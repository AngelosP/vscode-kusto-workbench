# E2E Full Suite Signal

The full E2E suite is a product signal, not a pile of green checkmarks. It should answer: can a real user open the extension, use the important surfaces, persist state, and trust authenticated SQL/Kusto workflows across time?

## Commands

CI behavioral suite, excluding README screenshot generators and authenticated named profiles:

```powershell
npm run test:e2e:ci
```

Full local/self-hosted behavioral suite, excluding README screenshot generators:

```powershell
npm run test:e2e:full:behavior
```

For ad hoc filtering, invoke the Node runner directly so shell-specific npm argument forwarding cannot strip flags:

```powershell
node scripts/e2e-full-suite.mjs --profiles "default,sql-auth,kusto-auth" --test-id sql-auto-trigger --repair-profile-residue --no-build
```

To pin a local run to the same VS Code selection mechanism used by CI, pass a version explicitly. `stable` keeps the `vscode-ext-test` default behavior, while CI resolves and passes the newest stable numeric version once per workflow run:

```powershell
node scripts/e2e-full-suite.mjs --profiles default --vscode-version stable
```

Scheduled CI divides the sorted default-profile test IDs into four deterministic round-robin shards. Reproduce one shard locally with the same one-based coordinates:

```powershell
node scripts/e2e-full-suite.mjs --profiles default --shard-index 2 --shard-count 4 --vscode-version stable
```

Both shard flags are required together. Each summary records its shard, its selected count, and the total selected across all shards.

Dry-run discovery:

```powershell
npm run test:e2e:ci:dry-run
```

Reusable profile residue check only:

```powershell
npm run test:e2e:profile-check:repair
```

README screenshot generators are intentionally excluded from the product signal by default. Run them explicitly when refreshing marketplace assets:

```powershell
node scripts/e2e-full-suite.mjs --profiles "default,kusto-auth,sql-auth" --include-screenshot-generators --repair-profile-residue
```

## Opt-In Live Authority ID Fixture

Live tenant fixtures set `"optIn": true` in their `e2e.settings.json` and are excluded from all ordinary/full-suite discovery. `--test-id` alone does not bypass this gate. To exercise the guest-tenant Authority ID scenario, prepare the `kusto-auth` profile with the guest account, start the existing ADX fixture, and set:

```powershell
$env:KUSTO_AUTH_REPRO_LIVE = '1'
$env:KUSTO_AUTH_REPRO_CLUSTER = 'https://<cluster>.<region>.kusto.windows.net'
$env:KUSTO_AUTH_REPRO_DATABASE = '<target-database>'
$env:KUSTO_AUTH_REPRO_RESOURCE_AUTHORITY = '<resource-tenant-guid-or-domain>'
$env:KUSTO_AUTH_REPRO_WRONG_AUTHORITY = '<home-tenant-guid-or-domain>'
$env:KUSTO_AUTH_REPRO_EXPECTED_ACCOUNT = '<prepared-profile-account-id-or-label>'
```

Run the extension E2E explicitly:

```powershell
node scripts/e2e-full-suite.mjs --profile kusto-auth --test-id kusto-authority-live --include-opt-in-tests --repair-profile-residue
```

The scenario creates only profile-local test connections/preferences, performs database discovery under both authorities, checks Connection Manager and Cached Values, and removes its fixture state. It does not create Azure resources, ingest data, or execute a data query.

For a UI-independent repro using the same read-only `.show databases` contract, set the same variables (plus optional `KUSTO_AUTH_REPRO_SUBSCRIPTION`) and run:

```powershell
npm run repro:kusto-authority
```

The CLI acquires two Azure CLI tokens serially and calls only the ADX management endpoint. It prints hashed account identity and database visibility metadata, never tokens or response bodies.

## Artifacts

The orchestrator writes ignored artifacts under `tests/vscode-extension-tester/history/`:

- `latest-summary.md` and `latest-summary.json` for the newest run.
- `history.jsonl` for pass/fail history across runs.
- `flake-ledger.json` for per-test pass/fail counts and recent status history.
- `full-suite-<timestamp>/command-output/` for raw `vscode-ext-test` output.
- Per-test framework artifacts remain in `tests/vscode-extension-tester/runs/<profile>/<test-id>/<timestamp>/` with `report.md`, `results.json`, screenshots, and output channel logs.

