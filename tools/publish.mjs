/**
 * Publishes a new version.
 *
 * Raises the version number, tags it, and pushes. GitHub Actions does the rest:
 * tests, build, npm publish through trusted publishing, and the GitHub release
 * with the host archive.
 *
 * Publishing cannot be undone. An npm version number can never be reused, even
 * after unpublishing, and a consumer may have installed it within seconds. So
 * this refuses to run unless the repository is in a state worth publishing
 * from, rather than finding out afterwards.
 *
 * Usage: npm run publish:version -- patch|minor|major
 *
 * @fileoverview Guarded release trigger.
 * @author Isaac Travers
 * @module tools/publish
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Runs a git command and returns its trimmed output.
 *
 * @param {...string} args - Arguments to git.
 * @returns {string} Standard output, trimmed.
 */
function git(...args) {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Stops with a message rather than a stack trace.
 *
 * @param {string} message - What is wrong.
 * @param {string} [fix] - What to do about it.
 * @returns {void}
 */
function refuse(message, fix) {
    console.error(`\nNot publishing: ${message}`);
    if (fix) console.error(`\n${fix}`);
    console.error('');
    process.exit(1);
}

const kind = process.argv[2];
if (!['patch', 'minor', 'major'].includes(kind)) {
    refuse(
        `expected patch, minor or major, got ${kind ? `"${kind}"` : 'nothing'}.`,
        'patch  a fix, no API change\n'
        + 'minor  new features, still backwards compatible\n'
        + 'major  the host contract changed: the MarpVideoEngine global, the\n'
        + '       postMessage protocol, or player.html query parameters',
    );
}

// A dirty tree means the published build would not match any commit, and
// nobody could later work out what shipped.
if (git('status', '--porcelain')) {
    refuse(
        'there are uncommitted changes.',
        'Commit or stash them first. What gets published is the commit, so an\n'
        + 'uncommitted change would silently not be in the release.',
    );
}

const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
if (branch !== 'master') {
    refuse(
        `on branch "${branch}", not master.`,
        'Releases are cut from master. Merge the work first.',
    );
}

git('fetch', 'origin', '--quiet');

const behind = Number(git('rev-list', '--count', 'HEAD..origin/master'));
if (behind > 0) {
    refuse(
        `master is ${behind} commit(s) behind origin.`,
        'Run: git pull --ff-only origin master',
    );
}

const ahead = Number(git('rev-list', '--count', 'origin/master..HEAD'));
if (ahead > 0) {
    refuse(
        `master is ${ahead} commit(s) ahead of origin.`,
        'Push them first, so the tag lands on a commit that exists remotely.',
    );
}

const current = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

console.log(`Current version: ${current}`);
console.log(`Raising the ${kind} number and publishing.\n`);

// npm version writes package.json, commits, and tags.
//
// npm.cmd directly rather than through a shell: a shell would split the commit
// message on its spaces into separate arguments, and PowerShell refuses the
// npm.ps1 shim under a Restricted execution policy.
execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', [
    'version',
    kind,
    '-m',
    'marp-video-player %s',
], {
    cwd: root,
    stdio: 'inherit',
});

const next = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

git('push', 'origin', 'master');
git('push', 'origin', `v${next}`);

console.log(`\nPublished ${next}. GitHub Actions is building it now:`);
console.log('  https://github.com/MarineAppliedResearch/marp-video-player/actions');
console.log('\nWhen it finishes:');
console.log(`  npm    https://www.npmjs.com/package/marp-video-player/v/${next}`);
console.log(`  files  https://github.com/MarineAppliedResearch/marp-video-player/releases/tag/v${next}`);
console.log('\nRemember to update CHANGELOG.md if you have not already.');
