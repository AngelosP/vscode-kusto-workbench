# Contributing to Kusto Workbench

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

## Project Structure

```
src/
  host/               Extension host (Node.js, TypeScript)
    extension.ts        Entry point — registers providers, commands, diagnostics
    queryEditorProvider.ts  Core query-editor panel management
    queryEditorCopilot.ts   Copilot integration (extracted from provider)
    queryEditorConnection.ts  Connection management (extracted from provider)
    queryEditorSchema.ts    Schema handling (extracted from provider)
    queryEditorTypes.ts     Shared types, including IncomingWebviewMessage
    kustoClient.ts          Azure Kusto client wrapper
    kqlxFormat.ts           .kqlx file format type definitions
    kqlLanguageService/     Custom KQL diagnostics engine
  webview/            Webview UI (browser, TypeScript + Lit)
    index.ts            esbuild entry — imports all modules in load order
    queryEditor.js      Pre-load stub (queues clicks before bundle loads)
    sections/           Lit web components for each section type
    components/         Reusable Lit components (data table, dropdown, etc.)
    modules/            Legacy bridge modules (absorbed from global-scope JS)
    shared/             Pure utility modules (importable by components and modules)
    styles/             CSS files
tests/
  integration/        VS Code extension-host tests (Mocha, run via npm test)
  webview/            Vitest unit tests for webview code
browser-ext/          Chrome/Edge browser extension (separate build, own package.json)
copilot-instructions/ Prompt files for Copilot and agent integrations
```

For a comprehensive file-by-file reference, see [`.github/copilot-instructions.md`](.github/copilot-instructions.md).

## Architecture

### Host ↔ Webview Communication

The extension host and webview communicate via `postMessage`:

- **Host → Webview**: `this.postMessage({ type: '...', ... })` in `QueryEditorProvider`.
- **Webview → Host**: `vscode.postMessage({ type: '...', ... })` from webview modules.

On the host side, incoming messages match the `IncomingWebviewMessage` union type exported from [`queryEditorTypes.ts`](src/host/queryEditorTypes.ts). On the webview side, the message dispatcher lives in [`main.ts`](src/webview/modules/main.ts) (a large `switch` statement).

### Window Bridges (Legacy)

The webview modules communicate via window globals declared in [`window-bridges.d.ts`](src/webview/window-bridges.d.ts). This is a legacy pattern from when modules were loaded as separate `<script>` tags. The codebase is being progressively migrated to ES module imports.

**New code should never add window globals** — use direct imports between modules instead.

### Section Types

The editor supports these section types, defined in [`kqlxFormat.ts`](src/host/kqlxFormat.ts):

| Type | Component | Purpose |
| ---- | --------- | ------- |
| `query` | `kw-query-section` | KQL query editor with execution and results |
| `markdown` | `kw-markdown-section` | Rich text / documentation |
| `python` | `kw-python-section` | Python code cells |
| `url` | `kw-url-section` | Embedded web content |
| `chart` | `kw-chart-section` | Visualization configs (ECharts) |
| `transformation` | `kw-transformation-section` | Data transformation expressions |

> **Note:** A legacy `copilotQuery` type also exists in `kqlxFormat.ts` for backward compatibility. It is treated as `query` at load time and should not be used in new code.

### How to Add a New Section Type

1. **Define the section type** in [`kqlxFormat.ts`](src/host/kqlxFormat.ts) — add a new variant to the `KqlxSectionV1` union type with the fields your section needs to persist.

2. **Create a Lit component** in `src/webview/sections/` (e.g., `kw-my-section.ts` + `kw-my-section.styles.ts`). Register it with `@customElement('kw-my-section')`. Implement a `serialize()` method that returns the shape defined in step 1.

3. **Add a creation function** in `src/webview/modules/` (e.g., in `extraBoxes.ts`) that inserts the `<kw-my-section>` element into the DOM and wires up event listeners.

4. **Add restoration logic** in [`persistence.ts`](src/webview/modules/persistence.ts) — handle the new `type` in the restore loop so `.kqlx` files with your section type are deserialized correctly. Serialization should delegate to the component's `serialize()` method.

5. **Add a message handler** in [`main.ts`](src/webview/modules/main.ts) if your section needs to receive messages from the extension host (e.g., execution results, schema updates).

Import your new component in [`index.ts`](src/webview/index.ts) so it's included in the bundle.

## Code Conventions

- **TypeScript strict mode** is enabled. No `any` where a proper type exists.
- **Lit web components** for all new UI. Shadow DOM for component-owned controls; light DOM (via `<slot>`) for elements that legacy code finds by `document.getElementById()`.
- **CSS Container Queries** for responsive layout (not JavaScript polling).
- **Popups dismiss on scroll** — never anchor floating elements to follow the viewport.
- Error messages shown to users should be **actionable and user-friendly**, not raw backend errors.

See [`.github/copilot-instructions.md`](.github/copilot-instructions.md) for full architecture details, styling rules, and established patterns.
