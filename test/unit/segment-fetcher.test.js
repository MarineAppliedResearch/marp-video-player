/**
 * Unit tests for SegmentFetcher#hasRawBytes -- the raw-bytes-cached check
 * getSegmentStates() relies on for scrub-bar visualization. Mocks the
 * global fetch() (available natively in the Node version this project
 * targets) rather than hitting a real server, since only the cache-status
 * bookkeeping is under test here, not real network behavior.
 *
 * @fileoverview Unit tests for SegmentFetcher's raw-bytes cache status.
 * @author Isaac Travers
 * @module video-engine/test/unit/segment-fetcher.test
 */

const { SegmentFetcher } = require('../../src/segment-fetcher.js');

const SEGMENT_INDEX = {
    initSegmentUrl: 'https://jellyfin.example.com/videos/init.mp4',
    segments: [
        { index: 0, url: 'https://jellyfin.example.com/videos/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
        { index: 1, url: 'https://jellyfin.example.com/videos/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
    ],
};

let previousFetch;

beforeEach(() => {
    previousFetch = global.fetch;
    global.fetch = jest.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
});

afterEach(() => {
    global.fetch = previousFetch;
});

describe('SegmentFetcher#fetchSegment abort signal', () => {
    test('rejects with AbortError when the passed signal fires before the fetch resolves', async () => {
        // Regression test: fetchSegment() used to accept no way to cancel
        // a request at all -- SegmentFetcher's own reference-counted
        // wanters (ensureRawBytes()) depend on this to actually free
        // bandwidth when a scrub-drag abandons a segment before its fetch finishes.
        global.fetch = jest.fn(
            (url, { signal }) =>
                new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    });
                })
        );

        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        const controller = new AbortController();

        const promise = fetcher.fetchSegment(0, { signal: controller.signal });
        controller.abort();

        await expect(promise).rejects.toThrow(/aborted/i);
    });

    test('a real (non-aborted) fetch still resolves normally when a signal is passed but never fires', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        const controller = new AbortController();

        const buffer = await fetcher.fetchSegment(0, { signal: controller.signal });

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(fetcher.hasRawBytes(0)).toBe(true);
    });
});

describe('SegmentFetcher#hasRawBytes', () => {
    test('is false before a segment is fetched, true after', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);

        expect(fetcher.hasRawBytes(0)).toBe(false);
        expect(fetcher.hasRawBytes(1)).toBe(false);

        await fetcher.fetchSegment(0);

        expect(fetcher.hasRawBytes(0)).toBe(true);
        expect(fetcher.hasRawBytes(1)).toBe(false);
    });

    test('does not consider the init segment a media segment', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        await fetcher.fetchInitSegment();

        expect(fetcher.hasRawBytes(0)).toBe(false);
    });
});

describe('SegmentFetcher#getCachedRawBytes', () => {
    test('returns cached bytes without fetching, and throws when nothing is cached', async () => {
        // Tier 2 (frame-store.js) is only allowed to read raw bytes through
        // this accessor, never fetchSegment() -- it must never trigger a
        // network fetch, even via a race between its own hasRawBytes()
        // check and the next call.
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);

        expect(() => fetcher.getCachedRawBytes(0)).toThrow(/not cached/);

        await fetcher.fetchSegment(0);
        const fetchCallsBefore = global.fetch.mock.calls.length;

        const buffer = fetcher.getCachedRawBytes(0);

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(global.fetch.mock.calls.length).toBe(fetchCallsBefore);
    });
});

