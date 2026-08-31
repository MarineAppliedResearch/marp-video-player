/**
 * Pure segment-index math shared by both cache tiers: a fixed "protected
 * floor" around the current playhead, plus a direction-weighted priority
 * order for every candidate beyond it.
 *
 * Kept tier-agnostic on purpose -- Tier 1 (raw bytes) and Tier 2 (decoded
 * frames) call the exact same functions here with their own reach/skew
 * inputs and apply their own budget on top, rather than this module
 * branching on which tier or mode (playing/paused) is asking.
 *
 * @fileoverview Protected-floor and directional-priority-order math for the two-tier cache.
 * @module video-engine/cache-window
 */

/**
 * Returns the fixed, symmetric protected-floor segment indices around a
 * center segment -- never scaled by speed, never skewed by direction.
 *
 * @param {number} centerIndex - Segment index to center on.
 * @param {number} totalSegments - Total segment count in the stream.
 * @param {number} floorRadius - Segments protected on each side.
 * @returns {number[]} Protected segment indices, ascending, clamped to [0, totalSegments-1].
 */
export function computeProtectedFloor(centerIndex, totalSegments, floorRadius) {
    const start = Math.max(0, centerIndex - floorRadius);
    const end = Math.min(totalSegments - 1, centerIndex + floorRadius);
    const indices = [];
    for (let index = start; index <= end; index++) {
        indices.push(index);
    }
    return indices;
}

/**
 * Returns every segment index beyond a protected floor, in priority order
 * (nearest-to-the-floor first on each side), interleaved between the two
 * directions so the preferred side contributes `skewRatio` candidates for
 * every one contributed by the other side.
 *
 * Each side is independently capped by its own count (`preferredSideCount`/
 * `otherSideCount`) -- pass `Infinity` for a side that should reach to the
 * edge of the stream (Tier 1's whole-timeline reach has no fixed cap; only
 * a pacing limit applied later by the caller).
 *
 * @param {number} centerIndex - Segment index to center on.
 * @param {number} totalSegments - Total segment count in the stream.
 * @param {number[]} protectedIndices - This center's protected-floor indices (excluded from the result).
 * @param {number} directionSign - >= 0 treats higher indices as the preferred side; < 0 treats lower indices as preferred.
 * @param {number} skewRatio - Preferred-side candidates emitted per one other-side candidate (2 while directional/playing, 1 while symmetric/paused).
 * @param {number} preferredSideCount - Max candidates to consider on the preferred side.
 * @param {number} otherSideCount - Max candidates to consider on the other side.
 * @returns {number[]} Opportunistic segment indices, in descending priority order.
 */
export function computeOpportunisticOrder(
    centerIndex,
    totalSegments,
    protectedIndices,
    directionSign,
    skewRatio,
    preferredSideCount,
    otherSideCount,
) {
    const floorHighEdge = protectedIndices.length > 0 ? Math.max(...protectedIndices) : centerIndex;
    const floorLowEdge = protectedIndices.length > 0 ? Math.min(...protectedIndices) : centerIndex;

    const higherSide = [];
    for (let index = floorHighEdge + 1; index < totalSegments; index++) {
        higherSide.push(index);
    }
    const lowerSide = [];
    for (let index = floorLowEdge - 1; index >= 0; index--) {
        lowerSide.push(index);
    }

    const preferredCandidates = directionSign >= 0 ? higherSide : lowerSide;
    const otherCandidates = directionSign >= 0 ? lowerSide : higherSide;

    const preferred = Number.isFinite(preferredSideCount) ? preferredCandidates.slice(0, preferredSideCount) : preferredCandidates;
    const other = Number.isFinite(otherSideCount) ? otherCandidates.slice(0, otherSideCount) : otherCandidates;

    return _interleaveBySkew(preferred, other, skewRatio);
}

/**
 * Round-robin merges two priority-ordered lists, taking `skewRatio`
 * entries from `preferred` for every one entry from `other`, until both
 * are exhausted.
 *
 * @param {number[]} preferred - Preferred-side candidates, nearest first.
 * @param {number[]} other - Other-side candidates, nearest first.
 * @param {number} skewRatio - Preferred entries taken per other entry.
 * @returns {number[]} Merged priority order.
 */
function _interleaveBySkew(preferred, other, skewRatio) {
    const result = [];
    let preferredIndex = 0;
    let otherIndex = 0;

    while (preferredIndex < preferred.length || otherIndex < other.length) {
        for (let count = 0; count < skewRatio && preferredIndex < preferred.length; count++) {
            result.push(preferred[preferredIndex++]);
        }
        if (otherIndex < other.length) {
            result.push(other[otherIndex++]);
        }
    }

    return result;
}
