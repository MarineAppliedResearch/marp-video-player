/**
 * Minimal fake WebCodecs audio and Web Audio globals for unit-testing
 * audio-decoder.js and audio-output.js under plain Node/Jest, which has
 * neither.
 *
 * Deliberately not a polyfill -- only the surface those two modules actually
 * call, kept faithful to the real APIs' shapes. The one part that matters
 * more than fidelity is the clock: `FakeAudioContext.currentTime` is a plain
 * writable number rather than something that advances on its own, because
 * every assertion worth making about scheduling is "given the clock was HERE,
 * what time was this buffer placed at". A real clock would make those
 * assertions timing-dependent, which is exactly what a scheduler test must
 * not be.
 *
 * @fileoverview Fake AudioDecoder and Web Audio globals for the audio unit tests.
 * @author Isaac Travers
 * @module video-engine/test/unit/fakes/webaudio-fakes
 */

/**
 * Fake AudioData -- one decoder output. `copyTo` writes a constant per
 * channel so a test can tell channels and outputs apart by value.
 */
class FakeAudioData {
    /**
     * @param {Object} init
     * @param {number} init.timestamp - Presentation timestamp, in microseconds.
     * @param {number} init.numberOfFrames - Sample frames in this output.
     * @param {number} init.numberOfChannels - Channel count.
     * @param {number} init.sampleRate - Sample rate this output was produced at.
     * @param {number} [init.fill] - Value every sample copies out as. Defaults to the timestamp, so outputs are distinguishable.
     */
    constructor({ timestamp, numberOfFrames, numberOfChannels, sampleRate, fill }) {
        this.timestamp = timestamp;
        this.numberOfFrames = numberOfFrames;
        this.numberOfChannels = numberOfChannels;
        this.sampleRate = sampleRate;
        this.format = 'f32-planar';
        this.fill = fill === undefined ? timestamp : fill;
        this.closed = false;
    }

    /**
     * Fills the destination the way the real copyTo writes decoded samples.
     *
     * @param {Float32Array} destination - Caller's buffer.
     * @param {Object} options - `{planeIndex, format}`, as audio-decoder.js passes.
     * @returns {void}
     */
    copyTo(destination, { planeIndex }) {
        destination.fill(this.fill + planeIndex);
    }

    /** @returns {void} */
    close() {
        this.closed = true;
    }
}

/** Fake EncodedAudioChunk -- carries the chunk descriptor through unchanged. */
class FakeEncodedAudioChunk {
    /** @param {Object} init - Chunk descriptor, as produced by a media source. */
    constructor(init) {
        Object.assign(this, init);
    }
}

/**
 * Fake AudioDecoder. `flush()` emits one output per queued chunk, using each
 * test's `outputForChunk` mapper when one is set.
 */
class FakeAudioDecoder {
    /**
     * @param {Object} callbacks
     * @param {function(Object): void} callbacks.output - Invoked once per decoded output.
     * @param {function(Error): void} callbacks.error - Invoked on decode error.
     */
    constructor({ output, error }) {
        this._output = output;
        this._error = error;
        this._queue = [];
        this.state = 'unconfigured';
        this.decodeQueueSize = 0;
        FakeAudioDecoder.instances.push(this);
    }

    /**
     * @param {Object} config - Codec config, recorded so a test can assert on it.
     * @returns {void}
     */
    configure(config) {
        this.config = config;
        this.state = 'configured';
    }

    /**
     * @param {Object} chunk - A FakeEncodedAudioChunk instance.
     * @returns {void}
     */
    decode(chunk) {
        this._queue.push(chunk);
    }

