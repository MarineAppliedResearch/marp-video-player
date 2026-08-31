/**
 * Unit tests for FrameStore's segment-granularity LRU eviction/pinning
 * logic, and for ensureDecoded()'s decode-only contract: it must decode
 * from already-fetched raw bytes, never fetch them itself, dedupe
 * concurrent callers, and back off after a real decode failure.
 *
 * Exercises `buffers`/`pinned`/`_evictIfNeeded`/`_touch` directly with
 * fake GopBuffers rather than going through `ensureDecoded()`'s real
 * decode pipeline where the eviction/pinning bookkeeping itself is under
 * test -- that bookkeeping is independent of how a GopBuffer was produced.
 * The media source is faked so ensureDecoded()'s own tests can drive decode
 * success/failure deterministically without a real mp4 payload.
 *
 * @fileoverview Unit tests for FrameStore's LRU eviction/pinning and decode-only orchestration.
 * @author Isaac Travers
 * @module video-engine/test/unit/frame-store.test
 */

const { FrameStore } = require('../../src/frame-store.js');

/**
 * Fake media source returning one keyframe chunk -- enough for FrameStore,
 * which only forwards chunks to the decoder and trims by timestamp.
 *
 * @returns {Object} A fake media source.
 */
function makeFakeMediaSource() {
    return {
        fetchChunks: jest.fn(() =>
            Promise.resolve({
                codec: 'avc1.test',
                description: null,
                chunks: [{ type: 'key', timestamp: 0, duration: 40_000, data: new Uint8Array([1]) }],
                unitFirstTimestampMicros: 0,
            }),
        ),
    };
}

/**
 * Builds a FrameStore with a tiny cache budget so maxSegmentsBuffered
 * always lands on the MIN_SEGMENTS_BUFFERED floor (3) regardless of the
 * nominal width/height/fps -- keeps eviction thresholds deterministic
 * without needing to know the module's private budget formula exactly.
 *
 * @param {Object} [segmentFetcher] - Fake Tier 1 to inject; defaults to an empty stub (unused by the eviction/pinning tests below).
 * @returns {FrameStore} A FrameStore instance with maxSegmentsBuffered pinned to 3.
 */
function makeFrameStore(segmentFetcher = {}) {
    return new FrameStore({
        segmentFetcher,
        mediaSource: makeFakeMediaSource(),
        gopDecoder: {},
        width: 1920,
        height: 1080,
        fps: 30,
        segmentDuration: 3,
        cacheBudgetBytes: 1,
    });
}

/**
 * Builds a fake GopBuffer with `count` frames, each carrying a jest.fn()
 * spy in place of a real VideoFrame's close(), so eviction tests can
 * assert exactly which segments got their frames closed.
 *
 * @param {number} count - Number of fake frames to include.
 * @returns {{frames: Array<{close: jest.Mock}>}} A fake GopBuffer.
 */
function makeGopBuffer(count) {
    return { frames: Array.from({ length: count }, () => ({ close: jest.fn() })) };
}

