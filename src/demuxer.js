/**
 * mp4box.js-based ISO-BMFF/CMAF demuxer.
 *
 * Turns one segment's raw fMP4 bytes into an ordered list of chunk
 * descriptors ready for WebCodecs' EncodedVideoChunk, plus the codec
 * config VideoDecoder.configure() needs.
 *
 * @fileoverview Per-segment mp4box.js demuxing into WebCodecs-ready chunk descriptors.
 * @author Isaac Travers
 * @module video-engine/demuxer
 */

import { createFile, DataStream } from 'mp4box';
import { readAudioTrackConfig } from './mp4-audio-config.js';

/**
 * Extracts the raw avcC/hvcC description bytes VideoDecoder.configure()
 * needs from the demuxed track's sample description box -- the standard
 * mp4box.js + WebCodecs recipe (box.write() into a fresh DataStream, then
 * skip the 8-byte box header to get just the config payload).
 *
 * @param {Object} isoFile - mp4box ISOFile instance, after onReady has fired.
 * @param {number} trackId - Video track id from `info.tracks[i].id`.
 * @returns {Uint8Array|null} Codec description bytes, or null if the track has neither box.
 */
function getDescriptionBytes(isoFile, trackId) {
    const track = isoFile.getTrackById(trackId);

    for (const entry of track.mdia.minf.stbl.stsd.entries) {
        const box = entry.avcC || entry.hvcC;
        if (box) {
            const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
            box.write(stream);
            return new Uint8Array(stream.buffer, 8); // skip size+type box header
        }
    }

    return null;
}

/**
 * Demuxes one segment's bytes into an ordered list of encoded-chunk
 * descriptors, using the shared init segment for track/codec setup.
 *
 * A fresh mp4box ISOFile is created per call rather than one long-lived,
 * stream-order-dependent instance -- required so segments can be demuxed
 * in any order (reverse playback and arbitrary seeks routinely need
 * segment N-1 demuxed after segment N). The init segment's tiny moov gets
 * re-parsed each call; negligible cost next to the decode itself.
 *
 * Which tracks are pulled out is the caller's choice, and neither is free:
 * extraction copies every sample it is asked for. Audio was originally
 * skipped here entirely; it is now extracted only when asked for, so the
 * video path costs exactly what it always did and a caller that wants audio
 * pays for audio alone.
 *
 * @async
 * @param {ArrayBuffer} initSegmentBuffer - Raw bytes of the shared init segment (the `#EXT-X-MAP` target).
 * @param {ArrayBuffer} segmentBuffer - Raw bytes of the media segment to demux.
 * @param {Object} [options]
 * @param {boolean} [options.includeVideo=true] - Extract the video track's samples.
 * @param {boolean} [options.includeAudio=false] - Extract the audio track's samples, if the segment has one.
 * @returns {Promise<{codec: string, description: (Uint8Array|null), chunks: Array<Object>, audio: ?{codec: string, description: (Uint8Array|null), sampleRate: number, numberOfChannels: number, chunks: Array<Object>}}>} Codec string, description bytes, and chunks in decode order. `audio` is null when the segment has no usable audio track, and otherwise carries that track's decoder config always and its chunks only when `includeAudio` asked for them.
 * @throws {Error} When mp4box reports a demux error, finds no video track, or never fires onReady.
 */
export function demuxSegment(initSegmentBuffer, segmentBuffer, { includeVideo = true, includeAudio = false } = {}) {
    return new Promise((resolve, reject) => {
        const isoFile = createFile();
        let videoTrackId = null;
        let audioTrackId = null;
        let codec = null;
        let description = null;
        let audioConfig = null;
        const chunks = [];
        const audioChunks = [];

        isoFile.onError = (error) => {
            reject(new Error(`mp4box demux error: ${error}`));
        };

        isoFile.onReady = (info) => {
            const videoTrack = info.tracks.find((track) => track.type === 'video');

            if (!videoTrack) {
                reject(new Error('No video track found in init segment.'));
                return;
            }

            videoTrackId = videoTrack.id;
            codec = videoTrack.codec;
            description = getDescriptionBytes(isoFile, videoTrackId);

            if (includeVideo) {
                isoFile.setExtractionOptions(videoTrackId, null, { nbSamples: 100000 });
            }

            // The audio track's configuration is read whenever there is one,
            // whether or not its samples were asked for -- it comes from the
            // init segment's moov, which is parsed either way, and a caller
            // needs it to answer "does this stream have audio at all" without
            // paying for a sample extraction to find out.
            //
            // A segment with no audio track, or one that cannot be
            // configured, is an ordinary outcome rather than a failure: the
            // caller gets `audio: null` and plays the picture.
            const audioTrack = info.tracks.find((track) => track.type === 'audio');
            audioConfig = readAudioTrackConfig(isoFile, audioTrack);

            if (audioConfig && includeAudio) {
                audioTrackId = audioTrack.id;
                isoFile.setExtractionOptions(audioTrackId, null, { nbSamples: 100000 });
            }

            isoFile.start();
        };

        isoFile.onSamples = (trackId, user, samples) => {
            const target = trackId === videoTrackId ? chunks : trackId === audioTrackId ? audioChunks : null;

            if (!target) {
                return;
            }

            for (const sample of samples) {
                const timescale = sample.timescale;
                target.push({
                    type: sample.is_sync ? 'key' : 'delta',
                    timestamp: Math.round((sample.cts / timescale) * 1e6),
                    duration: Math.round((sample.duration / timescale) * 1e6),
                    data: sample.data,
                });
            }
        };

        // Copy each buffer before tagging it with mp4box's required
        // `fileStart` bookkeeping property, so the caller's cached raw
        // segment bytes (which may be re-demuxed later) are never mutated.
        const init = initSegmentBuffer.slice(0);
        init.fileStart = 0;
        isoFile.appendBuffer(init);

        const media = segmentBuffer.slice(0);
        media.fileStart = init.byteLength;
        isoFile.appendBuffer(media);

        isoFile.flush();

        if (!videoTrackId) {
            reject(new Error('mp4box never reported track info (onReady did not fire) -- is this a valid init segment?'));
            return;
        }

        // Deliberately NOT sorted by timestamp here -- mp4box.js's sample
        // extraction order is already decode order (matches physical
        // storage order in the file), which is what decoder.decode() must
        // receive. Sorting by presentation timestamp here would reorder
        // B-frames ahead of the frames they depend on, corrupting decode.
        // (Decoded VideoFrames get sorted by presentation time separately,
        // after decode, in gop-decoder.js.)
        resolve({
            codec,
            description,
            chunks,
            // Every AAC sample is a sync sample, so audio has no decode-order
            // constraint of its own and can be handed over in presentation
            // order -- which is the order the audio decoder assembles by.
            audio: audioConfig ? { ...audioConfig, chunks: audioChunks } : null,
        });
    });
}
