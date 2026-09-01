/**
 * The complete player UI: builds the DOM, wires every control to the
 * engine, and owns loading (Jellyfin sign-in, item + quality selection,
 * local files) so one call produces a working video player.
 *
 * Ported from frontend/apps/VideoPlayer/app.js, which did all of this as
 * page glue against document-level ids. Three things changed in the move
 * and nothing else did:
 *
 *   1. Every lookup is scoped to this player's own root element, so the UI
 *      is an instance rather than a page.
 *   2. The on-page log panel is gone; messages go to the console, and to an
 *      `onLog` callback if the consumer wants them.
 *   3. The dev-server Jellyfin credentials that app.js prefilled are not in
 *      here. A library must not ship someone's server password; a consumer
 *      that wants a prefill passes `prefill`.
 *
 * @fileoverview Container-scoped player UI over the video engine.
 * @author Isaac Travers
 * @module video-engine/ui/player-ui
 */

import { createMarpVideoEngine } from '../index.js';
import { JellyfinClient } from '../jellyfin-client.js';
import { JellyfinMediaSource } from '../media-source-jellyfin-transcode.js';
import { LocalFileMediaSource } from '../media-source-local.js';
import { UrlMediaSource } from '../media-source-url.js';
import { createJellyfinSource } from '../media-source-jellyfin.js';
import { attachWebView2Bridge } from '../webview2-bridge.js';
import { PLAYER_CSS, STYLE_ELEMENT_ID } from './styles.js';
import { buildPlayerMarkup } from './markup.js';

/**
 * Playback-rate hotkeys. q..y span -8x..-0.08x (reverse, slowing toward
 * y); u..\ span 0.08x..16x. One flat table -- change this alone. Pressing
 * any of these also starts playback: they are for actively scrubbing
 * through the video, not for arming a rate.
 */
export const SPEED_KEYMAP = {
    q: -8,
    w: -3,
    e: -1,
    r: -0.5,
    t: -0.2,
    y: -0.08,
    u: 0.08,
    i: 0.2,
    o: 0.5,
    p: 1,
    '[': 2.5,
    ']': 6,
    '\\': 16,
};

/** How long the controls bar stays visible after the pointer stops moving during playback, in ms. */
const CONTROLS_IDLE_HIDE_MS = 2500;

/** How often segment-state shading is re-read and redrawn, in ms -- a plain timer, since it need not track frame presentation. */
const SEGMENT_SHADING_INTERVAL_MS = 250;

/** Bytes per GiB, for the cache-budget inputs. */
const BYTES_PER_GIB = 1024 * 1024 * 1024;

/**
 * Injects the player stylesheet into a document, at most once.
 *
 * @param {Document} doc - Target document.
 * @returns {void}
 */
function ensureStyles(doc) {
    if (doc.getElementById(STYLE_ELEMENT_ID)) {
        return;
    }
    const style = doc.createElement('style');
    style.id = STYLE_ELEMENT_ID;
    style.textContent = PLAYER_CSS;
    doc.head.appendChild(style);
}

/**
 * Formats seconds as m:ss.ss for the time display.
 *
 * @param {number} seconds - Possibly non-finite before load.
 * @returns {string} Formatted time, or "--:--".
 */
function formatTime(seconds) {
    if (!Number.isFinite(seconds)) {
        return '--:--';
    }
    const m = Math.floor(seconds / 60);
    const s = (seconds % 60).toFixed(2).padStart(5, '0');
    return `${m}:${s}`;
}

/**
 * Collapses a list of indices into compact ranges ("3-7, 11") for the
 * state dump.
 *
 * @param {number[]} indices - Segment indices, any order.
 * @returns {string[]} Range strings.
 */
function listToRanges(indices) {
    if (!indices || indices.length === 0) {
        return [];
    }

    const sorted = [...new Set(indices)].sort((a, b) => a - b);
    const ranges = [];
    let start = sorted[0];
    let end = sorted[0];

    for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] === end + 1) {
            end = sorted[i];
            continue;
        }
        ranges.push(start === end ? `${start}` : `${start}-${end}`);
        start = sorted[i];
        end = sorted[i];
    }
    ranges.push(start === end ? `${start}` : `${start}-${end}`);
    return ranges;
}

/**
 * A complete video player: picture, transport, scrub bar with per-segment
 * shading, spinner, and a settings menu covering sign-in, item loading,
 * quality, playback speed and cache diagnostics.
 *
 * Delegates the `<video>`-shaped surface (`currentTime`, `play()`,
 * `playbackRate`, `addEventListener`, `requestVideoFrameCallback`, ...) to
 * whichever engine is currently loaded, so a consumer holds one stable
 * object across item and quality changes -- each of which replaces the
 * engine underneath.
 */
export class MarpVideoPlayer {
    /**
     * @param {HTMLElement} container - Element to build the player inside. Emptied first.
     * @param {Object} [options]
     * @param {Object} [options.jellyfinClient] - Reuse an existing {@link module:video-engine/jellyfin-client.JellyfinClient}.
     * @param {Object} [options.jellyfin] - Existing session to adopt: `{serverUrl, accessToken, userId}`.
     * @param {Object} [options.prefill] - Login-form prefill: `{serverUrl, username, password}`. Only fills blank fields.
     * @param {string} [options.itemId] - Jellyfin item to load immediately.
     * @param {File} [options.file] - Local file to load immediately.
     * @param {string} [options.url] - Media URL to load immediately (.m3u8 as an HLS transcode stream, anything else by byte range).
     * @param {string} [options.defaultItemId] - Prefills the item-id field without loading.
     * @param {string} [options.aspectRatio] - CSS aspect-ratio for the player box. Default '16 / 9'. Pass null with a sized container to fill it instead.
     * @param {string} [options.maxWidth] - CSS max-width for the player box. Default '960px'; pass null for none.
     * @param {boolean} [options.controls] - Show the built-in controls (transport, scrub bar, settings). Default true. False leaves picture, spinner and placeholder mark only, for a host that draws its own chrome -- see setControlsVisible().
     * @param {boolean} [options.input] - Handle input on the video itself: click-to-play-pause, drag-and-drop loading, and the speed/space hotkeys. Defaults to whatever `controls` is, so a host that draws its own chrome owns all input by default.
     * @param {boolean} [options.showDiagnostics] - Render the Advanced section. Default true.
     * @param {boolean} [options.webview2Bridge] - Post status|/metadata|/frame| messages to a WebView2 host on every load. Default false.
     * @param {boolean} [options.segmentUpdates] - With webview2Bridge, also post segmentindex|/segments| so a host can draw its own scrub bar shading. Default false.
     * @param {number} [options.segmentIntervalMs] - How often segments| is posted. Default 250.
     * @param {boolean} [options.exposeGlobals] - Assign each loaded engine to window.marpVideo and window.mareVideo. Default false.
     * @param {number} [options.rawCacheGiB] - Initial raw-cache budget shown in Advanced. Default 3.
     * @param {number} [options.decodedCacheGiB] - Initial decoded-cache budget shown in Advanced. Default 5.
     * @param {Function} [options.onLog] - Receives every log line, in addition to the console.
     */
    constructor(container, options = {}) {
        if (!container) {
            throw new Error('MarpVideoPlayer needs a container element.');
        }

        this.options = options;
        this.container = container;
        this.document = container.ownerDocument;
        this.onLog = typeof options.onLog === 'function' ? options.onLog : null;

        /** The currently loaded engine (a MarpVideoShim), or null before the first load. */
        this.engine = null;

        this.currentItemId = null;
        this.currentQualityOption = null;
        this.lastFrameMetadata = null;

        this.scrubDragging = false;
        this.lastScrubTime = 0;
        this.segmentShadingHandle = null;
        this.controlsHideTimer = null;
        this.pointerOverControlsBar = false;
        this.settingsMenuOpen = false;
        // Login is expanded first: signing in is what a new session needs.
        this.openSettingsSectionId = 'settingsLoginBody';

        this.jellyfinClient = options.jellyfinClient || new JellyfinClient();
        if (options.jellyfin) {
            this.jellyfinClient.useSession(options.jellyfin);
        }
        // Probe-only source, separate from whatever source the engine ends up
        // using -- it answers "which tiers does this item have" before any
        // engine exists.
        this.probeSource = new JellyfinMediaSource(this.jellyfinClient);

        // Input follows controls unless asked otherwise: a host drawing its
        // own chrome owns the keyboard and the pointer by default.
        this.inputEnabled = options.input === undefined ? options.controls !== false : options.input !== false;

        ensureStyles(this.document);
        this._buildDom();
        this._wireControls();

        this.updateLoginStatus();
        this._applyPrefill();

        if (options.itemId) {
            this.loadItem(options.itemId, null);
        } else if (options.file) {
            this.loadFile(options.file);
        } else if (options.url) {
            this.loadUrl(options.url);
        }
    }

