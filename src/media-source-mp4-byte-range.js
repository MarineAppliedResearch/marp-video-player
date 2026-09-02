/**
 * Shared base for sources that read one MP4 by byte range.
 *
 * Everything about playing a whole MP4 lives here -- reading the index
 * prefix, grouping the sample table into GOP units, and assembling chunks
 * by slicing already-fetched bytes. Subclasses supply only a URL, because
 * that is genuinely all that differs: Jellyfin Direct Play points at
 * `/Videos/{id}/stream?static=true`, a local file at its own object URL,
 * and Chromium honours Range requests against both (verified: a blob URL
 * returns 206 with a correct Content-Range).
 *
 * Units are GOPs from the file's own sample table rather than fixed-length
 * HLS segments, so their timing is authoritative rather than derived from
 * playlist durations. Since the sample table carries every sample's offset,
 * size and timestamp, chunk assembly needs no per-unit container parsing at
 * all -- unlike the transcode path, which demuxes init+media for every
 * segment.
 *
 * @fileoverview Shared byte-range MP4 media source.
 * @module video-engine/media-source-mp4-byte-range
 */

import { createFile, DataStream } from 'mp4box';
import { SegmentFetcher } from './segment-fetcher.js';
import { readAudioTrackConfig } from './mp4-audio-config.js';

/** ftyp+moov measured at ~1.03MB on the reference 1080p item; a little headroom over that. */
const DEFAULT_INDEX_PREFIX_BYTES = 1_100_000;

/**
 * Supplies the unit index and decoder chunks for one byte-range MP4.
 *
 * @class Mp4ByteRangeMediaSource
 */
export class Mp4ByteRangeMediaSource {
    /**
     * @param {Object} params
     * @param {Object} [params.fetchOptions] - Extra fetch() options applied to every request this source makes.
     * @param {number} [params.rawSegmentCacheBudgetBytes] - Raw-bytes cache budget, in bytes.
     * @param {number} [params.indexPrefixBytes] - How much of the file's head to read looking for `moov`.
     * @param {function(string): void} [params.onDebug] - Progress messages.
     * @param {function(Error): void} [params.onError] - Called once per real fetch failure.
     */
    constructor({ fetchOptions, rawSegmentCacheBudgetBytes, indexPrefixBytes, onDebug, onError } = {}) {
        this.fetchOptions = fetchOptions;
        this.rawSegmentCacheBudgetBytes = rawSegmentCacheBudgetBytes;
        this.indexPrefixBytes = indexPrefixBytes || DEFAULT_INDEX_PREFIX_BYTES;
        this.onDebug = onDebug;
        this.onError = onError;

        // All built by load(), which must run before anything else.
        this.segmentFetcher = null;
        this._segmentIndex = null;
        this._samples = null;
        this._config = null;
        this._track = null;

        // Audio, when the file has a track this engine can decode. Null
        // throughout otherwise, which is what hasAudio() reports on.
        this._audioSamples = null;
        this._audioConfig = null;
    }

    /**
     * The URL this source reads byte ranges from. Subclasses must override.
     *
     * @returns {string} A URL that honours HTTP Range requests.
     */
    get streamUrl() {
        throw new Error('streamUrl is not implemented for this media source.');
    }

