# Architecture

## Architecture Program

- [GOLDEN_OUTCOME.md](GOLDEN_OUTCOME.md) defines the from-scratch target architecture for the complete implemented product. It is the stable north star, not a description of the current tree.
- [ARCHITECTURE_CONVERGENCE.md](ARCHITECTURE_CONVERGENCE.md) compares the current implementation with that target, ranks remaining ownership gaps, and selects one evidence-driven migration iteration at a time.
- This document describes the implementation that exists today and is updated as convergence work lands.

## Overview

Kusto Workbench is a VS Code extension that provides a notebook-like experience for Kusto Query Language (KQL) and T-SQL. The extension consists of three major subsystems:

1. **Extension host** (Node.js / TypeScript) — manages the VS Code integration, query execution, authentication, and schema handling.
2. **Webview UI** (browser / TypeScript / Lit) — the notebook editor rendered inside a VS Code webview panel.
3. **KQL language service** — a custom, lightweight diagnostics and analysis engine for KQL.

## Extension Host (`src/host/`)

| File | Purpose |
| ---- | ------- |
| `extension.ts` | Entry point. Registers providers, commands, and diagnostics |
| `queryEditorProvider.ts` | Main webview transport/composition adapter. Routes host↔webview messages and retains cross-language query, Copilot, persistence, connection UX, URL acquisition, and comparison adapters |
| `dashboardApplicationHandler.ts` | Injected host application owner for dashboard prompts, export, Fabric workspace/item lookup, publish request identity/cancellation, first-commit admission, document metadata application/compensation leases, and cleanup decisions |
| `artifactCsvSaveApplicationHandler.ts` | Injected host application owner for governed result-table CSV picker admission, one-use nonce challenges, cancellation, deadlines, replay tombstones, exact artifact correlation, and file publication |
| `pythonExecutionApplicationHandler.ts` | Injected host application owner for Python interpreter fallback, process/stdin/stdout/stderr lifecycle, bounded output, timeout/kill behavior, terminal publication, and disposal |
| `importedCsvSaveApplicationHandler.ts` | Injected host application owner for imported URL-section CSV empty-data UX, native picker admission, URI-preserving extension handling, exact UTF-8 publication, saved-file actions, failures, and disposal |
| `querySharingApplicationHandler.ts` | Injected host application owner for Kusto ADX-link generation, Kusto/SQL rich and plain-text share formatting, host clipboard effects, response publication, notifications, and disposal |
| `queryEditorCopilot.ts` | Copilot integration (extracted from provider) |
| `queryEditorConnection.ts` | Connection management (extracted from provider) |
| `queryEditorSchema.ts` | Schema handling (extracted from provider) |
| `kustoConnectionLifecycle.ts` | Serializes Kusto connection and Leave No Trace mutations, revokes affected execution identities, and publishes refreshed connection snapshots |
| `kustoExecutionCoordinator.ts` | Per-editor Kusto reservation, replacement, exact cancellation, dispatch capture, and exactly-once terminal authority |
| `queryRunCoordinator.ts` | Transport-neutral active-query sequence, identity, cancellation, and guarded cleanup |
| `queryEditorTypes.ts` | Shared types, including `IncomingWebviewMessage` |
| `powerBiExport.ts` | HTML dashboard export: generates `.pbip`/PBIR/TMDL Power BI projects backed by Kusto data sources |
| `powerBiPublish.ts` | Fabric/Power BI service publishing: creates or updates SemanticModel and Report items from generated PBIR/TMDL artifacts |
| `kustoClient.ts` | Azure Kusto client wrapper. Authentication, cancelable query attempts with immutable dispatch identity, schema fetching, caching |
| `connectionManager.ts` | Persists Kusto cluster connections and revisioned Leave No Trace state in VS Code global state |
| `kustoLeaveNoTracePolicyStore.ts` | Shared file-locked Kusto privacy policy with atomic snapshots, per-cluster revocation generations, recovery, and cross-window watching |
| `connectionManagerViewer.ts` | Connection manager webview panel |
| `kqlxEditorProvider.ts` | Custom editor for `.kqlx` and `.mdx` notebook files |
| `kqlCompatEditorProvider.ts` | Custom editor for `.kql`/`.csl` files (compatibility mode) |
| `compatSidecarFormat.ts` | Shared pure linked-sidecar URI, validation, hydration, and canonicalization helpers for KQL/SQL compatibility editors |
| `compatSidecarStore.ts` | Shared serialized, lock-protected CAS publication, repair, recovery, and drain mechanics for established compatibility sidecars |
| `compatSidecarSession.ts` | Shared revision, persist queue, upgrade barrier, dirty baseline, final-snapshot, reload, beforeunload, and close state machine |
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
| `editingPreferences.ts` | Revisioned application-backed editing preferences shared across Kusto, SQL, and VS Code windows |
| `firstLaunch/firstLaunchState.ts` | Versioned first-use state, legacy-user detection, and resumable write-journal parsing |
| `firstLaunch/editorAssociationManager.ts` | Serialized ownership-aware updates to global `workbench.editorAssociations` |
| `firstLaunch/firstLaunchCoordinator.ts` | Coalesces file, Activity Bar, and command triggers; commits or recovers setup transactions |
| `firstLaunch/firstLaunchSetupPanel.ts` | Secure singleton host for the first-launch setup webview |
| `firstLaunch/firstLaunchTriggers.ts` | Diff- and sidecar-aware supported-file trigger registration |
| `firstLaunch/firstLaunchProfileLease.ts` | `proper-lockfile`-backed profile lease preventing concurrent setup across VS Code windows |
| `sqlConnectionManager.ts` | Persists SQL connections in VS Code global state, passwords in SecretStorage |
| `sqlClient.ts` | Stable SQL data-plane facade over SQL Tools Service: database/schema discovery, cancelable execution |
| `sqlEditorSchema.ts` | SQL schema caching + webview wiring (`prefetchSqlSchema`/`sqlSchemaData`) |
| `copilotChatFlavor.ts` | Flavor configuration for Copilot chat (Kusto vs SQL) |
| `sql/sqlDialect.ts` | Persisted SQL dialect metadata and shared schema types |
| `sql/mssqlDialect.ts` | MSSQL connection-form metadata (`mssql` ID, auth modes, default port) |
| `sql/sqlDialectRegistry.ts` | Dialect metadata registry used by connection UIs |
| `sql/mssqlSchema.ts` | MSSQL schema catalog queries and transport-neutral parsers |
| `sql/sqlWorkbenchService.ts` | Extension-scoped owner for SQL connections, STS runtime, query broker, and client facade |
| `sql/sqlEditorLifecycleCoordinator.ts` | Editor-scoped SQL lifecycle orchestrator: section incarnations, target transitions, STS documents/replay, request currentness, and connection/principal/privacy invalidation |
| `sql/sqlEditorSessionRegistry.ts` | State-owning editor-scoped SQL target, principal, revocation, comparison, and owner-token authority |
| `sql/sqlExecutionBroker.ts` | Editor-scoped SQL admission, exact execution identity, cancellation, currentness, and guarded lease cleanup shared by manual and Copilot runs |
| `sql/sqlLeaveNoTracePolicyStore.ts` | Versioned, lock-protected, cross-extension-host SQL privacy policy with atomic updates and watcher propagation |
| `sql/sqlAuthState.ts` | Per-connection auth state tracking (AAD vs SQL Login) |
| `sql/stsProtocol.ts` | Typed contracts for the pinned SQL Tools Service JSON-RPC protocol |
| `sql/stsRuntime.ts` | Lazy, extension-scoped SQL Tools Service startup and shutdown |
| `sql/stsQueryService.ts` | Query execution state machine: connect, execute, subset paging, cancel, dispose, disconnect |
| `sql/stsResultAdapter.ts` | Converts STS column/cell envelopes into the shared `QueryResult` shape |
| `sql/stsConnectionOptions.ts` | Purpose-specific STS authentication, TLS, and timeout options |
| `sql/stsProcessManager.ts` | SQL Tools Service (STS) process lifecycle: spawn, restart with backoff, JSON-RPC connection |
| `sql/stsLanguageService.ts` | STS language service client: initialize, completion requests, document sync |
| `sql/stsDownloader.ts` | Downloads, verifies, atomically installs, and caches the STS binary on first use |

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
| `first-launch/` | Standalone Lit first-launch form for file associations and editing defaults |

### Key Runtime Modules (`src/webview/`)

The webview runtime is split into `core/` and `monaco/`:

- `core/`: cross-cutting infrastructure, global orchestration, and section factory
- `monaco/`: editor-specific integrations

| Module | Purpose |
| ------ | ------- |
| `core/main.ts` | Event handlers and webview-level message orchestration |
| `core/message-handler.ts` | Host `postMessage` dispatcher and routing |
| `core/editing-preferences.ts` | Persistence-free application of revisioned editing preferences to Kusto and SQL controls |
| `core/state.ts` | General webview state and typed Kusto preparation/readiness accessors |
| `core/kusto-editor-schema-coordinator.ts` | Per-editor Kusto section, target, request, model, catalog, preparation, and worker-readiness authority |
| `core/kusto-editor-schema-runtime.ts` | Webview-scoped coordinator instance |
| `core/schema-catalogs.ts` | Typed, language-separated Kusto and SQL schema access |
| `core/kusto-schema-message-router.ts` | Exact lifecycle admission for database and schema deliveries |
| `core/synthetic-request-broker.ts` | Bounded request, timeout, and late-delivery tombstone broker for non-editor schema/database requests |
| `core/kusto-schema-request-state.ts` | Narrow legacy request-token compatibility mirror; stamped request currentness remains coordinator-owned |
| `core/query-section-accessors.ts` | Leaf DOM accessors shared by Monaco and query controllers without a section-factory cycle |
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
| `shared/kusto-worker-mutation-port.ts` | Sole transaction serializer for shared Monaco-Kusto worker mutation |

### First-Launch Setup

First-use setup is profile-scoped and may be triggered by the first supported-file open, Activity Bar reveal, or contributed Kusto Workbench command. The coordinator coalesces concurrent triggers into one panel and defers automatic Did you know? delivery until setup settles.

