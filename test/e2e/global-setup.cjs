/**
 * Playwright global setup: make sure the test media exists before any test runs.
 *
 * Test media is downloaded once from the live Jellyfin server, read-only, and
 * cached in .test-media/. Downloading is the only thing this suite does against
 * the live server; every test that talks to a Jellyfin API points at the
 * development server instead, because some of them write playback state.
 *
 * The cache is git-ignored. It holds real survey footage and this repository is
 * public.
 *
 * Nothing here is a manual step. If the media is missing it is fetched; if it
 * is present the download is skipped; if it cannot be fetched the whole run
 * fails with a message naming what to configure.
 *
 * @fileoverview Downloads and caches test media before the E2E suite runs.
 * @author Isaac Travers
 * @module test/e2e/global-setup
 */

const { existsSync, mkdirSync, statSync, createWriteStream, renameSync, unlinkSync } = require('node:fs');
const { join } = require('node:path');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');

/** Where cached media lives. Git-ignored. */
const MEDIA_DIR = join(__dirname, '..', '..', '.test-media');

/**
 * Fixtures to have on hand, keyed by the local filename.
 *
 * Item ids come from the live Jellyfin library. Sizes are recorded so a
 * truncated download is detected rather than silently reused.
 */
const FIXTURES = {
    'short-1080p25.mp4': {
        itemId: process.env.MARP_FIXTURE_ITEM_SHORT || 'b24751c817e84b7fc2c090b70163d007',
        approxBytes: 2_829_000,
        description: '24s 1080p h264 25fps, small enough to fetch quickly',
    },
};

/**
 * Authenticates against a Jellyfin server and returns an access token.
 *
 * @async
 * @param {string} baseUrl - Jellyfin base URL.
 * @param {string} username - Account name.
 * @param {string} password - Account password.
 * @returns {Promise<string>} Access token.
 */
async function authenticate(baseUrl, username, password) {
    const auth = 'MediaBrowser Client="marp-video-player-tests", Device="global-setup", DeviceId="marp-e2e-setup", Version="1.0"';
    const res = await fetch(`${baseUrl}/Users/AuthenticateByName`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: auth },
        body: JSON.stringify({ Username: username, Pw: password }),
    });
    if (!res.ok) {
        throw new Error(`Jellyfin authentication failed (${res.status}) against ${baseUrl}`);
    }
    return (await res.json()).AccessToken;
}

/**
 * Downloads one fixture unless a plausible copy is already cached.
 *
 * Writes to a .part file and renames on success, so an interrupted download
 * never leaves a half file that looks complete on the next run.
 *
 * @async
 * @param {string} baseUrl - Jellyfin base URL to download from.
 * @param {string} token - Access token.
 * @param {string} filename - Local filename under .test-media/.
 * @param {Object} fixture - Entry from FIXTURES.
 * @returns {Promise<void>}
 */
async function ensureFixture(baseUrl, token, filename, fixture) {
    const target = join(MEDIA_DIR, filename);

    if (existsSync(target)) {
        const size = statSync(target).size;
        // Within 10% of the expected size is treated as a good copy.
        if (size > fixture.approxBytes * 0.9) {
            console.log(`  ${filename}: cached (${(size / 1048576).toFixed(1)} MB)`);
            return;
        }
        console.log(`  ${filename}: cached copy looks truncated (${size} bytes), refetching`);
        unlinkSync(target);
    }

    const url = `${baseUrl}/Videos/${fixture.itemId}/stream?static=true&api_key=${encodeURIComponent(token)}`;
    console.log(`  ${filename}: downloading ${fixture.description}`);

    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Download failed for item ${fixture.itemId} (${res.status})`);
    }

    const part = `${target}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
    renameSync(part, target);

    console.log(`  ${filename}: done (${(statSync(target).size / 1048576).toFixed(1)} MB)`);
}

/**
 * Playwright entry point.
 *
 * @async
 * @returns {Promise<void>}
 */
module.exports = async function globalSetup() {
    const baseUrl = process.env.MARP_MEDIA_JELLYFIN_URL;
    const username = process.env.MARP_MEDIA_JELLYFIN_USERNAME;
    const password = process.env.MARP_MEDIA_JELLYFIN_PASSWORD;

    if (!baseUrl || !username || !password) {
        throw new Error(
            'Test media cannot be fetched: set MARP_MEDIA_JELLYFIN_URL, '
            + 'MARP_MEDIA_JELLYFIN_USERNAME and MARP_MEDIA_JELLYFIN_PASSWORD. '
            + 'Copy .env.example to .env and fill it in.'
        );
    }

    mkdirSync(MEDIA_DIR, { recursive: true });
    console.log(`Test media in ${MEDIA_DIR}`);

    const token = await authenticate(baseUrl, username, password);
    for (const [filename, fixture] of Object.entries(FIXTURES)) {
        await ensureFixture(baseUrl, token, filename, fixture);
    }
};

module.exports.MEDIA_DIR = MEDIA_DIR;
module.exports.FIXTURES = FIXTURES;
