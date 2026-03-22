# Contributing to Kusto Workbench

For architecture details, file inventories, and design rationale, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Prerequisites

- **Node.js** LTS (20+). The project types target Node 22.x (`@types/node: "22.x"`).
- **VS Code** 1.107 or later (`engines.vscode: "^1.107.0"`).
- Run `npm install` at the repo root to install all dependencies.

## Build Commands

| Command | Purpose |
| ------- | ------- |
| `npm run watch` | Development build with watch mode (auto-recompiles on file changes) |
| `npm run compile` | One-shot production-quality build (type-check + lint + esbuild bundle) |
| `npm run bundle-size` | Print bundle sizes for the extension host and webview outputs |
| `npm run vsix` | Package a `.vsix` for distribution |

## Test Commands

| Command | Purpose |
| ------- | ------- |
| `npm test` | Integration tests — runs inside VS Code's extension host (pretest auto-compiles) |
| `npm run test:webview` | Webview unit tests via Vitest (fast, no VS Code required) |
| `npm run test:webview:coverage` | Same as above with V8 coverage report |
| `npm run test:webview:watch` | Vitest in watch mode for rapid iteration |

## Testing Guidelines

- When given an example of a KQL query where the extension behaves incorrectly, **first create a regression test** that catches the problem, then fix the code, then verify the test passes, then verify all tests pass.
- Integration tests (`tests/integration/`) run inside VS Code's extension host with full API access.
- Webview unit tests (`tests/webview/`) run via Vitest without VS Code.
- E2E tests (`tests/e2e/`) use `vscode-extension-tester` (Selenium). Run with `npm run test:e2e`.

## Project Structure

```
src/
  host/               Extension host (Node.js, TypeScript)
  webview/            Webview UI (browser, TypeScript + Lit)
    core/               Cross-cutting runtime infrastructure (state, persistence, dispatch)
    monaco/             Monaco-specific runtime modules (editor setup, diagnostics, completions)
    generated/          Generated runtime command/function bridges
    sections/           Lit web components for each section type
    components/         Reusable Lit components (data table, dropdown, etc.)
    shared/             Pure utility modules (importable by components and modules)
    styles/             CSS files
tests/
  integration/        VS Code extension-host tests (Mocha, run via npm test)
  webview/            Vitest unit tests for webview code
browser-ext/          Chrome/Edge browser extension (separate build, own package.json)
copilot-instructions/ Prompt files for Copilot and agent integrations (runtime resources)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for file-by-file inventories of each subsystem.

---

## Code Conventions

- **TypeScript strict mode** is enabled in both tsconfigs. No `any` where a proper type exists.
- **Lit web components** for all new UI. Shadow DOM for component-owned controls; light DOM (via `<slot>`) for elements that legacy code finds by `document.getElementById()`.
- **No new window globals.** The codebase uses window globals declared in `window-bridges.d.ts` as a legacy pattern. New code must use direct ES module imports instead. See [Window Bridges Guard](#window-bridges).
- **CSS Container Queries** for responsive layout, not JavaScript polling. See [ARCHITECTURE.md](ARCHITECTURE.md) for breakpoints and rationale.
- **Popups dismiss on scroll** — never anchor floating elements to follow the viewport. See [Popup Implementation Pattern](#popup--dropdown-dismiss-on-scroll-implementation) below.
- **Semicolons required.** Enforced by ESLint.
- **Strict equality (`===`)** only. Enforced by ESLint rule `eqeqeq`.
- **Throw `Error` objects**, not literals. Enforced by ESLint rule `no-throw-literal`.
- **Naming**: Imports must be camelCase or PascalCase (ESLint `@typescript-eslint/naming-convention`).

## Error Handling & UX

- The application treats error flows as first-class — error UX must be as polished as the happy path.
- Never surface raw backend error messages to users. Instead provide actionable, user-friendly guidance. We may build entire features around helping users recover from errors.
- User-facing errors must be formatted via `formatQueryExecutionErrorForUser()` in `queryEditorProvider.ts`.

## CSS & Styling Convention

- Keep component CSS in a sibling `*.styles.ts` file whenever styles are substantial (roughly 100+ lines) or reused across related controls.
- Import styles into the component and assign them with `static override styles = styles;`.
- Prefer this structure for Lit components:

```typescript
import { LitElement, html, type TemplateResult } from 'lit';
import { styles } from './my-component.styles.js';

