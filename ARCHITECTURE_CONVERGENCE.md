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

Assessment date: 2026-07-25

The comparison was made against the current working tree after the SQL lifecycle and Kusto schema lifecycle hardening. It includes the full implemented feature set described by the README, package contributions, persisted formats, architecture documentation, browser extension, and test suites.

The current architecture is not uniformly legacy. Several high-risk contexts already provide good models for the rest of the application.

## Current Alignment

| Golden outcome boundary | Current implementation | Assessment |
| --- | --- | --- |
| Exact Kusto schema ownership | [`KustoEditorSchemaCoordinator`](src/webview/core/kusto-editor-schema-coordinator.ts), exact message routing, model leases, target generations, and tombstones | Strong foundation |
| Serialized shared Kusto worker | [`KustoWorkerMutationPort`](src/webview/shared/kusto-worker-mutation-port.ts) with detached settlement and inline recovery | Strong foundation |
| SQL target and execution ownership | [`SqlEditorLifecycleCoordinator`](src/host/sql/sqlEditorLifecycleCoordinator.ts), [`SqlEditorSessionRegistry`](src/host/sql/sqlEditorSessionRegistry.ts), and [`SqlExecutionBroker`](src/host/sql/sqlExecutionBroker.ts) | Strong foundation |
| Compatibility sidecar mechanics | [`CompatSidecarFormat`](src/host/compatSidecarFormat.ts), [`CompatSidecarStore`](src/host/compatSidecarStore.ts), and [`CompatSidecarSession`](src/host/compatSidecarSession.ts) | Strong shared core |
| Kusto physical identity fencing | Connection, schema, and database operations capture endpoint and authority identity before asynchronous work | Strong foundation |
| SQL Leave No Trace policy | Cross-window policy, revocation generations, protected one-shot runtime, and guarded admission | Strong but SQL-specific |
| Dashboard domain semantics | Shared provenance upgrade/validation concepts and extensive Power BI golden tests | Good domain core, mixed with adapters |
| Editing preferences and first launch | Revisioned application preferences and transactional profile setup | Good explicit ownership |
| Section serialization | Lit section components implement `serialize()` and persistence iterates DOM order without ID-prefix ownership | Useful transitional boundary |

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
| 1 | `EXA` | Exact execution and immutable artifact spine | 5/5/5/5/2/5 | 52 | Active; EXA-1 complete, EXA-2 is next |
| 2 | `COD` | Lossless versioned codecs and one document-kind capability matrix | 5/4/5/5/4/5 | 52 | Open; prerequisite to `DOC` |
| 3 | `DOC` | Document actor and section-definition registry | 4/5/5/5/3/5 | 50 | Open; depends on `COD` |
| 4 | `PRO` | Runtime-validated protocol, view sessions, and deterministic startup | 4/4/5/5/3/5 | 48 | Open |
| 5 | `HST` | Host application composition; retire `QueryEditorProvider` as an application shell | 4/5/5/4/2/5 | 47 | Open, depends on contracts above |
| 6 | `BRW` | Real browser read-only composition root | 3/4/4/4/4/4 | 41 | Open, depends on document/projection contracts |
| 7 | `CMP` | Compatibility-provider composition around the shared sidecar core | 4/4/3/3/3/4 | 39 | Open |
| 8 | `DSH` | Dashboard compiler IR separated from VS Code/Fabric adapters | 3/3/3/3/4/4 | 35 | Open |
| 9 | `KLS` | Custom KQL analyzer decomposition behind a language-analysis port | 3/3/2/2/3/4 | 30 | Open |
| - | `ACT` | Untrusted-document capability admission | 5/5/5/5/3/5 | 53 | Deferred by product direction; excluded from active ranking |

Bundle headroom is a release constraint and must remain gated, but it is not itself an ownership architecture. Large domain algorithms are not automatically gaps when they have one owner and focused contracts.

## Gap Details

### `ACT` - Untrusted-Document Capability Admission

**Status:** deferred by product direction. Keep this gap visible for golden-outcome completeness, but do not select or implement it unless product direction changes or it becomes an explicit release blocker.

