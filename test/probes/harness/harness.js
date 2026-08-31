/**
 * S1/S2 -- decode cost, unit granularity, and the retention-window ceiling.
 *
 * Throwaway Phase 0 measurement code. It touches no engine module; it only
 * shares the probe index helper so S1/S2/S3 all measure the same index.
 *
 * Numbers from a software decoder are meaningless for these questions, so
 * this is built and smoke-tested in the sandbox (SwiftShader) and run for
 * real on the product owner's machine.
 *
 * S1 answers: how long a whole ~250-frame 1080p GOP takes to decode; time to
 * first frame for seeks landing early vs late in a GOP; the cost of
 * re-decoding from the keyframe when stepping backwards out of a retained
 * window, including across a GOP boundary.
 *
 * S2 answers: how many decoded frames (and therefore how many seconds of
 * video) can be held at once before VideoFrame allocation starts failing.
 */

import { authenticate, directPlayUrl, httpRangeReader, buildIndex, gopForTime, sampleRangeBytes, assembleChunks } from '../lib/mp4-index.mjs';

const out = document.getElementById('out');

/** Appends a line immediately, so partial results survive a tab crash in S2. */
function log(line = '') {
    out.textContent += line + '\n';
    out.scrollTop = out.scrollHeight;
    console.log(line);
}

