/**
 * Unit tests for GopDecoder, run against the fake WebCodecs globals in
 * test/unit/fakes/webcodecs-fakes.js rather than a real VideoDecoder --
 * lets these run under plain Node/Jest with no browser, while still
 * exercising the module's real decode-queue/serialization/detach logic
 * (only the underlying decoder callback machinery is faked).
 *
 * @fileoverview Unit tests for GopDecoder's segment decode orchestration.
 * @author Isaac Travers
 * @module video-engine/test/unit/gop-decoder.test
 */

const { GopDecoder } = require('../../src/gop-decoder.js');
const { FakeVideoDecoder, FakeVideoFrame, installWebCodecsFakes } = require('./fakes/webcodecs-fakes.js');

/** Restores the real (absent) globals after each test; set by installWebCodecsFakes() in beforeEach. */
let restoreWebCodecsFakes;

beforeEach(() => {
    restoreWebCodecsFakes = installWebCodecsFakes();
});

afterEach(() => {
    restoreWebCodecsFakes();
});

/**
 * Builds a minimal valid demuxResult -- one keyframe chunk followed by
 * delta chunks at the given timestamps -- matching the shape
 * demuxer.demuxSegment() really returns.
 *
 * @param {Array<number>} chunkTimestamps - Timestamp (microseconds) for each chunk; the first is always the keyframe.
 * @returns {{codec: string, description: Uint8Array, chunks: Array<Object>}} A fake demuxResult.
 */
function makeDemuxResult(chunkTimestamps) {
    return {
        codec: 'avc1.4D4028',
        description: new Uint8Array([1, 2, 3]),
        chunks: chunkTimestamps.map((timestamp, i) => ({
            type: i === 0 ? 'key' : 'delta',
            timestamp,
            duration: 33_333,
            data: new Uint8Array([i]),
        })),
    };
}

