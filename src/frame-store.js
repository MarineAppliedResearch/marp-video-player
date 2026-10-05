/**
 * Tier 2 of the two-tier cache: a segment-granularity decoded-frame LRU,
 * plus the decode orchestration needed to fill it.
 *
 * Tier 2 never fetches raw bytes itself -- it only decodes a segment once
 * Tier 1 (segment-fetcher.js) already has that segment's raw bytes
 * cached. Nor does it demux: chunks come from the media source, which
 * knows how its own container works (see
 * media-source-jellyfin-transcode.js, which also owns the
 * keyframe-continuity fallback that needs the preceding unit's bytes).
 *
 * Partial-GOP retention is pointless: decode is always forward-from-
 * keyframe, so evicting part of a segment's frames still requires a full
 * re-decode of that segment to get any of them back. Eviction therefore
 * always drops one whole segment's GopBuffer at a time, explicitly
 * close()-ing every VideoFrame it held (WebCodecs frames hold external
 * memory that ordinary GC won't reclaim promptly).
 *
 * @fileoverview Segment-granularity decoded-frame LRU cache and its decode orchestration.
 * @author Isaac Travers
 * @module video-engine/frame-store
 */

import { segmentShiftSeconds, isShifted, unitForTimestamp, unitCoverage, segmentHolding, segmentAfter } from './unit-assembly.js';

/**
 * How many segments one unit's assembly may fetch and decode before it gives up. A job
 * shifted by under a GOP needs its own segment plus two more; the rest is room for a gap
 * left between two Jellyfin jobs' segments, each fetched again once.
 */
const MAX_ASSEMBLY_SEGMENTS = 10;

/**
 * How many units may hold frames while still incomplete, besides the one being built. A
 * shifted job's segment feeds two units, so one neighbour on each side is all normal
 * playback needs; beyond that the farthest is closed rather than left to grow.
 */
const MAX_PARTIAL_UNITS = 2;

/** Uncompressed 8-bit 4:2:0: full-res Y plane plus quarter-res U/V planes. */
const BYTES_PER_PIXEL_420_8BIT = 1.5;

/**
 * Default decoded-frame cache budget: 5 GiB.
 *
 * Raised from 3 GiB once Direct Play made ~10s GOPs the common unit: at
 * 1080p one holds ~742MB decoded, so 3 GiB left room for only four units
 * (~40s of video) and very little slack around the playhead. 5 GiB holds
 * about seven, and was confirmed to play smoothly forward on real hardware.
 */
const DEFAULT_CACHE_BUDGET_BYTES = 5 * 1024 * 1024 * 1024;

/** Floor on buffered segments: current + one prefetch each direction. */
const MIN_SEGMENTS_BUFFERED = 3;

/** Backoff delay before the first automatic retry of a decode that just failed, in ms. */
const INITIAL_DECODE_RETRY_BACKOFF_MS = 200;

/** Ceiling on decode backoff delay, however many consecutive failures a segment has had, in ms. */
const MAX_DECODE_RETRY_BACKOFF_MS = 8000;

/** Decode backoff grows by this factor after each consecutive failure, until MAX_DECODE_RETRY_BACKOFF_MS. */
const DECODE_RETRY_BACKOFF_MULTIPLIER = 2;

/**
 * Caches decoded segments (GopBuffers) with LRU eviction, and knows how
 * to produce one on demand from already-fetched raw bytes.
 *
 * @class FrameStore
 */