describe('FrameStore eviction', () => {
    test('evicts least-recently-inserted unpinned segments first, closing every frame they held', () => {
        const frameStore = makeFrameStore();
        const buffers = { 0: makeGopBuffer(2), 1: makeGopBuffer(2), 2: makeGopBuffer(2), 3: makeGopBuffer(2), 4: makeGopBuffer(2) };

        for (let i = 0; i <= 4; i++) {
            frameStore.buffers.set(i, buffers[i]);
        }
        frameStore.setPinned([2]);

        frameStore._evictIfNeeded();

        expect([...frameStore.buffers.keys()]).toEqual([2, 3, 4]);
        buffers[0].frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1));
        buffers[1].frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1));
        buffers[3].frames.forEach((frame) => expect(frame.close).not.toHaveBeenCalled());
        buffers[4].frames.forEach((frame) => expect(frame.close).not.toHaveBeenCalled());
    });

    test('never evicts a pinned segment even when the cache is over budget', () => {
        const frameStore = makeFrameStore();
        const buffers = { 0: makeGopBuffer(1), 1: makeGopBuffer(1), 2: makeGopBuffer(1), 3: makeGopBuffer(1), 4: makeGopBuffer(1) };

        for (let i = 0; i <= 4; i++) {
            frameStore.buffers.set(i, buffers[i]);
        }
        frameStore.setPinned([0, 1, 2, 3, 4]);

        frameStore._evictIfNeeded();

        expect(frameStore.buffers.size).toBe(5);
        Object.values(buffers).forEach((gopBuffer) => gopBuffer.frames.forEach((frame) => expect(frame.close).not.toHaveBeenCalled()));
    });

    test('_touch re-inserts a segment as most-recently-used, protecting it from the next eviction pass', () => {
        const frameStore = makeFrameStore();
        const buffers = { 0: makeGopBuffer(1), 1: makeGopBuffer(1), 2: makeGopBuffer(1), 3: makeGopBuffer(1), 4: makeGopBuffer(1) };

        for (let i = 0; i <= 4; i++) {
            frameStore.buffers.set(i, buffers[i]);
        }
        // Touching segment 0 moves it to the end of Map iteration order,
        // so it should survive this eviction pass instead of being the
        // first thing dropped.
        frameStore._touch(0);

        frameStore._evictIfNeeded();

        expect([...frameStore.buffers.keys()]).toEqual([3, 4, 0]);
    });
});

describe('FrameStore eviction priority (playhead island)', () => {
    test('evicts the segments furthest from the playhead, not the ones decoded longest ago', () => {
        // Reproduces the live thrash: the cache evicted by decode-completion
        // order, so the playhead's own neighbourhood -- decoded EARLIEST, as
        // the playhead approached it -- was always the oldest entry and the
        // first evicted, while segments 40 ahead that prefetch had just
        // decoded survived as the newest. Observed live as the playhead's
        // decoded island being the SMALLEST of five disjoint islands, with
        // its members evicted and immediately re-decoded every pass.
        const frameStore = makeFrameStore();
        const buffers = {
            // Decoded first (oldest), and immediately around the playhead.
            110: makeGopBuffer(1),
            111: makeGopBuffer(1),
            // Decoded most recently, but far from the playhead.
            140: makeGopBuffer(1),
            141: makeGopBuffer(1),
            142: makeGopBuffer(1),
        };
        for (const index of [110, 111, 140, 141, 142]) {
            frameStore.buffers.set(index, buffers[index]);
        }

        // Playhead at 111, travelling forward: priority runs outward from
        // the playhead, so 110/111 are the most valuable segments here and
        // the distant 140s are the least.
        frameStore.setEvictionPriority([111, 112, 110, 113, 109]);
        frameStore._evictIfNeeded();

        const survivors = [...frameStore.buffers.keys()].sort((a, b) => a - b);
        expect(survivors).toContain(110);
        expect(survivors).toContain(111);
        expect(survivors).not.toContain(140);
        expect(survivors).not.toContain(141);
    });

    test('still never evicts a pinned segment, whatever the priority order says', () => {
        const frameStore = makeFrameStore();
        for (const index of [10, 11, 12, 13, 14]) {
            frameStore.buffers.set(index, makeGopBuffer(1));
        }

        // 10 is the lowest-priority entry (absent from the order entirely)
        // but pinned, so it must survive regardless.
        frameStore.setPinned([10]);
        frameStore.setEvictionPriority([13, 14, 12, 11]);
        frameStore._evictIfNeeded();

        expect([...frameStore.buffers.keys()]).toContain(10);
    });

    test('never evicts the segment just decoded, even when it ranks lowest', () => {
        // A seek's own target is decoded while the eviction ranking still
        // reflects the PRE-seek playhead, so it ranks below everything in
        // the cache. With the cache full it was evicted inside its own
        // insertion -- before seek() could read it -- and the seek then
        // failed on an undefined buffer, breaking seeking entirely.
        const frameStore = makeFrameStore();
        frameStore.setEvictionPriority([10, 11, 12]);
        for (const index of [10, 11, 12]) {
            frameStore.buffers.set(index, makeGopBuffer(1));
        }

        // Segment 200 is the seek target: freshly decoded, absent from the
        // (stale) priority order, and pushing the cache over budget.
        frameStore.buffers.set(200, makeGopBuffer(1));
        frameStore._evictIfNeeded(200);

        expect([...frameStore.buffers.keys()]).toContain(200);
    });

    test('falls back to insertion order when no priority has been set', () => {
        // Guards the pre-existing behaviour for any caller that never
        // supplies a priority order (e.g. a bare FrameStore in a test).
        const frameStore = makeFrameStore();
        for (const index of [0, 1, 2, 3, 4]) {
            frameStore.buffers.set(index, makeGopBuffer(1));
        }

        frameStore._evictIfNeeded();

        expect([...frameStore.buffers.keys()]).toEqual([2, 3, 4]);
    });
});

