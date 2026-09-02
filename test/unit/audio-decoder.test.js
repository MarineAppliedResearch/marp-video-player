/**
 * Unit tests for AudioUnitDecoder, run against the fake audio globals in
 * test/unit/fakes/webaudio-fakes.js rather than a real AudioDecoder -- so
 * these run under plain Node/Jest with no browser, while still exercising the
 * module's real queueing, assembly and failure handling.
 *
 * @fileoverview Unit tests for AudioUnitDecoder's per-unit decode.
 * @author Isaac Travers
 * @module video-engine/test/unit/audio-decoder.test
 */

const { AudioUnitDecoder } = require('../../src/audio-decoder.js');
const { FakeAudioDecoder, FakeAudioData, installAudioFakes } = require('./fakes/webaudio-fakes.js');

/** Restores the real (absent) globals after each test. */
let restoreAudioFakes;

beforeEach(() => {
    restoreAudioFakes = installAudioFakes();
});

afterEach(() => {
    restoreAudioFakes();
});

/**
 * Builds a media source's fetchAudioChunks() result: AAC frames of 1024
 * samples each, back to back from `startMicros`.
 *
 * @param {number} count - How many frames.
 * @param {Object} [options]
 * @param {number} [options.sampleRate] - Sample rate to configure with.
 * @param {number} [options.startMicros] - Timestamp of the first frame.
 * @returns {Object} An audioResult, as AudioUnitDecoder.decodeUnit takes.
 */
function makeAudioResult(count, { sampleRate = 48000, startMicros = 0 } = {}) {
    const frameMicros = Math.round((1024 / sampleRate) * 1e6);

    return {
        codec: 'mp4a.40.2',
        description: new Uint8Array([0x11, 0x90]),
        sampleRate,
        numberOfChannels: 2,
        chunks: Array.from({ length: count }, (_, i) => ({
            type: 'key',
            timestamp: startMicros + i * frameMicros,
            duration: frameMicros,
            data: new Uint8Array([i]),
        })),
    };
}

