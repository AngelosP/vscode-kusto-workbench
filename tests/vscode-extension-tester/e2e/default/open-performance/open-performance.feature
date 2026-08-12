Feature: Custom editor open performance

  Background:
    Given the extension is in a clean state
    And I wait 1 second

  Scenario: Open a plain KQL file
    Given a file "tests/vscode-extension-tester/runs/default/open-performance/plain-open.kql" exists with content:
      """
      StormEvents
      | where StartTime > ago(7d)
      | summarize Events=count() by State
      | order by Events desc
      """

    When I open file "tests/vscode-extension-tester/runs/default/open-performance/plain-open.kql" in the editor
    When I wait for "kw-query-section" in the webview for 30 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I evaluate "window.__e2e.perf.markWebviewSnapshot('plain-kql-webview-perf', 'webview.message.documentData.received,webview.persistence.restore.start,webview.persistence.restore.end,webview.section.query.added,webview.monaco.queryEditor.ready')" in the webview
    Then I wait for "[data-testid='e2e-proof-plain-kql-webview-perf']" in the webview for 5 seconds
    Then I collect JSON artifact "host-perf" from extension host expression "(() => { const s = globalThis.__kustoPerf?.snapshot?.(); if (!s || s.enabled !== true) throw new Error('host perf disabled'); const c = s.current; if (!c || c.label !== 'host.kqlCompat.resolve') throw new Error('wrong host perf label: ' + JSON.stringify(c)); const names = (c.marks || []).map(m => m.name); const missing = ['host.kqlCompat.initializeWebview.start','host.kqlCompat.initializeWebview.done','host.kqlCompat.postDocument.start','host.kqlCompat.documentData.posted'].filter(n => !names.includes(n)); if (missing.length) throw new Error('missing host perf marks: ' + missing.join(',')); return s; })()"
    Then I collect JSON artifact "webview-perf" from webview expression "window.__e2e?.perf?.snapshot?.()"

  Scenario: Open two plain KQL files in one session
    Given a file "tests/vscode-extension-tester/runs/default/open-performance/plain-first.kql" exists with content:
      """
      StormEvents | take 10
      """
    And a file "tests/vscode-extension-tester/runs/default/open-performance/plain-second.kql" exists with content:
      """
      StormEvents | where State == 'TEXAS' | take 10
      """

    When I open file "tests/vscode-extension-tester/runs/default/open-performance/plain-first.kql" in the editor
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I evaluate "window.__e2e.perf.markWebviewSnapshot('first-kql-webview-perf', 'webview.message.documentData.received,webview.persistence.restore.start,webview.persistence.restore.end,webview.section.query.added,webview.monaco.queryEditor.ready')" in the webview
    Then I wait for "[data-testid='e2e-proof-first-kql-webview-perf']" in the webview for 5 seconds
    Then I collect JSON artifact "host-perf-first-kql" from extension host expression "(() => { const s = globalThis.__kustoPerf?.snapshot?.(); if (!s || s.enabled !== true) throw new Error('host perf disabled'); const c = s.current; if (!c || c.label !== 'host.kqlCompat.resolve') throw new Error('wrong host perf label: ' + JSON.stringify(c)); const names = (c.marks || []).map(m => m.name); const missing = ['host.kqlCompat.initializeWebview.start','host.kqlCompat.initializeWebview.done','host.kqlCompat.postDocument.start','host.kqlCompat.documentData.posted'].filter(n => !names.includes(n)); if (missing.length) throw new Error('missing host perf marks: ' + missing.join(',')); return s; })()"
    Then I collect JSON artifact "webview-perf-first-kql" from webview expression "window.__e2e?.perf?.snapshot?.()"

    When I open file "tests/vscode-extension-tester/runs/default/open-performance/plain-second.kql" in the editor
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    Then I evaluate "window.__e2e.perf.markWebviewSnapshot('second-kql-webview-perf', 'webview.message.documentData.received,webview.persistence.restore.start,webview.persistence.restore.end,webview.section.query.added,webview.monaco.queryEditor.ready')" in the webview
    Then I wait for "[data-testid='e2e-proof-second-kql-webview-perf']" in the webview for 5 seconds
    Then I collect JSON artifact "host-perf-second-kql" from extension host expression "(() => { const s = globalThis.__kustoPerf?.snapshot?.(); if (!s || s.enabled !== true) throw new Error('host perf disabled'); const c = s.current; if (!c || c.label !== 'host.kqlCompat.resolve') throw new Error('wrong host perf label: ' + JSON.stringify(c)); const names = (c.marks || []).map(m => m.name); const missing = ['host.kqlCompat.initializeWebview.start','host.kqlCompat.initializeWebview.done','host.kqlCompat.postDocument.start','host.kqlCompat.documentData.posted'].filter(n => !names.includes(n)); if (missing.length) throw new Error('missing host perf marks: ' + missing.join(',')); return s; })()"
    Then I collect JSON artifact "webview-perf-second-kql" from webview expression "window.__e2e?.perf?.snapshot?.()"

  Scenario: Open a persisted-results KQLX file
    When I delete file "tests/vscode-extension-tester/runs/default/open-performance/owned-results.kqlx"
    And I wait 1 second
    When I execute command "kustoWorkbench.test.preparePersistedResultFixture" with args '[{"engine":"kusto","templatePath":"tests/vscode-extension-tester/e2e/default/persisted-results-restore/fixtures/persisted-results.kqlx","outputPath":"tests/vscode-extension-tester/runs/default/open-performance/owned-results.kqlx"}]'
    And I wait 1 second
    When I open file "tests/vscode-extension-tester/runs/default/open-performance/owned-results.kqlx" in the editor
    When I wait for "kw-query-section" in the webview for 30 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    When I wait for "kw-query-section[data-test-has-results='true']" in the webview for 30 seconds
    Then I evaluate "window.__e2e.perf.markWebviewSnapshot('persisted-kqlx-webview-perf', 'webview.message.documentData.received,webview.persistence.restore.start,webview.persistence.restore.end,webview.section.query.added,webview.monaco.queryEditor.ready')" in the webview
    Then I wait for "[data-testid='e2e-proof-persisted-kqlx-webview-perf']" in the webview for 5 seconds
    Then I collect JSON artifact "host-perf" from extension host expression "(() => { const s = globalThis.__kustoPerf?.snapshot?.(); if (!s || s.enabled !== true) throw new Error('host perf disabled'); const c = s.current; if (!c || c.label !== 'host.kqlx.resolve') throw new Error('wrong host perf label: ' + JSON.stringify(c)); const names = (c.marks || []).map(m => m.name); const missing = ['host.kqlx.webviewInitialized','host.kqlx.postDocument.start','host.kqlx.documentText.read','host.kqlx.parse.done','host.kqlx.sanitize.done','host.kqlx.documentData.posted'].filter(n => !names.includes(n)); if (missing.length) throw new Error('missing host perf marks: ' + missing.join(',')); return s; })()"
    Then I collect JSON artifact "webview-perf" from webview expression "window.__e2e?.perf?.snapshot?.()"
    When I execute command "workbench.action.revertAndCloseActiveEditor"
    When I execute command "kustoWorkbench.test.cleanupPersistedResultFixture"
    When I delete file "tests/vscode-extension-tester/runs/default/open-performance/owned-results.kqlx"

  Scenario: Open a mixed KQLX file
    Given a file "tests/vscode-extension-tester/runs/default/open-performance/mixed-open.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"type":"query","id":"query_perf_mixed","name":"Perf Query","clusterUrl":"https://help.kusto.windows.net","database":"Samples","query":"StormEvents | take 25","expanded":true},{"type":"markdown","id":"markdown_perf_mixed","title":"Perf Notes","text":"# Perf Notes\nA markdown section restored with the notebook.","mode":"preview","expanded":true},{"type":"html","id":"html_perf_mixed","name":"Perf HTML","code":"<section><h1>Perf HTML</h1><p>Restored dashboard section</p></section>","mode":"preview","expanded":true,"previewHeightPx":180},{"type":"sql","id":"sql_perf_mixed","name":"Perf SQL","query":"SELECT 1 AS perf_marker;","serverUrl":"localhost","database":"master","expanded":true}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/open-performance/mixed-open.kqlx" in the editor
    When I wait for "kw-query-section" in the webview for 30 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    When I wait for "kw-markdown-section" in the webview for 30 seconds
    When I wait for "kw-html-section" in the webview for 30 seconds
    Then I evaluate "window.__e2e.perf.markWebviewSnapshot('mixed-kqlx-webview-perf', 'webview.message.documentData.received,webview.persistence.restore.start,webview.persistence.restore.end,webview.section.query.added,webview.monaco.queryEditor.ready')" in the webview
    Then I wait for "[data-testid='e2e-proof-mixed-kqlx-webview-perf']" in the webview for 5 seconds
    Then I collect JSON artifact "host-perf" from extension host expression "(() => { const s = globalThis.__kustoPerf?.snapshot?.(); if (!s || s.enabled !== true) throw new Error('host perf disabled'); const c = s.current; if (!c || c.label !== 'host.kqlx.resolve') throw new Error('wrong host perf label: ' + JSON.stringify(c)); const names = (c.marks || []).map(m => m.name); const missing = ['host.kqlx.webviewInitialized','host.kqlx.postDocument.start','host.kqlx.documentText.read','host.kqlx.parse.done','host.kqlx.sanitize.done','host.kqlx.documentData.posted'].filter(n => !names.includes(n)); if (missing.length) throw new Error('missing host perf marks: ' + missing.join(',')); return s; })()"
    Then I collect JSON artifact "webview-perf" from webview expression "window.__e2e?.perf?.snapshot?.()"