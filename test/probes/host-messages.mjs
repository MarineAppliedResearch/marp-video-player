/**
 * What does player.html actually post to a WebView2 host?
 *
 * A host drives this player through messages, not function calls:
 * MareMediaElement raises MediaOpened from `status|loadedmetadata`, sizes
 * itself from `metadata|`, and moves its clock from `frame|`. If those never
 * arrive the host shows nothing -- no video, and none of its own UI, since
 * that waits on MediaOpened.
 *
 * Nothing else can catch this: the engine is fine, the page is fine, and the
 * messages are simply never sent. So this fakes chrome.webview and records
 * what the page posts.
 *
 * Usage: node video-engine/test/probes/host-messages.mjs
 * Requires the dev server running (node ./server.js).
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname });

const BASE = process.env.VIDEO_ENGINE_TEST_URL || 'http://localhost:3000/apps/VideoPlayer/';
const ITEM = process.env.JELLYFIN_ITEM || 'fb6a3c0fbd5e073d40e0840b9a54b79c';

const browser = await chromium.launch();
const page = await browser.newPage();

// Stand in for the host before any page script runs.
await page.addInitScript(() => {
    window.__hostMessages = [];
    window.chrome = window.chrome || {};
    window.chrome.webview = { postMessage: (message) => window.__hostMessages.push(String(message)) };
});

const helper = await browser.newPage();
await helper.goto(BASE, { waitUntil: 'load' });
const session = await helper.evaluate(
    async ({ server, user, pass }) => {
        const client = new MarpVideoEngine.JellyfinClient();
        await client.login(server, user, pass);
        return { serverUrl: client.serverUrl, token: client.accessToken, userId: client.userId };
    },
    {
        server: process.env.VIDEO_ENGINE_TEST_JELLYFIN_URL,
        user: process.env.VIDEO_ENGINE_TEST_JELLYFIN_USERNAME,
        pass: process.env.VIDEO_ENGINE_TEST_JELLYFIN_PASSWORD,
    },
);
await helper.close();

// controls=0 is the host case: MareMediaElement draws its own transport and
// scrub bar over an annotation overlay, so the built-in UI must be gone and
// the segment shading must arrive as messages instead of being drawn here.
const query =
    `server=${encodeURIComponent(session.serverUrl)}&token=${encodeURIComponent(session.token)}` +
    `&user=${encodeURIComponent(session.userId)}&item=${ITEM}&mode=directPlay&controls=0`;

await page.goto(`${BASE}player.html?${query}`, { waitUntil: 'load' });
await page.waitForFunction(() => window.marpVideo && window.marpVideo.duration > 0, { timeout: 90_000 });
await page.evaluate(() => window.marpVideo.play());
await page.waitForTimeout(3000);
await page.evaluate(() => window.marpVideo.pause());

const messages = await page.evaluate(() => window.__hostMessages);

// With controls=0 the built-in UI must be out of the way entirely: a host's
// overlay sits on top of this, and anything still hit-testable underneath
// would steal its clicks.
const ui = await page.evaluate(() => {
    const visible = (selector) => {
        const el = document.querySelector(selector);
        return Boolean(el) && getComputedStyle(el).display !== 'none';
    };
    return {
        controlsBar: visible('.marp-controls-bar'),
        centerOverlay: visible('.marp-center-overlay'),
        canvas: visible('.marp-canvas'),
        logo: Boolean(document.querySelector('.marp-logo')),
    };
});

await browser.close();

const kinds = messages.map((m) => m.split('|')[0]);
const loadedMetadata = messages.find((m) => m.startsWith('status|loadedmetadata'));
const metadata = messages.find((m) => m.startsWith('metadata|'));
const frames = kinds.filter((k) => k === 'frame').length;
const segmentIndex = messages.find((m) => m.startsWith('segmentindex|'));
const segmentUpdates = messages.filter((m) => m.startsWith('segments|'));

console.log(`messages posted: ${messages.length}`);
console.log(`  status|loadedmetadata : ${loadedMetadata || 'MISSING -- host would never raise MediaOpened'}`);
console.log(`  metadata|             : ${metadata || 'MISSING -- host would not know the video size'}`);
console.log(`  frame| count          : ${frames}${frames ? '' : '  MISSING -- host clock would never move'}`);

// Geometry is sent once and states repeatedly; a host that got states
// without geometry could not place them on its bar.
const geometryFields = segmentIndex ? segmentIndex.split('|') : [];
const segmentCount = geometryFields.length > 1 ? Number(geometryFields[1]) : 0;
const lastStates = segmentUpdates.length ? segmentUpdates[segmentUpdates.length - 1].split('|')[1] : '';
const statesMatchCount = Boolean(segmentCount) && lastStates.length === segmentCount;
const anyProgress = /[1-7]/.test(lastStates);

console.log(`  segmentindex|         : ${segmentIndex ? `${segmentCount} segments` : 'MISSING -- host could not place segments on its bar'}`);
console.log(`  segments| count       : ${segmentUpdates.length}${segmentUpdates.length ? '' : '  MISSING -- host bar would never shade'}`);
console.log(`  states length matches : ${statesMatchCount ? 'yes' : `NO -- ${lastStates.length} digits for ${segmentCount} segments`}`);
console.log(`  any fetched/decoded   : ${anyProgress ? 'yes' : 'NO -- every segment reads 0'}`);

console.log('built-in UI with controls=0:');
console.log(`  controls bar hidden   : ${ui.controlsBar ? 'NO -- would sit under the host overlay' : 'yes'}`);
console.log(`  center overlay hidden : ${ui.centerOverlay ? 'NO -- would sit under the host overlay' : 'yes'}`);
console.log(`  canvas still drawn    : ${ui.canvas ? 'yes' : 'NO -- no picture'}`);

const ok =
    loadedMetadata &&
    metadata &&
    frames > 0 &&
    segmentIndex &&
    segmentUpdates.length > 0 &&
    statesMatchCount &&
    anyProgress &&
    !ui.controlsBar &&
    !ui.centerOverlay &&
    ui.canvas;

process.exit(ok ? 0 : 1);
