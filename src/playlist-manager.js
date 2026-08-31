/**
 * Minimal HLS playlist loading/parsing for a single-variant, VOD, CMAF/fMP4
 * Jellyfin transcode stream.
 *
 * Deliberately hand-written rather than reusing hls.js: the manifest shape
 * needed here is tiny (one variant, VOD, keyframe-aligned, one init
 * segment -- no ABR, live-reload, discontinuities, or encryption to
 * handle), and hls.js's parser isn't cleanly separable from its CDN bundle
 * without depending on undocumented internals.
 *
 * @fileoverview Hand-written HLS master/media playlist parser producing an immutable SegmentIndex.
 * @author Isaac Travers
 * @module video-engine/playlist-manager
 */

/** Max time to wait for a playlist fetch, in ms -- see segment-fetcher.js's FETCH_TIMEOUT_MS for why this exists at all (a stuck fetch must fail loudly, not hang forever). */
const FETCH_TIMEOUT_MS = 60000;

/**
 * Fetches a URL as text, following redirects transparently, with a
 * timeout so a genuinely stuck request fails with a clear error instead
 * of hanging forever.
 *
 * `response.url` reflects the final URL reached (e.g. MARP's stream
 * endpoint 302-ing to Jellyfin's own master.m3u8) -- confirmed live, no
 * need for `redirect: 'manual'` (which would return an opaque, unreadable
 * response cross-origin anyway).
 *
 * @async
 * @param {string} url - URL to fetch.
 * @param {Object} [fetchOptions] - Extra options passed through to fetch() (e.g. headers).
 * @returns {Promise<{text: string, finalUrl: string}>} Response body and the final URL after redirects.
 * @throws {Error} When the response is not ok, or the request times out.
 */
async function fetchText(url, fetchOptions) {
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response;
    try {
        response = await fetch(url, { ...fetchOptions, signal: controller.signal });
    } catch (err) {
        if (err.name === 'AbortError') {
            throw new Error(`Playlist fetch timed out after ${FETCH_TIMEOUT_MS}ms: ${url}`);
        }
        throw err;
    } finally {
        clearTimeout(timeoutHandle);
    }

    if (!response.ok) {
        throw new Error(`Failed to fetch playlist (${response.status} ${response.statusText}): ${url}`);
    }

    const text = await response.text();
    return { text, finalUrl: response.url };
}

/**
 * Resolves a possibly-relative playlist URI against its containing
 * playlist's URL.
 *
 * @param {string} maybeRelative - URI as it appears in the playlist.
 * @param {string} baseUrl - Absolute URL of the playlist that referenced it.
 * @returns {string} Absolute URL.
 */
function resolveUrl(maybeRelative, baseUrl) {
    return new URL(maybeRelative, baseUrl).toString();
}

/**
 * Parses a comma-separated KEY=VALUE attribute list, honoring quoted
 * strings (e.g. the tag body of `#EXT-X-STREAM-INF:` or `#EXT-X-MAP:`).
 *
 * @param {string} line - Attribute-list portion of a playlist tag, after its colon.
 * @returns {Object<string, string>} Parsed attributes, keyed by attribute name.
 */
function parseAttributeList(line) {
    const attrs = {};
    const regex = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
    let match;

    while ((match = regex.exec(line)) !== null) {
        let value = match[2];
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
        }
        attrs[match[1]] = value;
    }

    return attrs;
}

/**
 * Finds the first (only, for this engine's single-variant streams) media
 * playlist URI referenced by a master playlist.
 *
 * @param {string} text - Master playlist body.
 * @param {string} baseUrl - Absolute URL the master playlist was fetched from.
 * @returns {string|null} Absolute media playlist URL, or null if none was found.
 */
function parseMasterPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (!line.startsWith('#EXT-X-STREAM-INF:')) {
            continue;
        }

        for (let j = i + 1; j < lines.length; j++) {
            const candidate = lines[j].trim();
            if (candidate && !candidate.startsWith('#')) {
                return resolveUrl(candidate, baseUrl);
            }
        }
    }

    return null;
}

/**
 * Parses a VOD media playlist into an immutable SegmentIndex.
 *
 * Cumulative startTime/endTime come from each segment's real #EXTINF
 * value -- never assumed-uniform, since the tail segment is typically
 * shorter than the rest (e.g. 0.168s vs. a nominal 3.000s).
 *
 * @param {string} text - Media playlist body.
 * @param {string} baseUrl - Absolute URL the media playlist was fetched from.
 * @returns {Object} SegmentIndex: `{initSegmentUrl, segments: [{index, url, duration, startTime, endTime}], totalDuration}`.
 * @throws {Error} When the playlist has no #EXT-X-MAP init segment or no segments.
 */
