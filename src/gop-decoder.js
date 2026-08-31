/**
 * Owns one persistent WebCodecs VideoDecoder instance and decodes a
 * segment's demuxed chunks forward into an ordered GopBuffer of VideoFrame
 * objects.
 *
 * Decode requests are serialized through an internal queue since only one
 * VideoDecoder is used: WebCodecs decodes are strictly ordered, so mixing
 * chunks from two unrelated GOPs into the queue without a flush() barrier
 * between them would make frame-to-segment attribution ambiguous. Each
 * segment is keyframe-aligned (confirmed via Jellyfin's
 * BreakOnNonKeyFrames=False policy), so decoding segments out of order
 * through the same decoder instance is safe -- every GOP fully resets
 * decode state via its leading IDR frame.
 *
 * @fileoverview WebCodecs VideoDecoder wrapper producing one ordered GopBuffer per segment.
 * @author Isaac Travers
 * @module video-engine/gop-decoder
 */

// Max time to wait for a segment's flush() before treating it as a
// stalled decoder, in ms. Originally 8000, raised after being confirmed
// live to fire during ordinary (not stalled) software decode: a Playwright
// E2E run under headless Chromium's SwiftShader software decoder hit this
// watchdog with framesOutputSoFar=43 and decodeQueueSize=29 -- output was
// actively progressing, just too slowly for the original budget, not
// actually stuck. That contradicts this file's own prior assumption that
// software decode never hits this path (only hardware-accelerated decode
// had been observed to). 20s stays a real ceiling for a genuine stall
// while giving slow software decode realistic room.
const DECODE_WATCHDOG_MS = 20000;

/**
 * Copies a decoded VideoFrame's pixel data into a plain, CPU-memory-backed
 * VideoFrame, then closes the original.
 *
 * Hardware-accelerated decoders hold a small, fixed pool of GPU decode
 * surfaces -- each undetached output VideoFrame keeps one occupied until
 * closed. This engine caches many frames per segment (and multiple
 * segments) for instant reverse/step access, which holds far more frames
 * alive at once than that pool can supply -- confirmed live: decoding
 * stalls partway through a segment with hardware decode enabled (no error,
 * no more output, decodeQueueSize stuck), while the same stream decodes
 * fine with software decode, which has no such surface limit. Detaching
 * every frame from its hardware surface immediately after output, before
 * it's held onto for caching, keeps the surface pool free for the decoder
 * to keep producing frames regardless of how many we're buffering.
 *
 * @async
 * @param {VideoFrame} frame - Freshly decoded, hardware-surface-backed frame.
 * @returns {Promise<VideoFrame>} An equivalent frame backed by plain memory.
 */
async function detachFromHardwareSurface(frame) {
    try {
        // copyTo()/allocationSize() default to the frame's VISIBLE rect,
        // not its (possibly macroblock-padded, e.g. 1080p coded as 1088px
        // tall) codedWidth/codedHeight -- confirmed live: passing the
        // padded coded dimensions into the reconstructed VideoFrame below
        // threw "data is not large enough", since the copied buffer only
        // ever held the smaller visible-rect data. Using the visible
        // width/height consistently for both the copy and the
        // reconstruction keeps them in agreement.
        const width = frame.visibleRect ? frame.visibleRect.width : frame.displayWidth;
        const height = frame.visibleRect ? frame.visibleRect.height : frame.displayHeight;

        const buffer = new Uint8Array(frame.allocationSize());
        await frame.copyTo(buffer);

        try {
            return new VideoFrame(buffer, {
                format: frame.format,
                codedWidth: width,
                codedHeight: height,
                timestamp: frame.timestamp,
                duration: frame.duration ?? undefined,
                colorSpace: frame.colorSpace,
            });
        } catch (err) {
            // Called out explicitly because it otherwise surfaces as a
            // generic "segment failure" that reads like a decode or
            // network problem, when it is neither: decoding worked, and
            // the browser simply refused to hand out another frame
            // buffer. Every cached frame holds its own buffer, so the
            // decoded-frame cache budget translates almost directly into
            // live VideoFrame memory -- a budget of several GB asks for
            // thousands of simultaneous buffers, and Chrome caps the
            // shared-memory regions backing them per renderer regardless
            // of how much RAM the machine has.
            console.error(
                `[gop-decoder] FRAME ALLOCATION FAILED (${frame.format} ${width}x${height}): ${err.message}. ` +
                    'The browser refused to allocate another VideoFrame -- decoding itself is fine. ' +
                    'This is the decoded-frame cache budget exceeding what this browser can allocate; lower it.',
            );
            throw err;
        }
    } finally {
        frame.close();
    }
}

