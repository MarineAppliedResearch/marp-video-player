/**
 * Owns one persistent WebCodecs AudioDecoder and decodes a unit's demuxed
 * audio chunks into plain PCM.
 *
 * The audio counterpart of gop-decoder.js, and deliberately shaped the same
 * way: one decoder instance, decodes serialized through an internal queue,
 * one unit in and one buffer out. Units are the same units the video uses --
 * a GOP on the byte-range paths, an HLS segment on the transcode path -- so
 * nothing here needs its own index or its own notion of where it is.
 *
 * What comes out is NOT an AudioBuffer. An AudioBuffer can only be created
 * through an AudioContext, and giving this module one would mean it owned a
 * piece of the output device purely to hold decoded samples. It returns
 * plain Float32Arrays instead, and {@link module:video-engine/audio-output}
 * turns them into AudioBuffers when it schedules them. That also means the
 * whole decode path is testable without any Web Audio at all.
 *
 * Every AAC frame is a sync sample, so unlike video there is no keyframe
 * continuity to preserve and units can be decoded in any order.
 *
 * @fileoverview WebCodecs AudioDecoder wrapper producing one PCM buffer per unit.
 * @author Isaac Travers
 * @module video-engine/audio-decoder
 */

/**
 * How long the decoder may produce NOTHING AT ALL before it is treated as
 * stalled, in ms. Reset by every output, so this measures a lack of progress
 * rather than a budget for the whole unit.
 *
 * It is written that way because a fixed total budget was wrong here, and
 * measurably so. The first version allowed 5 seconds per unit, reasoning that
 * audio is a fraction of the decode work of the picture beside it. That
 * reasoning ignored contention: a ten-second 1080p GOP has its own 250 frames
 * being decoded and copied out of GPU memory at the same time, and against
 * that the audio decoder was observed managing 130 of a unit's 938 frames in
 * five seconds -- progressing the whole time, and killed anyway. The unit then
 * went permanently silent, which is what "audio stops after about five
 * seconds" turned out to be.
 *
 * gop-decoder.js records being bitten by the same thing and answered it by
 * raising its total budget to 20 seconds. Keying on progress is the better
 * answer: a decoder that is merely slow is never killed however long it takes,
 * and one that is genuinely wedged is caught just as fast.
 *
 * @constant
 * @type {number}
 */
const DECODE_NO_PROGRESS_MS = 10000;

/**
 * Decodes audio units into PCM through one shared, serialized AudioDecoder.
 *
 * @class AudioUnitDecoder
 */
export class AudioUnitDecoder {
    constructor() {
        this._decoder = null;
        this._currentConfigKey = null;
        this._currentSink = null; // (audioData) => void, set per active decode call
        this._currentErrorHandler = null; // (err) => void, set per active decode call
        this._queue = Promise.resolve();
    }

    /**
     * Decodes one unit's audio. Concurrent calls are serialized behind the
     * internal queue, since there is only one AudioDecoder.
     *
     * @param {number} unitIndex - Unit index this audio belongs to.
     * @param {Object} audioResult - A media source's `fetchAudioChunks()` result.
     * @param {string} audioResult.codec - RFC 6381 codec string, e.g. `mp4a.40.2`.
     * @param {Uint8Array|null} audioResult.description - Codec description bytes (an AudioSpecificConfig, for AAC).
     * @param {number} audioResult.sampleRate - Sample rate the decoder should be configured with.
     * @param {number} audioResult.numberOfChannels - Channel count the decoder should be configured with.
     * @param {Array<Object>} audioResult.chunks - Chunk descriptors ready for EncodedAudioChunk.
     * @returns {Promise<{unitIndex: number, sampleRate: number, numberOfChannels: number, startTime: number, duration: number, channels: Array<Float32Array>}>} Decoded PCM, one Float32Array per channel, with `startTime`/`duration` in seconds.
     * @throws {Error} When the codec config is unsupported, the decoder errors, or it stalls past the watchdog.
     */
    decodeUnit(unitIndex, audioResult) {
        const result = this._queue.then(() => this._decodeUnitNow(unitIndex, audioResult));

        // Keep the queue alive even if this unit's decode fails, so a later,
        // unrelated unit is not blocked by this one's rejection.
        this._queue = result.then(
            () => undefined,
            () => undefined
        );

        return result;
    }

