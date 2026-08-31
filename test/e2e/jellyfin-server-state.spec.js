/**
 * Things only the Jellyfin server can confirm.
 *
 * Both tests here check state the client cannot verify about itself. A client
 * always believes it sent its playback report; only the server knows whether
 * one arrived. Behind sessions are negotiated with the server, so only its
 * transcode sessions prove they exist.
 *
 * These run against the DEVELOPMENT Jellyfin server because they write:
 * playback reporting records resume positions against a real account, and
 * behind sessions start real transcodes.
 *
 * Previously manual scripts, test/probes/playback-reporting.mjs and
 * test/probes/behind-sessions.mjs.
 *
 * @fileoverview Server-observable behaviour tests.
 * @author Isaac Travers
 */

import { test, expect } from '@playwright/test';
import { JELLYFIN, missingJellyfinConfig } from './jellyfin-session.mjs';

/** A cold 1080p GOP is megabytes to fetch and seconds to decode. */
const LOAD_TIMEOUT_MS = 90_000;

/** Jellyfin reports positions in 100-nanosecond ticks. */
const TICKS_PER_SECOND = 10_000_000;

test.beforeAll(() => {
    const missing = missingJellyfinConfig();
    if (missing) throw new Error(`Cannot run Jellyfin server-state tests: ${missing}`);
});

test.describe('playback reporting', () => {
    test.describe.configure({ mode: 'serial' });

    // Both paths report, and both have broken separately before.
    for (const mode of ['directPlay', 'transcode']) {
        test(`${mode}: Jellyfin records where we played`, async ({ page }) => {
            test.setTimeout(LOAD_TIMEOUT_MS + 120_000);

            const playFrom = 300;
            await page.goto('', { waitUntil: 'load' });

            const result = await page.evaluate(
                async ({ server, user, pass, itemId, prefer, from }) => {
                    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
                    const client = new window.MarpVideoEngine.JellyfinClient();
                    await client.login(server, user, pass);

                    /** What the server currently believes about our position. */
                    async function serverPosition() {
                        const res = await fetch(
                            `${client.serverUrl}/Users/${client.userId}/Items/${itemId}`,
                            { headers: { 'X-Emby-Token': client.accessToken } },
                        );
                        const data = await res.json();
                        return (data.UserData && data.UserData.PlaybackPositionTicks) || 0;
                    }

                    const before = await serverPosition();

                    const built = await window.MarpVideoEngine.createJellyfinSource({ client, itemId, prefer });
                    const engine = await window.MarpVideoEngine.createMarpVideoEngine(
                        document.createElement('canvas'),
                        built,
                    );
                    engine.currentTime = from;
                    await settle(4000);
                    engine.play();
                    await settle(4000);
                    engine.pause();

                    // close() sends the final "stopped" report, which carries
                    // the position.
                    engine.close();
                    await settle(3000);

                    return { before, after: await serverPosition() };
                },
                {
                    server: JELLYFIN.url,
                    user: JELLYFIN.username,
                    pass: JELLYFIN.password,
                    itemId: JELLYFIN.itemId,
                    prefer: mode,
                    from: playFrom,
                },
            );

            const afterSeconds = result.after / TICKS_PER_SECOND;

            expect(result.after, 'server position changed').not.toBe(result.before);
            expect(
                Math.abs(afterSeconds - playFrom),
                `recorded position ${afterSeconds.toFixed(1)}s should be near ${playFrom}s`,
            ).toBeLessThan(30);
        });
    }
});

test.describe('behind sessions', () => {
    test('are negotiated from inside the library, and reverse playback works', async ({ page }) => {
        test.setTimeout(LOAD_TIMEOUT_MS + 180_000);

        const seekTo = 400;

        // Behind sessions announce themselves; the library logs each one.
        const announcements = new Set();
        page.on('console', (message) => {
            const text = message.text();
            if (/behind-session ready/.test(text)) {
                announcements.add(text.replace(/^.*?\]\s*/, '').slice(0, 70));
            }
        });

        await page.goto('', { waitUntil: 'load' });
        await page.click('#playerSettingsButton');
        await page.click('#jellyfinLoginButton');
        await page.waitForFunction(
            () => document.getElementById('loginStatus').textContent.startsWith('Signed in'),
            { timeout: 20_000 },
        );
        await page.click('[data-section="settingsLoadItemBody"]');

        // Transcode explicitly: behind sessions exist only on that path.
        // Direct Play and local files are randomly addressable and need none.
        await page.evaluate(async (itemId) => {
            await window.loadItem(itemId, {
                name: 'Auto',
                maxStreamingBitrate: 7_950_247,
                maxWidth: 1920,
                maxHeight: 1080,
            });
        }, JELLYFIN.itemId);

        await page.waitForFunction(
            () => window.marpVideo && !document.getElementById('playPauseButton').disabled,
            { timeout: LOAD_TIMEOUT_MS },
        );

        await page.evaluate((t) => { window.marpVideo.currentTime = t; }, seekTo);
        await page.waitForTimeout(12_000);

        await page.evaluate(() => {
            window.marpVideo.playbackRate = -1;
            window.marpVideo.play();
        });
        await page.waitForTimeout(10_000);

        const state = await page.evaluate(() => ({
            currentTime: window.marpVideo.currentTime,
            fetched: window.marpVideo.getSegmentStates().filter((unit) => unit.fetched).length,
        }));
        await page.evaluate(() => window.marpVideo.pause());

        expect(state.currentTime, 'reverse playback moved backward').toBeLessThan(seekTo);
        expect(state.fetched, 'units fetched').toBeGreaterThan(0);

        // The point of the test: the tiling sessions behind the playhead are
        // negotiated by the library itself, not by the app around it.
        expect(announcements.size, 'behind sessions negotiated').toBeGreaterThan(0);
    });
});