/**
 * Decodes segments into GopBuffers via one shared, serialized
 * VideoDecoder instance.
 *
 * @class GopDecoder
 */
export class GopDecoder {
    constructor() {
        this._decoder = null;
        this._currentConfigKey = null;
        this._currentSink = null; // (frame) => void, set per active decode call
        this._currentErrorHandler = null; // (err) => void, set per active decode call
        this._queue = Promise.resolve();

        // Serializes detachFromHardwareSurface() calls so at most one
        // hardware decode surface is ever awaiting its copy at a time --
        // confirmed live that firing all of a segment's ~75 copies
        // concurrently (one per output frame, unthrottled) re-creates the
        // same surface-pool exhaustion the copy step exists to prevent,
        // just via pending copies instead of held-open cached frames.
        this._detachQueue = Promise.resolve();
    }

    /**
     * Queues one frame's hardware-surface detach behind any already in
     * progress, so copies never run concurrently.
     *
     * @param {VideoFrame} frame - Freshly decoded, hardware-surface-backed frame.
     * @returns {Promise<VideoFrame>} An equivalent frame backed by plain memory.
     */
    _enqueueDetach(frame) {
        const result = this._detachQueue.then(() => detachFromHardwareSurface(frame));
        this._detachQueue = result.then(
            () => undefined,
            () => undefined
        );
        return result;
    }

    /**
     * Decodes one segment. Concurrent calls are serialized behind the
     * internal queue rather than run in parallel, since only one
     * VideoDecoder instance is used.
     *
     * @param {number} segmentIndexNumber - Segment index this GOP belongs to.
     * @param {Object} demuxResult - Result of {@link module:video-engine/demuxer.demuxSegment}.
     * @returns {Promise<{segmentIndex: number, frames: Array<VideoFrame>}>} The decoded GopBuffer.
     * @throws {Error} When the segment's first chunk is not a keyframe, or the codec config is unsupported.
     */
    decodeSegment(segmentIndexNumber, demuxResult) {
        const result = this._queue.then(() => this._decodeSegmentNow(segmentIndexNumber, demuxResult));

        // Keep the queue alive even if this segment's decode fails, so a
        // later, unrelated segment isn't blocked by this one's rejection.
        this._queue = result.then(
            () => undefined,
            () => undefined
        );

        return result;
    }