const ms = (v) => `${v.toFixed(1)}ms`;
const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(2)} MB`;

function config() {
    return {
        base: document.getElementById('base').value.trim(),
        item: document.getElementById('item').value.trim(),
        user: document.getElementById('user').value.trim(),
        pass: document.getElementById('pass').value,
    };
}

/** Authenticates and builds the GOP index; shared by both spikes. */
async function connect() {
    const c = config();
    const token = await authenticate(c.base, c.user, c.pass, 'decode-harness');
    const read = httpRangeReader(directPlayUrl(c.base, c.item, token));
    const index = await buildIndex(read);
    log(`item: ${index.track.codec} ${index.track.width}x${index.track.height}, ${index.track.durationSeconds.toFixed(1)}s`);
    log(`index: ${index.gops.length} GOPs, avg ${(index.track.sampleCount / index.gops.length).toFixed(1)} frames / ${(index.track.durationSeconds / index.gops.length).toFixed(2)}s`);
    log(`agent: ${navigator.userAgent}`);
    const support = await VideoDecoder.isConfigSupported({
        codec: index.config.codec,
        description: index.config.description,
        codedWidth: index.track.width,
        codedHeight: index.track.height,
    });
    log(`decoder config supported: ${support.supported}`);
    log();
    return { index, read };
}

/**
 * Decodes samples [from..to] of a GOP from already-fetched bytes.
 *
 * Bytes are passed in rather than fetched here so decode time is never
 * confounded with network time -- S3 measures the network separately.
 *
 * onFrame decides each frame's fate: return true to retain it (the caller
 * then owns closing it), otherwise it is closed immediately. `stopAt` lets
 * a caller measure time-to-target-frame without waiting for the rest.
 */
async function decodeSamples({ index, bytes, byteStart, from, to, onFrame }) {
    const chunks = assembleChunks(index.samples, from, to, bytes, byteStart);
    const frames = [];
    let firstFrameAt = null;
    let decoded = 0;

    let resolveDone;
    let rejectDone;
    const done = new Promise((res, rej) => {
        resolveDone = res;
        rejectDone = rej;
    });

    const started = performance.now();
    const decoder = new VideoDecoder({
        output: (frame) => {
            decoded++;
            if (firstFrameAt === null) firstFrameAt = performance.now() - started;
            const keep = onFrame ? onFrame(frame, decoded - 1, performance.now() - started) : false;
            if (keep) frames.push(frame);
            else frame.close();
            if (decoded === chunks.length) resolveDone();
        },
        error: (e) => rejectDone(e),
    });
    decoder.configure({
        codec: index.config.codec,
        description: index.config.description,
        codedWidth: index.track.width,
        codedHeight: index.track.height,
        optimizeForLatency: true,
    });

    for (const c of chunks) decoder.decode(new EncodedVideoChunk(c));
    await decoder.flush().catch(rejectDone);
    await done;
    const totalMs = performance.now() - started;
    decoder.close();

    return { frames, totalMs, firstFrameAt, count: chunks.length };
}

/** Fetches a GOP's bytes and returns them with the range they cover. */
async function fetchRange(read, byteStart, byteEnd) {
    const bytes = await read(byteStart, byteEnd);
    return { bytes, byteStart };
}

// ---------------------------------------------------------------- S1 ----

async function runS1() {
    const { index, read } = await connect();
    const { samples, gops } = index;

    // 1. whole-GOP decode, three GOPs, bytes prefetched so only decode is timed
    log('S1.1 whole-GOP decode (network excluded)');
    for (const t of [30, 677, 1010]) {
        const gop = gopForTime(gops, t);
        const { bytes, byteStart } = await fetchRange(read, gop.byteStart, gop.byteEnd);
        const r = await decodeSamples({ index, bytes, byteStart, from: gop.firstSample, to: gop.lastSample });
        log(
            `  gop ${String(gop.index).padStart(3)}  ${r.count} frames  total ${ms(r.totalMs).padStart(9)}  ` +
                `${(r.totalMs / r.count).toFixed(2)}ms/frame  ${((r.count / r.totalMs) * 1000).toFixed(0)} fps  first frame ${ms(r.firstFrameAt)}`,
        );
    }

    // 2. time to first *target* frame for seeks landing at points in a GOP.
    // This is the number that decides how narrow the retained window can be.
    log('\nS1.2 time-to-target-frame by landing position in a GOP');
    const gop = gopForTime(gops, 677);
    for (const pct of [0, 0.25, 0.5, 0.75, 1]) {
        const target = gop.firstSample + Math.round((gop.frameCount - 1) * pct);
        const range = sampleRangeBytes(samples, gop.firstSample, target);
        const fetchStart = performance.now();
        const { bytes, byteStart } = await fetchRange(read, range.byteStart, range.byteEnd);
        const fetchMs = performance.now() - fetchStart;

        let targetAt = null;
        const wanted = target - gop.firstSample;
        const r = await decodeSamples({
            index,
            bytes,
            byteStart,
            from: gop.firstSample,
            to: target,
            onFrame: (_frame, i, at) => {
                if (i === wanted) targetAt = at;
                return false;
            },
        });
        log(
            `  ${String(pct * 100).padStart(3)}%  ${String(r.count).padStart(3)} frames  ${mb(range.byteLength).padStart(8)}  ` +
                `fetch ${ms(fetchMs).padStart(8)}  decode-to-target ${ms(targetAt ?? r.totalMs).padStart(9)}  total ${ms(fetchMs + (targetAt ?? r.totalMs)).padStart(9)}`,
        );
    }

    // 3. stepping backwards out of a retained window: the cost is always a
    // re-decode from the GOP's keyframe up to the wanted frame.
    log('\nS1.3 backward step out of the retained window (re-decode from keyframe)');
    const { bytes: fullBytes, byteStart: fullStart } = await fetchRange(read, gop.byteStart, gop.byteEnd);
    for (const back of [1, 10, 50, 125, 249]) {
        const target = gop.lastSample - back;
        if (target < gop.firstSample) continue;
        let targetAt = null;
        const wanted = target - gop.firstSample;
        const r = await decodeSamples({
            index,
            bytes: fullBytes,
            byteStart: fullStart,
            from: gop.firstSample,
            to: target,
            onFrame: (_f, i, at) => {
                if (i === wanted) targetAt = at;
                return false;
            },
        });
        log(`  step back ${String(back).padStart(3)} frames from GOP end -> re-decode ${r.count} frames, target ready in ${ms(targetAt ?? r.totalMs)}`);
    }

    // 4. the worst backward case: crossing into the previous GOP, which also
    // costs a fetch. This is what reverse playback pays at every boundary.
    log('\nS1.4 backward step across a GOP boundary (fetch + full re-decode)');
    const prev = gops[gop.index - 1];
    const crossStart = performance.now();
    const { bytes: prevBytes, byteStart: prevStart } = await fetchRange(read, prev.byteStart, prev.byteEnd);
    const prevFetchMs = performance.now() - crossStart;
    let lastAt = null;
    const r = await decodeSamples({
        index,
        bytes: prevBytes,
        byteStart: prevStart,
        from: prev.firstSample,
        to: prev.lastSample,
        onFrame: (_f, i, at) => {
            if (i === prev.frameCount - 1) lastAt = at;
            return false;
        },
    });
    log(`  previous GOP ${prev.index}: ${mb(prev.byteLength)} fetch ${ms(prevFetchMs)}, decode to its last frame ${ms(lastAt ?? r.totalMs)}, total ${ms(prevFetchMs + (lastAt ?? r.totalMs))}`);
    log('\nS1 done.');
}

// ---------------------------------------------------------------- S2 ----

async function runS2() {
    const { index, read } = await connect();
    const { gops, track } = index;
    const fps = track.sampleCount / track.durationSeconds;

    log('S2 retention ceiling: retaining every decoded frame until allocation fails');
    log(`  nominal I420 cost: ${((track.width * track.height * 1.5) / 1024 / 1024).toFixed(2)} MB/frame at ${track.width}x${track.height}`);
    const cap = Number(document.getElementById('cap').value) || 4000;
    log(`  stopping at ${cap} retained frames if nothing fails first`);
    log('  NOTE: exhaustion may crash the tab rather than throw -- observed in the sandbox at');
    log('  ~1250-1500 frames. A crash IS the result: the last line below brackets the ceiling.\n');

    const retained = [];
    let held = 0;
    // Report every 50 frames as they are retained, not once per 250-frame
    // GOP, so a crash still brackets the ceiling to within 50 frames.
    const STEP = 50;
    let gopIndex = gopForTime(gops, 30).index;
    try {
        while (held < cap && gopIndex < gops.length) {
            const gop = gops[gopIndex];
            const { bytes, byteStart } = await fetchRange(read, gop.byteStart, gop.byteEnd);
            const r = await decodeSamples({
                index,
                bytes,
                byteStart,
                from: gop.firstSample,
                to: gop.lastSample,
                onFrame: () => {
                    if (held >= cap) return false;
                    held++;
                    if (held % STEP === 0) {
                        log(
                            `  retained ${String(held).padStart(5)} frames  = ${(held / fps).toFixed(1)}s of video  ` +
                                `~${((held * track.width * track.height * 1.5) / 1024 / 1024 / 1024).toFixed(2)} GB nominal`,
                        );
                    }
                    return true;
                },
            });
            retained.push(...r.frames);
            gopIndex++;
        }
        log(`\nreached ${held} retained frames (${(held / fps).toFixed(1)}s) with no failure.`);
    } catch (e) {
        log(`\nFAILED after ${held} retained frames (${(held / fps).toFixed(1)}s of video): ${e}`);
        log('  ^ this is the retention ceiling on this machine');
    } finally {
        for (const f of retained) f.close();
        log('released all retained frames.');
    }
}

document.getElementById('s1').addEventListener('click', () => runS1().catch((e) => log(`ERROR: ${e && e.stack ? e.stack : e}`)));
document.getElementById('s2').addEventListener('click', () => runS2().catch((e) => log(`ERROR: ${e && e.stack ? e.stack : e}`)));
document.getElementById('clear').addEventListener('click', () => {
    out.textContent = '';
});