- File choices are application-scoped extension settings; only `.kql`, `.csl`, `.md`, and `.sql` are configurable. `.kqlx`, `.mdx`, and `.sqlx` always use Workbench.
- Editor associations are read and written only at global scope. Ownership metadata preserves an absent or foreign prior mapping and restores it only while the current mapping remains Workbench-owned.
- Fresh installs write a current-install marker before other extension infrastructure starts. Save writes a transaction journal before settings, associations, or editing preferences. A later activation resumes any valid journal before terminal or legacy-user detection, preventing Close or interrupted setup from being misclassified as an upgrade.
- An atomic lock-directory lease in extension global storage permits only one setup owner across VS Code windows. Waiting windows re-read profile state after the lease is released.
- Editing defaults are application-scoped settings. Legacy global-state values migrate into those settings once and are then removed, so Reset Setting returns to the declared default. Configuration changes produce timestamp-monotonic revisions and update every live webview in every window without invoking document persistence. Legacy root preference fields loaded from old notebooks round-trip unchanged, but new global choices never enter the document signature. Automatic completion and Copilot ghost text are shared by Kusto and SQL; Smart documentation is Kusto-only.
- Closing automatic setup writes nothing and suppresses another automatic prompt for that extension-host session. Skip records a terminal state while preserving inherited editing preferences.

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

* **Host → Webview:** `QueryEditorProvider` owns panel transport; injected application handlers such as `HostDashboardApplicationHandler`, `HostArtifactCsvSaveApplicationHandler`, `HostPythonExecutionApplicationHandler`, and `HostQuerySharingApplicationHandler` send through that transport callback.
* **Webview → Host:** `vscode.postMessage({ type: '...', ... })` via `postMessageToHost()` in `webview-messages.ts`

On the host side, incoming messages match the `IncomingWebviewMessage` union type exported from `queryEditorTypes.ts`. On the webview side, the message dispatcher lives in `core/message-handler.ts` (a large `switch` statement) and is wired by `core/main.ts`.

The native notebook document lifecycle has one narrower runtime-validated channel in `src/shared/documentViewProtocol.ts`. Protocol version 1 and channel `document-view` cover only `documentData`, `documentReloadResult`, host-owned section commands/results, and the Markdown command Save barrier. `KqlxEditorProvider` creates a UUID for each concrete panel incarnation, stamps every in-scope host message, and rejects malformed or mismatched webview envelopes before projection activation, command queue admission, or barrier settlement. The webview adopts the session only from its first valid native `documentData`, permanently tombstones that initial reload request, retains a bounded recent-reload ledger, and rejects malformed, duplicate, or cross-session host traffic before client or DOM adoption. Source generations, command IDs, document/section revisions, the per-URI physical queue, and Save leases remain independent inner fences. Metadata-free compatibility editors and browser/legacy viewers retain their existing behavior.

Dashboard workflows remain outside the six-kind document-view discriminator set. `QueryEditorProvider` offers each typed inbound message to its injected `DashboardApplicationHandler`; the handler synchronously declines unrelated traffic so Kusto/SQL admission timing is unchanged, and it is the sole dashboard discriminator/workflow owner. HTML sections send request-correlated `exportDashboard`, `getPbiWorkspaces`, `checkPbiItemExists`, and `publishToPowerBI` messages; cancellation and every host response carry the exact request ID and concrete HTML owner. The host replies with `openPublishPbiDialog`, `pbiWorkspacesResult`, `pbiItemExistsResult`, and `publishToPowerBIResult`, which route only to the originating `kw-html-section`/`kw-publish-pbi-dialog` incarnation.

Governed result-table CSV saving is likewise outside the document-view protocol. `HostArtifactCsvSaveApplicationHandler` owns `requestArtifactCsvSave`, `artifactCsvSaveData`, and `cancelArtifactCsvSaveIntent`, including native picker admission, eight active intents, one-use UUID nonce challenges, 60-second transfer deadlines, bounded 10-minute replay tombstones, exact box/artifact matching, UTF-8 file publication, and disposal. `QueryEditorProvider` only constructs or accepts the handler, offers typed messages synchronously, supplies panel transport, and disposes it. The webview artifact/table-generation gate and browser-local CSV shim remain separate unchanged adapters.

Python execution remains outside the document-view protocol. `HostPythonExecutionApplicationHandler` is the sole native owner of `executePython`, interpreter fallback (`python`, `python3`, `py`), child process and stdin/stdout/stderr lifecycle, independent 200 KB UTF-8 output caps, the 15-second timeout/kill terminal, `pythonResult` / `pythonError` publication, and disposal. Timeout and disposal retire terminal authority before process termination, so synchronous or late close/error events cannot publish twice. `QueryEditorProvider` only constructs or accepts the handler, offers typed messages synchronously, supplies panel transport, and disposes it. The webview one-request admission registry and host-owned persisted Python output remain unchanged authorities.

Imported URL-section CSV saving remains outside the document-view protocol and the governed artifact CSV workflow. `HostImportedCsvSaveApplicationHandler` is the sole native owner of `saveImportedCsv`, including empty-data UX, native picker admission, workspace/home default selection, URI-preserving `.csv` extension handling, exact UTF-8 file publication, Open File / Show in Folder actions, notification failure containment, write-failure messaging, and disposal. `QueryEditorProvider` only constructs or accepts the handler, offers typed messages synchronously, and disposes it. URL fetch identity/content acquisition, `kw-url-section`, browser downloads, Connection Manager preview export, message shapes, and network/trust policy remain unchanged adapters.

Query sharing remains outside the document-view protocol. `HostQuerySharingApplicationHandler` is the sole native owner of `copyAdeLink` and `shareToClipboard`, including input validation, Kusto gzip/base64 Azure Data Explorer links, SQL shares without an ADX-link promise, exact HTML/plain-text formatting and escaping, host clipboard writes, `shareContentReady` publication, notifications, and disposal. `QueryEditorProvider` only constructs or accepts the handler, synchronously offers typed messages, supplies connection lookup and panel transport, and disposes it. The `share:clipboard:result` artifact binding and policy admission, share modal, browser clipboard write, row caps, Kusto/SQL execution and connection ownership, message shapes, and protocol remain unchanged adapters.

## Window Bridges (Legacy)

Webview modules communicate via window globals declared in `window-bridges.d.ts`. This is a legacy pattern from when modules were loaded as separate `<script>` tags. The codebase is being progressively migrated to ES module imports between modules.

## File Formats

### `.kqlx` / `.sqlx` / `.mdx` (Notebooks)

JSON format with a `sections` array. Each section has a `type` discriminator and type-specific fields. Type definitions live in `kqlxFormat.ts`; `kqlxOverlay.ts` owns the lossless overlay codec. `.kqlx` files can contain any mix of section types (query, sql, chart, markdown, etc.). `.sqlx` files use the same JSON schema and allow SQL plus chart, transformation, Python, URL, HTML, and markdown sections, but not Kusto query sections. `.mdx` files are markdown-oriented notebooks.

`src/shared/documentSectionCapabilities.ts` is the sole transport-neutral authority for known document/section compatibility, canonical aliases, visible add kinds, and default section kinds:

| Document kind | Persisted known section kinds | User-addable kinds |
| ------------- | ----------------------------- | ------------------ |
| `.kqlx` | `query`, `sql`, `chart`, `transformation`, `markdown`, `python`, `url`, `html`, `devnotes` | All except hidden `devnotes` |
| `.sqlx` | `sql`, `chart`, `transformation`, `markdown`, `python`, `url`, `html`, `devnotes` | All except hidden `devnotes` |
| `.mdx` | `markdown`, `url`, `transformation`, `devnotes` | All except hidden `devnotes` |

Legacy `copilotQuery` canonicalizes to `query` and is accepted only where `query` is accepted. Unknown future section kinds are deliberately not classified as incompatible: they remain opaque COD-1 data and retain their relative order. A known incompatible section is never filtered. Parsing reports the document kind, section index/ID, and canonical type, and the custom editor opens script-disabled and read-only without installing a persistence channel. The notebook provider also requires the root `kind` to match the URI-derived `.kqlx`/`.sqlx`/`.mdx` kind, so parsing and projection cannot select different matrix rows.

Host `allowedSectionKinds`, defaults, and KQL/SQL/Markdown compatibility upgrade destinations derive from the shared matrix. `core/document-capabilities.ts` intersects those host projections with the same matrix before add buttons, insert zones, default creation, restored-state validation, or tool dispatch. `createSectionWithCapabilities()` in `core/persistence.ts` is the sole non-restore creation gateway: UI creation may request an explicit compatibility upgrade, while tools, Copilot auto-create/Insert, and comparison preparation reject before mutation when the document or host does not admit the kind. SQL optimization comparisons persist and restore as `sql` sections carrying `comparisonSourceBoxId`, so SQLX never contains a Kusto query section. Removing a comparison unregisters its webview mapping, clears the source backlink, publishes `sqlComparisonRemoved`, and defensively retires its own host owner before a same-source comparison can be recreated. The browser extension bundles `browser-ext/src/viewer-document.ts`, which delegates structural and capability validation to the host's pure `parseKqlxText()`, requires the first companion section to link to the exact opened raw file, fails visibly for invalid or unrelated companions, and preserves opaque future sections; its production build runs a strict browser TypeScript check before esbuild.

Parsing validates the root kind/version and document-kind capability row, requires a section array, rejects malformed section records, duplicate non-empty IDs, invalid link values, multiple linked-query owners, malformed known primitive/container values, and missing required nested identities. Unknown sections and explicitly opaque payloads remain forward-compatible data. The codec preserves unknown root/state fields, extension fields on known sections and nested known objects, opaque unknown sections, and their relative order. Ordinary persistence overlays edited known state onto the exact current file revision; known field omission remains authoritative while future fields survive. Nested arrays distinguish stable identities (artifacts, lineage, development notes) from explicitly renameable configuration items, and fail closed when future metadata cannot be correlated safely. Root/state/section extension comparison and durable persistence equality are JSON-semantic and hostile-key safe, separate from semantic UI-default normalization.

Legacy id-less sections receive stable opaque IDs per raw document revision before webview projection, and the same projected baseline is used for persistence. Every host projection carries a source generation and becomes active only after the webview acknowledges successful section materialization; persistence echoes that generation. KQL/SQL compatibility sidecars deterministically materialize IDs after overlay, enrich edits from the exact locked baseline before privacy sanitation, and use CAS/retry for writes, repair, and recovery. Their accepted physical identity is captured during load or returned by the locked creation/adoption publication itself, then retained through later draft writes. Privacy sanitation removes explicitly modeled row-bearing fields without granting authority over future extensions. Linked queries support one plain `.kql`/`.csl` target, use exact structural ownership, reject self/non-query targets, fence asynchronous loads by document generation, and reject stale or previously missing linked-file writes until reload establishes an exact baseline. Native linked Save holds one serialized content lease across buffer mutation and durable publication, rejects any other dirty open document that aliases the target's physical file, and treats buffer/disk rollback as independent CAS surfaces so a newer direct edit is never overwritten.

