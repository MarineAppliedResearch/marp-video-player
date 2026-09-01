/**
 * Public entry point for the video-engine package.
 *
 * Two levels of API, and a consumer picks one:
 *
 *   createMarpVideoPlayer(container, options)
 *     A complete video player -- picture, transport controls, scrub bar,
 *     spinner, and a settings menu covering sign-in, item loading, quality
 *     and diagnostics -- built inside `container`. This is the whole point
 *     of the package: one call, a working player, in a browser or inside a
 *     WebView2 host, from this one bundle.
 *
 *   createMarpVideoEngine(canvas, options)
 *     Picture and a <video>-shaped API only, for a consumer that draws its
 *     own interface.
 *
 * @fileoverview Package barrel: the player, the engine, and the pieces both build on.
 * @author Isaac Travers
 * @module video-engine
 */

import { createMarpVideoEngine } from './engine.js';
import { createMarpVideoPlayer, MarpVideoPlayer, SPEED_KEYMAP } from './ui/player-ui.js';
import { JellyfinTranscodeMediaSource, JellyfinMediaSource } from './media-source-jellyfin-transcode.js';
import { JellyfinDirectPlayMediaSource } from './media-source-jellyfin-directplay.js';
import { LocalFileMediaSource } from './media-source-local.js';
import { UrlMediaSource } from './media-source-url.js';
import { createJellyfinSource } from './media-source-jellyfin.js';
import { attachWebView2Bridge } from './webview2-bridge.js';
import { JellyfinClient } from './jellyfin-client.js';
import { MediaSource } from './media-source.js';
import { getQualityOptions } from './quality-options.js';
import { PLAYER_CSS } from './ui/styles.js';
import { encodeSegmentStates, encodeSegmentGeometry, SEGMENT_FETCHED, SEGMENT_DECODED, SEGMENT_PINNED } from './segment-encoding.js';

/**
 * This build's version, matching the published package version.
 *
 * Replaced at build time by build.js. Outside a build -- running the source
 * directly, or under the unit tests -- there is no version to report, so it
 * reads "dev". `typeof` rather than a bare reference, because the identifier
 * genuinely does not exist then.
 *
 * @constant
 * @type {string}
 */
export const VERSION = typeof __MARP_VERSION__ === 'undefined' ? 'dev' : __MARP_VERSION__;

export {
    createMarpVideoPlayer,
    MarpVideoPlayer,
    SPEED_KEYMAP,
    createMarpVideoEngine,
    attachWebView2Bridge,
    JellyfinClient,
    MediaSource,
    JellyfinMediaSource,
    JellyfinTranscodeMediaSource,
    JellyfinDirectPlayMediaSource,
    LocalFileMediaSource,
    UrlMediaSource,
    createJellyfinSource,
    getQualityOptions,
    PLAYER_CSS,
    encodeSegmentStates,
    encodeSegmentGeometry,
    SEGMENT_FETCHED,
    SEGMENT_DECODED,
    SEGMENT_PINNED,
};
