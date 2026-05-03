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

## Artifacts

The orchestrator writes ignored artifacts under `tests/vscode-extension-tester/history/`:

- `latest-summary.md` and `latest-summary.json` for the newest run.
- `history.jsonl` for pass/fail history across runs.
- `flake-ledger.json` for per-test pass/fail counts and recent status history.
- `full-suite-<timestamp>/command-output/` for raw `vscode-ext-test` output.
- Per-test framework artifacts remain in `tests/vscode-extension-tester/runs/<profile>/<test-id>/<timestamp>/` with `report.md`, `results.json`, screenshots, and output channel logs.

The suite summaries record the VS Code version requested for the run. Scheduled CI resolves this to the latest stable numeric version before invoking the runner, so the artifact trail shows which editor release produced the signal.

## Per-Test Workspace Settings

Tests can include an `e2e.settings.json` file next to their `.feature` file with a `workspaceSettings` object. The suite runner creates an isolated workspace under that run's history folder, writes those settings to `.vscode/settings.json`, and launches VS Code with that workspace for the test. Use this for deterministic feature flags or network-sensitive settings that should be expressed through normal VS Code configuration rather than through UI editing.

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

The orchestrator checks each named profile's `user-data/User/workspaceStorage` and allows only the controller workspace `ext-dev`. Any other entry is profile residue because it can make `Given the extension is in a clean state` hang on `workbench.action.closeAllEditors`.

Use `--repair-profile-residue` to move residue into the current history artifact folder without deleting auth state. Do not delete `globalStorage`, `Local Storage`, or SecretStorage when cleaning profiles.

The orchestrator also seeds named profiles with quiet host settings such as `extensions.ignoreRecommendations=true`. This keeps screenshots and failure artifacts focused on Kusto Workbench rather than machine-specific VS Code recommendations.

## Scheduling

The scheduled workflow `.github/workflows/e2e-full-suite.yml` runs on GitHub-hosted `windows-latest`; no self-hosted runner or custom `kusto-workbench-e2e` label is required for the current CI signal. It executes the unauthenticated `default` profile only and intentionally skips `sql-auth` and `kusto-auth` because those named profiles require prepared authentication state. Before the run, the workflow queries the official VS Code stable release endpoint, semver-sorts the returned stable versions, validates the newest version against `package.json`'s VS Code engine minimum, and passes the resolved numeric version to `vscode-ext-test` via `--vscode-version`. The workflow also queries the latest `vscode-extension-tester` GitHub release and installs the `vscode-ext-test-*.tgz` asset before running the suite:

```powershell
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/AngelosP/vscode-extension-tester/releases/latest'
$package = ($release.assets | Where-Object name -match '^vscode-ext-test-\d+\.\d+\.\d+\.tgz$' | Select-Object -First 1).browser_download_url
npm install -g $package
```

Do not rely on a local symlink or a preinstalled global CLI for scheduled runs. Scheduled runs use the latest released framework by default so new framework step definitions are picked up automatically. When validating a candidate or rolling back, run the workflow manually with the `vscodeExtTestPackage` input set to a specific tarball URL.

Authenticated coverage remains opt-in for local or future prepared self-hosted runs with `npm run test:e2e:full:behavior`.

Default-profile coverage may include copies of authenticated-profile tests only when the copied scenario remains fully operational without a live SQL/Kusto connection. Toolbar, persistence, form, fallback autocomplete, and persisted-result rendering tests are good candidates. Live query execution, connection/database selection, schema-bound autocomplete, STS diagnostics, favorites against a real service, Copilot availability, remote network files, and screenshot generators stay in authenticated or explicit profiles.

GitHub-hosted runners cannot provide the reusable authenticated product signal without a profile setup flow. Keep uploading both `history/` and `runs/` artifacts so failures still include reports, screenshots, and output-channel logs.