/**
 * The core playback engine: two decoupled loops (decode-ahead, and a
 * requestAnimationFrame-paced render loop), plus seek handling shared by
 * every `currentTime` write.
 *
 * Two-tier cache algorithm (see cache-window.js for the shared math):
 * - A fixed "protected floor" (segment-count radius around the playhead)
 *   is always fetched (Tier 1) and decoded (Tier 2), never evicted from
 *   either tier, regardless of direction, speed, or budget pressure --
 *   this guarantees an instant reversal or resume always has a ready
 *   buffer without depending on which way playback moves next.
 * - Beyond the floor, an opportunistic window extends outward, skewed
 *   toward the current direction of travel and scaled by |playbackRate|.
 *   Tier 1 (raw bytes) has no fixed outer edge -- the skew only orders
 *   fetch priority, and it keeps advancing across the whole timeline
 *   until its byte budget is full. Tier 2 (decode) only ever decodes
 *   segments Tier 1 already has, within a bounded window sized by its own
 *   decode budget.
 * - While paused, the window is symmetric (no directional skew, no rate
 *   scaling) instead of directional -- there's no active direction of
 *   travel or rate while paused. The direction of travel itself persists
 *   across pause (the last actually-played `playbackRate` sign) and only
 *   changes on the next play()/setPlaybackRate() call.
 *
 * A 1-frame key-nudge and a slider-release seek both go through the exact
 * same seek path, resolving near-instantly whenever the target segment is
 * already buffered (always true for a small nudge). Does NOT force a
 * pause on seek: confirmed against the real app's skipFrames() key
 * handler, which nudges Position while playback may still be active. If
 * playing, the render loop simply re-anchors its wall-clock reference to
 * the new position and continues from there.
 *
 * @fileoverview Forward/reverse playback pacing, seeking, and two-tier cache orchestration.
 * @author Isaac Travers
 * @module video-engine/scheduler
 */

import { findSegmentForTime } from './playlist-manager.js';
import { computeProtectedFloor, computeOpportunisticOrder } from './cache-window.js';

/**
 * Protected-floor reach on each side of the playhead, in SECONDS of video.
 *
 * Expressed in time rather than units because unit length varies by source:
 * 3s HLS segments versus ~10s Direct Play/local GOPs. A fixed unit count
 * silently became 3.3x more memory on the long-GOP sources -- a floor of 3
 * units either side is 21s (~1.5GB decoded at 1080p) with HLS segments but
 * 70s (~5.2GB) with GOPs, which exceeds any budget and left the playhead
 * unable to decode the unit it was about to cross into.
 */
const PROTECTED_FLOOR_RADIUS_SECONDS = 9;

/** Tier 2 (decode) opportunistic window: base per-side reach at rest (paused, or 1x on the non-preferred side), in SECONDS -- see PROTECTED_FLOOR_RADIUS_SECONDS. */
const TIER2_OPPORTUNISTIC_BASE_SECONDS = 12;

/** Tier 1 (raw fetch) opportunistic pacing: base new-fetch launches per cache pass at rest. */
const TIER1_BASE_PACING_PER_PASS = 2;

/**
 * Default ceiling on simultaneously in-flight Tier 1 fetches, across
 * protected floor and opportunistic candidates combined, for a source that
 * supports true random access (e.g. a static file server). Without this, an
 * unbounded background frontier (see cache-window.js's module doc) can
 * accumulate far more concurrent `fetch()` calls than the browser's own
 * per-origin connection limit -- queuing a newly-urgent request (e.g. a
 * seek's own cold target) behind a pile of older, lower-priority ones
 * instead of actually racing them.
 *
 * Overridable per-instance via the constructor's `maxConcurrentTier1Fetches`
 * option -- a source backed by a single sequential live producer (e.g.
 * Jellyfin's on-the-fly HLS transcoder, confirmed live against its own
 * DynamicHlsController: any request for a segment behind its current
 * transcoding index, or too far ahead of it, kills and restarts that
 * session's ffmpeg job) needs a much lower ceiling, since concurrent
 * requests spanning both directions around the playhead can otherwise
 * race two conflicting restarts against each other under the same
 * PlaySessionId -- confirmed live as the cause of transient 404/500s that
 * only self-healed via SegmentFetcher's own retry/backoff.
 */
const DEFAULT_MAX_CONCURRENT_TIER1_FETCHES = 6;

/** Directional skew ratio while playing: preferred-direction candidates considered per one opposite-direction candidate. */
const DIRECTIONAL_SKEW_RATIO = 2;

/** Skew ratio while paused: symmetric, no directional preference. */
const PAUSED_SKEW_RATIO = 1;

/** Paused background cache-fill cadence, in ms. */
const PAUSED_FILL_INTERVAL_MS = 500;

/**
 * How far a presented frame's own decoded timestamp may sit from the
 * mediaTime being reported for it before that counts as a real content
 * mismatch, in seconds. Generous on purpose: a segment's first frame
 * routinely sits a fraction of a second off its declared start (an ~80ms
 * offset is normal for this transcoder), while a genuine mis-route is off
 * by whole segments or minutes -- so this only needs to separate those
 * two scales, not measure either precisely.
 */
const CONTENT_MISMATCH_TOLERANCE_SECONDS = 1.5;

/**
 * Drives forward/reverse pacing, seeking, and the two-tier cache
 * algorithm against a FrameStore (Tier 2) and its SegmentFetcher (Tier 1),
 * rendering through a CanvasRenderer.
 *
 * @class Scheduler
 */
