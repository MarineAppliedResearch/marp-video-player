/**
 * Media source for Jellyfin's on-the-fly HLS transcode path.
 *
 * Owns everything HLS-specific: loading the playlist, the per-segment URLs
 * and the raw-byte fetcher that uses them, the shared init segment, mp4box
 * demuxing, and the keyframe-continuity fallback. The engine above sees
 * only ordered units with real start/end times and asks for their chunks,
 * so a source whose units are byte ranges of one file (Direct Play, local
 * files) can answer the same questions with no playlist and no init
 * segment existing at all.
 *
 * @fileoverview The Jellyfin HLS transcode media source.
 * @module video-engine/media-source-jellyfin-transcode
 */

import { demuxSegment } from './demuxer.js';
import { loadSegmentIndex } from './playlist-manager.js';
import { SegmentFetcher } from './segment-fetcher.js';
import { MediaSource } from './media-source.js';
import { getQualityOptions } from './quality-options.js';
import { JellyfinPlaybackReporter } from './jellyfin-playback-reporter.js';

/**
 * How far behind the playhead the CLOSE behind session starts its own
 * transcode, in seconds. Deliberately small.
 *
 * A Jellyfin session only ever sweeps FORWARD from its anchor, so it
 * produces the segment nearest its anchor first and the one nearest the
 * playhead last -- exactly the opposite order from what reverse playback
 * consumes. A session anchored far back therefore delivers what reverse
 * needs soonest LAST of all. Keeping this session tight means it reaches
 * the playhead's own neighbourhood almost immediately; the deeper section
 * is the extended session's job instead.
 */
const CLOSE_LOOK_BEHIND_SECONDS = 9;

/** Ceiling on how many units below the close session's start the extended session will scan for the next uncached run -- keeps it from anchoring at the very start of a long video the playhead will never reach. */
const EXTENDED_MAX_SCAN_SEGMENTS = 60;

/** How often to check whether the close session's coverage has drifted stale relative to the current playhead, in ms. */
const BEHIND_SESSION_CHECK_INTERVAL_MS = 2000;

/**
 * How close the playhead may get to the close session's own start before
 * that session is re-anchored -- it is about to reverse out the bottom of
 * its coverage.
 *
 * Must stay well BELOW CLOSE_LOOK_BEHIND_SECONDS, or a session is stale
 * the moment it is created and re-negotiates on every check: with a 9s
 * look-behind and a 10s trigger, the close session re-anchored every 2
 * seconds forever, paying a transcoder restart each time.
 */
const BEHIND_SESSION_MIN_DISTANCE_SECONDS = 3;

/** How far the playhead may drift PAST the close session's anchor before it is re-anchored -- beyond this it is stale coverage of territory the user has long since passed, not a tight buffer just behind them. */
const BEHIND_SESSION_MAX_DISTANCE_SECONDS = CLOSE_LOOK_BEHIND_SECONDS + 15;

/**
 * Supplies the unit index and decoder chunks for a Jellyfin HLS stream.
 *
 * @class JellyfinTranscodeMediaSource
 */
