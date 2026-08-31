/**
 * Direct browser-to-Jellyfin API client -- login, playback negotiation, and
 * playback reporting, with zero MARE_API involvement.
 *
 * Mirrors repository/jellyfin.repository.js's request shapes (auth header,
 * PlaybackInfo body, Sessions/Playing report body) so this negotiates with
 * Jellyfin exactly the same way MARP's own backend already does -- just
 * from the browser, authenticated as the real end user's own Jellyfin
 * account instead of one shared service account.
 *
 * @fileoverview Jellyfin API client for direct, MARP-API-free playback.
 */

const SESSION_STORAGE_KEY = 'marp-jellyfin-session';
const DEVICE_ID_STORAGE_KEY = 'marp-jellyfin-device-id';
const CLIENT_NAME = 'MarpVideoPlayer';
const CLIENT_VERSION = '1.0.0';

/** Jellyfin ticks are 100ns units -- used to convert a seconds-based startTimeSeconds. */
const TICKS_PER_SECOND = 10_000_000;

export class JellyfinClient {
    /**
     * @param {Storage} [storage] - Defaults to the real browser
     * `localStorage`. Injectable so unit tests can supply an in-memory
     * fake instead of requiring a jsdom test environment.
     */
    constructor(storage) {
        this.storage = storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        this.serverUrl = '';
        this.accessToken = '';
        this.userId = '';
        this._loadStoredSession();
    }

    /**
     * Strips trailing slashes so endpoint paths can be appended predictably.
     *
     * @param {string} url - Raw server URL.
     * @returns {string} URL with no trailing slash.
     */
    _normalizeServerUrl(url) {
        return url.trim().replace(/\/+$/, '');
    }

    /**
     * A stable per-browser device id, generated once and persisted --
     * matches how real Jellyfin clients identify "this device" across
     * logins, distinct from the per-login access token.
     *
     * @returns {string} Persisted device id.
     */
    _getOrCreateDeviceId() {
        if (!this.storage) {
            return `marp-video-player-${crypto.randomUUID()}`;
        }

        let deviceId = this.storage.getItem(DEVICE_ID_STORAGE_KEY);

        if (!deviceId) {
            deviceId = `marp-video-player-${crypto.randomUUID()}`;
            this.storage.setItem(DEVICE_ID_STORAGE_KEY, deviceId);
        }

        return deviceId;
    }

    /**
     * Builds the `MediaBrowser` authorization header Jellyfin expects on
     * both the login request and (with a token appended) authenticated
     * requests.
     *
     * @returns {string} Header value.
     */
    _buildAuthorizationHeader() {
        const deviceId = this._getOrCreateDeviceId();
        let header =
            `MediaBrowser Client="${CLIENT_NAME}", Device="Browser", ` +
            `DeviceId="${deviceId}", Version="${CLIENT_VERSION}"`;

        if (this.accessToken) {
            header += `, Token="${this.accessToken}"`;
        }

        return header;
    }

    /**
     * Restores a previously logged-in session from localStorage, if any.
     */
    _loadStoredSession() {
        if (!this.storage) {
            return;
        }

        const raw = this.storage.getItem(SESSION_STORAGE_KEY);

        if (!raw) {
            return;
        }

        try {
            const stored = JSON.parse(raw);
            this.serverUrl = stored.serverUrl || '';
            this.accessToken = stored.accessToken || '';
            this.userId = stored.userId || '';
        } catch {
            this.storage.removeItem(SESSION_STORAGE_KEY);
        }
    }

    _persistSession() {
        if (!this.storage) {
            return;
        }

        this.storage.setItem(
            SESSION_STORAGE_KEY,
            JSON.stringify({ serverUrl: this.serverUrl, accessToken: this.accessToken, userId: this.userId })
        );
    }

    /**
     * True once a login has succeeded and a session is held (either just
     * now or restored from a prior visit).
     *
     * @returns {boolean} Whether this client is ready to make authenticated calls.
     */
    isAuthenticated() {
        return Boolean(this.serverUrl && this.accessToken && this.userId);
    }

