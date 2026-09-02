/**
 * Plays decoded audio units through Web Audio, timed by the video's clock.
 *
 * The one rule this module exists to obey: **there is no second clock.** The
 * scheduler's wall-clock anchor (`_anchorWallClockMs`/`_anchorTime` in
 * scheduler.js) decides where playback is, and everything here is derived
 * from it. Audio is scheduled against that position and never read back into
 * it, so audio can be late, absent, or silent without the picture moving by
 * a single frame.
 *
 * The mechanism is the standard Web Audio look-ahead: a timer runs a few
 * times a second, and each pass schedules whichever units fall inside the
 * look-ahead window at absolute `AudioContext` times computed from the video
 * position. Nothing is ever scheduled "now and hope"; every buffer is placed
 * at a time derived from the anchor.
 *
 * Two clocks do exist in the machine underneath -- `performance.now()` is the
 * system clock and `AudioContext.currentTime` is the audio hardware's -- and
 * they drift apart by tens of parts per million. That is the only drift this
 * module can suffer, and each pass measures it and resyncs past a threshold.
 * At a typical 50 ppm that is one correction every quarter of an hour or so.
 *
 * Audio never blocks, never fetches, and never throws into the playback path.
 * Everything it can fail at costs sound and nothing else.
 *
 * @fileoverview Web Audio playback of decoded audio units, slaved to the video clock.
 * @author Isaac Travers
 * @module video-engine/audio-output
 */

import { findSegmentForTime } from './playlist-manager.js';

/**
 * Slowest and fastest rates at which audio is played.
 *
 * Rate is applied with `AudioBufferSourceNode.playbackRate`, which resamples
 * and so shifts pitch with speed -- there is no time-stretching here. The
 * band is set by where that stops being useful rather than by where it stops
 * working: below half speed it is an unintelligible rumble, and beyond 2.5x
 * it is a shriek. 2.5x is deliberately the top rather than 2x, because it is
 * exactly the `[` speed hotkey (see SPEED_KEYMAP in ui/player-ui.js), and a
 * band that stopped just short of it would make the nearest fast key the
 * silent one.
 *
 * Outside the band, and in reverse at any speed, audio simply stops.
 *
 * @constant
 * @type {number}
 */
const MIN_AUDIBLE_RATE = 0.5;

/** @constant @type {number} */
const MAX_AUDIBLE_RATE = 2.5;

/** How often the look-ahead scheduling pass runs, in ms. */
const SCHEDULE_INTERVAL_MS = 200;

/** How far ahead of the audio clock units are scheduled, in seconds. Comfortably more than one pass interval, so a late pass cannot leave a gap. */
const LOOKAHEAD_SECONDS = 0.5;

/**
 * How far audio may drift from the video position before it is resynced,
 * in seconds.
 *
 * One frame at 25fps is 40ms, and published lip-sync tolerance is tighter for
 * audio leading the picture than lagging it. 50ms sits just past a frame,
 * which keeps corrections rare -- each one is an audible discontinuity, so
 * correcting too eagerly is its own defect.
 *
 * @constant
 * @type {number}
 */
const DRIFT_LIMIT_SECONDS = 0.05;

/** Gain ramp for volume and mute changes, in seconds. Long enough that a change is not a click, short enough to feel instant. */
const GAIN_RAMP_SECONDS = 0.015;

/**
 * Whether audio is played at a given playback rate.
 *
 * @param {number} rate - Playback rate; negative values play in reverse.
 * @returns {boolean} True when the rate is forward and inside the audible band.
 */
export function isRateAudible(rate) {
    return Number.isFinite(rate) && rate >= MIN_AUDIBLE_RATE && rate <= MAX_AUDIBLE_RATE;
}

/**
 * Schedules decoded audio units through an AudioContext, timed by the video.
 *
 * @class AudioOutput
 */
