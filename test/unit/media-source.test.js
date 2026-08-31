/**
 * Unit tests for the MediaSource abstraction and its JellyfinMediaSource
 * implementation, against a fake JellyfinClient (no network/fetch involved
 * -- that's already covered by jellyfin-client.test.js).
 *
 * @fileoverview Tests for media-source.js and JellyfinMediaSource.
 */

const { MediaSource } = require('../../src/media-source.js');
const { JellyfinMediaSource } = require('../../src/media-source-jellyfin-transcode.js');

describe('MediaSource base class', () => {
    test('resolveStreamUrl rejects by default -- subclasses must override it', async () => {
        await expect(new MediaSource().resolveStreamUrl('item-1')).rejects.toThrow(/not implemented/i);
    });

    test('the three reporting methods are no-ops by default', async () => {
        const source = new MediaSource();
        await expect(source.reportPlaybackStarted('item-1', {})).resolves.toBeUndefined();
        await expect(source.reportPlaybackProgress('item-1', {})).resolves.toBeUndefined();
        await expect(source.reportPlaybackStopped('item-1', {})).resolves.toBeUndefined();
    });
});

describe('JellyfinMediaSource', () => {
    /**
     * A fake JellyfinClient exposing just the methods JellyfinMediaSource
     * calls -- network/storage behavior is already covered by
     * jellyfin-client.test.js, so this stays a plain jest.fn() double.
     *
     * @returns {Object} Fake client with mocked probe/negotiate/report methods.
     */
    function createFakeClient() {
        return {
            probeMediaSource: jest.fn(async () => ({ bitrate: 8_000_000, width: 1920, height: 1080, supportsTranscoding: true })),
            getPlaybackInfo: jest.fn(async () => ({
                streamUrl: 'http://jellyfin.example/videos/item-1/master.m3u8',
                mediaSourceId: 'source-1',
                playSessionId: 'session-1',
            })),
            reportPlaybackStarted: jest.fn(async () => {}),
            reportPlaybackProgress: jest.fn(async () => {}),
            reportPlaybackStopped: jest.fn(async () => {}),
        };
    }

    test('probeQualityOptions delegates to the client and builds tiers from the result', async () => {
        const client = createFakeClient();
        const source = new JellyfinMediaSource(client);

        const options = await source.probeQualityOptions('item-1');

        expect(client.probeMediaSource).toHaveBeenCalledWith('item-1');
        expect(options.map((o) => o.name)).toContain('Full');
    });

    test('resolveStreamUrl negotiates via the client and returns its stream URL', async () => {
        const client = createFakeClient();
        const source = new JellyfinMediaSource(client);

        const url = await source.resolveStreamUrl('item-1', { maxStreamingBitrate: 4_000_000 });

        expect(client.getPlaybackInfo).toHaveBeenCalledWith('item-1', { maxStreamingBitrate: 4_000_000 });
        expect(url).toBe('http://jellyfin.example/videos/item-1/master.m3u8');
    });

    test('playback reporting fills in mediaSourceId/playSessionId from the most recent negotiation', async () => {
        const client = createFakeClient();
        const source = new JellyfinMediaSource(client);
        await source.resolveStreamUrl('item-1', {});

        await source.reportPlaybackStarted('item-1', { positionTicks: 0, isPaused: false });

        expect(client.reportPlaybackStarted).toHaveBeenCalledWith('item-1', {
            mediaSourceId: 'source-1',
            playSessionId: 'session-1',
            positionTicks: 0,
            isPaused: false,
        });
    });

    test('reporting before any negotiation sends undefined mediaSourceId/playSessionId rather than throwing', async () => {
        const client = createFakeClient();
        const source = new JellyfinMediaSource(client);

        await source.reportPlaybackProgress('item-1', { positionTicks: 500 });

        expect(client.reportPlaybackProgress).toHaveBeenCalledWith('item-1', {
            mediaSourceId: null,
            playSessionId: null,
            positionTicks: 500,
            isPaused: undefined,
        });
    });
});