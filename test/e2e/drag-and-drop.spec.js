/**
 * Dropping a video file onto the player loads it.
 *
 * This regressed because the listeners were on the canvas, while
 * `.marp-center-overlay` is `position: absolute; inset: 0` and is shown until
 * the first frame is presented -- exactly the state the player is in when a
 * file is dropped to load one. The drop landed on the overlay, which had no
 * handler, and the browser navigated to the file instead.
 *
 * The test therefore drops on the player root without targeting the canvas,
 * which is what a person does, and would fail again if the listeners moved
 * back to a covered element.
 *
 * @fileoverview Drag-and-drop loading tests.
 * @author Isaac Travers
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/** This file's directory. ESM has no __dirname. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Downloaded by the global setup. */
const FIXTURE = process.env.MARP_LOCAL_FIXTURE
    || join(HERE, '..', '..', '.test-media', 'short-1080p25.mp4');

/** A cold 1080p GOP is megabytes to fetch and seconds to decode. */
const LOAD_TIMEOUT_MS = 90_000;

/**
 * Drops a real file onto a selector, the way a person drops onto the player.
 *
 * Playwright cannot synthesise an OS drag, so the file is handed to the page
 * as bytes and a DataTransfer is built there. The events are dispatched on the
 * element under the pointer rather than on the canvas, so a handler attached
 * to a covered element would not see them.
 *
 * @async
 * @param {Object} page - Playwright page.
 * @param {string} selector - Element to drop onto.
 * @param {string} filePath - Local file to drop.
 * @returns {Promise<void>}
 */
async function dropFile(page, selector, filePath) {
    const bytes = Array.from(readFileSync(filePath));
    const name = filePath.split(/[\\/]/).pop();

    await page.evaluate(
        async ({ selector: sel, bytes: data, name: filename }) => {
            const target = document.querySelector(sel);
            const file = new File([new Uint8Array(data)], filename, { type: 'video/mp4' });
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(file);

            for (const type of ['dragenter', 'dragover', 'drop']) {
                target.dispatchEvent(new DragEvent(type, {
                    bubbles: true,
                    cancelable: true,
                    dataTransfer,
                }));
            }
        },
        { selector, bytes, name },
    );
}

test.describe('drag and drop', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(() => {
        if (!existsSync(FIXTURE)) {
            throw new Error(`Fixture missing: ${FIXTURE}. The global setup should have downloaded it.`);
        }
    });

    test('dropping a file onto the player loads and plays it', async ({ page }) => {
        test.setTimeout(LOAD_TIMEOUT_MS + 60_000);

        await page.goto('', { waitUntil: 'load' });

        // The centre overlay covers the player before anything is loaded, so
        // this is the element a person actually drops onto.
        await dropFile(page, '.marp-center-overlay', FIXTURE);

        await page.waitForFunction(
            () => window.marpVideo && window.marpVideo.duration > 0,
            { timeout: LOAD_TIMEOUT_MS },
        );

        const state = await page.evaluate(async () => {
            const engine = window.marpVideo;
            const settle = (ms) => new Promise((r) => setTimeout(r, ms));
            const before = engine.currentTime;
            engine.play();
            await settle(2000);
            const after = engine.currentTime;
            engine.pause();
            return { duration: engine.duration, before, after };
        });

        expect(state.duration, 'video loaded with a real duration').toBeGreaterThan(0);
        expect(state.after, 'playback advanced after the drop').toBeGreaterThan(state.before);
    });

    test('dragging over the player shows a drop affordance', async ({ page }) => {
        await page.goto('', { waitUntil: 'load' });

        const before = await page.evaluate(
            () => document.querySelector('.marp-player').classList.contains('marp-drag-over'),
        );
        expect(before, 'no drag state before dragging').toBe(false);

        await page.evaluate(() => {
            const dataTransfer = new DataTransfer();
            dataTransfer.items.add(new File([new Uint8Array([0])], 'x.mp4', { type: 'video/mp4' }));
            document.querySelector('.marp-center-overlay').dispatchEvent(
                new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer }),
            );
        });

        const during = await page.evaluate(
            () => document.querySelector('.marp-player').classList.contains('marp-drag-over'),
        );
        expect(during, 'drag state applied while dragging over').toBe(true);
    });
});
