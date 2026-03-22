# Architecture

## Overview

Kusto Workbench is a VS Code extension that provides a notebook-like experience for Kusto Query Language (KQL). The extension consists of three major subsystems:

1. **Extension host** (Node.js / TypeScript) — manages the VS Code integration, query execution, authentication, and schema handling.
2. **Webview UI** (browser / TypeScript / Lit) — the notebook editor rendered inside a VS Code webview panel.
3. **KQL language service** — a custom, lightweight diagnostics and analysis engine for KQL.

## Extension Host (`src/host/`)

| File | Purpose |
| ---- | ------- |
| `extension.ts` | Entry point. Registers providers, commands, and diagnostics |
| `queryEditorProvider.ts` | Core class (~4500 lines). Manages the webview panel, handles all webview↔extension messages, query execution |
| `queryEditorCopilot.ts` | Copilot integration (extracted from provider) |
| `queryEditorConnection.ts` | Connection management (extracted from provider) |
| `queryEditorSchema.ts` | Schema handling (extracted from provider) |
| `queryEditorTypes.ts` | Shared types, including `IncomingWebviewMessage` |
| `kustoClient.ts` | Azure Kusto client wrapper. Authentication, query execution, schema fetching, caching |
| `connectionManager.ts` | Persists Kusto cluster connections in VS Code global state |
| `connectionManagerViewer.ts` | Connection manager webview panel |
| `kqlxEditorProvider.ts` | Custom editor for `.kqlx` and `.mdx` notebook files |
| `kqlCompatEditorProvider.ts` | Custom editor for `.kql`/`.csl` files (compatibility mode) |
| `mdCompatEditorProvider.ts` | Custom editor for `.md` files with embedded KQL |
| `kqlxFormat.ts` | Type definitions for the `.kqlx` JSON file format (`KqlxSectionV1`, `KqlxStateV1`) |
| `schemaCache.ts` | Disk-based caching for database schemas |
| `schemaIndexUtils.ts` | Schema formatting utilities for compact text representation |
| `kqlSchemaInference.ts` | Extracts table/function references from KQL for schema matching |
| `queryEditorHtml.ts` | HTML rendering for the query editor webview |
| `selectionTracker.ts` | Tracks text editor selections for compatibility mode |
| `diffViewerUtils.ts` | Utilities for rendering diff views |
| `cachedValuesViewer.ts` | Cached values viewer panel |
| `kustoWorkbenchTools.ts` | VS Code agent tool registrations |
| `copilotConversationUtils.ts` | Copilot conversation message building utilities |
| `remoteFileOpener.ts` | Remote file opening support |

## KQL Language Service (`src/host/kqlLanguageService/`)

A custom, lightweight language service for KQL diagnostics and analysis:

| File | Purpose |
| ---- | ------- |
| `service.ts` | Core diagnostics engine (~2100 lines). Parses KQL, detects errors, tracks column availability |
| `host.ts` | Bridge between extension and language service. Resolves schema context |
| `protocol.ts` | Type definitions for diagnostics, positions, ranges (LSP-compatible) |

## Webview UI (`src/webview/`)

The notebook UI runs as a VS Code webview, built with Lit web components and legacy bridge modules:

| Directory / File | Purpose |
| ---------------- | ------- |
| `index.ts` | esbuild entry — imports all modules in load order |
| `queryEditor.js` | Pre-load stub (queues clicks before bundle loads) |
| `vscodeApi.js` | `acquireVsCodeApi()` bridge (separate `<script>` tag for browser-ext shim replacement) |
| `sections/` | Lit web components for each section type |
| `components/` | Reusable Lit components (`kw-data-table`, `kw-dropdown`, etc.) |
| `modules/` | Legacy bridge modules absorbed from global-scope JS |
| `shared/` | Pure utility modules importable by both components and modules |
| `styles/` | CSS files |
| `viewers/` | Viewer components (cell viewer, object viewer, etc.) |

### Key Modules (`src/webview/modules/`)

