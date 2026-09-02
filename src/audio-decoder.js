/**
 * Decodes a unit's audio using the browser's own decoder.
 *
 * The audio counterpart of gop-decoder.js only in position, not in method. The
 * video is decoded with WebCodecs because this player needs individual frames
 * on demand, forwards and backwards. Audio needs nothing of the sort, and
 * decoding it the same way turned out to be actively harmful: the WebCodecs
 * audio decoder waits inside the platform's media pipeline behind the video
 * decoder, and decoding one second of this media's audio was measured taking
 * ~4400 ms that way against 36-78 ms through `decodeAudioData` under identical
 * load. Issue #6 records the whole investigation.
 *
 * That difference matters more for audio than the equivalent would for video.
 * A late frame freezes the picture and nothing is lost; a late sample is
 * silence for ever, because the output device has already passed that moment.
 *
 * So: frame the AAC as ADTS (seven bytes per frame, see audio-adts.js) and hand
 * it to `decodeAudioData`, which decodes off the main thread and returns one
 * ready-to-schedule `AudioBuffer`.
 *
 * @fileoverview Per-unit audio decode through decodeAudioData.
 * @author Isaac Travers
 * @module video-engine/audio-decoder
 */

import { readAdtsFields, frameAdts } from './audio-adts.js';

/**
 * Decodes audio units into AudioBuffers.
 *
 * @class AudioUnitDecoder
 */
export class AudioUnitDecoder {
    /**
     * @param {Object} params
     * @param {function(): ?AudioContext} params.getContext - Returns the context to decode with, creating it if need be. Decoding does not require a running context, so a suspended one is fine.
     */
    constructor({ getContext }) {
        this.getContext = getContext;
        this._queue = Promise.resolve();

        // Cached per codec configuration, because reading it is pure parsing and
        // the configuration does not change within a stream.
        this._fields = null;
        this._fieldsFor = null;
    }

    /**
     * Decodes one unit's audio.
     *
     * Serialised, like the video decoder's own queue: several units decoding at
     * once would compete for exactly the resource this design exists to stop
     * competing for.
     *
     * @param {number} unitIndex - Unit index this audio belongs to.
     * @param {Object} audioResult - A media source's `fetchAudioChunks()` result.
     * @returns {Promise<{unitIndex: number, sampleRate: number, numberOfChannels: number, startTime: number, duration: number, buffer: ?AudioBuffer}>} The decoded unit.
     * @throws {Error} When the audio cannot be framed or the browser refuses to decode it.
     */
    decodeUnit(unitIndex, audioResult) {
        const result = this._queue.then(() => this._decodeUnitNow(unitIndex, audioResult));

        // Keep the queue alive even if this unit fails, so a later, unrelated
        // unit is not blocked by this one's rejection.
        this._queue = result.then(
            () => undefined,
            () => undefined
        );

        return result;
    }

    /**
     * @async
     * @param {number} unitIndex - Unit index this audio belongs to.
     * @param {Object} audioResult - As passed to {@link AudioUnitDecoder#decodeUnit}.
     * @returns {Promise<Object>} The decoded unit.
     */
    async _decodeUnitNow(unitIndex, audioResult) {
        const { chunks, description, codec, sampleRate, numberOfChannels } = audioResult;

        const empty = {
            unitIndex,
            sampleRate,
            numberOfChannels,
            startTime: 0,
            duration: 0,
            buffer: null,
        };

        if (!chunks || chunks.length === 0) {
            return empty;
        }

        const context = this.getContext();
        if (!context) {
            throw new Error('No audio context is available to decode with.');
        }

        const fields = this._adtsFields(codec, description);
        if (!fields) {
            throw new Error(`Audio (${codec}) cannot be framed as ADTS; its configuration is not one ADTS can express.`);
        }

        const framed = frameAdts(chunks, fields);
        if (!framed) {
            return empty;
        }

        // decodeAudioData detaches the buffer it is given, which is why the
        // framed bytes are built fresh for every call and never reused.
        const buffer = await context.decodeAudioData(framed.buffer);

        // The unit's position comes from the chunks, not from the decoded
        // buffer: `decodeAudioData` knows nothing about where in the media this
        // audio sits, and resamples to the context's rate on the way out.
        const startTime = chunks[0].timestamp / 1e6;

        return {
            unitIndex,
            sampleRate: buffer.sampleRate,
            numberOfChannels: buffer.numberOfChannels,
            startTime,
            duration: buffer.duration,
            buffer,
        };
    }

    /**
     * Reads and caches the ADTS header fields for this stream's configuration.
     *
     * @param {string} codec - RFC 6381 codec string.
     * @param {Uint8Array|null} description - AudioSpecificConfig bytes.
     * @returns {?Object} The fields, or null when this audio cannot be framed.
     */
    _adtsFields(codec, description) {
        const key = `${codec}:${description ? description.length : 0}`;

        if (this._fieldsFor !== key) {
            this._fields = readAdtsFields(description);
            this._fieldsFor = key;
        }

        return this._fields;
    }

    /**
     * Nothing to release: the context belongs to whoever supplied it, and
     * decoded buffers are released by the cache that holds them.
     *
     * Kept so the shape matches gop-decoder.js and callers need not care which
     * decoder is underneath.
     *
     * @returns {void}
     */
    close() {}
}
