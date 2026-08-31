# marp-video-player

A frame-accurate video player for the browser, built on [WebCodecs](https://developer.mozilla.org/en-US/docs/Web/API/WebCodecs_API). Import it like any other video library: one file, no dependencies to install, no build step required.

Built for scientific video review, where the exact frame matters: frame-accurate seeking, real reverse playback, and variable speed without drift.

## Install

Directly from GitHub:

```bash
npm install github:MarineAppliedResearch/marp-video-player
```

Or download a build from `dist/` and drop it in.

## Use it

### As an ES module

The published bundle is fully self-contained — `mp4box` and the player UI are compiled in, so there is nothing else to install and no import map to configure.

```html
<div id="player"></div>

<script type="module">
  import { createMarpVideoPlayer } from './dist/marp-video-player.js';

  const player = createMarpVideoPlayer(document.getElementById('player'));
  await player.loadUrl('https://example.org/dive-165.mp4');
</script>
```

With a bundler, the package name works the same way:

```js
import { createMarpVideoPlayer } from 'marp-video-player';
```

### As a plain script tag

No modules, no build step. The bundle attaches `window.MarpVideoEngine`:

```html
<script src="dist/marp-video-player.iife.js"></script>
<script>
  const player = MarpVideoEngine.createMarpVideoPlayer(document.getElementById('player'));
</script>
```

### Embedded in a native host

`dist/marp-video-player.standalone.js` is the minified single-file build, with every asset inlined. Use it where there is no server to resolve sibling files — for example inside a WebView2 virtual-host mapping. See [Host integration](#host-integration).

## Builds

`npm run build` produces:

| File | Format | Use |
| --- | --- | --- |
| `dist/marp-video-player.js` | ESM | `import` in a browser or bundler |
| `dist/marp-video-player.iife.js` | IIFE, `window.MarpVideoEngine` | plain `<script>` |
| `dist/marp-video-player.standalone.js` | IIFE, minified | native hosts, embedded use |

The IIFE global is `MarpVideoEngine` rather than the package name, because the C# WebView2 host and the pages in `app/` depend on that name.

## No dependencies, no network

Two guarantees this package is built to keep:

**Nothing else to install.** The bundles have zero external imports. `mp4box`, the player markup, the stylesheet, and the logo are all compiled in. A consumer adds one file.

**No internet connection required.** Loading the player makes no network requests of any kind — no CDN, no web fonts, no remote assets. The logo is an inlined data URI and the UI uses system fonts. The only network traffic is fetching the media you point it at, which happens on your own network if that is where the media lives.

This means the player works fully air-gapped, which matters for shipboard and field deployments.

## Media sources

The player reads from several kinds of source, selected by the `MediaSource` implementation you hand it:

| Source | What it reads |
| --- | --- |
| `UrlMediaSource` | any HTTP URL serving an MP4 with range requests |
| `LocalFileMediaSource` | a `File` from an `<input type="file">` |
| `JellyfinDirectPlayMediaSource` | Jellyfin, streaming the original file by byte range |
| `JellyfinTranscodeMediaSource` | Jellyfin, via its HLS transcode |

`createJellyfinSource` picks between the two Jellyfin strategies automatically.

## Public API

Twenty named exports. The main entry points:

- `createMarpVideoPlayer(element, options)` — player with the built-in UI
- `createMarpVideoEngine(options)` — engine only, bring your own UI
- `attachWebView2Bridge(...)` — message bridge for native hosts
- `PLAYER_CSS` — the UI stylesheet, if you render markup yourself

Generate the full reference with `npm run docs`.

## Development

```bash
npm install
npm run build        # ESM, IIFE, and standalone bundles into dist/
npm run serve        # static server on port 8099
npm test             # 12 suites, 140 unit tests
npm run docs         # JSDoc reference into docs/generated/
```

With the server running:

<http://localhost:8099/app/index.html> is the player with its full UI. Load a
local MP4 or a URL.

Everything here runs with nothing else installed — no API, no database, no Jellyfin. Loading a local file exercises the full decode and playback path on its own.

### In VS Code

Open the folder and use **Run and Debug** (<kbd>F5</kbd>):

| Configuration | What it does |
| --- | --- |
| Open player in browser | Rebuilds, starts the server, opens the player with the debugger attached |
| Debug unit tests (all) | Full Jest suite with breakpoints |
| Debug unit tests (current file) | Just the open test file |
| Debug the build | Step through `build.js` |
| Debug a probe (current file) | Run the open probe under the debugger |

Or **Terminal → Run Task** for build, docs, tests, E2E, and serving without a debugger. `Install Playwright browsers` is a one-time task needed before E2E tests work.

### Tests

- `npm test` — unit tests. ES modules transformed on the fly by esbuild.
- `npm run test:e2e` — Playwright, against a real browser. Set `MARP_PLAYER_TEST_URL` to point at a served player, and the Jellyfin variables to exercise those sources.
- `test/probes/` — scripts that check what the suites cannot, such as whether the picture on screen is the *right* picture and whether a WebView2 host receives the messages it needs. Run deliberately, not on every commit. See `test/probes/README.md`.

## Host integration

The player runs inside a C# WebView2 host in MARE's desktop application. `app/player.html` is the page that host loads, and `attachWebView2Bridge` carries messages between them. Changing that bridge or the `MarpVideoEngine` global name is a breaking change for the host.

## Browser support

Requires WebCodecs: Chrome/Edge 94+. Firefox and Safari do not yet ship the parts this depends on.

## History

Extracted from [`MARE_API`](https://github.com/MarineAppliedResearch/MARE_API), where it lived at `video-engine/`. Commit history before the extraction is in that repository.

## License

Apache-2.0
