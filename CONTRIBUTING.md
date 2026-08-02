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
- A controller constructor must call `host.addController(this)` so Lit invokes those lifecycle hooks.
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

## Kusto Schema Lifecycle Development

Kusto schema state is editor-lifecycle state, not general global state. Preserve these boundaries:

* **Coordinator authority**: `KustoEditorSchemaCoordinator` owns section/model leases and target-scoped schema, metadata, preparation, pending worker updates, readiness, enhancement, apply requirements, and waiters. Use typed accessors in `schema-catalogs.ts` and `state.ts`; do not add per-box lifecycle maps or a mutable window schema catalog.
* **Exact request identity**: Every real editor database/schema request must carry `{ sectionInstanceId, targetGeneration, requestToken }`. Host responses must echo it, and `message-handler.ts` must route through `kusto-schema-message-router.ts` before changing editor state.
* **Disconnect is not disposal**: Lit disconnect/reconnect occurs during reorder. Close a section lease only on explicit section removal. Model attach/detach must use the matching model lease.
* **Registered-section enumeration**: Connection/auth invalidation and schema reapply scheduling must enumerate coordinator sections, not only mounted `queryEditors`; restored sections can exist before Monaco initialization.
* **Language separation**: Kusto state uses coordinator-backed accessors. SQL state uses `sqlSchemaByBoxId`. Never share a per-box schema map between languages.
* **Synthetic requests**: Tool and helper requests use `SyntheticRequestBroker`, including bounded timeouts and tombstones. A late synthetic response must be consumed, never fall through to editor delivery.
* **Worker transactions**: Every Monaco-Kusto worker mutation must run through `KustoWorkerMutationPort` and commit on its exact transaction after the physical call succeeds. Do not create a second promise queue, ambient commit API, or independent worker revision/epoch counter.
* **Detached recovery**: A leased timeout is logical; it cannot cancel the worker call. Reject commits from the detached transaction, keep later mutations blocked until physical settlement, and run exact-primary recovery in the same serialized slot before releasing the queue.
* **Dependency direction**: `section-factory.ts` composes Monaco and section controllers. `monaco/` and `QueryConnectionController` must not import back from the factory; use `query-section-accessors.ts`, `monaco/resize.ts`, or the owning controller API.

Focused lifecycle coverage lives in `kusto-editor-schema-coordinator.test.ts`, `kusto-schema-message-router.test.ts`, `kusto-worker-mutation-port.test.ts`, `synthetic-request-broker.test.ts`, and `kusto-schema-ownership.test.ts`. Keep the ownership guard green whenever schema state or worker mutation code changes.

## Kusto Execution Ownership Development

Section-publishing Kusto execution has one host authority and one exact envelope. Preserve these boundaries:

* **Reservation authority**: `KustoExecutionCoordinator` reserves synchronously before any await, replaces/cancels only the exact prior reservation, captures physical dispatch identity, and publishes every Kusto section terminal. Do not construct `queryResult`, `queryError`, or `queryCancelled` for Kusto sections elsewhere.
* **Complete identity**: Requests and terminals carry `boxId`, `sectionInstanceId`, `targetGeneration`, `executionId`, `connectionId`, `database`, `producer`, and `engine: 'kusto'` once host-owned. Physical attempts also carry connection revision/identity, endpoint/authority, account partition, auth-session generation, Leave No Trace revision, attempt number, and client activity ID. Host connection projections and schema lifecycle targets must preserve `connectionRevision` and `connectionIdentityKey`; a saved ID is not a physical target.
* **Success requires dispatch**: `queryResult` is invalid without a positive reservation sequence and a runtime-valid physical dispatch identity. Keep this invariant inside `KustoExecutionCoordinator` and the webview terminal guard, not only in provider callers.
* **Fail-closed start**: `executeQuery()` and `executeQueryDirect()` may post only after the section returns `true` from `beginQueryExecution()`. Copilot and comparison producers must receive the exact `kustoExecutionStartedAck` before SDK dispatch. Never restore provisional Kusto ownership through `copilotWriteQueryExecuting`.
* **Exact Copilot and Optimize requests**: Every Kusto Copilot request, comparison preparation, and host output carries `{ boxId, sectionInstanceId, targetGeneration, copilotRequestId }`; standalone Optimize carries the equivalent `optimizeRequestId`. Retarget/removal/replacement/panel disposal cancels exact model, query, final, comparison, and Optimize owners. Delegated tools capture the exact request after send and retain a request-scoped pre-start cancellation tombstone. Do not add raw-window, box-only output, or section-only cancellation that could mutate or cancel a recreated/newer section owner.
* **One terminal owner**: The webview keeps the active identity while cancelling and waits for the coordinator terminal. Retired identities remain admissible exactly once until their terminal arrives; do not add a count-based eviction that can strand delayed tool requests.
* **Strict admission**: Route SQL first, then reject incomplete terminals aimed at registered Kusto sections. A stale/retired terminal may settle its exact internal listener but must not render, persist, clear, or replace current section state.
* **Lifecycle and policy fencing**: Target change, account/authority change, connection mutation, section close, panel disposal, and Leave No Trace change revoke affected reservations. Preserve only true first automatic account establishment (`none -> A`); a real `A -> B` rotation revokes mapped owners and retained state. Reorder disconnect is not section disposal.
* **Cross-window privacy**: `KustoLeaveNoTracePolicyStore` is canonical. Dispatch and every data-bearing admission must use its shared file lock and per-cluster revocation generation. Await asynchronous delivery before releasing that lock; never treat a `Thenable<boolean>` as a delivered boolean. Direct Copilot output/history and table preview rows publish inside locked admission. A watcher or process-local cache alone is insufficient. Unrelated cluster changes must not revoke the current run. Unrecoverable post-migration policy loss stays globally fail closed, dominates higher-version unblocked in-memory state, and marks every current Kusto connection non-persistable until explicit recovery.
* **Authenticated metadata dispatch**: Database/schema discovery, preview, Connection Manager search, Cached Values, and agent schema tools capture physical connection, account partition, auth-session generation, per-cluster policy generation, and cache generations. Invoke the final admission gate inside `KustoQueryClient`'s canonical Kusto policy lock immediately before SDK submission. A pre-authentication policy check is not sufficient.
* **Application acknowledgement**: Sensitive Kusto publication uses stage/commit/revoke and applied acknowledgement. Treat `postMessage()` as transport acceptance only. Preserve the completed-publication ledger and bounded revoke/status reconciliation so a lost acknowledgement cannot produce rows plus a contradictory fallback terminal.
* **Cross-store lock order**: Acquire Kusto before SQL. When SQL is contended, use `tryDispatchSqlOwnerSnapshot` / `tryRunWithSqlOwnerSnapshotLock`, release Kusto, and retry the complete acquisition through `retrySqlOwnerSnapshotAcquisition`. Never hold Kusto admission during SQL lock backoff.
* **Persisted metadata proofs**: New Connection Manager search rows carry exact `kustoSearchOwner` proofs and are restored row by row. Whole-profile fingerprints and whole-policy versions are legacy fail-closed fallbacks only; do not use them to discard otherwise current proof-bearing rows after an unrelated account or cluster change.
* **Restoration privacy**: Kusto result restoration waits for canonical policy readiness. A protected/global policy snapshot discards queued restore jobs and clears stored, shared, and rendered rows. Policy transitions must purge all three surfaces; persistence filtering alone is not admission.
* **Producer coverage**: Manual, Run Function, Copilot final, comparison, and agent-tool section publication use the coordinator. A model-context-only query may bypass it only when it cannot publish a generic section terminal.
* **Comparison targets**: Retire and exactly cancel a linked comparison's old owner before adopting the source connection, database, and lifecycle target on source retarget or comparison reuse. Before mutation, clear rendered/shared rows, persisted `resultJson`, comparison summaries, standalone Optimize, target-bound Copilot conversation history, and temporary artifact pins. Verify equality before every manual or Copilot attempt; never compare rows produced from different targets.
* **Comparison artifacts**: Kusto source and comparison executions share one `KustoComparisonRunIdentity`. Dispatch the comparison only after admitted source success. Pin source by producer execution, retain the run identity in the section owner and terminal, require matching target/principal/session/policy stamps before rendering, publish `comparison-source` lineage, and release temporary pins on every terminal/removal/retarget path. Summaries read lineage, never source current.
* **Artifact publication**: `src/shared/resultArtifact.ts` owns immutable result revisions, current pointers, consumer bindings, and pruning. Publish through `setResultsState`; do not create another result-artifact map or treat mutable `results-state.ts` entries as lineage.
* **Binding semantics**: An ordinary rerun advances the source's current pointer without moving pinned consumers. Rebind only at an explicit product refresh/source-selection boundary. Clearing or retiring a source must synchronously revoke all bindings for that source; removing a consumer must unbind it.
* **Derived artifacts**: Transformations bind primary and join-right inputs separately and publish direct lineage plus inherited leaf-source policy stamps. Compute from bound artifacts, never mutable dataset rows. Keep formula edits pinned; rebind on source selection or dependent refresh. Source revocation must follow lineage without clearing unrelated retargeted revisions.
* **Dashboard artifact exposure**: HTML previews bind the provenance fact artifact under `html:<boxId>:fact` and may serialize rows only when `exposeToActiveContent === true`. Missing/legacy/mixed permission denies. Same-source edits remain pinned; dependent refresh explicitly rebinds. Source change, revoke, reconnect, and removal must synchronously eliminate stale iframe data/bindings. Do not use this permission for Power BI export, model context, scripts, or network access; those remain independent decisions.
* **Model/tool result artifacts**: Bind `model:<requestId>:result` to the artifact for the exact producer execution and require `sendToModel === true`; never reuse `exposeToActiveContent`, mutable current rows, or terminal payload rows. Carry host-captured query text with the execution start. Preserve response caps/formats and release the binding, listeners, timers, and request owner on every terminal, denial, exception, timeout, cancellation ordering, failed start, and cleanup path.
* **Clipboard-share artifacts**: Share Results binds the singleton `share:clipboard:result` consumer and requires `shareToClipboard === true`. When rows are selected, query, connection, database, and rows must come from the same artifact producer; never combine bound rows with mutable editor/target state. Rerun may retire current state while retaining an already-bound A, but target/privacy/removal/document transitions revoke or close immediately. SQL shares use SQL formatting and no ADX link.
* **SQL result provenance**: Manual, tool, Copilot-final, and SQL-derived comparison success envelopes must carry the exact executed query, connection, database, and execution ID. Publish a required SQL start before transport, revalidate after asynchronous delivery, and retire stale comparison persistence before replacing its query. Preserve query whitespace exactly. Restored clipboard permission requires matching live query/owner/database/principal/revocation state, including cold and comparison-first restores.
* **Persistence pairing**: `resultJson` remains the bounded row payload and `resultArtifact` is optional row-free identity/provenance metadata. Install restored descriptors only after owner/policy admission and accepted rendering. Positive capabilities require a matching local decision and exact producer provenance; restored derived lineage and leaf policies must be reconstructed from admitted source artifacts and match exactly. A legacy missing capability stays missing. Discard cyclic restore dependencies. Every row deletion, privacy purge, or sanitation path must remove the descriptor atomically.
* **Consumer scope**: Charts, transformations, Kusto/SQL comparisons, Diff, HTML preview and Power BI metadata, Kusto model/tool responses, Share Results, Save Results CSV, and URL CSV downstream consumption use immutable bindings or exact provenance. Governed table-local copy requires a live rendered generation; ungoverned direct-data tables remain separate workflows. Any new row consumer must add a discriminating pin/rebind/revoke test and may not bypass the artifact layer through mutable latest-result rows.

