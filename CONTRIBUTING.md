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
| `npm run test:coverage-gate` | Runs Vitest coverage and fails if statement coverage drops below the recorded baseline |

## Testing Guidelines

- When given an example of a KQL query where the extension behaves incorrectly, **first create a regression test** that catches the problem, then fix the code, then verify the test passes, then verify all tests pass.
- For HTML dashboard, slicer, Power BI export, Power BI publish, dashboard prompt/tool, or exported skill template changes, add focused coverage in the existing webview/host suites when possible. The usual starting points are `tests/webview/host/powerBiExport.test.ts`, `tests/webview/kw-html-section-slicer.test.ts`, `tests/webview/host/message-protocol.test.ts`, and `tests/webview/host/skill-template.test.ts`.
- Integration tests (`tests/integration/`) run inside VS Code's extension host with full API access.
- Webview unit tests (`tests/webview/`) run via Vitest without VS Code.
- E2E tests (`tests/e2e/`) use `vscode-extension-tester` (Selenium). Run with `npm run test:e2e`.

### Coverage Gate

`npm run test:coverage-gate` prevents coverage regressions. It runs the Vitest suite with coverage, reads the `json-summary` output, and fails if statement coverage drops below the recorded baseline minus a 0.5% buffer. The baseline is stored in `scripts/coverage-gate.mjs` — update it when coverage meaningfully increases.

## Project Structure

```
src/
  host/               Extension host (Node.js, TypeScript)
    sql/                SQL-specific host modules (dialects, STS process, downloader)
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
    host/             Pure host-side logic tests (run via Vitest, no VS Code required)
  vscode-extension-tester/  E2E tests (Selenium, run via vscode-ext-test)
    e2e/sql-auth/     SQL feature E2E tests (connection, execution, completions, etc.)
    e2e/kusto-auth/   Kusto feature E2E tests
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
- User-facing errors must be formatted via `formatQueryExecutionErrorForUser()` in `queryEditorUtils.ts`.

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
| `SqlCopilotChatManagerController` | `kw-sql-section` | `sections/sql-copilot-chat-manager.controller.ts` |

## SQL Section Development

SQL sections follow the same patterns as Kusto query sections. Key differences:

* **Connections**: `SqlConnectionManager` (not `ConnectionManager`). IDs use `sql_` prefix. Separate `sqlConnections` state in `state.ts`.
* **Events**: All SQL custom events use `sql-` prefix (e.g. `sql-connection-changed`, `sql-database-changed`).
* **Dialects**: Adding a new SQL backend (e.g. PostgreSQL) requires implementing `SqlDialect` interface, registering in `SqlDialectRegistry`, and adding a Copilot rules file.
* **Copilot**: Uses flavor system — host-side `sqlCopilotFlavor` in `copilotChatFlavor.ts`, webview-side `sqlWebviewFlavor` in `copilot-chat-flavor.ts`.
* **File format**: `.sqlx` files use the same JSON schema as `.kqlx` but only allow SQL sections. Mixed `.kqlx` files can contain both Kusto and SQL sections.
* **IntelliSense**: SQL inline completions are powered by Microsoft's SQL Tools Service (STS), a separate process communicating over JSON-RPC via `vscode-jsonrpc`. The STS binary is downloaded on first use (`stsDownloader.ts`), managed by `StsProcessManager`, and the LSP client layer lives in `StsLanguageService`. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full STS architecture.
* **Build**: `mssql` is externalized in esbuild. `sql-formatter` is bundled for the webview prettify feature.
* **Tests**: SQL unit tests in `tests/webview/host/` (`mssqlDialect.test.ts`, `sqlDialectRegistry.test.ts`, `sqlFormat.test.ts`, `sqlClient.test.ts`, `sqlPrettify.test.ts`, `sqlAuthState.test.ts`, `sqlFavorites.test.ts`, `sqlEditorUtils.test.ts`). E2E tests in `tests/vscode-extension-tester/e2e/sql-auth/`.

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
- **Unused Monaco language workers (`css`, `json`, `ts`) are filtered out** during the copy step to reduce size. The `html` worker is kept for HTML section editing. Do not remove this filtering.
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
const sectionPrefixes = ['query_', 'chart_', 'transformation_', 'markdown_', 'python_', 'url_', 'html_', 'sql_'];
```

