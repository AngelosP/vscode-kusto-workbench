# Architecture Convergence

## Purpose

This is the living work queue for moving Kusto Workbench toward [GOLDEN_OUTCOME.md](GOLDEN_OUTCOME.md).

It records:

- Where the current implementation already matches the golden outcome.
- Where authority, contracts, and behavior still diverge.
- Which gap has the highest priority now.
- The smallest vertical migration that can prove the next boundary.
- The evidence required before selecting another gap.

[ARCHITECTURE.md](ARCHITECTURE.md) remains the factual description of the current implementation. The golden outcome is stable. This document changes after every architecture iteration.

## Operating Principle

Convergence is not a rewrite and not a file-splitting exercise.

Each iteration must move one real state transition behind one explicit owner, preserve the external behavior and file formats, delete the displaced authority, and add a guard that prevents the old ownership pattern from returning.

A smaller file is not evidence of progress. Fewer competing authorities and stronger executable contracts are evidence of progress.

## Baseline

Assessment date: 2026-08-06

The comparison was refreshed against the current working tree after HST-8 local resource URI application-handler convergence. It includes the full implemented feature set described by the README, package contributions, persisted formats, architecture documentation, browser extension, and test suites.

The current architecture is not uniformly legacy. Several high-risk contexts already provide good models for the rest of the application.

## Current Alignment

| Golden outcome boundary | Current implementation | Assessment |
| ----------------------- | ---------------------- | ---------- |
| Exact Kusto schema ownership | [`KustoEditorSchemaCoordinator`](src/webview/core/kusto-editor-schema-coordinator.ts), exact message routing, model leases, target generations, and tombstones | Strong foundation |
| Serialized shared Kusto worker | [`KustoWorkerMutationPort`](src/webview/shared/kusto-worker-mutation-port.ts) with detached settlement and inline recovery | Strong foundation |
| SQL target and execution ownership | [`SqlEditorLifecycleCoordinator`](src/host/sql/sqlEditorLifecycleCoordinator.ts), [`SqlEditorSessionRegistry`](src/host/sql/sqlEditorSessionRegistry.ts), and [`SqlExecutionBroker`](src/host/sql/sqlExecutionBroker.ts) | Strong foundation |
| Compatibility sidecar mechanics | [`CompatSidecarFormat`](src/host/compatSidecarFormat.ts), [`CompatSidecarStore`](src/host/compatSidecarStore.ts), and [`CompatSidecarSession`](src/host/compatSidecarSession.ts) | Strong shared core |
| Lossless notebook codec and kind capabilities | [`kqlxOverlay.ts`](src/host/kqlxOverlay.ts) preserves exact unknown data; [`documentSectionCapabilities.ts`](src/shared/documentSectionCapabilities.ts) owns every known `.kqlx`/`.sqlx`/`.mdx` allow/default/add decision across parser, host, webview, tools, upgrades, and browser | Strong foundation |
| Kusto physical identity fencing | Connection, schema, and database operations capture endpoint and authority identity before asynchronous work | Strong foundation |
| SQL Leave No Trace policy | Cross-window policy, revocation generations, protected one-shot runtime, and guarded admission | Strong but SQL-specific |
| Dashboard domain semantics | Shared provenance upgrade/validation concepts and extensive Power BI golden tests | Good domain core, mixed with adapters |
| Dashboard application workflow | [`HostDashboardApplicationHandler`](src/host/dashboardApplicationHandler.ts) owns all dashboard requests, cancellation, first-commit admission, publish application/compensation leases, and cleanup; `QueryEditorProvider` only composes transport | Strong initial host-application boundary |
| Artifact CSV save workflow | [`HostArtifactCsvSaveApplicationHandler`](src/host/artifactCsvSaveApplicationHandler.ts) owns picker admission, nonce challenges, cancellation, deadlines, replay tombstones, exact correlation, and file publication; `QueryEditorProvider` only composes transport | Strong bounded host-application boundary |
| Imported CSV save workflow | [`HostImportedCsvSaveApplicationHandler`](src/host/importedCsvSaveApplicationHandler.ts) owns empty-data UX, picker admission, URI-preserving extension handling, exact UTF-8 publication, saved-file actions, failures, and disposal; `QueryEditorProvider` only composes routing | Strong bounded host-application boundary |
| Query-sharing workflow | [`HostQuerySharingApplicationHandler`](src/host/querySharingApplicationHandler.ts) owns ADX-link encoding, Kusto/SQL rich and plain formatting, host clipboard effects, response publication, notifications, and disposal; `QueryEditorProvider` only composes lookup and transport | Strong bounded host-application boundary |
| URL-content acquisition workflow | [`HostUrlContentApplicationHandler`](src/host/urlContentApplicationHandler.ts) owns URL validation, redirect-following fetch, timeout/abort, byte caps, classification/sniffing, truncation, response publication, and disposal; `QueryEditorProvider` only composes transport | Strong bounded host-application boundary |
| Control-command syntax lookup | [`HostControlCommandSyntaxApplicationHandler`](src/host/controlCommandSyntaxApplicationHandler.ts) owns the 24-hour cache, Microsoft Learn fetch/normalization, syntax/entity extraction, `with(...)` parsing, response publication, and disposal; `QueryEditorProvider` only composes transport | Strong bounded host-application boundary |
| Local resource URI resolution | [`HostResourceUriApplicationHandler`](src/host/resourceUriApplicationHandler.ts) owns passthrough and local-base decisions, Windows/POSIX/workspace path normalization, stat/cache behavior, webview URI conversion, response publication, and disposal; `QueryEditorProvider` only composes transport and the live conversion capability | Strong bounded host-application boundary |
| Editing preferences and first launch | Revisioned application preferences and transactional profile setup | Good explicit ownership |
| Native document-view lifecycle protocol | [`documentViewProtocol.ts`](src/shared/documentViewProtocol.ts), one host-created panel UUID, runtime parsing, exactly-once initial projection, and session-fenced commands/results/Save barriers | Strong initial protocol slice |
| Unmigrated section serialization | Kusto/SQL and remaining adapter-heavy kinds still participate in broad restore/persistence switches; Markdown, URL, Python, Chart, Transformation, and HTML native state no longer comes from component `serialize()` | Useful transitional boundary |

These parts should normally be wrapped behind golden-outcome ports, not rewritten. Their adversarial lifecycle tests are migration assets.

## Priority Model

Product direction is the eligibility gate. A gap explicitly deferred by the product owner remains documented against the golden outcome but cannot preempt eligible product work, regardless of its raw score. Every eligible gap receives six scores from 1 to 5. The register scores architecture themes; the active iteration is selected separately and must state its own feasibility. A theme cannot borrow the feasibility of a narrow slice or make that slice appear to close the whole theme.

| Dimension | Weight | A score of 5 means |
| --- | ---: | --- |
| `H` - Harm | 3 | The gap can lose/cross-contaminate data, violate privacy, wedge a core workflow, or publish stale work. |
| `A` - Change amplification | 2 | Ordinary feature changes require coordinated edits across many owners or duplicated paths. |
| `R` - Reach | 2 | The gap affects most features, document types, or hosts. |
| `L` - Leverage | 2 | Closing it unlocks several later golden-outcome boundaries. |
| `F` - Feasibility | 1 | A narrow vertical slice can be shipped and reversed safely. |
| `E` - Evidence | 1 | Runtime failures, source-confirmed defects, or strong test gaps demonstrate the problem. |

The score is:

```text
priority = 3H + 2A + 2R + 2L + F + E
```

The maximum is 55. The score orders eligible gaps; it does not override dependency constraints. A correctness, security, or privacy finding preempts the queue only when product direction or release policy classifies it as release-blocking.

## Gap Register

| Rank | ID | Gap | H/A/R/L/F/E | Score | State |
| ---: | --- | --- | --- | ---: | --- |
| - | `EXA` | Exact execution and immutable artifact spine | 5/5/5/5/2/5 | 52 | Closed through EXA-2; transport-neutral coordinator convergence remains deferred |
| - | `COD` | Lossless versioned codecs and one document-kind capability matrix | 5/4/5/5/4/5 | 52 | Closed through COD-2 |
| 1 | `HST` | Host application composition; retire `QueryEditorProvider` as an application shell | 4/4/5/4/4/5 | 47 | HST-1 through HST-8 closed; HST-9 selected |
| 2 | `PRO` | Runtime-validated protocol, view sessions, and deterministic startup | 4/4/5/4/3/4 | 45 | PRO-1 closed; broader protocol/startup work remains open |
| 3 | `DOC` | Document actor and section-definition registry | 4/4/4/4/2/5 | 43 | DOC-1 through DOC-6 closed; Kusto/SQL deferred |
| 4 | `BRW` | Real browser read-only composition root | 3/4/4/4/4/4 | 41 | Open, depends on document/projection contracts |
| 5 | `CMP` | Compatibility-provider composition around the shared sidecar core | 4/4/3/3/3/4 | 39 | Open |
| 6 | `DSH` | Dashboard compiler IR separated from VS Code/Fabric adapters | 3/3/3/3/4/4 | 35 | Open |
| 7 | `KLS` | Custom KQL analyzer decomposition behind a language-analysis port | 3/3/2/2/3/4 | 30 | Open |
| - | `ACT` | Untrusted-document capability admission | 5/5/5/5/3/5 | 53 | Deferred by product direction; excluded from active ranking |

Bundle headroom is a release constraint and must remain gated, but it is not itself an ownership architecture. Large domain algorithms are not automatically gaps when they have one owner and focused contracts.

## Gap Details

### `ACT` - Untrusted-Document Capability Admission

**Status:** deferred by product direction. Keep this gap visible for golden-outcome completeness, but do not select or implement it unless product direction changes or it becomes an explicit release blocker.

**Golden outcome:** document origin and trust are versioned inputs to one host policy authority. Every document-authored privileged effect is separately authorized, including scripts, data, network, local code, Kusto, SQL/STS, language/schema traffic, model/tools, external resources, navigation, export, and publication. Trust or origin change revokes affected work and permissions.

**Current divergence:**

- Remote GitHub, Azure DevOps, SharePoint, OneDrive, and URL content is downloaded into extension global storage and opened as an ordinary local document. The editor receives no durable source-origin/trust descriptor.
- HTML preview uses `sandbox="allow-scripts"` and injects authored code through `srcdoc`. Its data bridge now requires an immutable artifact with an explicit compatibility exposure decision, but that decision is not yet grounded in document origin/trust capabilities.
- Neither the outer workbench template nor the preview `srcdoc` establishes a content-security policy. Sandboxing removes same-origin authority but does not by itself prohibit outbound network requests.
- Bootstrap and runtime dispatch accept arbitrary object-shaped `window.message` events without a host-session/source boundary. Authored iframe code can post to its parent and attempt to impersonate host document, policy, result, persistence, or tool messages.
- Expanded URL sections automatically request arbitrary HTTP/HTTPS content during restore. Host fetch is not admitted by document origin or trust and can target loopback/private endpoints.
- Markdown preview preserves direct HTTP/HTTPS image sources, so rendering alone can make a request without host policy admission.
- Fetched URL HTML injects a `<base>` and renders sanitized markup in a sandboxed iframe without a policy CSP. Nested images, stylesheets, fonts, frames, media, CSS URLs/imports, forms, and navigation can therefore resolve independently of the top-level host fetch decision.
- The read-only browser viewer is not an active-content trust boundary; read-only content can still execute and observe embedded data.
- Kusto/SQL admission now publishes an artifact-level `exposeToActiveContent` compatibility decision, and dashboards require it. There is still no independent origin/trust policy authority for that decision or for script/network capabilities.
- Migrated Kusto, chart, transformation, comparison, and HTML-preview paths retain immutable producer/policy/lineage identity. Unmigrated result consumers and SQL physical provenance remain outside the complete golden artifact contract.
- Standalone HTML export intentionally writes authored HTML/JavaScript verbatim, while Power BI/Fabric supports only the portable provenance subset. These outputs currently share one loosely defined export path.
- Authenticated top-level webview messages can directly invoke Python, Kusto, SQL/STS, schema/language, Copilot, and tool paths without an independent document-capability decision. Automatic restoration can also initiate SQL/Kusto preparation and authentication/network effects.
- A persisted `linkedQueryPath` can reference absolute, `file:`, UNC, or traversal-bearing paths. The provider can automatically read/open the target and later write edits, with no remote-origin containment or explicit adoption boundary.

**Failure modes:**

- A remote notebook can execute authored JavaScript and receive query-derived rows after the user runs or restores a source section.
- Active content can attempt network egress without a declared policy.
- Authored child-frame code can attempt to forge host protocol messages and mutate document or policy state.
- Restoring an untrusted remote document can trigger extension-host URL requests without any script grant.
- Passive Markdown or fetched-HTML rendering can trigger nested browser requests even when explicit host and script fetches are denied.
- Trust cannot be revoked coherently because origin and trust revision are absent from document and result state.
- Unmigrated consumers or a future exposure decision not grounded in origin/trust can still misclassify data despite the artifact-level compatibility gate.
- Browser read-only mode can be mistaken for script/data isolation.
- Portable Power BI behavior and raw active standalone export can be conflated, hiding non-portable or executable behavior.
- Untrusted documents can launch local Python, authenticated data-plane/language/model operations, or automatic preparation even when HTML remains static.
- Remote content can dereference local files or network shares through `linkedQueryPath`, crossing the immutable snapshot boundary before trust admission.

**Migration theme:** establish one document-capability gateway before expanding artifact availability or execution orchestration. Transport authentication, script execution, artifact exposure, passive/explicit network, host execution, external resources, model/tools, raw standalone export, and portable publication remain distinct decisions.

### `COD` - Lossless Codecs And Document Capabilities

**Golden outcome:** runtime-validated codecs preserve unknown root/state fields, known-section extension fields, opaque unknown sections, and order. One capability matrix validates `.kqlx`, `.sqlx`, and `.mdx` without silently filtering incompatible content.

**Status:** closed through COD-2.

**Current alignment:**

- `kqlxOverlay.ts` now preserves unknown root/state fields, known-section extensions, nested future fields, opaque sections, and relative order across notebook and sidecar persistence.
- Known field omission remains authoritative, legacy/id-less sections receive stable projected identities, and privacy sanitation removes modeled row-bearing fields without gaining authority over future extensions.
- `documentSectionCapabilities.ts` is the sole matrix for known/canonical kinds, legacy `copilotQuery`, hidden `devnotes`, persisted compatibility, visible add kinds, and defaults.
- The parser requires the URI-derived document kind, reports known incompatibility with document kind plus section index/ID/type, and leaves opaque future kinds outside incompatibility classification.
- Host projection, KQL/SQL/Markdown upgrade destinations, webview controls/defaults/restore, actual tool dispatch, and browser read-only parsing use that owner. An explicit empty host capability set remains empty.
- MDX silent sanitation and provider-local arrays are deleted. A static source guard rejects their return, while the cross-layer table tests every known matrix cell and the opaque-future control.

