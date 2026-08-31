/**
 * Unit tests for Scheduler's pure/mockable logic: frame-lookup math
 * (#_locateFrameIndex), the two-tier cache pass (#_runCachePass and its
 * Tier 1/Tier 2 halves), and segment-state reporting (#getSegmentStates).
 *
 * Play/pause pacing and real seek races depend on requestAnimationFrame,
 * performance.now(), and real decoded segments, and are exercised instead
 * by the E2E suite against the real running engine.
 *
 * @fileoverview Unit tests for Scheduler's frame-locating, two-tier cache, and segment-state logic.
 * @author Isaac Travers
 * @module video-engine/test/unit/scheduler.test
 */

const { Scheduler } = require('../../src/scheduler.js');
const { SegmentFetcher } = require('../../src/segment-fetcher.js');
const { computeProtectedFloor } = require('../../src/cache-window.js');

/**
 * Builds a Scheduler with the minimal fakes its constructor needs, none of
 * which are exercised by the pure frame-locating logic under test here.
 *
 * @returns {Scheduler} A Scheduler instance safe to call `_locateFrameIndex` on.
 */
function makeScheduler() {
    return new Scheduler({
        segmentIndex: { totalDuration: 0, segments: [] },
        frameStore: { buffers: new Map() },
        canvasRenderer: { onFramePresented: () => {}, canvas: { width: 0, height: 0 } },
        emit: () => {},
    });
}

describe('Scheduler#_locateFrameIndex', () => {
    // Whole-microsecond timestamps, matching how the real demuxer always
    // stores them (see demuxer.js's Math.round(... * 1e6)).
    const gopBuffer = {
        frames: [{ timestamp: 0 }, { timestamp: 1_000_000 }, { timestamp: 2_000_000 }],
    };

    test('atOrBefore lands on the exact frame when the target matches a timestamp exactly', () => {
        const scheduler = makeScheduler();
        expect(scheduler._locateFrameIndex(gopBuffer, 1.0, 'atOrBefore')).toBe(1);
    });

    test('atOrBefore lands on the earlier frame when the target falls between two frames', () => {
        const scheduler = makeScheduler();
        expect(scheduler._locateFrameIndex(gopBuffer, 1.5, 'atOrBefore')).toBe(1);
    });

    test('atOrAfter lands on the exact frame when the target matches a timestamp exactly', () => {
        const scheduler = makeScheduler();
        expect(scheduler._locateFrameIndex(gopBuffer, 1.0, 'atOrAfter')).toBe(1);
    });

    test('atOrAfter lands on the later frame when the target falls between two frames', () => {
        const scheduler = makeScheduler();
        expect(scheduler._locateFrameIndex(gopBuffer, 1.5, 'atOrAfter')).toBe(2);
    });

    test('atOrAfter is not thrown off by a sub-microsecond float overshoot past an exact frame timestamp', () => {
        // Regression guard: repeated +-1/fps arithmetic on targetTimeSeconds
        // can leave it a fraction of a microsecond past an exact frame
        // timestamp -- harmless for atOrBefore, but silently breaks a
        // naive atOrAfter ('>=') comparison exactly on the target frame.
        const scheduler = makeScheduler();
        const justPastOneSecond = 1.0000000004;
        expect(scheduler._locateFrameIndex(gopBuffer, justPastOneSecond, 'atOrAfter')).toBe(1);
    });

    test('uses segment-relative timeline when raw frame timestamps are offset from segment start time', () => {
        // Regression test for post-seek stutter: some streams expose per-
        // segment sample timestamps offset from playlist time (for
        // example, segment 41's decoded timestamps may still sit near
        // segment 40's range). Frame lookup must compare target time in
        // that segment's LOCAL timeline, not the stream-absolute target
        // value directly, or forward playback keeps landing on each
        // segment's edge frame.
        const scheduler = makeScheduler();
        const offsetBuffer = {
            frames: [{ timestamp: 120_080_000 }, { timestamp: 121_080_000 }, { timestamp: 122_080_000 }, { timestamp: 123_000_000 }],
        };

        // Segment metadata says this segment covers [123, 126). A target
        // at t=124 should land ~1s into this buffer (index 1), not on the
        // last frame (index 3).
        expect(scheduler._locateFrameIndex(offsetBuffer, 124.0, 'atOrBefore', 123.0)).toBe(1);
    });
});

/**
 * Builds a uniform SegmentIndex of `count` segments, each `duration`
 * seconds long.
 *
 * @param {number} count - Number of segments.
 * @param {number} duration - Duration of each segment, in seconds.
 * @returns {Object} A SegmentIndex, matching playlist-manager.js's shape.
 */
function makeUniformSegmentIndex(count, duration) {
    const segments = Array.from({ length: count }, (_, index) => ({
        index,
        startTime: index * duration,
        endTime: (index + 1) * duration,
        duration,
    }));
    return { segments, totalDuration: count * duration };
}

/**
 * Builds a fake Tier 1 (SegmentFetcher) + Tier 2 (FrameStore) pair that
 * record every ensureRawBytes()/ensureDecoded()/setPinned()/
 * setProtectedRawSegments() call, for asserting exactly what the
 * scheduler's cache pass reaches for.
 *
 * @param {Object} [opts]
 * @param {Set<number>} [opts.rawBytesIndices] - Segment indices to report as already raw-cached; if omitted, every index reports true (Tier 2 is never gated in that case).
 * @param {Set<number>} [opts.fetchBackoffIndices] - Segment indices isFetchInBackoff() should report true for.
 * @param {Set<number>} [opts.decodeBackoffIndices] - Segment indices isDecodeInBackoff() should report true for.
 * @param {Set<number>} [opts.behindCoverageGapIndices] - Segment indices isBehindCoverageGap() should report true for (no live session can serve them without a backward seek).
 * @param {number} [opts.maxSegmentsBuffered] - Tier 2 decode budget; defaults to effectively unbounded.
 * @returns {Object} `{frameStore, decodedIndices, fetchedIndices, pinnedSnapshots, protectedRawSnapshots}`.
 */
function makeRecordingTiers({
    rawBytesIndices = null,
    fetchBackoffIndices = new Set(),
    decodeBackoffIndices = new Set(),
    behindCoverageGapIndices = new Set(),
    maxSegmentsBuffered = Number.MAX_SAFE_INTEGER,
} = {}) {
    const decodedIndices = [];
    const decodedSet = new Set();
    const fetchedIndices = [];
    const pinnedSnapshots = [];
    const protectedRawSnapshots = [];
    const evictionPrioritySnapshots = [];

    const segmentFetcher = {
        hasRawBytes: (index) => (rawBytesIndices ? rawBytesIndices.has(index) : true),
        isFetchInBackoff: (index) => fetchBackoffIndices.has(index),
        // This fake's ensureRawBytes() "resolves" synchronously (from the
        // test's point of view, within one _runCachePass call) rather than
        // modeling a real pending fetch, so nothing is ever genuinely
        // in-flight here -- these two exist only so the scheduler's own
        // in-flight/concurrency checks don't throw on a missing method.
        hasInFlightFetch: () => false,
        getInFlightFetchCount: () => 0,
        preemptInFlightFetches: () => {},
        setAnchorSegmentIndex: () => {},
        isBehindCoverageGap: (index) => behindCoverageGapIndices.has(index),
        ensureRawBytes: (index) => {
            fetchedIndices.push(index);
            return Promise.resolve();
        },
        setProtectedRawSegments: (indices) => {
            protectedRawSnapshots.push([...indices]);
        },
    };

    const frameStore = {
        segmentFetcher,
        maxSegmentsBuffered,
        // Stateful, like the real cache: once decoded, later passes see
        // has()===true and skip re-decoding the same index.
        has: (index) => decodedSet.has(index),
        isDecodeInBackoff: (index) => decodeBackoffIndices.has(index),
        ensureDecoded: (index) => {
            decodedIndices.push(index);
            decodedSet.add(index);
            return Promise.resolve();
        },
        setPinned: (indices) => {
            pinnedSnapshots.push([...indices]);
        },
        setEvictionPriority: (indices) => {
            evictionPrioritySnapshots.push([...indices]);
        },
    };

    return { frameStore, decodedIndices, fetchedIndices, pinnedSnapshots, protectedRawSnapshots, evictionPrioritySnapshots };
}

