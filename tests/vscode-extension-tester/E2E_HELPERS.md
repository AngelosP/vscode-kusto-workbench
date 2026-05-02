# E2E Helper API

Feature files should prefer the semantic `window.__e2e` API over long inline JavaScript or direct private fields. The older `window.__test*` helpers remain available as low-level building blocks, but new behavioral tests should read like product intent.

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

## Why

The semantic API prevents stale-editor mistakes, keeps section selectors consistent, and makes failures read as product failures instead of JavaScript plumbing errors.