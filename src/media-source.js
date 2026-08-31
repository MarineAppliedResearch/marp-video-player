/**
 * MediaSource abstraction: resolves an item reference to a playable stream
 * URL (what createMarpVideoEngine actually needs) and, where applicable,
 * reports playback state back to the origin server.
 *
 * The base interface only. Each source implementation lives in its own
 * file -- media-source-jellyfin-transcode.js today, with local-file and
 * Direct Play sources to follow.
 *
 * @fileoverview Base interface for the pluggable media sources.
 */

/**
 * Base interface. Subclasses override resolveStreamUrl (required) and the
 * three reporting methods (optional -- default to no-ops, since not every
 * source has a remote session to report to).
 */
export class MediaSource {
    /**
     * Resolves an item reference + quality tier to a playable stream URL.
     *
     * @async
     * @param {string} itemId - Source-specific item reference.
     * @param {Object} [qualityOption] - A tier from this source's own quality options (if any).
     * @returns {Promise<string>} A URL createMarpVideoEngine can load.
     */
    async resolveStreamUrl(itemId, qualityOption) {
        throw new Error('resolveStreamUrl is not implemented for this MediaSource.');
    }

    /**
     * Resolves a second, independent stream URL dedicated to serving
     * segments behind the current seek anchor, started at
     * `startTimeSeconds` -- optional, called once per seek by the caller
     * (see the video-engine shim's `setBehindSession`). `undefined` means
     * single-session mode: every segment is fetched from
     * `resolveStreamUrl`'s one session regardless of direction,
     * appropriate for a source that supports true random access (e.g. a
     * static file server) and so has no "direction" cost to avoid.
     *
     * @async
     * @param {string} itemId - Source-specific item reference.
     * @param {Object} [qualityOption] - A tier from this source's own quality options (if any).
     * @param {number} [startTimeSeconds] - Absolute position (seconds) the returned URL's session should start from.
     * @returns {Promise<string|undefined>} A second URL createMarpVideoEngine can load, or undefined for single-session mode.
     */
    async resolveBehindStreamUrl(itemId, qualityOption, startTimeSeconds) {
        return undefined;
    }

    /**
     * Ceiling on simultaneously in-flight raw segment fetches this source
     * can safely tolerate, passed straight through to
     * createMarpVideoEngine's own `maxConcurrentFetches` option.
     * `undefined` here means "let the engine use its own default" (full
     * concurrency), appropriate for a source that supports true random
     * access, e.g. a static file server. A source backed by a single
     * sequential live producer must override this with a much lower value
     * -- see {@link JellyfinMediaSource#maxConcurrentFetches}.
     *
     * @returns {number|undefined} Concurrent-fetch ceiling, or undefined for the engine's own default.
     */
    get maxConcurrentFetches() {
        return undefined;
    }

    /** @param {string} itemId @param {Object} context @returns {Promise<void>} */
    async reportPlaybackStarted(itemId, context) {}

    /** @param {string} itemId @param {Object} context @returns {Promise<void>} */
    async reportPlaybackProgress(itemId, context) {}

    /** @param {string} itemId @param {Object} context @returns {Promise<void>} */
    async reportPlaybackStopped(itemId, context) {}
}