describe('Scheduler content-mismatch detection', () => {
    /**
     * Builds a scheduler whose current segment holds one decoded frame at
     * `frameTimestampSeconds`, so a presented frame's own timestamp can be
     * driven independently of the segment grid it is presented under.
     *
     * @param {number} frameTimestampSeconds - The decoded frame's own timestamp, in seconds.
     * @param {number} segmentIndexNumber - Segment index to present it as.
     * @returns {Object} `{scheduler, emitted}`.
     */
    function makeSchedulerWithFrameAt(frameTimestampSeconds, segmentIndexNumber) {
        const emitted = [];
        const frames = [{ timestamp: frameTimestampSeconds * 1e6, displayWidth: 1280, displayHeight: 720 }];
        const { frameStore } = makeRecordingTiers();
        frameStore.buffers = new Map([[segmentIndexNumber, { frames }]]);

        const segmentIndex = makeUniformSegmentIndex(500, 3);
        const scheduler = new Scheduler({
            segmentIndex,
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, canvas: { width: 1280, height: 720 } },
            emit: (type, detail) => emitted.push({ type, detail }),
        });
        scheduler.currentSegmentIndex = segmentIndexNumber;
        scheduler.currentFrameIdx = 0;
        // The engine reports the time derived from the SEGMENT GRID, which
        // is the whole point: it stays self-consistent no matter what
        // content the segment actually holds, so only the decoded frame's
        // own timestamp can contradict it.
        scheduler._presentedMediaTime = segmentIndex.segments[segmentIndexNumber].startTime;
        scheduler.requestVideoFrameCallback(() => {});
        return { scheduler, emitted };
    }

    test('warns when a presented frame\'s own timestamp does not match the time being reported for it', () => {
        // The exact shape of the real bug: absolute segment 375 (1125s)
        // was served bytes from 24s and presented as 1125s. Every number
        // the engine derived stayed self-consistent, because mediaTime
        // comes from the segment grid rather than the decoded bytes --
        // the frame's own timestamp is the only independent signal.
        const { scheduler, emitted } = makeSchedulerWithFrameAt(24.08, 375);

        scheduler._dispatchFrameCallbacks();

        const mismatch = emitted.find((event) => event.type === 'debug' && /CONTENT MISMATCH/.test(event.detail.message));
        expect(mismatch).toBeDefined();
        expect(mismatch.detail.message).toContain('segment 375');
    });

    test('stays silent for the ordinary sub-second offset between a segment\'s start and its first real frame', () => {
        // A segment's first frame routinely sits ~80ms off its declared
        // start with this transcoder -- that is normal, not a mismatch.
        const { scheduler, emitted } = makeSchedulerWithFrameAt(1125.08, 375);

        scheduler._dispatchFrameCallbacks();

        expect(emitted.find((event) => event.type === 'debug' && /CONTENT MISMATCH/.test(event.detail.message))).toBeUndefined();
    });

    test('warns once per segment, not once per frame', () => {
        const { scheduler, emitted } = makeSchedulerWithFrameAt(24.08, 375);

        scheduler.requestVideoFrameCallback(() => {});
        scheduler._dispatchFrameCallbacks();
        scheduler.requestVideoFrameCallback(() => {});
        scheduler._dispatchFrameCallbacks();

        const mismatches = emitted.filter((event) => event.type === 'debug' && /CONTENT MISMATCH/.test(event.detail.message));
        expect(mismatches).toHaveLength(1);
    });
});

