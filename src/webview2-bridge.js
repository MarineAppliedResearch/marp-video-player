/**
 * Bridges a MarpVideoShim instance's events and metadata to
 * chrome.webview.postMessage, in the exact `status|`/`metadata|`/`frame|`
 * text format MareMediaElement.xaml.cs's CoreWebView2_WebMessageReceived
 * handler parses (see that file's HandleStatusMessage/
 * HandleMetadataMessage/HandleFrameMessage) -- ported from the postMessage
 * glue that file's own BuildPlayerHtml() currently generates inline around
 * a plain <video> element, so the C# side needs no changes to its message
 * parsing, only to how its injected HTML loads the player (see this
 * package's README/handoff notes for the replacement HTML).
 *
 * Deliberately a thin translation layer only -- it reads MarpVideoShim's
 * public surface (currentTime/duration/videoWidth/videoHeight/paused/
 * playbackRate, addEventListener, requestVideoFrameCallback) the exact
 * same way any other consumer would, no special internal access.
 *
 * @fileoverview Bridges MarpVideoShim events to chrome.webview.postMessage in MareMediaElement.xaml.cs's expected format.
 * @author Isaac Travers
 * @module video-engine/webview2-bridge
 */

import { encodeSegmentStates, encodeSegmentGeometry } from './segment-encoding.js';

/**
 * Posts a raw string message to the WebView2 host, if one is present.
 * A no-op in a plain browser tab (no window.chrome.webview) so the exact
 * same bundle works unmodified inside and outside the WPF host.
 *
 * @param {string} message - Raw message text.
 * @returns {void}
 */
function postToHost(message) {
    if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(message);
    }
}

/**
 * Wires a MarpVideoShim instance's lifecycle events, metadata, and
 * per-frame callback to chrome.webview.postMessage, matching the message
 * format MareMediaElement.xaml.cs already parses.
 *
 * @param {Object} marpVideo - A MarpVideoShim instance (or anything matching its public surface).
 * @param {Object} [options]
 * @param {boolean} [options.segmentUpdates] - Also post `segmentindex|` once per load and `segments|` on a timer, for a host drawing its own scrub bar. Off by default.
 * @param {number} [options.segmentIntervalMs] - How often to post `segments|`. Default 250, matching the built-in scrub bar's own refresh.
 * @returns {Function} Detach function that stops the segment timer.
 */
