/**
 * Media source for an MP4 served over HTTP at a plain URL.
 *
 * The generic byte-range source: it needs nothing but an address, so it
 * covers Jellyfin Direct Play (`/Videos/{id}/stream?static=true`), a local
 * file exposed through a WebView2 virtual-host folder mapping, and any
 * other static MP4 an embedder can reach. Requires the server to honour
 * Range requests, which both of those do (verified: WebView2's virtual host
 * answers 206 with a correct Content-Range).
 *
 * Use LocalFileMediaSource instead when the media arrives as a File from a
 * picker or drag-and-drop, and JellyfinDirectPlayMediaSource when a
 * logged-in client is on hand to build the URL and report playback.
 *
 * @fileoverview Byte-range media source for an arbitrary MP4 URL.
 * @module video-engine/media-source-url
 */

import { Mp4ByteRangeMediaSource } from './media-source-mp4-byte-range.js';

/**
 * Plays an MP4 from a URL that supports byte ranges.
 *
 * @class UrlMediaSource
 * @augments Mp4ByteRangeMediaSource
 */
export class UrlMediaSource extends Mp4ByteRangeMediaSource {
    /**
     * @param {Object} params
     * @param {string} params.url - URL of the MP4. Must honour HTTP Range requests.
     * @param {Object} [params.options] - Remaining options, forwarded to {@link Mp4ByteRangeMediaSource}.
     */
    constructor({ url, ...options }) {
        super(options);
        this.url = url;
    }

    /** @returns {string} The URL this source reads byte ranges from. */
    get streamUrl() {
        return this.url;
    }
}