describe('Scheduler#_runCachePass', () => {
    test('forward: pins and decodes the protected floor, skewed 2x toward the direction of travel beyond it', () => {
        // A large stream (200 segments) keeps both sides of the
        // opportunistic window far from the stream's own edges, so the
        // 2:1 skew ratio is observable rather than saturated by
        // running out of segments on one side.
        const { frameStore, decodedIndices, pinnedSnapshots } = makeRecordingTiers();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 8;
        scheduler._lastDirectionSign = 1;

        scheduler._runCachePass(300, { symmetric: false }); // segment 100

        const expectedProtected = computeProtectedFloor(100, 200, 3);
        expect(pinnedSnapshots[pinnedSnapshots.length - 1]).toEqual(expectedProtected);
        expect(decodedIndices).toEqual(expect.arrayContaining(expectedProtected));

        const floorMax = Math.max(...expectedProtected);
        const floorMin = Math.min(...expectedProtected);
        const beyondForward = decodedIndices.filter((index) => index > floorMax);
        const beyondBackward = decodedIndices.filter((index) => index < floorMin);

        expect(beyondForward.length).toBeGreaterThan(0);
        expect(beyondForward.length).toBe(beyondBackward.length * 2);
    });

    test('hands the decoded cache a playhead-centred, direction-skewed eviction priority', () => {
        // The cache must evict by distance from the playhead, not by decode
        // age. Without this the playhead's own neighbourhood -- decoded
        // earliest, as the playhead approached -- was always the oldest
        // entry and the first evicted, leaving the island around the
        // playhead the SMALLEST region of the cache while distant segments
        // prefetch had just decoded survived.
        const { frameStore, evictionPrioritySnapshots } = makeRecordingTiers({ maxSegmentsBuffered: 21 });
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 1;
        scheduler._lastDirectionSign = 1;

        scheduler._runCachePass(300, { symmetric: false }); // segment 100

        const priority = evictionPrioritySnapshots[evictionPrioritySnapshots.length - 1];
        expect(priority).toBeDefined();

        // The protected floor around the playhead ranks highest.
        expect(priority.slice(0, 7)).toEqual(computeProtectedFloor(100, 200, 3));

        // Never more entries than the cache can actually hold, or the tail
        // would be asking to keep segments there is no room for.
        expect(priority.length).toBeLessThanOrEqual(21);

        // Every retained index is a near neighbour, and the set is skewed
        // toward the direction of travel rather than symmetric.
        const forward = priority.filter((index) => index > 103).length;
        const backward = priority.filter((index) => index < 97).length;
        expect(forward).toBeGreaterThan(backward);
        expect(Math.max(...priority) - Math.min(...priority)).toBeLessThan(30);
    });

    test('does not step over a backed-off near segment to fetch a distant one', () => {
        // The starvation bug behind "the island around my playhead isn't
        // caching while other islands are." With a single fetch slot (as
        // Jellyfin requires), the scan used to walk past near segments that
        // were temporarily in backoff and spend that slot far away -- where
        // segments were already transcoded to disk and returned in ~59ms,
        // so distant islands filled fast while the playhead's own
        // neighbourhood stayed empty. Waiting is correct: backoff is short
        // and this pass reruns every tick.
        const nearestBackwardCandidate = Math.min(...computeProtectedFloor(100, 200, 3)) - 1;
        const { frameStore, fetchedIndices } = makeRecordingTiers({
            rawBytesIndices: new Set(),
            fetchBackoffIndices: new Set([nearestBackwardCandidate]),
        });
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.currentSegmentIndex = 100;
        scheduler.playbackRate = -8;
        scheduler._lastDirectionSign = -1;

        scheduler._runCachePass(300, { symmetric: false }); // segment 100

        // Nothing further back than the blocked segment was fetched.
        const backwardFetches = fetchedIndices.filter((index) => index < nearestBackwardCandidate);
        expect(backwardFetches).toEqual([]);
    });

    test('applies the concurrency ceiling to the protected floor, not just opportunistic fetches', () => {
        // Jellyfin's HLS transcoder answers one request at a time per
        // session. Firing the whole protected floor at it concurrently made
        // those requests race each other's transcoder restarts, which is
        // what produced the transient 500s -- a lone backward/far request
        // never fails, only concurrent ones do.
        const fetchedIndices = [];
        const frameStore = {
            segmentFetcher: {
                hasRawBytes: () => false,
                isFetchInBackoff: () => false,
                hasInFlightFetch: () => false,
                // Already saturated: one fetch is in flight and the ceiling is 1.
                getInFlightFetchCount: () => 1,
                isBehindCoverageGap: () => false,
                preemptInFlightFetches: () => {},
                setAnchorSegmentIndex: () => {},
                ensureRawBytes: (index) => {
                    fetchedIndices.push(index);
                    return Promise.resolve();
                },
                setProtectedRawSegments: () => {},
            },
            maxSegmentsBuffered: 100,
            has: () => false,
            isDecodeInBackoff: () => false,
            ensureDecoded: () => Promise.resolve(),
            setPinned: () => {},
            setEvictionPriority: () => {},
            buffers: new Map(),
        };
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            maxConcurrentTier1Fetches: 1,
            emit: () => {},
        });

        scheduler._runCachePass(300, { symmetric: false });

        expect(fetchedIndices).toEqual([]);
    });

    test('opportunistic prefetch skips indices no live session can serve without a backward seek', () => {
        // Jellyfin transcodes strictly forward: asking any session for a
        // segment before where its own ffmpeg process started kills and
        // restarts that job (seconds of stall, transient 500s). Segments
        // in that gap become reachable by re-anchoring the behind session
        // further back, not by fetching them from the forward session --
        // so the opportunistic pass must leave them alone.
        const protectedFloor = computeProtectedFloor(100, 200, 3);
        const floorMin = Math.min(...protectedFloor);

        // The highest-priority backward candidates -- the ones immediately
        // below the protected floor. Reverse playback fetches these first,
        // so if they are skipped, it is the coverage-gap check doing it and
        // nothing else. Kept to two, since one pass's pacing cap only
        // launches that many opportunistic fetches (asserted by the control
        // below, which would fail if this assumption ever changed).
        const gapIndices = new Set([floorMin - 1, floorMin - 2]);

        const withGaps = makeRecordingTiers({
            rawBytesIndices: new Set(),
            behindCoverageGapIndices: gapIndices,
        });
        const schedulerWithGaps = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore: withGaps.frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        schedulerWithGaps.playbackRate = -1;
        schedulerWithGaps._lastDirectionSign = -1;
        schedulerWithGaps._runCachePass(300, { symmetric: false }); // segment 100

        for (const gapIndex of gapIndices) {
            expect(withGaps.fetchedIndices).not.toContain(gapIndex);
        }

        // Control: the identical pass with no coverage gap declared DOES
        // fetch those same indices -- so the assertion above is proving the
        // skip, not merely that the pass never reached them.
        const noGaps = makeRecordingTiers({ rawBytesIndices: new Set() });
        const schedulerNoGaps = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore: noGaps.frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        schedulerNoGaps.playbackRate = -1;
        schedulerNoGaps._lastDirectionSign = -1;
        schedulerNoGaps._runCachePass(300, { symmetric: false });

        for (const gapIndex of gapIndices) {
            expect(noGaps.fetchedIndices).toContain(gapIndex);
        }
    });

    test('reverse: skew flips to favor lower segment indices', () => {
        const { frameStore, decodedIndices } = makeRecordingTiers();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = -8;
        scheduler._lastDirectionSign = -1;

        scheduler._runCachePass(300, { symmetric: false }); // segment 100

        const expectedProtected = computeProtectedFloor(100, 200, 3);
        const floorMax = Math.max(...expectedProtected);
        const floorMin = Math.min(...expectedProtected);
        const beyondForward = decodedIndices.filter((index) => index > floorMax);
        const beyondBackward = decodedIndices.filter((index) => index < floorMin);

        expect(beyondBackward.length).toBeGreaterThan(0);
        expect(beyondBackward.length).toBe(beyondForward.length * 2);
    });

    test('paused/symmetric: the opportunistic window is equal-width on both sides, with no rate scaling', () => {
        const { frameStore, decodedIndices } = makeRecordingTiers();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        // A high stored playbackRate must NOT affect a symmetric pass --
        // pause forces base (1x), unscaled width regardless of rate.
        scheduler.playbackRate = 8;
        scheduler._lastDirectionSign = 1;

        scheduler._runCachePass(300, { symmetric: true }); // segment 100

        const expectedProtected = computeProtectedFloor(100, 200, 3);
        const floorMax = Math.max(...expectedProtected);
        const floorMin = Math.min(...expectedProtected);
        const beyondForward = decodedIndices.filter((index) => index > floorMax);
        const beyondBackward = decodedIndices.filter((index) => index < floorMin);

        expect(beyondForward.length).toBeGreaterThan(0);
        expect(beyondForward.length).toBe(beyondBackward.length);
    });

    test('Tier 2 never decodes a segment Tier 1 has not fetched, even inside the protected floor -- but Tier 1 still fetches it unconditionally', () => {
        const { frameStore, decodedIndices, fetchedIndices } = makeRecordingTiers({ rawBytesIndices: new Set([100]) });
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 1;

        scheduler._runCachePass(300, { symmetric: false }); // segment 100

        const expectedProtected = computeProtectedFloor(100, 200, 3);
        expect(decodedIndices).toEqual([100]);
        for (const index of expectedProtected) {
            if (index !== 100) {
                expect(fetchedIndices).toContain(index);
            }
        }
    });

    test('skips ensureDecoded for a segment currently in decode backoff, even though its raw bytes are available', () => {
        const { frameStore, decodedIndices } = makeRecordingTiers({ decodeBackoffIndices: new Set([101]) });
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 8;

        scheduler._runCachePass(300, { symmetric: false });

        expect(decodedIndices).not.toContain(101);
        // Sanity: without backoff this segment would otherwise have decoded.
        expect(decodedIndices).toContain(102);
    });

    test('skips ensureRawBytes for a segment currently in fetch backoff', () => {
        const { frameStore, fetchedIndices } = makeRecordingTiers({
            rawBytesIndices: new Set(),
            fetchBackoffIndices: new Set([120]),
        });
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 8;

        scheduler._runCachePass(300, { symmetric: false });

        expect(fetchedIndices).not.toContain(120);
        // Sanity: this pass does fetch some opportunistic segments beyond
        // the protected floor, just not the backed-off one.
        expect(fetchedIndices.length).toBeGreaterThan(0);
    });

    test('Tier 1 launches more new fetches per pass at a higher |playbackRate|', () => {
        const rate1 = makeRecordingTiers({ rawBytesIndices: new Set() });
        const schedulerAt1x = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore: rate1.frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        schedulerAt1x.playbackRate = 1;
        schedulerAt1x._runCachePass(300, { symmetric: false });

        const rate8 = makeRecordingTiers({ rawBytesIndices: new Set() });
        const schedulerAt8x = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore: rate8.frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        schedulerAt8x.playbackRate = 8;
        schedulerAt8x._runCachePass(300, { symmetric: false });

        const protectedIndices = computeProtectedFloor(100, 200, 3);
        const newAt1x = rate1.fetchedIndices.filter((index) => !protectedIndices.includes(index)).length;
        const newAt8x = rate8.fetchedIndices.filter((index) => !protectedIndices.includes(index)).length;

        expect(newAt8x).toBeGreaterThan(newAt1x);
    });

    /**
     * Builds a fake Tier 1 whose ensureRawBytes() never resolves on its
     * own, genuinely tracking which segments are "in flight" -- unlike
     * makeRecordingTiers()'s fetcher (which resolves synchronously and so
     * never reports anything as in-flight), this lets a test exercise the
     * in-flight-skip and concurrency-ceiling logic in _runTier1FetchPass.
     *
     * @returns {{frameStore: Object, launchedIndices: number[]}}
     */
    function makePendingFetchTiers() {
        const launchedIndices = [];
        const pending = new Set();
        const segmentFetcher = {
            hasRawBytes: () => false,
            isFetchInBackoff: () => false,
            hasInFlightFetch: (index) => pending.has(index),
            getInFlightFetchCount: () => pending.size,
            isBehindCoverageGap: () => false,
            ensureRawBytes: (index) => {
                launchedIndices.push(index);
                pending.add(index);
                return new Promise(() => {}); // never resolves -- stays "in flight"
            },
            setProtectedRawSegments: () => {},
        };
        const frameStore = {
            segmentFetcher,
            maxSegmentsBuffered: Number.MAX_SAFE_INTEGER,
            has: () => false,
            isDecodeInBackoff: () => false,
            ensureDecoded: () => Promise.resolve(),
            setPinned: () => {},
            setEvictionPriority: () => {},
        };
        return { frameStore, launchedIndices };
    }

    test('does not re-launch a fetch already in flight from a previous pass, even though it is not yet cached', () => {
        // Regression test: this pass runs on every render tick (dozens of
        // times a second), and a real fetch takes far longer than one
        // tick -- without an in-flight check, the same still-pending
        // segments get a harmless-but-wasteful repeat ensureRawBytes()
        // call every single tick until they resolve, burning the pacing
        // budget on no-ops instead of letting the frontier advance.
        const { frameStore, launchedIndices } = makePendingFetchTiers();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 1;

        scheduler._runCachePass(300, { symmetric: false });
        const launchedAfterFirstPass = [...launchedIndices];

        scheduler._runCachePass(300, { symmetric: false });
        scheduler._runCachePass(300, { symmetric: false });

        expect(launchedIndices).toEqual(launchedAfterFirstPass);
    });

    test('stops launching new opportunistic fetches once the concurrency ceiling is reached', () => {
        // Regression test: an unbounded opportunistic reach combined with
        // a rate-scaled pacing cap can ask for a very large batch of new
        // fetches in one pass (e.g. 100 at a high rate) -- without a
        // ceiling on total simultaneous in-flight fetches, that overruns
        // the browser's own per-origin connection limit, queuing a
        // newly-urgent fetch (e.g. a seek's own cold target) behind a
        // pile of low-priority ones instead of racing them.
        const { frameStore, launchedIndices } = makePendingFetchTiers();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(200, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });
        scheduler.playbackRate = 50; // pacing cap would otherwise be ~100

        scheduler._runCachePass(300, { symmetric: false });

        const protectedIndices = computeProtectedFloor(100, 200, 3);
        const opportunisticLaunches = launchedIndices.filter((index) => !protectedIndices.includes(index));

        // The protected floor (7 segments) alone already meets the
        // ceiling (6), so no opportunistic fetch should launch at all --
        // demonstrating the ceiling engages well short of the ~100 a bare
        // pacing cap would otherwise allow.
        expect(opportunisticLaunches).toHaveLength(0);
    });

    test('does not call emit("error", ...) itself when ensureRawBytes/ensureDecoded reject -- SegmentFetcher/FrameStore report failures, not the per-call site', async () => {
        // Regression test for a real duplicate-error-burst bug: this
        // pass runs on every render-loop tick, so wrapping its own calls
        // in `.catch((err) => emit('error', err))` would re-report a
        // failure every tick that ran while a segment was still in
        // flight. Error reporting happens exactly once, from inside
        // SegmentFetcher/FrameStore's own onError, so this call site must
        // swallow rejections silently instead of re-reporting them.
        const emitSpy = jest.fn();
        const frameStore = {
            segmentFetcher: {
                hasRawBytes: () => false,
                isFetchInBackoff: () => false,
                hasInFlightFetch: () => false,
                getInFlightFetchCount: () => 0,
                isBehindCoverageGap: () => false,
                ensureRawBytes: () => Promise.reject(new Error('fetch failed')),
                setProtectedRawSegments: () => {},
            },
            maxSegmentsBuffered: 100,
            has: () => false,
            isDecodeInBackoff: () => false,
            ensureDecoded: () => Promise.reject(new Error('decode failed')),
            setPinned: () => {},
            setEvictionPriority: () => {},
        };
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(20, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: emitSpy,
        });
        scheduler.playbackRate = 8;

        scheduler._runCachePass(0, { symmetric: false });
        await new Promise((resolve) => setImmediate(resolve));

        expect(emitSpy).not.toHaveBeenCalledWith('error', expect.anything());
    });
});