export class Scheduler {
    /**
     * @param {Object} params
     * @param {Object} params.segmentIndex - SegmentIndex from {@link module:video-engine/playlist-manager.loadSegmentIndex}.
     * @param {Object} params.frameStore - {@link module:video-engine/frame-store.FrameStore} instance (Tier 2).
     * @param {Object} params.canvasRenderer - {@link module:video-engine/canvas-renderer.CanvasRenderer} instance.
     * @param {function(string, Object=): void} params.emit - Callback for shim event dispatch, with an optional detail object merged onto the dispatched event (e.g. `emit('seeking', {targetTime})`, `emit('playing')`). NOT used for segment fetch/decode failures -- those are reported once each via FrameStore/SegmentFetcher's own `onError`, not through here.
     * @param {number} [params.protectedFloorRadius] - Segments protected on each side of the playhead, in both tiers. Default 3.
     * @param {number} [params.maxConcurrentTier1Fetches] - Ceiling on simultaneously in-flight Tier 1 fetches. Default 6 (see DEFAULT_MAX_CONCURRENT_TIER1_FETCHES's own doc comment); a source backed by a single sequential live producer should pass a much lower value.
     */
    constructor({ segmentIndex, frameStore, canvasRenderer, emit, protectedFloorRadius, maxConcurrentTier1Fetches }) {
        this.segmentIndex = segmentIndex;
        this.frameStore = frameStore;
        this.canvasRenderer = canvasRenderer;
        this.emit = emit;
        const unitDurationSeconds = (segmentIndex.segments[0] && segmentIndex.segments[0].duration) || 1;
        this._protectedFloorRadius = protectedFloorRadius || this._floorRadiusForUnits(unitDurationSeconds);
        this._tier2OpportunisticBase = Math.max(1, Math.round(TIER2_OPPORTUNISTIC_BASE_SECONDS / unitDurationSeconds));
        this._maxConcurrentTier1Fetches = maxConcurrentTier1Fetches || DEFAULT_MAX_CONCURRENT_TIER1_FETCHES;

        this.playbackRate = 1;
        this.playing = false;
        this.seekingFlag = false;

        // Current frame is always an exact (segmentIndex, frameIdx) pair,
        // never a floating-point time re-snapped each tick -- avoids the
        // rounding drift that would otherwise accumulate across many steps.
        this.currentSegmentIndex = 0;
        this.currentFrameIdx = 0;

        this._anchorWallClockMs = 0;
        this._anchorTime = 0;
        this._presentedMediaTime = 0;

        // Last segment index a content-mismatch warning fired for, so a
        // real mismatch logs once per segment instead of once per frame.
        this._lastMismatchWarnedSegment = null;
        this._pausedFreezeTime = null;
        this._rafHandle = null;
        this._pausedIntervalHandle = null;
        this._frameCallbacks = [];
        this._presentedFrameCount = 0;

        // The last direction actually played (playbackRate's sign),
        // defaulting to forward if no play has happened yet this session.
        // Persists across pause -- pause does not reset or symmetrize it,
        // only the cache pass itself becomes symmetric while paused.
        this._lastDirectionSign = 1;

        // Bumped on every seek() call; a seek that's still awaiting decode
        // when a newer one starts checks this after the await to detect
        // it's been superseded, and abandons its own (now-stale) result
        // instead of clobbering the newer seek's state -- confirmed live
        // that two overlapping seeks (a slow cold-segment one racing a
        // fast already-buffered one) can otherwise complete out of order.
        this._seekGeneration = 0;

        // The previous seek()'s own AbortController, aborted the instant a
        // newer seek() call starts -- releases that seek's "want" on
        // whatever segment it was fetching (see SegmentFetcher.ensureRawBytes's
        // reference-counted wanters), so a segment nothing else still
        // wants gets its in-flight fetch cancelled immediately instead of
        // completing uselessly. Confirmed live this is the actual cause
        // of a scrub-drag "backlog": every intermediate position used to
        // kick off a real, uncancellable fetch regardless of whether the
        // drag had already moved past it.
        this._seekFetchAbort = null;

        // Null while nothing is blocking playback/seek; otherwise the
        // reason the currently-displayed frame is stale -- used to emit
        // 'waiting'/'playing' transitions a consumer (e.g. a buffering
        // spinner) can key off of. See _updateBufferState()'s own doc
        // comment for why this is idempotent-by-value rather than a
        // plain boolean.
        this._bufferState = null;

        // Set by the engine once it exists, and null when the media has no
        // audio. The scheduler drives it and never reads playback state back
        // out of it: this clock is the only clock, and audio is told where it
        // is rather than asked. See audio-output.js's module comment.
        this.audioOutput = null;

        canvasRenderer.onFramePresented(() => this._dispatchFrameCallbacks());
    }

    /**
     * Attaches an audio output for this scheduler to drive.
     *
     * Set after construction rather than passed in, because an AudioOutput
     * reads the playhead from the scheduler it belongs to -- one of them has
     * to exist first, and it is this one.
     *
     * @param {?Object} audioOutput - {@link module:video-engine/audio-output.AudioOutput} instance, or null for media with no audio.
     * @returns {void}
     */
    setAudioOutput(audioOutput) {
        this.audioOutput = audioOutput;
    }

    /**
     * Brings audio into line with the current playback state.
     *
     * Audio plays only when the picture is genuinely moving: playing, not
     * mid-seek, and not blocked on fetch or decode. Everything else stops it,
     * including a playback rate outside the audible band, which
     * {@link module:video-engine/audio-output.AudioOutput#start} treats as an
     * ordinary request to be silent rather than as an error.
     *
     * Only ever called on a state transition. Calling it while audio is
     * already running restarts it, which is audible.
     *
     * @returns {void}
     */
    _syncAudio() {
        if (!this.audioOutput) {
            return;
        }

        if (this.playing && !this.seekingFlag && this._bufferState === null) {
            this.audioOutput.start(this.currentTime, this.playbackRate);
        } else {
            this.audioOutput.stop();
        }
    }

    /** @returns {number} Total stream duration, in seconds. */
    /**
     * Converts the seconds-based floor reach into a unit radius, clamped so
     * the floor can never ask for more decoded units than the cache can
     * hold.
     *
     * That clamp is the invariant that was violated: with ~10s GOPs the
     * cache held 4 units while the floor pinned 7, so eviction could free
     * nothing and the unit the playhead was about to enter never decoded.
     * One slot is always left free for the unit being decoded next.
     *
     * @param {number} unitDurationSeconds - Nominal unit length, in seconds.
     * @returns {number} Floor radius in units, on each side of the playhead.
     */
    _floorRadiusForUnits(unitDurationSeconds) {
        const wanted = Math.max(1, Math.round(PROTECTED_FLOOR_RADIUS_SECONDS / unitDurationSeconds));
        const capacity = this.frameStore.maxSegmentsBuffered;
        if (!Number.isFinite(capacity)) {
            return wanted;
        }
        // floorSize = 2r + 1 must stay at or below capacity - 1.
        const affordable = Math.max(0, Math.floor((capacity - 2) / 2));
        return Math.min(wanted, affordable);
    }