    /**
     * Performs one segment's decode -- only ever run one at a time, via
     * the queue in {@link GopDecoder#decodeSegment}.
     *
     * @async
     * @param {number} segmentIndexNumber - Segment index this GOP belongs to.
     * @param {Object} demuxResult - Result of {@link module:video-engine/demuxer.demuxSegment}.
     * @returns {Promise<{segmentIndex: number, frames: Array<VideoFrame>}>} The decoded GopBuffer.
     * @throws {Error} When the segment's first chunk is not a keyframe, the decoder reports an error, or the decoder stalls past the watchdog timeout.
     */
    async _decodeSegmentNow(segmentIndexNumber, demuxResult) {
        const { codec, description, chunks } = demuxResult;

        if (chunks.length === 0 || chunks[0].type !== 'key') {
            throw new Error(
                `Segment ${segmentIndexNumber}'s first chunk is not a keyframe -- cannot decode independently ` +
                    `(caller must merge in the previous segment's chunks first).`
            );
        }

        await this._ensureConfigured(codec, description);

        // Each pushed entry is a promise -- detachFromHardwareSurface()
        // copies the frame off its (surface-pool-limited) hardware backing
        // immediately, rather than waiting until the whole segment is
        // collected, which is what actually exhausts the pool.
        const framePromises = [];
        this._currentSink = (frame) => framePromises.push(this._enqueueDetach(frame));

        // A decode error asynchronously closes the decoder without ever
        // settling a pending flush() promise -- confirmed live (flush()
        // hangs forever after the error callback fires). Race flush()
        // against an error signal so a bad segment rejects instead of
        // stalling the engine forever.
        const errorPromise = new Promise((_, reject) => {
            this._currentErrorHandler = (err) => reject(err);
        });

        // Belt-and-suspenders watchdog: confirmed live that a platform's
        // WebCodecs decoder can stall on some encoded input with NEITHER a
        // resolved flush() NOR a fired error callback (originally observed
        // with hardware-accelerated decode; also since confirmed firing
        // under headless Chromium's software/SwiftShader decode, just from
        // genuinely slow-but-progressing decode rather than a true stall --
        // see DECODE_WATCHDOG_MS's own comment) -- there is no
        // spec-guaranteed signal to wait for in the true-stall case, so a
        // timeout is the only way to turn a silent, permanent hang into a
        // real, actionable error instead.
        let watchdogHandle;
        const watchdogPromise = new Promise((_, reject) => {
            watchdogHandle = setTimeout(() => {
                reject(
                    new Error(
                        `VideoDecoder stalled decoding segment ${segmentIndexNumber}: flush() did not settle within ` +
                            `${DECODE_WATCHDOG_MS}ms (decodeQueueSize=${this._decoder.decodeQueueSize}, ` +
                            `state=${this._decoder.state}, framesOutputSoFar=${framePromises.length}). No error callback fired -- ` +
                            `this looks like a platform/hardware decoder stall, not a demux/config problem.`
                    )
                );
            }, DECODE_WATCHDOG_MS);
        });

        for (const chunk of chunks) {
            this._decoder.decode(new EncodedVideoChunk(chunk));
        }

        const flushPromise = this._decoder.flush();
        flushPromise.catch(() => {}); // avoid an unhandled rejection if it settles after we've already raced away

        try {
            await Promise.race([flushPromise, errorPromise, watchdogPromise]);
        } catch (err) {
            // A watchdog timeout (or an error the decoder itself didn't
            // fully shut down from) does NOT mean the real VideoDecoder
            // actually stopped -- it keeps processing this segment's
            // already-submitted chunks in the background. Left alone, its
            // late output fires into whatever segment decodes NEXT via the
            // shared _currentSink (reassigned once this call's queue slot
            // releases), silently mixing that segment's frames with
            // leftovers from this one -- confirmed live as the actual
            // cause of the FRAME ATTRIBUTION MISMATCH check below, and
            // almost certainly the root cause of "correct index, wrong
            // picture" reports after fast reverse scrubbing outran decode
            // throughput. Closing here guarantees no further output can
            // ever arrive from this instance; _ensureConfigured()
            // transparently builds a fresh one for the next decodeSegment()
            // call.
            if (this._decoder && this._decoder.state !== 'closed') {
                this._decoder.close();
            }

            // Some frames may already have been decoded and detached to
            // plain memory before the error/stall occurred -- each is a
            // VideoFrame holding real external memory, so leaving them
            // unclosed here leaks on every failed segment, compounding on
            // repeated retries. Promise.allSettled (not Promise.all): a
            // still-pending or separately-rejected detach must not stop
            // the frames that DID finish from being closed.
            const settledFrames = await Promise.allSettled(framePromises);
            for (const result of settledFrames) {
                if (result.status === 'fulfilled') {
                    result.value.close();
                }
            }
            throw err;
        } finally {
            clearTimeout(watchdogHandle);
            this._currentSink = null;
            this._currentErrorHandler = null;
        }

        const frames = await Promise.all(framePromises);

        // Permanent regression guard (was a temporary diagnostic -- this
        // confirmed the actual bug fixed above: a watchdog/error failure
        // leaving the real decoder running in the background, leaking late
        // output into the next segment via the shared _currentSink). Kept
        // rather than removed since a recurrence here is exactly as subtle
        // and hard to reproduce as the original was. Checks that this
        // decode call's output frame timestamps are EXACTLY the set of
        // timestamps fed in as input chunks -- a mismatch means a frame
        // from a DIFFERENT decodeSegment() call leaked into this one's
        // output (or one of this segment's own frames leaked OUT).
        const expectedTimestamps = new Set(chunks.map((c) => c.timestamp));
        const actualTimestamps = new Set(frames.map((f) => f.timestamp));
        const unexpected = [...actualTimestamps].filter((t) => !expectedTimestamps.has(t));
        const missing = [...expectedTimestamps].filter((t) => !actualTimestamps.has(t));
        if (unexpected.length > 0 || missing.length > 0) {
            console.warn(
                `[gop-decoder] FRAME ATTRIBUTION MISMATCH decoding segment ${segmentIndexNumber}: ` +
                    `expected ${expectedTimestamps.size} frames, got ${actualTimestamps.size}. ` +
                    `unexpected timestamps (may belong to a different segment): [${unexpected.join(', ')}]. ` +
                    `missing timestamps (may have leaked to a different segment): [${missing.join(', ')}].`
            );
        }

        frames.sort((a, b) => a.timestamp - b.timestamp);

        return { segmentIndex: segmentIndexNumber, frames };
    }

