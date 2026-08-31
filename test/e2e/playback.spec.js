/**
 * Browser-driven E2E suite for the video-engine, using @playwright/test to
 * drive a real Chromium instance against the VideoPlayer app.
 *
 * The same playback checks run against EVERY media source -- a local file,
 * Jellyfin Direct Play, and a Jellyfin transcode -- because the whole point
 * of the media-source layer is that playback behaves identically whatever
 * is underneath it. Running them per source is what catches a change made
 * for one path regressing another, which has happened.
 *
 * The local-file suite is the reliable one: same bytes every run, no
 * transcoder, no sessions, no network. The Jellyfin suites depend on a live
 * server that may have to transcode segments from cold, so they are slower
 * and less deterministic by nature.
 *
 * The Direct Play suite needs REAL GPU decode. Its units are ~250-frame
 * 1080p GOPs, which a software decoder (the dev sandbox's SwiftShader)
 * cannot keep up with -- it fails there with VideoDecoder flush stalls that
 * say nothing about the engine. Run a single source with Playwright's own
 * filter when that matters, e.g.
 *   npx playwright test --config video-engine/playwright.config.js --grep "local file"
 *
 * One shared page per source (test.beforeAll + serial mode), NOT
 * Playwright's per-test page: the engine load is by far the most expensive
 * step, and each check is cheap once it is up. These are a sequential walk
 * through one session's state, not independent scenarios.
 *
 * Requires the dev server running (`node ./server.js`) and Chromium's
 * system dependencies (`sudo npx playwright install-deps chromium`).
 *
 * @fileoverview @playwright/test E2E suite, run against every media source.
 * @author Isaac Travers
 * @module video-engine/test/e2e/playback.spec
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/** This file's directory. ESM has no __dirname. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Real segment fetch time against the live Jellyfin server over a slow connection has been observed taking 30s+ for a single segment. */
const ENGINE_LOAD_TIMEOUT_MS = 90_000;

/**
 * A real 1080p MP4 on disk.
 *
 * Defaults to the fixture the global setup downloads into .test-media/, so this
 * suite needs no manual preparation. Set MARP_LOCAL_FIXTURE to point at your
 * own footage instead.
 */
const LOCAL_FIXTURE = process.env.MARP_LOCAL_FIXTURE
    || join(HERE, '..', '..', '.test-media', 'short-1080p25.mp4');

/**
 * Reads the current window.marpVideo playback state from the page.
 *
 * @param {Object} page - Active Playwright page.
 * @returns {Promise<{currentTime: number, paused: boolean, duration: number, fps: number}>} Current playback state.
 */
function getPlaybackState(page) {
    return page.evaluate(() => ({
        currentTime: window.marpVideo.currentTime,
        paused: window.marpVideo.paused,
        duration: window.marpVideo.duration,
        fps: window.marpVideo.fps,
    }));
}

/**
 * Signs in to the dev Jellyfin server through the settings menu.
 *
 * loadItem() refuses to do anything without an authenticated client, and a
 * fresh Playwright page has no stored session -- without this every
 * Jellyfin test fails identically with "sign in to a Jellyfin server
 * first" rather than any real playback problem.
 *
 * @param {Object} page - Active Playwright page.
 * @returns {Promise<void>}
 */
