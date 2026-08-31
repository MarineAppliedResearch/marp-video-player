/**
 * Direct Play feasibility probe.
 *
 * Question: can we build a real sample/GOP index for random access by
 * fetching only the moov prefix over HTTP byte ranges, and then pull an
 * arbitrary GOP out of mdat by byte range and assemble WebCodecs-ready
 * chunks from authoritative container timestamps?
 *
 * If yes, Direct Play gives accurate seeking and reverse playback without
 * any HLS segmentation, and without downloading the whole file.
 */

import { createFile, DataStream } from 'mp4box';

// Configuration comes only from the environment. Earlier revisions carried a
// server address, item id, username and password as inline fallbacks; those are
// credentials in source control, so the probe now refuses to run without them.
// See .env.example for the variable names.
const BASE = process.env.JELLYFIN_URL;
const ITEM = process.env.JELLYFIN_ITEM;
const USER = process.env.JELLYFIN_USER;
const PASS = process.env.JELLYFIN_PASS;

const missing = Object.entries({ JELLYFIN_URL: BASE, JELLYFIN_ITEM: ITEM, JELLYFIN_USER: USER, JELLYFIN_PASS: PASS })
    .filter(([, value]) => !value)
    .map(([name]) => name);

if (missing.length > 0) {
    console.error(`Set ${missing.join(', ')} before running this probe (see .env.example).`);
    process.exit(1);
}

const auth = await (
    await fetch(`${BASE}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: 'MediaBrowser Client="probe", Device="probe", DeviceId="probe-idx-1", Version="1.0"',
        },
        body: JSON.stringify({ Username: USER, Pw: PASS }),
    })
).json();

const url = `${BASE}/Videos/${ITEM}/stream?static=true&api_key=${auth.AccessToken}`;

async function range(start, endInclusive) {
    const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
    if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`);
    return await res.arrayBuffer();
}

// ---- 1. moov-only prefix -----------------------------------------------
const PREFIX_BYTES = 1_100_000; // ftyp + moov measured at ~1.03MB
const t0 = Date.now();
const prefix = await range(0, PREFIX_BYTES - 1);
const prefixMs = Date.now() - t0;
console.log(`fetched ${(prefix.byteLength / 1024 / 1024).toFixed(2)} MB moov prefix in ${prefixMs}ms`);

const isoFile = createFile();
let info = null;
isoFile.onError = (e) => console.error('mp4box error:', e);
isoFile.onReady = (i) => {
    info = i;
};
prefix.fileStart = 0;
isoFile.appendBuffer(prefix);
isoFile.flush();

if (!info) {
    console.error('FAIL: mp4box did not report onReady from a moov-only prefix');
    process.exit(1);
}

const videoTrack = info.tracks.find((t) => t.type === 'video');
console.log(`\nonReady from prefix alone: codec=${videoTrack.codec} ${videoTrack.video.width}x${videoTrack.video.height}`);
console.log(`  timescale=${videoTrack.timescale} duration=${(videoTrack.duration / videoTrack.timescale).toFixed(3)}s nb_samples=${videoTrack.nb_samples}`);

// ---- 2. full sample table --------------------------------------------
const samples = isoFile.getTrackSamplesInfo(videoTrack.id);
console.log(`\ngetTrackSamplesInfo returned ${samples.length} samples`);
if (!samples.length) {
    console.error('FAIL: no sample table available from the prefix');
    process.exit(1);
}

const keyframes = samples.filter((s) => s.is_sync);
console.log(`  keyframes: ${keyframes.length} (avg GOP ${(samples.length / keyframes.length).toFixed(1)} samples)`);
const s0 = samples[0];
console.log(`  sample[0]: offset=${s0.offset} size=${s0.size} cts=${s0.cts} dts=${s0.dts} sync=${s0.is_sync} timescale=${s0.timescale}`);
const sLast = samples[samples.length - 1];
console.log(`  sample[last]: cts=${sLast.cts} -> ${(sLast.cts / sLast.timescale).toFixed(3)}s, offset=${sLast.offset}`);

// ---- 3. pull an arbitrary GOP by byte range --------------------------
// Target ~677s in, the same region used in earlier live testing.
const targetSeconds = 677;
const targetCts = targetSeconds * samples[0].timescale;
let gopStartIdx = 0;
for (let i = 0; i < samples.length; i++) {
    if (samples[i].is_sync && samples[i].cts <= targetCts) gopStartIdx = i;
    if (samples[i].cts > targetCts) break;
}
let gopEndIdx = samples.length - 1;
for (let i = gopStartIdx + 1; i < samples.length; i++) {
    if (samples[i].is_sync) {
        gopEndIdx = i - 1;
        break;
    }
}

const gop = samples.slice(gopStartIdx, gopEndIdx + 1);
const byteStart = Math.min(...gop.map((s) => s.offset));
const byteEnd = Math.max(...gop.map((s) => s.offset + s.size)) - 1;
console.log(`\nGOP covering ${targetSeconds}s: samples ${gopStartIdx}..${gopEndIdx} (${gop.length} frames)`);
console.log(`  presentation ${(gop[0].cts / gop[0].timescale).toFixed(3)}s .. ${(gop[gop.length - 1].cts / gop[0].timescale).toFixed(3)}s`);
console.log(`  byte range ${byteStart}..${byteEnd} (${((byteEnd - byteStart + 1) / 1024).toFixed(0)} KB)`);

const t1 = Date.now();
const gopBytes = await range(byteStart, byteEnd);
console.log(`  fetched in ${Date.now() - t1}ms`);

// Assemble chunk descriptors exactly as demuxer.js produces them.
const view = new Uint8Array(gopBytes);
const chunks = gop.map((s) => ({
    type: s.is_sync ? 'key' : 'delta',
    timestamp: Math.round((s.cts / s.timescale) * 1e6),
    duration: Math.round((s.duration / s.timescale) * 1e6),
    data: view.subarray(s.offset - byteStart, s.offset - byteStart + s.size),
}));
console.log(`  assembled ${chunks.length} chunks; first is ${chunks[0].type}, ${chunks[0].data.byteLength} bytes`);
console.log(`  chunk timestamps span ${(chunks[0].timestamp / 1e6).toFixed(3)}s .. ${(chunks[chunks.length - 1].timestamp / 1e6).toFixed(3)}s`);

// ---- 4. codec description for VideoDecoder.configure() ---------------
const trak = isoFile.getTrackById(videoTrack.id);
let description = null;
for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC;
    if (box) {
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        description = new Uint8Array(stream.buffer, 8);
    }
}
console.log(`\navcC description: ${description ? description.byteLength + ' bytes' : 'MISSING'}`);

const allKey = chunks[0].type === 'key';
console.log(
    `\n${allKey && description && chunks.length > 1 ? 'PASS' : 'FAIL'}: GOP starts on a keyframe, has a codec description, and carries real container timestamps.`,
);
