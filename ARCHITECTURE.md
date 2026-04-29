# Architecture

## Overview

Kusto Workbench is a VS Code extension that provides a notebook-like experience for Kusto Query Language (KQL) and T-SQL. The extension consists of three major subsystems:

1. **Extension host** (Node.js / TypeScript) — manages the VS Code integration, query execution, authentication, and schema handling.
2. **Webview UI** (browser / TypeScript / Lit) — the notebook editor rendered inside a VS Code webview panel.
3. **KQL language service** — a custom, lightweight diagnostics and analysis engine for KQL.

## Extension Host (`src/host/`)

| File | Purpose |
| ---- | ------- |
| `extension.ts` | Entry point. Registers providers, commands, and diagnostics |
| `queryEditorProvider.ts` | Core class (~4500 lines). Manages the webview panel, handles all webview↔extension messages, query execution, dashboard export/publish routing |
| `queryEditorCopilot.ts` | Copilot integration (extracted from provider) |
| `queryEditorConnection.ts` | Connection management (extracted from provider) |
| `queryEditorSchema.ts` | Schema handling (extracted from provider) |
| `queryEditorTypes.ts` | Shared types, including `IncomingWebviewMessage` |
| `powerBiExport.ts` | HTML dashboard export: generates `.pbip`/PBIR/TMDL Power BI projects backed by Kusto data sources |
| `powerBiPublish.ts` | Fabric/Power BI service publishing: creates or updates SemanticModel and Report items from generated PBIR/TMDL artifacts |
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
| `copilotPromptUtils.ts` | Pure prompt template builders for Copilot optimization and tool definitions |
| `kustoClientUtils.ts` | Pure schema parsing (`extractSchemaFromJson`, `finalizeSchema`), cell formatting, error classification |
| `queryEditorUtils.ts` | Pure query helpers: error formatting, control command detection, query mode, cache directives |
| `remoteFileOpener.ts` | Remote file opening support |
| `sqlConnectionManager.ts` | Persists SQL connections in VS Code global state, passwords in SecretStorage |
| `sqlClient.ts` | SQL query client with pool management, cancelable execution, AAD/SQL Login auth |
| `sqlEditorSchema.ts` | SQL schema caching + webview wiring (`prefetchSqlSchema`/`sqlSchemaData`) |
| `copilotChatFlavor.ts` | Flavor configuration for Copilot chat (Kusto vs SQL) |
| `sql/sqlDialect.ts` | SqlDialect interface + shared types for pluggable SQL backends |
| `sql/mssqlDialect.ts` | MSSQL dialect (pool, execute, schema, error classification) |
| `sql/sqlDialectRegistry.ts` | Dialect registry: register/get/list SQL dialects |
| `sql/sqlAuthState.ts` | Per-connection auth state tracking (AAD vs SQL Login) |
| `sql/stsProcessManager.ts` | SQL Tools Service (STS) process lifecycle: spawn, restart with backoff, JSON-RPC connection |
| `sql/stsLanguageService.ts` | STS language service client: initialize, completion requests, document sync |
| `sql/stsDownloader.ts` | Downloads and extracts the STS binary on first use |

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
| `core/` | Cross-cutting runtime infrastructure (state, persistence, message dispatcher, keyboard, reorder) |
| `monaco/` | Monaco-specific runtime modules (editor wiring, diagnostics, completions, suggestions) |
| `generated/` | Generated control command and function bridge modules |
| `sections/` | Lit web components for each section type |
| `components/` | Reusable Lit components (`kw-data-table`, `kw-dropdown`, etc.) |
| `shared/` | Pure utility modules importable by both components and modules |
| `styles/` | CSS files |
| `viewers/` | Viewer components (cell viewer, object viewer, etc.) |

### Key Runtime Modules (`src/webview/`)

The webview runtime is split into `core/` and `monaco/`:

- `core/`: cross-cutting infrastructure, global orchestration, and section factory
- `monaco/`: editor-specific integrations