Focused execution coverage lives in `kustoLeaveNoTracePolicyStore.test.ts`, `connectionManager.test.ts`, `connectionManagerViewerSearch.test.ts`, `cachedValuesViewer.test.ts`, `kustoAuthPreferenceService.test.ts`, `kustoExecutionCoordinator.test.ts`, `kustoClient.test.ts`, `kustoClientAuthIdentity.test.ts`, `queryEditorProviderCancel.test.ts`, `query-execution-run-function.test.ts`, `query-section-accessors.test.ts`, `kw-query-section-loading.test.ts`, `message-handler.test.ts`, `message-protocol.test.ts`, `persistence-roundtrip.test.ts`, `queryEditorCopilotFunctionExecution.test.ts`, `toolOrchestratorConnect.test.ts`, `kw-cached-values.test.ts`, `kw-connection-manager.test.ts`, and `kusto-schema-ownership.test.ts`. Run them with `--maxWorkers=1`. Authenticated native qualification uses `kusto-execution-contract` for normal, immediate-rerun, and retarget behavior plus `query-cancel` for physical cancellation and recovery; inspect every screenshot and JSON artifact. A pass after failure stays recorded as a flake suspect and must be reported rather than silently treated as a clean first attempt.

## SQL Section Development

SQL sections follow the same patterns as Kusto query sections. Key differences:

* **Connections**: `SqlConnectionManager` (not `ConnectionManager`). IDs use `sql_` prefix. Separate `sqlConnections` state in `state.ts`.
* **Events**: All SQL custom events use `sql-` prefix (e.g. `sql-connection-changed`, `sql-database-changed`).
* **Dialects**: `SqlDialect` stores connection/UI metadata. Adding a non-MSSQL backend also requires a reviewed data-plane implementation; the current runtime data plane is SQL Tools Service and supports Microsoft SQL Server / Azure SQL.
* **Copilot**: Uses flavor system — host-side `sqlCopilotFlavor` in `copilotChatFlavor.ts`, webview-side `sqlWebviewFlavor` in `copilot-chat-flavor.ts`.
* **File format**: `.sqlx` files use the same JSON schema as `.kqlx` and allow SQL plus chart, transformation, Python, URL, HTML, and markdown sections, but not Kusto query sections. Mixed `.kqlx` files can contain both Kusto and SQL sections.
* **Runtime**: SQL Tools Service powers IntelliSense, database/schema discovery, query execution, and cancellation. The runtime is downloaded and SHA-256 verified on first use (`stsDownloader.ts`), owned by `SqlWorkbenchService`, managed by `StsRuntime`/`StsProcessManager`, and consumed by editor-scoped `StsLanguageService` plus extension-scoped `StsQueryService`. Installer hashing/extraction is cancellable, failed request generations settle, and exhausted managers are replaced with editor replay.
* **Editor lifecycle**: `SqlEditorLifecycleCoordinator` is the per-editor orchestrator for section incarnations, target transitions, STS document sequencing/replay, database request tickets, and connection/principal/Leave No Trace invalidation. Keep editor-local maps and subscriptions there. `QueryEditorProvider` should remain a thin webview/cross-language adapter and must not recreate lifecycle maps.
* **Execution ownership**: `SqlEditorSessionRegistry` owns section/comparison target identity and owner tokens. `SqlExecutionBroker` owns editor-scoped SQL admission, pending execution IDs, exact cancellation, currentness, and lease cleanup for both manual and Copilot runs. Keep query shaping, retry policy, UI copy, and Copilot history outside the broker.
* **SQL Leave No Trace**: `SqlLeaveNoTracePolicyStore` is the cross-window source of truth. Every SQL data, language, schema-cache, Copilot, and restoration entry point must refresh/revalidate it immediately before dispatch or data admission. Enabling it cancels active owners and clears host, webview, shared-result, dependent-section, and Copilot history state. Manual queries and database discovery remain available through a one-operation STS process whose temp, home, app-data, cache, working, and log directories are isolated; the process must stop and its sandbox must be deleted before results are admitted. Shared language STS, schema caching, result persistence/restoration, and protected error logging remain disabled.
* **Build**: Only `vscode` is externalized from the extension host bundle. `sql-formatter` is bundled for the webview prettify feature; STS is a verified first-use download.
* **Tests**: SQL host tests include process epochs, manager replacement, protocol execution, paging, cancellation, result adaptation, schema parsing, TLS/auth options, cross-host LNT propagation/restoration/Copilot invalidation, and dialect metadata. Authenticated behavior E2E lives under `tests/vscode-extension-tester/e2e/sql-auth/`.