export class JellyfinTranscodeMediaSource {
    /**
     * @param {Object} params
     * @param {string} params.streamUrl - MARP/Jellyfin stream-negotiation URL.
     * @param {Object} [params.fetchOptions] - Extra fetch() options applied to every request this source makes.
     * @param {number} [params.rawSegmentCacheBudgetBytes] - Tier 1 raw-segment cache budget in bytes.
     * @param {function(string): void} [params.onDebug] - Called with progress messages, e.g. when the continuity fallback fires.
     * @param {function(Error): void} [params.onError] - Called once per real raw-fetch failure.
     */
    constructor({ streamUrl, fetchOptions, rawSegmentCacheBudgetBytes, onDebug, onError, client, itemId, qualityOption, getCurrentTime }) {
        this.streamUrl = streamUrl;
        this.fetchOptions = fetchOptions;
        this.rawSegmentCacheBudgetBytes = rawSegmentCacheBudgetBytes;
        this.onDebug = onDebug;
        this.onError = onError;

        // Supplied together, these let the source negotiate its own extra
        // sessions; without them it runs single-session (see _canNegotiate).
        this.client = client;
        this.itemId = itemId;
        this.qualityOption = qualityOption;
        this.getCurrentTime = getCurrentTime;

        // Both created by load(), which must run before anything else.
        this.segmentFetcher = null;
        this._segmentIndex = null;

        // Behind sessions currently installed, keyed by role, so each can be
        // re-anchored independently: 'close' hugs the playhead and re-anchors
        // often, 'extended' owns the deeper section and rarely does.
        this._behindSessionsByRole = new Map();

        // Per-role negotiation bookkeeping. The generation counter discards a
        // superseded negotiation whose own round-trip finished after a newer
        // one's; the in-flight flag stops speculative attempts piling up while
        // one is still awaiting Jellyfin.
        this._closeStartTimeSeconds = null;
        this._closeGeneration = 0;
        this._closeInFlight = false;
        this._extendedStartTimeSeconds = null;
        this._extendedGeneration = 0;
        this._extendedInFlight = false;

        this._maintenanceHandle = null;

        // Playback reporting. The factory supplies the session ids from the
        // negotiation that produced this source's own stream.
        this._reporter = new JellyfinPlaybackReporter({
            client,
            itemId,
            getCurrentTime,
            onDebug: (message) => this._logDebug(message),
        });
    }

    /**
     * Loads the playlist and builds this source's Tier 1 fetcher over it.
     *
     * Tier 1 lives here rather than in the engine because everything it
     * does is HLS-specific -- one URL per segment, behind-session routing,
     * a concurrency ceiling sized for a sequential transcoder. The engine
     * still drives it (hasRawBytes/ensureRawBytes/preemptInFlightFetches),
     * it just no longer constructs it.
     *
     * @async
     * @returns {Promise<void>}
     */
    async load() {
        this._segmentIndex = await loadSegmentIndex(this.streamUrl, { fetchOptions: this.fetchOptions });
        this.segmentFetcher = new SegmentFetcher(this._segmentIndex, {
            maxRawCacheBytes: this.rawSegmentCacheBudgetBytes,
            // A raw fetch a seek is awaiting can be in flight for many
            // seconds with no other visible signal that anything is
            // happening at all.
            onDebug: this.onDebug,
            onError: this.onError,
        });
    }

    /**
     * The engine-facing unit index: ordered decodable units with real
     * start/end times, and no URLs -- how a unit's bytes are located is
     * this source's business alone.
     *
     * @returns {{segments: Array<{index: number, startTime: number, endTime: number, duration: number}>, totalDuration: number}} Ordered units and total duration.
     */
    getUnitIndex() {
        return {
            segments: this._segmentIndex.segments.map(({ index, startTime, endTime, duration }) => ({
                index,
                startTime,
                endTime,
                duration,
            })),
            totalDuration: this._segmentIndex.totalDuration,
        };
    }

