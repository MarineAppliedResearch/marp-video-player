/**
 * Unit tests for building units from frames that arrived under another unit's label.
 *
 * The fake Jellyfin here behaves as the real one was measured to on 2026-09-26: a
 * transcode job cold-started at segment N begins at the source keyframe at or before N's
 * start (keyframes every 10 s, as on MARP's dives), keeps N's label, and every later
 * segment of that job carries the same shift. Frame timestamps are the true source times.
 * A job started at 0 has no shift.
 *
 * @fileoverview Unit tests for unit-assembly.js and FrameStore's assembly by true time.
 * @module video-engine/test/unit/unit-assembly.test
 */

const {
    segmentShiftSeconds,
    isShifted,
    unitForTimestamp,
    unitCoverage,
    segmentHolding,
} = require('../../src/unit-assembly.js');
const { FrameStore } = require('../../src/frame-store.js');

const FPS = 25;
const FRAME = 1 / FPS;
const SEGMENT = 3;
const KEYFRAME_INTERVAL = 10;
const UNITS = 400;

/**
 * Jellyfin's transcode playlist. Its segments are 3 s, or a hair longer on a dive whose
 * average rate is under 25 -- 3.0067 s on 20260611_161158_Fwd -- while each still holds
 * exactly 75 frames, 3.000 s.
 */
function unitIndex(label = SEGMENT) {
    const segments = Array.from({ length: UNITS }, (_, index) => ({
        index,
        startTime: index * label,
        endTime: (index + 1) * label,
        duration: label,
    }));
    return { segments, totalDuration: UNITS * label };
}

const micros = (seconds) => Math.round(seconds * 1e6);

/**
 * A fake Jellyfin transcode. The first segment requested starts the job; `restartAt`
 * starts another, as a seek far away would. Returns the segment's chunks at their true
 * source times.
 */
function makeJellyfin(label = SEGMENT) {
    // A job: the segment it was started at, and the keyframe its output began from. Its
    // output is continuous, 3.000 s of frames per segment, whatever the labels say.
    let job = null;
    const fetches = [];
    return {
        fetches,
        label,
        restartAt(segmentNumber) {
            const start = segmentNumber * label;
            job = { from: segmentNumber, keyframe: Math.floor(start / KEYFRAME_INTERVAL) * KEYFRAME_INTERVAL };
        },
        // Like the real raw cache: a segment fetched once is served from cache until it is
        // asked for afresh, whichever job it came from.
        cache: new Map(),
        segment(segmentNumber, { refetch = false } = {}) {
            if (job === null) this.restartAt(segmentNumber);
            if (!refetch && this.cache.has(segmentNumber)) return this.cache.get(segmentNumber);
            fetches.push(segmentNumber);
            const from = job.keyframe + (segmentNumber - job.from) * SEGMENT;
            const count = Math.round(SEGMENT * FPS);
            const chunks = Array.from({ length: count }, (_, i) => ({
                type: i === 0 ? 'key' : 'delta',
                timestamp: micros(from + i * FRAME),
                duration: micros(FRAME),
                data: new Uint8Array([1]),
            }));
            this.cache.set(segmentNumber, chunks);
            return chunks;
        },
    };
}

function makeStore(jellyfin) {
    const index = unitIndex(jellyfin.label);
    const decodes = [];
    const frames = [];
    const mediaSource = {
        unitsMayArriveShifted: true,
        getUnitIndex: () => index,
        // The ordinary path's call too, so the same fake runs against a store without
        // assembly and shows what it did: the label's frames, whatever time they are from.
        fetchChunks: async (segmentNumber) => {
            const chunks = jellyfin.segment(segmentNumber);
            return { codec: 'avc1.test', description: null, chunks, unitFirstTimestampMicros: chunks[0].timestamp };
        },
        fetchSegmentChunks: jest.fn(async (segmentNumber, options) => {
            const chunks = jellyfin.segment(segmentNumber, options);
            return { codec: 'avc1.test', description: null, chunks, unitFirstTimestampMicros: chunks[0].timestamp };
        }),
    };
    const gopDecoder = {
        decodeSegment: async (segmentNumber, demux) => {
            decodes.push(segmentNumber);
            const made = demux.chunks.map((chunk) => ({ timestamp: chunk.timestamp, close: jest.fn() }));
            frames.push(...made);
            return { segmentIndex: segmentNumber, frames: made };
        },
    };
    const store = new FrameStore({
        segmentFetcher: { hasRawBytes: () => true },
        mediaSource,
        gopDecoder,
        width: 1280,
        height: 720,
        fps: FPS,
        segmentDuration: SEGMENT,
        cacheBudgetBytes: 1,
    });
    store._logDebug = () => {};
    store.mediaSource = mediaSource;
    return { store, decodes, frames, mediaSource };
}

