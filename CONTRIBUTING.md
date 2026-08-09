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

## Host-Owned Document Section Development

Native `.kqlx` / `.sqlx` / `.mdx` Markdown, URL, Python, Chart, Transformation, and HTML persisted state have one host application owner. Preserve these boundaries:

* **Aggregate authority**: `MarkdownDocumentAggregate` owns ordered Markdown + URL + Python + Chart + Transformation + HTML application state, document revisions, section revisions, and add/patch/remove transitions. `markdownSectionDefinition.ts`, `urlSectionDefinition.ts`, `pythonSectionDefinition.ts`, `chartSectionDefinition.ts`, `transformationSectionDefinition.ts`, and `htmlSectionDefinition.ts` own persisted validation and patch semantics. Do not add a second per-kind aggregate, command queue, or authoritative state map.
* **Document-view protocol**: `src/shared/documentViewProtocol.ts` is the sole runtime schema and discriminated type owner for native `documentData`, `documentReloadResult`, host-owned section commands/results, and the Save barrier request/result. Every native in-scope envelope carries protocol version 1, channel `document-view`, and the host-created panel session ID. Validate before projection, client, command queue, revision, or Save-lease side effects. Do not duplicate these message shapes in provider or webview unions.
* **Panel session identity**: A view-session UUID identifies one concrete panel incarnation and never replaces source generation. Dispose/replace retires the session before delayed traffic can act. Cross-session acknowledgements, commands, results, and barriers are dropped at the outer protocol fence; source generation, command ID, revisions, URI queue, and Save leases remain authoritative inside it. Metadata-free compatibility and browser/legacy messages stay outside this native channel.
* **Exactly-once initial projection**: A native webview adopts its session from the first valid `documentData`. The initial reload request remains tombstoned for the full panel lifetime, later request IDs are bounded, and malformed or duplicate projections cannot materialize sections or emit another acknowledgement.
* **View-only components**: `kw-markdown-section`, `kw-url-section`, `kw-python-section`, `kw-chart-section`, and `kw-transformation-section` emit revisioned commands and apply host projections. Native persistence must not call their `serialize()` methods. Plain `.md` compatibility and metadata-free browser/legacy hosts intentionally retain their existing serializers.
* **URL runtime boundary**: only authored `name`, `url`, `expanded`, `outputHeightPx`, `imageSizeMode`, `imageAlign`, and `imageOverflow` are aggregate state. Redirect URLs, fetched content, request/loading/error state, CSV artifacts, iframe/DOMPurify rendering, debounce, and autosizing remain component/runtime effects. A default image display value may serialize by omission.
* **Python runtime boundary**: only authored `name`, `code`, admitted terminal `output`, `expanded`, and `editorHeightPx` are aggregate state. Monaco instances, transient `Running...` UI, and local-code policy remain view/runtime adapter effects. `HostPythonExecutionApplicationHandler` is the sole native owner of `executePython`, interpreter fallback, process/stdin/stdout/stderr lifecycle, independent 200 KB UTF-8 output caps, the 15-second timeout/kill terminal, `pythonResult` / `pythonError` publication, and disposal. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, and dispose this handler; it must not regain Python process creation, discriminator cases, output accumulation, timeout transitions, or terminal construction. The box-ID-only protocol permits one outstanding request per section through `python-execution-admission.ts`; projection/removal/invalidation retires publication authority, inactive terminals settle without publishing, and the handler must emit one bounded timeout terminal even if process close never arrives. Timeout/disposal authority must be established before `kill()` so synchronous or late close/error cannot publish twice.
* **Chart runtime boundary**: only persisted Chart configuration is aggregate state. ECharts instances, immutable artifact bindings, source refresh/rebind, rendering, zoom, tooltips, column memory, and dependency scheduling remain adapter effects. Equal projections must retain the exact element, renderer state, and artifact binding without rendering or commands. Genuine source changes transition the binding even while collapsed; genuine removal disposes and unbinds. Detached/replaced instances and delayed Lit callbacks cannot mutate a current same-ID owner, and renderer-only automatic layout must not persist defaults.
* **Transformation runtime boundary**: only persisted Transformation configuration is aggregate state. Primary/join-right artifact bindings, expression evaluation, derived publication/lineage, dependency scheduling, refresh cascades, table/CSV rendering, and runtime warnings remain adapter effects. Equal projections retain the exact element, pins, lineage, and output. Configuration-only changes recompute from existing pins; source/type changes rebind only affected roles and publish even while collapsed; dependent refresh explicitly advances pins. Automatic layout cannot persist or hitchhike into another patch, while explicit fit/resize heights remain durable. Detached/replaced instances cannot command, publish, unbind, or remove a current same-ID owner.
* **HTML runtime boundary**: only persisted HTML configuration is aggregate state: `name`, `code`, `mode`, `expanded`, editor/preview heights, `previewHeightUserSet`, `dataSourceIds`, `pbiPublishInfo`, and `powerBiUpgradeNotice`. Monaco, sandboxed iframe/scripts, provenance parsing, the data bridge, immutable artifact binding, slicers, validation, Power BI export, and Fabric operations remain adapter effects. Equal projections retain the exact element, editor, iframe, and fact binding without rerendering or commands. Detached/replaced instances and delayed measurements cannot mutate the current owner.
* **Dashboard application authority**: `HostDashboardApplicationHandler` is the sole owner of dashboard prompt/export/workspace/existence/publish request routing, request abort controllers, first-external-commit admission, publish application/compensation leases, and cleanup finalization. `QueryEditorProvider` may construct/inject, offer typed messages to, and dispose this handler; it must not regain dashboard workflow maps, Fabric/export adapter imports, discriminator branches, or state transitions. The handler must decline unrelated messages synchronously so Kusto/SQL reservation timing remains unchanged.
* **Artifact CSV save authority**: `HostArtifactCsvSaveApplicationHandler` is the sole native owner of `requestArtifactCsvSave`, `artifactCsvSaveData`, and `cancelArtifactCsvSaveIntent`, including picker admission, active-intent limits, one-use nonce challenges, cancellation, deadlines, replay tombstones, exact box/artifact correlation, file bytes, and disposal. `QueryEditorProvider` may construct/inject, offer typed messages to, and dispose this handler; it must not regain CSV intent/save maps, discriminator cases, or file-publication transitions. The webview `artifact-csv-export.ts` binding/table-generation gate and `browser-ext/vscode-shim.js` remain separate adapters and must not be folded into the host handler.
* **Imported CSV save authority**: `HostImportedCsvSaveApplicationHandler` is the sole native owner of `saveImportedCsv`, including empty-data UX, picker admission, `.csv` extension handling, exact UTF-8 bytes, local/remote URI authority, Open File / Show in Folder actions, notification failure containment, write-failure messaging, and disposal. `QueryEditorProvider` may construct/inject, offer typed messages to, and dispose this handler; it must not regain imported-CSV picker/write/notification code or the discriminator case. URL fetch identity/content, `kw-url-section`, browser downloads, governed artifact CSV saving, Connection Manager preview export, message shapes, and network/trust policy stay outside this handler.
* **Query-sharing application authority**: `HostQuerySharingApplicationHandler` is the sole native owner of `copyAdeLink` and `shareToClipboard`, including input validation, Kusto gzip/base64 ADX links, SQL no-link behavior, exact HTML/plain-text formatting and escaping, host clipboard writes, `shareContentReady`, notifications, and disposal. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, supply connection lookup/panel transport, and dispose this handler; it must not regain sharing discriminator cases, zlib/link construction, formatting, clipboard calls, response publication, or notifications. The webview share modal, `share:clipboard:result` artifact admission, browser clipboard write, row caps, Kusto/SQL execution and connection ownership, message shapes, and protocol stay outside this handler.
* **URL-content application authority**: `HostUrlContentApplicationHandler` is the sole native owner of `fetchUrl`, including HTTP/HTTPS validation, redirect-following fetch, the 15-second timeout/abort lifecycle, 100 MB text/CSV and 5 MB image caps, 200,000-character truncation, CSV/HTML/text/image classification and body sniffing, exact original/resolved URL identity, `urlContent` / `urlError` publication, and disposal. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, supply panel transport, and dispose this handler; it must not regain URL validation, fetch/abort logic, byte/truncation limits, classification, discriminator cases, or URL terminal construction. `kw-url-section` request identity, stale rejection, rendering, URL artifacts, debounce, autosizing, teardown, imported CSV saving, browser behavior, `resolveResourceUri`, control-command syntax lookup, and network/origin/trust policy stay outside this handler.
* **Control-command syntax application authority**: `HostControlCommandSyntaxApplicationHandler` is the sole native owner of `fetchControlCommandSyntax`, including the 24-hour cache, Microsoft Learn URL normalization/fetch, HTML/entity syntax extraction, `with(...)` argument parsing, existing failure-cache behavior, exact request/command identity, `controlCommandSyntaxResult` publication, and disposal/late-publication suppression. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, supply panel transport, and dispose this handler; it must not regain the syntax cache, Learn fetch/parsing helpers, discriminator case, or result construction. Caret-docs request de-duplication, presentation caching/rendering, control-command grammar/detection/execution, generated command data, browser behavior, `resolveResourceUri`, message shapes, and network/origin/trust policy stay outside this handler.
* **Resource URI application authority**: `HostResourceUriApplicationHandler` is the sole native owner of `resolveResourceUri`, including request normalization, passthrough schemes, local-file base validation, Markdown path normalization, workspace-root and relative/absolute construction, stat checks, exact base/path caching, webview URI conversion, failure shaping, `resolveResourceUriResult` publication, and disposal/late-publication suppression. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, supply panel transport plus the live `asWebviewUri` capability, and dispose this handler; it must not regain the cache, path import/normalization, file stat, discriminator case, failure strings, or result construction. Markdown request de-duplication, timeout/rendering, browser behavior, URL acquisition, navigation, linked queries, message shapes, and network/origin/trust/file policy stay outside this handler.
* **Copilot content-open application authority**: `HostCopilotContentOpenApplicationHandler` is the sole native owner of `openToolResultInEditor` and `openMarkdownPreview`, including exact tool/content coercion, untitled `plaintext` creation, `preview: true`, `ViewColumn.Beside`, local `vscode.Uri.file()` construction, `markdown.showPreview`, and the existing failure prefixes. `QueryEditorProvider` may construct/inject, synchronously offer the original typed messages to, and dispose this handler; it must not regain either discriminator case, method, document-open/display call, Markdown preview command, or notification. `boxId`, `label`, and the normalized tool value remain behaviorally ignored. Disposal must suppress later requests without canceling or silencing an already accepted native effect. Copilot generation/conversations/tools, controller presentation intent, browser behavior, generic navigation, origin/trust/file policy, message shapes, and Kusto/SQL execution stay outside this handler.
* **Information-notification application authority**: `HostInformationNotificationApplicationHandler` is the sole native owner of `showInfo`. It must synchronously decline unrelated messages, receive the original typed object, call `vscode.window.showInformationMessage(message.message)` exactly once with unchanged text, discard rather than await or adopt the returned thenable, and emit no response. A synchronous native throw must still reject `QueryEditorProvider.handleWebviewMessage`. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, and dispose this handler; it must not regain the discriminator case or direct notification call. Disposal is idempotent, claims and suppresses later `showInfo`, and cannot cancel, await, or silence an accepted native notification. Cached Values, Agent Chat, emitters, message shapes, browser behavior, and Kusto/SQL lifecycle stay outside this handler.
* **Cached-values-open application authority**: `HostCachedValuesOpenApplicationHandler` is the sole provider-route owner of `seeCachedValues`. It must synchronously decline unrelated messages, receive the original typed object, invoke exactly `vscode.commands.executeCommand('kusto.seeCachedValues')` with zero arguments, await settlement, discard the resolved value, propagate the exact rejection, and emit no response. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, await claimed work, and dispose this handler; it must not regain the discriminator case or command ID. Disposal is idempotent, claims and suppresses later requests, and cannot cancel or alter accepted command settlement. `extension.ts` remains the first-launch command-registration owner and `CachedValuesViewerV2` remains the viewer singleton/lifecycle owner; the handler must not import or open the viewer. Cache/schema/auth/privacy, Agent Chat, emitters, message shapes, browser behavior, and Kusto/SQL lifecycle stay outside this handler.
* **Copilot-agent-open application authority**: `HostCopilotAgentOpenApplicationHandler` is the sole provider-route owner of `openCopilotAgent`. It must synchronously decline unrelated messages, receive the original typed object, invoke `openKustoWorkbenchAgentChat()` exactly once with zero arguments, await settlement, discard the resolved boolean, propagate the exact rejection, and emit no response. `QueryEditorProvider` may construct/inject, synchronously offer typed messages to, await claimed work, and dispose this handler; it must not regain the discriminator case or import/invoke the shared helper. Disposal is idempotent, claims and suppresses later requests, and cannot cancel or alter accepted helper settlement. `copilotChatOpenUtils.ts` remains the shared native orchestration owner for the initial chat-open command, 150 ms Kusto Workbench mode reapplication, optional query/submit shaping, and fallback semantics used by extension, dashboard, and Copilot callers. Generation, conversations, tools, first-time UX, emitters, message shapes, browser behavior, and Kusto/SQL lifecycle stay outside this handler.
* **Editor-cursor-status application authority**: `HostEditorCursorStatusApplicationHandler` is the sole provider-route owner of `editorCursorPositionChanged`, development-only `getEditorCursorStatusSnapshot`, panel-hidden clearing, and panel-disposal clearing. It must synchronously decline unrelated messages, receive both original typed objects, keep one unique `queryEditor:<sequence>:` prefix, trim `boxId` and `editorKind` with `editor` fallback, update only while a status adapter exists and the panel is visible, preserve the exact snapshot request ID, use `{ visible: false, text: '' }` without an adapter, await and contain snapshot transport failures, and clear only its prefix on hide/disposal. Disposal is idempotent, claims and suppresses later cursor traffic, and must not dispose the shared status bar. `QueryEditorProvider` may construct/inject, offer messages, forward visibility, await snapshot work, and dispose the handler; it must not regain owner-ID, update, snapshot, or prefix-clear decisions. `EditorCursorStatusBar` remains the status-item, formatting, accessibility, stale-owner, and global-disposal owner. Webview emitters and protocol shapes stay unchanged.
* **Editing-preferences application authority**: `HostEditingPreferencesApplicationHandler` is the sole provider-route owner of `setCaretDocsEnabled`, `setAutoTriggerAutocompleteEnabled`, and `setCopilotInlineCompletionsEnabled`. It must synchronously decline unrelated traffic, receive each original typed object, map discriminators to the existing `STORAGE_KEYS` keys, normalize with `!!message.enabled`, await exactly one `setEditingPreference`, and publish the exact returned `editingPreferencesData` object through the live `toolOrchestrator.postToAllWebviews` when available or the awaited current-panel transport otherwise. Mutation and publication rejection must propagate exactly. Disposal is idempotent, claims and suppresses later preference requests, and cannot alter accepted mutation/publication settlement. `QueryEditorProvider` may construct/inject, offer messages, await claimed work, supply transport/publisher capabilities, and dispose the handler; it must not regain preference discriminator cases, key mapping, mutation, or publication decisions. `editingPreferences.ts` retains persistence, revision, snapshot, migration, and application-configuration ownership; `extension.ts` retains configuration listeners; initial preference projection stays in `connectionsData`; application scope, emitters, webview application, and message shapes stay unchanged.
* **Kusto connection-intake application authority**: `HostKustoConnectionIntakeApplicationHandler` is the sole provider-route owner of `addConnectionsForClusters`, `promptImportConnectionsXml`, and `importConnectionsFromXml`. It must synchronously decline unrelated traffic; preserve short-cluster and cluster-plus-authority deduplication, HTTPS/default-name/authority normalization, blank and malformed skipping, sequential additions, exact picker defaults/options/cancellation, UTF-8 read and response objects, fire-and-forget notification wording, and accepted settlement across disposal. Accepted add/import requests await exactly one injected connection refresh after intake settles, including no-op input; a rejected discovered-cluster mutation must not refresh, and picker traffic must never refresh. Disposal is idempotent and claims/suppresses later related requests. `ConnectionManager` remains persistent owner. `QueryEditorProvider` may construct/inject, offer exact typed objects, supply panel transport plus its revisioned `connectionsData` refresh effect, await claimed work, and dispose the handler; it must not regain the three cases or intake decisions. Webview XML parsing, message shapes, favorites, single-connection onboarding/testing, auth lifecycle, databases/schemas, and selection persistence stay outside this handler.
* **Kusto connection-onboarding application authority**: `HostKustoConnectionOnboardingApplicationHandler` is the sole provider-route owner of `promptAddConnection`, `addConnection`, and `testKustoConnection`. It must synchronously decline unrelated traffic; preserve exact dialog identity, blank add behavior, HTTPS/name/database/authority normalization, explicit-account lookup and fallback, persistent addition, selection-before-refresh ordering, exact success/error objects, draft identity, transient explicit/automatic auth preference with direct-client fallback, interactive non-persisting database discovery, database normalization, tracing, and every existing test terminal. Accepted work settles across disposal; disposal is idempotent and claims/suppresses later related requests. `ConnectionManager`, `KustoAuthPreferenceService`, `KustoQueryClient`, `ConnectionService.saveLastSelection`, provider revisioned `connectionsData`, database-list tracing utilities, webview controls, and message shapes remain their existing owners. `QueryEditorProvider` may construct/inject, offer exact typed objects, supply those capabilities, await claimed work, and dispose the handler; it must not regain the three cases or displaced `ConnectionService` methods.
* **SQL connection-onboarding application authority**: `HostSqlConnectionOnboardingApplicationHandler` is the sole provider-route owner of `promptAddSqlConnection` and `addSqlConnection`. It must synchronously decline unrelated traffic; preserve exact SQL Server address/authentication/username/password/optional-name prompts and cancellation, AAD and SQL Login shaping, password masking, trimming/defaults, direct-form optional fields, and password separation; then await manager persistence, await `globalState.update('sql.lastConnectionId', id)`, and invoke the exact fire-and-forget-settlement `sqlConnectionAdded` transport with current manager connections. Exact rejection propagates without compensation. Accepted work settles across disposal; disposal is idempotent and claims/suppresses later related requests. `SqlConnectionManager` retains persistence and SecretStorage ownership; provider revisioned policy/principal-aware `sqlConnectionsData`, `SqlWorkbenchService`, `SqlEditorLifecycleCoordinator`, controls, response application, and message shapes remain unchanged. `QueryEditorProvider` may construct/inject, offer exact typed objects, await claimed work, and dispose the handler; it must not regain either case, method, native prompt, manager mutation, selection-key decision, or acknowledgement construction.
* **SQL favorites application authority**: `HostSqlFavoritesApplicationHandler` is the sole provider-route owner of `requestAddSqlFavorite` and `removeSqlFavorite`. It must synchronously decline unrelated traffic; preserve exact prompt title, prompt, value fallback, `ignoreFocusOut`, cancellation, trimming, sanitized `sql.favorites` reads, connection-ID plus case-insensitive database keying, in-place replacement with submitted database spelling, append order, and removal persistence even when unchanged. It must await `globalState.update(STORAGE_KEYS.sqlFavorites, favorites)`, then await `Promise.resolve(postMessage(...))` with exact sanitized `sqlFavoritesData`, the originating `boxId` only for add/upsert, no `boxId` for removal, exact warning containment, and contained logger failures. Accepted work settles across disposal; disposal is idempotent and claims/suppresses later related requests. `QueryEditorProvider` may construct/inject, offer exact typed objects, read sanitized favorites for its existing revisioned policy/principal-aware `sqlConnectionsData`, and dispose the handler; it must not regain either case or any prompt, keying, mutation, persistence, publication, or warning decision. Kusto favorites, Connection Manager SQL-favorites routes, controls, emitters, response application, and message shapes stay outside this handler.
* **Kusto favorites application authority**: `HostKustoFavoritesApplicationHandler` is the sole provider-route owner of `requestAddFavorite`, `removeFavorite`, and `confirmRemoveFavorite`. It must synchronously decline unrelated traffic; preserve exact prompt/confirmation text, trimming/defaults, connection-presence and account-partition revalidation, migration, active-principal filtering, exact trimmed connection-ID plus case-insensitive database keying, replacement order and submitted database spelling, hidden-principal merge, and unresolved-entry fail-closed persistence. After successful storage it must fire-and-forget publication to every live handler sharing the same favorite storage, carry `boxId` only to the originating add/upsert handler, notify external listeners, contain transport/listener/logger failures with existing messages, and preserve accepted settlement across disposal. Activation and disposal are idempotent; later recognized traffic is claimed and suppressed until reactivation. `QueryEditorProvider` may construct/inject, offer exact typed objects, expose the handler's read-only favorites projection to existing Kusto `connectionsData` and schema inference, reactivate it with the panel, and dispose it; it must not regain any route, registry, prompt, mutation, persistence, confirmation, or broadcast decision. Connection Manager Kusto-favorites routes remain their independent workflow over shared pure helpers; SQL favorites, controls, emitters, response application, and message shapes stay outside this handler.
* **SQL database-discovery application authority**: `HostSqlDatabaseDiscoveryApplicationHandler` is the sole provider-route owner of `getSqlDatabases` and `refreshSqlDatabases`. It must synchronously decline unrelated traffic; adopt the exact section target before request admission; preserve passive versus explicit refresh, monotonic lifecycle tickets, bounded loading admission, sorted data/error terminals, terminal retry and exact completion, and fixed data-free retirement when owner/policy state changes while the ticket remains current. It must capture physical target and canonical principal/privacy identity, admit every owner-bearing transport attempt through `SqlWorkbenchService`, use protected one-operation STS only while Leave No Trace is current, finish sandbox cleanup before publication, keep protected diagnostics detail-free, and never publish one principal's cache or discovery under another. `SqlEditorLifecycleCoordinator` retains section identity, target generations, request tickets, currentness, and exact completion; `sqlDatabaseCache.ts` retains cross-window cache ownership/CAS; `SqlConnectionManager`, `SqlQueryClient`, `StsQueryService`, and `StsRuntime` retain physical adapters. `QueryEditorProvider` may construct/inject, offer exact typed objects, supply transport, and dispose the handler; it must not regain either route, target adoption, discovery orchestration, cache calls, protection helpers, terminal construction, notifications, or logging. SQL connection snapshots/favorites, schema, execution, comparisons, persistence, controls, emitters, response routing, and message shapes stay outside this handler.
* **KQL language-request application authority**: `HostKqlLanguageRequestApplicationHandler` is the sole provider-route owner of `kqlLanguageRequest`. It must synchronously decline unrelated traffic; trim and require `requestId`; preserve the runtime `{ text: '' }` params fallback; delegate exact params to `KqlLanguageServiceHost.getDiagnostics()` or `.findTableReferences()`; construct the existing supported, unsupported, and fixed failure `kqlLanguageResponse` objects; preserve fire-and-forget transport settlement; log the exact raw failure before publishing the fixed user-safe response; and own idempotent disposal. Accepted analysis settles across disposal, but late publication/logging and later recognized requests are suppressed. `QueryEditorProvider` may construct/inject, reference-identically offer exact typed objects, await claimed work, supply transport/logger capabilities, and dispose the handler; it must not regain the discriminator case, language-host field/import, request method, terminal construction, or logging. `KqlLanguageServiceHost` retains selection fallback, cached-schema/auth-partition resolution, and analysis delegation; `KqlLanguageService`, `extension.ts` text-editor diagnostics, webview timeout/resolver ownership, response application, emitters, and message shapes stay outside this handler.
* **SQL last-selection application authority**: `HostSqlLastSelectionApplicationHandler` is the sole provider-route owner of `saveSqlLastSelection`. It must synchronously decline unrelated traffic; trim and require `sqlConnectionId`; await `globalState.update('sql.lastConnectionId', id)` before an optional `globalState.update('sql.lastDatabase', database)`; preserve `database === undefined` as no database write and `database === ''` as an explicit clearing write; propagate exact rejection; emit no response; and own idempotent disposal. Accepted writes settle across disposal, while later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after KQL language requests, reference-identically offer the typed object, await claimed work, and dispose the handler; it must not regain the discriminator case or either application-state write. `SqlSectionSessionController` retains target transitions and emission, `HostSqlConnectionOnboardingApplicationHandler` retains its independent post-add write, and provider revisioned policy/principal-aware `sqlConnectionsData` retains reads of both keys. SQL lifecycle, connections/secrets, discovery, schema, execution, comparisons, persistence, Copilot, controls, response routing, and message shapes stay outside this handler.
* **Development-note mutation application authority**: `HostDevelopmentNoteMutationApplicationHandler` is the sole owner of Copilot development-note request IDs, `webviewMutationResponseResolvers`, the exact five-second timeout, `updateDevNotes` delivery, unavailable/rejected/failed delivery results, matching `toolResponse` settlement, and disposal settlement. `QueryEditorProvider.updateDevelopmentNotes()` must remain a thin delegate; the provider may offer a `toolResponse` to the handler but must forward every unclaimed response unchanged to `toolOrchestrator`. The handler must never claim unrelated or unmatched tool responses. `CopilotService` retains add/supersede/remove shaping, note IDs/content/category, tool-result copy, and history. The webview retains validation, compatibility/read-only admission, document mutation, persistence, and response construction; agent tools retain their independent response path. Message shapes, document ownership, execution, comparison summaries, and inline completion stay outside this handler.
* **Copilot inline-completion application authority**: `HostCopilotInlineCompletionApplicationHandler` is the sole provider-route owner of `requestCopilotInlineCompletion`. It must synchronously decline unrelated traffic, receive the original typed object, route non-SQL requests directly to the existing Copilot delegate, assert SQL owner-token admission through the injected lifecycle capability, and delegate SQL with the exact issued owner and token. SQL assertion or delegation failure must preserve the existing response-settled empty `copilotInlineCompletionResult` carrying the original request ID, box ID, and owner token; Kusto rejection propagates exactly. Accepted work settles across disposal, while later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after development-note mutation, reference-identically offer requests, await claimed work, supply narrow callbacks, and dispose the handler; it must not regain the discriminator branch, flavor decision, owner assertion, Copilot invocation, or fallback construction. `CopilotService` retains normalization, model selection/cache, KQL/T-SQL prompts, context trimming, eight-second cancellation, replacement, streaming, owner revalidation, cleanup, and normal result construction. SQL lifecycle/workbench services retain owner-token, principal, privacy, and dispatch authority. The webview retains request IDs, its ten-second resolver, Monaco spinner/application, cancellation policy, editing-preference admission, emitters, and message shapes.
* **Copilot availability application authority**: `HostCopilotAvailabilityApplicationHandler` is the sole provider-route owner of `checkCopilotAvailability`. It must synchronously decline unrelated traffic, receive the original typed object, await the existing Copilot capability with the exact unnormalized `boxId`, propagate exact rejection, and emit no response itself. Accepted work settles across disposal, while later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after inline completion, reference-identically offer requests, await claimed work, and dispose the handler; it must not regain the discriminator case, directly invoke availability work, or publish availability. `CopilotService` retains `vscode.lm.selectChatModels({ vendor: 'copilot' })`, model-present/no-model/failure-to-false semantics, and exact `copilotAvailability` construction/publication. Global startup, Kusto and SQL section callers, response routing/application, and message shapes stay outside this handler.
* **Copilot write-query preparation application authority**: `HostCopilotWriteQueryPreparationApplicationHandler` is the sole provider-route owner of `prepareCopilotWriteQuery`. It must synchronously decline unrelated traffic, receive the original typed Kusto or SQL object, await the existing Copilot capability with that exact object, propagate exact rejection, and emit no response itself. Accepted work settles across disposal, while later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after Copilot availability, reference-identically offer requests, await claimed work, and dispose the handler; it must not regain the discriminator case, directly invoke preparation work, or publish options/status. `CopilotService` retains box-ID normalization, model discovery/filtering/sorting and labels, preferred/default and persisted-model selection, Kusto/SQL local-tool selection, unavailable status, and exact `copilotWriteQueryOptions` / `copilotWriteQueryStatus` construction/publication. Kusto and SQL chat-manager callers, response routing/application, and message shapes stay outside this handler.
* **Copilot conversation-clear application authority**: `HostCopilotConversationClearApplicationHandler` is the sole provider-route owner of `clearCopilotConversation`. It must synchronously decline unrelated traffic, receive the original typed Kusto or SQL object, branch by flavor, require the complete existing Kusto request identity before Kusto delegation, preserve metadata-free SQL compatibility, await the appropriate clear capability, propagate exact rejection, and emit no response itself. Accepted work settles across disposal, while later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after write-query preparation, reference-identically offer requests, await claimed work, and dispose the handler; it must not regain the discriminator case, flavor/identity branch, or direct clear invocation. `CopilotService.clearCopilotConversation()` retains box normalization and deletion of general-rules, development-note, and conversation-history state; `clearKustoCopilotConversation()` retains exact active Kusto owner matching and owner deletion. Kusto and SQL chat-manager callers, conversation creation/history, start/cancel execution, response routing, and message shapes stay outside this handler.
* **Copilot history-removal application authority**: `HostCopilotHistoryRemovalApplicationHandler` is the sole provider-route owner of `removeFromCopilotHistory`. It must synchronously decline unrelated traffic, receive the original typed object, await the existing Copilot capability with the exact unnormalized `boxId` and `entryId`, propagate exact rejection, and emit no response itself. Accepted work settles across disposal, while later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after conversation clear, reference-identically offer requests, await claimed work, and dispose the handler; it must not regain the discriminator case or directly invoke history removal. `CopilotService.removeFromCopilotHistory()` retains box/entry normalization, history lookup, eligible `tool-call` / `general-rules` decisions, and the `removed` mutation. `kw-copilot-chat` retains immediate local removal and the shared Kusto/SQL chat manager retains exact box/entry emission. Conversation creation, clear semantics, first-time UX, start/cancel execution, optimization, response routing, and message shapes stay outside this handler.
* **Copilot chat first-time application authority**: `HostCopilotChatFirstTimeApplicationHandler` is the sole provider-route and complete workflow owner of `copilotChatFirstTimeCheck`. It must synchronously decline unrelated traffic, receive the original typed object, read `STORAGE_KEYS.copilotChatFirstTimeDismissed`, publish exact `proceed` immediately when already seen, otherwise await writing that key before showing the unchanged modal, preserve both exact action strings and copy, await zero-argument `openKustoWorkbenchAgentChat()` only for the Agent choice, and publish exact `proceed`, `openedAgent`, or `dismissed` with the existing non-awaited transport semantics. State, modal, helper, and synchronous transport failures propagate exactly. Accepted work settles across disposal; later recognized requests are claimed and suppressed. `QueryEditorProvider` may construct/inject in the slot immediately after history removal, reference-identically offer requests, await claimed work, and dispose the handler; it must not regain the discriminator, state/modal/helper/result decisions, or direct transport effect. `CopilotService` must not regain the complete workflow or Agent Chat helper import. `STORAGE_KEYS`, initial `connectionsData`, the shared Kusto/SQL caller, webview local-flag/result application, and `copilotChatOpenUtils.ts` command/mode/timing/fallback behavior stay unchanged.
* **Workbench tool-session application authority**: `HostWorkbenchToolSessionApplicationHandler` is the sole panel-scoped owner of the orchestrator connection token, initial connection and visible-panel reactivation, guarded disconnect, the exact five-second `requestToolState` resolver ledger, request publication and settlement, schema-refresh query-section filtering, exact Kusto connection resolution, SQL connection and ready-owner callbacks, and `toolExecutionStarted`, unclaimed `toolResponse`, and `toolStateResponse` routing. `HostDevelopmentNoteMutationApplicationHandler` retains first claim on matching development-note responses. `KustoWorkbenchToolOrchestrator`, `SchemaService`, and `SqlEditorLifecycleCoordinator` retain extension command/correlation, schema acquisition/cache/publication, and SQL ownership respectively. `QueryEditorProvider` may construct/inject immediately after the first-time handler, activate, reference-identically offer messages, expose a thin `requestSectionsFromWebview()` delegate, and dispose the handler; it must not regain the token, resolver map, lifecycle helpers, schema target projection, SQL callbacks, or any of the three discriminator cases. Persistence must call `sqlLifecycle.reconcileComparisonOwners()` directly.
* **Kusto connection-browsing application authority**: `HostKustoConnectionBrowsingApplicationHandler` is the sole provider-route owner of `getConnections`, `getDatabases`, `refreshDatabases`, and `saveLastSelection`. It must synchronously decline unrelated traffic; preserve exact message objects at the provider boundary; map database requests to `passive` or `interactive-refresh` without trimming or dropping request token, required database, section instance, or target generation; forward blank discovery connection IDs so `ConnectionService` owns the error terminal; trim and reject blank selection connection IDs; preserve `database === undefined` and `database === ''`; await selection persistence before best-effort `kusto.refreshTextEditorDiagnostics`; propagate exact projection, discovery, and persistence failures; contain diagnostics failures; let accepted work settle across disposal; and claim/suppress later recognized traffic. `QueryEditorProvider` may construct/inject immediately after the Workbench tool-session handler, offer exact objects, await claimed work, supply its revisioned privacy-aware connection projection plus `ConnectionService` database/selection capabilities, and dispose the handler; it must not regain the four cases or direct route effects. `ConnectionService` retains cache, authentication, discovery, tracing, recovery, terminals, and selection persistence. `extension.ts` retains diagnostics registration. Plain `.kql` compatibility retains file-cache and inferred-selection updates before forwarding.
* **Copilot query-workflow application authority**: `HostCopilotQueryWorkflowApplicationHandler` is the sole provider-route owner of `startCopilotWriteQuery`, `cancelCopilotWriteQuery`, `prepareOptimizeQuery`, `cancelOptimizeQuery`, and `optimizeQuery`. It must synchronously decline unrelated traffic; preserve exact original-object provider forwarding; reserve SQL preflight before owner-token assertion; clear only the exact preflight; emit the existing safe owner-change terminal only while that reservation is current; let exact cancellation win either resolving or rejecting assertion without a second terminal or later dispatch; preserve the current owner token on the cancellation terminal; pass complete Kusto request identity to cancellation; invoke write/Optimize cancellation synchronously; await start/prepare/run delegation; and resolve SQL manager/schema/client lazily only when accepted delegation begins. Accepted work settles across disposal; later recognized traffic is claimed and suppressed; disposal is idempotent. `QueryEditorProvider` may construct/inject immediately after Kusto browsing, reference-identically offer messages, await claimed work, supply existing Copilot/broker/lifecycle/adapter/transport capabilities, and dispose the handler; it must not regain any of the five cases, preflight constant, owner-token assertion, terminal construction, flavor/identity branch, or direct Copilot delegation. `CopilotService`, `SqlExecutionBroker`, `SqlEditorLifecycleCoordinator`, SQL managers/adapters, callers, response routing, execution, artifacts, persistence, browser behavior, and message shapes stay outside this handler.
* **Kusto section-execution application authority**: `HostKustoSectionExecutionApplicationHandler` is the sole provider-route owner of `kustoSectionOpen`, `kustoSectionTarget`, `kustoSectionClose`, `kustoExecutionStartedAck`, `kustoPublicationAck`, `executeQuery`, and `cancelQuery`. It must synchronously decline unrelated traffic; preserve exact original-object provider forwarding; own the exact execution-start and publication acknowledgement ledgers, five-second deadlines, transport-failure settlement, revoke/status reconciliation, and late-ack suppression; route section lifecycle and exact cancellation through `KustoExecutionCoordinator`; preserve manual query shaping, selection persistence, physical connection/account identity, Leave No Trace admission, success/failure/cancellation/replacement terminals, refresh ordering, user-safe errors, logging, and Copilot section-close cleanup; let accepted execution settle across disposal; claim and suppress later recognized traffic; and dispose idempotently. `QueryEditorProvider` may construct/inject immediately after the Copilot query workflow, reference-identically offer messages, retain only thin `CopilotServiceHost` delegates, and dispose the handler; it must not regain any of the seven cases, acknowledgement maps, manual execution method, physical-dispatch validation, or direct coordinator/client/selection/transport/Copilot-close effects. `KustoExecutionCoordinator`, `KustoQueryClient`, `ConnectionService`, `ConnectionManager`, and `CopilotService` retain their canonical algorithms and state. Message shapes, callers, artifacts, persistence, schema, SQL, comparisons, browser behavior, and deferred ACT stay outside this handler.
* **Comparison-preparation application authority**: `HostComparisonPreparationApplicationHandler` is the sole provider-route owner of `sqlComparisonAdmissionAck`, `comparisonBoxEnsured`, and `sqlComparisonRemoved`; the pending comparison-request and Kusto comparison-owner maps; the 20-second preparation deadline; SQL `staged`, `committed`, `finalized`, `completed`, and `rolledBack` acknowledgement correlation; rollback retry; exact Kusto/SQL target and SQL policy revalidation; removal cancellation; lifecycle rejection; and disposal settlement. It must synchronously decline unrelated traffic, preserve complete Kusto Copilot identity and SQL section/target identity, retain the prior SQL comparison owner until completed acknowledgement, retry forward completion without rollback, retry rollback until acknowledged, and suppress late or post-disposal traffic. Removal before finalization must remain on exact acknowledged rollback; after finalization, removal may terminally settle without rollback only after the webview-local admission ledger clears its request/box correlation, persistence snapshot, admission attribute, and read-only state through `sql-comparison-admission-runtime.ts`. `QueryEditorProvider` may construct/inject immediately after Kusto section execution, reference-identically offer exact messages, retain only a thin `ensureComparisonBoxInWebview()` delegate, and dispose the handler; it must not regain any of the three cases, maps, deadlines, acknowledgement helpers, rollback decisions, target/policy admission, or removal cancellation. `SqlEditorLifecycleCoordinator`, `SqlEditorSessionRegistry`, `SqlExecutionBroker`, `KustoExecutionCoordinator`, and `CopilotService` remain canonical owners. Artifact lineage, persistence, callers, webview transaction application, message shapes, browser behavior, and deferred ACT stay outside this handler.
* **Comparison-summary presentation authority**: comparison summaries are computed and rendered only in `displayComparisonSummary()` from an immutable comparison artifact and its exact `comparison-source` lineage. Banner teardown is local to the query section. Do not add `comparisonSummary` / `clearComparisonSummary` host messages, provider summary maps or waiters, `CopilotServiceHost` summary APIs, or SQL lifecycle summary callbacks. Kusto/SQL execution, comparison-owner retirement, exact cancellation, artifacts/lineage, Copilot narrative summaries, persistence, and browser rendering remain independent owners and must not depend on a host presentation mirror.
* **HTML publish transaction**: every dashboard request has exact request identity and cancellation. Fabric create/update uses one captured Microsoft account, final Leave No Trace admission at first external commit, collision-proof staging names, exact paginated recovery, and report-before-model compensation. Applying returned IDs is an exact one-field HTML command. The host captures the authoritative prior metadata; stale retirement restores exactly that value (or `null` only when none existed), and queue-stable cleanup deletes newly created items only when no authoritative HTML section references the exact workspace/model/report tuple. Provisional local metadata must make concurrent rename/collapse/resize patches carry the new tuple; failed apply/compensation reconciles from the acknowledged host projection rather than guessing.
* **Exact command terminals**: Every valid `commandId` must receive exactly one success or rejection result. Commands carry source generation plus expected document/section revisions; stale generation, owner, source, transition, write, or disposal paths fail explicitly.
* **One URI queue**: Every projection candidate and acknowledged owner for one normalized URI shares the same physical queue, including cold-start panels, adapter persistence, command writes, rollback, and Save leases. Reserve the queue before asynchronous source reads. Logical revocation never releases physical serialization early.
* **Complete projection admission**: Successful command results must match the full predicted owned projection: every Markdown/URL/Python/Chart/Transformation/HTML section, section revision, and exact mixed order. Inconsistent success reloads without adoption. Rejected results reconcile all six kinds and then run one stable whole-container order pass.
* **Acknowledged activation**: Candidate construction cannot invalidate active work. Activate only after a live reload request accepts the exact latest generation and source text. Rejected, expired, or source-drifted acknowledgements keep the prior owner.
* **Panel handoff**: Retained aggregate state and live panel ownership are separate. Canonical-panel disposal reprojects a surviving panel without installing its historical owner or rewinding revisions. Same-document URL, Python, Chart, Transformation, and HTML moves retain runtime state, including URL artifacts, Python Monaco instances, Chart ECharts/artifact bindings, Transformation input pins/lineage, and HTML Monaco/iframe/fact binding. Genuine removal tears down, and detached/replaced elements cannot persist or publish. Close cleanup rechecks live/closing panels atomically after queue settlement before deleting URI state.
* **Save fencing**: An accepted Markdown barrier reserves the shared queue through the matching native commit. Rejected barriers abort Save. Overlapping Saves serialize, internal canonical restoration cannot settle a user lease, and disposal settles active and retained leases.
* **Lossless boundary**: Apply aggregate Markdown + URL + Python + Chart + Transformation + HTML state to the final adapter snapshot, then serialize through `kqlxOverlay.ts` against the exact current source. Unknown root/state fields, known-section extensions, nested Chart settings, Transformation nested-array extensions, nested HTML publish/notice metadata, opaque sections, and order must survive; ambiguous nested correlation fails closed.