export class MyComponent extends LitElement {
  static override styles = styles;
}
```

- Keep the style module focused on CSS only:

```typescript
import { css } from 'lit';

export const styles = css`
  :host { display: block; }
`;
```

- Use inline `css` in the component file only for very small, local styles where extracting would hurt readability.
- Preserve the existing VS Code theme variable usage (`--vscode-*`) and do not hardcode app-level colors.

## ReactiveControllers

When a Lit component grows beyond ~1,500 lines or has distinct behavioral concerns, extract each concern into a **ReactiveController** co-located with its host component.

- **Naming**: `{concern}.controller.ts`, next to the host component (in `sections/` or `components/`).
- A controller **owns state**, has lifecycle hooks (`hostConnected`, `hostDisconnected`, `hostUpdate`, `hostUpdated`), and is **independently testable**.
- The host instantiates controllers and reads their state in `render()`.
- Controllers do **NOT** contain render templates — rendering stays in the host.

### Controller inventory

| Controller | Host | File |
| ---------- | ---- | ---- |
| `QueryConnectionController` | `kw-query-section` | `sections/query-connection.controller.ts` |
| `QueryExecutionController` | `kw-query-section` | `sections/query-execution.controller.ts` |
| `CopilotChatManagerController` | `kw-query-section` | `sections/copilot-chat-manager.controller.ts` |
| `ToolbarOverflowController` | `kw-query-toolbar` | `sections/toolbar-overflow.controller.ts` |
| `ChartDataSourceController` | `kw-chart-section` | `sections/chart-data-source.controller.ts` |
| `TableSearchController` | `kw-data-table` | `components/table-search.controller.ts` |
| `TableSelectionController` | `kw-data-table` | `components/table-selection.controller.ts` |
| `TableVirtualScrollController` | `kw-data-table` | `components/table-virtual-scroll.controller.ts` |
| `TableRowJumpController` | `kw-data-table` | `components/table-row-jump.controller.ts` |

---

# Regression Guards

The sections below define the constraints that prevent regressions. Any change that violates these rules must be blocked.

---

## Bundle Format & Build System

The build produces multiple bundles via esbuild (`esbuild.js`). The formats and targets are load-bearing:

| Bundle | Entry | Format | Platform | Output |
| ------ | ----- | ------ | -------- | ------ |
| Extension host | `src/host/extension.ts` | **CJS** | Node | `dist/extension.js` |
| Webview | `src/webview/index.ts` | **IIFE** | Browser (ES2022) | `dist/webview/webview.bundle.js` |
| ECharts vendor | `scripts/echarts-webview-entry.js` | **IIFE** | Browser | `dist/queryEditor/vendor/echarts/echarts.webview.js` |
| Toast UI vendor | `scripts/toastui-editor-webview-entry.js` | **IIFE** | Browser | `dist/queryEditor/vendor/toastui-editor/toastui-editor.webview.js` |
| Styles | `src/webview/styles/index.css` | CSS | — | `dist/webview/styles/queryEditor.bundle.css` |

### What must not change

- **Do not change the webview bundle format from IIFE.** The HTML loads it as a `<script>` tag. Switching to ESM would require corresponding HTML and CSP changes.
- **Do not change the host bundle format from CJS.** VS Code's extension host requires CommonJS.
- **The only external is `vscode`.** All other `dependencies` are bundled into the IIFE/CJS outputs. Do not add externals without understanding the full impact.
- **Do not add esbuild `splitting: true`** for the webview bundle. IIFE format does not support code splitting.

### Bundle Size Tracking

`npm run bundle-size` (via `scripts/bundle-size.mjs`) tracks these files:

1. `extension.js` (host)
2. `webview/webview.bundle.js` (Lit components)
3. `queryEditor/vendor/echarts/echarts.webview.js`
4. `queryEditor/vendor/toastui-editor/toastui-editor.webview.js`
5. `monaco/` directory (recursive size)
6. Total `dist/` directory

**Run `npm run bundle-size` before and after any change that touches dependencies, imports, or build config.** If a bundle grows, justify the increase.

---

## Monaco Editor — Do Not Bundle

Monaco Editor and `@kusto/monaco-kusto` are **not bundled by esbuild**. They are copied as pre-built AMD assets:

- `monaco-editor` → `dist/monaco/vs/`
- `@kusto/monaco-kusto` → `dist/monaco/vs/language/kusto/`

### What must not change

- **Never add `monaco-editor` or `@kusto/monaco-kusto` to an esbuild entry point.** They are AMD modules loaded at runtime by Monaco's AMD loader. Bundling them would break the loader.
- **Unused Monaco language workers (`css`, `html`, `json`, `ts`) are filtered out** during the copy step to reduce size. Do not remove this filtering.
- **Monaco is loaded in the webview via the AMD loader**, not via `import`. Any code that needs Monaco APIs at module scope must handle the case where Monaco is not yet loaded.

---

## TypeScript Configuration — Do Not Weaken

Two tsconfig files exist:

| File | Scope | Module | Target |
| ---- | ----- | ------ | ------ |
| `tsconfig.json` | `src/host` | Node16 | ES2022 |
| `tsconfig.webview.json` | `src/webview` | ESNext (bundler resolution) | ES2022 |

### What must not change

- **`strict: true`** in both configs. Do not disable any strict sub-option.
- **`noImplicitReturns`, `noFallthroughCasesInSwitch`, `noUnusedParameters`** in the host config. Do not relax these.
- **`experimentalDecorators: true`** and **`useDefineForClassFields: false`** in the webview config. These are **required by Lit decorators**. Changing either one will silently break every `@property` and `@state` declaration in every Lit component. The same settings must be mirrored in the Vitest config's esbuild transform plugin.
- **Do not merge the two tsconfigs into one.** The host config targets Node (no DOM lib); the webview config targets browser (DOM lib, bundler module resolution). They have fundamentally different environments.

---

## Vitest Configuration — Mirror Lit Settings

`vitest.config.ts` uses a custom Vite plugin (`esbuild-decorators`) that transforms `.ts` files with `experimentalDecorators: true` and `useDefineForClassFields: false`.

### What must not change

- **The esbuild-decorators plugin must remain active.** Without it, Lit decorators break in tests — `@property`, `@state`, and `@customElement` all fail silently, producing test failures with no clear error message.
- **`environment: 'happy-dom'`** — tests expect a DOM environment.
- **Test glob**: `tests/webview/**/*.test.ts`. Do not change unless the directory structure changes.

---

## Webview Import Order — Matters

`src/webview/index.ts` defines the module import order for the IIFE bundle. Because runtime modules register window globals at import time, **order is load-bearing**:

| Order | Module | Why |
| ----- | ------ | --- |
| **1st** | `core/state.js` | Initializes all `window.*` state globals — every other module depends on this |
| Before monaco | `monaco/diagnostics.js` | Registers bridges that `monaco.js` reads at import time |
| Before monaco | `monaco/completions.js` | Registers completion bridges that `monaco.js` reads at import time |
| After both | `monaco/monaco.js` | Consumes diagnostics and completion bridges |
| **Last** (among runtime modules) | `core/main.js` | Message dispatcher — wires everything together, must see all bridges |
| Any order | Components and sections | Self-register custom elements, no import-order dependencies |

### What must not change

- **`state.js` must be the first module import.** Moving it later will cause undefined globals.
- **`monaco-diagnostics.js` and `monaco-completions.js` must appear before `monaco.js`.** Reversing this causes Monaco to initialize without the KQL diagnostics or completions.
- **`main.js` must be the last module import.** It sets up the `message` event listener that dispatches to all other modules. If another module imports after it and registers bridges, main won't know about them.
- **Components and sections can be in any order** — they self-register via `@customElement()` and have no import-time side effects that depend on other components.

---

## Window Bridges

Window globals in `window-bridges.d.ts` are a legacy communication layer (~250+ declarations). The codebase is migrating away from this pattern.

### Rules

- **Do not add new window globals.** New code must use ES module imports/exports.
- **Do not remove a window bridge without updating all callers** — including `window-bridges.d.ts`, all bridge modules that assign it, and all code that reads it (modules, components, HTML inline scripts). A removed bridge that still has callers will fail silently at runtime, not at compile time, because the type stays in the `.d.ts` as `undefined`.
- **Any window bridge must be declared in `window-bridges.d.ts`** or TypeScript will error when assigning to it. Undeclared bridges bypass type checking entirely.
- **Bridges are assigned at module import time** in the IIFE bundle. Their availability depends on import order (see above).

---

## Lazy Vendor Loading — Do Not Import Directly

ECharts and Toast UI are loaded lazily via `<script>` tag injection (`src/webview/shared/lazy-vendor.ts`). They are **not** ES module imports.

### Rules

- **Never `import echarts`** in webview code. Always use `ensureEchartsLoaded()` from `lazy-vendor.ts` and access `window.echarts`.
- **Never `import @toast-ui/editor`** in webview code. Always use `ensureToastUiLoaded()` from `lazy-vendor.ts` and access `window.toastui.Editor`.
- **The Toast UI AMD compatibility hack is required.** Before injecting the Toast UI `<script>`, the loader temporarily hides `define.amd`, `module`, and `exports` from the global scope. This prevents Toast UI's UMD bundle from detecting Monaco's AMD loader and breaking. Do not remove this.
- **Vendor URLs come from `window.__kustoQueryEditorConfig`**, injected by the extension host HTML template (`queryEditorHtml.ts`). If a new vendor is added, the host must provide its URL.

---

## Section Serialization — Persistence Contract

All sections are serialized via a unified loop in `persistence.ts` (`getKqlxState()`):

```typescript
const sectionPrefixes = ['query_', 'chart_', 'transformation_', 'markdown_', 'python_', 'url_'];
```

The loop iterates DOM children of `#queries-container`, matches their `id` against these prefixes, and calls `el.serialize()`.