| Module | Purpose |
| ------ | ------- |
| `main.ts` | Event handlers, keyboard shortcuts, modal dialogs, message dispatcher |
| `queryBoxes.ts` | Query box creation, Monaco editor setup, toolbar wiring |
| `queryBoxes-execution.ts` | Query execution, results display, optimization |
| `queryBoxes-toolbar.ts` | Toolbar controls (caret docs, autocomplete, run mode, share) |
| `monaco.ts` | Monaco Editor configuration, KQL completions, column inference |
| `monaco-completions.ts` | Completion providers (columns, functions, tables) |
| `monaco-diagnostics.ts` | Real-time KQL diagnostics overlay |
| `state.ts` | Global state: connections, editors, schemas, caches |
| `resultsTable.ts` | Query results rendering with virtual scrolling |
| `resultsState.ts` | Results display state management |
| `persistence.ts` | State serialization for `.kqlx` files |
| `extraBoxes.ts` | Python, URL section creation + shared chart/data-source utilities |
| `extraBoxes-chart.ts` | Chart section creation and ECharts rendering |
| `extraBoxes-transformation.ts` | Transformation section creation |
| `extraBoxes-markdown.ts` | Markdown section creation |
| `schema.ts` | Schema display and navigation |
| `dropdown.ts` | Custom dropdown/menu component |
| `utils.ts` | Shared utility functions |

### Lit Section Components (`src/webview/sections/`)

| Component | File | Purpose |
| --------- | ---- | ------- |
| `kw-query-section` | `kw-query-section.ts` | KQL query editor with connection picker, execution, results |
| `kw-chart-section` | `kw-chart-section.ts` | Chart builder (line, area, bar, scatter, pie, funnel via ECharts) |
| `kw-transformation-section` | `kw-transformation-section.ts` | Data transformation expressions |
| `kw-markdown-section` | `kw-markdown-section.ts` | Rich text / documentation (Toast UI editor) |
| `kw-python-section` | `kw-python-section.ts` | Python code cells |
| `kw-url-section` | `kw-url-section.ts` | Embedded web content / images |

### Reusable Lit Components (`src/webview/components/`)

| Component | Purpose |
| --------- | ------- |
| `kw-data-table` | Virtual-scrolling data table with sort, filter, search, column jump |
| `kw-dropdown` | Dropdown/menu component with keyboard navigation |
| `kw-section-shell` | Shared section wrapper (drag handle, collapse, remove, name) |
| `kw-copilot-chat` | Copilot chat panel within a query section |
| `kw-popover` | Reusable popover component |
| `kw-filter-dialog` | Column filter dialog |
| `kw-sort-dialog` | Column sort dialog |
| `kw-search-bar` | Reusable search bar with match navigation |
| `kw-object-viewer` | JSON/object viewer modal |

### Shared Utilities (`src/webview/shared/`)

| Module | Purpose |
| ------ | ------- |
| `chart-utils.ts` | Number formatting, axis settings, legend normalization, UTC date utilities |
| `transform-expr.ts` | Expression tokenizer/parser/evaluator for transformation sections |
| `data-utils.ts` | Cell value conversion, time axis inference, column name normalization |
| `persistence-utils.ts` | URL normalization, leave-no-trace checks, byte length, result serialization |
| `schema-utils.ts` | `buildSchemaInfo()` pure function |
| `persistence-state.ts` | Shared persistence state object |
| `webview-messages.ts` | Typed `postMessage` wrapper |
| `lazy-vendor.ts` | Lazy loading for vendor libraries |
| `chart-renderer.ts` | ECharts rendering delegation |

## Host ↔ Webview Communication

Extension host and webview communicate via `postMessage`:

* **Host → Webview:** `this.postMessage({ type: '...', ... })` in `QueryEditorProvider`
* **Webview → Host:** `vscode.postMessage({ type: '...', ... })` via `postMessageToHost()` in `webview-messages.ts`

On the host side, incoming messages match the `IncomingWebviewMessage` union type exported from `queryEditorTypes.ts`. On the webview side, the message dispatcher lives in `main.ts` (a large `switch` statement).

## Window Bridges (Legacy)

Webview modules communicate via window globals declared in `window-bridges.d.ts`. This is a legacy pattern from when modules were loaded as separate `<script>` tags. The codebase is being progressively migrated to ES module imports between modules.

## File Formats

### `.kqlx` / `.mdx` (Kusto Notebook)

JSON format with a `sections` array. Each section has a `type` discriminator and type-specific fields. Type definitions live in `kqlxFormat.ts`.

### Section Types

