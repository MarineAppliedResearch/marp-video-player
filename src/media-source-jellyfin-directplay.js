/**
 * Media source for Jellyfin Direct Play: the original file, fetched by HTTP
 * byte range straight off the server.
 *
 * No transcoder, so none of the transcode path's session machinery applies
 * -- `/Videos/{id}/stream?static=true` is stateless, honours ranges and has
 * no restart cost, which is why this source installs no behind sessions and
 * lets fetches run at the engine's full concurrency.
 *
 * Everything about reading and indexing the MP4 lives in the shared base;
 * all this adds is where the bytes are.
 *
 * @fileoverview The Jellyfin Direct Play media source.
 * @module video-engine/media-source-jellyfin-directplay
 */

import { Mp4ByteRangeMediaSource } from './media-source-mp4-byte-range.js';
import { JellyfinPlaybackReporter } from './jellyfin-playback-reporter.js';

/**
 * Plays a Jellyfin item as its original file.
 *
 * @class JellyfinDirectPlayMediaSource
 * @augments Mp4ByteRangeMediaSource
 */
export class JellyfinDirectPlayMediaSource extends Mp4ByteRangeMediaSource {
    /**
     * @param {Object} params
     * @param {import('./jellyfin-client.js').JellyfinClient} params.client - An authenticated client, for the server URL and token.
     * @param {string} params.itemId - Jellyfin item id to play.
     * @param {Object} [params.options] - Remaining options, forwarded to {@link Mp4ByteRangeMediaSource}.
     */
    constructor({ client, itemId, getCurrentTime, ...options }) {
        super(options);
        this.client = client;
        this.itemId = itemId;
        this.getCurrentTime = getCurrentTime;

        // Direct Play needs reporting as much as the transcode path does:
        // it is what keeps Jellyfin's resume position and now-playing
        // working, and Direct Play is the default path.
        this._reporter = new JellyfinPlaybackReporter({
            client,
            itemId,
            getCurrentTime,
            onDebug: (message) => this._logDebug(message),
        });
    }

    /**
     * Reads the index, then learns the session ids reporting needs.
     *
     * Direct Play negotiates nothing to play -- the URL is stateless -- so
     * the ids come from a PlaybackInfo probe, which is the same call that
     * reports whether the item can be direct-played at all.
     *
     * @async
     * @returns {Promise<void>}
     */
    async load() {
        await super.load();
        try {
            const probe = await this.client.probeMediaSource(this.itemId);
            this._reporter.setSession({ mediaSourceId: probe.mediaSourceId, playSessionId: probe.playSessionId });
        } catch (err) {
            // Reporting is a convenience; failing to identify a session must
            // never stop playback.
            this._logDebug(`could not resolve a playback session for reporting: ${err.message}`);
        }
    }


    /**
     * Receives readers for engine state the source needs.
     *
     * Called by the engine once it is running. A source is usually built
     * before the engine exists -- a consumer picks one and passes it in --
     * so anything it needs to know about playback position arrives here
     * rather than through its constructor.
     *
     * @param {Object} engine
     * @param {function(): number} engine.getCurrentTime - Playhead position, in seconds.
     * @param {function(): boolean} engine.isPaused - Whether playback is paused.
     * @returns {void}
     */
    attachEngine({ getCurrentTime, isPaused }) {
        this.getCurrentTime = getCurrentTime;
        this._reporter.getCurrentTime = getCurrentTime;
        this._reporter.isPaused = isPaused;
    }

    /** Starts reporting playback to Jellyfin. @returns {void} */
    startPlaybackReporting() {
        this._reporter.start();
    }

    /** Stops reporting and sends a final "stopped". @returns {void} */
    stopPlaybackReporting() {
        this._reporter.stop();
    }

    /** The stateless Direct Play URL: no session, no transcoder, honours ranges. */
    get streamUrl() {
        return `${this.client.serverUrl}/Videos/${encodeURIComponent(this.itemId)}/stream?static=true&api_key=${encodeURIComponent(this.client.accessToken)}`;
    }
}