    get duration() {
        return this.segmentIndex.totalDuration;
    }

    /**
     * KNOWN BUG (unfixed, low priority -- see
     * docs/developer/video-player-library-handoff.md): playing in reverse
     * into the start of a clip makes this read the clip's END for about one
     * frame before the engine pauses itself at 0. Measured on a 30.44s clip:
     * the playhead walked 2.16 -> 0.20 normally, then one sample read 30.12,
     * then 'pause' fired and it settled at 0.12.
     *
     * The stop itself is correct -- _tick() clamps targetTime to 0 on a
     * reverse boundary -- but this getter reports _presentedMediaTime, the
     * frame actually on screen, not that clamped target, so whatever lands
     * at the boundary is reported verbatim. Cosmetic in the player (the
     * scrub handle flicks right for a frame), but the WebView2 bridge posts
     * a frame| message per presented frame and Jellyfin playback reporting
     * posts positions, so a consumer can act on that stray value. Reproduce
     * by playing in reverse into 0 while sampling currentTime.
     *
     * @returns {number} Presentation time of the currently displayed frame, in seconds.
     */
    get currentTime() {
        if (this._pausedFreezeTime !== null && !this.playing && !this.seekingFlag) {
            return this._pausedFreezeTime;
        }
        return this._presentedMediaTime;
    }

    /**
     * Maps a decoded frame timestamp onto the stream's media timeline for
     * the segment it belongs to.
     *
     * Some streams expose sample timestamps that are offset from HLS
     * segment start times (for example by one full segment duration), so
     * comparing raw frame timestamps directly against playlist time can
     * pin playback to a segment's edge frame after seek. This mapping
     * aligns each decoded segment's first frame to that segment's own
     * startTime, preserving within-segment frame spacing while staying in
     * the playlist timeline the scheduler uses everywhere else.
     *
     * @param {number} segmentIndexNumber - Segment index the frame came from.
     * @param {number} frameTimestampMicros - Decoded frame timestamp, in microseconds.
     * @returns {number} Frame time in the playlist/media timeline, in seconds.
     */
    _frameTimestampToMediaTimeSeconds(segmentIndexNumber, frameTimestampMicros) {
        const segment = this.segmentIndex.segments[segmentIndexNumber];
        const buffer = this.frameStore.buffers.get(segmentIndexNumber);
        const firstFrame = buffer && buffer.frames[0];

        if (!segment || !firstFrame) {
            return frameTimestampMicros / 1e6;
        }

        const offsetMicros = frameTimestampMicros - firstFrame.timestamp;
        return segment.startTime + offsetMicros / 1e6;
    }

    /**
     * Warns when a presented frame's own decoded timestamp disagrees with
     * the time the engine is claiming to display -- i.e. the frame on
     * screen is not from where the timecode says it is.
     *
     * This exists because that failure was, for a long time, undetectable
     * from the engine's own output. `mediaTime` is derived from the
     * forward segment grid (see _frameTimestampToMediaTimeSeconds), so it
     * can never disagree with that grid no matter what content a segment
     * actually holds; a mis-routed segment served content from a
     * completely different part of the video while every number the
     * engine reported looked self-consistent. The frame's raw timestamp
     * is the one independent signal available, since it comes from the
     * decoded bytes themselves.
     *
     * Warns once per segment rather than per frame -- at 25fps a genuine
     * mismatch would otherwise emit dozens of identical lines a second
     * and bury the rest of the log.
     *
     * @param {Object} metadata - The frame metadata about to be dispatched to frame callbacks.
     * @returns {void}
     */
    _warnOnContentMismatch(metadata) {
        if (!Number.isFinite(metadata.rawFrameTime)) {
            return;
        }

        const drift = Math.abs(metadata.rawFrameTime - metadata.mediaTime);
        if (drift <= CONTENT_MISMATCH_TOLERANCE_SECONDS) {
            return;
        }

        if (this._lastMismatchWarnedSegment === metadata.segmentIndex) {
            return;
        }
        this._lastMismatchWarnedSegment = metadata.segmentIndex;

        console.warn(
            `[scheduler] CONTENT MISMATCH on segment ${metadata.segmentIndex}: ` +
                `mediaTime=${metadata.mediaTime.toFixed(3)}s vs decoded frame timestamp ` +
                `${metadata.rawFrameTime.toFixed(3)}s (drift ${drift.toFixed(3)}s)`,
        );
        this.emit('debug', {
            message:
                `[scheduler] CONTENT MISMATCH on segment ${metadata.segmentIndex}: ` +
                `presenting mediaTime=${metadata.mediaTime.toFixed(3)}s but the decoded frame's own ` +
                `timestamp is ${metadata.rawFrameTime.toFixed(3)}s (drift ${drift.toFixed(3)}s) -- ` +
                `this segment's bytes are not from where its timecode claims.`,
        });
    }

    /**
     * Reports every segment's current fetch/decode/pin status, for a
     * scrub-bar visualization -- one entry per segment, in order.
     *
     * @returns {Array<{index: number, startTime: number, endTime: number, fetched: boolean, decoded: boolean, pinned: boolean}>} Per-segment state.
     */
    getSegmentStates() {
        return this.segmentIndex.segments.map((segment) => ({
            index: segment.index,
            startTime: segment.startTime,
            endTime: segment.endTime,
            fetched: this.frameStore.segmentFetcher.hasRawBytes(segment.index),
            decoded: this.frameStore.has(segment.index),
            pinned: this.frameStore.pinned.has(segment.index),
        }));
    }

    /**
     * Returns exact scheduler playhead internals for diagnostics.
     *
     * @returns {{currentSegmentIndex: number, currentFrameIdx: number, currentRawFrameTime: (number|null), currentTime: number, pausedAnchorTime: number, playing: boolean, seeking: boolean}}
     */
    getDebugState() {
        const buffer = this.frameStore.buffers.get(this.currentSegmentIndex);
        const frame = buffer && buffer.frames[this.currentFrameIdx];
        return {
            currentSegmentIndex: this.currentSegmentIndex,
            currentFrameIdx: this.currentFrameIdx,
            currentRawFrameTime: frame ? frame.timestamp / 1e6 : null,
            currentTime: this.currentTime,
            pausedAnchorTime: this._pausedFreezeTime,
            playing: this.playing,
            seeking: this.seekingFlag,
        };
    }