const seconds = (buffer) => buffer.frames.map((frame) => Math.round(frame.timestamp / 1e3) / 1e3);

describe('the assembly rules', () => {
    test('a segment\'s shift is how far before its label its first frame is', () => {
        expect(segmentShiftSeconds({ startTime: 267 }, micros(260))).toBeCloseTo(7);
        expect(isShifted(7, FRAME)).toBe(true);
        expect(isShifted(0.01, FRAME)).toBe(false);
    });

    test('a frame belongs to the unit its own time is in, a boundary frame to the later one', () => {
        expect(unitForTimestamp(unitIndex(), micros(266.96))).toBe(88);
        expect(unitForTimestamp(unitIndex(), micros(267))).toBe(89);
    });

    test('coverage names the first moment missing, at the start, in a gap or at the end', () => {
        const unit = { startTime: 267, endTime: 270 };
        const all = Array.from({ length: 75 }, (_, i) => micros(267 + i * FRAME));
        expect(unitCoverage(all, unit, FRAME)).toEqual({ complete: true, missingFromSeconds: null });
        expect(unitCoverage(all.slice(25), unit, FRAME).missingFromSeconds).toBe(267);
        expect(unitCoverage(all.slice(0, 50), unit, FRAME).missingFromSeconds).toBeCloseTo(269);
        expect(unitCoverage([...all.slice(0, 20), ...all.slice(30)], unit, FRAME).missingFromSeconds).toBeCloseTo(267.8);
    });

    test('a job shifted by 7 s holds 267 s in the segment labelled 274 s', () => {
        expect(segmentHolding(unitIndex(), 267, 7)).toBe(91);
        expect(segmentHolding(unitIndex(), 267, 0)).toBe(89);
    });
});

