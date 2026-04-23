---
name: vscode-scrollbars
description: >
  Implement VS Code-style scrollbars in webview surfaces. Covers the main
  body-level scrollbar (DOM overlay via OverlayScrollbars) and inner scrollable
  containers in Lit Shadow DOM components (CSS-only via scrollbarSheet).
  Use when the user says 'scrollbar', 'VS Code scrollbar', 'fix scrollbar',
  'scrollbar arrows', 'overlay scrollbar', 'custom scrollbar', or any request
  to change scrollbar appearance in the extension's webviews.
---

# vscode-scrollbars

Implement VS Code-style scrollbars: rectangular thumbs, no arrow buttons,
transparent tracks, theme-aware colors via `--vscode-scrollbarSlider-*` tokens.

## Critical Lessons Learned

### CSS scrollbar APIs in Chromium 134+ (Electron 39, VS Code 1.117+)

1. **`::-webkit-scrollbar` pseudo-elements are dead.** In Chromium 121+, if
   `scrollbar-width` or `scrollbar-color` are set to any value other than
   `auto`, they **completely override** all `::-webkit-scrollbar-*` rules.
   Even without explicitly setting those properties, Chromium 134 ignores
   `::-webkit-scrollbar` rules on Windows — the native scrollbar renders
   unchanged. MDN confirms: *"If scrollbar-color and scrollbar-width are
   supported and have any value other than auto set, they will override
   ::-webkit-scrollbar-* styling."*

2. **`scrollbar-width: thin` keeps arrows on Windows.** The `thin` value
   tells the OS to render a narrower variant, but on Windows with classic
   scrollbars enabled, the OS still renders arrow buttons. There is no CSS
   value that removes arrows — `thin` just makes the scrollbar narrower.

3. **`scrollbar-width: none` hides scrollbars entirely** (but preserves
   scrollability). This is what OverlayScrollbars uses on its viewport
   element to hide the native scrollbar and render its own DOM overlay.

4. **You cannot mix approaches.** Do NOT combine `::-webkit-scrollbar` with
   `scrollbar-width`/`scrollbar-color`. The standards properties always win
   in Chromium 121+ and the webkit rules are silently ignored.

5. **VS Code itself uses DOM overlay scrollbars** (`.monaco-scrollable-element
   > .scrollbar > .slider`), not CSS scrollbar styling. That's why VS Code's
   own scrollbars look correct on all platforms.

### Conclusion

The **only** way to get arrow-free, fully-custom scrollbars in a VS Code
webview on Windows is **DOM-based overlay scrollbars**. CSS-only approaches
cannot remove native arrow buttons on Windows with classic scrollbars.

## Two Implementation Strategies

### Strategy A: DOM Overlay (OverlayScrollbars library)

**Use for:** The body-level page scrollbar on the main .kqlx/.kql webview,
or any scrollable container where you need full visual control (no arrows,
overlay behavior, auto-hide).

**Key files:**
- `src/webview/core/overlay-scrollbars.ts` — initialization + scroll patching
- `node_modules/overlayscrollbars/styles/overlayscrollbars.min.css` — library CSS (14KB)
- `src/host/queryEditorHtml.ts` — inlines library CSS into the `<style>` tag
- `esbuild.js` — copies library CSS to `dist/webview/styles/`

**How it works:**
1. Wraps all `<body>` children in a `.kw-scroll-viewport` div
2. Sets `body { overflow: hidden; height: 100vh; padding: 0 }` — body no longer scrolls
3. Moves `padding: 16px` to the wrapper
4. Initializes `OverlayScrollbars(wrapper, { ... })` on the wrapper
5. The library sets `scrollbar-width: none` on its internal viewport element,
   hiding the native scrollbar, and renders its own DOM-based scrollbar
6. Patches `window.scrollBy`, `window.scrollTo`, `window.scrollY`,
   `window.pageYOffset`, and `document.documentElement.scrollTop` to
   delegate to the wrapper element — preserving compatibility with 20+
   existing call sites

**VS Code theme CSS (applied via adoptedStyleSheets):**
```css
.os-scrollbar-vertical { width: 14px; }
.os-scrollbar-horizontal { height: 14px; }
.os-scrollbar .os-scrollbar-track { background: transparent; }
.os-scrollbar .os-scrollbar-handle {
  background: var(--vscode-scrollbarSlider-background);
  border-radius: 0;
}
.os-scrollbar .os-scrollbar-handle:hover {
  background: var(--vscode-scrollbarSlider-hoverBackground);
}
.os-scrollbar .os-scrollbar-handle:active,
.os-scrollbar .os-scrollbar-handle.active {
  background: var(--vscode-scrollbarSlider-activeBackground);
}
```