describe('GopDecoder#decodeSegment', () => {
    test('names frame-buffer exhaustion explicitly instead of letting it read as a decode failure', async () => {
        // A too-large decoded-frame cache budget shows up here, as the
        // browser refusing to construct another VideoFrame -- every cached
        // frame holds its own buffer, so a multi-GB budget asks for
        // thousands of live buffers. Without a dedicated message this
        // surfaces as a generic "segment failure" that reads like a decode
        // or network problem, sending debugging in the wrong direction.
        const originalVideoFrame = global.VideoFrame;
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
        try {
            global.VideoFrame = function ThrowingVideoFrame() {
                throw new DOMException('Failed to create a VideoFrame with format: PIXEL_FORMAT_NV12', 'OperationError');
            };

            const decoder = new GopDecoder();
            await expect(decoder.decodeSegment(0, makeDemuxResult([0, 33_333]))).rejects.toThrow();

            const message = consoleErrorSpy.mock.calls.map((call) => call[0]).join('\n');
            expect(message).toMatch(/FRAME ALLOCATION FAILED/);
            expect(message).toMatch(/cache budget/i);
        } finally {
            consoleErrorSpy.mockRestore();
            global.VideoFrame = originalVideoFrame;
        }
    });

    test('rejects a segment whose first chunk is not a keyframe', async () => {
        const decoder = new GopDecoder();
        const demuxResult = makeDemuxResult([0, 33_333]);
        demuxResult.chunks[0].type = 'delta';

        await expect(decoder.decodeSegment(0, demuxResult)).rejects.toThrow(/not a keyframe/);
    });

    test('returns decoded frames sorted by presentation timestamp, regardless of decode/output order', async () => {
        // Simulates B-frame reordering: the decoder emits frames in an
        // order that doesn't match presentation time, matching how a real
        // decoder's *output* order can differ from decode-submission
        // order -- gop-decoder.js's job is to re-sort by timestamp after
        // decode, never before (see demuxer.js's own doc comment on this).
        FakeVideoDecoder.outputForChunk = (chunk) =>
            new FakeVideoFrame({ timestamp: chunk.timestamp, duration: 33_333, displayWidth: 16, displayHeight: 16, format: 'I420' });

        const decoder = new GopDecoder();
        const demuxResult = makeDemuxResult([0, 66_666, 33_333]);

        const gopBuffer = await decoder.decodeSegment(7, demuxResult);

        expect(gopBuffer.segmentIndex).toBe(7);
        expect(gopBuffer.frames.map((f) => f.timestamp)).toEqual([0, 33_333, 66_666]);
    });

    test('closes the original hardware-surface-backed frame after detaching it to plain memory', async () => {
        const originalFrames = [];
        FakeVideoDecoder.outputForChunk = (chunk) => {
            const frame = new FakeVideoFrame({ timestamp: chunk.timestamp, duration: 33_333, displayWidth: 16, displayHeight: 16, format: 'I420' });
            originalFrames.push(frame);
            return frame;
        };

        const decoder = new GopDecoder();
        const gopBuffer = await decoder.decodeSegment(0, makeDemuxResult([0, 33_333]));

        expect(originalFrames.every((frame) => frame.closed)).toBe(true);
        // The returned frames are the *reconstructed* plain-memory copies,
        // not the original hardware-backed instances.
        gopBuffer.frames.forEach((frame) => expect(originalFrames).not.toContain(frame));
    });

    test('closes every already-detached frame when decode fails partway through a segment', async () => {
        // Regression test for a real leak: if a segment's decode fails
        // after some frames were already output and detached to plain
        // memory (see webcodecs-fakes.js's simulateErrorAfterFrames),
        // those frames must still be closed before the rejection
        // propagates -- each is a VideoFrame holding real external memory.
        FakeVideoDecoder.outputForChunk = (chunk) =>
            new FakeVideoFrame({ timestamp: chunk.timestamp, duration: 33_333, displayWidth: 16, displayHeight: 16, format: 'I420' });
        FakeVideoDecoder.simulateErrorAfterFrames = 2;

        const decoder = new GopDecoder();
        const demuxResult = makeDemuxResult([0, 33_333, 66_666, 100_000]);

        await expect(decoder.decodeSegment(0, demuxResult)).rejects.toThrow(/simulated decode error/);

        expect(FakeVideoFrame.reconstructedFrames).toHaveLength(2);
        expect(FakeVideoFrame.reconstructedFrames.every((frame) => frame.closed)).toBe(true);
    });

    test('serializes concurrent decodeSegment calls so segments never interleave through the shared decoder', async () => {
        const decoder = new GopDecoder();
        const [first, second] = await Promise.all([
            decoder.decodeSegment(0, makeDemuxResult([0, 33_333])),
            decoder.decodeSegment(1, makeDemuxResult([100_000, 133_333])),
        ]);

        expect(first.frames.map((f) => f.timestamp)).toEqual([0, 33_333]);
        expect(second.frames.map((f) => f.timestamp)).toEqual([100_000, 133_333]);
    });

    test('closes the real decoder on a watchdog stall, so late background output cannot leak into the next segment (regression)', async () => {
        // Regression test: a watchdog timeout used to leave the real
        // decoder running -- decodeSegment() gave up waiting, but nothing
        // ever called close() on it, so if it eventually produced more
        // output in the background, that output fired into whatever
        // segment decoded NEXT via the shared _currentSink, silently
        // mixing frames from two unrelated segments (confirmed live as
        // the actual cause of "correct index, wrong picture" after fast
        // reverse scrubbing outran decode throughput).
        jest.useFakeTimers();
        try {
            FakeVideoDecoder.simulateStall = true;
            const decoder = new GopDecoder();
            const stalledDemux = makeDemuxResult([0, 33_333]);

            const stalledResult = decoder.decodeSegment(4, stalledDemux);
            await jest.advanceTimersByTimeAsync(20_000); // past DECODE_WATCHDOG_MS, pumping microtasks along the way
            await expect(stalledResult).rejects.toThrow(/stalled/i);

            const stalledInstance = FakeVideoDecoder.instances[0];
            expect(stalledInstance.state).toBe('closed');

            FakeVideoDecoder.simulateStall = false;
            const nextDemux = makeDemuxResult([100_000, 133_333]);
            const nextResult = decoder.decodeSegment(5, nextDemux);

            // The old (now-closed) decoder's background work "finally
            // completing" -- must be a no-op, not leak into segment 5.
            stalledInstance.emitLateOutput(
                new FakeVideoFrame({ timestamp: 999_999, duration: 33_333, displayWidth: 16, displayHeight: 16, format: 'I420' })
            );

            const { frames } = await nextResult;
            expect(frames.map((f) => f.timestamp)).toEqual([100_000, 133_333]);
            expect(FakeVideoDecoder.instances).toHaveLength(2); // a fresh decoder was built for segment 5, not the closed one reused
        } finally {
            jest.useRealTimers();
        }
    });
});