export class AudioOutput {
    /**
     * @param {Object} params
     * @param {Object} params.segmentIndex - SegmentIndex, for mapping a media time onto a unit.
     * @param {Object} params.store - {@link module:video-engine/audio-store.AudioStore} instance.
     * @param {function(): number} params.getPlayheadTime - Reads the authoritative media position, in seconds. This is the clock.
     * @param {function(string): void} [params.onDebug] - Progress messages.
     * @param {function(): void} [params.onStateChange] - Called when the browser's willingness to make sound changes, so a consumer can re-read {@link AudioOutput#blocked} and tell someone. Deliberately NOT called for volume and mute: those are set from outside, and whoever set them announces them.
     */
    constructor({ segmentIndex, store, getPlayheadTime, onDebug, onStateChange }) {
        this.segmentIndex = segmentIndex;
        this.store = store;
        this.getPlayheadTime = getPlayheadTime;
        this.onDebug = onDebug;
        this.onStateChange = onStateChange;

        this._context = null;
        this._gain = null;

        this._volume = 1;
        this._muted = false;
        this._blocked = false;

        this._playing = false;
        this._rate = 1;
        this._closed = false;

        // The media-time-to-context-time mapping, set on every start().
        this._baseMediaTime = 0;
        this._baseContextTime = 0;

        // Where scheduling has reached. Driven by unit index rather than by
        // time, so a unit whose decoded audio ends fractionally before its
        // video unit does cannot leave the cursor inside the same unit and
        // schedule it forever.
        this._cursorUnit = 0;
        this._cursorMediaTime = 0;

        this._scheduled = [];
        this._timerHandle = null;

        // Bumped on every start and stop. A unit decode that lands after the
        // run it belonged to has ended checks this and drops its result
        // rather than scheduling audio for a position playback has left.
        this._epoch = 0;
    }

    /** @returns {number} Current volume, 0 to 1. */
    get volume() {
        return this._volume;
    }

    /** @param {number} value - New volume, clamped to 0..1. */
    set volume(value) {
        const clamped = Math.max(0, Math.min(1, Number(value)));
        if (clamped === this._volume) {
            return;
        }
        this._volume = clamped;
        this._applyGain();
    }

    /** @returns {boolean} Whether audio is muted. */
    get muted() {
        return this._muted;
    }

    /** @param {boolean} value - New mute state. */
    set muted(value) {
        const next = Boolean(value);
        if (next === this._muted) {
            return;
        }
        this._muted = next;
        this._applyGain();
    }

    /**
     * Whether the browser is refusing to let the audio context run.
     *
     * True when an AudioContext has been created and is still suspended
     * despite a resume attempt -- the autoplay policy, which requires a user
     * gesture before a page may make sound. The picture is unaffected; only
     * sound is withheld, and {@link AudioOutput#resume} lifts it once a
     * gesture has happened.
     *
     * @returns {boolean} True while sound is blocked by the browser.
     */
    get blocked() {
        return this._blocked;
    }

    /** @returns {boolean} True while audio is scheduled to play. */
    get playing() {
        return this._playing;
    }

    /**
     * Attempts to bring the audio context out of the suspended state the
     * autoplay policy starts it in. Safe to call repeatedly, and from a
     * gesture handler.
     *
     * @async
     * @returns {Promise<boolean>} True if the context is running afterwards.
     */
    async resume() {
        if (this._closed || !this._context) {
            return false;
        }

        if (this._context.state === 'suspended') {
            try {
                await this._context.resume();
            } catch (err) {
                this._logDebug(`could not resume the audio context: ${err.message}`);
            }
        }

        const running = this._context.state === 'running';
        this._setBlocked(!running);
        return running;
    }

    /**
     * Starts audio from a media position, at a playback rate.
     *
     * A rate outside the audible band is not an error and not a special case
     * for the caller to check -- it simply stops audio, which is what the
     * caller wanted by setting that rate.
     *
     * @param {number} mediaTime - Media position to start from, in seconds.
     * @param {number} rate - Playback rate.
     * @returns {void}
     */
    start(mediaTime, rate) {
        if (this._closed) {
            return;
        }

        this.stop();

        if (!isRateAudible(rate)) {
            return;
        }

        this._ensureContext();
        if (!this._context) {
            return;
        }

        // Fire and forget: if the gesture has not happened yet this leaves
        // `blocked` set and no sound, and the picture carries on regardless.
        this.resume();

        this._rate = rate;
        this._playing = true;
        this._epoch += 1;

        this._baseMediaTime = mediaTime;
        this._baseContextTime = this._context.currentTime;
        this._cursorUnit = findSegmentForTime(this.segmentIndex, mediaTime).index;
        this._cursorMediaTime = mediaTime;

        // Run one pass immediately rather than waiting a full interval, so
        // audio starts with the picture instead of up to 200ms after it.
        this._pass();

        this._timerHandle = setInterval(() => this._pass(), SCHEDULE_INTERVAL_MS);
    }