The suite summaries record the resolved VS Code version, installed `vscode-ext-test` version, Node.js version, and CI commit SHA. Scheduled CI resolves the default `latest` editor request to a stable numeric version before invoking the runner, so the artifact trail identifies the complete toolchain that produced the signal.

The orchestrator retries only transient VS Code download failures that happen before launch and before any structured test result exists. Retryable signals are limited to download output with `ECONNRESET`, `ETIMEDOUT`, `EAI_AGAIN`, or HTTP 429/502/503/504. Assertion failures, step timeouts, post-launch failures, and runs with `results.json` are never retried. Every attempt remains in the raw command log and the run record reports its attempt count.

## Per-Test Workspace Settings

Tests can include an `e2e.settings.json` file next to their `.feature` file with a `workspaceSettings` object. The suite runner creates an isolated workspace under that run's history folder, writes those settings to `.vscode/settings.json`, and launches VS Code with that workspace for the test. Use this for deterministic feature flags or network-sensitive settings that should be expressed through normal VS Code configuration rather than through UI editing.

The same file may include an `env` object whose values are non-secret strings passed only to that test's launched VS Code process. Do not put credentials, tokens, or other secrets in tracked E2E settings.

Use `"timeout": 45000` for a per-step timeout in milliseconds; `stepTimeoutMs` is not supported. An explicit runner `--timeout` takes precedence. The outer timeout must exceed a step's explicit wait/evaluation budget. Unknown top-level settings and non-object configurations fail discovery instead of silently using defaults.

Tests that add their own external workspace can declare `managedWorkspacePath`. The path must resolve to an absolute path after `${ENVIRONMENT_VARIABLE}` expansion. This field does not launch or create the workspace; it lets the suite move that exact workspace's reusable-profile storage into the run artifacts after the test, including when the output directory is on another volume. Unreadable metadata is left for the normal residue report rather than aborting summary generation. The feature must validate the canonical external path, reject links in every path it will mutate, create or add the directory itself, and verify it is the intended first workspace before any file-writing product action. A `managedWorkspaceOwner` with exact `markerName` and `content` authorizes the runner to remove that workspace after the VS Code child exits.

`workspaceSettings` and `managedWorkspacePath` are mutually exclusive. The runner handles both direct folder metadata and VS Code's generated untitled-workspace metadata, but moves an untitled entry only when its canonical folder set contains exactly the declared managed workspace.

VS Code may delete the generated untitled-workspace file during shutdown while leaving workspaceStorage behind. For that case, the runner snapshots entry names before this serial test and may move only a newly created tombstone whose missing workspace file was under the same profile's `user-data/Workspaces` root. Reusable profiles must not be opened concurrently while the suite owns them.

Managed cleanup and the ordinary residue check run even when command artifact parsing fails. Each run record retains the matched workspaceStorage entries, backup destinations, and structured repair errors with source, attempted target, and message, plus any execution, artifact-processing, or cleanup errors. Multi-entry backup is per-entry: an earlier successful move remains recorded when a later inspect or move fails. A fixed external workspace must use an exact ownership marker: refuse an existing unmarked root and validate marker and target file type/link count before mutation. Runner cleanup rejects managed roots that are inside or contain the repository, and records structured path/error details on rejection. Raw runs remove generated content and retain only the marker because Windows keeps the active workspace root open. The full-suite runner validates that marker again and removes the complete root after the child exits, including failed E2E or artifact-processing paths.

After any failure, inspect in this order:

1. `tests/vscode-extension-tester/history/latest-summary.md`
2. The failed test's `report.md`
3. Failure screenshots with the `view_image` tool
4. `output-channels/` logs, especially `Kusto_Workbench.log`
5. Raw command output in `history/full-suite-*/command-output/`

## Quarantine Policy

Quarantine is a temporary exception, not a place to hide broken coverage.

Use `tests/vscode-extension-tester/e2e-suite.quarantine.json` only when a test is known to fail for a documented reason and there is an owner. Every active entry must include:

- `profile`
- `testId`
- `mode`: `skip` or `allowed-failure`
- `owner`
- `reason`
- `issue`
- `expiresOn`

Expired or incomplete entries fail the suite before test execution. A quarantined test should be removed after three consecutive clean product runs or when the linked fix merges.