    /**
     * Performs one unit's decode -- only ever run one at a time, via the
     * queue in {@link AudioUnitDecoder#decodeUnit}.
     *
     * @async
     * @param {number} unitIndex - Unit index this audio belongs to.
     * @param {Object} audioResult - As passed to {@link AudioUnitDecoder#decodeUnit}.
     * @returns {Promise<Object>} The decoded PCM buffer.
     * @throws {Error} When the decoder errors or stalls.
     */
    async _decodeUnitNow(unitIndex, audioResult) {
        const { codec, description, sampleRate, numberOfChannels, chunks } = audioResult;

        if (!chunks || chunks.length === 0) {
            return {
                unitIndex,
                sampleRate,
                numberOfChannels,
                startTime: 0,
                duration: 0,
                channels: [],
            };
        }

        await this._ensureConfigured(codec, description, sampleRate, numberOfChannels);

        // Each output is copied to plain memory and closed immediately.
        // AudioData holds external memory the same way VideoFrame does, and
        // holding a unit's worth of them open while the rest decodes is the
        // same mistake gop-decoder.js documents at length for frames.
        const parts = [];

        // Assigned once the watchdog below exists. Every output pushes the
        // deadline out, which is what makes this a progress check rather than
        // a time limit.
        let noteProgress = () => {};

        this._currentSink = (audioData) => {
            try {
                parts.push(copyOut(audioData));
                noteProgress();
            } finally {
                audioData.close();
            }
        };

        // A decode error asynchronously closes the decoder without ever
        // settling a pending flush(), so flush() is raced against an error
        // signal rather than awaited alone -- the same failure gop-decoder.js
        // records having confirmed live for video.
        const errorPromise = new Promise((_, reject) => {
            this._currentErrorHandler = (err) => reject(err);
        });

        let watchdogHandle;
        const watchdogPromise = new Promise((_, reject) => {
            const arm = () => {
                watchdogHandle = setTimeout(() => {
                    const error = new Error(
                        `AudioDecoder produced no output for unit ${unitIndex} in ${DECODE_NO_PROGRESS_MS}ms ` +
                            `(decodeQueueSize=${this._decoder.decodeQueueSize}, state=${this._decoder.state}, ` +
                            `outputsSoFar=${parts.length}). This is a wedged decoder, not a slow one.`
                    );
                    // Marks it as worth another attempt: a decoder that stopped
                    // producing says nothing about whether these bytes are
                    // decodable, unlike a codec the platform refuses outright.
                    error.stalled = true;
                    reject(error);
                }, DECODE_NO_PROGRESS_MS);
            };

            noteProgress = () => {
                clearTimeout(watchdogHandle);
                arm();
            };

            arm();
        });

        for (const chunk of chunks) {
            this._decoder.decode(new EncodedAudioChunk(chunk));
        }

        const flushPromise = this._decoder.flush();
        flushPromise.catch(() => {}); // may settle after the race has already been lost

        try {
            await Promise.race([flushPromise, errorPromise, watchdogPromise]);
        } catch (err) {
            // Same reasoning as gop-decoder.js: a watchdog timeout does not
            // stop the real decoder, and its late output would otherwise
            // arrive through the shared sink and be attributed to whichever
            // unit decodes next. Closing guarantees it cannot.
            if (this._decoder && this._decoder.state !== 'closed') {
                this._decoder.close();
            }
            throw err;
        } finally {
            clearTimeout(watchdogHandle);
            this._currentSink = null;
            this._currentErrorHandler = null;
        }

        return assemble(unitIndex, parts, sampleRate, numberOfChannels);
    }

    /**
     * Ensures the shared AudioDecoder is configured, rebuilding it only when
     * the config actually changed.
     *
     * @async
     * @param {string} codec - RFC 6381 codec string.
     * @param {Uint8Array|null} description - Codec description bytes, if any.
     * @param {number} sampleRate - Source sample rate.
     * @param {number} numberOfChannels - Source channel count.
     * @returns {Promise<void>}
     * @throws {Error} When AudioDecoder.isConfigSupported reports the config unsupported.
     */
    async _ensureConfigured(codec, description, sampleRate, numberOfChannels) {
        const configKey = `${codec}:${sampleRate}:${numberOfChannels}:${description ? description.length : 0}`;

        if (this._decoder && this._decoder.state !== 'closed' && this._currentConfigKey === configKey) {
            return;
        }

        if (this._decoder && this._decoder.state !== 'closed') {
            this._decoder.close();
        }

        const config = { codec, sampleRate, numberOfChannels };
        if (description) {
            config.description = description;
        }

        const support = await AudioDecoder.isConfigSupported(config);
        if (!support.supported) {
            throw new Error(
                `AudioDecoder does not support codec config: ${JSON.stringify({ codec, sampleRate, numberOfChannels })}`
            );
        }

        this._decoder = new AudioDecoder({
            output: (audioData) => {
                if (this._currentSink) {
                    this._currentSink(audioData);
                } else {
                    // No active decode wants this -- avoid leaking the
                    // underlying WebCodecs memory.
                    audioData.close();
                }
            },
            error: (err) => {
                console.error('AudioDecoder error', err);
                if (this._currentErrorHandler) {
                    this._currentErrorHandler(err);
                }
            },
        });

        this._decoder.configure(config);
        this._currentConfigKey = configKey;
    }

