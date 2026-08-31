/**
 * Jest configuration for video-engine's unit test tier.
 *
 * Deliberately separate from the repo root's jest.config.js: that config
 * runs the DB-backed API suite in plain CommonJS, while video-engine/src
 * is ES modules transformed on the fly via esbuild (see
 * test/unit/jest-esbuild-transform.cjs) -- keeping the two configs apart
 * means neither suite's settings (environment, transform, timeout) leaks
 * into the other.
 *
 * Covers only test/unit/ -- test/e2e/ is a separate @playwright/test
 * suite (real browser, real Jellyfin server), run via `npm run
 * test:video-engine:e2e`, not through Jest at all.
 *
 * @fileoverview Jest configuration for video-engine's Node-only unit tests.
 * @author Isaac Travers
 * @module video-engine/jest.config
 */
module.exports = {
    rootDir: __dirname,

    testEnvironment: 'node',

    testMatch: ['<rootDir>/test/unit/**/*.test.js'],

    transform: {
        '^.+\\.js$': '<rootDir>/test/unit/jest-esbuild-transform.cjs',
    },
};