### Rules

- **Every new section type must have its prefix added to `sectionPrefixes`.** If omitted, the section will not be saved — data loss.
- **Every Lit section component must implement `serialize()`** returning a JSON-serializable object with a `type` field matching the `KqlxSectionV1` union.
- **`schedulePersist()` computes a JSON signature to avoid unnecessary disk writes.** Do not bypass this with direct `postMessage` persistence calls.
- **Leave No Trace**: Sections connected to a leave-no-trace cluster have their `resultJson` stripped before persistence. If you add new data fields to section serialization, verify they respect this check (see [ARCHITECTURE.md](ARCHITECTURE.md) for details).

---

## Popup & Dropdown Dismiss-on-Scroll Implementation

All floating UI must be dismissed on scroll (see [ARCHITECTURE.md](ARCHITECTURE.md) for the full policy and rationale). For interactive dropdowns, use the 20px threshold pattern:

```typescript
// On open: capture scroll position
const scrollAtOpen = scrollContainer.scrollTop;

// Passive scroll listener (added on open, removed on close)
const onScroll = () => {
  if (Math.abs(scrollContainer.scrollTop - scrollAtOpen) > 20) {
    closeDropdown();
  }
};
scrollContainer.addEventListener('scroll', onScroll, { passive: true });
```

### What must not change