Native notebook Markdown, URL, Python, Chart, Transformation, and HTML persisted state are host-owned. `markdownSectionDefinition.ts`, `urlSectionDefinition.ts`, `pythonSectionDefinition.ts`, `chartSectionDefinition.ts`, `transformationSectionDefinition.ts`, and `htmlSectionDefinition.ts` own validation and patch semantics, while the transitional `MarkdownDocumentAggregate` owns their ordered application state, document revision, per-section revisions, and add/patch/remove transitions together. The webview `markdown-document-client.ts` uses one optimistic full-projection ledger and command queue for all six kinds. Their Lit components remain views; native persistence reads acknowledged host projections and never consults component `serialize()`. Plain `.md` compatibility and metadata-free browser/legacy behavior retain their existing serializers.

Each normalized notebook URI has one physical document-command queue shared before and after projection acknowledgement, across transient panels, owner replacement, Save, rollback, close, and reopen. A command reserves that queue before any asynchronous source read. Every successful result must match the complete predicted post-command projection, including all owned sections, revisions, and mixed section order; malformed or inconsistent results reload without adoption. Rejected commands may adopt a complete authoritative projection, reconcile all six view kinds, and finish with one stable whole-container ordering pass. A projection candidate becomes canonical only after a live reload request, exact source/generation checks, and application acknowledgement. Every valid command ID receives one terminal result. Native Save converts the webview barrier into a queue lease held through the matching non-canonical commit; rejected barriers abort, overlapping Saves serialize, canonical result-restoration Saves cannot release user leases, and disposal settles accepted leases. Live panel ownership is distinct from retained aggregate state: canonical-panel disposal reprojects a survivor without rewinding revisions, while text-document cleanup deletes retained owner and queue only after the tail stabilizes and an atomic final check confirms that the URI did not reopen. Final serialization overlays the aggregate snapshot onto the exact current codec baseline, preserving COD-1 future data and order.

PRO-1 qualification passed the seven-file focused Vitest ring (375 tests), complete sequential Vitest and sequential coverage (217 files, 5,635 tests, 47.78% statements), both TypeScript projects, integration compilation, the complete VS Code 1.131.0 extension-host suite (191/191 with `--timeout 5000`), production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates. Provider lifecycle coverage passed 16/16 and the compatibility sidecar matrix passed 117/117. Native run `20260803-213448` passed all three `host-owned-markdown-lifecycle` scenarios. Reviewed `1280x1000` screenshots, JSON artifacts, and logs proved distinct panel-session UUIDs, one initial projection per session, exactly one stamped command/result per session, no terminal or mutation from a prior-session command, an accepted stamped Save barrier, clean persisted state, and unchanged DOC-3/DOC-4 lossless/runtime contracts. The blocker-only reviewer returned `VERDICT: CLOSE PRO-1`. Final production sizes are 1,872.6 KB for `extension.js` and 2,752.8 KB for `webview.bundle.js`; synchronized baselines are 1,823 KB and 2,703 KB with the 50 KB buffer unchanged.

URL fetch identity, resolved redirect URL, downloaded content, loading/error state, CSV artifacts, iframe/DOMPurify rendering, debounce, and autosizing remain view/runtime effects. Only the authored URL and persisted presentation fields enter the aggregate. Same-document projections retain unchanged URL elements so artifacts, tables, iframes, observers, and pending debounce work survive synchronous DOM moves; teardown is deferred until genuine removal. Detached or replaced instances cannot emit persistence commands because the current connected element must own the exact section ID.

Python Monaco instances and local-code policy remain view/runtime adapter effects. `HostPythonExecutionApplicationHandler` owns native execution dispatch, interpreter fallback, child-process/stdin/stdout/stderr acquisition, bounded output, timeout/kill behavior, and terminal publication. Only authored `name`, `code`, `output`, `expanded`, and `editorHeightPx` enter the aggregate. `python-execution-admission.ts` fences the legacy box-ID-only execution protocol to one outstanding request per section, retaining exact component identity and code. Projection, removal, replacement, disconnect, and document invalidation retire publication authority while preserving a tombstone until the terminal is consumed; inactive terminals settle without publishing output. The handler publishes one bounded timeout terminal even if process termination or close never settles. Same-document projections retain unchanged Python elements and Monaco instances, genuine removal disposes them, and detached/replaced instances cannot persist stale code or output.

HST-3 qualification passed the final 10-file focused ring (502 tests), complete sequential Vitest and coverage (224 files, 5,728 tests; 48.18% statements), host/webview/browser typechecks, integration compilation, and the complete VS Code 1.132.0 extension-host suite (201/201 with `--timeout 5000`). Production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, `git diff --check`, and both bundle gates passed. Final production sizes are 1,908.2 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; the synchronized extension baseline is 1,859 KB with the 50 KB buffer unchanged. Native run `20260805-194937` executed built-in Python through the real Run button, rendered exact `HST3:24`, saved/reopened raw Windows stdout, and proved normalized output plus `dirty:false`; its foreground-valid screenshot and two JSON artifacts were reviewed clean. The definitive blocker-only review returned `VERDICT: NO HST-3 BLOCKER`.

HST-4 qualification passed the focused eight-file HST ring (128 tests), the provider lifecycle suite (101 tests), complete sequential Vitest and the official coverage gate (225 files, 5,736 tests; 48.18% statements), host/webview/browser typechecks, integration compilation, and the complete VS Code 1.132.0 extension-host suite (201/201 with `--timeout 5000`). A preceding npm-wrapper run incorrectly passed `5000` as a positional argument and hit the known two-second close-bound test at 200/201; the direct five-second CLI run passed unchanged. Production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, both bundle gates, and the blocker review passed. Final production sizes are 1,908.5 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; existing baselines and the 50 KB buffer remain unchanged. Native run `20260805-211100` passed 1/1 against the reviewed build, driving the real imported-table Save button and Windows picker, writing the exact 36-byte UTF-8 file `Name,City\nJosé,東京\nZoë,München`, and showing the saved notification with Open File / Show in Folder in a foreground-valid `1280x1000` screenshot. Two preceding harness attempts established the correct product output but failed on literal Unicode-escape substring handling and the documented controller notification-capture limitation; the final scenario uses exact host-read bytes plus visual notification evidence. The definitive blocker-only review returned `VERDICT: NO HST-4 BLOCKER`.