    /**
     * Demuxes one unit's already-fetched bytes into decoder chunks.
     *
     * Requires the unit's raw bytes to be present in Tier 1 -- this never
     * fetches them. The one exception is the continuity fallback below,
     * which needs the PRECEDING unit's bytes to make decode possible at
     * all; that is an implementation detail of decoding this unit, not a
     * scheduling decision.
     *
     * @async
     * @param {number} unitIndex - Index of the unit to demux.
     * @returns {Promise<{codec: string, description: (Uint8Array|null), chunks: Array<Object>, unitFirstTimestampMicros: (number|null)}>} Chunks in decode order, plus this unit's own first presentation timestamp so merged-in frames can be trimmed after decode.
     * @throws {Error} When unit 0 itself does not start with a keyframe (unrecoverable).
     */
    async fetchChunks(unitIndex) {
        const initBuffer = await this.segmentFetcher.fetchInitSegment();
        const segmentBuffer = this.segmentFetcher.getCachedRawBytes(unitIndex);

        let demuxResult = await demuxSegment(initBuffer, segmentBuffer);

        // Captured before any merge, so the caller can trim prepended
        // frames back out after decode.
        const unitFirstTimestampMicros = demuxResult.chunks.length > 0 ? demuxResult.chunks[0].timestamp : null;

        if (demuxResult.chunks.length === 0 || demuxResult.chunks[0].type !== 'key') {
            // Defensive: this unit's first sample isn't a keyframe, contrary
            // to Jellyfin's BreakOnNonKeyFrames=False guarantee. Merge the
            // previous unit's chunks so decode has a real keyframe to start
            // from, rather than corrupting output or throwing.
            this._logDebug(`unit ${unitIndex}: non-key start, merging previous unit for decode continuity`);
            if (unitIndex === 0) {
                throw new Error('First segment does not start with a keyframe -- cannot recover.');
            }

            const previousBuffer = await this.segmentFetcher.ensureRawBytes(unitIndex - 1);
            const previousDemux = await demuxSegment(initBuffer, previousBuffer);

            demuxResult = {
                codec: demuxResult.codec,
                description: demuxResult.description,
                chunks: [...previousDemux.chunks, ...demuxResult.chunks].sort((a, b) => a.timestamp - b.timestamp),
            };
        }

        return { ...demuxResult, unitFirstTimestampMicros };
    }

    /**
     * Starts the behind-session maintenance timer, and runs one check
     * immediately rather than waiting a full interval, so backward buffer
     * starts warming the moment playback is ready.
     *
     * Deliberately its own wall-clock timer rather than something driven
     * off the scheduler's cache passes: those run per animation frame
     * while playing and every 500ms while paused, and negotiating a
     * Jellyfin session costs a real ffmpeg restart, so its cadence must
     * not be a function of playback state.
     *
     * @returns {void}
     */
    startBehindSessionMaintenance() {
        if (!this._canNegotiate() || this._maintenanceHandle !== null) {
            return;
        }
        this._maintenanceHandle = setInterval(() => this._maybeRefreshBehindSessions(), BEHIND_SESSION_CHECK_INTERVAL_MS);
        this._maybeRefreshBehindSessions();
    }

    /**
     * Stops the maintenance timer and abandons any in-flight negotiation
     * by bumping both generations, so a late result can never apply to a
     * torn-down source.
     *
     * @returns {void}
     */
    stopBehindSessionMaintenance() {
        if (this._maintenanceHandle !== null) {
            clearInterval(this._maintenanceHandle);
            this._maintenanceHandle = null;
        }
        ++this._closeGeneration;
        ++this._extendedGeneration;
    }

    /**
     * Re-anchors the close behind session at the playhead. Called when a
     * seek lands, and by the maintenance timer when coverage goes stale.
     *
     * Fire-and-forget: this only affects opportunistic background fetches
     * for units below the anchor, never a seek's own target fetch.
     *
     * @param {number} landedTimeSeconds - Where playback now is, in seconds.
     * @returns {void}
     */
    prepareForPlayhead(landedTimeSeconds) {
        if (!this._canNegotiate()) {
            return;
        }

        const generation = ++this._closeGeneration;
        const behindStartTimeSeconds = Math.max(0, landedTimeSeconds - CLOSE_LOOK_BEHIND_SECONDS);
        this._closeInFlight = true;

        this._negotiateBehindStreamUrl(behindStartTimeSeconds)
            .then((behindStreamUrl) => {
                if (!behindStreamUrl || generation !== this._closeGeneration) {
                    // Superseded by a newer negotiation -- discard silently.
                    return undefined;
                }
                // Re-checked again inside _applyBehindSession, after its
                // own playlist fetch: an OLDER call's fetch can finish
                // AFTER a newer one's and would otherwise clobber the
                // newer session with stale routing data. Confirmed live as
                // the cause of a unit decoding content from a completely
                // different point in the stream.
                return this._applyBehindSession('close', behindStreamUrl, behindStartTimeSeconds, () => generation === this._closeGeneration);
            })
            .then(() => {
                if (generation === this._closeGeneration) {
                    this._closeStartTimeSeconds = behindStartTimeSeconds;
                    this._logDebug(`close behind-session ready: sweeping forward from unit ${this._unitIndexForTime(behindStartTimeSeconds)}`);
                }
            })
            .catch((err) => this._logDebug(`ERROR preparing close behind session: ${err.message}`))
            .finally(() => {
                if (generation === this._closeGeneration) {
                    this._closeInFlight = false;
                }
            });
    }