- **Never anchor a popup/dropdown to follow scroll.** This was tried and rejected — see [ARCHITECTURE.md](ARCHITECTURE.md) for the full rationale.
- **Ephemeral UI** (autocomplete, context menus, tooltips) must close immediately on any scroll.
- **Interactive UI** (dropdowns, menus, modals) must close after a 20px scroll threshold.
- **All scroll listeners for dismiss must be `{ passive: true }`** to avoid blocking the scroll thread.

---

## Responsive Layout — CSS Only

The query section header toolbar uses **CSS Container Queries** for responsive layout.

### What must not change

- **Do not add JavaScript-based element width polling** (e.g., `setInterval` + `getBoundingClientRect()`). This was the previous approach and caused a race condition where newly-added sections received wrong styles because their width was 0 during layout. CSS Container Queries are synchronous with layout.
- **Do not remove the container query breakpoints.** The `.is-minimal` and `.is-ultra-compact` legacy CSS classes remain for backward compatibility but are no longer applied by JavaScript.
- Breakpoints are defined in `queryEditor.css` on `.query-header-row-bottom` (see [ARCHITECTURE.md](ARCHITECTURE.md) for values).

---

## Dependency Management

### What must not change

- **Do not move `monaco-editor` or `@kusto/monaco-kusto` from `dependencies` to `devDependencies`.** They are not bundled by esbuild but their files are copied into `dist/` at build time. If they're in `devDependencies`, a `--production` install will exclude them.
- **Do not add large new runtime dependencies without justification.** Run `npm run bundle-size` before and after. Prefer:
  - Tree-shakeable ESM packages over monolithic UMD bundles.
  - Lazy loading (via the `lazy-vendor.ts` pattern) for large vendored libraries.
  - Direct implementation for small utilities instead of pulling in a library.
