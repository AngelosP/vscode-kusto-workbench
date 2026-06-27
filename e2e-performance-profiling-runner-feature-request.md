# Feature Request: Add First-Class Performance Profiling Support to vscode-extension-tester

## Context

We use `vscode-extension-tester` to test a VS Code extension with complex custom editor webviews. We now need repeatable performance profiling, especially for "open file -> custom editor/webview becomes usable" scenarios.

The extension under test can emit structured performance marks from both extension host code and webview code, but the test runner needs better support for:

- running a scenario repeatedly,
- passing performance-mode env vars / VS Code launch args,
- collecting structured JSON performance snapshots as artifacts,
- optionally capturing Chromium/DevTools traces,
- producing a summary across iterations.

The goal is not to turn E2E tests into microbenchmarks. The goal is a pragmatic perf harness for product workflows.

## Primary Use Case

From an extension repo, run something like:

```bash
vscode-ext-test run \
  --test-id open-performance \
  --perf \
  --iterations 7 \
  --warmup 1 \
  --env KUSTO_WORKBENCH_PERF=1 \
  --vscode-arg --disable-extensions \
  --collect-webview-json "window.__e2e?.perf?.snapshot?.()" \
  --collect-extension-host-json "globalThis.__kustoPerf?.snapshot?.()"
```

Expected result:

- The runner launches VS Code normally.
- It executes the scenario 1 warmup time and 7 measured times.
- It collects JSON snapshots from the webview and/or extension host after each measured iteration.
- It writes per-iteration artifacts and an aggregate summary.
- It does not require the extension repo to parse terminal output by hand.

## Required Capabilities

### 1. Repeat Runs With Warmup

Add repeat-run support to `vscode-ext-test run`.

Suggested CLI:

```bash
vscode-ext-test run --test-id open-performance --iterations 7 --warmup 1
```

Requirements:

- `--iterations <n>`: number of measured iterations.
- `--warmup <n>`: number of unmeasured warmup iterations.
- Each iteration should produce a separate artifact subfolder or clearly separated artifact namespace.
- The summary should identify warmup vs measured iterations.
- Failures should include which iteration failed.
- Default behavior remains unchanged when these flags are absent.

Nice-to-have:

```bash
--cooldown-ms 1000
--fail-fast
--keep-window-between-iterations
```

These are secondary and should not block the first implementation.

### 2. Environment Variables and VS Code Launch Arguments

Add generic support for passing environment variables and VS Code launch arguments.

Suggested CLI:

```bash
vscode-ext-test run \
  --env KUSTO_WORKBENCH_PERF=1 \
  --env MY_FLAG=true \
  --vscode-arg --disable-gpu \
  --vscode-arg --remote-debugging-port=0
```

Requirements:

- `--env KEY=VALUE` can be repeated.
- Env vars apply to the launched VS Code process and extension host.
- `--vscode-arg <arg>` can be repeated and appended to the VS Code launch args.
- This must work in normal launch mode.
- In attach mode, document clearly that env/launch args cannot affect an already-running Dev Host.

### 3. Structured JSON Artifact Collection From Webviews

Add a generic way to evaluate a JavaScript expression in the active/current webview and save the returned JSON as an artifact.

Suggested Gherkin step syntax:

```gherkin
Then I collect JSON artifact "webview-perf" from webview expression "window.__e2e?.perf?.snapshot?.()"
```

Requirements:

- The step evaluates in the current/active webview context, using the same frame-discovery logic as existing webview evaluation steps.
- The returned value must be JSON-serializable.
- Save the result as `artifacts/<scenario>/<iteration>/webview-perf.json`, or an equivalent stable path.
- Add the artifact path to `results.json` and `report.md`.
- If the expression returns `undefined`, `null`, or non-serializable data, fail with a useful error.
- If no webview context is available, fail with a useful error listing discovered webviews/frames if possible.

Useful examples:

```gherkin
Then I collect JSON artifact "open-perf-webview" from webview expression "window.__e2e.perf.snapshot()"
Then I collect JSON artifact "custom-state" from webview expression "({ title: document.title, sections: document.querySelectorAll('kw-query-section').length })"
```

### 4. Structured JSON Artifact Collection From Extension Host

Add a generic way to evaluate JavaScript in the extension host and save returned JSON.

Suggested Gherkin step syntax:

```gherkin
Then I collect JSON artifact "host-perf" from extension host expression "globalThis.__kustoPerf?.snapshot?.()"
```

Requirements:

- This should use whatever mechanism the runner already has for extension-host scripts, if available.
- Returned value must be JSON-serializable.
- Save artifact path in `results.json` and `report.md`.
- Failure cases should be explicit:
  - extension host eval unavailable,
  - expression threw,
  - result not JSON-serializable.

If extension-host expression collection is hard, implement webview JSON collection first and leave extension-host collection behind a clearly documented follow-up issue.

### 5. Aggregate Performance Summary

When `--perf` is enabled, generate a summary artifact.

Suggested output files:

```text
perf-summary.json
perf-summary.md
```

The runner should aggregate numeric fields from collected JSON artifacts across measured iterations.

Example input snapshot from an extension:

```json
{
  "scenario": "open-kqlx-large",
  "marks": {
    "host.resolve.start": 0,
    "host.documentData.posted": 184,
    "webview.documentData.received": 232,
    "webview.firstSection.visible": 310,
    "webview.firstEditor.ready": 522,
    "webview.results.restored": 910
  },
  "measures": {
    "host.parseMs": 34,
    "host.totalToDocumentDataMs": 184,
    "webview.restoreMs": 288,
    "openToFirstSectionMs": 310,
    "openToFirstEditorMs": 522,
    "openToResultsRestoredMs": 910
  }
}
```

Aggregation requirements:

- For each numeric field under common locations like `measures`, calculate:
  - count,
  - min,
  - median,
  - p95,
  - max,
  - mean.
- Preserve per-iteration raw data.
- Include scenario/test id, profile, VS Code version, extension path, timestamp, and CLI args.
- If multiple JSON artifacts are collected, summarize each separately by artifact name.

Do not fail tests based on thresholds initially. This feature is for measurement first.

Nice-to-have, not required in v1:

```bash
--perf-threshold openToFirstEditorMs.p95<=1000
```

### 6. Optional CDP / Chromium Trace Capture

Add optional trace capture around a scenario or step block.

Suggested CLI:

```bash
vscode-ext-test run --test-id open-performance --trace-cdp
```

Suggested Gherkin steps:

```gherkin
When I start CDP trace "open-file"
...
Then I stop CDP trace "open-file"
```

Requirements:

- Save a Chrome trace JSON artifact, e.g. `open-file.trace.json`.
- Include the artifact in `report.md` and `results.json`.
- It is acceptable for this to require a launched VS Code with remote debugging enabled.
- If attach mode or VS Code launch configuration cannot support CDP tracing, fail with a clear explanation.

Important: CDP tracing is secondary. The core v1 must be repeat runs + JSON artifact collection.

## Suggested Architecture

Implement this generically in the runner, not as Kusto Workbench-specific behavior.

Possible pieces:

1. CLI option parsing:
   - `--perf`
   - `--iterations`
   - `--warmup`
   - `--env KEY=VALUE`
   - `--vscode-arg ARG`
   - optional `--trace-cdp`
2. Iteration orchestration:
   - Wrap scenario/test execution in warmup + measured loops.
   - Add iteration metadata to artifact paths and reports.
3. Artifact model:
   - Extend `results.json` with a generic `artifacts` array:

```json
{
  "name": "webview-perf",
  "kind": "json",
  "path": ".../webview-perf.json",
  "iteration": 3
}
```

4. New Gherkin steps:

```gherkin
Then I collect JSON artifact "NAME" from webview expression "JS_EXPRESSION"
Then I collect JSON artifact "NAME" from extension host expression "JS_EXPRESSION"
When I start CDP trace "NAME"
Then I stop CDP trace "NAME"
```

5. Perf summary generator:
   - Reads collected JSON artifacts after the run.
   - Writes `perf-summary.json` and `perf-summary.md`.

## Acceptance Criteria

### Core Acceptance

- Existing tests run exactly as before when no perf flags/steps are used.
- `vscode-ext-test run --iterations 2 --warmup 1 --test-id <id>` runs the test 3 times total, marks 1 as warmup, and reports the 2 measured iterations separately.
- `--env KEY=VALUE` passes environment variables to launched VS Code.
- `--vscode-arg ARG` appends VS Code launch args.
- A feature can collect a JSON artifact from a webview expression.
- The artifact appears in:
  - the run folder,
  - `results.json`,
  - `report.md`.
- With `--perf`, the runner writes `perf-summary.json` and `perf-summary.md`.
- Numeric fields in collected JSON are summarized with min/median/p95/max/mean.

### Regression Acceptance

- Existing screenshot capture still works.
- Failure screenshots still work.
- Existing webview evaluation steps still work.
- Attach mode still works for normal tests.
- Build lifecycle remains unchanged unless `--no-build` is already supplied.
- No Kusto Workbench-specific names or assumptions are hardcoded in the runner.

## Example Feature File For Validation

Use a generic fixture extension or a real extension test with a webview. A validation feature could look like:

```gherkin
Feature: Performance artifact collection

  Scenario: Collect webview performance snapshot
    Given the extension is in a clean state
    When I execute command "myExtension.openPerfTestWebview"
    Then I wait for "#root" in the webview for 10 seconds
    Then I collect JSON artifact "webview-perf" from webview expression "({ measures: { openToReadyMs: 123, renderMs: 45 }, marks: { ready: performance.now() } })"
```

Run:

```bash
vscode-ext-test run --test-id perf-artifact-smoke --perf --iterations 3 --warmup 1
```

Expected:

- 1 warmup iteration, 3 measured iterations.
- 3 `webview-perf.json` measured artifacts, plus optional warmup artifacts clearly marked.
- `perf-summary.json` includes median/p95 for `measures.openToReadyMs` and `measures.renderMs`.

## Non-Goals

- Do not implement app-specific instrumentation in the runner.
- Do not require every test to be a perf test.
- Do not add default performance thresholds in v1.
- Do not require CDP tracing for the basic perf workflow.
- Do not depend on screenshots as performance data.

## Why This Matters

For custom editor webviews, source inspection alone is not enough to identify user-visible delay. We need timing data that spans:

1. VS Code launch/open command,
2. extension host custom editor provider,
3. host-to-webview `documentData`,
4. webview bundle load,
5. section restore,
6. editor readiness,
7. deferred result rendering.

The extension can emit those marks, but the runner needs to collect them repeatably and preserve them as first-class artifacts.