**Golden outcome:** document origin and trust are versioned inputs to one host policy authority. Every document-authored privileged effect is separately authorized, including scripts, data, network, local code, Kusto, SQL/STS, language/schema traffic, model/tools, external resources, navigation, export, and publication. Trust or origin change revokes affected work and permissions.

**Current divergence:**

- Remote GitHub, Azure DevOps, SharePoint, OneDrive, and URL content is downloaded into extension global storage and opened as an ordinary local document. The editor receives no durable source-origin/trust descriptor.
- HTML preview uses `sandbox="allow-scripts"`, injects authored code through `srcdoc`, and immediately embeds up to 10,000 rows from the selected fact section into the authored JavaScript data bridge.
- Neither the outer workbench template nor the preview `srcdoc` establishes a content-security policy. Sandboxing removes same-origin authority but does not by itself prohibit outbound network requests.
- Bootstrap and runtime dispatch accept arbitrary object-shaped `window.message` events without a host-session/source boundary. Authored iframe code can post to its parent and attempt to impersonate host document, policy, result, persistence, or tool messages.
- Expanded URL sections automatically request arbitrary HTTP/HTTPS content during restore. Host fetch is not admitted by document origin or trust and can target loopback/private endpoints.
- Markdown preview preserves direct HTTP/HTTPS image sources, so rendering alone can make a request without host policy admission.
- Fetched URL HTML injects a `<base>` and renders sanitized markup in a sandboxed iframe without a policy CSP. Nested images, stylesheets, fonts, frames, media, CSS URLs/imports, forms, and navigation can therefore resolve independently of the top-level host fetch decision.
- The read-only browser viewer is not an active-content trust boundary; read-only content can still execute and observe embedded data.
- Kusto/SQL privacy rules govern persistence and some exports but there is no independent `exposeToActiveContent` admission decision.
- Current result state has no immutable producer target, principal, privacy-decision revision, or derived lineage. Consulting a section's current target when exposing an older result would create a second, race-prone privacy authority.
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
- A late or derived protected result can be misclassified if active-content admission consults only the section's current target.
- Browser read-only mode can be mistaken for script/data isolation.
- Portable Power BI behavior and raw active standalone export can be conflated, hiding non-portable or executable behavior.
- Untrusted documents can launch local Python, authenticated data-plane/language/model operations, or automatic preparation even when HTML remains static.
- Remote content can dereference local files or network shares through `linkedQueryPath`, crossing the immutable snapshot boundary before trust admission.

**Migration theme:** establish one document-capability gateway before expanding artifact availability or execution orchestration. Transport authentication, script execution, artifact exposure, passive/explicit network, host execution, external resources, model/tools, raw standalone export, and portable publication remain distinct decisions.

### `COD` - Lossless Codecs And Document Capabilities

**Golden outcome:** runtime-validated codecs preserve unknown root/state fields, known-section extension fields, opaque unknown sections, and order. One capability matrix validates `.kqlx`, `.sqlx`, and `.mdx` without silently filtering incompatible content.

**Current divergence:**

- `parseKqlxText()` reconstructs a known root/state shape and drops unknown root and state fields.
- Known sections are hydrated field by field and serialized from current component state, so future fields on known sections have no guaranteed overlay path.
- Unknown section variants are permissively typed but are not governed by one lossless ordered codec contract.
- `.mdx` sanitation filters unsupported/unknown sections instead of reporting incompatibility.
- Documentation has described `.sqlx` as SQL-only even though the implementation permits SQL plus chart, transformation, Python, URL, HTML, and markdown sections.

**Failure modes:**

- Opening and saving a file from a newer producer can erase data the current build does not understand.
- Different parse, sanitize, restore, and UI-capability paths can disagree about valid section kinds.
- Moving document authority behind current codecs would formalize lossy behavior.

**Migration theme:** introduce lossless overlay codecs and one generated capability matrix before `DOC`. Golden fixtures must edit one known field while preserving future root, state, section, and unknown-section data in order.

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
- Static terminal-construction/cancellation guards, protocol inventory, focused state-machine tests, full sequential tests, and authenticated normal/rerun/retarget/cancellation E2E are green.

