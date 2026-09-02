/**
 * Unit tests for audio on the byte-range media sources.
 *
 * These cover the one measurement that decided the whole design: audio and
 * video are interleaved sample by sample, so a unit's audio cannot be fetched
 * on its own without hundreds of requests -- but the unit's video byte range
 * already spans nearly all of it, so widening that range buys the audio for a
 * few per cent more bytes and no extra requests at all.
 *
 * The synthetic sample tables below reproduce that layout deliberately: each
 * unit's audio starts inside its video byte range and ends past it, which is
 * exactly what was measured in the real media.
 *
 * @fileoverview Unit tests for audio indexing and chunk assembly on byte-range sources.
 * @author Isaac Travers
 * @module video-engine/test/unit/media-source-audio.test
 */

const { MediaSource } = require('../../src/media-source.js');
const { UrlMediaSource } = require('../../src/media-source-url.js');

/** Timescale both synthetic tracks use, so a cts is milliseconds. */
const TIMESCALE = 1000;

/**
 * Two GOPs of two samples each. Byte ranges deliberately leave gaps between
 * samples, the way an interleaved file does -- audio lives in those gaps.
 *
 * @returns {Array<Object>} A video sample table in mp4box's shape.
 */
function videoSamples() {
    return [
        { cts: 0, duration: 500, timescale: TIMESCALE, is_sync: true, offset: 1000, size: 200 },
        { cts: 500, duration: 500, timescale: TIMESCALE, is_sync: false, offset: 1400, size: 100 },
        { cts: 1000, duration: 500, timescale: TIMESCALE, is_sync: true, offset: 1800, size: 200 },
        { cts: 1500, duration: 500, timescale: TIMESCALE, is_sync: false, offset: 2200, size: 100 },
    ];
}

/**
 * Eight audio samples of 250ms each. Two per unit sit inside that unit's
 * video byte range and two sit past its end, reproducing the lag measured in
 * the real interleave.
 *
 * @returns {Array<Object>} An audio sample table in mp4box's shape.
 */
function audioSamples() {
    return [
        { cts: 0, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 1250, size: 20 },
        { cts: 250, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 1270, size: 20 },
        { cts: 500, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 1520, size: 20 },
        { cts: 750, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 1540, size: 20 },
        { cts: 1000, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 2050, size: 20 },
        { cts: 1250, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 2070, size: 20 },
        { cts: 1500, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 2320, size: 20 },
        { cts: 1750, duration: 250, timescale: TIMESCALE, is_sync: true, offset: 2340, size: 20 },
    ];
}

/**
 * A source with its index already built from the tables above, bypassing
 * load() -- which would need a real MP4 over a real fetch.
 *
 * @param {Object} [options]
 * @param {Array<Object>|null} [options.audio] - Audio sample table, or null for a file with no audio.
 * @returns {UrlMediaSource} A source ready to answer index and chunk questions.
 */
function build({ audio = audioSamples() } = {}) {
    const source = new UrlMediaSource({ url: 'http://example.test/clip.mp4' });

    source._samples = videoSamples();
    source._track = { duration: 2000, timescale: TIMESCALE };
    source._config = { codec: 'avc1.4D4028', description: new Uint8Array([1]) };
    source._audioSamples = audio;
    source._audioConfig = audio
        ? {
              codec: 'mp4a.40.2',
              description: new Uint8Array([0x11, 0x90]),
              sampleRate: 48000,
              numberOfChannels: 2,
              language: 'und',
          }
        : null;
    source._segmentIndex = source._buildUnitIndex();

    // Tier 1 stands in as the bytes the unit's own range covers, filled with
    // each byte's absolute file offset so a slice can be checked by value.
    source.segmentFetcher = {
        getCachedRawBytes: (unitIndex) => {
            const unit = source._segmentIndex.segments[unitIndex];
            const length = unit.byteRangeEnd - unit.byteRangeStart;
            const bytes = new Uint8Array(length);
            for (let i = 0; i < length; i++) {
                bytes[i] = (unit.byteRangeStart + i) % 256;
            }
            return bytes.buffer;
        },
    };

    return source;
}

describe('MediaSource base class audio contract', () => {

    /**
     * The default has to be "no audio" rather than an error: a source written
     * by a consumer of this package predates all of this, and must keep
     * working untouched.
     */
    it('reports no audio by default', async () => {
        const source = new MediaSource();

        expect(source.hasAudio()).toBe(false);
        expect(source.getAudioConfig()).toBeNull();
        await expect(source.fetchAudioChunks(0)).resolves.toBeNull();
    });
});

