## What and why

<!-- One paragraph. What changes for the person using MARP. -->

## The specification

<!-- Link the issue, and note that .marp/task.md on this branch carries the requirements,
     the assumptions and how they were answered. Reviewing this diff includes reviewing
     what it was supposed to do. -->

- Issue:
- Assumptions answered:

## Verification

<!-- .marp/verification.md carries the plan that was reviewed and the results that were
     actually produced. Summarise here; do not restate it. -->

- Tiers run:
- Requirements with no test:
- Known gaps:

## Checklist

- [ ] `.marp/task.md` has no unanswered `blocking` assumption
- [ ] Every defect fixed here has a named test at a tier that can observe it
- [ ] Durable decisions promoted to `docs/decisions/` or the umbrella's `architecture/decisions/`
- [ ] Generated output rebuilt if the change touches what generates it
- [ ] No credential, host, port or machine-specific path added to a tracked file