## Flake Tracking

The orchestrator updates `flake-ledger.json` after every run. A test is marked as a flake suspect when recent history contains both passes and failures.

Triage rules:

- One failure: inspect screenshot and logs, then rerun once to classify.
- Same failure twice: treat as product or test bug, not noise.
- Pass-after-fail: record as flake suspect; stabilize selectors, waits, profile cleanup, or product async state.
- Do not add broad sleeps unless the screenshot/log evidence proves the UI needs a real state transition wait.

## Reusable Auth Profiles

Named profiles keep authentication state under `tests/vscode-extension-tester/profiles/`, which is gitignored. They must not keep restored editor/workspace state between tests.

The reusable `default` profile follows the same workspace-residue rule when it exists locally. Ordinary suite cases also set `KUSTO_WORKBENCH_E2E_BYPASS_FIRST_LAUNCH=1`, which settles stale development-only onboarding state before commands run. The `first-launch-setup` test is explicitly excluded so it continues to exercise the real onboarding flow.

The orchestrator checks each reusable profile's `user-data/User/workspaceStorage` and allows only the controller workspace `ext-dev`. When a test uses a generated per-test workspace, its matching workspaceStorage entry is moved into that run's managed artifact backup before the generic residue check. Any other entry is profile residue because it can make `Given the extension is in a clean state` hang on `workbench.action.closeAllEditors`.

Use `--repair-profile-residue` to move residue into the current history artifact folder without deleting auth state. Do not delete `globalStorage`, `Local Storage`, or SecretStorage when cleaning profiles.

The orchestrator also seeds named profiles with quiet host settings such as `extensions.ignoreRecommendations=true`. This keeps screenshots and failure artifacts focused on Kusto Workbench rather than machine-specific VS Code recommendations.

## Stabilization Coverage Ledger

Contract: the current default behavioral suite must exercise real editor workflows on the newest stable VS Code without setup races, hidden failures, or substituted success. The scheduled `latest` gate, existing behavioral assertions, and fail-on-assertion policy remain required. A local pass is not a hosted-Windows pass.

