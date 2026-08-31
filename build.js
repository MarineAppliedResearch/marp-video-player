/**
 * Bundles the player into the outputs a consumer can load.
 *
 * Three outputs, because consumers differ:
 *
 *   marp-video-player.js             ESM. For bundlers and for
 *                                    `import { createMarpVideoPlayer } from
 *                                    'marp-video-player'`.
 *   marp-video-player.iife.js        IIFE exposing the `MarpVideoPlayer`
 *                                    global. For a plain <script> tag with no
 *                                    build step.
 *   marp-video-player.standalone.js  IIFE, minified, everything inlined. For
 *                                    the C# WebView2 host, which needs one
 *                                    file with no sibling assets and no
 *                                    relative paths that could break inside a
 *                                    virtual-host mapping.
 *
 * The player UI (markup, stylesheet, and the placeholder mark as an inlined
 * data URI in src/ui/logo.js) is compiled into every output, so a consumer
 * copying one script gets a complete working player.
 *
 * assets/ remains the source of truth for the mark; it is not copied next to
 * the bundles.
 *
 * @fileoverview esbuild bundler for marp-video-player.
 * @author Isaac Travers
 * @module build
 */

import esbuild from 'esbuild';
import path from 'node:path';
import { mkdirSync, copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'dist');
const appDistDir = path.join(here, 'app', 'dist');
const entry = path.join(here, 'src', 'index.js');

/**
 * The IIFE global stays `MarpVideoEngine` rather than matching the package
 * name. The C# WebView2 host and the pages in app/ both reference
 * `window.MarpVideoEngine`, and extracting this package is not the moment to
 * break that contract.
 */
const GLOBAL_NAME = 'MarpVideoEngine';

/** Shared across every output. */
const common = {
    entryPoints: [entry],
    bundle: true,
    target: ['chrome94'],
    sourcemap: true,
    logLevel: 'info',
};

/**
 * Builds all three outputs.
 *
 * @async
 * @returns {Promise<void>}
 */
async function build() {
    await esbuild.build({
        ...common,
        format: 'esm',
        outfile: path.join(outDir, 'marp-video-player.js'),
    });

    await esbuild.build({
        ...common,
        format: 'iife',
        globalName: GLOBAL_NAME,
        outfile: path.join(outDir, 'marp-video-player.iife.js'),
    });

    await esbuild.build({
        ...common,
        format: 'iife',
        globalName: GLOBAL_NAME,
        minify: true,
        outfile: path.join(outDir, 'marp-video-player.standalone.js'),
    });

    // The pages in app/ and the WebView2 host load the bundle as
    // `dist/marp-video-engine.js` relative to the page. Keep that exact path
    // and filename so the host integration and the diagnostic page keep
    // working unchanged.
    mkdirSync(appDistDir, { recursive: true });
    copyFileSync(
        path.join(outDir, 'marp-video-player.iife.js'),
        path.join(appDistDir, 'marp-video-engine.js')
    );
    copyFileSync(
        path.join(outDir, 'marp-video-player.iife.js.map'),
        path.join(appDistDir, 'marp-video-engine.js.map')
    );
    console.log('  app/dist/marp-video-engine.js  (compatibility copy for app pages and the WebView2 host)');
}

build().catch((err) => {
    console.error(err);
    process.exit(1);
});