**Remaining divergence:**

- Accepted data is still mutable latest state keyed by `boxId` in [`results-state.ts`](src/webview/core/results-state.ts).
- Charts, transformations, comparisons, persistence, HTML dashboards, export, and Copilot can identify a source section but not an immutable producer revision with policy-bearing lineage.
- Runtime result bindings and persisted result JSON do not yet share one immutable artifact contract, so downstream consumers can still observe latest-state replacement rather than an explicit revision.
- Kusto and SQL retain transport-specific execution coordinators over the shared low-level run registry; a transport-neutral artifact publication contract has not yet proven which semantics should be shared above transport.

**Failure modes:**

- Downstream state can be replaced without retaining the exact producer revision that a chart, transformation, dashboard, export, or Copilot response consumed.
- Derived data can lose privacy/export permissions as it moves through section-keyed maps.
- Restoration and persistence can preserve rows without a first-class immutable producer, target, principal, policy, and lineage record.
- Prematurely merging Kusto and SQL execution abstractions could erase transport-specific cancellation and privacy semantics before the artifact contract is proven.

**Migration theme:** establish exact execution reservation/dispatch identity and one terminal owner first, then introduce immutable persisted artifact records and runtime bindings behind the existing result APIs, then move consumers one at a time.

### `DOC` - Document Actor And Section Registry

**Golden outcome:** one serial document actor owns application content revisions, ordered domain state, and section commands while a VS Code `CustomDocument` adapter owns native dirty/undo/save/revert/backup/close integration. Each section kind has one definition for parse, migration, serialization, validation, dependencies, and policy. Views do not serialize the DOM.

**Current divergence:**

- [`persistence.ts`](src/webview/core/persistence.ts) imports section construction/removal and centrally hydrates every section type.
- [`section-factory.ts`](src/webview/core/section-factory.ts) imports persistence, creating a cycle between mutation and storage.
- Creation, restoration, removal, tool configuration, dependency refresh, and privacy sanitation are distributed across large switches and per-type arrays.
- Components own serialization but are not the canonical domain state. Restore behavior still knows component-private methods and timing.
- Adding a section requires edits across format, component, factory, persistence, tool removal, startup imports, and privacy handling.

**Migration theme:** after `COD`, introduce a typed section definition registry and a host-side document session behind the lossless codecs. Migrate simple sections first; do not move Kusto/SQL editor lifecycle until the registry contract is proven.

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

## Next Candidate

### Iteration `EXA-2`: Immutable Result Artifacts And Lineage

**Status:** next candidate; not implemented in this task.

**Why next:** EXA-1 makes the producer execution exact, but admitted rows still collapse into mutable section-keyed state. This leaves the highest-risk remaining break between exact production and downstream consumption.

**Falsifiable hypothesis:** if each admitted success creates an immutable artifact revision carrying producer reservation/dispatch identity, target/principal/policy metadata, and source lineage, then a derived consumer can bind to one revision while a later rerun replaces the section's current pointer without changing what that consumer reads.

**Cheapest discriminating check:** execute a source section, bind one low-risk derived consumer to the resulting revision, rerun the source, and prove the consumer retains its original revision until an explicit rebind while current result rendering still shows the new revision.

**Initial boundary:** introduce immutable runtime and persisted artifact records behind existing result APIs, then migrate one low-risk derived consumer. Preserve current file compatibility and rendering. Do not broaden into deferred `ACT` capability work.

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

## Decision Discipline

- Do not create a generic framework before one vertical slice proves the contract.
- Do not move code solely to match the suggested package layout.
- Do not replace mature Kusto schema, SQL lifecycle, sidecar, or dashboard semantics without a demonstrated contract gap.
- Do not pursue global removal before the owning module API exists.
- Do not let temporary compatibility adapters become new authorities.
- Do not run two writers for document state, result artifacts, or privacy-sensitive persistence.
- Prefer one end-to-end behavioral test over many source-shape assertions, then add static guards for dependency direction.
- Keep migrations reversible until the old authority is removed and broad validation passes.