| Path / transition | Owner and exact oracle | Coverage / decision |
| --- | --- | --- |
| Fresh editor -> helper setup -> user controls | Development helper registration; exact initial tab plus `data-kusto-e2e-ready`; existing section, worker, and result assertions still run | Include: affected default feature scenarios; do not reactivate the tab during focus-sensitive observations; standalone viewers use their own rendered controls |
| Invalid MDX open -> error page -> unchanged durable bytes | Native custom editor; expected heading/reason plus exact section IDs and `dirty: false` | Existing `document-capabilities`: wait for the error page in `incompatible.mdx` before text assertions |
| Remove -> delayed acknowledgement -> same-ID recreation | Real Markdown document client; cleanup stays pending beyond DOM removal, then only accepted removal permits recreation | Include `markdown-document-client.test.ts`: delayed/rejected replies, malformed success, stale/duplicate/session-mismatched results, timeout/late response, quiet-window hidden commands, suppression restoration |
| Capture -> source/session retirement -> delayed old success | Client acceptance and capture lifetime; old traffic cannot complete the current capture | Include same client suite: retirement before waiting, uncaptured pending work, rearming, and failure cleanup |
| Layout scenario -> accepted teardown -> exact session close -> next scenario | Layout helper plus provider close drain; eight created sections are removed before resetting the test-owned session | Include `section-layout-regression`: explicit setup/teardown for all four scenarios; three iterations assert 96 created and accepted removals without changing geometry checks |
| Six layout Adds -> accepted revisions -> populated mixed notebook | The real command client accepts each Add before the next factory runs; the shared 20-second budget and five-second client timeout remain strict | Include `markdown-document-client.test.ts` serial six-Add, rejection, retirement, and deadline cases; `section-layout-regression`, `section-types-contract`, and `sql-toolbar-actions` retain populated content and real-control oracles |
| Markdown vendor load overlaps Monaco AMD initialization | The installed Monaco API factory must publish `editor` and `languages` with AMD detection masked or visible, without replacing worker configuration | Include `lazy-vendor.test.ts`, `retains the editor API when Markdown masks AMD`; existing mixed-section E2E requires working Python and query editors |
| E2E session open -> accepted initial projection -> cleanup | Both isolated and ordinary first-launch-bypassed E2E opens await the current live panel's host-accepted activation; a rejected first generation does not qualify. Only isolated opens reset the session | Include `firstLaunchIntegration.test.ts` held close/write/initialization cases for missing, empty, and populated sessions, with ordinary development and Production controls; existing `kqlxMarkdownOwnership.test.ts`, `initial projection initialization waiter handles ...`, covers rejected initial generations. Composed E2E includes `file-operations`, `kusto-results-visibility-layout`, `share-result-artifacts`, and `section-lifecycle`; existing non-isolated bytes remain unchanged |
| Native session truncate -> intermediate notification -> completed write -> next command | Change observation reads under the document lock; matching owned text, authority, and physical identity cannot be fenced by a partial or stale editor buffer | Include `kqlxMarkdownOwnership.test.ts`, `session stable-write observation ...`: real FileHandle truncation, two accepted revisions, exact bytes and all eight section IDs, late/duplicate notifications, stale-event external edits, real external clear, replacement inode, disposal, and unchanged synchronous non-session fencing; repeated external notifications are suppressed only after successful admission |
| First-launch Save -> resumed session -> Add SQL | Canonical starter factory; one KQL starter plus real SQL Add and synchronized toolbar preferences | Existing `first-launch-setup` E2E plus `firstLaunchIntegration.test.ts`: isolated/fresh/missing session and unchanged ordinary existing empty file |
| Deferred supplemental cleanup -> new text-diagnostics fixture | Startup cleanup owner; no seed reads before settlement and final exact seeded connection/database while auth/schema survive | Include `firstLaunchIntegration.test.ts` deferred behavioral regression |
| Settings discovery -> CLI forwarding | Suite parser; exact 45000 ms, explicit override precedence, invalid/unknown rejection, correction, and supported workspace/opt-in paths | Include `e2e-full-suite-support.test.mjs`; direct CLI invocation must supply its timeout separately |
| Auth/cache setup -> result display -> Save/reopen | Existing prepared-owner/result contracts; exact cache/partition, rows, lineage, and durable bytes | Existing `share-result-artifacts`, `persisted-results-restore`, `legacy-result-migration`, and `kusto-fq-open-diagnostics`; no speculative auth invalidation changes |
| Synthetic owner loss -> authentication settlement -> both caches restored -> fixture publication | The fixture restores database and schema caches only after genuine owner recovery; independent cache loss, incarnation or policy drift, and failed writes still reject publication | Include `firstLaunchIntegration.test.ts`, `recovers both caches after preference loss ...`, drift and write-failure controls, plus `legacy-result-migration` exact rows, conservative policy, and byte-stable reopen; live authenticated execution is not inferred from this fixture |
| Identity fixture token override -> delayed invalidation -> database/schema seeding -> ADX clipboard | Real Kusto client override listeners clear the account's caches asynchronously. Wait for tracked lifecycle settlement before seeding, and reject superseded database writes | Include the real-service identity fixture cases in `firstLaunchIntegration.test.ts`: held account invalidation, two seed generations, database/schema false and rejected writes, unchanged user connections/caches/selection/privacy. Existing `share-result-artifacts` retains five-account/cache readiness and the real host clipboard assertion. Scheduled run #160 preserved all explicit preferences but lost the Foobar database cache; this is distinct from #158's unexplained preference loss |
| Charts weekly/channel -> Agent edits -> Charts unchanged | Tutorial host mutations and delivered snapshot; Charts remains weekly while Agent changes | Existing composed `did-you-know-regressions`; isolated probes alone do not replace this E2E |
| Save Kusto/SQL search -> reload -> switch kind -> restore before requesting another snapshot -> edit both kinds | Host publishes after the active-kind write; exact stored per-kind query, scope, targets, and categories reach the current controller | Include `connectionManagerViewerSearch.test.ts` and `cm-back-search`; retain write failure propagation, result sanitization, and independent B1-to-B2 post-reload edits |
| Explicit empty engine -> Add form -> snapshot -> draft retained | Webview snapshot honors explicit selection independently of inventory; SQL unavailable still forces Kusto | Include `kw-connection-manager.test.ts` and `connection-manager`; host unset/invalid preference auto-selects SQL only for SQL-only inventory, without writing a default preference |
| Full cold default suite -> all test IDs terminal -> artifacts | Suite runner; no failed, skipped, or allowed-failure entries; inspect reports, JSON, screenshots, and profile residue | Required final qualification on latest VS Code; preserve prior failures and classify interrupted runs separately |
| Authenticated profiles and browser viewer | Different environment/host owners from the requested default CI workflow | Exclude from this stabilization gate; no changed authenticated execution or browser contracts |

