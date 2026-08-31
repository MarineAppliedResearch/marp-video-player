/**
 * Minimal fake WebCodecs globals (VideoDecoder, EncodedVideoChunk,
 * VideoFrame) for unit-testing gop-decoder.js and frame-store.js under
 * plain Node/Jest, which has none of these as real globals.
 *
 * Deliberately NOT a full WebCodecs polyfill -- only the surface
 * gop-decoder.js actually calls is implemented, kept faithful to the real
 * API's async/callback shape (configure/decode/flush, output/error
 * callbacks, isConfigSupported) so the module under test can't tell the
 * difference at the call-site level.
 *
 * @fileoverview Fake WebCodecs globals for video-engine unit tests.
 * @author Isaac Travers
 * @module video-engine/test/unit/fakes/webcodecs-fakes
 */

/**
 * Fake VideoFrame -- used both for a decoder's raw output (constructed
 * directly by test fixtures) and for the plain-memory frame
 * detachFromHardwareSurface() reconstructs (constructed with the real
 * two-arg `(bufferOrData, init)` shape).
 */
class FakeVideoFrame {
    /**
     * @param {(Object|Uint8Array)} bufferOrInit - A plain fields object (decoder-output path, no second arg) or a pixel buffer (reconstruction path, used together with `init`).
     * @param {Object} [init] - Reconstruction options, matching the real `new VideoFrame(buffer, init)` two-arg form gop-decoder.js's detachFromHardwareSurface() uses.
     */
    constructor(bufferOrInit, init) {
        if (init) {
            this.format = init.format;
            this.displayWidth = init.codedWidth;
            this.displayHeight = init.codedHeight;
            this.timestamp = init.timestamp;
            this.duration = init.duration;
            this.colorSpace = init.colorSpace;
            // Tracks every reconstructed (plain-memory) frame -- the ones
            // detachFromHardwareSurface() produces and gop-decoder.js's
            // framePromises ultimately resolves to -- so a test can assert
            // on their .closed state without needing to intercept
            // detachFromHardwareSurface() itself, which is internal to
            // the module under test.
            FakeVideoFrame.reconstructedFrames.push(this);
        } else {
            Object.assign(this, bufferOrInit);
        }
        this.closed = false;
    }

    /** @returns {{width: number, height: number}} Matches gop-decoder.js's visibleRect-or-displayWidth/Height fallback logic. */
    get visibleRect() {
        return { width: this.displayWidth, height: this.displayHeight };
    }

    /** @returns {number} Fake 4:2:0 8-bit buffer size, matching the real allocationSize() formula in gop-decoder.js. */
    allocationSize() {
        return Math.ceil(this.displayWidth * this.displayHeight * 1.5);
    }

    /**
     * No-op: the fake has no real pixel data to copy. Real copyTo()
     * writes pixel bytes into the caller's buffer.
     *
     * @async
     * @returns {Promise<void>}
     */
    async copyTo() {}

    /** @returns {void} Marks the fake frame closed, so tests can assert on `.closed`. */
    close() {
        this.closed = true;
    }
}

/** Every reconstructed (plain-memory) frame created since the last installWebCodecsFakes() call. */
FakeVideoFrame.reconstructedFrames = [];

/**
 * Fake EncodedVideoChunk -- just carries through whatever chunk
 * descriptor gop-decoder.js passes in, so a fake VideoDecoder can read
 * `.timestamp`/`.type` back off it.
 */
class FakeEncodedVideoChunk {
    /** @param {Object} init - Chunk descriptor, as produced by demuxer.js. */
    constructor(init) {
        Object.assign(this, init);
    }
}

/**
 * Fake VideoDecoder. `flush()` synchronously (via a microtask) calls
 * `output(...)` once per queued chunk, using each test's configured
 * `outputForChunk` mapper to control what frame (and what order) comes
 * back out -- this is how tests simulate decode reordering the real
 * decoder would otherwise do internally.
 */
class FakeVideoDecoder {
    /**
     * @param {Object} callbacks
     * @param {function(Object): void} callbacks.output - Invoked once per decoded frame, matching the real VideoDecoder constructor dict.
     * @param {function(Error): void} callbacks.error - Invoked on decode error, when a test sets FakeVideoDecoder.simulateErrorAfterFrames.
     */
    constructor({ output, error }) {
        this._output = output;
        this._error = error;
        this._queue = [];
        this.state = 'unconfigured';
        this.decodeQueueSize = 0;
        FakeVideoDecoder.instances.push(this);
    }

