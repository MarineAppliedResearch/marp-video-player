/**
 * Unit tests for AudioStore.
 *
 * The behaviour worth protecting here is mostly about what the store REFUSES
 * to do: it never fetches, never retries a permanent failure, and never lets
 * an audio problem become a playback problem. Those are the properties that
 * keep audio from competing with the picture.
 *
 * @fileoverview Unit tests for the decoded-audio cache.
 * @author Isaac Travers
 * @module video-engine/test/unit/audio-store.test
 */

const { AudioStore } = require('../../src/audio-store.js');

/**
 * Builds a store over doubles for the media source, Tier 1 and the decoder.
 *
 * @param {Object} [options]
 * @param {Array<number>} [options.fetchedUnits] - Units whose raw bytes Tier 1 holds.
 * @param {Object} [options.overrides] - Replacement methods for the media source or decoder.
 * @returns {Object} `{store, mediaSource, segmentFetcher, audioDecoder}`.
 */
function build({ fetchedUnits = [0, 1, 2], overrides = {} } = {}) {
    const mediaSource = {
        fetchAudioChunks: jest.fn(async (unitIndex) => ({
            codec: 'mp4a.40.2',
            description: new Uint8Array([1]),
            sampleRate: 48000,
            numberOfChannels: 2,
            chunks: [{ type: 'key', timestamp: unitIndex * 1_000_000, duration: 1_000_000, data: new Uint8Array([1]) }],
            timelineOffsetMicros: 0,
        })),
        ...overrides.mediaSource,
    };

    const segmentFetcher = {
        hasRawBytes: jest.fn((unitIndex) => fetchedUnits.includes(unitIndex)),
        // Present so a test can prove it is never called. Audio must never
        // put a fetch in front of the picture's own.
        ensureRawBytes: jest.fn(),
        fetchSegment: jest.fn(),
    };

    const audioDecoder = {
        decodeUnit: jest.fn(async (unitIndex) => ({
            unitIndex,
            sampleRate: 48000,
            numberOfChannels: 2,
            startTime: unitIndex,
            duration: 1,
            buffer: { duration: 1, sampleRate: 48000, numberOfChannels: 2 },
        })),
        close: jest.fn(),
        ...overrides.audioDecoder,
    };

    return {
        store: new AudioStore({ mediaSource, segmentFetcher, audioDecoder, maxUnits: 2 }),
        mediaSource,
        segmentFetcher,
        audioDecoder,
    };
}