    /**
     * Builds the player DOM inside the container and caches element
     * references.
     *
     * @private
     * @returns {void}
     */
    _buildDom() {
        const {
            aspectRatio = '16 / 9',
            maxWidth = '960px',
            defaultItemId = '',
            showDiagnostics = true,
            rawCacheGiB,
            decodedCacheGiB,
        } = this.options;

        this.container.innerHTML = '';

        const root = this.document.createElement('div');
        root.className = 'marp-player';
        // Kept for parity with the harness page, whose speed hotkeys relied
        // on the player being focusable.
        root.id = 'playerContainer';
        root.tabIndex = 0;
        root.style.width = '100%';
        if (aspectRatio) {
            root.style.aspectRatio = aspectRatio;
        } else {
            root.style.height = '100%';
        }
        if (maxWidth) {
            root.style.maxWidth = maxWidth;
        }
        root.innerHTML = buildPlayerMarkup({ defaultItemId, showDiagnostics });

        // The controls DOM is always built, and hidden when unwanted, rather
        // than skipped: every load path and event handler here writes to the
        // time display, the scrub handle, the quality list and the transport
        // buttons, and guarding all of that against absent elements is where
        // bugs would breed. Hidden elements take no clicks and no focus, so
        // they cannot fight a host's own overlay -- the cost is a few dozen
        // inert nodes.
        this.container.appendChild(root);
        this.root = root;

        this.controlsVisible = this.options.controls !== false;
        root.classList.toggle('marp-controls-off', !this.controlsVisible);

        /** @private Every element this UI touches, by scoped class. */
        this.el = {
            canvas: root.querySelector('.marp-canvas'),
            logo: root.querySelector('.marp-logo'),
            centerOverlay: root.querySelector('.marp-center-overlay'),
            centerPlay: root.querySelector('.marp-center-play'),
            spinner: root.querySelector('.marp-spinner'),
            controlsBar: root.querySelector('.marp-controls-bar'),
            scrubTrack: root.querySelector('.marp-scrub-track'),
            scrubBg: root.querySelector('.marp-scrub-bg'),
            scrubHandle: root.querySelector('.marp-scrub-handle'),
            scrubTooltip: root.querySelector('.marp-scrub-tooltip'),
            playPause: root.querySelector('.marp-play-pause'),
            stepBack: root.querySelector('.marp-step-back'),
            stepForward: root.querySelector('.marp-step-forward'),
            time: root.querySelector('.marp-time'),
            speed: root.querySelector('.marp-speed'),
            settingsButton: root.querySelector('.marp-settings-button'),
            settingsMenu: root.querySelector('.marp-settings-menu'),
            mute: root.querySelector('.marp-mute'),
            fullscreen: root.querySelector('.marp-fullscreen'),
            serverUrl: root.querySelector('.marp-server-url'),
            username: root.querySelector('.marp-username'),
            password: root.querySelector('.marp-password'),
            login: root.querySelector('.marp-login'),
            logout: root.querySelector('.marp-logout'),
            loginStatus: root.querySelector('.marp-login-status'),
            itemId: root.querySelector('.marp-item-id'),
            load: root.querySelector('.marp-load'),
            localFile: root.querySelector('.marp-local-file'),
            qualityList: root.querySelector('.marp-quality-list'),
            speedInput: root.querySelector('.marp-speed-input'),
            rawCache: root.querySelector('.marp-raw-cache'),
            decodedCache: root.querySelector('.marp-decoded-cache'),
            applyCache: root.querySelector('.marp-apply-cache'),
            readCache: root.querySelector('.marp-read-cache'),
            dumpState: root.querySelector('.marp-dump-state'),
        };

        if (this.el.rawCache && Number.isFinite(rawCacheGiB)) {
            this.el.rawCache.value = String(rawCacheGiB);
        }
        if (this.el.decodedCache && Number.isFinite(decodedCacheGiB)) {
            this.el.decodedCache.value = String(decodedCacheGiB);
        }
    }

    /**
     * Writes a line to the console and to `options.onLog`.
     *
     * @param {string} message - Text to log.
     * @returns {void}
     */
    log(message) {
        console.log(message);
        if (this.onLog) {
            this.onLog(message);
        }
    }

    /**
     * Reads the raw-cache budget input as bytes.
     *
     * @private
     * @returns {number|undefined} Bytes, or undefined when unset/invalid.
     */
    _rawCacheBudgetBytes() {
        if (!this.el.rawCache) {
            return undefined;
        }
        const bytes = Math.floor(parseFloat(this.el.rawCache.value) * BYTES_PER_GIB);
        return Number.isFinite(bytes) ? bytes : undefined;
    }

    /**
     * Guards both load paths: WebCodecs only exists in a secure context, and
     * reaching a dev server over plain http at a LAN address silently removes
     * it -- which otherwise surfaces as a bare "VideoDecoder is not defined"
     * from deep inside the decoder.
     *
     * @private
     * @returns {boolean} True when decoding is possible.
     */
    _checkWebCodecs() {
        if (typeof VideoDecoder !== 'undefined') {
            return true;
        }
        this.log(
            `ERROR: WebCodecs (VideoDecoder) is unavailable at ${window.location.origin} ` +
                `(isSecureContext=${window.isSecureContext}). Open this page over https or via localhost/127.0.0.1.`
        );
        return false;
    }

