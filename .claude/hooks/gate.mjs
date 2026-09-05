/**
 * Locate the MARP harness and run one of its gates.
 *
 * This file is copied into every component as `.claude/hooks/gate.mjs`, and it is the
 * only part of the harness that lives inside a component. It exists because of a real
 * failure: the hooks were wired as `$CLAUDE_PROJECT_DIR/../scripts/harness/...`, which
 * assumes the repository sits directly inside the umbrella. A git worktree does not — it
 * lives under `marp-worktrees/<repo>/<branch>/` — so the path resolved to nothing and the
 * gates failed open **silently**, in precisely the configuration parallel agents use.
 *
 * A gate that is off exactly when several agents are working is worse than no gate,
 * because the settings file still says it is there.
 *
 * Usage, from .claude/settings.json:
 *   node "$CLAUDE_PROJECT_DIR/.claude/hooks/gate.mjs" spec-gate
 *   node "$CLAUDE_PROJECT_DIR/.claude/hooks/gate.mjs" danger-gate
 *
 * Kept in step with the umbrella's copy by `marp harness check`.
 */

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync, execFileSync } from 'node:child_process';
import { join, resolve, dirname } from 'node:path';

const allow = (reason) => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
};

/** Does this directory look like the MARP umbrella? */
const isUmbrella = (dir) =>
  existsSync(join(dir, 'services', 'repos.yml')) && existsSync(join(dir, 'scripts', 'harness'));

/**
 * Find the umbrella from wherever this repository happens to be checked out.
 *
 * Four ways, cheapest first. The git one is what makes worktrees work: a worktree's
 * `--git-common-dir` points at the main checkout's `.git`, so its grandparent is the
 * umbrella even though the worktree itself sits somewhere else entirely.
 */
function findUmbrella(projectDir) {
  if (process.env.MARP_HOME && isUmbrella(process.env.MARP_HOME)) return process.env.MARP_HOME;

  const sibling = resolve(projectDir, '..');
  if (isUmbrella(sibling)) return sibling;

  try {
    const common = execFileSync('git', ['-C', projectDir, 'rev-parse', '--git-common-dir'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const mainCheckout = dirname(resolve(projectDir, common));
    const parent = resolve(mainCheckout, '..');
    if (isUmbrella(parent)) return parent;
  } catch { /* not a git checkout, or no git */ }

  let dir = projectDir;
  for (let i = 0; i < 6; i++) {
    if (isUmbrella(dir)) return dir;
    const up = resolve(dir, '..');
    if (up === dir) break;
    dir = up;
  }
  return null;
}

const gate = process.argv[2];
if (!gate) allow('no gate named');

let payload = '';
try { payload = readFileSync(0, 'utf8'); } catch { /* no stdin */ }

let projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
try {
  const parsed = payload.trim() ? JSON.parse(payload) : {};
  if (parsed.cwd) projectDir = parsed.cwd;
} catch { /* leave the default */ }

const umbrella = findUmbrella(projectDir);
if (!umbrella) {
  // Fail open, but say so. A standalone clone with no workspace is supported; being
  // unable to tell that from a broken installation is not.
  allow('MARP harness not found beside this repository — gates skipped. Set MARP_HOME if it is elsewhere.');
}

const script = join(umbrella, 'scripts', 'harness', 'hooks', `${gate}.mjs`);
if (!existsSync(script)) allow(`harness found at ${umbrella} but ${gate} is missing`);

const result = spawnSync(process.execPath, [script], { input: payload, encoding: 'utf8' });
if (result.status !== 0 || !result.stdout) allow(`${gate} could not run`);

process.stdout.write(result.stdout);