The remaining distributed section parse/reduce/serialize/view knowledge belongs to `DOC`, not COD.

### `EXA` - Exact Execution And Immutable Artifacts

**Golden outcome:** one transport-neutral execution coordinator owns reservation, replacement, cancellation, terminal settlement, and artifact publication. Every terminal carries exact operation identity. Every result becomes an immutable artifact revision with lineage and permissions.

**Current alignment:**

- EXA-1 introduced `KustoExecutionCoordinator` as the sole Kusto section terminal authority. It reserves before awaits, performs exact replacement/cancellation, captures authenticated dispatch identity, and settles success/error/cancellation/supersession once.
- Manual, Run Function, Copilot-final, performance-comparison, and agent-tool section publication use the coordinator. Copilot/comparison dispatch waits for exact webview start acknowledgement; tools acknowledge the exact owner and can cancel before or after acknowledgement.
- Section incarnation, target generation, connection/database, producer, reservation sequence, execution ID, physical attempt, account partition, client activity ID, connection revision/identity, and Leave No Trace revision are correlated through the real controller/provider/window-dispatcher boundary.
- Connection, true account rotation, removed/recreated sessions, authority, target, policy, section, and panel lifecycle changes revoke affected reservations. Only first automatic account establishment preserves its exact run. Comparison retarget clears result, persistence, summary, Optimize, and conversation state before target mutation.
- Kusto Copilot output and comparison preparation carry exact request/lifecycle identity; standalone Optimize has a parallel exact owner. Delegated tools capture exact request owners and use pre-start cancellation tombstones, panel disposal cancels all exact Kusto Copilot/Optimize owners, and recreated sections reject queued box-only or stale-generation output.
- Kusto Leave No Trace uses an atomically committed, file-locked, watched cross-window policy with per-cluster generations. Dispatch, result admission, table preview, and direct Copilot output/history mutation execute under the shared lock before watcher delivery, including awaited asynchronous delivery. Restoration waits for policy readiness and policy transitions purge queued, stored, shared, and rendered protected data. Unrecoverable post-migration state dominates older unblocked versions and stays globally fail closed for persistence and publication.
- Host-issued physical connection stamps fence reservation, pre-start admission, schema lifecycle, and dispatch, so reusing a saved connection ID cannot redirect stale execution or metadata work. Authentication-session generations fence recreated same-account sessions.
- Metadata viewers and direct agent tools carry exact physical/auth/policy/cache owners. Sensitive deliveries use stage/commit/revoke plus application acknowledgement, and persisted search rows are restored from per-row proofs rather than whole-profile invalidation.
- Mixed Kusto/SQL snapshots and persistence sanitation use one-attempt SQL owner locks and retry the complete Kusto-then-SQL acquisition without holding Kusto privacy admission during SQL contention.
- The webview retains cancelling and retired identities until exact terminal admission and rejects unstamped Kusto section terminals.
- `ResultArtifactStore` now snapshots every accepted result into a deep-immutable per-source revision while `results-state.ts` preserves the mutable latest-result facade for compatibility. Current pointers, explicit consumer bindings, source-wide revocation, and reference-based pruning have one owner.
- Admitted Kusto successes publish exact reservation, dispatch, target, principal, policy, and optional comparison lineage. Bounded `resultJson` persistence can carry a row-free artifact descriptor; owner/policy admission precedes descriptor installation, restored identity remains stable, and later revisions remain monotonic.
- Charts, transformations, comparisons, Diff, HTML dashboards, Power BI metadata, model/tool responses, Share Results, CSV export, and governed table-local copy now consume immutable artifacts or exact bindings. URL CSV sections publish immutable source artifacts while retaining their separate generic local copy/save workflow.
- Transformations bind primary and join-right revisions independently, compute from those immutable inputs, and publish derived artifacts with direct lineage roles plus flattened leaf-source policies. Formula edits stay pinned; source changes and dependent refresh explicitly rebind.
- Artifact retention now follows lineage references. Source clear revokes affected revisions and downstream bindings transitively while preserving a retargeted current derived revision whose lineage is independent of the cleared source.
- Kusto comparison source and output executions carry one exact run identity. Manual and standalone Optimize sequence on admitted source success; Copilot retries retain the same source execution. Output and summaries use the pinned source artifact and fail closed on target or policy mismatch.
- HTML dashboard previews bind an immutable provenance fact artifact and require an explicit active-content exposure decision. Refresh rebinds intentionally; revoke/source change hides and blanks iframe data synchronously; restore revalidates exposure after owner admission.
- Model/tool responses, Share Results, and result-table CSV export use independent policy-bearing bindings. CSV tables carry an exact artifact ID plus table-generation token; native save uses a host nonce challenge after the asynchronous picker, and browser viewers emulate the same challenge locally.
- Persistence deletion and host privacy sanitation remove rows and descriptors atomically. A descriptor is never row authority, cannot restore without admitted `resultJson`, and is rejected when its source or policy claims disagree with the current owner.
- Static terminal-construction/cancellation guards, protocol inventory, focused state-machine tests, full sequential tests, and authenticated normal/rerun/retarget/cancellation E2E are green.

**Remaining divergence:**

- Mutable latest-result state remains as a presentation and presence compatibility facade. The EXA-2 audit found no active row-bearing cross-section or egress consumer that still treats it as lineage authority.
- SQL results publish exact query/connection/database ownership for migrated consumers, but transport/principal parity with Kusto remains intentionally incomplete.
- Kusto and SQL retain transport-specific execution coordinators over the shared low-level run registry; a transport-neutral artifact publication contract has not yet proven which semantics should be shared above transport.

**Failure modes:**

- A future row consumer can regress if it bypasses artifact binding, declared-column projection, generation liveness, or synchronous revocation contracts.
- SQL restoration and persistence can preserve rows without the same first-class immutable producer, target, principal, policy, and lineage record as Kusto.
- Prematurely merging Kusto and SQL execution abstractions could erase transport-specific cancellation and privacy semantics before the artifact contract is proven.

**Migration theme:** EXA-2 is closed. Future transport-neutral coordinator work requires a separately selected iteration and must preserve the proven transport-specific cancellation and privacy contracts.

### `DOC` - Document Actor And Section Registry

**Golden outcome:** one serial document actor owns application content revisions, ordered domain state, and section commands while a VS Code `CustomDocument` adapter owns native dirty/undo/save/revert/backup/close integration. Each section kind has one definition for parse, migration, serialization, validation, dependencies, and policy. Views do not serialize the DOM.

**Current divergence:**

- Native Markdown, URL, Python, Chart, Transformation, and HTML persisted state are migrated: one host aggregate, one command client, one URI queue, and per-kind definitions own ordered state and revisions; all six Lit components are views, and native Save does not consult their DOM serialization.
- [`persistence.ts`](src/webview/core/persistence.ts) imports section construction/removal and centrally hydrates every section type.
- [`section-factory.ts`](src/webview/core/section-factory.ts) imports persistence, creating a cycle between mutation and storage.
- Creation, restoration, removal, tool configuration, dependency refresh, and privacy sanitation for Kusto/SQL and remaining adapter-heavy paths are distributed across large switches and per-type arrays.
- Unmigrated components still supply serialization without being canonical domain state. Restore behavior still knows component-private methods and timing.
- Adding a section requires edits across format, component, factory, persistence, tool removal, startup imports, and privacy handling.

**Migration theme:** DOC-1 through DOC-6 proved the transport-neutral aggregate/definition pattern with Markdown, URL, Python, Chart, Transformation, and HTML while preserving runtime-heavy adapters. Kusto/SQL remain materially higher-risk and are deferred until separately selected. The next eligible work is host composition behind the contracts now proven.

### `PRO` - Protocol, View Sessions, And Startup

**Golden outcome:** one runtime-validated protocol, explicit view-session identity, capability negotiation, plugin-ready handshake, one initial projection, and revisioned deltas.

**Current divergence:**

- `documentViewProtocol.ts` now owns runtime schemas and discriminated types for native `documentData`, `documentReloadResult`, host-owned section commands/results, and Save barriers. `KqlxEditorProvider` stamps one host-created UUID per panel; both directions reject malformed or cross-session envelopes before side effects, and the webview applies the initial projection exactly once.
- Existing source generations, command IDs, revisions, per-URI queues, and Save leases remain inner fences. Metadata-free compatibility and browser/legacy behavior is unchanged.
- All unrelated host/webview messages still use duplicated unions, `unknown` host output, and `any` dispatcher input.
- [`message-handler.ts`](src/webview/core/message-handler.ts) is a central switch while some temporary and component listeners observe the same transport independently.
- [`window-bridges.d.ts`](src/webview/window-bridges.d.ts) remains a large ambient contract, and state is mirrored between module bindings and `window`.
- [`index.ts`](src/webview/index.ts) relies on import-time side effects and says `main` must be last even though component registration imports follow it.
- The preload queues early Add commands in `window.__kustoQueryEditorPendingAdds`, while runtime restore drains a separate `pState.queryEditorPendingAdds`. There is no explicit adoption handoff.
- Browser startup implements a different buffering/acknowledgement protocol.

**Migration theme:** PRO-1 closes only the host-owned document lifecycle channel. Future PRO slices may add capability/plugin readiness and migrate one additional domain router at a time; do not turn the proven narrow schema into a global rewrite. Ambient bridges are removed only after their owning contract exists.

### `HST` - Host Application Composition

**Golden outcome:** the VS Code provider is a transport/composition adapter. Application workflows live in use-case handlers and actors.

**Current divergence:**

- HST-1 moved dashboard prompts, export, workspace/existence lookup, publish request lifetimes, first-external-commit admission, document metadata application/compensation leases, and cleanup into one injected `HostDashboardApplicationHandler`. The provider has no dashboard workflow maps, Fabric/export imports, discriminator switch, or publish transition authority.
- HST-2 moved governed result-table CSV picker admission, one-use nonce challenges, cancellation, deadlines, replay tombstones, exact correlation, and file publication into one injected `HostArtifactCsvSaveApplicationHandler`. The provider has no artifact CSV maps, discriminator cases, deadlines, tombstones, or write transitions.
- HST-3 moved Python interpreter fallback, process/stdin/stdout/stderr lifecycle, independent 200 KB UTF-8 output caps, 15-second timeout/kill behavior, exactly-once terminal publication, and disposal into one injected `HostPythonExecutionApplicationHandler`. The provider has no Python process creation, discriminator case, output accumulation, timeout transition, or terminal construction.
- HST-4 moved imported URL-section CSV empty-data UX, native picker admission, URI-preserving extension handling, exact UTF-8 publication, saved-file actions, failures, and disposal into one injected `HostImportedCsvSaveApplicationHandler`. The provider has no imported CSV picker/write/notification code or discriminator case.
- HST-5 moved Kusto ADX-link generation, Kusto/SQL rich and plain-text share formatting, host clipboard effects, `shareContentReady`, notifications, and disposal into one injected `HostQuerySharingApplicationHandler`. The provider has no sharing discriminator cases, zlib/link generation, formatting, clipboard effects, or sharing publication.
- HST-6 moved URL validation, redirect-following fetch, timeout/abort, text/image byte caps, truncation, content classification/sniffing, response shaping, and disposal into one injected `HostUrlContentApplicationHandler`. The provider has no URL acquisition discriminator case, fetch/abort transition, cap/classification decision, or URL terminal construction.
- HST-7 moved the 24-hour control-command syntax cache, Microsoft Learn URL normalization/fetch, HTML/entity syntax extraction, `with(...)` argument parsing, failure shaping, `controlCommandSyntaxResult` publication, and disposal into one injected `HostControlCommandSyntaxApplicationHandler`. The provider has no syntax cache, parsing helper, Learn fetch, discriminator case, or syntax-result construction.
- HST-8 moved local resource request shaping, passthrough/local-base decisions, Windows/POSIX/workspace path normalization, stat and exact base/path caching, webview URI conversion, failure shaping, `resolveResourceUriResult` publication, and disposal into one injected `HostResourceUriApplicationHandler`. The provider has no resource cache, path import/normalization, stat, discriminator case, failure strings, or result construction.
- [`QueryEditorProvider`](src/host/queryEditorProvider.ts) still combines panel transport with Kusto execution, SQL adapters, persistence UX, comparisons, and cross-language coordination.
- Focused tests often construct or patch the provider without a real composition root, indicating that use cases do not have narrow injectable boundaries.

**Migration theme:** do not split the class by file category first. Move routes behind the execution, document, protocol, and dashboard contracts as those owners are introduced. The provider shrinks as a consequence.

### `BRW` - Browser Composition Root

**Golden outcome:** browser rendering uses shared codecs, projections, and section views with an explicit read-only capability set.

**Current divergence:**

- The viewer simulates VS Code host messages, duplicates startup, patches globals, and repeatedly enforces read-only behavior.
- Unsupported operations are dropped or hidden by convention instead of being absent from host capabilities.
- No dedicated browser-extension test suite currently validates startup and read-only contracts.

**Migration theme:** compose a `BrowserViewerRoot` after document projections and host capabilities exist. Do not fork section implementations.

### `CMP` - Compatibility Provider Composition

**Golden outcome:** KQL, SQL, and Markdown compatibility providers are thin primary-text and UX adapters around one document/session composition.

**Current divergence:**

- Shared sidecar format/store/session mechanics are strong.
- Provider shells still duplicate panel routing, save/reload/close orchestration, and integration with `QueryEditorProvider`.

**Migration theme:** preserve the sidecar core and replace provider orchestration after the document actor and protocol are available.

### `DSH` - Dashboard Compiler Boundary

**Golden outcome:** one portable dashboard specification and compiler IR drives shared bindings in preview and standalone HTML plus PBIR/TMDL/DAX and publishing adapters. An explicitly active source extension preserves trusted preview and raw standalone HTML behavior that is not portable to Power BI.

**Current divergence:**

- Domain semantics and tests are mature, but pure validation/generation and VS Code filesystem/Fabric orchestration still meet in large host modules.
- Some preview/export validation remains duplicated.

**Migration theme:** extract compiler inputs, IR, and renderer contracts without changing provenance v1 or generated output goldens.

### `KLS` - KQL Analyzer Boundary

**Golden outcome:** language analysis is a replaceable adapter behind a typed request/result contract.

**Current divergence:**

- The custom analyzer is large and hand-built, but it is relatively cohesive, has focused diagnostics tests, and does not currently own document state.