describe('Scheduler#getSegmentStates', () => {
    test('reports fetched/decoded/pinned per segment, independently of each other', () => {
        // Deliberately mixed states -- segment 1 is fetched but not
        // decoded (still just raw bytes), segment 2 is decoded but not
        // pinned (already evicted from the lookahead window), matching
        // real states a scrub-bar visualization needs to tell apart.
        const frameStore = {
            segmentFetcher: { hasRawBytes: (index) => index === 1 || index === 2 },
            has: (index) => index === 2,
            pinned: new Set([0]),
        };
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(3, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {} },
            emit: () => {},
        });

        expect(scheduler.getSegmentStates()).toEqual([
            { index: 0, startTime: 0, endTime: 3, fetched: false, decoded: false, pinned: true },
            { index: 1, startTime: 3, endTime: 6, fetched: true, decoded: false, pinned: false },
            { index: 2, startTime: 6, endTime: 9, fetched: true, decoded: true, pinned: false },
        ]);
    });
});

/**
 * Builds a fake Tier 1 whose ensureRawBytes() never resolves on its own --
 * it only settles when the test explicitly resolves/rejects a captured
 * call, or when the passed AbortSignal fires -- so a test can assert
 * exactly when Scheduler.seek() aborts a still-pending call without
 * needing a real fetch/demux/decode pipeline. Tier 2's ensureDecoded()
 * just reads back whatever the test has already placed in `buffers`
 * (mirroring how a real decode populates it) once Tier 1 resolves.
 *
 * @returns {{frameStore: Object, calls: Array<{index: number, signal: (AbortSignal|undefined), resolve: Function, reject: Function}>}} The fake FrameStore/SegmentFetcher pair and the list of ensureRawBytes() calls it's received, in order, each with its own resolve/reject.
 */