    /**
     * Ensures the shared VideoDecoder is configured for the given codec,
     * reconfiguring (closing and recreating) only when the config
     * actually changed.
     *
     * @async
     * @param {string} codec - RFC 6381 codec string (e.g. `avc1.4D4028`).
     * @param {Uint8Array|null} description - Codec description bytes (avcC/hvcC payload), if any.
     * @returns {Promise<void>}
     * @throws {Error} When VideoDecoder.isConfigSupported reports the config unsupported.
     */
    async _ensureConfigured(codec, description) {
        const configKey = `${codec}:${description ? description.length : 0}`;

        if (this._decoder && this._decoder.state !== 'closed' && this._currentConfigKey === configKey) {
            return;
        }

        if (this._decoder && this._decoder.state !== 'closed') {
            this._decoder.close();
        }

        const config = { codec, optimizeForLatency: true };
        if (description) {
            config.description = description;
        }

        const support = await VideoDecoder.isConfigSupported(config);
        if (!support.supported) {
            throw new Error(`VideoDecoder does not support codec config: ${JSON.stringify({ codec })}`);
        }

        this._decoder = new VideoDecoder({
            output: (frame) => {
                if (this._currentSink) {
                    this._currentSink(frame);
                } else {
                    // No active decodeSegment call wants this frame (shouldn't
                    // normally happen given the serialized queue) -- avoid
                    // leaking the underlying WebCodecs memory.
                    frame.close();
                }
            },
            error: (err) => {
                console.error('VideoDecoder error', err);
                if (this._currentErrorHandler) {
                    this._currentErrorHandler(err);
                }
            },
        });

        this._decoder.configure(config);
        this._currentConfigKey = configKey;
    }

    /**
     * Closes the underlying VideoDecoder, releasing its resources.
     *
     * @returns {void}
     */
    close() {
        if (this._decoder && this._decoder.state !== 'closed') {
            this._decoder.close();
        }
    }
}
