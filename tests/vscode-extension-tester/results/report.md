# Test Results - All Passed

1 passed, 0 failed, 0 skipped (50087ms)

## SQL Copilot inline completions (ghost text)

✅ **Inline completions toggle and ghost text support in SQL sections** (43790ms)

- ✅ Given the extension is in a clean state
- ✅ And I capture the output channel "Kusto Workbench"
- ✅ And I wait 2 seconds
- ✅ When I execute command "kusto.openQueryEditor"
- ✅ And I wait 3 seconds
- ✅ When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length + ' sections'; })()" in the webview
- ✅ And I wait 2 seconds
- ✅ When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
- ✅ When I click "button[data-add-kind='sql']" in the webview
- ✅ And I wait 2 seconds
- ✅ When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
- ✅ When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) return 'no section'; const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs (' + dbs.length + ')'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
- ✅ When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
- ✅ When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
- ✅ Then I take a screenshot "00-setup-ready"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('Copilot inline toggle NOT found in SQL toolbar'); if (el.classList.contains('qe-in-overflow')) throw new Error('Toggle exists but is hidden in overflow — not visible to user'); const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) throw new Error('Toggle has zero dimensions — not visible'); return 'TOGGLE_VISIBLE: ' + rect.width + 'x' + rect.height; })()" in the webview
- ✅ Then I take a screenshot "01-toggle-exists"
- ✅ When I evaluate "(() => { if (typeof window.copilotInlineCompletionsEnabled !== 'boolean') throw new Error('copilotInlineCompletionsEnabled not found'); return 'copilotInline=' + window.copilotInlineCompletionsEnabled; })()" in the webview
- ✅ Then I take a screenshot "02-inline-state-default"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked OFF'; })()" in the webview
- ✅ And I wait 1 second
- ✅ When I evaluate "(() => { if (window.copilotInlineCompletionsEnabled) throw new Error('Expected copilotInlineCompletionsEnabled OFF after toggle'); return 'after toggle OFF: ' + window.copilotInlineCompletionsEnabled; })()" in the webview
- ✅ Then I take a screenshot "03-toggle-off"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked ON'; })()" in the webview
- ✅ And I wait 1 second
- ✅ When I evaluate "(() => { if (!window.copilotInlineCompletionsEnabled) throw new Error('Expected copilotInlineCompletionsEnabled ON after re-toggle'); return 'after re-toggle ON: ' + window.copilotInlineCompletionsEnabled; })()" in the webview
- ✅ Then I take a screenshot "04-toggle-on"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('No sql section'); const ed = el._editor; if (!ed) throw new Error('No editor'); const model = ed.getModel(); if (!model || !model.uri) throw new Error('No model'); const uri = model.uri.toString(); const boxId = window.queryEditorBoxByModelUri[uri]; if (!boxId) throw new Error('boxId not in queryEditorBoxByModelUri for ' + uri); const edRef = window.queryEditors[boxId]; if (!edRef) throw new Error('editor not in queryEditors for ' + boxId); return 'MAPS_OK: boxId=' + boxId; })()" in the webview
- ✅ Then I take a screenshot "05-editor-maps-populated"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const ed = el._editor; const opts = ed.getOptions(); const inlineSuggestOpt = opts.get(monaco.editor.EditorOption.inlineSuggest); if (!inlineSuggestOpt || !inlineSuggestOpt.enabled) throw new Error('inlineSuggest not enabled: ' + JSON.stringify(inlineSuggestOpt)); return 'INLINE_SUGGEST_ENABLED'; })()" in the webview
- ✅ Then I take a screenshot "06-inline-suggest-option"
- ✅ When I scroll "kw-sql-section .query-editor" into view
- ✅ And I wait 1 second
- ✅ When I click "kw-sql-section .query-editor" in the webview
- ✅ And I wait 1 second
- ✅ When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; ed.setValue('SELECT * FROM SalesLT.Customer WHERE FirstName = '); ed.setPosition({lineNumber:1, column: 50}); ed.focus(); window.__testInlineReqCapture = []; const orig = window.__kustoPostMessageToHost || null; window.__testOrigPostMsg = window.postMessageToHost; window.postMessageToHost = function(msg) { if (msg && msg.type === 'requestCopilotInlineCompletion') { window.__testInlineReqCapture.push(msg); } if (window.__testOrigPostMsg) window.__testOrigPostMsg(msg); }; return 'intercepted, editor ready'; })()" in the webview
- ✅ And I wait 1 second
- ✅ When I press "Ctrl+Shift+Space"
- ✅ And I wait 3 seconds
- ✅ Then I take a screenshot "07-after-ctrl-shift-space"
- ✅ When I evaluate "(() => { const msgs = window.__testInlineReqCapture || []; if (msgs.length === 0) throw new Error('No inline completion request captured — Ctrl+Shift+Space did not trigger'); const msg = msgs[0]; if (msg.flavor !== 'sql') throw new Error('Expected flavor=sql, got: ' + msg.flavor); if (!msg.textBefore || !msg.textBefore.includes('SELECT')) throw new Error('textBefore missing expected content'); return 'REQUEST_OK: flavor=' + msg.flavor + ' requests=' + msgs.length; })()" in the webview
- ✅ Then I take a screenshot "08-inline-request-verified"
- ✅ When I evaluate "(() => { if (window.__testOrigPostMsg) { window.postMessageToHost = window.__testOrigPostMsg; delete window.__testOrigPostMsg; } delete window.__testInlineReqCapture; return 'restored'; })()" in the webview
- ✅ When I wait for "button[data-add-kind='query']" in the webview for 5 seconds
- ✅ When I click "button[data-add-kind='query']" in the webview
- ✅ And I wait 2 seconds
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('Copilot inline toggle NOT found in KQL toolbar'); return 'KQL_TOGGLE_EXISTS'; })()" in the webview
- ✅ When I evaluate "(() => { const sqlTgl = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); const kqlTgl = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); if (!sqlTgl) throw new Error('SQL toggle not found'); if (!kqlTgl) throw new Error('KQL toggle not found'); const sqlActive = sqlTgl.classList.contains('is-active'); const kqlActive = kqlTgl.classList.contains('is-active'); return 'SQL_ACTIVE=' + sqlActive + ' KQL_ACTIVE=' + kqlActive; })()" in the webview
- ✅ Then I take a screenshot "09-both-toggles-on"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked OFF for sync test'; })()" in the webview
- ✅ And I wait 1 second
- ✅ When I evaluate "(() => { const sqlTgl = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); const kqlTgl = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); const sqlActive = sqlTgl.classList.contains('is-active'); const kqlActive = kqlTgl.classList.contains('is-active'); if (sqlActive) throw new Error('SQL toggle should be inactive'); if (kqlActive) throw new Error('KQL toggle should be inactive — sync broken'); return 'SYNC_OK: SQL_ACTIVE=' + sqlActive + ' KQL_ACTIVE=' + kqlActive; })()" in the webview
- ✅ Then I take a screenshot "10-both-toggles-off-synced"
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked ON (re-enable)'; })()" in the webview
- ✅ And I wait 1 second
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); window.__testSqlBoxId = el.boxId; const ed = el._editor; const model = ed.getModel(); window.__testSqlModelUri = model.uri.toString(); return 'boxId=' + el.boxId + ' uri=' + window.__testSqlModelUri; })()" in the webview
- ✅ When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('no sql section'); el.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: el.boxId || el.id }, bubbles: true, composed: true })); return 'removed'; })()" in the webview
- ✅ And I wait 2 seconds
- ✅ When I evaluate "(() => { const boxId = window.__testSqlBoxId; const uri = window.__testSqlModelUri; const inMap1 = !!window.queryEditorBoxByModelUri[uri]; const inMap2 = !!window.queryEditors[boxId]; if (inMap1) throw new Error('queryEditorBoxByModelUri not cleaned up for ' + uri); if (inMap2) throw new Error('queryEditors not cleaned up for ' + boxId); return 'CLEANUP_OK: maps clear'; })()" in the webview
- ✅ Then I take a screenshot "11-cleanup-verified"
- ✅ Then I take a screenshot "12-final"

---
*Generated at 2026-04-20T02:01:19.846Z*