    /**
     * Registers a one-shot callback for the next presented frame,
     * matching the real requestVideoFrameCallback contract (callers must
     * re-register themselves each time to keep receiving frames).
     *
     * @param {function(number, Object): void} callback - Invoked with `(now, metadata)` on the next presented frame.
     * @returns {symbol} Handle usable with {@link Scheduler#cancelVideoFrameCallback}.
     */
    requestVideoFrameCallback(callback) {
        const handle = Symbol('marpVideoFrameCallback');
        this._frameCallbacks.push({ handle, callback });
        return handle;
    }

    /**
     * Cancels a pending frame callback registered via
     * {@link Scheduler#requestVideoFrameCallback}.
     *
     * @param {symbol} handle - Handle returned by requestVideoFrameCallback.
     * @returns {void}
     */
    cancelVideoFrameCallback(handle) {
        this._frameCallbacks = this._frameCallbacks.filter((entry) => entry.handle !== handle);
    }

    /**
     * Fires every pending frame callback exactly once, with metadata
     * describing the just-presented frame. The single choke point for
     * requestVideoFrameCallback dispatch, regardless of which mode
     * (forward/reverse/step/seek) presented the frame.
     *
     * @returns {void}
     */
    _dispatchFrameCallbacks() {
        if (this._frameCallbacks.length === 0) {
            return;
        }

        const toFire = this._frameCallbacks;
        this._frameCallbacks = [];
        this._presentedFrameCount += 1;

        const currentBuffer = this.frameStore.buffers.get(this.currentSegmentIndex);
        const currentFrame = currentBuffer && currentBuffer.frames[this.currentFrameIdx];

        const metadata = {
            mediaTime: this.currentTime,
            presentedFrames: this._presentedFrameCount,
            expectedDisplayTime: performance.now() + 16.6,
            presentationTime: performance.now(),
            width: this.canvasRenderer.canvas.width,
            height: this.canvasRenderer.canvas.height,
            // Not part of the real requestVideoFrameCallback contract --
            // an additive extra field (like marpVideo.fps) purely for
            // diagnostics, so callers can tell which segment is currently
            // driving playback without reaching into engine internals.
            segmentIndex: this.currentSegmentIndex,
            frameIndex: this.currentFrameIdx,
            rawFrameTime: currentFrame ? currentFrame.timestamp / 1e6 : NaN,
        };

        this._warnOnContentMismatch(metadata);

        const now = performance.now();
        for (const { callback } of toFire) {
            callback(now, metadata);
        }
    }

    /**
     * Starts (or resumes) playback at the current `playbackRate`.
     *
     * @returns {void}
     */
    play() {
        if (this.playing) {
            return;
        }
        this._stopPausedFillWorker();
        this.playing = true;
        this._anchorWallClockMs = performance.now();
        this._anchorTime = this.currentTime;
        this._pausedFreezeTime = null;
        this.emit('playing');
        this._syncAudio();
        this._scheduleTick();
    }

    /**
     * Pauses playback deterministically.
     *
     * @returns {void}
     */
    pause() {
        if (!this.playing) {
            return;
        }
        this.playing = false;
        if (this._rafHandle !== null) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = null;
        }

        this._pausedFreezeTime = this._presentedMediaTime;

        // Run one symmetric cache pass immediately (don't wait for the
        // first interval tick), then keep the background worker running
        // so newly-arrived raw bytes/budget headroom keep getting used.
        this._runCachePass(this.currentTime, { symmetric: true });
        this._startPausedFillWorker();

