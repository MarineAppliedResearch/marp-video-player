/**
 * The controls row fits a phone-width player.
 *
 * At full size the row needs about 440px. On a phone it ran past the player,
 * and Android Chrome widened the whole page to fit it: the page zoomed out,
 * the fullscreen button went off the edge, the time text overlapped the step
 * buttons, and the settings menu opened partly off screen. Found on a real
 * Android emulator; the row only reaches its full width once a video is
 * loaded and the time display holds real numbers, which is why this loads one.
 *
 * @fileoverview Phone-width layout of the controls row.
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

for (const width of [320, 360, 412]) {
    test.describe(`a ${width}px touch screen`, () => {
        test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });

        test('the controls row fits inside the player', async ({ page }) => {
            test.setTimeout(LOAD_TIMEOUT_MS + 30_000);
            if (!existsSync(FIXTURE)) {
                throw new Error(`Fixture missing: ${FIXTURE}. The global setup should have downloaded it.`);
            }

            // player.html is the host page: the player and nothing else, where the demo
            // page's own panels are wider than a phone. It carries no viewport tag, so a
            // phone would lay it out 980px wide and the row would always fit; every page
            // that hosts the player on a phone has one -- the Mosaic's inspector does.
            await page.addInitScript(() => {
                document.addEventListener('DOMContentLoaded', () => {
                    const meta = document.createElement('meta');
                    meta.name = 'viewport';
                    meta.content = 'width=device-width, initial-scale=1';
                    document.head.appendChild(meta);
                });
            });
            await page.goto('player.html', { waitUntil: 'load' });
            expect(await page.evaluate(() => window.innerWidth), 'the page is laid out at the phone width')
                .toBe(width);
            const bytes = Array.from(readFileSync(FIXTURE));
            await page.evaluate(({ data }) => {
                const file = new File([new Uint8Array(data)], 'short.mp4', { type: 'video/mp4' });
                const dataTransfer = new DataTransfer();
                dataTransfer.items.add(file);
                const target = document.querySelector('.marp-center-overlay');
                for (const type of ['dragenter', 'dragover', 'drop']) {
                    target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer }));
                }
            }, { data: bytes });
            await page.waitForFunction(
                () => window.marpVideo && window.marpVideo.duration > 0,
                { timeout: LOAD_TIMEOUT_MS },
            );

            const layout = await page.evaluate(() => {
                const row = document.querySelector('.marp-controls-row');
                const player = document.querySelector('.marp-player').getBoundingClientRect();
                const fullscreen = document.querySelector('.marp-fullscreen').getBoundingClientRect();
                return {
                    rowNeeds: row.scrollWidth,
                    rowHas: row.clientWidth,
                    fullscreenRight: fullscreen.right,
                    playerRight: player.right,
                    time: document.querySelector('.marp-time').textContent,
                };
            });

            expect(layout.time, 'the time display holds real numbers').toMatch(/\d/);
            expect(layout.rowNeeds, `the row needs ${layout.rowNeeds}px and has ${layout.rowHas}px`)
                .toBeLessThanOrEqual(layout.rowHas);
            expect(layout.fullscreenRight, 'the fullscreen button is inside the player')
                .toBeLessThanOrEqual(layout.playerRight);
        });
    });
}