describe('SegmentFetcher#ensureRawBytes reference-counted cancellation', () => {
    /**
     * Makes global.fetch() hang until its AbortSignal fires, so tests can
     * inspect whether ensureRawBytes()'s reference counting actually
     * cancels the underlying request.
     *
     * @returns {void}
     */
    function makeFetchHangUntilAborted() {
        global.fetch = jest.fn(
            (url, { signal }) =>
                new Promise((resolve, reject) => {
                    const onAbort = () => {
                        const err = new Error('aborted');
                        err.name = 'AbortError';
                        reject(err);
                    };
                    if (signal.aborted) {
                        onAbort();
                    } else {
                        signal.addEventListener('abort', onAbort);
                    }
                })
        );
    }

    test('aborts the underlying fetch once the only wanter releases before it resolves', async () => {
        // Regression test: Scheduler.seek() needs a way to cancel a stale
        // segment's raw-byte fetch, so scrubbing over N segments doesn't
        // queue N uncancellable real fetches.
        makeFetchHangUntilAborted();
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        const controller = new AbortController();

        const promise = fetcher.ensureRawBytes(0, { signal: controller.signal });
        promise.catch(() => {});

        const entry = fetcher._inFlightFetches.get(0);
        expect(entry.abortController.signal.aborted).toBe(false);

        controller.abort();

        expect(entry.abortController.signal.aborted).toBe(true);
        await expect(promise).rejects.toThrow();
    });

    test('does not abort the fetch while another caller (e.g. opportunistic prefetch, no signal) still wants the same segment', async () => {
        makeFetchHangUntilAborted();
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        const controller = new AbortController();

        const seekPromise = fetcher.ensureRawBytes(0, { signal: controller.signal });
        seekPromise.catch(() => {});
        // No signal -- matches how the scheduler's cache pass calls
        // ensureRawBytes(), a want that lasts as long as the request is in flight.
        const prefetchPromise = fetcher.ensureRawBytes(0);

        const entry = fetcher._inFlightFetches.get(0);
        controller.abort();

        expect(entry.abortController.signal.aborted).toBe(false);
        expect(fetcher._inFlightFetches.get(0)).toBe(entry);

        void prefetchPromise;
    });

    test('serves cached bytes without starting a new fetch when already cached', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        await fetcher.fetchSegment(0);
        const fetchCallsBefore = global.fetch.mock.calls.length;

        const buffer = await fetcher.ensureRawBytes(0);

        expect(buffer).toBeInstanceOf(ArrayBuffer);
        expect(global.fetch.mock.calls.length).toBe(fetchCallsBefore);
    });
});

describe('SegmentFetcher fetch retry backoff', () => {
    beforeEach(() => {
        jest.useFakeTimers();
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    test('a real failure enters backoff, a success clears it, and a cancellation does not count as a failure', async () => {
        global.fetch = jest.fn(() => Promise.reject(new Error('upstream 500')));
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);

        expect(fetcher.isFetchInBackoff(0)).toBe(false);

        await expect(fetcher.ensureRawBytes(0)).rejects.toThrow('upstream 500');
        expect(fetcher.isFetchInBackoff(0)).toBe(true);

        jest.advanceTimersByTime(199);
        expect(fetcher.isFetchInBackoff(0)).toBe(true);
        jest.advanceTimersByTime(2);
        expect(fetcher.isFetchInBackoff(0)).toBe(false);

        fetcher._recordFetchOutcome(0, new Error('boom'));
        expect(fetcher.isFetchInBackoff(0)).toBe(true);
        fetcher._recordFetchOutcome(0, null);
        expect(fetcher.isFetchInBackoff(0)).toBe(false);

        const abortErr = new Error('aborted');
        abortErr.name = 'AbortError';
        fetcher._recordFetchOutcome(0, abortErr);
        expect(fetcher.isFetchInBackoff(0)).toBe(false);
    });
});

describe('SegmentFetcher onError callback', () => {
    test('fires exactly once per real failure, even when many callers share the same in-flight request', async () => {
        global.fetch = jest.fn(() => Promise.reject(new Error('upstream 500')));
        const errors = [];
        const fetcher = new SegmentFetcher(SEGMENT_INDEX, { onError: (err) => errors.push(err) });

        const calls = Array.from({ length: 20 }, () => fetcher.ensureRawBytes(0).catch(() => {}));
        await Promise.all(calls);

        expect(errors).toHaveLength(1);
        expect(errors[0].message).toBe('upstream 500');
    });
});

describe('SegmentFetcher byte-range fetches (local-file SegmentIndex support)', () => {
    /**
     * A local-file-shaped SegmentIndex: every segment (and the init region)
     * shares one whole-file URL, distinguished only by byte range -- the
     * shape LocalFileMediaSource's mp4box.js-based segmenting produces,
     * unlike Jellyfin/HLS's distinct-URL-per-segment shape (SEGMENT_INDEX
     * above), which never sets these fields.
     */
    const RANGE_SEGMENT_INDEX = {
        initSegmentUrl: 'blob:local-file',
        initByteRangeStart: 0,
        initByteRangeEnd: 100,
        segments: [
            { index: 0, url: 'blob:local-file', byteRangeStart: 100, byteRangeEnd: 500, duration: 3, startTime: 0, endTime: 3 },
        ],
    };

    test('fetchSegment sends a Range header derived from byteRangeStart/End when present', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(8) }));
        const fetcher = new SegmentFetcher(RANGE_SEGMENT_INDEX);

        await fetcher.fetchSegment(0);

        expect(global.fetch).toHaveBeenCalledWith(
            'blob:local-file',
            expect.objectContaining({ headers: { Range: 'bytes=100-499' } }),
        );
    });

    test('fetchSegment throws if a Range request is not honored (200 instead of 206)', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));
        const fetcher = new SegmentFetcher(RANGE_SEGMENT_INDEX);

        await expect(fetcher.fetchSegment(0)).rejects.toThrow(/not honored/i);
    });

    test('fetchInitSegment sends a Range header derived from initByteRangeStart/End when present', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 206, arrayBuffer: async () => new ArrayBuffer(8) }));
        const fetcher = new SegmentFetcher(RANGE_SEGMENT_INDEX);

        await fetcher.fetchInitSegment();

        expect(global.fetch).toHaveBeenCalledWith(
            'blob:local-file',
            expect.objectContaining({ headers: { Range: 'bytes=0-99' } }),
        );
    });

    test('never sends a Range header for a Jellyfin/HLS-shaped SegmentIndex (no byteRange fields)', async () => {
        global.fetch = jest.fn(async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }));
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);

        await fetcher.fetchSegment(0);
        await fetcher.fetchInitSegment();

        for (const call of global.fetch.mock.calls) {
            expect(call[1]?.headers).toBeUndefined();
        }
    });
});