**Migration theme:** extract parsing/flow-analysis stages only after higher-risk application boundaries converge.

## Completed Iteration Detail

### Iteration `EXA-1`: Exact Kusto Execution Ownership

**Status:** complete and qualified.

**Why now:** query execution is the product's central workflow, and the current Kusto path has a source-confirmed cross-layer contradiction. The webview creates an exact `executionId` and rejects terminals that do not match it, while the host drops that identity when registering the run and publishing success, error, and cancellation. Cancellation also has two logical owners, and downstream data is mutable latest-result state keyed only by section ID. This affects normal runs, rapid reruns, cancellation, comparisons, Copilot/tool execution, derived sections, persistence, and future provider decomposition.

**Falsifiable hypothesis:** if one host-owned coordinator reserves each Kusto execution synchronously, finalizes its actual dispatch identity after authentication, and remains the sole logical terminal owner, then the current run settles exactly once while stale runs, stale cancellations, retargeted results, and account/policy-revoked results cannot render or clear newer state.

**Cheapest discriminating check:** start through the real Kusto execution controller, capture its outbound `executionId`, invoke the registered provider message path, and deliver the resulting terminal through the real webview dispatcher. Before EXA-1 the host terminal omitted that ID; the cross-layer test now proves one identity through request, dispatch, terminal, rendering, persistence admission, and controller cleanup. Native immediate-rerun and retarget scenarios prove stale work cannot settle the current section.

**Scope:**

1. Define a synchronous `KustoExecutionReservation` containing document/view scope where available, section incarnation, target intent/generation, reservation sequence, and `executionId`.
2. Reserve before `saveLastSelection` or any other `await`. Missing connection/database, selection-write failure, synchronous client failure, cancellation, and replacement each settle through one correlated terminal path.
3. Finalize an immutable `KustoDispatchLease` immediately before each physical query dispatch using the actual connection revision, endpoint/authority/database identity, authenticated account partition/principal, and applicable policy revision. Preflight failures use the reservation and do not invent a dispatch principal.
4. Make one coordinator the sole logical terminal owner. The webview enters `cancelling` and waits for the exact host terminal instead of clearing the active ID and rendering cancellation independently. Physical SDK cancellation remains best-effort.
5. Make replacement and explicit cancellation conditional on the exact reservation. Retarget, account/authority change, Leave No Trace change, section removal, reload, and disposal revoke affected reservations or dispatch leases before publication.
6. Echo exact identity in every section-publishing Kusto success, error, cancellation, and supersession terminal. Cover manual/run-function execution, integrated Copilot final execution, performance comparisons, and agent-tool execution. Model-context-only queries may remain separate only when they never publish generic section terminals.
7. Give agent-tool execution immediate request-to-reservation acknowledgement, propagate invocation cancellation to the exact run, and align host/webview terminal deadlines.
8. Add cross-layer and coordinator tests for reversed preflight ordering, rapid replacement, stale cancellation, retarget, account change, policy revocation, success, error, cancellation, disposal, and exactly-once cleanup.
9. Add protocol and architecture guards that reject uncorrelated Kusto section terminals and box-only cancellation paths.

**Non-goals:**

- Do not redesign the result payload or persisted notebook format yet.
- Do not merge Kusto and SQL transport implementations; reuse SQL ownership concepts only where they form a transport-neutral contract.
- Do not redesign Copilot prompts or conversations; only section-publishing execution enters this owner.
- Do not broadly split `QueryEditorProvider`, `message-handler.ts`, or remove window bridges.
- Do not implement deferred `ACT` work.

**Completion evidence:**

- The real controller-to-provider-to-window-dispatcher test fails before the change and passes after it with one identity throughout.
- Current and stale execution/cancellation/retarget/account/policy cases are deterministic under deliberately reversed ordering.
- Every section-publishing Kusto terminal carries a complete reservation and, when dispatched, its immutable dispatch identity.
- Every admitted reservation receives exactly one logical terminal; cancellation and supersession cannot clear or replace a newer run.
- No result produced under an old target/account/policy renders or persists under the current one.
- Table preview, direct Copilot delivery, and persisted result restoration use the same policy generation/admission boundary; protected transitions clear queued and retained data.
- Comparison retarget clears old rows, persisted JSON, summaries, Optimize, and target-bound conversation state before adopting the new target.
- Copilot, standalone Optimize, and delegated cancellation are exact request owners; delayed cancellation cannot affect a newer same-box request.
- Only absent-to-account establishment is preserved; an automatic A-to-B rotation revokes affected execution and retained state.
- Manual, run-function, Copilot-final, comparison, and agent-tool paths use the same owner when they publish into a section.
- Focused host, coordinator, dispatcher, protocol, Copilot/tool, and query-section tests pass.
- Native run, cancel-and-rerun, and retarget-during-run E2E scenarios pass.
- Full sequential tests, production package, browser build, and bundle gates pass.
- Displaced box-only cancellation and uncorrelated terminal paths are deleted or blocked by architecture tests.

**Final validation (2026-07-28):**

- Mandatory pessimistic review returned `VERDICT: ACCEPTABLE FOR EXA-1 COMPLETION` after all seven blocker classes were fixed.
- Focused EXA gate: 27 files, 1,270/1,270 tests with one worker.
- Full sequential Vitest: 195 files, 5,098/5,098 tests.
- Host/webview TypeScript and integration-test compilation: pass. Production package: pass with 0 lint errors and 6 style warnings. Browser production build: pass. Integrated and standalone bundle gates: pass.
- VS Code integration suite: 113/113 tests on VS Code 1.130.0.
- Authenticated native `kusto-execution-contract`: unchanged rerun passed 3/3 scenarios for normal execution, immediate exact replacement, and database retarget; the preceding first-scenario timeout remains in the flake ledger. The identity JSON and all three passing-run screenshots were reviewed.
- Authenticated native `query-cancel`: 2/2 scenarios for physical long-run cancellation, fast cancellation race, and recovery; all six screenshots were reviewed.

**Iteration feasibility:** realized at 3/5. The migration required every section-publishing producer plus target/account/policy/disposal fencing, but the old Kusto terminal authority and box-only cancellation path are now removed.

## Completed Iteration

### Iteration `EXA-2`: Immutable Result Artifacts And Lineage

**Status:** closed on 2026-07-30. Final pessimistic review returned `VERDICT: CLOSE EXA-2`.

**Why next:** EXA-1 makes the producer execution exact, but admitted rows still collapse into mutable section-keyed state. This leaves the highest-risk remaining break between exact production and downstream consumption.

**Falsifiable hypothesis:** if each admitted success creates an immutable artifact revision carrying producer reservation/dispatch identity, target/principal/policy metadata, and source lineage, then a derived consumer can bind to one revision while a later rerun replaces the section's current pointer without changing what that consumer reads.

**Cheapest discriminating check:** execute a source section, bind one low-risk derived consumer to the resulting revision, rerun the source, and prove the consumer retains its original revision until an explicit rebind while current result rendering still shows the new revision.

**Initial boundary:** introduce immutable runtime and persisted artifact records behind existing result APIs, then migrate one low-risk derived consumer. Preserve current file compatibility and rendering. Do not broaden into deferred `ACT` capability work.

**Initial evidence:** every accepted result now creates an immutable revision; exact Kusto successes add producer/policy metadata; bounded Kusto persistence restores stable descriptor identity only after owner admission; and charts render a bound revision. The discriminating tests prove source revision A remains readable after current advances to B, explicit rebind selects B, and source clear synchronously revokes both current and bound artifacts. Pessimistic review returned `VERDICT: ACCEPTABLE FOR INITIAL EXA-2 SLICE`.

**Initial qualification:** the 12-file focused ring passed 527 tests; full sequential Vitest passed 196 files and 5,116 tests; production extension/browser builds, integration compilation, and bundle gates passed; the extension-host suite passed all 113 tests with five-second Mocha headroom for its existing three-second bounded-close case; and native `default/chart-regressions` passed both scenarios on VS Code 1.130.0, including the A-to-B artifact contract.

**Transformation evidence:** primary and join-right inputs now have independent bindings; outputs retain direct revisions and flattened leaf-source policies; unchanged-source tool edits remain pinned; dependent refresh explicitly rebinds; join-right changes trigger recomputation; removal releases inputs and output; and source revocation follows lineage transitively without clearing a retargeted independent current revision. Pessimistic review returned `VERDICT: ACCEPTABLE FOR TRANSFORMATION ARTIFACT SLICE`.

**Transformation qualification:** the 14-file focused ring passed 570 tests; full sequential Vitest passed 196 files and 5,123 tests; host/webview type checks, production extension/browser builds, integration compilation, lint with zero errors, and both bundle gates passed; the extension-host suite passed all 113 tests with the established five-second Mocha headroom; and native `default/transformation-artifacts` passed on its first run on VS Code 1.130.0.

**Comparison evidence:** source and comparison requests/reservations/terminals now carry one exact `KustoComparisonRunIdentity`; manual Compare and standalone Optimize no longer race on a timer; direct Run with a previously cached source delegates to the same source-first pair; Copilot retries reuse the admitted source execution; output publication requires the bound source artifact plus matching physical target and all five policy stamps; summaries follow output lineage; and every failure/removal/retarget path releases temporary pins. Pessimistic review returned `VERDICT: ACCEPTABLE FOR EXACT COMPARISON ARTIFACT SLICE`.

**Comparison qualification:** the 16-file focused EXA ring passed 707 tests; full sequential Vitest passed 196 files and 5,135 tests; host/webview type checks, production extension/browser builds, integration compilation, lint with zero errors, and both bundle gates passed; the extension-host suite passed all 113 tests with established Mocha headroom; and native `default/comparison-artifacts` passed both runs on VS Code 1.130.0.

**Dashboard bridge evidence:** provenance fact sources now bind immutable artifact revisions; same-source HTML edits remain pinned and dependent refresh explicitly rebinds; missing/mixed exposure decisions deny iframe data; source change, revoke, removal, and reorder reconnect cannot retain stale bridge rows; Kusto/SQL admission and derived leaf policies make exposure explicit; and persisted metadata cannot self-authorize without matching the locally recomputed decision.

**Dashboard bridge qualification:** the 18-file focused EXA/dashboard ring passed 844 tests; full sequential Vitest passed 196 files and 5,144 tests; host/webview type checks, production extension/browser builds, integration compilation, lint with zero errors, and both bundle gates passed; the extension-host suite passed all 113 tests with established Mocha headroom; and native `default/html-artifact-bridge` passed on its first run on VS Code 1.130.0.

**Model-result evidence:** configure-and-execute previews and delegated Kusto Copilot responses now bind `model:<requestId>:result` to the artifact for the exact producer execution and require `sendToModel === true` independently of active-content exposure. Mutable current and terminal-row fallbacks are gone. Delegated starts carry the host-captured query, row caps remain stable, and every success, denial, exception, cancellation ordering, timeout, failed start, owner invalidation, and cleanup path releases request state exactly once. Policyless leaves remain explicit; positive persisted capabilities require local admission; and restored Kusto comparisons must match locally reconstructed source lineage and leaf policies. Legacy exposure-only descriptors do not gain model permission, and cyclic comparison restores are discarded. Final pessimistic review found no blocking issue.

**Model-result qualification:** the 21-file focused EXA/model ring passed 1,140 tests; full sequential Vitest passed 196 files and 5,163 tests; host/webview type checks, production extension/browser builds, integration compilation, ESLint with zero errors, and all existing bundle gates passed without threshold changes; the extension-host suite passed all 113 tests with established Mocha headroom; and native `default/model-result-artifacts` passed on its first run on VS Code 1.130.0.

**Clipboard-share evidence:** Share Results now binds `share:clipboard:result` and requires the independent `shareToClipboard === true` decision. Query, connection, database, and rows come from one exact artifact; an open modal stays on A through rerun, close releases A, and reopen selects B. Denial, revocation, owner/document teardown, and forged or mismatched restored provenance fail closed without blocking title/query-only sharing. Kusto and owner-admitted SQL manual/tool/Copilot/comparison producers carry exact query/target metadata. SQL external reruns preserve only already-bound A, comparison replacement retires stale persisted/current/rendered rows, Copilot comparison starts are admitted before transport, and direct/cold/reordered SQL restores revalidate live owner/query/database. SQL formatting omits the ADX link. Final pessimistic review found no blocking issue.

**Clipboard-share qualification:** the 12-file focused EXA/share ring passed 610 tests; full sequential Vitest passed 197 files and 5,182 tests; host/webview type checks, production extension/browser builds, integration compilation, ESLint with zero errors, and all final bundle gates passed; the intentional webview baseline increased by 10 KB only; the extension-host suite passed all 113 tests on VS Code 1.130.0 and 1.131.0; and native `default/share-result-artifacts` passed both runs on VS Code 1.130.0.

**CSV-export evidence:** Kusto, SQL, restored, comparison, and transformation results carry the independent `exportToCsv` decision; derived outputs promote it only when every leaf permits export. Each governed table registers one exact artifact plus a table-generation token, hides Save when admission fails, and serializes its current sorted/filtered projection using only declared columns. Replacement, transitive revocation, removal, every applied document transition (including malformed replacement), and stale same-ID cleanup synchronously release only the owned generation and hide Save. Picker cancellation or transfer timeout cancels only that export attempt, leaving a still-valid table retryable. Webview projections are one-per-table and capped globally. The host opens the native picker before requesting bytes, issues a one-use nonce, validates nonce/box/artifact, retains cardinality- and TTL-bounded intent tombstones against replay, and writes only the correlated response. Concurrent, delayed, replayed, mismatched, remote-URI, and disposal paths fail closed. URL-imported CSV and Connection Manager previews remain separate direct-data workflows. Read-only browser viewers restore persisted Kusto/SQL rows and SQL-derived comparisons into fresh runtime artifacts carrying only `exportToCsv`; they never trust persisted model, clipboard, or active-content claims. Inline and standalone browser hosts emulate the same challenge, cancel timed-out projections, restrict forwarding to the owned iframe, and were exercised with real persisted payloads and exact downloaded bytes.

**CSV-export qualification:** the 14-file focused EXA/CSV ring passed 586 tests; full sequential Vitest passed 199 files and 5,224 tests. Repeated first-attempt proper-lockfile/SQL credential lock failures were unrelated; each affected file passed unchanged and every complete rerun passed. Host/webview type checks, production extension/browser builds, integration compilation, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Final production sizes are 1,762.9 KB for `extension.js` and 2,660.1 KB for `webview.bundle.js`; synchronized baselines moved only from 1,711 to 1,713 KB and 2,605 to 2,611 KB. The extension-host suite passed all 113 tests on VS Code 1.131.0. Native `default/csv-result-artifacts` proved denied Save is absent, allowed Save is present, and the Windows picker wrote exactly 26 bytes (`Name,Score\nalpha,1\nbravo,2`); both screenshots and the JSON byte artifact were reviewed. Built browser inline Kusto, standalone Kusto, SQL, and SQL-derived comparison fixtures in both section orders restored without live connections and downloaded exact CSV bytes.