    /**
     * Checks whether the close session's coverage has drifted outside its
     * healthy band behind the playhead and re-anchors it if so; otherwise
     * spends this tick on the deeper extended session.
     *
     * Both edges matter: sustained forward playback drifts the playhead
     * too far PAST the anchor, and a reverse scrub approaches the anchor
     * from above and is about to run out below it.
     *
     * @returns {void}
     */
    _maybeRefreshBehindSessions() {
        if (!this._canNegotiate() || typeof this.getCurrentTime !== 'function') {
            return;
        }
        // Never pile a speculative attempt on one still awaiting Jellyfin;
        // a real seek calls prepareForPlayhead directly and is not gated.
        if (this._closeInFlight) {
            return;
        }

        const currentTime = this.getCurrentTime();
        if (!Number.isFinite(currentTime)) {
            return;
        }

        const distanceFromCoverageStart = currentTime - this._closeStartTimeSeconds;
        // Being close to the anchor is only stale if there is somewhere
        // further back left to extend to. Once anchored at 0, being near
        // it is correct, not stale -- without this, playback starting near
        // time 0 re-negotiated pointlessly on every single check.
        const canExtendFurtherBack = this._closeStartTimeSeconds > 0;
        const coverageStale =
            this._closeStartTimeSeconds === null ||
            (canExtendFurtherBack && distanceFromCoverageStart <= BEHIND_SESSION_MIN_DISTANCE_SECONDS) ||
            distanceFromCoverageStart >= BEHIND_SESSION_MAX_DISTANCE_SECONDS;

        if (coverageStale) {
            this.prepareForPlayhead(currentTime);
            return;
        }

        // Checked here rather than on its own timer so the two sessions
        // never negotiate against Jellyfin simultaneously.
        if (this._closeStartTimeSeconds !== null) {
            this._prepareExtendedBehindSession(this._closeStartTimeSeconds);
        }
    }

    /**
     * Finds where the extended session should anchor: one chunk off the
     * TOP of the next run of uncached units below the close session.
     *
     * Anchoring at the bottom of the run instead would produce the units
     * nearest the playhead LAST -- measured live, an anchor 191s back
     * would have taken ~100s to reach the region reverse consumes within
     * seconds. Walking backward a chunk at a time keeps coverage growing
     * in the direction reverse actually travels.
     *
     * @param {number} closeStartTimeSeconds - Where the close session begins.
     * @returns {number|null} Absolute time to anchor at, or null if there is no uncached run worth covering.
     */
    _findExtendedBehindAnchor(closeStartTimeSeconds) {
        const units = this._segmentIndex.segments;
        const closeStartIndex = units.findIndex((unit) => unit.endTime > closeStartTimeSeconds);
        if (closeStartIndex <= 0) {
            return null; // the close session already covers down to the start
        }

        const scanFloor = Math.max(0, closeStartIndex - EXTENDED_MAX_SCAN_SEGMENTS);

        // Top of the next missing run, walking down from the close session.
        let runTop = -1;
        for (let index = closeStartIndex - 1; index >= scanFloor; index--) {
            if (!this.segmentFetcher.hasRawBytes(index)) {
                runTop = index;
                break;
            }
        }
        if (runTop === -1) {
            return null; // everything within reach is already cached
        }

        // Bottom of that same contiguous missing run.
        let runBottom = runTop;
        while (runBottom - 1 >= scanFloor && !this.segmentFetcher.hasRawBytes(runBottom - 1)) {
            runBottom--;
        }

        const chunkUnits = Math.max(1, Math.round(CLOSE_LOOK_BEHIND_SECONDS / (units[0].endTime - units[0].startTime)));
        const anchorIndex = Math.max(runBottom, runTop - chunkUnits + 1);

        return units[anchorIndex].startTime;
    }