Focused coverage lives in `document-view-protocol.test.ts`, `webview-messages.test.ts`, `markdown-document-aggregate.test.ts`, `markdown-document-client.test.ts`, `html-section-definition.test.ts`, `kw-html-section-slicer.test.ts`, `kw-html-publish-compensation.test.ts`, `kw-publish-pbi-dialog.test.ts`, `kw-python-section.test.ts`, `kw-url-section.test.ts`, `chart-datasets.test.ts`, `chart-data-source.controller.test.ts`, `chart-renderer-zoom-pan.test.ts`, `kw-chart-section-agent.test.ts`, `transformation-join.test.ts`, `artifactCsvSaveApplicationHandler.test.ts`, `queryEditorProviderArtifactCsvHandler.test.ts`, `queryEditorProviderImportedCsvHandler.test.ts`, `savedResultsCsvNotification.test.ts`, `pythonExecutionApplicationHandler.test.ts`, `queryEditorProviderPython.test.ts`, `querySharingApplicationHandler.test.ts`, `queryEditorProviderQuerySharingHandler.test.ts`, `urlContentApplicationHandler.test.ts`, `queryEditorProviderUrlContentHandler.test.ts`, `controlCommandSyntaxApplicationHandler.test.ts`, `queryEditorProviderControlCommandSyntaxHandler.test.ts`, `resourceUriApplicationHandler.test.ts`, `queryEditorProviderResourceUriHandler.test.ts`, `copilotContentOpenApplicationHandler.test.ts`, `queryEditorProviderCopilotContentOpenHandler.test.ts`, `informationNotificationApplicationHandler.test.ts`, `queryEditorProviderInformationNotificationHandler.test.ts`, `cachedValuesOpenApplicationHandler.test.ts`, `queryEditorProviderCachedValuesOpenHandler.test.ts`, `copilotAgentOpenApplicationHandler.test.ts`, `queryEditorProviderCopilotAgentOpenHandler.test.ts`, `copilotChatOpenUtils.test.ts`, `copilot-chat-manager-capabilities.test.ts`, `queryEditorProviderDashboardHandler.test.ts`, `queryEditorProviderPowerBiPublishHelp.test.ts`, `powerBiPublishCancellation.test.ts`, `persistence-roundtrip.test.ts`, `message-handler.test.ts`, `message-protocol.test.ts`, `section-projection-order.test.ts`, `main-url-batch-visibility.test.ts`, `section-setName.test.ts`, `kqlxMarkdownOwnership.test.ts`, and the native `host-owned-markdown-lifecycle`, `python-execution-application-handler`, `imported-csv-save-application-handler`, `share-result-artifacts`, and `csv-result-artifacts` scenarios. Run Vitest with `--maxWorkers=1` and extension-host tests with `--timeout 5000`.