    /**
     * Closes the underlying AudioDecoder, releasing its resources.
     *
     * @returns {void}
     */
    close() {
        if (this._decoder && this._decoder.state !== 'closed') {
            this._decoder.close();
        }
        this._decoder = null;
        this._currentConfigKey = null;
    }
}

/**
 * Copies one AudioData's samples into plain Float32Arrays, one per channel.
 *
 * `f32-planar` is requested explicitly rather than read from
 * `audioData.format`. copyTo() converts on the way out, and asking for one
 * layout unconditionally means nothing downstream has to branch on what the
 * platform's decoder happened to produce -- Chromium emits `f32-planar` for
 * AAC today, but that is an observation, not a guarantee.
 *
 * @param {AudioData} audioData - One decoder output.
 * @returns {{timestamp: number, frames: number, channels: Array<Float32Array>}} Copied samples and the timestamp they start at, in microseconds.
 */
function copyOut(audioData) {
    const frames = audioData.numberOfFrames;
    const channels = [];

    for (let plane = 0; plane < audioData.numberOfChannels; plane++) {
        const destination = new Float32Array(frames);
        audioData.copyTo(destination, { planeIndex: plane, format: 'f32-planar' });
        channels.push(destination);
    }

    return { timestamp: audioData.timestamp, frames, channels, sampleRate: audioData.sampleRate };
}

/**
 * Joins a unit's decoder outputs into one contiguous buffer per channel.
 *
 * Outputs are placed by their own timestamps rather than simply concatenated,
 * so a gap in the encoded audio becomes silence at the right position instead
 * of shifting everything after it earlier -- which would put the whole rest
 * of the unit out of sync with the picture.
 *
 * @param {number} unitIndex - Unit index this audio belongs to.
 * @param {Array<Object>} parts - Copied outputs, in decode order.
 * @param {number} configuredSampleRate - Sample rate the decoder was configured with.
 * @param {number} numberOfChannels - Configured channel count.
 * @returns {{unitIndex: number, sampleRate: number, numberOfChannels: number, startTime: number, duration: number, channels: Array<Float32Array>}} One buffer per channel.
 */
function assemble(unitIndex, parts, configuredSampleRate, numberOfChannels) {
    if (parts.length === 0) {
        return { unitIndex, sampleRate: configuredSampleRate, numberOfChannels, startTime: 0, duration: 0, channels: [] };
    }

    const ordered = [...parts].sort((a, b) => a.timestamp - b.timestamp);
    const startMicros = ordered[0].timestamp;

    // The rate the decoder actually produced, not the one it was configured
    // with. Spectral band replication (HE-AAC) advertises half the output
    // rate in its config and then emits at double it, so trusting the
    // configured value would lay the samples out at half speed.
    const sampleRate = ordered[0].sampleRate || configuredSampleRate;

    // The real channel count, not the configured one: a decoder is free to
    // output fewer planes than were asked for, and allocating for a plane
    // that never arrives would leave it silent rather than absent.
    const channelCount = Math.min(numberOfChannels, Math.max(...ordered.map((part) => part.channels.length)));

    const last = ordered[ordered.length - 1];
    const totalFrames = Math.round(((last.timestamp - startMicros) / 1e6) * sampleRate) + last.frames;

    const channels = [];
    for (let channel = 0; channel < channelCount; channel++) {
        channels.push(new Float32Array(totalFrames));
    }

    for (const part of ordered) {
        const offset = Math.round(((part.timestamp - startMicros) / 1e6) * sampleRate);
        for (let channel = 0; channel < channelCount; channel++) {
            const source = part.channels[channel];
            if (!source) {
                continue;
            }
            // Clamped rather than trusted: a rounded offset plus the last
            // output's length can land one sample past the allocation.
            const room = Math.max(0, channels[channel].length - offset);
            channels[channel].set(room < source.length ? source.subarray(0, room) : source, offset);
        }
    }

    return {
        unitIndex,
        sampleRate,
        numberOfChannels: channelCount,
        startTime: startMicros / 1e6,
        duration: totalFrames / sampleRate,
        channels,
    };
}
