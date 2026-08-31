/**
 * Composes the video-engine pipeline (playlist -> segment fetch -> demux
 * -> decode -> frame cache -> scheduler -> canvas render) and returns a
 * window.marpVideo-compatible facade over it.
 *
 * Lives here rather than in index.js so the player UI can build engines
 * without importing the package barrel, which would import the UI back --
 * a cycle this codebase has been bitten by before. index.js re-exports
 * createMarpVideoEngine, so the public API is unchanged.
 *
 * @fileoverview The engine factory: createMarpVideoEngine().
 * @author Isaac Travers
 * @module video-engine/engine
 */

import { JellyfinTranscodeMediaSource } from './media-source-jellyfin-transcode.js';
import { GopDecoder } from './gop-decoder.js';
import { FrameStore } from './frame-store.js';
import { Scheduler } from './scheduler.js';
import { CanvasRenderer } from './canvas-renderer.js';
import { MarpVideoShim } from './marp-video-shim.js';

/**
 * Creates a frame-accurate bidirectional playback engine over a Jellyfin
 * HLS/CMAF stream, backed by WebCodecs + a <canvas>, exposing a
 * window.marpVideo-compatible surface.
 *
 * @async
 * @param {HTMLCanvasElement} canvas - Render target.
 * @param {Object} options
 * @param {string} [options.streamUrl] - MARP stream-negotiation URL, e.g. `/api/v2/jellyfin/items/:id/stream?mode=Transcode`. Used only when `options.mediaSource` is omitted.
 * @param {Object} [options.mediaSource] - A ready-made media source (e.g. {@link module:video-engine/media-source-jellyfin-directplay.JellyfinDirectPlayMediaSource}). Defaults to a Jellyfin transcode source over `streamUrl`.
 * @param {Object} [options.fetchOptions] - Extra fetch() options (e.g. `{headers: {Authorization: 'Bearer ...'}}`) applied to every request this engine makes.
 * @param {number} [options.cacheBudgetBytes] - Decoded-frame LRU cache budget in bytes. Default 3 GiB.
 * @param {number} [options.rawSegmentCacheBudgetBytes] - Raw-segment cache budget in bytes. Default 3 GiB.
 * @param {number} [options.maxConcurrentFetches] - Ceiling on simultaneously in-flight raw segment fetches. Default 6, suitable for a source that supports true random access (e.g. a static file server). A source backed by a single sequential live producer (e.g. Jellyfin's on-the-fly HLS transcoder) should pass a much lower value -- see scheduler.js's DEFAULT_MAX_CONCURRENT_TIER1_FETCHES doc comment for why.
 * @returns {Promise<Object>} A {@link module:video-engine/marp-video-shim.MarpVideoShim} instance.
 * @throws {Error} When the stream can't be loaded or the first segment decodes zero frames.
 */