**Closure evidence:** governed Kusto, SQL, transformation, and Diff tables bind exact artifacts and synchronously purge rows, table/search models, viewers, dialogs, chart controls, and copy authority on revocation. Declared-column projection occurs before presentation, search, model/share/HTML egress, artifact publication, and persistence. Kusto and SQL comparisons retain exact source execution lineage through runtime cancellation and source-first/comparison-first restore. Restored producer claims are grounded in live ownership. URL CSV sections publish immutable artifacts for chart/transformation consumers while request IDs, requested URLs, component-incarnation uniqueness, debounce cancellation, and box-authoritative cleanup prevent stale-response or replacement races. Ungoverned URL and Connection Manager tables retain their direct local workflows.

**Closure qualification:** the final 26-file acceptance ring passed 1,046 tests and final review returned `VERDICT: CLOSE EXA-2`. Full sequential Vitest passed 200 files and 5,264 tests on rerun; the first run had one unrelated SQL credential-lock timing failure, and that file passed unchanged at 52/52 before the complete rerun. Host/webview type checks, production extension build, browser-extension build, integration compilation, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Final production sizes are 1,763.0 KB for `extension.js` and 2,673.8 KB for `webview.bundle.js`; intentional EXA-2 runtime growth moved only the synchronized webview baseline from 2,611 to 2,624 KB with the existing 50 KB buffer unchanged. The extension-host suite passed 113/113 with the documented five-second Mocha headroom; two default two-second attempts reached 112/113 because the existing bounded-close test itself waits up to three seconds. The previously reviewed native `default/csv-result-artifacts` exact-byte evidence remains applicable because the host nonce/challenge/write contract did not change in the closure audit; no new native capture was required.

**Post-closure schema/autocomplete reliability qualification:** EXA-2 remains closed. Same-target metadata requests are brokered without coalescing owner-gated dispatch, SDK clients stay leased through concurrent operations, empty or malformed schema cannot poison cache state, JSON-to-tabular fallback stays within one authenticated attempt, disposal/currentness fences every physical schema command, compact cache entries are upgraded to worker-ready `.show schema` JSON, and queued primary worker intent no longer invalidates an executing primary transaction. The focused nine-file recovery ring passed 414 tests; full sequential Vitest passed 200 files and 5,297 tests. Host/webview type checks, production extension and browser builds, integration compilation, ESLint with zero errors and the same five pre-existing warnings, and both bundle gates passed. Deterministic production sizes are 1,774.1 KB for `extension.js` and 2,681.0 KB for `webview.bundle.js`; synchronized baselines moved from 1,713 to 1,725 KB and from 2,624 to 2,632 KB with the 50 KB buffer unchanged. The extension-host suite passed 113/113 with the established five-second Mocha headroom. Native VS Code 1.131.0 qualification passed `default/kusto-schema-replacement` and authenticated `kusto-auth/kusto-restored-startup`; the latter restored five same-target sections, kept four unfocused sections deferred, and rendered the exact section-three worker table in 917 ms with word suggestions and the auxiliary provider disabled. A preceding `--no-build` launch that opened no webview remains runner-state evidence rather than a product result.

**Subsequent boundary:** DOC-4 is closed. PRO-1 is selected below; deferred ACT, a fifth section migration, and Kusto/SQL coordinator convergence remain excluded.

## Completed Codec Iterations

### Iteration `COD-1`: Lossless Codec Preservation

**Status:** closed on 2026-08-01; final pessimistic review returned `VERDICT: CLOSE COD-1`.

**Boundary:** introduce one lossless overlay codec path that preserves unknown root fields, unknown state fields, extension fields on known sections, opaque unknown sections, and section order while editing one known field. Keep current document actors and UI restore paths in place.

**Cheapest discriminating check:** open a golden fixture containing future root/state fields, a future field on a known section, and an unknown section; edit one supported known field; save; prove every unknown value and the original order survive byte-semantic round-trip.

**Exclusions:** no document actor migration, no capability-policy expansion, no `ACT` work, and no execution-coordinator convergence.

**Completion evidence:** `kqlxOverlay.ts` now provides one recursive overlay codec with compile-time exhaustive host-known section schemas. Root/state extensions, known-section extensions, nested future fields, opaque sections, and order survive known edits. Known omissions remain deletions; stable nested identities cannot inherit metadata from replacements, while explicitly renameable transformation items retain extensions only when correlation is unambiguous. Required/typed known leaves, arrays, records, and nested identities fail read-only when malformed; hostile JSON keys remain data properties. Exact JSON-semantic persistence comparison prevents omitted empty/default fields from being falsely acknowledged. KQLX/SQLX/MDX privacy publication, KQL/SQL sidecar write/repair/recovery, id-less projections, legacy `copilotQuery`, devnotes, chart restoration, and linked-query ownership use the same preservation contract. Linked targets are single, plain-query, non-self, source-generation-fenced, and published through one exact content lease. Session, linked-query, and sidecar writes retain the physical identity accepted at load or locked creation/adoption, with independent durable/buffer rollback and exact Save/Close ownership.

**Qualification:** the expanded focused Vitest ring passed 484 tests, and the final complete sequential suite passed 202 files and 5,404 tests. Host/webview type checks, integration compilation, production extension build, browser-extension build, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. The complete extension-host suite passed 166/166 with the established five-second Mocha headroom. Native VS Code 1.131.0 `default/codec-lossless-roundtrip` passed on its first run after editing one known query field; its reviewed semantic artifact preserved future root/state fields, a known-section extension, the opaque payload, and exact section order, and its reviewed screenshot showed the expected clean editor state. Deterministic production sizes are 1,818.4 KB for `extension.js` and 2,683.9 KB for `webview.bundle.js`; synchronized baselines moved from 1,744 to 1,769 KB and from 2,632 to 2,634 KB while the 50 KB buffer remained unchanged.

### Iteration `COD-2`: One Document-Kind Capability Matrix

**Status:** closed on 2026-08-02; the definitive pessimistic review returned `VERDICT: CLOSE COD-2`.

**Boundary:** replace distributed `.kqlx` / `.sqlx` / `.mdx` section-kind filters and creation rules with one shared capability matrix used by parsing/validation, host projection, webview add controls, tools, and browser/read-only composition. Invalid known kinds must be reported rather than silently filtered; opaque future sections remain preserved by COD-1.

**Cheapest discriminating check:** enumerate every known section kind against each document kind and prove parser validation, host `allowedSectionKinds`, webview add controls, and tool admission return the same decision, including an incompatible known section that currently disappears from MDX projection.

**Exclusions:** no document actor, section-definition registry, protocol redesign, deferred `ACT`, or execution-coordinator convergence.

**Completion evidence:** `documentSectionCapabilities.ts` owns the typed matrix, canonical aliases, persisted/addable distinction, hidden `devnotes`, defaults, compatibility classification, and actionable validation. `parseKqlxText()` validates the actual URI-bound kind before projection. Provider-local arrays, SQL compatibility's advertised Kusto query, MDX sanitation/filtering, the overlay's MDX passthrough sets, compatibility primary-kind alias lists, and ad hoc `copilotQuery` decision branches are gone from capability surfaces. Host projections and KQL/SQL/Markdown upgrades derive from the destination kind. Compatibility sidecars validate the destination row before parse, hydration, repair, build, adoption, or write; malformed SQL linkage, multiple linked owners, and other invalid KQL/SQL companions project read-only and cannot reach an overwrite prompt. The webview intersects host declarations with the matrix before controls, insert zones, default creation, restore, and tool dispatch. `createSectionWithCapabilities()` owns every non-restore creation: tools, Kusto Copilot auto-create, Copilot Insert, and Kusto/SQL comparison preparation cannot bypass admission or silently lose compatibility-file sections. Empty capability projections stay empty, and default creation consults the persisted section array so visual, hidden, and opaque-only documents remain unchanged. SQL optimization comparisons persist as `sql` with `comparisonSourceBoxId`; comparison removal clears webview/host owner state and source backlinks before recreation; tool-created SQLX files use the matrix default. Every browser provider recognizes MDX, the production manifest makes raw-file routing reachable, and the viewer delegates structural and capability validation to the host parser, including hostile IDs, duplicate IDs, known shapes, linked owners, and invalid companions. Browser companion hydration additionally requires first-section ownership of the exact raw URL. Legacy preload APIs queue canonical query adds rather than maintaining a second alias kind. The ownership guard prevents removed lists, raw automation factories, alias branches, empty-set fallback, and the browser parser copy from returning.

**Final closure hardening:** SQL comparison preparation now uses an application-acknowledged `staged -> committed -> finalized -> completed` CAS transaction over the complete live descriptor, query/result revisions, persisted rows/artifact, and active execution identity. The host retains the prior owner until completed acknowledgement, retries acknowledged rollback before completion, releases terminal proofs explicitly, revalidates both exact targets afterward, and rejects nested sources before mutation. Admission fences Monaco and execution; restore reconstructs exact SQL lineage. Browser standalone handoff is UUID-tokened, one-shot, and TTL-bounded. Plain-file sidecars retain fixed primary identities and validate a complete candidate before source mutation. The webview starts runtime-inactive, activates only after successful materialization, and turns malformed retained DOM into an inert visual snapshot while retiring executable owners, rows, tools, and pending work.

**Qualification:** the final blocker ring passed 10 files and 584 tests; complete sequential Vitest passed 211 files and 5,543 tests. Host/webview and browser TypeScript checks, integration compilation, production extension and browser builds, ESLint with zero errors and the same five pre-existing warnings, and both bundle gates passed. The complete extension-host suite passed 174/174 with `--timeout 5000` on VS Code 1.131.0. The definitive native `default/document-capabilities` run `20260802-103341` passed 4/4: three reviewed MDX screenshots proved actionable byte-preserving rejection, exact allowed controls, and no opaque-only default; exact DOM/file assertions proved real host SQL comparison create/save/reopen, nested rejection, remove/recreate with a fresh ID, and final reopen with one valid SQL comparison and lineage. The definitive pessimistic review returned `VERDICT: CLOSE COD-2`. Final production sizes are 1,835.2 KB for `extension.js` and 2,704.9 KB for `webview.bundle.js`; synchronized baselines are 1,786 KB and 2,655 KB with the 50 KB buffer unchanged.

## Completed Document Iterations

### Iteration `DOC-1`: Host-Owned Markdown Section Lifecycle

**Status:** closed on 2026-08-03. The definitive pessimistic review returned `VERDICT: CLOSE DOC-1`.

**Why this slice:** COD was closed, so DOC's prerequisite was satisfied. Markdown was the lowest-risk section capable of proving host-owned ordered state, revisioned commands, view recreation, and lossless Save through the real custom-editor boundary.

**Boundary:** introduce the smallest transport-neutral document aggregate and section-definition contract needed to own one low-risk Markdown section's add, patch, remove, validation, and snapshot transitions behind the existing lossless codec and VS Code adapter. Keep the current protocol and view as adapters. Do not migrate Kusto/SQL lifecycle, execution, compatibility orchestration, or other section kinds in this slice.

**Falsifiable hypothesis:** if a serial host document owner and one Markdown section definition are authoritative, then a Markdown add/edit/remove survives view teardown and recreation and produces the same lossless snapshot without reading component or DOM serialization state.

**Cheapest discriminating check:** load a fixture containing Markdown plus opaque future data, execute add/patch/remove commands against the host owner, destroy and recreate the view projection, then save and prove the exact command result and opaque data persist while a deliberately stale or throwing DOM `serialize()` implementation is never consulted.

**Exclusions:** no protocol redesign, no ACT policy work, no Kusto/SQL execution convergence, no broad provider split, and no registry migration for a second section kind until the Markdown path deletes its displaced persistence authority.

**Completion evidence:** `markdownSectionDefinition.ts` owns Markdown persisted validation and patch semantics. `MarkdownDocumentAggregate` owns ordered application state, document and section revisions, and add/patch/remove transitions. Native Markdown components emit commands and render complete projections; native snapshot creation reads the host projection and never calls component `serialize()`, while plain `.md` compatibility remains primary-text-owned. Every command has a terminal result. Projection candidates activate only after a live, latest-generation, source-current application acknowledgement; rejected, expired, or drifted acknowledgements preserve the prior owner. Each normalized URI has one queue before ownership exists and across transient panels, commands, adapters, rollback, Save, close, and reopen. Save barriers become commit-scoped leases, rejected barriers abort, overlapping Saves serialize, internal canonical Saves cannot release user leases, and disposal settles accepted work. Live panel ownership is separate from retained aggregate state; canonical handoff preserves revision history through ABA-shaped text restoration, and close cleanup rechecks reopen state atomically before deleting the exact owner/queue. Final persistence overlays host Markdown onto adapter state through the lossless codec, preserving future root/state data, known-section extensions, opaque sections, and relative order.

**Qualification:** the focused Vitest ring passed 7 files and 444 tests; the expanded provider authority/multi-panel/Save/reopen matrix passed 12/12, and the sidecar suite passed 117/117 with `--timeout 5000`. Complete sequential Vitest passed 213 files and 5,565 tests. The complete VS Code 1.131.0 extension-host suite passed 187/187 with `--timeout 5000`. Native run `20260803-054923` passed `default/host-owned-markdown-lifecycle`; the reviewed screenshot showed `Host owned`, `after`, Preview mode, no error UI, and a clean editor. Reviewed JSON artifacts proved zero DOM serialization calls, stale-command rejection, exact `markdown_doc1|future_doc1` order, future root/state preservation, the Markdown extension, opaque payload, and `dirty:false` after Save and recreation. Host/webview and browser TypeScript checks, integration compilation, production extension and browser builds, ESLint with zero errors and the same five pre-existing warnings, and both bundle gates passed. Final production sizes are 1,854.4 KB for `extension.js` and 2,712.5 KB for `webview.bundle.js`; synchronized baselines are 1,805 KB and 2,663 KB with the 50 KB buffer unchanged.

### Iteration `DOC-2`: Host-Owned URL Section State

**Status:** closed on 2026-08-03. The definitive pessimistic review returned `VERDICT: CLOSE DOC-2`.

**Why next:** DOC remains the highest eligible theme at 50. The Markdown slice proves the aggregate, revision, queue, acknowledgement, Save, panel-handoff, and lossless overlay contracts. URL is the next small persisted-state shape that can expand the section-definition registry without entering Kusto/SQL execution or dependency-heavy chart/transformation ownership.