export class FrameStore {
    /**
     * @param {Object} params
     * @param {Object} params.segmentFetcher - {@link module:video-engine/segment-fetcher.SegmentFetcher} instance (Tier 1).
     * @param {Object} params.mediaSource - Media source supplying decoder chunks for a unit, e.g. {@link module:video-engine/media-source-jellyfin-transcode.JellyfinTranscodeMediaSource}.
     * @param {Object} params.gopDecoder - {@link module:video-engine/gop-decoder.GopDecoder} instance.
     * @param {number} params.width - Real negotiated video width, used to size the cache budget.
     * @param {number} params.height - Real negotiated video height, used to size the cache budget.
     * @param {number} params.fps - Real negotiated frame rate, used to size the cache budget.
     * @param {number} params.segmentDuration - Nominal segment duration in seconds.
     * @param {number} [params.cacheBudgetBytes] - Decoded-frame cache budget in bytes. Default 3 GiB.
     * @param {function(string): void} [params.onDebug] - Called with the same decode progress messages this class already logs to the console -- lets a consumer (e.g. the test harness's on-page log panel) surface them without needing DevTools open.
     * @param {function(Error): void} [params.onError] - Called exactly once per real (non-cancelled) segment decode failure, regardless of how many callers share the same in-flight request.
     */
    constructor({ segmentFetcher, mediaSource, gopDecoder, width, height, fps, segmentDuration, cacheBudgetBytes, onDebug, onError }) {
        this.segmentFetcher = segmentFetcher;
        this.mediaSource = mediaSource;
        this.gopDecoder = gopDecoder;
        this.onDebug = onDebug;
        this.onError = onError;

        this._width = width;
        this._height = height;
        this._fps = fps;
        this._segmentDuration = segmentDuration;
        this._cacheBudgetBytes = cacheBudgetBytes || DEFAULT_CACHE_BUDGET_BYTES;

        this.maxSegmentsBuffered = this._computeMaxSegmentsBuffered(this._cacheBudgetBytes);

        // segmentIndex -> GopBuffer. Insertion order is only the tie-break
        // for eviction; the real ordering comes from _evictionPriority below.
        this.buffers = new Map();
        this.pinned = new Set();

        // segmentIndex -> rank (0 = most valuable), set each cache pass by
        // the scheduler. Insertion order alone is the WRONG eviction order
        // for this cache: segments around the playhead are decoded earliest
        // (as the playhead approaches them), which made them the oldest
        // entries and the first evicted, while segments far ahead that
        // prefetch had just decoded survived as the newest. Observed live
        // as the playhead's own decoded island being the smallest of five
        // disjoint islands, with its members evicted and immediately
        // re-decoded on the following pass -- pure thrash that kept the
        // cache pegged at its budget while never growing where it mattered.
        this._evictionPriority = null;
        this._inFlightDecodes = new Map(); // segmentIndex -> Promise

        // Track recent real decode failures per segment.
        // Automatic lookahead respects this backoff window.
        // Explicit seek() still bypasses it on purpose.
        this._decodeBackoff = new Map();

        // Only for a source whose segments can hold another unit's time (a cold-started
        // Jellyfin transcode): unit -> (frame timestamp -> VideoFrame) for units that
        // have some of their frames but not all, and the shift of the job last seen.
        this._partials = new Map();
        this._lastShiftSeconds = 0;
        this._unitIndex = null;

        // What the last segment decoded for assembly actually held, which predicts where
        // the next moment is better than a shift does (see segmentAfter).
        this._lastDecoded = null;

        // Shifted units are built one at a time: each walks one Jellyfin job forward, and
        // two walks on one session would restart each other's job.
        this._assemblyQueue = Promise.resolve();

        // Segments whose frames have been filed by their own time, so building a unit
        // does not decode its own segment again when that segment was already decoded
        // and its frames went to other units.
        this._filedSegments = new Set();
    }

