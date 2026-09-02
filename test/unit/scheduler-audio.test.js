/**
 * Unit tests for the coupling between the Scheduler and its AudioOutput.
 *
 * The design rule these protect is one-directional: the scheduler tells audio
 * where playback is, and never asks. Audio can be stopped, silent, blocked or
 * absent without the picture noticing -- so every test here is of the form
 * "the picture did X, and audio was told to start from here / to stop".
 *
 * A recorded double stands in for AudioOutput, which is the point: the
 * scheduler must drive it entirely through start() and stop(), with no
 * knowledge of Web Audio at all.
 *
 * @fileoverview Unit tests for Scheduler's audio coupling.
 * @author Isaac Travers
 * @module video-engine/test/unit/scheduler-audio.test
 */

const { Scheduler } = require('../../src/scheduler.js');

/**
 * The render loop's own clock, stubbed to never fire.
 *
 * play() schedules a tick, and under Node there is no requestAnimationFrame
 * at all. A handle that is never called back is exactly right here: these
 * tests are about the transitions into and out of playback, not about frames
 * being presented, and a real ticking loop would only add timing to
 * assertions that should have none.
 */
beforeEach(() => {
    global.requestAnimationFrame = () => 1;
    global.cancelAnimationFrame = () => {};
});

afterEach(() => {
    delete global.requestAnimationFrame;
    delete global.cancelAnimationFrame;
});

/**
 * An AudioOutput double that records every call in order.
 *
 * @returns {Object} `{start, stop, close, calls}`.
 */
function makeAudioOutput() {
    const calls = [];
    return {
        calls,
        volume: 1,
        muted: false,
        blocked: false,
        start(mediaTime, rate) {
            calls.push({ kind: 'start', mediaTime, rate });
        },
        stop() {
            calls.push({ kind: 'stop' });
        },
        close() {
            calls.push({ kind: 'close' });
        },
    };
}

/**
 * A scheduler over enough of a pipeline to drive its state transitions,
 * without any real decoding, rendering or timing.
 *
 * @param {Object} audioOutput - The double to attach.
 * @returns {Scheduler} A scheduler with audio attached and one decoded unit.
 */
function makeScheduler(audioOutput) {
    const gopBuffer = { segmentIndex: 0, frames: [{ timestamp: 0 }, { timestamp: 1_000_000 }] };
    const buffers = new Map([[0, gopBuffer]]);

    const scheduler = new Scheduler({
        segmentIndex: {
            totalDuration: 2,
            segments: [{ index: 0, startTime: 0, endTime: 2, duration: 2 }],
        },
        frameStore: {
            buffers,
            has: (index) => buffers.has(index),
            setPinned: () => {},
            setEvictionPriority: () => {},
            isDecodeInBackoff: () => false,
            ensureDecoded: async () => gopBuffer,
            close: () => {},
            segmentFetcher: {
                hasRawBytes: () => true,
                ensureRawBytes: async () => new ArrayBuffer(0),
                setAnchorSegmentIndex: () => {},
                setProtectedRawSegments: () => {},
                preemptInFlightFetches: () => {},
                isFetchInBackoff: () => false,
                hasInFlightFetch: () => false,
                getInFlightFetchCount: () => 0,
                getInFlightFetchCountForSession: () => 0,
                sessionKeyFor: () => 'default',
                isBehindCoverageGap: () => false,
            },
        },
        canvasRenderer: { onFramePresented: () => {}, render: () => true, canvas: { width: 0, height: 0 } },
        emit: () => {},
    });

    scheduler.setAudioOutput(audioOutput);
    return scheduler;
}

/** Every start() call made, in order. */
const starts = (audio) => audio.calls.filter((call) => call.kind === 'start');

/** The most recent call of any kind. */
const last = (audio) => audio.calls[audio.calls.length - 1];

