/**
 * Does Jellyfin actually receive playback reports, on both paths?
 *
 * Reporting is what keeps Jellyfin's resume position and now-playing
 * working. It cannot be checked from the client alone -- the client thinks
 * it sent something either way -- so this asks the server what it has, by
 * reading the item's UserData.PlaybackPositionTicks back after playing.
 *
 * Usage: node video-engine/test/probes/playback-reporting.mjs [directPlay|transcode]
 * Requires the dev server running (node ./server.js).
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname });

const MODE = process.argv[2] === 'transcode' ? 'transcode' : 'directPlay';
const PLAYER_URL = process.env.VIDEO_ENGINE_TEST_URL || 'http://localhost:3000/apps/VideoPlayer/';
const ITEM = process.env.JELLYFIN_ITEM || 'fb6a3c0fbd5e073d40e0840b9a54b79c';
const PLAY_FROM = 300;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(PLAYER_URL, { waitUntil: 'load' });

const result = await page.evaluate(
    async ({ server, user, pass, itemId, mode, playFrom }) => {
        const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const client = new MarpVideoEngine.JellyfinClient();
        await client.login(server, user, pass);

        /** Reads what the server currently believes about our position. */
        async function serverPosition() {
            const res = await fetch(`${client.serverUrl}/Users/${client.userId}/Items/${itemId}`, {
                headers: { 'X-Emby-Token': client.accessToken },
            });
            const data = await res.json();
            return (data.UserData && data.UserData.PlaybackPositionTicks) || 0;
        }

        const before = await serverPosition();

        const built = await MarpVideoEngine.createJellyfinSource({ client, itemId, prefer: mode });
        const engine = await MarpVideoEngine.createMarpVideoEngine(document.createElement('canvas'), built);
        engine.currentTime = playFrom;
        await settle(4000);
        engine.play();
        await settle(4000);
        engine.pause();
        // close() sends the final "stopped" report, which carries position.
        engine.close();
        await settle(3000);

        return { before, after: await serverPosition() };
    },
    {
        server: process.env.VIDEO_ENGINE_TEST_JELLYFIN_URL,
        user: process.env.VIDEO_ENGINE_TEST_JELLYFIN_USERNAME,
        pass: process.env.VIDEO_ENGINE_TEST_JELLYFIN_PASSWORD,
        itemId: ITEM,
        mode: MODE,
        playFrom: PLAY_FROM,
    },
);
await browser.close();

const TICKS_PER_SECOND = 10_000_000;
const afterSeconds = result.after / TICKS_PER_SECOND;
const reported = Math.abs(afterSeconds - PLAY_FROM) < 30 && result.after !== result.before;

console.log(`${MODE}: server position before ${(result.before / TICKS_PER_SECOND).toFixed(1)}s, after ${afterSeconds.toFixed(1)}s (played from ${PLAY_FROM}s)`);
console.log(reported ? 'OK -- Jellyfin recorded the position' : 'FAILED -- Jellyfin did not record a position near where we played');
process.exit(reported ? 0 : 1);