    /**
     * Reads the file's index prefix, builds the GOP unit list from its
     * sample table, and prepares Tier 1 over the same byte ranges.
     *
     * @async
     * @returns {Promise<void>}
     * @throws {Error} When the file has no `moov` in its prefix (non-faststart) or carries no video track.
     */
    async load() {
        const moov = await this._locateMoov();

        // ftyp and moov are fed as one contiguous buffer even when the real
        // file has mdat between them. mp4box only needs the boxes in order
        // to parse; sample offsets come from the sample table and are
        // absolute file positions, which is what byte-range reads use, so
        // closing the gap here changes nothing downstream.
        const header = await this._fetchRange(0, moov.headerEnd);
        const moovBytes = await this._fetchRange(moov.offset, moov.offset + moov.size - 1);
        const combined = new Uint8Array(header.byteLength + moovBytes.byteLength);
        combined.set(new Uint8Array(header), 0);
        combined.set(new Uint8Array(moovBytes), header.byteLength);

        const iso = createFile();
        let info = null;
        iso.onReady = (parsed) => {
            info = parsed;
        };
        const buffer = combined.buffer;
        buffer.fileStart = 0;
        iso.appendBuffer(buffer);
        iso.flush();

        if (!info) {
            throw new Error(`Found a moov box at offset ${moov.offset} (${moov.size} bytes) but could not parse it.`);
        }

        const track = info.tracks.find((candidate) => candidate.type === 'video');
        if (!track) {
            throw new Error('This file has no video track.');
        }

        this._track = track;
        this._samples = iso.getTrackSamplesInfo(track.id);
        if (!this._samples.length) {
            throw new Error('This file has an empty sample table.');
        }
        this._config = { codec: track.codec, description: this._descriptionBytes(iso, track.id) };

        // Read before the unit index is built: units widen their byte ranges
        // to cover the audio that belongs to them, so the sample table has to
        // be in hand first.
        this._readAudioTrack(iso, info);

        this._segmentIndex = this._buildUnitIndex();

        this.segmentFetcher = new SegmentFetcher(this._segmentIndex, {
            maxRawCacheBytes: this.rawSegmentCacheBudgetBytes,
            onDebug: this.onDebug,
            onError: this.onError,
        });

        this._logDebug(
            `indexed ${this._samples.length} samples into ${this._segmentIndex.segments.length} GOPs ` +
                `(${track.video.width}x${track.video.height}, ${(track.duration / track.timescale).toFixed(1)}s)`,
        );

        if (this._audioConfig) {
            this._logDebug(
                `audio: ${this._audioConfig.codec} ${this._audioConfig.sampleRate}Hz ` +
                    `${this._audioConfig.numberOfChannels}ch, ${this._audioSamples.length} samples`,
            );
        }
    }

    /**
     * Reads the audio track's sample table and decoder configuration, if the
     * file has a track this engine can decode.
     *
     * Every failure here is silent and total: `this._audioConfig` stays null,
     * `hasAudio()` reports false, and the engine builds no audio path. Audio
     * is an addition to this player, never a precondition for it -- a file
     * whose audio cannot be read must still play its picture.
     *
     * @param {Object} iso - mp4box ISOFile, after onReady.
     * @param {Object} info - The parsed movie info.
     * @returns {void}
     */
    _readAudioTrack(iso, info) {
        const track = info.tracks.find((candidate) => candidate.type === 'audio');
        if (!track) {
            return;
        }

        const samples = iso.getTrackSamplesInfo(track.id);
        if (!samples || samples.length === 0) {
            this._logDebug(`audio track ${track.id} has an empty sample table; playing without audio`);
            return;
        }

        const config = readAudioTrackConfig(iso, track);
        if (!config) {
            this._logDebug(`audio track ${track.id} (${track.codec}) cannot be configured; playing without audio`);
            return;
        }

        this._audioSamples = samples;
        this._audioConfig = config;
    }

    /**
     * Finds the moov box by walking top-level box headers.
     *
     * Reads 16 bytes per box rather than assuming moov sits inside a fixed
     * prefix. That assumption broke two real cases: a large file whose
     * sample table alone exceeds the prefix (a 1.5GB dive file reported
     * "not faststart" when its moov was simply bigger), and files with moov
     * genuinely at the end, which are ~1% of the archive. Walking costs one
     * small request per top-level box -- typically three or four.
     *
     * @async
     * @returns {Promise<{offset: number, size: number, headerEnd: number}>} Where moov is, plus the end of the boxes preceding it.
     * @throws {Error} When no moov box is found.
     */
    async _locateMoov() {
        let offset = 0;
        let headerEnd = 0;
        // Bounded so a non-MP4 or a pathological file cannot loop forever.
        for (let box = 0; box < 64; box++) {
            const header = await this._fetchRange(offset, offset + 15);
            if (header.byteLength < 8) {
                break;
            }
            const view = new DataView(header);
            let size = view.getUint32(0);
            const type = String.fromCharCode(view.getUint8(4), view.getUint8(5), view.getUint8(6), view.getUint8(7));
            let headerSize = 8;
            if (size === 1) {
                // 64-bit size, carried in the eight bytes after the type.
                size = Number(view.getBigUint64(8));
                headerSize = 16;
            } else if (size === 0) {
                // Extends to end of file; only meaningful for the last box.
                size = (await this._fetchTotalSize()) - offset;
            }
            if (size < headerSize) {
                break;
            }
            if (type === 'moov') {
                return { offset, size, headerEnd: Math.max(0, headerEnd - 1) };
            }
            // Everything before moov (ftyp, and free/mdat when moov is at
            // the end) is fed to mp4box only as far as the first box, so
            // keep the running end of what precedes it.
            if (box === 0) {
                headerEnd = size;
            }
            offset += size;
        }
        throw new Error('No moov box found in this file -- is it a valid MP4?');
    }