### SQL Lifecycle Tests

Test `SqlEditorLifecycleCoordinator` directly with injected workbench, language-service, message, Copilot, persistence, and schema effects. Drive public operations such as section open/close, target adoption/retirement, STS connect/change/replay, connection/principal changes, Leave No Trace changes, and disposal. Do not construct `QueryEditorProvider` from its prototype or mutate lifecycle-private maps.

Keep provider tests focused on adapter responsibilities: message routing, manual SQL execution UX, database/schema I/O, persistence sanitation/publication, generic comparison fallback, panel transport, and Kusto behavior. Protocol tests must inventory host messages emitted from both `queryEditorProvider.ts` and `sql/sqlEditorLifecycleCoordinator.ts`.

## Notebook Codec Development

`kqlxOverlay.ts` is the lossless preservation authority for `.kqlx`, `.sqlx`, and `.mdx` state. Preserve these contracts:

* Unknown root/state fields, extensions on known sections and nested known objects, opaque unknown sections, hostile keys, and relative order survive supported edits.
* Known omission/deletion is authoritative. Stable nested identities must never inherit extensions from a replacement identity; only schema fields explicitly marked renameable may correlate by non-identity shape.
* Add every new known field to the exhaustive codec schema with its primitive, object, array-item, record-value, required-key, and identity semantics. A malformed known value that the real serializer cannot round-trip must fail read-only rather than be silently normalized.
* Durable persistence comparison is JSON-semantic. Do not reuse UI/diff normalization that collapses empty arrays, empty objects, empty strings, or implicit defaults.
* A host `documentData` projection is not current until the webview acknowledges successful materialization. Persistence snapshots must echo the admitted source generation.
* Linked-query native Save owns one exact content transaction across buffer mutation and durable publication. File and buffer rollback are independent CAS operations; neither may overwrite a newer direct edit.
* `src/shared/documentSectionCapabilities.ts` is the only document-kind section matrix. Do not add document-kind arrays or filters in providers, codecs, webviews, tools, or browser code.
* Known incompatible sections fail read-only with document kind, section index/ID, and type. Never filter them from a projection or persistence snapshot. Unknown future kinds remain opaque and preservable.
* Legacy `copilotQuery` canonicalizes to `query` for admission. Hidden `devnotes` is persistable but never user-addable.
* Host projections and compatibility upgrades derive from the destination notebook kind. Webview controls and tool dispatch must pass through `core/document-capabilities.ts`; an empty host capability set remains empty.
* Every non-restore section creation path must call `createSectionWithCapabilities()` in `core/persistence.ts`. Raw `add*Box()` calls are reserved for restore and the owner itself; tools, Copilot Insert/auto-create, and comparisons must reject or request upgrade before mutation.
* SQL comparisons persist as `sql` with `comparisonSourceBoxId`; never represent them as Kusto `query` sections in SQLX.
* SQL comparison removal must unregister its derived mapping, clear the source backlink, notify `sqlComparisonRemoved`, and retire its own host owner before recreation.
* Browser composition must use `browser-ext/src/viewer-document.ts`, which delegates to `parseKqlxText()`. Existing invalid companions fail visibly rather than falling back, and the first query section must link to the exact opened raw file. `npm run build` in `browser-ext/` includes strict typechecking and must remain green.

Focused coverage lives in `document-section-capabilities.test.ts`, `documentSectionCapabilitiesOwnership.test.ts`, `browser-provider-document-types.test.ts`, `copilot-chat-manager-capabilities.test.ts`, `persistence-roundtrip.test.ts`, `message-handler.test.ts`, `sql-section-message-router.test.ts`, `sqlEditorLifecycleCoordinator.test.ts`, and the native `codec-lossless-roundtrip` and `document-capabilities` E2E scenarios.