describe('AudioUnitDecoder', () => {

    it('decodes a unit into one contiguous buffer per channel', async () => {
        const decoder = new AudioUnitDecoder();
        const result = await decoder.decodeUnit(3, makeAudioResult(4));

        expect(result.unitIndex).toBe(3);
        expect(result.sampleRate).toBe(48000);
        expect(result.numberOfChannels).toBe(2);
        expect(result.channels).toHaveLength(2);
        expect(result.channels[0]).toHaveLength(4 * 1024);
        expect(result.duration).toBeCloseTo((4 * 1024) / 48000, 6);
    });

    it('reports the unit start from the first output rather than assuming zero', async () => {
        const decoder = new AudioUnitDecoder();
        const result = await decoder.decodeUnit(0, makeAudioResult(2, { startMicros: 10_000_000 }));

        expect(result.startTime).toBeCloseTo(10, 6);
    });

    it('configures the decoder with the codec, rate, channels and description', async () => {
        const decoder = new AudioUnitDecoder();
        await decoder.decodeUnit(0, makeAudioResult(1, { sampleRate: 96000 }));

        expect(FakeAudioDecoder.instances).toHaveLength(1);
        expect(FakeAudioDecoder.instances[0].config).toMatchObject({
            codec: 'mp4a.40.2',
            sampleRate: 96000,
            numberOfChannels: 2,
        });
        expect(FakeAudioDecoder.instances[0].config.description).toBeInstanceOf(Uint8Array);
    });

    it('reuses one decoder across units with the same config', async () => {
        const decoder = new AudioUnitDecoder();
        await decoder.decodeUnit(0, makeAudioResult(1));
        await decoder.decodeUnit(1, makeAudioResult(1));

        expect(FakeAudioDecoder.instances).toHaveLength(1);
    });

    it('rebuilds the decoder when the config changes', async () => {
        const decoder = new AudioUnitDecoder();
        await decoder.decodeUnit(0, makeAudioResult(1, { sampleRate: 48000 }));
        await decoder.decodeUnit(1, makeAudioResult(1, { sampleRate: 96000 }));

        expect(FakeAudioDecoder.instances).toHaveLength(2);
    });

    /**
     * The whole point of placing outputs by timestamp rather than
     * concatenating them: a gap has to become silence where it belongs. Simply
     * appending would pull everything after the gap earlier, which puts the
     * rest of the unit out of sync with the picture -- a much worse failure
     * than a moment of silence.
     */
    it('places a gap in the encoded audio as silence, not as a shift', async () => {
        const audioResult = makeAudioResult(3);
        const frameMicros = audioResult.chunks[1].timestamp;

        // Drop the middle frame's output, leaving a hole between the others.
        FakeAudioDecoder.outputForChunk = (chunk) =>
            new FakeAudioData({
                timestamp: chunk.timestamp === frameMicros ? chunk.timestamp + frameMicros : chunk.timestamp,
                numberOfFrames: 1024,
                numberOfChannels: 2,
                sampleRate: 48000,
                fill: 1,
            });

        const result = await new AudioUnitDecoder().decodeUnit(0, audioResult);

        // Three outputs, but the last two both land at the third frame's
        // position, so the buffer still spans three frames' worth.
        expect(result.channels[0]).toHaveLength(3 * 1024);
        expect(result.channels[0][0]).toBe(1);
        // The hole where the second frame should have been.
        expect(result.channels[0][1024]).toBe(0);
        expect(result.channels[0][2048]).toBe(1);
    });

    it('orders outputs by timestamp regardless of the order they arrive in', async () => {
        const audioResult = makeAudioResult(2);
        const timestamps = audioResult.chunks.map((chunk) => chunk.timestamp);

        // Emit them backwards, giving each a distinguishable fill value.
        let call = 0;
        FakeAudioDecoder.outputForChunk = () => {
            const index = 1 - call;
            call += 1;
            return new FakeAudioData({
                timestamp: timestamps[index],
                numberOfFrames: 1024,
                numberOfChannels: 2,
                sampleRate: 48000,
                fill: index + 1,
            });
        };

        const result = await new AudioUnitDecoder().decodeUnit(0, audioResult);

        expect(result.channels[0][0]).toBe(1);
        expect(result.channels[0][1024]).toBe(2);
    });

    /**
     * HE-AAC advertises half its output rate in its own config and then emits
     * at double it. Trusting the configured value would lay every sample out
     * at half speed.
     */
    it('uses the rate the decoder produced, not the one it was configured with', async () => {
        FakeAudioDecoder.outputForChunk = (chunk) =>
            new FakeAudioData({
                timestamp: chunk.timestamp,
                numberOfFrames: 2048,
                numberOfChannels: 2,
                sampleRate: 48000,
            });

        const result = await new AudioUnitDecoder().decodeUnit(0, makeAudioResult(1, { sampleRate: 24000 }));

        expect(result.sampleRate).toBe(48000);
    });

    it('closes every AudioData it copies out of', async () => {
        const seen = [];
        FakeAudioDecoder.outputForChunk = (chunk) => {
            const data = new FakeAudioData({
                timestamp: chunk.timestamp,
                numberOfFrames: 1024,
                numberOfChannels: 2,
                sampleRate: 48000,
            });
            seen.push(data);
            return data;
        };

        await new AudioUnitDecoder().decodeUnit(0, makeAudioResult(3));

        expect(seen).toHaveLength(3);
        expect(seen.every((data) => data.closed)).toBe(true);
    });

    it('returns an empty buffer for a unit with no audio samples, without configuring', async () => {
        const decoder = new AudioUnitDecoder();
        const result = await decoder.decodeUnit(7, { ...makeAudioResult(0), chunks: [] });

        expect(result.unitIndex).toBe(7);
        expect(result.channels).toEqual([]);
        expect(result.duration).toBe(0);
        expect(FakeAudioDecoder.instances).toHaveLength(0);
    });

    it('rejects when the codec config is unsupported', async () => {
        FakeAudioDecoder.supported = false;

        await expect(new AudioUnitDecoder().decodeUnit(0, makeAudioResult(1))).rejects.toThrow(
            /does not support codec config/
        );
    });

    it('rejects rather than hanging when the decoder errors without settling flush', async () => {
        FakeAudioDecoder.simulateError = true;

        await expect(new AudioUnitDecoder().decodeUnit(0, makeAudioResult(1))).rejects.toThrow(
            /simulated audio decode error/
        );
    });

    /**
     * A decoder that stalls with neither output nor an error would otherwise
     * leave the audio path waiting forever. It must also be CLOSED on the way
     * out: a real one keeps processing in the background, and its late output
     * would arrive through the shared sink and be attributed to whichever unit
     * decodes next -- the same failure gop-decoder.js documents for video.
     */
    it('gives up on a stalled decoder and closes it', async () => {
        jest.useFakeTimers();
        FakeAudioDecoder.simulateStall = true;

        const decoder = new AudioUnitDecoder();
        const pending = decoder.decodeUnit(2, makeAudioResult(1));
        const asserted = expect(pending).rejects.toThrow(/stalled decoding unit 2/);

        // The async form, because the watchdog's setTimeout is only created
        // after `isConfigSupported` has been awaited -- advancing
        // synchronously would run the clock before the timer exists.
        await jest.advanceTimersByTimeAsync(5000);
        await asserted;

        expect(FakeAudioDecoder.instances[0].state).toBe('closed');
        jest.useRealTimers();
    });

    it('builds a fresh decoder for the next unit after a failure', async () => {
        FakeAudioDecoder.simulateError = true;
        const decoder = new AudioUnitDecoder();
        await expect(decoder.decodeUnit(0, makeAudioResult(1))).rejects.toThrow();

        FakeAudioDecoder.simulateError = false;
        await decoder.decodeUnit(1, makeAudioResult(1));

        expect(FakeAudioDecoder.instances).toHaveLength(2);
        expect(FakeAudioDecoder.instances[1].state).toBe('configured');
    });

    /**
     * One decoder means decodes must not interleave: two units in flight at
     * once would mix their outputs through the shared sink.
     */
    it('serializes concurrent decodes rather than running them together', async () => {
        const decoder = new AudioUnitDecoder();

        const results = await Promise.all([
            decoder.decodeUnit(0, makeAudioResult(2)),
            decoder.decodeUnit(1, makeAudioResult(3)),
        ]);

        expect(results[0].channels[0]).toHaveLength(2 * 1024);
        expect(results[1].channels[0]).toHaveLength(3 * 1024);
    });

    it('closes the underlying decoder on close()', async () => {
        const decoder = new AudioUnitDecoder();
        await decoder.decodeUnit(0, makeAudioResult(1));

        decoder.close();

        expect(FakeAudioDecoder.instances[0].state).toBe('closed');
    });
});