    /**
     * Total length of the resource, from a Range response's Content-Range.
     *
     * @async
     * @returns {Promise<number>} Size in bytes.
     */
    async _fetchTotalSize() {
        const options = { ...(this.fetchOptions || {}) };
        options.headers = { ...(options.headers || {}), Range: 'bytes=0-0' };
        const response = await fetch(this.streamUrl, options);
        const contentRange = response.headers.get('Content-Range') || '';
        const total = parseInt(contentRange.split('/')[1], 10);
        if (!Number.isFinite(total)) {
            throw new Error('Could not determine the file size from Content-Range.');
        }
        return total;
    }

    /**
     * Groups the sample table into GOPs at sync samples, with the byte
     * range each occupies.
     *
     * Byte bounds come from the samples' own extents rather than assuming
     * they are contiguous, since storage order need not match presentation
     * order.
     *
     * @returns {{segments: Array<Object>, totalDuration: number}} Unit index in SegmentFetcher's shape.
     */
    _buildUnitIndex() {
        const url = this.streamUrl;
        const segments = [];
        let current = null;

        const finish = (unit, endSampleIndex) => {
            const span = this._samples.slice(unit.firstSample, endSampleIndex + 1);
            const timescale = span[0].timescale;
            let byteStart = Infinity;
            let byteEnd = -Infinity;
            // Presentation extent, taken across the whole span rather than
            // from its first and last samples. Samples are in DECODE order,
            // and with B-frames that is not presentation order: the last
            // decoded sample is not the latest-presented one. Reading the
            // ends directly left every unit a frame short, so consecutive
            // units did not touch -- and a seek landing in one of those gaps
            // found no unit covering it and fell through to the end of the
            // file.
            let firstCts = Infinity;
            let lastEndCts = -Infinity;
            for (const sample of span) {
                if (sample.offset < byteStart) byteStart = sample.offset;
                if (sample.offset + sample.size > byteEnd) byteEnd = sample.offset + sample.size;
                if (sample.cts < firstCts) firstCts = sample.cts;
                if (sample.cts + sample.duration > lastEndCts) lastEndCts = sample.cts + sample.duration;
            }
            segments.push({
                index: unit.index,
                url,
                firstSample: unit.firstSample,
                lastSample: endSampleIndex,
                startTime: firstCts / timescale,
                endTime: lastEndCts / timescale,
                duration: (lastEndCts - firstCts) / timescale,
                // Exclusive end: buildRangeHeaderOptions converts to HTTP's
                // inclusive form itself.
                byteRangeStart: byteStart,
                byteRangeEnd: byteEnd,
            });
        };

        for (let i = 0; i < this._samples.length; i++) {
            if (this._samples[i].is_sync || current === null) {
                if (current !== null) {
                    finish(current, i - 1);
                }
                current = { index: segments.length, firstSample: i };
            }
        }
        if (current !== null) {
            finish(current, this._samples.length - 1);
        }

        this._attachAudioToUnits(segments);

        return { segments, totalDuration: this._track.duration / this._track.timescale };
    }