    /**
     * Emits one output per queued chunk, then resolves.
     *
     * `simulateStall` never settles and emits nothing, which is the platform
     * failure audio-decoder.js's watchdog exists for. `simulateError` fires
     * the error callback and then never settles, matching the real decoder's
     * documented behaviour of closing without resolving a pending flush.
     *
     * @async
     * @returns {Promise<void>}
     */
    async flush() {
        if (FakeAudioDecoder.simulateStall) {
            return new Promise(() => {});
        }

        const chunks = this._queue;
        this._queue = [];

        if (FakeAudioDecoder.simulateError) {
            this._error(new Error('simulated audio decode error'));
            return new Promise(() => {});
        }

        const map =
            FakeAudioDecoder.outputForChunk ||
            ((chunk) =>
                new FakeAudioData({
                    timestamp: chunk.timestamp,
                    numberOfFrames: 1024,
                    numberOfChannels: 2,
                    sampleRate: 48000,
                }));

        for (const chunk of chunks) {
            this._output(map(chunk));
        }
    }

    /** @returns {void} */
    close() {
        this.state = 'closed';
    }
}

/** Every FakeAudioDecoder built since the last install -- lets a test confirm a fresh one was created after a failure. */
FakeAudioDecoder.instances = [];

/** Static isConfigSupported, matching the real API. Tests set `.supported = false` to exercise the refusal. */
FakeAudioDecoder.isConfigSupported = async () => ({ supported: FakeAudioDecoder.supported !== false });

/** Fake AudioParam: records what was written, including ramps. */
class FakeAudioParam {
    /** @param {number} value - Initial value. */
    constructor(value) {
        this.value = value;
        this.targets = [];
    }

    /**
     * @param {number} target - Value to ramp toward.
     * @param {number} startTime - Context time the ramp starts at.
     * @param {number} timeConstant - Ramp time constant.
     * @returns {void}
     */
    setTargetAtTime(target, startTime, timeConstant) {
        this.targets.push({ target, startTime, timeConstant });
        // Settled immediately: a test asserting on gain wants the value it
        // was asked for, not a point partway along an exponential curve.
        this.value = target;
    }
}

/** Fake GainNode. */
class FakeGainNode {
    constructor() {
        this.gain = new FakeAudioParam(1);
        this.connected = null;
    }

    /**
     * @param {Object} destination - Node to connect to.
     * @returns {void}
     */
    connect(destination) {
        this.connected = destination;
    }

    /** @returns {void} */
    disconnect() {
        this.connected = null;
    }
}

/**
 * Fake AudioBufferSourceNode. Every `start(when, offset)` is recorded, which
 * is the whole point: it is how a test reads back where audio was scheduled.
 */
class FakeAudioBufferSourceNode {
    /** @param {FakeAudioContext} context - Owning context. */
    constructor(context) {
        this.context = context;
        this.buffer = null;
        this.playbackRate = new FakeAudioParam(1);
        this.onended = null;
        this.started = null;
        this.stopped = false;
        this.connected = null;
    }

    /**
     * @param {Object} destination - Node to connect to.
     * @returns {void}
     */
    connect(destination) {
        this.connected = destination;
    }

    /** @returns {void} */
    disconnect() {
        this.connected = null;
    }

    /**
     * @param {number} when - Absolute context time to begin at.
     * @param {number} offset - Offset into the buffer, in seconds.
     * @returns {void}
     */
    start(when, offset) {
        this.started = { when, offset, rate: this.playbackRate.value };
        this.context.startedSources.push(this);
    }

    /**
     * Matches the real node, which throws when stopped before it ever
     * started -- audio-output.js swallows that deliberately.
     *
     * @returns {void}
     */
    stop() {
        if (!this.started) {
            throw new Error('cannot stop a source that never started');
        }
        this.stopped = true;
    }
}

/** Fake AudioBuffer. `copyToChannel` keeps what it was given, so a test can check which samples were scheduled. */
class FakeAudioBuffer {
    /**
     * @param {number} numberOfChannels - Channel count.
     * @param {number} length - Sample frames.
     * @param {number} sampleRate - Buffer's own sample rate, which need not match the context's.
     */
    constructor(numberOfChannels, length, sampleRate) {
        this.numberOfChannels = numberOfChannels;
        this.length = length;
        this.sampleRate = sampleRate;
        this.duration = length / sampleRate;
        this.channels = [];
    }

