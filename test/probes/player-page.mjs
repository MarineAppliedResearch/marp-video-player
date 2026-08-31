/**
 * Exercises player.html the way a host does: navigate with parameters.
 *
 * This is the page a WebView2 host loads, so it is the closest thing to the
 * host's own experience that can be run here. Covers both ways of telling it
 * what to play -- a Jellyfin item (preferred: the library picks the path and
 * maintains behind sessions) and a plain media URL.
 *
 * Expect the byte-range paths (Direct Play, and a plain MP4 URL) to fail
 * the forward-playback check on a machine without GPU decode: their units
 * are ~250-frame 1080p GOPs, which a software decoder cannot decode at
 * playback speed. The same limit fails the Direct Play E2E suite in the dev
 * sandbox and passes on real hardware. Seeking, stepping and reverse still
 * work there, because those read frames already decoded.
 *
 * Usage: node video-engine/test/probes/player-page.mjs
 * Requires the dev server running (node ./server.js).
 */

import { chromium } from 'playwright';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname });

const BASE = process.env.VIDEO_ENGINE_TEST_URL || 'http://localhost:3000/apps/VideoPlayer/';
const ITEM = process.env.JELLYFIN_ITEM || 'fb6a3c0fbd5e073d40e0840b9a54b79c';

const browser = await chromium.launch();
let failures = 0;

/** Loads player.html with the given query and exercises playback. */
async function run(label, query, startAt) {
    const page = await browser.newPage();
    const notes = [];
    page.on('console', (m) => {
        const text = m.text();
        if (text.startsWith('[player]')) notes.push(text.replace('[player] ', ''));
    });
    page.on('pageerror', (err) => notes.push('PAGEERROR ' + err.message));

    await page.goto(`${BASE}player.html?${query}`, { waitUntil: 'load' });
    try {
        await page.waitForFunction(() => window.marpVideo && window.marpVideo.duration > 0, { timeout: 90_000 });
    } catch {
        console.log(`${label}: FAILED to load -- ${notes.slice(0, 4).join(' | ')}`);
        failures++;
        await page.close();
        return;
    }

    const out = await page.evaluate(async (from) => {
        const engine = window.marpVideo;
        const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        // Wait for the seek to actually land rather than assuming a fixed
        // delay: a cold 1080p GOP is ~10MB to fetch and seconds to decode
        // under a software decoder, and a probe that quietly measures the
        // start of the file instead is worse than one that fails.
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
            hostAlias: window.marpVideo === window.mareVideo,
            stepped: stepped > stepFrom,
            forward: forward > stepped,
            reverse: reverse < forward,
            detail: `seek ${landed ? 'landed' : 'DID NOT LAND'} at ${stepFrom.toFixed(2)}s, step ->${stepped.toFixed(3)}, forward ->${forward.toFixed(2)}, reverse ->${reverse.toFixed(2)}`,
        };
    }, startAt);

    const ok = out.landed && out.hostAlias && out.stepped && out.forward && out.reverse;
    if (!ok) failures++;
    console.log(`${label}: ${ok ? 'OK' : 'PROBLEM'} -- ${out.detail}`);
    await page.close();
}

// A Jellyfin session, obtained the way a host already has one.
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

const jellyfin = `server=${encodeURIComponent(session.serverUrl)}&token=${encodeURIComponent(session.token)}&user=${encodeURIComponent(session.userId)}&item=${ITEM}`;

await run('jellyfin item, direct play', `${jellyfin}&mode=directPlay`, 300);
await run('jellyfin item, transcode', `${jellyfin}&mode=transcode`, 300);
await run('plain url (direct play stream)', `src=${encodeURIComponent(`${session.serverUrl}/Videos/${ITEM}/stream?static=true&api_key=${session.token}`)}`, 300);

await browser.close();
process.exit(failures === 0 ? 0 : 1);
