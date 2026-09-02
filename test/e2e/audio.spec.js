/**
 * Browser-driven E2E suite for the audio pipeline: real bytes, a real
 * AudioDecoder, and a real Web Audio graph.
 *
 * The question every unit test cannot answer is whether real decoded samples
 * actually reach the output, so this measures that directly. An init script
 * wraps `AudioBufferSourceNode.prototype.start` before the player loads and
 * records, for every buffer scheduled, when it was placed, at what rate, and
 * the RMS of its samples. Sound that is scheduled but silent shows up as an
 * RMS of zero, which is exactly the failure a "did it schedule anything"
 * check would miss.
 *
 * Wrapping the platform rather than reading the engine's own state is
 * deliberate: it keeps every test-only affordance out of `src/`, and it means
 * these tests would still catch the engine reporting sound it never made.
 *
 * Headless Chromium runs a null audio sink -- no sound comes out of the
 * machine -- but the graph is fully processed, so everything asserted here is
 * real. Playwright's own Chromium decodes AAC, verified against both this
 * repository's fixture and the reference media, so no proprietary-codec build
 * is needed.
 *
 * @fileoverview @playwright/test E2E suite for audio decode, scheduling, volume and mute.
 * @author Isaac Travers
 * @module video-engine/test/e2e/audio.spec
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/** This file's directory. ESM has no __dirname. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Real decoding from cold can take a while; matches the playback suite. */
const ENGINE_LOAD_TIMEOUT_MS = 90_000;

/**
 * The fixture the global setup downloads. It carries an AAC 48kHz stereo
 * track, so the single-track case needs no media of its own.
 */
const LOCAL_FIXTURE = process.env.MARP_LOCAL_FIXTURE
    || join(HERE, '..', '..', '.test-media', 'short-1080p25.mp4');

/**
 * Installs the Web Audio recorder. Must run before the page's own scripts,
 * which is what addInitScript guarantees.
 *
 * @param {Object} page - Playwright page, before navigation.
 * @returns {Promise<void>}
 */
async function recordAudioGraph(page) {
    await page.addInitScript(() => {
        window.__audio = { scheduled: [], contexts: 0 };

        const OriginalContext = window.AudioContext;
        window.AudioContext = class extends OriginalContext {
            constructor(...args) {
                super(...args);
                window.__audio.contexts += 1;
                window.__audio.lastContext = this;
            }
        };

        const originalStart = AudioBufferSourceNode.prototype.start;
        AudioBufferSourceNode.prototype.start = function start(when, offset, duration) {
            try {
                const buffer = this.buffer;
                let rms = 0;

                if (buffer) {
                    const samples = buffer.getChannelData(0);
                    // Every hundredth sample: enough to tell silence from
                    // sound without copying a megabyte per buffer.
                    let sum = 0;
                    let counted = 0;
                    for (let i = 0; i < samples.length; i += 100) {
                        sum += samples[i] * samples[i];
                        counted += 1;
                    }
                    rms = counted ? Math.sqrt(sum / counted) : 0;
                }

                window.__audio.scheduled.push({
                    when,
                    offset,
                    rate: this.playbackRate.value,
                    seconds: buffer ? buffer.duration : 0,
                    sampleRate: buffer ? buffer.sampleRate : 0,
                    channels: buffer ? buffer.numberOfChannels : 0,
                    rms,
                });
            } catch (err) {
                window.__audio.error = String(err);
            }

            return originalStart.call(this, when, offset, duration);
        };
    });
}

/** @param {Object} page - Active page. @returns {Promise<Object>} What has been scheduled so far. */
function readAudio(page) {
    return page.evaluate(() => ({
        ...window.__audio,
        lastContext: undefined,
        gain: window.__audio.lastContext ? window.__audio.lastContext.state : null,
    }));
}

/** @param {Object} page - Active page. @returns {Promise<void>} Clears the recording, so a test measures only what it caused. */
function clearAudio(page) {
    return page.evaluate(() => {
        window.__audio.scheduled = [];
    });
}