    /**
     * Negotiates (or re-anchors) the extended behind session.
     *
     * Re-anchored far less often than the close session: its value is
     * having already produced the deeper section by the time the playhead
     * reverses into it, and every re-anchor restarts its ffmpeg job and
     * throws that head start away.
     *
     * @param {number} closeStartTimeSeconds - Where the close session begins.
     * @returns {void}
     */
    _prepareExtendedBehindSession(closeStartTimeSeconds) {
        if (this._extendedInFlight) {
            return;
        }

        const anchor = this._findExtendedBehindAnchor(closeStartTimeSeconds);
        if (anchor === null || anchor === this._extendedStartTimeSeconds) {
            return;
        }

        const generation = ++this._extendedGeneration;
        this._extendedInFlight = true;

        this._negotiateBehindStreamUrl(anchor)
            .then((streamUrl) => {
                if (!streamUrl || generation !== this._extendedGeneration) {
                    return undefined;
                }
                return this._applyBehindSession('extended', streamUrl, anchor, () => generation === this._extendedGeneration);
            })
            .then(() => {
                if (generation === this._extendedGeneration) {
                    this._extendedStartTimeSeconds = anchor;
                    this._logDebug(`extended behind-session ready: sweeping forward from unit ${this._unitIndexForTime(anchor)}`);
                }
            })
            .catch((err) => this._logDebug(`ERROR preparing extended behind session: ${err.message}`))
            .finally(() => {
                if (generation === this._extendedGeneration) {
                    this._extendedInFlight = false;
                }
            });
    }

    /**
     * Loads a behind session's own playlist and installs it for routing.
     *
     * Segment indices are absolute in every session, so the start time
     * only marks how far back this session can serve from without being
     * forced to seek backward -- it is NOT an index translation.
     *
     * @async
     * @param {string} role - Session role, 'close' or 'extended'.
     * @param {string} behindStreamUrl - Stream URL negotiated with StartTimeTicks = startTimeSeconds.
     * @param {number} startTimeSeconds - The exact start time that URL was negotiated with.
     * @param {function(): boolean} isStillWanted - Re-checked after this call's own playlist fetch, immediately before applying.
     * @returns {Promise<void>}
     */
    async _applyBehindSession(role, behindStreamUrl, startTimeSeconds, isStillWanted) {
        const behindSegmentIndex = await loadSegmentIndex(behindStreamUrl, { fetchOptions: this.fetchOptions });
        if (isStillWanted && !isStillWanted()) {
            return;
        }
        this._behindSessionsByRole.set(role, {
            segments: behindSegmentIndex.segments,
            startTimeSeconds,
        });
        this.segmentFetcher.setBehindSessions([...this._behindSessionsByRole.values()]);
    }

    /**
     * Maps an absolute time to the unit index covering it, for logs --
     * every other line talks in unit numbers, so reporting an anchor only
     * in seconds made coverage hard to line up against fetches.
     *
     * @param {number} timeSeconds - Absolute time.
     * @returns {number} Unit index, or -1 if no unit covers that time.
     */
    _unitIndexForTime(timeSeconds) {
        return this._segmentIndex.segments.findIndex((unit) => unit.endTime > timeSeconds);
    }


    /**
     * Receives readers for engine state the source needs.
     *
     * Called by the engine once it is running. A source is usually built
     * before the engine exists -- a consumer picks one and passes it in --
     * so anything it needs to know about playback position arrives here
     * rather than through its constructor.
     *
     * @param {Object} engine
     * @param {function(): number} engine.getCurrentTime - Playhead position, in seconds.
     * @param {function(): boolean} engine.isPaused - Whether playback is paused.
     * @returns {void}
     */
    attachEngine({ getCurrentTime, isPaused }) {
        this.getCurrentTime = getCurrentTime;
        this._reporter.getCurrentTime = getCurrentTime;
        this._reporter.isPaused = isPaused;
    }

