# GitHub Copilot — marp-video-player

**Read [AGENTS.md](../AGENTS.md) first.** It is the single source for how to work in this
repository: the workflow and its gates, the rules that are not negotiable, how assumptions
are surfaced, and the testing doctrine. This file holds only what is specific to Copilot.

## Start from `master`, not the default branch

This repository's GitHub default branch is not necessarily the branch work happens on.
`services/repos.yml` in the umbrella records the branch to develop on, and for this
repository it is **`master`**.

In this platform `master` means *what is in production* and is promoted by hand, so it can
be far behind — marp-api's is around 147 commits and a year behind `develop`, with an older
architecture. A coding agent that starts from the default branch starts there.

## Path-specific rules

Rules that apply to one part of the tree live in `.github/instructions/*.instructions.md`
and apply automatically to the paths they name. Prefer adding one there over repeating a
rule in a review comment.

## Reviewing

Copilot code review is welcome on pull requests and is not a gate. It is good at the class
of problem our checks do not cover, and it does not know what MARP means by a session, an
observation, or a review — so treat its comments about meaning as questions rather than
findings.

## What not to do

- Do not open a pull request as the completion of a task. Pull request creation is gate G5
  in AGENTS.md and belongs to the human.
- Do not report a tier as passing that you did not run.
