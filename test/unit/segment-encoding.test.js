/**
 * Unit tests for the compact segment wire format a WebView2 host parses to
 * draw its own scrub bar shading.
 *
 * @fileoverview Tests for video-engine/src/segment-encoding.
 * @author Isaac Travers
 */

import {
    encodeSegmentStates,
    encodeSegmentGeometry,
    SEGMENT_FETCHED,
    SEGMENT_DECODED,
    SEGMENT_PINNED,
} from '../../src/segment-encoding.js';

/**
 * Builds a segment state object.
 *
 * @param {number} index - Segment index.
 * @param {Object} [flags] - fetched/decoded/pinned.
 * @returns {Object} Segment state shaped like getSegmentStates() entries.
 */
function segment(index, flags = {}) {
    return {
        index,
        startTime: index * 6,
        endTime: (index + 1) * 6,
        fetched: Boolean(flags.fetched),
        decoded: Boolean(flags.decoded),
        pinned: Boolean(flags.pinned),
    };
}

describe('encodeSegmentStates', () => {
    it('encodes one digit per segment, in segment order', () => {
        const encoded = encodeSegmentStates([segment(0), segment(1), segment(2)]);
        expect(encoded).toBe('000');
    });

    it('sets one bit per state', () => {
        expect(encodeSegmentStates([segment(0, { fetched: true })])).toBe(String(SEGMENT_FETCHED));
        expect(encodeSegmentStates([segment(0, { decoded: true })])).toBe(String(SEGMENT_DECODED));
        expect(encodeSegmentStates([segment(0, { pinned: true })])).toBe(String(SEGMENT_PINNED));
    });

    it('keeps the three states orthogonal rather than collapsing to a winner', () => {
        // "pinned but not yet decoded" and "pinned and decoded" must stay
        // distinguishable -- the built-in bar draws pinned as a ring over
        // the fill, and a host reproducing it needs the same distinction.
        const pinnedOnly = encodeSegmentStates([segment(0, { pinned: true, fetched: true })]);
        const pinnedDecoded = encodeSegmentStates([segment(0, { pinned: true, fetched: true, decoded: true })]);

        expect(pinnedOnly).toBe('5');
        expect(pinnedDecoded).toBe('7');
        expect(pinnedOnly).not.toBe(pinnedDecoded);
    });

    it('stays one byte per segment for a real-length stream', () => {
        // A 1354s clip at ~6s segments is ~226 segments; the whole point of
        // the digit encoding is that this stays a few hundred bytes per
        // tick rather than tens of kilobytes of JSON.
        const states = Array.from({ length: 226 }, (_, i) => segment(i, { fetched: true, decoded: i < 10 }));
        expect(encodeSegmentStates(states)).toHaveLength(226);
    });

    it('returns an empty string for no segments', () => {
        expect(encodeSegmentStates([])).toBe('');
    });
});

describe('encodeSegmentGeometry', () => {
    it('encodes start,end pairs separated by semicolons', () => {
        expect(encodeSegmentGeometry([segment(0), segment(1)])).toBe('0.000,6.000;6.000,12.000');
    });

    it('keeps millisecond precision for non-uniform segment durations', () => {
        const uneven = [
            { startTime: 0, endTime: 6.006 },
            { startTime: 6.006, endTime: 10.5 },
        ];
        expect(encodeSegmentGeometry(uneven)).toBe('0.000,6.006;6.006,10.500');
    });

    it('contains no pipe, so it cannot break the host message split', () => {
        const states = Array.from({ length: 50 }, (_, i) => segment(i));
        expect(encodeSegmentGeometry(states)).not.toContain('|');
    });
});