    /**
     * Takes a segment decoded elsewhere -- the engine's opening unit -- into the cache.
     *
     * Exactly as before, it becomes that unit's buffer, unless the source's segments can
     * hold another unit's time and this one does: then its frames are filed under the
     * units they belong to, and the unit is built from its own frames when asked for.
     *
     * @param {number} segmentIndexNumber - The segment it was decoded as.
     * @param {Object} gopBuffer - Its GopBuffer.
     * @returns {void}
     */
    adoptDecoded(segmentIndexNumber, gopBuffer) {
        if (!this.mediaSource.unitsMayArriveShifted || gopBuffer.frames.length === 0) {
            this.buffers.set(segmentIndexNumber, gopBuffer);
            return;
        }
        if (!this._unitIndex) {
            this._unitIndex = this.mediaSource.getUnitIndex();
        }
        const shift = segmentShiftSeconds(this._unitIndex.segments[segmentIndexNumber], gopBuffer.frames[0].timestamp);
        if (!isShifted(shift, 1 / this._fps)) {
            this.buffers.set(segmentIndexNumber, gopBuffer);
            return;
        }
        this._lastShiftSeconds = shift;
        this._lastDecoded = this._heldBy(segmentIndexNumber, gopBuffer.frames);
        this._logDebug(`segment ${segmentIndexNumber}: its frames start ${shift.toFixed(3)}s before its label; filing them by their own time`);
        this._file(gopBuffer.frames, this._unitIndex, segmentIndexNumber);
        this._filedSegments.add(segmentIndexNumber);
    }

    /**
     * Computes decoded-segment capacity from a byte budget.
     *
     * @param {number} budgetBytes - Decoded-frame budget in bytes.
     * @returns {number} Max decoded segments retained.
     */
    _computeMaxSegmentsBuffered(budgetBytes) {
        const bytesPerFrame = this._width * this._height * BYTES_PER_PIXEL_420_8BIT;
        const framesPerSegment = Math.ceil(this._segmentDuration * this._fps);
        const bytesPerSegment = bytesPerFrame * framesPerSegment;
        return Math.max(MIN_SEGMENTS_BUFFERED, Math.floor(budgetBytes / bytesPerSegment));
    }

    /**
     * Returns current decoded-cache configuration/state.
     *
     * @returns {{cacheBudgetBytes: number, maxSegmentsBuffered: number, cachedDecodedSegments: number}} Cache config/state snapshot.
     */
    getDecodedCacheConfig() {
        return {
            cacheBudgetBytes: this._cacheBudgetBytes,
            maxSegmentsBuffered: this.maxSegmentsBuffered,
            cachedDecodedSegments: this.buffers.size,
        };
    }

    /**
     * Updates decoded-frame cache budget at runtime and evicts oldest
     * unpinned decoded segments immediately when shrinking.
     *
     * @param {number} budgetBytes - New decoded-frame budget in bytes.
     * @returns {{cacheBudgetBytes: number, maxSegmentsBuffered: number, cachedDecodedSegments: number}} Updated cache config/state snapshot.
     */
    setDecodedCacheBudgetBytes(budgetBytes) {
        if (!Number.isFinite(budgetBytes) || budgetBytes <= 0) {
            throw new Error(`Invalid decoded cache budget: ${budgetBytes}`);
        }

        // Store the new byte budget first.
        // Then recompute how many whole decoded segments fit in it.
        this._cacheBudgetBytes = Math.floor(budgetBytes);
        this.maxSegmentsBuffered = this._computeMaxSegmentsBuffered(this._cacheBudgetBytes);

        // Shrinks should evict immediately.
        // Grows simply leave more headroom for future decodes.
        this._evictIfNeeded();
        return this.getDecodedCacheConfig();
    }

    /**
     * Marks segments the scheduler's protected floor needs as exempt from
     * eviction. Opportunistic (non-floor) segments remain evictable.
     *
     * @param {Iterable<number>} indices - Segment indices to pin.
     * @returns {void}
     */
    setPinned(indices) {
        this.pinned = new Set(indices);
    }

    /**
     * Sets the eviction ordering for the current playhead position: the
     * segment indices worth keeping, most valuable first. Eviction drops
     * whatever ranks lowest, so the decoded cache fills with one growing
     * island around the playhead (skewed toward the direction of travel,
     * since that is how the caller orders it) rather than scattered
     * islands left behind wherever prefetch happened to reach.
     *
     * Segments absent from this list rank below every listed one -- they
     * are outside the window entirely and are evicted first, oldest-
     * inserted among them going first.
     *
     * @param {Iterable<number>} orderedIndices - Segment indices in descending value, e.g. the scheduler's protected floor followed by its direction-skewed opportunistic order.
     * @returns {void}
     */
    setEvictionPriority(orderedIndices) {
        const priority = new Map();
        let rank = 0;
        for (const index of orderedIndices) {
            if (!priority.has(index)) {
                priority.set(index, rank++);
            }
        }
        this._evictionPriority = priority;
    }

