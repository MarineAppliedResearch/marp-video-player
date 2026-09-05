# marp-video-player — agent instructions

A frame-accurate WebCodecs video player. One component of the [MARP
platform](https://github.com/MarineAppliedResearch/MARP).

**This file is the source.** `CLAUDE.md` and `.github/copilot-instructions.md` point here.
The shared block below is synced from the umbrella — edit `MARP/AGENTS.md` and run
`marp harness sync`, never this copy.

This repository is where the harness was proven, and it is the reference for two of its
ideas. Both are visible in `.github/workflows/test.yml`: a load-bearing claim becomes a
check (the bundle really is asserted to have no external imports and no remote assets,
rather than the README being trusted), and a contract with software in another repository
gets a test that fails here when that contract breaks (`test/e2e/host-contract.spec.js`).

<!-- marp:shared start -->
<!-- Canonical source: MARP/AGENTS.md. Do not edit this block in a component repository;
     edit it here and run `marp harness sync`. -->

## The platform

MARP is a polyrepo. `services/repos.yml` in the umbrella repository is the registry of
what MARP consists of, and it is authoritative — including for which branch to work on.

**Start from `repos.yml`'s `default_branch`, not from GitHub's default branch.** They
differ deliberately. `master` in this platform means *what is in production*, and
production is promoted by hand, so `master` can be far behind and that is not decay. Work
happens on `develop` where a repository has one.

Branch model is Gitflow: `master` is production, `develop` is integration, and every task
gets its own branch off `develop` named for its issue (`68-mosaic-review-prototype`).
Never commit directly to `master` or `develop`.

## Rules that are not negotiable

- **Commit authorship is the human developer only.** Never add an AI assistant as author
  or co-author, never add a `Co-Authored-By` trailer, and never mention an assistant or
  vendor in a commit message, PR title, or PR body. This applies to merge and squash
  commits too.
- **Never commit `.env` files, credentials, tokens, keys, or host passwords.** Each
  repository has a `.env.example` documenting variable *names*. Operational detail for a
  specific machine goes in `.marp/local/`, which is git-ignored.
- **The production database is a scientific record.** `mare_v1` holds years of annotation
  that is queried and reported on by people and tools outside this workspace. Any
  transformation of existing data must either preserve everything currently possible or
  lose nothing — a column that stops being populated, a value that becomes ambiguous, or a
  format an existing query no longer parses all count as loss, even when the application
  still works. Derived columns are part of the contract.
- **Ask about meaning rather than inferring it from the data.** How a field is meant to
  work, what an empty value means, whether two similar rows are one thing or two — these
  are answerable by the person who recorded them and not reliably by inspection.

## Keep commit messages short

Subject under ~72 characters plus a few one-line bullets. Reference the issue with
`Refs #NN` or `Closes #NN`. Cross-repository work references the other side in full:
`MarineAppliedResearch/MARP_API#68`.

## The workflow, and where it stops for a human

```
G0  Intake      read the task, this file, and the repository's decision records
G1  Design      investigate -> write .marp/task.md -> surface assumptions
    GATE          the human answers. Nothing is implemented while a `blocking`
                  assumption is open. This is enforced, not requested.
G2  Implement   implement the settled spec. Fast, autonomous, no questions --
                  unless a NEW material assumption appears, which returns to G1.
G3  Test plan   write .marp/verification.md: what will be tested, which
    GATE          requirement each test proves, and what is NOT covered.
                  The human reviews the PLAN before anything is run.
G4  Verify      run the approved verification, record real results including
    GATE          failures, verbatim. The human reviews the evidence.
G5  PR          opened only when the human says so. Never automatically.
G6  Merge       CI green plus human approval.
```

`.marp/task.md` is the task specification and it lives on the task's own branch, so it
travels with the code and appears in the pull request. `.marp/task.template.md` is the
skeleton. Durable decisions are promoted out of it into decision records
(`docs/decisions/` for one repository, the umbrella's `architecture/decisions/` for
anything spanning two).

## Surfacing assumptions is the point

Agents make plausible but incorrect assumptions, and a material assumption must never
silently become an implementation decision. During G1, write down anything of these kinds
that the task does not settle:

behavioural · product/UI · scientific or data-meaning · database/schema · API contract ·
architectural · performance/concurrency · security/permissions · destructive operations ·
cross-repository integration · environment

Each goes in `## Open assumptions` in `.marp/task.md` as a checklist item tagged with its
category and whether it is `blocking`. `marp spec check` fails while a blocking assumption
is unticked, which is what actually stops G2 from starting.

Trivial local choices that follow an established pattern in the repository are not
assumptions. If you are unsure whether something is material, the test is: *would a
different reasonable answer change the behaviour, the schema, the interface, or the
data?* If yes, it is material.

Discovering a new material assumption during G2 is normal and is not a failure. Append it,
say so, and stop — do not guess to preserve momentum.

## Working in parallel

Several agents can work at once, and the model is the ordinary one: **each works on its own
branch, in its own copy of the repository, and pushes that branch when the work is done.**
Branches are merged the usual way. The only extra requirement is that two agents must not
collide over the things a running MARP needs.

```bash
marp agent start marp-api 71-thumbnail-lifecycle
```

That gives the branch its own copy, its own database on its own port, its own API port, a
written `.env`, and its dependencies installed — so it can run and test without touching
anybody else's. `marp agent list` shows what is set up and where; `marp agent env <branch>`
prints the settings again; `marp agent remove <branch>` throws the copy away and **keeps
the branch**, because tidying up and discarding work should never be the same command.

On a second machine there is nothing to set up: clone the repository, check out the branch,
and it is already isolated. The command exists for putting several on one machine.

Two things are deliberately shared:

- **Jellyfin.** Every agent talks to the central MARP media server. It holds the real
  library, and the tests that touch it read far more than they write. A task that genuinely
  needs its own instance says so; nothing else should.
- **The PostgreSQL binaries**, downloaded once. Only the data directory is per-agent.

**Parallelism comes after the design is settled, never before.** Two agents each doing
their own investigation on overlapping surface is how two incompatible interpretations of
MARP get built. One agent settles the assumptions with the human; then the work fans out.

## Testing doctrine

Learned the expensive way, and it holds everywhere in this platform:

- **A defect is not fixed until it has a named test at a tier that can actually observe
  it.** Several defects here were reported twice because the first fix was verified at a
  tier that structurally could not see the bug. Store-level checks cannot see what was
  drawn; unit tests cannot see what a browser rendered.
- **A test that narrates a result without asserting it can lie.** This applies to
  walkthrough videos especially: a scene that says "the tile is now excluded" and only
  asserts that a panel opened will pass for weeks while excluding nothing.
- **Run the fast tiers after every change.** Parse and unit checks cost about a second.
  Do not run slow browser, database or hardware suites for routine feedback; they belong
  to the person working, and to G4.
- **A skipped suite looks green.** Prerequisites missing should fail, not skip.

## Documentation that states an environment fact

**Point at the command; do not restate the value.** A host, a port, a path or a version
written into prose goes stale silently and an agent cannot tell. Write *"run `marp db
status` to see yours"* rather than naming a host and port.

This is not a style preference. The umbrella's own `CLAUDE.md` once described the database
in two contradictory ways sixty lines apart, and an agent resolved the contradiction toward
the stale half and built a plan on it. `marp harness check` now greps tracked instruction
files for environment literals and retired markers.

The same rule retires any document that promises to stay in sync with code it cannot
observe. Do not write a `## Current API` section by hand; point at the generated contract.

## How corrections become durable

When a human corrects an agent, the correction should make the same mistake less likely
next time. Route it by this ranking:

> **A correction becomes a check if it possibly can, a test if it cannot be a check, and a
> sentence only if it can be neither.**

| The correction is about | Where it goes |
| --- | --- |
| what the system should do | `.marp/task.md` requirements, plus a test naming that requirement |
| a decision that constrains future work | a decision record |
| how agents should work, everywhere | this shared block |
| a rule for one area of one tree | `.github/instructions/*.instructions.md` |
| a defect | a named test at the tier that can see it |
| a mechanically checkable invariant | `marp doctor` or `marp harness check` or CI |
| something an agent should not do | a hook or a permission rule |

## Permissions

**Free:** read anything, search, run parse/unit/contract tiers, write to a task branch,
write `.marp/*`, commit locally, query a local disposable database, read the GitHub API.

**Ask first:** `git push` · opening a pull request (this is gate G5) · migrations against
anything but a local disposable database · any write to a shared database · adding a
dependency · editing generated output by hand · changing a published contract surface.

**Never without the human present:** anything against production `mare_v1` · the live
Jellyfin service and its configuration · force push · branch deletion · rewriting
published history · restoring anything from a `retired-migrations` directory · rotating
credentials.

## Working style

The human is the programmer; the agent is the assistant.

- Do not race ahead, and do not design large systems without checking direction.
- Work one milestone at a time. If asked for a test, give exactly that test and wait for
  the result before moving on.
- If a failure is reported, focus on that failure. Do not pile on unrelated improvements.
- **Report a failure the moment you see it.** Do not silently run diagnostics while
  somebody waits, and never present a partial result as a finished one.
- State assumptions explicitly. If several interpretations exist, present them rather than
  picking silently. If a simpler approach exists, say so.
- Minimum code that solves the problem. No speculative features, no abstractions for
  single-use code, no configurability that was not asked for.
- Touch only what the task requires. Do not reformat, refactor or "improve" adjacent code.
  Match the existing style even where you would do it differently. Remove only the imports
  and variables your own change orphaned.
- Comments: many short ones rather than a few long ones, about two lines on average, and
  they explain *why* far more than *what*.

<!-- marp:shared end -->


## This repository

## Things that will break other software if you change them

The C# WebView2 host in `VIDEO_PROCESSING_GUI` — a different repository — depends on all of these. Changing any of them is a breaking change for software you cannot see from here:

- The IIFE global name `MarpVideoEngine`. It is deliberately not the package name.
- `window.mareVideo` as an alias of `window.marpVideo`.
- The `postMessage` protocol in `src/webview2-bridge.js`: `status|`, `metadata|`, `frame|`, `segmentindex|`, `segments|`.
- `app/player.html`'s query parameters: `server`, `token`, `user`, `item`, `mode`, `src`, `controls`.

`test/e2e/host-contract.spec.js` exists to catch exactly these.

**Add, never change.** New information goes out as a further `status|` line, and
new page options as a further query parameter. `metadata|` and `frame|` are split
on a fixed field count by `MareMediaElement.xaml.cs`, so an extra field there
breaks a host in a repository you cannot see; `HandleStatusMessage` matches known
prefixes and logs anything else, so a new `status|` line is free. That is why the
audio state goes out as `status|audio ...` and `status|volumechange ...` rather
than as fields on `metadata|`.

Worth knowing: the C# host already writes `window.marpVideo.volume` and
`.muted` on every `Volume` set, and did so throughout the period when both were
inert properties. Implementing them was not a contract change — it made wiring
that was already there start working.

## Two guarantees the package must keep

- **No runtime dependencies.** `mp4box` and the interface are compiled into the bundles. A consumer adds one file.
- **No network at load.** No CDN, no web fonts, no remote assets. The player is deployed to ships and field sites without connectivity. If you add an asset, inline it as a data URI the way `src/ui/logo.js` does.

## Module system

`package.json` declares `"type": "module"`, so `.js` is ESM.

- Source and test specs use `import`.
- Config files that must be CommonJS are `.cjs`: `jest.config.cjs`, `playwright.config.cjs`, `test/e2e/global-setup.cjs`, `test/unit/jest-esbuild-transform.cjs`.
- ESM has no `__dirname`; use `dirname(fileURLToPath(import.meta.url))`.

Unit tests are ES modules transformed on the fly by esbuild, which is why they need their own Jest config separate from anything else.

## Tests

Two tiers, nothing else. There is deliberately no third category of scripts you run by hand.

| Command | What | Speed |
| --- | --- | --- |
| `npm test` | 280 unit tests against fake WebCodecs and Web Audio globals. No server, network, or media. | seconds |
| `npm run test:e2e` | 50 browser tests, real decoding. Starts its own server, downloads its own media. | minutes |

**Use `npm test` for feedback.** Do not run the browser suite routinely — it decodes real 1080p video against a live server with 120-second timeouts. Leave it to the person working, via the launcher.

The browser suite **fails** rather than skips when a prerequisite is missing. A skipped suite looks green.

### Two Jellyfin servers, deliberately

| Purpose | Server | Why |
| --- | --- | --- |
| Fixture download, read-only | live | it has the media library |
| Every test calling a Jellyfin API | development | these write: playback reporting records resume positions, behind sessions start transcodes |

Never point the API tests at live.

## Layout

```text
src/            the library. src/ui/ is the built-in interface.
app/            developer test page. Not a demo -- it carries diagnostics
                and a native-host simulator. Constructs the player with
                `input: false`, so the library's own input handlers are off
                and the page wires its own.
demo/           three runnable embedding examples, smallest first.
tools/serve.mjs static server for both.
test/unit/      Jest, no dependencies.
test/e2e/       Playwright.
```

## Audio

**Audio is decoded by the browser, not by WebCodecs.** That is the single most
important thing to know here, and it is not a style preference — decoding audio
the way the video is decoded does not work. Measured on the reference media,
decoding one second of audio:

| | |
| --- | --- |
| WebCodecs `AudioDecoder`, while GOPs decode | ~4400 ms — **slower than real time** |
| `decodeAudioData` on ADTS, same conditions | 36–78 ms |

The audio decoder ends up waiting inside the platform's media pipeline behind
the video decoder. Video survives that: a late frame freezes the picture and
nothing is lost. Audio cannot, because a sample that misses its moment is
silence for ever. The symptom was audio playing for four seconds, stopping for
twenty-two, and resuming. Issue #6 has the full investigation, including two
theories that measurement disproved.

So the path is: `fetchAudioChunks()` on the media source hands over AAC samples
from bytes already fetched for the picture → `audio-adts.js` frames them (seven
bytes per frame) → `decodeAudioData` → `audio-store.js` caches the AudioBuffers
→ `audio-output.js` schedules them against the scheduler's clock.

Three rules, each of which cost something:

- **There is one clock.** `Scheduler#playbackPosition` — the render loop's own
  continuous target, *not* `currentTime`, which advances in whole frames and
  reads as 50–120 ms of drift that is not there. `Scheduler#_syncAudio` is the
  only thing that starts or stops audio, and only on transitions.
- **Audio never fetches.** `AudioStore` reads bytes Tier 1 already holds and
  skips a unit whose bytes are absent. Missing audio is silence; a missing frame
  is a stall.
- **Audio never breaks playback.** Anything that fails ends in silence and a
  debug line.

Things that look like fixes and are not, all tried and measured: slicing the
decode smaller, priming while paused (the paused fill worker decodes ahead too,
so the machine is never idle), and moving to a Worker (the contention is not
main-thread — a heartbeat showed constant blocking while flush times varied
1000×). MediaSource with muxed fMP4 was also built and abandoned after
`PIPELINE_ERROR_DECODE`; ADTS needs no muxer at all.

On the byte-range paths, each unit's byte range is **widened** at index time to
cover the audio overlapping its own time span. Audio and video are interleaved
sample by sample, so fetching ten seconds of audio alone took 251 requests
spanning 11 MB to collect 245 KB, while the video unit's range already covered
95–98% of it. Widening costs about 5% more bytes and no extra requests.

Never point an `<audio>` element at the media URL, however tempting: the browser
refetches the whole file to find the audio track, and some of these dives are
20 GB.

Do not trust `track.audio.sample_rate` from mp4box — it reports 0 for the 96 kHz
AAC track in this project's own media. That is correct rather than a bug: the
`mp4a` box states its rate in 16.16 fixed point and 96000 does not fit in the
integer part. Read the AudioSpecificConfig.

## Gotchas found the hard way

- **The centre overlay covers the canvas.** `.marp-center-overlay` is `position: absolute; inset: 0` and is shown until the first frame is presented. Anything listening on the canvas alone will never fire before playback starts — this is what broke drag-and-drop.
- **`baseURL` in `playwright.config.cjs` must end at the player page.** The specs call `page.goto('')`; pointing it at the server root silently serves nothing.
- **Rebuild after changing `src/`.** The pages load `dist/`, so source edits do not appear until `npm run build`.
- **On Windows, VS Code tasks must call `npm.cmd`.** PowerShell resolves bare `npm` to `npm.ps1` and refuses it under a Restricted execution policy.

## Releasing

Semver, with one rule: **a major bump means the host contract changed** (the
`MarpVideoEngine` global, the `postMessage` protocol, or `player.html`'s query
parameters). A consumer relies on that to take a minor update without
re-verifying its host.

Publish with `npm run publish:version -- <patch|minor|major>`, or the
**Publish a new version** launcher entry. It refuses on a dirty tree, off
`master`, or when `master` differs from the remote. The tag then runs CI, which
tests, checks the tag against `package.json`, builds, publishes to npm through
trusted publishing (no token), and attaches
`marp-video-player-X.Y.Z-host.zip` to the release.

Never build a release locally. `dist/` is git-ignored, so a local build is
unreproducible and nothing records which one a consumer ended up with.

## Documentation

Source is thoroughly JSDoc-commented and the comments explain *why*, often recording findings about decoder and transcoder behaviour that cost real time to establish. Preserve that when editing; do not trim comments to shorten a diff.