HST-5 qualification passed the expanded 12-file HST/share ring (454 tests), complete sequential Vitest and the official coverage gate (227 files, 5,749 tests; 48.18% statements), host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, and both bundle gates. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000` on unchanged rerun; the preceding run reached 199/201 after one unrelated sidecar repair timeout and its cascading setup failure, and both cases passed alone before the clean rerun. Final production sizes are 1,909.1 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; the synchronized extension baseline moved by 1 KB to 1,860 KB while the 50 KB buffer remained unchanged. Definitive native run `20260805-231107` passed 2/2 `share-result-artifacts` scenarios against the reviewed build: an exact extension-host JSON artifact proved clipboard artifact B while denied/revoked rows were absent, and the real host clipboard contained the expected gzip/base64 ADX URL prefix. Its foreground-valid `1280x1000` screenshot visibly showed the exact ADX-link success toast. A preceding identity-checklist run stopped before clipboard on an unrelated Connection Manager Favorites assertion; a later controller notification assertion missed the visibly present toast after exact clipboard success. The final isolated scenario uses exact clipboard bytes plus visual notification evidence. The definitive blocker-only review returned `VERDICT: NO HST-5 BLOCKER`.

Chart ECharts instances, immutable result-artifact bindings, source refresh/rebind behavior, rendering, zoom, tooltips, column memory, and dependency scheduling remain adapter effects. Only the persisted Chart configuration enters the aggregate. An unchanged authoritative projection retains the exact Chart element, global renderer state, ECharts instance, zoom state, and artifact binding without rendering or emitting a command. A genuine source change synchronously transitions the artifact binding even while collapsed, while rendering remains visibility-dependent. Renderer-only automatic layout does not persist defaults. Genuine removal disposes ECharts and releases the binding; detached/replaced same-ID elements and delayed Lit updates cannot command, render into, or remove the current owner. Transformation column rename propagation identifies Charts by component type rather than ID prefix and commits the resulting configuration through the same host command client.

Transformation primary and join-right immutable artifact bindings, expression evaluation, derived publication and lineage, dependency scheduling, refresh cascades, table/CSV rendering, and runtime warnings remain adapter effects. Only persisted Transformation configuration enters the aggregate. Equal projections retain the exact element, both input bindings, derived lineage, and rendered state without commands or publication. Configuration-only changes recompute from the existing pins; a genuine source/type change synchronously rebinds only the affected role and republishes even while collapsed. The established dependent-refresh boundary explicitly rebinds current upstream revisions. Renderer-driven auto-fit remains local and cannot hitchhike into a later host patch; explicit fit/resize heights persist and restore. Genuine removal clears output and releases both inputs, while detached/replaced same-ID instances cannot command, publish, unbind, or remove the current owner. Downstream rename propagation identifies Transformations by component type and commits arbitrary IDs through the host client.

HTML Monaco instances, sandboxed iframe/scripts, provenance parsing, data-bridge serialization, immutable fact binding, slicers, validation, Power BI export, and Fabric REST remain adapter effects. Only persisted HTML configuration enters the aggregate. Equal projections retain the exact element, Monaco editor, iframe, and fact binding with no rerender or command; a genuine source/code change retires stale dashboard workflows and rebinds through the established artifact refresh path. Native tools, rename/collapse/resize, and Save use host commands/projections; metadata-free browser/legacy serialization remains intentional.

Power BI create/update is a separate external transaction. One captured Microsoft account is reused for Fabric operations, refresh schedule, and initial refresh. Final Leave No Trace admission is held through the first mutating request. New publishes use UUID staging names, exact paginated ID recovery, and report-before-model compensation. Returned model/report IDs enter the document through an exact one-field HTML command. The host captures the authoritative pre-apply metadata and accepts compensation only as that exact object, or `null` when none existed, at the exact document/section revisions. The component provisionalizes the new tuple so concurrent rename/collapse/resize patches cannot overwrite it with stale metadata, then reconciles from the acknowledged host projection on failed apply/compensation. Cleanup runs in the same URI queue and deletes newly created items only after a queue-stable source proves that no HTML section references the exact workspace/model/report tuple.

Definitive DOC-6 qualification passed the final 20-file focused ring (661 tests), complete sequential Vitest and coverage (220 files, 5,703 tests, 48.18% statements), all TypeScript projects, integration compilation, and the complete VS Code 1.131.0 extension-host suite (201/201 with `--timeout 5000`). Production extension and strict browser builds passed; ESLint reported zero errors and five pre-existing warnings. Final production sizes are 1,905.5 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; synchronized baselines are 1,856 KB and 2,752 KB with the 50 KB buffer unchanged, and both gates pass. Definitive native run `20260805-043534` passed all five `host-owned-markdown-lifecycle` scenarios after one documented harness file-not-found rerun. Five fresh foreground `1280x1000` screenshots and all eight DOC-6 artifacts were reviewed: exact successful/stale terminals, equal editor/iframe/binding identity with zero rerender, dirty host state, accepted Save barrier, zero serializer/commands, exact recreation, clean lossless order, nested future publish/notice fields, and opaque preservation. Focused publish tests additionally prove exact old-metadata restoration and the concurrent rename-during-apply race. Logs contained only existing Git/CSP/Mermaid noise. The post-fix blocker reviews returned `VERDICT: NO DOC-6 BLOCKER`; the documented closure decision is `VERDICT: CLOSE DOC-6`. No live authenticated Fabric tenant run was performed.

Definitive DOC-5 qualification passed the final 19-file focused ring (729 tests), complete sequential Vitest and coverage (217 files, 5,657 tests, 48.11% statements), both TypeScript projects, integration compilation, the complete VS Code 1.131.0 extension-host suite (200/200 with `--timeout 5000`), production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates. Provider lifecycle passed 20/20 and compatibility sidecars passed 124/124, including pending-authority pre-lease rejection, retry projection handshakes, privacy durability, canonical restoration, overlapping Saves, and dirty physical-alias rejection. Native run `20260804-144628` passed all four `host-owned-markdown-lifecycle` scenarios. Four reviewed foreground `1280x1000` screenshots were clean; all 25 reviewed strict JSON artifacts proved exact successful/stale terminals, accepted stamped Saves, zero Transformation serializer/equal-projection commands, A pins retained through configuration while source currents advanced to B, explicit refresh rebinding both roles to B, exact recreated height/configuration, lossless nested future metadata/order, distinct panel sessions, and `dirty:false`. Logs contained only existing Git/CSP/Mermaid noise. The definitive blocker-only reviewer returned `VERDICT: CLOSE DOC-5`. Final production sizes are 1,886.5 KB for `extension.js` and 2,773.4 KB for `webview.bundle.js`; synchronized baselines are 1,837 KB and 2,724 KB with the 50 KB buffer unchanged.

Definitive DOC-2 qualification passed the final 11-file focused ring (513 tests), complete sequential Vitest (215 files, 5,592 tests), both TypeScript projects, integration compilation, the complete VS Code 1.131.0 extension-host suite (188/188 with `--timeout 5000`), production extension and browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates. The provider lifecycle matrix passed 13/13, including reversed session source reads. Native run `20260803-104840` passed `default/host-owned-markdown-lifecycle`; its reviewed screenshot showed restored Markdown and collapsed URL sections without errors, and both reviewed JSON artifacts proved zero component serialization, stale-command rejection, exact `markdown_doc1|url_doc1|future_doc1` order, future root/state/known-section/opaque preservation, and `dirty:false`. The definitive pessimistic review returned `VERDICT: CLOSE DOC-2`. Final production sizes are 1,857.1 KB for `extension.js` and 2,724.2 KB for `webview.bundle.js`; synchronized baselines are 1,808 KB and 2,675 KB with the 50 KB buffer unchanged.

Definitive DOC-3 qualification passed the final 12-file focused ring (539 tests), complete sequential Vitest (216 files, 5,615 tests), both TypeScript projects, integration compilation, the complete VS Code 1.131.0 extension-host suite (189/189 with `--timeout 5000`), production extension and browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates. The provider lifecycle matrix passed 14/14, including Python-only Save before projection acknowledgement. Native run `20260803-124847` passed the extended `default/host-owned-markdown-lifecycle` scenario. Its reviewed screenshot showed restored `Host owned` Markdown plus collapsed URL and `Host owned Python` sections without error UI; three reviewed JSON artifacts proved zero Markdown/URL/Python serializer calls, stale-command rejection, exact `markdown_doc1|url_doc1|python_doc1|future_doc1` order, all five Python fields, future root/state/known-section/opaque preservation, and `dirty:false`. The definitive post-qualification review returned `VERDICT: CLOSE DOC-3`. Final production sizes are 1,859.0 KB for `extension.js` and 2,731.4 KB for `webview.bundle.js`; synchronized baselines are 1,810 KB and 2,682 KB with the 50 KB buffer unchanged.

DOC-4 qualification passed the expanded 17-file focused ring (744 tests), complete sequential Vitest (216 files, 5,626 tests), both TypeScript projects, integration compilation, the complete VS Code 1.131.0 extension-host suite (190/190 with `--timeout 5000`), production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates. The provider lifecycle matrix passed 15/15, including Chart-only Save before projection acknowledgement and a command arriving after a barrier response but before lease reservation. Native run `20260803-194348` passed both `default/host-owned-markdown-lifecycle` scenarios with a clean extension-host log. Its reviewed screenshots showed restored Markdown/URL/Python and the four collapsed owned sections including arbitrary-ID `Host owned Chart`, with no error UI or dirty indicator. Eleven reviewed JSON artifacts proved four exact successful Chart terminals with no reload, an explicitly accepted Save barrier, zero Chart serializer calls, zero equal-projection commands, retained runtime identity, stale-command rejection, exact `markdown_doc4|url_doc4|python_doc4|sales-chart|future_doc4` order, complete nested Chart configuration, future root/state/known-section/nested-setting/opaque preservation, and `dirty:false` immediately after Save and after reopen. Full-projection comparison follows JSON transport semantics, so omitted and `undefined` object fields cannot cause a false reload. Final production sizes are 1,863.5 KB for `extension.js` and 2,744.2 KB for `webview.bundle.js`; intentional DOC-4 growth moved synchronized baselines from 1,810 to 1,814 KB and from 2,682 to 2,695 KB with the 50 KB buffer unchanged.

The webview sets `documentRuntimeActive` to false before buffered host messages can drain and keeps it false throughout document replacement. It becomes true only after capability validation and section materialization succeed. Before that point, publications, terminals, tools, notes, and state requests fail with an explicit loading response. A malformed replacement retires Kusto and SQL lifecycle owners, purges result and owner maps, resolves pending comparison work only through rollback or forward completion, and leaves any retained last-good DOM inert and non-executable.

Definitive COD-2 qualification passed the final 10-file blocker ring (584 tests), complete sequential Vitest (211 files, 5,543 tests), both host/webview TypeScript projects, strict browser typechecking, integration compilation, the complete VS Code 1.131.0 extension-host suite (174/174), production extension and browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates. Compatibility sidecars validate against their destination kind before parse, hydration, repair, build, adoption, or write; malformed SQL `linkedQueryPath`, multiple linked owners, and other invalid KQL/SQL companions project read-only without prompts or byte changes. Empty host capabilities remain empty, nonempty visual/hidden/opaque documents never receive a default section, all browser providers and the production `<all_urls>` manifest route MDX/raw URLs, browser validation reuses the host parser and exact companion linkage, and legacy aliases canonicalize through the shared owner across restore, sanitation, tools, and preloaders. All non-restore creation goes through the capability-aware owner; SQL optimization comparisons persist as SQL and retire exact owners on removal. Native run `20260802-103341` passed all four `default/document-capabilities` scenarios; three reviewed MDX screenshots and exact DOM/file assertions proved actionable byte-preserving rejection, exact controls, opaque-only behavior, future-data preservation, and real host SQL comparison save/reopen/nested-reject/remove/recreate/reopen with one fresh valid comparison and lineage. The definitive pessimistic review returned `VERDICT: CLOSE COD-2`. Final production sizes are 1,835.2 KB for `extension.js` and 2,704.9 KB for `webview.bundle.js`; synchronized baselines are 1,786 KB and 2,655 KB with the existing 50 KB buffer.

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
  id?: string;
  type: 'html';
  name?: string;
  code?: string;
  mode?: 'code' | 'preview';
  expanded?: boolean;
  editorHeightPx?: number;
  previewHeightPx?: number;
  previewHeightUserSet?: boolean;
  dataSourceIds?: string[];
  pbiPublishInfo?: PbiPublishInfo;
  powerBiUpgradeNotice?: PowerBiUpgradeNoticeState;
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

HTML sections are authored in `kw-html-section.ts`; `htmlSectionDefinition.ts` owns their persisted shape and patch semantics. They store `name`, source `code`, display `mode`, expansion and editor/preview height state, referenced `dataSourceIds`, optional `pbiPublishInfo`, and optional `powerBiUpgradeNotice`. They do not persist query result data in the HTML section; data remains owned by source query/transformation sections and is read at runtime.

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

`HostDashboardApplicationHandler` composes these unchanged export/publish adapters. It owns all ten dashboard request/cancel/ack routes, exact request abort controllers, successful publish application leases, first-external-commit Leave No Trace admission, stale publish retirement, and cleanup finalization. `KqlxEditorProvider` supplies three explicit native-document hooks for publish apply/compensate admission, terminal settlement, and queue-stable cleanup. `QueryEditorProvider` retains only handler construction/injection, transport offering, and disposal; it has no dashboard workflow map, Fabric adapter import, or publish state transition.

HST-1 qualification passed the final 10-file focused ring (466 tests), complete sequential Vitest and coverage (221 files, 5,708 tests, 48.18% statements), host/webview/browser typechecks, integration compilation, and the complete VS Code 1.131.0 extension-host suite (201/201 with `--timeout 5000`). Production extension and strict browser builds passed; ESLint reported zero errors and five pre-existing warnings. Final production sizes are 1,905.8 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`, within the unchanged synchronized limits. The real provider lifecycle passed 21/21, including publish apply, same-ID HTML replacement, stale compensation rejection, exact prior-metadata restoration, and queue-stable cleanup. The definitive documentation-aware reviewer returned `VERDICT: CLOSE HST-1`. No live authenticated Fabric tenant run was performed.

