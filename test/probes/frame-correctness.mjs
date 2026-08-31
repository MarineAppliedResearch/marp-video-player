/**
 * Is the picture on the canvas the RIGHT picture?
 *
 * Every existing check in this project verifies timing, routing or decode
 * success. None verifies content: a segment can decode cleanly, carry
 * correct timestamps, satisfy the CONTENT MISMATCH detector, and still show
 * the wrong pictures -- which is the bug this exists to catch. Decode
 * FAILURES are a different phenomenon entirely (they cache nothing and
 * retry), so counting them does not measure this.
 *
 * Method: drive the real player, capture the canvas at known times, and
 * compare each capture against a reference frame extracted from the
 * original file with ffmpeg. PSNR separates the cases cleanly -- a correct
 * frame scores far above a wrong one, since a wrong frame is different
 * content rather than the same content with transcode artifacts.
 *
 * Usage: node video-engine/test/probes/frame-correctness.mjs [label]
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import dotenv from 'dotenv';

dotenv.config({ path: new URL('../../../.env', import.meta.url).pathname });

const LABEL = process.argv[2] || 'build';
// Set FRAME_REFERENCE_FILE to the original source MP4 to compare captures
// against. No default: the previous one was an absolute Linux path.
const SOURCE = process.env.FRAME_REFERENCE_FILE;

if (!SOURCE) {
    console.error('Set FRAME_REFERENCE_FILE to the reference source MP4 before running this probe.');
    process.exit(1);
}
const PLAYER_URL = process.env.VIDEO_ENGINE_TEST_URL || 'http://localhost:3000/apps/VideoPlayer/';

/** Below this PSNR the capture is a different picture, not a noisier one. */
const PSNR_WRONG_BELOW_DB = 20;

if (!existsSync(SOURCE)) {
    console.error(`reference file not found: ${SOURCE}`);
    process.exit(1);
}

const workDir = mkdtempSync(join(tmpdir(), 'frame-correctness-'));

/** Extracts the source frame at a time, scaled to the transcode's size. */
function referenceFrame(seconds, width, height, name) {
    const path = join(workDir, `${name}-ref.png`);
    execFileSync(
        'ffmpeg',
        ['-v', 'error', '-ss', String(seconds), '-i', SOURCE, '-frames:v', '1', '-vf', `scale=${width}:${height}`, '-y', path],
        { stdio: 'pipe' },
    );
    return path;
}

/** PSNR of two same-size PNGs, in dB (Infinity when identical). */
function psnr(referencePath, capturePath) {
    // ffmpeg's psnr filter reports on stderr, not stdout.
    const result = spawnSync(
        'ffmpeg',
        ['-hide_banner', '-i', capturePath, '-i', referencePath, '-lavfi', 'psnr', '-f', 'null', '-'],
        { encoding: 'utf8' },
    );
    const match = (result.stderr || '').match(/average:([0-9.]+|inf)/);
    if (!match) return null;
    return match[1] === 'inf' ? Infinity : parseFloat(match[1]);
}

/**
 * PSNR against the best of several nearby reference frames.
 *
 * A seek lands on the nearest decodable frame, and the transcode carries a
 * small constant offset from the source's own timeline, so comparing
 * against exactly one timestamp would flag a correct frame as wrong purely
 * from being one frame out.
 */
function bestPsnr(seconds, width, height, capturePath, name) {
    let best = { db: -Infinity, offset: null };
    for (const offset of [0, -0.04, 0.04, -0.08, 0.08]) {
        const reference = referenceFrame(Math.max(0, seconds + offset), width, height, `${name}${offset}`);
        const db = psnr(reference, capturePath);
        if (db !== null && db > best.db) best = { db, offset };
    }
    return best;
}

const browser = await chromium.launch();
const page = await browser.newPage();

await page.goto(PLAYER_URL, { waitUntil: 'load' });
await page.click('#playerSettingsButton');
await page.fill('#jellyfinServerUrlInput', process.env.VIDEO_ENGINE_TEST_JELLYFIN_URL);
await page.fill('#jellyfinUsernameInput', process.env.VIDEO_ENGINE_TEST_JELLYFIN_USERNAME);
await page.fill('#jellyfinPasswordInput', process.env.VIDEO_ENGINE_TEST_JELLYFIN_PASSWORD);
await page.click('#jellyfinLoginButton');
await page.waitForFunction(() => document.getElementById('loginStatus').textContent.startsWith('Signed in'), { timeout: 20_000 });
await page.click('[data-section="settingsLoadItemBody"]');
await page.click('#loadButton');
await page.waitForFunction(() => document.getElementById('playPauseButton') && !document.getElementById('playPauseButton').disabled, { timeout: 90_000 });

const size = await page.evaluate(() => ({ width: window.marpVideo.videoWidth, height: window.marpVideo.videoHeight }));

/** Seeks, waits for the frame to settle, and captures the canvas. */
async function capture(seconds, name) {
    await page.evaluate((t) => (window.marpVideo.currentTime = t), seconds);
    await page.waitForTimeout(2500);
    const shot = await page.evaluate(() => ({
        dataUrl: document.getElementById('canvas').toDataURL('image/png'),
        currentTime: window.marpVideo.currentTime,
    }));
    const path = join(workDir, `${name}.png`);
    writeFileSync(path, Buffer.from(shot.dataUrl.split(',')[1], 'base64'));
    return { path, currentTime: shot.currentTime };
}

// The reproduction: settle deep in the file, then the rate sequence that
// produced the corruption manually, then revisit ground already played --
// the symptom is that a revisited segment still shows wrong pictures.
await page.evaluate(() => (window.marpVideo.currentTime = 570));
await page.waitForTimeout(6000);

async function rate(value, holdMs) {
    await page.evaluate((r) => {
        window.marpVideo.playbackRate = r;
        window.marpVideo.play();
    }, value);
    await page.waitForTimeout(holdMs);
}

await rate(1, 3000);
await rate(0.5, 3000);
await rate(-0.5, 4000);
await rate(-1, 6000);
await rate(-3, 10_000);
await rate(-1, 6000);
await page.evaluate(() => window.marpVideo.pause());
await page.waitForTimeout(2000);

const results = [];
for (const target of [568, 564, 560, 556, 552]) {
    const shot = await capture(target, `t${target}`);
    const best = bestPsnr(shot.currentTime, size.width, size.height, shot.path, `t${target}`);
    results.push({ target, ...shot, ...best });
    console.log(
        `${LABEL} t=${target}s: displayed ${shot.currentTime.toFixed(3)}s, PSNR ${best.db === Infinity ? 'inf' : best.db.toFixed(1)}dB ` +
            `-> ${best.db < PSNR_WRONG_BELOW_DB ? 'WRONG PICTURE' : 'correct'}`,
    );
}

await browser.close();

const wrong = results.filter((r) => r.db < PSNR_WRONG_BELOW_DB);
console.log(`\n${LABEL}: ${wrong.length} of ${results.length} sampled frames showed the wrong picture`);
if (wrong.length) {
    console.log('captures kept for inspection:');
    for (const r of wrong) console.log(`  t=${r.target}s -> ${r.path}`);
} else {
    console.log(`captures in ${workDir}`);
}
