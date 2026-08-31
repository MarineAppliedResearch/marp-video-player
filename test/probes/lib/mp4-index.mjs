/**
 * Shared probe helper: turn a byte-range-readable MP4 into a GOP index.
 *
 * This is Phase 0 measurement code, not engine code. It exists so the
 * throughput probe (S3) and the browser decode harness (S1/S2) measure the
 * same index, built the same way, rather than each reimplementing it.
 *
 * The read primitive is deliberately `read(start, endInclusive) -> ArrayBuffer`
 * and nothing more, matching the reader contract §6 of the architecture doc
 * settles on -- so the same code works over HTTP+Range or a Blob.
 */

import { createFile, DataStream } from 'mp4box';

/** ftyp + moov measured at ~1.03MB on the reference 1080p item. */
export const DEFAULT_PREFIX_BYTES = 1_100_000;

/** Authenticates against Jellyfin and returns the access token. */
export async function authenticate(base, user, pass, deviceId = 'probe-device-1') {
    const res = await fetch(`${base}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            Authorization: `MediaBrowser Client="probe", Device="probe", DeviceId="${deviceId}", Version="1.0"`,
        },
        body: JSON.stringify({ Username: user, Pw: pass }),
    });
    if (!res.ok) throw new Error(`auth failed: ${res.status}`);
    return (await res.json()).AccessToken;
}

/** The stateless Direct Play URL: no session, no transcoder, honours ranges. */
export function directPlayUrl(base, item, token) {
    return `${base}/Videos/${item}/stream?static=true&api_key=${token}`;
}

/** Builds a read(start, endInclusive) function over an HTTP resource. */
export function httpRangeReader(url) {
    return async function read(start, endInclusive) {
        const res = await fetch(url, { headers: { Range: `bytes=${start}-${endInclusive}` } });
        if (res.status !== 206) throw new Error(`expected 206, got ${res.status}`);
        return await res.arrayBuffer();
    };
}

/**
 * Fetches the moov prefix and derives the decoder config, sample table and
 * GOP list. Throws if the index is not at the front of the file -- a
 * non-faststart file needs a different probe strategy (open question 5).
 */
export async function buildIndex(read, prefixBytes = DEFAULT_PREFIX_BYTES) {
    const started = Date.now();
    const prefix = await read(0, prefixBytes - 1);
    const fetchMs = Date.now() - started;

    const iso = createFile();
    let info = null;
    iso.onReady = (i) => {
        info = i;
    };
    prefix.fileStart = 0;
    iso.appendBuffer(prefix);
    iso.flush();
    if (!info) throw new Error(`no moov within the first ${prefixBytes} bytes (non-faststart?)`);

    const track = info.tracks.find((t) => t.type === 'video');
    const samples = iso.getTrackSamplesInfo(track.id);
    if (!samples.length) throw new Error('sample table empty');

    return {
        fetchMs,
        prefixBytes,
        track: {
            codec: track.codec,
            width: track.video.width,
            height: track.video.height,
            timescale: track.timescale,
            durationSeconds: track.duration / track.timescale,
            sampleCount: track.nb_samples,
        },
        config: { codec: track.codec, description: avcDescription(iso, track.id) },
        samples,
        gops: buildGops(samples),
    };
}

/** Extracts the avcC/hvcC payload VideoDecoder.configure() needs. */
function avcDescription(iso, trackId) {
    const trak = iso.getTrackById(trackId);
    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC;
        if (!box) continue;
        const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
        box.write(stream);
        return new Uint8Array(stream.buffer, 8);
    }
    return null;
}

/**
 * Groups the sample table into GOPs at sync samples. Byte ranges are taken
 * from min/max sample extents rather than assumed contiguous, since sample
 * order in the file need not match presentation order.
 */
export function buildGops(samples) {
    const gops = [];
    let current = null;
    for (let i = 0; i < samples.length; i++) {
        const s = samples[i];
        if (s.is_sync || current === null) {
            if (current) gops.push(finishGop(current, samples));
            current = { index: gops.length, firstSample: i };
        }
        current.lastSample = i;
    }
    if (current) gops.push(finishGop(current, samples));
    return gops;
}

function finishGop(gop, samples) {
    const span = samples.slice(gop.firstSample, gop.lastSample + 1);
    const timescale = span[0].timescale;
    let byteStart = Infinity;
    let byteEnd = -Infinity;
    for (const s of span) {
        if (s.offset < byteStart) byteStart = s.offset;
        if (s.offset + s.size - 1 > byteEnd) byteEnd = s.offset + s.size - 1;
    }
    return {
        ...gop,
        frameCount: span.length,
        startTime: span[0].cts / timescale,
        endTime: (span[span.length - 1].cts + span[span.length - 1].duration) / timescale,
        byteStart,
        byteEnd,
        byteLength: byteEnd - byteStart + 1,
    };
}

/** The GOP containing a presentation time, or the last one before it. */
export function gopForTime(gops, seconds) {
    let found = gops[0];
    for (const gop of gops) {
        if (gop.startTime <= seconds) found = gop;
        else break;
    }
    return found;
}

/**
 * Byte range covering samples [from..to] of a GOP -- the sub-GOP addressing
 * §4 needs, so a seek near a GOP's start does not pay for its whole 10s.
 */
export function sampleRangeBytes(samples, from, to) {
    let byteStart = Infinity;
    let byteEnd = -Infinity;
    for (let i = from; i <= to; i++) {
        const s = samples[i];
        if (s.offset < byteStart) byteStart = s.offset;
        if (s.offset + s.size - 1 > byteEnd) byteEnd = s.offset + s.size - 1;
    }
    return { byteStart, byteEnd, byteLength: byteEnd - byteStart + 1 };
}

/** Assembles WebCodecs-ready chunk descriptors from fetched GOP bytes. */
export function assembleChunks(samples, from, to, bytes, byteStart) {
    const view = new Uint8Array(bytes);
    const chunks = [];
    for (let i = from; i <= to; i++) {
        const s = samples[i];
        chunks.push({
            type: s.is_sync ? 'key' : 'delta',
            timestamp: Math.round((s.cts / s.timescale) * 1e6),
            duration: Math.round((s.duration / s.timescale) * 1e6),
            data: view.subarray(s.offset - byteStart, s.offset - byteStart + s.size),
        });
    }
    return chunks;
}