## Schema Caching

* **In-memory:** `schemaCache` Map in `KustoQueryClient`
* **On-disk:** SHA1-hashed JSON files in `globalStorageUri/schemaCache/`
* **Version:** `SCHEMA_CACHE_VERSION` constant triggers cache invalidation on format changes

### Kusto Schema Lifecycle and Preparation Readiness

Every active `<kw-query-section>` claims an immutable section lease identified by `{ boxId, sectionInstanceId }`. Selecting a different connection/database or explicitly invalidating authentication advances `targetGeneration`. Database and schema requests carry `{ sectionInstanceId, targetGeneration, requestToken }`; the host echoes that identity, and `kusto-schema-message-router.ts` admits a delivery only when the section incarnation, target, and request stream are still exact. Recreating the same persisted `boxId` therefore cannot revive an old response.

`KustoEditorSchemaCoordinator` is the canonical per-editor owner for section/model leases and all target-scoped Kusto state: schema, metadata, preparation, pending worker updates, base worker readiness, enhancement readiness, apply requirements, and waiters. A DOM disconnect caused by section reorder is not disposal. Only explicit section removal closes the lease, settles waiters, clears owned state, and leaves a tombstone against late writes. Auth invalidation and reapply scheduling enumerate coordinator-registered sections, so restored sections are covered before their Monaco models exist.

Kusto and SQL catalogs are intentionally separate. Kusto consumers use `schema-catalogs.ts` accessors backed by the coordinator; SQL consumers use `sqlSchemaByBoxId`. There is no mutable `window.schemaByBoxId` authority. `section-factory.ts` composes query sections, Monaco, and controllers, but Monaco and `QueryConnectionController` stay below it through leaf accessors and direct module APIs.

The extension host treats the physical Kusto connection identity (cluster plus authority) as part of response ownership. Host connection projections carry `connectionRevision` and `connectionIdentityKey`; section lifecycle targets retain those stamps so a request queued against saved connection A cannot silently run against replacement B that reused the same ID. Restored sections can establish their logical target before that projection arrives, so `setConnections()` republishes the same connection/database with its host stamp without clearing target-bound rows. Schema prewarm goes through the section target API and is keyed by target generation. Within that exact generation, schema responses match the logical connection/database target because the physical stamps are host-owned lifecycle state rather than duplicated response fields. Database and schema services capture the same physical identity before asynchronous work and suppress publication if the connection is removed or repointed. `KustoConnectionLifecycle` synchronously invalidates physical targets before its queued projection refresh, then serializes Copilot/schema invalidation, publishes `kustoAuthIdentityChanged`, and sends the refreshed connection snapshot.

`KustoQueryClient` coalesces concurrent direct database or schema discovery only when the complete target, principal preference, refresh, interaction, and persistence policy match; owner-gated dispatch remains isolated. An SDK client is held by an operation lease until every in-flight sibling settles, so account retry, invalidation, cancellation, or disposal can evict the cache entry without closing a client still serving metadata. Disposal and authentication currentness are checked before every physical schema command and again before publication. Schema discovery tries JSON and tabular formats within one authenticated attempt before considering another account, rejects empty or malformed results, and normalizes successful or historical compact cache entries into structurally validated `.show schema` JSON before they can become worker-ready. Shared disk-cache reads are request-brokered per exact cache key.

Kusto query sections expose coordinator-owned preparation state through typed accessors in `src/webview/core/state.ts`. A section is not worker-ready merely because `schemaData` reached the webview. Readiness requires the current primary database schema to match the current operation generation, delivery revision, schema key/signature, and Monaco model, with these blockers settled:

1. Required database discovery and schema delivery are complete.
2. A usable cached fallback is available, or a required foreground schema load has completed. Silent cache-expiry refreshes never hold section readiness.
3. The schema is applied to the current Monaco Kusto worker model.
4. Deferred function-output inference is tracked separately as best-effort background enrichment. It can improve function-result completions and is retried after cancellation or failure, but it does not hold `aria-busy` or the toolbar progress indicator once the exact base worker schema can already serve semantic completions.

Because Monaco-Kusto uses a shared worker schema, another section targeting the same cluster/database can adopt an already-loaded schema for its exact model and become ready without waiting for a duplicate host fetch. Stale-cache validation and changed-schema refreshes continue silently and never replace the usable ready fact with a foreground preparation blocker.

Multi-section restore intentionally avoids pushing every unfocused model into the shared Monaco worker, because those writes can race the first real focus and install the wrong primary database context. Once raw schema is fetched and exact delivery ownership is retained, an inactive section therefore becomes `deferred / waiting-focus`: it keeps the pending worker update and preparation token, but has no active blocker or worker operation. Focusing that editor promotes the same token back to `preparing / waiting-worker`, applies the pending schema for the exact model, and reaches true `ready` only after worker readiness is committed.

The state is reflected by `kw-query-section` through `data-preparation-state`, `data-preparation-stage`, and `aria-busy`. While the state is `preparing`, `queryEditor.css` renders an indeterminate blue segment over the bottom border of the Kusto editor toolbar. Deferred, ready, idle, and terminal-error states use the normal solid toolbar border. Reduced-motion mode uses a static accent, and forced-colors mode uses `Highlight`.

Operation generations and delivery revisions prevent late database/schema/worker responses from completing newer work. Removal leaves a monotonic tombstone so recreating a persisted section ID cannot be revived by an old async operation. Worker-wide schema replacement invalidates other model readiness; those sections remain dormant until focus prepares them again.

All shared Monaco-Kusto worker writes pass through `KustoWorkerMutationPort`. A queued operation receives the exact transaction that owns its physical worker calls and records a commit only after each mutation succeeds. Queued primary intent and started primary intent are distinct: enqueueing a later primary apply cannot invalidate the primary transaction that is currently executing, while a transaction that actually starts supersedes the prior started intent. Primary intent generation, committed worker revision, and destructive replacement epoch are distinct counters. Supplemental/enhancement leases may time out logically while an uncancelable worker call remains in flight; the detached transaction cannot commit afterward, and the queue remains occupied through physical settlement and inline primary-schema recovery before any later mutation can begin.

Each active primary worker-preparation episode has one 30-second absolute budget, shared by retries and fallback paths. Deferred, ready, error, and idle states retire the episode so focus-time or later worker preparation receives a fresh budget, while stale older generations cannot reset a newer active deadline. Expiry moves the owning section to a terminal error state so `aria-busy` and the toolbar indicator stop, but it does not cancel or release the underlying Monaco worker operation; that operation remains serialized until it settles because Monaco-Kusto exposes no worker-mutation cancellation API.

### Exact Kusto Execution Ownership

Every section-publishing Kusto run carries one `KustoExecutionRequestIdentity`: `{ engine, boxId, sectionInstanceId, targetGeneration, executionId, connectionId, database, producer }`. `src/shared/kustoExecution.ts` defines that contract. The webview publishes exact section open/target/close lifecycle messages, and `KustoExecutionCoordinator` mirrors the current target for each section incarnation.

The host reserves synchronously before selection persistence, authentication, or any other await. A reservation receives a monotonic `reservationSequence`; replacement atomically installs the new reservation, cancels the previous transport, and publishes the previous reservation's correlated `superseded` terminal. Reservation, pre-start admission, and dispatch capture compare the host-issued physical connection owner, so same-ID replacement cannot redirect stale work. Immediately before each actual SDK submission, `KustoQueryClient` captures immutable dispatch identity: attempt number, connection revision and identity, endpoint/authority, authenticated account partition and session generation, Leave No Trace revision, and client activity ID. Success is admitted only when that dispatch exists and its physical target, account session, and policy revisions remain current.

`KustoExecutionCoordinator` is the only Kusto logical terminal publisher. Success, error, explicit cancellation, target retirement, policy retirement, and supersession carry the complete reservation plus dispatch identity when physical submission occurred. Physical SDK and server cancellation remain best-effort, but logical settlement is immediate and idempotent. Manual runs, Run Function, Copilot final runs, performance comparisons, and agent-tool runs use this coordinator whenever they publish into a query section. Copilot/comparison starts use `kustoExecutionStarted` / `kustoExecutionStartedAck` before physical dispatch; tool invocations separately acknowledge the exact owner so cancellation works before or after that acknowledgement. Model-context-only Copilot queries remain separate because they never publish a generic section terminal.

Kusto Copilot requests have a second exact identity for their whole generation/write lifecycle: `{ boxId, sectionInstanceId, targetGeneration, copilotRequestId }`. Standalone Optimize uses the parallel `{ boxId, sectionInstanceId, targetGeneration, optimizeRequestId }` identity. The webview creates and owns these requests, the host echoes them on every status/options/output/terminal message, and the section admits output only for the active request and current lifecycle. Retarget, removal, replacement, or panel disposal cancels exact model, direct-query, final-run, comparison, and Optimize owners. Delegated tools capture the exact Copilot request owner after send and use a request-scoped pre-start cancellation tombstone, so delayed cancellation cannot affect a newer request in the same section. Queued output cannot mutate or settle a recreated same-ID section.

Successful terminals require a runtime-validated reservation and physical dispatch envelope; the coordinator retires a dispatchless success attempt instead of publishing rows. Request admission compares connection, database, and producer in addition to section/execution identity. Linked comparison sections retire and exactly cancel any old-target owner before synchronously adopting the source connection, database, and lifecycle target whenever the source retargets or the comparison is reused. That retirement clears rendered rows, shared result state, persisted `resultJson`, comparison summaries, and exact target-bound Copilot conversation history before mutation. Manual and Copilot comparison dispatch fail closed if the source and comparison data targets differ.

The webview must successfully claim the exact owner before sending `executeQuery`. `QueryExecutionController` retains ownership while cancellation is pending and retains every superseded identity until its exact terminal is admitted once. SQL routing runs first; afterward, a terminal targeting a registered Kusto section is rejected unless it carries a complete Kusto execution identity. A removed tool section may consume its matching retired terminal through the internal terminal event so the tool request settles without rendering into a missing or recreated section.