**OverlayScrollbars options used:**
```ts
OverlayScrollbars(element, {
  scrollbars: {
    visibility: 'auto',
    autoHide: 'move',
    autoHideDelay: 800,
    autoHideSuspend: true,
  },
  overflow: {
    x: 'hidden',   // or 'scroll' if horizontal scroll needed
    y: 'scroll',
  },
});
```

**When adding to a new container (not body):**
- No scroll patching needed — just call `OverlayScrollbars(element, options)`
- The library CSS must already be loaded (it is, in the `<style>` tag)
- The theme CSS is applied via `adoptedStyleSheets` (already done)
- If the container is inside Shadow DOM, import `overlayscrollbars` and call
  `OverlayScrollbars` directly; the library CSS needs to be adopted into the
  shadow root too (add it to the component's `static styles`)

### Strategy B: CSS-Only (scrollbarSheet)

**Use for:** Inner scrollable containers inside Lit Shadow DOM components
where the OverlayScrollbars library would be overkill. This still produces
themed scrollbars but **will have arrows on Windows with classic scrollbars**.

**Key file:** `src/webview/shared/scrollbar-styles.ts`

**How it works:**
- Exports a `CSSStyleSheet` instance (`scrollbarSheet`) using the
  constructable stylesheet pattern (same as `sashSheet`, `codiconSheet`)
- Applied globally via `document.adoptedStyleSheets` in `index.ts`
- Applied per-component via `static styles = [scrollbarSheet, ...]` in
  every Lit component

**Current CSS (`::-webkit-scrollbar` only — no `scrollbar-width`/`scrollbar-color`):**
```css
::-webkit-scrollbar { width: 10px; height: 10px; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }
::-webkit-scrollbar-thumb:active { background: var(--vscode-scrollbarSlider-activeBackground); }
::-webkit-scrollbar-corner { background: transparent; }
```

> **Note:** On Chromium 134+ this CSS has **no visible effect** because the
> webkit pseudo-elements are ignored. The scrollbars render as native. This
> sheet exists as a no-op safety net. The real styling comes from Strategy A
> (overlay) for the body scrollbar, or from future per-container overlay
> instances for inner scrollbars.

## VS Code Scrollbar Dimensions

| Property | Value |
|----------|-------|
| Vertical width | 14px |
| Horizontal height | 14px |
| Thumb border-radius | 0 (rectangular) |
| Track background | transparent |
| Thumb resting | `--vscode-scrollbarSlider-background` |
| Thumb hover | `--vscode-scrollbarSlider-hoverBackground` |
| Thumb active/drag | `--vscode-scrollbarSlider-activeBackground` |

### Monaco Editor Scrollbar Size ≠ CSS/OverlayScrollbar Size

Monaco's `verticalScrollbarSize` / `horizontalScrollbarSize` options measure
the **full scrollbar track width** including internal padding around the
thumb. CSS `::-webkit-scrollbar { width }` and OverlayScrollbars
`.os-scrollbar-vertical { width }` measure the **visible element width**
which maps more directly to the rendered thumb area.

**To achieve visually matching scrollbar widths across all three systems,
use different numeric values:**

| System | Code value | Visual result |
|--------|-----------|---------------|
| Monaco editor options | **10px** | Matches VS Code scrollbar width |
| CSS `::-webkit-scrollbar` | **14px** | Matches VS Code scrollbar width |
| OverlayScrollbars theme CSS | **14px** | Matches VS Code scrollbar width |

Setting all three to the same number (e.g. 14px) produces Monaco scrollbars
that are visually **wider** than the page/CSS scrollbars. The ~4px difference
compensates for Monaco's internal track padding.

**All 6 Monaco editor creation sites** set scrollbar sizes inline — there is
no shared options object:
- `src/webview/monaco/monaco.ts` — KQL editor
- `src/webview/core/section-factory.ts` — Python editor (legacy)
- `src/webview/sections/kw-python-section.ts` — Python editor (Lit)
- `src/webview/sections/kw-html-section.ts` — HTML editor
- `src/webview/sections/kw-sql-section.ts` — SQL editor (also sets `horizontal: 'hidden'`)
- `src/host/diffViewerUtils.ts` — Diff editor (webview panel, string-injected JS)

## Converted Scrollbars

### Body-level page scroll (main .kqlx/.kql webview)
- **Strategy:** A (DOM Overlay via OverlayScrollbars)
- **Files:** `overlay-scrollbars.ts`, `queryEditorHtml.ts`, `esbuild.js`
- **Result:** Full VS Code-style overlay scrollbar, no arrows, auto-hide on idle

### All Lit Shadow DOM components (29 components)
- **Strategy:** B (CSS-only via `scrollbarSheet`)
- **Files:** `scrollbar-styles.ts`, `index.ts`, every component `.ts` file
- **Components:** kw-chart-section, kw-transformation-section, kw-url-section,
  kw-query-section, kw-sql-section, kw-html-section, kw-python-section,
  kw-markdown-section, kw-connection-manager, kw-cached-values, kw-diff-view,
  kw-filter-dialog, kw-copilot-chat, kw-object-viewer,
  kw-cell-viewer, kw-kind-picker, kw-chart-tooltip, kw-dropdown,
  kw-function-params-dialog, kw-kusto-connection-form, kw-popover,
  kw-schema-info, kw-search-bar, kw-section-reorder-popup, kw-section-shell,
  kw-sort-dialog, kw-sql-connection-form, kw-unique-values-dialog
- **Result:** Themed colors via CSS variables. On Chromium 134+ the webkit
  rules are no-ops; inner scrollbars render as native. To fully fix these,
  upgrade individual containers to Strategy A.

### kw-data-table (`.vscroll` container — horizontal + vertical)
- **Strategy:** A (DOM Overlay via OverlayScrollbars)
- **Files:** `kw-data-table.ts`, `table-virtual-scroll.controller.ts`,
  `os-theme-styles.ts` (new shared sheet)
- **How:** OverlayScrollbars initialized on `.vscroll` in `firstUpdated()`.
  The TanStack virtualizer's scroll element is re-pointed at
  `instance.elements().viewport` via `_vScrollCtrl.setScrollElement()`.
  `osThemeSheet` added to `static styles` for Shadow DOM theme overrides.
  Instance destroyed in `disconnectedCallback()`. Re-initialized when
  `_bodyVisible` toggles to `true` (conditional rendering).
- **Result:** Full VS Code-style overlay scrollbar on both axes, no arrows,
  compatible with virtual scrolling.

### Removed redundant per-component scrollbar CSS
- `queryEditor-chart-builder.css` — removed `.kusto-chart-controls-scroll` scrollbar block
- `kw-chart-section.styles.ts` — removed `.chart-controls-scroll` scrollbar rules + dropdown `scrollbar-width: thin`
- `kw-transformation-section.styles.ts` — same pattern as chart section
- `kw-url-section.styles.ts` — removed `scrollbar-width: thin`
- `kw-connection-manager.styles.ts` — removed global `*` scrollbar block + webkit rules
- `kw-cached-values.styles.ts` — removed `.scrollPane` scrollbar rules (12px overrides)

## Upgrading an Inner Container to Strategy A

To convert an inner scrollable container from Strategy B (CSS-only, arrows
on Windows) to Strategy A (DOM overlay, no arrows):

### Critical: Shadow DOM requires adopted library CSS

The OverlayScrollbars library CSS is inlined into the document `<style>` tag
for the light DOM. **But CSS cannot penetrate Shadow DOM boundaries.** The
library's structural CSS (including `scrollbar-width: none !important` which
hides the native scrollbar) MUST be adopted into the shadow root or the
native scrollbar will still render unchanged.