| Module | Purpose |
| ------ | ------- |
| `core/main.ts` | Event handlers and webview-level message orchestration |
| `core/message-handler.ts` | Host `postMessage` dispatcher and routing |
| `core/state.ts` | Global state: connections, editors, schemas, caches |
| `core/persistence.ts` | State serialization/restore for `.kqlx` files |
| `core/results-state.ts` | Results display state management |
| `core/keyboard-shortcuts.ts` | Keyboard handlers and clipboard integration |
| `core/drag-reorder.ts` | Section drag-and-drop reorder wiring |
| `core/utils.ts` | Shared runtime utility functions |
| `core/dropdown.ts` | Legacy HTML dropdown/menu rendering and management |
| `core/error-renderer.ts` | Error rendering, navigate-to-line, fallback HTML injection |
| `monaco/monaco.ts` | Monaco editor configuration, KQL integration, column inference |
| `monaco/completions.ts` | Completion providers (columns, functions, tables) |
| `monaco/diagnostics.ts` | Real-time KQL diagnostics overlay |
| `core/section-factory.ts` | Section creation for all types (query, chart, python, URL, etc.), data-source utilities |

### Lit Section Components (`src/webview/sections/`)

| Component | File | Purpose |
| --------- | ---- | ------- |
| `kw-query-section` | `kw-query-section.ts` | KQL query editor with connection picker, execution, results |
| `kw-query-toolbar` | `kw-query-toolbar.ts` | Query toolbar actions (toggles, share, run modes, tools) |
| `query-connection.controller` | `query-connection.controller.ts` | ReactiveController for connection, database, favorites, and schema management |
| `query-execution.controller` | `query-execution.controller.ts` | ReactiveController for query execution, results visibility, optimization |
| `copilot-chat-manager.controller` | `copilot-chat-manager.controller.ts` | ReactiveController for Copilot chat panel installation, visibility, resize, event wiring, and message delegation |
| `toolbar-overflow.controller` | `toolbar-overflow.controller.ts` | ReactiveController for toolbar overflow detection and resize handling |
| `kw-chart-section` | `kw-chart-section.ts` | Chart builder (line, area, bar, scatter, pie, funnel via ECharts) |
| `chart-data-source.controller` | `chart-data-source.controller.ts` | ReactiveController for data source switching, dataset refresh, and per-source column memory |
| `kw-transformation-section` | `kw-transformation-section.ts` | Data transformation expressions |
| `kw-markdown-section` | `kw-markdown-section.ts` | Rich text / documentation (Toast UI editor) |
| `kw-python-section` | `kw-python-section.ts` | Python code cells |
| `kw-url-section` | `kw-url-section.ts` | Embedded web content / images |
| `kw-html-section` | `kw-html-section.ts` | HTML dashboard editor/preview with provenance, slicers, data bridge, and Power BI actions |

### ReactiveController Pattern

When a Lit component has distinct behavioral concerns, each concern is extracted into a **ReactiveController** co-located with its host component (in `sections/` or `components/`). Controllers own state and lifecycle hooks but do not contain render templates — rendering stays in the host component. This keeps components focused and controllers independently testable.

| Controller | Host | Location |
| ---------- | ---- | -------- |
| `QueryConnectionController` | `kw-query-section` | `sections/query-connection.controller.ts` |
| `QueryExecutionController` | `kw-query-section` | `sections/query-execution.controller.ts` |
| `CopilotChatManagerController` | `kw-query-section` | `sections/copilot-chat-manager.controller.ts` |
| `ToolbarOverflowController` | `kw-query-toolbar` | `sections/toolbar-overflow.controller.ts` |
| `ChartDataSourceController` | `kw-chart-section` | `sections/chart-data-source.controller.ts` |
| `TableSearchController` | `kw-data-table` | `components/table-search.controller.ts` |
| `TableSelectionController` | `kw-data-table` | `components/table-selection.controller.ts` |
| `TableVirtualScrollController` | `kw-data-table` | `components/table-virtual-scroll.controller.ts` |
| `TableRowJumpController` | `kw-data-table` | `components/table-row-jump.controller.ts` |

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
| `kw-publish-pbi-dialog` | Power BI/Fabric publish dialog with workspace selection, update/new mode, and publish status |

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
| `error-parser.ts` | Pure error parsing: JSON extraction, line positions, error model builder |
| `viewer-utils.ts` | Pure viewer utilities: JSON formatting, syntax highlighting, value classification |

## Host ↔ Webview Communication

Extension host and webview communicate via `postMessage`:

* **Host → Webview:** `this.postMessage({ type: '...', ... })` in `QueryEditorProvider`
* **Webview → Host:** `vscode.postMessage({ type: '...', ... })` via `postMessageToHost()` in `webview-messages.ts`

On the host side, incoming messages match the `IncomingWebviewMessage` union type exported from `queryEditorTypes.ts`. On the webview side, the message dispatcher lives in `core/message-handler.ts` (a large `switch` statement) and is wired by `core/main.ts`.

Dashboard-specific messages use the same channel. HTML sections send `exportDashboard` to save the dashboard as standalone HTML or a `.pbip` project, and use `getPbiWorkspaces`, `checkPbiItemExists`, and `publishToPowerBI` for Fabric/Power BI service publishing. The host replies with `openPublishPbiDialog`, `pbiWorkspacesResult`, `pbiItemExistsResult`, and `publishToPowerBIResult`, which are routed back to the originating `kw-html-section`/`kw-publish-pbi-dialog`.

## Window Bridges (Legacy)

Webview modules communicate via window globals declared in `window-bridges.d.ts`. This is a legacy pattern from when modules were loaded as separate `<script>` tags. The codebase is being progressively migrated to ES module imports between modules.

## File Formats

### `.kqlx` / `.sqlx` / `.mdx` (Notebooks)

JSON format with a `sections` array. Each section has a `type` discriminator and type-specific fields. Type definitions live in `kqlxFormat.ts`. `.kqlx` files can contain any mix of section types (query, sql, chart, markdown, etc.). `.sqlx` files use the same JSON schema but only allow SQL sections. `.mdx` files are markdown-oriented notebooks.

### Section Types

| Type | Component | Purpose |
| ---- | --------- | ------- |
| `query` | `kw-query-section` | KQL query editor with execution and results |
| `markdown` | `kw-markdown-section` | Rich text / documentation |
| `python` | `kw-python-section` | Python code cells |
| `url` | `kw-url-section` | Embedded web content |
| `chart` | `kw-chart-section` | Visualization configs (ECharts) |
| `transformation` | `kw-transformation-section` | Data transformation expressions |
| `html` | `kw-html-section` | HTML + JS dashboard sections with preview, slicers, data bindings, and Power BI export/publish |
| `sql` | `kw-sql-section` | T-SQL query cells (SQL Server / Azure SQL) |

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

SqlConnection {
  id: string;       // prefix: sql_
  name: string;
  dialect: string;   // e.g. 'mssql'
  serverUrl: string;
  port?: number;
  database?: string;
  authType: string;  // 'aad' | 'sql-login'
  username?: string;
}

HtmlSectionData {
  type: 'html';
  code: string;
  mode: 'code' | 'preview';
  previewHeightPx?: number;
  dataSourceIds?: string[];
  pbiPublishInfo?: PbiPublishInfo;
}

