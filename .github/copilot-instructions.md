# VS Code Extension: Kusto Workbench

## Project Overview

This is a VS Code extension that provides a notebook-like experience for Kusto Query Language (KQL), similar to Jupyter notebooks for Python, but better.

## Project Details

* **Extension Name**: Kusto Workbench
* **Internal Name**: vscode-kusto-workbench
* **Language**: TypeScript
* **Purpose**: Create and run Kusto queries and more.

## Development Guidelines

* Follow TypeScript best practices
* Implement proper error handling for query execution
* When given an example of a kusto query where we behave incorrectly, first create a regression test that catches the problem, then fix, then check if the test passes, then check if all the tests pass.

## Application Behavior Guidelines

* The application tries to handle error conditions, and error flows in a graceful manner and as polished as the happy path.
* The application doesn't just show raw error messages from the backend or system. Instead, it provides user-friendly error messages that guide the user on how to resolve the issue or what steps to take next. We might even build entire features around helping the user recover from errors.

## Architecture Overview

### Extension Host (TypeScript - `src/`)

The extension runs in VS Code's extension host and consists of:

| File | Purpose |
| ---- | ------- |
| `extension.ts` | Entry point. Registers providers, commands, and diagnostics |
| `queryEditorProvider.ts` | **Core class (\~4500 lines)**. Manages the webview panel, handles all webview↔extension messages, query execution, Copilot integration |
| `kustoClient.ts` | Azure Kusto client wrapper. Authentication, query execution, schema fetching, caching |
| `connectionManager.ts` | Persists Kusto cluster connections in VS Code global state |
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

### KQL Language Service (`src/kqlLanguageService/`)

A custom, lightweight language service for KQL diagnostics and analysis:

| File | Purpose |
| ---- | ------- |
| `service.ts` | Core diagnostics engine (\~2100 lines). Parses KQL, detects errors, tracks column availability |
| `host.ts` | Bridge between extension and language service. Resolves schema context |
| `protocol.ts` | Type definitions for diagnostics, positions, ranges (LSP-compatible) |

### Webview UI (`media/queryEditor/`)

The notebook UI runs as a VS Code webview. Key files:

| File | Purpose |
| ---- | ------- |
| `main.js` | Event handlers, keyboard shortcuts, modal dialogs |
| `queryBoxes.js` | **Core UI (\~7300 lines)**. Query box creation, Monaco editor setup, toolbar, results |
| `monaco.js` | Monaco Editor configuration (\~10000 lines). KQL completions, column inference |
| `state.js` | Global state: connections, editors, schemas, caches |
| `resultsTable.js` | Query results rendering with virtual scrolling |
| `vscode.js` | `acquireVsCodeApi()` bridge for webview↔extension communication |
| `schema.js` | Schema display and navigation |
| `persistence.js` | State serialization for `.kqlx` files |
| `copilotQueryBoxes.js` | Copilot chat integration UI |
| `extraBoxes.js` | Markdown, Python, URL, and Chart section types |
| `dropdown.js` | Custom dropdown/menu component |
| `cellViewer.js` | Cell viewer for detailed cell inspection |
| `columnAnalysis.js` | Column analysis utilities |
| `objectViewer.js` | Object/JSON viewer modal |
| `diffView.js` | Diff view rendering |
| `searchControl.js` | Search control component |
| `utils.js` | Shared utility functions |

## File Formats

### `.kqlx` / `.mdx` (Kusto Notebook)

JSON format with `sections` array containing:

* `type: 'query'` \- KQL query boxes
* `type: 'markdown'` \- Rich text sections
* `type: 'python'` \- Python code cells
* `type: 'url'` \- Embedded web content
* `type: 'chart'` \- Visualization configs

### Key Types (from `kqlxFormat.ts`)

```typescript
KqlxSectionV1 // Union type for all section kinds
KqlxStateV1   // Root document state with sections array
```

## Communication Pattern

Extension ↔ Webview communication uses `postMessage`:

* **Extension → Webview:** `this.postMessage({ type: '...', ... })`
* **Webview → Extension:** `vscode.postMessage({ type: '...', ... })`

Message types are defined in `IncomingWebviewMessage` union type in `queryEditorProvider.ts`.

## Key Abstractions

### Schema Types

```typescript
DatabaseSchemaIndex {
  tables: string[];
  columnTypesByTable: Record<string, Record<string, string>>;
  functions?: KustoFunctionInfo[];
  rawSchemaJson?: unknown;
}
```

### Connection Types

```typescript
KustoConnection {
  id: string;
  name: string;
  clusterUrl: string;
  database?: string;
}
```

## 'Copilot Chat' feature

* The 'Copilot Chat' feauture in our application is an integration with an LLM via VS Code's Copilot API.
* The UX is a chat window that opens up along side the Kusto query editor, inside a Kusto section. It has a main content view where the conversation with the LLM takes place, a textbox for the user to type the request, and two buttons called 'Send', and 'Cancel'. In the header, there is also a 'Clear' button (with a clear-all icon) that allows users to reset the conversation history.
* The LLM has access to two categories of tools: 'Optional' and 'Final Step'. The 'Optional' category contains tools that the LLM can choose to use zero or multiple times, it's completely up to it. The 'Final Step' category contains the tools that the LLM needs to use to provide its reponse to the user.