**This is the #1 reason overlay scrollbars fail silently in Shadow DOM
components.** The JS initializes fine, the DOM overlay elements are created,
but the native scrollbar isn't hidden because the CSS rules don't reach
inside the shadow boundary.

### Shared sheets for Shadow DOM

| Sheet | File | Purpose |
|-------|------|---------|
| `osLibrarySheet` | `src/webview/shared/os-library-styles.ts` | Full OverlayScrollbars CSS (14KB) — structural positioning, `scrollbar-width: none`, visibility transitions. **Auto-generated** by `scripts/generate-os-library-styles.mjs` from the npm package CSS. |
| `osThemeSheet` | `src/webview/shared/os-theme-styles.ts` | VS Code theme overrides — 14px width, transparent track, theme-colored thumb. Hand-written, small. |

Both must be in the component's `static styles` array for OverlayScrollbars
to work inside Shadow DOM.

### Step-by-step

1. **Add imports:**
   ```ts
   import { OverlayScrollbars } from 'overlayscrollbars';
   import { osLibrarySheet } from '../shared/os-library-styles.js';
   import { osThemeSheet } from '../shared/os-theme-styles.js';
   ```

2. **Adopt sheets into Shadow DOM** — add to `static styles`:
   ```ts
   static styles = [scrollbarSheet, osLibrarySheet, osThemeSheet, styles];
   ```

