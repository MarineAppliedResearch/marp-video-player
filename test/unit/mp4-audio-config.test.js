/**
 * Unit tests for MP4 audio decoder-configuration reading.
 *
 * The values asserted here are real: the AudioSpecificConfig bytes come from
 * this project's own media, read out of their `moov` boxes and confirmed
 * against what a real Chromium AudioDecoder reported when handed frames from
 * the same files. That matters because the obvious source for these numbers
 * -- the sample description box -- is wrong: mp4box reports `sample_rate: 0`
 * for the 96kHz track, and believing it would configure the decoder at the
 * media timescale by luck rather than by reading.
 *
 * @fileoverview Unit tests for mp4-audio-config.js.
 * @author Isaac Travers
 * @module video-engine/test/unit/mp4-audio-config.test
 */

const { parseAudioSpecificConfig, audioDescriptionBytes, readAudioTrackConfig } = require('../../src/mp4-audio-config.js');

/**
 * A stand-in for an mp4box ISOFile carrying one audio track whose esds holds
 * the given config bytes.
 *
 * @param {Array<number>|null} configBytes - AudioSpecificConfig payload, or null for a track with no esds.
 * @returns {Object} An object with getTrackById, as the module calls.
 */
function makeIsoFile(configBytes) {
    const entry = configBytes
        ? { esds: { esd: { descs: [{ descs: [{ data: new Uint8Array(configBytes) }] }] } } }
        : { type: 'mp4a' };

    return {
        getTrackById: () => ({ mdia: { minf: { stbl: { stsd: { entries: [entry] } } } } }),
    };
}

describe('parseAudioSpecificConfig', () => {

    /**
     * From CaliforniaMPA_And_MARE.mp4. A 96kHz AAC track is unusual enough
     * that it is worth pinning: it is the case that would be silently wrong
     * if the frequency index were ignored in favour of a default.
     */
    it('reads 96kHz stereo from the test media\'s own config bytes', () => {
        expect(parseAudioSpecificConfig(new Uint8Array([0x10, 0x10, 0x56, 0xe5, 0x00]))).toEqual({
            sampleRate: 96000,
            numberOfChannels: 2,
        });
    });

    /** From .test-media/short-1080p25.mp4, the E2E fixture. */
    it('reads 48kHz stereo from the E2E fixture\'s config bytes', () => {
        expect(parseAudioSpecificConfig(new Uint8Array([0x11, 0x90, 0x56, 0xe5, 0x00]))).toEqual({
            sampleRate: 48000,
            numberOfChannels: 2,
        });
    });

    it('reads the other rates in the frequency table', () => {
        // AAC-LC (object type 2) at 44.1kHz (index 4), stereo.
        expect(parseAudioSpecificConfig(new Uint8Array([0x12, 0x10])).sampleRate).toBe(44100);
        // 8kHz (index 11), mono.
        expect(parseAudioSpecificConfig(new Uint8Array([0x15, 0x88]))).toEqual({
            sampleRate: 8000,
            numberOfChannels: 1,
        });
    });

    /**
     * Frequency index 15 means the rate is written out in full instead of
     * chosen from the table -- the branch that exists for rates the table has
     * no entry for.
     */
    it('reads an explicit sample rate when the index says one follows', () => {
        // Object type 2, index 15, then 24 bits of 50000, then 2 channels.
        const bytes = new Uint8Array([0x17, 0x80, 0x61, 0xa8, 0x10]);
        expect(parseAudioSpecificConfig(bytes).sampleRate).toBe(50000);
    });

    it('reports an unreadable channel configuration as unknown rather than guessing', () => {
        // Channel configuration 0 means the layout is in the bitstream.
        expect(parseAudioSpecificConfig(new Uint8Array([0x11, 0x80])).numberOfChannels).toBeNull();
    });

    it('reads 7.1 as eight channels', () => {
        // Channel configuration 7 is 7.1, which is eight channels, not seven.
        expect(parseAudioSpecificConfig(new Uint8Array([0x11, 0xb8])).numberOfChannels).toBe(8);
    });

    it('returns nulls for bytes it cannot read rather than throwing', () => {
        expect(parseAudioSpecificConfig(null)).toEqual({ sampleRate: null, numberOfChannels: null });
        expect(parseAudioSpecificConfig(new Uint8Array([]))).toEqual({ sampleRate: null, numberOfChannels: null });
        expect(parseAudioSpecificConfig(new Uint8Array([0x11]))).toEqual({ sampleRate: null, numberOfChannels: null });
        // Index 15 promises 24 more bits that are not there.
        expect(parseAudioSpecificConfig(new Uint8Array([0x17, 0x80]))).toEqual({ sampleRate: null, numberOfChannels: null });
    });
});