- **`@tanstack/table-core` and `@tanstack/virtual-core` are bundled into the webview IIFE.** They are small, headless, and framework-agnostic by design. Do not replace them with a larger table library.
- **`lit` is the component framework for all new UI.** Do not introduce an additional UI framework (React, Preact, Svelte, etc.) into the webview bundle.

---

## New Section Types — Checklist

1. **Define the section type** in [`kqlxFormat.ts`](src/host/kqlxFormat.ts) — add a new variant to the `KqlxSectionV1` union type.
2. **Create a Lit component** in `src/webview/sections/` (e.g., `kw-my-section.ts` + `kw-my-section.styles.ts`). Register with `@customElement('kw-my-section')`. Implement `serialize()`.
3. **Add the prefix to `sectionPrefixes`** in [`persistence.ts`](src/webview/core/persistence.ts) — REQUIRED or the section won't be saved.
4. **Add a creation function** in [`section-factory.ts`](src/webview/core/section-factory.ts) that creates the DOM element and wires event listeners.
5. **Add restoration logic** in [`persistence.ts`](src/webview/core/persistence.ts) — handle the new `type` in the restore loop.
6. **Add a message handler** in [`main.ts`](src/webview/core/main.ts) if the section needs messages from the extension host.
7. **Import the component** in [`index.ts`](src/webview/index.ts) (in the components/sections block — order doesn't matter).
8. **Verify Leave No Trace** — if the section can display query results or derived data, implement the stripping logic.

---

## Review Checklist — For Every Change

Use this checklist when reviewing any PR or change:

### Build & Bundle
- [ ] `npm run compile` passes with no errors (type-check + lint + esbuild).
- [ ] `npm run bundle-size` output does not show unexpected growth. If a bundle grew, the increase is justified and documented.
- [ ] No new esbuild externals were added (only `vscode` should be external).
- [ ] Bundle formats unchanged (host = CJS, webview = IIFE, vendors = IIFE).
- [ ] No direct import of `monaco-editor`, `echarts`, or `@toast-ui/editor` in webview code.

### TypeScript
- [ ] `strict: true` not weakened in either tsconfig.
- [ ] `experimentalDecorators` and `useDefineForClassFields` unchanged in `tsconfig.webview.json`.
- [ ] No new `any` types where a proper type exists.
- [ ] No `@ts-ignore` or `@ts-expect-error` without a comment explaining why.

### Tests
- [ ] `npm run test:webview` passes (all Vitest tests).
- [ ] `npm test` passes (all integration tests).
- [ ] Bug fixes include a regression test.
- [ ] New features include tests.
- [ ] Vitest decorator plugin settings unchanged.

### Architecture
- [ ] No new window globals added to `window-bridges.d.ts`.
- [ ] No new UI framework introduced (only Lit for components).
- [ ] No JavaScript-based responsive layout (CSS Container Queries only).
- [ ] No scroll-anchored popups/dropdowns.
- [ ] Webview import order in `index.ts` preserved (`state` first, `main` last, diagnostics/completions before monaco).
- [ ] New section types follow the [full checklist](#new-section-types--checklist) including `sectionPrefixes`.
- [ ] Lazy-loaded vendors remain lazy (no direct imports).
- [ ] Toast UI AMD hack preserved if touching vendor loading.

### UX
- [ ] Error messages are user-friendly and actionable, not raw backend errors.
- [ ] Error flows are polished, not degraded.
- [ ] Leave No Trace respected — new data fields on sections are stripped for leave-no-trace clusters.
- [ ] Floating UI dismisses on scroll per the policy.

### Dependencies
- [ ] No large new runtime dependencies without justification and bundle-size check.
- [ ] `monaco-editor` and `@kusto/monaco-kusto` remain in `dependencies` (not `devDependencies`).
- [ ] No duplicate functionality — prefer existing shared utilities over new libraries.