function makeControllableFrameStore() {
    const calls = [];
    const buffers = new Map();
    const segmentFetcher = {
        hasRawBytes: (index) => buffers.has(index),
        isFetchInBackoff: () => false,
        hasInFlightFetch: () => false,
        getInFlightFetchCount: () => 0,
        isBehindCoverageGap: () => false,
        setProtectedRawSegments: () => {},
        preemptInFlightFetches: () => {},
        setAnchorSegmentIndex: () => {},
        ensureRawBytes(index, { signal } = {}) {
            return new Promise((resolve, reject) => {
                calls.push({ index, signal, resolve, reject });
                if (signal) {
                    signal.addEventListener('abort', () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                }
            });
        },
    };
    const frameStore = {
        buffers,
        segmentFetcher,
        maxSegmentsBuffered: Number.MAX_SAFE_INTEGER,
        has: (index) => buffers.has(index),
        isDecodeInBackoff: () => false,
        setPinned: () => {},
            setEvictionPriority: () => {},
        async ensureDecoded(index) {
            return buffers.get(index);
        },
    };
    return { frameStore, calls };
}

describe('Scheduler#seek supersession', () => {
    test("a new seek() aborts the previous one's still-pending ensureRawBytes(), which abandons silently instead of throwing", async () => {
        // Regression test for the real "scrub-drag backlog" bug: every
        // seek() used to kick off an uncancellable raw-byte fetch, so
        // dragging over many segments before releasing queued real
        // fetch/decode work for every one of them. seek() must now cancel
        // its own previous call's want the instant a newer one starts.
        const { frameStore, calls } = makeControllableFrameStore();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(20, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true },
            emit: () => {},
        });

        const firstSeekPromise = scheduler.seek(10); // segment 3 ([9, 12))
        await Promise.resolve(); // let seek()'s microtasks run up to its ensureRawBytes() call
        expect(calls).toHaveLength(1);
        expect(calls[0].signal.aborted).toBe(false);

        const secondSeekPromise = scheduler.seek(50); // segment 16 ([48, 51)) -- supersedes the first
        await Promise.resolve();

        expect(calls[0].signal.aborted).toBe(true);
        // The superseded seek must resolve quietly, not reject/throw --
        // its own ensureRawBytes() rejected internally, but seek() catches
        // that specific (aborted) case and abandons rather than
        // propagating it as a real error.
        await expect(firstSeekPromise).resolves.toBeUndefined();

        // Let the second (real, current) seek's ensureRawBytes resolve
        // normally, and confirm it completes and applies its result.
        frameStore.buffers.set(calls[1].index, { frames: [{ timestamp: 50_000_000 }] });
        calls[1].resolve();
        await secondSeekPromise;

        expect(scheduler.currentSegmentIndex).toBe(calls[1].index);
    });

    test('two consecutive seeks landing in the SAME segment do not abort each other\'s shared fetch', async () => {
        // Regression test for a real bug the fix above introduced: seek()
        // used to release the previous seek's want BEFORE registering the
        // new one. When both seeks target the same segment (very likely
        // mid-drag, since many pointermove events land within one ~1-3s
        // segment), that ordering let the shared entry's wanter count
        // touch zero in between, aborting the fetch the new seek was
        // about to depend on. This test exercises the REAL SegmentFetcher
        // (Tier 1 now owns the wanter-refcounted cancellation this
        // regression guards), with global.fetch mocked to hang.
        let capturedSignal = null;
        const previousFetch = global.fetch;
        global.fetch = jest.fn((url, { signal } = {}) => {
            capturedSignal = signal;
            return new Promise(() => {}); // never resolves -- only test whether it gets aborted
        });

        try {
            const segmentIndex = makeUniformSegmentIndex(20, 3);
            const realSegmentFetcher = new SegmentFetcher({
                initSegmentUrl: 'https://example.invalid/init.mp4',
                segments: segmentIndex.segments.map((segment) => ({ ...segment, url: `https://example.invalid/${segment.index}.m4s` })),
            });
            const frameStore = {
                segmentFetcher: realSegmentFetcher,
                has: () => false,
                ensureDecoded: () => Promise.resolve(),
            };
            const scheduler = new Scheduler({
                segmentIndex,
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true },
                emit: () => {},
            });

            scheduler.seek(10.0); // segment 3
            await Promise.resolve();
            await Promise.resolve();
            const entry = realSegmentFetcher._inFlightFetches.get(3);
            expect(entry).toBeDefined();
            expect(capturedSignal.aborted).toBe(false);

            scheduler.seek(10.5); // still segment 3 ([9, 12)) -- same underlying fetch
            await Promise.resolve();
            await Promise.resolve();

            // The shared entry's fetch must still be alive -- both seeks want
            // segment 3, so releasing the first one's want must not have
            // dropped the count to zero.
            expect(capturedSignal.aborted).toBe(false);
            expect(realSegmentFetcher._inFlightFetches.get(3)).toBe(entry);
        } finally {
            global.fetch = previousFetch;
        }
    });
});

/**
 * Builds a fake Tier 1/Tier 2 pair whose ensureRawBytes()/ensureDecoded()
 * actually "succeed" -- populating `buffers` with a minimal one-frame
 * GopBuffer keyed by segment index -- so a real Scheduler#seek() call can
 * complete end-to-end, while also recording every call so a test can
 * confirm which segments the cache pass actually reached for.
 *
 * @param {number} segmentDurationSeconds - Nominal segment duration, used to synthesize each fake GopBuffer's single frame timestamp.
 * @returns {Object} A fake FrameStore usable with a real Scheduler#seek() call.
 */
function makeSeekableRecordingFrameStore(segmentDurationSeconds) {
    const buffers = new Map();
    const fetchedIndices = [];
    const decodedIndices = [];
    let pinned = null;
    const segmentFetcher = {
        hasRawBytes: (index) => buffers.has(index) || fetchedIndices.includes(index),
        isFetchInBackoff: () => false,
        hasInFlightFetch: () => false,
        getInFlightFetchCount: () => 0,
        isBehindCoverageGap: () => false,
        setProtectedRawSegments: () => {},
        preemptInFlightFetches: () => {},
        setAnchorSegmentIndex: () => {},
        ensureRawBytes(index) {
            fetchedIndices.push(index);
            return Promise.resolve();
        },
    };
    const frameStore = {
        buffers,
        segmentFetcher,
        maxSegmentsBuffered: Number.MAX_SAFE_INTEGER,
        has: (index) => buffers.has(index),
        isDecodeInBackoff: () => false,
        async ensureDecoded(index) {
            decodedIndices.push(index);
            if (!buffers.has(index)) {
                buffers.set(index, { frames: [{ timestamp: Math.round(index * segmentDurationSeconds * 1e6) }] });
            }
            return buffers.get(index);
        },
        setEvictionPriority() {},
        setPinned(indices) {
            pinned = [...indices];
        },
        get pinnedSnapshot() {
            return pinned;
        },
    };
    return { frameStore, fetchedIndices, decodedIndices };
}

