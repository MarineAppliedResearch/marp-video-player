/**
 * Describes the local MP4 test fixtures and writes a manifest beside them.
 *
 * Two things are recorded per fixture, both of which probes and later
 * local-file tests need to assert rather than assume:
 *
 *  - moov position relative to mdat. "faststart" is a muxer flag, not a
 *    guarantee; the only honest check is a top-level box walk. This is also
 *    the detector the archive survey (S4) uses for non-faststart files.
 *  - sample table shape: sample count, keyframes, average GOP, fps.
 *
 * Usage: node video-engine/test/probes/fixture-manifest.mjs [fixtureDir]
 */

import { readFileSync, writeFileSync, readdirSync, openSync, readSync, closeSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createFile } from 'mp4box';

// Pass the fixture directory as the first argument, or set
// VIDEO_ENGINE_FIXTURE_DIR. There is no default: the previous one was an
// absolute Linux path that does not exist on a Windows development machine.
const FIXTURE_DIR = process.argv[2] || process.env.VIDEO_ENGINE_FIXTURE_DIR;

if (!FIXTURE_DIR) {
    console.error('Usage: node fixture-manifest.mjs <fixture-dir>  (or set VIDEO_ENGINE_FIXTURE_DIR)');
    process.exit(1);
}

/**
 * Walks the top-level box list of an MP4 by reading only box headers.
 * Reads at most a few hundred bytes regardless of file size, so it is
 * safe to point at multi-gigabyte archive files.
 */
function walkTopLevelBoxes(path) {
    const size = statSync(path).size;
    const fd = openSync(path, 'r');
    const header = Buffer.alloc(16);
    const boxes = [];
    try {
        let offset = 0;
        while (offset < size && boxes.length < 64) {
            const read = readSync(fd, header, 0, 16, offset);
            if (read < 8) break;
            let boxSize = header.readUInt32BE(0);
            const type = header.toString('latin1', 4, 8);
            let headerSize = 8;
            // size 1 means the real size is a 64-bit value after the type
            if (boxSize === 1) {
                boxSize = Number(header.readBigUInt64BE(8));
                headerSize = 16;
            } else if (boxSize === 0) {
                boxSize = size - offset; // extends to end of file
            }
            if (boxSize < headerSize) break;
            boxes.push({ type, offset, size: boxSize });
            offset += boxSize;
        }
    } finally {
        closeSync(fd);
    }
    return boxes;
}

/** True when moov appears before mdat, i.e. the index is at the front. */
function isFaststart(boxes) {
    const moov = boxes.findIndex((b) => b.type === 'moov');
    const mdat = boxes.findIndex((b) => b.type === 'mdat');
    if (moov === -1 || mdat === -1) return null;
    return moov < mdat;
}

/** Sample-table stats via mp4box, reading the whole file (fixtures are small). */
function describeSamples(path) {
    const bytes = readFileSync(path);
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    buf.fileStart = 0;
    const iso = createFile();
    let info = null;
    iso.onReady = (i) => {
        info = i;
    };
    iso.appendBuffer(buf);
    iso.flush();
    if (!info) return { error: 'mp4box did not reach onReady' };

    const track = info.tracks.find((t) => t.type === 'video');
    if (!track) return { error: 'no video track' };
    const samples = iso.getTrackSamplesInfo(track.id);
    const keyframes = samples.filter((s) => s.is_sync);
    const durationSeconds = track.duration / track.timescale;
    return {
        codec: track.codec,
        width: track.video.width,
        height: track.video.height,
        durationSeconds: Number(durationSeconds.toFixed(3)),
        fps: Number((track.nb_samples / durationSeconds).toFixed(3)),
        samples: samples.length,
        keyframes: keyframes.length,
        averageGopSamples: Number((samples.length / keyframes.length).toFixed(1)),
        averageGopSeconds: Number((durationSeconds / keyframes.length).toFixed(3)),
    };
}

const files = readdirSync(FIXTURE_DIR)
    .filter((f) => f.endsWith('.mp4'))
    .sort();
const manifest = {};

for (const name of files) {
    const path = join(FIXTURE_DIR, name);
    const boxes = walkTopLevelBoxes(path);
    const faststart = isFaststart(boxes);
    const stats = describeSamples(path);
    manifest[name] = {
        bytes: statSync(path).size,
        faststart,
        topLevelBoxes: boxes.map((b) => `${b.type}@${b.offset}+${b.size}`),
        ...stats,
    };

    console.log(`\n${name}  (${(manifest[name].bytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`  boxes:     ${manifest[name].topLevelBoxes.join('  ')}`);
    console.log(`  faststart: ${faststart === null ? 'unknown' : faststart}`);
    if (stats.error) {
        console.log(`  ERROR:     ${stats.error}`);
        continue;
    }
    console.log(`  video:     ${stats.codec} ${stats.width}x${stats.height} @ ${stats.fps}fps, ${stats.durationSeconds}s`);
    console.log(`  samples:   ${stats.samples}, ${stats.keyframes} keyframes, avg GOP ${stats.averageGopSamples} samples / ${stats.averageGopSeconds}s`);
}

const out = join(FIXTURE_DIR, 'manifest.json');
writeFileSync(out, JSON.stringify(manifest, null, 4) + '\n');
console.log(`\nwrote ${out}`);
