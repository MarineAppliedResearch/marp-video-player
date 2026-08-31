/**
 * Tests for the Jellyfin transcode source's chunk provision, including the
 * keyframe-continuity fallback that moved here out of FrameStore.
 *
 * @fileoverview Unit tests for JellyfinTranscodeMediaSource#fetchChunks.
 */

jest.mock('../../src/demuxer.js', () => ({
    demuxSegment: jest.fn(),
}));

const { demuxSegment } = require('../../src/demuxer.js');
const { JellyfinTranscodeMediaSource } = require('../../src/media-source-jellyfin-transcode.js');

/** Tier 1 stub: has every segment's bytes, and records ensureRawBytes calls. */
function makeSegmentFetcher() {
    return {
        fetchInitSegment: jest.fn(() => Promise.resolve(new ArrayBuffer(8))),
        getCachedRawBytes: jest.fn(() => new ArrayBuffer(8)),
        ensureRawBytes: jest.fn(() => Promise.resolve(new ArrayBuffer(8))),
    };
}

/**
 * Builds a source with Tier 1 stubbed in place of what load() would create,
 * so chunk provision can be tested without a real playlist or network.
 *
 * @param {Object} segmentFetcher - Tier 1 stub.
 * @returns {JellyfinTranscodeMediaSource} A source ready for fetchChunks().
 */
function makeSource(segmentFetcher) {
    const source = new JellyfinTranscodeMediaSource({ streamUrl: 'https://example.invalid/master.m3u8' });
    source.segmentFetcher = segmentFetcher;
    return source;
}

beforeEach(() => {
    demuxSegment.mockReset();
});

describe('JellyfinTranscodeMediaSource#fetchChunks', () => {
    test('returns the demuxed chunks and the unit\'s own first timestamp when it starts on a keyframe', async () => {
        const segmentFetcher = makeSegmentFetcher();
        demuxSegment.mockResolvedValueOnce({
            codec: 'avc1.test',
            description: null,
            chunks: [
                { type: 'key', timestamp: 3_080_000, duration: 40_000, data: new Uint8Array([1]) },
                { type: 'delta', timestamp: 4_080_000, duration: 40_000, data: new Uint8Array([2]) },
            ],
        });

        const source = makeSource(segmentFetcher);
        const result = await source.fetchChunks(1);

        expect(demuxSegment).toHaveBeenCalledTimes(1);
        expect(segmentFetcher.ensureRawBytes).not.toHaveBeenCalled();
        expect(result.unitFirstTimestampMicros).toBe(3_080_000);
        expect(result.chunks.map((chunk) => chunk.timestamp)).toEqual([3_080_000, 4_080_000]);
    });

    test('merges the previous unit when this one does not start on a keyframe', async () => {
        const segmentFetcher = makeSegmentFetcher();
        demuxSegment
            .mockResolvedValueOnce({
                codec: 'avc1.test',
                description: null,
                chunks: [
                    { type: 'delta', timestamp: 3_080_000, duration: 40_000, data: new Uint8Array([1]) },
                    { type: 'delta', timestamp: 4_080_000, duration: 40_000, data: new Uint8Array([2]) },
                ],
            })
            .mockResolvedValueOnce({
                codec: 'avc1.test',
                description: null,
                chunks: [
                    { type: 'key', timestamp: 80_000, duration: 40_000, data: new Uint8Array([3]) },
                    { type: 'delta', timestamp: 1_080_000, duration: 40_000, data: new Uint8Array([4]) },
                ],
            });

        const source = makeSource(segmentFetcher);
        const result = await source.fetchChunks(1);

        expect(demuxSegment).toHaveBeenCalledTimes(2);
        expect(segmentFetcher.ensureRawBytes).toHaveBeenCalledWith(0);
        // Merged, sorted by presentation time, and starting on a real keyframe.
        expect(result.chunks.map((chunk) => chunk.timestamp)).toEqual([80_000, 1_080_000, 3_080_000, 4_080_000]);
        expect(result.chunks[0].type).toBe('key');
        // Still reports segment 1's own start, so the caller can trim.
        expect(result.unitFirstTimestampMicros).toBe(3_080_000);
    });

    test('throws when unit 0 itself does not start on a keyframe', async () => {
        const segmentFetcher = makeSegmentFetcher();
        demuxSegment.mockResolvedValueOnce({
            codec: 'avc1.test',
            description: null,
            chunks: [{ type: 'delta', timestamp: 0, duration: 40_000, data: new Uint8Array([1]) }],
        });

        const source = makeSource(segmentFetcher);

        await expect(source.fetchChunks(0)).rejects.toThrow('does not start with a keyframe');
        expect(segmentFetcher.ensureRawBytes).not.toHaveBeenCalled();
    });
});