describe('Scheduler audio coupling', () => {

    it('starts audio from the playhead when playback starts', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);
        scheduler._presentedMediaTime = 1.25;

        scheduler.play();

        expect(starts(audio)).toHaveLength(1);
        expect(starts(audio)[0]).toMatchObject({ mediaTime: 1.25, rate: 1 });
        scheduler.pause();
    });

    it('stops audio when playback pauses', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);

        scheduler.play();
        scheduler.pause();

        expect(last(audio).kind).toBe('stop');
    });

    /**
     * Every buffer already scheduled sits on the old mapping from media time
     * to context time, so a rate change cannot be followed in place -- audio
     * restarts on the new mapping from where the picture is.
     */
    it('restarts audio at the new rate when the rate changes mid-playback', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);
        scheduler.play();
        scheduler._presentedMediaTime = 0.5;

        scheduler.setPlaybackRate(2);

        expect(starts(audio)).toHaveLength(2);
        expect(starts(audio)[1]).toMatchObject({ mediaTime: 0.5, rate: 2 });
        scheduler.pause();
    });

    /**
     * The rate band is AudioOutput's business, not the scheduler's -- so a
     * reverse rate is still passed through, and comes out silent because
     * start() treats an inaudible rate as an ordinary request for silence.
     */
    it('hands a reverse rate straight through rather than deciding for itself', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);
        scheduler.play();

        scheduler.setPlaybackRate(-1);

        expect(starts(audio)[1]).toMatchObject({ rate: -1 });
        scheduler.pause();
    });

    it('does not touch audio when the rate changes while paused', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);

        scheduler.setPlaybackRate(2);

        expect(audio.calls).toHaveLength(0);
    });

    /**
     * A stall freezes the picture while the wall clock keeps running, so
     * audio that carried on would be playing against a frame that is no
     * longer current.
     */
    it('stops audio when playback stalls and restarts it when the picture resumes', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);
        scheduler.play();
        audio.calls.length = 0;

        scheduler._updateBufferState('fetching');
        expect(last(audio).kind).toBe('stop');

        scheduler._presentedMediaTime = 3;
        scheduler._updateBufferState(null);
        expect(last(audio)).toMatchObject({ kind: 'start', mediaTime: 3 });

        scheduler.pause();
    });

    it('does not restart audio when a stall clears while paused', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);

        scheduler._updateBufferState('decoding');
        scheduler._updateBufferState(null);

        expect(starts(audio)).toHaveLength(0);
    });

    it('stops audio on the way into a seek and starts it again where the seek lands', async () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);
        scheduler.play();
        audio.calls.length = 0;

        await scheduler.seek(1);

        expect(audio.calls[0].kind).toBe('stop');
        expect(last(audio).kind).toBe('start');
        expect(last(audio).mediaTime).toBeCloseTo(1, 6);

        scheduler.pause();
    });

    it('leaves audio stopped after a seek that lands while paused', async () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);

        await scheduler.seek(1);

        expect(starts(audio)).toHaveLength(0);
        expect(last(audio).kind).toBe('stop');
    });

    it('closes the audio output when the engine closes', () => {
        const audio = makeAudioOutput();
        const scheduler = makeScheduler(audio);

        scheduler.close();

        expect(audio.calls.some((call) => call.kind === 'close')).toBe(true);
        expect(scheduler.audioOutput).toBeNull();
    });

    /**
     * Media with no audio track attaches no output at all, and every one of
     * these transitions has to stay a no-op rather than a crash.
     */
    it('runs every transition without an audio output attached', async () => {
        const scheduler = makeScheduler(makeAudioOutput());
        scheduler.setAudioOutput(null);

        expect(() => {
            scheduler.play();
            scheduler.setPlaybackRate(2);
            scheduler._updateBufferState('fetching');
            scheduler._updateBufferState(null);
            scheduler.pause();
        }).not.toThrow();

        await expect(scheduler.seek(1)).resolves.toBeUndefined();
        expect(() => scheduler.close()).not.toThrow();
    });
});