    /**
     * Tears down the previous engine before a replacement loads.
     *
     * Without this, switching item or quality left the old scheduler's render
     * loop and cache-fill passes running indefinitely, fetching against
     * Jellyfin concurrently with the new engine -- enough to make the
     * transcoder error out on both sessions at once.
     *
     * @private
     * @returns {void}
     */
    _closeCurrentEngine() {
        if (!this.engine) {
            return;
        }
        this.log('Closing previous engine before loading the new one...');
        // Before the engine goes: the bridge's segment timer would otherwise
        // keep polling a closed engine.
        if (this._detachBridge) {
            this._detachBridge();
            this._detachBridge = null;
        }
        this.engine.close();
        this.engine = null;

        // The picture belonged to that engine. Left up, a spinner over the
        // last frame of the previous video reads as "still playing that one"
        // rather than "loading the next one". Cleared only once the engine
        // that draws it is gone, or its render loop would paint over this.
        this._clearPicture();
    }

    /**
     * Blanks the canvas back to the placeholder mark.
     *
     * @private
     * @returns {void}
     */
    _clearPicture() {
        const context = this.el.canvas.getContext('2d');
        if (context) {
            context.clearRect(0, 0, this.el.canvas.width, this.el.canvas.height);
        }
        this.el.logo.style.display = '';
    }

    /**
     * Marks the start of a load: spinner up, load button out.
     *
     * The spinner used to be driven entirely by engine events, which meant it
     * could not appear until there was an engine to raise them -- and by then
     * the slow part is over. Negotiating with the server, fetching the `moov`
     * prefix or the playlist, and the first fetch and decode all happen inside
     * `createMarpVideoEngine`, so the whole opening stretch reported nothing at
     * all and a load looked like a click that had not registered. See #9.
     *
     * Default colour rather than the `decoding` variant: at this point the wait
     * is network, which is the blue the scrub bar uses for fetched segments.
     *
     * @private
     * @returns {void}
     */
    _beginLoad() {
        this.el.load.disabled = true;
        this.el.spinner.classList.remove('decoding');
        this.el.spinner.classList.remove('marp-hidden');

        // A play button over a spinner offers something that is not there yet.
        // applyLoadedUiState() puts it back when the load succeeds; after a
        // failure there is genuinely nothing to press.
        this.el.centerOverlay.classList.add('marp-hidden');
    }

    /**
     * Marks the end of a load, however it ended.
     *
     * Hidden here rather than left to the engine's `playing`/`canplay`
     * handlers, because on a successful load those have already fired: the
     * engine primes its first frame with a `seek(0)` *before*
     * `createMarpVideoEngine` resolves, so the block clears before this UI has
     * attached a single listener. Waiting for an event that is already in the
     * past would leave the spinner turning forever.
     *
     * Anything that blocks after this point still raises `waiting`, which puts
     * the spinner back.
     *
     * @private
     * @returns {void}
     */
    _endLoad() {
        this.el.load.disabled = false;
        this.el.spinner.classList.add('marp-hidden');
    }

    /**
     * Shared tail of both load paths: wire events, start shading, enable
     * controls, publish the engine.
     *
     * @private
     * @returns {void}
     */
    _afterLoad() {
        this._wireEngineEvents();

        this.log(
            `Engine ready. duration=${this.engine.duration.toFixed(3)}s, ` +
                `${this.engine.videoWidth}x${this.engine.videoHeight}, ${this.engine.fps}fps`
        );

        this.buildSegmentBlocks(this.engine.getSegmentStates());
        if (this.segmentShadingHandle) {
            clearInterval(this.segmentShadingHandle);
        }
        this.segmentShadingHandle = setInterval(() => this.updateSegmentShading(), SEGMENT_SHADING_INTERVAL_MS);

        this._enableTransportControls();
        this.syncCacheSettingsFromEngine();

        if (this.options.exposeGlobals) {
            window.marpVideo = this.engine;
            window.mareVideo = this.engine;
        }
        if (this.options.webview2Bridge) {
            // Safe to attach after the fact: the bridge replays
            // loadedmetadata on attach for exactly this case.
            this._detachBridge = attachWebView2Bridge(this.engine, {
                segmentUpdates: this.options.segmentUpdates,
                segmentIntervalMs: this.options.segmentIntervalMs,
            });
        }

        this.root.focus();
    }

    /**
     * Loads (or reloads, for a quality change) a Jellyfin item, talking
     * directly to Jellyfin. Re-creates the engine each time; seamless
     * mid-stream quality switching is out of scope.
     *
     * @async
     * @param {string} itemId - Jellyfin item id.
     * @param {Object} [qualityOption] - A tier from probeQualityOptions(); the first tier when omitted.
     * @returns {Promise<Object|null>} The loaded engine, or null on failure.
     */
    async loadItem(itemId, qualityOption) {
        if (!this._checkWebCodecs()) {
            return null;
        }

        if (!this.jellyfinClient.isAuthenticated()) {
            this.log('ERROR: sign in to a Jellyfin server first (Settings > Server / Login).');
            return null;
        }

        this._beginLoad();

        try {
            // Always re-probe the full tier list, even when reloading for one
            // specific pick -- qualityOption decides which tier is selected,
            // not which exist, otherwise the menu collapses to one entry.
            const options = await this.probeSource.probeQualityOptions(itemId);
            if (options.length === 0) {
                throw new Error('Jellyfin reports this item cannot be transcoded.');
            }
            this.currentQualityOption = qualityOption || options[0];
            this.currentItemId = itemId;
            this.buildQualityOptionsMenu(options, this.currentQualityOption);
            if (this.el.itemId) {
                this.el.itemId.value = itemId;
            }

            const directPlay = Boolean(this.currentQualityOption.directPlay);
            const rawCacheBudgetBytes = this._rawCacheBudgetBytes();

            this.log(`Loading ${itemId} (${this.currentQualityOption.name}) ...`);
            this._closeCurrentEngine();

            // The library decides how to play the item: which path, what to
            // negotiate, and -- on transcode -- the behind sessions that keep
            // reverse fast. Nothing here needs to know any of that exists.
            const built = await createJellyfinSource({
                client: this.jellyfinClient,
                itemId,
                prefer: directPlay ? 'directPlay' : 'transcode',
                qualityOption: directPlay ? undefined : this.currentQualityOption,
                rawSegmentCacheBudgetBytes: rawCacheBudgetBytes,
                onDebug: (message) => this.log(message),
                onError: (err) => this.log(`ERROR (media source): ${err.message}`),
            });

            this.engine = await createMarpVideoEngine(this.el.canvas, {
                mediaSource: built.mediaSource,
                maxConcurrentFetches: built.maxConcurrentFetches,
                rawSegmentCacheBudgetBytes: rawCacheBudgetBytes,
            });

            this._afterLoad();
            return this.engine;
        } catch (err) {
            this.log('ERROR loading: ' + err.message);
            console.error(err);
            return null;
        } finally {
            this._endLoad();
        }
    }