    /**
     * Logs into a Jellyfin server as a real end-user account, replacing any
     * previously stored session.
     *
     * @async
     * @param {string} serverUrl - Jellyfin server base URL, e.g. "http://192.168.1.202:8097".
     * @param {string} username - Jellyfin account username.
     * @param {string} password - Jellyfin account password.
     * @returns {Promise<void>}
     * @throws {Error} If the server is unreachable or rejects the login.
     */
    async login(serverUrl, username, password) {
        this.serverUrl = this._normalizeServerUrl(serverUrl);
        this.accessToken = '';
        this.userId = '';

        const response = await fetch(`${this.serverUrl}/Users/AuthenticateByName`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: this._buildAuthorizationHeader(),
            },
            body: JSON.stringify({ Username: username, Pw: password }),
        });

        if (!response.ok) {
            throw new Error(`Jellyfin login failed (${response.status}).`);
        }

        const data = await response.json();
        this.accessToken = data.AccessToken;
        this.userId = data.User.Id;
        this._persistSession();
    }

    /**
     * Adopts a session obtained elsewhere, instead of logging in here.
     *
     * A host application usually authenticates with Jellyfin through its own
     * client and already holds a token -- the C# desktop app does. Making it
     * log in a second time would create a second session for the same user
     * and mean handling credentials in two places.
     *
     * @param {Object} session
     * @param {string} session.serverUrl - Jellyfin base URL.
     * @param {string} session.accessToken - An access token for that server.
     * @param {string} session.userId - The user the token belongs to.
     * @returns {void}
     */
    useSession({ serverUrl, accessToken, userId }) {
        this.serverUrl = this._normalizeServerUrl(serverUrl || '');
        this.accessToken = accessToken || '';
        this.userId = userId || '';
        this._persistSession();
    }

    /**
     * Clears the stored session. Does not call Jellyfin to invalidate the
     * token server-side -- just forgets it locally.
     */
    logout() {
        this.serverUrl = '';
        this.accessToken = '';
        this.userId = '';

        if (this.storage) {
            this.storage.removeItem(SESSION_STORAGE_KEY);
        }
    }

    /**
     * Resolves a possibly-relative Jellyfin URL (PlaybackInfo can return
     * `TranscodingUrl` as a server-root-relative path) to an absolute URL.
     *
     * @param {string} jellyfinUrl - Absolute or relative Jellyfin URL.
     * @returns {string} Absolute URL.
     */
    _buildAbsoluteUrl(jellyfinUrl) {
        if (/^https?:\/\//i.test(jellyfinUrl)) {
            return jellyfinUrl;
        }

        return jellyfinUrl.startsWith('/') ? `${this.serverUrl}${jellyfinUrl}` : `${this.serverUrl}/${jellyfinUrl}`;
    }

    /**
     * Discovers a media source's real bitrate/resolution/capabilities via a
     * permissive PlaybackInfo call (mirrors jellyfin_client.cs's
     * GetPlaybackInfoAsync) -- used only to build the quality-tier menu,
     * never for actual playback (Jellyfin may pick a non-HLS/non-fMP4
     * method here, which our demuxer can't consume).
     *
     * @async
     * @param {string} itemId - Jellyfin item id to inspect.
     * @returns {Promise<{bitrate: number, width: number, height: number, supportsTranscoding: boolean}>}
     * @throws {Error} If not authenticated, or Jellyfin rejects the request.
     */
    async probeMediaSource(itemId) {
        if (!this.isAuthenticated()) {
            throw new Error('Not logged into Jellyfin.');
        }

        const response = await fetch(`${this.serverUrl}/Items/${encodeURIComponent(itemId)}/PlaybackInfo?UserId=${encodeURIComponent(this.userId)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': this.accessToken,
            },
            body: JSON.stringify({
                UserId: this.userId,
                MaxStreamingBitrate: 120_000_000,
                EnableDirectPlay: true,
                EnableDirectStream: true,
                EnableTranscoding: true,
            }),
        });

        if (!response.ok) {
            throw new Error(`Jellyfin PlaybackInfo probe failed (${response.status}).`);
        }

        const data = await response.json();
        const mediaSource = data.MediaSources && data.MediaSources[0];

        if (!mediaSource) {
            throw new Error('Jellyfin PlaybackInfo probe returned no media sources.');
        }

        const videoStream = (mediaSource.MediaStreams || []).find((stream) => stream.Type === 'Video');

        return {
            bitrate: mediaSource.Bitrate || 0,
            width: (videoStream && videoStream.Width) || 0,
            height: (videoStream && videoStream.Height) || 0,
            supportsTranscoding: Boolean(mediaSource.SupportsTranscoding),
            // Jellyfin identifies a playback report by these, and this probe
            // is already the PlaybackInfo call that produces them -- the
            // Direct Play path has no other negotiation to take them from.
            mediaSourceId: mediaSource.Id,
            playSessionId: data.PlaySessionId,
        };
    }

    /**
     * Negotiates transcode playback for an item, identical in shape to
     * repository/jellyfin.repository.js#getTranscodePlaybackInfo -- forces
     * a real transcode (never a video copy) at the requested quality tier.
     *
     * @async
     * @param {string} itemId - Jellyfin item id to play.
     * @param {Object} [option] - Quality tier selected from the quality picker.
     * @param {number} [option.maxStreamingBitrate=4000000] - Bitrate ceiling.
     * @param {number} [option.maxWidth=1280] - Width ceiling.
     * @param {number} [option.maxHeight=720] - Height ceiling.
     * @param {number} [option.startTimeSeconds] - Position to start this session's transcode from (StartTimeTicks), instead of the beginning -- used to negotiate a second, independent session anchored earlier than a seek target (see JellyfinMediaSource#resolveBehindStreamUrl).
     * @returns {Promise<{streamUrl: string, mediaSourceId: string, playSessionId: string}>}
     * @throws {Error} If not authenticated, or Jellyfin rejects the request.
     */
    async getPlaybackInfo(itemId, option = {}) {
        if (!this.isAuthenticated()) {
            throw new Error('Not logged into Jellyfin.');
        }

        const maxStreamingBitrate = option.maxStreamingBitrate || 4_000_000;
        const maxWidth = option.maxWidth || 1280;
        const maxHeight = option.maxHeight || 720;

        const response = await fetch(`${this.serverUrl}/Items/${encodeURIComponent(itemId)}/PlaybackInfo?UserId=${encodeURIComponent(this.userId)}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': this.accessToken,
            },
            body: JSON.stringify({
                UserId: this.userId,
                EnableDirectPlay: false,
                EnableDirectStream: false,
                EnableTranscoding: true,
                MaxStreamingBitrate: maxStreamingBitrate,
                MaxWidth: maxWidth,
                MaxHeight: maxHeight,
                AllowVideoStreamCopy: false,
                AllowAudioStreamCopy: true,
                ...(Number.isFinite(option.startTimeSeconds) ? { StartTimeTicks: Math.round(option.startTimeSeconds * TICKS_PER_SECOND) } : {}),
                DeviceProfile: {
                    Name: CLIENT_NAME,
                    MaxStreamingBitrate: maxStreamingBitrate,
                    TranscodingProfiles: [
                        { Container: 'mp4', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls' },
                    ],
                },
            }),
        });

        if (!response.ok) {
            throw new Error(`Jellyfin PlaybackInfo request failed (${response.status}).`);
        }

        const data = await response.json();
        const mediaSource = data.MediaSources && data.MediaSources[0];

        if (!mediaSource || !mediaSource.TranscodingUrl) {
            throw new Error('Jellyfin PlaybackInfo response had no transcoding URL.');
        }

        return {
            streamUrl: this._buildAbsoluteUrl(mediaSource.TranscodingUrl),
            mediaSourceId: mediaSource.Id,
            playSessionId: data.PlaySessionId,
        };
    }

    /**
     * Relays a playback report to one of Jellyfin's `/Sessions/Playing*`
     * endpoints -- identical body shape to
     * repository/jellyfin.repository.js#_reportPlayback.
     *
     * @async
     * @param {string} path - Jellyfin session endpoint suffix, e.g. '/Sessions/Playing'.
     * @param {string} itemId - Jellyfin item id being played.
     * @param {Object} report - Report fields.
     * @param {string} [report.mediaSourceId] - MediaSource id from the earlier PlaybackInfo response.
     * @param {string} [report.playSessionId] - PlaySessionId from the earlier PlaybackInfo response.
     * @param {number} [report.positionTicks=0] - Current playback position, in Jellyfin ticks (100ns units).
     * @param {boolean} [report.isPaused=false] - Whether playback is currently paused.
     * @returns {Promise<void>}
     */
    async _reportPlayback(path, itemId, report = {}) {
        if (!this.isAuthenticated()) {
            return;
        }

        const positionTicks = report.positionTicks && report.positionTicks > 0 ? report.positionTicks : 0;

        await fetch(`${this.serverUrl}${path}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Emby-Token': this.accessToken,
            },
            body: JSON.stringify({
                ItemId: itemId,
                MediaSourceId: report.mediaSourceId || '',
                PlaySessionId: report.playSessionId || '',
                PositionTicks: positionTicks,
                IsPaused: Boolean(report.isPaused),
                IsMuted: false,
                PlayMethod: 'Transcode',
                RepeatMode: 'RepeatNone',
                PlaybackRate: 1.0,
            }),
        });
    }

    /**
     * Reports that playback has started or resumed for an item.
     *
     * @async
     * @param {string} itemId - Jellyfin item id being played.
     * @param {Object} [report] - Report fields (see {@link JellyfinClient#_reportPlayback}).
     * @returns {Promise<void>}
     */
    async reportPlaybackStarted(itemId, report) {
        await this._reportPlayback('/Sessions/Playing', itemId, report);
    }

    /**
     * Reports current playback position/pause state. Call periodically
     * during playback (real Jellyfin clients use a 10s interval) so
     * Jellyfin's transcode-session lifecycle and resume position stay
     * accurate.
     *
     * @async
     * @param {string} itemId - Jellyfin item id being played.
     * @param {Object} [report] - Report fields (see {@link JellyfinClient#_reportPlayback}).
     * @returns {Promise<void>}
     */
    async reportPlaybackProgress(itemId, report) {
        await this._reportPlayback('/Sessions/Playing/Progress', itemId, report);
    }

    /**
     * Reports final playback position before the item/session changes or
     * closes, so Jellyfin can clean up the active transcode session.
     *
     * @async
     * @param {string} itemId - Jellyfin item id that was being played.
     * @param {Object} [report] - Report fields (see {@link JellyfinClient#_reportPlayback}).
     * @returns {Promise<void>}
     */
    async reportPlaybackStopped(itemId, report) {
        await this._reportPlayback('/Sessions/Playing/Stopped', itemId, { ...report, isPaused: true });
    }
}