**Boundary:** add one URL section definition and route URL add/patch/remove plus persisted presentation state through the existing host document aggregate and command protocol. Keep fetch, sanitization, iframe rendering, and deferred origin/trust admission in their current adapters. Do not migrate a third section kind.

**Falsifiable hypothesis:** if URL persisted state joins the proven host aggregate, then URL add/edit/remove and view recreation can use host revisions and lossless snapshots while a stale or throwing URL component serializer cannot affect native Save.

**Cheapest discriminating check:** load URL plus Markdown and opaque future data, execute URL add/patch/remove against the host owner, recreate the view, then Save and prove exact URL state, Markdown state, order, and future data survive while URL `serialize()` is never consulted.

**Exclusions:** no URL fetch/network redesign, no deferred `ACT` work, no HTML/Markdown resource policy, no Kusto/SQL lifecycle migration, no protocol rewrite, and no migration of another section kind.

**Completion evidence:** `urlSectionDefinition.ts` owns URL persisted validation and patch semantics. URL joins Markdown inside the existing `MarkdownDocumentAggregate`, optimistic webview projection ledger, command protocol, save barrier, and per-URI physical queue. Commands reserve the queue before source reads, and successful terminals must match the complete predicted owned projection, including every Markdown/URL section revision and exact mixed order. Rejected terminals reconcile both kinds and use one stable whole-container ordering pass. Native snapshots substitute acknowledged URL state and never call `kw-url-section.serialize()`.

The component retains fetch/render ownership. Authored URL and resolved redirect identity are distinct; only authored URL plus persisted presentation state enters the aggregate. Same-document projections retain unchanged URL elements and their debounce, CSV artifact/table/observer, and iframe identity. Synchronous DOM moves are not disposal; genuine removal defers teardown until disconnection is confirmed, and detached or replaced same-ID instances cannot emit stale persistence callbacks. Fetch request identity, content, loading/error state, DOMPurify, iframe rendering, CSV artifacts, and autosizing otherwise remain unchanged.

**Qualification:** the definitive focused ring passed 11 files and 513 tests. Complete sequential Vitest passed 215 files and 5,592 tests. The provider lifecycle matrix passed 13/13, including two session URL commands whose source reads were deliberately reversed at admission. The complete VS Code 1.131.0 extension-host suite passed 188/188 with `--timeout 5000`. Both TypeScript projects, integration compilation, production extension/browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Native run `20260803-104840` passed the extended `default/host-owned-markdown-lifecycle` scenario. Its reviewed screenshot showed restored `Host owned` Markdown and collapsed `Host owned URL` sections with no error UI; reviewed JSON artifacts proved zero Markdown/URL serializer calls, stale-command rejection, exact `markdown_doc1|url_doc1|future_doc1` order, future root/state/Markdown/URL/opaque preservation, and `dirty:false`. A preceding native run failed only because its test artifact returned an `undefined` optional field; the strict-JSON assertion was corrected without product changes. Final production sizes are 1,857.1 KB for `extension.js` and 2,724.2 KB for `webview.bundle.js`; synchronized baselines are 1,808 KB and 2,675 KB with the 50 KB buffer unchanged.

### Iteration `DOC-3`: Host-Owned Python Section State

**Status:** closed on 2026-08-03. The definitive post-qualification review returned `VERDICT: CLOSE DOC-3`.

**Why next:** DOC remains the highest eligible theme at 50. Python is the next bounded persisted-state shape after Markdown and URL. It can expand the proven aggregate and definition contract without entering Kusto/SQL target lifecycle or chart/transformation dependency scheduling.

**Boundary:** add one Python section definition and route Python add/patch/remove plus persisted `name`, `code`, `output`, `expanded`, and `editorHeightPx` through the existing host aggregate and command queue. Keep Monaco instances, execution request/process ownership, stdout/stderr acquisition, and local-code policy in their current adapters. Do not migrate a fourth section kind.

**Falsifiable hypothesis:** if Python persisted state joins the same host aggregate, then source/output/presentation edits, stale rejection, view recreation, and lossless Save remain correct while a stale or throwing Python component serializer cannot affect native persistence.

**Cheapest discriminating check:** load Python plus host-owned Markdown/URL and opaque future data, execute Python add/patch/remove against the host owner, reject a stale command, recreate the view, poison Python `serialize()`, then Save and prove exact Python/Markdown/URL state, order, and future data survive.

**Exclusions:** no Python execution/process redesign, no local-code trust or deferred `ACT` work, no Monaco lifecycle rewrite, no protocol rewrite, no Kusto/SQL migration, and no chart/transformation/HTML or fourth section kind.

**Completion evidence:** `pythonSectionDefinition.ts` owns Python persisted validation and patch semantics. Python joins Markdown and URL inside the existing aggregate, optimistic full-projection ledger, command protocol, Save barrier, and per-URI physical queue. Native snapshots substitute acknowledged Python state and never call `kw-python-section.serialize()`. Add, code/output/name/presentation patch, remove, tool mutation, stale rejection, rejected-result reconciliation, Save, panel handoff, close, and recreation all use the same owner.

The component retains Monaco and execution adapters. Same-document projection and reorder preserve the existing Monaco instance; genuine removal disposes it; detached or replaced instances cannot persist. A webview-local admission registry fences the legacy box-ID-only execution protocol to one outstanding exact component/code owner, retires publication on projection/removal/invalidation, consumes inactive terminals without output, and blocks rerun until retired work settles. The host's 15-second deadline publishes one terminal independently of process close, so a non-settling child cannot strand the admission tombstone. Only an admitted terminal patches persisted `output`; transient `Running...` never enters the aggregate. Metadata-free browser/legacy behavior and local-code policy remain unchanged.

**Qualification:** the final focused ring passed 12 files and 539 tests. Complete sequential Vitest passed 216 files and 5,615 tests. The provider lifecycle matrix passed 14/14, including Python-only Save before projection acknowledgement. The complete VS Code 1.131.0 extension-host suite passed 189/189 with `--timeout 5000`. Host/webview and browser TypeScript checks, integration compilation, production extension/browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Native run `20260803-124847` passed the extended `default/host-owned-markdown-lifecycle` scenario; the reviewed screenshot showed restored Markdown plus collapsed URL and Python sections without error UI. Three reviewed JSON artifacts proved zero Markdown/URL/Python serializer calls, stale-command rejection, exact `markdown_doc1|url_doc1|python_doc1|future_doc1` order, all five Python fields, future root/state/known-section/opaque preservation, and `dirty:false`. The definitive post-qualification review returned `VERDICT: CLOSE DOC-3`. Final production sizes are 1,859.0 KB for `extension.js` and 2,731.4 KB for `webview.bundle.js`; synchronized baselines are 1,810 KB and 2,682 KB with the 50 KB buffer unchanged.

### Iteration `DOC-4`: Host-Owned Chart Configuration State

**Status:** closed on 2026-08-03. The definitive post-fix closure review returned `VERDICT: CLOSE DOC-4`.

**Why next:** DOC remains the highest eligible theme at 50. Chart is the next configuration-bearing section that can broaden the definition contract while retaining mature immutable artifact bindings and ECharts rendering in their current adapters.

**Boundary:** add one chart section definition and route chart add/patch/remove plus the existing persisted chart configuration through the aggregate and shared URI queue. Keep ECharts instances, immutable artifact bindings, source refresh, rendering, and dependency scheduling in current adapters. Do not migrate a fifth section kind.

**Falsifiable hypothesis:** if chart configuration joins the host aggregate, chart source/configuration/presentation edits, stale rejection, view recreation, and lossless Save remain correct while chart rendering and bound artifact identity survive host projection application and a stale or throwing chart serializer cannot affect native persistence.

**Cheapest discriminating check:** load Chart plus host-owned Markdown/URL/Python and opaque future data, execute chart add/patch/remove, reject a stale command, recreate the view, poison chart `serialize()`, then Save and prove exact chart configuration, owned-section order, future data, and retained runtime binding behavior.

**Exclusions:** no artifact-store or ECharts redesign, no transformation scheduling migration, no HTML/Kusto/SQL lifecycle, no protocol redesign, no deferred `ACT`, and no fifth section kind.

**Completion evidence:** `chartSectionDefinition.ts` owns the complete persisted Chart configuration, including nested axis, legend, heatmap, color-record, title, validation, and null-delete patch semantics. Chart joins the existing aggregate, optimistic full-projection ledger, command envelope, URI queue, acknowledgement, Save lease, handoff, and lossless overlay path. Native snapshots substitute acknowledged Chart state and never call `kw-chart-section.serialize()`; metadata-free browser/legacy hosts keep the serializer.

The component and renderer remain adapters. Equal projections retain the exact element, global renderer state, ECharts instance, zoom state, and immutable artifact binding without rendering or command emission. Genuine source changes synchronously transition the binding even while collapsed; normal dependent refresh still owns explicit revision rebind. Automatic first-render layout does not persist defaults. Genuine removal disposes ECharts and releases its binding. Detached or replaced same-ID elements, delayed first updates, and delayed projection callbacks cannot command, render into, or remove the current owner. Transformation rename propagation uses component type rather than ID prefix and commits arbitrary-ID Charts through the same command client. Add/configure/remove/collapse tools wait for exact command settlement.

**Qualification:** the expanded focused ring passed 17 files and 744 tests. Complete sequential Vitest passed 216 files and 5,626 tests. The provider lifecycle matrix passed 15/15, including Chart-only Save before projection acknowledgement and a command arriving after a barrier response but before lease reservation. The complete VS Code 1.131.0 extension-host suite passed 190/190 with `--timeout 5000`. Host/webview and browser TypeScript checks, integration compilation, production extension and browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Native run `20260803-194348` passed both `default/host-owned-markdown-lifecycle` scenarios with a clean extension-host log. Reviewed screenshots showed clean restored Markdown/URL/Python and all four collapsed owned sections including arbitrary-ID `Host owned Chart`. Eleven reviewed JSON artifacts proved four successful exact Chart terminals with no reload, an explicitly accepted Save barrier, zero serializer calls, zero equal-projection commands, retained runtime identity, stale rejection, exact five-section order, complete nested configuration, future root/state/known-section/nested-setting/opaque preservation, and `dirty:false` immediately after Save and after reopen. Full-projection comparison follows JSON transport semantics, so omitted and `undefined` object fields cannot cause a false reload. Final production sizes are 1,863.5 KB for `extension.js` and 2,744.2 KB for `webview.bundle.js`; intentional growth moved synchronized baselines from 1,810 to 1,814 KB and from 2,682 to 2,695 KB with the 50 KB buffer unchanged. An initial closure review blocked on a rejected Save barrier in superseded run `20260803-185050`; the barrier catch-up and JSON-semantic projection fixes are covered by provider/client regressions and the clean replacement run. The definitive post-fix review found no remaining blocker and returned `VERDICT: CLOSE DOC-4`.

### Iteration `DOC-5`: Host-Owned Transformation Configuration State

**Status:** closed on 2026-08-04. The definitive blocker-only review returned `VERDICT: CLOSE DOC-5`.

**Boundary:** `transformationSectionDefinition.ts` owns persisted Transformation validation, deep cloning, nested arrays, and null-delete patches. Transformation joins the existing aggregate, optimistic full-projection ledger, runtime-validated document-view channel, URI queue, Save lease, handoff, and lossless overlay path. Native snapshots substitute acknowledged Transformation state and never call `kw-transformation-section.serialize()`; metadata-free browser/legacy behavior retains it.

**Adapter boundary:** primary/join-right immutable artifact bindings, expression evaluation, derived publication and lineage, dependency scheduling, refresh cascades, table/CSV rendering, warnings, and automatic layout remain in `kw-transformation-section` and artifact adapters. Equal projections retain the exact element, pins, lineage, and output. Configuration-only edits recompute from existing pins; source/type edits synchronously rebind only affected roles and publish while collapsed; dependent refresh explicitly advances pins. Renderer-only height cannot enter a host patch, explicit fit/resize persists, and detached/replaced instances cannot command, publish, unbind, or remove a current owner.

**Displaced authority and guards:** native Transformation DOM serialization is no longer persistence authority. Add/patch/remove/collapse/configure tools wait for the shared command terminal. Arbitrary-ID downstream rename propagation uses component type. A real provider regression proves stale rejection, view recreation, poisoned serialization, exact mixed order, and nested future metadata. Pure owner/client/protocol tests cover nested validation, optimistic equality, and ambiguity rejection; adapter tests cover equal/config/source projection behavior, collapsed primary/right retargets, renderer-height isolation, explicit refresh, lineage, and stale same-ID fencing.

**Qualification:** the final focused ring passed 19 files and 729 tests. Complete sequential Vitest and the official sequential coverage gate passed 217 files and 5,657 tests; statement coverage is 48.11% against the unchanged 27.67% threshold. Provider lifecycle passed 20/20, compatibility sidecars passed 124/124, and the complete VS Code 1.131.0 extension-host suite passed 200/200 with `--timeout 5000`. Final hardening covers pending-authority rejection before adapter lease acquisition, real-webview retry acknowledgements, URI-queue privacy durability, canonical restoration, overlapping Saves, and inode-aware rejection of dirty open physical aliases before linked durable publication. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Final native run `20260804-144628` passed all four `host-owned-markdown-lifecycle` scenarios. Four reviewed foreground `1280x1000` screenshots were clean, and all 25 strict JSON artifacts were reviewed. DOC-5 evidence proves one exact successful Transformation terminal, stale rejection, accepted stamped Save, zero serializer/equal-projection commands, A pins/lineage retained through configuration while source currents advanced to B, explicit refresh rebinding both roles to B, exact recreation at 460px, clean Save, exact mixed order, nested future metadata, and opaque preservation. Inherited DOC-3/DOC-4/PRO-1 artifacts remained clean. Logs contained only existing Git/CSP/Mermaid noise, with no DOC-5 product error. Final sizes are 1,886.5 KB for `extension.js` and 2,773.4 KB for `webview.bundle.js`; synchronized baselines are 1,837 KB and 2,724 KB with the 50 KB buffer unchanged. The definitive blocker-only reviewer found no closure blocker and returned `VERDICT: CLOSE DOC-5`.

## Completed Protocol Iteration

### Iteration `PRO-1`: Runtime-Validated Document View Session

**Status:** closed on 2026-08-03. The definitive blocker-only review returned `VERDICT: CLOSE PRO-1`.