async function signIn(page) {
    const serverUrl = process.env.VIDEO_ENGINE_TEST_JELLYFIN_URL;
    const username = process.env.VIDEO_ENGINE_TEST_JELLYFIN_USERNAME;
    const password = process.env.VIDEO_ENGINE_TEST_JELLYFIN_PASSWORD;
    if (!serverUrl || !username || !password) {
        throw new Error('VIDEO_ENGINE_TEST_JELLYFIN_URL/USERNAME/PASSWORD must be set (see .env) to run this suite.');
    }
    // The login fields live inside the gear menu's "Server / Login"
    // accordion section, hidden until the gear button opens the menu.
    await page.click('#playerSettingsButton');
    await page.fill('#jellyfinServerUrlInput', serverUrl);
    await page.fill('#jellyfinUsernameInput', username);
    await page.fill('#jellyfinPasswordInput', password);
    await page.click('#jellyfinLoginButton');
    await page.waitForFunction(() => document.getElementById('loginStatus').textContent.startsWith('Signed in'), {
        timeout: 15_000,
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
 * The sources under test. Each loads the app a different way; everything
 * after that is identical, which is the property being tested.
 *
 * Tiers are passed to loadItem() directly rather than clicked in the
 * quality menu: clicking would load the app's default source first and then
 * reload, paying two engine loads. The harness page exposes the player's
 * loadItem as a window global for exactly this.
 */
const SOURCES = [
    {
        name: 'local file',
        needsJellyfin: false,
        // The global setup downloads this, so a missing file means setup did
        // not run or failed -- a real problem, not a reason to quietly skip.
        skip: !existsSync(LOCAL_FIXTURE)
            && `fixture missing: ${LOCAL_FIXTURE}. The global setup should have downloaded it.`,
        load: async (page) => {
            await page.click('#playerSettingsButton');
            await page.click('[data-section="settingsLoadItemBody"]');
            await page.setInputFiles('#localFileInput', LOCAL_FIXTURE);
        },
    },
    {
        name: 'Jellyfin Direct Play',
        needsJellyfin: true,
        load: async (page) => {
            await page.evaluate(async () => {
                await loadItem(document.getElementById('itemIdInput').value.trim(), { name: 'Direct Play', directPlay: true });
            });
        },
    },
    {
        name: 'Jellyfin transcode',
        needsJellyfin: true,
        load: async (page) => {
            // 'Auto' (the source's own bitrate/resolution) is the tier this
            // suite has always exercised -- it was the app's default before
            // Direct Play took that place.
            await page.evaluate(async () => {
                await loadItem(document.getElementById('itemIdInput').value.trim(), {
                    name: 'Auto',
                    maxStreamingBitrate: 7_950_247,
                    maxWidth: 1920,
                    maxHeight: 1080,
                });
            });
        },
    },
];

for (const source of SOURCES) {
    test.describe(`video-engine playback (${source.name})`, () => {
        // Serial: later tests build on state left behind by earlier ones
        // (reverse starts wherever forward finished), and an early failure
        // should skip the rest rather than cascade into confusing ones.
        test.describe.configure({ mode: 'serial' });

        let page;
        let consoleErrors;

        test.skip(Boolean(source.skip), source.skip || '');

        test.beforeAll(async ({ browser }) => {
            // Playwright's per-test timeout also bounds this hook, and a
            // cold engine load can exceed it on its own.
            test.setTimeout(ENGINE_LOAD_TIMEOUT_MS + 60_000);

            page = await browser.newPage();
            consoleErrors = [];
            page.on('console', (message) => {
                if (message.type() === 'error') {
                    consoleErrors.push(message.text());
                }
            });
            page.on('pageerror', (err) => consoleErrors.push(`pageerror: ${err.message}`));

            // Deliberately '', not '/' -- a leading slash resolves against
            // baseURL's ORIGIN only, discarding its /apps/VideoPlayer/ path
            // and landing on the marketing homepage, which has no #loadButton
            // and looks exactly like a hang.
            await page.goto('', { waitUntil: 'load' });

            if (source.needsJellyfin) {
                await signIn(page);
            }
            await source.load(page);
            await waitForEngine(page);
        });

        test.afterAll(async () => {
            if (page) {
                await page.close();
            }
        });

        test.afterEach(() => {
            // A real assertion, not just a printed count, so a console error
            // fails the test it happened during.
            expect(consoleErrors, `console errors during the test: ${consoleErrors.join('; ')}`).toHaveLength(0);
            consoleErrors.length = 0;
        });

        test('time advances forward while playing at 1x', async () => {
            const before = await getPlaybackState(page);
            await page.click('#playPauseButton');
            await page.waitForTimeout(2000);
            const after = await getPlaybackState(page);
            await page.click('#playPauseButton');

            expect(after.currentTime).toBeGreaterThan(before.currentTime);
        });

        test('time moves backward at playbackRate=-1 -- the whole point of this engine', async () => {
            // Start from well inside the clip, not from wherever the previous
            // test stopped (~2s in): reverse playback that reaches 0 makes the
            // engine pause itself, and the pause click below would then be
            // read as "play" -- leaving the next test stepping through a
            // clip that is still moving. Measured, not guessed: reverse
            // covered 2.2s of media in 1.8s of wall clock.
            await page.evaluate(() => {
                window.marpVideo.currentTime = Math.min(10, window.marpVideo.duration / 2);
            });
            await page.waitForTimeout(500);
            const before = await getPlaybackState(page);

            // The speed override moved into the gear menu's "Playback"
            // section when the UI became part of the library, so it has to
            // be opened before the input is reachable. Closed again after,
            // so the open menu cannot sit over the transport.
            await page.click('#playerSettingsButton');
            await page.click('[data-section="settingsPlaybackBody"]');
            await page.fill('#speedOverrideInput', '-1');
            await page.dispatchEvent('#speedOverrideInput', 'change');
            await page.click('#playerSettingsButton');

            await page.click('#playPauseButton');
            await page.waitForTimeout(2000);
            const after = await getPlaybackState(page);

            // Restored through the API, not by clicking the transport: a
            // click only toggles, so it says nothing about the state the
            // next test starts from.
            await page.evaluate(() => {
                window.marpVideo.pause();
                window.marpVideo.playbackRate = 1;
            });

            expect(after.currentTime).toBeLessThan(before.currentTime);
            expect(after.paused).toBe(false);
        });

        test('5 forward + 5 back steps return to the exact starting frame (no drift)', async () => {
            const start = await getPlaybackState(page);

            for (let i = 0; i < 5; i++) {
                await page.click('#stepForwardButton');
                await page.waitForTimeout(150);
            }
            for (let i = 0; i < 5; i++) {
                await page.click('#stepBackButton');
                await page.waitForTimeout(150);
            }

            const afterSteps = await getPlaybackState(page);
            expect(Math.abs(afterSteps.currentTime - start.currentTime)).toBeLessThan(0.001);
        });

        test('seek forward to a never-before-decoded segment lands near the target', async () => {
            await page.evaluate(() => {
                window.marpVideo.currentTime = 20.0;
            });
            await page.waitForFunction(() => Math.abs(window.marpVideo.currentTime - 20.0) < 0.1, { timeout: 60_000 }).catch(() => {});

            const state = await getPlaybackState(page);
            expect(Math.abs(state.currentTime - 20.0)).toBeLessThan(0.1);
        });

        test('seek backward across segment boundaries lands near the target', async () => {
            await page.evaluate(() => {
                window.marpVideo.currentTime = 5.0;
            });
            await page.waitForFunction(() => Math.abs(window.marpVideo.currentTime - 5.0) < 0.1, { timeout: 60_000 }).catch(() => {});

            const state = await getPlaybackState(page);
            expect(Math.abs(state.currentTime - 5.0)).toBeLessThan(0.1);
        });

        test('overlapping seeks settle on the latest request, never a stale one', async () => {
            await page.evaluate(() => {
                window.marpVideo.currentTime = 25.0; // slow: a cold unit
                window.marpVideo.currentTime = 8.0; // issued immediately after, no await -- must win
            });

            // Generously long: this fetches and decodes two never-before-seen
            // units back to back through the engine's single shared
            // VideoDecoder, and a cold Jellyfin segment fetch alone has been
            // seen taking 30s+.
            await page.waitForFunction(() => Math.abs(window.marpVideo.currentTime - 8.0) < 0.1, { timeout: 90_000 }).catch(() => {});

            const state = await getPlaybackState(page);
            expect(Math.abs(state.currentTime - 8.0)).toBeLessThan(0.1);
        });
    });
}
