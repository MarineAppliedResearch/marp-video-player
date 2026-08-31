/**
 * Encodes per-segment cache state for a host that draws its own scrub bar.
 *
 * getSegmentStates() returns one object per segment, which is the right
 * shape for a caller that can hold objects (a JS consumer, or C# reading
 * the return value of ExecuteScriptAsync). It is the wrong shape to push
 * several times a second across the WebView2 message channel: a 1354s clip
 * is ~226 segments, tens of kilobytes of JSON per tick, nearly all of it
 * unchanged.
 *
 * So the two halves are split by how often they change:
 *
 *   geometry -- where each segment sits on the timeline. Fixed once the
 *   stream is loaded, so it is sent once.
 *
 *   state -- fetched/decoded/pinned. Changes constantly, so it is sent as
 *   one digit per segment: a bitmask, 1 = fetched, 2 = decoded, 4 = pinned.
 *   The three are deliberately orthogonal rather than a single "best"
 *   state, because "pinned but not yet decoded" and "pinned and decoded"
 *   are different things worth drawing differently -- the built-in bar
 *   draws pinned as a ring over the fill for exactly that reason.
 *
 * @fileoverview Compact wire encoding of segment states for a WebView2 host.
 * @author Isaac Travers
 * @module video-engine/segment-encoding
 */

/** @type {number} Raw bytes for this segment are in the raw cache. */
export const SEGMENT_FETCHED = 1;

/** @type {number} Decoded frames for this segment are in the decoded cache. */
export const SEGMENT_DECODED = 2;

/** @type {number} Segment is in the protected lookahead window and will not be evicted. */
export const SEGMENT_PINNED = 4;

/**
 * Encodes segment states as one digit per segment.
 *
 * Digits, not a delimited list, so the message stays a few hundred bytes at
 * any realistic segment count and a host can index straight into it:
 * character N describes segment N.
 *
 * @param {Array<{fetched: boolean, decoded: boolean, pinned: boolean}>} segmentStates - From getSegmentStates().
 * @returns {string} One digit ('0'-'7') per segment, in segment order.
 */
export function encodeSegmentStates(segmentStates) {
    let out = '';
    for (const segment of segmentStates) {
        let bits = 0;
        if (segment.fetched) {
            bits |= SEGMENT_FETCHED;
        }
        if (segment.decoded) {
            bits |= SEGMENT_DECODED;
        }
        if (segment.pinned) {
            bits |= SEGMENT_PINNED;
        }
        out += String(bits);
    }
    return out;
}

/**
 * Encodes segment geometry: where each segment sits on the timeline.
 *
 * Sent once per load, since segment count and boundaries never change
 * afterward. Times are fixed to millisecond precision -- a scrub bar is
 * positioned in whole pixels, so more digits would be noise.
 *
 * @param {Array<{startTime: number, endTime: number}>} segmentStates - From getSegmentStates().
 * @returns {string} `start,end;start,end;...` in segment order.
 */
export function encodeSegmentGeometry(segmentStates) {
    return segmentStates.map((segment) => `${segment.startTime.toFixed(3)},${segment.endTime.toFixed(3)}`).join(';');
}