    /**
     * Stops audio and cancels everything scheduled.
     *
     * @returns {void}
     */
    stop() {
        if (this._timerHandle !== null) {
            clearInterval(this._timerHandle);
            this._timerHandle = null;
        }

        this._playing = false;
        this._epoch += 1;

        for (const source of this._scheduled) {
            try {
                source.onended = null;
                source.stop();
                source.disconnect();
            } catch (err) {
                // stop() throws if the node never started or has already
                // ended. Both mean it is not playing, which is the point.
            }
        }
        this._scheduled = [];
    }

    /**
     * Releases the audio context and everything under it.
     *
     * @returns {void}
     */
    close() {
        this.stop();
        this._closed = true;

        if (this._context) {
            const context = this._context;
            this._context = null;
            this._gain = null;
            // A context that outlives its engine keeps an output device open;
            // a reload replacing the engine would otherwise accumulate them.
            Promise.resolve()
                .then(() => context.close())
                .catch(() => {});
        }
    }

    /**
     * One look-ahead scheduling pass: correct any drift, then schedule
     * whatever now falls inside the window.
     *
     * @returns {void}
     */
    _pass() {
        if (!this._playing || !this._context || this._closed) {
            return;
        }

        if (this._correctDrift()) {
            return;
        }

        const context = this._context;
        const segments = this.segmentIndex.segments;

        while (
            this._cursorUnit < segments.length &&
            this._contextTimeFor(this._cursorMediaTime) < context.currentTime + LOOKAHEAD_SECONDS
        ) {
            const unit = this.store.get(this._cursorUnit);

            if (!unit) {
                // Not decoded yet. Leave the cursor where it is and try again
                // next pass: the mapping from media time to context time is
                // unchanged, so whatever arrives late is placed at its real
                // position and the hole is silence, not a shift.
                this.store.request(this._cursorUnit);
                break;
            }

            this._scheduleUnit(unit);

            this._cursorUnit += 1;
            const nextSegment = segments[this._cursorUnit];
            this._cursorMediaTime = nextSegment
                ? Math.max(unit.mediaEnd, nextSegment.startTime)
                : unit.mediaEnd;
        }

        // Keep the cursor's unit and the one after it warm, so the next pass
        // usually finds them decoded rather than starting from cold. Bounded
        // rather than left to the store to reject: asking for a unit past the
        // end of the stream is this module getting it wrong, not the store's
        // job to absorb.
        for (let index = this._cursorUnit; index <= this._cursorUnit + 1 && index < segments.length; index++) {
            this.store.request(index);
        }
    }

    /**
     * Measures how far the scheduled audio has drifted from the video
     * position, and restarts audio there if it is past the limit.
     *
     * This is the only place the two hardware clocks are reconciled, and it
     * only ever moves audio. It also covers every case where the picture
     * moved without audio being told -- a stall, a rate change applied
     * elsewhere -- because those show up here as exactly the same thing: the
     * playhead is no longer where the schedule says.
     *
     * @returns {boolean} True if audio was restarted, meaning this pass is over.
     */
    _correctDrift() {
        const playhead = this.getPlayheadTime();
        if (!Number.isFinite(playhead)) {
            return false;
        }

        const scheduledNow = this._baseMediaTime + (this._context.currentTime - this._baseContextTime) * this._rate;
        const error = playhead - scheduledNow;

        if (Math.abs(error) <= DRIFT_LIMIT_SECONDS) {
            return false;
        }

        this._logDebug(`resyncing audio: ${(error * 1000).toFixed(1)}ms from the picture`);
        this.start(playhead, this._rate);
        return true;
    }