    /**
     * Loads a local file, with no server involved at all.
     *
     * Deliberately independent of Jellyfin: no sign-in, no item id, no
     * quality tiers -- a file on disk has one representation. The picker and
     * the drop handler share this path.
     *
     * @async
     * @param {File} file - File from the picker or a drop.
     * @returns {Promise<Object|null>} The loaded engine, or null on failure.
     */
    async loadFile(file) {
        if (!this._checkWebCodecs()) {
            return null;
        }

        this._beginLoad();

        try {
            this.log(`Loading local file ${file.name} (${(file.size / 1024 / 1024).toFixed(1)} MB) ...`);
            this._closeCurrentEngine();

            this.currentItemId = null;
            this.currentQualityOption = null;
            this.engine = await createMarpVideoEngine(this.el.canvas, {
                rawSegmentCacheBudgetBytes: this._rawCacheBudgetBytes(),
                mediaSource: new LocalFileMediaSource({
                    file,
                    onDebug: (message) => this.log(message),
                    onError: (err) => this.log(`ERROR (media source): ${err.message}`),
                }),
            });

            // A local file has no tier menu -- say so, rather than leaving
            // whatever a previous Jellyfin load put there.
            this.el.qualityList.innerHTML = '';
            const note = this.document.createElement('span');
            note.className = 'marp-status';
            note.textContent = 'Local file - no quality tiers.';
            this.el.qualityList.appendChild(note);

            this._afterLoad();
            this.applyLoadedUiState();
            return this.engine;
        } catch (err) {
            this.log(`ERROR loading local file: ${err.message}`);
            return null;
        } finally {
            this._endLoad();
        }
    }

    /**
     * Loads a plain media URL, with no Jellyfin session and no item id.
     *
     * An .m3u8 is read as a Jellyfin HLS transcode stream; anything else is
     * read as an MP4 by byte range, which covers a local file served through
     * a WebView2 virtual-host folder mapping. A bare .m3u8 cannot maintain
     * behind sessions -- there is no session to negotiate with -- so prefer
     * loadItem() when reverse playback matters.
     *
     * @async
     * @param {string} url - Media URL.
     * @returns {Promise<Object|null>} The loaded engine, or null on failure.
     */
    async loadUrl(url) {
        if (!this._checkWebCodecs()) {
            return null;
        }

        this._beginLoad();

        try {
            const rawSegmentCacheBudgetBytes = this._rawCacheBudgetBytes();
            const isHls = url.toLowerCase().includes('.m3u8');
            this.log(`Loading ${isHls ? 'HLS transcode stream' : 'URL by byte range'} ${url} ...`);
            this._closeCurrentEngine();

            this.currentItemId = null;
            this.currentQualityOption = null;
            this.engine = await createMarpVideoEngine(
                this.el.canvas,
                isHls
                    ? {
                          streamUrl: url,
                          rawSegmentCacheBudgetBytes,
                          // Jellyfin's transcoder answers one request at a
                          // time per session; more in flight makes them race
                          // its restarts. Byte-range sources have no such
                          // limit and take the engine's own default.
                          maxConcurrentFetches: 2,
                      }
                    : {
                          mediaSource: new UrlMediaSource({
                              url,
                              rawSegmentCacheBudgetBytes,
                              onDebug: (message) => this.log(message),
                              onError: (err) => this.log(`ERROR (media source): ${err.message}`),
                          }),
                      }
            );

            this.el.qualityList.innerHTML = '';
            const note = this.document.createElement('span');
            note.className = 'marp-status';
            note.textContent = isHls ? 'Stream URL - tiers are fixed by the server.' : 'Plain URL - no quality tiers.';
            this.el.qualityList.appendChild(note);

            this._afterLoad();
            this.applyLoadedUiState();
            return this.engine;
        } catch (err) {
            this.log(`ERROR loading URL: ${err.message}`);
            return null;
        } finally {
            this._endLoad();
        }
    }

    /**
     * Probes which quality tiers an item has, without loading it -- lets a
     * consumer pick a tier (e.g. force the transcode path) before calling
     * loadItem().
     *
     * @async
     * @param {string} itemId - Jellyfin item id.
     * @returns {Promise<Object[]>} Tiers, Direct Play first when available.
     */
    async probeQualityOptions(itemId) {
        return this.probeSource.probeQualityOptions(itemId);
    }

    /**
     * Enables the transport and diagnostics controls once an engine is
     * running -- shared by both load paths, which need exactly this set.
     *
     * @private
     * @returns {void}
     */
    _enableTransportControls() {
        [
            this.el.playPause,
            this.el.centerPlay,
            this.el.stepBack,
            this.el.stepForward,
            this.el.speedInput,
            this.el.mute,
            this.el.fullscreen,
            this.el.rawCache,
            this.el.decodedCache,
            this.el.applyCache,
            this.el.readCache,
            this.el.dumpState,
        ].forEach((el) => {
            // Diagnostics elements are absent when showDiagnostics is off.
            if (el) {
                el.disabled = false;
            }
        });
    }

    /**
     * Reflects the client's current Jellyfin session in the login panel.
     *
     * @returns {void}
     */
    updateLoginStatus() {
        if (this.jellyfinClient.isAuthenticated()) {
            this.el.loginStatus.textContent = `Signed in to ${this.jellyfinClient.serverUrl}`;
            this.el.serverUrl.value = this.jellyfinClient.serverUrl;
        } else {
            this.el.loginStatus.textContent = 'Not signed in.';
        }
    }

    /**
     * Fills blank login fields from `options.prefill`, leaving a real
     * session's own values alone.
     *
     * @private
     * @returns {void}
     */
    _applyPrefill() {
        const prefill = this.options.prefill;
        if (!prefill) {
            return;
        }
        if (prefill.serverUrl && !this.el.serverUrl.value) {
            this.el.serverUrl.value = prefill.serverUrl;
        }
        if (prefill.username && !this.el.username.value) {
            this.el.username.value = prefill.username;
        }
        if (prefill.password && !this.el.password.value) {
            this.el.password.value = prefill.password;
        }
    }

    /**
     * Renders the quality-tier picker for the item just probed.
     *
     * @param {Object[]} options - Tiers from probeQualityOptions().
     * @param {Object} selected - The currently active tier.
     * @returns {void}
     */
    buildQualityOptionsMenu(options, selected) {
        this.el.qualityList.innerHTML = '';

        for (const option of options) {
            const button = this.document.createElement('button');
            button.type = 'button';
            button.className = 'marp-quality-option quality-option';
            button.classList.toggle('selected', option.name === (selected && selected.name));
            button.textContent = option.name;
            button.addEventListener('click', () => {
                const itemId = this.el.itemId.value.trim() || this.currentItemId;
                if (itemId) {
                    this.loadItem(itemId, option);
                }
            });
            this.el.qualityList.appendChild(button);
        }
    }

