/**
 * Unit tests for the quality-tier menu builder.
 *
 * @fileoverview Tests for quality-options.js.
 */

const { getQualityOptions } = require('../../src/quality-options.js');

describe('getQualityOptions', () => {
    test('offers Direct Play only when the source does not support transcoding at all', () => {
        const options = getQualityOptions({ bitrate: 8_000_000, width: 1920, height: 1080, supportsTranscoding: false });
        // Direct Play needs no transcode, so it survives here; whether the
        // client can decode the codec is decode's business, not the menu's.
        expect(options.map((o) => o.name)).toEqual(['Direct Play']);
    });

    test('a high-quality 1080p source offers Direct Play, Auto, Full, and all three lower fixed tiers', () => {
        const options = getQualityOptions({ bitrate: 10_000_000, width: 1920, height: 1080, supportsTranscoding: true });

        expect(options.map((o) => o.name)).toEqual(['Direct Play', 'Auto', 'Full', '1080p, 8 Mbps', '720p, 4 Mbps', '480p, 1 Mbps']);
    });

    test('Auto and Full both use the source bitrate/resolution as their ceiling', () => {
        const options = getQualityOptions({ bitrate: 10_000_000, width: 1920, height: 1080, supportsTranscoding: true });

        const auto = options.find((o) => o.name === 'Auto');
        const full = options.find((o) => o.name === 'Full');

        expect(auto).toEqual({ name: 'Auto', maxStreamingBitrate: 10_000_000, maxWidth: 1920, maxHeight: 1080 });
        expect(full).toEqual({ name: 'Full', maxStreamingBitrate: 10_000_000, maxWidth: 1920, maxHeight: 1080 });
    });

    test('a lower-quality 480p source only offers Direct Play, Auto and Full -- no upscaled fixed tiers', () => {
        const options = getQualityOptions({ bitrate: 900_000, width: 854, height: 480, supportsTranscoding: true });

        expect(options.map((o) => o.name)).toEqual(['Direct Play', 'Auto', 'Full']);
    });

    test('a 720p source between tiers offers only the 480p fixed tier below it', () => {
        const options = getQualityOptions({ bitrate: 3_000_000, width: 1280, height: 720, supportsTranscoding: true });

        expect(options.map((o) => o.name)).toEqual(['Direct Play', 'Auto', 'Full', '480p, 1 Mbps']);
    });

    test('unknown source bitrate/height (both 0) offers every fixed tier', () => {
        const options = getQualityOptions({ bitrate: 0, width: 0, height: 0, supportsTranscoding: true });

        expect(options.map((o) => o.name)).toEqual(['Direct Play', 'Auto', 'Full', '1080p, 8 Mbps', '720p, 4 Mbps', '480p, 1 Mbps']);
    });
});