describe('byte-range audio indexing', () => {

    it('splits the video sample table into GOP units as it always did', () => {
        const source = build();
        const units = source._segmentIndex.segments;

        expect(units).toHaveLength(2);
        expect(units[0]).toMatchObject({ startTime: 0, endTime: 1 });
        expect(units[1]).toMatchObject({ startTime: 1, endTime: 2 });
    });

    it('assigns each unit the audio samples covering its own time span', () => {
        const units = build()._segmentIndex.segments;

        expect(units[0]).toMatchObject({ firstAudioSample: 0, lastAudioSample: 3 });
        expect(units[1]).toMatchObject({ firstAudioSample: 4, lastAudioSample: 7 });
    });

    /**
     * The measurement this whole approach rests on. Without the widening, the
     * last two audio samples of each unit sit past the fetched bytes and the
     * unit would be part silent.
     */
    it('widens a unit\'s byte range to cover audio that runs past its video', () => {
        const units = build()._segmentIndex.segments;

        // Video alone ended at 1500 and 2300; audio runs to 1560 and 2360.
        expect(units[0].byteRangeStart).toBe(1000);
        expect(units[0].byteRangeEnd).toBe(1560);
        expect(units[1].byteRangeEnd).toBe(2360);
    });

    /**
     * Audio lagging the video is what was measured, not what is guaranteed --
     * a file that interleaves the other way has to work too.
     */
    it('widens the head as well when audio runs ahead of the video', () => {
        const early = audioSamples();
        early[0].offset = 900; // before the first video sample at 1000

        const units = build({ audio: early })._segmentIndex.segments;

        expect(units[0].byteRangeStart).toBe(900);
    });

    it('leaves byte ranges alone for a file with no audio', () => {
        const units = build({ audio: null })._segmentIndex.segments;

        expect(units[0].byteRangeEnd).toBe(1500);
        expect(units[0].firstAudioSample).toBeUndefined();
    });

    /**
     * A sample straddling a unit boundary belongs to both, so the walk must
     * not consume it out from under the next unit. The forward pointer only
     * ever skips samples that have genuinely ended.
     */
    it('gives a boundary-straddling sample to both units it covers', () => {
        const straddling = audioSamples();
        // Stretch the fourth sample across the 1.0s boundary.
        straddling[3].duration = 500;

        const units = build({ audio: straddling })._segmentIndex.segments;

        expect(units[0].lastAudioSample).toBe(3);
        expect(units[1].firstAudioSample).toBe(3);
    });
});

describe('byte-range audio chunk assembly', () => {

    it('reports the audio config it read', () => {
        const source = build();

        expect(source.hasAudio()).toBe(true);
        expect(source.getAudioConfig()).toMatchObject({ codec: 'mp4a.40.2', sampleRate: 48000, numberOfChannels: 2 });
    });

    it('slices a unit\'s audio chunks out of the same bytes the picture came from', async () => {
        const result = await build().fetchAudioChunks(0);

        expect(result.chunks).toHaveLength(4);
        expect(result.codec).toBe('mp4a.40.2');
        expect(result.sampleRate).toBe(48000);
        expect(result.chunks[0]).toMatchObject({ type: 'key', timestamp: 0, duration: 250_000 });
        expect(result.chunks[3].timestamp).toBe(750_000);
    });

    it('slices from the right offset within the fetched bytes', async () => {
        const result = await build().fetchAudioChunks(0);

        // Bytes carry their own absolute file offset, so the first byte of
        // the sample at offset 1250 must read as 1250 % 256.
        expect(result.chunks[0].data).toHaveLength(20);
        expect(result.chunks[0].data[0]).toBe(1250 % 256);
        expect(result.chunks[1].data[0]).toBe(1270 % 256);
    });

    /**
     * The tail samples are the ones the widening exists for -- if the range
     * were not widened these would slice past the end of the buffer.
     */
    it('reaches the audio that sits past the unit\'s video bytes', async () => {
        const result = await build().fetchAudioChunks(0);

        expect(result.chunks[2].data[0]).toBe(1520 % 256);
        expect(result.chunks[3].data[0]).toBe(1540 % 256);
    });

    it('reports a zero timeline offset, since these timestamps are already playlist time', async () => {
        const result = await build().fetchAudioChunks(1);

        expect(result.timelineOffsetMicros).toBe(0);
        expect(result.chunks[0].timestamp).toBe(1_000_000);
    });

    /**
     * Feeding a decoder a slice that ran off the end of the buffer is feeding
     * it whatever happened to be adjacent. Dropping the sample costs one frame
     * of audio; passing it on costs the unit.
     */
    it('drops a sample that falls outside the fetched bytes rather than slicing garbage', async () => {
        const source = build();
        source.segmentFetcher.getCachedRawBytes = () => new ArrayBuffer(300);

        const result = await source.fetchAudioChunks(0);

        // Only the samples wholly inside the first 300 bytes survive.
        expect(result.chunks).toHaveLength(2);
    });

    it('returns null for a file with no audio', async () => {
        const source = build({ audio: null });

        expect(source.hasAudio()).toBe(false);
        await expect(source.fetchAudioChunks(0)).resolves.toBeNull();
    });

    it('throws for a unit that does not exist', async () => {
        await expect(build().fetchAudioChunks(99)).rejects.toThrow(/No unit at index 99/);
    });
});