    /**
     * Applies the UI state a freshly-loaded (and always-paused-until-play)
     * engine should show: hide the placeholder mark, reveal the center-play
     * overlay, and show real time/duration instead of the "--:--" placeholder.
     *
     * @returns {void}
     */
    applyLoadedUiState() {
        this.el.logo.style.display = 'none';
        this.el.centerOverlay.classList.remove('marp-hidden');
        this.el.time.textContent = `${formatTime(this.engine.currentTime)} / ${formatTime(this.engine.duration)}`;
        this.updateScrubHandle(this.engine.currentTime);
    }

    /**
     * Wires the loaded engine's events and frame callback to the transport
     * controls, scrub bar, spinner and log.
     *
     * @private
     * @returns {void}
     */
    _wireEngineEvents() {
        const engine = this.engine;

        ['loadedmetadata', 'durationchange', 'resize', 'playing', 'pause'].forEach((type) => {
            engine.addEventListener(type, () => this.log(`event: ${type}`));
        });

        // seeking/seeked carry where the seek is headed and where it landed,
        // so "did the seek land somewhere unexpected" is visible directly.
        engine.addEventListener('seeking', (event) => {
            this.log(`event: seeking targetTime=${event.targetTime.toFixed(3)} targetSegment=${event.segmentIndex}`);
        });
        engine.addEventListener('seeked', (event) => {
            this.log(
                `event: seeked targetTime=${event.targetTime.toFixed(3)} landedTime=${event.currentTime.toFixed(3)} ` +
                    `segment=${event.segmentIndex} frameIndex=${event.frameIndex}`
            );
        });

        // Buffering spinner: shown whenever playback or a seek is blocked on
        // network (Tier 1) or decode (Tier 2), colored to match the scrub
        // bar's fetched=blue/decoded=green convention.
        engine.addEventListener('waiting', (event) => {
            this.log(`event: waiting reason=${event.reason}`);
            this.el.spinner.classList.remove('marp-hidden');
            this.el.spinner.classList.toggle('decoding', event.reason === 'decoding');
        });

        // Logs the real Error's message: the shim dispatches the actual error
        // object, and discarding it hides the one detail that tells one
        // failure apart from another.
        engine.addEventListener('error', (event) => {
            this.log(`event: error -- ${event.error ? event.error.message : '(no detail)'}`);
        });

        // Segment fetch/decode progress straight from frame-store.js --
        // answers "what is being downloaded/decoded right now".
        engine.addEventListener('debug', (event) => this.log(event.message));

        // Called directly, not only via the listener: createMarpVideoEngine()
        // dispatches loadedmetadata before it returns the engine, so by the
        // time this runs the event is already gone for good (matching real
        // EventTarget semantics -- no replay for late listeners). Without the
        // direct call the placeholder mark and center-play overlay never
        // appear. The listener stays for any later re-fire.
        this.applyLoadedUiState();
        engine.addEventListener('loadedmetadata', () => this.applyLoadedUiState());

        engine.addEventListener('playing', () => {
            this.el.playPause.innerHTML = '&#10074;&#10074;';
            this.el.centerOverlay.classList.add('marp-hidden');
            this.el.spinner.classList.add('marp-hidden');
        });

        // Unblocked while paused (e.g. a cold seek landed): clear the spinner
        // only -- the transport must keep showing paused.
        engine.addEventListener('canplay', () => {
            this.el.spinner.classList.add('marp-hidden');
        });

        engine.addEventListener('pause', () => {
            this.el.playPause.innerHTML = '&#9654;';
            this.el.centerOverlay.classList.remove('marp-hidden');
            this.showControlsBar();
        });

        let frameLogCounter = 0;

        const onFrame = (now, metadata) => {
            // A stale callback from a replaced engine must not drive this
            // UI's time display or re-register itself.
            if (this.engine !== engine) {
                return;
            }

            this.lastFrameMetadata = metadata;
            frameLogCounter += 1;
            if (frameLogCounter % 10 === 0) {
                this.log(
                    `frame #${metadata.presentedFrames} mediaTime=${metadata.mediaTime.toFixed(3)} ` +
                        `raw=${Number.isFinite(metadata.rawFrameTime) ? metadata.rawFrameTime.toFixed(3) : 'na'} ` +
                        `segment=${metadata.segmentIndex} frameIdx=${metadata.frameIndex} rate=${engine.playbackRate}`
                );
            }

            if (!this.scrubDragging) {
                this.updateScrubHandle(metadata.mediaTime);
            }
            this.el.time.textContent = `${formatTime(metadata.mediaTime)} / ${formatTime(engine.duration)}`;

            engine.requestVideoFrameCallback(onFrame);
        };

        engine.requestVideoFrameCallback(onFrame);
    }

    /**
     * Moves the scrub handle to a media time.
     *
     * @param {number} mediaTime - Seconds.
     * @returns {void}
     */
    updateScrubHandle(mediaTime) {
        const duration = this.engine ? this.engine.duration : NaN;
        const fraction = duration > 0 ? Math.min(1, Math.max(0, mediaTime / duration)) : 0;
        this.el.scrubHandle.style.left = `${fraction * 100}%`;
    }

    /**
     * Builds one absolutely-positioned block per segment on the scrub track,
     * sized by each segment's real duration -- once per load, since segment
     * count and durations never change afterward.
     *
     * @param {Object[]} segmentStates - From getSegmentStates().
     * @returns {void}
     */
    buildSegmentBlocks(segmentStates) {
        this.el.scrubBg.innerHTML = '';
        const duration = this.engine.duration;

        for (const segment of segmentStates) {
            const block = this.document.createElement('div');
            block.className = 'marp-segment segment-block';
            block.dataset.index = String(segment.index);
            block.style.left = `${(segment.startTime / duration) * 100}%`;
            block.style.width = `${((segment.endTime - segment.startTime) / duration) * 100}%`;
            this.el.scrubBg.appendChild(block);
        }
    }

    /**
     * Re-reads segment fetch/decode/pin status and updates each block's
     * shading. Runs on a plain timer, independent of frame presentation.
     *
     * @returns {void}
     */
    updateSegmentShading() {
        if (!this.engine) {
            return;
        }

        for (const segment of this.engine.getSegmentStates()) {
            const block = this.el.scrubBg.querySelector(`[data-index="${segment.index}"]`);
            if (!block) {
                continue;
            }
            block.classList.toggle('fetched', segment.fetched);
            block.classList.toggle('decoded', segment.decoded);
            block.classList.toggle('pinned', segment.pinned);
        }
    }

    /**
     * Converts a pointer event's x position on the scrub track to a media
     * time.
     *
     * @private
     * @param {PointerEvent} event - Pointer event on the track.
     * @returns {number} Seconds, clamped to [0, duration].
     */
    _scrubEventToTime(event) {
        const rect = this.el.scrubBg.getBoundingClientRect();
        const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
        return fraction * this.engine.duration;
    }