describe('Scheduler#seek kicks off the cache pass immediately', () => {
    test('fetches/decodes the protected floor right away, even while paused, not only once playback starts', async () => {
        // Regression test for a real, confirmed-live bug: the cache pass
        // was only ever run from _tick(), which only runs while
        // scheduler.playing is true. Landing a seek while paused (a
        // completely ordinary workflow -- drag the scrub bar, release,
        // look at the frame, then decide to play) used to fetch only the
        // exact target segment and leave everything ahead of it
        // completely cold.
        const { frameStore, fetchedIndices } = makeSeekableRecordingFrameStore(1);
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(20, 1),
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true },
            emit: () => {},
            // Pinned explicitly: the floor is otherwise derived from unit
            // duration (see PROTECTED_FLOOR_RADIUS_SECONDS), and this test
            // is about a paused seek running the cache pass at all, not
            // about how wide the floor is.
            protectedFloorRadius: 3,
        });
        expect(scheduler.playing).toBe(false);

        await scheduler.seek(0.5); // lands in segment 0 ([0, 1))

        const expectedProtected = computeProtectedFloor(0, 20, 3);
        expect(frameStore.pinnedSnapshot).toEqual(expectedProtected);
        // Something beyond the protected floor should already be queued
        // for raw-byte fetch (Tier 1's unbounded, paced reach).
        expect(fetchedIndices.some((index) => !expectedProtected.includes(index))).toBe(true);
    });
});

describe('Scheduler#seek preempts lower-priority in-flight fetches', () => {
    /**
     * Builds a fake Tier 1/Tier 2 pair whose ensureRawBytes()/
     * ensureDecoded() succeed synchronously (populating `buffers`), while
     * recording every preemptInFlightFetches() call -- enough to confirm
     * seek() asks Tier 1 to preempt lower-priority fetches exactly when,
     * and only when, its own target actually needs a new fetch.
     *
     * @param {Map<number, Object>} initialBuffers - Segments to seed as already-cached raw bytes AND decoded frames.
     * @returns {{frameStore: Object, preemptCalls: number[][]}}
     */
    function makeSeekPreemptionFrameStore(initialBuffers) {
        const buffers = new Map(initialBuffers);
        const preemptCalls = [];
        const segmentFetcher = {
            hasRawBytes: (index) => buffers.has(index),
            isFetchInBackoff: () => false,
            hasInFlightFetch: () => false,
            getInFlightFetchCount: () => 0,
            isBehindCoverageGap: () => false,
            setProtectedRawSegments: () => {},
            preemptInFlightFetches: (keepIndices) => preemptCalls.push([...keepIndices]),
            setAnchorSegmentIndex: () => {},
            ensureRawBytes: (index) => {
                if (!buffers.has(index)) {
                    buffers.set(index, { frames: [{ timestamp: Math.round(index * 3 * 1e6) }] });
                }
                return Promise.resolve(buffers.get(index));
            },
        };
        const frameStore = {
            buffers,
            segmentFetcher,
            maxSegmentsBuffered: Number.MAX_SAFE_INTEGER,
            has: (index) => buffers.has(index),
            isDecodeInBackoff: () => false,
            setPinned: () => {},
            setEvictionPriority: () => {},
            async ensureDecoded(index) {
                return buffers.get(index);
            },
        };
        return { frameStore, preemptCalls };
    }

    test('preempts other in-flight fetches when the seek target is not yet cached', async () => {
        // Regression test: a seek's own fetch used to just join the
        // browser's connection queue alongside already-in-flight
        // background-prefetch fetches, sometimes finishing LAST purely by
        // chance of byte size/network timing -- confirmed live with a
        // seek landing after 6 unrelated lower-priority fetches.
        const { frameStore, preemptCalls } = makeSeekPreemptionFrameStore(new Map());
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(20, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true },
            emit: () => {},
        });

        await scheduler.seek(30); // segment 10, cold

        expect(preemptCalls).toEqual([[10]]);
    });

    test('does not preempt anything when the seek target is already cached', async () => {
        const { frameStore, preemptCalls } = makeSeekPreemptionFrameStore(
            new Map([[10, { frames: [{ timestamp: 30_000_000 }] }]])
        );
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(20, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true },
            emit: () => {},
        });

        await scheduler.seek(30); // segment 10, already cached -- no new fetch needed

        expect(preemptCalls).toHaveLength(0);
    });
});

describe('Scheduler#_tick stall anchoring', () => {
    test('re-anchors to the target time, not the last-displayed position, so a stall does not oscillate back into the last decoded segment', () => {
        // Regression test: anchoring to currentTime (behind the segment
        // boundary) let the next tick's tiny elapsed increment land back
        // inside the already-decoded segment, "succeeding" there for
        // ~one frame's duration before re-crossing into the stall --
        // confirmed live as a rapid waiting/playing flicker for the
        // whole real length of the stall.
        const frameStore = {
            buffers: new Map([[0, { frames: [{ timestamp: 2_960_000 }] }]]),
            has: (index) => index === 0,
            isDecodeInBackoff: () => false,
            ensureDecoded: () => Promise.resolve(),
            setPinned: () => {},
            setEvictionPriority: () => {},
            pinned: new Set(),
            segmentFetcher: {
                hasRawBytes: () => false,
                isFetchInBackoff: () => false,
                hasInFlightFetch: () => false,
                getInFlightFetchCount: () => 0,
                isBehindCoverageGap: () => false,
                ensureRawBytes: () => Promise.resolve(),
                setProtectedRawSegments: () => {},
            },
        };
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(4, 3), // segment 0: [0,3), segment 1: [3,6)
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });
        scheduler.playing = true;
        scheduler.playbackRate = 1;
        scheduler.currentSegmentIndex = 0;
        scheduler.currentFrameIdx = 0;
        scheduler._presentedMediaTime = 2.96;
        scheduler._anchorTime = 2.96;
        scheduler._anchorWallClockMs = 1000;
        scheduler._scheduleTick = () => {};

        scheduler._tick(1050); // targetTime = 2.96 + 0.05 = 3.01 -- crosses into segment 1, stalls
        expect(scheduler._anchorTime).toBeCloseTo(3.01, 5);

        const renderSpy = jest.spyOn(scheduler, '_renderAtTime');
        scheduler._tick(1066); // only 16ms later -- must still target segment 1, not fall back to segment 0
        expect(renderSpy.mock.calls[0][0]).toBeGreaterThanOrEqual(3.0);
    });
});

describe('Scheduler#_tick pauses advancement while a seek is in flight', () => {
    test('does not render or touch the anchor while seekingFlag is true', () => {
        // Regression test: play() called right after a slow seek used to
        // just keep advancing from the stale pre-seek anchor, making a
        // real, still-in-flight seek look like it had silently failed.
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(4, 3),
            frameStore: { buffers: new Map(), has: () => true, setPinned: () => {}, setEvictionPriority: () => {}, pinned: new Set() },
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });
        scheduler.playing = true;
        scheduler.seekingFlag = true;
        scheduler._anchorTime = 0;
        scheduler._anchorWallClockMs = 1000;
        const renderSpy = jest.spyOn(scheduler, '_renderAtTime');
        scheduler._scheduleTick = () => {};

        scheduler._tick(5000);

        expect(renderSpy).not.toHaveBeenCalled();
        expect(scheduler._anchorWallClockMs).toBe(1000);
    });
});

