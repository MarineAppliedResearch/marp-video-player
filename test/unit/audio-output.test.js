/**
 * Unit tests for AudioOutput, the module that decides *when* sound happens.
 *
 * Every assertion here is of the same shape: given the video says the
 * playhead is HERE and the audio clock reads THAT, where was the buffer
 * placed and what was played from it. That is testable only because
 * FakeAudioContext's clock is written rather than running -- see the fakes'
 * own module comment.
 *
 * The invariant these exist to protect is the one in audio-output.js's module
 * comment: the video's position is the only clock, and audio is placed
 * against it. Nothing here should ever make the picture wait.
 *
 * @fileoverview Unit tests for AudioOutput's scheduling, volume and drift correction.
 * @author Isaac Travers
 * @module video-engine/test/unit/audio-output.test
 */

const { AudioOutput, isRateAudible } = require('../../src/audio-output.js');
const { FakeAudioContext, installAudioFakes } = require('./fakes/webaudio-fakes.js');

/** Restores the real (absent) globals after each test. */
let restoreAudioFakes;

/** Unit length used throughout, in seconds. */
const UNIT_SECONDS = 2;

beforeEach(() => {
    restoreAudioFakes = installAudioFakes();
    jest.useFakeTimers();
});

afterEach(() => {
    jest.useRealTimers();
    restoreAudioFakes();
});

/**
 * A segment index of five equal units.
 *
 * @param {number} [count] - How many units.
 * @returns {Object} A SegmentIndex in the shape the engine passes around.
 */
function makeSegmentIndex(count = 5) {
    return {
        segments: Array.from({ length: count }, (_, index) => ({
            index,
            startTime: index * UNIT_SECONDS,
            endTime: (index + 1) * UNIT_SECONDS,
            duration: UNIT_SECONDS,
        })),
        totalDuration: count * UNIT_SECONDS,
    };
}

/**
 * A stand-in for AudioStore that holds whichever units a test says are
 * decoded, and records every unit asked for.
 *
 * @param {Array<number>} readyUnits - Unit indices that are already decoded.
 * @returns {Object} A store with `get`, `request`, and a `requested` log.
 */
function makeStore(readyUnits) {
    const sampleRate = 48000;
    const units = new Map(
        readyUnits.map((index) => [
            index,
            {
                unitIndex: index,
                sampleRate,
                numberOfChannels: 2,
                channels: [new Float32Array(UNIT_SECONDS * sampleRate), new Float32Array(UNIT_SECONDS * sampleRate)],
                mediaStart: index * UNIT_SECONDS,
                mediaEnd: (index + 1) * UNIT_SECONDS,
            },
        ])
    );

    return {
        requested: [],
        get: (index) => units.get(index) || null,
        request(index) {
            this.requested.push(index);
        },
    };
}

/**
 * Builds an AudioOutput over a fake store and a playhead the test controls.
 *
 * @param {Object} [options]
 * @param {Array<number>} [options.readyUnits] - Units already decoded.
 * @param {number} [options.playhead] - Initial video position, in seconds.
 * @param {number} [options.unitCount] - Units in the index.
 * @returns {Object} `{output, store, setPlayhead, context}` -- context is only available after a start().
 */
function build({ readyUnits = [0, 1, 2, 3, 4], playhead = 0, unitCount = 5 } = {}) {
    const store = makeStore(readyUnits);
    let currentPlayhead = playhead;
    let currentPresented = playhead;
    const stateChanges = [];

    const output = new AudioOutput({
        segmentIndex: makeSegmentIndex(unitCount),
        store,
        getPlayheadTime: () => currentPlayhead,
        onStateChange: () => stateChanges.push(output.blocked),
    });

    return {
        output,
        store,
        stateChanges,
        setPlayhead: (value) => {
            currentPlayhead = value;
            currentPresented = value;
        },
        // Moves the intended position only. The presented frame is not read by
        // the module any more, so this differs from setPlayhead only in what a
        // test is describing: a window whose render loop has stopped.
        setPlayheadOnly: (value) => {
            currentPlayhead = value;
        },
        get context() {
            return FakeAudioContext.instances[FakeAudioContext.instances.length - 1];
        },
    };
}