KQL language request ownership is covered directly by `kqlLanguageRequestApplicationHandler.test.ts` and through the real provider by `queryEditorProviderKqlLanguageRequestHandler.test.ts`; keep `kqlDiagnostics.test.ts`, `message-handler.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

SQL last-selection ownership is covered directly by `sqlLastSelectionApplicationHandler.test.ts` and through the real provider by `queryEditorProviderSqlLastSelectionHandler.test.ts`; keep `sql-section-session.controller.test.ts`, SQL onboarding/discovery/lifecycle tests, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Development-note mutation correlation is covered directly by `developmentNoteMutationApplicationHandler.test.ts` and through the real provider by `queryEditorProviderDevelopmentNoteMutationHandler.test.ts`; keep Copilot tool/history coverage, `message-handler.test.ts`, persistence/codec tests, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot inline-completion admission is covered directly by `copilotInlineCompletionApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotInlineCompletionHandler.test.ts`; keep Copilot generation, SQL owner/lifecycle, `message-handler.test.ts`, `sql-section-message-router.test.ts`, editing-preference, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot availability admission is covered directly by `copilotAvailabilityApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotAvailabilityHandler.test.ts`; keep `queryEditorCopilotFunctionExecution.test.ts`, global/Kusto/SQL caller guards, `message-handler.test.ts`, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot write-query preparation admission is covered directly by `copilotWriteQueryPreparationApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotWriteQueryPreparationHandler.test.ts`; keep `queryEditorCopilotFunctionExecution.test.ts`, Kusto/SQL chat-manager caller coverage, `message-handler.test.ts`, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot conversation-clear admission is covered directly by `copilotConversationClearApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotConversationClearHandler.test.ts`; keep `queryEditorCopilotFunctionExecution.test.ts`, Kusto/SQL chat-manager caller coverage, `kw-copilot-chat.test.ts`, `message-handler.test.ts`, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot history-removal admission is covered directly by `copilotHistoryRemovalApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotHistoryRemovalHandler.test.ts`; keep `queryEditorCopilotFunctionExecution.test.ts`, shared Kusto/SQL chat-manager caller coverage, `kw-copilot-chat.test.ts`, `message-handler.test.ts`, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot Chat first-time workflow ownership is covered directly by `copilotChatFirstTimeApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotChatFirstTimeHandler.test.ts`; keep `copilotChatOpenUtils.test.ts`, shared Kusto/SQL chat-manager caller coverage, initial `connectionsData`, `message-handler.test.ts`, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Workbench panel tool-session ownership is covered directly by `workbenchToolSessionApplicationHandler.test.ts` and through the real provider by `queryEditorProviderWorkbenchToolSessionHandler.test.ts`; keep `toolOrchestratorConnect.test.ts`, `queryEditorSchema.test.ts`, `sqlEditorLifecycleCoordinator.test.ts`, HST-23 priority coverage, `message-handler.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Kusto connection-browsing ownership is covered directly by `kustoConnectionBrowsingApplicationHandler.test.ts` and through the real provider by `queryEditorProviderKustoConnectionBrowsingHandler.test.ts`; keep `queryEditorConnection.test.ts`, `kqlCompatEditorProvider.test.ts`, Kusto intake/onboarding tests, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring.