describe('audioDescriptionBytes', () => {

    it('finds the decoder config inside the esds descriptor tree', () => {
        const bytes = audioDescriptionBytes(makeIsoFile([0x11, 0x90, 0x56, 0xe5, 0x00]), 2);
        expect(Array.from(bytes)).toEqual([0x11, 0x90, 0x56, 0xe5, 0x00]);
    });

    it('returns null for a track with no esds', () => {
        expect(audioDescriptionBytes(makeIsoFile(null), 2)).toBeNull();
    });

    it('returns null rather than throwing for a track it cannot walk', () => {
        expect(audioDescriptionBytes({ getTrackById: () => null }, 2)).toBeNull();
        expect(audioDescriptionBytes({ getTrackById: () => ({}) }, 2)).toBeNull();
    });
});

describe('readAudioTrackConfig', () => {

    it('builds a decoder config from the track and its own config bytes', () => {
        const config = readAudioTrackConfig(makeIsoFile([0x10, 0x10, 0x56, 0xe5, 0x00]), {
            id: 2,
            codec: 'mp4a.40.2',
            timescale: 96000,
            language: 'eng',
            audio: { sample_rate: 0, channel_count: 2 },
        });

        expect(config).toMatchObject({
            codec: 'mp4a.40.2',
            sampleRate: 96000,
            numberOfChannels: 2,
            language: 'eng',
        });
        expect(config.description).toBeInstanceOf(Uint8Array);
    });

    /**
     * The reason the config bytes are preferred over the sample description
     * box at all: mp4box really does report a sample rate of zero for this
     * track, and a decoder configured at 0 Hz is not a decoder.
     */
    it('prefers the config bytes over a sample description that says zero', () => {
        const config = readAudioTrackConfig(makeIsoFile([0x11, 0x90, 0x56, 0xe5, 0x00]), {
            id: 2,
            codec: 'mp4a.40.2',
            timescale: 12345,
            audio: { sample_rate: 0, channel_count: 0 },
        });

        expect(config.sampleRate).toBe(48000);
        expect(config.numberOfChannels).toBe(2);
    });

    it('falls back to the sample description when there are no config bytes to read', () => {
        const config = readAudioTrackConfig(makeIsoFile(null), {
            id: 2,
            codec: 'mp3',
            timescale: 44100,
            audio: { sample_rate: 44100, channel_count: 2 },
        });

        expect(config).toMatchObject({ codec: 'mp3', sampleRate: 44100, numberOfChannels: 2 });
    });

    /**
     * AAC in MP4 cannot be configured without its AudioSpecificConfig. Null is
     * the right answer, not a guess: the engine treats it as "no audio" and
     * plays the picture, where a wrong config would be noise.
     */
    it('refuses an AAC track with no decoder config', () => {
        expect(
            readAudioTrackConfig(makeIsoFile(null), {
                id: 2,
                codec: 'mp4a.40.2',
                timescale: 48000,
                audio: { sample_rate: 48000, channel_count: 2 },
            })
        ).toBeNull();
    });

    it('returns null when there is no audio track at all', () => {
        expect(readAudioTrackConfig(makeIsoFile(null), undefined)).toBeNull();
    });
});