    /**
     * Toggles play/pause -- one control shared by the transport button, the
     * center overlay, the canvas click and the space key.
     *
     * @returns {void}
     */
    togglePlayPause() {
        if (!this.engine) {
            return;
        }
        if (this.engine.paused) {
            this.engine.play();
        } else {
            this.engine.pause();
        }
    }

    /**
     * Applies a playback rate and updates the readout -- the one choke point
     * the hotkeys and the manual override input both go through.
     *
     * @param {number} rate - New playback rate; negative plays in reverse.
     * @returns {void}
     */
    setPlaybackRate(rate) {
        if (!this.engine) {
            return;
        }
        this.engine.playbackRate = rate;
        this.el.speed.textContent = `${rate}x`;
        this.el.speedInput.value = String(rate);
        this.log(`playbackRate set to ${rate}`);
    }

    /**
     * Shows the controls bar and restarts the idle-hide timer while playing.
     * Always visible while paused, while the pointer is over the bar, or
     * while the settings menu is open.
     *
     * @returns {void}
     */
    showControlsBar() {
        this.el.controlsBar.classList.remove('marp-faded');
        if (this.controlsHideTimer) {
            clearTimeout(this.controlsHideTimer);
        }
        if (this.engine && !this.engine.paused) {
            this.controlsHideTimer = setTimeout(() => {
                if (!this.pointerOverControlsBar && !this.settingsMenuOpen) {
                    this.el.controlsBar.classList.add('marp-faded');
                }
            }, CONTROLS_IDLE_HIDE_MS);
        }
    }

    /**
     * Toggles fullscreen on the player element.
     *
     * Exposed as a method, not left to the built-in button, so a host that
     * hides the controls can still offer fullscreen -- it is the one piece
     * of the transport that needs the player's own element rather than the
     * engine.
     *
     * @returns {Promise<void>} Resolves once the browser has applied the change.
     */
    toggleFullscreen() {
        if (this.document.fullscreenElement) {
            return this.document.exitFullscreen();
        }
        return this.root.requestFullscreen();
    }

    /**
     * Shows or hides the built-in controls at runtime.
     *
     * For a host that draws its own transport, scrub bar and menus: hiding
     * leaves the picture, the buffering spinner and the placeholder mark,
     * and takes the controls out of the hit-testing and focus order so they
     * cannot intercept anything an overlay above them does.
     *
     * Note this does not change input handling on the video itself, which
     * is fixed at construction by the `input` option -- flipping controls
     * back on for a debugging session should not silently re-bind the
     * spacebar a host is already using.
     *
     * @param {boolean} visible - True to show the controls, false to hide them.
     * @returns {void}
     */
    setControlsVisible(visible) {
        this.controlsVisible = Boolean(visible);
        this.root.classList.toggle('marp-controls-off', !this.controlsVisible);
        if (!this.controlsVisible) {
            this.closeSettingsMenu();
        }
    }

    /**
     * Whether the built-in controls are currently shown.
     *
     * @returns {boolean} True when visible.
     */
    getControlsVisible() {
        return this.controlsVisible;
    }

    /**
     * Shows the open accordion section's body and hides the rest -- the gear
     * menu's whole navigation model. No "back" step exists because nothing
     * ever replaces anything else.
     *
     * @private
     * @returns {void}
     */
    _applyOpenSettingsSection() {
        this.el.settingsMenu.querySelectorAll('.marp-section-body').forEach((body) => {
            body.classList.toggle('marp-hidden', body.id !== this.openSettingsSectionId);
        });
        this.el.settingsMenu.querySelectorAll('.marp-section-header').forEach((header) => {
            header.classList.toggle('expanded', header.dataset.section === this.openSettingsSectionId);
        });
    }

    /** Opens the settings menu, keeping the transport visible while it is up. */
    openSettingsMenu() {
        this.settingsMenuOpen = true;
        this.el.settingsMenu.classList.add('open');
        this._applyOpenSettingsSection();
        this.showControlsBar();
    }

    /** Closes the settings menu. */
    closeSettingsMenu() {
        this.settingsMenuOpen = false;
        this.el.settingsMenu.classList.remove('open');
    }

    /** Toggles the settings menu. */
    toggleSettingsMenu() {
        if (this.settingsMenuOpen) {
            this.closeSettingsMenu();
            return;
        }
        this.openSettingsMenu();
    }

    /**
     * Reads the engine's real cache configuration back into the Advanced
     * inputs and logs it.
     *
     * @returns {void}
     */
    syncCacheSettingsFromEngine() {
        if (!this.engine || typeof this.engine.getCacheConfig !== 'function' || !this.el.rawCache) {
            return;
        }

        const cache = this.engine.getCacheConfig();
        this.el.rawCache.value = (cache.raw.maxRawCacheBytes / BYTES_PER_GIB).toFixed(2);
        this.el.decodedCache.value = (cache.decoded.cacheBudgetBytes / BYTES_PER_GIB).toFixed(2);
        this.log(
            `cache config raw=${(cache.raw.cachedRawBytes / BYTES_PER_GIB).toFixed(2)}GiB/${(cache.raw.maxRawCacheBytes / BYTES_PER_GIB).toFixed(2)}GiB ` +
                `decoded=${cache.decoded.cachedDecodedSegments}/${cache.decoded.maxSegmentsBuffered} ` +
                `budgetGiB=${(cache.decoded.cacheBudgetBytes / BYTES_PER_GIB).toFixed(2)}`
        );
    }