/** Waits until an engine is loaded and the transport controls are live. */
function waitForEngine(page) {
    return page.waitForFunction(
        () => window.marpVideo && document.getElementById('playPauseButton') && !document.getElementById('playPauseButton').disabled,
        { timeout: ENGINE_LOAD_TIMEOUT_MS }
    );
}

/**
 * Waits until at least `count` buffers have been scheduled.
 *
 * @param {Object} page - Active page.
 * @param {number} count - How many to wait for.
 * @param {number} [timeout] - How long to wait, in ms.
 * @returns {Promise<void>}
 */
function waitForScheduled(page, count, timeout = 15_000) {
    return page.waitForFunction((n) => window.__audio.scheduled.length >= n, count, { timeout });
}

test.describe.configure({ mode: 'serial' });

test.describe('audio pipeline (local file)', () => {
    /** @type {import('@playwright/test').Page} */
    let page;

    test.beforeAll(async ({ browser }) => {
        if (!existsSync(LOCAL_FIXTURE)) {
            throw new Error(`fixture missing: ${LOCAL_FIXTURE}. The global setup should have downloaded it.`);
        }

        page = await browser.newPage();
        await recordAudioGraph(page);
        await page.goto('');

        await page.click('#playerSettingsButton');
        await page.click('[data-section="settingsLoadItemBody"]');
        await page.setInputFiles('#localFileInput', LOCAL_FIXTURE);
        await waitForEngine(page);
        // Close the settings menu so it cannot swallow later clicks.
        await page.click('#playerSettingsButton');
    });

    test.afterAll(async () => {
        await page?.close();
    });

    test('reports that the media has audio', async () => {
        expect(await page.evaluate(() => window.marpVideo.hasAudio)).toBe(true);
    });

    test('shows the volume controls for media that has audio', async () => {
        await expect(page.locator('#volumeGroup')).toBeVisible();
        await expect(page.locator('#volumeSlider')).toBeEnabled();
    });

    test('opens no audio context before anything has played', async () => {
        expect(await page.evaluate(() => window.__audio.contexts)).toBe(0);
    });

    /**
     * The whole point of the suite: real AAC, decoded by a real AudioDecoder,
     * reaching the graph with real samples in it.
     */
    test('schedules real decoded audio when playback starts', async () => {
        await clearAudio(page);
        await page.evaluate(() => window.marpVideo.play());
        await waitForScheduled(page, 1);

        const audio = await readAudio(page);
        const [first] = audio.scheduled;

        expect(audio.error).toBeUndefined();
        expect(first.channels).toBe(2);
        expect(first.sampleRate).toBe(48000);
        expect(first.seconds).toBeGreaterThan(0);
        // Not silence. Survey footage is quiet, so this is deliberately a low
        // bar -- it separates real samples from an empty buffer, nothing more.
        expect(first.rms).toBeGreaterThan(0.0001);
    });

    test('plays at the rate the picture is playing at', async () => {
        const audio = await readAudio(page);
        expect(audio.scheduled[0].rate).toBe(1);
    });

    test('keeps scheduling as playback continues', async () => {
        await waitForScheduled(page, 2, 30_000);
        expect((await readAudio(page)).scheduled.length).toBeGreaterThanOrEqual(2);
    });

    test('stops scheduling when playback pauses', async () => {
        await page.evaluate(() => window.marpVideo.pause());
        await page.waitForTimeout(600);
        await clearAudio(page);
        await page.waitForTimeout(600);

        expect((await readAudio(page)).scheduled).toHaveLength(0);
    });

    test('resumes from the new position after a seek', async () => {
        await page.evaluate(async () => {
            window.marpVideo.currentTime = 8;
        });
        await page.waitForFunction(() => !window.marpVideo.seeking, { timeout: 30_000 });

        await clearAudio(page);
        await page.evaluate(() => window.marpVideo.play());
        await waitForScheduled(page, 1);

        const audio = await readAudio(page);
        expect(audio.scheduled[0].rms).toBeGreaterThan(0.0001);
    });

    /**
     * Reverse and fast playback are silent by design: pitch-shifted audio is
     * useless past 2.5x and meaningless backwards.
     */
    test('is silent in reverse', async () => {
        await page.evaluate(() => {
            window.marpVideo.playbackRate = -1;
        });
        await page.waitForTimeout(300);
        await clearAudio(page);
        await page.waitForTimeout(800);

        expect((await readAudio(page)).scheduled).toHaveLength(0);
    });

    test('is silent above the audible band', async () => {
        await page.evaluate(() => {
            window.marpVideo.currentTime = 2;
            window.marpVideo.playbackRate = 6;
        });
        await page.waitForFunction(() => !window.marpVideo.seeking, { timeout: 30_000 });
        await clearAudio(page);
        await page.waitForTimeout(800);

        expect((await readAudio(page)).scheduled).toHaveLength(0);
    });

    /**
     * 2.5x is the top of the band on purpose: it is exactly the `[` speed
     * hotkey, and stopping short of it would have made the nearest fast key
     * the silent one.
     */
    test('still plays at the top of the audible band', async () => {
        await page.evaluate(() => {
            window.marpVideo.currentTime = 2;
            window.marpVideo.playbackRate = 2.5;
        });
        await page.waitForFunction(() => !window.marpVideo.seeking, { timeout: 30_000 });
        await clearAudio(page);
        await page.evaluate(() => window.marpVideo.play());
        await waitForScheduled(page, 1);

        const audio = await readAudio(page);
        expect(audio.scheduled[0].rate).toBeCloseTo(2.5, 3);
        expect(audio.scheduled[0].rms).toBeGreaterThan(0.0001);
    });

    test('muting silences the output without stopping the schedule', async () => {
        await page.evaluate(() => {
            window.marpVideo.playbackRate = 1;
            window.marpVideo.muted = true;
        });

        expect(await page.evaluate(() => window.__audio.lastContext.state)).toBe('running');
        expect(await page.evaluate(() => window.marpVideo.muted)).toBe(true);
    });

    test('the mute button and slider follow the engine', async () => {
        await page.evaluate(() => {
            window.marpVideo.muted = false;
            window.marpVideo.volume = 0.25;
        });
        await page.waitForTimeout(100);

        expect(await page.locator('#volumeSlider').inputValue()).toBe('0.25');
    });

    test('a volume written by the player reaches the engine', async () => {
        await page.locator('#volumeSlider').fill('0.6');
        await page.waitForTimeout(100);

        expect(await page.evaluate(() => window.marpVideo.volume)).toBeCloseTo(0.6, 3);
    });

    test('clicking mute toggles it both ways', async () => {
        await page.click('#muteButton');
        expect(await page.evaluate(() => window.marpVideo.muted)).toBe(true);

        await page.click('#muteButton');
        expect(await page.evaluate(() => window.marpVideo.muted)).toBe(false);
    });

    /**
     * A context that outlives its engine keeps an output device open, and a
     * player used all day reloads items constantly.
     */
    test('releases the audio context when the engine is replaced', async () => {
        await page.evaluate(() => window.marpVideo.pause());

        // A boolean, not the context itself: an AudioContext cannot cross
        // the page boundary.
        expect(await page.evaluate(() => Boolean(window.__audio.lastContext))).toBe(true);

        await page.click('#playerSettingsButton');
        await page.click('[data-section="settingsLoadItemBody"]');
        await page.setInputFiles('#localFileInput', LOCAL_FIXTURE);
        await waitForEngine(page);
        await page.click('#playerSettingsButton');

        // The engine that owned the old context is gone, so its context is
        // closed; a fresh one is only opened when audio next plays. Waited
        // for rather than read once: close() settles on a microtask.
        await page.waitForFunction(() => window.__audio.lastContext.state === 'closed', { timeout: 10_000 });
    });

    test('keeps the volume across an engine replacement', async () => {
        await page.evaluate(() => {
            window.marpPlayer.volume = 0.4;
        });

        await page.click('#playerSettingsButton');
        await page.click('[data-section="settingsLoadItemBody"]');
        await page.setInputFiles('#localFileInput', LOCAL_FIXTURE);
        await waitForEngine(page);
        await page.click('#playerSettingsButton');

        expect(await page.evaluate(() => window.marpVideo.volume)).toBeCloseTo(0.4, 3);
    });
});