## Compatibility Sidecar Development

The `.kql`/`.csl` and `.sql` compatibility providers share three load-bearing abstractions:

* `CompatSidecarFormat` for pure linkage/hydration/canonicalization.
* `CompatSidecarStore` for lock/CAS/repair/recovery publication and accepted physical identity.
* `CompatSidecarSession` for revision, queue, upgrade, dirty, final-save, reload, and close coordination.

Keep KQL inference, connection caching, primary-text application, protocol message names, and language-specific sidecar create/adopt UX in provider adapters. Capture a sidecar's accepted identity at load or return it directly from the owned creation/adoption primitive; never resample the pathname after releasing publication ownership. Any sidecar lifecycle change must run the full parameterized `tests/integration/kqlSidecar.test.ts` matrix for both KQL and SQL variants.

---

# Regression Guards

The sections below define the constraints that prevent regressions. Any change that violates these rules must be blocked.

---

## Webview Page Scroll & Mouse Coordinates

The main notebook/page scrollbar is implemented with OverlayScrollbars on `.kw-scroll-viewport`, not with native document scrolling. That wrapper is the canonical page scroll element for application code.

### What must not change

- **Do not spoof native global scroll reads.** Never patch `window.scrollY`, `window.pageYOffset`, or `document.documentElement.scrollTop` to return the overlay viewport's scroll position. Monaco and browser native mouse handling depend on those reads staying native.
- **Use explicit page-scroll helpers for app scroll state.** Code that needs notebook page scroll position or scroll writes must use `getPageScrollElement()`, `getPageScrollTop()`, `setPageScrollTop()`, `scrollPageBy()`, or another explicit helper in `src/webview/core/utils.ts`.
- **Use viewport coordinates for body-attached overlays.** Context menus, insert affordances, and similar floating UI attached to `document.body` should use `clientX`/`clientY` and `getBoundingClientRect()` with `position: fixed`, not `pageX`/`pageY` or document-coordinate math.
- **Native E2E coverage is required for scroll-offset caret bugs.** Synthetic DOM-dispatched clicks can miss Monaco/native coordinate regressions. Repros involving editor click placement after page scroll need a native `vscode-extension-tester` click path, like `tests/vscode-extension-tester/e2e/default/kusto-click-caret-fidelity/`.

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

All sections are serialized via a unified loop in `persistence.ts` (`getKqlxState()`). The loop iterates direct DOM children of `#queries-container` and calls `el.serialize()` on section elements. IDs are opaque persisted identities and are not required to use a type prefix.

### Rules

- **Every Lit section component must implement `serialize()`** returning a JSON-serializable object with a `type` field matching the `KqlxSectionV1` union.
- **Do not infer section ownership from ID prefixes.** Persistence, tool removal, and lifecycle cleanup must use the section element/type so arbitrary restored IDs receive the same behavior.
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

1. **Define the section type and capabilities** — add the `KqlxSectionV1` variant in [`kqlxFormat.ts`](src/host/kqlxFormat.ts), its exhaustive codec schema in `kqlxOverlay.ts`, and its canonical/document-kind rows in `src/shared/documentSectionCapabilities.ts`. Extend the cross-layer matrix test and ownership guard; never add a second per-document list.
2. **Create a Lit component** in `src/webview/sections/` (e.g., `kw-my-section.ts` + `kw-my-section.styles.ts`). Register with `@customElement('kw-my-section')`. Implement `serialize()`.
3. **Add a creation function** in [`section-factory.ts`](src/webview/core/section-factory.ts) that creates the DOM element and wires event listeners.
4. **Add restoration logic** in [`persistence.ts`](src/webview/core/persistence.ts) — handle the new `type` in the restore loop.
5. **Add owner-routed tool removal** in [`message-handler.ts`](src/webview/core/message-handler.ts) using the element tag or serialized `type`, never only an ID prefix.
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
- [ ] New section types follow the [full checklist](#new-section-types--checklist), including arbitrary-ID serialization and owner-routed removal.
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
