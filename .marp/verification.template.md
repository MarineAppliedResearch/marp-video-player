# Verification — <task>

<!--
  The G3 package. Written BEFORE anything is run, and reviewed by a human before it is
  run. The point of this file is that "you're missing this case" and "that test does not
  actually prove the requirement" get said while they are still cheap.

  `marp verify plan` drafts it from .marp/task.md. `marp verify run` executes what was
  approved and appends the real results, failures included, verbatim.
-->

## What each test proves

| Requirement | Test | Tier | Proves |
| --- | --- | --- | --- |
| R1 | … | unit | … |
| R2 | … | render | … |

**Choosing the tier is the decision that matters.** A rendering defect passes every
store-level check. A rule defect passes every browser test that never exercises it. A fix
reported as verified at a tier that structurally cannot observe the defect is how the same
bug gets reported twice.

## Requirements with no test

List them. This section being empty is a claim, not a formality — `marp verify plan` fills
it in from the requirement ids the tests reference.

## Edge cases

Each one with the defect or the reasoning it traces to.

## Regression coverage

Tests added because something broke before. Name what broke.

## Known gaps

What this verification does not cover, stated plainly. A gap that is written down is a
decision; a gap that is omitted is a surprise later.

## Manual steps

Anything that cannot be automated — the Windows GUI, GPU inference, a real Jellyfin
server. Written so a human can follow them exactly, with the expected result for each.

## Walkthrough videos

Which scenarios will be recorded and, for each, the requirement it demonstrates and the
assertion it makes. A scene that narrates a result without asserting it can lie, so every
scene named here has to say what it asserts.

---

## Results

<!-- Appended by `marp verify run`. Real output, including failures, verbatim. -->
