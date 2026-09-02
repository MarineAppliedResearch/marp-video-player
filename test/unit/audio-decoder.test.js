/**
 * Unit tests for AudioUnitDecoder.
 *
 * The decoder is a thin thing now: frame the AAC as ADTS, hand it to
 * `decodeAudioData`, and report where in the media the result belongs. It was
 * not always thin — it used to drive a WebCodecs `AudioDecoder` with an output
 * queue, a stall watchdog and hardware-surface bookkeeping, and none of that
 * survived contact with the measurement in issue #6. What is left is tested
 * here against a fake context.
 *
 * @fileoverview Unit tests for per-unit audio decode.
 * @author Isaac Travers
 * @module video-engine/test/unit/audio-decoder.test
 */

const { AudioUnitDecoder } = require('../../src/audio-decoder.js');

/** The reference media's real config: AAC-LC, 96 kHz, stereo. */
const ASC = new Uint8Array([0x10, 0x10, 0x56, 0xe5, 0x00]);

/**
 * A context whose `decodeAudioData` reports what it was given and returns a
 * buffer whose length follows from it.
 *
 * @param {Object} [options]
 * @param {boolean} [options.reject] - Refuse to decode, the way a browser does for a malformed stream.
 * @returns {Object} `{context, calls}`.
 */
function makeContext({ reject = false } = {}) {
    const calls = [];
    return {
        calls,
        context: {
            sampleRate: 48000,
            async decodeAudioData(bytes) {
                calls.push({ byteLength: bytes.byteLength });
                if (reject) {
                    throw new Error('Unable to decode audio data');
                }
                // One second, at the context's rate rather than the media's --
                // decodeAudioData resamples on the way out.
                return { duration: 1, sampleRate: 48000, numberOfChannels: 2, length: 48000 };
            },
        },
    };
}

/**
 * A media source's `fetchAudioChunks()` result.
 *
 * @param {number} count - How many frames.
 * @param {number} [startMicros] - Timestamp of the first frame.
 * @returns {Object} An audioResult.
 */
function makeAudioResult(count, startMicros = 0) {
    const frameMicros = Math.round((1024 / 96000) * 1e6);

    return {
        codec: 'mp4a.40.2',
        description: ASC,
        sampleRate: 96000,
        numberOfChannels: 2,
        chunks: Array.from({ length: count }, (_, i) => ({
            type: 'key',
            timestamp: startMicros + i * frameMicros,
            duration: frameMicros,
            data: new Uint8Array(250).fill(i & 0xff),
        })),
    };
}

describe('AudioUnitDecoder', () => {

    it('frames the unit and hands it to the context to decode', async () => {
        const { context, calls } = makeContext();
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        const result = await decoder.decodeUnit(3, makeAudioResult(10));

        expect(calls).toHaveLength(1);
        // Ten frames of 250 bytes, each with a seven-byte ADTS header.
        expect(calls[0].byteLength).toBe(10 * 257);
        expect(result.unitIndex).toBe(3);
        expect(result.buffer).not.toBeNull();
    });

    /**
     * `decodeAudioData` knows nothing about where in the media this audio sits,
     * so the position has to come from the chunks. Taking it from the buffer
     * instead would put every unit at zero.
     */
    it('reports the unit position from the chunks, not the decoded buffer', async () => {
        const { context } = makeContext();
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        const result = await decoder.decodeUnit(0, makeAudioResult(4, 10_000_000));

        expect(result.startTime).toBeCloseTo(10, 6);
        expect(result.duration).toBeCloseTo(1, 6);
    });

    /**
     * The decoder resamples to the context's rate, so what comes back is not
     * necessarily the media's rate. Reporting the media's would misplace every
     * sample in the scheduled buffer.
     */
    it('reports the rate the decoder produced, not the media\'s', async () => {
        const { context } = makeContext();
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        const result = await decoder.decodeUnit(0, makeAudioResult(4));

        expect(result.sampleRate).toBe(48000);
    });

    it('returns an empty unit for audio with no frames, without decoding', async () => {
        const { context, calls } = makeContext();
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        const result = await decoder.decodeUnit(7, { ...makeAudioResult(0), chunks: [] });

        expect(result.buffer).toBeNull();
        expect(result.duration).toBe(0);
        expect(calls).toHaveLength(0);
    });

    it('rejects when the browser will not decode the stream', async () => {
        const { context } = makeContext({ reject: true });
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        await expect(decoder.decodeUnit(0, makeAudioResult(4))).rejects.toThrow(/Unable to decode audio data/);
    });

    it('rejects when there is no context to decode with', async () => {
        const decoder = new AudioUnitDecoder({ getContext: () => null });

        await expect(decoder.decodeUnit(0, makeAudioResult(4))).rejects.toThrow(/No audio context/);
    });

    /**
     * A configuration ADTS cannot express has to fail here rather than produce a
     * stream declaring the wrong rate, which would decode into audio at the
     * wrong speed instead of failing.
     */
    it('rejects audio whose configuration ADTS cannot express', async () => {
        const { context } = makeContext();
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        const audio = makeAudioResult(4);
        // Frequency index 15: an explicit rate, which ADTS has no field for.
        audio.description = new Uint8Array([0x17, 0x80, 0x61, 0xa8, 0x10]);

        await expect(decoder.decodeUnit(0, audio)).rejects.toThrow(/cannot be framed as ADTS/);
    });

    /**
     * Concurrent decodes would compete for exactly the resource this whole
     * design exists to stop competing for.
     */
    it('serialises concurrent decodes', async () => {
        let inFlight = 0;
        let overlapped = false;
        const context = {
            sampleRate: 48000,
            async decodeAudioData() {
                inFlight += 1;
                if (inFlight > 1) {
                    overlapped = true;
                }
                await Promise.resolve();
                inFlight -= 1;
                return { duration: 1, sampleRate: 48000, numberOfChannels: 2 };
            },
        };
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        await Promise.all([
            decoder.decodeUnit(0, makeAudioResult(4)),
            decoder.decodeUnit(1, makeAudioResult(4)),
            decoder.decodeUnit(2, makeAudioResult(4)),
        ]);

        expect(overlapped).toBe(false);
    });

    it('keeps decoding later units after one fails', async () => {
        let first = true;
        const context = {
            sampleRate: 48000,
            async decodeAudioData() {
                if (first) {
                    first = false;
                    throw new Error('Unable to decode audio data');
                }
                return { duration: 1, sampleRate: 48000, numberOfChannels: 2 };
            },
        };
        const decoder = new AudioUnitDecoder({ getContext: () => context });

        await expect(decoder.decodeUnit(0, makeAudioResult(4))).rejects.toThrow();
        await expect(decoder.decodeUnit(1, makeAudioResult(4))).resolves.toMatchObject({ unitIndex: 1 });
    });
});
