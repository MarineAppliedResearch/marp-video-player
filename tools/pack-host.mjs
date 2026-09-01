/**
 * Packs the host archive: the artifact a native host consumes.
 *
 * A JavaScript project installs this package from npm and configures the
 * player in code. A native host cannot -- WebView2 and its equivalents
 * navigate to a URL, so they need `player.html`, which translates query
 * parameters into player options, plus the bundle that page loads.
 *
 * Those two files must version together. The page loads the bundle by a
 * relative path, so shipping them separately eventually pairs a new page with
 * an old bundle, and the failure is silent.
 *
 * Layout inside the archive mirrors the repository, so `player.html` needs no
 * edit when packaged:
 *
 *     player.html
 *     dist/marp-video-player.standalone.js
 *     dist/marp-video-player.standalone.js.map
 *     VERSION
 *     LICENSE
 *     NOTICE
 *
 * Usage: npm run pack:host      (after npm run build)
 *
 * @fileoverview Builds the release archive for native hosts.
 * @author Isaac Travers
 * @module tools/pack-host
 */

import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const distDir = path.join(root, 'dist');
const stageDir = path.join(root, 'release', 'host');
const outDir = path.join(root, 'release');

const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

/** Files that go in, relative to the repository root, mapped to their place in the archive. */
const CONTENTS = [
    ['app/player.html', 'player.html'],
    ['dist/marp-video-player.standalone.js', 'dist/marp-video-player.standalone.js'],
    ['dist/marp-video-player.standalone.js.map', 'dist/marp-video-player.standalone.js.map'],
    ['LICENSE', 'LICENSE'],
    ['NOTICE', 'NOTICE'],
];

if (!existsSync(distDir)) {
    console.error('dist/ is missing. Run `npm run build` first.');
    process.exit(1);
}

mkdirSync(path.join(stageDir, 'dist'), { recursive: true });

for (const [from, to] of CONTENTS) {
    const source = path.join(root, from);
    if (!existsSync(source)) {
        console.error(`Missing ${from}. Run \`npm run build\` first.`);
        process.exit(1);
    }
    writeFileSync(path.join(stageDir, to), readFileSync(source));
}

// A consumer that has unpacked this needs to be able to answer "which version
// is this?" without going back to where it came from.
writeFileSync(
    path.join(stageDir, 'VERSION'),
    `marp-video-player ${version}\n`
    + `https://github.com/MarineAppliedResearch/marp-video-player/releases/tag/v${version}\n`
);

const archiveName = `marp-video-player-${version}-host.zip`;
const archive = path.join(outDir, archiveName);

// Zipping without adding a dependency, which means using whatever the platform
// already has. Git Bash's GNU tar is deliberately avoided: it reads an absolute
// Windows path as a remote host ("Cannot connect to C:"), and it cannot create
// a real zip regardless.
if (process.platform === 'win32') {
    // ZipFile.CreateFromDirectory, not Compress-Archive: the latter nests the
    // staging folder itself inside the archive and writes backslash
    // separators. This puts the directory's contents at the archive root with
    // forward slashes, which is what a consumer expects.
    execFileSync('powershell.exe', [
        '-NoProfile',
        '-Command',
        "Add-Type -AssemblyName System.IO.Compression.FileSystem; "
        + `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stageDir}', '${archive}')`,
    ], { stdio: 'inherit' });
} else {
    // zip is present on GitHub's Linux and macOS runners.
    execFileSync('zip', ['-r', '-q', archive, '.'], { cwd: stageDir, stdio: 'inherit' });
}

console.log(`  ${path.relative(root, archive)}`);
for (const [, to] of CONTENTS) console.log(`    ${to}`);
console.log('    VERSION');
