/**
 * Tier 1 of the two-tier cache: raw, undecoded HLS segment bytes as
 * fetched from the network, plus the init segment (once, cached forever).
 *
 * Owns the raw-bytes cache tier -- deliberately separate from and much
 * larger than the decoded-frame LRU in frame-store.js, since raw HLS
 * segments are ~150x cheaper to hold than their decoded frames (~1.5MB vs
 * ~223MB per 3s/1080p segment) but expensive to re-fetch over the network.
 * Tier 1 never decodes anything -- that's Tier 2's (frame-store.js) job,
 * and it only ever decodes what Tier 1 has already fetched.
 *
 * Every URL fetched here is a direct Jellyfin URL (already carrying its
 * own embedded API key) -- deliberately fetched with no extra options
 * (no MARP Authorization header). Sending one anyway would turn these
 * into cross-origin requests with a custom header, forcing a CORS
 * preflight Jellyfin isn't guaranteed to answer -- confirmed live to hang
 * the fetch() indefinitely with no error ever surfacing.
 *
 * @fileoverview Raw HLS segment/init-segment fetching with an LRU byte cache.
 * @author Isaac Travers
 * @module video-engine/segment-fetcher
 */

/** Backoff delay before the first automatic retry of a raw fetch that just failed, in ms. */
const INITIAL_FETCH_RETRY_BACKOFF_MS = 200;

/** Ceiling on raw-fetch backoff delay, however many consecutive failures a segment has had, in ms. */
const MAX_FETCH_RETRY_BACKOFF_MS = 8000;

/** Raw-fetch backoff grows by this factor after each consecutive failure, until MAX_FETCH_RETRY_BACKOFF_MS. */
const FETCH_RETRY_BACKOFF_MULTIPLIER = 2;

/** Max time to wait for a single segment fetch, in ms -- generous, since a real transcode segment fetch over a slow connection has been observed taking 30s+; the point is only to fail loudly, not to be a strict SLA. */
const FETCH_TIMEOUT_MS = 60000;

/** Default raw-segment cache budget: 3 GiB. */
const DEFAULT_RAW_CACHE_BUDGET_BYTES = 3 * 1024 * 1024 * 1024;

/**
 * Fetches a URL with a timeout, so a genuinely stuck network request fails
 * with a clear, actionable error instead of hanging forever with no signal
 * -- confirmed live that segment fetch time over a slow connection to a
 * remote Jellyfin server is highly variable (single-digit seconds to 30+),
 * so this exists purely as a last-resort backstop, not a performance target.
 *
 * @param {string} url - URL to fetch.
 * @param {AbortSignal} [externalSignal] - Caller-supplied cancellation, e.g. FrameStore releasing a fetch no caller wants anymore.
 * @param {Object} [extraOptions] - Extra fetch() options merged in (e.g. a Range header for a local-file byte-range read -- see buildRangeHeaderOptions).
 * @returns {Promise<Response>} The fetch response.
 * @throws {Error} When the request doesn't complete within FETCH_TIMEOUT_MS.
 * @throws {DOMException} AbortError, when `externalSignal` fires (distinguished from a timeout by checking `externalSignal.aborted`).
 */