    /**
     * Reports whether a segment is already decoded and cached.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {boolean} True if cached.
     */
    has(segmentIndexNumber) {
        return this.buffers.has(segmentIndexNumber);
    }

    /**
     * Logs a decode progress or failure message to the console and, if
     * supplied, to the `onDebug` callback -- the latter lets a consumer
     * (e.g. the test harness's on-page log panel) see exactly which
     * segment is being decoded/failed without needing DevTools open.
     *
     * @param {string} message - Message text, without the "[frame-store]" prefix (added here).
     * @returns {void}
     */
    _logDebug(message) {
        const prefixed = `[frame-store] ${message}`;
        console.log(prefixed);
        if (this.onDebug) {
            this.onDebug(prefixed);
        }
    }

    /**
     * Reports whether a segment's decode failed recently enough that
     * automatic (opportunistic) callers should skip it until its backoff
     * window elapses -- a deliberate seek() is NOT gated by this.
     *
     * @param {number} segmentIndexNumber - Segment index to check.
     * @returns {boolean} True if a recent failure's backoff window hasn't elapsed yet.
     */
    isDecodeInBackoff(segmentIndexNumber) {
        const backoff = this._decodeBackoff.get(segmentIndexNumber);
        return !!backoff && Date.now() < backoff.nextAttemptAtMs;
    }

    /**
     * Records a segment's decode outcome for backoff purposes: a real
     * failure grows that segment's backoff delay (exponentially, up to
     * MAX_DECODE_RETRY_BACKOFF_MS); a success clears it entirely. A
     * cancellation is deliberately NOT treated as a failure.
     *
     * @param {number} segmentIndexNumber - Segment index the outcome applies to.
     * @param {(Error|null)} err - The rejection reason, or null on success.
     * @returns {void}
     */
    _recordDecodeOutcome(segmentIndexNumber, err) {
        if (!err) {
            this._decodeBackoff.delete(segmentIndexNumber);
            return;
        }
        if (err.name === 'AbortError') {
            return;
        }

        const previous = this._decodeBackoff.get(segmentIndexNumber);
        const delayMs = previous
            ? Math.min(MAX_DECODE_RETRY_BACKOFF_MS, previous.delayMs * DECODE_RETRY_BACKOFF_MULTIPLIER)
            : INITIAL_DECODE_RETRY_BACKOFF_MS;
        this._decodeBackoff.set(segmentIndexNumber, { nextAttemptAtMs: Date.now() + delayMs, delayMs });

        // Reported from here, exactly once per real failure, rather than
        // by each caller wrapping its own ensureDecoded() call in a
        // .catch() -- see SegmentFetcher._recordFetchOutcome()'s identical
        // reasoning: many callers can share one in-flight decode, and
        // per-caller reporting used to fire once per caller.
        if (this.onError) {
            this.onError(err);
        }
    }

