# marp-video-player — Claude Code

See **[AGENTS.md](AGENTS.md)**. It is the single source for how to work in this
repository, whichever assistant is reading it. Shared platform conventions are synced into
the top of that file from the [umbrella repository](https://github.com/MarineAppliedResearch/MARP).

## Claude-specific

`.claude/settings.json` holds the permission rules; `.claude/hooks/` holds the gates:

- **spec-gate** refuses edits outside `.marp/` while a `blocking` assumption in
  `.marp/task.md` is unanswered — gate G1 in `AGENTS.md`.
- **danger-gate** stops a force push, a branch deletion, or a release built locally.
  `dist/` is git-ignored precisely so no local build can become the thing a consumer got;
  releases are cut by CI from a tag.

Both fail open when the umbrella is not checked out beside this repository. A standalone
clone is a supported way to work here, and a missing gate must not look like a broken
repository.

To see what the gate sees:

```bash
node ../scripts/harness/spec-check.mjs .
```