Copilot query-workflow ownership is covered directly by `copilotQueryWorkflowApplicationHandler.test.ts` and through the real provider by `queryEditorProviderCopilotQueryWorkflowHandler.test.ts`; keep `queryEditorProviderCancel.test.ts`, `queryEditorCopilotFunctionExecution.test.ts`, `sqlExecutionBroker.test.ts`, `sqlEditorLifecycleCoordinator.test.ts`, Kusto/SQL chat-manager caller coverage, `message-handler.test.ts`, `webview-messages.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring. Run Vitest with `--maxWorkers=1` and retain exact success/failure/cancellation ordering plus lazy adapter-resolution assertions.

Kusto section-execution ownership is covered directly by `kustoSectionExecutionApplicationHandler.test.ts` and through the real provider by `queryEditorProviderKustoSectionExecutionHandler.test.ts`; keep `queryEditorProviderCancel.test.ts`, `kustoExecutionCoordinator.test.ts`, `queryEditorCopilotFunctionExecution.test.ts`, `toolOrchestratorConnect.test.ts`, `query-execution-run-function.test.ts`, `kw-query-section-loading.test.ts`, `message-handler.test.ts`, `webview-messages.test.ts`, `persistence-roundtrip.test.ts`, `kusto-schema-ownership.test.ts`, `query-section-accessors.test.ts`, `message-protocol.test.ts`, and provider disposal coverage in the adjacent ring. Run Vitest with `--maxWorkers=1`; retain exact lifecycle, start/publication acknowledgement, manual terminal, replacement, cancellation, physical/policy identity, disposal-crossing settlement, late suppression, and current 15-case provider-inventory assertions.

Cross-engine comparison preparation is covered directly by `comparisonPreparationApplicationHandler.test.ts` and through the real provider by `queryEditorProviderComparisonPreparationHandler.test.ts`; keep `queryEditorProviderCancel.test.ts`, `sqlEditorLifecycleCoordinator.test.ts`, `sqlExecutionBroker.test.ts`, `kustoExecutionCoordinator.test.ts`, `queryEditorCopilotFunctionExecution.test.ts`, `sql-comparison-lifecycle.test.ts`, `sql-section-message-router.test.ts`, `message-handler.test.ts`, `webview-messages.test.ts`, `result-artifact.test.ts`, `persistence-roundtrip.test.ts`, `query-execution-run-function.test.ts`, `message-protocol.test.ts`, document-capability ownership, and provider disposal coverage in the adjacent ring. Run Vitest with `--maxWorkers=1`; retain all five SQL acknowledgement phases, rollback/retry, exact Kusto and SQL identities, target/policy races, removal cancellation, lifecycle rejection, disposal-crossing settlement, late suppression, and current 15-case provider-inventory assertions. Include `comparisonPreparationApplicationHandler.ts` in host-message sender inventory whenever its transport changes.

Comparison-summary bridge retirement is covered by the real local rendering and target-retirement tests in `query-execution-run-function.test.ts` and `kw-query-section-loading.test.ts`, plus `comparisonSummaryHostBridgeRetirement.test.ts`. Keep comparison artifact, SQL lifecycle, Copilot, message-protocol, and browser-build coverage in the adjacent ring.

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
* **Editor lifecycle**: `SqlEditorLifecycleCoordinator` is the per-editor orchestrator for section incarnations, target transitions, STS document sequencing/replay, monotonic database request tickets/currentness/exact completion, and connection/principal/Leave No Trace invalidation. Keep editor-local maps and subscriptions there. `QueryEditorProvider` should remain a thin webview/cross-language adapter and must not recreate lifecycle maps.
* **Execution ownership**: `SqlEditorSessionRegistry` owns section/comparison target identity and owner tokens. `SqlExecutionBroker` owns editor-scoped SQL admission, pending execution IDs, exact cancellation, currentness, and lease cleanup for both manual and Copilot runs. Keep query shaping, retry policy, UI copy, and Copilot history outside the broker.
* **SQL Leave No Trace**: `SqlLeaveNoTracePolicyStore` is the cross-window source of truth. Every SQL data, language, schema-cache, Copilot, and restoration entry point must refresh/revalidate it immediately before dispatch or data admission. Enabling it cancels active owners and clears host, webview, shared-result, dependent-section, and Copilot history state. Manual queries and database discovery remain available through a one-operation STS process whose temp, home, app-data, cache, working, and log directories are isolated; the process must stop and its sandbox must be deleted before results are admitted. Shared language STS, schema caching, result persistence/restoration, and protected error logging remain disabled.
* **Build**: Only `vscode` is externalized from the extension host bundle. `sql-formatter` is bundled for the webview prettify feature; STS is a verified first-use download.
* **Tests**: SQL host tests include process epochs, manager replacement, protocol execution, paging, cancellation, result adaptation, schema parsing, TLS/auth options, cross-host LNT propagation/restoration/Copilot invalidation, and dialect metadata. Authenticated behavior E2E lives under `tests/vscode-extension-tester/e2e/sql-auth/`.

### SQL Lifecycle Tests

Test `SqlEditorLifecycleCoordinator` directly with injected workbench, language-service, message, Copilot, persistence, and schema effects. Drive public operations such as section open/close, target adoption/retirement, STS connect/change/replay, connection/principal changes, Leave No Trace changes, and disposal. Do not construct `QueryEditorProvider` from its prototype or mutate lifecycle-private maps.

Keep provider tests focused on adapter responsibilities: message routing, manual SQL execution UX, database/schema I/O, persistence sanitation/publication, panel transport, and Kusto behavior. Test comparison preparation directly through `HostComparisonPreparationApplicationHandler`; use the real provider only for constructor ordering, reference-identical three-route/preparation forwarding, exact settlement/rejection, thin delegation, zero direct effects, and disposal. Test dashboard workflows directly through `HostDashboardApplicationHandler`, governed native CSV workflows through `HostArtifactCsvSaveApplicationHandler`, imported CSV publication through `HostImportedCsvSaveApplicationHandler`, Python process/terminal behavior through `HostPythonExecutionApplicationHandler`, sharing behavior through `HostQuerySharingApplicationHandler`, URL acquisition through `HostUrlContentApplicationHandler`, control-command syntax lookup through `HostControlCommandSyntaxApplicationHandler`, local resource resolution through `HostResourceUriApplicationHandler`, Copilot content opening through `HostCopilotContentOpenApplicationHandler`, information notifications through `HostInformationNotificationApplicationHandler`, Cached Values command dispatch through `HostCachedValuesOpenApplicationHandler`, Agent Chat opening through `HostCopilotAgentOpenApplicationHandler`, cursor status routing/lifecycle through `HostEditorCursorStatusApplicationHandler`, and editing-preference mutation/publication through `HostEditingPreferencesApplicationHandler`; use the real provider only to prove typed injection/forwarding, visibility where applicable, and disposal. Protocol tests must inventory host messages emitted from `queryEditorProvider.ts`, `comparisonPreparationApplicationHandler.ts`, `dashboardApplicationHandler.ts`, `artifactCsvSaveApplicationHandler.ts`, `pythonExecutionApplicationHandler.ts`, `querySharingApplicationHandler.ts`, `urlContentApplicationHandler.ts`, `controlCommandSyntaxApplicationHandler.ts`, `resourceUriApplicationHandler.ts`, `copilotContentOpenApplicationHandler.ts`, `informationNotificationApplicationHandler.ts`, `cachedValuesOpenApplicationHandler.ts`, `copilotAgentOpenApplicationHandler.ts`, `editorCursorStatusApplicationHandler.ts`, `editingPreferencesApplicationHandler.ts`, and `sql/sqlEditorLifecycleCoordinator.ts`. The sender extractor must retain coverage for option-backed handler transports and all-webview broadcasts rather than only direct provider `postMessage` calls.

Test SQL single-connection onboarding directly through `HostSqlConnectionOnboardingApplicationHandler`, Query Editor SQL favorites directly through `HostSqlFavoritesApplicationHandler`, Query Editor Kusto favorites directly through `HostKustoFavoritesApplicationHandler`, and Query Editor SQL database discovery directly through `HostSqlDatabaseDiscoveryApplicationHandler`; use the real provider only for exact-object injection/forwarding, projection/read delegation where applicable, activation where applicable, and disposal. Include all four handler files in host-message sender inventory whenever their transport changes.

Test Query Editor KQL language requests directly through `HostKqlLanguageRequestApplicationHandler`; use the real provider only for reference-identical injection/forwarding, awaited claimed settlement, exact rejection, constructor ordering, and disposal. Include `kqlLanguageRequestApplicationHandler.ts` in host-message sender inventory whenever its transport changes.

Test Query Editor SQL last-selection persistence directly through `HostSqlLastSelectionApplicationHandler`; use the real provider only for reference-identical injection/forwarding, awaited claimed settlement, exact rejection, zero direct application-state writes, constructor ordering, and disposal. Include `sqlLastSelectionApplicationHandler.ts` in the host-message sender inventory and keep it response-free.

Test Copilot development-note mutation correlation directly through `HostDevelopmentNoteMutationApplicationHandler`; use the real provider only for exact mutation delegation, reference-identical claimed-response offering, unclaimed tool-orchestrator fallthrough, zero provider resolver-map effects, constructor ordering, and disposal. Include `developmentNoteMutationApplicationHandler.ts` in the host-message sender inventory and preserve the existing `updateDevNotes` / `toolResponse` shapes.

Test Copilot inline-completion admission directly through `HostCopilotInlineCompletionApplicationHandler`; use the real provider only for reference-identical Kusto/SQL forwarding, awaited claimed settlement, exact rejection, zero direct owner-token/Copilot/fallback effects, constructor ordering, and disposal. Include `copilotInlineCompletionApplicationHandler.ts` in the host-message sender inventory and preserve the existing request/result shapes.

Test Copilot availability admission directly through `HostCopilotAvailabilityApplicationHandler`; use the real provider only for reference-identical forwarding, awaited claimed settlement, exact rejection, zero direct Copilot/transport effects, constructor ordering, and disposal. Include `copilotAvailabilityApplicationHandler.ts` in the host-message sender inventory as response-free, keep `queryEditorCopilot.ts` as the `copilotAvailability` sender, and preserve the existing request/result shapes.

Test Copilot write-query preparation admission directly through `HostCopilotWriteQueryPreparationApplicationHandler`; use the real provider only for reference-identical Kusto/SQL forwarding, awaited claimed settlement, exact rejection, zero direct Copilot/transport effects, constructor ordering, and disposal. Include `copilotWriteQueryPreparationApplicationHandler.ts` in the host-message sender inventory as response-free, keep `queryEditorCopilot.ts` as the `copilotWriteQueryOptions` / `copilotWriteQueryStatus` sender, and preserve the existing request/result shapes.

Test Copilot conversation-clear admission directly through `HostCopilotConversationClearApplicationHandler`; use the real provider only for reference-identical Kusto/SQL forwarding, awaited claimed settlement, exact rejection, zero direct Copilot/transport effects, constructor ordering, and disposal. Include `copilotConversationClearApplicationHandler.ts` in the host-message sender inventory as response-free, keep both clear capabilities and all conversation state in `queryEditorCopilot.ts`, and preserve the existing Kusto identity-bearing and SQL box-scoped message shapes.

Test Copilot history-removal admission directly through `HostCopilotHistoryRemovalApplicationHandler`; use the real provider only for reference-identical Kusto/SQL-originated forwarding, awaited claimed settlement, exact rejection, zero direct Copilot/transport effects, constructor ordering, and disposal. Include `copilotHistoryRemovalApplicationHandler.ts` in the host-message sender inventory as response-free, keep normalization and history mutation in `queryEditorCopilot.ts`, keep immediate local removal plus exact shared-manager emission in the webview, and preserve the existing box/entry message shape.

Test the complete Copilot Chat first-time workflow directly through `HostCopilotChatFirstTimeApplicationHandler`; use the real provider only for reference-identical forwarding, awaited claimed settlement, exact rejection, zero direct state/modal/helper/transport effects, constructor ordering, and disposal. Include `copilotChatFirstTimeApplicationHandler.ts` in the host-message sender inventory as the sole `copilotChatFirstTimeResult` sender, keep the shared Kusto/SQL request caller and webview result application unchanged, and preserve the existing request/result shapes.

Test Workbench panel tool sessions directly through `HostWorkbenchToolSessionApplicationHandler`; use the real provider only for constructor ordering, activation/disposal, reference-identical three-route forwarding, HST-23-first response claiming, thin state delegation, and zero legacy/global effects. Include `workbenchToolSessionApplicationHandler.ts` in host-message sender inventory as the `requestToolState` sender, keep `KustoWorkbenchToolOrchestrator`, `SchemaService`, and `SqlEditorLifecycleCoordinator` as separate canonical owners, and preserve the existing tool request/response shapes.

Test Kusto connection browsing directly through `HostKustoConnectionBrowsingApplicationHandler`; use the real provider only for constructor ordering, reference-identical four-route forwarding, awaited settlement, exact rejection, zero direct projection/`ConnectionService`/diagnostics effects, and disposal. Include `kustoConnectionBrowsingApplicationHandler.ts` in host-message sender inventory as response-free, keep the provider revisioned `connectionsData` projection and `ConnectionService` as canonical senders/owners, preserve the plain `.kql` pre-forward cache/inference path, and preserve existing request/response shapes.

Test comparison summaries through local webview behavior. Rendering must create the exact banner/diff link without host traffic, and target retirement must remove the banner without host traffic while preserving owner cancellation and artifact cleanup. Keep a static production-source guard that rejects any return of summary maps, waiters, routes, callbacks, or protocol types.

## Notebook Codec Development

Kusto bulk/XML connection intake is tested directly through `HostKustoConnectionIntakeApplicationHandler`; Kusto and SQL single-connection onboarding are tested directly through `HostKustoConnectionOnboardingApplicationHandler` and `HostSqlConnectionOnboardingApplicationHandler`; Query Editor SQL and Kusto favorites are tested directly through `HostSqlFavoritesApplicationHandler` and `HostKustoFavoritesApplicationHandler`. Use the real provider only for exact-object injection/forwarding, projection/read delegation where applicable, activation, and disposal. Include all five handler files in host-message sender inventory whenever their transport changes.

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

`persistence.ts` (`getKqlxState()`) iterates direct DOM children of `#queries-container`. Native host-owned Markdown, URL, Python, Chart, Transformation, and HTML sections are substituted from the acknowledged host projection and never serialized from the component. Unmigrated kinds and metadata-free browser/legacy hosts still call `el.serialize()`. IDs are opaque persisted identities and are not required to use a type prefix.