describe('Scheduler buffering-state signal', () => {
    test('_updateBufferState emits waiting/playing only on an actual transition', () => {
        const emitSpy = jest.fn();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(4, 3),
            frameStore: { buffers: new Map() },
            canvasRenderer: { onFramePresented: () => {} },
            emit: emitSpy,
        });

        scheduler.playing = true;
        scheduler._updateBufferState('fetching');
        scheduler._updateBufferState('fetching'); // same state -- no-op
        scheduler._updateBufferState('decoding'); // reason changed
        scheduler._updateBufferState(null);

        expect(emitSpy.mock.calls).toEqual([
            ['waiting', { reason: 'fetching' }],
            ['waiting', { reason: 'decoding' }],
            ['playing'],
        ]);
    });

    test('a tick stall emits "fetching" before raw bytes arrive, "decoding" once they do', () => {
        const emitSpy = jest.fn();
        const rawBytesIndices = new Set();
        const frameStore = {
            buffers: new Map(),
            has: () => false,
            isDecodeInBackoff: () => false,
            ensureDecoded: () => Promise.resolve(),
            setPinned: () => {},
            setEvictionPriority: () => {},
            pinned: new Set(),
            segmentFetcher: {
                hasRawBytes: (index) => rawBytesIndices.has(index),
                isFetchInBackoff: () => false,
                hasInFlightFetch: () => false,
                getInFlightFetchCount: () => 0,
                isBehindCoverageGap: () => false,
                ensureRawBytes: () => Promise.resolve(),
                setProtectedRawSegments: () => {},
            },
        };
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(4, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: emitSpy,
        });
        scheduler.playing = true;
        scheduler.playbackRate = 1;
        scheduler._anchorTime = 0;
        scheduler._anchorWallClockMs = 1000;
        scheduler._scheduleTick = () => {};

        scheduler._tick(1000);
        expect(emitSpy).toHaveBeenCalledWith('waiting', { reason: 'fetching' });

        rawBytesIndices.add(0); // raw bytes now present, decode still pending
        scheduler._tick(1000);
        expect(emitSpy).toHaveBeenCalledWith('waiting', { reason: 'decoding' });
    });
});

describe('Scheduler boundary and pause behavior', () => {
    test('does not auto-pause on the first forward tick at t=0', () => {
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(4, 3),
            frameStore: {
                buffers: new Map(),
                has: () => true,
                ensureDecoded: () => Promise.resolve(),
                setPinned: () => {},
            setEvictionPriority: () => {},
                pinned: new Set(),
            },
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });
        scheduler.playing = true;
        scheduler.playbackRate = 1;
        scheduler._anchorTime = 0;
        scheduler._anchorWallClockMs = 1000;
        scheduler._renderAtTime = () => true;
        scheduler._runCachePass = () => {};
        scheduler._scheduleTick = () => {};
        const pauseSpy = jest.spyOn(scheduler, 'pause');

        scheduler._tick(1000);

        expect(pauseSpy).not.toHaveBeenCalled();
        expect(scheduler.playing).toBe(true);
    });

    test('pauses at t=0 only when actually playing in reverse', () => {
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(4, 3),
            frameStore: {
                buffers: new Map(),
                has: () => true,
                ensureDecoded: () => Promise.resolve(),
                setPinned: () => {},
            setEvictionPriority: () => {},
                pinned: new Set(),
            },
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });
        scheduler.playing = true;
        scheduler.playbackRate = -1;
        scheduler._anchorTime = 0;
        scheduler._anchorWallClockMs = 1000;
        scheduler._renderAtTime = () => true;
        scheduler._runCachePass = () => {};
        scheduler._scheduleTick = () => {};
        const pauseSpy = jest.spyOn(scheduler, 'pause');

        scheduler._tick(1000);

        expect(pauseSpy).toHaveBeenCalledTimes(1);
    });

    test('pause runs an immediate symmetric cache pass warming the protected floor', () => {
        const { frameStore, decodedIndices, pinnedSnapshots } = makeRecordingTiers();
        const scheduler = new Scheduler({
            segmentIndex: makeUniformSegmentIndex(20, 3),
            frameStore,
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });

        scheduler.playing = true;
        scheduler.currentSegmentIndex = 10;
        scheduler.currentFrameIdx = 0;
        scheduler._presentedMediaTime = 30;

        scheduler.pause();

        const expectedProtected = computeProtectedFloor(10, 20, 3);
        expect(pinnedSnapshots[pinnedSnapshots.length - 1]).toEqual(expectedProtected);
        expect(decodedIndices).toEqual(expect.arrayContaining(expectedProtected));
        expect(scheduler.playing).toBe(false);
    });
});