describe('FrameStore#close', () => {
    test('closes every cached VideoFrame, clears the cache, and closes the shared GopDecoder', () => {
        // Regression test: close() previously left the shared GopDecoder's
        // VideoDecoder open, so a replaced engine's old decoder kept
        // running (and consuming CPU/decode throughput) alongside the new
        // engine's own decoder -- confirmed live as a multi-second delay
        // between "closing previous engine" and the new engine being ready.
        const gopDecoder = { close: jest.fn() };
        const frameStore = new FrameStore({
            segmentFetcher: {},
            gopDecoder,
            width: 1920,
            height: 1080,
            fps: 30,
            segmentDuration: 3,
            cacheBudgetBytes: 1,
        });
        const buffers = { 0: makeGopBuffer(2), 1: makeGopBuffer(2) };
        frameStore.buffers.set(0, buffers[0]);
        frameStore.buffers.set(1, buffers[1]);

        frameStore.close();

        expect(frameStore.buffers.size).toBe(0);
        buffers[0].frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1));
        buffers[1].frames.forEach((frame) => expect(frame.close).toHaveBeenCalledTimes(1));
        expect(gopDecoder.close).toHaveBeenCalledTimes(1);
    });
});

/**
 * Builds a fake Tier 1 (SegmentFetcher) whose raw bytes are always
 * present for `cachedIndices` and never present otherwise -- enough for
 * ensureDecoded()'s contract tests, which only need hasRawBytes()/
 * getCachedRawBytes()/fetchInitSegment(), not a real fetch pipeline.
 *
 * @param {Set<number>} cachedIndices - Segment indices to report as raw-cached.
 * @returns {Object} A fake SegmentFetcher.
 */
function makeFakeSegmentFetcher(cachedIndices) {
    return {
        hasRawBytes: (index) => cachedIndices.has(index),
        getCachedRawBytes: (index) => {
            if (!cachedIndices.has(index)) {
                throw new Error(`Segment ${index} raw bytes are not cached`);
            }
            return new ArrayBuffer(8);
        },
        fetchInitSegment: () => Promise.resolve(new ArrayBuffer(8)),
        ensureRawBytes: jest.fn(() => Promise.reject(new Error('ensureDecoded must never call ensureRawBytes'))),
    };
}