export async function createMarpVideoEngine(canvas, options) {
    const { streamUrl, fetchOptions, cacheBudgetBytes, rawSegmentCacheBudgetBytes, maxConcurrentFetches, client, itemId, qualityOption } = options;

    let shim = null;
    let scheduler = null;
    // Set once the engine has finished loading. The behind-session hooks
    // below stay quiet until then: the engine's own priming seek(0) would
    // otherwise negotiate a session for a playhead position the user never
    // asked for, which is one of the timing changes that made the previous
    // attempt at this move suspect.
    let engineReady = false;

    // Which source is plugged in decides where bytes come from and how they
    // become decoder chunks; everything below this is source-agnostic. A
    // caller can supply its own (Direct Play, a local file); the Jellyfin
    // transcode source is built here only as the default for a streamUrl.
    const mediaSource = options.mediaSource || new JellyfinTranscodeMediaSource({
        streamUrl,
        fetchOptions,
        rawSegmentCacheBudgetBytes,
        // Forwards progress/failure messages to a 'debug' event on the shim
        // -- deferred `shim` reference since the source is constructed
        // before the shim exists (same pattern FrameStore/Scheduler's
        // callbacks use below).
        onDebug: (message) => {
            if (shim) {
                shim._dispatch('debug', { message });
            }
        },
        onError: (err) => {
            console.error('Media source reported a raw-fetch failure', err);
            if (shim) {
                shim._dispatch('error', { error: err });
            }
        },
        // With these the transcode source negotiates and maintains its own
        // behind sessions, which is what makes reverse fast on that path.
        // Deferred `scheduler` reference for the same reason as `shim`: the
        // source is built before either exists.
        client,
        itemId,
        qualityOption,
        getCurrentTime: () => (scheduler ? scheduler.currentTime : NaN),
    });

    // Logged at each stage (not just on final success/failure) so a stall
    // in any one step -- e.g. a hung fetch() -- is immediately localized
    // instead of looking like total silence.
    console.log('[video-engine] loading media source...');
    await mediaSource.load();
    const segmentIndex = mediaSource.getUnitIndex();
    console.log(`[video-engine] source loaded: ${segmentIndex.segments.length} units, ${segmentIndex.totalDuration.toFixed(3)}s`);
    console.log(`[video-engine] max concurrent segment fetches: ${maxConcurrentFetches || '(engine default)'}`);

    const segmentFetcher = mediaSource.segmentFetcher;
    const gopDecoder = new GopDecoder();

    // Demux+decode the first segment up front, both to display an initial
    // frame and to learn the real negotiated width/height/fps the LRU
    // cache's memory-budget formula needs -- never guessed/hardcoded.
    console.log('[video-engine] fetching first segment...');
    await segmentFetcher.fetchSegment(0);

    console.log('[video-engine] demuxing first segment...');
    const { unitFirstTimestampMicros: _firstUnitStart, ...firstDemux } = await mediaSource.fetchChunks(0);

    console.log('[video-engine] decoding first segment...');
    const firstGopBuffer = await gopDecoder.decodeSegment(0, firstDemux);
    console.log(`[video-engine] first segment decoded: ${firstGopBuffer.frames.length} frames`);

    if (firstGopBuffer.frames.length === 0) {
        throw new Error('First segment decoded zero frames.');
    }

    const firstFrame = firstGopBuffer.frames[0];
    const videoWidth = firstFrame.displayWidth;
    const videoHeight = firstFrame.displayHeight;
    const fps = Math.round(firstGopBuffer.frames.length / segmentIndex.segments[0].duration);

    const frameStore = new FrameStore({
        segmentFetcher,
        mediaSource,
        gopDecoder,
        width: videoWidth,
        height: videoHeight,
        fps,
        segmentDuration: segmentIndex.segments[0].duration,
        cacheBudgetBytes,
        // Forwards fetch/decode progress/failure messages to a 'debug'
        // event on the shim, so a consumer can surface them without
        // needing DevTools open -- deferred `shim` reference since
        // FrameStore is constructed before the shim exists (same pattern
        // Scheduler's own `emit` callback already uses below).
        onDebug: (message) => {
            if (shim) {
                shim._dispatch('debug', { message });
            }
        },
        // Reports each real segment failure exactly once (see FrameStore's
        // own constructor doc comment for why per-caller reporting used to
        // fire many duplicate times for a single failure).
        onError: (err) => {
            console.error('FrameStore reported a segment failure', err);
            if (shim) {
                shim._dispatch('error', { error: err });
            }
        },
    });

    // Seed the cache with the segment already decoded above rather than
    // discarding it and re-decoding on the first seek(0) below.
    frameStore.buffers.set(0, firstGopBuffer);

    const canvasRenderer = new CanvasRenderer(canvas);

    scheduler = new Scheduler({
        segmentIndex,
        frameStore,
        canvasRenderer,
        maxConcurrentTier1Fetches: maxConcurrentFetches,
        emit: (type, detail) => {
            if (type === 'error') {
                console.error('Scheduler emitted "error"', detail && detail.error);
            }
            // A landed seek is where the region behind the playhead changes
            // most; sources that pre-produce it want to know immediately.
            if (engineReady && type === 'seeked' && typeof mediaSource.prepareForPlayhead === 'function') {
                mediaSource.prepareForPlayhead(scheduler.currentTime);
            }
            if (shim) {
                // Forwards whatever detail the scheduler attached (e.g.
                // seeking/seeked's targetTime/segmentIndex, debug's
                // message) straight through to listeners like the
                // WebView2 bridge or the test harness's log panel.
                shim._dispatch(type, detail);
            }
        },
    });

    shim = new MarpVideoShim(scheduler, { videoWidth, videoHeight, fps });

    // Sources are usually built before the engine exists, so anything they
    // need to read from it (the playhead, for playback reporting and for
    // anchoring behind sessions) is handed over here.
    if (typeof mediaSource.attachEngine === 'function') {
        mediaSource.attachEngine({
            getCurrentTime: () => scheduler.currentTime,
            isPaused: () => shim.paused,
        });
    }

    // Sources that maintain their own background work (the transcode
    // path's behind sessions) run it from here until the engine closes --
    // otherwise a replaced engine leaves the old one negotiating against
    // Jellyfin forever.
    const closeShim = shim.close.bind(shim);
    shim.close = () => {
        if (typeof mediaSource.stopBehindSessionMaintenance === 'function') {
            mediaSource.stopBehindSessionMaintenance();
        }
        if (typeof mediaSource.stopPlaybackReporting === 'function') {
            mediaSource.stopPlaybackReporting();
        }
        closeShim();
    };
    // Prime the first displayed frame and fire the initial metadata
    // events, matching a real <video> element's loadedmetadata/
    // durationchange/resize timing on first load.
    await scheduler.seek(0);
    shim._dispatch('loadedmetadata');
    shim._dispatch('durationchange');
    shim._dispatch('resize');

    // Only now, with the engine up: the same moment the app used to start
    // this from, so the cadence is unchanged from what has been running.
    engineReady = true;
    if (typeof mediaSource.startBehindSessionMaintenance === 'function') {
        mediaSource.startBehindSessionMaintenance();
    }
    if (typeof mediaSource.startPlaybackReporting === 'function') {
        mediaSource.startPlaybackReporting();
    }

    return shim;
}
