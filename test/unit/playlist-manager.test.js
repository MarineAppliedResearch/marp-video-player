/**
 * Unit tests for the hand-written HLS playlist parser in playlist-manager.js.
 *
 * Pure-logic tests only -- no network, no fetch mocking -- since
 * parseMasterPlaylist/parseMediaPlaylist/findSegmentForTime all operate
 * on already-fetched playlist text. loadSegmentIndex() (the network-facing
 * wrapper) is exercised instead by the E2E suite against a real server.
 *
 * @fileoverview Unit tests for playlist-manager.js's HLS parsing and segment lookup.
 * @author Isaac Travers
 * @module video-engine/test/unit/playlist-manager.test
 */

const { parseMasterPlaylist, parseMediaPlaylist, findSegmentForTime } = require('../../src/playlist-manager.js');

/** Arbitrary but realistic master playlist URL, used to verify relative-URI resolution. */
const BASE_URL = 'https://jellyfin.example.com/videos/master.m3u8';

describe('parseMasterPlaylist', () => {
    test('resolves the first variant URI against the master playlist URL', () => {
        const text = ['#EXTM3U', '#EXT-X-STREAM-INF:BANDWIDTH=4000000', 'media.m3u8'].join('\n');

        expect(parseMasterPlaylist(text, BASE_URL)).toBe('https://jellyfin.example.com/videos/media.m3u8');
    });

    test('returns null when there is no #EXT-X-STREAM-INF variant', () => {
        expect(parseMasterPlaylist('#EXTM3U\n', BASE_URL)).toBeNull();
    });
});

describe('parseMediaPlaylist', () => {
    const MEDIA_URL = 'https://jellyfin.example.com/videos/media.m3u8';

    test('computes real cumulative startTime/endTime from #EXTINF, including a shorter tail segment', () => {
        const text = [
            '#EXTM3U',
            '#EXT-X-MAP:URI="init.mp4"',
            '#EXTINF:3.000,',
            'seg0.m4s',
            '#EXTINF:3.000,',
            'seg1.m4s',
            '#EXTINF:0.168,',
            'seg2.m4s',
        ].join('\n');

        const index = parseMediaPlaylist(text, MEDIA_URL);

        expect(index.initSegmentUrl).toBe('https://jellyfin.example.com/videos/init.mp4');
        expect(index.segments).toEqual([
            { index: 0, url: 'https://jellyfin.example.com/videos/seg0.m4s', duration: 3, startTime: 0, endTime: 3 },
            { index: 1, url: 'https://jellyfin.example.com/videos/seg1.m4s', duration: 3, startTime: 3, endTime: 6 },
            { index: 2, url: 'https://jellyfin.example.com/videos/seg2.m4s', duration: 0.168, startTime: 6, endTime: 6.168 },
        ]);
        expect(index.totalDuration).toBeCloseTo(6.168, 6);
    });

    test('throws when there is no #EXT-X-MAP init segment', () => {
        const text = ['#EXTM3U', '#EXTINF:3.000,', 'seg0.m4s'].join('\n');
        expect(() => parseMediaPlaylist(text, MEDIA_URL)).toThrow(/EXT-X-MAP/);
    });

    test('throws when there are no segments', () => {
        const text = ['#EXTM3U', '#EXT-X-MAP:URI="init.mp4"'].join('\n');
        expect(() => parseMediaPlaylist(text, MEDIA_URL)).toThrow(/no segments/);
    });
});

describe('findSegmentForTime', () => {
    /**
     * Deliberately non-uniform: a real VOD stream's tail segment is
     * shorter than the rest, which is exactly the case
     * findSegmentForTime's uniform-duration fast-path guess can get
     * wrong and must fall back to a linear scan for.
     */
    const segmentIndex = {
        segments: [
            { index: 0, startTime: 0, endTime: 3, duration: 3 },
            { index: 1, startTime: 3, endTime: 6, duration: 3 },
            { index: 2, startTime: 6, endTime: 6.168, duration: 0.168 },
        ],
    };

    test('clamps a negative/zero time to the first segment', () => {
        expect(findSegmentForTime(segmentIndex, 0).index).toBe(0);
        expect(findSegmentForTime(segmentIndex, -5).index).toBe(0);
    });

    test('clamps a time past the end to the last segment', () => {
        expect(findSegmentForTime(segmentIndex, 999).index).toBe(2);
    });

    test('finds the correct segment when the uniform-duration guess lands correctly', () => {
        expect(findSegmentForTime(segmentIndex, 4.5).index).toBe(1);
    });

    test('falls back correctly for the short tail segment, where a uniform-duration guess would overshoot', () => {
        expect(findSegmentForTime(segmentIndex, 6.1).index).toBe(2);
    });
});