    /**
     * Ensures a segment's frames are decoded and cached, decoding it (via
     * demux + GopDecoder) if not already present. Concurrent calls for the
     * same segment share one in-flight promise rather than duplicating
     * decode work.
     *
     * Requires the segment's raw bytes to already be present in Tier 1
     * (segmentFetcher.hasRawBytes()) -- this method never fetches them.
     * Callers driving opportunistic decode must check that themselves
     * before calling; this only asserts it, since a caller racing a
     * concurrent eviction of its own raw bytes is otherwise possible.
     *
     * @async
     * @param {number} segmentIndexNumber - Segment index to ensure decoded.
     * @returns {Promise<Object>} The segment's GopBuffer.
     * @throws {Error} When the segment's raw bytes are not yet fetched.
     */
    async ensureDecoded(segmentIndexNumber) {
        if (this.buffers.has(segmentIndexNumber)) {
            this._touch(segmentIndexNumber);
            return this.buffers.get(segmentIndexNumber);
        }

        if (!this.segmentFetcher.hasRawBytes(segmentIndexNumber)) {
            throw new Error(`Cannot decode segment ${segmentIndexNumber}: raw bytes not yet fetched`);
        }

        let promise = this._inFlightDecodes.get(segmentIndexNumber);
        if (!promise) {
            promise = this._decode(segmentIndexNumber)
                .then(
                    (result) => {
                        this._recordDecodeOutcome(segmentIndexNumber, null);
                        return result;
                    },
                    (err) => {
                        this._recordDecodeOutcome(segmentIndexNumber, err);
                        this._logDebug(`segment ${segmentIndexNumber}: FAILED -- ${err.message}`);
                        throw err;
                    },
                )
                .finally(() => {
                    this._inFlightDecodes.delete(segmentIndexNumber);
                });
            this._inFlightDecodes.set(segmentIndexNumber, promise);
        }

        return promise;
    }

    /**
     * Demuxes and decodes one segment from its already-fetched raw bytes,
     * with a defensive keyframe-merge fallback if Jellyfin's
     * keyframe-alignment guarantee is ever violated in practice.
     *
     * @async
     * @param {number} segmentIndexNumber - Segment index to decode.
     * @returns {Promise<Object>} The segment's GopBuffer.
     * @throws {Error} When segment 0 itself doesn't start with a keyframe (unrecoverable).
     */
    async _decode(segmentIndexNumber) {
        if (this.mediaSource.unitsMayArriveShifted) {
            return this._assemble(segmentIndexNumber);
        }

        // Decode in progress is otherwise invisible from the outside -- a
        // real decode taking a while and a genuine stall both just look
        // like nothing is happening. Logging start and completion here
        // gives an at-a-glance answer to "is it still working" without
        // needing a debugger or guesswork.
        this._logDebug(`segment ${segmentIndexNumber}: demuxing + decoding...`);

        // How the bytes become chunks is the source's business: HLS demuxes
        // init+media, a byte-range source slices its own sample table. The
        // source may prepend a previous unit's chunks for decode continuity,
        // which is why it also reports this unit's own first timestamp.
        const { unitFirstTimestampMicros, ...demuxResult } = await this.mediaSource.fetchChunks(segmentIndexNumber);

        const gopBuffer = await this.gopDecoder.decodeSegment(segmentIndexNumber, demuxResult);

        // The previous segment's chunks may be merged in only to satisfy
        // decode continuity.
        // They must not stay cached as part of THIS segment's frame list.
        // Otherwise scheduler time mapping anchors to the wrong frame.
        // That can make visible frames disagree with currentTime.
        if (unitFirstTimestampMicros !== null) {
            gopBuffer.frames = gopBuffer.frames.filter((frame) => frame.timestamp >= unitFirstTimestampMicros);
        }

        this._logDebug(`segment ${segmentIndexNumber}: ready (${gopBuffer.frames.length} frames)`);

        this.buffers.set(segmentIndexNumber, gopBuffer);
        this._touch(segmentIndexNumber);
        this._evictIfNeeded(segmentIndexNumber);

        return gopBuffer;
    }

    /**
     * Builds one unit from the decoded frames whose own timestamps fall inside it.
     *
     * For a source whose segments can hold another unit's time: a Jellyfin transcode
     * started partway into a file begins at the keyframe before the requested segment and
     * keeps the requested labels, so segment N can hold frames from seconds earlier (see
     * unit-assembly.js). Each segment fetched is decoded once and its frames are filed
     * under the units they belong to; this unit is handed back once its frames cover it.
     * A segment that already holds its own time is used exactly as the ordinary path uses
     * it.
     *
     * @async
     * @param {number} unitIndexNumber - The unit to build.
     * @returns {Promise<Object>} The unit's GopBuffer.
     * @throws {Error} When the unit cannot be covered within MAX_ASSEMBLY_SEGMENTS.
     */
    _assemble(unitIndexNumber) {
        const run = this._assemblyQueue.then(() => this._assembleNow(unitIndexNumber));
        this._assemblyQueue = run.then(() => undefined, () => undefined);
        return run;
    }