describe('SegmentFetcher dual-session anchor routing', () => {
    /** The "behind" session's own segment list. Segment indices are ABSOLUTE in every Jellyfin session, including one negotiated with StartTimeTicks -- its index 0 is the stream's index 0, not its own start time (measured directly against the real server; see setBehindSession's doc comment). */
    const BEHIND_SESSION_SEGMENTS = [
        { index: 0, url: 'https://jellyfin.example.com/behind/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
        { index: 1, url: 'https://jellyfin.example.com/behind/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
        { index: 2, url: 'https://jellyfin.example.com/behind/seg2.m4s', duration: 3, startTime: 6, endTime: 9 },
    ];

    test('uses the ordinary url for every segment before any seek moves the anchor, even with a behind session installed', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setBehindSession(BEHIND_SESSION_SEGMENTS, 0);

        await fetcher.fetchSegment(0);

        expect(global.fetch).toHaveBeenCalledWith('https://jellyfin.example.com/videos/seg0.m4s', expect.anything());
    });

    test('fetches below the anchor from the behind session, at or above it from the ordinary url', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(1);
        fetcher.setBehindSession(BEHIND_SESSION_SEGMENTS, 0);

        await fetcher.fetchSegment(0);

        expect(global.fetch).toHaveBeenCalledWith('https://jellyfin.example.com/behind/seg0.m4s', expect.anything());
    });

    test('addresses the behind session by ABSOLUTE index, never translated by its own start time', async () => {
        // Regression test for the bug that made decoded content silently
        // not match its own timecode. This used to apply
        // `indexOffset = Math.round(behindStartTime / segmentDuration)`,
        // on the assumption that a session negotiated with StartTimeTicks
        // numbered its own segments from 0. Measured directly against the
        // real Jellyfin server, that is false: such a session returns the
        // ENTIRE item's playlist (same segment count and total duration as
        // a session with no start time), and its segment N holds absolute
        // [N*duration, (N+1)*duration) -- ffprobe put segment 8 of a
        // session started at 1101s at 24.0s, and its segment 375 at
        // 1125.0s. With the offset applied, asking for absolute segment 5
        // here fetched the behind session's index 0 -- content from a
        // completely different part of the video.
        const behindSegments = Array.from({ length: 8 }, (_, i) => ({
            index: i,
            url: `https://jellyfin.example.com/behind/seg${i}.m4s`,
            duration: 3,
            startTime: i * 3,
            endTime: (i + 1) * 3,
        }));
        const fetcher = new SegmentFetcher({
            initSegmentUrl: 'https://jellyfin.example.com/videos/init.mp4',
            segments: Array.from({ length: 8 }, (_, i) => ({
                index: i,
                url: `https://jellyfin.example.com/forward/seg${i}.m4s`,
                duration: 3,
                startTime: i * 3,
                endTime: (i + 1) * 3,
            })),
        });
        fetcher.setAnchorSegmentIndex(6);
        // Behind session's transcode began at 9s (absolute segment 3).
        fetcher.setBehindSession(behindSegments, 9);

        await fetcher.fetchSegment(5);

        expect(global.fetch).toHaveBeenCalledWith('https://jellyfin.example.com/behind/seg5.m4s', expect.anything());
    });

    test('does not route to the behind session for indices EARLIER than its own transcode start', async () => {
        // Asking a session for a segment before where its ffmpeg process
        // started means asking it to seek backward, which Jellyfin answers
        // by killing and restarting that session's job -- the exact cost
        // the dual-session design exists to avoid. Such an index is a
        // coverage gap: the caller is expected to skip it and wait for the
        // behind session to be re-anchored further back.
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(2);
        // Behind session started at 3s, so absolute segment 0 (0-3s) predates it.
        fetcher.setBehindSession(BEHIND_SESSION_SEGMENTS, 3);

        expect(fetcher.isBehindCoverageGap(0)).toBe(true);
        expect(fetcher.isBehindCoverageGap(1)).toBe(false);

        await fetcher.fetchSegment(1);
        expect(global.fetch).toHaveBeenCalledWith('https://jellyfin.example.com/behind/seg1.m4s', expect.anything());
    });

    test('reports no coverage gap at or above the anchor, or when no behind session is installed', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);

        // No behind session yet -- nothing is a gap, everything is the forward session's.
        expect(fetcher.isBehindCoverageGap(0)).toBe(false);

        fetcher.setAnchorSegmentIndex(1);
        fetcher.setBehindSession(BEHIND_SESSION_SEGMENTS, 3);

        // Index 2 is at/above the anchor -- the forward session serves it, no gap.
        expect(fetcher.isBehindCoverageGap(2)).toBe(false);
    });

    test('routes to the tightest-fitting behind session when several cover the same index', async () => {
        // Two behind sessions tile the region behind the playhead: a close
        // one just behind it, and an extended one owning the deeper
        // section. Both may technically list a given index, but the one
        // that STARTED LATEST has the least left to produce before
        // reaching it, so it is the one most likely to already have it on
        // disk -- and an already-written segment serves in ~59ms against
        // the real server, versus a multi-second restart otherwise.
        const closeSegments = [
            { index: 0, url: 'https://jellyfin.example.com/close/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
            { index: 1, url: 'https://jellyfin.example.com/close/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
            { index: 2, url: 'https://jellyfin.example.com/close/seg2.m4s', duration: 3, startTime: 6, endTime: 9 },
        ];
        const extendedSegments = [
            { index: 0, url: 'https://jellyfin.example.com/extended/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
            { index: 1, url: 'https://jellyfin.example.com/extended/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
            { index: 2, url: 'https://jellyfin.example.com/extended/seg2.m4s', duration: 3, startTime: 6, endTime: 9 },
        ];

        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(2);
        fetcher.setBehindSessions([
            { segments: extendedSegments, startTimeSeconds: 0 }, // deep section
            { segments: closeSegments, startTimeSeconds: 3 }, // just behind the playhead
        ]);

        // Segment 1 (3-6s) is reachable by both; the close session started
        // latest at 3s, so it wins.
        await fetcher.fetchSegment(1);
        expect(global.fetch).toHaveBeenCalledWith('https://jellyfin.example.com/close/seg1.m4s', expect.anything());

        // Segment 0 (0-3s) predates the close session, so only the
        // extended one can serve it without seeking backward.
        await fetcher.fetchSegment(0);
        expect(global.fetch).toHaveBeenLastCalledWith('https://jellyfin.example.com/extended/seg0.m4s', expect.anything());
    });

    test('reports a coverage gap only when NO behind session can reach an index', async () => {
        const behindSegments = [
            { index: 0, url: 'https://jellyfin.example.com/behind/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
            { index: 1, url: 'https://jellyfin.example.com/behind/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
            { index: 2, url: 'https://jellyfin.example.com/behind/seg2.m4s', duration: 3, startTime: 6, endTime: 9 },
        ];
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(2);

        // Only a deep session: index 0 is covered, so no gap.
        fetcher.setBehindSessions([{ segments: behindSegments, startTimeSeconds: 0 }]);
        expect(fetcher.isBehindCoverageGap(0)).toBe(false);

        // Only a close session starting at 3s: index 0 (0-3s) predates it.
        fetcher.setBehindSessions([{ segments: behindSegments, startTimeSeconds: 3 }]);
        expect(fetcher.isBehindCoverageGap(0)).toBe(true);

        // Adding the deep session back closes that gap.
        fetcher.setBehindSessions([
            { segments: behindSegments, startTimeSeconds: 3 },
            { segments: behindSegments, startTimeSeconds: 0 },
        ]);
        expect(fetcher.isBehindCoverageGap(0)).toBe(false);
    });

    test('counts in-flight fetches per live session, not globally', async () => {
        // The concurrency ceiling exists because concurrent requests race
        // a transcoder restart against each other WITHIN one session.
        // Separate sessions are separate ffmpeg jobs, so counting globally
        // would split one slot across them and buy no extra throughput.
        let resolveFetch;
        global.fetch = jest.fn(
            () =>
                new Promise((resolve) => {
                    resolveFetch = () => resolve({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
                }),
        );

        const behindSegments = [
            { index: 0, url: 'https://jellyfin.example.com/behind/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
            { index: 1, url: 'https://jellyfin.example.com/behind/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
            { index: 2, url: 'https://jellyfin.example.com/behind/seg2.m4s', duration: 3, startTime: 6, endTime: 9 },
        ];
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(2);
        fetcher.setBehindSessions([{ segments: behindSegments, startTimeSeconds: 0 }]);

        fetcher.ensureRawBytes(0).catch(() => {}); // behind session
        fetcher.ensureRawBytes(2).catch(() => {}); // forward session (at the anchor)

        // One in flight on each session, not two on one.
        expect(fetcher.getInFlightFetchCountForSession(0)).toBe(1);
        expect(fetcher.getInFlightFetchCountForSession(2)).toBe(1);
        expect(fetcher.getInFlightFetchCount()).toBe(2);

        resolveFetch();
    });

    test('keeps counting an in-flight fetch against the session it was LAUNCHED on, even after routing changes', async () => {
        // Confirmed live as a 500: segment 213 was in flight on the
        // behind@seg210 session when the close session re-anchored, which
        // changed what 213 would resolve to NOW. Re-deriving the session for
        // each in-flight fetch therefore misattributed 213, so segment 211
        // was allowed onto seg210's session as a second concurrent request
        // -- and that pair raced a transcoder restart, killing 213.
        global.fetch = jest.fn(() => new Promise(() => {})); // never resolves; stays in flight

        const deepSegments = SEGMENT_INDEX.segments.map((segment) => ({
            ...segment,
            url: `https://jellyfin.example.com/deep/seg${segment.index}.m4s`,
        }));
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(2);
        fetcher.setBehindSessions([{ segments: deepSegments, startTimeSeconds: 0 }]);

        fetcher.ensureRawBytes(1).catch(() => {});
        expect(fetcher.getInFlightFetchCountForSession(1)).toBe(1);

        // A closer behind session is installed while that fetch is still in
        // flight, so index 1 would now resolve to the NEW session.
        const closeSegments = SEGMENT_INDEX.segments.map((segment) => ({
            ...segment,
            url: `https://jellyfin.example.com/close/seg${segment.index}.m4s`,
        }));
        fetcher.setBehindSessions([
            { segments: deepSegments, startTimeSeconds: 0 },
            { segments: closeSegments, startTimeSeconds: 3 },
        ]);

        // The in-flight fetch still counts against the deep session it was
        // launched on, so index 0 (which only the deep session can serve)
        // correctly sees that session as busy.
        expect(fetcher.getInFlightFetchCountForSession(0)).toBe(1);
    });

    test('falls back to the ordinary url when the behind session does not (yet) cover a below-anchor index', async () => {
        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(1);
        // Behind session's own list is empty -- it lists no index at all yet.
        fetcher.setBehindSession([], 0);

        await fetcher.fetchSegment(0);

        expect(global.fetch).toHaveBeenCalledWith('https://jellyfin.example.com/videos/seg0.m4s', expect.anything());
    });

    test('does NOT re-fetch when a forward<->behind transition is just the anchor moving past an already-cached index', async () => {
        // A forward url and a behind session's url for the SAME index
        // represent identical real content (same source, same quality,
        // and Jellyfin does accurate non-stream-copy seeking -- issue
        // #36), just via a different session -- confirmed live that
        // treating this transition as "stale" wasted a huge number of
        // already-fetched, still-correct segments every time a seek moved
        // the anchor past them, directly against the design goal of
        // pre-fetching as much as possible and evicting only when truly
        // necessary.
        global.fetch = jest.fn(async (url) => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode(url).buffer,
        }));

        const fetcher = new SegmentFetcher(SEGMENT_INDEX);

        // Index 0 starts at/above the anchor -- ordinary forward fetch.
        fetcher.setAnchorSegmentIndex(0);
        const forwardBuffer = await fetcher.fetchSegment(0);
        expect(new TextDecoder().decode(forwardBuffer)).toBe('https://jellyfin.example.com/videos/seg0.m4s');
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // A seek moves the anchor forward past index 0, and a behind
        // session happens to be installed -- index 0 now resolves through it.
        fetcher.setAnchorSegmentIndex(1);
        fetcher.setBehindSession(BEHIND_SESSION_SEGMENTS, 0);

        const stillCachedBuffer = await fetcher.fetchSegment(0);
        expect(new TextDecoder().decode(stillCachedBuffer)).toBe('https://jellyfin.example.com/videos/seg0.m4s');
        expect(global.fetch).toHaveBeenCalledTimes(1); // no new fetch -- the cached bytes were reused
    });

    test('does NOT re-fetch when the same index resolves through two DIFFERENT behind sessions (identical content)', async () => {
        // The inverse of what this test used to assert. It previously
        // evicted here, on the theory that each behind session had its own
        // index offset and so the same absolute index mapped to different
        // real content across them. Segment indices are absolute in every
        // session, so index N is the SAME real time range no matter which
        // session's url fetched it -- and evicting on re-anchor threw away
        // large runs of perfectly good cached segments, which is the
        // unexplained mass-eviction behavior that was reported live.
        global.fetch = jest.fn(async (url) => ({
            ok: true,
            status: 200,
            arrayBuffer: async () => new TextEncoder().encode(url).buffer,
        }));

        const EARLIER_BEHIND_SESSION_SEGMENTS = [
            { index: 0, url: 'https://jellyfin.example.com/behind-earlier/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
        ];

        const fetcher = new SegmentFetcher(SEGMENT_INDEX);
        fetcher.setAnchorSegmentIndex(1);
        fetcher.setBehindSession(EARLIER_BEHIND_SESSION_SEGMENTS, 0);

        const firstBehindBuffer = await fetcher.fetchSegment(0);
        expect(new TextDecoder().decode(firstBehindBuffer)).toBe('https://jellyfin.example.com/behind-earlier/seg0.m4s');
        expect(global.fetch).toHaveBeenCalledTimes(1);

        // The behind session is re-anchored (a new negotiation, different
        // urls) while the anchor stays put -- index 0 still holds the same
        // real content, so the cached bytes must be reused as-is.
        fetcher.setBehindSession(BEHIND_SESSION_SEGMENTS, 0);

        const secondBehindBuffer = await fetcher.fetchSegment(0);
        expect(new TextDecoder().decode(secondBehindBuffer)).toBe('https://jellyfin.example.com/behind-earlier/seg0.m4s');
        expect(global.fetch).toHaveBeenCalledTimes(1); // no re-fetch, no eviction
    });
});
