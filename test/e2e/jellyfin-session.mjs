/**
 * Shared Jellyfin configuration and session helper for the browser suite.
 *
 * Every test that calls a Jellyfin API uses the DEVELOPMENT server. Two of
 * them write server-side state -- playback reporting records resume positions,
 * and behind sessions open transcode sessions -- so live is never a valid
 * target for these.
 *
 * Fixture downloads are the only thing that touches the live server, and that
 * happens in global-setup.cjs.
 *
 * @fileoverview Jellyfin helpers for the E2E suite.
 * @author Isaac Travers
 * @module test/e2e/jellyfin-session
 */

/** Development Jellyfin server the API tests run against. */
export const JELLYFIN = {
    url: process.env.MARP_API_JELLYFIN_URL,
    username: process.env.MARP_API_JELLYFIN_USERNAME,
    password: process.env.MARP_API_JELLYFIN_PASSWORD,
    itemId: process.env.MARP_API_JELLYFIN_ITEM || 'fb6a3c0fbd5e073d40e0840b9a54b79c',
};

/**
 * Explains what is missing, or null when the configuration is complete.
 *
 * Used to fail a suite with an actionable message rather than let it die on a
 * confusing timeout deep inside a page.
 *
 * @returns {?string} Message naming the unset variables, or null.
 */
export function missingJellyfinConfig() {
    const missing = [];
    if (!JELLYFIN.url) missing.push('MARP_API_JELLYFIN_URL');
    if (!JELLYFIN.username) missing.push('MARP_API_JELLYFIN_USERNAME');
    if (!JELLYFIN.password) missing.push('MARP_API_JELLYFIN_PASSWORD');
    if (missing.length === 0) return null;
    return `${missing.join(', ')} not set. Copy .env.example to .env and point it at the development Jellyfin server.`;
}

/**
 * Signs in to Jellyfin from inside a loaded player page and returns the
 * session a host would already hold.
 *
 * Done in the browser rather than in Node so it exercises the library's own
 * JellyfinClient, which is what a real consumer uses.
 *
 * @async
 * @param {Object} page - Playwright page with the player loaded.
 * @returns {Promise<{serverUrl: string, token: string, userId: string}>} Session.
 */
export async function jellyfinSession(page) {
    return page.evaluate(
        async ({ server, user, pass }) => {
            const client = new window.MarpVideoEngine.JellyfinClient();
            await client.login(server, user, pass);
            return { serverUrl: client.serverUrl, token: client.accessToken, userId: client.userId };
        },
        { server: JELLYFIN.url, user: JELLYFIN.username, pass: JELLYFIN.password },
    );
}

/**
 * Builds the query string `player.html` expects for a Jellyfin item.
 *
 * @param {Object} session - Result of jellyfinSession.
 * @param {string} itemId - Jellyfin item id.
 * @param {Object} [extra] - Additional query parameters.
 * @returns {string} Encoded query string, without the leading `?`.
 */
export function playerQuery(session, itemId, extra = {}) {
    const params = new URLSearchParams({
        server: session.serverUrl,
        token: session.token,
        user: session.userId,
        item: itemId,
        ...extra,
    });
    return params.toString();
}
