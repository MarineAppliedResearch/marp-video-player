/**
 * Unit tests for the arrow-key playback-rate shuttle.
 *
 * This behaviour existed first in VIDEO_PROCESSING_GUI's C#
 * (`stepPlaybackSpeed` in VideoPlayer.xaml.cs, with PlaybackStepSize 0.5 and
 * PlaybackStepLimit 16) and not in this package at all -- a host implemented it
 * against the player rather than the player providing it, so nothing here
 * covered it and nothing here could tell you whether it worked. It lives in the
 * library now, and these exist so that stays true.
 *
 * `MarpVideoPlayer.prototype.stepPlaybackRate` is exercised directly against a
 * fake engine, rather than through a constructed player: the method reads the
 * engine and calls setPlaybackRate, and building the whole DOM to observe that
 * would test the DOM instead of the arithmetic.
 *
 * @fileoverview Unit tests for stepPlaybackRate.
 * @author Isaac Travers
 * @module video-engine/test/unit/playback-rate-step.test
 */

const { MarpVideoPlayer, SPEED_STEP, SPEED_STEP_LIMIT } = require('../../src/ui/player-ui.js');

/**
 * A player stand-in carrying only what stepPlaybackRate touches.
 *
 * @param {Object} [engine] - Engine state: `{paused, playbackRate}`.
 * @returns {Object} `{step, rate, paused, calls}`.
 */
function build({ paused = true, playbackRate = 1 } = {}) {
    const calls = [];
    const context = {
        engine: {
            paused,
            playbackRate,
            play() {
                context.engine.paused = false;
                calls.push('play');
            },
            pause() {
                context.engine.paused = true;
                calls.push('pause');
            },
        },
        setPlaybackRate(rate) {
            context.engine.playbackRate = rate;
            calls.push(`rate:${rate}`);
        },
        log() {},
    };

    return {
        calls,
        step: (direction) => MarpVideoPlayer.prototype.stepPlaybackRate.call(context, direction),
        get rate() {
            return context.engine.playbackRate;
        },
        get paused() {
            return context.engine.paused;
        },
        context,
    };
}

describe('stepPlaybackRate', () => {

    it('matches the desktop application\'s own step and limit', () => {
        expect(SPEED_STEP).toBe(0.5);
        expect(SPEED_STEP_LIMIT).toBe(16);
    });

    /**
     * From a standstill the first press must give half speed in the direction
     * asked for, not resume at whatever rate was last used -- which is why a
     * paused engine counts as zero rather than as its stored playbackRate.
     */
    it('gives half speed forward on the first press from paused', () => {
        const harness = build({ paused: true, playbackRate: 1 });

        harness.step(1);

        expect(harness.rate).toBe(0.5);
        expect(harness.paused).toBe(false);
    });

    it('gives half speed in reverse on the first press the other way', () => {
        const harness = build({ paused: true, playbackRate: 1 });

        harness.step(-1);

        expect(harness.rate).toBe(-0.5);
        expect(harness.paused).toBe(false);
    });

    it('climbs in half steps', () => {
        const harness = build({ paused: true });
        const seen = [];

        for (let press = 0; press < 5; press++) {
            harness.step(1);
            seen.push(harness.rate);
        }

        expect(seen).toEqual([0.5, 1, 1.5, 2, 2.5]);
    });

    it('descends through zero into reverse, pausing on the way', () => {
        const harness = build({ paused: false, playbackRate: 1 });
        const seen = [];

        for (let press = 0; press < 4; press++) {
            harness.step(-1);
            seen.push(harness.paused ? 'paused' : harness.rate);
        }

        expect(seen).toEqual([0.5, 'paused', -0.5, -1]);
    });

    /**
     * Zero is not a playable rate, so it pauses instead. Matching the desktop
     * application, which does exactly this.
     */
    it('pauses rather than setting a rate of zero', () => {
        const harness = build({ paused: false, playbackRate: 0.5 });

        harness.step(-1);

        expect(harness.paused).toBe(true);
        expect(harness.calls).toContain('pause');
        expect(harness.calls.some((call) => call === 'rate:0')).toBe(false);
    });

    /**
     * A rate reached by speed hotkey is not on the half-step grid. Stepping
     * from it must land on a clean multiple rather than carrying 0.08 or 0.2
     * forward through every later press.
     */
    it('rounds a rate set by hotkey onto the step grid', () => {
        // 2.5x is already on the grid, so it simply advances.
        const fromTwoAndAHalf = build({ paused: false, playbackRate: 2.5 });
        fromTwoAndAHalf.step(1);
        expect(fromTwoAndAHalf.rate).toBe(3);

        const fromQuarter = build({ paused: false, playbackRate: 0.08 });
        fromQuarter.step(1);
        expect(fromQuarter.rate).toBe(0.5);

        const fromSix = build({ paused: false, playbackRate: 6 });
        fromSix.step(1);
        expect(fromSix.rate).toBe(6.5);

        const fromReverseEight = build({ paused: false, playbackRate: -8 });
        fromReverseEight.step(1);
        expect(fromReverseEight.rate).toBe(-7.5);
    });

    it('clamps at the limit in both directions', () => {
        const forward = build({ paused: false, playbackRate: SPEED_STEP_LIMIT });
        forward.step(1);
        expect(forward.rate).toBe(SPEED_STEP_LIMIT);

        const reverse = build({ paused: false, playbackRate: -SPEED_STEP_LIMIT });
        reverse.step(-1);
        expect(reverse.rate).toBe(-SPEED_STEP_LIMIT);
    });

    it('does nothing at all before an engine is loaded', () => {
        const context = { engine: null, setPlaybackRate: () => { throw new Error('must not be called'); }, log() {} };

        expect(() => MarpVideoPlayer.prototype.stepPlaybackRate.call(context, 1)).not.toThrow();
    });
});
