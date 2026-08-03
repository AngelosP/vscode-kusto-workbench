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

Assessment date: 2026-08-03

The comparison was refreshed against the current working tree after DOC-2 host-owned URL state convergence. It includes the full implemented feature set described by the README, package contributions, persisted formats, architecture documentation, browser extension, and test suites.

The current architecture is not uniformly legacy. Several high-risk contexts already provide good models for the rest of the application.

## Current Alignment

| Golden outcome boundary | Current implementation | Assessment |
| --- | --- | --- |
| Exact Kusto schema ownership | [`KustoEditorSchemaCoordinator`](src/webview/core/kusto-editor-schema-coordinator.ts), exact message routing, model leases, target generations, and tombstones | Strong foundation |
| Serialized shared Kusto worker | [`KustoWorkerMutationPort`](src/webview/shared/kusto-worker-mutation-port.ts) with detached settlement and inline recovery | Strong foundation |
| SQL target and execution ownership | [`SqlEditorLifecycleCoordinator`](src/host/sql/sqlEditorLifecycleCoordinator.ts), [`SqlEditorSessionRegistry`](src/host/sql/sqlEditorSessionRegistry.ts), and [`SqlExecutionBroker`](src/host/sql/sqlExecutionBroker.ts) | Strong foundation |
| Compatibility sidecar mechanics | [`CompatSidecarFormat`](src/host/compatSidecarFormat.ts), [`CompatSidecarStore`](src/host/compatSidecarStore.ts), and [`CompatSidecarSession`](src/host/compatSidecarSession.ts) | Strong shared core |
| Lossless notebook codec and kind capabilities | [`kqlxOverlay.ts`](src/host/kqlxOverlay.ts) preserves exact unknown data; [`documentSectionCapabilities.ts`](src/shared/documentSectionCapabilities.ts) owns every known `.kqlx`/`.sqlx`/`.mdx` allow/default/add decision across parser, host, webview, tools, upgrades, and browser | Strong foundation |
| Kusto physical identity fencing | Connection, schema, and database operations capture endpoint and authority identity before asynchronous work | Strong foundation |
| SQL Leave No Trace policy | Cross-window policy, revocation generations, protected one-shot runtime, and guarded admission | Strong but SQL-specific |
| Dashboard domain semantics | Shared provenance upgrade/validation concepts and extensive Power BI golden tests | Good domain core, mixed with adapters |
| Editing preferences and first launch | Revisioned application preferences and transactional profile setup | Good explicit ownership |
| Unmigrated section serialization | Section kinds other than Markdown and URL implement `serialize()` and persistence iterates their DOM order without ID-prefix ownership | Useful transitional boundary |

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
| 1 | `DOC` | Document actor and section-definition registry | 4/5/5/5/3/5 | 50 | DOC-2 closed; DOC-3 selected |
| 2 | `PRO` | Runtime-validated protocol, view sessions, and deterministic startup | 4/4/5/5/3/5 | 48 | Open |
| 3 | `HST` | Host application composition; retire `QueryEditorProvider` as an application shell | 4/5/5/4/2/5 | 47 | Open, depends on contracts above |
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

- Native Markdown and URL persisted state are migrated: one host aggregate, one command client, one URI queue, and per-kind definitions own ordered state and revisions; both Lit components are views, and native Save does not consult their DOM serialization.
- [`persistence.ts`](src/webview/core/persistence.ts) imports section construction/removal and centrally hydrates every section type.
- [`section-factory.ts`](src/webview/core/section-factory.ts) imports persistence, creating a cycle between mutation and storage.
- Creation, restoration, removal, tool configuration, dependency refresh, and privacy sanitation for the remaining section kinds are distributed across large switches and per-type arrays.
- Unmigrated components still supply serialization without being canonical domain state. Restore behavior still knows component-private methods and timing.
- Adding a section requires edits across format, component, factory, persistence, tool removal, startup imports, and privacy handling.