function fetchWithTimeout(url, externalSignal, extraOptions) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    // Combines our own timeout-driven abort with the caller's cancellation
    // -- not AbortSignal.any() (would be the cleaner primitive) since this
    // engine's own target/support baseline isn't confirmed to have it.
    const onExternalAbort = () => controller.abort();
    if (externalSignal) {
        if (externalSignal.aborted) {
            controller.abort();
        } else {
            externalSignal.addEventListener('abort', onExternalAbort, { once: true });
        }
    }

    return fetch(url, { ...extraOptions, signal: controller.signal })
        .catch((err) => {
            if (err.name === 'AbortError') {
                if (externalSignal && externalSignal.aborted) {
                    throw err; // real cancellation, not a timeout -- let callers recognize it via err.name/externalSignal.aborted
                }
                throw new Error(`Fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
            }
            throw err;
        })
        .finally(() => {
            clearTimeout(timeoutHandle);
            if (externalSignal) {
                externalSignal.removeEventListener('abort', onExternalAbort);
            }
        });
}

/**
 * Builds fetch() options for a byte-range request, or undefined when no
 * range is given -- used for a local-file SegmentIndex, where every
 * segment/the init region are all byte ranges within one shared whole-file
 * URL (a `blob:` URL in a plain browser, a WebView2 virtual-host-mapped
 * URL inside the C# host) rather than separate URLs the way Jellyfin's
 * per-segment HLS URLs are. Confirmed both environments' Chromium-based
 * fetch() honors Range against these URL kinds.
 *
 * @param {number} [byteRangeStart] - Inclusive start offset, in bytes.
 * @param {number} [byteRangeEnd] - Exclusive end offset, in bytes (JS slice()/Blob.slice() convention, converted to HTTP's inclusive end here).
 * @returns {Object|undefined} `{headers: {Range: ...}}`, or undefined if either bound is missing.
 */
function buildRangeHeaderOptions(byteRangeStart, byteRangeEnd) {
    if (!Number.isFinite(byteRangeStart) || !Number.isFinite(byteRangeEnd)) {
        return undefined;
    }
    return { headers: { Range: `bytes=${byteRangeStart}-${byteRangeEnd - 1}` } };
}

/**
 * Fetches and caches the raw bytes of a SegmentIndex's segments.
 *
 * @class SegmentFetcher
 */
export class SegmentFetcher {
    /**
     * @param {Object} segmentIndex - SegmentIndex from {@link module:video-engine/playlist-manager.loadSegmentIndex}.
     * @param {Object} [options]
     * @param {number} [options.maxRawCacheBytes=3221225472] - Raw-bytes LRU cap.
     * @param {function(Error): void} [options.onError] - Called exactly once per real (non-cancelled) raw-fetch failure, regardless of how many callers (opportunistic prefetch, render-path fallback, a seek) share the same in-flight request.
     * @param {function(string): void} [options.onDebug] - Called with the same fetch progress messages this class already logs to the console -- lets a consumer (e.g. the test harness's on-page log panel) see that a raw fetch is in flight, since it can otherwise take seconds with zero visible signal.
     */
    constructor(segmentIndex, { maxRawCacheBytes = DEFAULT_RAW_CACHE_BUDGET_BYTES, onError, onDebug } = {}) {
        this.segmentIndex = segmentIndex;
        this.maxRawCacheBytes = Math.floor(maxRawCacheBytes);
        this.onError = onError;
        this.onDebug = onDebug;

        // segmentIndex -> ArrayBuffer, insertion order doubles as LRU order.
        this._rawSegmentCache = new Map();
        this._rawSegmentBytes = 0;

        // The scheduler can mark a local neighborhood as protected.
        // Protected raw segments should survive ordinary LRU churn.
        // This matters most while paused and filling aggressively.
        // Without it, far-away background fetches age out local bytes.
        this._protectedRawSegments = new Set();

        // segmentIndex -> {promise, wanterCount, abortController}. Concurrent
        // ensureRawBytes() callers for the same segment share one in-flight
        // fetch; a caller that passes `signal` releases its own "want" when
        // it fires, and the underlying fetch is only actually cancelled once
        // every wanter has released (see ensureRawBytes()'s own doc comment).
        this._inFlightFetches = new Map();

        // Tracks recent real fetch failures per segment so automatic
        // (opportunistic) callers stop hammering a segment that just
        // failed; a deliberate seek() still bypasses this.
        this._fetchBackoff = new Map();

        // The init segment is tiny.
        // It never changes for this stream.
        // Once fetched, keep it forever.
        this._initSegmentBuffer = null;
        this._initSegmentPromise = null;

        // Dual-session routing (see setAnchorSegmentIndex/setBehindSession's
        // own doc comments): a segment index below the anchor is fetched
        // from the "behind" session's own segment list (a second,
        // independent Jellyfin transcode session negotiated with an
        // earlier StartTimeTicks, so its own ffmpeg process only ever
        // moves forward -- never restarts -- while sweeping through this
        // region). Segment indices are ABSOLUTE in both sessions and need
        // no translation between them -- see setBehindSession's own doc
        // comment for the measurement that established this. Segments at
        // or above the anchor always use their ordinary `url` (the
        // "forward" session).
        this._anchorSegmentIndex = 0;
        this._behindSessions = [];
    }

    /**
     * Moves the dual-session forward/behind boundary to a newly-landed
     * seek's target segment. Segments at or above this index are fetched
     * from their ordinary `url` (the "forward" session); segments below
     * it from the behind session set via setBehindSession(), if any.
     * Deliberately only updated here (on seek), never as playback
     * continues past it, per the two-session design: each session is a
     * single sequential transcode producer that must only ever be asked
     * to move in its own one direction relative to the anchor, or it pays
     * the same restart cost a single shared session already does.
     *
     * @param {number} segmentIndexNumber - The just-landed seek's target segment index.
     * @returns {void}
     */
    setAnchorSegmentIndex(segmentIndexNumber) {
        this._anchorSegmentIndex = segmentIndexNumber;
    }

    /**
     * Installs (or replaces) the "behind" session's own segment list,
     * negotiated with an earlier StartTimeTicks so its ffmpeg process
     * sweeps forward through the seek anchor's behind-region without ever
     * restarting. Called once per seek, asynchronously, after the seek's
     * own negotiation/fetch has already landed -- this only affects
     * opportunistic background fetches for indices below the anchor, not
     * the seek's own target-segment fetch.
     *
     * Segment indices are ABSOLUTE in every Jellyfin session, including
     * one negotiated with StartTimeTicks -- no index translation is
     * applied or wanted here. Measured directly against the real server:
     * a session negotiated with StartTimeTicks=1101s returns the ENTIRE
     * item's playlist (452 segments / 1354.134s, identical to a session
     * with no start time at all), and ffprobe of its own bytes puts
     * segment 8 at absolute 24.0s, segment 367 at 1101.0s, and segment
     * 375 at 1125.0s. StartTimeTicks only tells the transcoder where to
     * begin ENCODING; it does not renumber or truncate segments.
     *
     * This previously applied `indexOffset = Math.round(startTime /
     * segmentDuration)` on the assumption that each session's numbering
     * restarted at 0 from its own StartTimeTicks. That assumption was
     * wrong, and it silently served content from a completely different
     * part of the video (asking for absolute segment 375 fetched behind
     * index 8 -- 24 seconds in -- and presented it as 1125s). Do not
     * reintroduce an offset here.
     *
     * @param {Array<Object>|null} segments - The behind session's own SegmentIndex.segments, addressed by absolute segment index, or null to clear (single-session mode/no behind session yet negotiated).
     * @param {number} [behindStartTimeSeconds=0] - Absolute position this session's transcode was started from. Only indices at or after this point can be served by it without forcing its ffmpeg process to seek backward (which restarts it) -- see isBehindCoverageGap.
     * @returns {void}
     */
    setBehindSession(segments, behindStartTimeSeconds = 0) {
        this.setBehindSessions(segments ? [{ segments, startTimeSeconds: behindStartTimeSeconds }] : []);
    }

    /**
     * Installs (or replaces) every "behind" session at once.
     *
     * Multiple sessions tile the region behind the playhead between them:
     * a close one anchored just behind the playhead, serving what reverse
     * playback needs immediately, and an extended one anchored deeper,
     * building coverage of the section the playhead is heading into. Each
     * is an independent Jellyfin transcode job, so re-anchoring one (which
     * costs a restart) does not disturb the others.
     *
     * Any forward-sweeping session produces the segment nearest its own
     * anchor FIRST and the one furthest ahead of it LAST -- which is
     * exactly backwards from what reverse playback consumes. That is why
     * the close session has to sit very near the playhead and re-anchor
     * often, rather than covering a wide span: a wide span would produce
     * the segments reverse needs soonest last of all.
     *
     * @param {Array<{segments: Array<Object>, startTimeSeconds: number}>} sessions - Behind sessions, each with its own absolute-indexed segment list and the position its transcode began at. Order does not matter; routing picks by fit (see _behindSessionFor).
     * @returns {void}
     */
    setBehindSessions(sessions) {
        this._behindSessions = Array.isArray(sessions) ? sessions.filter((session) => session && session.segments) : [];
    }

    /**
     * Picks the behind session best placed to serve a segment: among those
     * whose transcode began at or before it, the one that began LATEST.
     *
     * That is the tightest fit -- the session with the least content left
     * to produce before it reaches this segment, and so the one most
     * likely to already have it on disk. (A segment already written is
     * served immediately regardless of session state, measured at ~59ms
     * against the real server, versus a multi-second restart for one that
     * forces the job to move.)
     *
     * @param {Object} segment - `this.segmentIndex.segments[segmentIndexNumber]`.
     * @param {number} segmentIndexNumber - Segment index being resolved.
     * @returns {Object|null} The chosen session, or null if none can serve it without seeking backward.
     */
    _behindSessionFor(segment, segmentIndexNumber) {
        if (!segment) {
            return null;
        }

        let best = null;
        for (const session of this._behindSessions) {
            if (session.startTimeSeconds > segment.startTime) {
                continue;
            }
            if (!session.segments[segmentIndexNumber]) {
                continue;
            }
            if (!best || session.startTimeSeconds > best.startTimeSeconds) {
                best = session;
            }
        }
        return best;
    }

    /**
     * Resolves which URL a segment index should be fetched from --
     * ordinary `url` (forward session) at or above the anchor, or the
     * behind session's own URL (same absolute index) below it, falling
     * back to `url` if no behind session is installed or that index falls
     * outside what it can serve.
     *
     * @param {number} segmentIndexNumber - Segment index to resolve.
     * @param {Object} segment - `this.segmentIndex.segments[segmentIndexNumber]`.
     * @returns {string} The URL to fetch.
     */
    _resolveSegmentUrl(segmentIndexNumber, segment) {
        const session = this._servableByBehindSession(segmentIndexNumber, segment);
        return session ? session.segments[segmentIndexNumber].url : segment.url;
    }

    /**
     * Which behind session should serve this index, if any: the index must
     * be below the anchor (at or above it belongs to the forward session),
     * and some behind session must be able to reach it without seeking its
     * own transcode backward.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @param {Object} segment - `this.segmentIndex.segments[segmentIndexNumber]`.
     * @returns {Object|null} The session that should serve it, or null.
     */
    _servableByBehindSession(segmentIndexNumber, segment) {
        if (segmentIndexNumber >= this._anchorSegmentIndex) {
            return null;
        }
        return this._behindSessionFor(segment, segmentIndexNumber);
    }

    /**
     * Whether this index sits behind the anchor but EARLIER than the
     * behind session's own transcode start -- i.e. neither session can
     * serve it cheaply. The forward session would have to seek backward
     * (Jellyfin kills and restarts that session's ffmpeg job, producing
     * the transient 500s and multi-second stalls the dual-session design
     * exists to avoid), and the behind session would too.
     *
     * Opportunistic background prefetch skips these entirely and waits
     * for the behind session to be re-anchored further back (the app's
     * own periodic refresh does this as the playhead moves), which is the
     * only way to reach them without a restart: jump the session back,
     * then sweep forward from there. The render path's own protected
     * floor deliberately does NOT consult this -- those segments are
     * needed to show frames right now, so a restart is the lesser cost.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {boolean} True if no session can currently serve this index without a restart.
     */
    isBehindCoverageGap(segmentIndexNumber) {
        if (this._behindSessions.length === 0 || segmentIndexNumber >= this._anchorSegmentIndex) {
            return false;
        }
        const segment = this.segmentIndex.segments[segmentIndexNumber];
        return Boolean(segment) && !this._behindSessionFor(segment, segmentIndexNumber);
    }

    /**
     * A stable key for the live transcode session a segment index resolves
     * to -- `"forward"`, or `"behind@<startTime>"` for a behind session
     * (its own start time identifies it, since that is what distinguishes
     * one behind session's ffmpeg job from another's).
     *
     * Used both for debug logging and for per-session fetch accounting:
     * concurrent requests only race a restart against each other WITHIN
     * one session, so the concurrency ceiling is applied per session
     * rather than globally -- otherwise adding sessions would just split
     * one slot between them and buy no extra throughput.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {string} Session key.
     */
    sessionKeyFor(segmentIndexNumber) {
        const segment = this.segmentIndex.segments[segmentIndexNumber];
        const session = this._servableByBehindSession(segmentIndexNumber, segment);
        return session ? `behind@${session.startTimeSeconds}` : 'forward';
    }

    /**
     * Human-readable session label for debug logging, naming the behind
     * session by the SEGMENT its transcode starts at rather than its raw
     * start time -- every other line in the log talks in segment numbers,
     * so a seconds-based label made it needlessly hard to line a session's
     * coverage up against the fetches attributed to it.
     *
     * Deliberately not used as the accounting key (see sessionKeyFor):
     * two sessions anchored a fraction of a second apart can fall inside
     * the same segment, and collapsing them into one label is fine for
     * reading a log but would merge their concurrency accounting.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {string} `"forward"` or `"behind@seg<index>"`.
     */
    _sessionLabelFor(segmentIndexNumber) {
        const segment = this.segmentIndex.segments[segmentIndexNumber];
        const session = this._servableByBehindSession(segmentIndexNumber, segment);
        if (!session) {
            return 'forward';
        }
        const startIndex = this.segmentIndex.segments.findIndex((candidate) => candidate.endTime > session.startTimeSeconds);
        return `behind@seg${startIndex}`;
    }

    /**
     * Counts in-flight fetches currently routed to the same live session
     * as `segmentIndexNumber` -- see sessionKeyFor for why this is counted
     * per session rather than globally.
     *
     * @param {number} segmentIndexNumber - Segment index whose session to count for.
     * @returns {number} In-flight fetches on that session.
     */
    getInFlightFetchCountForSession(segmentIndexNumber) {
        const key = this.sessionKeyFor(segmentIndexNumber);
        let count = 0;
        // Counts the key each fetch was LAUNCHED against, never a re-derived
        // one. Routing is time-varying -- a behind session re-anchoring
        // changes which session a given index resolves to -- so re-deriving
        // an in-flight fetch's session here misattributed it, let a second
        // request onto a session that already had one in flight, and that
        // pair raced a transcoder restart: confirmed live as segment 213
        // failing with a 500 on the session it shared with segment 211.
        for (const entry of this._inFlightFetches.values()) {
            if (entry.sessionKey === key) {
                count++;
            }
        }
        return count;
    }

    /**
     * Returns current raw-segment cache configuration/state.
     *
     * @returns {{maxRawCacheBytes: number, cachedRawBytes: number, cachedRawSegments: number, protectedRawSegments: number}} Cache config/state snapshot.
     */
    getRawCacheConfig() {
        return {
            maxRawCacheBytes: this.maxRawCacheBytes,
            cachedRawBytes: this._rawSegmentBytes,
            cachedRawSegments: this._rawSegmentCache.size,
            protectedRawSegments: this._protectedRawSegments.size,
        };
    }

    /**
     * Protects a set of segment indices from raw-cache eviction whenever
     * possible. If every cached entry is protected and eviction is still
     * required, eviction falls back to oldest-first among protected keys.
     *
     * @param {Iterable<number>} indices - Segment indices to protect.
      * @returns {{maxRawCacheBytes: number, cachedRawBytes: number, cachedRawSegments: number, protectedRawSegments: number}} Updated cache config/state snapshot.
     */
    setProtectedRawSegments(indices) {
        // Each scheduler pass supplies the full protected region.
        // Replacing atomically keeps the rule simple and predictable.
        this._protectedRawSegments = new Set(indices);

        // Reconcile immediately.
        // Do not wait for another fetch to trigger eviction.
        this._evictIfNeeded();
        return this.getRawCacheConfig();
    }

    /**
     * Updates the raw-segment LRU capacity at runtime and evicts oldest
     * entries immediately if the new cap is smaller than current usage.
     *
     * @param {number} budgetBytes - New raw-segment cache capacity in bytes.
     * @returns {{maxRawCacheBytes: number, cachedRawBytes: number, cachedRawSegments: number, protectedRawSegments: number}} Updated cache config/state snapshot.
     */
    setMaxRawCacheBytes(budgetBytes) {
        if (!Number.isFinite(budgetBytes) || budgetBytes < 1) {
            throw new Error(`Invalid raw segment cache size: ${budgetBytes}`);
        }

        this.maxRawCacheBytes = Math.floor(budgetBytes);
        this._evictIfNeeded();
        return this.getRawCacheConfig();
    }

    /**
     * Reports whether a segment's raw bytes are already fetched, cached,
     * AND still valid for what this index currently resolves to (see
     * _getFreshCachedBuffer) -- without fetching them if not. Used to
     * report per-segment fetch status (e.g. for a scrub-bar
     * visualization), as distinct from
     * {@link module:video-engine/frame-store.FrameStore#has}'s decoded status.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {boolean} True if the segment's raw bytes are cached and still fresh.
     */
    hasRawBytes(segmentIndexNumber) {
        return this._getFreshCachedBuffer(segmentIndexNumber) !== undefined;
    }

    /**
     * Reports whether a segment already has a fetch in flight (started by
     * an earlier call, not yet settled) -- so a repeat caller (e.g. the
     * scheduler's own cache pass, run on every render tick) can skip it
     * instead of burning its per-pass pacing budget on a no-op re-call
     * every single tick until the real fetch finally resolves.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {boolean} True if a fetch for this segment is already in flight.
     */
    hasInFlightFetch(segmentIndexNumber) {
        return this._inFlightFetches.has(segmentIndexNumber);
    }

    /**
     * Returns the current count of distinct segments with a raw fetch in
     * flight -- used to cap total concurrent fetches, since the browser's
     * own per-origin connection limit means an unbounded number of
     * simultaneously in-flight requests queues newer, more urgent ones
     * (e.g. a seek's own target) behind a pile of older, lower-priority
     * opportunistic ones instead of actually running concurrently.
     *
     * @returns {number} Count of segments with an in-flight fetch.
     */
    getInFlightFetchCount() {
        return this._inFlightFetches.size;
    }

    /**
     * Forcibly cancels every currently in-flight fetch except those in
     * `keepIndices`, regardless of how many wanters each one still has --
     * unlike the ordinary wanter-refcounted release (which only cancels a
     * fetch once nothing wants it anymore), this exists for a caller with
     * a genuinely more urgent need (a seek's cold target) that shouldn't
     * have to race the browser's own per-origin connection limit against
     * a pile of already-in-flight, lower-priority background-prefetch
     * fetches that simply got there first. Preempted fetches are not
     * treated as failures (see `_recordFetchOutcome`'s AbortError
     * handling) -- a later cache pass will naturally re-request whichever
     * of them are still relevant.
     *
     * @param {Iterable<number>} keepIndices - Segment indices whose in-flight fetch should be left alone.
     * @returns {void}
     */
    preemptInFlightFetches(keepIndices) {
        const keepSet = new Set(keepIndices);
        for (const [index, entry] of this._inFlightFetches) {
            if (!keepSet.has(index)) {
                entry.abortController.abort();
            }
        }
    }

    /**
     * Returns a segment's already-cached raw bytes synchronously, never
     * fetching -- the one accessor Tier 2 (frame-store.js) is allowed to
     * use for its ordinary decode path, so decode can structurally never
     * trigger a network fetch, even via a race between a caller's own
     * hasRawBytes() check and its next call. Still subject to the same
     * freshness check as every other cache read (see
     * _getFreshCachedBuffer) -- a stale entry throws exactly as if
     * nothing were cached, rather than handing the decoder bytes that no
     * longer correspond to what this index should now serve.
     *
     * @param {number} segmentIndexNumber - Segment index to read.
     * @returns {ArrayBuffer} The segment's cached raw bytes.
     * @throws {Error} When the segment's raw bytes are not cached (or are stale).
     */
    getCachedRawBytes(segmentIndexNumber) {
        const buffer = this._getFreshCachedBuffer(segmentIndexNumber);
        if (!buffer) {
            throw new Error(`Segment ${segmentIndexNumber} raw bytes are not cached`);
        }
        const segment = this.segmentIndex.segments[segmentIndexNumber];
        this._touch(segmentIndexNumber, buffer, this._resolveSegmentUrl(segmentIndexNumber, segment));
        return buffer;
    }

    /**
     * Returns a segment's cached raw bytes, if present.
     *
     * No session-routing staleness check is applied, and none is needed:
     * segment indices are absolute in every Jellyfin session (see
     * setBehindSession), so index N holds the same real time range no
     * matter which session's url fetched it -- forward, or any behind
     * session at any anchor. The url a segment was fetched through is
     * kept only for diagnostics.
     *
     * An earlier version compared the cached url against what
     * _resolveSegmentUrl would return now and evicted on a mismatch. That
     * was built on the (since-disproven) belief that each session
     * numbered its own segments from 0, and it is what silently discarded
     * large runs of perfectly good cached segments whenever the behind
     * session was re-anchored -- the unexplained mass-eviction report
     * that its own temporary diagnostic was added to chase.
     *
     * @param {number} segmentIndexNumber - Segment index to look up.
     * @returns {ArrayBuffer|undefined} The cached bytes, or undefined if absent.
     */
    _getFreshCachedBuffer(segmentIndexNumber) {
        const entry = this._rawSegmentCache.get(segmentIndexNumber);
        if (!entry) {
            return undefined;
        }
        return entry.buffer;
    }

    /**
     * Logs a raw-fetch progress or failure message to the console and, if
     * supplied, to the `onDebug` callback -- see the constructor's own doc
     * comment for why this exists (a raw fetch can be silently in flight
     * for a long time otherwise).
     *
     * @param {string} message - Message text, without the "[segment-fetcher]" prefix (added here).
     * @returns {void}
     */
    _logDebug(message) {
        const prefixed = `[segment-fetcher] ${message}`;
        console.log(prefixed);
        if (this.onDebug) {
            this.onDebug(prefixed);
        }
    }

    /**
     * Fetches the shared init segment, caching it forever (it's tiny and
     * identical for every media segment in this stream).
     *
     * @async
     * @returns {Promise<ArrayBuffer>} Raw init segment bytes.
     * @throws {Error} When the fetch fails.
     */
    async fetchInitSegment() {
        if (this._initSegmentBuffer) {
            return this._initSegmentBuffer;
        }

        if (!this._initSegmentPromise) {
            const rangeOptions = buildRangeHeaderOptions(this.segmentIndex.initByteRangeStart, this.segmentIndex.initByteRangeEnd);
            this._initSegmentPromise = fetchWithTimeout(this.segmentIndex.initSegmentUrl, undefined, rangeOptions)
                .then((response) => {
                    if (!response.ok) {
                        throw new Error(`Failed to fetch init segment (${response.status}): ${this.segmentIndex.initSegmentUrl}`);
                    }
                    if (rangeOptions && response.status !== 206) {
                        // A byte-range request that comes back 200 means the
                        // server/resource loader ignored the Range header and
                        // handed back the WHOLE file -- silently treating
                        // that as "the init segment" would feed mp4box.js
                        // garbage instead of failing loudly.
                        throw new Error(`Init segment byte-range request was not honored (got ${response.status}, expected 206): ${this.segmentIndex.initSegmentUrl}`);
                    }
                    return response.arrayBuffer();
                })
                .then((buffer) => {
                    this._initSegmentBuffer = buffer;
                    return buffer;
                });
        }

        return this._initSegmentPromise;
    }

    /**
     * Fetches one media segment's raw bytes, serving from the LRU cache
     * when already fetched.
     *
     * @async
     * @param {number} segmentIndexNumber - Index into `segmentIndex.segments`.
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal] - Cancels the underlying fetch if it fires before this resolves -- see FrameStore's reference-counted wanter tracking, which is what actually decides when a fetch no caller wants anymore should be cancelled.
     * @returns {Promise<ArrayBuffer>} Raw segment bytes.
     * @throws {Error} When segmentIndexNumber is out of range or the fetch fails.
     * @throws {DOMException} AbortError, when `options.signal` fires before the fetch completes.
     */
    async fetchSegment(segmentIndexNumber, { signal } = {}) {
        const segment = this.segmentIndex.segments[segmentIndexNumber];
        if (!segment) {
            throw new Error(`No segment at index ${segmentIndexNumber}`);
        }

        const url = this._resolveSegmentUrl(segmentIndexNumber, segment);

        const cachedBuffer = this._getFreshCachedBuffer(segmentIndexNumber);
        if (cachedBuffer) {
            this._touch(segmentIndexNumber, cachedBuffer, url);
            return cachedBuffer;
        }

        const rangeOptions = buildRangeHeaderOptions(segment.byteRangeStart, segment.byteRangeEnd);
        const response = await fetchWithTimeout(url, signal, rangeOptions);
        if (!response.ok) {
            throw new Error(`Failed to fetch segment ${segmentIndexNumber} (${response.status}): ${url}`);
        }
        if (rangeOptions && response.status !== 206) {
            // See fetchInitSegment's identical check -- a silently-ignored
            // Range header would otherwise hand mp4box.js the WHOLE local
            // file instead of just this segment's moof+mdat.
            throw new Error(`Segment ${segmentIndexNumber} byte-range request was not honored (got ${response.status}, expected 206): ${url}`);
        }

        const buffer = await response.arrayBuffer();
        this._touch(segmentIndexNumber, buffer, url);
        this._evictIfNeeded();

        return buffer;
    }

    /**
     * Reports whether a segment's raw fetch failed recently enough that
     * automatic (opportunistic) callers should skip it until its backoff
     * window elapses -- a deliberate seek() is NOT gated by this.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {boolean} True if a recent failure's backoff window hasn't elapsed yet.
     */
    isFetchInBackoff(segmentIndexNumber) {
        const backoff = this._fetchBackoff.get(segmentIndexNumber);
        return !!backoff && Date.now() < backoff.nextAttemptAtMs;
    }

    /**
     * Records a raw-fetch outcome for backoff purposes: a real failure
     * grows that segment's backoff delay exponentially (up to
     * MAX_FETCH_RETRY_BACKOFF_MS); a success clears it. A cancellation is
     * deliberately not treated as a failure -- it says nothing about
     * whether the segment is actually fetchable.
     *
     * @param {number} segmentIndexNumber - Segment index the outcome applies to.
     * @param {(Error|null)} err - The rejection reason, or null on success.
     * @returns {void}
     */
    _recordFetchOutcome(segmentIndexNumber, err) {
        if (!err) {
            this._fetchBackoff.delete(segmentIndexNumber);
            return;
        }
        if (err.name === 'AbortError') {
            return;
        }

        const previous = this._fetchBackoff.get(segmentIndexNumber);
        const delayMs = previous
            ? Math.min(MAX_FETCH_RETRY_BACKOFF_MS, previous.delayMs * FETCH_RETRY_BACKOFF_MULTIPLIER)
            : INITIAL_FETCH_RETRY_BACKOFF_MS;
        this._fetchBackoff.set(segmentIndexNumber, { nextAttemptAtMs: Date.now() + delayMs, delayMs });

        if (this.onError) {
            this.onError(err);
        }
    }

    /**
     * Ensures a segment's raw bytes are fetched and cached -- Tier 1's
     * single entry point for every caller (opportunistic prefetch, the
     * render-path stall fallback, and seek()) so concurrent callers for
     * the same segment share one in-flight fetch instead of duplicating
     * network work.
     *
     * Callers that only transiently want a segment (seek(), which calls
     * this again for a new target on every drag movement) can pass
     * `signal` to release their want when it fires -- if no other caller
     * (e.g. opportunistic prefetch, which never passes a signal) still
     * wants this segment, its underlying fetch is cancelled immediately.
     *
     * @async
     * @param {number} segmentIndexNumber - Segment index to ensure.
     * @param {Object} [options]
     * @param {AbortSignal} [options.signal] - Releases this specific call's "want" when it fires.
     * @returns {Promise<ArrayBuffer>} The segment's raw bytes.
     */
    async ensureRawBytes(segmentIndexNumber, { signal } = {}) {
        const cachedBuffer = this._getFreshCachedBuffer(segmentIndexNumber);
        if (cachedBuffer) {
            const segment = this.segmentIndex.segments[segmentIndexNumber];
            this._touch(segmentIndexNumber, cachedBuffer, this._resolveSegmentUrl(segmentIndexNumber, segment));
            return cachedBuffer;
        }

        let entry = this._inFlightFetches.get(segmentIndexNumber);
        if (!entry) {
            // A real network fetch can take anywhere from under a second
            // to tens of seconds depending on the upstream transcoder/
            // network -- logging start and completion here is the only
            // signal that a raw fetch is in flight at all, as opposed to
            // having silently stalled or never having been requested.
            const sessionLabel = this._sessionLabelFor(segmentIndexNumber);
            this._logDebug(`segment ${segmentIndexNumber}: fetching raw bytes... [${sessionLabel}]`);
            const abortController = new AbortController();
            const promise = this.fetchSegment(segmentIndexNumber, { signal: abortController.signal })
                .then(
                    (buffer) => {
                        this._recordFetchOutcome(segmentIndexNumber, null);
                        this._logDebug(`segment ${segmentIndexNumber}: raw bytes ready (${buffer.byteLength} bytes) [${sessionLabel}]`);
                        return buffer;
                    },
                    (err) => {
                        this._recordFetchOutcome(segmentIndexNumber, err);
                        if (err.name !== 'AbortError') {
                            this._logDebug(`segment ${segmentIndexNumber}: raw fetch FAILED -- ${err.message} [${sessionLabel}]`);
                        }
                        throw err;
                    },
                )
                .finally(() => {
                    this._inFlightFetches.delete(segmentIndexNumber);
                });
            // sessionKey is captured HERE, at launch, and never recomputed --
            // see getInFlightFetchCountForSession for why re-deriving it
            // breaks the per-session concurrency ceiling.
            entry = { promise, wanterCount: 0, abortController, sessionKey: this.sessionKeyFor(segmentIndexNumber) };
            this._inFlightFetches.set(segmentIndexNumber, entry);
        }

        entry.wanterCount += 1;
        if (signal) {
            const release = () => this._releaseWanter(segmentIndexNumber, entry);
            if (signal.aborted) {
                release();
            } else {
                signal.addEventListener('abort', release, { once: true });
            }
        }

        return entry.promise;
    }

    /**
     * Releases one caller's "want" on an in-flight raw fetch, cancelling
     * it if that was the last remaining wanter and it hasn't resolved yet.
     *
     * @param {number} segmentIndexNumber - Segment index whose want is being released.
     * @param {Object} entry - The `_inFlightFetches` entry this release applies to.
     * @returns {void}
     */
    _releaseWanter(segmentIndexNumber, entry) {
        entry.wanterCount -= 1;
        if (entry.wanterCount <= 0 && this._inFlightFetches.get(segmentIndexNumber) === entry) {
            entry.abortController.abort();
        }
    }

    /**
     * Marks a cache entry as most-recently-used by re-inserting it (Map
     * iteration order follows insertion order). Stores the URL these
     * bytes were actually fetched from (or, for a cache hit, the URL this
     * index currently resolves to) alongside the buffer -- see
     * _getFreshCachedBuffer, which is what actually reads it back.
     *
     * @param {number} segmentIndexNumber - Segment index to bump.
     * @param {ArrayBuffer} buffer - Its cached bytes.
     * @param {string} url - The URL these bytes came from (or currently correspond to).
     * @returns {void}
     */
    _touch(segmentIndexNumber, buffer, url) {
        const previousEntry = this._rawSegmentCache.get(segmentIndexNumber);
        if (previousEntry) {
            this._rawSegmentBytes -= previousEntry.buffer.byteLength;
        }
        this._rawSegmentCache.delete(segmentIndexNumber);
        this._rawSegmentCache.set(segmentIndexNumber, { buffer, url });
        this._rawSegmentBytes += buffer.byteLength;
    }

    /**
     * Evicts the oldest cache entries until the cache is back within
     * `maxRawCacheBytes`.
     *
     * @returns {void}
     */
    _evictIfNeeded() {
        while (this._rawSegmentBytes > this.maxRawCacheBytes) {
            let evicted = false;

            // Prefer evicting the oldest non-protected segment first.
            // This keeps the local paused neighborhood resident longer.
            for (const key of this._rawSegmentCache.keys()) {
                if (!this._protectedRawSegments.has(key)) {
                    const entry = this._rawSegmentCache.get(key);
                    this._rawSegmentBytes -= entry.buffer.byteLength;
                    this._rawSegmentCache.delete(key);
                    evicted = true;
                    break;
                }
            }

            if (!evicted) {
                // If everything is protected, capacity still has to win.
                // Fall back to ordinary oldest-first eviction.
                // This avoids an infinite loop when protection is too large.
                const oldestKey = this._rawSegmentCache.keys().next().value;
                const entry = this._rawSegmentCache.get(oldestKey);
                this._rawSegmentBytes -= entry.buffer.byteLength;
                this._rawSegmentCache.delete(oldestKey);
            }
        }
    }
}
