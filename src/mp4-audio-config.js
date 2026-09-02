/**
 * Reads an MP4 audio track's decoder configuration.
 *
 * Shared because both paths need exactly this and neither should own it: the
 * byte-range sources parse one `moov` at load and index its sample table,
 * while the transcode path demuxes an init segment per unit. Different bytes,
 * the same question -- what does AudioDecoder.configure() need for this track.
 *
 * @fileoverview AudioSpecificConfig extraction and parsing for MP4 audio tracks.
 * @author Isaac Travers
 * @module video-engine/mp4-audio-config
 */

/**
 * Sample rates an AudioSpecificConfig's 4-bit frequency index selects from.
 *
 * Index 15 means the rate follows explicitly as 24 bits instead, which is why
 * this table has 13 entries and not 16.
 *
 * @constant
 * @type {Array<number>}
 */
const ASC_SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/**
 * Finds the DecoderSpecificInfo payload inside an esds descriptor tree.
 *
 * Searched rather than indexed: descriptor order is not fixed, and an SL
 * descriptor sitting ahead of the decoder config is legal.
 *
 * @param {Array<Object>|undefined} descs - Descriptors to search, recursively.
 * @returns {Uint8Array|null} The payload bytes, or null if there are none.
 */
function findDescriptorData(descs) {
    if (!descs) {
        return null;
    }

    for (const desc of descs) {
        if (desc && desc.data && desc.data.length > 0) {
            return desc.data instanceof Uint8Array ? desc.data : new Uint8Array(desc.data);
        }
        const nested = findDescriptorData(desc && desc.descs);
        if (nested) {
            return nested;
        }
    }

    return null;
}

/**
 * Extracts the AudioSpecificConfig bytes AudioDecoder.configure() needs from
 * a track's sample description.
 *
 * Walks into the esds box for the DecoderSpecificInfo payload rather than
 * writing the whole box out: the decoder wants the bare config bytes, not the
 * descriptor tree wrapped around them. (This is the one place where audio
 * differs from video, where the avcC/hvcC box payload is what is wanted --
 * see `getDescriptionBytes` in demuxer.js.)
 *
 * @param {Object} isoFile - mp4box ISOFile, after onReady.
 * @param {number} trackId - Audio track id.
 * @returns {Uint8Array|null} Config bytes, or null if absent.
 */
export function audioDescriptionBytes(isoFile, trackId) {
    const trak = isoFile.getTrackById(trackId);

    if (!trak || !trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl) {
        return null;
    }

    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        if (!entry.esds || !entry.esds.esd) {
            continue;
        }

        const found = findDescriptorData(entry.esds.esd.descs);
        if (found) {
            return found;
        }
    }

    return null;
}

/**
 * Reads the sample rate and channel count out of an AudioSpecificConfig.
 *
 * Preferred over the values in the sample description box, because those are
 * routinely wrong or absent -- mp4box reports `sample_rate: 0` for the 96kHz
 * AAC track in this project's own test media, while the config bytes carry
 * 96000 correctly and the decoder agrees with them.
 *
 * Reads only the first two fields, which is all that is needed and all that
 * sits at a fixed position: object type (5 bits), frequency index (4), then
 * channel configuration (4). A frequency index of 15 means an explicit 24-bit
 * rate follows instead of a table lookup.
 *
 * @param {Uint8Array|null} bytes - AudioSpecificConfig bytes.
 * @returns {{sampleRate: (number|null), numberOfChannels: (number|null)}} What could be read, with nulls for what could not.
 */
export function parseAudioSpecificConfig(bytes) {
    if (!bytes || bytes.length < 2) {
        return { sampleRate: null, numberOfChannels: null };
    }

    const first16 = (bytes[0] << 8) | bytes[1];
    const frequencyIndex = (first16 >> 7) & 0x0f;

    let sampleRate;
    let channelBits;

    if (frequencyIndex === 0x0f) {
        if (bytes.length < 5) {
            return { sampleRate: null, numberOfChannels: null };
        }
        // 5 bits of object type + 4 of index, so the explicit rate starts at
        // bit 9 and runs for 24.
        sampleRate = ((bytes[1] & 0x7f) << 17) | (bytes[2] << 9) | (bytes[3] << 1) | ((bytes[4] >> 7) & 0x01);
        channelBits = (bytes[4] >> 3) & 0x0f;
    } else {
        sampleRate = ASC_SAMPLE_RATES[frequencyIndex] || null;
        channelBits = (first16 >> 3) & 0x0f;
    }

    // Channel configuration 0 means the layout is described in the bitstream
    // itself rather than here; 7 means 7.1, which is eight channels.
    const numberOfChannels = channelBits === 0 ? null : channelBits === 7 ? 8 : channelBits;

    return { sampleRate, numberOfChannels };
}

/**
 * Builds an AudioDecoder configuration for one track of a parsed MP4.
 *
 * Returns null rather than throwing for every reason a track might be
 * unusable. Audio is an addition to this player and never a precondition for
 * it: media whose audio cannot be configured must still play its picture, so
 * "no usable audio" has to be an ordinary answer rather than a failure.
 *
 * @param {Object} isoFile - mp4box ISOFile, after onReady.
 * @param {Object} track - The audio track entry from the parsed movie info.
 * @returns {?{codec: string, description: (Uint8Array|null), sampleRate: number, numberOfChannels: number, language: (string|undefined)}} Decoder configuration, or null.
 */
export function readAudioTrackConfig(isoFile, track) {
    if (!track) {
        return null;
    }

    const description = audioDescriptionBytes(isoFile, track.id);
    const descriptionBox = audioDescriptionBox(isoFile, track.id);
    const fromAsc = parseAudioSpecificConfig(description);

    // AAC in MP4 cannot be configured without its AudioSpecificConfig. Codecs
    // that carry everything in the codec string (MP3) can.
    if (/^mp4a\.40/.test(track.codec) && !description) {
        return null;
    }

    const sampleRate = fromAsc.sampleRate || (track.audio && track.audio.sample_rate) || track.timescale;
    const numberOfChannels = fromAsc.numberOfChannels || (track.audio && track.audio.channel_count) || 2;

    if (!sampleRate || !numberOfChannels) {
        return null;
    }

    return {
        codec: track.codec,
        description,
        // The parsed box, not just its payload. Muxing audio back out for
        // MediaSource reuses this verbatim as the new track's description
        // box, which is what makes the muxed codec string agree with the
        // media's own -- see audio-mux.js.
        descriptionBox,
        sampleRate,
        numberOfChannels,
        language: track.language,
    };
}

/**
 * The audio track's whole sample-description box, for handing back to a muxer.
 *
 * @param {Object} isoFile - mp4box ISOFile, after onReady.
 * @param {number} trackId - Audio track id.
 * @returns {?Object} The parsed `esds` box, or null if absent.
 */
export function audioDescriptionBox(isoFile, trackId) {
    const trak = isoFile.getTrackById(trackId);

    if (!trak || !trak.mdia || !trak.mdia.minf || !trak.mdia.minf.stbl) {
        return null;
    }

    for (const entry of trak.mdia.minf.stbl.stsd.entries) {
        if (entry.esds) {
            return entry.esds;
        }
    }

    return null;
}
