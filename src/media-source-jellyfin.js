/**
 * Builds the right media source for a Jellyfin item.
 *
 * This is the entry point a consumer should use: it decides between Direct
 * Play and a transcode, negotiates whatever that choice needs, and hands
 * back a source ready for createMarpVideoEngine. Consumers should not be
 * probing quality tiers, negotiating stream URLs or knowing that transcode
 * sessions exist -- that is what made the browser app the only place the
 * player fully worked.
 *
 * @fileoverview Jellyfin source selection and negotiation.
 * @module video-engine/media-source-jellyfin
 */

import { JellyfinDirectPlayMediaSource } from './media-source-jellyfin-directplay.js';
import { JellyfinTranscodeMediaSource, JellyfinMediaSource } from './media-source-jellyfin-transcode.js';

/**
 * Creates a media source for a Jellyfin item.
 *
 * Direct Play is the default: it reads the original file by byte range, so
 * timing comes from the container itself and no transcoder is involved. A
 * transcode is the fallback for media this client cannot decode, or a link
 * too slow for the original bitrate.
 *
 * The transcode source is given the client and item id as well as its
 * stream URL, which is what lets it negotiate and maintain its own behind
 * sessions -- without those, reverse playback on that path asks one
 * sequential transcoder to seek backwards and pays a restart every time.
 *
 * @async
 * @param {Object} params
 * @param {import('./jellyfin-client.js').JellyfinClient} params.client - An authenticated client.
 * @param {string} params.itemId - Jellyfin item id.
 * @param {('directPlay'|'transcode')} [params.prefer='directPlay'] - Which path to use.
 * @param {Object} [params.qualityOption] - Transcode tier; defaults to the first non-Direct-Play tier offered.
 * @param {number} [params.rawSegmentCacheBudgetBytes] - Raw-bytes cache budget.
 * @param {function(string): void} [params.onDebug] - Progress messages.
 * @param {function(Error): void} [params.onError] - Fetch failures.
 * @returns {Promise<{mediaSource: Object, maxConcurrentFetches: (number|undefined), qualityOption: (Object|undefined)}>} Ready to spread into createMarpVideoEngine's options.
 * @throws {Error} When a transcode is asked for and the item offers no transcode tier.
 */
export async function createJellyfinSource({
    client,
    itemId,
    prefer = 'directPlay',
    qualityOption,
    rawSegmentCacheBudgetBytes,
    onDebug,
    onError,
}) {
    if (prefer === 'directPlay') {
        return {
            mediaSource: new JellyfinDirectPlayMediaSource({ client, itemId, rawSegmentCacheBudgetBytes, onDebug, onError }),
            // Stateless and randomly addressable: no session to overload, so
            // the engine's own default concurrency applies.
            maxConcurrentFetches: undefined,
        };
    }

    const negotiator = new JellyfinMediaSource(client);
    let tier = qualityOption;
    if (!tier) {
        const options = await negotiator.probeQualityOptions(itemId);
        tier = options.find((option) => !option.directPlay);
        if (!tier) {
            throw new Error('Jellyfin offers no transcode tier for this item.');
        }
    }

    const streamUrl = await negotiator.resolveStreamUrl(itemId, tier);

    const source = new JellyfinTranscodeMediaSource({
            streamUrl,
            rawSegmentCacheBudgetBytes,
            onDebug,
            onError,
            // These are what let the source run its own behind sessions.
        client,
        itemId,
        qualityOption: tier,
    });
    // Jellyfin identifies a playback report by the ids of the negotiation
    // that produced the stream, so the source needs them to report at all.
    source.setPlaybackSession({
        mediaSourceId: negotiator._negotiation.mediaSourceId,
        playSessionId: negotiator._negotiation.playSessionId,
    });

    return {
        mediaSource: source,
        maxConcurrentFetches: negotiator.maxConcurrentFetches,
        qualityOption: tier,
    };
}
