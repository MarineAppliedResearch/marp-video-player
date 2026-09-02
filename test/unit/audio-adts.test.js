/**
 * Unit tests for ADTS framing.
 *
 * Bit-packing, so every assertion is on exact bytes. Worth pinning precisely
 * because a wrong bit here does not produce an error — it produces a stream the
 * browser refuses to decode, reported as a generic `PIPELINE_ERROR_DECODE` that
 * says nothing about which field was wrong. That is exactly how much time the
 * earlier fMP4 attempt cost.
 *
 * @fileoverview Unit tests for audio-adts.js.
 * @author Isaac Travers
 * @module video-engine/test/unit/audio-adts.test
 */

const { readAdtsFields, frameAdts } = require('../../src/audio-adts.js');

/** The reference media's real AudioSpecificConfig: AAC-LC, 96 kHz, stereo. */
const ASC_96K = new Uint8Array([0x10, 0x10, 0x56, 0xe5, 0x00]);

/** The E2E fixture's real config: AAC-LC, 48 kHz, stereo. */
const ASC_48K = new Uint8Array([0x11, 0x90, 0x56, 0xe5, 0x00]);

describe('readAdtsFields', () => {

    it('reads the reference media\'s 96kHz config', () => {
        expect(readAdtsFields(ASC_96K)).toEqual({
            objectType: 2,
            frequencyIndex: 0,
            channelConfig: 2,
            sampleRate: 96000,
        });
    });

    it('reads the E2E fixture\'s 48kHz config', () => {
        expect(readAdtsFields(ASC_48K)).toEqual({
            objectType: 2,
            frequencyIndex: 3,
            channelConfig: 2,
            sampleRate: 48000,
        });
    });

    /**
     * ADTS states the rate as a 4-bit index, so a stream whose config gives an
     * explicit 24-bit rate instead cannot be expressed at all. Refusing is the
     * right answer: framing it anyway would declare the wrong rate.
     */
    it('refuses a config whose rate is explicit rather than indexed', () => {
        // Object type 2, frequency index 15, then an explicit rate.
        expect(readAdtsFields(new Uint8Array([0x17, 0x80, 0x61, 0xa8, 0x10]))).toBeNull();
    });

    it('refuses a channel configuration ADTS cannot state', () => {
        // Channel configuration 0 means "described in the bitstream".
        expect(readAdtsFields(new Uint8Array([0x11, 0x80]))).toBeNull();
    });

    it('returns null for bytes it cannot read rather than guessing', () => {
        expect(readAdtsFields(null)).toBeNull();
        expect(readAdtsFields(new Uint8Array([]))).toBeNull();
        expect(readAdtsFields(new Uint8Array([0x11]))).toBeNull();
    });
});

describe('frameAdts', () => {

    /** One chunk of `size` bytes, each byte distinguishable from the header. */
    const chunk = (size, fill = 0xaa) => ({ data: new Uint8Array(size).fill(fill) });

    it('prefixes each frame with a seven-byte header', () => {
        const framed = frameAdts([chunk(100), chunk(200)], readAdtsFields(ASC_96K));
        expect(framed).toHaveLength(100 + 200 + 14);
    });

    it('writes the syncword and an MPEG-4, no-CRC header', () => {
        const framed = frameAdts([chunk(10)], readAdtsFields(ASC_96K));

        expect(framed[0]).toBe(0xff);
        // 0xF1: syncword's low nibble, MPEG-4, layer 0, no CRC.
        expect(framed[1]).toBe(0xf1);
    });

    /**
     * The profile field is the object type MINUS ONE -- AAC-LC is object type 2
     * and profile 1. Writing the object type directly declares AAC-SSR and the
     * stream will not decode.
     */
    it('writes the profile as the object type minus one', () => {
        const framed = frameAdts([chunk(10)], readAdtsFields(ASC_96K));
        expect((framed[2] >> 6) & 0x03).toBe(1);
    });

    it('writes the frequency index and channel configuration', () => {
        const at96k = frameAdts([chunk(10)], readAdtsFields(ASC_96K));
        expect((at96k[2] >> 2) & 0x0f).toBe(0);

        const at48k = frameAdts([chunk(10)], readAdtsFields(ASC_48K));
        expect((at48k[2] >> 2) & 0x0f).toBe(3);

        // Channel configuration straddles the byte boundary: one bit at the
        // bottom of byte 2 and two at the top of byte 3.
        const channelConfig = (((at48k[2] & 0x01) << 2) | ((at48k[3] >> 6) & 0x03));
        expect(channelConfig).toBe(2);
    });

    /**
     * The length field spans 13 bits across three bytes and counts the header
     * itself. Getting either wrong desynchronises every frame after the first.
     */
    it('writes a 13-bit frame length that includes the header', () => {
        const framed = frameAdts([chunk(250)], readAdtsFields(ASC_96K));

        const length = ((framed[3] & 0x03) << 11) | (framed[4] << 3) | ((framed[5] >> 5) & 0x07);
        expect(length).toBe(250 + 7);
    });

    it('writes a length that survives a frame larger than 255 bytes', () => {
        const framed = frameAdts([chunk(2000)], readAdtsFields(ASC_96K));

        const length = ((framed[3] & 0x03) << 11) | (framed[4] << 3) | ((framed[5] >> 5) & 0x07);
        expect(length).toBe(2007);
    });

    it('copies the sample data in after each header', () => {
        const framed = frameAdts([chunk(4, 0x11), chunk(4, 0x22)], readAdtsFields(ASC_96K));

        expect(Array.from(framed.slice(7, 11))).toEqual([0x11, 0x11, 0x11, 0x11]);
        expect(Array.from(framed.slice(18, 22))).toEqual([0x22, 0x22, 0x22, 0x22]);
    });

    /**
     * Every frame carries a full header, so a run can begin at any frame. That
     * is what makes a unit decodable without anything from the unit before it.
     */
    it('makes every frame independently framed', () => {
        const framed = frameAdts([chunk(9), chunk(9), chunk(9)], readAdtsFields(ASC_96K));

        for (const at of [0, 16, 32]) {
            expect(framed[at]).toBe(0xff);
            expect(framed[at + 1]).toBe(0xf1);
        }
    });

    it('returns null when there is nothing to frame', () => {
        expect(frameAdts([], readAdtsFields(ASC_96K))).toBeNull();
        expect(frameAdts(null, readAdtsFields(ASC_96K))).toBeNull();
        expect(frameAdts([chunk(10)], null)).toBeNull();
    });
});
