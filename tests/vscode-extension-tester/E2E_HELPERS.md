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

## Boundary

Use raw `When I evaluate "..." in the webview` only when the assertion is genuinely bespoke for that scenario. Do not use private section fields such as `_editor`, `_database`, `_databases`, or `_sqlConnectionId` in behavioral tests. Screenshot-generator features may keep targeted setup shortcuts when they are only arranging visual state for README capture.

## Why

The semantic API prevents stale-editor mistakes, keeps section selectors consistent, and makes failures read as product failures instead of JavaScript plumbing errors.