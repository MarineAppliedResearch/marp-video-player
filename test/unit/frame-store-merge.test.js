/**
 * Regression tests for merged-segment decode continuity handling.
 *
 * The merge itself belongs to the media source (see
 * media-source-jellyfin-transcode.test.js); what FrameStore still owns, and
 * what this covers, is trimming the prepended frames back out so the cached
 * buffer holds only this segment's own frames -- otherwise the scheduler's
 * time mapping anchors to the wrong frame and visible frames disagree with
 * currentTime.
 *
 * @fileoverview Tests that continuity-merge frames are trimmed back out of the cached segment buffer.
 */

const { FrameStore } = require('../../src/frame-store.js');

describe('FrameStore continuity merge trimming', () => {
    test('retains only the current segment frames after the source merged previous-segment chunks', async () => {
        const segmentFetcher = {
            hasRawBytes: () => true,
        };

        // The source merged segment 0's chunks in for decode continuity and
        // reports segment 1's own first timestamp so they can be trimmed.
        const mediaSource = {
            fetchChunks: jest.fn(() =>
                Promise.resolve({
                    codec: 'avc1.test',
                    description: null,
                    chunks: [
                        { type: 'key', timestamp: 80_000, duration: 40_000, data: new Uint8Array([3]) },
                        { type: 'delta', timestamp: 1_080_000, duration: 40_000, data: new Uint8Array([4]) },
                        { type: 'delta', timestamp: 3_080_000, duration: 40_000, data: new Uint8Array([1]) },
                        { type: 'delta', timestamp: 4_080_000, duration: 40_000, data: new Uint8Array([2]) },
                    ],
                    unitFirstTimestampMicros: 3_080_000,
                }),
            ),
        };

        const gopDecoder = {
            decodeSegment: jest.fn(() =>
                Promise.resolve({
                    segmentIndex: 1,
                    frames: [
                        { timestamp: 80_000 },
                        { timestamp: 1_080_000 },
                        { timestamp: 3_080_000 },
                        { timestamp: 4_080_000 },
                    ],
                }),
            ),
        };

        const frameStore = new FrameStore({
            segmentFetcher,
            mediaSource,
            gopDecoder,
            width: 1280,
            height: 720,
            fps: 25,
            segmentDuration: 3,
            cacheBudgetBytes: 1,
        });

        const gopBuffer = await frameStore.ensureDecoded(1);

        expect(mediaSource.fetchChunks).toHaveBeenCalledWith(1);
        expect(gopBuffer.frames.map((frame) => frame.timestamp)).toEqual([3_080_000, 4_080_000]);
        expect(frameStore.buffers.get(1).frames.map((frame) => frame.timestamp)).toEqual([3_080_000, 4_080_000]);
    });
});
