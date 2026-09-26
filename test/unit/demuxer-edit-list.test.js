/**
 * Unit tests for the edit-list offset the demuxer applies to sample times.
 *
 * Jellyfin's transcode init segment carries a video edit list starting at 1024 of 12800
 * ticks -- the two-frame reorder delay of a B-frame stream. Without it every picture sat
 * two frames earlier than the time it was shown at (issue #20), and every transcode segment
 * looked 0.08 s off its own label.
 *
 * @fileoverview Unit tests for demuxer.js presentationOffsetTicks.
 * @module video-engine/test/unit/demuxer-edit-list.test
 */

const { presentationOffsetTicks } = require('../../src/demuxer.js');

/** An mp4box file stand-in holding one track with these edit-list entries. */
const fileWith = (entries) => ({
    getTrackById: () => (entries === undefined ? {} : { edts: { elst: { entries } } }),
});

describe('the presentation offset from a track\'s edit list', () => {
    test('is the edit list\'s start, in the track\'s ticks -- Jellyfin\'s transcode is 1024', () => {
        expect(presentationOffsetTicks(fileWith([{ segment_duration: 0, media_time: 1024 }]), 1)).toBe(1024);
    });

    test('is 0 for a track with no edit list, or one starting at 0', () => {
        expect(presentationOffsetTicks(fileWith(undefined), 1)).toBe(0);
        expect(presentationOffsetTicks(fileWith([{ segment_duration: 0, media_time: 0 }]), 2)).toBe(0);
    });

    test('skips an empty edit, which is a delay rather than a start', () => {
        expect(presentationOffsetTicks(fileWith([{ segment_duration: 500, media_time: -1 }, { segment_duration: 0, media_time: 1536 }]), 1)).toBe(1536);
    });
});