describe('FrameStore#ensureDecoded decode-only contract', () => {
    test('throws without ever fetching when the segment\'s raw bytes are not yet cached', async () => {
        // Tier 2 must never trigger a network fetch itself -- only decode
        // what Tier 1 already has. A caller (the scheduler's cache pass)
        // is responsible for checking hasRawBytes() first; this is the
        // structural backstop.
        const segmentFetcher = makeFakeSegmentFetcher(new Set());
        const frameStore = new FrameStore({
            segmentFetcher,
            mediaSource: makeFakeMediaSource(),
            gopDecoder: { decodeSegment: jest.fn() },
            width: 1920,
            height: 1080,
            fps: 30,
            segmentDuration: 3,
            cacheBudgetBytes: 1,
        });

        await expect(frameStore.ensureDecoded(5)).rejects.toThrow(/raw bytes not yet fetched/);
        expect(segmentFetcher.ensureRawBytes).not.toHaveBeenCalled();
    });

    test('decodes from already-cached raw bytes and caches the result', async () => {
        const segmentFetcher = makeFakeSegmentFetcher(new Set([3]));
        const gopBuffer = { segmentIndex: 3, frames: [{ timestamp: 9_000_000 }] };
        const gopDecoder = { decodeSegment: jest.fn(() => Promise.resolve(gopBuffer)) };
        const frameStore = new FrameStore({
            segmentFetcher,
            mediaSource: makeFakeMediaSource(),
            gopDecoder,
            width: 1920,
            height: 1080,
            fps: 30,
            segmentDuration: 3,
            cacheBudgetBytes: 1,
        });

        const result = await frameStore.ensureDecoded(3);

        expect(result).toBe(gopBuffer);
        expect(frameStore.has(3)).toBe(true);
        expect(segmentFetcher.ensureRawBytes).not.toHaveBeenCalled();
    });

    test('concurrent calls for the same segment share one in-flight decode', async () => {
        const segmentFetcher = makeFakeSegmentFetcher(new Set([1]));
        let resolveDecode;
        const gopDecoder = {
            decodeSegment: jest.fn(
                () =>
                    new Promise((resolve) => {
                        resolveDecode = resolve;
                    })
            ),
        };
        const frameStore = new FrameStore({
            segmentFetcher,
            mediaSource: makeFakeMediaSource(),
            gopDecoder,
            width: 1920,
            height: 1080,
            fps: 30,
            segmentDuration: 3,
            cacheBudgetBytes: 1,
        });

        const first = frameStore.ensureDecoded(1);
        const second = frameStore.ensureDecoded(1);
        // Let _decode()'s own awaits (fetchInitSegment(), demuxSegment())
        // settle before decodeSegment() is actually reached and
        // resolveDecode gets assigned.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        resolveDecode({ segmentIndex: 1, frames: [{ timestamp: 0 }] });

        await Promise.all([first, second]);
        expect(gopDecoder.decodeSegment).toHaveBeenCalledTimes(1);
    });

    test('a real decode failure enters backoff and reports onError exactly once for concurrent callers', async () => {
        const segmentFetcher = makeFakeSegmentFetcher(new Set([7]));
        const gopDecoder = { decodeSegment: jest.fn(() => Promise.reject(new Error('decoder stalled'))) };
        const errors = [];
        const frameStore = new FrameStore({
            segmentFetcher,
            mediaSource: makeFakeMediaSource(),
            gopDecoder,
            width: 1920,
            height: 1080,
            fps: 30,
            segmentDuration: 3,
            cacheBudgetBytes: 1,
            onError: (err) => errors.push(err),
        });

        const calls = Array.from({ length: 5 }, () => frameStore.ensureDecoded(7).catch(() => {}));
        await Promise.all(calls);

        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('decoder stalled');
        expect(frameStore.isDecodeInBackoff(7)).toBe(true);
    });

    test('is not in backoff before any attempt, and a success clears a prior backoff', async () => {
        const segmentFetcher = makeFakeSegmentFetcher(new Set([2]));
        const frameStore = makeFrameStore(segmentFetcher);

        expect(frameStore.isDecodeInBackoff(2)).toBe(false);

        frameStore._recordDecodeOutcome(2, new Error('boom'));
        expect(frameStore.isDecodeInBackoff(2)).toBe(true);

        frameStore._recordDecodeOutcome(2, null);
        expect(frameStore.isDecodeInBackoff(2)).toBe(false);
    });

    test('a cancellation (AbortError) does not count as a decode failure', () => {
        const frameStore = makeFrameStore();
        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';

        frameStore._recordDecodeOutcome(5, abortErr);

        expect(frameStore.isDecodeInBackoff(5)).toBe(false);
    });
});