    /**
     * @param {Float32Array} source - Samples to copy in.
     * @param {number} channelNumber - Destination channel.
     * @returns {void}
     */
    copyToChannel(source, channelNumber) {
        this.channels[channelNumber] = source;
    }
}

/**
 * Fake AudioContext with a manually advanced clock.
 *
 * `currentTime` is writable, and `advance()` moves it -- scheduling
 * assertions are about where a buffer was placed given a known clock, which
 * a real advancing clock would make flaky rather than more realistic.
 */
class FakeAudioContext {
    constructor() {
        this.currentTime = 0;
        this.state = FakeAudioContext.initialState || 'running';
        this.destination = { name: 'destination' };
        this.startedSources = [];
        this.closed = false;
        this.gainNodes = [];
        FakeAudioContext.instances.push(this);
    }

    /** @returns {FakeGainNode} A new gain node. */
    createGain() {
        const node = new FakeGainNode();
        this.gainNodes.push(node);
        return node;
    }

    /**
     * @param {number} numberOfChannels - Channel count.
     * @param {number} length - Sample frames.
     * @param {number} sampleRate - Buffer sample rate.
     * @returns {FakeAudioBuffer} A new buffer.
     */
    createBuffer(numberOfChannels, length, sampleRate) {
        return new FakeAudioBuffer(numberOfChannels, length, sampleRate);
    }

    /** @returns {FakeAudioBufferSourceNode} A new source node. */
    createBufferSource() {
        return new FakeAudioBufferSourceNode(this);
    }

    /**
     * Matches the real resume(), which is what lifts the autoplay block.
     * `resumeRefused` keeps the context suspended, which is what a browser
     * does when resume is called outside a user gesture.
     *
     * @async
     * @returns {Promise<void>}
     */
    async resume() {
        if (!FakeAudioContext.resumeRefused) {
            this.state = 'running';
        }
    }

    /**
     * @async
     * @returns {Promise<void>}
     */
    async close() {
        this.closed = true;
        this.state = 'closed';
    }

    /**
     * Moves the clock forward.
     *
     * @param {number} seconds - How far to advance.
     * @returns {void}
     */
    advance(seconds) {
        this.currentTime += seconds;
    }
}

/** Every FakeAudioContext built since the last install. */
FakeAudioContext.instances = [];

/**
 * Installs the fake audio globals, returning a restore function.
 *
 * @returns {function(): void} Call to remove the fakes and restore whatever globals existed before.
 */
function installAudioFakes() {
    FakeAudioDecoder.instances = [];
    FakeAudioContext.instances = [];

    const previous = {
        AudioDecoder: global.AudioDecoder,
        EncodedAudioChunk: global.EncodedAudioChunk,
        AudioData: global.AudioData,
        AudioContext: global.AudioContext,
    };

    global.AudioDecoder = FakeAudioDecoder;
    global.EncodedAudioChunk = FakeEncodedAudioChunk;
    global.AudioData = FakeAudioData;
    global.AudioContext = FakeAudioContext;

    return function restore() {
        global.AudioDecoder = previous.AudioDecoder;
        global.EncodedAudioChunk = previous.EncodedAudioChunk;
        global.AudioData = previous.AudioData;
        global.AudioContext = previous.AudioContext;
        delete FakeAudioDecoder.outputForChunk;
        delete FakeAudioDecoder.simulateStall;
        delete FakeAudioDecoder.simulateError;
        delete FakeAudioDecoder.supported;
        delete FakeAudioContext.initialState;
        delete FakeAudioContext.resumeRefused;
    };
}

module.exports = {
    FakeAudioData,
    FakeEncodedAudioChunk,
    FakeAudioDecoder,
    FakeAudioContext,
    FakeAudioBuffer,
    FakeGainNode,
    installAudioFakes,
};
