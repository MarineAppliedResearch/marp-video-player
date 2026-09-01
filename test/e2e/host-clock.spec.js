/**
 * The time a host is told must be the frame on screen.
 *
 * Annotations are recorded against a frame, so a host holding a stale position
 * records an observation against the wrong picture. This is the check that the
 * two agree.
 *
 * The host's clock is driven by `frame|` lines, which come from
 * requestVideoFrameCallback and therefore describe the frame being displayed.
 * The final one before a pause can describe a frame earlier than the one
 * playback actually stopped on -- measured at a full frame behind. So pause has
 * to carry the settled time, the way seeked already does, and this file exists
 * to keep that true.
 *
 * Uses a plain URL source rather than Jellyfin: this is about the clock, and a
 * local file over HTTP keeps the test deterministic and offline.
 *
 * @fileoverview Host clock accuracy tests.
 * @author Isaac Travers
 */

import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/** This file's directory. ESM has no __dirname. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Downloaded by the global setup. */
const FIXTURE = join(HERE, '..', '..', '.test-media', 'short-1080p25.mp4');

/** Served by the suite's own static server, which supports range requests. */
const FIXTURE_URL = '/.test-media/short-1080p25.mp4';

/**
 * A local file over HTTP loads in a few seconds. Kept tight deliberately: a
 * generous ceiling would hide a load getting slower, and turn a hang into a
 * minute and a half of waiting.
 */
const LOAD_TIMEOUT_MS = 15_000;

/** Whole test, including the load and the play/pause sequence. */
const TEST_TIMEOUT_MS = 30_000;

test.describe('host clock', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(() => {
        if (!existsSync(FIXTURE)) {
            throw new Error(`Fixture missing: ${FIXTURE}. The global setup should have downloaded it.`);
        }
    });

    /**
     * Loads player.html against the fixture, with a stand-in host that records
     * every message.
     *
     * @param {Object} page - Playwright page.
     * @returns {Promise<void>}
     */
    async function openPlayerWithHost(page) {
        await page.addInitScript(() => {
            window.__hostMessages = [];
            window.chrome = window.chrome || {};
            window.chrome.webview = {
                postMessage: (message) => window.__hostMessages.push(String(message)),
            };
        });

        // Absolute, because player.html reads it as a media URL rather than a
        // page-relative path.
        const src = new URL(FIXTURE_URL, page.context()._options?.baseURL || 'http://localhost:8099/');
        await page.goto(`player.html?controls=0&src=${encodeURIComponent(src.href)}`, { waitUntil: 'load' });

        await page.waitForFunction(
            () => window.marpVideo && window.marpVideo.duration > 0,
            { timeout: LOAD_TIMEOUT_MS },
        );
    }

    test('pause tells the host the frame it stopped on', async ({ page }) => {
        test.setTimeout(TEST_TIMEOUT_MS);

        await openPlayerWithHost(page);

        const result = await page.evaluate(async () => {
            const video = window.marpVideo;
            const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

            // Land on an exact frame, the way an annotator lines up on one.
            video.currentTime = 3.0;
            await settle(2500);

            window.__hostMessages.length = 0;

            video.play();
            await settle(2000);
            video.pause();
            await settle(500);

            const pauseLine = window.__hostMessages
                .filter((message) => message.startsWith('status|pause'))
                .pop();

            return {
                fps: video.fps,
                playerTime: video.currentTime,
                pauseLine: pauseLine || null,
            };
        });

        // Without a time on the pause line the host has nothing to correct
        // with, which is the whole bug.
        expect(result.pauseLine, 'a pause line was posted').toBeTruthy();
        expect(result.pauseLine, 'pause carries currentTime').toContain('currentTime=');

        const reported = Number(result.pauseLine.split('currentTime=')[1]);

        // Must be the frame the player actually stopped on, not near it.
        const driftFrames = Math.abs(reported - result.playerTime) * result.fps;
        expect(
            driftFrames,
            `host was told ${reported}, player is at ${result.playerTime}`,
        ).toBeLessThan(0.001);
    });

    test('the reported time is a whole frame, not a position between two', async ({ page }) => {
        test.setTimeout(TEST_TIMEOUT_MS);

        await openPlayerWithHost(page);

        const result = await page.evaluate(async () => {
            const video = window.marpVideo;
            const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

            video.currentTime = 3.0;
            await settle(2500);
            video.play();
            await settle(1500);
            video.pause();
            await settle(500);

            return { fps: video.fps, playerTime: video.currentTime };
        });

        // A time that is not a whole number of frames means the player stopped
        // between two pictures, and there would be no single right answer to
        // record an annotation against.
        const frameIndex = result.playerTime * result.fps;
        const distanceFromWholeFrame = Math.abs(frameIndex - Math.round(frameIndex));

        expect(
            distanceFromWholeFrame,
            `paused at ${result.playerTime}s, which is frame ${frameIndex} at ${result.fps}fps`,
        ).toBeLessThan(0.001);
    });
});
