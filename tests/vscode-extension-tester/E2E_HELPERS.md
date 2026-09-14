# E2E Helper API

Feature files should prefer the semantic `window.__e2e` API over long inline JavaScript or direct private fields. The older `window.__test*` helpers remain available as low-level building blocks, but new behavioral tests should read like product intent.

## Readiness And Targeting

Wait for `body[data-kusto-e2e-ready='true']` in the exact notebook tab before using `window.__e2e`. This development-only marker is installed after the helper API; it does not replace section, Monaco, schema, or execution readiness assertions. Close unrelated sidebar/panel webviews during setup. Use title targeting at open/reopen boundaries, but leave keyboard/focus-sensitive operations unqualified once the intended editor is active: CLI 0.1.23 reactivates a named tab before each operation, which can dismiss suggestions or blur chat inputs.

```gherkin
When I execute command "kusto.openQueryEditor"
And I wait for "body[data-kusto-e2e-ready='true']" in the webview "session.kqlx"
And I evaluate "window.__e2e.workbench.clearSections()" in the webview
```

`clearSections()` returns a promise. Return or await it in composed expressions. Cleanup waits for canonical host-command settlement as well as an empty DOM; rejection, source/session retirement, or timeout must fail setup before section IDs can be reused. `waitForDocumentCommands()` similarly requires client acceptance, not merely a captured `ok: true` wire message.

Title-targeted steps may activate their tab. When focus retention is the behavior under test, assert the active tab's exact URI from the extension host before any title-targeted inspection. Standalone tutorial and first-launch webviews have different bundles: wait for their own rendered controls rather than the notebook helper marker.

## Preferred Patterns

- `window.__e2e.workbench.clearSections()`
- `window.__e2e.sql.selectDatabase('sampledb')`
- `window.__e2e.kusto.selectSampleDatabase()`
- `window.__e2e.sql.setQuery('SELECT 1')`
- `window.__e2e.kusto.setQuery('print x=1')`
- `window.__e2e.sql.run()` / `window.__e2e.kusto.run()`
- `window.__e2e.sql.assertResultColumns('col1,col2')`
- `window.__e2e.suggest.sql.setTextAt('SELECT * FROM ', 1, 15)`
- `window.__e2e.suggest.sql.trigger()`
- `window.__e2e.suggest.sql.assertVisible('FROM tables', 'Customer,Product')`
- `window.__e2e.suggest.sql.assertHidden('disabled auto-trigger')`
- `window.__e2e.autoTrigger.assertEnabled(true)`
- `window.__e2e.autoTrigger.clickSqlToggle()`
- `window.__e2e.inline.beginRequestCapture('sql', 'SELECT ...', 1, 50)`
- `window.__e2e.copilot.snapshot('sql')`
- `window.__e2e.copilot.beginObservation('sql')`
- `window.__e2e.copilot.finishObservation('Expected assistant text', 15000)`
- `window.__e2e.persistence.assertSectionOrder('query,markdown,sql')`
- `window.__e2e.persistence.assertQuerySection('query_1', { queryIncludes: 'StormEvents', clusterUrl: 'https://...', database: 'Samples' })`
- `window.__e2e.persistence.assertSqlSection('sql_1', { queryIncludes: 'SELECT', serverUrl: 'server.example', database: 'master' })`
- `window.__e2e.persistence.assertMarkdownSection('markdown_1', { mode: 'preview', textIncludes: 'Notes' })`
- `window.__e2e.cursorStatus.createNotebook()`
- `window.__e2e.cursorStatus.beginCapture()` / `window.__e2e.cursorStatus.restoreCapture()`
- `window.__e2e.cursorStatus.hoverKusto(2, 5)`
- `window.__e2e.cursorStatus.focusKusto(2, 5)` / `focusSql(2, 8)` / `focusHtml(2, 4)` / `focusPython(2, 6)` / `focusMarkdown(1, 3)`
- `window.__e2e.cursorStatus.assertVisible('kusto', 2, 5)`
- `window.__e2e.cursorStatus.assertStatusBarVisible('kusto', 2, 5)` / `assertStatusBarHidden()`
- `window.__e2e.cursorStatus.setKustoExpanded(false)` / `setKustoExpanded(true)`
- `window.__e2e.cursorStatus.setHtmlPreview()` / `setMarkdownPreview()`
- `window.__e2e.cursorStatus.assertHidden('html')` / `assertHidden('markdown')`

## Boundary

Use raw `When I evaluate "..." in the webview` only when the assertion is genuinely bespoke for that scenario. Do not use private section fields such as `_editor`, `_database`, `_databases`, or `_sqlConnectionId` in behavioral tests. Screenshot-generator features may keep targeted setup shortcuts when they are only arranging visual state for README capture.

Copilot observation helpers are inspection-only. They may assert rendered messages, running/progress state, enabled tools, mutation quiescence, and browser long-task timing, but tests must use the rendered textarea, tool checkboxes, Send/Stop button, and native keyboard input for user actions.

## Why

The semantic API prevents stale-editor mistakes, keeps section selectors consistent, and makes failures read as product failures instead of JavaScript plumbing errors.