    /**
     * The body of {@link FrameStore#_assemble}, run one unit at a time.
     *
     * @async
     * @param {number} unitIndexNumber - The unit to build.
     * @returns {Promise<Object>} The unit's GopBuffer.
     */
    async _assembleNow(unitIndexNumber) {
        if (this.buffers.has(unitIndexNumber)) {
            return this.buffers.get(unitIndexNumber);
        }
        let walking = false;
        try {
            return await this._assembleWalking(unitIndexNumber, () => {
                if (!walking && this.mediaSource.beginAssembly) {
                    walking = true;
                    this.mediaSource.beginAssembly(unitIndexNumber);
                }
            });
        } finally {
            if (walking && this.mediaSource.endAssembly) {
                this.mediaSource.endAssembly();
            }
        }
    }

    /**
     * Builds a unit, calling `startWalk` the first time a segment other than its own is
     * needed -- an unshifted unit never walks, so ordinary playback is never held.
     *
     * @async
     * @param {number} unitIndexNumber - The unit to build.
     * @param {function(): void} startWalk - Starts holding fetches that would restart the job.
     * @returns {Promise<Object>} The unit's GopBuffer.
     */
    async _assembleWalking(unitIndexNumber, startWalk) {
        if (!this._unitIndex) {
            this._unitIndex = this.mediaSource.getUnitIndex();
        }
        const unitIndex = this._unitIndex;
        const unit = unitIndex.segments[unitIndexNumber];
        const frameInterval = 1 / this._fps;
        const decodedHere = new Set();

        for (let attempt = 0; attempt < MAX_ASSEMBLY_SEGMENTS; attempt++) {
            const held = this._partials.get(unitIndexNumber);
            const coverage = held
                ? unitCoverage([...held.keys()].sort((a, b) => a - b), unit, frameInterval)
                : { complete: false, missingFromSeconds: unit.startTime };
            if (coverage.complete) {
                return this._promote(unitIndexNumber);
            }

            // Its own segment first. After that, the one the last job's shift says holds
            // the first missing moment -- fetched again if this assembly already decoded
            // it, because then the bytes cached for it came from another job.
            const ownFirst = decodedHere.size === 0 && !held && !this._filedSegments.has(unitIndexNumber);
            const missing = coverage.missingFromSeconds;
            // Earlier than anything the last job held: never a step backward inside a job
            // (Jellyfin restarts it there, at a keyframe that can still be after this
            // moment), but a fresh start at the segment whose own time holds the moment --
            // it begins at the keyframe before, at or before the moment -- walked forward.
            const behind = !ownFirst && this._lastDecoded && missing < this._lastDecoded.firstSeconds;
            const segmentNumber = ownFirst
                ? unitIndexNumber
                : behind
                    ? unitForTimestamp(unitIndex, Math.round(missing * 1e6))
                    : this._lastDecoded
                        ? segmentAfter(missing, this._lastDecoded, unitIndex.segments.length)
                        : segmentHolding(unitIndex, missing, this._lastShiftSeconds);
            const refetch = behind || decodedHere.has(segmentNumber);
            decodedHere.add(segmentNumber);
            if (!ownFirst) {
                startWalk();
            }

            this._logDebug(`unit ${unitIndexNumber}: decoding segment ${segmentNumber}${refetch ? ' again, fetched afresh' : ''}...`);
            const { unitFirstTimestampMicros, ...demuxResult } =
                await this.mediaSource.fetchSegmentChunks(segmentNumber, { refetch });
            const decoded = await this.gopDecoder.decodeSegment(segmentNumber, demuxResult);

            // Frames merged in only for decode continuity belong to the segment before,
            // exactly as on the ordinary path.
            let frames = decoded.frames;
            if (unitFirstTimestampMicros !== null) {
                for (const frame of frames) {
                    if (frame.timestamp < unitFirstTimestampMicros) frame.close();
                }
                frames = frames.filter((frame) => frame.timestamp >= unitFirstTimestampMicros);
            }
            if (frames.length === 0) {
                continue;
            }

            const shift = segmentShiftSeconds(unitIndex.segments[segmentNumber], frames[0].timestamp);
            this._lastShiftSeconds = isShifted(shift, frameInterval) ? shift : 0;
            this._lastDecoded = this._heldBy(segmentNumber, frames);

            if (segmentNumber === unitIndexNumber && !held && !isShifted(shift, frameInterval)) {
                // The segment holds its own time: today's path, one segment one unit.
                this._logDebug(`segment ${unitIndexNumber}: ready (${frames.length} frames)`);
                return this._store(unitIndexNumber, { segmentIndex: unitIndexNumber, frames });
            }

            this._logDebug(`segment ${segmentNumber}: its frames start ${shift.toFixed(3)}s before its label; filing them by their own time`);
            this._file(frames, unitIndex, unitIndexNumber);
            this._filedSegments.add(segmentNumber);
        }

        throw new Error(`Unit ${unitIndexNumber} could not be covered by its frames within ${MAX_ASSEMBLY_SEGMENTS} segments`);
    }