**Boundary:** `documentViewProtocol.ts` owns one versioned, runtime-validated channel for only native `documentData`, `documentReloadResult`, host-owned section commands/results, and Save barrier traffic. `KqlxEditorProvider` creates one UUID per concrete panel incarnation and stamps every in-scope host envelope. Host and webview ingress parse before side effects and reject malformed, retired, or cross-session traffic. The webview adopts the session from its first valid projection, permanently tombstones that initial request, and keeps later duplicate detection bounded. Existing source generations, command IDs, revisions, URI queues, file formats, and Save leases remain unchanged inner authorities. Compatibility and browser/legacy messages remain metadata-free.

**Displaced authority:** native document lifecycle messages no longer cross provider/webview boundaries as unchecked `unknown`/`any` objects or duplicated local message shapes. A disposed panel cannot acknowledge a successor projection, reserve a successor command, settle a successor terminal, or release a successor Save barrier merely by carrying otherwise current generations, request IDs, or revisions.

**Guards:** the required provider regression establishes a session, replaces it, and injects predecessor acknowledgement, command, and barrier traffic using successor-valid correlation fields; none affects the successor, while current-session traffic completes exactly once and the accepted Save lease remains held until `didSave`. Webview tests reject malformed and duplicate initial projections before adoption and reject prior-session results/barriers before client admission. Pure protocol tests inventory and validate all six discriminators and nested projections, the real outbound wrapper tests stamping/drop behavior, and the static message inventory follows the shared protocol source.

**Qualification:** the finalized focused ring passed 7 files and 375 tests. Complete sequential Vitest and sequential coverage passed 217 files and 5,635 tests; statement coverage is 47.78% against the unchanged 27.67% threshold. Provider lifecycle passed 16/16, compatibility sidecars passed 117/117, and the complete VS Code 1.131.0 extension-host suite passed 191/191 with `--timeout 5000`. Host/webview/browser typechecks, production extension and browser builds, ESLint with zero errors and five pre-existing warnings, and both synchronized bundle gates passed. Native run `20260803-213448` passed all three `host-owned-markdown-lifecycle` scenarios. Three reviewed `1280x1000` screenshots were clean and correctly foreground-captured; reviewed JSON proved distinct session UUIDs, one initial request per session, exactly one stamped command/result per session, no terminal or mutation from the predecessor command, accepted stamped Save barriers, and `dirty:false` persisted state. Inherited DOC-3/DOC-4 artifacts and logs remained clean; logs contained only existing VS Code Git/CSP warnings and the unrelated Mermaid proposed-API error. Final production sizes are 1,872.6 KB for `extension.js` and 2,752.8 KB for `webview.bundle.js`; intentional PRO-1 growth moved synchronized baselines from 1,814 to 1,823 KB and from 2,695 to 2,703 KB with the 50 KB buffer unchanged.

## Completed Document Iteration

### Iteration `DOC-6`: Host-Owned HTML Configuration State

**Status:** closed on 2026-08-05. Post-fix blocker reviews returned `VERDICT: NO DOC-6 BLOCKER`; the closure decision is `VERDICT: CLOSE DOC-6`.

**Selection rationale:** DOC was the highest eligible gap at 48. HTML was the next bounded persisted-configuration section after Transformation. Its durable shape was already explicit in `kqlxFormat.ts` and the lossless overlay, while Monaco, preview iframe, provenance/data bridge, immutable artifact binding, slicers, validation, export, and publishing could remain adapter-owned. Kusto and SQL combined primary text, target, language, execution, privacy, and result ownership and were materially riskier candidates.

**Boundary:** add one HTML section definition and route existing persisted `name`, `code`, `mode`, `expanded`, editor/preview heights, `previewHeightUserSet`, `dataSourceIds`, `pbiPublishInfo`, and `powerBiUpgradeNotice` through the existing aggregate, optimistic client, document-view channel, and URI queue. Keep Monaco instances, preview iframe/scripts, provenance parsing, data bridge, immutable artifact binding, slicers, renderer state, validation, Power BI export, and Fabric publishing in existing adapters. Do not migrate Kusto, SQL, dashboard compiler ownership, or another section kind.

**Falsifiable hypothesis:** if HTML persisted configuration joins the host document owner while preview/data/export behavior remains adapter-owned, then code/mode/height/publish-metadata edits, stale rejection, view recreation, and lossless Save use host revisions while an equal projection retains the exact Monaco/iframe/artifact binding and a stale or throwing HTML serializer cannot affect native persistence.

**Cheapest discriminating check:** load native Markdown/URL/Python/Chart/Transformation plus one HTML section bound to an immutable fact artifact, nested future publish/notice metadata, and an opaque section. Apply one HTML configuration edit and reject one stale edit through the host command path, recreate the view, poison `kw-html-section.serialize()`, then Save and prove exact configuration/order/future data while an equal projection retains the same Monaco, preview iframe, and fact binding without rerender or command emission.

**Exclusions:** no active-content/origin/trust policy work, dashboard compiler or provenance redesign, artifact-store redesign, iframe/network policy, Power BI/Fabric workflow migration, Kusto/SQL ownership, protocol expansion beyond the existing document-view channel, deferred `ACT`, or seventh section kind.

**Boundary:** `htmlSectionDefinition.ts` owns persisted HTML validation, cloning, nested publish/notice metadata, and null-delete patches. HTML joins the existing aggregate, optimistic full-projection ledger, runtime-validated document-view channel, physical URI queue, Save lease, handoff, and lossless overlay. Native Save substitutes acknowledged HTML and never calls `kw-html-section.serialize()`; metadata-free browser/legacy behavior retains serialization.

**Adapter boundary:** Monaco, sandboxed iframe/scripts, provenance parsing, data bridge, immutable fact binding, slicers, validation, Power BI export, and Fabric publishing remain adapter-owned. Equal projection retains the exact element/editor/iframe/binding without rerender or commands. Same-ID/detached instances, delayed measurement, stale responses, and no-op DOM ordering cannot mutate or reload the current runtime.

**Publish transaction hardening:** dashboard requests carry exact identities and cancellation. Fabric mutation uses one account and final Leave No Trace admission, UUID staging, exact paginated recovery, and partial-create compensation. Returned IDs enter the document through one-field correlated HTML commands. Apply/compensate binds exact section, complete metadata, document/section revisions, and authoritative previous value. Concurrent ordinary HTML patches carry a provisional new tuple; failures reconcile from host projection. Queue-stable cleanup retains referenced or uncertain items and deletes only an absent exact tuple.

**Qualification:** final focused ring passed 20 files and 661 tests. Complete sequential Vitest and coverage passed 220 files and 5,703 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. Provider lifecycle passed 21/21, compatibility sidecars passed 124/124, and the complete VS Code 1.131.0 extension-host suite passed 201/201 with `--timeout 5000`. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, and both synchronized bundle gates passed. Final sizes are 1,905.5 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; baselines are 1,856 KB and 2,752 KB with the 50 KB buffer unchanged. Definitive native run `20260805-043534` passed all five `host-owned-markdown-lifecycle` scenarios after one harness file-not-found rerun. Five reviewed foreground `1280x1000` screenshots and eight DOC-6 JSON artifacts proved exact successful/stale terminals, accepted Save, zero serializer/equal-projection commands, exact editor/iframe/binding retention, clean recreation, exact mixed order, nested future publish/notice metadata, and opaque preservation. Logs contained only existing Git/CSP/Mermaid noise. No live authenticated Fabric tenant run was performed.

## Completed Host Iterations

### Iteration `HST-1`: Dashboard Workflow Application Handler

**Status:** closed on 2026-08-05. The definitive blocker-only review returned `VERDICT: NO HST-1 BLOCKER`.

**Boundary:** `HostDashboardApplicationHandler` is the injected owner for all ten dashboard request/cancel/ack routes, request abort controllers, user prompts, HTML/PBIP export, Fabric workspace/item lookup, first-external-commit Leave No Trace admission, publish application/compensation leases, stale retirement, and cleanup finalization. `QueryEditorProvider` constructs or accepts the handler, offers typed inbound messages, preserves synchronous admission for unrelated Kusto/SQL traffic, and disposes it. `KqlxEditorProvider` supplies only the explicit publish apply/settle/cleanup hooks backed by the existing URI queue.

**Displaced authority:** `QueryEditorProvider` no longer owns dashboard workflow maps, publish-ack maps, cleanup admission, dashboard discriminator cases, Power BI/Fabric adapter imports, or publish state transitions. `powerBiExport.ts`, `powerBiPublish.ts`, the document aggregate/URI queue, `kw-html-section`, `kw-publish-pbi-dialog`, provenance v1, generated PBIR/TMDL/DAX, message shapes, and product behavior are unchanged.

**Guards:** the requested real-provider test was written red first, then proves exact forwarding of every dashboard message to a compile-time-complete fake handler. A source guard prevents workflow maps, native publish hooks, and Power BI/Fabric adapter calls from returning to the provider. Direct handler tests cover synchronous decline, prompts, correlated workspace/existence responses, successful publish response/ack, exact cancellation, stale retirement, first-commit policy, apply/compensate interleavings, same-ID replacement, exact old-metadata restoration, and queue-stable cleanup. Protocol extraction inventories handler-emitted messages.

**Qualification:** the final focused ring passed 10 files and 466 tests. Complete sequential Vitest and the official coverage gate passed 221 files and 5,708 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.131.0 extension-host suite passed 201/201 with `--timeout 5000`, and the provider lifecycle passed 21/21. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, and both bundle gates passed. Final sizes are 1,905.8 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`, within unchanged limits. No live authenticated Fabric tenant run was performed.

### Iteration `HST-2`: Artifact CSV Save Application Handler

**Status:** closed on 2026-08-05. The definitive blocker-only review returned `VERDICT: NO HST-2 BLOCKER`.

**Boundary:** `HostArtifactCsvSaveApplicationHandler` is the injected owner for `requestArtifactCsvSave`, `artifactCsvSaveData`, and `cancelArtifactCsvSaveIntent`. It owns native picker admission, eight active intents, one-use UUID nonce challenges, intent and transfer cancellation, 60-second deadlines, bounded 10-minute replay tombstones, exact box/artifact correlation, URI-preserving `.csv` publication, saved-file notifications, and disposal. `QueryEditorProvider` only constructs or accepts the handler, offers typed messages synchronously, supplies panel transport, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer owns artifact CSV intent/save/completed maps, timeout/tombstone constants, discriminator cases, picker transitions, nonce issuance/admission, or governed CSV file writes. `artifact-csv-export.ts`, immutable result-artifact bindings, table-generation tokens, `kw-data-table`, browser shim/download behavior, message shapes, imported CSV, and Connection Manager preview export remain unchanged.

**Guards:** the requested real-provider injection/forwarding test was written red first and failed with zero handler calls, then passed for all three exact typed messages. A static displaced-authority guard prevents maps, methods, and discriminator cases from returning to the provider. Direct handler tests cover synchronous decline, exact UTF-8 bytes, active/completed bounds, concurrent reverse delivery, mismatched and replayed nonces, picker cancellation, cancellation during picker and transfer, deadlines, disposal, and remote URI authority. Protocol extraction includes the handler and explicitly requires both outbound CSV messages.

**Qualification:** the final focused ring passed 11 files and 310 tests. Complete sequential Vitest and the official coverage gate passed 223 files and 5,713 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.131.0 extension-host suite passed 201/201 with `--timeout 5000`. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, `git diff --check`, and both bundle gates passed. Final production sizes are 1,906.3 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; the synchronized extension baseline moved from 1,856 to 1,857 KB with the 50 KB buffer unchanged. Native run `20260805-164304` exercised denied/allowed Save admission, the real Windows picker, exact intent/export/nonce/box/artifact correlation, zero cancellation, host write completion, and the exact 26-byte file `Name,Score\nalpha,1\nbravo,2`. The permanent scenario's fresh screenshots were blocked before picker execution by the framework's foreground-HWND validation; previously reviewed clean screenshots remain the visual baseline.

### Iteration `HST-3`: Python Execution Application Handler

**Status:** closed on 2026-08-05. The definitive blocker-only review returned `VERDICT: NO HST-3 BLOCKER`.

**Boundary:** `HostPythonExecutionApplicationHandler` is the injected owner for `executePython`, interpreter fallback (`python`, `python3`, `py`), child-process/stdin/stdout/stderr lifecycle, independent 200 KB UTF-8 output caps, the 15-second timeout/kill terminal, `pythonResult` / `pythonError` publication, and disposal. Timeout/disposal establish terminal authority before process termination; expected teardown stream errors remain non-terminal, unexpected stream errors settle once and kill best-effort, and late child/stdio events are consumed. `QueryEditorProvider` only constructs or accepts the handler, offers typed messages synchronously, supplies panel transport, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer imports `spawn`, creates Python processes, owns the `executePython` discriminator branch, accumulates stdout/stderr, schedules Python deadlines, or constructs Python terminals. `kw-python-section`, `python-execution-admission.ts`, host-owned Python persisted state, local-code policy, Monaco/runtime rendering, message shapes, and the document-view protocol remain unchanged.

**Guards:** the requested real-provider injection test was written red first and failed with zero fake-handler calls, then passed with exact unchanged forwarding. A static displaced-authority guard prevents Python process/terminal code from returning to the provider. Direct handler tests cover synchronous decline, success, synchronous and event-based fallback, all interpreters missing, non-ENOENT failure, expected and unexpected stdio errors, synchronous/late close/error races, timeout, 200 KB UTF-8 boundaries, and disposal. Protocol extraction inventories both handler terminals.

**Qualification:** the final focused ring passed 10 files and 502 tests. Complete sequential Vitest and the official coverage gate passed 224 files and 5,728 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000`. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, `git diff --check`, and both bundle gates passed. Final production sizes are 1,908.2 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; the synchronized extension baseline moved from 1,857 to 1,859 KB with the 50 KB buffer unchanged. Final isolated native run `20260805-194937` passed first attempt against the reviewed build: the real Run button executed built-in Python, rendered exact `HST3:24`, saved, closed/reopened, and restored raw Windows stdout `HST3:24\r\n` with normalized output `HST3:24` and `dirty:false`. Its foreground-valid `1280x1000` screenshot and two JSON artifacts were reviewed clean; logs contained only existing Git, missing-CSP, and Mermaid proposed-API noise.

### Iteration `HST-4`: Imported CSV Save Application Handler

**Status:** closed on 2026-08-05. The definitive blocker-only review returned `VERDICT: NO HST-4 BLOCKER`.

**Boundary:** `HostImportedCsvSaveApplicationHandler` is the injected owner for `saveImportedCsv`, empty-data UX, native picker admission, workspace/home default selection, URI-preserving `.csv` extension handling, exact UTF-8 publication, Open File / Show in Folder actions, notification failure containment, write-failure messaging, and disposal. `QueryEditorProvider` only constructs or accepts the handler, offers typed inbound messages synchronously, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer imports imported-CSV file helpers, owns `saveImportedCsvFromWebview`, handles the discriminator case, opens the picker, writes bytes, or publishes save notifications. URL fetch identity/content acquisition, `kw-url-section`, browser download behavior, governed artifact CSV saving, Connection Manager preview export, message shapes, and network/trust policy remain unchanged.