| Type | Component | Purpose |
| ---- | --------- | ------- |
| `query` | `kw-query-section` | KQL query editor with execution and results |
| `markdown` | `kw-markdown-section` | Rich text / documentation |
| `python` | `kw-python-section` | Python code cells |
| `url` | `kw-url-section` | Embedded web content |
| `chart` | `kw-chart-section` | Visualization configs (ECharts) |
| `transformation` | `kw-transformation-section` | Data transformation expressions |

> A legacy `copilotQuery` type also exists for backward compatibility. It is treated as `query` at load time and should not be used in new code.

### Key Types

```typescript
KqlxSectionV1   // Union type for all section kinds
KqlxStateV1     // Root document state with sections array

DatabaseSchemaIndex {
  tables: string[];
  columnTypesByTable: Record<string, Record<string, string>>;
  functions?: KustoFunctionInfo[];
  rawSchemaJson?: unknown;
}

KustoConnection {
  id: string;
  name: string;
  clusterUrl: string;
  database?: string;
}
```

## Schema Caching

* **In-memory:** `schemaCache` Map in `KustoQueryClient`
* **On-disk:** SHA1-hashed JSON files in `globalStorageUri/schemaCache/`
* **Version:** `SCHEMA_CACHE_VERSION` constant triggers cache invalidation on format changes

## Diagnostic Codes

Custom diagnostics use codes like:

* `KW_EXPECTED_PIPE` — Missing pipe operator
* `KW_UNKNOWN_COLUMN` — Column not found in schema
* See `service.ts` for the full list

## Error Message Formatting

User-facing errors are formatted via `formatQueryExecutionErrorForUser()` in `queryEditorProvider.ts`. This converts raw Kusto errors into actionable, user-friendly guidance.

## Popup & Dropdown Dismiss-on-Scroll Policy

All floating UI elements (popups, dropdowns, menus, tooltips) are **dismissed on scroll**, never anchored to move with the viewport. This matches VS Code's native behavior.

| Category | Behavior | Examples |
| -------- | -------- | -------- |
| **Ephemeral** | Close immediately on any scroll | Monaco autocomplete, context menus, tooltips, caret docs, hover info |
| **Interactive** | Close when scroll exceeds **20px threshold** | Dropdowns (favorites, clusters, databases, chart type, chart columns), cache settings, run-mode menu, tools menu, share modal |
| **Never anchor** | Never attempt to reposition a popup to follow scroll | All categories — anchoring is explicitly prohibited |

### Why Not Anchor?

Anchoring (repositioning popups on every scroll frame) was considered and rejected because:
- The webview scroll container's rendering pipeline is not under our control, causing visible lag
- `requestAnimationFrame` repositioning still produces janky movement on fast scrolls
- The threshold-based dismiss approach provides a better UX with far less complexity
- VS Code's own dropdown menus use the same dismiss-on-scroll pattern

## Responsive Layout (CSS Container Queries)

The query section header toolbar uses **CSS Container Queries** for responsive layout, not JavaScript. This ensures correct layout immediately when sections are added, without race conditions.

### Breakpoints

Defined in `queryEditor.css` on `.query-header-row-bottom` (which has `container-type: inline-size`):

| Container Width | Layout Mode | Behavior |
| --------------- | ----------- | -------- |
| > 420px | Full | Dropdowns show icon + text |
| ≤ 420px | Minimal | Dropdowns collapse to icon-only (32px) |
| ≤ 200px | Ultra-compact | Also hides refresh, favorite, and schema buttons |

### Why Not JavaScript?

Previously, a 500ms `setInterval` polled element widths using `getBoundingClientRect()`. This caused a race condition: if the timer fired while a newly-added section was in the DOM but not yet laid out (width = 0), incorrect styles were applied. CSS Container Queries are synchronous with layout, eliminating this issue.

### Legacy Classes

The `.is-minimal` and `.is-ultra-compact` classes are still supported in CSS for backwards compatibility, but JavaScript no longer adds them. The container queries handle everything automatically.

## Leave No Trace

"Leave no trace" is a privacy feature that allows users to mark specific Kusto clusters as sensitive. When a cluster is marked:

* **Query results are not persisted**: Tabular results from queries executed against these clusters are never saved to `.kqlx` files or session storage
* **Derived data is also excluded**: Any data derived from query results (chart previews, transformations, etc.) is not persisted
* **Configuration is preserved**: Section configurations (query text, chart settings, etc.) are still saved—only the data itself is excluded

### Implementation

