# Repo-Specific Testing Knowledge

This file is your persistent knowledge base for E2E testing this specific
codebase with vscode-extension-tester. Unlike SKILL.md (which is overwritten
on every `vscode-ext-test init` to stay current with framework updates),
**this file is never overwritten** — it accumulates knowledge across sessions.

## How to Use

Read this file before every test session. Update it after every session with
anything new you learned. Structure it however makes sense for this repo.

## Current Verification Checkpoint: Fresh Hidden MDX Mode Update

Status: REPRODUCED AND FIXED. The exact first hidden call and composed
Save/reopen lifecycle pass in the final production workspace build, with the
user-approved CDP visual validation. All approved complete core regressions
and production budgets pass. Stock native screenshot limitations remain
separate; no installed-release qualification is claimed.

- Use the real public create/list/update path: create an ID-less MDX with
  `reveal:false`, create the other supported formats, obtain the inactive
  file's live inventory UUID, and issue a mode-only `wysiwyg` update before
  activation. Default WYSIWYG does not require adding a saved mode field.
- The actual-orchestrator test failed with `{success:false}` while four
  neighboring Markdown controls passed. Real isolated run `20261031-031809`
  independently returned bare false in 252.0178 ms; the identical call with
  the same UUID passed in 21.1504 ms after one ordinary activation. Subsequent
  unmodified-product attempts repeated that API failure.
- The defect was split authority: inventory used the live native section ID,
  while the host-owned background mutation parsed ID-less source and searched
  for `section_0`. Markdown now reuses the existing ready-background ownership
  handoff and carries its exact connection/source-admission fence into dispatch.
  It does not activate the file or invent an index/ID mapping.
- All 334 orchestrator tests pass. The six new cases cover ready/delayed
  admission, unavailable readiness followed by a valid retry, source-version
  drift, retirement, and connection replacement before dispatch.
- The composed public-tool lifecycle passes with foreground-independent CDP
  captures: a first hidden default no-op, a second fresh hidden Preview change,
  hidden Save, Preview after reopen, hidden return to WYSIWYG using the current
  inventory ID, another Save/reopen, and explicit unknown-ID rejection.
  Content and the first document remain unchanged; exact owned-tab/file cleanup
  passes. The three mode screenshots were reviewed.
- Native capture remains a separate limitation in this environment: preserve
  the initial Shadow DOM selector error, guest-compositor timeout, native
  moveWindow failure, and lost-foreground-after-synchronization failure. The
  user explicitly approved CDP main-page screenshots instead. The live adapter
  executes the same feature assertions and takes CDP images at its screenshot
  boundaries; do not describe the stock native capture as passing.
- Query the Markdown component's own shadow root for selected mode tabs.
  A compound document selector spanning that boundary failed. Cleanup must
  compare directories with platform-aware `path.relative`, not literal drive
  letter casing; a composed run passed behavior but initially failed cleanup
  on `C:` versus `c:`, and that failure remains recorded.
- The fix added 89 production host bytes, 56 beyond the previous cap. The user
  approved a host-only 1 KiB increase to 2546 KiB; the two host baselines stay
  synchronized, with the 50 KiB buffer and every other limit unchanged.
- Final validation: 452 native tests, 9368 webview/host tests, and 571 script
  tests pass, with five existing skips across the latter two suites.
  Production packaging and both synchronized budget checks pass.
- The final production CDP lifecycle (`mdx-live-oXlngt`) passed every feature
  API, DOM, durable-field, unknown-ID, and cleanup assertion. Its first hidden
  WYSIWYG call succeeded in 83.4528 ms with zero activations and byte-stable
  source; the first hidden Preview mutation succeeded in 77.8123 ms. Preview
  and then WYSIWYG survived separate Save/reopen cycles, using current
  inventory identity after reopen. All three exact-window images were reviewed.
  The final cleanup closed three remaining owned tabs and deleted eleven
  synthetic files; earlier failed-run synthetic fixtures were also cleaned
  without altering original dogfood files or prepared-profile state.

## Previous Verification Checkpoint: Retained-Notebook Renderer OOM

### Target 88 Follow-up

The second October 30 failure shares the prior fix's observed red-to-green
evidence. The exact 27,908-byte, six-section archive file first failed in
30,736.5833 ms in `20261030-184506` and first opened live in 3,132.5307 ms in
the full-duration green run. The earlier run had 169 restored tabs, including a
different copy of the same filename, but not the exact requested URI. Compare
full URIs when deciding whether an activation is genuinely cold.

The replay now explicitly pins target 88's identity/bytes, rejects warming or
fallback metadata, and reads its development notes later while hidden without
another activation. This document has no saved development-note section:
`success:true, notes:[]` is the correct result, not a snapshot-unavailable error.
All 20 harness guard tests pass. Separate evaluation of the actual oracle
rejects the recorded real first-call failure and accepts the recorded success.

Run `20261031-022712` passed all 12 API/preservation checks: target 88 opened
live in 2,301.1825 ms, its later hidden note read passed in 93.7383 ms, and its
activation count stayed one. All 109 activations passed and starting/final tab
counts were zero. No additional product patch was made. The runner still
exited 1 because the final native cleanup screenshot lost foreground
qualification; retain that failure. A separate trusted post-oracle CDP image
showed the live canary and a metadata-superseded notification, not a target-88
activation failure. This is API/preservation evidence, not a clean full-run
visual sign-off.

### Retained-notebook Qualification

Status: THE FIRST OCTOBER 30 HANDOFF BUG IS REPRODUCED AND VERIFIED FIXED IN
THE WORKSPACE BUILD. The unprofiled original workload passes after the complete
2300-second hidden interval. Approved core regressions, focused authenticated
worker recreation, production packaging, and unchanged bundle budgets pass.
This does not qualify an older installed extension or the deferred broad E2E suite.

- The original 109-target sequence reproduces unavailable development notes
  and dashboard validation, followed by failed ordinary activation of the
  same canary. A 2300-second run reproduced both errors, but had 59 restored
  starting tabs. Subsequent fresh-workspace runs reproduced the failure with
  exactly zero starting tabs. Preserve that distinction.
- Reuse the prepared authentication profile with a new empty workspace folder
  for each replay. Reusing its empty-window layout restored previous test tabs
  despite successful in-run exact-URI cleanup. Never reset unrelated or dirty
  tabs to manufacture a clean baseline.
- Native dumps identify a renderer OOM (`0xe0000008`) on a DedicatedWorker
  thread. The canary becomes gray and its exact visible iframe has no live CDP
  target. Successful native `postMessage` delivery does not establish that the
  webview application received or acknowledged a probe.
- Direct worker CDP attachment can hang. Browser-level attachment followed by
  recursive parent-frame auto-attachment reaches the worker isolates. Deduplicate
  observations by isolate ID, not iframe count; multiple documents can share a
  renderer heap. Match visible webviews by their iframe `id`, not shared origin.
- Allocation sampling in run `20261031-000705` observed 87 Kusto workers and
  all original API/preservation assertions passed. This is diagnostic evidence,
  not a fix: inspector attachment changes execution conditions, and no full
  hidden-duration qualification was performed. Allocation totals included
  collected objects, so they are not retained heap sizes or true peak bounds.
- The sampled run's post-recovery CDP screenshot shows a live canary. Its later
  native cleanup screenshot failed foreground validation and the runner exited
  1; retain both facts instead of relabeling the whole run green.
- Sampled call stacks exposed repeated database-symbol construction for
  schemed/unschemed aliases of the same host. Actual-function tests first failed
  for duplicate registrations; worker-only hostname deduplication makes those
  tests pass while retaining distinct short/full hosts and later revisions.
  The unprofiled 109-target candidate still failed at target 92
  (`20261031-002707`), with all nine preservation/build/cleanup guards true.
  A subsequent Blob-backed loader removes source strings from worker messages.
  Its first unprofiled 109-file run (`20261031-005336`) passed all four exact
  note/dashboard pairs, ordinary same-target activation, all nine guards, and
  zero starting/final tabs. There were no activation failures. Both the live
  canary CDP image (captured only after the measured calls) and the exact-target
  native cleanup image were reviewed. This run used the short diagnostic
  duration; do not call it full-duration qualification.
- Full-duration run `20261031-011033` subsequently passed without profiling or
  a duration override: 109 activations, no activation failures, zero starting
  and final tabs, all nine guards true. The first hidden notes call began at
  2300007.4469 ms and completed in 49.2593 ms; dashboard validation began at
  2300059.3146 ms and completed in 115.1164 ms. Both exact APIs also passed
  immediately after one ordinary same-target activation. No query execution,
  file mutation, or cold-reopen recovery was substituted. The observer attached
  only after those calls; live-canary and exact-target cleanup images were reviewed.
- Blob loading also passed all six real Ctrl+Space scenarios, including exact
  remote columns (`20261031-004956`), with a reviewed trustworthy screenshot.
  The first attempt requested a nonexistent named `default` profile and never
  launched; the successful unchanged feature used ordinary fresh-profile mode.
- Current core regression evidence: 452 native tests passed on Code 1.144.0;
  the full webview suite passed 9362 tests with four existing skips; all three
  script files produced 558 passes and one existing prerequisite skip.
  A broader E2E dry-run executed zero tests: its preflight rejected
  existing `kusto-auth` workspace state and missing `opt-in` profile storage.
  The user chose focused verification rather than repairing or bypassing those
  profile guards; preserve the existing state.
- Production packaging and all unchanged bundle budgets passed after the frozen
  qualification finished. An earlier budget check used unminified `npm run compile`
  output and failed the gate's production-output prerequisite; preserve that
  classification instead of describing it as source growth or raising budgets.
- The separately corrected passive/eager preparation path passed the real
  five-section restored-worker completion/Save/reopen scenario
  (`20261030-220906`), but did not fix the retained-load failure by itself.
- The final production-build scenario (`20261031-015653`) includes a zero-tab
  pre-reset guard and a second real third-editor click after Save/close/reopen.
  Both completion proofs passed with the auxiliary and word-based providers
  disabled, actual worker context verified, and the four other sections still
  deferred. Both native screenshots were reviewed; they show the settled
  completion-probe prefix after the widget was dismissed, while JSON artifacts
  carry the exact matched-table proof. The fixture and task tabs were cleaned up.

## Previous Verification Checkpoint: October 30 Readiness And Test Infrastructure

Status: TARGETED FIXES VERIFIED. The targeted activation, real Kusto/SQL
execution lifecycles, bounded hidden-read scenario and current regression gates
have passing evidence. The original 109-file, 16-warm-tab, long-duration incident
has not been fully qualified, and the older SQL profile's dirty-tab inconsistency
remains preserved. Do not describe every historical behavior as closed.

### Implemented Changes

- Native automatic refreshes retain their starting requirement across queued preparation, with a document-request fence preventing a later explicit rejection from being healed.
- A successful, still-current initial projection satisfies an already-admitted bootstrap recovery instead of issuing a redundant reload. Failed, explicit, stale-source, unanswered-challenge and replaced-runtime cases retain their independent projection requirements.
- The transport fixture separates setup, command assertions and cleanup under the existing five-second defaults. Restoration is synchronous, ownership-checked and idempotent before draining; aggregate observations are fixture-scoped. The real session writes/fsync, 500 ms delivery deadline, 50 ms retry intervals and all original assertions remain.
- The Chart-only Save and Power BI compensation fixtures use exact-title setup/cleanup hooks in their original suite order. Only initialization moved out of their test bodies; all 13 Chart assertions and 12 Power BI assertions and action sequences remain. Cleanup retires hooks before clearing the live-document facade and retains unclosed private fixtures.
- Seven existing native lifetime tests now issue an ordinary explicit reread where they previously relied on the removed duplicate bootstrap projection. Only two setup expressions changed; their deadline, disposal, latest-projection and late-snapshot assertions remain intact.
- The TypeSpec SDK recorder uses 32 routine/64 probe keys per panel and phase, a 128-row pool per panel, and the existing 32-panel bound. Lifecycle records remain ordered and unmerged; every loss is still fatal. Qualified receipts validate panel identity, membership and per-panel capacity. Guard v3 rejects older or stale-function receipts.

The separately authorized launcher repair is in the sibling
`vscode-extension-tester` repository: both child output pipes are resumed before
waiting for the controller. Previously, startup Trace filled unread pipes and
could stall native opening and the debugging endpoint. A counts-only diagnostic
drained 104018 stdout bytes and 1306 stderr bytes; all five original first-call
oracles then passed, exposing recorder overflow as a separate failure.
The first validation used CLI 0.1.23 with a local two-line patch: only its
generated `dist/modes/ci-mode.js` and matching map were replaced after verifying
the runtime difference. Backups and hashes are in `%TEMP%/kw-launcher-fix-37`.
During final validation, the sibling repository and installed CLI advanced to
0.1.24; the sibling is clean at release commit `889ac29`. That external release
was preserved. The installed launcher implementation still has SHA-256
`c3084b49de848aba8fb979274cea9cfd6930b7e41531c68e236be472ef7a330b`.
The acceptance pin and its test fixtures now require 0.1.24. All 103 affected
TypeSpec tests and a fresh ordinary standalone/prefix pair passed after that
pin update. No acceptance deadline or retry limit was changed.

### Current Evidence

| Scope | Setup, action and exact oracle | Result |
| --- | --- | --- |
| Automatic readiness | Existing native fixture accepts generation 1, overlaps two automatic preparations, negatively acknowledges later revisions, drains all counters, and checks current-view readiness plus unchanged source. Queued policy changes and explicit rejections remain false | Genuine `false !== true` red fixed; a review counterexample that healed a later explicit rejection also reproduced and is fenced. Four new parameter cases |
| Initial sharing | Real native document and gateway issue recovery while initialization is pending or already posted; assert exact projection/snapshot counts, source preservation and current runtime. Explicit, failed, version-ABA, unanswered-challenge and replacement-runtime controls remain independent | Genuine duplicate `2 !== 1` red fixed; seven new parameter cases. Gateway suite: 95 passed |
| TypeSpec C1/C2 | Fresh ordinary CLI standalone, then separate fresh prefix 100-104; exact first-call results, all 13 checks, complete SDK capture and unchanged files | Both pass with installed CLI 0.1.24 and the newly pinned v3 recorder. C2 has 229 records across five panels, zero loss, no saves or damage. Earlier locally patched 0.1.23 passes remain retained |
| Real Kusto execution | Background CREATE -> Save -> LIST actual ID -> configure/execute without replacing the query -> rendered Probe=1 -> Save/close/reopen -> restored result -> execute-only with new producer -> Save | `PASS_DOM_DISK_NOT_VISUAL_OR_INSTALLED_PRODUCTION`; first 1193.9771 ms, second 882.7995 ms. Query `print Probe=1` unchanged, durable models clean, five starting tabs preserved |
| Real SQL execution | Same composed lifecycle on the existing dedicated `sq-6e42` profile, with exact connection/server/database pins and query `SELECT 1 AS Probe` | Same DOM/disk pass; first 18234.784 ms, second 6617.092 ms. Fresh post-reopen producer, unchanged query, zero starting or surviving task tabs |
| Hidden access | Exact archived ten-section canary, six bindings and one source; retain mixed prefixes 19 and 32; first notes then dashboard reads while hidden, before inventory | Uninstrumented run: `NOT_REPRODUCED_SHORT_RUN`. All three pairs and eight checks passed, 32 retained prefix activations, no saves or damage. Not full historical-outage qualification |
| Native regression | Full suite after transport, Chart and Power BI fixture lifetime isolation, with all original behavioral assertions retained | Final `npm test`: 452 passed in 3 minutes, exit 0. Focused transport/guards: 15 passed; ordered Power BI -> Chart -> retained controls: 3 passed. Earlier 447/4, 450/2 and 451/1 failures remain retained; the final pass does not erase them |
| Protocol inventory | Review unchanged command-result and gateway senders after source movement | 80 passed after coordinate-only updates `5636:10 -> 5666:10` and `798:33 -> 804:33`; the preceding 78/2 result is retained |
| Recorder regression | One/five-panel traffic, exact counts/order, per-panel overflow, stale guards and retired capture | Five-panel red overflow 478; complete journal file: 518 passed, one existing prerequisite skip. After the final 0.1.24 pin-only update, all 103 affected TypeSpec cases passed again |
| Launcher regression | Real bounded streams containing 256 KiB each must drain before controller connection without contaminating JSONL | Red inactive streams with four controls passing, then five passing. Full sibling suite: 592 tests / 33 files; both Turbo builds passed |
| Unit coverage | Official current-code `npm run test:coverage-gate` | 9330 passed, four existing skips; 372 passing files and one skipped file. Statements 53.58% (34812/64971), gate passed; 1061.95 seconds |
| Complete script regression | Current journal file plus `e2e-full-suite-support.test.mjs` | 518 journal tests passed with one existing prerequisite skip; all 33 support tests passed. Combined: 551 passed, one skip, no failures |

Product host: 2606047 bytes, SHA-256
`8cba65ba4a0a2b02977d97da79b5f9666b347ba899747ea7916dc83c81e42015`.
The approved 2545 KiB cap is unchanged, with 33 bytes remaining. The normal
uninstrumented production build passed three typechecks, lint, all 12 caps and
bootstrap packaging. Native regression uses Code 1.144.0; acceptance uses the
authentic pinned Code 1.143.0. No visual or installed-Production qualification
is claimed.

V3 feature: 74483 bytes, SHA-256
`576e6694fc054ea955a09e4609591c504219b082367fcda12ac1de5ea4a627c5`.
Executing function: 65528 bytes, SHA-256
`c492b3d1e347213dace929dc97c73b40e05f7451ce0a37bc7a0d905e438563f3`.
Frozen acceptance runtime: `%TEMP%/kw-v324-45/e`, manifest SHA-256
`066fbc8a2a638f750ea7875ede6d571e15613c04e2a7c77e774bc100d5e22bd8`.

Current acceptance receipts:

- Current 0.1.24 C1: frozen runtime `tests/vscode-extension-tester/runs/20261030-082553`; evidence `%TEMP%/kw-acceptance-dpUyk2/evidence`, first 104 in 2664.9927 ms.
- Current 0.1.24 C2: frozen runtime run `20261030-082628`; evidence `%TEMP%/kw-acceptance-aWsxKP/evidence`, first calls 100-104 in 4129.6148 / 664.5539 / 3893.2394 / 3127.1858 / 2416.2926 ms.
- Earlier patched 0.1.23 C1/C2: `%TEMP%/kw-v3-38/e` runs `20261030-044125` and `20261030-044252`, evidence roots `kw-acceptance-wDDFau` and `kw-acceptance-mky1e0`. These do not replace the new receipts.
- Kusto: workspace run `20261030-060454`; `%TEMP%/kw-first41/evidence/kusto-lifecycle-ep8YyL`.
- SQL: workspace run `20261030-061429`; `%TEMP%/kw-first41/evidence/sql-lifecycle-BU3vwf`.
- Hidden: `%TEMP%/kw-v3-38/e` run `20261030-062310`; `%TEMP%/kw-acceptance-QWQPww/evidence`.

### Retained Limits And Failures

The first Kusto execution failed while fetching `/v1/rest/auth/metadata` before
TLS completed. The user confirmed VPN was connected. Node, PowerShell and the
isolated extension host subsequently returned HTTP 200 with normal certificate
validation; the real lifecycle then passed without changing VPN/TLS settings.
This establishes no VPN root cause; retain run `20261030-055404`.

The older `sql-auth` profile restores a dirty custom-editor tab while its native
version-1 model and disk bytes are clean. The user authorized saving that exact
older test file. Native Save returned true while it was clean; Workbench Save
later reported the tab remained dirty. No discard was performed. That profile
inconsistency remains unresolved. The successful dedicated profile used the
same verified SQL server/database, without copying credentials, and does not
retroactively qualify the older profile.

Hidden run `20261030-051418` failed initial baseline activation, before any
hidden read. Its mixed SQL-bearing notebook accepted generation 1 and rejected
an automatic generation 2; no source damage occurred. A temporary scalar-only
revision probe did not identify that failure's cause and was removed. Its
passing diagnostic run is not the final evidence; the uninstrumented run above
is. Neither the short pass nor controlled native readiness regressions prove
the complete original 109-file/16-warm-tab/24-minute incident fixed.

Transport-fixture diagnostic attempts are also retained: an initial annotation
compile failure, a setup timeout after hook separation, a late owner assertion
after retirement, and an unavailable `workspace.fs.readFile` replacement.
Those temporary probes were removed; failed setup is not a product red. The
observed roughly four-second setup I/O delay is not explained by the fixture
isolation repair. The final Chart cleanup retains its private fixture when the
test has prepared Save without committing it; no synthetic commit was added to
make cleanup succeed. Do not retry until green or increase deadlines to hide
these earlier failures.

Final manual follow-ups remain unperformed: type during schema startup and
switch away/back before Save/reopen; reopen and add another section to check
single application; visual/installed-Production review; and the full historical
hidden workload. Use disposable files and preserve first failures. Existing
automated functional passes above do not substitute for those qualifications.

## Historical Verification Checkpoint: October 29 Correlated Logging

Status: INCOMPLETE. The new activation diagnostics are implemented and captured
through the existing Output-channel facility. The original three workflows are
not all verified, and the full native regression gate is not green. No separate
framework change is an established prerequisite.

| Scope | Current evidence / limit |
| --- | --- |
| Focused logging tests | 344 passed, including 17 new observer cases. The initial missing-observer red retained 327 passing controls. Types, lint and targeted editor diagnostics passed |
| Protocol inventory | All 80 cases in `tests/webview/host/message-protocol.test.ts` passed after the logging and documentation changes; no sender allowlist changes were needed |
| Production package | Three typechecks, lint, all 12 bundle caps and bootstrap packaging passed. Explicit user approval raised only the host cap to 2545 KiB / 2606080 bytes, baseline 2495 plus unchanged 50. Host measured 2605209 bytes; other limits remain unchanged |
| Full native regression | Three unchanged `npm test` runs on Code 1.144.0 returned 423 pass / 1 cleanup failure, 437 pass / 3 transport failures, and 436 pass / 4 transport failures. Later isolated successes do not erase these failures |
| Native diagnostic follow-up | The schema-cache group passed 23 isolated cases; four isolated transport cases passed. A reduced 15-case ordered run failed 12 pass / 3 fail. Optional phase logging reproduced cleanup overlapping the next test after the five-second timeout; the temporary logging was removed and tests recompiled. No assertion or timeout was changed |
| Normal first activation | Fresh `kw-log25-standalone`, normal CLI 0.1.23, unchanged four-step feature and authentic Code 1.143.0. URI-only call 104 failed after 30215.6237 ms with no live bridge or read-only fallback. Classification `TYPESPEC_FIRST_ACTIVATION_FAILED`; required `firstResponses` is absent, not a thirteenth true check. The other 12 checks passed |
| Correlated native progress | Activation trace 1: lifecycle finished in 1 ms, `openWith` in 200 ms. The five-second pending snapshot was in recovery, with one active custom tab and clean version-1 document. Background-owner/operation membership was false and mutation count zero. Recovery returned false at 30205 ms, followed by normal observer stop with no suppressed records. Provider trace 2 shared the URI hash |
| SDK / renderer boundary | Capture was complete and restored, with all quality/loss counters zero. All 118 dispatcher probe posts settled true; no inbound record was observed. Native renderer logged `webview ready`. This differs from the earlier pending-post failure and does not prove application script execution or identify a script failure |
| Existing Output capture | Normal capture retained 4699 characters from `Kusto Workbench`, including the new observer records. Manifest source was `cdp-fallback`, controller length zero; fallback can read native backing logs and is not proof of a successful CDP connection |
| Preservation / exclusions | No saves or damage; exact archive, helper, 178 runtime files, loaded Code identity and clean native source checks passed, as did cleanup. Pending and post-failure renderer observations each timed out at four seconds. Failure screenshot capture could not find the target PID; no visual review occurred. The prefix profile remains unused because standalone failed |

The frozen runtime is `%TEMP%/kw-log25/e`. Its host SHA-256 is
`3b85d393650c14daee5af7fbec2f6b777efdbf4135eccfc5380bf67b13f288d6`;
`%TEMP%/kw-log25/manifest.json` has SHA-256
`4898944c4c1bde212e26c8af733281ddf95860b6ee42134dc51180487dfd52e4`.
The source helper, original feature and parsed acceptance-function fingerprint
were pinned before launch and remained unchanged. Authentic cached Code was
copied with its original completion marker. No timestamp-only setup gate,
authentication-store copy, extra observer, warming call, retry, query or Save
was added. Native regression Code 1.144.0 and acceptance Code 1.143.0 are
different builds and must not be conflated.

Normal artifacts: `%TEMP%/kw-log25/e/tests/vscode-extension-tester/runs/20261029-233229`.
Acceptance receipt: `%TEMP%/kw-acceptance-In03m2/evidence/final-outcome.json`.
The normal scenario capture includes `_capture-manifest.json`, Workbench,
controller, extension-host and renderer logs. Preserve this failed first call;
do not run prefix 100-103 or treat the old standalone pass as current-build
authorization. The remaining application-startup boundary needs evidence, not
a speculative readiness fix or a declaration that VS Code is at fault.

### Logging Coverage Ledger