    /**
     * Records the config, mirroring the real VideoDecoder#configure --
     * gop-decoder.js only ever checks `.state`, never the config value
     * itself, so this doesn't need to validate anything.
     *
     * @param {Object} config - Codec config, as passed to the real VideoDecoder.
     * @returns {void}
     */
    configure(config) {
        this._config = config;
        this.state = 'configured';
    }

    /**
     * Queues one chunk for the next flush() call, matching the real
     * VideoDecoder#decode's fire-and-forget signature.
     *
     * @param {Object} chunk - A FakeEncodedVideoChunk instance.
     * @returns {void}
     */
    decode(chunk) {
        this._queue.push(chunk);
    }

    /**
     * Emits one output frame per queued chunk, then resolves -- the fake
     * decoder's only real behavior. Each test can override
     * `FakeVideoDecoder.outputForChunk` to control what frame (and in
     * what order) comes back for a given chunk, e.g. to simulate decoded
     * output arriving out of presentation order.
     *
     * If `FakeVideoDecoder.simulateErrorAfterFrames` is set to a number,
     * fires the `error` callback after that many frames instead of
     * finishing normally, and never resolves/rejects itself -- matching
     * gop-decoder.js's own documented real-world observation that a
     * decode error fires the error callback without ever settling a
     * pending flush() promise.
     *
     * @async
     * @returns {Promise<void>}
     */
    async flush() {
        if (FakeVideoDecoder.simulateStall) {
            // Matches a genuine platform stall: no output, no error, never
            // settles -- the only thing that ends this in gop-decoder.js is
            // its own watchdog timeout.
            return new Promise(() => {});
        }

        const chunks = this._queue;
        this._queue = [];

        for (let i = 0; i < chunks.length; i++) {
            if (FakeVideoDecoder.simulateErrorAfterFrames === i) {
                this._error(new Error('simulated decode error'));
                return new Promise(() => {}); // never settles, matching real behavior
            }
            const outputForChunk = FakeVideoDecoder.outputForChunk || ((c) => new FakeVideoFrame({ timestamp: c.timestamp, duration: c.duration, displayWidth: 16, displayHeight: 16, format: 'I420' }));
            this._output(outputForChunk(chunks[i]));
        }
    }

    /**
     * Test hook: manually fires the output callback as if a queued chunk's
     * decode had just finished in the background, simulating a real
     * decoder continuing to process work submitted before flush()/the
     * watchdog gave up on it. Matches real VideoDecoder semantics: a
     * closed decoder never fires output() again, so this is a no-op once
     * close() has been called -- exactly the guarantee GopDecoder's
     * stall/error recovery relies on to prevent late output from one
     * segment leaking into the next segment's decode via the shared
     * _currentSink.
     *
     * @param {Object} frame - Frame to emit, as if freshly decoded.
     * @returns {void}
     */
    emitLateOutput(frame) {
        if (this.state === 'closed') {
            return;
        }
        this._output(frame);
    }

    /**
     * Marks the fake decoder closed, matching the real VideoDecoder#close.
     *
     * @returns {void}
     */
    close() {
        this.state = 'closed';
    }
}

/** Every FakeVideoDecoder instance constructed since the last installWebCodecsFakes() call -- lets a test confirm a fresh decoder was built after a failure, not the same (closed) one reused. */
FakeVideoDecoder.instances = [];

/** Static isConfigSupported, matching the real VideoDecoder's API shape -- gop-decoder.js always awaits this before configuring. */
FakeVideoDecoder.isConfigSupported = async () => ({ supported: true });

/**
 * Installs the fake WebCodecs globals, returning a restore function.
 *
 * @returns {function(): void} Call to remove the fakes and restore whatever globals existed before.
 */
function installWebCodecsFakes() {
    FakeVideoFrame.reconstructedFrames = [];
    FakeVideoDecoder.instances = [];

    const previous = {
        VideoFrame: global.VideoFrame,
        EncodedVideoChunk: global.EncodedVideoChunk,
        VideoDecoder: global.VideoDecoder,
    };

    global.VideoFrame = FakeVideoFrame;
    global.EncodedVideoChunk = FakeEncodedVideoChunk;
    global.VideoDecoder = FakeVideoDecoder;

    return function restore() {
        global.VideoFrame = previous.VideoFrame;
        global.EncodedVideoChunk = previous.EncodedVideoChunk;
        global.VideoDecoder = previous.VideoDecoder;
        delete FakeVideoDecoder.outputForChunk;
        delete FakeVideoDecoder.simulateErrorAfterFrames;
        delete FakeVideoDecoder.simulateStall;
    };
}

module.exports = { FakeVideoFrame, FakeEncodedVideoChunk, FakeVideoDecoder, installWebCodecsFakes };
