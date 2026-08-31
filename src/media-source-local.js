/**
 * Media source for a local file the user picked or dropped onto the player.
 *
 * Needs no server at all: an object URL over the File honours Range
 * requests (verified in Chromium -- 206 with a correct Content-Range), so
 * this reuses the same byte-range reading, indexing and chunk assembly as
 * Direct Play. It takes a File/Blob and knows nothing about how it was
 * obtained, so a picker, a drag-and-drop, or a host handing one in all work
 * the same way.
 *
 * @fileoverview The local-file media source.
 * @module video-engine/media-source-local
 */

import { Mp4ByteRangeMediaSource } from './media-source-mp4-byte-range.js';

/**
 * Plays an MP4 straight off the user's disk.
 *
 * @class LocalFileMediaSource
 * @augments Mp4ByteRangeMediaSource
 */
export class LocalFileMediaSource extends Mp4ByteRangeMediaSource {
    /**
     * @param {Object} params
     * @param {File|Blob} params.file - The file to play.
     * @param {Object} [params.options] - Remaining options, forwarded to {@link Mp4ByteRangeMediaSource}.
     */
    constructor({ file, ...options }) {
        super(options);
        this.file = file;
        this.name = (file && file.name) || 'local file';
        this._objectUrl = null;
    }

    /** An object URL over the File; created once and revoked by close(). */
    get streamUrl() {
        if (!this._objectUrl) {
            this._objectUrl = URL.createObjectURL(this.file);
        }
        return this._objectUrl;
    }

    /**
     * Releases the object URL. Without this the File stays retained for the
     * lifetime of the document, which matters when loading several in a row.
     *
     * @returns {void}
     */
    close() {
        if (this._objectUrl) {
            URL.revokeObjectURL(this._objectUrl);
            this._objectUrl = null;
        }
    }
}