    /**
     * What a decoded segment held: its index, first frame's time, and the time after its last.
     *
     * @param {number} segmentNumber - The segment.
     * @param {Array<VideoFrame>} frames - Its decoded frames, ascending.
     * @returns {{segment: number, firstSeconds: number, endSeconds: number}}
     */
    _heldBy(segmentNumber, frames) {
        const lastFrameSeconds = frames[frames.length - 1].timestamp / 1e6;
        return {
            segment: segmentNumber,
            firstSeconds: frames[0].timestamp / 1e6,
            lastFrameSeconds,
            endSeconds: lastFrameSeconds + 1 / this._fps,
        };
    }

    /**
     * Files decoded frames under the units their own timestamps belong to.
     *
     * A frame for a unit already built, or already held, is a duplicate and is closed.
     *
     * @param {Array<VideoFrame>} frames - Decoded frames, ascending.
     * @param {{segments: Array<Object>}} unitIndex - The engine's unit index.
     * @param {number} buildingIndex - The unit being built, which is never dropped here.
     * @returns {void}
     */
    _file(frames, unitIndex, buildingIndex) {
        for (const frame of frames) {
            const owner = unitForTimestamp(unitIndex, frame.timestamp);
            if (this.buffers.has(owner)) {
                frame.close();
                continue;
            }
            let held = this._partials.get(owner);
            if (!held) {
                held = new Map();
                this._partials.set(owner, held);
            }
            if (held.has(frame.timestamp)) {
                frame.close();
            } else {
                held.set(frame.timestamp, frame);
            }
        }

        // Bounded: the partials farthest from the unit being built go first.
        while (this._partials.size > MAX_PARTIAL_UNITS + 1) {
            const farthest = [...this._partials.keys()]
                .filter((index) => index !== buildingIndex)
                .sort((a, b) => Math.abs(b - buildingIndex) - Math.abs(a - buildingIndex))[0];
            for (const frame of this._partials.get(farthest).values()) {
                frame.close();
            }
            this._partials.delete(farthest);
            this._logDebug(`unit ${farthest}: incomplete frames dropped`);
        }
    }