Connection, authority/account, database target, section removal, panel disposal, and Kusto Leave No Trace changes revoke affected reservations before publication. First-time automatic account establishment (`none -> A`) is not a revocation: an added Microsoft session establishes the baseline, and account-partition metadata refresh invalidates schema ownership without retargeting or clearing the exact run that established it. A true automatic rotation (`A -> B`), removed or recreated session, explicit selection change, or forgotten account revokes only mapped connections and clears their retained data and Copilot state.

`KustoLeaveNoTracePolicyStore` is the canonical cross-window privacy authority. It stores atomically committed snapshots under extension global storage, serializes changes with a filesystem lock, watches other extension hosts, and advances a per-cluster revocation generation. Physical dispatch starts and all data-bearing publication read that generation under the same shared lock; asynchronous publication callbacks are awaited before the lock is released. Model-context Copilot posts rows and appends history inside that callback, and Connection Manager table preview captures the dispatch generation and admits its rows under the same lock. A remote toggle therefore invalidates only affected clusters even before watcher delivery and cannot interleave between admission and publication.

Database/schema discovery, table preview, Connection Manager search, Cached Values, and direct agent schema tools use exact metadata owners rather than connection IDs alone. Those owners include physical connection identity/incarnation, account partition, authentication-session generation, per-cluster Leave No Trace generation, and the relevant database/schema cache generations. `KustoQueryClient` invokes authenticated metadata gates inside the canonical Kusto policy lock immediately before the SDK call, closing the authentication-to-submission race. Persisted Connection Manager search rows carry their own `kustoSearchOwner` proof and are revalidated individually; whole-profile fingerprints and whole-policy versions remain only a fail-closed fallback for legacy rows.

Sensitive host-to-webview deliveries use application-level publication leases: stage, commit, and revoke/status reconciliation. The webview acknowledges staging only after it owns the exact payload and acknowledges application only after the mutation occurs. A bounded completed-publication ledger lets a lost applied acknowledgement converge on the already-rendered result instead of producing a contradictory cancellation or second terminal. Transport-level `postMessage()` success is never treated as proof that rows were applied.

Snapshots that combine Kusto and SQL ownership use canonical lock order Kusto then SQL. `SqlWorkbenchService` exposes one-attempt owner-snapshot acquisition; callers release Kusto admission while SQL is contended and retry the complete ordered acquisition. This prevents Connection Manager, Cached Values, Query Editor sanitation, or publication from holding the Kusto privacy lock during SQL lock backoff.

Persisted Kusto result restoration waits for the first canonical policy snapshot. Protected or globally blocked jobs are discarded before rendering; later policy changes purge matching queued jobs, shared/rendered rows, and stored `resultJson`. If committed state and backup are unrecoverable after migration, recovery remains globally fail closed through ordinary edits and dominates any older process's higher unblocked version: result admission is rejected, the first connection snapshot waits for policy initialization, and every current Kusto connection is advertised non-persistable. `ConnectionManager` mirrors healthy shared state into legacy global state for compatibility and maps changed cluster keys to local connection IDs for lifecycle cancellation.

Reorder disconnect/reconnect is not disposal and does not release the execution or Copilot owner.

Admitted Kusto successes also publish their exact producer dispatch and privacy owner into the immutable result-artifact layer described below. Transport-specific execution coordination remains separate from artifact publication; SQL does not yet publish the same exact artifact provenance.

Focused coverage lives in `kustoLeaveNoTracePolicyStore.test.ts`, `connectionManager.test.ts`, `connectionManagerViewerSearch.test.ts`, `cachedValuesViewer.test.ts`, `kustoAuthPreferenceService.test.ts`, `kustoExecutionCoordinator.test.ts`, `kustoClient.test.ts`, `queryEditorProviderCancel.test.ts`, `query-execution-run-function.test.ts`, `query-section-accessors.test.ts`, `kw-query-section-loading.test.ts`, `message-handler.test.ts`, `message-protocol.test.ts`, `persistence-roundtrip.test.ts`, `queryEditorCopilotFunctionExecution.test.ts`, `toolOrchestratorConnect.test.ts`, `kw-cached-values.test.ts`, `kw-connection-manager.test.ts`, and `kusto-schema-ownership.test.ts`. Authenticated native coverage lives in `kusto-execution-contract` and `query-cancel`.

Final EXA-1 qualification on VS Code 1.130.0 passed production and integration compilation, the 27-suite focused ring (1,270 tests), full sequential Vitest (195 files, 5,098 tests), the full extension-host integration suite (113 tests), production extension and browser builds, and both bundle-size gates. Authenticated `kusto-execution-contract` passed all three normal/rerun/retarget scenarios on its unchanged rerun; the preceding first-scenario timeout remains recorded as a flake suspect. Authenticated `query-cancel` passed both physical-cancellation/race-recovery scenarios. Every final JSON artifact and all nine passing-run screenshots were reviewed.

### Immutable Result Artifacts

`src/shared/resultArtifact.ts` owns the runtime `ResultArtifactStore` and the compact `PersistedResultArtifactV1` descriptor. Each publication deep-clones and freezes columns, rows, metadata, producer, policy, and lineage; advances a monotonic per-source revision; and replaces only the source's mutable current pointer. Explicit consumer bindings retain an older revision across later source publications. Rebinding moves that consumer to the selected current revision and prunes unreferenced history. Clearing a source synchronously revokes all of its consumer bindings and current artifact, while an ordinary rerun preserves pinned consumers.

`core/results-state.ts` is the compatibility facade for latest-result presentation and presence checks. Every accepted `setResultsState` first publishes an immutable artifact revision; publication failure clears presentation and rejects the result atomically. Cross-section computation, external egress, and governed table interactions do not treat the mutable facade as lineage authority.

`shared/chart-renderer.ts` resolves only the chart's bound artifact. A normal source rerun therefore cannot silently change a pinned render; the existing dependent-refresh cascade explicitly rebinds the chart before refreshing it, preserving automatic live-chart behavior. Source selection rebinds through rendering, clearing the selection releases the binding, and chart removal releases it permanently.

Transformations are the first derived producer. `kw-transformation-section` owns separate immutable bindings for its primary and join-right inputs, computes only from those bound revisions, and publishes a new artifact with direct input roles and flattened leaf-source policy ancestry. Formula and tool edits retain existing bindings; source selection and the established dependent-refresh path explicitly rebind. Join refresh observes either input. Removal releases both inputs and clears the derived output even when the element is already detached.

Lineage participates in retention and revocation. A source revision remains available while any derived artifact references it. Clearing a source follows artifact lineage transitively, removes affected derived revisions and their consumer bindings synchronously, and clears mutable compatibility rows only when that source's current artifact was revoked. An old T(A) revision is therefore revoked with A while a retargeted current T(B) survives. Differently owned join inputs retain exact per-source policy stamps instead of fabricating one common owner; a top-level owner stamp is inherited only when every policy-bearing leaf agrees.

Kusto comparisons use one `KustoComparisonRunIdentity` across the source and comparison executions: source box, source execution, and comparison box. Manual Compare and standalone Optimize wait for the admitted source terminal before dispatching the comparison; Copilot optimization reuses the same source execution identity across retries. The source artifact is pinned by producer execution, the comparison start claims that exact pin, and output publication verifies source target, principal session, connection incarnation, and Leave No Trace policy against its dispatch before rendering. The comparison artifact then retains `comparison-source` lineage and leaf policy ancestry, so summaries resolve the exact source revision even after the source current pointer advances. Cancellation, failure, retarget, removal, and abandoned dispatch release temporary pins.

HTML dashboard previews bind their provenance fact source through `html:<boxId>:fact` and serialize rows only from that immutable artifact revision. Ordinary source publication does not move the binding; the existing dependent-refresh cascade explicitly rebinds. Active iframe data requires `policy.exposeToActiveContent === true`. Kusto and owner-admitted SQL results publish that compatibility decision explicitly, transformations promote it only when every leaf source allows exposure, and restored descriptors must match the locally recomputed post-owner-admission decision. Missing or mixed permission fails closed.

Source/lineage revocation reports affected consumer IDs synchronously. A connected dashboard immediately hides and blanks its sandboxed iframe before deferred refresh; provenance source changes do the same for the old source. Reconnect after reorder revalidates the retained binding, and section removal releases it even after DOM detachment. Passive Power BI/export metadata remains separate and continues to read only schema/query metadata; this slice does not introduce the deferred document trust, script, or network capability gateway.

Kusto model/tool result responses bind the artifact for their exact producer execution under `model:<requestId>:result` and require the independent `policy.sendToModel === true` decision. Configure-and-execute previews and delegated Copilot responses never fall back to mutable latest rows or terminal payloads. Delegated execution starts carry the host-captured query text, so the response cannot pair execution A's rows with later editor text B. Row caps and response formats remain unchanged. Success, denial, cancellation, timeout, failed start, owner invalidation, callback exceptions, and panel cleanup all settle once and release listeners, timers, owners, and bindings.

Share Results uses the singleton `share:clipboard:result` consumer. Opening the modal binds the current immutable result and, when `policy.shareToClipboard === true`, takes query, connection, and database from that artifact's producer rather than the mutable editor. A rerun retires mutable/current state without pruning an already-bound A; copying closes and releases A, and reopening binds B. Denial, source revocation, owner removal, malformed/applied document replacement, and modal dismissal release the binding; title/query-only sharing remains available when rows are denied. Kusto shares retain their Azure Data Explorer link, while direct and derived SQL shares use SQL formatting and no ADX-link promise.

After webview artifact admission, `HostQuerySharingApplicationHandler` formats the exact typed payload and publishes `shareContentReady`; the webview writes both HTML and plain-text clipboard flavors. The same handler owns direct Kusto ADX-link clipboard writes. Provider transport cannot reformat, relink, or publish sharing responses independently.

Result-table CSV export uses a separate `policy.exportToCsv` capability. Kusto, SQL, and transformation sections register `csv:<boxId>:table` against the exact rendered artifact and receive a unique table-generation token. Save remains hidden until that exact binding is admitted. The table serializes its TanStack sorted/filtered row model by declared column index, so ragged rows cannot export undeclared cells, then `artifact-csv-export.ts` verifies the artifact ID, generation token, binding, and policy before sending an intent without bytes.