**Guards:** the requested real-provider injection test was written red first and failed with zero fake-handler calls, then passed unchanged. A static displaced-authority guard prevents the provider method, discriminator case, and file helpers from returning. Direct handler coverage proves synchronous decline, empty-data UX, picker cancellation, exact local/remote URI publication, UTF-8 bytes, extension handling, Open File / Show in Folder actions, notification/action failure containment, write-failure messaging, and disposal while the picker is open. The provider lifecycle test proves panel disposal retires the handler.

**Qualification:** the focused eight-file HST ring passed 128 tests and the provider lifecycle suite passed 101 tests. Complete sequential Vitest and the official coverage gate passed 225 files and 5,736 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000`; a preceding npm-wrapper attempt passed the timeout as a positional argument and hit the known two-second close-bound test at 200/201. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, and both bundle gates passed. Final production sizes are 1,908.5 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; synchronized baselines and the 50 KB buffer are unchanged. Native run `20260805-211100` passed 1/1 against the reviewed build with the real imported-table Save button and Windows picker, an exact 36-byte UTF-8 artifact, and a foreground-valid `1280x1000` screenshot showing the saved notification plus Open File / Show in Folder. Two earlier harness attempts produced correct product output but failed on literal Unicode-escape matching and the documented controller notification-capture limitation; the final scenario uses exact bytes plus visual evidence. Logs contain only existing Git/CSP/Mermaid/Node noise.

### Iteration `HST-5`: Query Sharing Application Handler

**Status:** closed on 2026-08-05. The definitive blocker-only review returned `VERDICT: NO HST-5 BLOCKER`.

**Boundary:** `HostQuerySharingApplicationHandler` is the injected owner for `copyAdeLink` and `shareToClipboard`, including input validation, Kusto gzip/base64 ADX-link generation, SQL shares without an ADX-link promise, exact HTML/plain-text formatting and escaping, host clipboard writes, `shareContentReady`, notifications, and disposal. `QueryEditorProvider` only constructs or accepts the handler, synchronously offers typed messages, supplies connection lookup and panel transport, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer imports zlib or ADX-link export helpers, owns either sharing discriminator case/method, formats clipboard content, writes the host clipboard, publishes `shareContentReady`, or emits sharing notifications. The webview share modal, singleton `share:clipboard:result` binding and policy admission, browser clipboard write, row caps, Kusto/SQL execution and connection ownership, message shapes, and protocol remain unchanged.

**Guards:** the requested real-provider forwarding test was written red first and failed with zero fake-handler calls, then passed unchanged for both exact typed messages. A static guard prevents the methods, cases, zlib/link helper, and response publication from returning to the provider. Direct handler tests cover synchronous decline, missing/malformed inputs, exact gzip/base64 decoding, SQL no-link output, HTML/plain escaping, row summaries, empty selection/content, clipboard failure, notifications, and disposal/late completion. Protocol extraction inventories both handler responses.

**Qualification:** the expanded focused ring passed 12 files and 454 tests. Complete sequential Vitest and the official coverage gate passed 227 files and 5,749 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000` on unchanged rerun; the first run had one unrelated sidecar repair timeout plus a cascading setup failure, and both cases passed alone before the clean rerun. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, and both bundle gates passed. Final sizes are 1,909.1 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; only the synchronized extension baseline moved 1,859 -> 1,860 KB and the 50 KB buffer is unchanged. Definitive native run `20260805-231107` passed 2/2 `share-result-artifacts` scenarios: exact rich clipboard JSON retained B and excluded denied/revoked rows, the real host clipboard contained the expected ADX prefix, and a reviewed foreground-valid `1280x1000` screenshot showed the exact success toast. A preceding identity-checklist attempt stopped before clipboard on unrelated Connection Manager behavior; a later controller notification assertion missed the visibly present toast after exact clipboard success.

### Iteration `HST-6`: URL Content Acquisition Application Handler

**Status:** closed on 2026-08-05. The definitive blocker-only review returned `VERDICT: NO HST-6 BLOCKER`.

**Why next:** HST remains the highest eligible gap. `fetchUrl` is one cohesive provider-owned acquisition workflow: URL validation, redirect-following fetch, timeout/abort, byte limits, content classification, UTF-8/image shaping, and exact `urlContent` / `urlError` publication. The URL component already owns request identity, stale-response rejection, rendering, CSV artifact publication, debounce, and teardown.

**Boundary:** extract only `fetchUrl` orchestration into one injected application handler. Preserve the existing 15-second timeout, 100 MB text/CSV and 5 MB image caps, 200,000-character truncation, redirect URL, content sniffing/classification, exact response identity, and message shapes. Keep `kw-url-section`, request admission/stale rejection, rendering, URL artifacts, imported CSV saving, browser behavior, `resolveResourceUri`, control-command syntax lookup, and network/trust policy unchanged.

**Falsifiable hypothesis:** if one URL-content handler owns fetch validation, deadlines, byte acquisition/classification, and response publication, `QueryEditorProvider` can synchronously offer `fetchUrl` without retaining URL-content decisions while the current request-correlated webview behavior remains unchanged.

**Cheapest discriminating check:** construct the real provider with a fake URL-content handler and prove exact forwarding of `fetchUrl`; then drive the handler through invalid/non-HTTP URLs, redirects, HTTP failures, CSV/HTML/text/image classification, body sniffing, truncation, byte caps, timeout/abort, fetch failure, unrelated-message decline, and disposal/late completion.

**Exclusions:** no URL-section or artifact redesign, no imported CSV changes, no browser-host changes, no `resolveResourceUri` or control-command migration, no network/origin/trust policy or deferred ACT work, and no generic handler framework.

**Boundary:** `HostUrlContentApplicationHandler` is the injected owner for `fetchUrl`, including HTTP/HTTPS validation, redirect-following fetch, the 15-second timeout and abort lifecycle, 100 MB text/CSV and 5 MB image caps, 200,000-character truncation, CSV/HTML/text/image classification and HTML body sniffing, exact original/resolved URL identity, `urlContent` / `urlError` publication, and disposal. `QueryEditorProvider` only constructs or accepts the handler, synchronously offers typed messages, supplies panel transport, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer owns the `fetchUrl` discriminator case or method, creates URL fetch abort controllers, applies byte/truncation limits, classifies content, or constructs URL terminals. `kw-url-section` request identity, stale rejection, rendering, immutable CSV artifacts, debounce, autosizing, teardown, imported CSV saving, browser behavior, `resolveResourceUri`, control-command syntax lookup, message shapes, and network/origin/trust policy remain unchanged.

**Guards:** the requested real-provider forwarding test was written red first and failed with zero fake-handler calls, then passed unchanged after injection. A static guard prevents URL fetch, abort, cap, classification, and terminal authority from returning to the provider. Direct tests cover synchronous decline, invalid/non-HTTP input, exact original/resolved identity, redirects, HTTP and transport failures, CSV/HTML/text/image classification, HTML body sniffing, image data URIs, truncation, both caps, timeout/abort, disposal with signal-ignoring fetch, disposal abort rejection, and late-publication suppression. Protocol extraction attributes both URL terminals to the handler.