describe('FrameStore builds a cold-started transcode\'s units by their frames\' own time', () => {
    test('R1 R2: the unit at 267 s holds exactly 267.00 to 269.96 s, not the 260 s its segment carried', async () => {
        const { store } = makeStore(makeJellyfin());
        const buffer = await store.ensureDecoded(89);
        const times = seconds(buffer);
        expect(times).toHaveLength(75);
        expect(times[0]).toBe(267);
        expect(times[74]).toBe(269.96);
    });

    test('R3: every segment is decoded once, and the next unit reuses what the last one decoded', async () => {
        const { store, decodes } = makeStore(makeJellyfin());
        await store.ensureDecoded(89);
        // 89 starts the job (and holds 260 to 263); 91 and 92 hold 267 to 270.
        expect(decodes).toEqual([89, 91, 92]);
        await store.ensureDecoded(90);
        expect(seconds(store.buffers.get(90))[0]).toBe(270);
        // 92 already gave 90 its first two seconds; only 93 is new.
        expect(decodes).toEqual([89, 91, 92, 93]);
    });

    test('R1 R3: the opening unit the engine decoded is filed by its own time, and not decoded again', async () => {
        const { store, decodes, frames } = makeStore(makeJellyfin());
        // What the engine does at load: decode the opening segment itself, then hand it over.
        const chunks = (await store.mediaSource.fetchSegmentChunks(89)).chunks;
        const opening = chunks.map((chunk) => ({ timestamp: chunk.timestamp, close: jest.fn() }));
        frames.push(...opening);
        store.adoptDecoded(89, { segmentIndex: 89, frames: opening });
        expect(store.has(89)).toBe(false);

        const buffer = await store.ensureDecoded(89);
        expect(seconds(buffer)[0]).toBe(267);
        expect(seconds(buffer)).toHaveLength(75);
        expect(decodes).toEqual([91, 92]);
    });

    test('R4: an unshifted opening unit is seeded exactly as before', async () => {
        const jellyfin = makeJellyfin();
        jellyfin.restartAt(0);
        const { store, decodes } = makeStore(jellyfin);
        const chunks = (await store.mediaSource.fetchSegmentChunks(5)).chunks;
        const opening = { segmentIndex: 5, frames: chunks.map((chunk) => ({ timestamp: chunk.timestamp, close: jest.fn() })) };
        store.adoptDecoded(5, opening);
        expect(store.buffers.get(5)).toBe(opening);
        expect(decodes).toEqual([]);
    });

    test('R1 R2: on labels longer than their content, the next segment is found from what the last one held', async () => {
        // 20260611_161158_Fwd opened at 600 s: its labels are 3.0067 s, its segments 75 frames.
        const jellyfin = makeJellyfin(3.0067);
        const { store, decodes } = makeStore(jellyfin);
        const unit = store.mediaSource.getUnitIndex().segments[199];
        const buffer = await store.ensureDecoded(199);
        const times = seconds(buffer);
        expect(times[0]).toBeGreaterThanOrEqual(unit.startTime - 1e-3);
        expect(times[0] - unit.startTime).toBeLessThan(FRAME);
        expect(unit.endTime - times[times.length - 1]).toBeLessThanOrEqual(FRAME + 1e-3);
        // Never the same segment twice: that was the loop the constant-shift guess made.
        expect(new Set(decodes).size).toBe(decodes.length);
    });

    test('R4: a job from 0 takes today\'s path -- one segment, one unit, one decode', async () => {
        const jellyfin = makeJellyfin();
        jellyfin.restartAt(0);
        const { store, decodes } = makeStore(jellyfin);
        const buffer = await store.ensureDecoded(5);
        expect(decodes).toEqual([5]);
        expect(seconds(buffer)[0]).toBe(15);
        expect(seconds(buffer)).toHaveLength(75);
    });

    test('R6: every frame decoded is kept by a unit, held for one, or closed, and holding is bounded', async () => {
        const { store, frames } = makeStore(makeJellyfin());
        await store.ensureDecoded(89);
        await store.ensureDecoded(90);
        const kept = new Set([...store.buffers.values()].flatMap((buffer) => buffer.frames));
        const held = new Set([...store._partials.values()].flatMap((partial) => [...partial.values()]));
        for (const frame of frames) {
            const closed = frame.close.mock.calls.length > 0;
            expect([kept.has(frame), held.has(frame), closed].filter(Boolean)).toHaveLength(1);
        }
        expect(store._partials.size).toBeLessThanOrEqual(3);
    });

    test('A4: after a seek starts a new job, a unit is still built from its own time, and nothing is decoded twice unless fetched again', async () => {
        const jellyfin = makeJellyfin();
        const { store, decodes, mediaSource } = makeStore(jellyfin);
        await store.ensureDecoded(89);
        await store.ensureDecoded(90);
        // A seek elsewhere starts a new job, shifted differently (5 s); segments already
        // cached are still the old job's.
        jellyfin.restartAt(95);
        const before = decodes.length;
        const callsBefore = mediaSource.fetchSegmentChunks.mock.calls.length;
        const buffer = await store.ensureDecoded(93);
        const times = seconds(buffer);
        expect(times[0]).toBe(279);
        expect(times[74]).toBe(281.96);
        expect(times).toHaveLength(75);
        const calls = mediaSource.fetchSegmentChunks.mock.calls.slice(callsBefore);
        const seen = new Set();
        decodes.slice(before).forEach((segmentNumber, i) => {
            const refetched = Boolean(calls[i][1] && calls[i][1].refetch);
            expect(seen.has(segmentNumber) && !refetched).toBe(false);
            seen.add(segmentNumber);
        });
    });
});
