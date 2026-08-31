/**
 * Jest transformer that converts video-engine's ES module source to
 * CommonJS via esbuild, so it can run under plain Jest without adding
 * Babel to a codebase that otherwise has zero Babel usage.
 *
 * esbuild is already a project dependency (it builds the real browser
 * bundle in video-engine/build.js) -- reusing it here means the unit
 * tests exercise syntax handling from the same tool that ships the code,
 * rather than a second, independent transform pipeline.
 *
 * @fileoverview esbuild-backed Jest transformer, scoped to video-engine/src.
 * @author Isaac Travers
 * @module video-engine/test/unit/jest-esbuild-transform
 */

const esbuild = require('esbuild');

module.exports = {
    /**
     * Transforms one source file's contents for Jest.
     *
     * @param {string} sourceText - Original ES module source.
     * @param {string} sourcePath - Absolute path of the file being transformed.
     * @returns {{code: string}} CommonJS-equivalent source Jest can require().
     */
    process(sourceText, sourcePath) {
        const { code } = esbuild.transformSync(sourceText, {
            loader: 'js',
            format: 'cjs',
            target: 'node18',
            sourcefile: sourcePath,
        });

        return { code };
    },
};