The loop iterates DOM children of `#queries-container`, matches their `id` against these prefixes, and calls `el.serialize()`.

### Rules

- **Every new section type must have its prefix added to `sectionPrefixes`.** If omitted, the section will not be saved — data loss.
- **Every Lit section component must implement `serialize()`** returning a JSON-serializable object with a `type` field matching the `KqlxSectionV1` union.
- **`schedulePersist()` computes a JSON signature to avoid unnecessary disk writes.** Do not bypass this with direct `postMessage` persistence calls.
- **Leave No Trace**: Sections connected to a leave-no-trace cluster have their `resultJson` stripped before persistence. If you add new data fields to section serialization, verify they respect this check (see [ARCHITECTURE.md](ARCHITECTURE.md) for details).

### HTML Dashboard Serialization

HTML sections persist source and configuration, not data snapshots. The serialized shape must stay aligned between `kqlxFormat.ts` and `kw-html-section.ts`:

- Persist `type: 'html'`, `code`, `mode`, `expanded`, `editorHeightPx`, `previewHeightPx`, `dataSourceIds`, and optional `pbiPublishInfo`.
- `dataSourceIds` are references to source query/transformation sections derived from provenance and section wiring; do not duplicate result rows inside the HTML section.
- `pbiPublishInfo` is metadata returned by Fabric/Power BI publish (`workspaceId`, model/report IDs, report name, URL, selected data mode). Preserve it across save/restore so republish can update the existing report with the intended Import/DirectQuery behavior.
- After a publish updates `pbiPublishInfo`, ensure persistence is scheduled/flushed through the normal persistence path rather than ad hoc host messages.
- If dashboard fields ever start carrying derived query data, update Leave No Trace stripping first.

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

## Section Resize — Max Heights & Fit-to-Contents

Sections with a Monaco editor and tabular results (Kusto query, SQL) enforce a specific resize contract. See [ARCHITECTURE.md](ARCHITECTURE.md) for the full design.

### What must not change

- **`monaco-editor-max-height` is 750px.** The editor sash drag, fit-to-contents, double-click, and auto-resize must all cap the editor wrapper at 750px. Do not allow any code path to exceed this.
- **Results sash drag must be capped at `section-max-height`** (data table content + 10px gap). Results fit-to-contents / double-click caps at `min(section-max-height, 750px)`.
- **Fit-to-contents and double-click on sashes must share the same calculation.** Do not add separate code paths.
- **Fit-to-contents on the section shell = fit editor + fit results (when visible).** The shell button must size both the editor and the results area. When tabular results are hidden, only the editor is adjusted. Individual sash double-clicks only resize their respective area.
- **Auto-resize (grow-only) is capped at 750px** (`monaco-editor-max-height`). It grows to content height up to this cap and is disabled once the user manually resizes.

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

## HTML Dashboards And Power BI Checklist

Use this checklist when changing `kw-html-section`, dashboard prompts/tools, `powerBiExport.ts`, `powerBiPublish.ts`, or related message contracts.

