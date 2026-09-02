/**
 * A small cache of decoded audio units, keyed by the same unit index the
 * video pipeline uses.
 *
 * The audio counterpart of frame-store.js, and far simpler than it, because
 * audio has none of the properties that make the video cache hard: units are
 * small, cheap to decode, never needed in reverse, and never pinned. A short
 * ring of recently used units is the whole policy.
 *
 * **This module never fetches.** It reads only bytes Tier 1 already holds,
 * and skips a unit whose bytes are absent rather than asking for them. That
 * is deliberate: on the byte-range paths a unit's audio lives inside the same
 * byte range as its video, so if the picture is playing the audio bytes are
 * already there, and on the transcode path they are in the same segment.
 * Letting audio issue fetches of its own would put it in competition with the
 * picture for the connection pool, and picture is what this player is for.
 * Missing audio is silence; a missing frame is a stall.
 *
 * @fileoverview Small LRU cache of decoded audio units.
 * @author Isaac Travers
 * @module video-engine/audio-store
 */

/**
 * How many decoded units to keep. A 10-second stereo unit at 96 kHz is about
 * 7.7 MB of Float32, so four is a few tens of megabytes at the worst unit
 * length this engine has seen -- next to the video cache's gigabytes, small
 * enough not to need a byte budget of its own.
 *
 * @constant
 * @type {number}
 */
const DEFAULT_MAX_UNITS = 4;

/**
 * How many times a unit may fail to decode before it is given up on.
 *
 * More than one because the commonest failure is not a bad unit at all: the
 * audio decoder giving up while the picture was saturating the machine. The
 * contention that caused it is usually over by the time anything asks again.
 * Bounded because a genuinely undecodable unit will not become decodable by
 * being asked five times a second forever.
 *
 * @constant
 * @type {number}
 */
const MAX_DECODE_ATTEMPTS = 2;

/**
 * Fetches (from cache only), decodes and holds audio units.
 *
 * @class AudioStore
 */
export class AudioStore {
    /**
     * @param {Object} params
     * @param {Object} params.mediaSource - The engine's media source; supplies `fetchAudioChunks()`.
     * @param {Object} params.segmentFetcher - Tier 1, read-only: consulted for `hasRawBytes()`, never asked to fetch.
     * @param {Object} params.audioDecoder - {@link module:video-engine/audio-decoder.AudioUnitDecoder} instance.
     * @param {number} [params.maxUnits] - How many decoded units to keep.
     * @param {function(string): void} [params.onDebug] - Progress messages.
     * @param {function(number): void} [params.onUnitReady] - Called with a unit index once it is decoded and cached. Lets a consumer act the moment a unit lands rather than on its next poll, which is the difference between audio starting with the picture and starting a scheduling interval later.
     */
    constructor({ mediaSource, segmentFetcher, audioDecoder, maxUnits, onDebug, onUnitReady }) {
        this.mediaSource = mediaSource;
        this.segmentFetcher = segmentFetcher;
        this.audioDecoder = audioDecoder;
        this.maxUnits = maxUnits || DEFAULT_MAX_UNITS;
        this.onDebug = onDebug;
        this.onUnitReady = onUnitReady || null;

        /** Decoded units, in least-recently-used-first order. @type {Map<number, Object>} */
        this.units = new Map();
        this._inFlight = new Map();

        // Units given up on, and how many times each unit has failed so far.
        // Failure is not permanent on the first attempt -- see
        // MAX_DECODE_ATTEMPTS -- but it has to become permanent eventually,
        // because the scheduling passes run several times a second and a unit
        // that cannot decode will not start decoding by being asked again.
        this._failed = new Set();
        this._attempts = new Map();
    }

    /**
     * Returns a decoded unit if it is already in hand. Never starts work --
     * this is called from the scheduling pass, which must not block.
     *
     * @param {number} unitIndex - Unit index.
     * @returns {Object|null} The decoded unit, or null if it is not cached.
     */
    get(unitIndex) {
        const unit = this.units.get(unitIndex);
        if (!unit) {
            return null;
        }
        // Re-insert to mark most recently used.
        this.units.delete(unitIndex);
        this.units.set(unitIndex, unit);
        return unit;
    }