`HostArtifactCsvSaveApplicationHandler` opens the native picker, creates a one-use nonce, and asks the webview to provide the projection. The webview revalidates the active table and creates a short-lived `csv:<boxId>:save` binding before returning bytes. One table may retain one projection, with eight pending projections globally. The handler accepts only the matching nonce, box, and artifact, consumes it once, retains a bounded completed-intent tombstone against request replay, and writes immediately to the selected URI. Replacement, transitive result revocation, removal, every applied document transition (including malformed replacement), and panel disposal clear both sides and hide Save through a token-scoped release event. Picker cancellation or the visible 60-second transfer timeout cancels only that attempt, leaving an otherwise valid table retryable. URL-imported CSV routes `saveImportedCsv` to `HostImportedCsvSaveApplicationHandler`; Connection Manager preview export retains its separate protocol.

HST-2 qualification passed the final 11-file focused ring (310 tests), complete sequential Vitest and coverage (223 files, 5,713 tests; 48.18% statements), host/webview/browser typechecks, integration compilation, and the complete VS Code 1.131.0 extension-host suite (201/201 with `--timeout 5000`). Production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, `git diff --check`, both bundle gates, and the definitive blocker review passed. Final production sizes are 1,906.3 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; the synchronized extension baseline moved by 1 KB to 1,857 KB while the 50 KB buffer remained unchanged. Native run `20260805-164304` exercised denied/allowed Save admission, the real Windows picker, exact intent/nonce/box/artifact correlation, zero cancellation, and the exact 26-byte file `Name,Score\nalpha,1\nbravo,2`. The permanent scenario's fresh screenshots were blocked before picker execution by the test framework's foreground-HWND validation; its previously reviewed clean screenshots remain the visual baseline.

Read-only browser viewers are a distinct local authority because they intentionally have no live Kusto/SQL connection owner. Persisted `resultJson` rows are restored into a fresh runtime artifact carrying only `exportToCsv: true`; persisted producer identity and model, clipboard, or active-content capability claims are not adopted. `vscode-shim.js` implements the same nonce and replay contract, then downloads locally or forwards to the owned inline/standalone iframe parent. Parent handlers reject messages from every other source window.

Standalone browser handoff never uses a process-global latest payload. `background.js` assigns each open request a `crypto.randomUUID()` token, stores payloads in a one-shot TTL-bounded map, and embeds only that token in the standalone URL. The wrapper requests and consumes exactly its own token, so concurrent opens cannot receive each other's document.

Kusto success publication carries reservation, execution, lifecycle target, physical dispatch, connection, principal session, Leave No Trace policy, and optional comparison-source lineage from the admitted terminal. Owner-admitted SQL manual/tool/Copilot and derived-comparison successes carry the exact executed query, connection, and database needed by row-sharing consumers. SQL Copilot execution publishes required start ownership before transport, revalidates after asynchronous delivery, and retires stale comparison rows before replacing a comparison query. Bounded persistence continues to store rows once in `resultJson` and may pair them with a row-free `resultArtifact` descriptor. Restore waits for the existing Kusto/SQL owner and policy admission, validates descriptor source and policy claims, renders accepted rows, and only then installs the restored artifact identity. Positive capability claims require a matching local decision. Restored Kusto comparisons additionally wait for their admitted source artifact and must exactly match locally reconstructed lineage and flattened leaf policies; cyclic dependencies are discarded. Restored SQL results and comparisons must match the live query, connection, database, principal, and revocation generation, including comparison-first documents and whitespace-exact queries. Legacy descriptors retain only capabilities they already carried; they never gain model or clipboard permission. The next live publication advances beyond the highest runtime revision. A descriptor never admits rows by itself; every row purge and host privacy sanitizer removes the descriptor atomically, and diffs treat it as result noise.

Declared-column projection happens before presentation, search, persistence, artifact publication, model/share/HTML egress, and derived computation. Governed Kusto, SQL, transformation, and Diff tables retain local copy only while their exact rendered generation is live; revocation synchronously purges rows, TanStack/search state, selection, object/unique-values viewers, chart interactions, and copy authority. URL CSV sections publish immutable source artifacts for chart/transformation consumption through a request-correlated fetch protocol, while their local table and Connection Manager previews retain separate ungoverned direct-data copy/save workflows. EXA-2 is closed; this boundary does not persist transformation payloads, merge the Kusto and SQL execution coordinators, or introduce deferred document capability admission.

Focused coverage lives in `result-artifact.test.ts`, `results-state.test.ts`, `artifact-csv-export.test.ts`, `browser-csv-shim.test.ts`, `transformation-join.test.ts`, `chart-renderer-zoom-pan.test.ts`, `chart-datasets.test.ts`, `kw-html-section-slicer.test.ts`, `dashboard-chart-renderer.test.ts`, `kustoExecutionCoordinator.test.ts`, `message-handler.test.ts`, `query-execution-run-function.test.ts`, `queryEditorCopilotFunctionExecution.test.ts`, `kw-query-section-loading.test.ts`, `kw-query-toolbar-share.test.ts`, `kw-sql-section-loading.test.ts`, `kw-data-table-visibility.test.ts`, `kw-url-section.test.ts`, `savedResultsCsvNotification.test.ts`, `sql-section-session.controller.test.ts`, `persistence-roundtrip.test.ts`, `queryEditorProviderCancel.test.ts`, `kqlxFormat.test.ts`, and `diffViewerUtils.test.ts`. Native `default/chart-regressions`, `default/transformation-artifacts`, `default/comparison-artifacts`, `default/html-artifact-bridge`, `default/model-result-artifacts`, `default/share-result-artifacts`, and `default/csv-result-artifacts` contracts prove pinning, explicit rebind, derived/comparison lineage, independent exposure/model/clipboard/CSV admission, exact projections, row caps, and synchronous revocation through the real VS Code webview.

Final model-result qualification on VS Code 1.130.0 passed the 21-file focused ring (1,140 tests), full sequential Vitest (196 files, 5,163 tests), both type projects, production extension and browser builds, integration compilation, the full extension-host suite (113 tests), and all existing bundle gates without a threshold increase. ESLint completed with zero errors and five pre-existing warnings outside touched files. Native `default/model-result-artifacts` passed on its first run. Final pessimistic review found no blocking issue.

Final clipboard-share qualification passed the 12-file focused ring (610 tests), full sequential Vitest (197 files, 5,182 tests), both type projects, production extension and browser builds, integration compilation, and the full extension-host suite (113 tests) on VS Code 1.130.0 and 1.131.0. ESLint completed with zero errors and the same five pre-existing warnings. The intentional webview runtime and native-contract growth raised only the synchronized webview bundle baseline by 10 KB (2,595 to 2,605 KB); every final bundle remains within its threshold. Native `default/share-result-artifacts` passed both runs, including the final production build. Final pessimistic review found no blocking issue.

CSV-export qualification passed the 14-file focused ring (586 tests), full sequential Vitest (199 files, 5,224 tests), both type projects, production extension/browser builds, integration compilation, the full extension-host suite (113 tests), and both bundle gates. ESLint completed with zero errors and five pre-existing warnings. Repeated first-attempt proper-lockfile/SQL credential lock failures were unrelated; each affected file passed unchanged and every complete rerun passed. Final production sizes are 1,762.9 KB for the extension and 2,660.1 KB for the webview. Native `default/csv-result-artifacts` exercised denied and allowed Save visibility, the real Windows picker, an exact 26-byte payload, and the saved notification; both screenshots and the JSON byte artifact were reviewed. Built browser inline/standalone Kusto, SQL, and SQL-derived comparison fixtures in both section orders restored and downloaded exact CSV bytes without live connections.

### Supplemental Fully Qualified Schemas

Schemas referenced through fully qualified expressions such as `cluster(...).database(...)` are supplemental and intentionally excluded from section-level preparation. They never extend the blue primary preparation indicator. `KustoSupplementalSchemaCoordinator` in `src/webview/shared/kusto-supplemental-schema-coordinator.ts` is the per-Monaco-model authority for reference generations and the `scheduled`, `fetching`, `fetched`, `waiting-primary`, `applying`, `loaded`, and `failed` states. A schema-keyed broker in `monaco.ts` deduplicates host fetches and retains raw schema payloads, but application readiness remains model-scoped.

The webview discovers references when a model is registered or changed, and again when primary preparation becomes ready. Model changes schedule a model-independent pump, so inactive sections can fetch and apply supplemental schemas without taking focus; readiness and request completion events resume waiting work without a permanent polling timer. Background requests use `requestSource: 'background'`; `SchemaService` and `KustoQueryClient` enforce `allowInteractive: false`, so opening a document cannot show an authentication prompt. Explicit Ctrl+Space escalates the exact model/reference to `requestSource: 'autocomplete'`, may retry interactively, and retains the bounded supplemental-completion fallback. A stale disk schema remains usable during silent refresh; Ctrl+Space can force an interactive live revision from any fetched nonterminal state, and a failed refresh restores the stale loaded fallback. Fetch and apply deadlines restore diagnostics on terminal failure instead of suppressing them indefinitely.

While an owned attempt is active or loaded, the Monaco marker boundary suppresses only explicit `KS207` and `KS208` diagnostics contained by that fully qualified cluster/database call. Other diagnostics, broad statement-level markers, database-only references, message-only warnings, and terminal failures remain visible. After load or failure, `monaco.ts` calls the Kusto worker's `doValidation()` only when exact primary preparation is ready, then republishes markers guarded by model/version, primary preparation identity, worker-schema revision, and broker revisions. Monaco-Kusto stores one shared schema per worker, so each broker revision mutates the worker once; exact-primary-ready model owners adopt that shared revision and retain independent loaded/revalidation state. Every worker-wide replacement invalidates supplemental applications and synchronously restores other ready primary schemas from the authoritative primary cache before readiness is republished. Supplemental schemas never enter the primary `SchemaTracker` cache.

Supplemental worker mutation has a 12-second lease so app state can move to a terminal outcome without granting a late operation commit authority. The transaction port still holds the shared-worker queue until the detached call settles, then runs recovery in that same serialized slot. Recovery forces an active authoritative primary schema through `setSchemaFromShowSchema`, removing any partial supplemental mutation before readiness is trusted or later writes run. Monaco-Kusto 14.1.0 exposes no public worker-cancellation or restart API, so a permanently nonresponsive worker cannot be recovered in-process; it requires webview/window recreation.

