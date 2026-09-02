/**
 * Unit tests for MarpVideoShim's audio surface.
 *
 * This is the surface the C# WebView2 host has been writing to all along --
 * `MarpMediaElement.xaml.cs` sets `window.marpVideo.volume` and
 * `window.marpVideo.muted` on every Volume write, and did so while both were
 * inert. So the contract these protect is not new: it is that those writes now
 * reach real audio, and that they still cannot throw when there is none.
 *
 * @fileoverview Unit tests for the shim's volume, mute and audio-state surface.
 * @author Isaac Travers
 * @module video-engine/test/unit/marp-video-shim-audio.test
 */

const { MarpVideoShim } = require('../../src/marp-video-shim.js');

/**
 * A scheduler stand-in with an optional audio output attached.
 *
 * @param {?Object} audioOutput - The output to expose, or null for media with no audio.
 * @returns {Object} A scheduler-shaped object.
 */
function makeScheduler(audioOutput) {
    return {
        audioOutput,
        currentTime: 0,
        duration: 10,
        playing: false,
        seekingFlag: false,
        playbackRate: 1,
        seek: async () => {},
    };
}

/**
 * An AudioOutput stand-in that records what was written to it.
 *
 * @returns {Object} An output with volume, muted, blocked and resume().
 */
function makeAudioOutput() {
    return {
        volume: 1,
        muted: false,
        blocked: false,
        resumeCalls: 0,
        async resume() {
            this.resumeCalls += 1;
            this.blocked = false;
            return true;
        },
    };
}

/**
 * @param {?Object} audioOutput - Output to attach.
 * @returns {MarpVideoShim} A shim over a scheduler carrying that output.
 */
function makeShim(audioOutput) {
    return new MarpVideoShim(makeScheduler(audioOutput), { videoWidth: 1920, videoHeight: 1080, fps: 25 });
}

describe('MarpVideoShim audio surface', () => {

    it('starts audible at full volume, the way a browser video player does', () => {
        const shim = makeShim(makeAudioOutput());

        expect(shim.volume).toBe(1);
        expect(shim.muted).toBe(false);
    });

    it('passes a volume write through to the audio output', () => {
        const audio = makeAudioOutput();
        const shim = makeShim(audio);

        shim.volume = 0.4;

        expect(shim.volume).toBeCloseTo(0.4, 6);
        expect(audio.volume).toBeCloseTo(0.4, 6);
    });

    it('passes a mute write through to the audio output', () => {
        const audio = makeAudioOutput();
        const shim = makeShim(audio);

        shim.muted = true;

        expect(shim.muted).toBe(true);
        expect(audio.muted).toBe(true);
    });

    it('clamps volume to 0..1 and ignores a value that is not a number', () => {
        const shim = makeShim(makeAudioOutput());

        shim.volume = 9;
        expect(shim.volume).toBe(1);

        shim.volume = -1;
        expect(shim.volume).toBe(0);

        shim.volume = 'loud';
        expect(shim.volume).toBe(0);
    });

    it('keeps volume and mute independent, the way HTMLMediaElement does', () => {
        const shim = makeShim(makeAudioOutput());

        shim.volume = 0.7;
        shim.muted = true;
        expect(shim.volume).toBeCloseTo(0.7, 6);

        shim.muted = false;
        expect(shim.volume).toBeCloseTo(0.7, 6);
    });

    it('fires volumechange with both values on either write', () => {
        const shim = makeShim(makeAudioOutput());
        const events = [];
        shim.addEventListener('volumechange', (event) => events.push(event));

        shim.volume = 0.5;
        shim.muted = true;

        expect(events).toHaveLength(2);
        expect(events[0]).toMatchObject({ volume: 0.5, muted: false });
        expect(events[1]).toMatchObject({ volume: 0.5, muted: true });
    });

    it('does not fire volumechange for a write that changes nothing', () => {
        const shim = makeShim(makeAudioOutput());
        const events = [];
        shim.addEventListener('volumechange', (event) => events.push(event));

        shim.volume = 1;
        shim.muted = false;

        expect(events).toHaveLength(0);
    });

    it('reports whether the media has audio', () => {
        expect(makeShim(makeAudioOutput()).hasAudio).toBe(true);
        expect(makeShim(null).hasAudio).toBe(false);
    });

    it('reports and lifts an autoplay block', async () => {
        const audio = makeAudioOutput();
        audio.blocked = true;
        const shim = makeShim(audio);

        expect(shim.audioBlocked).toBe(true);

        await expect(shim.resumeAudio()).resolves.toBe(true);
        expect(audio.resumeCalls).toBe(1);
        expect(shim.audioBlocked).toBe(false);
    });

    /**
     * The reason volume state lives on the shim rather than on the audio
     * output: the host writes it on every load regardless of what was loaded,
     * and a clip with no audio track has no output for it to reach. It has to
     * be accepted and remembered rather than thrown away or thrown at.
     */
    describe('media with no audio track', () => {

        it('accepts and remembers volume and mute writes', () => {
            const shim = makeShim(null);

            expect(() => {
                shim.volume = 0.3;
                shim.muted = true;
            }).not.toThrow();

            expect(shim.volume).toBeCloseTo(0.3, 6);
            expect(shim.muted).toBe(true);
        });

        it('still fires volumechange, so a host UI stays in step', () => {
            const shim = makeShim(null);
            const events = [];
            shim.addEventListener('volumechange', (event) => events.push(event));

            shim.volume = 0.2;

            expect(events).toHaveLength(1);
        });

        it('is never blocked and resumes to false rather than throwing', async () => {
            const shim = makeShim(null);

            expect(shim.audioBlocked).toBe(false);
            await expect(shim.resumeAudio()).resolves.toBe(false);
        });
    });
});
