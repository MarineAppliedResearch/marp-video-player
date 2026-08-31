/**
 * Builds the video player's quality-tier menu from a probed Jellyfin media
 * source. Ports the scheme from docs/old_scripts_for_reference/jellyfin_client.cs's
 * BuildPlaybackOptions/AddTranscodeOptionIfUseful -- a small, curated set of
 * fixed tiers rather than jellyfin-web's full 12-entry bitrate ladder.
 *
 * Unlike that reference (a LibVLC client that can direct-play), every tier
 * here goes through the same HLS transcode negotiation our WebCodecs engine
 * requires -- there's no true zero-transcode passthrough available to us.
 * "Full" (renamed from that reference's "Original") means "transcode at the
 * source's own detected bitrate/resolution", not a genuine direct stream.
 * "Auto" is an alias for "Full" for now, pending real adaptive-bitrate logic.
 *
 * @fileoverview Quality-tier menu construction for the video player.
 */

const FIXED_TIERS = [
    { name: '1080p, 8 Mbps', maxStreamingBitrate: 8_000_000, maxWidth: 1920, maxHeight: 1080 },
    { name: '720p, 4 Mbps', maxStreamingBitrate: 4_000_000, maxWidth: 1280, maxHeight: 720 },
    { name: '480p, 1 Mbps', maxStreamingBitrate: 1_000_000, maxWidth: 854, maxHeight: 480 },
];

/**
 * Builds the quality-tier list for a probed media source. Each fixed tier is
 * only included when it's genuinely lower quality than the source -- no
 * point offering "1080p, 8 Mbps" upscaled from a 480p/2Mbps source.
 *
 * @param {Object} source - Result of JellyfinClient#probeMediaSource.
 * @param {number} source.bitrate - Source bitrate in bits/sec (0 if unknown).
 * @param {number} source.height - Source video height in pixels (0 if unknown).
 * @param {boolean} source.supportsTranscoding - Whether Jellyfin can transcode this source at all.
 * @returns {Array<{name: string, maxStreamingBitrate: number, maxWidth: number, maxHeight: number}>}
 */
export function getQualityOptions(source) {
    if (!source) {
        return [];
    }

    // Direct Play first, and therefore the default: it plays the original
    // file by byte range with no transcoder involved, so timing comes from
    // the file's own sample table rather than from HLS segment durations.
    // Offered regardless of supportsTranscoding, since it needs no
    // transcode at all -- what it does need is a codec this client can
    // decode, which only decode itself can establish.
    const options = [{ name: 'Direct Play', directPlay: true }];

    if (!source.supportsTranscoding) {
        return options;
    }

    options.push(
        {
            name: 'Auto',
            maxStreamingBitrate: source.bitrate || FIXED_TIERS[0].maxStreamingBitrate,
            maxWidth: source.width || FIXED_TIERS[0].maxWidth,
            maxHeight: source.height || FIXED_TIERS[0].maxHeight,
        },
        {
            name: 'Full',
            maxStreamingBitrate: source.bitrate || FIXED_TIERS[0].maxStreamingBitrate,
            maxWidth: source.width || FIXED_TIERS[0].maxWidth,
            maxHeight: source.height || FIXED_TIERS[0].maxHeight,
        },
    );

    for (const tier of FIXED_TIERS) {
        const bitrateIsUseful = !source.bitrate || tier.maxStreamingBitrate < source.bitrate;
        const heightIsUseful = !source.height || tier.maxHeight <= source.height;

        if (bitrateIsUseful && heightIsUseful) {
            options.push({ ...tier });
        }
    }

    return options;
}