describe('isRateAudible', () => {

    /**
     * The band's top is 2.5x on purpose: that is exactly the `[` speed
     * hotkey, and stopping at 2x would have made the nearest fast key the
     * silent one.
     */
    it('accepts forward rates from 0.5x to 2.5x and nothing else', () => {
        expect(isRateAudible(0.5)).toBe(true);
        expect(isRateAudible(1)).toBe(true);
        expect(isRateAudible(2.5)).toBe(true);

        expect(isRateAudible(0.49)).toBe(false);
        expect(isRateAudible(2.51)).toBe(false);
        expect(isRateAudible(6)).toBe(false);
        expect(isRateAudible(0)).toBe(false);
    });

    it('is false for every reverse rate, however slow', () => {
        expect(isRateAudible(-1)).toBe(false);
        expect(isRateAudible(-0.5)).toBe(false);
        expect(isRateAudible(-8)).toBe(false);
    });

    it('is false for a rate that is not a number', () => {
        expect(isRateAudible(NaN)).toBe(false);
        expect(isRateAudible(undefined)).toBe(false);
    });
});

describe('AudioOutput scheduling', () => {

    it('opens no audio context until something actually plays', () => {
        const { output } = build();

        output.volume = 0.5;
        output.muted = true;

        expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it('schedules the unit at the playhead as soon as it starts', () => {
        const harness = build();
        harness.output.start(0, 1);

        const sources = harness.context.startedSources;
        expect(sources).toHaveLength(1);
        expect(sources[0].started.when).toBeCloseTo(0, 6);
        expect(sources[0].started.offset).toBeCloseTo(0, 6);
    });

    it('starts part way into a unit when the playhead is part way into it', () => {
        const harness = build({ playhead: 2.75 });
        harness.output.start(2.75, 1);

        const [source] = harness.context.startedSources;
        expect(source.started.offset).toBeCloseTo(0.75, 6);
    });

    it('fills the look-ahead window and no further', () => {
        const harness = build();
        harness.output.start(0, 1);

        // Two-second units and a half-second look-ahead: only the unit being
        // played is inside the window, and its successor is merely warmed.
        expect(harness.context.startedSources).toHaveLength(1);
        expect(harness.store.requested).toContain(1);
    });

    it('schedules the next unit as the clock reaches it', () => {
        const harness = build();
        harness.output.start(0, 1);

        harness.context.advance(UNIT_SECONDS);
        harness.setPlayhead(UNIT_SECONDS);
        jest.advanceTimersByTime(200);

        const sources = harness.context.startedSources;
        expect(sources).toHaveLength(2);
        expect(sources[1].started.when).toBeCloseTo(UNIT_SECONDS, 6);
        expect(sources[1].started.offset).toBeCloseTo(0, 6);
    });

    /**
     * Rate compresses context time against media time, which is what makes
     * `_contextTimeFor` divide rather than multiply. Getting this backwards
     * would schedule the second unit twice as far away as it belongs.
     */
    it('places later audio by media time divided by rate', () => {
        const harness = build();
        harness.output.start(0, 2);

        harness.context.advance(1);
        harness.setPlayhead(2);
        jest.advanceTimersByTime(200);

        const sources = harness.context.startedSources;
        expect(sources).toHaveLength(2);
        // Unit 1 starts at media 2s; at 2x that is 1s of context time.
        expect(sources[1].started.when).toBeCloseTo(1, 6);
        expect(sources[1].started.rate).toBe(2);
    });

    it('plays nothing at a rate outside the audible band', () => {
        const harness = build();
        harness.output.start(0, 6);

        expect(harness.output.playing).toBe(false);
        expect(FakeAudioContext.instances).toHaveLength(0);
    });

    it('plays nothing in reverse', () => {
        const harness = build();
        harness.output.start(4, -1);

        expect(harness.output.playing).toBe(false);
    });

    /**
     * A unit that has not decoded yet must leave the mapping alone. Sliding
     * the cursor to cover the hole would pull every later unit early and put
     * the whole rest of playback out of sync with the picture -- far worse
     * than a moment of silence.
     */
    it('leaves a hole as silence when a unit is not decoded, and asks for it', () => {
        const harness = build({ readyUnits: [0, 2] });
        harness.output.start(0, 1);

        harness.context.advance(UNIT_SECONDS);
        harness.setPlayhead(UNIT_SECONDS);
        jest.advanceTimersByTime(200);

        // Unit 1 is missing, so nothing new was scheduled and unit 2 was NOT
        // pulled forward into its place.
        expect(harness.context.startedSources).toHaveLength(1);
        expect(harness.store.requested).toContain(1);
    });

    it('skips into a late unit by exactly how late it is, rather than replaying it', () => {
        const harness = build({ readyUnits: [0] });
        harness.output.start(0, 1);
        harness.context.startedSources.length = 0;

        // Half a second past where unit 1 should have begun. The playhead
        // moves with it, so this is lateness, not drift.
        const store = harness.store;
        const late = makeStore([1]).get(1);
        store.get = (index) => (index === 1 ? late : null);

        harness.context.advance(UNIT_SECONDS + 0.5);
        harness.setPlayhead(UNIT_SECONDS + 0.5);
        jest.advanceTimersByTime(200);

        const [source] = harness.context.startedSources;
        expect(source.started.when).toBeCloseTo(harness.context.currentTime, 6);
        expect(source.started.offset).toBeCloseTo(0.5, 6);
    });

    it('stops at the end of the stream rather than running off it', () => {
        const harness = build({ unitCount: 2, readyUnits: [0, 1] });
        harness.output.start(0, 1);

        harness.context.advance(4);
        harness.setPlayhead(4);
        jest.advanceTimersByTime(200);

        // Both units scheduled, and no attempt at a third.
        expect(harness.context.startedSources.length).toBeLessThanOrEqual(2);
        expect(harness.store.requested).not.toContain(2);
    });
});

describe('AudioOutput drift correction', () => {

    /**
     * The system clock and the audio hardware clock run at slightly different
     * rates. This is the only drift the design admits, and the only thing
     * that corrects it.
     */
    it('restarts audio once it has drifted far enough to hear', () => {
        const harness = build();
        harness.output.start(0, 1);
        const before = harness.context.startedSources.length;

        // The audio clock advanced a second; the picture only got to 0.8s.
        harness.context.advance(1);
        harness.setPlayhead(0.8);
        jest.advanceTimersByTime(200);

        const sources = harness.context.startedSources;
        expect(sources.length).toBeGreaterThan(before);

        // Restarted from where the picture actually is.
        const latest = sources[sources.length - 1];
        expect(latest.started.when).toBeCloseTo(harness.context.currentTime, 6);
        expect(latest.started.offset).toBeCloseTo(0.8, 6);
    });

    /**
     * The render loop re-anchors its own wall clock every time a frame is
     * late, which on 1080p GOPs under decode load happens repeatedly. Cutting
     * the sound to correct 90ms each time was audible two or three times a
     * minute and fixed nothing anyone could hear.
     */
    it('corrects a small error without cutting the sound', () => {
        const harness = build();
        harness.output.start(0, 1);
        const [source] = harness.context.startedSources;

        // 90ms out: past the limit, well short of worth interrupting.
        harness.context.advance(1);
        harness.setPlayhead(0.91);
        jest.advanceTimersByTime(200);

        expect(source.stopped).toBe(false);
        expect(harness.context.startedSources).toHaveLength(1);
    });

    /**
     * A silent correction has to actually correct something: the next unit must
     * land on the moved mapping, or the error simply persists and is re-measured
     * for ever.
     */
    it('places the next unit on the corrected mapping', () => {
        const harness = build();
        harness.output.start(0, 1);

        // Correct 100ms silently, then run on to the next unit boundary.
        harness.context.advance(1);
        harness.setPlayhead(0.9);
        jest.advanceTimersByTime(200);

        harness.context.advance(1);
        harness.setPlayhead(1.9);
        jest.advanceTimersByTime(200);

        const sources = harness.context.startedSources;
        expect(sources).toHaveLength(2);
        // Unit 1 starts at media 2s, which on the corrected mapping is 0.1s
        // later in context time than it would have been before.
        expect(sources[1].started.when).toBeCloseTo(2.1, 2);
    });

    /**
     * Correcting eagerly is its own defect: every resync is an audible
     * discontinuity, so anything inside a frame's worth is left alone.
     */
    it('leaves a small disagreement alone rather than resyncing on it', () => {
        const harness = build();
        harness.output.start(0, 1);
        const before = harness.context.startedSources.length;

        harness.context.advance(1);
        harness.setPlayhead(1.02);
        jest.advanceTimersByTime(200);

        expect(harness.context.startedSources).toHaveLength(before);
    });

    it('ignores a playhead that is not a number instead of resyncing wildly', () => {
        const harness = build();
        harness.output.start(0, 1);
        const before = harness.context.startedSources.length;

        harness.setPlayhead(NaN);
        harness.context.advance(1);
        jest.advanceTimersByTime(200);

        expect(harness.context.startedSources).toHaveLength(before);
    });
});

describe('AudioOutput when the window is in the background', () => {

    /**
     * A browser stops  outright for an occluded window,
     * so the render loop halts and the presented frame stops advancing while
     * this module's timer and the audio clock carry on.
     *
     * Audio must keep playing through that. The render loop is anchored to the
     * wall clock, so when the window comes back the picture jumps forward to
     * where the wall clock now is -- which is exactly where audio has been all
     * along. Stopping audio instead would silence the player whenever anything
     * else was in front of it, which is not what a video player does.
     */
    it('keeps playing while the presented frame is frozen', () => {
        const harness = build();
        harness.output.start(0, 1);
        const [source] = harness.context.startedSources;

        // The intended position keeps pace with the audio clock, because both
        // derive from clocks that do not stop. Only the picture has stopped.
        for (let pass = 1; pass <= 10; pass++) {
            harness.context.advance(0.2);
            harness.setPlayheadOnly(0.2 * pass);
            jest.advanceTimersByTime(200);
        }

        expect(source.stopped).toBe(false);
        expect(harness.output.playing).toBe(true);
    });

    /**
     * The regression that started all of this. Drift used to be measured
     * against the PRESENTED frame, which freezes with the render loop -- so an
     * occluded window read as ever-growing drift, resynced to the frozen
     * position, and did it again on every pass. Heard as the same fraction of a
     * second replaying indefinitely the moment another window was maximised.
     *
     * Measuring against the continuous anchor instead means there is no drift
     * to correct, and nothing to restart.
     */
    it('does not restart audio over and over while the picture is frozen', () => {
        const harness = build();
        harness.output.start(0, 1);

        for (let pass = 1; pass <= 10; pass++) {
            harness.context.advance(0.2);
            harness.setPlayheadOnly(0.2 * pass);
            jest.advanceTimersByTime(200);
        }

        // Two units scheduled across two seconds of playback, and no third
        // copy of either: no resync fired.
        expect(harness.context.startedSources).toHaveLength(2);
        expect(harness.context.startedSources.filter((s) => s.started.offset > 0.5)).toHaveLength(0);
    });
});

describe('AudioOutput volume and mute', () => {

    it('writes volume onto the gain node', () => {
        const harness = build();
        harness.output.start(0, 1);

        harness.output.volume = 0.25;

        expect(harness.context.gainNodes[0].gain.value).toBeCloseTo(0.25, 6);
    });

    it('mutes to zero gain and remembers the volume underneath', () => {
        const harness = build();
        harness.output.start(0, 1);
        harness.output.volume = 0.4;

        harness.output.muted = true;
        expect(harness.context.gainNodes[0].gain.value).toBe(0);
        expect(harness.output.volume).toBeCloseTo(0.4, 6);

        harness.output.muted = false;
        expect(harness.context.gainNodes[0].gain.value).toBeCloseTo(0.4, 6);
    });

    it('clamps volume to 0..1', () => {
        const { output } = build();

        output.volume = 5;
        expect(output.volume).toBe(1);

        output.volume = -2;
        expect(output.volume).toBe(0);
    });

    it('applies volume set before anything played', () => {
        const harness = build();
        harness.output.volume = 0.3;

        harness.output.start(0, 1);

        expect(harness.context.gainNodes[0].gain.value).toBeCloseTo(0.3, 6);
    });

    /**
     * Muting is not stopping. The buffers stay scheduled so unmuting picks up
     * mid-stream in sync, rather than having to rebuild the schedule.
     */
    it('keeps playing while muted', () => {
        const harness = build();
        harness.output.start(0, 1);

        harness.output.muted = true;

        expect(harness.output.playing).toBe(true);
        expect(harness.context.startedSources[0].stopped).toBe(false);
    });
});

describe('AudioOutput autoplay blocking', () => {

    it('reports blocked when the browser will not let the context run', () => {
        FakeAudioContext.initialState = 'suspended';
        FakeAudioContext.resumeRefused = true;

        const harness = build();
        harness.output.start(0, 1);

        expect(harness.output.blocked).toBe(true);
        expect(harness.stateChanges).toContain(true);
    });

    it('clears the block once a resume is allowed', async () => {
        FakeAudioContext.initialState = 'suspended';
        FakeAudioContext.resumeRefused = true;

        const harness = build();
        harness.output.start(0, 1);
        expect(harness.output.blocked).toBe(true);

        FakeAudioContext.resumeRefused = false;
        await expect(harness.output.resume()).resolves.toBe(true);

        expect(harness.output.blocked).toBe(false);
    });

    it('resumes to false rather than throwing when there is no context at all', async () => {
        const { output } = build();
        await expect(output.resume()).resolves.toBe(false);
    });

    /**
     * A blocked context must not stop the picture, and must not stop audio
     * from being scheduled either -- the schedule is what makes sound appear
     * in the right place the moment the block lifts.
     */
    it('still schedules audio while blocked', () => {
        FakeAudioContext.initialState = 'suspended';
        FakeAudioContext.resumeRefused = true;

        const harness = build();
        harness.output.start(0, 1);

        expect(harness.context.startedSources.length).toBeGreaterThan(0);
    });
});

describe('AudioOutput teardown', () => {

    it('stops every scheduled source on stop()', () => {
        const harness = build();
        harness.output.start(0, 1);
        const [source] = harness.context.startedSources;

        harness.output.stop();

        expect(source.stopped).toBe(true);
        expect(harness.output.playing).toBe(false);
    });

    it('schedules nothing more after stop()', () => {
        const harness = build();
        harness.output.start(0, 1);
        harness.output.stop();
        const after = harness.context.startedSources.length;

        harness.context.advance(UNIT_SECONDS);
        harness.setPlayhead(UNIT_SECONDS);
        jest.advanceTimersByTime(1000);

        expect(harness.context.startedSources).toHaveLength(after);
    });

    it('is safe to stop when nothing ever started', () => {
        const { output } = build();
        expect(() => output.stop()).not.toThrow();
    });

    /**
     * A context that outlives its engine keeps an output device open, and a
     * player that reloads items all day would accumulate one per load.
     */
    it('closes the audio context on close()', async () => {
        const harness = build();
        harness.output.start(0, 1);
        const context = harness.context;

        harness.output.close();
        await Promise.resolve();
        await Promise.resolve();

        expect(context.closed).toBe(true);
    });

    it('refuses to start again once closed', () => {
        const harness = build();
        harness.output.start(0, 1);
        harness.output.close();

        const contexts = FakeAudioContext.instances.length;
        harness.output.start(0, 1);

        expect(FakeAudioContext.instances).toHaveLength(contexts);
        expect(harness.output.playing).toBe(false);
    });
});
