/**
 * Unit tests for attachWebView2Bridge -- verifies the exact
 * `status|`/`metadata|`/`frame|` message text posted to
 * window.chrome.webview.postMessage matches the fixed-field format
 * MareMediaElement.xaml.cs's CoreWebView2_WebMessageReceived handler
 * parses, against a fake MarpVideoShim-shaped object rather than a real
 * engine instance.
 *
 * @fileoverview Unit tests for the WebView2 postMessage bridge.
 * @author Isaac Travers
 * @module video-engine/test/unit/webview2-bridge.test
 */

const { attachWebView2Bridge } = require('../../src/webview2-bridge.js');

/**
 * Minimal fake matching MarpVideoShim's public surface (addEventListener/
 * requestVideoFrameCallback plus the properties the bridge reads), with a
 * `dispatch()` helper tests use to fire events the same way the real
 * shim's internal `_dispatch()` does.
 */
class FakeMarpVideo {
    constructor() {
        this._listeners = new Map();
        this.duration = 39.168;
        this.videoWidth = 1920;
        this.videoHeight = 1080;
        this.currentTime = 0;
        this.volume = 1;
        this.muted = false;
        this.hasAudio = true;
        this.audioBlocked = false;
    }

    addEventListener(type, callback) {
        if (!this._listeners.has(type)) {
            this._listeners.set(type, []);
        }
        this._listeners.get(type).push(callback);
    }

    dispatch(type, detail) {
        for (const callback of this._listeners.get(type) || []) {
            callback({ type, target: this, ...detail });
        }
    }

    requestVideoFrameCallback(callback) {
        this._frameCallback = callback;
    }
}

let previousWindow;

beforeEach(() => {
    previousWindow = global.window;
    global.window = { chrome: { webview: { postMessage: jest.fn() } } };
});

afterEach(() => {
    global.window = previousWindow;
});

describe('attachWebView2Bridge', () => {
    test('posts loadedmetadata status and metadata, then starts the frame clock', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        marpVideo.dispatch('loadedmetadata');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('status|loadedmetadata duration=39.168');
        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('metadata|39.168|1920|1080');
        expect(typeof marpVideo._frameCallback).toBe('function');
    });

    test('posts a frame| line matching the fixed 8-field format on each frame callback, then re-registers itself', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);
        marpVideo.dispatch('loadedmetadata');
        window.chrome.webview.postMessage.mockClear();

        marpVideo._frameCallback(123, {
            mediaTime: 1.5,
            presentedFrames: 10,
            expectedDisplayTime: 100.1,
            presentationTime: 99.9,
            width: 1920,
            height: 1080,
        });

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('frame|1.5|10|100.1|99.9|1920|1080|1');
        // requestVideoFrameCallback is one-shot on the real shim -- the
        // bridge must re-register itself after every frame to keep
        // receiving callbacks, matching the pattern MareMediaElement.xaml.cs's
        // own inline glue already relies on.
        expect(typeof marpVideo._frameCallback).toBe('function');
    });

    test('posts the real error message on an error event, unlike a numeric MediaError code', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        marpVideo.dispatch('error', { error: new Error('segment fetch failed') });

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('status|video error segment fetch failed');
    });

    test('posts seeking/seeked status with currentTime formatted to 6 decimal places', () => {
        const marpVideo = new FakeMarpVideo();
        marpVideo.currentTime = 5.5;
        attachWebView2Bridge(marpVideo);

        marpVideo.dispatch('seeking');
        marpVideo.dispatch('seeked');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('status|seeking currentTime=5.500000');
        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('status|seeked currentTime=5.500000');
    });

    test('is a no-op outside a WebView2 host (no window.chrome.webview) instead of throwing', () => {
        global.window = {};
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        expect(() => marpVideo.dispatch('loadedmetadata')).not.toThrow();
    });

    /**
     * Audio state goes out as further  lines rather than as extra
     * fields on . HandleMetadataMessage splits on a fixed four
     * fields and would break; HandleStatusMessage matches known prefixes and
     * logs anything else, so an un-updated host is unaffected by these.
     */
    test('announces the audio state alongside loadedmetadata', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        marpVideo.dispatch('loadedmetadata');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith(
            'status|audio hasAudio=true volume=1.000000 muted=false blocked=false'
        );
    });

    test('posts a volumechange line carrying volume, mute and blocked', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        marpVideo.volume = 0.25;
        marpVideo.muted = true;
        marpVideo.dispatch('volumechange');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith(
            'status|volumechange hasAudio=true volume=0.250000 muted=true blocked=false'
        );
    });

    test('reports media with no audio track as such', () => {
        const marpVideo = new FakeMarpVideo();
        marpVideo.hasAudio = false;
        attachWebView2Bridge(marpVideo);

        marpVideo.dispatch('loadedmetadata');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith(
            'status|audio hasAudio=false volume=1.000000 muted=false blocked=false'
        );
    });

    /**
     * The host may drive playback from native code with no user gesture ever
     * happening in the page, so this is the only way it learns sound is being
     * withheld rather than simply missing.
     */
    test('tells the host when the browser is withholding sound', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        marpVideo.audioBlocked = true;
        marpVideo.dispatch('volumechange');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith(
            'status|volumechange hasAudio=true volume=1.000000 muted=false blocked=true'
        );
    });

    test('still posts the original fixed-field lines unchanged', () => {
        const marpVideo = new FakeMarpVideo();
        attachWebView2Bridge(marpVideo);

        marpVideo.dispatch('loadedmetadata');

        expect(window.chrome.webview.postMessage).toHaveBeenCalledWith('metadata|39.168|1920|1080');
    });
});