**How to manage the convesation history with the LLM**

1. Each Kusto section is completely separate when it comes to the 'Copilot Chat' feature, so when talking about 'maintaining conversation history' it is implied that each Kusto section gets its own conversation history and one section does not affect the other in that regard.
2. At the start of every conversation (and every 'reset' conversation after the clear button is clicked), along with the first request the user sends, we also send the contents of the ./copilot-instructions/general-query-rules.md file. This is styled in a way that is similar to the tool calls, and also the queries, but different enough to tell them apart. It also has an action the user can hover over to view the contents, or click on to open the contents in markdown preview mode (i.e., read-only), in a new tab.
3. Every message, response, and tool call is remembered and included in the next message to the LLM as the conversation progresses within a given Kusto section, unless the user takes explicit action to either a) remove the results of a tool call from the conversation history, or b) clear the entire conversation history.
4. Every tool call the LLM makes is represented in the conversation history with consistent styling, an action that allows the user to inspect the tool call (the exact action is tool specific), and the ability to remove the response from the tool call from the conversation history (helpful when it takes up a lot of space and is no longer needed by the LLM).
5. Every notification / message that is included in the Copilot Chat window that is not part of the conversation history (e.g. notification of a failure and re-try logic) has specific and consistent styling so it is clear it's not part of the conversation history, the LLM does not see it, and it's only something for the user to be aware of.
6. Every message the user sends to the LLM also includes the current Kusto query from the editor if it's not blank. This is also represented in the Copilot Chat window, with styling similar to that of tool calls, but still easy to tell them apart. Just like the tool calls, this UI also gives users the ability to explicitely remove past queries from the conversation history if they are no longer relevant. 
<br>

## Testing

Tests are in `src/test/`. Run with `npm test`.

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
* `npm run watch` \- Development build with watch mode
* `npm run compile-tests && npm test` \- Run tests
* `npm run vsix` \- Package for distribution

## Important Patterns

### Error Message Formatting

User-facing errors should be formatted via `formatQueryExecutionErrorForUser()` in `queryEditorProvider.ts`. This converts raw errors into actionable guidance.

### Schema Caching

* In-memory: `schemaCache` Map in `KustoQueryClient`
* On-disk: SHA1-hashed JSON files in `globalStorageUri/schemaCache/`
* Version: `SCHEMA_CACHE_VERSION` constant triggers cache invalidation on format changes

### Diagnostic Codes

Custom diagnostics use codes like:

* `KW_EXPECTED_PIPE` \- Missing pipe operator
* `KW_UNKNOWN_COLUMN` \- Column not found in schema
* See `service.ts` for full list

## Dependencies

* `@kusto/monaco-kusto` \- Monaco Editor KQL language support
* `azure-kusto-data` \- Official Kusto client SDK
* `monaco-editor` \- Code editor
* `@toast-ui/editor` \- WYSIWYG markdown editor
* `echarts` \- Charting library

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

## Leave No Trace Clusters

"Leave no trace" is a privacy feature that allows users to mark specific Kusto clusters as sensitive. When a cluster is marked as "Leave no trace":

* **Query results are not persisted**: Tabular results from queries executed against these clusters are never saved to `.kqlx` files or session storage
* **Derived data is also excluded**: Any data derived from query results (chart previews, transformations, etc.) is not persisted
* **Configuration is preserved**: Section configurations (query text, chart settings, etc.) are still saved—only the data itself is excluded

### Implementation Details

* **Storage**: Leave no trace cluster URLs are stored in VS Code global state under key `kusto.leaveNoTraceClusters`
* **Connection Manager UI**: 
  - Clusters section shows a "Mark as Leave no trace" action on hover
  - A dedicated "Leave No Trace" accordion section displays marked clusters
  - Users can remove the mark by clicking delete in the Leave No Trace section
* **Persistence Logic**: 
  - Before saving, check if a query section's `clusterUrl` matches a leave-no-trace cluster
  - If matched, strip `resultJson` from that section
  - Also strip data from chart/transformation sections that reference such query sections

### Key Files

| File | Changes |
| ---- | ------- |
| `connectionManagerViewer.ts` | Leave no trace accordion section, mark/unmark actions |
| `connectionManager.ts` | Storage API for leave-no-trace cluster list |
| `persistence.js` | Strip results from leave-no-trace clusters before persisting |
| `queryEditorProvider.ts` | Pass leave-no-trace list to webview |

## Copilot Integration

The extension integrates with VS Code's Copilot APIs for:

* Query generation (`startCopilotWriteQuery`)
* Query optimization (`optimizeQuery`)
* Local tools defined in `getCopilotLocalTools()`:
    * `get_extended_schema`
    * `get_query_optimization_best_practices` (reads `optimize-query-rules.md`)
    * `execute_kusto_query`
    * `respond_to_query_performance_optimization_request`
    * `respond_to_all_other_queries`
    * `ask_user_clarifying_question`

### VS Code Agent Tools (registered via `registerKustoWorkbenchTools()`)

These tools are registered with `vscode.lm.registerTool()` and available to the custom VS Code agent:

| Tool ID | Tool Reference Name | Purpose |
| ------- | ------------------- | ------- |
| `kusto-workbench_refresh-schema` | `refreshKustoSchema` | Force-refreshes schema from Kusto cluster, updates cache, returns schemas |