---
name: kusto-autocomplete-tracing
description: "Use when diagnosing Kusto autocomplete, schema trace, fully qualified cluster/database aliases, missing column suggestions, unknown-cluster squiggles, Ctrl+Space failures, or Monaco Kusto worker issues in Kusto Workbench."
---

# Kusto Autocomplete Tracing

Use this skill for Kusto autocomplete and Kusto worker diagnostics in Kusto Workbench, especially when a real `.kql` file has missing column suggestions or a fully qualified `cluster(...).database(...)` reference is incorrectly marked as unknown.

## Ground Rules

- Reproduce the user's real file or real query first when they provide one. Fixture-only tests can hide schema alias and worker-state bugs.
- The live autocomplete path is Monaco Kusto worker state in `src/webview/monaco/monaco.ts`, not the disabled fallback provider in `src/webview/monaco/completions.ts`.
- Prefer DOM/webview helper assertions over screenshots for suggestion and diagnostic state. Screenshots are useful context, but they can capture the wrong foreground window on this machine.
- Keep trace payloads bounded and sanitized. Do not log raw schemas, full query text, current query lines, tokens, or secrets.

## Trace APIs

The webview exposes autocomplete traces through window bridges:

```js
window.__kustoGetAutocompleteTrace(traceId)
window.__kustoCompactAutocompleteTrace(traceId)
window.__kustoClearAutocompleteTrace()
window.__kustoLastAutocompleteTraceId
```

The E2E helper surface mirrors these under `window.__e2e.kusto`:

```js
window.__e2e.kusto.getAutocompleteTrace(traceId)
window.__e2e.kusto.compactAutocompleteTrace(traceId)
window.__e2e.kusto.clearAutocompleteTrace()
window.__e2e.kusto.lastAutocompleteTraceId()
window.__e2e.kusto.suggestDiagnostics('context label')
window.__e2e.kusto.schemaLifecycleSnapshot()
```

`compactAutocompleteTrace()` is the default artifact to paste into failure output. Use the full trace only when the compact trace omits a needed detail.

## Collection Workflow

1. Open the real `.kql` or `.kqlx` repro in the Dev Host, using the same connection/profile as the user. For authenticated Kusto repros, prefer the `kusto-auth` named profile if it already has the required connection.
2. Clear stale trace state before the action:

```js
window.__e2e.kusto.clearAutocompleteTrace()
```

3. Put the caret at the failing location and trigger suggestions through the app path:

```js
await window.__e2e.kusto.triggerSuggest()
```

4. Collect diagnostics after the suggest widget settles:

```js
window.__e2e.kusto.suggestDiagnostics('real-file autocomplete repro')
window.__e2e.kusto.schemaLifecycleSnapshot()
window.__e2e.kusto.compactAutocompleteTrace()
```

`schemaLifecycleSnapshot()` is the sanitized coordinator view. It reports section/target generations, request presence, model attachment, catalog counts, preparation blockers, worker readiness, and pending-update status without exposing raw schemas, schema keys, model URIs, query text, or credentials.

5. If a strict column check is appropriate, assert exact existing column labels rather than loose substring matches:

```js
await window.__e2e.suggest.kusto.waitExistingAllColumnsVisible(
  'real-file workflow columns',
  'TIMESTAMP,EventName,Kind,env_dt_traceId',
  15000
)
```

Failures from `waitExistingAllColumnsVisible` include the compact autocomplete trace.

## Interpreting Events

Use the trace as a transaction timeline from Ctrl+Space to visible suggestions:

| Event | Meaning | Typical Follow-up |
| --- | --- | --- |
| `trigger-start` | Autocomplete was requested for a concrete editor/model/caret. | Confirm `boxId`, `modelUri`, caret position, and line/word lengths match the repro. |
| `schema-prepare-context` | The trigger found the active schema context. | Verify cluster/database are the selected connection. |
| `schema-prepare-no-context` | No per-model schema context was available. | Trace host schema delivery and editor-to-box mapping. |
| `schema-prepare-refs` | Fully qualified references were detected from the current statement/model. | Confirm current-cluster aliases are included when the reference targets the selected cluster/database. |
| `schema-prepare-keys` | Schema cache keys available to the webview at trigger time. | Look for missing primary, alias, or remote schema keys. |
| `schema-prepare-primary-wait` | The trigger waited for the Monaco worker primary schema. | If it times out, inspect the section's `preparation`, `worker`, and `pending` fields in `schemaLifecycleSnapshot()`, then inspect schema transaction events. |
| `schema-prepare-cross-cluster-wait` | The trigger waited for remote/cross-cluster schemas. | Check cross-cluster trace and host fetch/cache messages. |
| `worker-schema-decision` | The worker schema path chose first-load, replace, add, or fallback. | Validate that primary/current schema is also registered under cluster aliases. |
| `worker-add-aliases-start` / `worker-add-aliases-finish` | Additional database aliases were registered in the worker. | Confirm aliases include the fully qualified `cluster(...).database(...)` name and preserve functions/tables. |
| `suggest-triggered` | Monaco was asked to open suggestions. | If no labels appear after this, inspect worker diagnostics and markers. |
| `suggest-visible-snapshot` | Captures visible suggestion labels after render. | Compare expected exact column labels against `labels`. |

## Common Bug Shapes

- Missing columns with valid schema: primary schema may be loaded in app state but not registered into the Monaco Kusto worker for the active model.
- Schema arrived but was ignored: compare the current section instance/target generation with the request identity; stale same-ID sections and old targets are intentionally rejected.
- Unknown-cluster squiggle for selected connection: current cluster/database needs to be registered as an alias in the worker, including fully qualified `cluster(...).database(...)` forms.
- Functions visible but columns missing after invoking a function: function metadata may be missing `OutputColumns` or a synthesized body in alias schemas.
- Tests pass but real file fails: fixture schema is too small or loose suggestion matching accepts function signatures such as `timestamp()` instead of the `TIMESTAMP` column.

## Verification Checklist

- Run `npm run compile` after trace or Monaco worker changes.
- Run focused E2E tests that exercise semantic Kusto completions and Ctrl+Space.
- For user-provided authenticated repros, run a throwaway real-file E2E under `tests/vscode-extension-tester/runs/` and keep it untracked unless it is intentionally promoted to a stable test.
- Assert exact column labels with `waitExistingAllColumnsVisible`; do not rely on substring or normalized function-name matches.
- If you need source context, inspect the real file directly in the workspace. Do not add raw query text to autocomplete traces or E2E failure payloads.
- Confirm Kusto diagnostics for fully qualified current-cluster references have no unknown-cluster error markers.