    /**
     * Turns a covered unit's held frames into its GopBuffer.
     *
     * @param {number} unitIndexNumber - The unit.
     * @returns {Object} The GopBuffer.
     */
    _promote(unitIndexNumber) {
        const held = this._partials.get(unitIndexNumber);
        this._partials.delete(unitIndexNumber);
        const frames = [...held.values()].sort((a, b) => a.timestamp - b.timestamp);
        this._logDebug(`segment ${unitIndexNumber}: ready (${frames.length} frames, filed by their own time)`);
        return this._store(unitIndexNumber, { segmentIndex: unitIndexNumber, frames });
    }

    /**
     * Caches a unit's GopBuffer, exactly as the ordinary decode path does.
     *
     * @param {number} unitIndexNumber - The unit.
     * @param {Object} gopBuffer - Its GopBuffer.
     * @returns {Object} The same GopBuffer.
     */
    _store(unitIndexNumber, gopBuffer) {
        this.buffers.set(unitIndexNumber, gopBuffer);
        this._touch(unitIndexNumber);
        this._evictIfNeeded(unitIndexNumber);
        return gopBuffer;
    }

    /**
     * Marks a cached GopBuffer as most-recently-used by re-inserting it.
     *
     * @param {number} segmentIndexNumber - Segment index to bump.
     * @returns {void}
     */
    _touch(segmentIndexNumber) {
        const buffer = this.buffers.get(segmentIndexNumber);
        this.buffers.delete(segmentIndexNumber);
        this.buffers.set(segmentIndexNumber, buffer);
    }

    /**
     * Evicts the lowest-priority unpinned GopBuffers until the cache is
     * back within `maxSegmentsBuffered`, closing every evicted VideoFrame.
     *
     * Priority comes from setEvictionPriority (distance from the playhead,
     * skewed toward the direction of travel); segments never given a rank
     * fall to the bottom. With no priority set at all this degrades to the
     * original insertion-order behaviour.
     *
     * @param {number} [justDecodedIndex] - A segment inserted by the caller right now, exempt from this pass. Its rank reflects wherever the playhead was when the current priority order was computed, which for a seek target is "nowhere near" -- so without this exemption a freshly decoded seek target is evicted inside its own insertion, before the seek can even read it, and the seek fails with an undefined buffer.
     * @returns {void}
     */
    _evictIfNeeded(justDecodedIndex) {
        if (this.buffers.size <= this.maxSegmentsBuffered) {
            return;
        }

        const rankOf = (index) => {
            const rank = this._evictionPriority && this._evictionPriority.get(index);
            return rank === undefined || rank === null ? Number.POSITIVE_INFINITY : rank;
        };

        // Worst-first. Array.prototype.sort is stable, so equal ranks --
        // including everything outside the window, which all rank Infinity
        // -- keep insertion order among themselves and the oldest goes first.
        const evictionOrder = [...this.buffers.keys()]
            .filter((index) => !this.pinned.has(index) && index !== justDecodedIndex)
            .sort((a, b) => rankOf(b) - rankOf(a));

        for (const index of evictionOrder) {
            if (this.buffers.size <= this.maxSegmentsBuffered) {
                break;
            }
            for (const frame of this.buffers.get(index).frames) {
                frame.close();
            }
            this.buffers.delete(index);
            this._logDebug(`segment ${index}: evicted (cache ${this.buffers.size}/${this.maxSegmentsBuffered})`);
        }
    }

    /**
     * Closes every cached VideoFrame, releases the shared VideoDecoder,
     * and clears the cache. Called when the engine is torn down --
     * without releasing the decoder here, a replaced engine (e.g. a
     * quality-change reload) leaves the old VideoDecoder instance alive
     * and still draining its queued decode work, competing with the new
     * engine's own decoder for the same CPU/GPU decode throughput.
     *
     * @returns {void}
     */
    close() {
        for (const gopBuffer of this.buffers.values()) {
            for (const frame of gopBuffer.frames) {
                frame.close();
            }
        }
        this.buffers.clear();
        for (const held of this._partials.values()) {
            for (const frame of held.values()) {
                frame.close();
            }
        }
        this._partials.clear();
        this.gopDecoder.close();
    }
}