    /**
     * Supplies the session ids Jellyfin identifies a report by.
     *
     * @param {Object} session - {mediaSourceId, playSessionId} from PlaybackInfo.
     * @returns {void}
     */
    setPlaybackSession(session) {
        this._reporter.setSession(session);
    }

    /** Starts reporting playback to Jellyfin. @returns {void} */
    startPlaybackReporting() {
        this._reporter.start();
    }

    /** Stops reporting and sends a final "stopped". @returns {void} */
    stopPlaybackReporting() {
        this._reporter.stop();
    }

    /**
     * Whether this source can negotiate extra Jellyfin sessions for itself.
     *
     * Without a client and item id it runs single-session: playback still
     * works, but the region behind the playhead is not pre-produced, so
     * reverse falls back on the forward session and pays a transcoder
     * restart for every backward request.
     *
     * @returns {boolean} True when behind sessions are possible.
     */
    _canNegotiate() {
        return Boolean(this.client && this.itemId);
    }

    /**
     * Negotiates one extra transcode session starting at an earlier point
     * in the item, so its ffmpeg process only ever sweeps FORWARD through
     * the region behind the playhead instead of being asked to seek
     * backward -- which costs a restart every time.
     *
     * @async
     * @param {number} startTimeSeconds - Where this session's own transcode should begin.
     * @returns {Promise<string>} Absolute HLS playlist URL for the new session.
     */
    async _negotiateBehindStreamUrl(startTimeSeconds) {
        const negotiation = await this.client.getPlaybackInfo(this.itemId, { ...this.qualityOption, startTimeSeconds });
        return negotiation.streamUrl;
    }

    /**
     * @param {string} message - Message text, without the module prefix (added here).
     * @returns {void}
     */
    _logDebug(message) {
        const prefixed = `[media-source-jellyfin-transcode] ${message}`;
        console.log(prefixed);
        if (this.onDebug) {
            this.onDebug(prefixed);
        }
    }
}

/**
 * Plays directly from a Jellyfin server -- no MARE_API involvement. Wraps a
 * logged-in JellyfinClient for negotiation and playback reporting.
 */
export class JellyfinMediaSource extends MediaSource {
    /**
     * @param {import('./jellyfin-client.js').JellyfinClient} jellyfinClient - An already-authenticated client.
     */
    constructor(jellyfinClient) {
        super();
        this.client = jellyfinClient;
        this._negotiation = null;
    }

    /**
     * Probes the item's source characteristics and builds its quality-tier
     * menu (see quality-options.js for the tier scheme).
     *
     * @async
     * @param {string} itemId - Jellyfin item id.
     * @returns {Promise<Array<Object>>} Quality options, or [] if this item can't be transcoded at all.
     */
    async probeQualityOptions(itemId) {
        const source = await this.client.probeMediaSource(itemId);
        return getQualityOptions(source);
    }

    /**
     * @async
     * @param {string} itemId - Jellyfin item id.
     * @param {Object} qualityOption - A tier from {@link JellyfinMediaSource#probeQualityOptions}.
     * @returns {Promise<string>} Absolute Jellyfin HLS master playlist URL.
     */
    async resolveStreamUrl(itemId, qualityOption) {
        this._negotiation = await this.client.getPlaybackInfo(itemId, qualityOption);
        return this._negotiation.streamUrl;
    }

