/**
 * S3 -- Direct Play throughput and seek latency.
 *
 * Questions (architecture doc §9):
 *   - What does a cold index cost, and a whole GOP?
 *   - What does a seek cost as a function of where in the GOP it lands?
 *     Landing at the very end is the worst case: every sample from the
 *     keyframe must be fetched and decoded to display one frame.
 *   - Does sustained sequential fetching keep up with the media bitrate?
 *
 * Network only. No decode happens here, so these numbers are valid in the
 * sandbox; what the sandbox cannot reproduce is a genuinely slow link, so
 * the owner should re-run this over the VPN.
 *
 * Usage: node video-engine/test/probes/s3-throughput.mjs
 */

import { authenticate, directPlayUrl, httpRangeReader, buildIndex, gopForTime, sampleRangeBytes } from './lib/mp4-index.mjs';

const BASE = process.env.JELLYFIN_URL;
const ITEM = process.env.JELLYFIN_ITEM;
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;

const mbps = (bytes, ms) => ((bytes * 8) / (ms / 1000) / 1e6).toFixed(1);
const mb = (bytes) => (bytes / 1024 / 1024).toFixed(2);

const token = await authenticate(BASE, USER, PASS, 's3-throughput');
const url = directPlayUrl(BASE, ITEM, token);
const read = httpRangeReader(url);

// ---- 1. cold index -----------------------------------------------------
const index = await buildIndex(read);
const { track, gops, samples } = index;
console.log(`item: ${track.codec} ${track.width}x${track.height}, ${track.durationSeconds.toFixed(1)}s, ${track.sampleCount} samples`);
console.log(`index: ${mb(index.prefixBytes)} MB prefix in ${index.fetchMs}ms (${mbps(index.prefixBytes, index.fetchMs)} Mbps)`);
console.log(`gops:  ${gops.length}, avg ${(track.sampleCount / gops.length).toFixed(1)} frames / ${(track.durationSeconds / gops.length).toFixed(2)}s`);

const mediaBitrate = (track.sampleCount && gops.reduce((n, g) => n + g.byteLength, 0) * 8) / track.durationSeconds / 1e6;
console.log(`media bitrate (from sample sizes): ${mediaBitrate.toFixed(2)} Mbps\n`);

// ---- 2. whole-GOP fetch at several points in the file ------------------
console.log('whole-GOP fetches (cold seek, full unit):');
const probeTimes = [30, 340, 677, 1010, 1340];
for (const t of probeTimes) {
    const gop = gopForTime(gops, t);
    const started = Date.now();
    await read(gop.byteStart, gop.byteEnd);
    const ms = Date.now() - started;
    console.log(
        `  t=${String(t).padStart(4)}s  gop ${String(gop.index).padStart(3)}  ${String(gop.frameCount).padStart(3)} frames  ` +
            `${mb(gop.byteLength).padStart(6)} MB  ${String(ms).padStart(5)}ms  ${mbps(gop.byteLength, ms).padStart(6)} Mbps`,
    );
}

// ---- 3. seek cost vs position within a GOP -----------------------------
// The §4 mitigation: to show time T we need the keyframe plus samples up to
// T, and the sample table gives every offset -- so an early landing is cheap
// and only a late landing approaches the whole GOP.
console.log('\nseek cost vs landing position within one GOP (sub-GOP fetch):');
const seekGop = gopForTime(gops, 677);
console.log(`  gop ${seekGop.index}: samples ${seekGop.firstSample}..${seekGop.lastSample}, ${seekGop.frameCount} frames, ${mb(seekGop.byteLength)} MB total`);
for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
    const target = seekGop.firstSample + Math.round((seekGop.frameCount - 1) * pct);
    const range = sampleRangeBytes(samples, seekGop.firstSample, target);
    const started = Date.now();
    await read(range.byteStart, range.byteEnd);
    const ms = Date.now() - started;
    const share = ((range.byteLength / seekGop.byteLength) * 100).toFixed(0);
    console.log(
        `  ${String(pct * 100).padStart(3)}%  frames ${String(target - seekGop.firstSample + 1).padStart(3)}  ` +
            `${mb(range.byteLength).padStart(6)} MB (${share.padStart(3)}% of GOP)  ${String(ms).padStart(5)}ms`,
    );
}

// ---- 4. sustained sequential throughput --------------------------------
// Playback consumes ~1 GOP per GOP-duration; sustained rate must exceed the
// media bitrate or forward playback falls behind regardless of decode speed.
console.log('\nsustained sequential fetch (8 consecutive GOPs):');
const first = gopForTime(gops, 677).index;
let totalBytes = 0;
let totalSeconds = 0;
const startedAll = Date.now();
for (let i = first; i < first + 8 && i < gops.length; i++) {
    const gop = gops[i];
    await read(gop.byteStart, gop.byteEnd);
    totalBytes += gop.byteLength;
    totalSeconds += gop.endTime - gop.startTime;
}
const allMs = Date.now() - startedAll;
console.log(`  ${mb(totalBytes)} MB covering ${totalSeconds.toFixed(1)}s of video in ${allMs}ms -> ${mbps(totalBytes, allMs)} Mbps`);
console.log(`  realtime factor: ${(totalSeconds / (allMs / 1000)).toFixed(1)}x (must exceed 1.0 for forward playback to keep up)`);

// ---- 5. what a constrained link would mean ------------------------------
const worstGop = gops.reduce((a, b) => (b.byteLength > a.byteLength ? b : a));
console.log(`\nworst-case GOP in this file: gop ${worstGop.index}, ${mb(worstGop.byteLength)} MB, ${worstGop.frameCount} frames`);
for (const linkMbps of [100, 25, 8, 4, 1]) {
    const seconds = (worstGop.byteLength * 8) / (linkMbps * 1e6);
    console.log(`  at ${String(linkMbps).padStart(3)} Mbps: worst-case cold seek ${seconds.toFixed(1)}s, playback needs ${mediaBitrate.toFixed(1)} Mbps sustained -> ${linkMbps > mediaBitrate ? 'feasible' : 'NOT feasible'}`);
}