**Qualification:** the definitive seven-file URL ring passed 223 tests. Complete sequential Vitest passed 229 files and 5,767 tests before the review-added disposal regression; the official sequential coverage gate passed the final 229 files and 5,768 tests at 48.18% statements against the unchanged 27.67% threshold. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000`. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, and both bundle gates passed. Final production sizes are 1,910.3 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; only the synchronized extension baseline moved 1,860 -> 1,861 KB and the 50 KB buffer is unchanged. Native E2E was not required for this host-only extraction because the webview runtime and message shapes did not change. The blocker-only reviewer returned `VERDICT: NO HST-6 BLOCKER`; both non-blocking follow-ups were addressed.

### Iteration `HST-7`: Control-Command Syntax Lookup Application Handler

**Status:** closed on 2026-08-06. The definitive blocker-only review returned `VERDICT: NO HST-7 BLOCKER`.

**Boundary:** `HostControlCommandSyntaxApplicationHandler` is the injected owner for `fetchControlCommandSyntax`, including the exact 24-hour cache boundary, Microsoft Learn URL normalization/fetch, Syntax-section and first-`pre` fallback extraction, HTML entity decoding, case-insensitive `with(...)` argument de-duplication, existing failure-cache behavior, exact request/command identity, `controlCommandSyntaxResult` publication, and disposal/late-settlement suppression. `QueryEditorProvider` only constructs or accepts the handler, synchronously offers typed messages, supplies panel transport, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer owns `controlCommandSyntaxCache`, `CONTROL_COMMAND_SYNTAX_CACHE_TTL_MS`, the `fetchControlCommandSyntax` discriminator case, parsing helpers, Learn fetch, failure shaping, or syntax-result construction. Caret-docs request de-duplication, presentation caching/rendering, Kusto control-command grammar/detection/execution, generated command data, browser behavior, `resolveResourceUri`, URL content acquisition, message shapes, and network/origin/trust policy remain unchanged.

**Guards:** the requested real-provider forwarding test was written red first, failed with zero fake-handler calls while the old provider attempted a Learn fetch, and passed unchanged after injection. A static source guard prevents every displaced cache/parser/fetch/result authority from returning. Direct tests cover synchronous decline, invalid request shaping, relative and absolute Learn URL normalization, existing `view` replacement, Syntax-section preference, first-`pre` fallback, entity decoding, `with(...)` parsing/de-duplication, exact cache hit/expiry and failure-cache behavior, fetch failure, disposal, and late fetch/text resolve/reject suppression. Protocol extraction attributes `controlCommandSyntaxResult` to the handler, and provider lifecycle coverage requires disposal.

**Qualification:** the definitive five-file HST-7 ring passed 321 tests, and the expanded 17-file host-application ring passed 424 tests. Complete sequential Vitest and the official coverage gate passed 231 files and 5,782 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000`. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, `git diff --check`, and the bundle gate passed. Final production sizes are 1,910.9 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`, within the existing 1,911/2,802 KB limits and unchanged 50 KB buffer. Native E2E was not required because this was a host-only ownership extraction and the caret-docs runtime/message shapes remained unchanged.

### Iteration `HST-8`: Local Resource URI Resolution Application Handler

**Status:** closed on 2026-08-06. The definitive blocker-only review returned `VERDICT: NO HST-8 BLOCKER`.

**Boundary:** `HostResourceUriApplicationHandler` is the injected owner for `resolveResourceUri`, including exact request shaping, HTTP/HTTPS/data/blob/webview passthrough, local-file-only base validation, Markdown backslash normalization, workspace-root and relative/absolute path construction, file stat, exact `${baseUri.toString()}::${rawPath}` caching, live-panel webview URI conversion, exact failure strings, `resolveResourceUriResult` publication, and disposal/late-settlement suppression. `QueryEditorProvider` only constructs or accepts the handler, synchronously offers typed messages, supplies panel transport plus the live conversion capability, and disposes it.

**Displaced authority:** `QueryEditorProvider` no longer owns `resolvedResourceUriCache`, the `resolveResourceUri` discriminator case or method, the `path` import, path/base/stat/cache decisions, failure strings, or result construction. Markdown request de-duplication, timeout and rendering, browser behavior, URL acquisition, navigation, linked queries, message shapes, and network/origin/trust/file policy remain unchanged.

**Guards:** the requested real-provider forwarding test was written red first, failed with zero fake-handler calls, and passed unchanged after injection. A static source guard prevents every displaced cache/path/stat/result authority from returning. Direct tests cover synchronous decline, missing identity, exact empty/base/path/conversion failures, every passthrough scheme, workspace-root and relative paths, Windows drive/UNC and POSIX behavior, stat-before-panel ordering, exact raw-path cache identity and cache hits, response-transport containment, disposal/cache clearing, and late stat/conversion resolve/reject suppression. Protocol extraction attributes `resolveResourceUriResult` to the handler, and provider lifecycle coverage requires disposal.

**Qualification:** the expanded six-file HST-8/Markdown ring passed 378 tests. Complete sequential Vitest and the official coverage gate passed 233 files and 5,816 tests; statement coverage is 48.18% against the unchanged 27.67% threshold. The complete VS Code 1.132.0 extension-host suite passed 201/201 with `--timeout 5000`. Host/webview/browser typechecks, integration compilation, production extension and strict browser builds, ESLint with zero errors and five pre-existing warnings, diagnostics, and both bundle gates passed. Final production sizes are 1,911.9 KB for `extension.js` and 2,801.9 KB for `webview.bundle.js`; only the synchronized extension baseline moved 1,861 -> 1,862 KB and the 50 KB buffer is unchanged. Native E2E was not required because this was a host-only ownership extraction and Markdown/browser runtime plus message shapes remained unchanged.

## Next Iteration

### Iteration `HST-9`: Copilot Content Open Application Handler

**Status:** selected, not started.

**Why next:** HST remains the highest eligible gap. `openToolResultInEditor` and `openMarkdownPreview` form one bounded, stateless provider-owned host-presentation workflow: exact untitled plaintext creation, beside-column preview, local Markdown URI construction, preview-command dispatch, and existing failure notifications. Their webview emitter already owns Copilot presentation intent.

**Boundary:** extract only `openToolResultInEditor` and `openMarkdownPreview` into one injected application handler. Preserve exact input handling, untitled `plaintext` content, `preview: true`, `ViewColumn.Beside`, `vscode.Uri.file(filePath)`, `markdown.showPreview`, and user-facing failure strings. Keep Copilot generation/conversations/tools, browser behavior, generic navigation, document origin/trust/file policy, message shapes, and all Kusto/SQL execution/lifecycle behavior unchanged.

**Falsifiable hypothesis:** if one content-open handler owns these two native presentation effects, `QueryEditorProvider` can synchronously offer both exact messages without retaining document-open or preview decisions while current Copilot presentation behavior remains unchanged.

**Cheapest discriminating check:** construct the real provider with one final fake content-open handler, send the exact `openToolResultInEditor` and `openMarkdownPreview` objects, and prove both original objects are forwarded while mocked VS Code open APIs remain untouched. Before injection the fake receives zero calls and the old provider APIs execute.

**Exclusions:** no HST-1 through HST-8 changes, no Copilot generation/tool redesign, no browser changes, no generic navigation/open-file migration, no origin/trust/file policy or deferred ACT work, no Kusto/SQL execution/lifecycle work, no protocol-shape changes, and no generic handler framework.

## Convergence Loop

Run this loop after every completed architecture slice.

### 1. Reconfirm Product Invariants

- Read the golden outcome and the product behavior touched by the candidate.
- Update the golden outcome only if an implemented product capability or a fundamental platform constraint changed.
- Never weaken the target merely because migration is difficult.

### 2. Refresh Current Evidence

- Read the exact owning code paths and neighboring tests.
- Record concrete competing authorities, untyped boundaries, races, privacy exposure, or change amplification.
- Prefer executable behavior and state ownership over line counts.
- Add newly discovered gaps to the register; retire facts that are no longer true.

### 3. Score And Respect Dependencies

- Score every credible gap using `H/A/R/L/F/E`.
- Select the highest score that has a coherent incremental slice.
- A lower-scoring prerequisite may go first only when the higher gap cannot be safely reached without it; record that dependency explicitly.
- Correctness, security, and privacy discoveries can preempt the queue only when product direction or release policy marks them release-blocking.

### 4. State One Hypothesis And One Discriminating Test

Before editing, write:

- The canonical owner that should decide the behavior.
- The current path that bypasses or duplicates it.
- One falsifiable hypothesis.
- The cheapest test that can disprove it.
- The smallest reversible vertical migration.

If this cannot be stated, the candidate is not ready to implement.

### 5. Characterize The Existing Boundary

- Add or identify a failing cross-layer test for the current divergence.
- Include stale, cancellation, replacement, disposal, and policy-revocation ordering where relevant.
- Do not start with broad module movement.

### 6. Introduce One Owner Behind Existing Contracts

- Preserve public behavior, file formats, and host compatibility.
- Route one complete user journey through the new owner.
- Keep old adapters as anti-corruption layers only while unmigrated callers remain.
- Never dual-write sensitive or canonical state.

### 7. Delete Displaced Authority

- Remove the old mutable map, switch branch, synthetic message, DOM-derived state, or duplicate lifecycle path for the migrated journey.
- Add a static architecture guard or contract test preventing its return.
- A migration is not complete while both old and new paths can decide the same transition.

### 8. Validate In Expanding Rings

1. Failing characterization test.
2. Focused owner/state-machine tests.
3. Neighboring cross-layer tests.
4. Typecheck and lint.
5. Native or authenticated E2E for the touched behavior.
6. Full sequential tests.
7. Production package, browser build when affected, and bundle gates.

Use sequential execution in constrained environments.

### 9. Review Against The Golden Outcome

Ask a pessimistic reviewer only for correctness, privacy, ownership, and regression blockers. Verify:

- Exactly one canonical owner remains.
- All terminals and asynchronous publications are correlated.
- Privacy and identity are revalidated at admission boundaries.
- External behavior and compatibility are preserved.
- The new abstraction removes real complexity rather than renaming it.

### 10. Update This Ledger

- Move the iteration to the completed log with its evidence.
- Update current-alignment facts and gap scores.
- Record deleted authorities and new guards.
- Rescore all gaps; do not automatically continue the same theme.
- Select the next iteration and state its discriminating test.

## Iteration Definition Of Done

An architecture iteration is complete only when:

- One named canonical owner decides the migrated transitions.
- The old owner cannot still publish or mutate that state.
- The slice is exercised through the real boundary, not only isolated mocks.
- Stale, cancellation, failure, disposal, and privacy paths have explicit outcomes.
- Public file/protocol compatibility remains intentional and tested.
- Focused and broad validation pass.
- Architecture and contributor guidance reflect the new boundary.
- This ledger is rescored and points to exactly one next iteration.

## Convergence Measures

These measures track authority migration, not developer activity:

| Measure | Golden value |
| --- | ---: |
| Manual execution terminal types lacking exact operation identity | 0 |
| Canonical result stores keyed only by section ID | 0 |
| Derived artifacts without source revision and policy lineage | 0 |
| Known section kinds outside the section-definition registry | 0 |
| Durable document fields reconstructed only from DOM state | 0 |
| Host/webview message types without runtime schema | 0 |
| Internal mutable `window` authorities outside the approved adapter allowlist | 0 |
| Temporary transport listeners implementing request ownership | 0 |
| Tool workflows that require a live webview to mutate document state | 0 |
| Browser behaviors implemented by patching full-host globals | 0 |
| Application use cases owned directly by `QueryEditorProvider` | 0 |

Counts should be added only when an automated check can measure them reliably.

## Completed Foundations

These are not full golden-outcome iterations retroactively, but they materially reduce future migration risk.

| Foundation | Outcome |
| --- | --- |
| SQL lifecycle hardening | Explicit target/session ownership, execution broker, STS replay, and Leave No Trace admission |
| Kusto schema lifecycle hardening | Exact section/target/request/model identity and coordinator-owned schema state |
| Shared Kusto worker serialization | One mutation port with physical settlement and inline recovery |
| Kusto/SQL schema separation | Independent language catalogs and invalidation boundaries |
| Compatibility sidecar core | Shared format, lock/CAS store, and session lifecycle abstractions |
| Opaque section-ID hardening | Persistence, removal, and reorder no longer infer ownership from prefixes |

## Completed Iterations

| Iteration | Canonical owner introduced | Authority deleted | Guard added | Validation | Date |
| --- | --- | --- | --- | --- | --- |
| `EXA-1` | `KustoExecutionCoordinator` | Uncorrelated Kusto terminals, box-only cancellation, raw/provisional Kusto Copilot/Optimize output, process-local/fail-open Kusto privacy revision | Exact-envelope cross-layer/protocol/ownership/policy/restore guards | Focused, full sequential, package, integration, and authenticated native gates complete | 2026-07-28 |
| `EXA-2` | `ResultArtifactStore` and exact consumer bindings | Mutable latest-result lineage authority across derived, model, dashboard, share, and CSV consumers | Pin/rebind/revoke, declared-column, producer/policy, and native artifact gates | Focused, full sequential, package, integration, browser, and native gates complete | 2026-07-30 |
| `COD-1` | `kqlxOverlay.ts` lossless codec | Reconstructive serialization and non-exact projection/publication baselines | Exhaustive schema, exact comparison, sidecar matrix, and native codec round-trip guards | Focused, full sequential, package, integration, browser, and native gates complete | 2026-08-01 |
| `COD-2` | `documentSectionCapabilities.ts` + `createSectionWithCapabilities()` | Provider/webview/tool/browser lists, raw automation factories, MDX filtering, compatibility alias lists, and browser parser copy | Every-cell matrix, creation/parser/teardown ownership guards, exact-byte sidecar/manifest gates, acknowledged SQL comparison CAS, inactive-runtime guards, and native MDX/SQLX capability gate | Blocker ring 584, full Vitest 5,543, extension-host 174, native 4/4, production/browser, and definitive review complete | 2026-08-02 |
| `DOC-1` | `MarkdownDocumentAggregate` + `markdownSectionDefinition.ts` | Native Markdown DOM serialization authority and per-panel revision state | Full-projection commands, one URI queue, Save leases, handoff/reopen, lossless Save, and native lifecycle gate | Focused 444, full Vitest 5,565, extension-host 187, native, production/browser, and definitive review complete | 2026-08-03 |
| `DOC-2` | Existing aggregate/client/URI queue + `urlSectionDefinition.ts` | Native URL DOM serialization authority and adapter-owned URL persisted state | Full optimistic projection, pre-read queue reservation, stable mixed order, runtime move/disposal/redirect guards, lossless Save, and native lifecycle gate | Focused 513, full Vitest 5,592, extension-host 188, native, production/browser, and definitive review complete | 2026-08-03 |
| `DOC-3` | Existing aggregate/client/URI queue + `pythonSectionDefinition.ts` | Native Python DOM serialization authority and adapter-owned persisted Python state | Full optimistic projection, exact stale/output admission, inactive settlement, bounded timeout terminal, Monaco retention, lossless Save, and native lifecycle gate | Focused 539, full Vitest 5,615, extension-host 189, native, production/browser, and definitive review complete | 2026-08-03 |
| `DOC-4` | Existing aggregate/client/URI queue + `chartSectionDefinition.ts` | Native Chart DOM serialization authority and adapter-owned persisted Chart configuration | Full optimistic projection, retained ECharts/artifact identity, exact source rebind, detached-instance fencing, lossless Save, arbitrary-ID propagation, and native lifecycle gate | Focused 744, full Vitest 5,626, extension-host 190, native 2/2, production/browser, bundle gates, and definitive post-fix review complete | 2026-08-03 |
| `PRO-1` | `documentViewProtocol.ts` + host-created panel session UUID | Unchecked/duplicated native document lifecycle envelopes and sessionless panel admission | Runtime schema inventory, exactly-once initial projection, stale-session acknowledgement/command/result/barrier fences, provider race test, and native recreation gate | Focused 375, full/coverage Vitest 5,635, extension-host 191, native 3/3, production/browser, bundle gates, and definitive blocker review complete | 2026-08-03 |
| `DOC-5` | Existing aggregate/client/URI queue + `transformationSectionDefinition.ts` | Native Transformation DOM serialization authority and adapter-owned persisted Transformation configuration | Full optimistic projection, retained input pins/lineage, exact source rebind, runtime-height isolation, stale instance fencing, lossless Save, privacy/physical-alias guards, and native lifecycle gate | Focused 729, full/coverage Vitest 5,657, extension-host 200, native 4/4, production/browser, bundle gates, and definitive blocker review complete | 2026-08-04 |
| `DOC-6` | Existing aggregate/client/URI queue + `htmlSectionDefinition.ts` | Native HTML DOM serialization authority and adapter-owned persisted HTML configuration | Full optimistic projection, exact Monaco/iframe/artifact retention, stale-instance/workflow fencing, one-field publish metadata CAS/rollback, queue-stable external cleanup, lossless Save, and native lifecycle gate | Focused 661, full/coverage Vitest 5,703, extension-host 201, native 5/5, production/browser, bundle gates, post-fix blocker reviews, and documented closure decision complete | 2026-08-05 |
| `HST-1` | `HostDashboardApplicationHandler` | Provider-owned dashboard workflow/ack maps, Fabric/export imports, discriminator branches, native publish lease methods, and cleanup transitions | Real-provider injection/forwarding, static displaced-authority, synchronous-decline, direct workflow/race, protocol-sender, and native same-ID cleanup guards | Focused 466, full/coverage Vitest 5,708, extension-host 201, provider lifecycle 21, production/browser, bundle gates, and definitive blocker review complete | 2026-08-05 |
| `HST-2` | `HostArtifactCsvSaveApplicationHandler` | Provider-owned artifact CSV maps, picker/nonce/cancel/deadline/tombstone transitions, discriminator cases, and governed file publication | Real-provider injection/forwarding, static displaced-authority, direct concurrency/replay/cancel/deadline/disposal tests, protocol-sender inventory, browser compatibility, and native exact-byte gate | Focused 310, full/coverage Vitest 5,713, extension-host 201, native exact 26 bytes, production/browser, bundle gates, and definitive blocker review complete | 2026-08-05 |
| `HST-3` | `HostPythonExecutionApplicationHandler` | Provider-owned Python process creation, discriminator branch, stdio accumulation, timeout transitions, and terminal publication | Real-provider injection/forwarding, static displaced-authority, direct fallback/stdio/timeout/cap/disposal tests, protocol-sender inventory, and isolated native execution/persistence gate | Focused 502, full/coverage Vitest 5,728, extension-host 201, native exact output, production/browser, bundle gates, and definitive blocker review complete | 2026-08-05 |
| `HST-4` | `HostImportedCsvSaveApplicationHandler` | Provider-owned imported CSV method, discriminator case, picker/write helpers, notification transitions, and late-picker authority | Real-provider injection/forwarding, static displaced-authority, direct UX/URI/bytes/failure/disposal tests, provider lifecycle disposal, and isolated native exact-byte/picker gate | Focused 128 plus provider lifecycle 101, full/coverage Vitest 5,736, extension-host 201, native exact 36 bytes, production/browser, bundle gates, and definitive blocker review complete | 2026-08-05 |
| `HST-5` | `HostQuerySharingApplicationHandler` | Provider-owned sharing cases/methods, zlib/ADX-link generation, Kusto/SQL formatting, host clipboard effects, response publication, and notifications | Red-first real-provider forwarding, static displaced-authority, direct validation/encoding/formatting/failure/disposal tests, protocol-sender inventory, and native rich/ADX clipboard gate | Focused 454, full/coverage Vitest 5,749, extension-host 201 on rerun, native 2/2 with exact clipboard artifact/screenshot, production/browser, bundle gates, and definitive blocker review complete | 2026-08-05 |
| `HST-6` | `HostUrlContentApplicationHandler` | Provider-owned URL validation, fetch/abort lifecycle, limits, classification/sniffing, response shaping, discriminator case, and URL terminals | Red-first real-provider forwarding, static displaced-authority, direct identity/redirect/classification/cap/timeout/disposal tests, protocol-sender inventory, and unchanged URL component ring | Focused 223, final coverage Vitest 5,768, extension-host 201, production/browser, bundle gates, and definitive blocker review complete | 2026-08-05 |
| `HST-7` | `HostControlCommandSyntaxApplicationHandler` | Provider-owned syntax cache/TTL, Learn fetch/normalization, HTML/entity/`with(...)` parsing, failure shaping, discriminator case, and syntax-result publication | Red-first real-provider forwarding, static displaced-authority, exact cache/URL/parser/failure/disposal tests, protocol-sender inventory, provider lifecycle disposal, and unchanged caret-docs ring | Focused 321, host-handler ring 424, full/coverage Vitest 5,782, extension-host 201, production/browser, bundle gate, and definitive blocker review complete | 2026-08-06 |
| `HST-8` | `HostResourceUriApplicationHandler` | Provider-owned resource cache, path import/normalization, passthrough/base/stat/conversion decisions, discriminator case, failure shaping, and URI-result publication | Red-first real-provider forwarding, static displaced-authority, direct path/cache/order/failure/disposal tests, protocol-sender inventory, provider lifecycle disposal, and unchanged Markdown caller ring | Focused 378, full/coverage Vitest 5,816, extension-host 201, production/browser, bundle gates, and definitive blocker review complete | 2026-08-06 |

## Decision Discipline

- Do not create a generic framework before one vertical slice proves the contract.
- Do not move code solely to match the suggested package layout.
- Do not replace mature Kusto schema, SQL lifecycle, sidecar, or dashboard semantics without a demonstrated contract gap.
- Do not pursue global removal before the owning module API exists.
- Do not let temporary compatibility adapters become new authorities.
- Do not run two writers for document state, result artifacts, or privacy-sensitive persistence.
- Prefer one end-to-end behavioral test over many source-shape assertions, then add static guards for dependency direction.
- Keep migrations reversible until the old authority is removed and broad validation passes.