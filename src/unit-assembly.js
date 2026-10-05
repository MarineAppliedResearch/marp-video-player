/**
 * The rules for building a unit from frames that arrived under another unit's label.
 *
 * Jellyfin 10.11 starts a transcode that begins partway into a file with ffmpeg's
 * `-noaccurate_seek`, so the job begins at the source keyframe at or before the
 * requested segment -- up to one source GOP early, ten seconds on MARP's dives -- while
 * still labelling its output as the requested segment. Every later segment of that job
 * carries the same shift. The frames' own timestamps are the true source times; only the
 * labels are wrong. A job that starts at 0 has no shift.
 *
 * So a unit is built from the decoded frames whose own timestamps fall inside its
 * playlist time range, wherever they arrived. Everything here is pure: no decoder, no
 * network, no frames -- timestamps and the unit index only.
 *
 * @fileoverview Pure rules for assembling units by their frames' own timestamps.
 * @module video-engine/unit-assembly
 */

import { findSegmentForTime } from './playlist-manager.js';

/**
 * A frame exactly on a unit boundary belongs to the later unit, even after the
 * microsecond timestamp and the playlist's seconds disagree in the last digit.
 */
const BOUNDARY_TOLERANCE_SECONDS = 1e-4;

/**
 * How far a segment's first frame sits before its own playlist start, in seconds.
 *
 * Positive for a cold-started Jellyfin job: its output began at an earlier keyframe.
 *
 * @param {{startTime: number}} segment - The segment the bytes were fetched as.
 * @param {number} firstFrameTimestampMicros - The first decoded frame's own timestamp.
 * @returns {number} The shift in seconds.
 */
export function segmentShiftSeconds(segment, firstFrameTimestampMicros) {
    return segment.startTime - firstFrameTimestampMicros / 1e6;
}

/**
 * True when a shift is more than half a frame: the segment does not hold its own time.
 *
 * @param {number} shiftSeconds - From {@link segmentShiftSeconds}.
 * @param {number} frameIntervalSeconds - One frame's duration.
 * @returns {boolean}
 */
export function isShifted(shiftSeconds, frameIntervalSeconds) {
    return Math.abs(shiftSeconds) > frameIntervalSeconds / 2;
}

/**
 * The unit a frame belongs to, by its own timestamp.
 *
 * @param {{segments: Array<Object>}} unitIndex - The engine's unit index.
 * @param {number} timestampMicros - The frame's own timestamp.
 * @returns {number} The unit's index.
 */
export function unitForTimestamp(unitIndex, timestampMicros) {
    return findSegmentForTime(unitIndex, timestampMicros / 1e6 + BOUNDARY_TOLERANCE_SECONDS).index;
}

/**
 * Whether a unit's frames cover its whole time range, and if not, the first time missing.
 *
 * Covered means no frame is missing at the start, between two frames, or at the end: a
 * unit's range need not begin on a frame, so its first frame may sit up to one frame
 * interval after its start. The time missing is the next frame's, one whole interval
 * after the last present -- half an interval still lands inside the segment that
 * supplied the last frame, which would be fetched again for nothing.
 *
 * @param {Array<number>} timestampsMicros - The unit's frames' timestamps, ascending.
 * @param {{startTime: number, endTime: number}} unit - The unit.
 * @param {number} frameIntervalSeconds - One frame's duration.
 * @returns {{complete: boolean, missingFromSeconds: (number|null)}}
 */
export function unitCoverage(timestampsMicros, unit, frameIntervalSeconds) {
    const interval = frameIntervalSeconds;
    if (timestampsMicros.length === 0) {
        return { complete: false, missingFromSeconds: unit.startTime };
    }

    const times = timestampsMicros.map((t) => t / 1e6);
    if (times[0] - unit.startTime >= interval - BOUNDARY_TOLERANCE_SECONDS) {
        return { complete: false, missingFromSeconds: unit.startTime };
    }
    for (let i = 1; i < times.length; i++) {
        if (times[i] - times[i - 1] > interval * 1.5) {
            return { complete: false, missingFromSeconds: times[i - 1] + interval };
        }
    }
    const last = times[times.length - 1];
    if (unit.endTime - last > interval + BOUNDARY_TOLERANCE_SECONDS) {
        return { complete: false, missingFromSeconds: last + interval };
    }
    return { complete: true, missingFromSeconds: null };
}

/**
 * The segment most likely to hold a given true time, from what the last segment decoded
 * actually held.
 *
 * A job's output is continuous: the next segment's frames start where the last one's
 * ended, and every segment holds the same number of frames. That is not the same as its
 * labels, which can be a hair longer than their content -- 3.0067 s labels over 3.000 s of
 * frames on a 24.946 fps-average dive -- so adding a shift to the label times drifts a
 * segment a minute, and names the same segment again at the edge of it.
 *
 * @param {number} trueTimeSeconds - The time wanted.
 * A time after the last segment's final frame is in the next segment, even when it is
 * still inside that frame's interval: a unit can begin between two frames -- 598.39 s,
 * between 598.36 and 598.40 -- and asking for the same segment again found nothing new.
 *
 * @param {{segment: number, firstSeconds: number, lastFrameSeconds: number, endSeconds: number}} last
 *   The last segment decoded: its index, its first and final frames' times, and the time
 *   just after its final frame.
 * @param {number} segmentCount - How many segments the stream has.
 * @returns {number} The segment's index.
 */
export function segmentAfter(trueTimeSeconds, last, segmentCount) {
    const span = last.endSeconds - last.firstSeconds;
    let segment = last.segment;
    if (trueTimeSeconds > last.lastFrameSeconds + BOUNDARY_TOLERANCE_SECONDS) {
        segment = last.segment + 1 + Math.max(0, Math.floor((trueTimeSeconds - last.endSeconds) / span + BOUNDARY_TOLERANCE_SECONDS));
    } else if (trueTimeSeconds < last.firstSeconds - BOUNDARY_TOLERANCE_SECONDS) {
        segment = last.segment - Math.ceil((last.firstSeconds - trueTimeSeconds) / span - BOUNDARY_TOLERANCE_SECONDS);
    }
    return Math.max(0, Math.min(segmentCount - 1, segment));
}

/**
 * The segment most likely to hold a given true time, for a job shifted by `shiftSeconds`.
 *
 * A job shifted by `d` holds true time `t` in the segment labelled `t + d`.
 *
 * @param {{segments: Array<Object>}} unitIndex - The engine's unit index.
 * @param {number} trueTimeSeconds - The time wanted.
 * @param {number} shiftSeconds - The job's shift; 0 for an unshifted one.
 * @returns {number} The segment's index.
 */
export function segmentHolding(unitIndex, trueTimeSeconds, shiftSeconds) {
    return findSegmentForTime(unitIndex, trueTimeSeconds + shiftSeconds + BOUNDARY_TOLERANCE_SECONDS).index;
}
