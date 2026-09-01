/**
 * The spinner appears as soon as a load starts, not once the engine exists.
 *
 * The spinner used to be driven entirely by engine events, and the listeners
 * were attached after `createMarpVideoEngine` resolved -- by which point the
 * slow part (negotiating, fetching the `moov` prefix, the first fetch and the
 * first decode) was over. A cold load therefore showed nothing at all for
 * several seconds and looked like a click that had not registered. See #9.
 *
 * The assertions are made against a recording rather than a live poll, because
 * "was it showing while nothing existed yet" is not something a poll can catch
 * reliably: a fast load would finish between the poll and the check. A
 * MutationObserver installed before the load records every state the spinner
 * passed through, and the recording is read afterwards.
 *
 * @fileoverview Loading-indicator tests.
 * @author Isaac Travers
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

/** This file's directory. ESM has no __dirname. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Downloaded by the global setup. */
const FIXTURE = process.env.MARP_LOCAL_FIXTURE
    || join(HERE, '..', '..', '.test-media', 'short-1080p25.mp4');

/** A cold 1080p GOP is megabytes to read and seconds to decode. */
const LOAD_TIMEOUT_MS = 90_000;

/**
 * Starts recording every change to the spinner's class list.
 *
 * Each entry notes whether the spinner was hidden, whether it was wearing the
 * green `decoding` variant, and whether an engine existed yet -- the last of
 * which is what distinguishes the fixed behaviour from the old one.
 *
 * @async
 * @param {Object} page - Playwright page.
 * @returns {Promise<void>}
 */
async function recordSpinnerStates(page) {
    await page.evaluate(() => {
        const spinner = document.querySelector('.marp-spinner');
        const logo = document.querySelector('.marp-logo');

        window.__spinnerStates = [];

        const record = () => {
            window.__spinnerStates.push({
                hidden: spinner.classList.contains('marp-hidden'),
                decoding: spinner.classList.contains('decoding'),
                // window.marpVideo is assigned once the engine has resolved,
                // so this is the moment the old implementation could first
                // have shown anything.
                engineExists: Boolean(window.marpVideo),
                logoShowing: logo.style.display !== 'none',
            });
        };

        record();
        new MutationObserver(record).observe(spinner, {
            attributes: true,
            attributeFilter: ['class'],
        });
    });
}

/**
 * Hands a file to the player the way the picker and the drop handler both do,
 * and resolves once the load has settled either way.
 *
 * @async
 * @param {Object} page - Playwright page.
 * @param {Array<number>} bytes - File contents.
 * @param {string} name - File name.
 * @returns {Promise<boolean>} Whether an engine came back.
 */
async function loadBytes(page, bytes, name) {
    return page.evaluate(
        async ({ bytes: data, name: filename }) => {
            const file = new File([new Uint8Array(data)], filename, { type: 'video/mp4' });
            const engine = await window.marpPlayer.loadFile(file);
            return Boolean(engine);
        },
        { bytes, name },
    );
}

test.describe('loading indicator', () => {
    test.describe.configure({ mode: 'serial' });

    test.beforeAll(() => {
        if (!existsSync(FIXTURE)) {
            throw new Error(`Fixture missing: ${FIXTURE}. The global setup should have downloaded it.`);
        }
    });

    test('the spinner is up while the engine is still being built', async ({ page }) => {
        test.setTimeout(LOAD_TIMEOUT_MS + 60_000);

        await page.goto('', { waitUntil: 'load' });

        const initiallyHidden = await page.evaluate(
            () => document.querySelector('.marp-spinner').classList.contains('marp-hidden'),
        );
        expect(initiallyHidden, 'no spinner before a load starts').toBe(true);

        await recordSpinnerStates(page);

        const loaded = await loadBytes(page, Array.from(readFileSync(FIXTURE)), 'short-1080p25.mp4');
        expect(loaded, 'the fixture loaded').toBe(true);

        const states = await page.evaluate(() => window.__spinnerStates);

        // The whole point: shown while there was no engine to raise an event.
        const shownBeforeEngine = states.filter((s) => !s.hidden && !s.engineExists);
        expect(shownBeforeEngine.length, 'spinner shown before the engine existed').toBeGreaterThan(0);

        // Blue, not green: at that point the wait is network, which is the
        // colour the scrub bar uses for fetched segments.
        expect(shownBeforeEngine[0].decoding, 'default colour, not the decoding variant').toBe(false);

        const finallyHidden = await page.evaluate(
            () => document.querySelector('.marp-spinner').classList.contains('marp-hidden'),
        );
        expect(finallyHidden, 'spinner gone once the first frame is up').toBe(true);
    });

    test('a load that fails stops the spinner and clears the picture', async ({ page }) => {
        test.setTimeout(LOAD_TIMEOUT_MS + 60_000);

        await page.goto('', { waitUntil: 'load' });

        const loaded = await loadBytes(page, Array.from(readFileSync(FIXTURE)), 'short-1080p25.mp4');
        expect(loaded, 'the fixture loaded first').toBe(true);

        const logoAfterLoad = await page.evaluate(
            () => document.querySelector('.marp-logo').style.display,
        );
        expect(logoAfterLoad, 'placeholder mark hidden once a video is up').toBe('none');

        await recordSpinnerStates(page);

        // Not an MP4 at all: the byte-range source finds no moov and throws,
        // which is the quickest honest failure to reach from here.
        const failed = await loadBytes(page, [0, 1, 2, 3, 4, 5, 6, 7], 'not-a-video.mp4');
        expect(failed, 'a file with no moov box does not load').toBe(false);

        const states = await page.evaluate(() => window.__spinnerStates);

        expect(states.some((s) => !s.hidden), 'spinner shown for the failed load too').toBe(true);

        const spinnerState = await page.evaluate(() => ({
            hidden: document.querySelector('.marp-spinner').classList.contains('marp-hidden'),
            logoShowing: document.querySelector('.marp-logo').style.display !== 'none',
            playShowing: !document.querySelector('.marp-center-overlay').classList.contains('marp-hidden'),
        }));

        // Left turning forever is the failure mode worth pinning.
        expect(spinnerState.hidden, 'spinner stopped after the failure').toBe(true);

        // The previous video's last frame is not the current video. Clearing to
        // the placeholder mark says so unambiguously.
        expect(spinnerState.logoShowing, 'picture cleared back to the placeholder mark').toBe(true);
        expect(spinnerState.playShowing, 'no play button over nothing').toBe(false);
    });
});