* **Storage**: Leave no trace cluster URLs are stored in VS Code global state under key `kusto.leaveNoTraceClusters`
* **Connection Manager UI**: Clusters section shows a "Mark as Leave no trace" action on hover. A dedicated "Leave No Trace" accordion section displays marked clusters.
* **Persistence Logic**: Before saving, check if a query section's `clusterUrl` matches a leave-no-trace cluster. If matched, strip `resultJson` from that section. Also strip data from chart/transformation sections that reference such query sections.

Key files: `connectionManagerViewer.ts`, `connectionManager.ts`, `persistence.ts`, `queryEditorProvider.ts`.

## Copilot Chat Feature

The Copilot Chat feature integrates with an LLM via VS Code's Copilot API. The UX is a chat window alongside the Kusto query editor, inside a Kusto section. It has a main content view for the conversation, a textbox for user input, and Send/Cancel buttons. The header includes a Clear button to reset conversation history.

The LLM has access to two categories of tools:

* **Optional**: Tools the LLM can choose to use zero or multiple times
* **Final Step**: Tools the LLM must use to provide its response

### Conversation History Management

1. Each Kusto section maintains its own independent conversation history.
2. At the start of every conversation (and after reset), the contents of `copilot-instructions/general-query-rules.md` are included with the first user request. This is displayed with distinctive styling and hover/click actions.
3. Every message, response, and tool call is remembered and included in subsequent messages, unless the user explicitly removes a tool call result or clears the entire history.
4. Tool calls are represented with consistent styling, an inspection action, and the ability to remove the response from history.
5. Notifications not part of the conversation history have distinct styling to indicate the LLM does not see them.
6. Each user message includes the current Kusto query from the editor (if non-blank), displayed with styling similar to tool calls and removable from history.

## Copilot Integration

The extension integrates with VS Code's Copilot APIs for query generation (`startCopilotWriteQuery`) and query optimization (`optimizeQuery`).

### Local Tools (via `getCopilotLocalTools()`)

* `get_extended_schema`
* `get_query_optimization_best_practices` (reads `optimize-query-rules.md`)
* `execute_kusto_query`
* `respond_to_query_performance_optimization_request`
* `respond_to_all_other_queries`
* `ask_user_clarifying_question`

### VS Code Agent Tools (via `registerKustoWorkbenchTools()`)

Registered with `vscode.lm.registerTool()`:

| Tool ID | Tool Reference Name | Purpose |
| ------- | ------------------- | ------- |
| `kusto-workbench_refresh-schema` | `refreshKustoSchema` | Force-refreshes schema from Kusto cluster, updates cache, returns schemas |
| `kusto-workbench_search-cached-schemas` | `searchCachedSchemas` | Searches all cached schemas for tables, columns, functions matching a regex pattern |

## Dependencies

* `@kusto/monaco-kusto` — Monaco Editor KQL language support
* `azure-kusto-data` — Official Kusto client SDK
* `monaco-editor` — Code editor
* `@toast-ui/editor` — WYSIWYG markdown editor
* `echarts` — Charting library

## Test Coverage

Tests are organized under `tests/`:

* **Integration tests** (`tests/integration/`): Run inside VS Code's extension host with full API access.
* **Webview unit tests** (`tests/webview/`): Run via Vitest without VS Code.
* **E2E tests** (`tests/e2e/`): UI automation tests using `vscode-extension-tester` (Selenium).

| Test File | Coverage |
| --------- | -------- |
| `kqlDiagnostics.test.ts` | KQL error detection, pipe operator validation |
| `kqlCompletionColumns.test.ts` | Column completion inference |
| `kqlCompletionColumnsInFunctionArgs.test.ts` | Column inference inside function calls |
| `kqlCompletionFunctions.test.ts` | Function completion |
| `kqlSchemaInference.test.ts` | Table/function extraction from queries |
| `kqlCompatInference.test.ts` | Schema inference for compatibility mode |
| `kqlPrettify.test.ts` | KQL prettification/formatting |
| `kqlSidecar.test.ts` | Sidecar .kql.json file strategy |

## Build System

* **esbuild** bundles the extension (`esbuild.js`)
* Two build targets: extension host bundle and webview bundle
* Development: `npm run watch` (runs `watch:tsc` and `watch:esbuild` in parallel)
* Production: `npm run compile` (type-check + lint + esbuild)
* Distribution: `npm run vsix`