Supplemental traces are bounded and sanitized: model, schema, request, box, cluster, and database identities are hashed; query text, raw schemas, aliases, credentials, and backend messages are not recorded. Host responses carry distinct request policy (`requestSource`), delivery provenance (`deliverySource`), and structured failure kinds so diagnostics and retries do not infer policy from cache provenance or user-facing error text.

## SQL Section Architecture

SQL sections provide a near-identical notebook experience for T-SQL queries against SQL Server / Azure SQL databases. The system mirrors the Kusto architecture with full separation.

### Dialect Metadata

* **`SqlDialect`** (`sql/sqlDialect.ts`) — persisted/UI metadata contract: ID, display name, default port, and authentication modes
* **`MssqlDialect`** (`sql/mssqlDialect.ts`) — Microsoft SQL Server / Azure SQL metadata; saved connections continue to use `dialect: "mssql"`
* **`SqlDialectRegistry`** (`sql/sqlDialectRegistry.ts`) — register/get/list metadata for connection forms and viewers

### Host Services

* **`SqlConnectionManager`** — CRUD for SQL connections. IDs use `sql_` prefix. Connections in `globalState`, passwords in `SecretStorage`
* **`SqlWorkbenchService`** — one extension-scoped SQL owner shared by editors, Connection Manager, Cached Values, Copilot, and tools
* **`SqlEditorLifecycleCoordinator`** — one per editor/webview. Owns section incarnation and STS sequencing, composes the registry and execution broker, reacts to connection/principal/privacy/runtime events, and exposes narrow owner/currentness APIs to provider adapters
* **`SqlEditorSessionRegistry`** — one state-owning editor-scoped authority for section/comparison targets, generations, result ownership, lineage, and owner tokens
* **`SqlExecutionBroker`** — one editor-scoped authority for SQL preflight reservations, single-attempt transport admission, exact cancellation, currentness, and guarded release. Manual and Copilot callers retain query shaping, retries, user-facing terminals, and conversation history
* **`SqlQueryClient`** — stable caller-facing facade over STS database discovery, schema queries, execution, and cancellation
* **`SqlSchemaService`** (`sqlEditorSchema.ts`) — disk + memory schema cache, webview wiring via `prefetchSqlSchema`/`sqlSchemaData` messages

### SQL Tools Service (STS) — Language And Data Engine

SQL sections use Microsoft's SQL Tools Service, the same engine behind the official SQL Server extension. A lazily started shared process communicates over JSON-RPC and serves normal language sessions and the SQL data plane. Leave No Trace data operations use a separate one-operation process instead.

* **`StsDownloader`** — pins release `6.0.20260409.1`, verifies each platform archive with SHA-256, installs through a locked staging directory, and validates the cached binary manifest
* **`StsProcessManager`** — spawns STS, establishes a `vscode-jsonrpc` connection, exposes process epochs, settles failed readiness generations, rebinds subscriptions after restart, and supports per-request timeouts
* **`StsLanguageService`** — editor-scoped LSP client with session-unique owner URIs, document lifecycle, schema-ready handling, restart replay, and disposal
* **`StsQueryService`** — extension-scoped data-plane broker using `connection/connect`, `connection/listdatabases`, `query/executeString`, `query/complete`, paged `query/subset`, `query/cancel`, `query/dispose`, and `connection/disconnect`
* **Protected STS runtime** — each Leave No Trace query/database-discovery operation gets an isolated OS-temp sandbox and process. `TEMP`, `TMP`, home, app-data, cache, working, and log paths point into that sandbox. Cleanup disconnects/disposes the STS owner, stops or kills the process, recursively deletes the sandbox before returning results, and removes abandoned dead-process sandboxes on the next activation.

Every query execution gets a unique owner URI. The public `QueryResult`, host/webview messages, and `.kqlx`/`.sqlx` formats remain shared with Kusto and unchanged. STS results are converted before entering shared table, chart, transformation, HTML, comparison, and persistence paths.

### SQL Editor Lifecycle Boundary

`QueryEditorProvider` remains the webview and cross-language adapter. It owns connection prompts, database/schema I/O and response shaping, manual query formatting and terminal UX, generic comparison promises/summaries, and lock-held persistence sanitation/publication. It delegates editor-local identity and sequencing to `SqlEditorLifecycleCoordinator`.

The coordinator composes, but does not replace, the canonical authorities:

* `SqlEditorSessionRegistry` owns targets, monotonic generations/tombstones, comparison lineage, canonical result owners, and owner tokens.
* `SqlExecutionBroker` owns preflight/admission, exact execution IDs, cancellation, currentness, and guarded release over the provider's shared `QueryRunCoordinator`.
* `SqlWorkbenchService` remains extension-scoped and owns connections, principals, Leave No Trace policy, shared STS runtime, query service, and client.
* `StsLanguageService` owns the per-editor JSON-RPC document protocol. The coordinator owns when documents open, change, close, and replay.

Target changes cancel work and exact-close the old STS owner inside the registry's pre-commit callback, while the old token and target are still current. Runtime replacement recreates language state without rotating the logical target generation. Leave No Trace invalidation cancels correlated work before revoking tokens and publishing policy, then closes shared language state and issues an execution-only token only when the final target remains protected.

The coordinator receives provider effects as callbacks and never imports `QueryEditorProvider`, `CopilotService`, the extension entry point, or document providers. This prevents panel-scoped state from flowing into extension-scoped services and keeps lifecycle tests independent of VS Code webview construction.

SQL comparison preparation is a request-ID-scoped, application-acknowledged transaction. The webview snapshots the complete live descriptor, query text/revision, result revision, persisted rows and artifact, and active execution identity, then advances only through `staged`, `committed`, `finalized`, and `completed` acknowledgements. Admission makes the comparison read-only, fences delayed Monaco unlocks, and cancels/tombstones exact active work. Before completion, failure retries an acknowledged rollback to the unchanged snapshot; after completion, late rollback is rejected. The host preserves the previous comparison owner and token until the completed acknowledgement, then revalidates both source and comparison targets/generations before installing derived ownership. Completed and rolled-back proofs are released explicitly. Nested comparison sources and duplicate section identities reject before mutation.

### Compatibility Sidecars

Plain `.kql`/`.csl` and `.sql` editors share one compatibility-sidecar architecture while retaining language-specific adapters:

* **`CompatSidecarFormat`** owns linked-path resolution, exact linkage validation, primary-text hydration, and canonical sidecar serialization.
* **`CompatSidecarStore`** owns established-sidecar write serialization, cross-window locks, compare-and-swap publication, three-attempt repair, recovery files, and drain barriers.
* **`CompatSidecarSession`** owns revision admission, persist sequencing, upgrade barriers, dirty baselines, correlated final snapshots/reloads, beforeunload, and close settlement.
* **Providers** retain primary-text edits, KQL inference/connection caching, language-specific sidecar creation/adoption prompts, diff UI, protocol names, and user-facing copy.

Compatibility files reserve stable primary IDs (`compat_primary_query` and `compat_primary_sql`) and admit exactly one structurally valid primary section. Candidate sidecars must preserve that identity and ordering and pass destination-kind validation before a primary-text edit is applied. Load, create, adoption, repair, and publication retain the exact accepted physical sidecar identity. If final sanitation fails transiently, a metadata-only draft is retained only when its primary text still equals the source, so a later Save can retry without publishing a mismatched companion.

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
* SQL Tools Service is downloaded on first SQL use; it is not bundled in the VSIX
* Data-plane TLS uses mandatory encryption with certificate validation; language connections preserve their existing compatibility policy
* SQL Leave No Trace policy is versioned in extension global storage, serialized with a filesystem lock, atomically replaced, and watched by every extension host so toggles propagate across VS Code windows
* SQL Leave No Trace keeps manual queries and database discovery usable through the protected one-shot STS runtime. Shared language STS, schema/cache publication, Copilot execution, durable result state, restoration, and data-bearing output logs remain blocked. Results render in memory only and are admitted after sandbox deletion.
* A terminally exhausted STS manager is replaced by `StsRuntime`; open editors recreate language services and replay their latest document/target state against the replacement manager
* File format: `.kqlx` supports mixed Kusto+SQL; `.sqlx` supports SQL plus derived and presentation sections, but not Kusto query sections

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

* **Storage**: The canonical policy is an atomically committed, file-locked snapshot under extension global storage; `kusto.leaveNoTraceClusters` is maintained as a legacy compatibility mirror
* **Execution fencing**: Effective policy changes advance a per-cluster revocation generation, propagate across extension hosts, revoke active runs for matching connections before refreshed snapshots, and guard both dispatch and result admission under the shared lock
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
* `vscode-jsonrpc` — JSON-RPC protocol for STS communication
* Microsoft SQL Tools Service — downloaded and integrity-checked on first SQL use; provides IntelliSense and query execution

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
| `queryEditorProviderDashboardHandler.test.ts` | Real-provider dashboard handler injection/forwarding and static displaced-authority guard |
| `queryEditorProviderQuerySharingHandler.test.ts` | Real-provider query-sharing injection/forwarding and static displaced-authority guard |
| `querySharingApplicationHandler.test.ts` | ADX encoding, Kusto/SQL rich/plain formatting, escaping, validation, notifications, clipboard failures, synchronous decline, and disposal |
| `queryEditorProviderPowerBiPublishHelp.test.ts` | Dashboard application handler prompts, cancellation, workspace/item responses, publish leases, compensation, exact metadata restoration, and cleanup admission |
| `powerBiExport.test.ts` | HTML dashboard provenance parsing, DAX generation, PBIR/TMDL output, native slicers, Import/DirectQuery model generation, and CSS patching |
| `mssqlDialect.test.ts` | MSSQL persisted/UI dialect metadata |
| `mssqlSchema.test.ts` | MSSQL schema catalog query and parser compatibility |
| `sqlDialectRegistry.test.ts` | Dialect registry: register, get, list, unknown dialect handling |
| `sqlFormat.test.ts` | `.sqlx` file parsing, serialization, section type validation |
| `sqlClient.test.ts` | SQL client error contract |
| `stsProcessManager.test.ts` | STS process epochs, request timeouts, and restart-safe subscriptions |
| `stsQueryService.test.ts` | STS connection, execution, paging, cancellation, cleanup, and database listing |
| `stsResultAdapter.test.ts` | STS column and cell conversion into shared query results |
| `stsConnectionOptions.test.ts` | STS authentication, TLS, server/port, and timeout options |
| `sqlLeaveNoTrace.test.ts` | SQL Leave No Trace fail-closed policy before STS startup |
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