### Rules

- **Every Lit section component must implement `serialize()`** returning a JSON-serializable object with a `type` field matching the `KqlxSectionV1` union for browser/legacy compatibility. Native persistence for migrated kinds must not call it.
- **Do not infer section ownership from ID prefixes.** Persistence, tool removal, and lifecycle cleanup must use the section element/type so arbitrary restored IDs receive the same behavior.
- **`schedulePersist()` computes a JSON signature to avoid unnecessary disk writes.** Do not bypass this with direct `postMessage` persistence calls.
- **Leave No Trace**: Sections connected to a leave-no-trace cluster have their `resultJson` stripped before persistence. If you add new data fields to section serialization, verify they respect this check (see [ARCHITECTURE.md](ARCHITECTURE.md) for details).

### HTML Dashboard Serialization

HTML sections persist source and configuration, not data snapshots. The serialized shape must stay aligned between `kqlxFormat.ts` and `kw-html-section.ts`:

- Persist `type: 'html'`, `name`, `code`, `mode`, `expanded`, `editorHeightPx`, `previewHeightPx`, `previewHeightUserSet`, `dataSourceIds`, optional `pbiPublishInfo`, and optional `powerBiUpgradeNotice` through `htmlSectionDefinition.ts` and the shared document owner.
- `dataSourceIds` are references to source query/transformation sections derived from provenance and section wiring; do not duplicate result rows inside the HTML section.
- `pbiPublishInfo` is metadata returned by Fabric/Power BI publish (`workspaceId`, model/report IDs, report name, URL, selected data mode). Preserve it across save/restore so republish can update the existing report with the intended Import/DirectQuery behavior.
- Apply publish metadata through the exact one-field host command. A stale publish must restore the authoritative prior value, concurrent ordinary HTML edits must carry the provisional new value, and cleanup must follow the queue-stable authoritative projection.
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

