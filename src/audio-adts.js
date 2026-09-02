/**
 * Wraps raw AAC frames in ADTS headers, so the browser's own audio decoder can
 * read them.
 *
 * Seven bytes per frame, and that is the whole module. It exists because of what
 * it replaces: this player originally decoded audio with WebCodecs, the way it
 * decodes video, and that does not work. The audio decoder ends up waiting
 * inside the platform's media pipeline behind the video decoder, and the numbers
 * are not close (issue #6 has the detail):
 *
 * | Decoding ~1s of this media's audio | |
 * | --- | --- |
 * | WebCodecs `AudioDecoder`, while GOPs decode | ~4400 ms -- slower than real time |
 * | `decodeAudioData` on ADTS, same conditions | 36-78 ms |
 * | `decodeAudioData` on ADTS, machine idle | 7 ms |
 *
 * Video tolerates a late decode -- the frame freezes and nothing is lost. Audio
 * cannot: a sample that misses its moment is silence for ever. So audio is
 * decoded by the browser, which is what every streaming player does, and ADTS is
 * the cheapest container it will accept.
 *
 * MediaSource was tried first and abandoned: it needs fragmented MP4, and muxing
 * that with mp4box hit a `PIPELINE_ERROR_DECODE` that resisted several fixes.
 * ADTS needs no muxer and no container library at all.
 *
 * @fileoverview ADTS framing of AAC samples for decodeAudioData.
 * @author Isaac Travers
 * @module video-engine/audio-adts
 */

/** Bytes in an ADTS header without CRC. */
const HEADER_BYTES = 7;

/** Sample rates an AudioSpecificConfig's 4-bit frequency index selects from -- the same table ADTS uses. */
const ASC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Reads the three fields an ADTS header needs out of an AudioSpecificConfig.
 *
 * Taken from the config rather than from the track's sample description, for the
 * same reason the decoder configuration is: the sample description is routinely
 * wrong. This project's own 96 kHz reference media reports `sample_rate: 0`
 * there -- which is not a bug in the file, because the `mp4a` box states its
 * rate in 16.16 fixed point and 96000 does not fit in the integer part.
 *
 * @param {Uint8Array} asc - AudioSpecificConfig bytes.
 * @returns {?{objectType: number, frequencyIndex: number, channelConfig: number, sampleRate: (number|null)}} The fields, or null if they cannot be read.
 */
export function readAdtsFields(asc) {
    if (!asc || asc.length < 2) {
        return null;
    }

    const first16 = (asc[0] << 8) | asc[1];
    const objectType = (first16 >> 11) & 0x1f;
    const frequencyIndex = (first16 >> 7) & 0x0f;
    const channelConfig = (first16 >> 3) & 0x0f;

    // ADTS carries the rate as a 4-bit index, so a stream whose config states an
    // explicit rate instead (index 15) cannot be framed this way at all.
    if (frequencyIndex > 12 || objectType < 1 || objectType > 4 || channelConfig < 1) {
        return null;
    }

    return {
        objectType,
        frequencyIndex,
        channelConfig,
        sampleRate: ASC_SAMPLE_RATES[frequencyIndex] || null,
    };
}

/**
 * Frames a run of AAC samples as one ADTS stream.
 *
 * Every AAC frame is independently decodable, so a run can start anywhere and
 * needs nothing from the run before it.
 *
 * @param {Array<{data: Uint8Array}>} chunks - Chunk descriptors from a media source's `fetchAudioChunks()`.
 * @param {{objectType: number, frequencyIndex: number, channelConfig: number}} fields - From {@link readAdtsFields}.
 * @returns {?Uint8Array} The ADTS stream, or null when there is nothing to frame.
 */
export function frameAdts(chunks, fields) {
    if (!chunks || chunks.length === 0 || !fields) {
        return null;
    }

    let total = 0;
    for (const chunk of chunks) {
        total += chunk.data.byteLength + HEADER_BYTES;
    }

    const out = new Uint8Array(total);
    let at = 0;

    for (const chunk of chunks) {
        const frameLength = chunk.data.byteLength + HEADER_BYTES;

        // Syncword 0xFFF, MPEG-4, no CRC.
        out[at++] = 0xff;
        out[at++] = 0xf1;
        // Profile is the object type minus one, then the rate index, then the
        // top bit of the channel configuration.
        out[at++] = ((fields.objectType - 1) << 6) | (fields.frequencyIndex << 2) | ((fields.channelConfig >> 2) & 0x01);
        // Remaining channel bits, then the top two bits of the 13-bit length.
        out[at++] = ((fields.channelConfig & 0x03) << 6) | ((frameLength >> 11) & 0x03);
        out[at++] = (frameLength >> 3) & 0xff;
        // Bottom three length bits, then a full buffer-fullness field.
        out[at++] = ((frameLength & 0x07) << 5) | 0x1f;
        out[at++] = 0xfc;

        out.set(chunk.data, at);
        at += chunk.data.byteLength;
    }

    return out;
}
