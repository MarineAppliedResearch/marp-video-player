# marp-video-player — working notes

A frame-accurate WebCodecs video player. One component of the [MARP platform](https://github.com/MarineAppliedResearch/MARP); shared conventions live in the umbrella repository's `CLAUDE.md` when this repo is opened inside that workspace. This file covers what is specific here.

## Conventions

- **Commit authorship is Human only.** Never add Claude as author or co-author, and never a `Co-Authored-By` trailer. Applies to merge and squash commits too.
- **Short commit messages.** Subject under ~72 characters plus a few one-line bullets. Reference the issue (`Refs #NN`, `Closes #NN`).
- **Branch per issue**, named for it: `2-drag-and-drop-does-not-load`. Never commit directly to `master`.
- **Never commit credentials.** `.env` and `app/dev-config.js` are git-ignored; `.env.example` documents the variable names. This repository is public.

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