    /**
     * Logs a full snapshot of playback position, cache configuration and
     * per-segment fetch/decode/pin state.
     *
     * @returns {Object|null} The snapshot, also logged as JSON.
     */
    dumpEngineState() {
        if (!this.engine) {
            this.log('dump-state: no active engine');
            return null;
        }

        const segmentStates = this.engine.getSegmentStates();
        const fetchedSegments = segmentStates.filter((segment) => segment.fetched).map((segment) => segment.index);
        const decodedSegments = segmentStates.filter((segment) => segment.decoded).map((segment) => segment.index);
        const pinnedSegments = segmentStates.filter((segment) => segment.pinned).map((segment) => segment.index);

        // Demuxed and decoded are the same persistence tier today --
        // demux-only buffers are not retained separately.
        const demuxedSegments = [...decodedSegments];

        const cacheConfig =
            typeof this.engine.getCacheConfig === 'function' ? this.engine.getCacheConfig() : { raw: null, decoded: null };
        const debugState = typeof this.engine.getDebugState === 'function' ? this.engine.getDebugState() : null;
        const frame = this.lastFrameMetadata;

        /**
         * Prefers the engine's own debug state, falling back to the last
         * presented frame's metadata.
         *
         * @param {string} stateKey - Field on getDebugState().
         * @param {string} frameKey - Field on the frame metadata.
         * @returns {number|null} The value, or null when neither has it.
         */
        const pick = (stateKey, frameKey) => {
            if (debugState && Number.isFinite(debugState[stateKey])) {
                return debugState[stateKey];
            }
            if (frame && Number.isFinite(frame[frameKey])) {
                return frame[frameKey];
            }
            return null;
        };

        const currentSegmentIndex = pick('currentSegmentIndex', 'segmentIndex');

        const snapshot = {
            takenAt: new Date().toISOString(),
            playback: {
                currentTime: this.engine.currentTime,
                duration: this.engine.duration,
                playbackRate: this.engine.playbackRate,
                paused: this.engine.paused,
                seeking: this.engine.seeking,
                currentSegmentIndex,
                currentFrameIndex: pick('currentFrameIdx', 'frameIndex'),
                currentRawFrameTime: pick('currentRawFrameTime', 'rawFrameTime'),
            },
            debugState,
            cacheConfig,
            segmentStateCounts: {
                total: segmentStates.length,
                fetched: fetchedSegments.length,
                decoded: decodedSegments.length,
                demuxed: demuxedSegments.length,
                pinned: pinnedSegments.length,
            },
            fetchedSegments,
            fetchedRanges: listToRanges(fetchedSegments),
            decodedSegments,
            decodedRanges: listToRanges(decodedSegments),
            demuxedSegments,
            demuxedRanges: listToRanges(demuxedSegments),
            pinnedSegments,
            pinnedRanges: listToRanges(pinnedSegments),
            neighborhood: segmentStates
                .filter((segment) => Number.isFinite(currentSegmentIndex) && Math.abs(segment.index - currentSegmentIndex) <= 5)
                .map((segment) => ({
                    index: segment.index,
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                    fetched: segment.fetched,
                    decoded: segment.decoded,
                    pinned: segment.pinned,
                })),
        };

        this.log('dump-state: BEGIN');
        this.log(JSON.stringify(snapshot, null, 2));
        this.log('dump-state: END');
        return snapshot;
    }

    /**
     * Wires every control. Listeners are registered on this player's own
     * elements, except the one document-level pointerdown that closes the
     * settings menu on an outside click -- tracked so destroy() removes it.
     *
     * @private
     * @returns {void}
     */
    _wireControls() {
        const el = this.el;

        el.load.addEventListener('click', () => {
            const itemId = el.itemId.value.trim();
            if (!itemId) {
                this.log('ERROR: enter a Jellyfin item id first.');
                return;
            }
            this.loadItem(itemId, null);
        });

        el.localFile.addEventListener('change', () => {
            const file = el.localFile.files && el.localFile.files[0];
            if (file) {
                this.loadFile(file);
            }
        });

        // Input on the video itself is opt-out: a host with its own controls
        // (and, typically, its own overlay on top of the picture) owns all
        // of this, and a stray drop or click here would fight it -- a
        // dropped file would replace what the host loaded.
        if (this.inputEnabled) {
            // Listen on the root, not the canvas. The centre overlay is
            // `position: absolute; inset: 0`, so it covers the canvas
            // completely -- and it is shown until the first frame is
            // presented, which is exactly the state you are in when dropping
            // a file to load one. A drop aimed at the video landed on the
            // overlay, where nothing handled it, and since dragover was not
            // prevented there either the browser navigated to the file
            // instead. Listening on the root catches the drop wherever it
            // lands, whatever is layered on top.
            this.root.addEventListener('dragover', (event) => {
                // Must be prevented, or the browser navigates to the dropped
                // file rather than handing it over.
                event.preventDefault();
                if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
                this.root.classList.add('marp-drag-over');
            });

            // dragleave fires when moving between children too, so only clear
            // the state when the pointer has actually left the player.
            this.root.addEventListener('dragleave', (event) => {
                if (!this.root.contains(event.relatedTarget)) {
                    this.root.classList.remove('marp-drag-over');
                }
            });

            this.root.addEventListener('drop', (event) => {
                event.preventDefault();
                this.root.classList.remove('marp-drag-over');
                const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
                if (file) {
                    this.loadFile(file);
                }
            });
        }

        el.login.addEventListener('click', async () => {
            const serverUrl = el.serverUrl.value.trim();
            const username = el.username.value.trim();
            const password = el.password.value;

            if (!serverUrl || !username || !password) {
                this.log('ERROR: server URL, username, and password are all required.');
                return;
            }

            try {
                await this.jellyfinClient.login(serverUrl, username, password);
                el.password.value = '';
                this.updateLoginStatus();
                this.log(`Signed in to ${serverUrl} as ${username}.`);
            } catch (err) {
                this.log(`ERROR signing in: ${err.message}`);
            }
        });

        el.logout.addEventListener('click', () => {
            this.jellyfinClient.logout();
            this.updateLoginStatus();
            this.log('Signed out.');
        });

        el.settingsButton.addEventListener('click', (event) => {
            event.stopPropagation();
            this.toggleSettingsMenu();
        });

        // Keeps clicks inside the menu from reaching the player.
        el.settingsMenu.addEventListener('click', (event) => event.stopPropagation());

        el.settingsMenu.querySelectorAll('.marp-section-header').forEach((header) => {
            header.addEventListener('click', () => {
                this.openSettingsSectionId =
                    header.dataset.section === this.openSettingsSectionId ? null : header.dataset.section;
                this._applyOpenSettingsSection();
            });
        });

        this._onDocumentPointerDown = (event) => {
            if (!this.settingsMenuOpen) {
                return;
            }
            if (el.settingsMenu.contains(event.target) || el.settingsButton.contains(event.target)) {
                return;
            }
            this.closeSettingsMenu();
        };
        this.document.addEventListener('pointerdown', this._onDocumentPointerDown);

        // Commit-on-release: dragging only moves the handle and tooltip; the
        // real seek fires once, on pointerup. Deliberately not a seek per
        // pointermove -- with no trickplay preview yet that buys no visual
        // benefit, only real fetch/decode work for every position dragged
        // over, plus engine-side cancellation with its own sharp edges. It
        // also matches the annotation tool's own slider UX.
        el.scrubTrack.addEventListener('pointerdown', (event) => {
            if (!this.engine) {
                return;
            }
            this.scrubDragging = true;
            el.scrubTrack.setPointerCapture(event.pointerId);
            this.lastScrubTime = this._scrubEventToTime(event);
            this.updateScrubHandle(this.lastScrubTime);
        });

        el.scrubTrack.addEventListener('pointermove', (event) => {
            if (!this.engine) {
                return;
            }
            const time = this._scrubEventToTime(event);
            const rect = el.scrubBg.getBoundingClientRect();

            el.scrubTooltip.style.display = 'block';
            el.scrubTooltip.style.left = `${((event.clientX - rect.left) / rect.width) * 100}%`;
            el.scrubTooltip.textContent = formatTime(time);

            if (this.scrubDragging) {
                this.lastScrubTime = time;
                this.updateScrubHandle(time);
            }
        });

        el.scrubTrack.addEventListener('pointerleave', () => {
            el.scrubTooltip.style.display = 'none';
        });

        el.scrubTrack.addEventListener('pointerup', (event) => {
            this.scrubDragging = false;
            el.scrubTrack.releasePointerCapture(event.pointerId);
            if (!this.engine) {
                return;
            }
            this.engine.currentTime = this.lastScrubTime;
        });

        const toggle = () => this.togglePlayPause();
        el.playPause.addEventListener('click', toggle);
        el.centerPlay.addEventListener('click', toggle);
        if (this.inputEnabled) {
            el.canvas.addEventListener('click', toggle);
        }

        el.stepForward.addEventListener('click', () => {
            if (this.engine) {
                this.engine.currentTime = this.engine.currentTime + 1 / this.engine.fps;
            }
        });

        el.stepBack.addEventListener('click', () => {
            if (this.engine) {
                this.engine.currentTime = Math.max(0, this.engine.currentTime - 1 / this.engine.fps);
            }
        });

        el.speedInput.addEventListener('change', (event) => {
            const rate = parseFloat(event.target.value);
            if (!Number.isNaN(rate)) {
                this.setPlaybackRate(rate);
            }
        });

        el.mute.addEventListener('click', () => {
            if (!this.engine) {
                return;
            }
            // Inert today (audio decode is not implemented yet) but wired
            // through, so this button needs no change once audio lands.
            this.engine.muted = !this.engine.muted;
            el.mute.innerHTML = this.engine.muted ? '&#128263;' : '&#128266;';
        });

        el.fullscreen.addEventListener('click', () => {
            this.toggleFullscreen();
        });

        if (el.applyCache) {
            el.applyCache.addEventListener('click', () => {
                if (!this.engine) {
                    return;
                }
                const rawBytes = Math.floor(parseFloat(el.rawCache.value) * BYTES_PER_GIB);
                const decodedBytes = Math.floor(parseFloat(el.decodedCache.value) * BYTES_PER_GIB);

                try {
                    const rawConfig = this.engine.setRawSegmentCacheBudgetBytes(rawBytes);
                    const decodedConfig = this.engine.setDecodedCacheBudgetBytes(decodedBytes);
                    this.log(
                        `cache settings applied raw=${(rawConfig.cachedRawBytes / BYTES_PER_GIB).toFixed(2)}GiB/${(rawConfig.maxRawCacheBytes / BYTES_PER_GIB).toFixed(2)}GiB ` +
                            `decoded=${decodedConfig.cachedDecodedSegments}/${decodedConfig.maxSegmentsBuffered} ` +
                            `budgetGiB=${(decodedConfig.cacheBudgetBytes / BYTES_PER_GIB).toFixed(2)}`
                    );
                } catch (err) {
                    this.log(`ERROR applying cache settings: ${err.message}`);
                }
            });

            el.readCache.addEventListener('click', () => this.syncCacheSettingsFromEngine());
            el.dumpState.addEventListener('click', () => this.dumpEngineState());
        }

        this.root.addEventListener('pointermove', () => this.showControlsBar());
        el.controlsBar.addEventListener('pointerenter', () => {
            this.pointerOverControlsBar = true;
            this.showControlsBar();
        });
        el.controlsBar.addEventListener('pointerleave', () => {
            this.pointerOverControlsBar = false;
            this.showControlsBar();
        });

        // Hotkeys fire only while the player itself has focus (see the root's
        // tabIndex), so typing in the settings fields is never hijacked.
        // Skipped entirely when input is off: space and q..\\ are exactly the
        // keys a host is likely to bind itself, and both firing is worse
        // than neither.
        if (!this.inputEnabled) {
            return;
        }

        this.root.addEventListener('keydown', (event) => {
            if (event.key === 'Escape' && this.settingsMenuOpen) {
                this.closeSettingsMenu();
                return;
            }
            if (!this.engine) {
                return;
            }

            if (event.key === ' ') {
                event.preventDefault();
                this.togglePlayPause();
                return;
            }

            const rate = SPEED_KEYMAP[event.key];
            if (rate !== undefined) {
                event.preventDefault();
                this.setPlaybackRate(rate);
                // A speed hotkey always starts playback: these keys are for
                // actively scrubbing at that rate, not arming a rate for
                // later. Scoped to the hotkeys, so the manual override
                // input's own behaviour (set rate, leave play state alone)
                // is unchanged.
                this.engine.play();
            }
        });
    }

