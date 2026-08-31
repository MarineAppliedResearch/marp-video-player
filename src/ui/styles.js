/**
 * The player's stylesheet, as a string the library injects once per
 * document.
 *
 * Ported from the harness page's inline <style> with one structural change:
 * every rule is scoped under `.marp-player`, and the palette custom
 * properties are declared there rather than on `:root`. The harness could
 * style bare `body`/`button`/`input`/`label` selectors because it owned the
 * whole page; a library injecting those would restyle its consumer's page.
 *
 * Class names, not ids, do the styling here so more than one player can
 * coexist on a page. The markup still carries the original ids -- see
 * markup.js for why.
 *
 * @fileoverview Scoped CSS for the player UI.
 * @author Isaac Travers
 * @module video-engine/ui/styles
 */

/** @type {string} The <style> id used to inject this sheet at most once per document. */
export const STYLE_ELEMENT_ID = 'marp-video-player-styles';

/** @type {string} Full player stylesheet, scoped under `.marp-player`. */
export const PLAYER_CSS = `
/* Same palette as frontend/shared/assets/css/landing.css's :root -- the
   player's default look should read as MARP's, not an arbitrary debug gray.
   Declared on the root element, not :root, so nothing leaks to the page. */
.marp-player {
    --navy-1000: #01050d;
    --navy-950: #020814;
    --navy-900: #03101f;
    --navy-850: #051828;
    --navy-800: #07233a;

    --cyan-300: #64f6f2;
    --cyan-400: #22d7dc;
    --cyan-500: #05b9c8;
    --blue-400: #2d9cff;
    --blue-500: #147ee8;
    --green-300: #c7ff62;
    --green-400: #a7ec35;
    --green-500: #83c91f;

    --white: #f7fbff;
    --text: #c7d4dd;
    --muted: #8198a8;
    --faint: #587181;

    --border: rgba(42, 214, 220, 0.28);
    --border-strong: rgba(42, 214, 220, 0.52);
    --glow-cyan: 0 0 24px rgba(34, 215, 220, 0.25);
    /* Green is the player's primary accent (handle, focus ring, decoded);
       cyan is secondary (pinned-segment indicator only). */
    --glow-green: 0 0 24px rgba(167, 236, 53, 0.35);
    --border-green: rgba(167, 236, 53, 0.35);

    position: relative;
    background: black;
    font-family: sans-serif;
    color: var(--text);
    outline: none;
    user-select: none;
}

/* tabindex on the root makes it focusable, scoping the q..\\ speed hotkeys
   to a focused player instead of hijacking the consumer page's inputs. */
.marp-player:focus {
    box-shadow: 0 0 0 2px var(--green-400), var(--glow-green);
}

.marp-player .marp-hidden {
    display: none;
}

/* Controls off: a host draws its own transport and menus. display:none,
   not opacity, so nothing here takes a click or a tab stop underneath the
   host's own overlay. The spinner and the placeholder mark deliberately
   stay -- they are status, not controls. */
.marp-player.marp-controls-off .marp-controls-bar,
.marp-player.marp-controls-off .marp-center-overlay {
    display: none;
}

/* Nothing to focus when the player is not the one being driven. */
.marp-player.marp-controls-off:focus {
    box-shadow: none;
}

.marp-player .marp-canvas {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: contain;
}

/* Shown centered over the canvas until the first frame is presented. */
.marp-player .marp-logo {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 25%;
    max-width: 160px;
    opacity: 0.85;
    pointer-events: none;
}

.marp-player .marp-center-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(1, 5, 13, 0.35);
    cursor: pointer;
}

.marp-player .marp-center-overlay.marp-hidden {
    display: none;
}

/* Plain oversized glyph, not a circular badge -- a much larger effective
   tap target, and reads as "tap anywhere here to play". */
.marp-player .marp-center-play {
    border: none;
    background: none;
    color: var(--white);
    opacity: 0.75;
    font-size: 88px;
    line-height: 1;
    cursor: pointer;
    padding: 0;
}

.marp-player .marp-center-play:hover {
    opacity: 0.95;
}

/* Colors match the scrub bar's fetched=blue/decoded=green convention --
   one visual language for what the network/decode pipeline is doing. */
.marp-player .marp-spinner {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 56px;
    height: 56px;
    margin: -28px 0 0 -28px;
    border-radius: 50%;
    border: 5px solid rgba(199, 212, 221, 0.25);
    border-top-color: var(--blue-400);
    animation: marp-buffering-spin 0.9s linear infinite;
    pointer-events: none;
}

.marp-player .marp-spinner.decoding {
    border-top-color: var(--green-400);
}

@keyframes marp-buffering-spin {
    to {
        transform: rotate(360deg);
    }
}

/* --- Controls bar: fades out on idle during playback, always visible
   while paused or while the pointer is over the bar itself. --- */
.marp-player .marp-controls-bar {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    padding: 6px 10px 8px;
    background: linear-gradient(to top, rgba(1, 5, 13, 0.8), rgba(1, 5, 13, 0));
    opacity: 1;
    transition: opacity 0.2s ease;
}

.marp-player .marp-controls-bar.marp-faded {
    opacity: 0;
    pointer-events: none;
}

/* --- Scrub bar: a custom track (not <input type=range>) so per-segment
   fetch/decode/pinned shading can be drawn on the track itself -- native
   range inputs cannot color arbitrary sub-ranges. Deliberately thick: the
   shading needs visual room, and the whole player targets touchscreens. --- */
.marp-player .marp-scrub-track {
    position: relative;
    height: 40px;
    display: flex;
    align-items: center;
    cursor: pointer;
    margin-bottom: 4px;
    touch-action: none;
}

.marp-player .marp-scrub-bg {
    position: relative;
    width: 100%;
    height: 16px;
    border-radius: 8px;
    background: rgba(199, 212, 221, 0.15);
    overflow: hidden;
}

/* State priority: decoded over fetched over not-fetched (base). Pinned is
   a border, not a fill, so it stays visible in either fill state. */
.marp-player .marp-segment {
    position: absolute;
    top: 0;
    bottom: 0;
    background: transparent;
}

.marp-player .marp-segment.fetched {
    background: var(--blue-400);
}

.marp-player .marp-segment.decoded {
    background: var(--green-400);
}

/* Cyan, not green -- green is already decoded's fill and would not read as
   a distinct ring against it. */
.marp-player .marp-segment.pinned {
    box-shadow: inset 0 0 0 3px var(--cyan-400);
}

/* Reserved for the persistent disk cache -- not populated by
   getSegmentStates() yet, defined so wiring real data in is one line. */
.marp-player .marp-segment.disk-cached {
    background: var(--faint);
}

.marp-player .marp-scrub-handle {
    position: absolute;
    top: 50%;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--green-400);
    box-shadow: var(--glow-green);
    transform: translate(-50%, -50%);
    pointer-events: none;
}

.marp-player .marp-scrub-tooltip {
    position: absolute;
    bottom: 34px;
    transform: translateX(-50%);
    background: rgba(1, 5, 13, 0.9);
    border: 1px solid var(--border);
    color: var(--text);
    padding: 2px 6px;
    border-radius: 3px;
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
    display: none;
}

.marp-player .marp-controls-row {
    display: flex;
    align-items: center;
    gap: 10px;
}

/* min-width/height keeps a real >=44px touch target even though the glyph
   does not fill the whole button box. */
.marp-player .marp-controls-row button {
    background: none;
    border: none;
    color: var(--text);
    font-size: 26px;
    cursor: pointer;
    padding: 6px 10px;
    min-width: 44px;
    min-height: 44px;
}

.marp-player .marp-controls-row button:disabled {
    opacity: 0.5;
    cursor: default;
}

/* Step buttons carry a word, not a glyph, so they take a text size --
   they moved in from the harness page's own row below the player. */
.marp-player .marp-controls-row .marp-step {
    font-size: 13px;
    min-width: 0;
    padding: 6px 8px;
}

.marp-player .marp-time,
.marp-player .marp-speed {
    font-size: 12px;
    font-variant-numeric: tabular-nums;
}

.marp-player .marp-speed {
    color: var(--green-400);
}

.marp-player .marp-spacer {
    flex: 1;
}

.marp-player .marp-settings-anchor {
    position: relative;
}

.marp-player .marp-settings-button {
    font-size: 18px;
    line-height: 1;
}

.marp-player .marp-settings-menu {
    position: absolute;
    right: 0;
    bottom: 52px;
    width: 235px;
    background: rgba(1, 5, 13, 0.96);
    border: 1px solid var(--border-strong);
    border-radius: 8px;
    box-shadow: var(--glow-cyan);
    padding: 5px;
    display: none;
    z-index: 5;
    max-height: 70vh;
    overflow-y: auto;
}

.marp-player .marp-settings-menu.open {
    display: block;
}

/* --- Accordion: a stack of sections, each a header (always visible,
   toggles its own body) + a body (collapsed by default). At most one body
   open at a time. Nothing ever navigates away, so there is no "back". --- */
.marp-player .marp-section + .marp-section {
    border-top: 1px solid var(--border);
}

/* Explicitly restyled rather than inheriting: these buttons sit inside
   .marp-controls-row in the DOM, so that row's 26px transport-icon rule
   would otherwise win the cascade for every button nested in here. */
.marp-player .marp-settings-menu .marp-section-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    width: 100%;
    background: none;
    border: none;
    color: var(--cyan-300);
    font-size: 12.5px;
    font-weight: 600;
    padding: 7px 6px;
    cursor: pointer;
    border-radius: 4px;
    min-width: 0;
    min-height: 0;
}

.marp-player .marp-settings-menu .marp-section-header:hover {
    background: var(--navy-850);
}

/* Chevron flips to point down once its section is expanded. */
.marp-player .marp-settings-menu .marp-section-header::after {
    content: '\\276F';
    font-size: 9px;
    color: var(--faint);
    transition: transform 0.15s ease;
}

.marp-player .marp-settings-menu .marp-section-header.expanded::after {
    transform: rotate(90deg);
}

.marp-player .marp-section-body {
    padding: 2px 6px 8px;
}

.marp-player .marp-group {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 6px;
}

.marp-player .marp-group label {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 2px;
    font-size: 10.5px;
    color: var(--muted);
}

.marp-player .marp-actions {
    display: flex;
    gap: 6px;
}

.marp-player .marp-settings-menu .marp-actions button {
    font-size: 12px;
    padding: 4px 8px;
    min-width: 0;
    min-height: 0;
}

.marp-player .marp-settings-menu .marp-quality-option {
    display: block;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    color: var(--text);
    font-size: 12px;
    padding: 5px 8px;
    cursor: pointer;
    border-radius: 4px;
    min-width: 0;
    min-height: 0;
}

.marp-player .marp-settings-menu .marp-quality-option:hover {
    background: var(--navy-850);
    color: var(--cyan-300);
}

.marp-player .marp-settings-menu .marp-quality-option.selected {
    background: rgba(167, 236, 53, 0.12);
    color: var(--green-400);
}

.marp-player .marp-status {
    font-size: 11px;
    color: var(--muted);
    margin-bottom: 6px;
}

/* All three input types explicitly: the harness got its base input styling
   from page-level rules that a scoped library sheet cannot rely on. */
.marp-player .marp-settings-menu input[type="text"],
.marp-player .marp-settings-menu input[type="password"],
.marp-player .marp-settings-menu input[type="number"] {
    width: 100%;
    box-sizing: border-box;
    background: var(--navy-950);
    border: 1px solid var(--border);
    color: var(--text);
    font-size: 12px;
    padding: 4px 6px;
    border-radius: 4px;
}

.marp-player .marp-settings-menu input[type="file"] {
    color: var(--muted);
    font-size: 11px;
}

.marp-player .marp-settings-menu input:disabled {
    opacity: 0.55;
}

.marp-player .marp-hotkey-hint {
    font-size: 10px;
    color: var(--faint);
    line-height: 1.4;
}
`;