describe('Scheduler paused background cache-fill worker', () => {
    test('starts the paused fill worker on pause and stops it on play', () => {
        jest.useFakeTimers();
        try {
            const { frameStore } = makeRecordingTiers();
            const scheduler = new Scheduler({
                segmentIndex: makeUniformSegmentIndex(10, 3),
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
                emit: () => {},
            });

            scheduler.playing = true;
            scheduler.currentSegmentIndex = 0;
            scheduler.currentFrameIdx = 0;
            scheduler.pause();

            expect(scheduler._pausedIntervalHandle).not.toBeNull();

            scheduler._scheduleTick = () => {};
            scheduler.play();

            expect(scheduler._pausedIntervalHandle).toBeNull();
        } finally {
            jest.useRealTimers();
        }
    });

    test('while paused, the worker keeps re-running the SAME fixed-width symmetric window every interval -- no growing-over-time horizon', () => {
        jest.useFakeTimers();
        try {
            const { frameStore, decodedIndices } = makeRecordingTiers();
            const scheduler = new Scheduler({
                segmentIndex: makeUniformSegmentIndex(20, 3),
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
                emit: () => {},
            });

            scheduler.playing = true;
            scheduler.currentSegmentIndex = 10;
            scheduler.currentFrameIdx = 0;
            scheduler._presentedMediaTime = 30;
            scheduler.pause();

            const afterFirstPass = new Set(decodedIndices);

            jest.advanceTimersByTime(9000); // many more passes

            const afterManyPasses = new Set(decodedIndices);

            // Every index the worker ever reaches for was already reached
            // for on the very first pass -- passing more wall-clock time
            // must not widen the window (unlike the old growing-horizon
            // paused mode this replaces).
            for (const index of afterManyPasses) {
                expect(afterFirstPass.has(index)).toBe(true);
            }
            // Sanity: it did expand symmetrically beyond the protected
            // floor on both sides on that very first pass.
            const expectedProtected = computeProtectedFloor(10, 20, 3);
            const floorMax = Math.max(...expectedProtected);
            const floorMin = Math.min(...expectedProtected);
            expect([...afterFirstPass].some((index) => index > floorMax)).toBe(true);
            expect([...afterFirstPass].some((index) => index < floorMin)).toBe(true);
        } finally {
            jest.useRealTimers();
        }
    });

    test('while paused, a seek recenters the protected floor on the new position', async () => {
        jest.useFakeTimers();
        try {
            const segmentIndex = makeUniformSegmentIndex(80, 3);
            const { frameStore, pinnedSnapshots } = makeRecordingTiers();
            frameStore.buffers = new Map([[10, { frames: [{ timestamp: 1_000_000 }] }]]);
            frameStore.has = (index) => frameStore.buffers.has(index);
            frameStore.segmentFetcher.hasRawBytes = () => true;
            frameStore.ensureDecoded = async (index) => {
                if (!frameStore.buffers.has(index)) {
                    const seg = segmentIndex.segments[index];
                    frameStore.buffers.set(index, { frames: [{ timestamp: Math.round(seg.startTime * 1e6) }] });
                }
                return frameStore.buffers.get(index);
            };

            const scheduler = new Scheduler({
                segmentIndex,
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
                emit: () => {},
            });

            scheduler.playing = true;
            scheduler.currentSegmentIndex = 10;
            scheduler.currentFrameIdx = 0;
            scheduler._presentedMediaTime = 30;

            scheduler.pause();
            jest.advanceTimersByTime(1000);
            const preSeekPinned = pinnedSnapshots[pinnedSnapshots.length - 1];

            await scheduler.seek(150); // segment 50
            jest.advanceTimersByTime(1000);
            const postSeekPinned = pinnedSnapshots[pinnedSnapshots.length - 1];

            expect(preSeekPinned).toContain(10);
            expect(postSeekPinned).toEqual(computeProtectedFloor(50, 80, 3));
        } finally {
            jest.useRealTimers();
        }
    });

    test('while paused, a seek clears the buffering state via "canplay", never "playing"', async () => {
        // Regression test: seek() clears the buffer state on landing, and
        // _updateBufferState(null) used to emit 'playing' unconditionally --
        // so a cold paused seek (which sets waiting=fetching/decoding on the
        // way in) ended by announcing playback had started while paused was
        // still true, leaving the transport button showing the pause icon.
        // The spinner must still clear, hence 'canplay' rather than nothing.
        jest.useFakeTimers();
        try {
            const segmentIndex = makeUniformSegmentIndex(20, 3);
            const { frameStore } = makeRecordingTiers();
            frameStore.buffers = new Map([[10, { frames: [{ timestamp: 1_000_000 }] }]]);
            frameStore.has = (index) => frameStore.buffers.has(index);
            frameStore.segmentFetcher.hasRawBytes = () => false;
            frameStore.ensureDecoded = async (index) => {
                if (!frameStore.buffers.has(index)) {
                    const seg = segmentIndex.segments[index];
                    frameStore.buffers.set(index, { frames: [{ timestamp: Math.round(seg.startTime * 1e6) }] });
                }
                return frameStore.buffers.get(index);
            };

            const emitted = [];
            const scheduler = new Scheduler({
                segmentIndex,
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
                emit: (eventType, detail) => emitted.push({ eventType, detail }),
            });

            scheduler.currentSegmentIndex = 10;
            scheduler.currentFrameIdx = 0;
            scheduler._presentedMediaTime = 30;
            expect(scheduler.playing).toBe(false);

            await scheduler.seek(50);

            const types = emitted.map((entry) => entry.eventType);
            expect(types).toContain('waiting');
            expect(types).toContain('canplay');
            expect(types).not.toContain('playing');
            expect(scheduler.playing).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    test('while paused, expansion decode waits for raw bytes and only the protected core decodes immediately', () => {
        jest.useFakeTimers();
        try {
            const { frameStore, decodedIndices } = makeRecordingTiers({
                rawBytesIndices: new Set([7, 8, 9, 10, 11, 12, 13]),
            });
            const scheduler = new Scheduler({
                segmentIndex: makeUniformSegmentIndex(40, 3),
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
                emit: () => {},
            });

            scheduler.playing = true;
            scheduler.currentSegmentIndex = 10;
            scheduler.currentFrameIdx = 0;
            scheduler._presentedMediaTime = 30;

            scheduler.pause();
            jest.advanceTimersByTime(3000);

            const expectedProtected = computeProtectedFloor(10, 40, 3);
            expect(decodedIndices.sort((a, b) => a - b)).toEqual(expectedProtected);
        } finally {
            jest.useRealTimers();
        }
    });

    test('while paused, the segment at the paused anchor stays pinned across every interval pass', () => {
        jest.useFakeTimers();
        try {
            const { frameStore, pinnedSnapshots } = makeRecordingTiers();
            const scheduler = new Scheduler({
                segmentIndex: makeUniformSegmentIndex(40, 3),
                frameStore,
                canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
                emit: () => {},
            });

            scheduler.playing = true;
            scheduler.currentSegmentIndex = 10;
            scheduler.currentFrameIdx = 0;
            scheduler._presentedMediaTime = 30;
            scheduler.pause();

            jest.advanceTimersByTime(3000);

            expect(pinnedSnapshots.length).toBeGreaterThan(1);
            for (const snapshot of pinnedSnapshots) {
                expect(snapshot).toContain(10);
            }
        } finally {
            jest.useRealTimers();
        }
    });
});

describe('Scheduler reverse boundary continuity', () => {
    function makeSegmentLocalTimestampBuffer(frameCount = 75, frameStepMicros = 40_000) {
        return {
            frames: Array.from({ length: frameCount }, (_, index) => ({
                // Segment-local raw timeline (starts at 80ms), matching
                // the real stream pattern where raw frame timestamps are
                // not stream-absolute and need scheduler remapping.
                timestamp: 80_000 + index * frameStepMicros,
            })),
        };
    }

    test('reverse render progression remains monotonic and does not jump wildly across segment boundary', () => {
        const segmentIndex = makeUniformSegmentIndex(3, 3);
        const buffers = new Map([
            [0, makeSegmentLocalTimestampBuffer()],
            [1, makeSegmentLocalTimestampBuffer()],
        ]);

        const scheduler = new Scheduler({
            segmentIndex,
            frameStore: {
                buffers,
                has: (index) => buffers.has(index),
                setPinned: () => {},
            setEvictionPriority: () => {},
                pinned: new Set(),
            },
            canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });

        // Start in segment 1 and sweep backward across the boundary into
        // segment 0 with reverse frame selection.
        let previousShownTime = Infinity;
        for (let target = 3.40; target >= 2.60; target -= 0.04) {
            const rendered = scheduler._renderAtTime(target, 'atOrAfter');
            expect(rendered).toBe(true);

            const shownTime = scheduler.currentTime;
            if (Number.isFinite(previousShownTime)) {
                const shownDelta = shownTime - previousShownTime;

                // Never move forward while rewinding.
                expect(shownTime).toBeLessThanOrEqual(previousShownTime + 1e-9);

                // A single boundary hop can skip an extra frame, but not a
                // large chunk of time.
                expect(shownDelta).toBeGreaterThanOrEqual(-0.20);
            }

            previousShownTime = shownTime;
        }
    });
});

describe('Scheduler#close', () => {
    test('stops the paused fill worker, aborts every in-flight fetch, and closes the frame store -- and does not let pause() resurrect the worker', () => {
        // Regression test: close() used to call pause(), which
        // unconditionally restarts the paused-fill worker after running
        // one more cache pass -- silently undoing the _stopPausedFillWorker()
        // call right before it, so the old engine's 500ms background cache
        // pass (and its ensureDecoded/fetch calls against an
        // already-closed decoder/aborted fetcher) never actually stopped.
        // Confirmed live as a multi-second delay before a replaced engine
        // became ready, caused by the old engine still actively decoding.
        jest.useFakeTimers();
        const preemptInFlightFetches = jest.fn();
        const close = jest.fn();
        const scheduler = new Scheduler({
            segmentIndex: { totalDuration: 100, segments: [{ index: 0, startTime: 0, endTime: 10 }] },
            frameStore: { buffers: new Map(), segmentFetcher: { preemptInFlightFetches }, close },
            canvasRenderer: { onFramePresented: () => {}, canvas: { width: 0, height: 0 } },
            emit: () => {},
        });

        // Simulate a playing engine with its paused-fill worker not
        // running yet (matches real usage: close() is called on an
        // engine that may currently be playing).
        scheduler.playing = true;
        scheduler._startPausedFillWorker();

        scheduler.close();

        expect(preemptInFlightFetches).toHaveBeenCalledWith([]);
        expect(close).toHaveBeenCalledTimes(1);
        expect(scheduler._pausedIntervalHandle).toBeNull();

        // Advance well past one 500ms fill interval -- if pause()'s
        // restart-the-worker side effect leaked through, this would fire
        // another cache pass here.
        const runCachePassSpy = jest.spyOn(scheduler, '_runCachePass');
        jest.advanceTimersByTime(2000);
        expect(runCachePassSpy).not.toHaveBeenCalled();

        jest.useRealTimers();
    });
});
