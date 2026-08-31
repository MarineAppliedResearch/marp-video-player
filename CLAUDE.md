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
| `npm test` | 140 unit tests against fake WebCodecs globals. No server, network, or media. | seconds |
| `npm run test:e2e` | 26 browser tests, real decoding. Starts its own server, downloads its own media. | minutes |

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

## Gotchas found the hard way

- **The centre overlay covers the canvas.** `.marp-center-overlay` is `position: absolute; inset: 0` and is shown until the first frame is presented. Anything listening on the canvas alone will never fire before playback starts — this is what broke drag-and-drop.
- **`baseURL` in `playwright.config.cjs` must end at the player page.** The specs call `page.goto('')`; pointing it at the server root silently serves nothing.
- **Rebuild after changing `src/`.** The pages load `dist/`, so source edits do not appear until `npm run build`.
- **On Windows, VS Code tasks must call `npm.cmd`.** PowerShell resolves bare `npm` to `npm.ps1` and refuses it under a Restricted execution policy.

## Documentation

Source is thoroughly JSDoc-commented and the comments explain *why*, often recording findings about decoder and transcoder behaviour that cost real time to establish. Preserve that when editing; do not trim comments to shorten a diff.
