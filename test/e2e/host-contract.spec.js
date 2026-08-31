/**
 * The contract a native host depends on.
 *
 * `app/player.html` is the page MARE's C# WebView2 host loads, and it drives
 * the player through messages rather than function calls: MareMediaElement
 * raises MediaOpened from `status|loadedmetadata`, sizes itself from
 * `metadata|`, and moves its clock from `frame|`. If those stop arriving the
 * host shows nothing at all -- no video, and none of its own UI, because its
 * chrome is driven by the same messages.
 *
 * Nothing else in the suite covers this. The unit tests never load the page,
 * and playback.spec.js drives the library directly rather than through the
 * host-facing page.
 *
 * Previously a manual script, test/probes/host-messages.mjs and
 * test/probes/player-page.mjs.
 *
 * @fileoverview WebView2 host contract tests.
 * @author Isaac Travers
 */

import { test, expect } from '@playwright/test';
import { JELLYFIN, missingJellyfinConfig, jellyfinSession, playerQuery } from './jellyfin-session.mjs';

/** A cold 1080p GOP is megabytes to fetch and seconds to decode. */
const LOAD_TIMEOUT_MS = 90_000;

/** Far enough in to be a real seek into undecoded media. */
const SEEK_TO_SECONDS = 300;

test.describe('WebView2 host contract', () => {
    test.describe.configure({ mode: 'serial' });

    let session;

    test.beforeAll(async ({ browser }) => {
        const missing = missingJellyfinConfig();
        if (missing) throw new Error(`Cannot run host contract tests: ${missing}`);

        const page = await browser.newPage();
        await page.goto('', { waitUntil: 'load' });
        session = await jellyfinSession(page);
        await page.close();
    });

    test('player.html posts every message the host needs', async ({ browser }) => {
        test.setTimeout(LOAD_TIMEOUT_MS + 60_000);

        const page = await browser.newPage();

        // Stand in for the host before any page script runs.
        await page.addInitScript(() => {
            window.__hostMessages = [];
            window.chrome = window.chrome || {};
            window.chrome.webview = {
                postMessage: (message) => window.__hostMessages.push(String(message)),
            };
        });

        // controls=0 is the host case: MareMediaElement draws its own transport
        // and scrub bar over an annotation overlay.
        const query = playerQuery(session, JELLYFIN.itemId, { mode: 'directPlay', controls: '0' });
        await page.goto(`player.html?${query}`, { waitUntil: 'load' });
        await page.waitForFunction(
            () => window.marpVideo && window.marpVideo.duration > 0,
            { timeout: LOAD_TIMEOUT_MS },
        );

        await page.evaluate(() => window.marpVideo.play());
        await page.waitForTimeout(3000);
        await page.evaluate(() => window.marpVideo.pause());

        const messages = await page.evaluate(() => window.__hostMessages);
        await page.close();

        const find = (prefix) => messages.find((m) => m.startsWith(prefix));

        // Without this the host never raises MediaOpened.
        expect(find('status|loadedmetadata'), 'status|loadedmetadata').toBeTruthy();

        // Without this the host does not know the video size.
        expect(find('metadata|'), 'metadata|').toBeTruthy();

        // Without these the host clock never moves.
        const frames = messages.filter((m) => m.startsWith('frame|')).length;
        expect(frames, 'frame| messages').toBeGreaterThan(0);

        // Geometry is sent once, states repeatedly. A host given states without
        // geometry cannot place them on its own scrub bar.
        const geometry = find('segmentindex|');
        expect(geometry, 'segmentindex|').toBeTruthy();

        const segmentCount = Number(geometry.split('|')[1]);
        expect(segmentCount).toBeGreaterThan(0);

        const updates = messages.filter((m) => m.startsWith('segments|'));
        expect(updates.length, 'segments| updates').toBeGreaterThan(0);

        const lastStates = updates[updates.length - 1].split('|')[1];
        expect(lastStates.length, 'one state digit per segment').toBe(segmentCount);

        // All-zero states would mean nothing was ever fetched or decoded.
        expect(/[1-7]/.test(lastStates), 'some segment fetched or decoded').toBe(true);
    });

    test('with controls=0 the built-in UI gets out of the way', async ({ browser }) => {
        test.setTimeout(LOAD_TIMEOUT_MS + 60_000);

        const page = await browser.newPage();
        const query = playerQuery(session, JELLYFIN.itemId, { mode: 'directPlay', controls: '0' });
        await page.goto(`player.html?${query}`, { waitUntil: 'load' });
        await page.waitForFunction(
            () => window.marpVideo && window.marpVideo.duration > 0,
            { timeout: LOAD_TIMEOUT_MS },
        );

        const ui = await page.evaluate(() => {
            const visible = (selector) => {
                const el = document.querySelector(selector);
                return Boolean(el) && getComputedStyle(el).display !== 'none';
            };
            return {
                controlsBar: visible('.marp-controls-bar'),
                centerOverlay: visible('.marp-center-overlay'),
                canvas: visible('.marp-canvas'),
            };
        });
        await page.close();

        // A host overlays its own chrome. Anything still hit-testable
        // underneath steals its clicks.
        expect(ui.controlsBar, 'controls bar hidden').toBe(false);
        expect(ui.centerOverlay, 'center overlay hidden').toBe(false);

        // The picture itself must still be drawn.
        expect(ui.canvas, 'canvas drawn').toBe(true);
    });
});

