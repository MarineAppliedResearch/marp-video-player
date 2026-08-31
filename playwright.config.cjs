/**
 * Playwright configuration for the browser test suite.
 *
 * The suite is self-sufficient: it loads .env, downloads any missing test media
 * in globalSetup, and starts its own static server. `npm run test:e2e` is the
 * whole command -- there is no separate terminal to start and no file to
 * remember to fetch.
 *
 * Two Jellyfin servers are involved, deliberately:
 *
 *   MARP_MEDIA_JELLYFIN_*  the live server, read-only, used once to download
 *                          fixtures into .test-media/
 *   MARP_API_JELLYFIN_*    the development server, used by every test that
 *                          calls a Jellyfin API -- some of them write playback
 *                          state, which must never touch live
 *
 * @fileoverview Playwright configuration.
 * @author Isaac Travers
 * @module playwright.config
 */

const path = require('path');
const { defineConfig } = require('@playwright/test');

// Load .env if present. Committed as .env.example; a developer copies it once.
// dotenv ships with Playwright's dependency tree, and a missing file is not an
// error, so this stays optional.
try {
    require('dotenv').config({ path: path.join(__dirname, '.env') });
} catch {
    // dotenv unavailable: real environment variables still work.
}

/** Port the bundled static server listens on. Must match tools/serve.mjs. */
const PORT = Number(process.env.MARP_PLAYER_TEST_PORT) || 8099;

module.exports = defineConfig({
    testDir: './test/e2e',

    // Downloads test media before anything runs, and fails the run with an
    // actionable message if it cannot.
    globalSetup: require.resolve('./test/e2e/global-setup.cjs'),

    // Real decoding against a real server. Parallel workers would contend for
    // GPU decode surfaces and for Jellyfin transcode sessions.
    fullyParallel: false,
    workers: 1,
    retries: 0,

    // Generous: real segment fetch time against a Jellyfin server over a slow
    // connection has been observed taking 30s+ for a single segment (see
    // gop-decoder.js/segment-fetcher.js's own timeout comments).
    timeout: 120_000,

    use: {
        // Must end at the player page, not the server root: the specs call
        // page.goto('') and rely on this resolving to the player itself.
        baseURL: process.env.MARP_PLAYER_TEST_URL || `http://localhost:${PORT}/app/`,
        trace: 'retain-on-failure',
    },

    // Start the repository's own static server for the run. Reused if one is
    // already listening, so a manually started `npm run serve` is not fought
    // over.
    webServer: {
        command: `node tools/serve.mjs ${PORT}`,
        url: `http://localhost:${PORT}/app/index.html`,
        reuseExistingServer: true,
        timeout: 30_000,
        stdout: 'ignore',
        stderr: 'pipe',
    },

    reporter: [['list']],
});
