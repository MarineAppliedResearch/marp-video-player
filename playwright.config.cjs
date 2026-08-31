/**
 * @playwright/test configuration for the video-engine's browser-driven E2E
 * suite -- real Chromium against the real running dev server and real
 * Jellyfin server (see test/e2e/playback.spec.js).
 *
 * Deliberately serial (workers: 1, fullyParallel: false): every test
 * drives the same live Jellyfin server, and concurrent transcode
 * negotiations from parallel workers would multiply real server load and
 * session count for no benefit -- this suite exists to validate real
 * decode/timing behavior, not to run fast.
 *
 * @fileoverview @playwright/test config for video-engine/test/e2e.
 * @author Isaac Travers
 * @module video-engine/playwright.config
 */
const path = require('path');
// No dotenv: this repository is standalone. Configure via real environment
// variables, or run `npm run harness` and use its default URL.
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
    testDir: './test/e2e',
    fullyParallel: false,
    workers: 1,
    retries: 0,
    // Generous: real segment fetch time against the live Jellyfin server
    // over a slow connection has been observed taking 30s+ for a single
    // segment (see gop-decoder.js/segment-fetcher.js's own timeout comments).
    timeout: 120_000,
    use: {
        baseURL: process.env.MARP_PLAYER_TEST_URL || 'http://localhost:4173/',
        trace: 'retain-on-failure',
    },
    reporter: [['list']],
});