    /**
     * Records which audio samples belong to each unit, and widens the unit's
     * byte range to cover them.
     *
     * This is what makes audio cost almost nothing on this path. Audio and
     * video are interleaved sample by sample, so gathering ten seconds of
     * audio by byte range on its own would take hundreds of separate requests
     * spanning tens of megabytes to collect a couple of hundred kilobytes.
     * But a unit's video byte range already *spans* the region its audio sits
     * in -- measured at 95-98% of it already inside -- so widening the range
     * to cover the rest buys the audio for about 5% more bytes and no extra
     * requests at all. It is then sliced out of exactly the same cached bytes
     * the picture was decoded from.
     *
     * Widening at both ends rather than only the tail: audio lagging the
     * video in the interleave is what was measured, not what is guaranteed.
     *
     * Walks both tables with a single forward pointer rather than filtering
     * the audio table per unit, which on an hour of footage would be hundreds
     * of units against hundreds of thousands of samples.
     *
     * @param {Array<Object>} segments - Units built from the video sample table, modified in place.
     * @returns {void}
     */
    _attachAudioToUnits(segments) {
        if (!this._audioSamples) {
            return;
        }

        const samples = this._audioSamples;
        let cursor = 0;

        for (const unit of segments) {
            // Past everything that ends before this unit begins. Never
            // rewinds, because unit start times only increase.
            while (
                cursor < samples.length &&
                (samples[cursor].cts + samples[cursor].duration) / samples[cursor].timescale <= unit.startTime
            ) {
                cursor += 1;
            }

            let last = cursor;
            let byteStart = Infinity;
            let byteEnd = -Infinity;

            while (last < samples.length && samples[last].cts / samples[last].timescale < unit.endTime) {
                byteStart = Math.min(byteStart, samples[last].offset);
                byteEnd = Math.max(byteEnd, samples[last].offset + samples[last].size);
                last += 1;
            }

            if (last === cursor) {
                continue;
            }

            unit.firstAudioSample = cursor;
            unit.lastAudioSample = last - 1;
            unit.byteRangeStart = Math.min(unit.byteRangeStart, byteStart);
            unit.byteRangeEnd = Math.max(unit.byteRangeEnd, byteEnd);
        }
    }

    /** @returns {boolean} True when this file has an audio track this engine can decode. */
    hasAudio() {
        return this._audioConfig !== null;
    }

    /**
     * @returns {?{codec: string, description: (Uint8Array|null), sampleRate: number, numberOfChannels: number, language: (string|undefined)}} Decoder configuration, or null when there is no usable audio.
     */
    getAudioConfig() {
        return this._audioConfig;
    }

    /**
     * Assembles one unit's audio chunks from its already-fetched bytes.
     *
     * Pure slicing, exactly like {@link Mp4ByteRangeMediaSource#fetchChunks}:
     * the sample table gives every audio sample's offset, size and timestamp,
     * and the unit's byte range was widened at index time to contain them.
     * Every AAC sample is a sync sample, so there is no continuity to
     * preserve and units decode independently in any order.
     *
     * Sample timestamps here are already playlist time, so the timeline
     * offset is zero.
     *
     * @async
     * @param {number} unitIndex - Index of the unit to assemble.
     * @returns {Promise<?{codec: string, description: (Uint8Array|null), sampleRate: number, numberOfChannels: number, chunks: Array<Object>, timelineOffsetMicros: number}>} Decoder-ready chunks, or null when there is no audio.
     */
    async fetchAudioChunks(unitIndex) {
        if (!this._audioConfig) {
            return null;
        }

        const unit = this._segmentIndex.segments[unitIndex];
        if (!unit) {
            throw new Error(`No unit at index ${unitIndex}`);
        }

        const chunks = [];

        if (unit.firstAudioSample !== undefined) {
            const bytes = this.segmentFetcher.getCachedRawBytes(unitIndex);
            const view = new Uint8Array(bytes);

            for (let i = unit.firstAudioSample; i <= unit.lastAudioSample; i++) {
                const sample = this._audioSamples[i];
                const start = sample.offset - unit.byteRangeStart;

                // Defensive: a sample outside the fetched window would slice
                // into whatever happens to be adjacent and feed the decoder
                // noise. Dropping it costs one frame of audio; passing it on
                // would cost the unit.
                if (start < 0 || start + sample.size > view.length) {
                    continue;
                }

                chunks.push({
                    type: 'key',
                    timestamp: Math.round((sample.cts / sample.timescale) * 1e6),
                    duration: Math.round((sample.duration / sample.timescale) * 1e6),
                    data: view.subarray(start, start + sample.size),
                });
            }
        }

        return { ...this._audioConfig, chunks, timelineOffsetMicros: 0 };
    }

