# Demos

Three ways to embed the player, smallest first. Each is a single HTML file with nothing else to install.

| File | Shows |
| --- | --- |
| [`01-minimal.html`](01-minimal.html) | The smallest working embed: one container, one import, one call |
| [`02-script-tag.html`](02-script-tag.html) | No modules and no build step, driving the player from its public API |
| [`03-engine-only.html`](03-engine-only.html) | Decoding to your own canvas, with your own controls |

## Running them

From the repository root:

```bash
npm install
npm run build
npm run serve
```

Then open:

- <http://localhost:8099/demo/01-minimal.html>
- <http://localhost:8099/demo/02-script-tag.html>
- <http://localhost:8099/demo/03-engine-only.html>

`npm run build` is required first: the demos load from `dist/`, which is not committed.

A server is required — the demos will not work opened as `file://` URLs, because ES modules and range requests both need HTTP. Any static server will do; `npm run serve` is simply the one in this repository.

## Loading something to play

The player takes media from several kinds of source:

- **A local file** — in demos 1 and 2, open the settings menu (the gear) and choose a file. Demo 3 has its own file picker. You can also drag a video file onto the player.
- **A URL** — any HTTP address serving an MP4 that supports range requests:

  ```js
  await player.loadUrl('https://example.org/dive-165.mp4');
  ```

- **A Jellyfin server** — sign in through the settings menu, then load by item id. The player chooses between Direct Play and a transcode automatically.

## Next steps

- The [main README](../README.md) covers the public API, the three build outputs, and browser support.
- `npm run docs` generates the full reference from source.
- `app/index.html` is the developer test page rather than a demo: it carries diagnostics, a native-host simulator, and cache instrumentation that a consumer would not want.