function parseMediaPlaylist(text, baseUrl) {
    const lines = text.split(/\r?\n/);
    let initSegmentUrl = null;
    let pendingDuration = null;
    let cumulativeTime = 0;
    const segments = [];

    for (const rawLine of lines) {
        const line = rawLine.trim();

        if (!line) {
            continue;
        }

        if (line.startsWith('#EXT-X-MAP:')) {
            const attrs = parseAttributeList(line.slice('#EXT-X-MAP:'.length));
            if (attrs.URI) {
                initSegmentUrl = resolveUrl(attrs.URI, baseUrl);
            }
            continue;
        }

        if (line.startsWith('#EXTINF:')) {
            pendingDuration = parseFloat(line.slice('#EXTINF:'.length).split(',')[0]);
            continue;
        }

        if (line.startsWith('#')) {
            continue;
        }

        if (pendingDuration !== null) {
            const startTime = cumulativeTime;
            const duration = pendingDuration;
            segments.push({
                index: segments.length,
                url: resolveUrl(line, baseUrl),
                duration,
                startTime,
                endTime: startTime + duration,
            });
            cumulativeTime += duration;
            pendingDuration = null;
        }
    }

    if (!initSegmentUrl) {
        throw new Error('Media playlist has no #EXT-X-MAP init segment -- required for fMP4/CMAF demuxing.');
    }

    if (segments.length === 0) {
        throw new Error('Media playlist has no segments.');
    }

    return { initSegmentUrl, segments, totalDuration: cumulativeTime };
}

/**
 * Loads a SegmentIndex starting from a MARP stream-negotiation URL.
 *
 * Follows the redirect from e.g. `/api/v2/jellyfin/items/:id/stream?mode=Transcode`
 * to Jellyfin's own master.m3u8, then fetches the single media playlist it
 * references.
 *
 * `fetchOptions` (typically an `Authorization` header for MARP) is applied
 * ONLY to this first request, to MARP's own endpoint. Every URL after
 * that -- the media playlist, init segment, and media segments -- is a
 * Jellyfin URL that already carries its own embedded API key and needs no
 * auth header; sending one anyway would make those into cross-origin
 * requests with a custom header, forcing a CORS preflight that Jellyfin
 * isn't guaranteed to answer -- confirmed live to hang the fetch()
 * indefinitely with no error ever surfacing, rather than failing fast.
 *
 * @async
 * @param {string} streamUrl - MARP stream-negotiation URL.
 * @param {Object} [options]
 * @param {Object} [options.fetchOptions] - Extra fetch() options (e.g. an Authorization header) applied only to the initial MARP request.
 * @returns {Promise<Object>} The parsed SegmentIndex.
 * @throws {Error} When the master playlist has no variant, or the media playlist is malformed.
 */
export async function loadSegmentIndex(streamUrl, { fetchOptions } = {}) {
    const { text: masterText, finalUrl: masterUrl } = await fetchText(streamUrl, fetchOptions);
    const mediaPlaylistUrl = parseMasterPlaylist(masterText, masterUrl);

    if (!mediaPlaylistUrl) {
        throw new Error('Master playlist has no #EXT-X-STREAM-INF variant.');
    }

    // No fetchOptions here -- this is a direct Jellyfin URL (see doc comment above).
    const { text: mediaText, finalUrl: mediaUrl } = await fetchText(mediaPlaylistUrl);
    return parseMediaPlaylist(mediaText, mediaUrl);
}

/**
 * Locates the segment covering a given time.
 *
 * Uses a fast uniform-duration guess, verified (not trusted) against the
 * segment's real start/end before falling back to a linear scan -- the
 * tail segment is often shorter than the rest, so the guess alone isn't
 * reliable near the end.
 *
 * @param {Object} segmentIndex - SegmentIndex from {@link loadSegmentIndex}.
 * @param {number} targetTime - Target time, in seconds.
 * @returns {Object} The segment entry covering targetTime (clamped to the first/last segment if out of range).
 */
export function findSegmentForTime(segmentIndex, targetTime) {
    const { segments } = segmentIndex;

    if (targetTime <= 0) {
        return segments[0];
    }

    const last = segments[segments.length - 1];
    if (targetTime >= last.endTime) {
        return last;
    }

    const nominalDuration = segments[0].duration;
    const guessIndex = Math.min(segments.length - 1, Math.max(0, Math.floor(targetTime / nominalDuration)));
    const guess = segments[guessIndex];

    if (guess.startTime <= targetTime && targetTime < guess.endTime) {
        return guess;
    }

    for (const segment of segments) {
        if (segment.startTime <= targetTime && targetTime < segment.endTime) {
            return segment;
        }
    }

    return last;
}

export { parseMasterPlaylist, parseMediaPlaylist, resolveUrl };