Use this checklist when changing `kw-html-section`, dashboard prompts/tools, `dashboardApplicationHandler.ts`, `powerBiExport.ts`, `powerBiPublish.ts`, or related message contracts.

1. **Preserve provenance v1 compatibility.** Dashboards use `<script type="application/kw-provenance">` with `model.fact`, optional `model.dimensions`, and `bindings`. Treat schema changes as compatibility-sensitive.
2. **Use `data-kw-bind` for exportable values.** Preview JavaScript can enhance the dashboard, but Power BI output is generated from provenance bindings and `data-kw-bind` targets. JS-only DOM updates do not become Power BI visuals.
3. **Keep exportable visual parity explicit.** HTML dashboard charts should use `KustoWorkbench.renderChart(bindingId)` in preview and provenance chart bindings for export. Exportable tables should use `KustoWorkbench.renderTable(bindingId)`, repeated grouped table sections should use `KustoWorkbench.renderRepeatedTable(bindingId)`, and table-cell visuals should live in provenance `columns[].cellBar` or `columns[].cellFormat` specs. Preview SVG/HTML and Power BI DAX/SVG should share the same spec, palette, geometry, ordering, top-N, label, legend, and conditional-formatting semantics.
4. **Keep slicer semantics consistent.** Preview slicers are derived from provenance dimensions, filter the fact data client-side, and compose with AND semantics. Power BI export should generate equivalent native slicer visuals bound to fact-table columns where supported.
5. **Keep agent dashboard guidance current.** Dashboard authoring rules live in `copilot-instructions/html-dashboard-rules.md`, are exposed through `getHtmlDashboardGuide`, and should include upgrade-on-touch behavior for existing dashboards. Update `media/skill-template.md` and bump `TEMPLATE_VERSION` in `skillExport.ts` when exported skill behavior changes.
6. **Validate through the export path.** Agent-facing validation should reuse the webview export context and the shared Power BI validation collector so it matches actual export/publish behavior.
7. **Document and test new binding shapes.** If adding scalar/table/repeated-table/pivot/chart display modes, table cell visuals, or `preAggregate` behavior, cover DAX generation and rendered HTML/SVG output in `powerBiExport.test.ts` and preview bridge behavior in webview tests.
8. **Export `.pbip`/PBIR/TMDL, not `.pbix`.** Do not describe or implement this path as direct `.pbix` generation. The project uses the marketplace-signed HTML Content visual rather than importing a local `.pbiviz` file.
9. **Maintain data-mode compatibility.** Generated model queries should continue to use Kusto `AzureDataExplorer.Contents` sources, stable table/column naming, and explicit Import/DirectQuery behavior for local export, new publish, and legacy republish flows.
10. **Preserve Fabric publish/update behavior.** Publishing must support create-new and update-existing flows, item existence checks, exact stored metadata rollback, single-principal refresh calls, partial-create compensation, and non-fatal refresh schedule failures. Do not clean up a tuple still referenced by any authoritative HTML section.
11. **Keep host/webview contracts typed and correlated.** Any new export/publish message must be added to both `queryEditorTypes.ts` and `webview-messages.ts`, carry exact request identity/cancellation, route through `HostDashboardApplicationHandler`, and be covered by `message-protocol.test.ts`. The protocol sender inventory must include `dashboardApplicationHandler.ts`. Tool-framework messages that intentionally use generic `toolResponse` still need protocol inventory coverage.

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