3. **Initialize in `firstUpdated()`:**
   ```ts
   private _osInstance: ReturnType<typeof OverlayScrollbars> | null = null;

   protected firstUpdated(): void {
     const el = this.shadowRoot!.querySelector('.my-scroll-container')!;
     this._osInstance = OverlayScrollbars(el, {
       scrollbars: { visibility: 'auto', autoHide: 'move', autoHideDelay: 800, autoHideSuspend: true },
       overflow: { x: 'hidden', y: 'scroll' },
     });
   }
   ```

4. **If using a virtualizer** (TanStack Virtual, etc.), re-point it at the
   OverlayScrollbars viewport element:
   ```ts
   const viewport = this._osInstance.elements().viewport;
   this._vScrollCtrl.setScrollElement(viewport as HTMLElement);
   ```
   The virtualizer's `getScrollElement` must return the library's internal
   viewport, not the original container — because OverlayScrollbars moves
   scroll handling to that viewport.

5. **Cleanup in `disconnectedCallback()`:**
   ```ts
   disconnectedCallback(): void {
     super.disconnectedCallback();
     this._osInstance?.destroy();
     this._osInstance = null;
   }
   ```

6. **Handle conditional rendering** — if the scroll container is conditionally
   rendered (e.g. `_bodyVisible` toggle), re-init in `updated()`:
   ```ts
   protected updated(changed: PropertyValues): void {
     if (changed.has('_bodyVisible') && this._bodyVisible) {
       this._initOverlayScrollbars();
     }
   }
   ```
   Use `OverlayScrollbars.valid(this._osInstance)` to skip re-init if
   already active.

### Generating `osLibrarySheet`

The `os-library-styles.ts` file is **auto-generated** from the npm package:
```
node scripts/generate-os-library-styles.mjs
```
This reads `node_modules/overlayscrollbars/styles/overlayscrollbars.min.css`,
wraps it in a `new CSSStyleSheet()` + `replaceSync()`, and writes
`src/webview/shared/os-library-styles.ts`. It runs automatically during
`node esbuild.js` (added as a pre-step in esbuild.js). Re-run it after
upgrading the `overlayscrollbars` npm package.

## Build Pipeline

- **Library JS:** Bundled into `dist/webview/webview.bundle.js` by esbuild
  (imported from `overlayscrollbars` npm package)
- **Library CSS — light DOM (14KB min):** Copied from
  `node_modules/overlayscrollbars/styles/overlayscrollbars.min.css` to
  `dist/webview/styles/overlayscrollbars.min.css` by `esbuild.js`, then
  inlined into the webview's `<style>` tag by `queryEditorHtml.ts` (prepended
  before the app CSS bundle)
- **Library CSS — Shadow DOM:** Auto-generated as a constructable
  `CSSStyleSheet` in `src/webview/shared/os-library-styles.ts` by
  `scripts/generate-os-library-styles.mjs` (runs as a pre-step in esbuild.js).
  Components adopt it via `static styles = [osLibrarySheet, ...]`.
- **Theme overrides (`osThemeSheet`):** Shared `CSSStyleSheet` in
  `src/webview/shared/os-theme-styles.ts`. Applied document-wide via
  `overlay-scrollbars.ts` and per-component via `static styles`.
- **scrollbarSheet (Strategy B):** Applied via `document.adoptedStyleSheets`
  in `index.ts` + per-component `static styles` arrays

## Don'ts

- **Don't use `scrollbar-width: thin`** to try to make scrollbars smaller —
  it keeps arrows on Windows and overrides webkit pseudo-elements.
- **Don't combine `::-webkit-scrollbar` with `scrollbar-width`/`scrollbar-color`** —
  the standards properties win and webkit rules are silently ignored.
- **Don't use `::-webkit-scrollbar-button { display: none }`** to hide arrows —
  it doesn't work in Chromium 134+.
- **Don't initialize OverlayScrollbars on `<body>` directly** if the codebase
  reads `document.documentElement.scrollTop` — the library moves scroll to an
  internal viewport div. Use the wrapper strategy instead and patch scroll APIs.
- **Don't hand-write the OverlayScrollbars CSS** — the library's own CSS is
  complex (200+ rules) and handles edge cases like RTL, resize observers, and
  scrollbar hiding across browsers. Always use the official minified CSS.
- **Don't forget `osLibrarySheet` in Shadow DOM components** — this is the #1
  cause of "OverlayScrollbars initialized but native scrollbar still showing."
  The library CSS cannot penetrate Shadow DOM boundaries. You MUST add
  `osLibrarySheet` to the component's `static styles` array.