        this._syncAudio();
        this.emit('pause');
    }

    /**
     * Starts the paused background cache-fill worker.
     *
     * @returns {void}
     */
    _startPausedFillWorker() {
        if (this._pausedIntervalHandle !== null) {
            return;
        }

        this._pausedIntervalHandle = setInterval(() => {
            if (this.playing) {
                this._stopPausedFillWorker();
                return;
            }
            this._runCachePass(this.currentTime, { symmetric: true });
        }, PAUSED_FILL_INTERVAL_MS);
    }

    /**
     * Stops the paused background cache-fill worker, if running.
     *
     * @returns {void}
     */
    _stopPausedFillWorker() {
        if (this._pausedIntervalHandle !== null) {
            clearInterval(this._pausedIntervalHandle);
            this._pausedIntervalHandle = null;
        }
    }

    /**
     * Sets the playback rate, accepting negative values for reverse and
     * small magnitudes for slow motion. A nonzero rate updates the
     * persisted direction of travel used by the cache algorithm.
     *
     * Re-anchors the wall-clock reference so the new rate takes effect
     * from "now" rather than from the original anchor point, which would
     * otherwise jump the position the instant the next tick runs.
     *
     * @param {number} rate - New playback rate (negative plays in reverse).
     * @returns {void}
     */
    setPlaybackRate(rate) {
        if (this.playing) {
            this._anchorWallClockMs = performance.now();
            this._anchorTime = this.currentTime;
        }
        this.playbackRate = rate;
        if (rate !== 0) {
            this._lastDirectionSign = rate >= 0 ? 1 : -1;
        }

        // Audio cannot follow a rate change in place: every buffer already
        // scheduled was placed on the old mapping from media time to context
        // time. It restarts on the new mapping, from where the picture is now.
        if (this.playing) {
            this._syncAudio();
        }
    }

    /**
     * Schedules the next render-loop tick.
     *
     * @returns {void}
     */
    _scheduleTick() {
        this._rafHandle = requestAnimationFrame((now) => this._tick(now));
    }

    /**
     * One render-loop tick: computes the target presentation time from
     * the wall-clock anchor and playbackRate, renders it if buffered,
     * runs the two-tier cache pass, and reschedules itself.
     *
     * @param {number} now - `performance.now()`-style timestamp from requestAnimationFrame.
     * @returns {void}
     */
    _tick(now) {
        if (!this.playing) {
            return;
        }

        if (this.seekingFlag) {
            // Don't advance from the stale pre-seek anchor while a seek
            // is still resolving -- seek() re-anchors once it lands.
            this._scheduleTick();
            return;
        }

        const elapsedSeconds = (now - this._anchorWallClockMs) / 1000;
        let targetTime = this._anchorTime + elapsedSeconds * this.playbackRate;
        let hitBoundary = false;

        // Guard against pause races mid-tick.
        if (!this.playing) {
            return;
        }

        if (targetTime >= this.duration) {
            targetTime = this.duration;
            hitBoundary = this.playbackRate > 0;
        } else if (targetTime <= 0) {
            targetTime = 0;
            hitBoundary = this.playbackRate < 0;
        }

        const rendered = this._renderAtTime(targetTime, this.playbackRate >= 0 ? 'atOrBefore' : 'atOrAfter');

        if (!rendered) {
            // Stalled: re-anchor to the target we were trying to reach,
            // not the last-displayed position -- anchoring to the old
            // position (behind the segment boundary) let the next few
            // ticks' tiny elapsed increments keep landing back inside the
            // already-decoded segment, "succeeding" there for one
            // frame's duration before re-crossing into the stall --
            // confirmed live as a rapid waiting/playing flicker for the
            // whole real length of the stall. Anchoring to targetTime
            // still avoids the original runaway-catch-up concern (a long
            // stall no longer inflates targetTime once decode catches up).
            this._anchorWallClockMs = now;
            this._anchorTime = targetTime;
            this._updateBufferState(this._computeBufferReason(findSegmentForTime(this.segmentIndex, targetTime).index));
        } else {
            this._updateBufferState(null);
        }

        this._runCachePass(targetTime, { symmetric: false });

        if (hitBoundary) {
            this.pause();
            return;
        }

        if (this.playing) {
            this._scheduleTick();
        }
    }

    /**
     * Renders the frame at-or-before (forward) or at-or-after (reverse)
     * the given time, if its segment is already decoded.
     *
     * Never blocks the render loop on fetch/decode -- if the segment
     * isn't ready, the last displayed frame stays on screen (a graceful
     * stall) while the cache pass (and this method's own direct unstall
     * attempt) catch up in the background.
     *
     * @param {number} targetTime - Target presentation time, in seconds.
     * @param {('atOrBefore'|'atOrAfter')} direction - Which side of targetTime to prefer when landing between frames.
     * @returns {boolean} False if the needed segment isn't decoded yet (a stall); true otherwise, whether or not a new frame was actually presented.
     */
    _renderAtTime(targetTime, direction) {
        const segment = findSegmentForTime(this.segmentIndex, targetTime);

        if (!this.frameStore.has(segment.index)) {
            this._tryUnstall(segment.index);
            return false;
        }

        const gopBuffer = this.frameStore.buffers.get(segment.index);
        const frameIdx = this._locateFrameIndex(gopBuffer, targetTime, direction, segment.startTime);

        if (segment.index === this.currentSegmentIndex && frameIdx === this.currentFrameIdx) {
            // Reverse playback naturally reuses the same frame for a few
            // rAF ticks in a row -- not a stall, just a lower effective
            // frame rate than the render loop's own tick rate.
            return true;
        }

        const frame = gopBuffer.frames[frameIdx];
        const presented = this.canvasRenderer.render(frame);

        if (presented) {
            this.currentSegmentIndex = segment.index;
            this.currentFrameIdx = frameIdx;
            this._presentedMediaTime = this._frameTimestampToMediaTimeSeconds(segment.index, frame.timestamp);
        }

        return true;
    }

    /**
     * Attempts to unstall the render loop's exact target segment: ensures
     * its raw bytes (Tier 1) and, once available, its decode (Tier 2) --
     * independently of the opportunistic cache pass, so the one frame the
     * render loop needs right now isn't left waiting on that pass's own
     * pacing cap.
     *
     * Deliberately swallows rejections at this call site rather than
     * emitting an 'error' itself: this runs on every tick a stall
     * persists, so re-reporting here would duplicate the single report
     * SegmentFetcher/FrameStore already make through their own `onError`.
     *
     * @param {number} segmentIndex - Segment index the render loop is stalled on.
     * @returns {void}
     */
    _tryUnstall(segmentIndex) {
        const fetcher = this.frameStore.segmentFetcher;
        const hasRaw = fetcher.hasRawBytes(segmentIndex);

        if (!hasRaw) {
            if (!fetcher.isFetchInBackoff(segmentIndex)) {
                fetcher.ensureRawBytes(segmentIndex).catch(() => {});
            }
            return;
        }

        if (!this.frameStore.isDecodeInBackoff(segmentIndex)) {
            this.frameStore.ensureDecoded(segmentIndex).catch(() => {});
        }
    }

    /**
     * Reports which tier a given segment is currently waiting on -- the
     * one piece of information a buffering indicator needs to show a
     * different state for "downloading" versus "demuxing/decoding".
     *
     * @param {number} segmentIndex - Segment index to check.
     * @returns {('fetching'|'decoding')} 'fetching' if Tier 1 doesn't have raw bytes yet, 'decoding' if it does but Tier 2 hasn't decoded them yet.
     */
    _computeBufferReason(segmentIndex) {
        return this.frameStore.segmentFetcher.hasRawBytes(segmentIndex) ? 'decoding' : 'fetching';
    }

    /**
     * Emits 'waiting'/'playing'/'canplay' on an actual state transition
     * only, matching the real HTMLMediaElement contract -- not every tick.
     *
     * Clearing the block while paused emits 'canplay', NOT 'playing':
     * a paused seek unblocks (spinner off) without playback starting, and
     * 'playing' is what the UI keys its play/pause button off of.
     *
     * @param {('fetching'|'decoding'|null)} state - The current block, or null to clear it.
     * @returns {void}
     */
    _updateBufferState(state) {
        if (state === this._bufferState) {
            return;
        }
        this._bufferState = state;

        // A stall freezes the picture while the wall clock keeps running, so
        // audio carrying on would be playing against a frame that is no
        // longer current. It stops, and starts again wherever the picture
        // resumes.
        this._syncAudio();

        if (state) {
            this.emit('waiting', { reason: state });
        } else {
            this.emit(this.playing ? 'playing' : 'canplay');
        }
    }

    /**
     * Finds the index within a GopBuffer's frames closest to a target
     * time, on the requested side (at-or-before for forward playback,
     * at-or-after for reverse) -- a deterministic tie-break so a given
     * target time always lands on the same frame regardless of how it
     * was reached.
     *
     * @param {Object} gopBuffer - Decoded segment buffer (`{segmentIndex, frames}`).
     * @param {number} targetTimeSeconds - Target time, in seconds.
     * @param {('atOrBefore'|'atOrAfter')} direction - Which side of targetTime to prefer.
     * @returns {number} Index into `gopBuffer.frames`.
     */
    _locateFrameIndex(gopBuffer, targetTimeSeconds, direction, segmentStartTimeSeconds = 0) {
        // Rounded to the nearest whole microsecond -- frame timestamps are
        // always integers (see demuxer.js), but repeated floating-point
        // arithmetic on targetTimeSeconds (e.g. successive +-1/fps steps)
        // can leave it a fraction of a microsecond above or below an exact
        // frame timestamp. Left unrounded, that tiny overshoot is harmless
        // for an atOrBefore ('<=') comparison but silently breaks an
        // atOrAfter ('>=') comparison exactly on the target frame,
        // confirmed live: stepping back onto an exact prior frame landed
        // one frame later than intended until this rounding was added.
        const firstFrameTimestamp = gopBuffer.frames[0] ? gopBuffer.frames[0].timestamp : 0;
        const targetMicros = firstFrameTimestamp + Math.round((targetTimeSeconds - segmentStartTimeSeconds) * 1e6);
        const frames = gopBuffer.frames;

        if (direction === 'atOrBefore') {
            let idx = 0;
            for (let i = 0; i < frames.length; i++) {
                if (frames[i].timestamp <= targetMicros) {
                    idx = i;
                } else {
                    break;
                }
            }
            return idx;
        }

        let idx = frames.length - 1;
        for (let i = frames.length - 1; i >= 0; i--) {
            if (frames[i].timestamp >= targetMicros) {
                idx = i;
            } else {
                break;
            }
        }
        return idx;
    }

    /**
     * Runs one pass of the two-tier cache algorithm centered on a media
     * time: computes the shared protected floor and direction-weighted
     * opportunistic order once, then applies each tier's own budget/reach
     * independently (see cache-window.js's module doc for why the math is
     * shared but the application is not).
     *
     * @param {number} centerTime - Media time to center the pass on, in seconds.
     * @param {Object} options
     * @param {boolean} options.symmetric - True while paused: no directional skew, no |playbackRate| scaling.
     * @returns {void}
     */
    _runCachePass(centerTime, { symmetric }) {
        const totalSegments = this.segmentIndex.segments.length;
        const centerSegment = findSegmentForTime(this.segmentIndex, centerTime);
        const directionSign = this._lastDirectionSign;
        const skewRatio = symmetric ? PAUSED_SKEW_RATIO : DIRECTIONAL_SKEW_RATIO;
        const scaleFactor = symmetric ? 1 : Math.max(1, Math.abs(this.playbackRate));

        const protectedIndices = computeProtectedFloor(centerSegment.index, totalSegments, this._protectedFloorRadius);

        // Tier 2 (decode): a bounded window, skewed and rate-scaled.
        const tier2PreferredCount = Math.round(this._tier2OpportunisticBase * skewRatio * scaleFactor);
        const tier2OtherCount = Math.round(this._tier2OpportunisticBase * scaleFactor);
        const tier2Order = computeOpportunisticOrder(
            centerSegment.index,
            totalSegments,
            protectedIndices,
            directionSign,
            skewRatio,
            tier2PreferredCount,
            tier2OtherCount,
        );
        this._runTier2DecodePass(protectedIndices, tier2Order);

        // Tier 1 (raw fetch): unbounded reach -- the skew only orders
        // fetch priority; a per-pass pacing cap (itself rate-scaled)
        // limits how many NEW fetches this one pass launches.
        const tier1Order = computeOpportunisticOrder(
            centerSegment.index,
            totalSegments,
            protectedIndices,
            directionSign,
            skewRatio,
            Infinity,
            Infinity,
        );
        const tier1PacingCap = Math.round(TIER1_BASE_PACING_PER_PASS * scaleFactor);
        this._runTier1FetchPass(protectedIndices, tier1Order, tier1PacingCap);
    }

    /**
     * Tier 2's half of the cache pass: pins the protected floor against
     * eviction and ensures it (plus as much of the opportunistic window
     * as the decode budget allows) is decoded -- but only for segments
     * Tier 1 already has raw bytes for; this never triggers a fetch.
     *
     * @param {number[]} protectedIndices - This pass's protected-floor segment indices.
     * @param {number[]} opportunisticOrder - This pass's Tier 2 opportunistic candidates, nearest/most-preferred first.
     * @returns {void}
     */
    _runTier2DecodePass(protectedIndices, opportunisticOrder) {
        this.frameStore.setPinned(protectedIndices);

        const maxDecodedBudget = Number.isFinite(this.frameStore.maxSegmentsBuffered)
            ? this.frameStore.maxSegmentsBuffered
            : Number.MAX_SAFE_INTEGER;
        const surplusBudget = Math.max(0, maxDecodedBudget - protectedIndices.length);

        const ensureList = [...protectedIndices, ...opportunisticOrder.slice(0, surplusBudget)];

        // The same ordering that decides what to decode also decides what
        // to keep: without this the cache evicted by decode-completion age,
        // which systematically discarded the playhead's own neighbourhood
        // (decoded earliest) in favour of whatever prefetch decoded last.
        // Ranked over the full window, not just what this pass decodes, so
        // already-decoded distant units keep their correct ranking even
        // while opportunistic decoding is held back above.
        this.frameStore.setEvictionPriority([...protectedIndices, ...opportunisticOrder.slice(0, surplusBudget)]);

        for (const index of ensureList) {
            if (this.frameStore.has(index) || this.frameStore.isDecodeInBackoff(index)) {
                continue;
            }
            // A segment can only be decoded once Tier 1 already has its
            // raw bytes -- applies uniformly here, to protected-floor and
            // opportunistic candidates alike (see frame-store.js's module doc).
            if (!this.frameStore.segmentFetcher.hasRawBytes(index)) {
                continue;
            }
            this.frameStore.ensureDecoded(index).catch(() => {});
        }
    }

    /**
     * Tier 1's half of the cache pass: protects the floor from raw-byte
     * eviction and fetches it unconditionally, then launches a small,
     * paced batch of new fetches for the highest-priority opportunistic
     * candidates -- repeated passes keep advancing this frontier, with no
     * fixed outer edge, until the raw-byte budget is full or the whole
     * stream is cached.
     *
     * @param {number[]} protectedIndices - This pass's protected-floor segment indices.
     * @param {number[]} opportunisticOrder - Every not-yet-considered segment in priority order (unbounded reach).
     * @param {number} pacingCap - Max new fetches this pass may launch beyond the protected floor.
     * @returns {void}
     */
    /**
     * Whether the live session serving `index` already has its full
     * allowance of fetches in flight.
     *
     * Falls back to the global in-flight count for a fetcher that does not
     * report per-session counts (the abstraction only matters for a source
     * with multiple live producers).
     *
     * @param {Object} fetcher - The SegmentFetcher (Tier 1).
     * @param {number} index - Segment index whose session to check.
     * @returns {boolean} True if that session has no free fetch slot.
     */
    _sessionFetchSlotsFull(fetcher, index) {
        const inFlight = fetcher.getInFlightFetchCountForSession
            ? fetcher.getInFlightFetchCountForSession(index)
            : fetcher.getInFlightFetchCount();
        return inFlight >= this._maxConcurrentTier1Fetches;
    }

    _runTier1FetchPass(protectedIndices, opportunisticOrder, pacingCap) {
        const fetcher = this.frameStore.segmentFetcher;
        fetcher.setProtectedRawSegments(protectedIndices);

        for (const index of protectedIndices) {
            // The concurrency ceiling applies here too, not just to the
            // opportunistic loop below. A source backed by a single
            // sequential transcoder (Jellyfin) answers one request at a
            // time; firing the whole floor at it concurrently made those
            // requests race each other's transcoder restarts, which is
            // what produced the transient 500s seen live. Confirmed
            // against the real server: a lone backward or far-forward
            // request never fails, it just costs a restart (~2-3s, with
            // the NEXT request paying up to ~15s) -- only concurrent ones
            // fail.
            if (this._sessionFetchSlotsFull(fetcher, index)) {
                continue;
            }
            // hasInFlightFetch() skip: this pass runs on every render
            // tick (dozens of times a second) -- without it, a segment
            // whose real fetch is still pending gets a harmless-but-
            // wasteful repeat ensureRawBytes() call on every single tick
            // until it resolves.
            if (!fetcher.hasRawBytes(index) && !fetcher.isFetchInBackoff(index) && !fetcher.hasInFlightFetch(index)) {
                fetcher.ensureRawBytes(index).catch(() => {});
            }
        }

        // Whether each side of the playhead has hit something it cannot
        // fetch yet. Once a side is blocked, this pass stops considering
        // candidates further out on that side instead of stepping over
        // them -- see the comment on the `blocked` assignment below.
        const centerIndex = this.currentSegmentIndex;
        let forwardBlocked = false;
        let backwardBlocked = false;

        let launched = 0;
        for (const index of opportunisticOrder) {
            if (launched >= pacingCap || (forwardBlocked && backwardBlocked)) {
                break;
            }
            const isForwardSide = index > centerIndex;

            // Concurrency ceiling: an unbounded background frontier must
            // not accumulate more simultaneously in-flight fetches than
            // this source can actually tolerate -- see
            // DEFAULT_MAX_CONCURRENT_TIER1_FETCHES's own doc comment for
            // why. Applied per live session rather than globally: requests
            // only race a transcoder restart against each other within one
            // session, and counting globally would split a single slot
            // across the forward and behind sessions instead of letting
            // each run one fetch of its own.
            if (this._sessionFetchSlotsFull(fetcher, index)) {
                if (isForwardSide) {
                    forwardBlocked = true;
                } else {
                    backwardBlocked = true;
                }
                continue;
            }
            if (isForwardSide ? forwardBlocked : backwardBlocked) {
                continue;
            }

            // Already handled: cached needs nothing, in-flight is already
            // being fetched. Step over these -- they do not block the
            // frontier, they ARE the frontier advancing.
            if (fetcher.hasRawBytes(index) || fetcher.hasInFlightFetch(index)) {
                continue;
            }

            // Genuinely unavailable right now: recently failed, or no live
            // session can serve it without seeking its own transcode
            // backward. Block this side rather than stepping outward past
            // it. Stepping outward is what starved the playhead: with only
            // one fetch slot against Jellyfin, the scan walked past
            // backed-off near segments and spent the slot on distant ones
            // that were already transcoded to disk (confirmed live at
            // ~59ms each), so far islands filled while the island around
            // the playhead stayed empty. Waiting is the intended
            // behaviour -- backoff is short, and the pass reruns every
            // tick, so the frontier resumes the moment the near segment
            // is fetchable again.
            if (fetcher.isFetchInBackoff(index) || fetcher.isBehindCoverageGap(index)) {
                if (isForwardSide) {
                    forwardBlocked = true;
                } else {
                    backwardBlocked = true;
                }
                continue;
            }

            fetcher.ensureRawBytes(index).catch(() => {});
            launched++;
        }
    }

    /**
     * Handles a currentTime write -- shared by frame-step key nudges and
     * slider commit-on-release seeks alike (see the module doc comment).
     *
     * @async
     * @param {number} targetTimeSeconds - Requested time, in seconds (clamped to [0, duration]).
     * @returns {Promise<void>}
     */
    async seek(targetTimeSeconds) {
        const clamped = Math.max(0, Math.min(this.duration, targetTimeSeconds));
        const seekToken = ++this._seekGeneration;

        // Stop paused filling while we pivot to a new seek target.
        // Otherwise it can keep touching the old neighborhood mid-seek.
        this._stopPausedFillWorker();

        this.seekingFlag = true;
        this._syncAudio();

        const direction = clamped >= this.currentTime ? 'atOrBefore' : 'atOrAfter';
        const segment = findSegmentForTime(this.segmentIndex, clamped);
        const fetcher = this.frameStore.segmentFetcher;

        // Moves the dual-session forward/behind boundary to this seek's
        // target before any fetch (including this seek's own target-segment
        // fetch below) can be issued -- see SegmentFetcher#setAnchorSegmentIndex.
        fetcher.setAnchorSegmentIndex(segment.index);

        // Carries the resolved target so a listener (e.g. the test
        // harness's log panel) can tell where a seek is headed without
        // waiting for it to land -- useful for telling "still in flight"
        // apart from "landed somewhere unexpected" during a slow cold fetch.
        this.emit('seeking', { targetTime: clamped, segmentIndex: segment.index });

        if (!this.frameStore.has(segment.index)) {
            // A cold seek can be genuinely slow -- signal the same
            // buffering state a mid-playback stall would.
            this._updateBufferState(this._computeBufferReason(segment.index));
        }

        // Register THIS seek's want before releasing the PREVIOUS seek's
        // want -- not the other way around. If both target the same
        // segment (very likely during a real drag, since many pointermove
        // events land within the same ~1-3s segment), releasing the old
        // want first would drop that shared entry's wanter count to zero
        // and cancel its fetch right as this seek was about to depend on
        // it -- confirmed live: this caused spurious "error" events during
        // ordinary drags, since the fetch this seek needed got aborted out
        // from under it by its own predecessor. The IIFE below calls
        // ensureRawBytes() synchronously (no await before it), so starting
        // it first and aborting the previous controller immediately after,
        // still in the same synchronous tick, guarantees the new want is
        // already counted before the old one can zero it out.
        if (!fetcher.hasRawBytes(segment.index)) {
            // A cold seek target must not have to race the browser's own
            // per-origin connection limit against a pile of already-in-
            // flight, lower-priority background-prefetch fetches that
            // simply got there first (confirmed live: a seek's own fetch
            // can otherwise finish LAST in a batch of 6+ concurrent
            // requests, purely by chance of byte size/network timing).
            // Preempting them gives this fetch the whole pool to itself;
            // a later cache pass will naturally re-request whichever of
            // them are still relevant once things settle.
            fetcher.preemptInFlightFetches([segment.index]);
        }

        const seekFetchAbort = new AbortController();
        const previousSeekFetchAbort = this._seekFetchAbort;
        this._seekFetchAbort = seekFetchAbort;

        const ensurePromise = (async () => {
            await fetcher.ensureRawBytes(segment.index, { signal: seekFetchAbort.signal });
            return this.frameStore.ensureDecoded(segment.index);
        })();

        if (previousSeekFetchAbort) {
            previousSeekFetchAbort.abort();
        }

        let decodedBuffer;
        try {
            decodedBuffer = await ensurePromise;
        } catch (err) {
            if (seekFetchAbort.signal.aborted) {
                // Superseded by a newer seek before this one's fetch
                // finished -- abandon silently (this is not a real
                // failure), but still surface it on the debug channel so
                // "the seek I asked for never visibly landed" is
                // distinguishable from "it's just still fetching."
                this.emit('debug', { message: `seek to ${clamped.toFixed(3)}s (segment ${segment.index}) superseded before its fetch finished` });
                return;
            }
            // A real (non-abort) failure must not leave the buffering
            // signal stuck on -- the shim's currentTime setter surfaces
            // this via the 'error' event instead.
            this._updateBufferState(null);
            throw err;
        }

        if (seekToken !== this._seekGeneration) {
            // A newer seek was requested while this one was awaiting decode
            // -- abandon this now-stale result rather than overwriting the
            // newer seek's (possibly already-applied) state.
            this.emit('debug', { message: `seek to ${clamped.toFixed(3)}s (segment ${segment.index}) superseded after decode, before applying` });
            return;
        }

        // Use the buffer this seek actually decoded rather than re-reading
        // the cache: the cache can legitimately drop it in between (its
        // eviction ranking still reflects the PRE-seek playhead until the
        // next cache pass, so a distant seek target ranks last), and
        // re-reading turned that into a crash on an undefined buffer.
        const gopBuffer = decodedBuffer || this.frameStore.buffers.get(segment.index);
        const frameIdx = this._locateFrameIndex(gopBuffer, clamped, direction, segment.startTime);
        const frame = gopBuffer.frames[frameIdx];

        // Bookkeeping must land BEFORE render(): render() dispatches the
        // requestVideoFrameCallback listeners synchronously, and they read
        // currentTime/currentSegmentIndex/currentFrameIdx -- update after,
        // and every listener sees the pre-seek position (a scrub bar built
        // on it snaps back to where the seek started).
        this.currentSegmentIndex = segment.index;
        this.currentFrameIdx = frameIdx;
        this._presentedMediaTime = this._frameTimestampToMediaTimeSeconds(segment.index, frame.timestamp);

        this.canvasRenderer.render(frame);
        this._updateBufferState(null);

        // Re-anchor so continued playback (if active) resumes from here.
        this._anchorWallClockMs = performance.now();
        this._anchorTime = this.currentTime;

        if (!this.playing) {
            this._pausedFreezeTime = this._presentedMediaTime;
            this._runCachePass(this.currentTime, { symmetric: true });
            this._startPausedFillWorker();
        } else {
            this._pausedFreezeTime = null;
            this._runCachePass(this.currentTime, { symmetric: false });
        }

        this.seekingFlag = false;
        this._syncAudio();

        // Carries exactly where this seek actually landed -- the target
        // time requested can differ from the presented time (frame
        // granularity, direction rounding), which is exactly the kind of
        // mismatch this detail exists to make visible without guessing.
        this.emit('seeked', {
            targetTime: clamped,
            currentTime: this.currentTime,
            segmentIndex: this.currentSegmentIndex,
            frameIndex: this.currentFrameIdx,
        });
    }

    /**
     * Stops playback and tears down both cache tiers. Called when the
     * engine is torn down (including a reload replacing this engine with
     * a new one) -- without this, the old FrameStore's decoder and the
     * old SegmentFetcher's in-flight requests keep running in the
     * background, competing with the new engine for decode throughput
     * and network/connection-pool capacity.
     *
     * Deliberately does not call `pause()` here: `pause()` unconditionally
     * restarts the paused fill worker after running one more cache pass,
     * which would immediately undo `_stopPausedFillWorker()` below and
     * leave that 500ms interval (and its repeated `ensureDecoded`/fetch
     * calls against an already-closed decoder/aborted fetcher) running
     * forever, since nothing would ever stop it again.
     *
     * @returns {void}
     */
    close() {
        this.playing = false;
        if (this._rafHandle !== null) {
            cancelAnimationFrame(this._rafHandle);
            this._rafHandle = null;
        }
        this._stopPausedFillWorker();
        if (this.audioOutput) {
            this.audioOutput.close();
            this.audioOutput = null;
        }
        this.frameStore.segmentFetcher.preemptInFlightFetches([]);
        this.frameStore.close();
    }
}