Review limits: Cached Values' existing label assertion does not prove refresh completion while it displays `Loading...`. The clarification View oracle proves card presence, expansion, and input focus, but not that the card is inside the captured chat viewport. The prior-session lifecycle scenario can omit a stale-barrier injection when no barrier was captured. These pre-existing coverage gaps are not evidence for those stronger claims; this stabilization does not replace their assertions with weaker ones or count them as new coverage.

### Verified Local Run

`full-suite-20260914T101117Z` completed on September 14, 2026: 77/77 test IDs and 160/160 scenarios passed on Windows with VS Code 1.137.0 (resolved from latest stable), vscode-ext-test 0.1.23, and Node v22.16.0. Each test ran once, with zero bootstrap retries, skipped cases, allowed failures, quarantines, or profile residue. All 207 screenshots and the structured reports were reviewed. The final focused headless ring passed 371 Vitest tests and 26 Node runner tests; type checking, lint, and bundling passed in the suite build.

This is local working-tree evidence, not a GitHub-hosted run or a guarantee against all intermittent failures. The earlier full runs and their failures remain in local history; successful follow-ups do not replace them. The layout fix separately passed three composed iterations, including accepted teardown and exact close before each reopening. Screenshot review also retained unrelated visual findings: SQL stale-result dimming is not established by its class-only assertion, and the narrow comparison toolbar can clip the cache-plan checkbox. These are not claimed as repaired by this suite-stabilization work. Scheduled latest-VS-Code selection and its failure policy are unchanged.

## Scheduling

The scheduled workflow `.github/workflows/e2e-full-suite.yml` runs four fail-independent shards on GitHub-hosted `windows-latest`; no self-hosted runner or custom `kusto-workbench-e2e` label is required for the current CI signal. It executes the unauthenticated `default` profile only and intentionally skips `sql-auth` and `kusto-auth` because those named profiles require prepared authentication state. Each shard has a unique artifact and a 60-minute ceiling. Before each shard runs, the workflow queries the official VS Code stable release endpoint, semver-sorts the returned stable versions, validates the newest version against `package.json`'s VS Code engine minimum, and passes the resolved numeric version to `vscode-ext-test` via `--vscode-version`. The workflow installs the pinned `vscode-ext-test` release asset declared by `E2E_VSCODE_EXT_TEST_PACKAGE`; a separate discovery step reports the latest release for compatibility visibility.

```powershell
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/AngelosP/vscode-extension-tester/releases/latest'
$package = ($release.assets | Where-Object name -match '^vscode-ext-test-\d+\.\d+\.\d+\.tgz$' | Select-Object -First 1).browser_download_url
npm install -g $package
```

Do not rely on a local symlink or a preinstalled global CLI for scheduled runs. Scheduled runs use the pinned framework and latest stable VS Code by default. The latest-release discovery reports framework drift without changing the tested runner. For diagnosis, run the workflow manually with `vscodeExtTestPackage` set to a specific tarball URL and/or `vscodeVersion` set to a numeric version. These inputs do not change the scheduled defaults.

Authenticated coverage remains opt-in for local or future prepared self-hosted runs with `npm run test:e2e:full:behavior`.

Default-profile coverage may include copies of authenticated-profile tests only when the copied scenario remains fully operational without a live SQL/Kusto connection. Toolbar, persistence, form, fallback autocomplete, and persisted-result rendering tests are good candidates. Live query execution, connection/database selection, schema-bound autocomplete, STS diagnostics, favorites against a real service, Copilot availability, remote network files, and screenshot generators stay in authenticated or explicit profiles.

GitHub-hosted runners cannot provide the reusable authenticated product signal without a profile setup flow. Keep uploading both `history/` and `runs/` artifacts so failures still include reports, screenshots, and output-channel logs.