export function attachWebView2Bridge(marpVideo, options = {}) {
    /**
     * Posts a `status|<message>` line -- matches HandleStatusMessage's
     * prefix checks (e.g. `status.StartsWith("loadedmetadata", ...)`).
     *
     * @param {string} message - Status text.
     * @returns {void}
     */
    function postStatus(message) {
        postToHost(`status|${message}`);
    }

    /**
     * Posts a `metadata|<duration>|<width>|<height>` line -- matches
     * HandleMetadataMessage's fixed 4-field split.
     *
     * @returns {void}
     */
    function postMetadata() {
        const duration = Number.isFinite(marpVideo.duration) ? marpVideo.duration : -1;
        const width = marpVideo.videoWidth || -1;
        const height = marpVideo.videoHeight || -1;
        postToHost(`metadata|${duration}|${width}|${height}`);
    }

    // Matches the real callbackCount field HandleFrameMessage expects as
    // its 8th field -- a running count purely for that handler's own
    // periodic ("every 25th frame") logging, not used by this bridge itself.
    let callbackCount = 0;

    /**
     * requestVideoFrameCallback handler -- posts a `frame|...` line per
     * presented frame, matching HandleFrameMessage's fixed 8-field split,
     * then re-registers itself (requestVideoFrameCallback is one-shot).
     *
     * @param {number} now - performance.now()-style timestamp.
     * @param {Object} metadata - Frame metadata from MarpVideoShim.
     * @returns {void}
     */
    function onVideoFrame(now, metadata) {
        callbackCount += 1;

        const mediaTime = metadata.mediaTime ?? -1;
        const presentedFrames = metadata.presentedFrames ?? -1;
        const expectedDisplayTime = metadata.expectedDisplayTime ?? -1;
        const presentationTime = metadata.presentationTime ?? -1;
        const width = metadata.width ?? marpVideo.videoWidth ?? -1;
        const height = metadata.height ?? marpVideo.videoHeight ?? -1;

        postToHost(`frame|${mediaTime}|${presentedFrames}|${expectedDisplayTime}|${presentationTime}|${width}|${height}|${callbackCount}`);

        marpVideo.requestVideoFrameCallback(onVideoFrame);
    }

    /**
     * Announces the loaded stream and starts the frame clock.
     *
     * Split out because attaching AFTER the engine is built -- which is the
     * normal case, since createMarpVideoEngine resolves with a ready engine
     * and fires loadedmetadata before returning -- means that event is
     * already gone. A host waiting on it (MareMediaElement raises its
     * MediaOpened from exactly this message) would then never learn the
     * video had opened, and its own UI would never appear.
     *
     * @returns {void}
     */
    function announceLoaded() {
        postStatus(`loadedmetadata duration=${marpVideo.duration}`);
        postMetadata();
        // Starts the frame clock -- matches the original inline glue's
        // startFrameClockIfAvailable(), called once on first
        // loadedmetadata. No "is requestVideoFrameCallback available"
        // feature-detection here (unlike the original, which checked
        // HTMLVideoElement.prototype): MarpVideoShim always provides it,
        // it's this engine's own API, not a browser feature to detect.
        marpVideo.requestVideoFrameCallback(onVideoFrame);
    }

    marpVideo.addEventListener('loadedmetadata', announceLoaded);

    // Already loaded by the time we attached: replay it, so a host that
    // waits for this message is not left waiting forever.
    if (Number.isFinite(marpVideo.duration) && marpVideo.duration > 0) {
        announceLoaded();
    }

    marpVideo.addEventListener('durationchange', postMetadata);
    marpVideo.addEventListener('resize', postMetadata);

    marpVideo.addEventListener('error', (event) => {
        // Unlike a real HTMLVideoElement (MediaError code 1-4), MarpVideoShim
        // exposes the real underlying Error's message instead of a numeric
        // code -- HandleStatusMessage doesn't parse a specific code out of
        // this message today, it only logs unrecognized status text, so a
        // descriptive message is strictly more useful here than a code
        // would be.
        postStatus(`video error ${event.error ? event.error.message : '(no detail)'}`);
    });

    marpVideo.addEventListener('playing', () => postStatus('playing'));
    marpVideo.addEventListener('pause', () => postStatus('pause'));
    marpVideo.addEventListener('seeking', () => postStatus(`seeking currentTime=${marpVideo.currentTime.toFixed(6)}`));
    marpVideo.addEventListener('seeked', () => postStatus(`seeked currentTime=${marpVideo.currentTime.toFixed(6)}`));

    // --- Segment reporting, for a host drawing its own scrub bar ---
    //
    // Off unless asked for: a host that does not draw segment shading
    // should not pay for the messages. A host that does gets the geometry
    // once and the states on a timer, which is how the built-in scrub bar
    // reads the same data (see player-ui.js's own shading interval).
    let segmentTimer = null;
    let geometrySent = false;

    /** Posts `segmentindex|<count>|<start,end;...>` once per loaded stream. */
    function postSegmentGeometry() {
        const states = marpVideo.getSegmentStates();
        if (states.length === 0) {
            return;
        }
        postToHost(`segmentindex|${states.length}|${encodeSegmentGeometry(states)}`);
        geometrySent = true;
    }

    /** Posts `segments|<digits>`, one digit per segment (1 fetched, 2 decoded, 4 pinned). */
    function postSegmentStates() {
        const states = marpVideo.getSegmentStates();
        if (states.length === 0) {
            return;
        }
        // Geometry first if a reload replaced the stream under us, so a
        // host never has to map states onto boundaries it has not been
        // told about.
        if (!geometrySent) {
            postSegmentGeometry();
        }
        postToHost(`segments|${encodeSegmentStates(states)}`);
    }

    if (options.segmentUpdates) {
        const intervalMs = Number.isFinite(options.segmentIntervalMs) ? options.segmentIntervalMs : 250;

        marpVideo.addEventListener('loadedmetadata', () => {
            geometrySent = false;
            postSegmentGeometry();
        });
        postSegmentGeometry();

        segmentTimer = setInterval(postSegmentStates, intervalMs);
        postSegmentStates();
    }

    /**
     * Stops the segment timer. A host that never enabled segment updates
     * can ignore this; a page that replaces its engine should call it, or
     * the old timer keeps polling a closed engine.
     *
     * @returns {void}
     */
    return function detachWebView2Bridge() {
        if (segmentTimer) {
            clearInterval(segmentTimer);
            segmentTimer = null;
        }
    };
}