    /**
     * Negotiates a second, independent Jellyfin transcode session (its
     * own PlaySessionId/ffmpeg process), started at `startTimeSeconds`
     * (earlier than the seek anchor) via StartTimeTicks, so its ffmpeg
     * process only ever sweeps FORWARD through the anchor's behind-region
     * -- never restarting -- instead of being asked to move backward.
     * Confirmed live: even a session fully dedicated to serving segments
     * behind the anchor still restarts (multi-second cost, real 404/500s
     * under load) if asked in decreasing order; the fix is a session that
     * itself never needs to move backward, achieved by starting it
     * earlier and only ever requesting increasing indices from it (see
     * SegmentFetcher#setBehindSession/_resolveSegmentUrl).
     *
     * Not used for playback reporting -- `_negotiation` (from
     * resolveStreamUrl) remains the one Jellyfin considers "the" playback
     * session for resume-position/now-playing purposes; this second
     * session exists purely to pre-cache bytes.
     *
     * @async
     * @param {string} itemId - Jellyfin item id.
     * @param {Object} qualityOption - Same tier passed to {@link JellyfinMediaSource#resolveStreamUrl}.
     * @param {number} startTimeSeconds - Absolute position (seconds) to start this session's own transcode from.
     * @returns {Promise<string>} Absolute Jellyfin HLS master playlist URL for the second session.
     */
    async resolveBehindStreamUrl(itemId, qualityOption, startTimeSeconds) {
        const behindNegotiation = await this.client.getPlaybackInfo(itemId, { ...qualityOption, startTimeSeconds });
        return behindNegotiation.streamUrl;
    }

    /**
     * Two in flight PER LIVE SESSION (the engine applies this ceiling per
     * session, not across all of them -- see SegmentFetcher#sessionKeyFor).
     *
     * Confirmed live against Jellyfin's own
     * DynamicHlsController.GetDynamicSegment that its on-the-fly HLS
     * transcoder is a single sequential ffmpeg process per PlaySessionId,
     * not a randomly-addressable file store: a request for a segment
     * behind that session's current transcoding index, or more than ~24s
     * ahead of it, kills and restarts its job. This was originally
     * serialized to 1 for that reason.
     *
     * Two is safe enough to be worth the throughput, because of two later
     * measurements. First, a segment the transcoder has ALREADY written is
     * served straight off disk -- ~59ms, no index check, no restart -- and
     * the large majority of prefetch requests are for exactly those, since
     * each behind session sweeps forward through ground the playhead is
     * about to revisit. Only not-yet-produced segments can trigger a
     * restart at all. Second, the restart is keyed on PlaySessionId (see
     * TranscodeManager.KillTranscodingJobs), so sessions cannot restart
     * each other, and the risk is confined to two requests within one
     * session both landing on unproduced segments.
     *
     * Sized at 2 rather than higher so three live sessions stay within the
     * browser's own ~6 connections-per-origin limit; beyond that, extra
     * requests would queue in the browser instead of actually running,
     * which is the same problem DEFAULT_MAX_CONCURRENT_TIER1_FETCHES
     * exists to avoid.
     *
     * Known residual cost, accepted deliberately: two concurrent requests
     * for segments a freshly re-anchored session has not produced yet can
     * still race its restart and return a transient 500 (seen live on
     * segments 147/148 against a session anchored at 146). SegmentFetcher's
     * backoff retries and playback continues, so this is log noise rather
     * than a break -- but if it ever becomes disruptive, dropping back to
     * 1 is the first thing to try.
     *
     * @returns {number} 2.
     */
    get maxConcurrentFetches() {
        return 2;
    }

    /**
     * Builds the report body shared by all three playback-reporting calls,
     * filling in the mediaSourceId/playSessionId from the negotiation that
     * produced the currently-playing stream.
     *
     * @param {Object} context - Playback context.
     * @param {number} [context.positionTicks] - Current position, in Jellyfin ticks.
     * @param {boolean} [context.isPaused] - Whether playback is currently paused.
     * @returns {Object} Report body for JellyfinClient's reporting methods.
     */
    _buildReport(context = {}) {
        return {
            mediaSourceId: this._negotiation && this._negotiation.mediaSourceId,
            playSessionId: this._negotiation && this._negotiation.playSessionId,
            positionTicks: context.positionTicks,
            isPaused: context.isPaused,
        };
    }

    async reportPlaybackStarted(itemId, context) {
        await this.client.reportPlaybackStarted(itemId, this._buildReport(context));
    }

    async reportPlaybackProgress(itemId, context) {
        await this.client.reportPlaybackProgress(itemId, this._buildReport(context));
    }

    async reportPlaybackStopped(itemId, context) {
        await this.client.reportPlaybackStopped(itemId, this._buildReport(context));
    }
}
