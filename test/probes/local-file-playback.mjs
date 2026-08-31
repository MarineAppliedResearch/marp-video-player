/**
 * Plays a local file through the player's own file picker and reports
 * whether forward, reverse and frame stepping actually work.
 *
 * Local files are the one fully deterministic path in this project -- same
 * bytes every run, no transcoder, no sessions, no network -- so this is the
 * most trustworthy end-to-end check available. Point it at any MP4.
 *
 * Usage: node video-engine/test/probes/local-file-playback.mjs [file.mp4]
 * Requires the dev server running (node ./server.js).
 */

import { chromium } from 'playwright';

// Pass the MP4 to play as the first argument, or set
// VIDEO_ENGINE_TEST_LOCAL_FILE. No default: the previous one was an absolute
// Linux path that does not exist on a Windows development machine.
const FILE = process.argv[2] || process.env.VIDEO_ENGINE_TEST_LOCAL_FILE;

if (!FILE) {
    console.error('Usage: node local-file-playback.mjs <file.mp4>  (or set VIDEO_ENGINE_TEST_LOCAL_FILE)');
    process.exit(1);
}
const PLAYER_URL = process.env.VIDEO_ENGINE_TEST_URL || 'http://localhost:3000/apps/VideoPlayer/';

const browser = await chromium.launch();
const page = await browser.newPage();
page.on('console', (message) => {
    const text = message.text();
    if (/indexed|Engine ready|ERROR/i.test(text)) {
        console.log('  ' + text.slice(0, 140));
    }
});
page.on('pageerror', (error) => console.log('  PAGEERROR ' + error.message));

await page.goto(PLAYER_URL, { waitUntil: 'load' });
await page.click('#playerSettingsButton');
await page.click('[data-section="settingsLoadItemBody"]');
// Deliberately never signs in: a local file must need no Jellyfin at all.
await page.setInputFiles('#localFileInput', FILE);

try {
    await page.waitForFunction(() => window.marpVideo && !document.getElementById('playPauseButton').disabled, { timeout: 90_000 });
} catch {
    console.log('FAILED: engine never became ready');
    await browser.close();
    process.exit(1);
}

const info = await page.evaluate(() => ({
    duration: +window.marpVideo.duration.toFixed(3),
    size: `${window.marpVideo.videoWidth}x${window.marpVideo.videoHeight}`,
    fps: window.marpVideo.fps,
    units: window.marpVideo.getSegmentStates().length,
}));
console.log(`loaded: ${JSON.stringify(info)}`);

const start = Math.min(2, Math.max(0, info.duration / 4));
await page.evaluate(async (t) => {
    window.marpVideo.currentTime = t;
    await new Promise((resolve) => setTimeout(resolve, 2500));
    window.marpVideo.play();
}, start);
await page.waitForTimeout(5000);
const forward = await page.evaluate(() => +window.marpVideo.currentTime.toFixed(2));

await page.evaluate(() => {
    window.marpVideo.playbackRate = -1;
    window.marpVideo.play();
});
await page.waitForTimeout(5000);
const reverse = await page.evaluate(() => +window.marpVideo.currentTime.toFixed(2));

await page.evaluate(() => window.marpVideo.pause());
const before = await page.evaluate(() => +window.marpVideo.currentTime.toFixed(3));
await page.evaluate(() => {
    window.marpVideo.currentTime = window.marpVideo.currentTime + 1 / window.marpVideo.fps;
});
await page.waitForTimeout(1500);
const after = await page.evaluate(() => +window.marpVideo.currentTime.toFixed(3));

const frameSeconds = 1 / info.fps;
const stepped = Math.abs(after - before - frameSeconds) < frameSeconds / 2;
console.log(`forward:    ${start} -> ${forward} ${forward > start ? 'OK' : 'STALLED'}`);
console.log(`reverse:    ${forward} -> ${reverse} ${reverse < forward ? 'OK' : 'STALLED'}`);
console.log(`frame step: ${before} -> ${after} ${stepped ? 'OK' : `EXPECTED +${frameSeconds.toFixed(3)}s`}`);

await browser.close();
process.exit(forward > start && reverse < forward && stepped ? 0 : 1);
