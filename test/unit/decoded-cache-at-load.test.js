/**
 * Unit tests for the decoded-frame budget an engine is built with.
 *
 * `decodedCacheGiB` used to set the Advanced field and nothing else, so every engine
 * started at the frame store's 5 GiB default and a host could only shrink it after the
 * load. On a phone the engine had already decoded past what the device could hold by
 * then. These pin that the host's figure is what the engine is built with, and that a
 * host which set none still gets the engine's own default.
 *
 * Exercised against a stand-in carrying only what the method reads, as
 * playback-rate-step.test.js does.
 *
 * @fileoverview Unit tests for _decodedCacheBudgetBytes.
 * @author Isaac Travers
 * @module video-engine/test/unit/decoded-cache-at-load.test
 */

const { MarpVideoPlayer } = require('../../src/ui/player-ui.js');

const GIB = 1024 * 1024 * 1024;

/**
 * The budget a player would build its engine with.
 *
 * @param {Object} options - The host's options.
 * @param {string} field - What the Advanced field holds.
 * @returns {number|undefined} Bytes.
 */
function budget(options, field) {
    const context = { options, el: { decodedCache: { value: field } } };
    return MarpVideoPlayer.prototype._decodedCacheBudgetBytes.call(context);
}

describe('the decoded budget an engine is built with', () => {
    test('is the host figure when the host set one', () => {
        expect(budget({ decodedCacheGiB: 0.25 }, '0.25')).toBe(GIB / 4);
    });

    test('follows the Advanced field once somebody has changed it', () => {
        expect(budget({ decodedCacheGiB: 0.25 }, '1')).toBe(GIB);
    });

    test('is left to the engine when the host set none', () => {
        expect(budget({}, '5')).toBeUndefined();
    });

    test('is left to the engine when the field does not parse', () => {
        expect(budget({ decodedCacheGiB: 0.25 }, '')).toBeUndefined();
    });
});