    /**
     * Asks for a unit to be decoded in the background, if it can be.
     *
     * Silently does nothing when the unit is already held, already being
     * decoded, previously failed, out of range, or when Tier 1 does not
     * hold its bytes -- every one of those is a normal condition, not an
     * error, and this runs several times a second.
     *
     * @param {number} unitIndex - Unit index to decode.
     * @returns {void}
     */
    request(unitIndex) {
        if (!Number.isInteger(unitIndex) || unitIndex < 0) {
            return;
        }
        if (this.units.has(unitIndex) || this._inFlight.has(unitIndex) || this._failed.has(unitIndex)) {
            return;
        }
        if (!this.segmentFetcher.hasRawBytes(unitIndex)) {
            return;
        }

        const promise = this._decode(unitIndex)
            .catch((err) => {
                // Tier 1 can evict a unit's bytes between the check above and
                // the read inside fetchAudioChunks -- `getCachedRawBytes`
                // throws when it does -- and that says nothing about whether
                // the audio is decodable. It does not count as an attempt.
                if (!this.segmentFetcher.hasRawBytes(unitIndex)) {
                    this._logDebug(`unit ${unitIndex}: raw bytes went away mid-decode, will try again -- ${err.message}`);
                    return null;
                }

                const attempts = (this._attempts.get(unitIndex) || 0) + 1;
                this._attempts.set(unitIndex, attempts);

                if (attempts >= MAX_DECODE_ATTEMPTS) {
                    this._failed.add(unitIndex);
                    this._logDebug(
                        `unit ${unitIndex}: audio decode failed ${attempts} times, this unit will be silent -- ${err.message}`
                    );
                } else {
                    // Most often a decoder that gave up while the picture was
                    // saturating the machine. The contention that caused it is
                    // usually over by the time anything asks again.
                    this._logDebug(`unit ${unitIndex}: audio decode failed, will try once more -- ${err.message}`);
                }

                return null;
            })
            .finally(() => {
                this._inFlight.delete(unitIndex);
            });

        this._inFlight.set(unitIndex, promise);
    }

    /**
     * Decodes one unit's audio and caches it.
     *
     * @async
     * @param {number} unitIndex - Unit index to decode.
     * @returns {Promise<Object>} The decoded unit.
     */
    async _decode(unitIndex) {
        const audioResult = await this.mediaSource.fetchAudioChunks(unitIndex);

        if (!audioResult || !audioResult.chunks || audioResult.chunks.length === 0) {
            // A unit with no audio samples is perfectly ordinary -- a short
            // tail unit, or a gap in the audio track. Cache the emptiness so
            // it is not re-decoded on every pass.
            const empty = { unitIndex, mediaStart: 0, mediaEnd: 0, sampleRate: 0, numberOfChannels: 0, channels: [] };
            this._store(unitIndex, empty);
            return empty;
        }

        const pcm = await this.audioDecoder.decodeUnit(unitIndex, audioResult);

        // The decoder works in the media's own timestamps; the engine works
        // in the playlist timeline. The source reports the offset between
        // them, which is zero wherever sample timestamps already are
        // playlist time (the byte-range paths) and non-zero where a
        // transcoder's segment timestamps are shifted from it.
        const offsetSeconds = (audioResult.timelineOffsetMicros || 0) / 1e6;

        const unit = {
            unitIndex,
            sampleRate: pcm.sampleRate,
            numberOfChannels: pcm.numberOfChannels,
            channels: pcm.channels,
            mediaStart: pcm.startTime + offsetSeconds,
            mediaEnd: pcm.startTime + offsetSeconds + pcm.duration,
        };

        this._store(unitIndex, unit);
        return unit;
    }

    /**
     * Inserts a decoded unit and evicts the least recently used until the
     * cache is back within `maxUnits`.
     *
     * @param {number} unitIndex - Unit index.
     * @param {Object} unit - The decoded unit.
     * @returns {void}
     */
    _store(unitIndex, unit) {
        this.units.set(unitIndex, unit);

        if (this.onUnitReady) {
            this.onUnitReady(unitIndex);
        }

        while (this.units.size > this.maxUnits) {
            const oldest = this.units.keys().next().value;
            this.units.delete(oldest);
        }
    }

    /**
     * Drops every cached unit. Called when the audio path restarts somewhere
     * unrelated, so the cache reflects where playback now is.
     *
     * The failure set is deliberately kept: a unit that could not be decoded
     * still cannot be, and clearing it here would turn a permanent failure
     * back into one retried on every pass.
     *
     * @returns {void}
     */
    clear() {
        this.units.clear();
    }

    /**
     * Releases everything, including the underlying decoder.
     *
     * @returns {void}
     */
    close() {
        this.units.clear();
        this._inFlight.clear();
        this._failed.clear();
        this._attempts.clear();
        this.audioDecoder.close();
    }

    /**
     * @param {string} message - Message text, without the module prefix.
     * @returns {void}
     */
    _logDebug(message) {
        const prefixed = `[audio-store] ${message}`;
        console.log(prefixed);
        if (this.onDebug) {
            this.onDebug(prefixed);
        }
    }
}
