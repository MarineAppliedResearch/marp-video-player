/**
 * Unit tests for the direct-to-Jellyfin API client -- login/session
 * persistence, media-source probing, transcode negotiation, and playback
 * reporting, all against a mocked global fetch() and an in-memory fake
 * storage (no jsdom/localStorage dependency).
 *
 * @fileoverview Tests for jellyfin-client.js.
 */

const { JellyfinClient } = require('../../src/jellyfin-client.js');

/**
 * A minimal in-memory Storage-shaped fake, injected into JellyfinClient
 * instead of requiring a jsdom test environment for real localStorage.
 */
function createFakeStorage() {
    const map = new Map();
    return {
        getItem: (key) => (map.has(key) ? map.get(key) : null),
        setItem: (key, value) => map.set(key, String(value)),
        removeItem: (key) => map.delete(key),
    };
}

let previousFetch;

beforeEach(() => {
    previousFetch = global.fetch;
});

afterEach(() => {
    global.fetch = previousFetch;
});

describe('JellyfinClient login/session', () => {
    test('login stores server url, access token, and user id, and persists them to storage', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ AccessToken: 'tok-123', User: { Id: 'user-1' } }),
        }));

        const storage = createFakeStorage();
        const client = new JellyfinClient(storage);

        await client.login('http://jellyfin.example/', 'alice', 'hunter2');

        expect(client.isAuthenticated()).toBe(true);
        expect(client.serverUrl).toBe('http://jellyfin.example');
        expect(client.accessToken).toBe('tok-123');
        expect(client.userId).toBe('user-1');

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('http://jellyfin.example/Users/AuthenticateByName');
        expect(JSON.parse(options.body)).toEqual({ Username: 'alice', Pw: 'hunter2' });
        expect(options.headers.Authorization).toMatch(/^MediaBrowser /);
    });

    test('a fresh client with no stored session is not authenticated', () => {
        const client = new JellyfinClient(createFakeStorage());
        expect(client.isAuthenticated()).toBe(false);
    });

    test('restores a previously logged-in session from storage on construction', () => {
        const storage = createFakeStorage();
        storage.setItem(
            'marp-jellyfin-session',
            JSON.stringify({ serverUrl: 'http://jellyfin.example', accessToken: 'tok-abc', userId: 'user-2' })
        );

        const client = new JellyfinClient(storage);

        expect(client.isAuthenticated()).toBe(true);
        expect(client.accessToken).toBe('tok-abc');
    });

    test('logout clears in-memory state and the stored session', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({ AccessToken: 'tok-123', User: { Id: 'user-1' } }),
        }));

        const storage = createFakeStorage();
        const client = new JellyfinClient(storage);
        await client.login('http://jellyfin.example', 'alice', 'hunter2');

        client.logout();

        expect(client.isAuthenticated()).toBe(false);
        expect(storage.getItem('marp-jellyfin-session')).toBeNull();
    });

    test('login rejects when Jellyfin returns a non-ok response', async () => {
        global.fetch = jest.fn(async () => ({ ok: false, status: 401 }));

        const client = new JellyfinClient(createFakeStorage());

        await expect(client.login('http://jellyfin.example', 'alice', 'wrong')).rejects.toThrow(/401/);
        expect(client.isAuthenticated()).toBe(false);
    });
});

describe('JellyfinClient#probeMediaSource', () => {
    test('extracts bitrate, video width/height, and transcode support from the response', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                MediaSources: [
                    {
                        Bitrate: 8_000_000,
                        SupportsTranscoding: true,
                        MediaStreams: [
                            { Type: 'Audio', Channels: 2 },
                            { Type: 'Video', Width: 1920, Height: 1080 },
                        ],
                    },
                ],
            }),
        }));

        const client = new JellyfinClient(createFakeStorage());
        client.serverUrl = 'http://jellyfin.example';
        client.accessToken = 'tok';
        client.userId = 'user-1';

        const result = await client.probeMediaSource('item-1');

        expect(result).toEqual({ bitrate: 8_000_000, width: 1920, height: 1080, supportsTranscoding: true });
    });

    test('rejects when not authenticated', async () => {
        const client = new JellyfinClient(createFakeStorage());
        await expect(client.probeMediaSource('item-1')).rejects.toThrow(/not logged in/i);
    });
});

describe('JellyfinClient#getPlaybackInfo', () => {
    test('negotiates a transcode session and returns an absolute stream URL', async () => {
        global.fetch = jest.fn(async () => ({
            ok: true,
            json: async () => ({
                PlaySessionId: 'session-1',
                MediaSources: [{ Id: 'source-1', TranscodingUrl: '/videos/item-1/master.m3u8?foo=bar' }],
            }),
        }));

        const client = new JellyfinClient(createFakeStorage());
        client.serverUrl = 'http://jellyfin.example';
        client.accessToken = 'tok';
        client.userId = 'user-1';

        const result = await client.getPlaybackInfo('item-1', { maxStreamingBitrate: 4_000_000, maxWidth: 1280, maxHeight: 720 });

        expect(result).toEqual({
            streamUrl: 'http://jellyfin.example/videos/item-1/master.m3u8?foo=bar',
            mediaSourceId: 'source-1',
            playSessionId: 'session-1',
        });

        const [, options] = global.fetch.mock.calls[0];
        const body = JSON.parse(options.body);
        expect(body.AllowVideoStreamCopy).toBe(false);
        expect(body.AllowAudioStreamCopy).toBe(true);
        expect(body.EnableTranscoding).toBe(true);
    });
});

describe('JellyfinClient playback reporting', () => {
    test('reportPlaybackStarted posts to /Sessions/Playing with the report body', async () => {
        global.fetch = jest.fn(async () => ({ ok: true }));

        const client = new JellyfinClient(createFakeStorage());
        client.serverUrl = 'http://jellyfin.example';
        client.accessToken = 'tok';
        client.userId = 'user-1';

        await client.reportPlaybackStarted('item-1', { mediaSourceId: 'source-1', playSessionId: 'session-1', positionTicks: 0 });

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('http://jellyfin.example/Sessions/Playing');
        expect(JSON.parse(options.body)).toMatchObject({
            ItemId: 'item-1',
            MediaSourceId: 'source-1',
            PlaySessionId: 'session-1',
            IsPaused: false,
        });
    });

    test('reportPlaybackStopped forces isPaused true and posts to /Sessions/Playing/Stopped', async () => {
        global.fetch = jest.fn(async () => ({ ok: true }));

        const client = new JellyfinClient(createFakeStorage());
        client.serverUrl = 'http://jellyfin.example';
        client.accessToken = 'tok';
        client.userId = 'user-1';

        await client.reportPlaybackStopped('item-1', { positionTicks: 12_345 });

        const [url, options] = global.fetch.mock.calls[0];
        expect(url).toBe('http://jellyfin.example/Sessions/Playing/Stopped');
        expect(JSON.parse(options.body).IsPaused).toBe(true);
    });

    test('does not call fetch when not authenticated', async () => {
        global.fetch = jest.fn();

        const client = new JellyfinClient(createFakeStorage());
        await client.reportPlaybackProgress('item-1', { positionTicks: 100 });

        expect(global.fetch).not.toHaveBeenCalled();
    });
});