**Migration theme:** DOC-1 and DOC-2 proved the transport-neutral aggregate/definition pattern with Markdown and URL. Expand it one simple section kind at a time; do not move Kusto/SQL editor lifecycle until the registry contract is broader and stable.

### `PRO` - Protocol, View Sessions, And Startup

**Golden outcome:** one runtime-validated protocol, explicit view-session identity, capability negotiation, plugin-ready handshake, one initial projection, and revisioned deltas.

**Current divergence:**

- Host input and webview output message unions are duplicated; host output is `unknown` and webview dispatch input is `any`.
- [`message-handler.ts`](src/webview/core/message-handler.ts) is a central switch while some temporary and component listeners observe the same transport independently.
- [`window-bridges.d.ts`](src/webview/window-bridges.d.ts) remains a large ambient contract, and state is mirrored between module bindings and `window`.
- [`index.ts`](src/webview/index.ts) relies on import-time side effects and says `main` must be last even though component registration imports follow it.
- The preload queues early Add commands in `window.__kustoQueryEditorPendingAdds`, while runtime restore drains a separate `pState.queryEditorPendingAdds`. There is no explicit adoption handoff.
- Browser startup implements a different buffering/acknowledgement protocol.

**Migration theme:** define protocol schemas and a view-session bootstrap around existing messages, then extract domain routers. Ambient bridges are removed only after their owning contract exists.

### `HST` - Host Application Composition

**Golden outcome:** the VS Code provider is a transport/composition adapter. Application workflows live in use-case handlers and actors.

**Current divergence:**

- [`QueryEditorProvider`](src/host/queryEditorProvider.ts) still combines panel transport, a large inbound switch, Kusto execution, SQL adapters, Python/URL execution, persistence UX, comparisons, dashboard operations, and cross-language coordination.
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

**Subsequent boundary:** DOC-2 is now closed. The active selection is DOC-3 below; deferred ACT and Kusto/SQL coordinator convergence remain excluded.

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

## Next Iteration

### Iteration `DOC-3`: Host-Owned Python Section State

**Status:** selected, not started.

**Why next:** DOC remains the highest eligible theme at 50. Python is the next bounded persisted-state shape after Markdown and URL. It can expand the proven aggregate and definition contract without entering Kusto/SQL target lifecycle or chart/transformation dependency scheduling.

**Boundary:** add one Python section definition and route Python add/patch/remove plus persisted `name`, `code`, `output`, `expanded`, and `editorHeightPx` through the existing host aggregate and command queue. Keep Monaco instances, execution request/process ownership, stdout/stderr acquisition, and local-code policy in their current adapters. Do not migrate a fourth section kind.

**Falsifiable hypothesis:** if Python persisted state joins the same host aggregate, then source/output/presentation edits, stale rejection, view recreation, and lossless Save remain correct while a stale or throwing Python component serializer cannot affect native persistence.

**Cheapest discriminating check:** load Python plus host-owned Markdown/URL and opaque future data, execute Python add/patch/remove against the host owner, reject a stale command, recreate the view, poison Python `serialize()`, then Save and prove exact Python/Markdown/URL state, order, and future data survive.

**Exclusions:** no Python execution/process redesign, no local-code trust or deferred `ACT` work, no Monaco lifecycle rewrite, no protocol rewrite, no Kusto/SQL migration, and no chart/transformation/HTML or fourth section kind.

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

## Decision Discipline

- Do not create a generic framework before one vertical slice proves the contract.
- Do not move code solely to match the suggested package layout.
- Do not replace mature Kusto schema, SQL lifecycle, sidecar, or dashboard semantics without a demonstrated contract gap.
- Do not pursue global removal before the owning module API exists.
- Do not let temporary compatibility adapters become new authorities.
- Do not run two writers for document state, result artifacts, or privacy-sensitive persistence.
- Prefer one end-to-end behavioral test over many source-shape assertions, then add static guards for dependency direction.
- Keep migrations reversible until the old authority is removed and broad validation passes.