    /**
     * Schedules one decoded unit at the context time its media position maps
     * to.
     *
     * @param {Object} unit - A decoded unit from the store.
     * @returns {void}
     */
    _scheduleUnit(unit) {
        if (!unit.channels || unit.channels.length === 0 || unit.mediaEnd <= unit.mediaStart) {
            return;
        }

        const context = this._context;
        const fromMediaTime = Math.max(this._cursorMediaTime, unit.mediaStart);

        let offsetSeconds = fromMediaTime - unit.mediaStart;
        let when = this._contextTimeFor(fromMediaTime);

        if (when < context.currentTime) {
            // Behind: the unit arrived after the moment it should have
            // started. Skip into the buffer by exactly how late it is, so
            // what plays is still the right audio for the picture -- rather
            // than playing it from the top and putting everything after it
            // out of sync.
            offsetSeconds += (context.currentTime - when) * this._rate;
            when = context.currentTime;
        }

        const playableSeconds = unit.mediaEnd - unit.mediaStart - offsetSeconds;
        if (offsetSeconds < 0 || playableSeconds <= 0) {
            return;
        }

        // Whichever is smaller: a unit whose declared channel count outran the
        // planes the decoder actually produced would otherwise copy from an
        // undefined channel and throw, taking out the whole scheduling pass
        // over what should at worst be a quieter unit.
        const channelCount = Math.min(unit.numberOfChannels, unit.channels.length);
        const buffer = context.createBuffer(channelCount, unit.channels[0].length, unit.sampleRate);
        for (let channel = 0; channel < channelCount; channel++) {
            buffer.copyToChannel(unit.channels[channel], channel);
        }

        const source = context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this._rate;
        source.connect(this._gain);

        const epoch = this._epoch;
        source.onended = () => {
            if (epoch !== this._epoch) {
                return;
            }
            const index = this._scheduled.indexOf(source);
            if (index !== -1) {
                this._scheduled.splice(index, 1);
            }
        };

        source.start(when, offsetSeconds);
        this._scheduled.push(source);
    }

    /**
     * Maps a media position onto the absolute AudioContext time it should be
     * heard at.
     *
     * @param {number} mediaTime - Media position, in seconds.
     * @returns {number} Absolute context time, in seconds.
     */
    _contextTimeFor(mediaTime) {
        return this._baseContextTime + (mediaTime - this._baseMediaTime) / this._rate;
    }

    /**
     * Creates the AudioContext and gain node on first use.
     *
     * Deferred rather than built in the constructor so a player whose audio
     * is never used -- muted throughout, or media with no audio track at all
     * -- never opens an output device.
     *
     * @returns {void}
     */
    _ensureContext() {
        if (this._context || this._closed) {
            return;
        }

        const Constructor = typeof AudioContext !== 'undefined' ? AudioContext : globalThis.webkitAudioContext;
        if (!Constructor) {
            this._logDebug('this browser has no AudioContext; playback will be silent');
            return;
        }

        try {
            // Left at the default sample rate deliberately. An AudioBuffer
            // whose rate differs from the context's is resampled on playback
            // (verified against this project's own 96kHz test media), so
            // opening the context at the media's rate would buy nothing and
            // would mean a new context for every differently encoded item.
            this._context = new Constructor();
            this._gain = this._context.createGain();
            this._gain.connect(this._context.destination);
            this._applyGain();
            this._setBlocked(this._context.state === 'suspended');
        } catch (err) {
            this._logDebug(`could not create an audio context: ${err.message}`);
            this._context = null;
            this._gain = null;
        }
    }

    /**
     * Writes the current volume and mute state onto the gain node, with a
     * short ramp so a change is not a click.
     *
     * @returns {void}
     */
    _applyGain() {
        if (!this._gain) {
            return;
        }

        const target = this._muted ? 0 : this._volume;

        if (typeof this._gain.gain.setTargetAtTime === 'function') {
            this._gain.gain.setTargetAtTime(target, this._context.currentTime, GAIN_RAMP_SECONDS);
        } else {
            this._gain.gain.value = target;
        }
    }

    /**
     * @param {boolean} blocked - Whether the browser is withholding sound.
     * @returns {void}
     */
    _setBlocked(blocked) {
        if (blocked === this._blocked) {
            return;
        }
        this._blocked = blocked;
        this._notify();
    }

    /** @returns {void} */
    _notify() {
        if (this.onStateChange) {
            this.onStateChange();
        }
    }

    /**
     * @param {string} message - Message text, without the module prefix.
     * @returns {void}
     */
    _logDebug(message) {
        const prefixed = `[audio-output] ${message}`;
        console.log(prefixed);
        if (this.onDebug) {
            this.onDebug(prefixed);
        }
    }
}