/**
 * The three ways a host tells player.html what to play. Each must reach the
 * same working state: seek lands, stepping moves, playback runs both ways.
 */
const HOST_LOAD_MODES = [
    { name: 'Jellyfin item, Direct Play', params: { mode: 'directPlay' } },
    { name: 'Jellyfin item, transcode', params: { mode: 'transcode' } },
    { name: 'plain media URL', params: null },
];

test.describe('player.html load modes', () => {
    test.describe.configure({ mode: 'serial' });

    let session;

    test.beforeAll(async ({ browser }) => {
        const missing = missingJellyfinConfig();
        if (missing) throw new Error(`Cannot run player page tests: ${missing}`);

        const page = await browser.newPage();
        await page.goto('', { waitUntil: 'load' });
        session = await jellyfinSession(page);
        await page.close();
    });

    for (const mode of HOST_LOAD_MODES) {
        test(`${mode.name}: seeks, steps, and plays both directions`, async ({ browser }) => {
            test.setTimeout(LOAD_TIMEOUT_MS + 120_000);

            const query = mode.params
                ? playerQuery(session, JELLYFIN.itemId, mode.params)
                : new URLSearchParams({
                    src: `${session.serverUrl}/Videos/${JELLYFIN.itemId}/stream?static=true&api_key=${session.token}`,
                }).toString();

            const page = await browser.newPage();
            const notes = [];
            page.on('pageerror', (err) => notes.push(`PAGEERROR ${err.message}`));

            await page.goto(`player.html?${query}`, { waitUntil: 'load' });
            await page.waitForFunction(
                () => window.marpVideo && window.marpVideo.duration > 0,
                { timeout: LOAD_TIMEOUT_MS },
            );

            const result = await page.evaluate(async (from) => {
                const engine = window.marpVideo;
                const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

                // Wait for the seek to actually land rather than assuming a
                // fixed delay: measuring the start of the file instead would
                // silently pass.
                engine.currentTime = from;
                const deadline = Date.now() + 45_000;
                while (Math.abs(engine.currentTime - from) > 1 && Date.now() < deadline) {
                    await settle(500);
                }
                const landed = Math.abs(engine.currentTime - from) <= 1;

                const stepFrom = engine.currentTime;
                engine.currentTime = stepFrom + 1.5 / engine.fps;
                await settle(1500);
                const stepped = engine.currentTime;

                engine.play();
                await settle(4000);
                const forward = engine.currentTime;

                engine.playbackRate = -1;
                engine.play();
                await settle(5000);
                const reverse = engine.currentTime;
                engine.pause();

                return {
                    landed,
                    hostAlias: engine === window.mareVideo,
                    stepFrom,
                    stepped,
                    forward,
                    reverse,
                };
            }, SEEK_TO_SECONDS);

            await page.close();

            expect(notes, 'no page errors').toEqual([]);
            expect(result.landed, `seek landed near ${SEEK_TO_SECONDS}s`).toBe(true);

            // The host still refers to window.mareVideo; both names must work.
            expect(result.hostAlias, 'window.mareVideo aliases window.marpVideo').toBe(true);

            expect(result.stepped, 'frame step moved forward').toBeGreaterThan(result.stepFrom);
            expect(result.forward, 'playback advanced').toBeGreaterThan(result.stepped);
            expect(result.reverse, 'reverse playback moved backward').toBeLessThan(result.forward);
        });
    }
});