/** Lets every queued microtask settle, which is how a fire-and-forget request finishes. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

describe('AudioStore', () => {

    it('returns nothing until a requested unit has decoded', async () => {
        const { store } = build();

        expect(store.get(0)).toBeNull();

        store.request(0);
        await settle();

        expect(store.get(0)).not.toBeNull();
    });

    it('places a decoded unit on the playlist timeline', async () => {
        const { store } = build();
        store.request(1);
        await settle();

        const unit = store.get(1);
        expect(unit.mediaStart).toBeCloseTo(1, 6);
        expect(unit.mediaEnd).toBeCloseTo(2, 6);
    });

    /**
     * A transcoder's segment timestamps can sit a whole segment away from
     * playlist time, and the source reports the correction. Ignoring it would
     * put every unit's audio in the wrong place by that much.
     */
    it('applies the source-reported timeline offset', async () => {
        const { store, mediaSource } = build();
        mediaSource.fetchAudioChunks = jest.fn(async () => ({
            codec: 'mp4a.40.2',
            sampleRate: 48000,
            numberOfChannels: 2,
            chunks: [{ type: 'key', timestamp: 0, duration: 1_000_000, data: new Uint8Array([1]) }],
            timelineOffsetMicros: 5_000_000,
        }));

        store.request(0);
        await settle();

        expect(store.get(0).mediaStart).toBeCloseTo(5, 6);
    });

    /**
     * The rule that keeps audio from ever slowing the picture down: audio
     * reads bytes Tier 1 already has and asks for nothing.
     */
    it('never fetches, and skips a unit whose bytes are not already held', async () => {
        const { store, mediaSource, segmentFetcher } = build({ fetchedUnits: [0] });

        store.request(5);
        await settle();

        expect(store.get(5)).toBeNull();
        expect(mediaSource.fetchAudioChunks).not.toHaveBeenCalled();
        expect(segmentFetcher.ensureRawBytes).not.toHaveBeenCalled();
        expect(segmentFetcher.fetchSegment).not.toHaveBeenCalled();
    });

    it('decodes a unit once however many times it is asked for', async () => {
        const { store, audioDecoder } = build();

        store.request(0);
        store.request(0);
        store.request(0);
        await settle();
        store.request(0);
        await settle();

        expect(audioDecoder.decodeUnit).toHaveBeenCalledTimes(1);
    });

    /**
     * The commonest audio decode failure is not a bad unit at all: it is the
     * decoder giving up while the picture saturates the machine. Retrying once
     * costs almost nothing and recovers that case, which was observed leaving
     * a whole unit silent.
     */
    it('retries a unit that fails to decode once before giving up', async () => {
        const { store, audioDecoder } = build();
        audioDecoder.decodeUnit = jest.fn(async () => {
            throw new Error('bad audio');
        });

        store.request(0);
        await settle();
        store.request(0);
        await settle();

        expect(audioDecoder.decodeUnit).toHaveBeenCalledTimes(2);
        expect(store.get(0)).toBeNull();
    });

    /**
     * Retrying cannot be unbounded: the scheduling passes run several times a
     * second, and a genuinely undecodable unit will not become decodable by
     * being asked forever.
     */
    it('stops retrying a unit that keeps failing', async () => {
        const { store, audioDecoder } = build();
        audioDecoder.decodeUnit = jest.fn(async () => {
            throw new Error('bad audio');
        });

        for (let attempt = 0; attempt < 6; attempt++) {
            store.request(0);
            await settle();
        }

        expect(audioDecoder.decodeUnit).toHaveBeenCalledTimes(2);
    });

    it('recovers a unit whose first decode failed under load', async () => {
        const { store, audioDecoder } = build();
        let calls = 0;
        audioDecoder.decodeUnit = jest.fn(async (unitIndex) => {
            calls += 1;
            if (calls === 1) {
                throw new Error('AudioDecoder produced no output');
            }
            return { unitIndex, sampleRate: 48000, numberOfChannels: 2, startTime: 0, duration: 1, buffer: { duration: 1 } };
        });

        store.request(0);
        await settle();
        expect(store.get(0)).toBeNull();

        store.request(0);
        await settle();
        expect(store.get(0)).not.toBeNull();
    });

    /**
     * Tier 1 can evict a unit's bytes between the check and the read, and
     * `getCachedRawBytes` throws when it has. That says nothing about whether
     * the audio is decodable, so treating it as a permanent failure would
     * leave the unit silent for the rest of the session over a cache eviction
     * that has already been undone by the time anyone plays it again.
     */
    it('retries a unit whose bytes were evicted mid-decode rather than giving up on it', async () => {
        let bytesPresent = true;
        const { store, mediaSource, segmentFetcher } = build();

        segmentFetcher.hasRawBytes = jest.fn(() => bytesPresent);
        mediaSource.fetchAudioChunks = jest.fn(async () => {
            if (!bytesPresent) {
                throw new Error('Segment 0 raw bytes are not cached');
            }
            return {
                codec: 'mp4a.40.2',
                sampleRate: 48000,
                numberOfChannels: 2,
                chunks: [{ type: 'key', timestamp: 0, duration: 1_000_000, data: new Uint8Array([1]) }],
                timelineOffsetMicros: 0,
            };
        });

        // Passes the presence check, then the bytes go before it is read.
        segmentFetcher.hasRawBytes.mockImplementationOnce(() => {
            bytesPresent = false;
            return true;
        });

        store.request(0);
        await settle();
        expect(store.get(0)).toBeNull();

        // The bytes come back, and the unit is decodable after all.
        bytesPresent = true;
        store.request(0);
        await settle();

        expect(store.get(0)).not.toBeNull();
    });

    it('caches the emptiness of a unit that carries no audio samples', async () => {
        const { store, mediaSource, audioDecoder } = build();
        mediaSource.fetchAudioChunks = jest.fn(async () => ({ chunks: [] }));

        store.request(0);
        await settle();

        expect(store.get(0)).not.toBeNull();
        expect(store.get(0).buffer).toBeNull();
        expect(audioDecoder.decodeUnit).not.toHaveBeenCalled();
    });

    it('evicts the least recently used unit past its limit', async () => {
        const { store } = build();

        for (const index of [0, 1, 2]) {
            store.request(index);
            await settle();
        }

        // maxUnits is 2, so the oldest is gone and the newest two remain.
        expect(store.get(0)).toBeNull();
        expect(store.get(1)).not.toBeNull();
        expect(store.get(2)).not.toBeNull();
    });

    it('keeps a unit alive by reading it', async () => {
        const { store } = build();

        store.request(0);
        await settle();
        store.request(1);
        await settle();

        // Touching 0 makes 1 the least recently used instead.
        store.get(0);

        store.request(2);
        await settle();

        expect(store.get(0)).not.toBeNull();
        expect(store.get(1)).toBeNull();
    });

    it('drops cached units on clear() but does not resurrect a failed one', async () => {
        const { store, audioDecoder } = build();
        audioDecoder.decodeUnit = jest.fn(async (unitIndex) => {
            if (unitIndex === 0) {
                throw new Error('bad audio');
            }
            return { unitIndex, sampleRate: 48000, numberOfChannels: 2, startTime: 0, duration: 1, buffer: { duration: 1 } };
        });

        // Twice, so unit 0 exhausts its attempts and is given up on for good.
        for (let attempt = 0; attempt < 2; attempt++) {
            store.request(0);
            store.request(1);
            await settle();
        }

        store.clear();
        expect(store.get(1)).toBeNull();

        store.request(0);
        store.request(1);
        await settle();

        // Unit 1 decoded again; unit 0 was not attempted a third time.
        expect(store.get(1)).not.toBeNull();
        expect(audioDecoder.decodeUnit.mock.calls.filter(([index]) => index === 0)).toHaveLength(2);
    });

    it('closes the decoder on close()', () => {
        const { store, audioDecoder } = build();
        store.close();
        expect(audioDecoder.close).toHaveBeenCalled();
    });

    it('ignores a request for a unit index that is not one', () => {
        const { store, segmentFetcher } = build();

        store.request(-1);
        store.request(1.5);
        store.request(undefined);

        expect(segmentFetcher.hasRawBytes).not.toHaveBeenCalled();
    });
});
