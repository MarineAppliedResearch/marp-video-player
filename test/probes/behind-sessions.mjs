/**
 * Are behind sessions negotiated, and from inside the library?
 *
 * Behind sessions are two extra Jellyfin transcode sessions that tile the
 * region behind the playhead so reverse playback has bytes ready. They only
 * apply to the transcode path -- Direct Play and local files are randomly
 * addressable and need none -- and nothing in the unit or E2E suites covers
 * them, because they are only observable against a live Jellyfin server.
 *
 * They used to live in the browser app, which meant no other consumer got
 * them. This checks they now come from the library itself.
 *
 * Usage: node video-engine/test/probes/behind-sessions.mjs
 * Requires the dev server running (node ./server.js).
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname });

const PLAYER_URL = process.env.VIDEO_ENGINE_TEST_URL || 'http://localhost:3000/apps/VideoPlayer/';
const ITEM = process.env.JELLYFIN_ITEM || 'fb6a3c0fbd5e073d40e0840b9a54b79c';
const SEEK_TO = 400;

const browser = await chromium.launch();
const page = await browser.newPage();

const events = [];
page.on('console', (message) => {
    const text = message.text();
    if (/behind-session ready/.test(text)) {
        events.push(text.replace(/^.*?\]\s*/, '').slice(0, 70));
    }
});

await page.goto(PLAYER_URL, { waitUntil: 'load' });
await page.click('#playerSettingsButton');
await page.click('#jellyfinLoginButton');
await page.waitForFunction(() => document.getElementById('loginStatus').textContent.startsWith('Signed in'), { timeout: 20_000 });
await page.click('[data-section="settingsLoadItemBody"]');

// Transcode explicitly: behind sessions exist only on that path.
await page.evaluate(async (itemId) => {
    await loadItem(itemId, { name: 'Auto', maxStreamingBitrate: 7_950_247, maxWidth: 1920, maxHeight: 1080 });
}, ITEM);
await page.waitForFunction(() => window.marpVideo && !document.getElementById('playPauseButton').disabled, { timeout: 90_000 });

await page.evaluate((t) => {
    window.marpVideo.currentTime = t;
}, SEEK_TO);
await page.waitForTimeout(12_000);

await page.evaluate(() => {
    window.marpVideo.playbackRate = -1;
    window.marpVideo.play();
});
await page.waitForTimeout(10_000);

const state = await page.evaluate(() => ({
    currentTime: +window.marpVideo.currentTime.toFixed(2),
    fetched: window.marpVideo.getSegmentStates().filter((unit) => unit.fetched).length,
}));
await page.evaluate(() => window.marpVideo.pause());
await browser.close();

const reversed = state.currentTime < SEEK_TO;
// Each event is logged twice: once by the source, once by the app's log
// panel echoing the same line to the console.
const unique = [...new Set(events)];

console.log(`seeked to ${SEEK_TO}s, reverse reached ${state.currentTime}s -> ${reversed ? 'OK' : 'DID NOT REVERSE'}`);
console.log(`units fetched: ${state.fetched}`);
console.log(`behind sessions negotiated (${unique.length}):`);
for (const event of unique) {
    console.log('  ' + event);
}

process.exit(reversed && unique.length > 0 ? 0 : 1);
