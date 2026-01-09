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
|------|---------|
| `extension.ts` | Entry point. Registers providers, commands, and diagnostics |
| `queryEditorProvider.ts` | **Core class (~3700 lines)**. Manages the webview panel, handles all webview↔extension messages, query execution, Copilot integration |
| `kustoClient.ts` | Azure Kusto client wrapper. Authentication, query execution, schema fetching, caching |
| `connectionManager.ts` | Persists Kusto cluster connections in VS Code global state |
| `kqlxEditorProvider.ts` | Custom editor for `.kqlx` and `.mdx` notebook files |
| `kqlCompatEditorProvider.ts` | Custom editor for `.kql`/`.csl` files (compatibility mode) |
| `mdCompatEditorProvider.ts` | Custom editor for `.md` files with embedded KQL |
| `kqlxFormat.ts` | Type definitions for the `.kqlx` JSON file format (`KqlxSectionV1`, `KqlxStateV1`) |
| `schemaCache.ts` | Disk-based caching for database schemas |
| `kqlSchemaInference.ts` | Extracts table/function references from KQL for schema matching |

### KQL Language Service (`src/kqlLanguageService/`)

A custom, lightweight language service for KQL diagnostics and analysis:

| File | Purpose |
|------|---------|
| `service.ts` | Core diagnostics engine (~2100 lines). Parses KQL, detects errors, tracks column availability |
| `host.ts` | Bridge between extension and language service. Resolves schema context |
| `protocol.ts` | Type definitions for diagnostics, positions, ranges (LSP-compatible) |

### Webview UI (`media/queryEditor/`)

The notebook UI runs as a VS Code webview. Key files:

| File | Purpose |
|------|---------|
| `main.js` | Event handlers, keyboard shortcuts, modal dialogs |
| `queryBoxes.js` | **Core UI (~6400 lines)**. Query box creation, Monaco editor setup, toolbar, results |
| `monaco.js` | Monaco Editor configuration (~10000 lines). KQL completions, column inference |
| `state.js` | Global state: connections, editors, schemas, caches |
| `resultsTable.js` | Query results rendering with virtual scrolling |
| `vscode.js` | `acquireVsCodeApi()` bridge for webview↔extension communication |
| `schema.js` | Schema display and navigation |
| `persistence.js` | State serialization for `.kqlx` files |
| `copilotQueryBoxes.js` | Copilot chat integration UI |
| `extraBoxes.js` | Markdown, Python, URL, and Chart section types |

## File Formats

### `.kqlx` / `.mdx` (Kusto Notebook)
JSON format with `sections` array containing:
- `type: 'query'` - KQL query boxes
- `type: 'markdown'` - Rich text sections  
- `type: 'python'` - Python code cells
- `type: 'url'` - Embedded web content
- `type: 'chart'` - Visualization configs

### Key Types (from `kqlxFormat.ts`)
```typescript
KqlxSectionV1 // Union type for all section kinds
KqlxStateV1   // Root document state with sections array
```

## Communication Pattern

Extension ↔ Webview communication uses `postMessage`:

- **Extension → Webview:** `this.postMessage({ type: '...', ... })`
- **Webview → Extension:** `vscode.postMessage({ type: '...', ... })`

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

## Testing

Tests are in `src/test/`. Run with `npm test`.

| Test File | Coverage |
|-----------|----------|
| `kqlDiagnostics.test.ts` | KQL error detection, pipe operator validation |
| `kqlCompletionColumns.test.ts` | Column completion inference |
| `kqlCompletionColumnsInFunctionArgs.test.ts` | Column inference inside function calls |
| `kqlCompletionFunctions.test.ts` | Function completion |
| `kqlSchemaInference.test.ts` | Table/function extraction from queries |
| `kqlCompatInference.test.ts` | Schema inference for compatibility mode |

## Build System

- **esbuild** bundles the extension (`esbuild.js`)
- `npm run watch` - Development build with watch mode
- `npm run compile-tests && npm test` - Run tests
- `npm run vsix` - Package for distribution

## Important Patterns

### Error Message Formatting
User-facing errors should be formatted via `formatQueryExecutionErrorForUser()` in `queryEditorProvider.ts`. This converts raw errors into actionable guidance.

### Schema Caching
- In-memory: `schemaCache` Map in `KustoQueryClient`
- On-disk: SHA1-hashed JSON files in `globalStorageUri/schemaCache/`
- Version: `SCHEMA_CACHE_VERSION` constant triggers cache invalidation on format changes

### Diagnostic Codes
Custom diagnostics use codes like:
- `KW_EXPECTED_PIPE` - Missing pipe operator
- `KW_UNKNOWN_COLUMN` - Column not found in schema
- See `service.ts` for full list

## Dependencies

- `@kusto/monaco-kusto` - Monaco Editor KQL language support
- `azure-kusto-data` - Official Kusto client SDK
- `monaco-editor` - Code editor
- `@toast-ui/editor` - WYSIWYG markdown editor
- `echarts` - Charting library

## Copilot Integration

The extension integrates with VS Code's Copilot APIs for:
- Query generation (`startCopilotWriteQuery`)
- Query optimization (`optimizeQuery`)
- Local tools defined in `getCopilotLocalTools()`:
  - `get_extended_schema`
  - `get_query_optimization_best_practices` (reads `optimize-query-rules.md`)
  - `respond_to_query_performance_optimization_request`
  - `respond_to_all_other_queries`