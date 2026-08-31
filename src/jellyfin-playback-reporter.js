/**
 * Reports playback position to Jellyfin.
 *
 * This is what drives Jellyfin's own resume-position and now-playing
 * features, so every Jellyfin path needs it -- Direct Play as much as
 * transcode. Shared rather than duplicated per source, and owned by the
 * library rather than the consumer, because a report is identified by
 * session ids the source holds and a consumer would otherwise have to track.
 *
 * @fileoverview Playback reporting for the Jellyfin media sources.
 * @module video-engine/jellyfin-playback-reporter
 */

/** Jellyfin's own now-playing cadence, matching jellyfin-web's playbackmanager. */
const PLAYBACK_REPORT_INTERVAL_MS = 10_000;

/** Jellyfin expresses positions in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;

/**
 * Sends started/progress/stopped reports for one item.
 *
 * @class JellyfinPlaybackReporter
 */
export class JellyfinPlaybackReporter {
    /**
     * @param {Object} params
     * @param {import('./jellyfin-client.js').JellyfinClient} params.client - Authenticated client.
     * @param {string} params.itemId - Item being played.
     * @param {function(): number} [params.getCurrentTime] - Reads the playhead, in seconds.
     * @param {function(): boolean} [params.isPaused] - Reads paused state.
     * @param {function(string): void} [params.onDebug] - Progress/failure messages.
     */
    constructor({ client, itemId, getCurrentTime, isPaused, onDebug }) {
        this.client = client;
        this.itemId = itemId;
        this.getCurrentTime = getCurrentTime;
        this.isPaused = isPaused;
        this.onDebug = onDebug;

        // Set once the session producing this stream is known.
        this.session = null;
        this._handle = null;
    }

    /**
     * Supplies the ids Jellyfin identifies a report by.
     *
     * @param {Object} session
     * @param {string} [session.mediaSourceId] - MediaSource id from PlaybackInfo.
     * @param {string} [session.playSessionId] - PlaySession id from PlaybackInfo.
     * @returns {void}
     */
    setSession({ mediaSourceId, playSessionId } = {}) {
        this.session = { mediaSourceId, playSessionId };
    }

    /** Sends "started", then "progress" on Jellyfin's own cadence. @returns {void} */
    start() {
        if (!this._canReport() || this._handle !== null) {
            return;
        }
        this._send('Started');
        this._handle = setInterval(() => this._send('Progress'), PLAYBACK_REPORT_INTERVAL_MS);
    }

    /** Stops the timer and sends a final "stopped". @returns {void} */
    stop() {
        if (this._handle !== null) {
            clearInterval(this._handle);
            this._handle = null;
        }
        if (this._canReport()) {
            this._send('Stopped');
        }
    }

    /** @returns {boolean} Whether a report can be identified and sent. */
    _canReport() {
        return Boolean(this.client && this.itemId && this.session);
    }

    /**
     * @param {('Started'|'Progress'|'Stopped')} kind - Which report to send.
     * @returns {void}
     */
    _send(kind) {
        const seconds = typeof this.getCurrentTime === 'function' ? this.getCurrentTime() : NaN;
        const report = {
            mediaSourceId: this.session.mediaSourceId,
            playSessionId: this.session.playSessionId,
            positionTicks: Number.isFinite(seconds) ? Math.round(seconds * TICKS_PER_SECOND) : undefined,
            isPaused: typeof this.isPaused === 'function' ? Boolean(this.isPaused()) : false,
        };

        const sent =
            kind === 'Started'
                ? this.client.reportPlaybackStarted(this.itemId, report)
                : kind === 'Stopped'
                  ? this.client.reportPlaybackStopped(this.itemId, report)
                  : this.client.reportPlaybackProgress(this.itemId, report);

        Promise.resolve(sent).catch((err) => {
            if (this.onDebug) {
                this.onDebug(`playback ${kind} report failed: ${err.message}`);
            }
        });
    }
}