PbiPublishInfo {
  workspaceId: string;
  workspaceName?: string;
  semanticModelId: string;
  reportId: string;
  reportName: string;
  reportUrl: string;
  dataMode?: 'import' | 'directQuery';
}
```

## HTML Dashboard Sections

HTML sections are authored in `kw-html-section.ts` and persist as `type: 'html'` sections in `.kqlx` files. They store the source `code`, display `mode`, editor/preview heights, the referenced `dataSourceIds`, and optional `pbiPublishInfo` after a successful Power BI publish. They do not persist query result data in the HTML section; data remains owned by the source query/transformation sections and is read at runtime.

Dashboard data binding is declared with a provenance block embedded in the HTML source:

```html
<script type="application/kw-provenance">
{
  "version": 1,
  "model": {
    "fact": { "sectionId": "query_...", "sectionName": "..." },
    "dimensions": [
      { "column": "Day", "label": "Date", "mode": "between" }
    ]
  },
  "bindings": {
    "total-calls": { "display": { "type": "scalar", "agg": "COUNT" } }
  }
}
</script>
```

The provenance `model.fact` identifies the event-grain source query section. `model.dimensions` describes slicer columns and modes (`dropdown`, `list`, `between`). `bindings` map `data-kw-bind` element names to display definitions such as scalar, table, repeated table, pivot, and supported chart outputs. Preview rendering injects a sandboxed `window.KustoWorkbench` bridge with helpers such as `getData`, `onDataReady`, `agg`, `bind`, `bindHtml`, `renderChart`, `renderTable`, `renderRepeatedTable`, and formatting utilities.

Slicers are generated from provenance dimensions for preview. They filter the fact rows client-side and compose with AND semantics before bindings are evaluated. Exportable preview charts should call `KustoWorkbench.renderChart(bindingId)`, which renders registered bar, pie, and line bindings as inline SVG using the same chart dimensions, palette, ordering, and label rules as the Power BI DAX/SVG backend. Exportable preview tables should call `KustoWorkbench.renderTable(bindingId)`, which renders provenance table bindings into `<table>` or `<tbody>` targets and supports `columns[].cellBar` stacked SVG bars plus `columns[].cellFormat` conditional badges/highlights inside cells. Exportable repeated tables should call `KustoWorkbench.renderRepeatedTable(bindingId)` into a visible container target. Power BI export uses the same provenance contract but generates DAX/SVG/HTML Content visual output; JavaScript-only DOM updates that are not represented by `data-kw-bind` bindings will not survive the Power BI render path.

The Kusto Workbench agent keeps detailed dashboard authoring rules in `copilot-instructions/html-dashboard-rules.md` and exposes them through the `getHtmlDashboardGuide` tool. The `validateHtmlDashboard` tool asks the active webview for the same export context used by HTML dashboard export/publish, then runs the shared Power BI validation collector in `powerBiExport.ts`. This keeps agent-authored dashboards aligned with the actual `.pbip` export path instead of relying only on prompt guidance.

## Power BI Dashboard Export and Publishing

HTML dashboards can be saved as standalone HTML or exported as a folder-based Power BI project (`.pbip`) from `powerBiExport.ts`. The `.pbip` export writes PBIR report files, TMDL semantic model files, a `_KW_HtmlMeasures` measure table, and an `HTML Dashboard` measure rendered through the marketplace-signed HTML Content visual (`htmlContent443BE3AD55E043BF878BED274D3A6855`). The implementation intentionally targets `.pbip`/PBIR/TMDL, not `.pbix` files.

Exported data sources are generated from referenced Kusto query sections. The semantic model uses `AzureDataExplorer.Contents`, maps Kusto column types to TMDL types, and can generate Kusto tables in Import or DirectQuery mode. Local `.pbip` export and new Power BI service publishing default to Import mode, while legacy republish preserves DirectQuery compatibility unless a mode is selected explicitly. Provenance slicers are emitted as native Power BI visuals bound directly to fact-table columns so filter context reaches DAX measures without generated dimension-table joins. Scalar/table/repeatedTable/pivot/chart dashboard values are generated from the provenance binding definitions, including table visual-cell helpers such as stacked `cellBar` columns and numeric-threshold `cellFormat` styles. Custom JavaScript table bodies produced with `bindHtml()` are preview-only unless the same cells are represented in the table or repeated-table provenance spec.

Power BI service publishing is implemented in `powerBiPublish.ts` using Fabric REST APIs. Publishing creates or updates SemanticModel and Report items in a selected workspace, supports republishing to existing stored IDs, can detect whether the stored report still exists, and persists returned workspace/model/report metadata in `pbiPublishInfo`. Refresh schedule configuration is attempted after publish and treated as non-fatal if it fails.

## Schema Caching

* **In-memory:** `schemaCache` Map in `KustoQueryClient`
* **On-disk:** SHA1-hashed JSON files in `globalStorageUri/schemaCache/`
* **Version:** `SCHEMA_CACHE_VERSION` constant triggers cache invalidation on format changes

## SQL Section Architecture

SQL sections provide a near-identical notebook experience for T-SQL queries against SQL Server / Azure SQL databases. The system mirrors the Kusto architecture with full separation.

### Dialect System

* **`SqlDialect`** interface (`sql/sqlDialect.ts`) — pluggable backend contract: `createPool`, `closePool`, `executeQuery`, `getDatabases`, `getDatabaseSchema`, `isAuthError`, `isCancelError`, `formatError`
* **`MssqlDialect`** (`sql/mssqlDialect.ts`) — first dialect implementation using the `mssql` npm package
* **`SqlDialectRegistry`** (`sql/sqlDialectRegistry.ts`) — register/get/list dialects. Future backends (PostgreSQL, MySQL) require only a new dialect file + registration

### Host Services

* **`SqlConnectionManager`** — CRUD for SQL connections. IDs use `sql_` prefix. Connections in `globalState`, passwords in `SecretStorage`
* **`SqlQueryClient`** — pool management with serialization locks, cancelable query execution (deferred race pattern matching `KustoQueryClient`), AAD auth via `vscode.authentication`
* **`SqlSchemaService`** (`sqlEditorSchema.ts`) — disk + memory schema cache, webview wiring via `prefetchSqlSchema`/`sqlSchemaData` messages

### SQL Tools Service (STS) — IntelliSense Engine

Inline completions for SQL sections are powered by Microsoft's SQL Tools Service, the same engine behind the official SQL Server extension. The STS runs as a separate process communicating over JSON-RPC.

* **`StsDownloader`** (`sql/stsDownloader.ts`) — downloads the platform-specific STS binary on first activation. Stores it in the extension's global storage
* **`StsProcessManager`** (`sql/stsProcessManager.ts`) — spawns the STS process, establishes a `vscode-jsonrpc` `MessageConnection`, handles restarts with exponential backoff (max 2 restarts), and enforces timeouts (15s initialize, 10s per request)
* **`StsLanguageService`** (`sql/stsLanguageService.ts`) — LSP client layer: sends `textDocument/completion` requests, manages document open/change/close lifecycle, translates Monaco positions to LSP positions

### Webview Components

* **`kw-sql-section`** — hybrid light/shadow DOM Lit component (mirrors `kw-query-section`): Monaco editor, server+database dropdowns, action bar with Run/Cancel, results table (`kw-data-table`), Copilot chat pane
* **`kw-sql-toolbar`** — light DOM toolbar: Undo, Redo, Comment, Prettify (`sql-formatter`), Search, Replace, Copilot toggle
* **`sql-copilot-chat-manager.controller.ts`** — ReactiveController managing Copilot chat lifecycle for SQL sections

### Copilot Flavor System

Both Kusto and SQL share the same `CopilotChatManagerController` and `CopilotService` infrastructure. Differences are captured in flavor objects:

* **Host-side:** `CopilotChatFlavor` in `copilotChatFlavor.ts` — `kustoCopilotFlavor` / `sqlCopilotFlavor`. Controls role, language, rules file, feature flags
* **Webview-side:** `WebviewCopilotFlavor` in `copilot-chat-flavor.ts` — `kustoWebviewFlavor` / `sqlWebviewFlavor`. Controls DOM IDs, message types, tool names, CSS classes

SQL Copilot rules: `copilot-instructions/sql-query-rules.md`, optimization rules: `copilot-instructions/optimize-sql-rules.md`

### Agent Tools

4 SQL-specific tools registered in `kustoWorkbenchTools.ts`: `list-sql-connections`, `configure-sql-section`, `get-sql-schema`, `ask-sql-copilot`. The `add-section` tool also accepts `'sql'` as a type. The `list-sections` tool returns `serverUrl` for SQL sections (instead of `clusterUrl`).

### Key Patterns

* SQL events use `sql-` prefix (e.g. `sql-connection-changed`, `sql-database-changed`)
* SQL state is separate: `sqlConnections` / `sqlCachedDatabases` in `state.ts`
* Connection resolution matches by `serverUrl` (lowercase) instead of Kusto's hostname normalization
* `mssql` is externalized in esbuild (native/complex transitive deps)
* File format: `.kqlx` supports mixed Kusto+SQL; `.sqlx` allows only SQL sections

## Diagnostic Codes

Custom diagnostics use codes like:

* `KW_EXPECTED_PIPE` — Missing pipe operator
* `KW_UNKNOWN_COLUMN` — Column not found in schema
* See `service.ts` for the full list

## Error Message Formatting

User-facing errors are formatted via `formatQueryExecutionErrorForUser()` in `queryEditorUtils.ts`. This converts raw Kusto errors into actionable, user-friendly guidance. The function is pure (takes an error message string, cluster URL, and optional database name) and is independently testable.

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

Key files: `connectionManagerViewer.ts`, `connectionManager.ts`, `core/persistence.ts`, `queryEditorProvider.ts`.

## Section Resize, Max Height & Fit-to-Contents

Applies to all section types that contain a Monaco editor and show tabular results (Kusto query sections and SQL sections). Three concepts govern the resize behavior:

### Max Heights (Absolute Ceilings)

These ceilings cannot be exceeded by any operation — not manual sash dragging, not fit-to-contents, not auto-resize.

| Concept | Definition |
| ------- | ---------- |
| **monaco-editor-max-height** | 750px. The absolute maximum height of the Monaco editor wrapper, regardless of content length. |
| **section-max-height** (results area) | If tabular results are visible: the height needed to display all data rows plus the 10px gap (`padding-bottom` on `.results-wrapper`). If no tabular results: the results sash is disabled. |

### Fit-to-Contents & Double-Click on Resize Sashes

Fit-to-contents and double-clicking the resize sashes are **different entry points to the same logic**. They always produce the same result.

- **Double-click on the editor sash** → fit the Monaco editor to the height needed to display all rows without a scrollbar, or `monaco-editor-max-height` (750px), whichever is smaller.
- **Double-click on the results sash** → fit the results area to `section-max-height` or 750px, whichever is smaller.
- **Fit-to-contents button** (on the section shell) → equivalent to double-clicking the editor sash and then the results sash. When tabular results are hidden, only the editor is adjusted.

### Manual Sash Drag

- **Editor sash**: capped at `monaco-editor-max-height` (750px). The user cannot drag the editor wrapper beyond 750px.
- **Results sash**: capped at `section-max-height` (content height + 10px gap). The user can drag up to the full content height but not beyond it.

### Auto-Resize (Grow-Only)

The editor wrapper grows automatically as the user types, up to `monaco-editor-max-height` (750px). It never shrinks below the current height (to avoid jarring collapses). Auto-resize is disabled once the user manually resizes via the sash.

### Key Constants

| Constant | Value | Location | Purpose |
| -------- | ----- | -------- | ------- |
| `FIT_CAP_PX` | 750 | `section-factory.ts`, `kw-sql-section.ts`, `resize.ts` | `monaco-editor-max-height` and fit-to-contents cap for results |
| `FIT_SLACK_PX` | 5 | `section-factory.ts`, `resize.ts` | Extra pixels below editor content |
| `GAP_PX` | 10 | CSS `padding-bottom` on `.results-wrapper` | Gap between table end and section end |

Key files: `core/section-factory.ts`, `monaco/monaco.ts`, `monaco/resize.ts`, `sections/kw-sql-section.ts`, `sections/kw-query-section.ts`.

## Copilot Chat Feature

The Copilot Chat feature integrates with an LLM via VS Code's Copilot API. The UX is a chat window alongside the query editor (Kusto or SQL), inside a section. It has a main content view for the conversation, a textbox for user input, and Send/Cancel buttons. The header includes a Clear button to reset conversation history.

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

Tools are contributed in `package.json` and registered with `vscode.lm.registerTool()` in `kustoWorkbenchTools.ts`; the manifest `name` must match the registration ID. Current registrations cover connection/schema discovery, section lifecycle and configuration, query/chart/transformation/HTML/SQL configuration, delegation to Kusto or SQL Copilot, file creation, and development notes.

HTML dashboard-relevant tools include:

| Tool ID | Tool Reference Name | Purpose |
| ------- | ------------------- | ------- |
| `kusto-workbench_add-section` | `addSection` | Adds notebook sections, including `html` sections |
| `kusto-workbench_configure-html-section` | `configureHtmlSection` | Sets HTML section code/name/mode; dashboard prompts should use `application/kw-provenance` and `data-kw-bind` |

Schema-specific tools still include `kusto-workbench_refresh-schema` and `kusto-workbench_search-cached-schemas`, but they are no longer the full agent tool surface.

## Dependencies

* `@kusto/monaco-kusto` — Monaco Editor KQL language support
* `azure-kusto-data` — Official Kusto client SDK
* `monaco-editor` — Code editor
* `@toast-ui/editor` — WYSIWYG markdown editor
* `echarts` — Charting library
* `mssql` — Node.js SQL Server client (uses tedious). Externalized in esbuild
* `vscode-jsonrpc` — JSON-RPC protocol for STS communication
* Microsoft SQL Tools Service — bundled binary for SQL IntelliSense (downloaded on first use)

## Test Coverage

Tests are organized under `tests/`:

* **Vitest unit tests** (`tests/webview/`): Fast tests that run without VS Code. Covers webview components, shared utilities, and pure host-side logic.
  - `tests/webview/` — webview component and utility tests
  - `tests/webview/host/` — pure host-side logic (no VS Code dependency) tested via Vitest
* **Integration tests** (`tests/integration/`): Run inside VS Code's extension host. Reserved for tests that genuinely need VS Code APIs (webview panel faking, filesystem via `vscode.workspace.fs`, compiled-output extraction).

### Host-side pure utility tests (`tests/webview/host/`)

| Test File | Coverage |
| --------- | -------- |
| `kustoClientUtils.test.ts` | Cell formatting, error classification, schema JSON parsing |
| `queryEditorUtils.test.ts` | Error message formatting, control command detection, query mode, cache directives |
| `kqlxEditorUtils.test.ts` | State normalization, deep equality, section sanitization |
| `copilotPromptUtils.test.ts` | Prompt template building, tool definition enumeration |
| `copilotConversationUtils.test.ts` | Conversation history sanitization, tool call result insertion |
| `queryEditorConnection.test.ts` | URL normalization, connection naming, cluster key generation |
| `kqlSchemaInference.test.ts` | Table/function extraction from KQL queries |
| `kqlxFormat.test.ts` | `.kqlx` file parsing, serialization, creation |
| `schemaIndexUtils.test.ts` | Schema formatting, column counting, token-budget pruning |
| `kqlDiagnostics.test.ts` | KQL error detection, pipe operator validation, statement splitting |
| `message-protocol.test.ts` | Host↔webview message type alignment, payload shape contracts, including dashboard export/publish messages |
| `powerBiExport.test.ts` | HTML dashboard provenance parsing, DAX generation, PBIR/TMDL output, native slicers, Import/DirectQuery model generation, and CSS patching |
| `mssqlDialect.test.ts` | MSSQL dialect: pool creation, query execution, schema extraction, error classification |
| `sqlDialectRegistry.test.ts` | Dialect registry: register, get, list, unknown dialect handling |
| `sqlFormat.test.ts` | `.sqlx` file parsing, serialization, section type validation |
| `sqlClient.test.ts` | SQL query client: pool management, cancellation, auth flows |
| `sqlPrettify.test.ts` | SQL formatting via sql-formatter |
| `sqlAuthState.test.ts` | Per-connection auth state tracking |
| `sqlFavorites.test.ts` | SQL favorites: add, remove, match, persistence |
| `sqlEditorUtils.test.ts` | SQL editor utilities: query mode, error formatting |

### Webview/component tests (`tests/webview/`)

| Test File | Coverage |
| --------- | -------- |
| `kw-html-section-slicer.test.ts` | HTML dashboard preview slicer normalization and filtering behavior |

### Integration tests (`tests/integration/`)

| Test File | Coverage |
| --------- | -------- |
| `kqlCompatInference.test.ts` | Schema inference for `.kql` compatibility mode |
| `kqlSidecar.test.ts` | Sidecar `.kql.json` file strategy |
| `schemaCache.test.ts` | Disk-based schema cache read/write |
| `kqlPrettify.test.ts` | KQL prettification (via compiled output extraction) |
| `kqlCompletionColumns.test.ts` | Column completion inference |
| `kqlCompletionColumnsInFunctionArgs.test.ts` | Column inference inside function calls |
| `kqlCompletionFunctions.test.ts` | Function completion |

### Coverage gate

`npm run test:coverage-gate` fails the build if Vitest statement coverage drops below the recorded baseline. The baseline is stored in `scripts/coverage-gate.mjs`.

## Build System

* **esbuild** bundles the extension (`esbuild.js`)
* Two build targets: extension host bundle and webview bundle
* Development: `npm run watch` (runs `watch:tsc` and `watch:esbuild` in parallel)
* Production: `npm run compile` (type-check + lint + esbuild)
* Distribution: `npm run vsix`
