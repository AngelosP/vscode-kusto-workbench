# Repo-Specific Testing Knowledge

This file is your persistent knowledge base for E2E testing this specific
codebase with vscode-extension-tester. Unlike SKILL.md (which is overwritten
on every `vscode-ext-test init` to stay current with framework updates),
**this file is never overwritten** — it accumulates knowledge across sessions.

## How to Use

Read this file before every test session. Update it after every session with
anything new you learned. Structure it however makes sense for this repo.

## Extension Commands

<!-- List the command IDs this extension registers and what they do -->

- `kusto.openQueryEditor` opens the persistent scratch/session editor.
- `workbench.action.files.save` works for saving a custom `.kqlx` editor after webview-driven `schedulePersist()` updates the backing document.

## Webview Selectors

<!-- CSS selectors, data-testid values, and webview titles that work for this extension -->

- Main notebook container: `#queries-container`.
- Section tags are stable and usable through webview CSS/evaluate steps: `kw-query-section`, `kw-markdown-section`, `kw-html-section`, `kw-sql-section`.
- Add buttons use `button[data-add-kind='<kind>']`, with kinds including `query`, `sql`, `html`, and `markdown`.
- The section creation/removal window bridges are available in E2E webview evaluation: `addQueryBox`/`removeQueryBox`, `addMarkdownBox`/`removeMarkdownBox`, `addHtmlBox`/`removeHtmlBox`, `addSqlBox`/`removeSqlBox`.
- Kusto preparation is observable on `kw-query-section` through `data-test-preparation-state`, `data-test-preparation-stage`, and `data-test-preparation-blockers`. The toolbar animation can be asserted with `getComputedStyle(toolbar, '::after').animationName`.
- Supplemental fully qualified schema state is exposed through `window.__e2e.kusto.waitForSupplementalState`, `assertNoSupplementalWarnings`, `assertSupplementalBackgroundTrace`, and `suggestDiagnostics(context, sectionIndex)`.

## Activation & Setup Quirks

<!-- E.g. "needs a .kql file open before commands are available" -->

- Opening an empty `.kqlx` initializes one default Kusto section. Tests that need exact section counts should remove it first and assert the workbench is empty before setup.
- For reliable multi-line strings inside `I evaluate` steps, build newlines with `String.fromCharCode(10)` rather than relying on `\n` escaping through Gherkin and JavaScript string layers.
- In default launch mode, SQL sections may show `No SQL connections configured.`. This is expected unless the test uses a prepared profile or attach mode with SQL auth state.
- `kustoWorkbench.test.seedSupplementalSchemaDiagnosticsState` creates two synthetic Kusto connections and current-version raw schema caches without network/auth. Always call `kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState` after closing fixture editors; it removes only synthetic cluster/cache/file-pin state and restores the previous selection.

## Known Issues & Workarounds

<!-- Flaky areas, timing-sensitive steps, framework workarounds -->

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

## Testability Recommendations

<!-- data-testid attributes you recommended adding to the extension source -->