    /**
     * Closes the engine, stops timers, removes the document-level listener
     * and empties the container.
     *
     * @returns {void}
     */
    destroy() {
        if (this.segmentShadingHandle) {
            clearInterval(this.segmentShadingHandle);
            this.segmentShadingHandle = null;
        }
        if (this.controlsHideTimer) {
            clearTimeout(this.controlsHideTimer);
            this.controlsHideTimer = null;
        }
        if (this._onDocumentPointerDown) {
            this.document.removeEventListener('pointerdown', this._onDocumentPointerDown);
            this._onDocumentPointerDown = null;
        }
        this._closeCurrentEngine();
        this.container.innerHTML = '';
    }
}

// Delegates the <video>-shaped surface to whichever engine is loaded, so a
// consumer holds one object across item and quality changes -- each of
// which replaces the engine underneath. Defined from a table rather than
// written out, so this stays in step with MarpVideoShim by name.
const READ_ONLY_ENGINE_PROPERTIES = ['duration', 'videoWidth', 'videoHeight', 'fps', 'paused', 'seeking', 'ended'];
const WRITABLE_ENGINE_PROPERTIES = ['currentTime', 'playbackRate', 'muted', 'volume'];
const DELEGATED_ENGINE_METHODS = [
    'play',
    'pause',
    'addEventListener',
    'removeEventListener',
    'requestVideoFrameCallback',
    'getSegmentStates',
    'getCacheConfig',
    'getDebugState',
    'setRawSegmentCacheBudgetBytes',
    'setDecodedCacheBudgetBytes',
];

for (const name of READ_ONLY_ENGINE_PROPERTIES) {
    Object.defineProperty(MarpVideoPlayer.prototype, name, {
        get() {
            return this.engine ? this.engine[name] : undefined;
        },
    });
}

for (const name of WRITABLE_ENGINE_PROPERTIES) {
    Object.defineProperty(MarpVideoPlayer.prototype, name, {
        get() {
            return this.engine ? this.engine[name] : undefined;
        },
        set(value) {
            if (this.engine) {
                this.engine[name] = value;
            }
        },
    });
}

for (const name of DELEGATED_ENGINE_METHODS) {
    Object.defineProperty(MarpVideoPlayer.prototype, name, {
        value(...args) {
            if (!this.engine) {
                return undefined;
            }
            return this.engine[name](...args);
        },
    });
}

/**
 * Builds a complete video player -- picture, transport controls, scrub bar,
 * spinner and settings -- inside `container`.
 *
 * @param {HTMLElement} container - Element to build the player inside. Emptied first.
 * @param {Object} [options] - See {@link MarpVideoPlayer}.
 * @returns {MarpVideoPlayer} The player. Loading is asynchronous; await `loadItem()`/`loadFile()` when the caller needs the engine.
 */
export function createMarpVideoPlayer(container, options) {
    return new MarpVideoPlayer(container, options);
}