| Owner / transition | Setup, action and exact oracle |
| --- | --- |
| Named-channel admission | [Logger tests](../../../tests/webview/host/workbenchLogger.test.ts#L10) set global Trace but named-channel Info, or make channel access throw; starting observation creates zero subscriptions, state reads, timers and observer output |
| Event bounds / failure containment | The same logger test group sends 64 matching events: 30 initial/event records, then reserved pending and stop produce exactly 32, with `suppressed: 35`. Registration, metadata, sink and cleanup faults stay contained; late callbacks perform no reads or output, and no raw URI, text or private error is emitted |
| Composed activation phases | [Orchestrator observer test](../../../tests/webview/host/toolOrchestratorConnect.test.ts#L2506) holds lifecycle, open and recovery separately, injects matching and unrelated events, checks correlation, no pending at 4999 ms and exactly one at 5000 ms, unchanged native operation counts, one release, final stop and zero remaining timers |
| Failed activation branches | [Orchestrator failure cases](../../../tests/webview/host/toolOrchestratorConnect.test.ts#L2626) inject lifecycle, open, recovery, release and registration failures; exact results/error identity and operation counts remain unchanged, with one stop and no late activity |
| Real composed lifecycle | LOG25 exercises the existing [first-call oracle](../../../tests/vscode-extension-tester/e2e/opt-in/typespec-first-activation/typespec-first-activation.feature#L770): fresh URI-only activation through recovery failure, native version/byte/clean checks and exact cleanup. This is native failed-recovery evidence, not successful activation; other observer branches above remain unit evidence |

The native phase probe found one rejected-command fixture spending 4316 ms in
`resolveCustomTextEditor`, completing both command deliveries at 4500 ms, and
starting cleanup at 4501 ms. Cleanup settled and restored process-global mocks
at 5022 ms, after Mocha had started the next suite. This proves overlap, not the
cause of the resolve delay. The existing test wrapper also drops optional
transport arguments, so late restoration can contaminate following guard
tests. These direct-provider fixtures do not initiate the new activation
observer. No product attribution or regression clearance follows from that
fact. The probe's first launch wrapper stopped at package-export resolution
before tests; the corrected launch supplied the actual 12/3 diagnostic run.
`@vscode/test-cli` does not export its package metadata: resolve its declared
binary from the installed metadata file rather than importing that subpath.

Earlier 9312-test coverage and 538-pass script receipts below predate this
logging change. They are historical evidence, not current full-suite passes.
Original workflow completion, successful first activation, prefix execution,
GUI qualification and the native regression gap remain explicitly unverified.

Final post-edit review found no new critical or warning defects in the scoped
implementation or documentation. Its manual follow-ups are not executed and
must use separately authorized disposable copies, never retry the retained
failed first call or proceed to the prefix:

- With global Trace but named Workbench Info, activate once: expect no observer records; any such record is a gate regression.
- With Workbench Trace, activate a separate copy, then switch unrelated tabs and idle five seconds after settlement: expect one correlation, at most 32 observer records, one stop and no later activity or raw paths/content. Cross-target records or repeated pending/stop activity are regressions.
- Leave an untouched copy under Auto Save through activation and idle: expect exact bytes and a clean native document. Any unrequested save, dirty transition or changed bytes is a regression.

## Historical Verification Checkpoint: October 29 Before Correlated Logging

Status: INCOMPLETE. The deferred native invalidation mechanism has a controlled
red/green regression, but the original three workflows are not all verified.
No tests were run for this documentation update.

| Scope | Latest evidence / limit |
| --- | --- |
| Controlled readiness race | A real native document, two overlapping requests and two accepted generations remain unready when persistence invalidation is dropped while the second ACK is pending. The baseline passed and the race failed before the fix. The unchanged race now passes through the same first readiness promise, preserving two projections, two admissions, clean version 1 and exact authored bytes |
| Focused native controls | 37 passed in 4 seconds, including independent policy, physical settlement, source/version ABA, owner/runtime retirement, disposal and third-invalidation controls. A separate consumed-follow-up red produced seven projections; the unchanged green produces four with no renewed allowance despite remaining attempts and time |
| Full native regression | `npm test`: 440 passed in 3 minutes on VS Code 1.144.0, exit 0. Existing local-history ENOENT and fixture EPERM warnings remain visible. Raw receipt: `%APPDATA%/Code/copilot-terminal-output/copilot-terminal-output-c0df4379-0082-4ded-ab4b-b669ba520e46.txt` |
| Protocol inventory | 80 passed after reviewing the unchanged validated command-result sender and updating only two source coordinates, `5565:10` to `5636:10`. The preceding 78-pass / 2-coordinate-failure result remains retained |
| Production package | All three typechecks, lint, all 12 bundle caps and bootstrap packaging passed. The user explicitly approved only the host cap increase to 2543 KiB: baseline 2493 plus unchanged 50 KiB buffer, 2604032 bytes. Other limits, including webview 3349 KiB, are unchanged |
| Full coverage | 9312 passed, 4 existing skips; 372 passing files and 1 skipped file; 974.32 seconds; statement coverage 53.58% (34812/64971), official gate passed. No product changes followed this gate |
| Full scripts | 539 total: 538 passed, no failures or cancellations, 1 existing skip; 303233.9292 ms. Raw receipt: `%APPDATA%/Code/copilot-terminal-output/copilot-terminal-output-123d38e7-38b0-43fd-89ef-7fe5639e2504.txt` |
| Real workflow evidence | Original r16 first activation failed after 30292 ms before observed webview ingress. Diagnostic KDC20 instead captured successful bootstrap, resources, both ACKs and drained counters, followed by a failed first activation after 31124 ms. Required-generation state was not captured, so attribution to the controlled mechanism remains conditional until a fresh real-workflow green |
| Current frozen product | Host 2603047 bytes, SHA-256 `4fc449aa5e29c909c61145bc318b83775011a1bd7490d6b2ad9ad3496f105692`; webview 3425860 bytes, SHA-256 `ac2e294fcddfd3c729c13d1a5ab922bed367c8126c4246611a96ea1b8632b04a`. New ka21 manifest `ddd0f937fda810a440e46d05c7396ceadb02e7ae339f265d6e9f6034b8343629` pins the unchanged normal feature, helper and authentic Code 1.143.0. Native regression Code 1.144.0 is a separate build |
| Current normal first-call failure | Fresh r22 returned first-104 failure after 30309 ms: zero webview ingress and 116 native posts pending until disposal. No document request or projection started, so the deferred-invalidation fix was not traversed. Source, versions, dirty state and SDK capture were preserved; this startup failure remains unresolved |
| Current normal functional pass | The unchanged four-step CLI scenario passed in fresh tss-r23; first URI-only 104 succeeded in 1855.3879 ms, all 13 checks were true, complete SDK capture had zero quality counters, and bytes/version/clean state were preserved. The separate observer triggered after the call and never connected or evaluated. Its diagnostic qualification and first shutdown checkpoint remain failed; later cleanup reached zero. This functional pass does not create strict ka21 readiness or erase r22 |
| Composed diagnostic prefix | One authorized standard-CLI diagnostic used that exact normal PASS receipt in fresh tsp-r21. Call 100 passed in 4794.097 ms; call 101 remained pending for 178111.202 ms until framework cancellation. Calls 102-104 were never made. Native opening began but no matching provider entry, open completion or recovery appeared. The 180000-ms step timeout and missing final normal artifact remain failures; private diagnostics do not replace acceptance |
| Preservation and cleanup | Prefix24 preserved all 185 original completed-standalone/profile/evidence file facts and inventories, all 178 runtime files and the manifest. No retries, Save, query execution or dirty discard were used. Its private cleanup/observation gaps remain recorded; the later exact owned-process/listener checkpoint was zero. Automatic captures were retained without image viewing |

Deferred invalidations wait outside the URI queue for their exact projection's
physical settlement, then require fresh canonical proof under that queue. They
do not bypass readiness, extend deadlines, renew retry budgets, remove saved
attachments, or make SQL/linked/session states eligible for native retention.
The full acceptance path remains a fresh normal standalone activation followed
only on success by a separately isolated prefix 100-103 and first activation
104. Earlier setup, shutdown, capture, shared-store and activation failures stay
failed and retained; diagnostic passes cannot replace normal acceptance.

### Historical Framework Proposal: Pending Native Open Progress

**Withdrawn as a required dependency.** The proposal below predates the
correlated logger. Existing normal capture already retained 40253 Workbench
characters from prefix24, and LOG25 retained the newly emitted phase records.
Missing emitted progress was not proof that the framework could not capture
it. Additional native diagnostics may still be useful, but no framework
modification is currently required or authorized. The observations below remain
historical failures; LOG25 did not rerun or explain prefix24's call 101.

**What I was trying to do:** Complete the single first-call prefix 100-103,
then first activation 104, using disposable archived copies on the current
verified product. Prefix24 is retained under the normal run
`%TEMP%/kr21-8b9e/tests/vscode-extension-tester/runs/20261029-175320` and the
attributed private evidence root `%TEMP%/kw-acceptance-Hjxk4u/evidence`.

**Observed gap at that checkpoint:** Request-correlated native
progress from command receipt through text-model resolution to custom-editor
provider dispatch/return, including the pending await and cancellation reason.
The then-current emitted logs and CDP attempts did not distinguish these
stages. This was not proof of a capture-framework or VS Code defect.

**What I observed:** Call 100 returned genuine live success. Call 101 URI hash
`4c684f844d56cd8597ec23400fed153bdd61649de6712985c7b26f06bd5fe3bd`
completed lifecycle acquisition at 17:53:41.776 UTC and entered native
`openWith`, with no matching provider entry or open completion before
`Canceled` at 17:56:39.878 UTC. A pending observation at 17:53:46.772 UTC found
the exact tab active but no native document; CDP timed out during connection,
before evaluation. URI-less native `openTextDocument` log entries are only
temporally correlated. Calls 102-104 were not made.

**What I already tried:** Ordinary product activation/provider logs, normal
Workbench and Controller output capture, retained renderer/main/extension-host
logs, the actual SDK observer before activation, bounded pending and
post-failure observations, and a one-shot native-ready performance observer.
The normal standalone functional pass and the distinct controlled readiness
fix do not identify the native-open stall. Prefix24's SDK recorder observed
only call 100's panel, so loss counters of zero do not establish call-101
coverage. Private cleanup and the initial shutdown gap remain failed even
though later process/listener checks were zero.

**Originally proposed additional instrumentation:** Add a supported, bounded passive
observer or native trace collector for the actual owned window's command/model
bridge. Bind one request token and URI hash to command admission, model
resolution entry/exit, provider dispatch/return, pending stage and terminal
cancellation. Record observation gaps and loss explicitly; preserve the first
public result and physically pending work through normal shutdown. Preserve
receivers, arguments, promise identity and errors. Do not retry, reveal, reload,
Save, query, inspect credentials, or capture document/console payloads. Validate
exact process/profile ownership and use only requesting-user diagnostics. Test
transparency, bounded capture, cancellation and ownership in the framework;
do not weaken this extension's acceptance oracle or increase its deadlines.

**Suggested Gherkin step syntax (if applicable):**

```gherkin
Given native open progress is observed for the exact task-owned URI
Then I collect the first native open outcome without retrying it
```

**Original priority:** blocking for attribution of the pending native-open failure,
not evidence that the earlier product fixes or all original workflows are
complete. No authorization to edit the separate framework repository is
assumed. This withdrawn proposal preserves the bounded prefix24 evidence and
its then-missing stage; it is not a prerequisite for the current logging work.

## Historical Verification Checkpoint: October 28

Status: INCOMPLETE. The original three bugs are not all fixed. This short ledger
records the parent's latest receipts; older records below remain intact and do
not qualify the new fix. No tests were run for this documentation update.

| Scope | Latest evidence / limit |
| --- | --- |
| Native conditional readiness | Genuine native red in 2 seconds: an actual same-authority automatic conditional negative ACK left readiness false despite clean real-document source. The unchanged reproduction passed after the fix in 716 ms. The issued/required/accepted generation contract and strict retention fences are documented beside native projection readiness in `ARCHITECTURE.md` |
| Focused native controls | 15 passed in 3 seconds: five prior ordinary controls plus ten automatic cases, including separate policy-before and policy-after cases, preparation failure, runtime replacement, explicit rejection first, superseded fresh proof itself returning false, disposal, real source/version ABA, and later local persistence of query 2 through the actual readiness callback |
| Ordinary logging / focused regressions | Tool activation and provider-entry phase logs use hashed URIs; legacy raw paths remain, so this is not whole-log sanitization. TypeSpec harness checks: 90 passed; logging host ring: 327 passed. One line added to the existing message-handler native-session probe passed. Two protocol failures were only reviewed source coordinates (`5506:10` -> `5565:10`), with the same validation/delivery sender verified; the corrected three-file ring passed 407 tests |
| Full native regression | `npm test`: 427 passed in 3 minutes on VS Code 1.143.1. Cleanup logs include `EPERM` after fixture deletion; these were not test failures, and this is not a zero-warning claim |
| Latest product E2E failure | `r13` failed at prefix 100 after 31474 ms: generation 1 accepted, then `forceReload` generation 3 negatively acknowledged before persistence, leaving active 1/latest 3 at a dead end. A pending metadata observation completed and captured a clean native model at version 1; this is not continuous responsiveness or message-listener proof. Raw expected/actual revisions were not captured; attribution remains conditional, not proof of every prior root cause |
| Full coverage gate | 9312 passed / 4 existing skips, 372 passing files / 1 skipped, 980.65 seconds. Statements 53.58% (34812/64971), branches 49.67%, functions 56.02%, lines 56.34%; gate passed |
| Full script regression | 539 total: 538 passed, no failures or cancellations, one existing skip, 356175.8032 ms. Raw receipt: `%APPDATA%/Code/copilot-terminal-output/copilot-terminal-output-3b60eb84-2359-4986-a970-7180a37d8992.txt` |

Full native log:
`%APPDATA%/Code/copilot-terminal-output/copilot-terminal-output-aa82f984-b5e7-4aca-b071-baf59ee25577.txt`.
All three typechecks, lint, and package now pass after the user-approved host-only
2 KiB increase: baseline 2491 + unchanged 50 = 2541 KiB (2601984 bytes).
Measured host: 2601171 bytes, previously 1235 bytes above the 2539 KiB cap.
Only host baselines in `esbuild.js` and `scripts/bundle-size-gate.mjs` changed;
other limits, including webview 3349 KiB, are unchanged. A fresh
`npm run package` passed after both full suites; its raw log is
`%TEMP%/kw-readiness-package-8b9e28.log`. Measured host SHA-256:
`b5445c1e8154facab2bda727c3aed88ea3c797dd645e7df3fb5a6b4790eb0414`.
Webview remains `ac2e294fcddfd3c729c13d1a5ab922bed367c8126c4246611a96ea1b8632b04a`.

Current-build E2E remains PENDING. Historical pre-logging evidence only:
9299 passed / 4 skipped, 53.58% (34812/64971), native 417 passed, and Node 504
passed / 1 skipped. None qualifies the new fix.

The original hidden checkpoints remain unreached, the TypeSpec prefix is not
qualified, and current-product E2E is required. Earlier Kusto I1 reopen and the
old SQL profile's dirty-restore finding remain open; the earlier live SQL
functional pass retains its preceding-build, account-consent, and recorder
caveats below. This native fix does not explain all `r10` native-open hangs or
the `r11` setup timeout. CDP `defaultTarget` chooses the first inspectable page;
an attachment timeout does not prove a frozen main workbench. The framework
request below is withdrawn in favor of ordinary logs and existing CLI capture.

## Historical Verification Checkpoint: October 26-27

Status: INCOMPLETE. This checkpoint supersedes the older totals and "final"
wording below; earlier failures and receipts remain historical evidence.
First-operation ownership, SQL structural identity/configure-only admission,
Save completion, and automatic primary-schema authentication defects have
focused red/green coverage. The original hidden and prefixed TypeSpec acceptance
paths are not closed.

| Contract | Exact path and oracle | Current evidence / decision |
| --- | --- | --- |
| Fresh SQL identity | CREATE SQLX with `reveal:false`, Save, LIST; per-file inventory exposes only the actual `{id,type}`, without source changes or ownership transfer | Existing: `lists the real unconfigured SQL section after background CREATE and SAVE without handing off ownership` plus privacy, source/version, runtime, mapping, cancellation, and peer-delay assertions in `toolOrchestratorConnect.test.ts`; focused file 313 passed |
| Configure-only and removal | Advertised ID -> source configuration -> Save -> actual close notification retires ownership -> reopen -> live configuration -> Save; retain both separate first-removal flows | Existing: three native `background-created` scenarios in `kqlxMarkdownOwnership.test.ts`; adapted frontend and offline SQL adapters, not authenticated query proof |
| Authenticated SQL I1 | Stored `SELECT 1 AS Probe` -> CREATE without reveal -> Save/LIST -> first configure/execute without query replacement -> rendered/durable result -> close/reopen -> execute-only -> fresh producer -> clean Save | Functional pass on preceding `85fcc734...` build, after the user allowed Microsoft-account access. First execution 16860 ms, reopen 732 ms, execute-only 6378 ms. CLI 0; strict recorder 1 because connection-store inode/timestamps changed despite identical bytes/hash. Keep that failure; writer unobserved. See `%TEMP%/i1r-8b9e26/report.md` |
| Automatic primary schema | Native restore before connections exist -> later automatic reconciliation -> one noninteractive cache-miss fetch -> delivered/applied schema; explicit controls retain their own permission | Existing: genuine composed red, then 154 tests across `kw-query-section-loading.test.ts` and `queryEditorSchema.test.ts`; pending-database ABA, account/protection changes, and both auth-mode coalescing orders covered |
| Native schema controls | Rendered Refresh Schema plus actual FlaUI Ctrl+Space in the exact Monaco editor | Partial: real refresh changed the prepared catalog; native keypress produced visible suggestions and ready worker. Fresh silent authentication returned no usable session without an interactive attempt. Successful automatic network acquisition remains unverified. See `%TEMP%/kw-native-schema-20261026-8b9e9b92/report.md` |
| Hidden canary | Exact note then valid six-binding/one-source dashboard baseline -> continuously hidden prefix -> notes then dashboard at 19/32, before inventory | Defer: current baseline passed (6491/176/76 ms); prefix 1-5 passed, 6 remained pending until the 240-second framework deadline. Both hidden checkpoints unreached. No long-duration root reproduction or recovery claim |
| TypeSpec first activation | Fresh standalone -> separately qualified fresh prefix 100-103 -> first activation of exact archived 104, without warming/retry | Standalone qualified at 2398 ms. Prefix 100-103 passed; 104 remained pending until framework cancellation at 166215 ms. No returned product response; capture overflow 344 and incomplete cleanup. See `%TEMP%/ka7-8b9e/final-verified.json` |
| Earlier Kusto I1 and SQL restore | Kusto first execution/Save -> reopen -> fresh execution; separately observe dirty custom-tab versus clean native model during profile restoration | Defer: earlier Kusto reopen lost its bridge. The old SQL profile's mismatch preceded model resolution, with no later correlated snapshot. Fresh profiles do not close either finding |

Current production identifiers:

```text
Host: cdcc2310f7f860dbd3c4f22c7f1f5eebd3e22018952b2607b7254f7b8dd2a5d9
Webview: ac2e294fcddfd3c729c13d1a5ab922bed367c8126c4246611a96ea1b8632b04a
Host bytes/cap: 2599385 / 2599936 (2539 KiB)
Webview bytes/cap: 3425860 / 3429376 (3349 KiB)
```

Package: all three typechecks, lint, and 12 bundle gates passed. The host cap
increase was explicitly approved; all other limits and the 50 KiB buffer remain
unchanged. Current Node suite: 505 total, 504 passed, one existing prerequisite
skip. Current default native suite: 417 passed, exit 0. Final post-auth-fix
coverage is PENDING; the earlier 9253/4 at 53.06% is a pre-fix receipt, not a
current qualification.

Retain the native regression chronology: 377/40 exposed a test budget shorter
than its intentional lease/snapshot waits; its local budget was corrected.
The next 398/19 run included a real lease expiry before a 6755 ms native commit.
An opt-in diagnostic 417-pass run did not establish the cause. Normal fixture
diagnostic I/O was subsequently deferred, with all return-time snapshots and
assertions retained; default 417-pass runs then completed. Do not infer the old
delay's cause solely from those passes. Windows journal rename failures were
reproduced and fixed with bounded metadata-only retries, without replaying tools.

The user permits new testing profiles when they unblock capability without
destabilizing existing work, never to avoid fixing a broken path. Named I1
profiles require exact root/user-data/native-argv and approved-target checks.
Never copy auth stores manually, discard failed dirty fixtures, or revert the
user's later profile edits. Normal account-consent UI may require the user:
the SQL session completed only after "Allow access to my Microsoft account".
The unchanged connection form was canceled, not saved or tested again.

The original runtime was VS Code 1.143.0/087f..., current E2E uses authentic
1.143.0/2d0b..., and native integration uses 1.143.1. These are not identical
builds. E2E uses production-built assets in Development hosts. The user-provided
connection-success screenshot supports that UI state only; no automated visual
or installed-Production qualification is claimed.

### Withdrawn Framework Request: Correlate Pending Native Opens

**Status: WITHDRAWN as premature.** The user preferred ordinary product logs.
Existing CLI post-failure capture already works through its CDP fallback
(`r9Workbench`: 158947 bytes; `r12`: 205359 bytes), without framework changes.
The request, priority, and observations below are retained as historical
evidence, not an active framework prerequisite or proof of a main-process freeze.

**What I was trying to do:** Complete the unchanged hidden-canary and archived
TypeSpec first-activation sequences, preserving every first response and file.

**What step/capability is missing or broken:** A supported URI-correlated native
IPC progress audit before `openTextDocument` returns, through model resolution,
provider entry/return, HTML/control delivery, and final settlement. Implementing
this in the framework repository requires separate authorization.

**What I observed:** The current TypeSpec 104 call started at
2026-10-27T06:24:57.947Z. Native logs contain `vscode.openWith`, `_workbench.openWith`,
and two URI-less `openTextDocument` invocations, followed by no attributable
model/provider progress before framework cancellation. These entries are
time-correlated, not an exact target identity join. The bounded SDK recorder
overflowed; no captured 104 panel does not prove that no panel existed. Four
clean tabs remained at the last cleanup observation; normal host shutdown later
reached zero processes. Artifacts: `%TEMP%/ka7-8b9e/final-evidence.json` and
`%TEMP%/kw-acceptance-yXXBLO/evidence/call-104-response.json`.

**What I already tried:** Exact immutable originals, first-call preservation,
independent standalone and prefix hosts, native text/custom-editor controls,
SDK before-ingress recording, raw renderer capture with Document rebinding,
post-verdict realm inspection, bounded native-window metadata, and current-build
automatic-auth suppression. Earlier 30-second projection-ACK failures and this
unresolved native-open wait are distinct observations. Neither synthetic ACK
loss nor a larger product deadline is a root-cause test.

**What the framework needs to support:** Record scalar request/URI hashes,
native stage identity, entry/exit/deadline/cancellation and pending-dialog
metadata independently of the stalled log stream. Reserve bounded capacity for
the exact target and expose loss counters. Never capture document bodies,
authentication arguments, sessions, tokens, or secrets. Preserve receivers,
arguments, return/throw identity and the original first-call result; observations
must not retry, reveal, save, or close the target. Provide transparency tests and
one isolated replay retaining pending operations through normal host shutdown.

**Suggested Gherkin step syntax (if applicable):**

```gherkin
Given native open progress is observed for the exact task-owned URI
Then I collect the first native open outcome without retrying it
```

**Priority:** blocking for attribution of the pending native-open failure,
not evidence that the earlier product fixes or all original workflows are done.

## Historical First Operations and Archived Activation: October 20-22

Status: concrete first-operation ownership, queued-delivery, removal-persistence,
and Kusto connection-publication defects have focused red/green tests. The full
reported workflow is not closed: live Kusto still encountered a four-second
readiness rejection, SQL encountered Tools Service readiness failure, and the
original prolonged-hidden and load-dependent TypeSpec failures are unresolved.
Do not replace these outcomes with passing unit tests or matching error strings.

| Contract | Setup, action, and oracle | Evidence / remaining gap |
| --- | --- | --- |
| First background operation | Real orchestrator CREATE with `reveal:false` -> exact Save -> live LIST -> first removal or Kusto/SQL execution without query replacement; ID/URI and active/hidden cases | Twelve genuine missing-live reds, then green in `toolOrchestratorConnect.test.ts`; physical webview/execution replies are simulated |
| Ownership and dispatch fences | Actual admitted background edit held during public removal cancellation; later Save retains the edit; source/version/connection/runtime changes cannot deliver a queued mutation | Focused orchestrator, provider/session, and gateway tests; stale physical-delivery cases were red before the guard |
| Removal durability | Actual query/SQL webview handler removes the element but withholds success until persistence confirmation; rejected or retired runtime cannot succeed | Six genuine early-response reds, then green in `message-handler.test.ts` |
| Native removal lifecycle | Real native document/provider, background creation, live projection, response at matching native persistence ACK -> immediate public Save -> disk zero sections -> reopen -> implicit starter -> second removal/Save | Two passing `kqlxMarkdownOwnership.test.ts` cases; adapted frontend, not real DOM or query execution |
| Kusto publication readiness | Valid host target, ready dispatcher/native projection, deferred account enumeration and real staged/applied publication before one execution | Premature-post red then green; 28 added preparation, cancellation, identity, and provider tests; does not prove the later live readiness failure fixed |
| Live execution lifecycle | First configure/execute without `query` -> real Probe result -> Save/reopen -> fresh second producer and Save | Opt-in `background-first-execution`; earlier first Kusto execution and disk result succeeded, but full lifecycle remains unqualified. Latest current-build first request failed at the four-second gate; SQL failed STS readiness |
| TypeSpec first activation | Unchanged 54,487-byte archived copy -> exactly one public URI activation -> live/non-fallback response -> unchanged clean source and exact close | Standalone passed in 1.289 s; fresh prefix trial failed at index 100 after 30.507 s, before TypeSpec. No load-dependent TypeSpec qualification |
| Hidden canary | Exact saved note and valid six-binding/one-source dashboard baseline -> no inventory during mixed workload -> sequential notes/dashboard while hidden -> one ordinary activation only after failure | Baseline passed; prefix 2 failed activation after 30.851 s before hidden checkpoints. Later controller launch failed before product calls. No hidden-outage red/green |
| Bounded diagnostics | Native reload acknowledgment/admission metadata uses the existing 128-record cap and two reserved terminal records; throwing sinks cannot affect readiness | Five native diagnostic scenarios pass; new fields are numeric/boolean only. Existing timeouts and startup decisions remain unchanged |

The user explicitly approved an initial host limit of 2528 KiB and then a final
2532 KiB limit after the additional target/runtime guards (baseline 2482 plus the
unchanged 50 KiB buffer), leaving every other limit unchanged. The final measured
host is approximately 2531 KiB. Earlier 2528 KiB builds predate those guards;
the final production package passes all three typechecks, lint, and all 12 size
gates at 2531/2532 KiB for the host and 3344/3349 KiB for the main webview.

Final repository regressions: coverage gate passes with 372 passing files and
one existing skipped file, 9,121 passing tests and four existing skipped tests,
and 53.06% statement coverage. All 395 native integration tests pass. The complete
Node script suite has 351 passes, zero failures, and one existing recorded-build
prerequisite skip. Full logs are `%TEMP%/kw-final-coverage-verified-oct22.log`,
`%TEMP%/kw-final-native-oct21.log`, and `%TEMP%/kw-final-script-regressions-oct22.log`.
These gates do not qualify the remaining live E2E paths; their last failed
attempts predate the final target/runtime guards and require a fresh runtime run.

Final review additions have their own red/green cases: registered-but-loading
readiness before publication, immutable execute-only section/target expectations
without retargeting, both real compatibility providers forwarding queued guards,
and early dirty/tabless-document refusal in the opt-in harnesses. All starting
documents are preserved, not only those associated with visible tabs. The first
full coverage attempt was interrupted after exposing a stale six-trigger source
assertion; a second interrupted attempt exposed missing lifecycle fields in the
provider fixture. Both are failed/incomplete evidence, not passing gates. Their
focused corrections passed before the final complete coverage run. The final
post-edit review found no remaining Critical or Warning findings in its scope.

Use sequential terminal execution, including across agents: the terminal/CWD is
shared. Parallel terminal work mixed output and ran one `npx` invocation in a
frozen extension directory; its unwanted installation prompt was cancelled.
Do not credit commands without an actual completion receipt. Watchers can also
replace parent `dist` output without changing source: build an immutable private
source snapshot and verify runtime hashes before and after real E2E trials.

VS Code 1.143.0 may be absent from the download catalog. The official test-electron
cache accepts a verified copy of the authentic signed runtime under
`.vscode-test/vscode-win32-x64-archive-1.143.0`, with its normal completion metadata.
Do not patch the downloader, relabel another version, copy user authentication,
or touch the normal installation. Retain earlier setup failures. The standard
named-profile launcher refreshes managed auth metadata and window-restore state;
the user explicitly approved those effects for inactive `kusto-auth` and
`sql-auth` profiles only. Preserve starting clean tabs instead of assuming an
empty window, and never discard a dirty failed fixture.

Private evidence is retained under `%TEMP%`: `kw-acceptance-9r66XT` (TypeSpec
standalone/prefix audit), `kw-acceptance-Hw6OP9` (valid canary then prefix failure),
and `kw-i1-private-source-20261021-8b9e9b92` (live execution trials and immutable
builds). None of these claims visual qualification or proof of all SDK probe/ACK
phases. Existing saved results and all archived originals remain unchanged.

## Compact Tutorial Footer: October 20

The `520px` media query must not force `.compact-utility-strip` into a column or
make its actions full-width. Let the footer and action strip wrap naturally.
The compact Mute menu anchors to the action strip, not the narrower Mute button;
otherwise the narrow-screen menu rule squeezes labels into approximately 61px.

Coverage ledger for the shared `kw-tutorial-viewer` CSS:

| Path | Evidence / decision |
| --- | --- |
| Embedded file open -> loaded media -> resize -> footer geometry -> real Mute toggle -> open-menu bounds -> real Got it -> overlay gone | `did-you-know-embedded-popup` outline, actual webview widths 486/346/926px; include the reported breakpoint, separate navigation wrapping, and wide control |
| Original stacking | Run `20261020-171418`: genuine red at 486px, footer 120px; all actions share X but have different Y values |
| Menu counterexample after initial footer repair | Run `20261020-173013`: genuine narrow-menu red, width 60.7px/client 59px/scroll 100px; wide menu assertion passed before an unrelated capture failure |
| Final footer and menu | Run `20261020-173205`: 3/3 passed on VS Code 1.142.0; 346px menu width 280px, fully inside viewport, no horizontal overflow; exact-window capture metadata valid |
| Standard and empty compact controls | Existing `did-you-know-compact-actions` run `20261020-172517`: 3/3 passed; empty Got it alignment, wide close placement, adaptive controls/scrollbar and real dismissal; predates only the compact menu anchoring follow-up |
| Persistence, auth, revisions, document formats | Exclude additional lifecycle matrix: only shared presentation CSS changed, with no message, state, or persistence changes |
| Widths below the measured 346px | Deferred: the outline asserts fitting actions share a row; it does not claim coverage of the action strip's own wrapping at smaller widths |

Run `20261020-172040` failed only during screenshot foreground capture after all
three geometry and Mute-toggle checks passed. Keep it distinct from the later
passing runs. Screenshots were captured and metadata reviewed, not visually
inspected because image-resource retrieval has disrupted this user's chat.

Final regression gates after the menu follow-up: `npm run test:webview` passed
9,028 tests across 372 files, with four existing skipped tests in one file;
`npm test` passed all 391 extension-host tests on VS Code 1.142.0. The normal
compile, all three TypeScript checks, and lint also passed.

## Prolonged Hidden Access: October 15 Evidence, October 16 Blocker

Status: the reported continuously hidden four-second access outage remains
unreproduced in an independently observed runtime and is not fixed by this
investigation. The earlier native final-sanitation overlap fix and its five
fast integration cases remain intact; their final error strings do not qualify
this different failure phase. Do not add a 24/25-minute regression or treat that
elapsed time as an established threshold.

The user supplied the report at
`C:/Users/angelpe/source/dogfooding/vscode-kusto-workbench-dogfood/extension-prolonged-access-retest-2026-10-15.mdx`
and the immutable archive at
`C:/Users/angelpe/AppData/Local/Temp/kw-prolonged-access-before-2026-10-15-a2ba55ee9a1b42e495d52479c8604b8e.zip`.
Read-only ZIP inspection verified 856,415 bytes and SHA-256
`d8471f77cac73d133f935b83d24630cece4e5168ee80f9f74c59ee6a78432cf2`.
The current report matched its archived copy. Nothing was extracted over or
written to the original files.

The exact URI/path join covers all 109 successful historical activations.
`evidence/hidden-full-load-inventory.json` contains 110 task-owned files plus one
pre-existing fallback: 80 task-owned unavailable snapshots include the canary,
leaving 79 historical failures. Unavailable counts are 68 KQLX, nine MDX, and
three SQLX. Nineteen plain KQL/CSL/SQL files retain live metadata; eight Markdown
files are expected fallbacks. These flags do not independently prove API access.
The three healthy rich files are indices 106-108, but 17 healthy plain files were
opened before the newest failed rich file at index 104. Neither a type-only nor
a recency-only causal conclusion is established.

`evidence/observed-canary-calls-and-responses.json` records sequential notes then
dashboard calls. Baseline durations were 31/88 ms at 19:31:33 UTC; after 19 files,
38/101 ms at 19:36:46; after 109 files, 4,092/4,125 ms starting 19:57:33.102 and
19:57:37.197. Inventory followed qualification. Responses are semantic
transcriptions, not raw captures; loaded build/window, SDK send/ACK receipts,
per-file last visibility, and the first failing transition were not recorded.

### Short Investigation Attempts

All attempts used the existing framework, retained first failures, and requested
no data queries. No original notebook or normal F5 window was used. The user
explicitly approved use of the inactive isolated `kusto-auth` profile and later
approved the standard launcher's reset of that profile's stored window/workspace
restore metadata. This does not authorize resets of normal profiles.

| Run | Actual boundary reached | Classification |
| --- | --- | --- |
| `runs/20261015-214420` | New synthetic canary activation succeeded; actual gateway probe/ACK traces were captured; setup then treated `panelFor()` metadata as the SDK panel instead of using `.panel` | Harness setup failure, corrected before later attempts |
| `runs/20261015-215156` | Existing fresh-profile persisted-result helper failed with `partitionMatches:false` and `cachedDatabases:[]` before notebook calls | Fixture setup failure, not outage reproduction |
| `runs/20261015-215313` | One unchanged fresh-host retry produced the same pre-baseline owner/cache failure | Fixture setup blocker; do not loop or relax admission |
| `runs/20261016-023604` | Approved prepared-profile launch found Workbench already active before the test script could install its observer; no notebook calls followed | Pre-activation observation blocker |

Experimental opt-in gateway traces passed 98 calibration tests, but these tests
did not reproduce the outage. The experimental host bundle exceeded the unchanged
2524 KiB limit at approximately 2527 KiB. Review also found async-sink rejection,
cleanup, settings-restoration, and incomplete phase/runtime-proof risks in that
unqualified experiment. Only this investigation's diagnostic/probe additions and
their new tests were removed with context-checked inverse patches. The earlier
fixes, unrelated dirty work, all four run artifacts, and private evidence remain.
The restored gateway/provider/protocol ring passes 194 tests; production
typechecks, lint, packaging, and all 12 unchanged bundle gates pass. These are
restoration checks, not a new full-suite or outage-fix claim.

### Coverage Ledger

| Contract | Evidence / decision | Remaining gap |
| --- | --- | --- |
| Four-second dispatcher expiry versus five-second state reply and 30-second projection/context waits | Existing gateway/session deadline tests retained | Incident's exact failing phase still needs runtime receipts |
| Native sanitation overlapping resume | Existing five native integration cases retained | Adapted frontend, deliberate resume, and invalid dashboard baseline are not continuously hidden outage evidence |
| Continuously hidden real canary, first notes then dashboard before inventory | Include a short independently observed case after framework support | No completed healthy-baseline-to-hidden-failure experiment here |
| Probe send, renderer receipt, ACK emission/admission, and SDK settlement | Include correlated passive evidence | SDK `true` is not renderer receipt; closure posters do not expose actual panels |
| Tracing and cleanup cannot manufacture a pass | Include rejecting async sinks, saturation, target mismatch, opening/close-time damage, and unconditional restoration | Experimental calibration alone did not establish all these guarantees |

### Framework Fix Request: Observe Actual Product SDK Before Activation

**What I was trying to do:**
Run a short real hidden-webview probe using an unchanged private archived canary
in the approved isolated `kusto-auth` profile. Establish exact original notes,
valid dashboard bindings and saved-result data, hide the canary, then call notes
once followed by dashboard validation once before a complete inventory.

**What step/capability is missing or broken:**
The framework needs a supported pre-activation observer of the actual
product-specific VS Code API, or equivalent controller-owned passive panel and
transport observation installed before product startup. An observer installed
after activation cannot recover provider registrations or the panels enclosed
by opaque `liveConnections.poster` callbacks.

**What I observed:**
The prepared run `20261016-023604` failed at
`Given I collect JSON artifact "hidden-probe-setup" from extension host expression:`
with `SETUP_BLOCKED: requires an inactive observed host; never attach or close starting tabs`.
Workbench was already active. No hidden-canary calls or recovery actions ran.

**What I already tried:**
The three fresh-host attempts and the prepared-profile attempt are listed above.
The first captured real gateway traffic but failed local panel access; that
mistake was corrected. Two later fresh hosts failed the unchanged fixture-owner
admission before opening any notebook. Prepared mode therefore removed fixture
seeding and setup Save, using an immutable archived copy instead. The approved
standard profile restore reset still did not provide pre-activation observation.
No fabricated ACK, substituted state getter, relaxed validity check, query,
manual authentication-store copying, alternate launcher, or normal-profile
workaround was used. The standard framework still performs its normal managed
shared-authentication and Local State synchronization for named profiles.

**What the framework needs to support:**
Implement the capability in the existing `vscode-extension-tester` framework,
not a second profile launcher. Install an explicitly requested test observer
before Workbench activates and assert it sees the actual product API/provider.
Forward receiver, arguments, return values, and physical SDK settlement unchanged.
Capture exact process/build, URI, panel incarnation, renderer runtime, owner-specific
generation, read operation, wait/probe/request, ACK admission, and SDK settlement
identities. Record healthy identity before hiding; later renderer disappearance
is failure evidence, not a new setup failure. Disk hashes or orchestrator-method
presence alone must not certify the executing gateway and renderer.

Use bounded scalar recording with consistent correlation encoding; capture
monotonic timestamps at observation and flush outside measured operations.
Contain synchronous and asynchronous observer failures without awaiting them;
exclude trace messages from sender tracing to prevent recursion. Preserve the
first failure, even when the next original-order read succeeds. Require exact
canary request/reply and returned file/section identities, complete later
per-file inventory results, continuous hidden state, and no dropped evidence.
Register idempotent cleanup before hooks, execute it on setup/step/cancellation
failures, attempt all restorations, compare complete descriptors, and recheck
bytes, dirty/version state, settings, tabs, and execution after closing. Never
discard dirty files, rebaseline after admission, or require a successful renderer
response to retain evidence of renderer loss.

**Suggested Gherkin step syntax (if applicable):**
```gherkin
Given I observe actual product SDK traffic before extension activation
```

**Priority:** Blocking for the required independent prepared-profile observation.
After support lands, keep the experiment short and opt-in. Once a real failing
transition is captured, reduce that transition to a deterministic seconds-long
regression. Do not manufacture a root-cause reproduction by dropping ACKs, forcing
timeouts, or introducing a 25-minute suite test.

## Coverage Planning Gate

Before adding, changing, or claiming completeness for E2E coverage, read and
follow [`../test-coverage-planning/SKILL.md`](../test-coverage-planning/SKILL.md).
Create a coverage ledger that maps the exact composed user lifecycle, state and
transition dimensions, owning modules/protocols, existing exact assertions,
included cases, and explicitly justified exclusions. Do this before scenario
editing and update it after failures expose new branches.

E2E scenarios must use the rendered user control for the interaction under
test. Direct APIs may prepare unrelated state but may not set the value being
verified. A passing test that injects `dataSourceResultIndex`, run mode,
selection, or another control-owned value directly is not evidence for the
corresponding dropdown/menu/button path. Persistence scenarios must assert live
state, durable bytes, reopened state, and a post-reopen interaction. Existing
coverage counts only when its exact setup, action, lifecycle, and oracle match;
test names and nearby assertions are not enough.

`session.kqlx` lives under profile-global `vscode-userdata`, not the workspace.
Multiple F5 Development Host windows that use the same VS Code profile therefore
share one session file and can exercise cross-window autosave conflict handling.
Do not infer the session contract from a single-window fixture alone. Keep the
cross-window write-lock test, and drive the reopened multi-result picker with
native click/keyboard input; assigning `picker.value` and dispatching `change`
only proves the backing handler.

## Activation Recovery Ledger (2026-10-07)

Contract: unavailable live state must not be reported as successful empty notes.
Exact activation must recover the targeted dispatcher and await its current
accepted document projection without replaying rejected requests or changing
authored bytes. Gray legacy rendering remains separately attributed until a
rendered-control and runtime-error probe supplies evidence.

Owners: `MainWebviewStartupGateway`, `QueryEditorProvider`,
`HostWorkbenchToolSessionApplicationHandler`, `KustoWorkbenchToolOrchestrator`,
native projection readiness, compatibility projection recovery, and the webview
dispatcher's canonical state snapshot and correlated document request sender.

Acceptance: ten-section canary with one exact note, Kusto 3x4, SQL 3x6, and six
bindings -> 109 historical primary activations plus ten companions -> exact
URI/ID and repeated same-visible activation -> notes/dashboard and unchanged
120-source byte checks -> clean canary close/reopen with all 109 histories still
open -> restored APIs/results -> authored edit/Save -> second reopen/interaction.
Fixtures are disposable equivalents, not proof of the report's unidentified
installed binary. Its original 119 historical files are not activated or changed.

| ID | Setup, Action, And Oracle | Layer / Decision | Result |
| --- | --- | --- | --- |
| A1 | `toolOrchestratorConnect`: undefined note getter for active/URI/ID, rejected getter, retired deferred connection, unavailable -> authoritative empty -> exact ten-section note snapshot; failure has no fabricated notes | Unit / Include | Red-first, green |
| A2 | Same suite: deferred exact activation callback true/false and retirement while awaiting it; no premature live success or target substitution | Unit / Include | Red-first, green |
| A3 | `mainWebviewStartupGateway`: expired probe -> new runtime -> distinct challenge -> old ACK ignored -> exact ACK delivers new state request; expired mutation never replays; duplicate startup cannot renew deadline | Unit / Include | Red-first, green |
| A4 | Same suite: cold activation and concurrent callers share bounded challenge results; matching ACK true, expiry false; existing queue/retirement tests retained | Unit / Include | Red-first, green |
| A5 | `queryEditorProviderWorkbenchToolSessionHandler`: transport-first ordering, projection checks, failed transport/snapshot, replacement and retirement before/after reads | Unit / Include | Green; initial disposed-harness setup failure corrected |
| A6 | `message-handler`: inactive native/KQL/SQL probe requests one correlated document per challenge; active retained runtime does not reload; throwing serializer emits nonblank canonical error | Webview / Include | Red-first, green |
| A7 | `compatSidecarProjectionCoordinator`: exhausted initial request -> fresh correlation -> accepted current ACK; repeated correlation and automatic retry cannot renew budget; monotonic generation | Unit / Include | Red-first, green |
| A8 | `kqlxMarkdownOwnership`: historical native readiness -> pending fresh projection -> accepted/rejected/host-rejected/disposed result; old ACK rejected and document bytes/version unchanged | Native integration / Include | Four red-first cases green; 62 ownership tests pass on VS Code 1.141.0 |
| A9 | `workbench-tool-session-activation-sweep`: full acceptance above, 110 primaries/120 sources, exact ten section IDs/note metadata, six bindings, 3x4/3x6 tables, repeated activation, siblings retained through clean reopen, actual blank Query Run-options menu | Native E2E / Include | `20261008-011615`: all steps pass in 231969 ms on VS Code 1.141.0; JSON/logs reviewed, visual inspection unavailable |
| A10 | Actual four-second dispatcher expiry, stale matching ACK replay, same-visible fresh-challenge recovery, exact notes/dashboard/rows and byte preservation | Native E2E / Include | `dispatcher-expiry-outbound-20261008`: one fault attempt, 4012 ms, 16 withheld ACKs; expired replay inert; 19 ms fresh recovery and 12 ms repeat; same panel/runtime, clean bytes, exact cleanup |
| A11 | Authenticated Kusto/SQL reruns and unrelated chart/transform/export/privacy Cartesian products | Defer | This slice changes startup/readiness, not execution/publication owners; saved result restoration and existing native ownership gates are not a live rerun claim |
| A12 | Screenshot appearance / exact original gray incident attribution | Defer | Image inspection is prohibited in this conversation; DOM geometry, native menu interaction, logs and byte checks cannot certify screenshot appearance or the unidentified installed build |

Final affected unit gate: 788 tests in nine files. Full native integration:
324/324 on VS Code 1.141.0. The first full integration run passed 323/324 and
exposed an ordinary compatibility request renewing exhausted startup; recovery
was narrowed to fresh `dispatcher-document-` correlations, with non-evicting
64-request bounds. Its existing failing native test and the full suite then pass.
Host/webview/connector types, zero-warning lint, normal production package,
12 unchanged bundle limits, diagnostics, and whitespace checks pass. No commits,
version changes, original-notebook activations, or normal-profile changes.
Final read-only comparison of `baseline.json` from the October 7 audit archive
against its exact dogfood workspace matches all 119 original SHA-256 values,
including ten archived companions; zero files are changed or missing. This is a
byte check only and does not infer current editor dirty state in another window.

The sweep exposed passive SQL connection/database adoption persisting untouched
SQLX, including blank documents. Controller persistence now requires user/tool
intent; passive target clearing retains runtime effects without scheduling a
document write. Automatic result fitting no longer authors height or persists;
saved heights remain exact and explicit Fit still authors the measurement.
New red-first tests cover both paths; the complete SQL component/controller ring
passes 87 tests. These fixes preserve the existing native Save/publication owner.

Earlier runs remain failures, not passes: unresolved synthetic fixture owners,
missing pre-activation SQL helper, unconfigured SQL inventory, wrong table-column
accessor, section-top rather than table scrolling, an unqualified retained-frame
wait, overbroad blank-Run and JSON-key-order assertions, and observing a native
Save before its final clean publication. The final fixture saves only its newly
created canary before establishing the baseline. At most one extra setup Save
admits only an identity-only SQL descriptor transition, with exact authored
content checks; no rebaseline occurs after historical activation. Later native
Save is invoked once and its clean buffer/disk convergence is observed within
ten seconds, requiring a 500 ms stable checkpoint. Data/schema/byte assertions
were not removed.

For retained-frame result waits, always target the exact canary title. With 110
webviews an unqualified asynchronous helper can wait on a frozen unrelated frame
while the actual canary's tables are present. Scroll the `kw-data-table`, not a
tall query section, before requiring its three rows to intersect the viewport.
Kusto main Run readiness is target-based, not based on nonempty query text;
assert it against the public selection-readiness predicate and never execute the
blank control probe. Use the exact CSS toggle in its exact webview.

The first controlled-expiry attempt was harness-blocked: a late capture listener
did not precede the installed dispatcher. The passing test uses the existing
dynamic `__e2eCaptureHostMessage` hook to return false only for canonical probe
ACKs. It does not replace the SDK or alter host readiness; prior hooks are
restored and the expired real ACK is replayed before fresh recovery. Both runs
are retained, and all task-owned hosts/CLI processes are closed.

Exact archived-file and authentic installed-VSIX repetition, authenticated query
reruns, and visual appearance remain separate deferred qualifications. The SQL
table in the sweep is explicitly a saved legacy display fixture, not evidence of
an authenticated live SQL execution or ownership-publication transition.

## No-Op And Cold-Readiness Follow-Up (2026-10-09)

Contract: opening, hiding, revealing, and closing an untouched document must
preserve its exact bytes and clean state with Auto Save enabled. Genuine authoring
and native Save must still work. The original109 acceptance also requires actual
Query controls, exact notes and six dashboard bindings, loaded Production build
identity, native pixels, retained historical tabs, and a second post-reopen edit.
The earlier synthetic sweep is not a substitute for that composed lifecycle.

Owners: webview signature/restoration comparison, gateway dispatcher and outbound
queue, native projection/URI/Save ownership, exact tool connection and inventory,
and the isolated archive/capture/classification harness.

| ID | Setup, Action, And Oracle | Layer / Decision | Result |
| --- | --- | --- | --- |
| N1 | `noncanonical fourteen-section hydration preserves native bytes without an ordering-only edit`: five Markdown, five Query, four Chart sections and opaque fields -> accepted projection -> key-order-only snapshot -> unchanged native version, clean state and exact bytes -> real query change and Save | Native integration / Include | Passed before changing native equality; native `deepEqual` was already key-order-insensitive. Not proof of the incident writer |
| N2 | `does not persist or advance revision when fourteen hydrated sections only reorder object keys`: retain acknowledged baseline without reprojection/reseeding -> reorder serializer keys -> zero persistence and revision changes -> genuine query edit persists | Webview / Include | Red: one `persistDocument`, revision 1. Green after sorting comparison-copy object keys; wire text, values, arrays and result strings are not normalized |
| N3 | `does not persist reordered saved descriptors during deferred result settlement`: saved nested descriptor -> acknowledged clean baseline -> deferred peer settles -> no automatic persistence -> genuine query edit preserves both saved result strings and descriptor | Webview / Include | Red: one automatic persistence. Green after normalizing both comparison operands; the fixture records the real queued-to-settled transition |
| N4 | Cold dispatcher delay and coalesced deadline; held earlier physical send beyond 5.2 seconds -> no premature reload lease -> current dispatch/ACK; source/version/ABA, readiness expiry, disposal, invalid/unsafe projections, preparation rejection and transport rejection | Gateway and native / Include | 78 gateway tests and full 341 native tests pass. Two full native runs exposed lost transport retries, then factory replay; original retry-count and one-shot assertions were retained and both defects repaired |
| N5 | Unavailable and authoritative-empty snapshots; retirement during snapshot, SQL privacy admission and after A settles while B is pending; reveal-false file bridge inspection -> background edit -> explicit activation -> live edit | Host / Include | Red-first unavailable/retired flags, callback-free activation and final fanout races are green. Mutation ownership is unchanged; no healthy-neighbor substitution |
| N6 | Immutable private archives -> fresh marked TEMP root, link confinement and exact 131 before-images -> first clean legacy tab -> one exact-ID activation -> DOM Query controls and actual execution observer | Installed Production / Include | Two earlier runs reached one successful activation, clean 498-byte archival source and zero execution ingress/start. They predate the separate cold-copy fix and do not qualify that lifecycle. Exact executing module/context/tree hashes match the candidate; native control pixels remain unqualified |
| N7 | Pre-staged separate byte-identical cold copy -> exact recorded109 order including archival original target20 and growth target83/checkpoint88 -> close/reopen only the cold copy while all109 histories remain -> real native menu/Escape, separate authoring/Save/reopen/second edit, exact note and six bindings | Composed E2E / Defer | BLOCKED: native pixels/SDK geometry, actual URI/panel/frame mapping, and lawful Production offline result ownership. No fresh host was authorized for the cold-copy follow-up; no installed full109 pass, notes/dashboard completion or image review is claimed |
| N8 | Partial88, missing lifecycle, wrong executing hashes, overwritten host evidence, dirty-then-revert, unsafe links/aliases/cleanup, wrong/blank/fallback pixels and unobserved execution | Harness / Include | Final Node harness/support run passes; negative cases cannot certify partial or metadata-only evidence. Unit capture adapters do not replace native captures |
| N9 | Existing Node test `acceptance cold canary close retains exact109 including archival original target20; closing target20 fails108/109`: stage exact498 bytes before opening, keep original20 plus distinct cold tab, close cold after109, then deliberately close original20 | Node, real private filesystem and SDK-shaped tabs / Include | Red before fix: actual `108/109` after cold close. Green: exact109 retained; the original20 negative still throws `108/109`. No ordinal exclusion, reordering, rebaseline, normalization or file removal |
| N10 | Existing Node test `acceptance session composes first exact-ID cold copy, original109 including target20, clean close/reopen and independent131+1 observers`: metadata lookup once -> exact URI tool -> all109 -> cold close/reopen -> separate authoring copy | Node session with SDK-shaped metadata/tool/tab facades / Include | Exact original order and source hashes retained; archive baseline/source/checked counts131, separate cold count/checked count1. Copy keeps source basename and section ID; clean model generations and close/reopen observed. Not native E2E or Production fact qualification |
| N11 | Six mutations (buffer, disk, dirty document, dirty tab, clean version advance, changed/reverted buffer) at before-activation, before-close and after-reopen; parent collector independently rehashes the cold copy/source and verifies the root marker | Node session and existing parent-identity tests / Include | All18 mutation cases reject before further intent, without changing archival131 state. Existing parent hash assertions remain intact; cold inspection is separate, never blended into primary counts |
| N12 | Exact cold/historical/authoring control paths and source linkage; actual absent panel handle plus wildcard CSP with otherwise matching URI and geometry | Classifier and unchanged control matcher / Include | Separate-copy and archival-frame substitutions reject. `handle:null` plus wildcard CSP remains explicit BLOCKED; no handle is fabricated and no matcher is removed |

Final official coverage: 8,713 tests pass in 372 files, with four pre-existing
skipped tests in one file; statement coverage 52.32%, unchanged threshold. Full
native integration passes 341/341 on VS Code 1.141.0. Host/webview/connector types,
lint, production packaging and all 12 unchanged bundle gates pass. Earlier red
attempts and all failed installed campaigns are retained.

Candidate: `out/releases/vscode-kusto-workbench-0.0.0-placeholder.vsix`, SHA-256
`6b14f0549768a35b85104b175251c133ef487629b79ca2c502b49f0a0e4293bc`.
Executing main SHA-256 is
`2993f705ca59acf27b4114555f809ec26dd052404aee82e15ef507eeeb0428bf`; the 52-file
dist tree matches the VSIX. Actual loaded module and `ExtensionMode.Production`
are recorded, rather than inferred from the manifest version. No release,
original incident-binary attribution, human visual review, or completed109
qualification is implied by these code gates.

Installed attempts: `%TEMP%/kw-acceptance-d54mpo/a1` stopped before its activation
tool call because first-launch Welcome was foregrounded; the harness now admits
one clean exact inactive tab but still requires exact post-tool focus.
`%TEMP%/kw-acceptance-HI7qTh/a1` exposed the SDK treating an undefined frame result
as success; the exact-token guard now rejects that frame. Final
`%TEMP%/kw-acceptance-mSpHlp/a1` reaches the exact inner frame and controls but
refuses native input because native Document geometry is missing or ambiguous.
No screenshots are viewed. All three are failures or blockers, never passes.

Framework blocker: `NativeUIClient.getElementTree(windowId)` has no supported
depth/node/deadline options, while available bridge source limits depth to five
and does not report truncation. The available live CLI also lacks an enforceable
`realNativeOnly` policy. A bounded, PID/HWND-scoped native Document inventory with
explicit truncation and native-only/no-auth isolation is required before the
pixel gate can qualify; do not map a gray region or another document by guesswork.
The default synthetic feature remains unchanged by the opt-in comment-extracted
original109 fragment. Historical archived queries are never executed, original
dogfood files are never activated/restored, and no Auto Save or equality gate is
disabled. Authenticated synthetic ADX execution is a separate lawful owner path,
not an offline fixture or an authorization to use Development seeds.

### Critical Cold-Copy Harness Follow-Up

Only the existing replay harness, existing Node tests and this ledger changed.
The opt-in feature keeps the original basename/section-ID expectations; the
default feature and production code are untouched. Stage the exclusive copy
under `<fresh marked TEMP root>/cold-canary/<original basename>` before any
Workbench opening, outside `history` but inside the SDK's exact owned-root
boundary. Preserve all131 archive bytes/hashes and the 498-byte original20.
Authoring uses its third, distinct copy. Never reuse an old campaign root.

`acceptanceControlPath` is root-relative: cold/menu/Escape/reopened controls use
`cold-canary/<original basename>`, historical83/88/109 use their original
`history/<recorded path>`, and second interaction uses
`history/original109-authoring.kqlx`. Runtime `controlTarget`, parent collection
and classification must agree on those exact URIs, not only a title or section
ID shared by both copies. Cold model text, dirty transitions and same-model
versions are observed independently through close/reopen; mutations before
native intent must reject, including dirty/changed-then-reverted revisions.

Scoped validation: `node --test tests/scripts/published-notebook-journal.test.mjs
tests/scripts/e2e-full-suite-support.test.mjs` passes214/214, zero skips; 43 new
cases, with all previous tests/assertions retained. The first red used the same
retention command as the first harness patch's green validation. The three old
failure campaigns remain immutable:393/393 archived sources and15/15 private
archive/harness/helper/VSIX artifacts rehashed unchanged, no new cold root in
those campaigns. No host launch, network, capture/view, normal profile/auth,
original-file write, production edit, commit, version or gate change occurred.

Parent manual checklist item9: close/reopen the **separate cold copy** while
exactly109 archival tabs, including the original target20, stay retained and
all131 archival hashes remain unchanged. Never reduce that retention oracle.

Pipeline status remains **UNQUALIFIED**. The pre-review was already completed;
the requested new post-WARNING-1 pass is read-only and scoped to this follow-up.
Node facades do not qualify the native pixels, actual panel mapping or lawful
Production offline fact owner.

Final preservation check: 130 of 131 originals match their expected current
baseline, including the growth notebook's existing 15,947-byte after-image
`AA25DDE07FFF18562AF78A6CC5278B1462072F4B9BA65C3CEC24F9AE54A35CC9`.
`markdown/mdx-test.mdx` differs: expected
`f029166cfdc12508ed17f0bb8c24649c52a4007b17c6fa6c5ef82f7a5fd8e7e1`, current
`8b7c4a819ae63c4538c7d996015ad295729f134402e9718c90cb19d295ea5ffd`.
Both are 583-byte UTF-8 JSON with 28 CRLFs; parsed values and array order are
identical, with object-key order differences at `$.state` and its two sections.
Current mtime is `2026-10-09T01:02:54.678Z`. The writer is not attributed; do not
restore the file or claim all131 original byte hashes stayed unchanged. All
393 archived copies across the three failed campaigns match their before-images;
both protected archives, the candidate, and all three installed mains match their
recorded hashes. No task-owned host survives; the eight pre-existing watcher
processes remain. User editor buffers/active-editor dirty state were not observed.
Final Node harness/support validation passes 214 tests without skipped cases;
that lower-layer result does not qualify the blocked installed lifecycle.

### Framework Fix Request: Exact Owned-Panel Capture (BLOCKED)

**What I was trying to do:** Prove native Query controls/menu/Escape and
close/reopen for a private cold copy while its same-basename archival original20
and the other108 historical tabs remain open, with no executions or auth.

**What step/capability is missing or broken:** Supported exact URI/current-panel
to CDP frame identity, bounded native Document geometry, and enforceable
`realNativeOnly` capture/no-auth isolation in the installed framework.

**What I observed:** The actual public panel facade has `handle:null` and
wildcard CSP; neither supplies a unique frame identity. The unchanged matcher
returns `BLOCKED: exact URI-to-native-panel-to-CDP-frame identity unavailable`.
`getElementTree(windowId)` exposes no supported depth/node/deadline controls;
available bridge source fixes depth at five without a truncation report. The
installed CLI does not expose the required native-only policy.

**What I already tried:** The three retained campaigns and bounded SDK/CDP/tree
investigation are preserved. Node regressions prove that matching URI, basename,
section ID or geometry cannot replace the missing actual panel/frame identity.
No fresh hosts, images, guessed handles/depth options or weaker matchers are
authorized for this fix request.

**What the framework needs to support:** A supported, independently verifiable
mapping of the exact owned URI and current panel incarnation to its actual CDP
target/context/frame owner, without private-field assumptions, title-only
selection or wildcard matching; PID/HWND-scoped bounded native Document
inventory with explicit truncation; and native-only/no-auth capture policy that
fails closed. Preserve tokens, frame-owner/geometry and no-fallback checks.

**Suggested Gherkin step syntax (if applicable):** A native capture step keyed
by exact owned URI plus current panel incarnation, asserting the actual frame
identity and native-only/no-fallback policy. This is a capability request, not
an available step or workaround.

**Priority:** blocking. Pixel/SDK geometry and exact panel mapping remain
BLOCKED; lawful Production offline result ownership is an independent hard
gate. Do not substitute remote customer queries, auth seeds, forged facts or
Development fixture commands.

## Wave 3 Coverage Ledger (2026-10-09)

Status: installed pipeline **UNQUALIFIED**. Code gates pass, but the actual
`current133-api` attempt stops at initial `StageSetupBlockingOwner`; neither the
composed Production acceptance nor its executing panel-runtime proof is complete.
This is a documentation-only checkpoint using supplied gate receipts, not a new
test run. The October 7/8 history and the earlier 8,713-test/341-native checkpoint
above remain historical evidence, not the Wave 3 final gate.

Scope: the frozen 447-source snapshot at
`698891c66d37f4aa28cae40c4469b806c0e4bf31`. The same canonical URI queue,
`MainWebviewStartupGateway`, source-generation authority and native Save owners
remain in place; no new state map, file or transaction framework is implied.
Implementation and regression tests reuse existing files. This ledger records
their scope and receipts; no dependency, metadata, version, threshold, normal
profile/auth store or protected original was changed.

Isolation: use immutable archived before-images, never live originals, auth
seeds, historical query execution or Development fake result owners. Auto Save
stays enabled; exact assertions and byte baselines are not weakened or reset.

### Contract And Composed Acceptance

Ordinary targeted reads must establish fresh dispatcher/projection readiness and
return a complete captured snapshot or a canonical failure, never fabricated
empty notes or a successful partial document. Expiry withdraws the exact unsent
request without canceling a submitted SDK promise. Untouched bytes, model
versions, clean state, saved results and attachments stay independent of reads;
prior comparison-copy signatures and passive SQL behavior do not authorize
normalization, rebaselining or changing Auto Save. Genuine authoring/native Save
retain their existing owners.

**C1, mandatory read-only API composition:** immutable 133 before-images,
101 structured sources and the original October 7 order109 -> one clean unique
SDK custom-editor canary and one metadata-only exact-ID initial activation ->
initial full oracles -> all109 historical activations in the recorded order ->
hidden full oracles without auto-reveal -> exactly one ordinary exact-ID
post-stress activation -> full oracles before any close -> read-only close and
independent parent/runtime collection. Every oracle requires the original
regression canary's ten exact sections, full note and metadata/related IDs, six
bindings, typed raw results and attachment graph, the two Query sections and
the saved SQL display. The second Query's primary and additional tables must
both survive. It is not an authenticated SQL rerun. All133 source
bytes remain exact; the separate cold copy has its own count1/linkage ledger.
Before/after executing provider, gateway and webview identities are mandatory.
`current133-api` never replaces or renumbers the original131/original109 contract.

**C2, distinct native-control composition:** the original131 archive contract,
separate cold copy and all109 retained historical tabs including original20 ->
real Query controls at83/88/109 and native Run-options/Escape -> clean cold-copy
close/reopen while all109 remain -> separate authoring copy, real keyboard edit
and native Save -> reopen and second edit/Save/interaction, with live UI, durable
bytes and restored notes/bindings/results checked throughout. C1 API calls and
the older Development sweep cannot replace these controls or this lifecycle.
Exact panel/frame/native geometry and lawful Production result ownership remain
independent blockers; no image inspection or native-control pass is claimed.

Owners: the gateway owns panel transport, issued recovery and readiness episodes;
`QueryEditorProvider` owns captured-panel read preflight;
`HostWorkbenchToolSessionApplicationHandler` owns connection token, waiter and
reply settlement; the orchestrator owns targeted read/inventory dispatch.
Strict `getKqlxState(true)` and the shared snapshot protocol own capture/admission;
`KustoEditorSchemaCoordinator.beginSchemaRequests()` owns schema batch staging,
commit and guarded notification. `SqlEditorLifecycleCoordinator` retains SQL
comparison reconciliation after exact snapshot admission. Existing projection,
URI/source-generation and Save/publication owners retain durable authority.
The archive observer, SDK tab observer, cleanup set and parent collector are
evidence owners, not replacement product state authorities.

| Raw Dimension | Required Values / Transitions |
| --- | --- |
| Readiness | Cold shared30s; READY same-runtime fresh read; established4s/250ms probes; runtime replacement; unavailable/disposed; coalesced and staggered callers |
| Delivery | Queued unsent -> expiry/abort; preparation abort; physically submitted held SDK promise -> release; stale ACK/retry must not replay rejected work |
| Identity | Same/different connection registry token, panel, runtime and accepted projection; retirement before SQL effects and after the final inventory fanout await |
| Snapshot | Complete, partial, missing known serializer/primary/owned record, throwing callback, malformed/proxy and over-cap; authoritative empty/blank; same versus unrelated schema-refresh target |
| Schema Batch | Fresh/changed/equivalent targets; precommit refusal, late capture and stale model/token; postcommit waiter/readiness/lifecycle supersession, including later same-owner listeners |
| Host / Persistence | Native KQLX, KQL/CSL compatibility and SQL compatibility have distinct host paths; no-op comparison versus genuine authored Save; wire/raw results and array order remain exact |
| Lifecycle / Proof | C1 initial -> full109 hidden -> sole ordinary activation -> before-close; C2 cold close/reopen and second authoring revision; sealed candidate versus initial-only methods/disk hashes and missing later runtime proof |
| Preservation | Clean bytes/dirty flags/model versions; changed-then-reverted damage; independent cold count1/checkpoints; no setup Save or byte rebaseline after admission |

### Selected Evidence And Gaps

Each row names a distinct boundary, not a proposed new test. Existing evidence
is credited only for the listed setup, action and oracle; lower-layer passes do
not qualify C1/C2 or disprove installed Production `RuntimePressureWave3`.

| ID | Lifecycle / Owner | Exact Evidence, Setup, Action And Oracle | Decision / Layer | Result / Limitation |
| --- | --- | --- | --- | --- |
| C1 | Full API109/133 and executing candidate owners | [Unchanged archived canary survives original109 with exact hidden and ordinary activation oracles](../../../tests/vscode-extension-tester/e2e/default/workbench-tool-session-activation-sweep/workbench-tool-session-activation-sweep.feature#L110): initial exact-ID admission -> all109 -> hidden reads -> sole ordinary activation -> exact ten-section/note/six-binding/result graph before close | Include / Installed Production APIs | Actual initial dashboard is invalid; history0, post-stress activation0. No completed109 or qualified runtime proof |
| C2 | Native controls, Save, cold and authoring lifecycles | [Cold controls and exact archive order precede separate native authoring](../../../tests/vscode-extension-tester/e2e/default/workbench-tool-session-activation-sweep/workbench-tool-session-activation-sweep.feature#L4): real controls83/88/109, retain original20/all109 during cold reopen, keyboard Save/reopen/second edit with exact durable and UI oracles | Defer / Native E2E | Framework panel/frame/geometry and lawful result-owner blockers; APIs/source fixtures do not exercise native input |
| C3 | Exact unsent withdrawal versus physical SDK submission | [withdraws only the canceled queued message and cleans its abort listener](../../../tests/webview/host/mainWebviewStartupGateway.test.ts#L849): two queued sends -> cancel one -> only the other delivers. [does not release the physical drain when a submitted message is aborted](../../../tests/webview/host/mainWebviewStartupGateway.test.ts#L886): hold submitted head -> abort -> following waits for actual release. [withdraws a timed-out dashboard request behind a physically held outbound head](../../../tests/webview/host/toolOrchestratorConnect.test.ts#L212): timeout -> release -> no expired context request | Existing / Host unit | Focused gate passes; optional standard host-only AbortSignal is not a wire field or SDK cancellation |
| C4 | Stable read episode versus runtime replacement | [shares the original read deadline without retiring a ready same-runtime epoch (acknowledged=%s)](../../../tests/webview/host/mainWebviewStartupGateway.test.ts#L1215): 250ms retry and second caller at3999ms share one result/deadline; exact ACK preserves epoch, expiry retires it. [fences an older snapshot only when a staggered read observes runtime replacement (%s)](../../../tests/webview/host/queryEditorProviderWorkbenchToolSessionHandler.test.ts#L433): same-runtime older reply accepted; replacement rejects it before SQL | Existing / Host unit | Both branches pass; no recursive snapshot or fresh budget per caller |
| C5 | Issued dispatcher-document recovery during blocked inbound work | [admits its issued recovery after READY without unblocking unrelated inbound work](../../../tests/webview/host/mainWebviewStartupGateway.test.ts#L790): held handler -> exact issued challenge ACK -> duplicate recovery -> one requestDocument, ordinary work still held. [never routes unissued or expired dispatcher recovery into the document provider](../../../tests/webview/host/mainWebviewStartupGateway.test.ts#L826): unissued/expired correlation -> zero provider calls | Existing / Gateway unit | Bounded issued record survives READY; unissued, replayed and stale requests do not become document admission |
| C6 | Reply timer, registry/runtime/projection admission before SQL | [waits for read readiness before starting the unchanged snapshot deadline](../../../tests/webview/host/workbenchToolSessionApplicationHandler.test.ts#L449): hold readiness5200ms -> no request -> release -> exact empty response at4999ms is valid. [checks captured runtime and projection admission before SQL effects](../../../tests/webview/host/workbenchToolSessionApplicationHandler.test.ts#L475) and [rejects a registry-retired snapshot without requiring handler reactivation](../../../tests/webview/host/workbenchToolSessionApplicationHandler.test.ts#L492): retire captured authority -> undefined, no SQL reconciliation, exact signal retired | Existing / Session-owner unit | Five-second reply budget starts after read readiness; legitimate empty state remains distinct from unavailable |
| C7 | Actual READY read preflight and independent inventory fanout | [recovers a cached READY projection through an actual read probe before requesting its snapshot](../../../tests/webview/host/queryEditorProviderWorkbenchToolSessionHandler.test.ts#L394): stale probe inert -> exact ACK -> one snapshot/SQL reconciliation, no reveal. [does not publish live inventory retired after its snapshot while another file is pending](../../../tests/webview/host/toolOrchestratorConnect.test.ts#L554): A read settles, B held, A retires -> no stale live A after final await | Existing / Provider/orchestrator unit | Same/different captured owners remain independent; backing inspection or a healthy neighbor cannot establish live readiness |
| C8 | Strict base versus tolerant ordinary persistence | [keeps default persistence tolerant while strict tool capture rejects a later serializer failure](../../../tests/webview/persistence-roundtrip.test.ts#L1180), [rejects a missing known %s serializer only during strict tool capture](../../../tests/webview/persistence-roundtrip.test.ts#L1203) and [accepts an authoritative empty native strict tool capture without stale passthrough notes](../../../tests/webview/persistence-roundtrip.test.ts#L1285): later failure/missing known kinds reject complete tool capture; ordinary persistence stays tolerant; true empty captures frozen [] | Existing / Webview unit | No successful partial snapshot, fabricated blank primary or stale notes; legitimate pending/reader blank values remain valid |
| C9 | Real producer base/enrichment before schema effects | [rejects a real producer with later %s before schema-refresh effects](../../../tests/webview/message-handler.test.ts#L1819): real strict serializer, accessors, base/enrichment cap and SQL callback failures -> one canonical nonblank error with sections[], original schema identity/token/preparation unchanged, getters untouched | Existing / Webview producer unit | Shared caps apply before and after enrichment; canonical error is not authoritative successful empty state |
| C10 | Schema batch refusal, commit and independent publication | [rejects a batch with %s before target, token, waiter, or listener effects](../../../tests/webview/kusto-editor-schema-coordinator.test.ts#L111): three owners, invalid/stale/refused/late-capture plan -> no batch effects. [admits normalized frozen identities for mixed targets before committing or notifying](../../../tests/webview/kusto-editor-schema-coordinator.test.ts#L171): fresh/changed/equivalent owners -> every notification sees the whole committed batch. [suppresses stale post-commit notifications after a %s supersedes an owner](../../../tests/webview/kusto-editor-schema-coordinator.test.ts#L228): waiter/readiness/lifecycle callback publishes independent middle owner -> preserve it, suppress stale notifications | Existing / Coordinator unit | Precommit refusal has no effects; postcommit guards do not roll back an independently published owner |
| C11 | Shared bounds and top-level proxy ingress | [keeps the exact 16 Mi-character snapshot limit including object keys](../../../tests/webview/tool-state-snapshot-protocol.test.ts#L78), [keeps the exact 250,000-value snapshot limit](../../../tests/webview/tool-state-snapshot-protocol.test.ts#L89) and [rejects a top-level proxy through $direction $path admission before nested reflection](../../../tests/webview/tool-state-snapshot-protocol.test.ts#L241): exact boundary/overflow and host/webview direct/captured proxy paths -> inert invalid admission before nested reflection/waiter effects | Existing / Shared protocol unit | Existing depth64/container10,000 limits and frozen exact values retained; no separate strict/enriched budget |
| C12 | Three native host paths and physical reload lease | [${variant.name} startup buffers both directions until explicit dispatcher readiness](../../../tests/integration/kqlSidecar.test.ts#L10467): native KQLX/KQL compatibility/SQL compatibility -> queued startup, one document delivery, retirement rejects later traffic. [cold readiness starts the native reload lease only after a 5200 ms dispatcher ACK](../../../tests/integration/kqlxMarkdownOwnership.test.ts#L7111): no early lease -> exact ACK -> one five-second lease, unchanged bytes/version/clean state -> authored change/native Save | Existing / VS Code source integration | Final343/343 on1.141.0; SDK adapters echo actual issued probes and retain3/6/64 counts. Not installed-release E2E |
| C13 | Historical no-op comparison and native Save owner | [noncanonical fourteen-section hydration preserves native bytes without an ordering-only edit](../../../tests/integration/kqlxMarkdownOwnership.test.ts#L134): hydration -> ordering-only state -> exact clean bytes/version -> genuine edit/Save. [does not persist or advance revision when fourteen hydrated sections only reorder object keys](../../../tests/webview/persistence-roundtrip.test.ts#L3888) and [does not persist reordered saved descriptors during deferred result settlement](../../../tests/webview/persistence-roundtrip.test.ts#L5120): retain acknowledged operands -> reorder/settle -> no automatic persist -> real edit retains saved descriptors | Existing / Historical native/webview evidence | Native equality already passed before the prior comparison-copy fix; no new normalization, Auto Save change or incident-writer attribution |
| C14 | Exact initial SDK focus, composed mock lifecycle and actual cleanup | [current133 initial exact-ID activation admits the clean inactive canary behind Welcome and waits for SDK focus](../../../tests/scripts/published-notebook-journal.test.mjs#L1968): one metadata ID/initial call, clean unique SDK tab before/after. [current133 Node mocked lifecycle composes all109, exact hidden oracles, one activation and readonly close](../../../tests/scripts/published-notebook-journal.test.mjs#L2046): immutable archives -> all109 -> hidden/activation/close, retain public failures and assert actual SDK tab array empty | Existing / Private filesystem and SDK-shaped Node | Distinct133/109 and independent cold count1 preserved; no product fixture owner or real native controls proved |
| C15 | Fail-closed runtime classifier and independent parent collection | [current133 API classifier preserves negative evidence for matching orchestrator without executing panel-owner proof](../../../tests/scripts/published-notebook-journal.test.mjs#L485) and the same parameterized test for `executing panel-owner proof missing`: false/missing panel proof -> HARNESS_BLOCKED, no API qualification. [current133 independent collection keeps API pixels unattempted and cannot heal stale loaded METHOD observations](../../../tests/scripts/published-notebook-journal.test.mjs#L2010): even seeded retained true flags -> independently false panel-owner proof, exact limitation retained | Existing / Pure classifier and parent-collector Node | Two final focused identity guards and one collector case pass; theoretical classifier panelOwners:true is not actual fixture-owner evidence |
| C16 | Duplicate scalar/Cartesian expansion | C3-C11 already exercise shared capture/cap/admission owners and their refusal/success transitions; retain the coupled C1/C2 paths and distinct host/token/schema owners | Exclude / Duplicate only | No extra tests for equivalent scalar products. This does not exclude distinct mutation owners, host paths or dependent lifecycle risks |
| C17 | Idle READY with an already-held outbound head | C3/C4 cover shared readiness and retained submitted/unsent paths, not the full idle-READY held-head admission-order permutation | Defer / Concrete ordering gap | A fresh ordinary send could take another branch; the retained physical/unsent red and its green checks do not prove global send ordering |
| C18 | Development-note mutation queued expiry | HostDevelopmentNoteMutationApplicationHandler has its own mutation waiter/transport owner, outside the ordinary state/dashboard read fence | Defer / Explicitly out of scope | Its queued expiry remains unqualified; no claim that all mutations are fenced |

### Recorded Gates And Sealed Candidate

Corrected official FULL coverage: **8,843 pass**, four existing skips,
372 passing files plus one skipped file (373 total), **52.40%** statements,
1,132.67s; unchanged coverage threshold. The initial FULL result remains
8,841 pass/two failures. Both sender coordinates and the source guard were
corrected before the official pass: the AST permits read-only
`activeSourceGeneration` access through the existing coordinator, not a declared
or assigned duplicate source authority. Affected gate: 1,124 tests in 10 files,
no skips. Final native source integration: 343/343 on VS Code 1.141.0 with
actual-probe SDK adapters and unchanged 3/6/64 assertions. Normal
host/webview/connector types, lint, production package and all 12 unchanged
bundle gates pass.

The candidate passed those code/package gates with the exact 447-source snapshot
unchanged; only harness/docs followed packaging. Sealed candidate:
`out/releases/vscode-kusto-workbench-0.0.0-placeholder.vsix`, 5,623,580 bytes,
SHA-256 `2ddefbf4aa1788b7f9eee2db112d8e0c99944e4faa5b2a45708ce94ca4a0dea6`.
Main SHA-256:
`505e463234728a90e2df9c53c5b7a5864858eb0c0d1283c773a481767b9f0c24`.
52-resource tree SHA-256:
`b76e15b8ad302a2ef68ab81f60ea4dcad63ad720ee5729cc1ef61d648724ee8a`.
Host: 2,572,381/2,574,336 bytes; webview: 3,418,013/3,418,112 bytes, 99-byte headroom.
Local watcher-generated dist drift (three bundles/three maps) is not this sealed
candidate; no repack followed. Packaged Node 24 runtime and Node 22.16 terminal
execution are distinct contexts, not a reason to change metadata or thresholds.

Final full Node journal/support receipt: **297 pass**, zero failures, skips or
cancellations, 285.14s. This includes the two final identity guards and the
independent collector refusal; their focused checks also pass. The saved receipt
does not expose an exit-code field. No installed qualification is inferred from
these Node facade tests.

### Actual Installed Evidence And Counterexamples

Frozen ActualAPI attempt `c261009144905dd3d`,
`%TEMP%/kw-acceptance-xCzswC/a1`: one initial exact-ID activation succeeded,
notes were exact and full section count was10. Dashboard wrapper success=true
but valid=false, provenance=true, six bindings and zero data sources with
missing-data-source issues. This is a genuine initial StageSetupBlockingOwner
stop, not an auth-causal conclusion: history0/post-stress activation0, no
completed109. All133 bytes were clean at the observed prepared/initial and
post-host parent checkpoints; these partial checks are not the composed gate.

The earlier current133 attempt under `%TEMP%/kw-acceptance-xBZDtZ/a1` stopped on
the clean INACTIVE canary behind Welcome. Its correction admits that exact
unique clean tab, observes bounded90s SDK tab events, performs one metadata-only
ID lookup and one initial exact-ID activation, and requires exact SDK focus
afterward. No healthy-neighbor substitution or replay is allowed; both failed
attempts remain preserved.

Actual initial build evidence records ExtensionMode.Production context1,
require-cache executing orchestrator method slices with six matches
(`VERIFIED_INITIAL`) and the52 on-disk resource hashes. After identity is null
(`Runtime MISSING`). Executing provider/gateway/webview owners are not proved;
manifest5.2.0 alone is insufficient. The collector records
`collection.runtimeVerified.panelOwners=false` and the verbatim
`collection.runtimeLimitation`:
`Executing provider, gateway and webview identities are not observed by orchestrator method fingerprints`.
Matching parent disk hashes, tracked source or harness counts cannot repair that
missing observation. A pure classifier fixture with panelOwners:true is only
theoretical unit data; no production global or owner hook was added. Installed
API preservation remains unqualified, with no release or incident-causal claim
and no attribution of an older Wave 3 executing implementation.

Post-review cleanup red: the API canary lies outside order109, so the old owned
URI set reported zero survivors while leaving its actual SDK tab open. The
actual-tab-absence assertion failed; an API-only URI union now feeds the same
owned set to observer and cleanup, leaving original131 intact. The composed
mock lifecycle asserts that actual task-owned tabs are empty after cleanup,
not merely that a filtered survivor count is zero.

Seventeen preservation counterexamples initially received false API credit.
Qualification now requires initialActivationCalls1 and its exact record,
clean unique canonical SDK custom-editor observations before (Welcome focus
allowed) and after (exact active focus), plus independent cold count1/source
linkage/checkpoints/dirty-byte-version and no-rebaseline guards. Preservation
damage has priority even if subsequently reverted; a legitimate unopened cold
copy may have empty revision observations. Two later runtime-identity reds
exposed matching unchanged orchestrator methods being credited without executing
panel owners; final classification fails closed until proper runtime
instrumentation exists. Such instrumentation is future work, not implemented
or replaced by method/disk hashes. Lower-layer green results do not refute the
blocked installed Production RuntimePressureWave3 path.

## Independent Public-Activation Red (2026-10-09)

Scope: tests only, no product fix or rollback. The user rejected using their F5
window. The new opt-in `archive-public-activation-repro` runs in a fresh ephemeral
Development host against the actual extension and public LM tools. It copies the
immutable Wave3 historical corpus before opening, never opens protected originals,
and uses a separately labelled synthetic canary with one explicit authoring Save
before its baseline. This is not the original canary's result graph or Production
qualification. Existing user tabs, profiles, auth stores and watchers stay intact.

| Contract | Setup, Action, Oracle | Result / Fidelity |
| --- | --- | --- |
| Harness command-path sensitivity | `current133 historical first opens use exactly one public activation call without direct-open warming`: one historical range -> require one public tool call | Red: actual0 versus expected1. Harness gap, not a product reproduction |
| First public activation | Real archived copies -> one public URI activation per recorded target, all109 -> preserve first response and independent later inventory | Natural product red in run `20261009-191256`: targets21/92/105 return false with live-bridge recovery error; all three are live later without another activation. Target88 returns true but its SDK readiness check fails, separately recorded |
| Hidden and ordinary recovery | Healthy synthetic note/six-binding/one-source baseline -> hidden19 -> full109 hidden -> one exact-ID activation -> once-only note/dashboard checks | Passed for this synthetic canary. Original-canary full-load unavailability and failed recovery remain unreproduced, not cleared |
| Transient preservation | Observe all archived models/dirty transitions from first open; compare immutable bytes before and after exact cleanup | Red: eight historical paths changed or became dirty then reverted; final disk hashes all match. Final byte equality does not erase137 retained damage events |
| Setup and execution controls | Actual Development context/module, facade ingress/start observer, exact root/clean-tab cleanup, source/resource hashes | Initial controls passed; zero query ingress/start, unchanged identity, all109 retained and110 clean exact tabs closed. Panel runtime/native pixels/Production remain unqualified |

Earlier setup failures remain retained: `20261009-190208` stopped on synthetic
authoring defaults/dirty state; `20261009-190936` stopped on a diagnostic snapshot
comparison despite matching public notes and valid dashboard. These are not product
availability reproductions. The corrected snapshot assertion compares JSON transport
values, not prototype identity; it does not normalize a file or heal API failures.

Command: `vscode-ext-test run --extension-path . --features
tests/vscode-extension-tester/e2e/opt-in/archive-public-activation-repro
--vscode-version stable --timeout 180000 --no-build`. The initial attempt performed
the normal source compile/types/lint; subsequent attempts used that unchanged build.
The final scenario exits1 on its aggregate contract assertion. The feature syntax
and exact109/nonpolling route guard passes; the previous harness-fidelity check
remains intentionally red. Do not describe the complete suite as green.

The three private roots `kw-acceptance-kxLIe4`, `kw-acceptance-mxYOO4`, and
`kw-acceptance-1G8lh0` and their failed evidence are preserved. Read-only audit:
447/447 production files unchanged;134/134 Wave4 originals,399/399 staged histories,
three cold copies and sealed VSIX unchanged; zero scoped runner/Code survivors;
all seven prior watcher lifetimes/parents retained. No images were viewed. No new
product-causal attribution: independent note/no-op fixes have evidence, while shared
readiness/schema changes still need causal controls before keeping or reverting them
as an incident remedy. Never roll back the user's mixed worktree wholesale.

### Wave4 Evidence Handoff And Timing Replay

The failed-run handoff records a16m28.880s sweep:180.080s inside activation calls
and808.800s between calls. The canary was hidden for about17 minutes. Notes and
dashboard passed after19 targets, then failed after109; the failed reads and one
failed recovery took roughly4 seconds each. Our earlier independent run took
about3 minutes. This timing difference is a test condition, not a proven cause.

`KW_ARCHIVE_REPRO_TIMING=wave4` optionally replays the immutable Wave4 archive's
109 request timestamps and the handoff's hidden/recovery check times in our own
ephemeral host. One fixed clock preserves the pauses and records late starts;
no caller deadlines increase and no failed activation is replayed. Timed reads
use the recorded open-file-ID-only arguments. Three focused syntax, timing and
loaded-method checks pass.

Timed source run `20261009-224408`, private root `kw-acceptance-CnovpM`, reached
all109 calls on the recorded clock. Initial, hidden19, hidden109 and ordinary
recovery passed for the synthetic canary. First activations35/83/105 failed and
later became live without activation retry; transient preservation failed while
final hashes matched. Most starts were0-15ms late; a slow call caused22.690s
lateness at93, recorded without resetting the clock. Timing alone has not
reproduced the original hidden/read/recovery failures. The earlier timed run
`20261009-224113` stopped on its first synthetic activation and is retained.

The separate `archive-original-canary-baseline` case opens an unchanged private
copy of the real canary, with no seeds, warming, query or Save. Source run
`20261009-232546`, root `kw-acceptance-DgooTw`: activation succeeded, the note read
failed, and dashboard validation returned six bindings/zero sources with
`missing-data-source`. All staged bytes/versions stayed clean; zero execution,
exact cleanup and unchanged source identity were recorded. This is not the
reported working-baseline-then-full-load failure. A prepared independent test
profile and actual failed-run window/build information are needed; authentication
as the cause is not established. Do not alter the notebook to force admission.

The handoff does not identify which window or Workbench build handled Wave4,
the actual account state, or a related exception trace. Installed5.2.0 metadata
does not fill those gaps. Renderer tool-set JSON and Copilot schema warnings are
not tied to these failures. Remaining differences include our synthetic canary,
blank SQL, fresh starting state and extra diagnostic reads; timing alone cannot
make this a complete reproduction of the original notebook.

### Original Connection-ID Profile Setup Blocker

The updated handoff supplies non-secret connection ID, endpoint and database,
but no verified working profile. `ConnectionManager` loads saved connection IDs
unchanged; Add Connection and XML import generate new IDs. The focused saved-record
test passes, including persistence/reload through the existing loader. This is
lower-layer setup evidence, not a reproduction of the reported notebook failure.

The test-only `archive-original-canary-baseline/profile-runner.cjs` validates fresh
private user-data/extensions/shared-data directories, compiled-source hashes,
Windows quoting, config/receipt ownership and bounded phases. Prepare uses actual
VS Code Memento to write only the non-secret connection record. No account, token,
partition, artifact or privacy settings are supplied; no notebook opens in Prepare.
Check is a new host which must restore the exact record before any notebook call.
The initial path-case and `vscode-userdata` URI setup failures remain preserved;
six focused runner/baseline safety checks pass after test-only corrections.

Private root `kw-acceptance-cm2dGc`: native Prepare readback succeeded and exited;
fresh Check did not restore the record. The actual tested VS Code1.141.0
`mainImpl.js` storage rule is
`getStorageOptions(){return{useInMemoryStorage:!!this.environmentService.extensionTestsLocationURI}}`.
Both hosts used the same private storage path, but native extension-test mode uses
in-memory storage. A successful write/readback therefore cannot prepare the next
host. The unchanged original was not opened in this Check; zero notebook calls
means this remains a setup blocker, not the full-load reproduction.

Earlier proposed framework improvement, not established as necessary: support a fresh persistent Development host with
explicit private user-data/extensions/shared-data and artifact directories, no
`--extensionTestsPath`, no inherited/reusable profile, no normal Local State/auth
copy, no Settings Sync, and source build/window evidence. It must provide the
extension-host controller so the non-secret Memento preparation can complete,
close that owned host, then reopen the same private profile and verify original
ID/incarnation before the unchanged notebook baseline. Do not fix this by editing
VS Code's database, changing the notebook ID, injecting a matching account/policy,
or running its query. Native `profile-runner.cjs` is retained diagnostic evidence;
it is not a working persistent-profile recipe.

### Existing Kusto Profile Attempt (2026-10-12)

The standard E2E harness already launches the prepared `kusto-auth` profile.
The native in-memory-storage limitation above came from the alternative launcher
we chose, not evidence that named-profile launch support must be redesigned.
`--clone-named-profile` is declared but unimplemented in CLI0.1.23; this attempt
used its supported serial `--reuse-named-profile kusto-auth` route.

Run `20261012-174407` stopped before notebook calls because our test incorrectly
required a zero-tab/inactive starting state. The Kusto profile had opened its clean
scratch `session.kqlx`. Explicit `KW_ARCHIVE_BASELINE_PROFILE=kusto-auth` test mode
now validates actual profile storage, preserves every starting tab, and checks
only the owned temporary copy. If the extension was already active, earlier
registration/execution events are not claimed to be observed; read-only tool calls
and this observation limitation are reported separately.

Run `20261012-174923`: unchanged original-canary copy opened successfully; its
exact saved note was returned. Dashboard wrapper success was true but validity
false, six bindings/zero data sources with `missing-data-source`. The profile had
31 configured connections; its matching cluster record was
`conn_1779868561094_1s3rb3htt`, database `NetDefaultDB`, while the saved fact hint
was `conn_1765825441854_gi5ey0lar`. This is a confirmed setup difference, not proof
of an authentication cause or the later historical outage. No sign-in error was
returned by these calls. No query, Save, seed or connection change was requested.
The temporary copy and all staged bytes stayed unchanged; its one clean tab
closed, the starting scratch tab remained, and the harness test host stopped.
Do not run109 as evidence of working-then-failing dashboard recovery until the
original dashboard baseline passes in the prepared profile.

Final safety check and repeat run `20261012-175842`, private root `kw-acceptance-pJTWaI`,
confirmed the same baseline result. Prepared mode now reads settings as prerequisites
instead of changing global Auto Save or preview settings, and preserves starting-tab
multiplicity, editor type and dirty state. Three focused safety/syntax checks pass;
the live dashboard assertion remains red. Temporary copy: zero damage, exact bytes,
one clean owned tab closed, original Scratch retained. No query, Save, sign-in,
seed, connection change or product edit was requested. This demonstrates that the
existing harness/profile can run the scenario; it does not establish the later
full-load outage or identify its cause.

## First-Activation Verification And Native Input Blocker (2026-10-14)

The reported first-activation problem now has a passing real archived-file run:
`runs/20261014-223229`, VS Code 1.141.2, source Development host, one public
activation for each of the exact 109 historical targets. All 109 first results
passed. The canary's hidden checks at 19/109, one ordinary recovery, unchanged
bytes/model/dirty state, observed zero query ingress/starts, and exact cleanup
of 110 owned tabs passed. Retained evidence root: `kw-acceptance-WxOj8f`.
The recorded Wave4 timing replay also passed in `runs/20261014-234803`, retained
root `kw-acceptance-4gCPBp`: the same 109 first calls had zero failures, with
hidden19/109, recovery, preservation, unchanged source/build, zero observed
execution, and exact cleanup passing on the fixed recorded clock. The overall
run took 1154886 ms and retained lateness observations without resetting time.
This is source-only partial runtime evidence, not installed Production, visual,
or original-canary full-result-graph qualification. Older failed runs remain
failed and retained; later inventory never replaces a first activation result.

Two protocol inventory failures in the full unit run were stale source
coordinates for the unchanged validated command-result sender. Its reviewed
location moved from `5251:10` to `5436:10`; both exact expectations were updated
without changing the scanner, allowlist membership, or message validation.
The complete 80-test protocol file then passed. The fresh full coverage gate
passed with 9028 tests, four existing skips, and 53.03% statement coverage.
The complete extension-host suite passed 386 tests on the currently resolved
VS Code 1.142.0; the last subscription-wrapper cleanup also passed its focused
tests. Full Node harness regressions passed 342 tests with one explicit
recorded-build prerequisite skip. These do not replace the still-blocked
physical Bold/composed native Save-reopen workflow. The preceding failed
coverage run and its two stale-coordinate failures remain retained.

| Coverage | Exact setup/action/oracle | Evidence and remaining limit |
| --- | --- | --- |
| First activation and passive preservation | Immutable private archived copies, exact109 order, one public URI call each, hidden19/109 reads, one recovery, byte/model/dirty observations, exact-owned cleanup | Fast run 223229 and recorded-timing run 234803 passed; no Production/visual claim |
| Markdown preservation and current API ownership | Exact source, current editor registration, persistence roundtrip | 322 focused Markdown/ownership/persistence tests passed |
| Genuine paragraph authoring | Fresh private native fixture, raw before-image, trusted input, exact current section/editor text and whole host model | Native runs 193448/194211/195628/200415 passed through typing; older stale staged copies are not current-feature evidence |
| Physical Bold and composed Save/reopen | Exact owned window/frame, one physical click, trusted toolbar event, DOM strong, exact Markdown, Undo/Redo, two observed manual Saves and public reopen | Blocked: no trusted Bold event observed; later steps were not executed and are not qualified by unit passes |

### Framework Fix Request: Verifiable Owned Native Click Delivery

**What I was trying to do:**
Complete `native-markdown-authoring.feature` through a real Bold toolbar click,
Undo/Redo, manual Save, exact clean close/public reopen, and a second edit/Save.
Only fresh isolated hosts and disposable private copies may be used.

**What step/capability is missing or broken:**
`NativeUIClient.clickMouse` returns without a verifiable foreground or delivery
receipt. The native tree supplies no Document anchor for correlating the actual
CDP guest/frame-owner geometry with screen coordinates. Delivery is unproven;
this is not evidence that the product's Bold behavior is defective.

**What I observed:**
Run `runs/20261014-200415`, retained root `kw-acceptance-8ZGPl4`, passed first
activation, exact passive source, current API identity, trusted paragraph input,
and exact authored host model. The owned native window was PID 100184,
HWND `0x12A0E96`, bounds `(672,320,1216,808)`. Native Bold bounds were
`(930,482,24,24)`; the sole submitted screen point was `(942,494)`.
The exact guest viewport was `846x676`, DPR 1, Bold rect `(197,71,24,24)`.
The frame-owner quad was `[53,91,899,91,899,767,53,767]`, with a `1200x800`
shell viewport. The native tree contained 11 observed nodes and zero Document
candidates. After 1514.8 ms of exact-frame observation, the toolbar event delta
was empty, the selected word remained plain, and both current source APIs agreed.
Receipts `bold-control-state.json` and `bold-control-geometry.json` are retained.

**What I already tried:**
Fresh byte-identical feature stages; current PID/HWND/title targeting rather than
reminted enumeration IDs; actual enabled visible UIA button bounds; the same
single click followed by bounded observation; exact URI/token/root/observer
fences; and read-only DOM/frame-owner/native-tree geometry. No synthetic click,
keyboard Bold shortcut, guessed-coordinate correction, or action retry was used.
The diagnostic now rejects pre-click activity and bounds drift and retains
best-effort non-overwriting evidence on observation failure.

**What the framework needs to support:**
An owned-window native click with foreground PID/HWND verification and a useful
input-submission/delivery receipt. Provide bounded, complete native Document
geometry or another verified guest-to-screen mapping, explicit tree truncation,
and the actual bridge identity. Keep physical input and all event/DOM/source
oracles intact; do not return success solely because the bridge call completed.
Installed CLI 0.1.23 native/CDP clients and the bridge's mouse/window/tree
operations are the implementation surfaces. Public CDP selector clicking is
synthetic-first and must not replace this trusted-control requirement.

**Suggested Gherkin step syntax:**
```gherkin
When I click the native control "Bold" in the exact owned window with delivery evidence
```

**Priority:** Blocking for the composed native authoring lifecycle; independent
first-activation verification has passed. Never use the normal/F5 window, alter
protected originals, discard dirty tabs, inspect images, or erase failed evidence.

## Extension Commands

<!-- List the command IDs this extension registers and what they do -->

- `kusto.openQueryEditor` opens the persistent scratch/session editor.
- `workbench.action.files.save` works for saving a custom `.kqlx` editor after webview-driven `schedulePersist()` updates the backing document.

## Webview Selectors

<!-- CSS selectors, data-testid values, and webview titles that work for this extension -->

- Quick Access External Tools: open `workbench.view.extension.kustoWorkbench`, wait for `[data-testid='configure-external-tools']`, and scroll `[data-testid='quick-access-external-tools']` into view. The real button opens `Configure integration with external tools`; cancel before client selection to avoid setup effects. At 1100x1000, a native click at `20,500` before screenshots keeps the isolated window in foreground. After `workbench.action.showCommands`, wait for QuickInput title `Type the name of a command to run.` before typing; immediate input was lost in run `20260922-044204`, and the readiness-gated rerun `20260922-044325` passed with both screenshots reviewed.
- Main notebook container: `#queries-container`.
- Section tags are stable and usable through webview CSS/evaluate steps: `kw-query-section`, `kw-markdown-section`, `kw-html-section`, `kw-python-section`, `kw-sql-section`.
- Add buttons use `button[data-add-kind='<kind>']`, with kinds including `query`, `sql`, `html`, and `markdown`.
- The section creation/removal window bridges are available in E2E webview evaluation: `addQueryBox`/`removeQueryBox`, `addMarkdownBox`/`removeMarkdownBox`, `addHtmlBox`/`removeHtmlBox`, `addSqlBox`/`removeSqlBox`.
- Python's shadow-root Run control is reliably clickable as `.run-btn`; the compound selector `#<python-id> .run-btn` does not cross that shadow boundary in the current framework.
- Kusto preparation is observable on `kw-query-section` through `data-test-preparation-state`, `data-test-preparation-stage`, and `data-test-preparation-blockers`. The toolbar animation can be asserted with `getComputedStyle(toolbar, '::after').animationName`.
- Supplemental fully qualified schema state is exposed through `window.__e2e.kusto.waitForSupplementalState`, `assertNoSupplementalWarnings`, `assertSupplementalBackgroundTrace`, and `suggestDiagnostics(context, sectionIndex)`.
- SQL Copilot's toolbar action is `[data-testid='sql-copilot-chat-toggle']`; chat controls are `[data-testid='copilot-chat-input']`, `[data-testid='copilot-chat-tools']`, and `[data-testid='copilot-chat-send-stop']`. Tool checkboxes use `data-testid='copilot-chat-tool-<tool-name>'` and accessible names beginning with `Enable`.
- XY-chart X-axis settings are reliably clickable through `[data-testid='chart-x-axis-settings']`. The `chart-regressions` automatic-axis-gap scenario provides visual state evidence for the constant 5x5 affordance: its first screenshot shows neutral default dots for X/Y/Legend, and its post-slider screenshot shows only X changing to blue.

## Activation & Setup Quirks

- `background-user-save-handoff` is the native same-tab user-input/Save gate. VS Code can select a rich report opened with `reveal:false` even when `preserveFocus:true`; `listSections.isLiveWorkbench` means a webview exists, not that the tool orchestrator transferred file ownership. The scenario checks exact background ownership before native Monaco typing, live ownership after, immediate Ctrl+S, durable query and Markdown bytes with a clean document, close/reopen, another edit/Save, exact fixture cleanup, and two reviewed screenshots. Keyboard steps return before the asynchronous host Save completes, so use a bounded read-only poll of disk and document state, never replay a mutation. A Windows Security `PickerHost` firewall notification from a disposable test launch can steal foreground and invalidate screenshots; dismiss only that verified test-created prompt with Escape without approving access, then rerun the visual scenario.
- The opt-in packaged external MCP cold-launch soak checks post-reopen Markdown edits in all 20 isolated two-window report cycles. A rendered section in `listSections` is not an accepted initial projection: live tool mutations must wait for that exact panel to initialize, then pass the durable-byte and strict Save-log checks. Preserve a failed disposable report for inspection; never replay an uncertain mutation.
- `external-tools-walkthrough` is an opt-in native walkthrough check. Set `KUSTO_WORKBENCH_WALKTHROUGH_VSIX` to a freshly built package; the isolated host installs it because `extension.open` cannot find a development-only extension in the installed-extension list. Disable `workbench.welcomePage.walkthroughs.openOnInstall` only in that test profile before installation so automatic opening cannot race the README assertion. VSCE rewrites `command:` links in README Markdown as GitHub URLs; reference **Welcome > Walkthroughs** and an ordinary guide link instead. VS Code 1.139 exposes `welcome.showAllWalkthroughs` (not `workbench.action.showWelcomePage`); click the native `.monaco-list-row` for **Kusto Workbench: External Tools Integration**, then wait for the Markdown webview `h1` before asserting media. The separate `External tools - Open walkthrough` palette command was retired. Native step headings are `.getting-started-step .step-title`. Windows UIA failures can block standard move/resize/native capture; browser CDP verified Welcome tile navigation, media, and palette absence with provider disabled. Earlier seven-page/screenshots/Configure cancellation verification used CDP on VS Code 1.138.0.
- VS Code 1.138.0 renders native Welcome walkthrough Markdown in a cross-origin iframe beneath the `workbench` CDP page. The runner's `the webview should contain` does not see this iframe; it fails even when native screenshots show the full page at both 1000x700 and 1280x900. Root `document.body.innerText` sees step titles but not media content. To validate changed copy, click the native `.getting-started-step .step-title` via CDP mouse input, inspect the captured foreground screenshots, and report the Gherkin assertion as a separate failure rather than a product pass. A read-only native Configure/cancel probe on the packaged CLI and Vera pages confirmed the isolated provider stayed disabled.
- Microsoft Copilot desktop 155.0.4283.3 omits local Workbench plugins and skills from Customize but loads them in **Local Code sessions**. Verified a real `Workbench Connectivity Probe` session loading `kusto-workbench`, completing `getWorkbenchGuidance` and `listWorkbenchInstances` with separate **Allow once** approvals, and returning an independently confirmed instance UUID. Catalog visibility is not a runtime oracle. The opt-in `externalCopilotCodeIntegration.test.ts` case `running Local Code session` uses `KUSTO_WORKBENCH_RUN_CODE_DESKTOP_SMOKE=1` plus exact `KUSTO_WORKBENCH_CODE_DESKTOP_ACCOUNT` to inspect the already-completed session and verify returned IDs through fresh connector discovery. Additional windows may appear between the app call and inspection. This does not certify a full query/report workflow. Captures live in `runs/default/copilot-code-live-probe/20260922-233903`; the optional forwarded-guide draft was not submitted because focus guards refused unsafe input.
- `external-scout-setup` exercises the real Configure client/profile pickers, native Continue consent, reconfiguration, and managed removal using a separately loaded setup bundle with only connector-install/process checks prepared and Scout paths redirected to a unique temp home. Its JSON oracles verify registration plus skill, byte-identical rerun, unrelated-state preservation, and exact fixture cleanup. The evaluator has no global `require`: use `process.getBuiltinModule('node:module').createRequire(...)`. Do not spread the whole `vscode` API; that evaluates proposed getters. Target consent with `I click "Continue" on the "Visual Studio Code" dialog`, not the controller's generic dialog registry. Run 20260922-055306 passed all 28 steps; screenshot and four JSON artifacts reviewed. This does not prove a newly created registration is loaded by the Scout application itself.

<!-- E.g. "needs a .kql file open before commands are available" -->

- Opening blank or zero-section `.kqlx` / `.sqlx` content projects one document-kind starter without dirtying source bytes; blank `.kql` / `.sql` compatibility files project one pinned primary section. A later edit of the projected starter writes it on Save, while native persistence preserves an authored empty section array. Tests that need exact counts should distinguish projected state from durable bytes.
- `historical-empty-notebook-byte-regression` includes a disposable layout-height canary with saved Query result heights (182/126), an absent editor/URL height, and one offline saved Kusto result. Exact bytes/hash and clean state must survive `activateWorkbenchFile(targetFileUri)`, idle Auto Save, hide, close/reopen, and automatic URL CSV fitting; the real URL Fit button and resizer double-click then Save/reopen with different row counts must preserve the authored height. Restored results can join the webview signature after initial projection, so a no-op result admission must not rewrite the source. Run `20260928-182033` passed 16/16; the 97-file mixed activation gate `20260928-182728` passed separately. These are Development Host checks, not installed-release evidence.
- The URL Fit control lives inside the `kw-url-section` and `kw-section-shell` shadow roots. A compound E2E selector spanning both roots is not clickable; tag the actual rendered button/resizer with test-only `data-testid` attributes during setup, then use the normal E2E click/double-click steps.
- Exact empty `.kql.json` / `.sql.json` siblings project deterministic pinned primaries without becoming dirty. Keep raw bytes unchanged as CAS authority, normalize only first-primary implicit defaults for dirty/section status, retain result/UI fields and opaque data exactly, and materialize the destination kind on the first authored metadata Save. `blank-file-empty-companion` covers KQL/SQL hide/restore without change markers, clean close, reopen, authored name edit, future-field preservation, and exact primary linkage.
- For reliable multi-line strings inside `I evaluate` steps, build newlines with `String.fromCharCode(10)` rather than relying on `\n` escaping through Gherkin and JavaScript string layers.
- In default launch mode, SQL sections may show `No SQL connections configured.`. This is expected unless the test uses a prepared profile or attach mode with SQL auth state.
- `kustoWorkbench.test.seedSupplementalSchemaDiagnosticsState` creates two synthetic Kusto connections and current-version raw schema caches without network/auth. Always call `kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState` after closing fixture editors; it removes only synthetic cluster/cache/file-pin state and restores the previous selection.
- The supplemental diagnostics seed currently stores table `OrderedColumns` as an object. Monaco-Kusto first-load expects an array and can reject it with `TypeError: e.map is not a function`; prime the worker through an existing valid schema before using this seed, or use a valid array-shaped schema when testing first-load behavior.

## Known Issues & Workarounds

<!-- Flaky areas, timing-sensitive steps, framework workarounds -->

- Published-package investigation can use an inert development driver plus the actual VSIX installed into its isolated named profile. This keeps Workbench out of `--extensionDevelopmentPath`; verify the installed path/version, absent development-only Workbench commands, and bundle SHA against the VSIX. The public `vscode.Extension` object has no `extensionMode` property. When the profile already has an `extensions.json` registry, install the controller VSIX explicitly too: the runner's `_controller` link alone was not registered. With `--test-id`, `--features` is joined to the driver path even when absolute; use a relative path or stage byte-identical features beneath the named profile's test directory. Without `--test-id`, an absolute feature directory works.
- Clone only test-profile `Local State`, settings, and the authentication state database plus the CLI-owned shared auth store. Exclude browser caches, backups, and workspace/window restore state. A full prepared-profile copy consumed about 70 GB during this investigation; only the new disposable copies were removed. Never alter the original prepared profile or use its user-data directory concurrently.
- `published-notebook-corruption` observes real installed-package open -> registered query edit -> hide/reactivate -> Markdown Add -> native Save -> shrink -> Save/reopen -> later edit. On VS Code 1.139.1, 4.7.4 (`20260928-222935`), 5.0.0 (`20260928-223114`), and 5.1.1 (`20260928-223427`) completed without a malformed JSON revision. 5.0.0 nevertheless lost the large first saved result. 5.1.0 (`20260928-223228`) failed Add with an allocated section ID and `The host document is reloading after a concurrent section command failed.`; the note existed on disk, and its log recorded a native Save barrier failure because pending Markdown commands did not settle. Do not replay that ambiguous mutation or call these results proof of the repeated-tail cause.
- A real 5.1.1 Workbench-agent conversation on a synthetic 5.5 MB notebook completed query rename/edit, Markdown Add, and approved native Save with four saved results and exact buffer/disk bytes. Hide/reactivate/close/reopen retained the hash. The next model request failed before editing with `SQLITE_CANTOPEN` from Agent Host session persistence, so the post-reopen model edit is not covered. The current agent picker uses visible `span.title` labels; native CDP input avoids foreground-loss UIA failures. `workbench.action.chat.open` can target the sidebar/new session instead of an existing chat editor. Inspect the exact selected agent and conversation before submitting. Screenshots in this investigation were not visually reviewed because image fetching is disabled for this chat.
- Keep the scheduled latest-VS-Code gate: version drift is intentional compatibility coverage. Do not replace it with a pinned pass or hide assertion failures through retries.
- The suite runner reads `timeout`, not `stepTimeoutMs`; unknown top-level E2E settings now fail discovery. A step's explicit wait must fit within the outer CLI timeout.
- Notebook helper readiness is `body[data-kusto-e2e-ready='true']` in the exact file tab. It proves helper registration, not schema/worker readiness. Standalone tutorial/first-launch bundles do not have this marker. Title targeting can activate a tab, so focus-retention tests must first assert the exact active URI through the extension host.
- CLI 0.1.23 reactivates named tabs before every operation. Keep title targeting at initial open/reopen readiness, then use the active webview for keyboard, suggestion, or chat-focus assertions with unrelated panels closed. Do not remove the required `in the webview` words from ordinary evaluate/wait/click steps when removing a title; JSON artifact steps have a different optional suffix. Gherkin parsing alone does not validate registered step syntax.
- FlaUI can reject a second same-position `I move the Dev Host to 0, 0` within one scenario outline run. Position and resize once in a setup scenario when every later scenario shares the same window; screenshot metadata must still prove the target remained at the expected bounds.
- Return/await `clearSections()`: an empty DOM does not mean the host accepted removals. Cleanup/capture must retain canonical acceptance and failure checkpoints across quiet periods and source/session retirement before IDs can be reused.
- Isolated fresh scratch sessions use the canonical starter factory like normal first use; existing blank or zero-section KQLX/SQLX documents now reopen with one projected document-kind starter while their source bytes remain unchanged until mutation and Save. The text-diagnostics seed must await supplemental startup cleanup before capturing or changing selection.
- Scratch-session startup acceptance must not depend on connection isolation. Development E2E runs using `KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH=1` also await `waitForOpenEditorInitialized` before `kusto.openQueryEditor` returns; only isolated runs close/reset the session. The helper-ready marker alone cannot prevent an initial generation replacement.
- `seedKustoIdentityChecklist` must settle token-override lifecycle invalidation before writing database and schema caches, and reject `setDatabases(false)`. Scheduled run #160's trace retained all five explicit account preferences while Foobar lost its database cache; do not misclassify that as the earlier preference-loss failure.
- `vscode-scrollbars` exercises first-launch setup, so the suite passes `KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH=0` and its settings declare `timeout: 45000` for existing 35-second waits. A timed-out step without a failure screenshot is not visual evidence of the underlying UI state.
- `scripts/repro-vscode-memento.mjs --vscode-root <installation>` is an opt-in upstream diagnostic, not a suite retry or preference repair. The actual VS Code 1.137.0 Memento/storage classes lose pending preferences when an earlier FIFO whole-state echo lands before their scheduled send; serialized/coalesced/early-send controls pass. Run #162's trace is consistent with this race, but does not independently identify its storage transport ordering.
- For persistence E2E tests, assert both visible section IDs (`document.querySelectorAll(...)`) and direct `#queries-container.children` order, because persistence serializes direct DOM child order.
- Add explicit screenshots after scrolling to HTML/SQL sections; a top-of-document screenshot can pass assertions while hiding lower restored sections.
- This installed `vscode-ext-test` CLI does not currently provide the documented `I set setting ...` / `setting ... should be ...` Gherkin steps. Use per-test `e2e.settings.json` `workspaceSettings` for deterministic settings, or assert settings indirectly through the extension UI/state.
- In the Did you know viewer, DOM-driven `I evaluate` clicks on footer actions are more reliable than generic `I click "[data-testid='tutorial-standard-mute']" in the webview`; the selector click can miss that footer link even when the element exists.
- On this multi-monitor Windows machine, screenshot scenarios should move the Dev Host to `0, 0`, resize it explicitly, and close `workbench.action.closeAuxiliaryBar`; otherwise foreground focus can drift and invalidate native captures.
- A live force-refresh of the DevCLI schema can exceed the framework's effective 30-second step timeout. For deterministic preparation start/stop visual coverage, observe initial database-selection preparation; cover force-refresh success/failure with unit and host tests.
- E2E JSON artifacts reject `undefined` recursively. Diagnostic snapshots must emit `null` or omit optional fields, including supplemental `failureKind` and broker provenance.
- Scratch `session.kqlx` persists prior connection selections. Offline autocomplete tests must enable both host isolation (`kustoWorkbench.test.setIsolatedKustoConnections`) and webview isolation (`window.__e2e.workbench.enableIsolatedKustoConnections()`), then clear host isolation at teardown.
- `vscode-ext-test` v0.1.18 supports verified named-channel log levels with `I set the output channel "Kusto Workbench" log level to "Trace"` and `the output channel "Kusto Workbench" log level should be "Trace"`. Use these steps instead of automating `workbench.action.setLogLevel` QuickInput.
- After upgrading the CLI/controller, run `vscode-ext-test update` before using named profiles. A stale versioned controller extension can activate before `_controller-dev` and produce `Unknown method: getLogLevel` even when the linked development controller is current.
- v0.1.18 persists target-extension output through CDP fallback when controller interception is empty. Verify `_capture-manifest.json` reports `source: "cdp-fallback"`, then read the scenario-specific `Kusto_Workbench.log` artifact.
- A live `.show databases` request can exceed 30 seconds. Database-list Trace E2E uses a 45-second output wait and should run with `--timeout 60000` so cluster latency does not mask log-capture behavior.
- `kusto-execution-contract` is the native EXA ownership gate for normal execution, immediate same-target replacement, and database retarget. Keep immediate replacement low-resource (`print` followed by `print`): the true-long cancellation query can leave shared ADX under `E_LOW_MEMORY_CONDITION` and contaminate a same-database follow-up. Physical long-run cancellation remains in `query-cancel`.
- `kusto-restored-first-run` is the dedicated restored-target execution gate. It induces a connection-only lifecycle owner after restoring a real persisted `.kqlx`, starts outbound capture immediately before one real Run button click, and requires exactly one newer `kustoSectionTarget` followed by exactly one matching `executeQuery`. It then verifies 12 live rows, Save/close/reopen restoration, and exact artifact continuity. Run it with `--reuse-named-profile kusto-auth`.
- `kusto-run-all-session-persistence` is the exact scratch-session durability gate. It starts with a Favorites-backed runtime target deliberately absent from authored section state, selects sticky Run All from the real menu, selects Result #3, closes immediately without Save, reopens on Result #3, then switches to Result #2 and verifies its row. It reruns from the sticky main button and repeats the same Result #3 close/reopen to Result #2 transition, which also proves revision-2 artifact restoration. Do not replace it with a pre-seeded `resultJson` fixture or add chart/transformation edits that can mask result-commit persistence.
- Multi-result persistence coverage must combine non-primary selection, close/reopen, restored selection, and a post-reopen switch in one lifecycle scenario. Separate selection-only and restore-only tests are insufficient because stale local artifact revisions can render rows correctly while host selection authorization fails.
- `kusto-selected-result-chart-independence` is the cross-surface multi-result gate: the query displays Result #2 while the rendered Chart Data dropdown selects Result #1 and the real Preview button is clicked. Both indexes are asserted in durable bytes; close/reopen must preserve `second / 2` in the query, `first / 1` in the Chart, and the same chart dropdown option, while the reopened query picker must still switch away and back without changing the Chart binding. Do not replace the chart dropdown event with direct `dataSourceResultIndex` injection.
- The first normal-run scenario in `kusto-execution-contract` has once timed out with a genuinely stuck spinner while the two later scenarios passed; an unchanged rerun passed 3/3. Keep this in the flake ledger, inspect the failure screenshot and per-scenario logs, and never report the rerun as a clean first attempt.
- Persisted multi-section startup must be tested from a real `.kqlx` copy. Restored logical targets can exist before `connectionsData` supplies `connectionRevision`/`connectionIdentityKey`; sections must republish the stamped target, schema prewarm must use the section API, and exact-generation schema responses must compare the logical connection/database target rather than requiring those host-only stamps in the response envelope.
- `legacy-result-migration` has historical evidence from runs `20260825-213243` and `20260825-204825` for the former provenance-stamping/descriptor-removal contract. Those runs do not qualify the current saved-data contract. `kustoWorkbench.test.preparePersistedResultFixture` with `legacyKusto: true` supplies markerless rows and a legacy descriptor; saved-state reads must now preserve those bytes and metadata rather than stamp a current principal or delete the descriptor. Runtime capability admission remains separate and must not trust elevated legacy claims.
- `legacy-unresolved-result` is the ownerless saved-data-preservation gate. It copies the ragged fixture to a unique URI without preparing a Kusto owner, retains visible rows and a working Chart through auth/LNT changes, edits the Chart through real Edit/Preview controls, saves, verifies exact `resultJson` plus `resultArtifact`, closes/reopens, and saves again with the same attachment. The display-only runtime policy remains `{}` with no table CSV Save; preserving a saved descriptor does not grant active-content, model, clipboard, or CSV permissions or mint provenance. Do not enable Trace logging: it changes startup timing and can mask canonical projection races. Committed attachment A must survive rejected replacement B, target/account changes, and NEW-write filtering without retargeting authored fields; final native/sidecar callbacks restore the saved baseline after filtering. Recorded run `20260916-194200` passed all 54 steps with 20 JSON artifacts and 2 screenshots. This is scenario-specific evidence; the full unit suite is pending, and no full quality-gate pass is claimed. Earlier August runs exercised superseded preservation/migration oracles and are not current-contract qualification.
- `kusto-restored-startup` is the permanent no-click/reopen regression for multi-section schema preparation. An unfocused restored section may retain a pending worker update, but once raw schema is fetched it must be `deferred/waiting-focus` with empty blockers, `aria-busy=false`, and no `kusto-section-preparing` animation. The test must prove all five sections reached that state before any editor click, then prove one valid focused worker reaches stable `ready` while the other four remain deferred, save/close/reopen, and repeat the no-click assertion.
- Execution diagnostic JSON artifacts must project terminal fields explicitly and convert absent optional values to `null`; raw terminal objects contain `undefined` fields that the artifact collector rejects.
- `kusto-authority-live` is a deliberately opt-in guest-tenant fixture. Its `e2e.settings.json` sets `optIn=true`; run it only with `--include-opt-in-tests` and the `KUSTO_AUTH_REPRO_*` environment contract documented in `tests/vscode-extension-tester/FULL_SUITE.md`.
- `kustoWorkbench.test.runAuthorityLiveFixture` is development-only. It seeds two same-endpoint connections with different authorities, uses one exact prepared-profile account, and asserts the target database is visible only through the resource authority. Always pair it with `kustoWorkbench.test.cleanupAuthorityLiveFixture`.
- VS Code 1.129 requires the framework custom-tab fix: activating `TabInputCustom` must use `vscode.openWith(uri, viewType, ...)`, never `showTextDocument`, or a raw-text twin is created and title-targeted webview steps hit the wrong tab.
- Kusto Workbench custom editors use a generic HTML title. After tab-label activation, the framework may target the unique visible webview; multiple visible webviews must fail as ambiguous rather than choosing one.
- Screenshot-generator runs can attach a later `I evaluate` step to an outer custom-editor frame even after a shadow-piercing selector wait found the inner table. Prefer persisted fixtures plus selector-driven capture after restore; when JavaScript is unavoidable, keep setup and assertions in one evaluation that already proved it owns the target DOM.
- `document-capabilities` is the native COD-2 gate. It covers actionable read-only MDX incompatibility, exact MDX add controls, opaque-only Save, and SQLX comparison create/save/reopen/remove/recreate/save/reopen with exactly one `sql` comparison retaining `comparisonSourceBoxId`.
- `host-owned-markdown-lifecycle` is the native DOC-1/DOC-2/DOC-3 gate. It covers one host-owned Markdown + URL + Python command stream, stale rejection, throwing component serializers, Save/close/reopen, exact mixed order, Python's five persisted fields, and lossless root/state/known-section/opaque preservation. Default URL `imageSizeMode: "fill"` is canonicalized by omission, so strict JSON artifacts should emit `null` for that optional field. DOC-3 run `20260803-124847` produced a trustworthy `1280x1000` screenshot plus serializer, immediate-buffer, and durable-file JSON artifacts.
- `python-execution-application-handler` is the isolated native HST-3 gate. It uses only built-in Python, clicks the real `.run-btn`, requires exact visible `HST3:24`, saves, closes/reopens, and verifies raw durable Windows stdout (`HST3:24\r\n`) plus normalized output and `dirty:false`. Final reviewed-build run `20260805-194937` passed first attempt with a clean foreground `1280x1000` screenshot and two reviewed JSON artifacts.
- `imported-csv-save-application-handler` is the isolated native HST-4 gate. It locally seeds an exact URL-section fetch identity and matching CSV response without network I/O, clicks the real `[data-testid='data-table-save']` control, drives the Windows Save As dialog, and verifies the complete 36-byte UTF-8 file through an extension-host JSON artifact. Final reviewed-build run `20260805-211100` passed 1/1 with a foreground-valid `1280x1000` screenshot showing the saved notification plus Open File and Show in Folder actions. The controller notification assertion misses this visible post-Save-As toast, so preserve the explicit screenshot and direct handler notification tests instead.
- `share-result-artifacts` is the native HST-5 gate. It preserves the exact artifact A/B/deny/revoke webview contract, then verifies the actual rich clipboard through `vscode.env.clipboard.readText()`. Its second scenario sends `copyAdeLink` through the real webview/host transport with a deterministic seeded Kusto connection, asserts the exact ADX cluster/database/query prefix in the host clipboard, and captures the success toast. Definitive reviewed-build run `20260805-231107` passed 2/2; the exact JSON contained artifact B and excluded denied/revoked rows, and the foreground-valid `1280x1000` screenshot showed `Azure Data Explorer link copied to clipboard.`
- A preceding HST-5 `kusto-identity-manual-checklist` run stopped before clipboard on an unrelated Connection Manager Favorites alias assertion. Do not use that broad checklist as the HST-5 gate. A later controller notification assertion also missed the visibly present ADX success toast after the exact clipboard assertion passed; use exact clipboard data plus immediate screenshot, with direct handler tests for deterministic notification calls.
- `host-owned-markdown-lifecycle` now also contains the native DOC-4 Chart scenario. It uses arbitrary ID `sales-chart`, waits for every exact `markdownDocumentCommandResult` before Save, proves zero projection reloads/Chart serializer calls/equal-projection commands, retains a runtime marker, asserts an accepted Save barrier, rejects a stale command, and verifies nested Chart future fields plus exact mixed order after reopen. Definitive clean DOC-4 run `20260803-194348` passed 2/2 with clean `1280x1000` screenshots, eleven reviewed JSON artifacts, and no product-originated extension-host Save error.
- `chart-regressions` includes the adaptive axis-title gate. It renders dense date labels plus million-scale values, proves stored `30/45` defaults remain runtime-only Auto sentinels, checks transformed ZRender title/tick glyph bounds, opens the real X-axis settings control, and presses ArrowRight to verify exact Auto-to-manual handoff. Keep both popup and clean-chart screenshots; lower-layer coverage owns resize, short-canvas, heatmap placement, zero-size teardown, long-label, nice-endpoint, and stacked-total permutations.
- `host-owned-markdown-lifecycle` also carries the native PRO-1 view-session gate. It persists session A's host-created UUID through one command/Save, recreates the panel with a distinct session B UUID, injects an otherwise valid A command into B and requires no terminal or mutation, then proves one B command/result and clean persistence. Keep `files.autoSave` off for this test ID. The generated `document-view-session.kqlx` fixture intentionally remains on disk after close so a named profile cannot restore a deleted last-active custom-editor path.
- In repeated named-profile lifecycle runs, close editors, explicitly delete the old fixture, wait one second, recreate it, and wait one second before opening it. Rewriting an existing path is insufficient: VS Code can reuse a stale custom-editor model that reports `file was not found` even though the file exists.
- `kusto-azd-large-result` must leave its last-active fixture on disk for named-profile window restore, then delete/recreate it after clean-state closes editors. Run it with `--timeout 240000`; the default 30-second global timeout overrides its 180-second result wait during slower live-cluster attempts.
- For trustworthy unobstructed screenshots on this machine, move/resize the Dev Host, focus the active editor group, then click blank Activity Bar space at `30,700`. Clicking the title-bar center opens VS Code's command center and obscures the capture.
- Repeated Gherkin fixture setup must not rewrite identical file content. Preserving mtime avoids `File Modified Since` conflicts with retained custom-editor models across scenario outlines.
- For deterministic result-table presentation tests that do not need execution or restoration ownership, create a clean KQLX section and seed rows through its real `displayResult()` entry point. This avoids coupling UI-control coverage to persisted-result migration while still exercising the production table component and wrapper sizing.
- A custom element can satisfy a host-selector wait before its class upgrade creates `shadowRoot`. Before caching a root in a long evaluation, wait for a stable shadow descendant (for example, `[data-testid=tutorial-viewer-mode-standard]`).
- Embedded tutorial delivery must be correlated: changing `localResourceRoots` can replace webview content and lose blind show messages. Retry one request ID until the mounted overlay acknowledges it, classify that ack as startup-reentrant, suppress the embedded viewer's pre-ack `requestSnapshot`, and report success only after a current snapshot transport succeeds.
- Close the sidebar, auxiliary bar, and panel before unqualified main-editor webview evaluation. A visible Chat webview can otherwise win a later context lookup even after a selector wait found the Kusto editor.
- First-launch continuation coverage must click the real `button[data-add-kind='sql']` control and wait for `kw-sql-section`; a synthetic `HTMLElement.click()` inside a setup assertion is not evidence that the user control created the section.
- The framework notification-action registry can miss a fire-and-forget notification emitted before interception is installed. For the Kusto clarification fixture, use a 1000x700 Dev Host and the visibly verified native `View` coordinate `(955,635)`, then require both `manualClarificationSelections: ['View']` and the expected reveal/no-op webview state. Move/resize only in scenarios that perform this native click; repeatedly transforming the same hosted window in every scenario can fail with `InvalidOperationException` from UI Automation.
- Persisted-result fixture setup must settle auth writes and `ConnectionManager` lifecycle side effects before seeding caches: token-override events asynchronously clear that same account partition. Require generation-guarded database/schema writes, then revalidate the unique owner, partition, incarnation, Leave No Trace policy, and caches immediately before and after fixture publication.
- `complex-value-preview` drives table search through `[title='Search data']` and `.search-input`. Its highlighted-state artifact requires `(1/1)`, a visible `[data-testid='complex-value-preview'] mark.hl-cur`, and unchanged preview/full `textContent`; keep the pre-search and highlighted screenshots distinct.
- The fixed controller never leaves save-confirmation dialogs unattended: clean-state reset discards dirty test editors; explicit `workbench.action.closeAllEditors` discards them and fails with the dirty filenames.
- Use `${TEMP}` for direct-run-compatible E2E file paths. Do not put suite-only variables such as `${VSCODE_EXT_TEST_WORKSPACE}` in mutating Gherkin steps: an unset variable remains literal and resolves under the repository. A feature that adds its own temp workspace must validate canonical paths and reject links before and after adding it, verify it is the intended first workspace before writes, and declare the same path plus exact `managedWorkspaceOwner` marker in `e2e.settings.json`. Fixed temp workspaces are suitable only for serial tests: require the exact marker before deleting files and reject unmarked roots. Raw Windows runs retain only the marker because the active root cannot be removed; the full-suite runner removes the marker-owned root after the child exits, even when artifact processing fails. Managed untitled-workspace cleanup relies on the test's pre-run workspaceStorage snapshot, so never use the same named profile concurrently. For fire-and-forget VS Code notifications that the controller cannot enumerate, capture a foreground-valid screenshot before dismissal and assert the resulting file bytes exactly.
- After a native Save As dialog, the controller-backed notification assertion can miss a visible saved-file toast, and Windows UI Automation cannot enumerate its web-rendered action buttons. Verify exact file bytes and capture a trustworthy screenshot of the notification instead.
- GitHub-hosted Windows uses a 1024x768 desktop with a 1024x720 work area. Keep native-picker Dev Host windows at or below 1000x700 and allow three seconds after the Save control before driving Save As; oversized windows produced clipped captures and missing picker output in run `31659044893`.
- `vscode-ext-test` 0.1.18 `I save the file as` finds the real `File name:` edit and presses Enter, but does not prove the dialog closed or the file appeared. Keep a direct exact-byte/file assertion immediately after every native picker step.
- Accessibility-name clicks on custom-editor tab/title text are focus-only and can miss visibly present Chromium content. For screenshots use `workbench.action.focusActiveEditorGroup` plus an in-window blank coordinate. Clipboard writes additionally require a native click inside the webview, not the Activity Bar.
- After closing and reopening the same custom editor, wait one second before reopening so the retired CDP webview target is disposed; otherwise unqualified evaluation can attach to the predecessor target.
- The full suite supports deterministic round-robin sharding through paired one-based `--shard-index` and `--shard-count` flags. Scheduled default-profile CI runs four fail-independent shards.
- `kusto-favorites-sync` keeps 11 representative native scenarios covering every real file host in source and target roles. The complete 5x5 one-section and 3x3 many-section provider matrices remain in `kustoFavoritesApplicationHandler.test.ts` (34 direct permutations).
- `sql-copilot-chat` is the composed SQL Copilot regression gate. It uses the real SQL-auth owner and rendered controls with the development scripted model; toggles `execute_sql_query` through native interaction, covers prose-only and schema/execution tool rounds, registered agent delegation with a preserved manual draft, and real Escape/Stop cancellation. `window.__e2e.copilot` is inspection-only. Review its content-free round timing, long-task/mutation quiescence artifacts, and both screenshots; do not treat them as direct GPU-process measurements.
- `kusto-copilot-result-bridge` is the composed authenticated Kusto bridge gate. While the notebook is hidden it invokes the development-only `kustoWorkbench.test.evictActiveToolSessionConnection` command, then reactivates the tab and requires `askKustoCopilot` to reconnect, preserve a formatter-sensitive two-space string literal exactly through editor/start/terminal/tool-result identities, and render the complete 3-row by 4-column result. Use `--timeout 180000` and 120-second result waits because first live Kusto client creation has exceeded 60 seconds without a product failure.
- `workbench-tool-session-activation-sweep` is the retained/rehydrated dispatcher-epoch gate. It creates 76 KQLX files, activates all 76 custom editors, reactivates the first canary by exact `openFileId`, requires `sectionsUnavailable: false` with the original Query/Markdown/Development Notes IDs, updates the known query through `configureKustoQuerySection`, verifies the live editor text, saves and verifies exact clean durable bytes, closes all editors, reopens the canary, verifies the restored query, then closes and deletes the temp fixture tree.
- `agent-close-file-targeting` is the exact-tab lifecycle gate for `closeWorkbenchFile`. It rejects targetless invocation, opens two real KQLX custom editors, closes the non-active file by `openFileId`, proves the active file remains, mutates that file through `configureKustoQuerySection`, requires default dirty-close refusal, then uses `saveChanges: true` and verifies the exact durable query. Its second scenario opens linked-sidecar `.kql` and `.sql` compatibility editors, applies metadata-only collapse mutations while both primary documents remain clean, requires dirty refusal, explicitly saves/closes each target, verifies `expanded: false` in each companion while source bytes remain exact, and checks no target tab remains. Its third scenario dirties a hard-link alias of the companion JSON, proves even `saveChanges: true` refuses without changing disk or closing either tab, resolves that buffer explicitly, then proves the Workbench metadata saves and both exact target tabs close. Review both the dirty KQLX screenshot and the empty-editor completion screenshot.

- `powerbi-publish-status` mounts the production publish dialog with service-boundary interception, then drives real Publish/Re-publish, data-mode, destination-link, Close, and keyboard scrolling at 1000x700 and 420x560. The complete `.sd[data-overlay-scroll]` is the self-hosted OverlayScrollbars viewport: header, form, status, and footer scroll together. Scroll it to the bottom before asserting status/footer visibility; keep page-scroll oracles on the actual marked page viewport, not its wrapper. The scenario checks one themed scrollbar, compact geometry, Import completion/warning states, DirectQuery status, exact link destinations, retained update IDs, and same-component close/reopen without external publication or navigation. Default launch can have no `workspaceFolders`; capture the fixture tab URI after opening it and use that exact URI for `tabGroups.close` rather than deriving it from `workspaceFolders[0]`.
- `run-function-manual-checklist` opens the production parameter dialog in the default profile and verifies an input `mousedown` followed by backdrop `mouseup`/`click` leaves the dialog mounted with its value intact. Run `20260916-224037` passed 27/27 steps; review `run-function-dialog-drag-release.json` plus the before/after foreground screenshots.

## Testability Recommendations

<!-- data-testid attributes you recommended adding to the extension source -->

## Published Notebook Investigation (2026-09-29)

Run `node --test tests/scripts/published-notebook-journal.test.mjs` for the journal, expression-syntax, log-classification, and replay-plan checks. Run the opt-in installed-package investigation with:

```powershell
node scripts/repro-published-notebook.mjs --vsix out/releases/vscode-kusto-workbench-5.1.0.vsix --expected-sha 67dce6b9fa901aae84bbf98717732fbfa104381fb40d27054a89a82e90c84aec --repeats 3
```

The runner requires the existing prepared test authentication seed and cached Windows editor, never the normal profile. Its explicit 1.139.1 comparison pin does not replace the rolling scheduled gate. It installs a hash-verified package and controller in each new short-path profile, asserts effective Auto Save settings, alternates afterDelay/off pairs, retains failures, and never retries an ambiguous mutation. `--observation minimal` excludes per-event text copies but still validates checkpoint bytes. `--observation legacy --legacy-feature <retained-feature>` runs an unchanged older observer; its completion cannot certify exact saved-data preservation. `--prepare-only` prepares unused profiles and is not a test pass. No diagnostic VSIX is a release qualification.

The worker-backed journal retains immutable revision texts, document-open generation, range lengths, Save reason, per-section raw and canonical result hashes, attachment hashes, and original identity/order. Parsing and hashing run off the extension-host thread. Capture/transport and event-loop timing are recorded separately; a long event-loop delay alone does not identify its cause. Evidence lives outside fixture cleanup. Buffer/disk samples are checkpoint-time observations, not claims about exact disk bytes at an earlier `didSave` event. Native Save listener errors, invalid roots, lost payloads, incomplete capture, and ambiguous tool failures must never be presented as passes.

### Coverage Ledger

Contract: an ordinary installed Workbench edit/Add/Save lifecycle retains one valid notebook, all original saved payloads, exact intended edits, and usable post-reopen ownership. Separately, a native commit arriving after barrier acquisition but before final preparation must release its one unambiguous Save lease and fence late publication.

Acceptance path: four restored query sections with 5,566,501 bytes of saved data -> 70 KB query growth -> hide/reactivate -> named 65 KB Markdown Add -> native Save -> shrink/remove -> Save -> exact close/reopen -> second edit/Save. The model-selected path remains a separate evidence class from registered-tool replay.

| ID | Setup / action / oracle | Decision and evidence |
| --- | --- | --- |
| J1 | Capture immutable revisions, same-count payload replacement, empty result, attachment/order changes, formatting-only changes, overflow, write failure, separate cleanup roots, transient disk reads, warning-level Save failures, artifact-processing errors, native feature syntax, related journals and explicit fault outcomes | Include: 19 focused Node tests pass; normal and failure outcomes asserted, not just JSON validity |
| N1 | Existing `native Save fences a Markdown command still in transport`: barrier acquired -> hold final snapshot -> queue command -> commit first -> delayed snapshot -> command settles within 500 ms, no stale write | Include: exact intended red on pre-change source, green after owner change on VS Code 1.139.1 |
| N2 | Same integration lifecycle: normal commit, overlapping Saves, command after barrier, early commit without a competing edit, late snapshot timeout, mismatched committed bytes, canonical internal Save, source rejection, disposal | Include: exact text, terminal, queue and pending-mutation assertions pass; existing normal fences retained |
| N3 | Ownership suite plus overlapping native snapshots and overlapping KQLX result-generation Saves | Include: 57 pass; Python/Chart pre-ack tests time out both with this change and with the provider compiled from HEAD; not repaired here |
| N4 | Fixed early-commit assertion plus linked final-snapshot failure, retarget/physical-alias rejection, rollback, direct-edit preservation, immediate close, canonical Transformation restore, and overlapping native result Saves | Include: 15 pass; `linked notebook Save cannot publish a newer queued linked edit` fails its acknowledgement assertion both with this change and with the provider compiled from HEAD; not repaired here |
| P1 | Authentic 5.1.0, identical fixture SHA, three afterDelay/off pairs with worker journal | Include: `C:/kwpc/c26092918410316e8`; one retained-ID Add rejection, Save errors in every attempt; five later note assertions used the wrong `name` field and are harness failures, not lost titles |
| P2 | Authentic 5.1.0, corrected durable `title` oracle, one minimal-observation pair | Include: `C:/kwpc/c260929184928fec0`; both progress through reopen but reject the later query edit, with saved-result loss and Save errors; no malformed root |
| P3 | Current pre-change diagnostic VSIX, same paired lifecycle | Include: `C:/kwpc/c2609291858301a32`; Auto Save-on rejects Remove, off completes but logs Save errors; neither qualifies as passing |
| P4 | Corrected diagnostic VSIX, same paired lifecycle | Include: `C:/kwpc/c2609291943008b66`; Auto Save-on still rejects Remove with Save errors; off completes with exact payloads and no Save errors but has an event-loop timing warning; no release or visual pass |
| A1 | Two harmless model-selected list-sections requests in the same local Workbench conversation | Include: `C:/kwpc/c260929194952f871/a1/agent-preflight`; actual model/tool IDs and two completed response rows retained; no SQLite failure |
| A2 | Separate cold profile: real agent edit/Add/Save -> hide/reactivate -> exact close/reopen -> second model edit/Save | Include: `C:/kwpc/c260929194952f871/a2/agent-cold`; behavioral checks complete with two observed GPT-5.6 Sol turns, actual tool IDs, unchanged four raw result payloads, exact intended query/note state, and no native Save or SQLite errors; visual verification unavailable |
| D1 | Commit before barrier acquisition, or multiple indistinguishable active leases | Defer: not the N1 ordering; conservative fallback does not choose among multiple leases; overlapping Save identity needs separate evidence |
| D2 | Scratch, background rich-file, compatibility-sidecar and browser publication | Defer: production change is inside native Save coordination; unchanged owner paths are not qualified by P1-P4; N3/N4 exercise native canonical/linked neighbors, not a full other-host E2E matrix |
| D3 | Repeated-suffix corruption attribution | Defer: no ordinary workflow here produced malformed root bytes; the late-lease fix does not establish Lori's corrupting operation |

The first campaign, `C:/kwpc/c260929183546ed6b`, never reached a tool mutation: strict artifact output rejected undefined configuration fields, and the initial log classifier mistook an MSAL "ignored" warning for a Save error. Keep all six as harness failures; the classifier and settings projection were repaired and regression-tested. Do not include them in product failure counts.

The original named-Markdown Add followed by a title Patch already changed to one complete Add in `a4504d4`; do not duplicate that production change. Native `onWillSaveTextDocument` timeouts do not prevent VS Code from saving. A thrown listener or valid final JSON alone is not a preservation guarantee.

Current diagnostic packaging passed type checks and lint but hit the pre-existing webview size gate (3336 KB vs 3333 KB). The gate was not raised. Diagnostic-only VSIX hashes: before lease correction `9152f459b44110ccb761cac5531af17e3c9f4b68a7a5fb55eaecd33da8b7fccc`; after correction `a5c517c9c35aa1979b1e7732b63bdc8d4ac4b0855ef571a5b627f675781eddbc`. Both were installed only in disposable profiles.

VS Code 1.139.1's `chat.useAgentHost` is not a registered setting. Local-agent preflight used `chat.defaultToCopilotHarness=false`, `chat.editor.preferCopilotHarness=false`, and `chat.editor.localAgent.enabled=true` only in disposable profiles. Verify the actual picker says `Kusto Workbench`; the first `chat.open({mode: ...})` can silently leave `Agent` selected. `blockOnResponse` can stop at confirmation as well as completion, so check actual response rows and approvals. Keep generic tools enabled, record actual model/tool identities, and never synthesize successful-turn claims in evidence. Screenshots remain visually unreviewed in this chat; foreground-loss warnings further disqualify those individual captures.

### Native Checklist Follow-Up

The seven former manual checks were exercised with the E2E tooling, without changing production code again. New opt-in scenarios reuse the same hash-verified installed diagnostic package and isolated runner:

```powershell
node scripts/repro-published-notebook.mjs --vsix out/releases/kw-current-lease-fix-diagnostic-20260929.vsix --expected-sha a5c517c9c35aa1979b1e7732b63bdc8d4ac4b0855ef571a5b627f675781eddbc --feature-dir tests/vscode-extension-tester/e2e/default/native-save-workflows --autosave off --repeats 1
node scripts/repro-published-notebook.mjs --vsix out/releases/kw-current-lease-fix-diagnostic-20260929.vsix --expected-sha a5c517c9c35aa1979b1e7732b63bdc8d4ac4b0855ef571a5b627f675781eddbc --feature-dir tests/vscode-extension-tester/e2e/default/native-slow-save --autosave off --repeats 1 --cdp-port 61262
```

| Check | Automated action and oracle | Observed outcome |
| --- | --- | --- |
| Slow Save / next Markdown edit | Actual Ctrl+S, an injected 1100 ms preceding participant, one correlated final snapshot held FIFO, native commit, trusted `Z` input, matching command acknowledgement, no late overwrite, normal final Save | Confirmed on corrected package: `c2609292128530f80`, native commit to dirty accepted text 35 ms and matching acknowledgement 41 ms. The snapshot was held 671 ms and released after the commit. Pre-fix `c260929212505ed07` failed the one-second fence assertion with the same ordering, unchanged host version and no accepted command terminal. Expected native timeout logs are not a clean Save-health pass. |
| Auto Save Add/Remove lifecycle | Existing large restored notebook workflow, one-second Auto Save, exact tool result and native Save logs | Fails: `c2609292104077ea4` rejected Add with a retained section ID and reloading error; native Save reported timeout and unsettled commands. No mutation replay. |
| Save-participant health | Scan normal runs separately from fault injection, including warning-level abort/fallback and listener errors | Normal small native runs have no Save-log errors; Auto Save run fails this gate. Injected slow-Save warnings remain separately visible. |
| Normal Ctrl+S with results | Real ProseMirror typing, actual Manual will/did Save, 500 ms stable clean buffer/disk, exact result payload, close/reopen, next edit/Save | Passes in `c2609292137259cf0` checkpoints. Results are seeded authored rows; this does not claim live query Run coverage. |
| Native linked notebook | Native `.kqlx` linked to a plain `.kql`, actual Monaco input/Ctrl+S, exact disk and clean linked-buffer requirements | Fails. Earlier formatting-on runs `c26092920520780b6` / `c2609292101196c3e` failed after reopen; only `c2609292101196c3e` independently verified the focused, visible live query 3 while disk stayed at query 2. The stricter formatting-off control `c2609292137259cf0` fails its first clean linked-save oracle with disk still at query 1. This is not yet an isolated root-cause claim; do not call the earlier first disk-only check a clean linked Save pass. |
| Rapid double Ctrl+S / next edit | Two shortcut presses followed immediately by native typing and final Save | Next edit preserved. Only one Manual will/did pair was observed during the phase, so this verifies coalesced shortcuts, not two distinct concurrent native Save transactions. |
| Formatting settings / next edit | Enable insertFinalNewline, trimTrailingWhitespace and trimFinalNewlines in the disposable profile, native edit/Save/next edit/Save | Stable bytes and next edit pass with settings on. This does not independently prove each formatter transformed the raw file; reset all three settings before the linked control. |

Keep the failed attempts: `c260929205735eb70` stopped at a real input/focus guard; `c260929213506f21e` was interrupted without final results and has no product verdict. Slow-Save attempts `c260929211605b093` / `c2609292118231bb0` held zero replies and are invalid probes. `c2609292125502f94` observed accepted text/command promptly but sampled dirty state before its asynchronous notification; the final test waits for both inside the same unchanged deadline.

The slow-Save reply can be emitted before the added incoming listener runs, even in capture phase. Hold the first nonempty final-persist reply ID at the existing outbound hook, then independently require the captured host request to match it. Queue all later outgoing messages FIFO, release on trusted ProseMirror input, cap the hold, and reject a missing hold or out-of-window ordering. Preserve wire evidence before throwing the behavioral assertion. The renderer's 1750 ms participant abort is deliberately induced in its own fresh profile, never mixed with ordinary Save health.

The runner now exposes `EXPECTED_FAULT_CONFIRMED` only alongside a completed fault scenario, validated text observations, and retained native timeout logs; it is not `PASS_UNREVIEWED_VISUAL` and does not make the campaign a release pass. It scans every related notebook journal even when the feature stops early. Read-only scans of both earlier formatting/linked journals found zero invalid JSON, preservation violations or raw result changes. Do not run other terminal-backed agents concurrently with a native test command; retain incomplete attempts instead of inferring a result from partial terminal output.

### Save Fixes And Remaining Cold-Schema Gate (2026-09-30 UTC)

The follow-up fixes demonstrated first-party linked persistence and Save-lease defects. It does **not** close the cold large-schema Auto Save timing gate or attribute Lori's repeated suffix. Generic editor/execution/agent tools remain available. No original notebook, normal profile, existing user tab, version file, commit, or remote ref was changed.

Campaign IDs and this date use UTC; the corresponding VS Code output-channel logs use the preceding local calendar date.

- A clean native notebook can omit linked query text and therefore no-op on Save. The accepted user-save path now reserves the linked write queue and natively saves its exact owned linked buffer. Dirty-notebook commits finalize the matching buffer; delayed commits after rollback restore accepted disk bytes while preserving newer dirty drafts. New/failed Saves retire obsolete replay candidates and cannot publish the latest unowned draft.
- Native commit before barrier acquisition reproduced a still-pending preparation in the existing provider lifecycle. Unambiguous pre-lease preparations now retire on noncanonical commit; late barrier/projection continuations cannot acquire a lease. Ambiguous overlapping preparations remain conservative, and canonical internal saves do not retire user work.
- Scalar-only diagnostic package `48c8e6a55cef6bdadf68bcacba3091c64643c6c1e164505484dbd18d0892a12f`, campaign `c260930035234993e/a1`, proved an identical-byte canonical restoration held its transferred lease for 6.66 seconds after commit, causing the five-second Add deadline to expire. Exact candidate/row-free equality now bypasses fresh publication inside the lease-settling `finally`. All temporary trace code and its environment switch were removed.
- Full-host CPU profiles located redundant processing and transfer of a roughly 41 MB schema. Negotiated `schemaDataBytes/2` keeps complete schema bytes and per-message identities, with object fallback; primary preparation is single-flight. One-pass canonical signatures preserve exact old hashes, phase yields recheck authority, and bounded debug previews do not serialize the entire schema string. Shared immutable disk decoding is stat/epoch-fenced, limited to four entries/64 MiB raw bytes per storage owner, and invalidated by every schema mutation. These improvements do not make the remaining cold-start deadline a pass.

#### Follow-Up Coverage Ledger

| Case | Exact setup, action, and oracle | Executed result |
| --- | --- | --- |
| L1 | `kqlSidecar.test.ts`, clean/dirty native linked user-save pair: different-length query edits, formatting newline, next edit, gated Save plus queued draft, Save=false, external durable edit; exact notebook/result bytes, linked disk/buffer equality and clean/dirty state | Pass; both initial states |
| L2 | Queued newer linked edit -> rollback -> late actual notebook commit; disk gets accepted candidate, newer buffer stays dirty. Abandoned Save -> newer failed Save cannot resurrect a candidate or save the draft. Late close with no newer draft must end clean | Pass; strengthened three existing lifecycle tests |
| L3 | Six real VS Code TextDocument probes: same/different length, immediate/1500 ms delayed owned publication, direct edit during Save with/without prior publication | Pass on 1.139.1. Ordinary native Save includes direct edits made during participants; an owned-publication conflict returns false, retaining accepted disk bytes and the newer dirty buffer. This is not a promise that all direct native edits remain dirty |
| N5 | Existing `native Save fences a Markdown command still in transport`: commit before barrier reply, late reply, commit during held projection, canonical pre-lease commit, two ambiguous preparations, normal successor Save, acquired-lease early commit, overlapping Save, timeout, disposal | Red-first then pass; exact 500 ms retirement oracle and existing normal fences retained |
| N6 | Identical committed bytes plus held fresh-publication queue -> native commit -> queue tail resolves within 500 ms, zero fresh publication calls | Red-first then pass; fixes the measured 6.66-second no-op hold |
| N7 | Corrected `canonical public-row restoration keeps a Transformation command queued until restore completes`: new result absent from durable baseline -> explicitly row-free native Save -> held fresh publication -> saving-panel disposal -> survivor command -> release -> rows durable before command | Pass. The old fixture already stored its result on disk and did not prove genuinely required restoration |
| S1 | Gateway/dispatcher v2 negotiation, old-client fallback, malformed and stale payloads, per-request headers with shared bytes; service same-account/force sharing, failed load/retry, cache write failure, changed authority after each yield | Pass; included in final eight-file 712-test Vitest ring. The cached pre-signature yield asserts zero signature calls before release; the post-signature yield asserts exactly one |
| S2 | `schemaIndexUtils.test.ts`: one traversal of raw subtree; exact pre-change digests for normal and cyclic/special/hostile-key inputs. Real private 41 MB schema old/new hashes equal, one local 741 ms -> 598 ms measurement | Pass; no content identifiers logged and no claim of universal timing bounds |
| S3 | `schemaCache.test.ts`: reference-identical frozen snapshot, external change, TTL aging, malformed/repair/missing, write/clear/connection/account invalidation during cold read and warm stat, same-metadata internal rewrite, LRU/byte/oversize/negative-size bounds | Pass; 15 cache tests. Shared mock supplies real FileType values; native race fixtures override/restore the fs getter descriptor, not frozen methods |
| B1 | Python-only and Chart-only Save must remain pending until projection acknowledgement, then preserve host-owned state against stale adapter text | Pass. Earlier pre-ack timeout fixtures are repaired, not masked by larger deadlines |
| B2 | Final native persistence, linked real-SDK, schema cache/list/search combined ring | 131/131 pass on 1.139.1, 39 seconds |
| B3 | Final gateway, dispatcher, protocol, schema service/signatures, client, cached viewer, and auth identity ring; journal/runner contract suite | 712/712 Vitest and 19/19 Node pass |

The latest installed package is `out/releases/kw-save-schema-yield-20260930.vsix`, SHA-256 `ce29f0cc52c9fcad51c63ae8d51f31b5eed49d4cc6986c29282fa4347ebe4eba`, packaged as 5.2.0 without changing repository version metadata. Its last production change yields between the completed disk-cache read/validation and signature generation, with authority rechecked before continuing. The native keyboard and injected-fault checks below last ran on the preceding `out/releases/kw-save-schema-cache-20260930.vsix`, SHA-256 `a30ecd33a60a6ef3c439200daad86203af729d1b4a4c11599d01806efe4470be`; native persistence implementation is unchanged between them. Normal prepublish passed host/webview/connector types, ESLint, production build, connector preparation, and all bundle gates. The webview baseline changes from 3283 to 3287 KiB with its 50 KiB buffer unchanged: measured original baseline 3282.614 KiB, already-committed HEAD 3335.535 KiB, current main webview 3336.365 KiB. The codec contributes less than 1 KiB; the final ceiling is 3337 KiB, not a reset that grants another 50 KiB.

| Installed check | Retained campaign | Outcome |
| --- | --- | --- |
| Latest large notebook, cached phase yield, Auto Save on/off | `c26093004550284c1` | All tool mutations and payload/reopen checks complete. On has no Save errors, but a 1562 ms host stall and transient invalid disk checkpoint retain `HARNESS_SUSPECT`. Off completes but logs a 1750 ms Save abort and final-snapshot timeout despite its longest host stall being 1406 ms. **Responsiveness gate remains open**; phase yields alone do not establish a fix |
| Preceding large notebook, bounded schema reuse, Auto Save on/off | `c2609300430211383` | All tool mutations and exact payload/reopen checks complete. Auto Save-on Add takes 577 ms, but native Save still aborts at 1750 ms during a 1988 ms host stall; **not a clean pass**. Off completes without Save errors but has a timing warning |
| Native keyboard Save, formatting, rapid shortcuts, linked query 2222 -> reopen -> 333333, next edit | `c260930043641ccd1/a1` | Scenario completes, exact linked clean/durable state and result preservation pass; no Save errors or invalid/preservation observations. `HARNESS_SUSPECT` remains because host event-loop maximum is 2590 ms |
| Injected slow Save, trusted input after native commit, no late overwrite, final normal Save | `c2609300435406d4a/a1` | `EXPECTED_FAULT_CONFIRMED`, CLI 0; only expected injected timeout. Not a normal Save-health pass |
| Real installed schema autocomplete parity, earlier v2 package | `c26093001315943e0/a1/schema-ui/schema-bytes-actual-evidence.json` | Refreshed legacy object and v2 byte paths each show exact 5/5 column suggestions, 4078 tables; byte frame 41,107,540 bytes. Initial cold worker preparation errored, so this is not cold-start readiness proof |

Keep earlier attempts: `c260930025419a856` is the six-run reviewed-package campaign (one clean on-pass; remaining timing warnings and two Save failures). `c260930030034b479` and `c260930040844c3fb` retain CPU profiles. `c2609300311348157`, `c260930032351a330`, `c2609300343196a0a`, `c260930035109c461`, `c260930035234993e`, and `c26093004050723e6` retain intermediate timing, transient disk-read, and/or workflow failures. Do not promote transient invalid disk samples to buffer corruption, or downgrade Save-abort logs to a successful health gate. Post-edit reviews found no remaining code blocker after their linked-finalization and invalid-size findings were addressed, but the cold-schema timing qualification stays open. No `view_image` was called; screenshots were not visually inspected.

### Lori's Two New Close/Save Samples (2026-09-30 UTC)

The new screenshot reports close -> Save -> automatic reopen as "corrupt", with an extension restart during one reopen; whether Workbench was updated is unknown. Lori says closing without saving and reopening can restore a usable file. The user subsequently confirmed Workbench 5.1.1 for these incidents but does not know the exact error screen. Do not assume this is the earlier repeated-suffix corruption.

Read-only intake of the supplied Downloads originals:

| File | Bytes | SHA-256 | Structure |
| --- | --- | --- | --- |
| `azure tools.kqlx` | 43,751 | `d3e29860f46fb64b9a4d237e3e7085cb42744e5a032dbd893ce2bfcadaa87271` | 19 sections: 8 query, 8 chart, 3 Markdown |
| `azure-canvas-github-copilot-search.kqlx` | 19,340 | `e02b0c791dc9537d5d7fed31bd71c770c3b3be9eae66a272bcfd509a5f071a33` | 13 sections: 10 query, 1 chart, 2 Markdown |

Both files pass JSON.parse and the current production parseKqlxText unchanged. Neither has saved resultJson or linked query paths. The originals were never opened in Workbench, and their hashes were rechecked unchanged after all experiments. Disposable copies, exact native UI actions, and scalar/hash event journals were used; no queries were executed.

| Case | Composed action and oracle | Result / retained evidence |
| --- | --- | --- |
| LC1 | Installed current `ce29f0cc...` package on 1.139.1: open original-shape copy -> native Monaco comment insertion -> exact active URI assertion -> Ctrl+W -> native Save button -> valid disk, no remaining/reopened tab, full semantic comparison against original plus that one comment | Both files preserve every other field and section, with zero invalid buffer revisions. `C:/kwpc/c260930055209672e/a1/incident-copies/ordinary-close-evidence.json` |
| LC2 | Current second file -> native edit -> Ctrl+W -> native Don't Save -> original disk SHA unchanged, tab absent -> explicit reopen -> original query restored | Pass; same campaign's event journal and `second-reopened-query-focus` artifact. This does not cover an already-invalid dirty buffer |
| LC3 | Current second file saved/closed -> explicit reopen -> actual Restart Extension Host requested 39 ms later -> reattach controller -> inspect untouched disk/buffer and native workbench DOM -> close exact clean error tab -> reopen | Reproduces a native editor-resolution error, not malformed bytes: renderer logs `Assertion Failed: Argument is undefined or null` in `xh.resolve`; UI says "The editor could not be opened due to an unexpected error. Please consult the log for more details." No iframe exists. Disk/buffer SHA remains `65573911caf2044e31d7914f04eec2e7629e30c219fc83ab00813a4477d11a49`, clean, 13 sections. Close/reopen restores all 13 sections and exact edited query. See `incident-copies/after-restart-host.json` and `restart-attached/json-artifacts/Live_step/reopen-after-native-error.json` under the same campaign |
| LC4 | Authentic published 5.1.1 VSIX `c79e816e3b8e87788cf861ea86a5d9134fd70a0b7b3bf9dff7a20a34872a1568`, same editor/settings and fresh original copies -> native edit -> close prompt Save -> compare full document and tab state | First file exact intended edit only. Second remains valid with all 13 sections and no auto-reopen, but six `copilotChatVisible: true` fields are omitted on the first edit before close. This is separate metadata loss, absent in LC1, not the reported malformed-file symptom. `C:/kwpc/c26093006111637c2/a1/incident-copies/release-summary.json` and `released-second-differences.json`; reopened second UI restores all 13 sections and the edited query |

The existing strict Save-log scanner reports zero errors/warnings for both campaigns. LC3 is a real native editor-open failure but is not established as Lori's exact screen, and no save of a known-corrupt buffer was reproduced. The current package's large-schema Save responsiveness failure remains a separate open gate.

Retain harness failures: the first live setup expression failed to compile because a JSON-encoded newline became a literal newline in a JavaScript string (no setup executed); use String.fromCharCode(10) for those live JSONL strings. The native Enter step inserted no newline, so full-document expected-text checks were corrected to the observed exact 24-character comment insertion, without hiding other changes. The first 5.1.1 host-buffer check ran before the edit propagated; the next check proved the edit present, without retyping, and the second file used an explicit bounded acknowledgement wait (422 ms). Restart disconnects the original controller: reattach by exact isolated controller/CDP ports with no profile flag; attach mode rejects named-profile flags. The missing-webview checks after restart are retained as failures, followed by native DOM/log evidence and successful recovery; they are not a complete passing corruption scenario. No screenshot images were viewed, and visual verification remains unavailable. All task-owned tabs/controllers/hosts were closed after evidence capture.

### Cooperative Schema Follow-Up (2026-09-30 UTC)

The remaining Save timeout was investigated separately from Lori's new files. The receiver previously reparsed each identical 41,108,420-byte schema delivery: four local production-decoder calls took 1,608 ms. Exact-byte reuse now takes 553 ms for the same workload, with repeat decodes at 37-53 ms. The shared decoded object is deeply frozen; each request retains independent metadata and full admission. Worker fast/full preparation and its actual background enhancement callback now own function-record copies, including the normalized, cached, and alias-published graph. Tests failed first on frozen function mutation, then on returning the original unenhanced graph to the worker cache; both paths are corrected.

The host signature traversal is now cooperative without changing digest bytes. A local measurement on the same private schema completed in 801 ms with 339 timer callbacks, a 237 ms maximum callback gap, exact baseline digest equality, and one shared promise for two concurrent calls. Wide-object, primitive-array, nested-object, cyclic/special-value/hostile-key, rejected-load retry, and all five delivery-route identity-change checks pass. These measurements are local observations, not upper bounds for arbitrary schemas or machines.

The candidate package is `out/releases/kw-schema-cooperative-signature-20260930.vsix`, SHA-256 `1bf36433516e772fbc73870bcba858ec9a73ceab5d8044efaa2ecb584d55710f`. It passed normal host/webview/connector type checks, ESLint, production packaging, and all bundle gates. Receiver/worker changes add exactly 818 minified webview bytes, bringing the main bundle to 3,417,256 bytes / 3337.164 KiB; the synchronized baseline moves 3287 -> 3288 with its 50 KiB allowance unchanged, for a 3338 KiB ceiling.

| Case | Exact action and oracle | Evidence / result |
| --- | --- | --- |
| CS1 | Same cold four-query large-notebook tool edit/Add/Save/shrink/remove/reopen/next-edit path, one Auto Save on/off pair, unchanged deadlines and strict classifier | `c260930084536cf10`: both complete with no Save errors or preservation failures; on has a 1136 ms observation warning, off is `PASS_UNREVIEWED_VISUAL` |
| CS2 | Three fresh on/off pairs in the existing ABBA order, no ambiguous mutation retry | `c260930084849019d`: all six have zero Save errors, zero invalid buffer revisions, zero preservation violations, and zero failed tool operations. Attempts 4/5/6 pass cleanly; 2/3 retain 1008/1091 ms timing warnings; 1 completes all mutations but fails final journal qualification because `disk:hidden` sampled a 2,097,152-byte partial native write, plus a 1332 ms host-stall warning. It is **not** a six-pass or release-qualified campaign |
| CS3 | Fresh installed four-section fixture -> frozen real schema (4080 tables/5732 functions) -> native Ctrl+Space -> exact five-column suggestions -> native Ctrl+S -> exact clean buffer/disk -> close/reopen -> native Ctrl+Space again | `c2609300855330710/a1/schema-live`: ten live steps pass; exact 5/5 columns before and after reopen, full schema retained, no query execution. `schema-acceptance.json` records package identity and saved-file hash. Visual inspection unavailable |
| CS4 | Full sequential Vitest including downstream schema-cache consumers | Initial run: 8599 passed, 11 failed, 4 pre-existing skips / 372 files. Three fixture files supplied bytes from custom stores but inherited unrelated stat behavior. All 334 tests in those files pass after matching stat mocks; real-file adapter uses `birthtimeMs` for VS Code creation-time semantics, not Node inode `ctimeMs`. Final complete rerun passes 8610 tests / 371 files, with 4 pre-existing skipped tests / 1 skipped file, in 985 seconds |
| CS5 | Recompiled extension-host persistence/linked/schema-cache regressions, plus strict journal/runner contracts | 131 integration tests pass in 42 seconds; all 19 Node harness tests pass. Changed-file diagnostics and git diff whitespace checks are clean. Disposable hosts/controllers are closed; both original Lori file hashes still match intake |

Keep `c260930081356c843` as the decoder-only intermediate failure: all mutations/payload checks completed, but the on arm still logged a native Save abort. Only after cooperative host signing do CS1/CS2 show zero Save errors across eight independent attempts. This is evidence addressing the observed Save-deadline regression, not a guarantee against all timing failures; strict observation and visual qualifications remain explicitly open. No Save deadline, generic editor/agent capability, schema contents, or historical result preservation rule was weakened.

### Actual Production Close-Race Proof (2026-09-30 UTC)

Authentic installed Workbench 5.1.1 (`c79e816e3b8e87788cf861ea86a5d9134fd70a0b7b3bf9dff7a20a34872a1568`) on VS Code 1.139.1 reproduced automatic reopen, repeated-suffix buffer corruption, and a second native Save writing the invalid bytes. This supersedes the earlier absence of a demonstrated first-party corrupting operation. It does not establish which operation occurred in Lori's incident, the prevalence of the race, or identical runtime behavior in other versions. No product fix for this race was made.

The proof used a disposable two-section notebook, a real rendered Run of `print ReopenProbe = 1`, prepared authentication, Auto Save off, and native Ctrl+S. No result owner was seeded, no replacement was constructed or changed by the harness, and no Copilot/generic editing tool generated the damaging edits. The interposition delayed one actual result-bearing Workbench `workspace.applyEdit` across exact `tabGroups.close`; the first failing hold lasted 30 ms. This is timing fault injection, not an ungated reproduction.

Each extension receives its own VS Code API facade. A controller-side `workspace.applyEdit` hook observed zero Workbench calls. The correct facade comes from `createRequire(path.join(extension.extensionPath, extension.packageJSON.main))('vscode')`. Verify it captures a real production edit before arming; the initial proof used a successful registered query-title edit. An API hook that sees nothing is not a passing control.

Exact causal trace, retained in `C:/kwpc/c260930170414b352/a1/production-fixtures`:

1. Native Save committed valid, row-free JSON: 708 characters, version 5, clean.
2. The actual restoration edit was held, the pinned tab closed, and the unchanged edit released. The original document was still `isClosed: false` at release, but was closed/stale by completion. VS Code recreated a different document object; its valid restored text was 3,688 characters, version 6.
3. Two subsequent original Workbench edits ran after the held edit completed, not ahead of it. Both used range `(0,0)..(30,0)` from the old document. In the current text that range removed only 2,170 characters and inserted 3,688, producing invalid versions 7 and 8 at 5,206 and 6,724 characters. No tab existed during these corrupting writes; the automatic pinned reopen followed them.
4. The invalid text is exactly `validRoot + suffix + suffix`, where the root is 3,688 characters and the suffix is its final 1,518 characters. The root hash is `e5379f1cb51f4b13c5ca263445a8b60acfd3edb0c03667a6e2987f9e6f84ef9f`. Strict JSON parsing reports `Unexpected non-whitespace character after JSON at position 3700 (line 74 column 13)`.
5. Disk was still valid before the second native Ctrl+S. That Save wrote the exact invalid 6,724-character buffer and marked it clean. See `pinned-production-observation.json`, `before-second-save-proof.json`, `first-invalid-buffer.kqlx`, `valid-disk-before-second-save.kqlx`, and `after-second-save-proof.json`. `pinned-proof.kqlx` retains the damaged disk bytes.

The captured installed-bundle stack maps directly to the tagged release: `dist/extension.js:573:19500` is `restoreCanonicalNativeResults`; `573:7014`, `573:6635`, and `573:1560` are the edit/queue paths inside `repairPersistedSqlState`; `573:1275` is `applyOwnedSourceEdit`. Source inspection identifies the range owner: the repair loop reads `document.getText()` and builds `document.positionAt(...)` ranges from the provider's captured document without checking that it is the current live document. Tagged source also shows close finalization explicitly calling `repairPersistedSqlState(true)`, admitting the disposed owner; the captured async stack itself stops at the repair queue. Merely checking `isClosed` before an asynchronous edit is insufficient: the first failing document closed while that edit was in flight.

The historical source comparison remains bounded: 4.7.0 has neither that disposal-allowed repair call nor canonical native restoration; 5.0.0, 5.1.0, and 5.1.1 have both. Close repair was introduced by `90857301941cf9b84b4ac7bc7c5e9540ff4de2a9` and canonical restoration by `c88e9ff`, before 5.0.0. Version 4.7.0 still had asynchronous edits and `document.save()` on disposal, so this is not proof that every possible reopen race was absent then. Do not attribute the current branch's different materialization helper to 5.1.1.

| Case | Exact composed action / distinct boundary | Evidence and result |
| --- | --- | --- |
| PR1 | Real query -> native Save -> actual restoration crosses pinned close -> old document replaced -> original repair edits -> automatic reopen -> second native Save | Full corruption chain above, one observed live execution; no edit overtook the gate. Not a deterministic-frequency claim |
| PR2 | Same real query, no gate and no close during native Save; inspect every source revision and exact clean disk/buffer | `no-close-control-evidence.json` under PR1: all valid, actual results retained, two native commits, clean exact bytes |
| PR3 | Retained `native-save-close-race` feature, fresh authentic package, release immediately after exact tab close | `c260930174840616e`: intended gate reached, but original document object survived; valid restoration/save, no reopen. A passing timing interleaving, not a corruption-prevention qualification |
| PR4 | Same retained feature with an explicit 100 ms native-disposal interval after close | `c2609301754159038/a1/evidence`: expected red assertion `Closed notebook reopened automatically`; same document survived and JSON stayed valid. The gate and edit-order checks pass; this run does not reproduce PR1's suffix or require a second user Save because production already saved its valid restoration |
| PR5 | Fresh actual preview -> rendered Run -> hold its actual result persistence edit -> open another preview -> old tab absent -> release unchanged edit -> observe without opening/revealing old file | `c2609301754159038/a1/preview-evidence-2/preview-outcome.json`: original returns as inactive pinned tab, valid 3,839-character dirty buffer, zero malformed revisions. No native Save preceded this different producer boundary. Later selecting the existing tab and pressing Ctrl+S did not settle within eight seconds; disk stayed valid at 708 characters. Preserve `unsaved-buffer-for-cleanup.kqlx`; do not claim Save acceptance for this variant |
| PR6 | Natural close-prompt Save without a gate, exact original files, other published versions, current candidate, reload, SQLX/MDX, and multi-panel ownership | Deferred for this proof: the close-prompt exploration did not observe a native commit and its later cleanup Save timed out; other hosts/builds have different or unexercised ownership. Earlier ordinary-save/source-level controls do not replace this lifecycle |

Retained regression: `tests/vscode-extension-tester/e2e/default/native-save-close-race/native-save-close-race.feature`, opt-in only. It verifies installed main/journal identities against the replay runner's fully verified VSIX tree, waits for the real result to reach the dirty source, checks positive API interception, records native commits/document identity/line counts/ranges, rejects another edit entering while the gate is held and an unreached gate, preserves every buffer revision in the existing worker-backed journal, and asserts valid JSON, unchanged query/Markdown, exact saved bytes, and no automatic reopen. PR1's stronger after-completion ordering was checked separately from its raw events. It leaves all normal editing and agent tools available. The supplied baseline is read-only, must be exactly the dedicated result-free two-section fixture, and is copied to a fresh path; never supply a user's report.

```powershell
$env:KW_CLOSE_RACE_BASELINE = 'C:/kwpc/c260930170414b352/a1/production-fixtures/valid-disk-before-second-save.kqlx'
node scripts/repro-published-notebook.mjs --vsix out/releases/vscode-kusto-workbench-5.1.1.vsix --expected-sha c79e816e3b8e87788cf861ea86a5d9134fd70a0b7b3bf9dff7a20a34872a1568 --feature-dir tests/vscode-extension-tester/e2e/default/native-save-close-race --autosave off --repeats 1 --cdp-port 61328
```

Restore the environment variable afterward. The baseline contains the private prepared connection identity, not credentials; it is retained outside git. Its validity, actual Run, package identities, and immutable diagnostic provenance are required, not optional substitutes. A baseline in a different environment must use a legitimately available connection/database and the same literal `print` query.

Keep failed preparations: `c260930174039951e` reached a real result but the first oracle wrongly expected a primitive cell instead of `{ full, display }`; `c2609301742242996` saw rendered results before source publication, so the final test now waits for that source boundary. Both stopped before arming. The first preview attempt used title-targeted automation, pinned the preview, and captured no result edit; the valid PR5 rerun used an initially fresh preview and untargeted controls. The first live host also retained a mistargeted Run timeout and a later 90-second cleanup-Save timeout; those do not count as successful scenarios. No failures were deleted or silently reclassified.

Pre-edit and post-edit reviews were performed. The replay journal/syntax suite passes 20 tests. The exact suffix arithmetic and after-release ordering were independently asserted against the retained raw bytes/events. Screenshots were not viewed at the user's request, so visual inspection remains unavailable. Hooks/observers were restored in completed feature/preview runs; the first timed-out live controller rejected cleanup, then its disposable host was terminated, retiring all in-memory hooks. All task-owned hosts were ended; no original Lori file, normal profile, user editor tab, product source, version metadata, commit, or remote ref was changed by this reproduction phase.

### Partial Close-Lifetime Hardening: Blocked Gate (2026-10-01)

The user authorized the careful implementation plan after the previous work was committed. The worktree was clean at the start and `main` was 15 commits ahead. Preserve those user commits. The implementation remains partial and is not release-qualified: the unchanged installed no-reopen regression still fails, so linked/compatibility writer migration, tool completion changes, the full cross-version matrix, full repository coverage, and broader storage-lifecycle changes have not been claimed or completed.

Implemented in `kqlxEditorProvider.ts` and `textDocumentWriteOwner.ts`:

- Native owned buffer writes require the exact live `TextDocument` object, matching version/text, and the actual full-document range before submission. Completion rechecks the owner. A landed-but-retired edit is logged and cannot trigger another repair or Save from that retired owner; this cannot cancel the already-submitted native edit itself.
- Compensation still works when the same document survives in another Workbench panel or a visible native text editor. An owner with no surviving view cannot issue a follow-up rollback. The two branches now have separate assertions rather than treating panel disposal as document disposal.
- Owned edit registration has an exact cancellation handle. Cancelling a registration already consumed by a change event cannot cancel a later registration with identical text.
- Close result materialization no longer uses `WorkspaceEdit` or buffer rollback. It uses the matching accepted durable baseline and physical identity, yields to a live successor or dirty same-file/physical-alias document, rechecks admission under the existing file lock, and holds fresh privacy publication through the actual durable write. Changed durable baselines are diagnosed rather than overwritten. Existing session publication and result-preservation rules remain.
- The existing file publisher is still an in-place truncate/write/sync operation, not an atomic rename or a general solution for uncoordinated external writers. No blanket conversion of ordinary native Save to raw disk writes was made.

The two integration suites use `liveTextDocumentTestFacade.ts` to register fake documents explicitly, preserve real VS Code document identity/lifetime, and restore API descriptors between suites. Production has no test-mode liveness bypass. A missing fake version is derived from observed text changes; tests for ABA/version races still need explicit counters. No real document is kept artificially live by that facade.

| Case | Setup, action, and oracle | Evidence / result |
| --- | --- | --- |
| IH1 | Existing committed Run All fixture, real native text tab -> exact tab close -> mocked Workbench panel disposal; assert no source edit after tab closure and exact primary/additional results plus artifact on disk | First attempts explicitly failed `PRECONDITION: captured native document did not close` because VS Code 1.140.0 retained the object. The final test is accurately named as a tab-close/surviving-document case. It then failed on a real 2,219-character post-close `WorkspaceEdit`, and passes after removing close buffer edits. This is not replaced-object or authenticated UI coverage |
| IH2 | Same fixture with a fresh-publication callback lifetime counter, observe the actual target's `r+` open | Both variants failed `[false]` versus `[true]` before the write moved inside the callback; both now pass. This verifies callback lifetime; real privacy algorithms are covered separately, not replaced by the counter |
| IH3 | External inode replacement fault during fresh result publication, plus same-inode external edit, accepted atomic-save identity refresh, explicit section removal, session Run All, and durable close settlement | Eight adjacent integration cases pass. The external-replacement fault moved from the deleted buffer edit to the publication callback; an explicit `replaced === true` assertion prevents a false pass, and the exact original external-byte oracle is unchanged |
| IH4 | Real EOF overlap, pending native Save lease, survivor Transformation command fence, registration-specific cancellation, visible text-editor compensation and last-view-retired no-compensation | Focused cases pass. First complete affected-suite run had 237 pass / 1 fail because the old panel-disposal mock did not specify whether a text editor survived. Its original rollback oracle is retained for an explicit survivor, with a separate no-follow-up-write case. Final complete run: 239 passing in 59 seconds on 1.140.0 |
| IH5 | Strict write-owner helper: closed, missing, duplicate, successor-with-identical-text/version, version/source drift, and Windows URI normalization | Ten focused Vitest tests pass; no fallback to a new document or URI-only ownership |
| IH6 | Installed candidate, real rendered query -> native Save -> hold actual restore edit -> exact pinned tab close -> release unchanged edit -> automatic reopen -> second native Save | `C:/kwpc/c261001074514e698/a1/evidence/lifecycle-summary.json`, `WORKFLOW_FAILED: Closed notebook reopened automatically`. Gate reached, no reorder, zero invalid revisions. The same document survived; edit #2 entered before close and landed after close. It created valid 3,741-character dirty text and reopened a pinned tab. The second Save checkpoint was valid/clean at 708 characters; subsequent close completion left valid 3,741-character disk bytes with one result. Not a no-reopen pass or proof of all preservation permutations |

IH6 package: `out/releases/kw-close-lifetime-20261001-0740.vsix`, SHA-256 `fe362d3affdfb649043528bec474810ee6557fc9e31926f02444aa53af801bfe`, installed version 5.2.0 on VS Code 1.139.1 for direct comparison with the historical proof. Normal type, lint, production build, VSIX and unchanged bundle gates passed. Later source-only review corrections added registration-specific cleanup, explicit surviving-text-editor compensation, diagnostics and under-lock alias revalidation; the full 239-test affected ring includes those corrections. The package is a retained experimental artifact, not a release recommendation.

The retained E2E was not changed to hide the red result, bypass its gate, or suppress automatic reopen. A `WorkspaceEdit` already handed to VS Code has no cancellation token available to these guards. Extending the guard to more providers cannot satisfy this remaining native contract. The next decision is the separately scoped storage/Save-lifecycle change identified in the plan; do not silently undertake a CustomDocument migration, remove generic tools, drop new results, weaken privacy, or call this fix complete.

Pre-edit and post-edit pessimistic reviews were used. Review findings about exact tracking cancellation and visible surviving-editor compensation were fixed and tested. The native in-flight limitation remains an explicit architectural blocker. Original notebooks, normal profiles and user tabs are not test targets. Screenshot images were not viewed, and visual review remains unavailable. No commits, tags, branches, version metadata changes or pushes were made.

Final source checks pass: 239 affected integration tests, 335 focused write-owner/codec/result-owner/privacy Vitest tests across four files, host/webview/connector type checks, and ESLint. The complete repository Vitest/coverage and remaining native workflow matrix were not run because the installed acceptance gate is blocked. The final review also identified a pre-existing `onWillSave` tracking-registration cleanup gap when native Save drops returned edits; it remains part of the deferred Save transaction-lifecycle work, not a claim repaired by the new owned-source-edit canceller. No candidate-profile Code or Node processes remain after cleanup.

### Root Save Publication Fix (2026-10-01)

This follow-up supersedes the guard-only blocker. The user's baseline was clean `main`, 16 commits ahead. The fix retains the shared native TextDocument, undo/raw/generic editing, URI queue, section/result owners, privacy rules, codecs and linked-file behavior. A CustomDocument migration was not needed.

Native result completion no longer submits a post-commit WorkspaceEdit, calls native Save a second time, or repairs a retired buffer. The first native commit preserves old saved attachments while withholding unadmitted new rows. Fresh Kusto/SQL policy locks then cover direct publication against that exact committed baseline. Source versions/generation, dirty drafts, physical identity and aliases are checked before and inside publication. Privacy locks are released before bounded native-model adoption; the document Save lease still orders survivor commands. The obsolete canonical-second-Save flags are removed.

The critical cache fix is a non-recursive filesystem watch tied to the actual document lifetime, not the panel lifetime. VS Code normally removes out-of-workspace watches when the last editor closes, and `openWith` can reuse a stale clean model. The watch allows normal native clean-model reload after late disk publication without a dirty edit or automatic reopen. Document/provider disposal releases it. A newer dirty raw draft is not overwritten.

Rich notebooks now expose the existing tool close-lifecycle interface. Save/Close await native preparation, result publication and linked completion. Publication errors are visible and retain a retryable accepted snapshot; retries join the same completion tail and distinguish published, policy-empty, stale and failed outcomes. A newer Save cannot be blocked by an obsolete retry failure. Delayed adoption is diagnosed, and an eventual exact clean reload clears the status. Survivor panels receive the new saved baseline through the existing registry.

Owned publication preserves raw rollback bytes, UTF-8 BOM, UTF-16 LE and Windows-1252 through native encoding APIs; lossy encodings are rejected before writing. It no longer truncates to zero first. Shrinking text is padded with encoding-checked whitespace until final truncate. Physical identity/hard links are retained. This is not atomic rename or a power-loss guarantee: rename was rejected because it changes ACL/owner/hard-link semantics. Writable virtual files use provider stat/text checks and write/readback rather than requiring an inode.

| ID | Exact contract and evidence | Result |
| --- | --- | --- |
| RS1 | Real native document, old saved result plus new result absent from disk -> production persist -> native Save -> exact clean buffer/disk/results; zero post-commit edits, one native Save | Red first on one post-Save WorkspaceEdit. Eight native variants pass: normal, approximately 3.5 MB CRLF, UTF-8 BOM, newer raw dirty draft, tool Save completion, injected EACCES plus retry, UTF-16 LE BOM, Windows-1252. A ninth real TextDocument/FileSystemProvider case covers virtual storage |
| RS2 | Early user leases, newest result generation, linked rollback/new draft, survivor Transformation command awaiting durable rows and clean-source adoption | User-visible assertions retained. Only fabricated second-Save events were removed; disk/reload fixtures now model actual publication. Linked test handlers bind to their exact provider |
| RS3 | Raw rollback/BOM, foreign baseline, authority retirement after read, shrinking JSON; session stale owned notifications plus genuine external empty/replacement changes | Seven publisher tests pass. Session fault gate moved from removed truncate(0) to final truncate/before sync, with an added complete-file assertion |
| RS4 | Rich clean tab with authoritative lifecycle dirtiness, asynchronous Save, persistent failure, and pending completion before Close | Four added tool lifecycle cases; whole tool file passes 151 tests, without public API changes |
| RS5 | Installed real query -> Ctrl+S -> hold actual post-commit fs.open(r+) -> exact tab close -> release -> no auto-reopen -> explicit reopen exact results -> rerun plus registered title edit -> second Ctrl+S | `c2610011527394b28` on 1.139.1 passes in 33s. Package `kw-single-native-save-watch-20261001-1523.vsix`, SHA `6fa8c2c2c7e6d81d338c65f6894ce98b4dd94e19f1a39d85b406cb9e6e6cede3`. Gate positively reached; no synthetic replacement/results |
| RS6 | RS5 plus ungated Ctrl+W/Save with real results; title edit/Don't Save/exact original reopen; Cancel retains dirty tab and baseline then Ctrl+S saves exact edit | `c2610011649102a20/a1` on 1.140.0: both scenarios pass, exit 0, 77s, no classifier flags. Read `lifecycle-summary.json`, `close-choice-summary.json` and JSON/native-log artifacts. Real controls followed by exact target, didSave and durable-byte checks |
| RS7 | Complete extension-host suite and focused post-review native cases | 316 integration tests pass on 1.140.0; 13 native/encoding/virtual/session/survivor cases pass after review refinements |

RS6 package: `out/releases/kw-holistic-save-20261001-1640.vsix`, SHA `e8a902d0a46626bb5e3efdede35a7d70815bfae5025032697ed1a412420f45ca`. Normal type, lint, production packaging and unchanged bundle limits passed. Later review tightened stale retry state, delayed adoption and codec padding; qualification of those exact final bytes is recorded separately rather than inferred from RS6.

Preserve intermediate failures. `c261001151227f927` stayed closed with correct disk results but failed a cached-buffer check; `c261001151502bee6` failed the stronger explicit-reopen check, proving the watcher gap. `c261001152530856f` with the watcher passed close/reopen but an identical cached rerun did not dirty the file, so the final test requires an accepted title edit before its second Save. BOM initially failed before byte correction. An encoding matrix observed transient invalid revisions before pre-write truncation was removed; the unchanged all-revision validity assertion then passed. The first full unit run finished with 8,627 passing, four existing skips, and two stale sender-coordinate failures; updating the unchanged sender's reviewed line made its 80-test suite pass. A corrected full coverage run is required before a final all-green claim.

The harness retains historical `edit` gate mode and adds `KW_CLOSE_RACE_PUBLICATION_MODE=file` for the new writer. Both require a positively reached gate. A closed clean cached model may lag, but explicit reopen must adopt exact saved results before UI/rerun/Save checks. Screenshot images are not viewed at the user's request; installed passes remain `PASS_UNREVIEWED_VISUAL`. No new complete 4.7.0 binary matrix or exact Lori-incident attribution is claimed. Original reports and normal profiles are never mutation targets. No commits, tags, branches, version edits or pushes are part of this task.

Final reviewed artifact: `out/releases/kw-holistic-save-reviewed-20261001.vsix`, SHA-256 `4d8c40a89e49b13eaaf9a8ed517cdce78d6b8a65cd24d3670297ae383616d711`. Campaign `c2610011727125e84/a1` on 1.140.0 passes both installed scenarios in 91 seconds with zero classifier flags. This artifact includes the final retry/adoption/padding corrections. Its normal type/lint/production/VSIX/bundle gates pass; host is approximately 2,500 KiB under 2,514 KiB, with unchanged webview limits.

The corrected official coverage gate passes all 8,629 tests in 372 files, with four pre-existing skipped tests in one file (373 files total), in 1,098 seconds. Statement coverage is 52.30%; the baseline/threshold is unchanged. The historical 5.1.1 recheck `c2610011729475eb7` on 1.140.0 is inconclusive: its timed edit-gate scenario survived, then the Cancel-dialog control failed because the dialog was not found. It is `HARNESS_BLOCKED`, not another negative corruption proof or a repeatability claim. The original 5.1.1 corruption trace and this follow-up's red-first real native post-Save-edit regression remain the causal evidence. No failure was discarded or relabelled as a pass.

Final-tree timing correction: a complete integration rerun reached 314 passes and two tool-Save adoption timeouts. Event-only adoption missed the model's already-updated state. Adoption now also rechecks actual clean document state every 50 ms within the unchanged five-second deadline, with both timers disposed at settlement. The exact complete integration gate then passed all 316 tests in one minute; the final protocol/publication/tool unit ring passed 238 tests. The full 8,629-test coverage run above preceded only this two-line bounded recheck and its reviewed sender-coordinate update; it is not misrepresented as a second full run of those final lines.

Final deliverable: `out/releases/kw-holistic-save-final-20261001.vsix`, SHA-256 `893f26692bc83cd0066fbcfbb1b9cfb6aa1bcea2d0cd41d692ce7fb74dfa916a`. Normal type/lint/production/VSIX/bundle gates pass unchanged. Installed campaign `c2610011749394d36/a1` on 1.140.0 passes both complete scenarios in 67 seconds, `PASS_UNREVIEWED_VISUAL`, exit 0, zero classifier flags. This supersedes the earlier intermediate artifacts for testing the completed fix. Visual screenshot review and a full historical binary/platform matrix remain unclaimed.