    /**
     * The engine-facing unit index: ordered units with real start/end
     * times, and no URLs or byte ranges -- locating bytes is this source's
     * business alone.
     *
     * @returns {{segments: Array<{index: number, startTime: number, endTime: number, duration: number}>, totalDuration: number}} Ordered units and total duration.
     */
    getUnitIndex() {
        return {
            segments: this._segmentIndex.segments.map(({ index, startTime, endTime, duration }) => ({
                index,
                startTime,
                endTime,
                duration,
            })),
            totalDuration: this._segmentIndex.totalDuration,
        };
    }

    /**
     * Assembles one unit's decoder chunks from its already-fetched bytes.
     *
     * No container parsing happens here: the sample table from load()
     * already gives every sample's offset, size, timestamp and sync flag,
     * so this is pure slicing. A unit always begins on a sync sample by
     * construction, so the transcode path's keyframe-continuity merge has
     * no counterpart here.
     *
     * @async
     * @param {number} unitIndex - Index of the unit to assemble.
     * @returns {Promise<{codec: string, description: (Uint8Array|null), chunks: Array<Object>, unitFirstTimestampMicros: (number|null)}>} Chunks in decode order.
     */
    async fetchChunks(unitIndex) {
        const unit = this._segmentIndex.segments[unitIndex];
        if (!unit) {
            throw new Error(`No unit at index ${unitIndex}`);
        }

        const bytes = this.segmentFetcher.getCachedRawBytes(unitIndex);
        const view = new Uint8Array(bytes);
        const chunks = [];

        for (let i = unit.firstSample; i <= unit.lastSample; i++) {
            const sample = this._samples[i];
            const start = sample.offset - unit.byteRangeStart;
            chunks.push({
                type: sample.is_sync ? 'key' : 'delta',
                timestamp: Math.round((sample.cts / sample.timescale) * 1e6),
                duration: Math.round((sample.duration / sample.timescale) * 1e6),
                data: view.subarray(start, start + sample.size),
            });
        }

        return {
            codec: this._config.codec,
            description: this._config.description,
            chunks,
            unitFirstTimestampMicros: chunks.length ? chunks[0].timestamp : null,
        };
    }

    /**
     * Extracts the avcC/hvcC payload VideoDecoder.configure() needs.
     *
     * @param {Object} iso - mp4box ISOFile, after onReady.
     * @param {number} trackId - Video track id.
     * @returns {Uint8Array|null} Codec description bytes, or null if absent.
     */
    _descriptionBytes(iso, trackId) {
        const trak = iso.getTrackById(trackId);
        for (const entry of trak.mdia.minf.stbl.stsd.entries) {
            const box = entry.avcC || entry.hvcC;
            if (box) {
                const stream = new DataStream(undefined, 0, DataStream.BIG_ENDIAN);
                box.write(stream);
                return new Uint8Array(stream.buffer, 8); // skip the box header
            }
        }
        return null;
    }

    /**
     * @async
     * @param {number} start - Inclusive start offset.
     * @param {number} endInclusive - Inclusive end offset.
     * @returns {Promise<ArrayBuffer>} The requested bytes.
     * @throws {Error} When the server does not honour the range.
     */
    async _fetchRange(start, endInclusive) {
        const options = { ...(this.fetchOptions || {}) };
        options.headers = { ...(options.headers || {}), Range: `bytes=${start}-${endInclusive}` };
        const response = await fetch(this.streamUrl, options);
        if (response.status !== 206) {
            throw new Error(`Direct Play byte-range request was not honored (got ${response.status}, expected 206).`);
        }
        return await response.arrayBuffer();
    }

    /**
     * @param {string} message - Message text, without the module prefix.
     * @returns {void}
     */
    _logDebug(message) {
        const prefixed = `[${this.constructor.name}] ${message}`;
        console.log(prefixed);
        if (this.onDebug) {
            this.onDebug(prefixed);
        }
    }
}