1. **Preserve provenance v1 compatibility.** Dashboards use `<script type="application/kw-provenance">` with `model.fact`, optional `model.dimensions`, and `bindings`. Treat schema changes as compatibility-sensitive.
2. **Use `data-kw-bind` for exportable values.** Preview JavaScript can enhance the dashboard, but Power BI output is generated from provenance bindings and `data-kw-bind` targets. JS-only DOM updates do not become Power BI visuals.
3. **Keep exportable visual parity explicit.** HTML dashboard charts should use `KustoWorkbench.renderChart(bindingId)` in preview and provenance chart bindings for export. Exportable tables should use `KustoWorkbench.renderTable(bindingId)`, repeated grouped table sections should use `KustoWorkbench.renderRepeatedTable(bindingId)`, and table-cell visuals should live in provenance `columns[].cellBar` or `columns[].cellFormat` specs. Preview SVG/HTML and Power BI DAX/SVG should share the same spec, palette, geometry, ordering, top-N, label, legend, and conditional-formatting semantics.
4. **Keep slicer semantics consistent.** Preview slicers are derived from provenance dimensions, filter the fact data client-side, and compose with AND semantics. Power BI export should generate equivalent native slicer visuals bound to fact-table columns where supported.
5. **Keep agent dashboard guidance current.** Dashboard authoring rules live in `copilot-instructions/html-dashboard-rules.md`, are exposed through `getHtmlDashboardGuide`, and should include upgrade-on-touch behavior for existing dashboards. Update `media/skill-template.md` and bump `TEMPLATE_VERSION` in `skillExport.ts` when exported skill behavior changes.
6. **Validate through the export path.** Agent-facing validation should reuse the webview export context and the shared Power BI validation collector so it matches actual export/publish behavior.
7. **Document and test new binding shapes.** If adding scalar/table/repeated-table/pivot/chart display modes, table cell visuals, or `preAggregate` behavior, cover DAX generation and rendered HTML/SVG output in `powerBiExport.test.ts` and preview bridge behavior in webview tests.
8. **Export `.pbip`/PBIR/TMDL, not `.pbix`.** Do not describe or implement this path as direct `.pbix` generation. The project uses the marketplace-signed HTML Content visual rather than importing a local `.pbiviz` file.
9. **Maintain data-mode compatibility.** Generated model queries should continue to use Kusto `AzureDataExplorer.Contents` sources, stable table/column naming, and explicit Import/DirectQuery behavior for local export, new publish, and legacy republish flows.
10. **Preserve Fabric publish/update behavior.** Publishing must support create-new and update-existing flows, item existence checks, stored publish metadata, and non-fatal refresh schedule failures.
11. **Keep host/webview contracts typed.** Any new export/publish message must be added to both `queryEditorTypes.ts` and `webview-messages.ts`, and covered by `message-protocol.test.ts`. Tool-framework messages that intentionally use generic `toolResponse` still need protocol inventory coverage.

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
- [ ] Dashboard/PBI changes include targeted tests for provenance/bindings, slicers, PBIR/TMDL generation, or publish message contracts as appropriate.
- [ ] Vitest decorator plugin settings unchanged.

### Architecture
- [ ] No new window globals added to `window-bridges.d.ts`.
- [ ] No new UI framework introduced (only Lit for components).
- [ ] No JavaScript-based responsive layout (CSS Container Queries only).
- [ ] No scroll-anchored popups/dropdowns.
- [ ] Webview import order in `index.ts` preserved (`state` first, `main` last, diagnostics/completions before monaco).
- [ ] New section types follow the [full checklist](#new-section-types--checklist) including `sectionPrefixes`.
- [ ] HTML dashboard changes follow the [dashboard checklist](#html-dashboards-and-power-bi-checklist), including provenance and `data-kw-bind` compatibility.
- [ ] Lazy-loaded vendors remain lazy (no direct imports).
- [ ] Toast UI AMD hack preserved if touching vendor loading.

### UX
- [ ] Error messages are user-friendly and actionable, not raw backend errors.
- [ ] Error flows are polished, not degraded.
- [ ] Leave No Trace respected — new data fields on sections are stripped for leave-no-trace clusters.
- [ ] Power BI publish/update UX preserves stored report metadata and makes update-vs-new behavior clear.
- [ ] Floating UI dismisses on scroll per the policy.

### Dependencies
- [ ] No large new runtime dependencies without justification and bundle-size check.
- [ ] `monaco-editor` and `@kusto/monaco-kusto` remain in `dependencies` (not `devDependencies`).
- [ ] No duplicate functionality — prefer existing shared utilities over new libraries.
