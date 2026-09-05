---
task: MarineAppliedResearch/<repo>#<n>
repos: [<repo>]
status: design
needs: []
---

<!--
  The task specification. Copy to .marp/task.md on the task branch and fill it in.

  Headings are fixed because `marp spec check` parses them. `## Open assumptions` is the
  one that is enforced: implementation is blocked while any item tagged `blocking` is
  unticked. See ADR-0003, and the workflow gates in AGENTS.md.

  `needs:` names exclusive resources this task must hold — the Jellyfin dev instance, for
  example, which is one machine and does not parallelise. Leave it empty when nothing is
  shared.
-->

## Goal

One paragraph. What changes for the person using MARP, not what changes in the code.

## Requirements

Numbered, because tests reference them by id and `marp verify plan` lists the ones with no
test against them.

- **R1** — …
- **R2** — …

## Open assumptions

Everything the task does not settle that could change the behaviour, the schema, the
interface, or the data. Categories: behavioural · product/UI · scientific or data-meaning ·
database/schema · API contract · architectural · performance/concurrency ·
security/permissions · destructive · cross-repository · environment.

A trivial local choice that follows an established pattern in the repository is not an
assumption. Discovering a new one during implementation is normal — append it and stop.

- [ ] **A1 · <category> · blocking** — the question, phrased so a one-line answer resolves it.
- [x] **A2 · <category> · blocking** — answered YYYY-MM-DD: the answer. → ADR-NNNN if durable.

## Decisions

Dated, and short. Anything here that will outlive the task gets promoted to a decision
record before the branch merges, and this line then points at it.

- **YYYY-MM-DD** — …

## Plan

The steps, in order, each one small enough to verify.

## Acceptance criteria

What has to be true for this to be done. Observable, not aspirational.

## Test plan

Filled in at G3, before anything is run, and reviewed by a human. `marp verify plan` writes
the first draft of `.marp/verification.md` from the requirements above — including the
requirements that have no test, which is the part worth looking at.

## Status

- **Gate:** design | implementing | verifying | ready-for-pr
- **Notes:** what is done, what is not, and anything that turned out to be harder than it
  looked.
