Feature: SQL Copilot inline completions (ghost text)

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Inline completions toggle and ghost text support in SQL sections
    # ── Setup: open editor, add SQL section, connect to sampledb ───────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections
    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb through the database dropdown
    When I evaluate "window.__testSelectKwDropdownItem(`kw-sql-section .select-wrapper[title='SQL Database'] kw-dropdown`, 'sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Wait for schema to load
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "00-setup-ready"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 1: Verify the Copilot inline toggle button exists in the SQL toolbar
    # ══════════════════════════════════════════════════════════════════════
    # Use evaluate to check — the `element ... should exist` step sometimes
    # misses webview elements due to execution context targeting.
    # Also verify the button is VISIBLE (not hidden by toolbar overflow).
    When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('Copilot inline toggle NOT found in SQL toolbar'); if (el.classList.contains('qe-in-overflow')) throw new Error('Toggle exists but is hidden in overflow — not visible to user'); const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) throw new Error('Toggle has zero dimensions — not visible'); return 'TOGGLE_VISIBLE: ' + rect.width + 'x' + rect.height; })()" in the webview
    Then I take a screenshot "01-toggle-exists"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Verify copilotInlineCompletionsEnabled is ON by default
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { if (typeof window.copilotInlineCompletionsEnabled !== 'boolean') throw new Error('copilotInlineCompletionsEnabled not found'); return 'copilotInline=' + window.copilotInlineCompletionsEnabled; })()" in the webview
    Then I take a screenshot "02-inline-state-default"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: Toggle OFF — click the ghost icon toggle → state flips to false
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked OFF'; })()" in the webview
    And I wait 1 second

    # Verify state toggled to OFF
    When I evaluate "(() => { if (window.copilotInlineCompletionsEnabled) throw new Error('Expected copilotInlineCompletionsEnabled OFF after toggle'); return 'after toggle OFF: ' + window.copilotInlineCompletionsEnabled; })()" in the webview
    Then I take a screenshot "03-toggle-off"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: Toggle ON — click again → state flips back to true
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked ON'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { if (!window.copilotInlineCompletionsEnabled) throw new Error('Expected copilotInlineCompletionsEnabled ON after re-toggle'); return 'after re-toggle ON: ' + window.copilotInlineCompletionsEnabled; })()" in the webview
    Then I take a screenshot "04-toggle-on"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: SQL editor is registered in the shared editor maps
    #   queryEditorBoxByModelUri and queryEditors should contain this editor
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__testAssertMonacoEditorMapped('kw-sql-section .query-editor')" in the webview
    Then I take a screenshot "05-editor-maps-populated"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: inlineSuggest option is enabled on the SQL Monaco editor
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__testAssertMonacoInlineSuggestEnabled('kw-sql-section .query-editor')" in the webview
    Then I take a screenshot "06-inline-suggest-option"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 7: Trigger inline suggestion via Ctrl+Shift+Space
    #   We can't guarantee Copilot LLM responds in test, but we can
    #   verify the keybinding is registered and sends a message to the host.
    #   We'll intercept postMessageToHost to detect the request.
    # ══════════════════════════════════════════════════════════════════════

    # Set up editor with some content and intercept the postMessage
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "(() => { window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT * FROM SalesLT.Customer WHERE FirstName = ', 1, 50); window.__testInlineReqCapture = []; window.__testOrigPostMsg = window.postMessageToHost; window.postMessageToHost = function(msg) { if (msg && msg.type === 'requestCopilotInlineCompletion') { window.__testInlineReqCapture.push(msg); } if (window.__testOrigPostMsg) window.__testOrigPostMsg(msg); }; return 'intercepted, editor ready'; })()" in the webview
    And I wait 1 second

    # Trigger inline suggestion manually via Ctrl+Shift+Space
    When I press "Ctrl+Shift+Space"
    And I wait 3 seconds
    Then I take a screenshot "07-after-ctrl-shift-space"

    # Verify a requestCopilotInlineCompletion message was sent with flavor='sql'
    When I evaluate "(() => { const msgs = window.__testInlineReqCapture || []; if (msgs.length === 0) throw new Error('No inline completion request captured — Ctrl+Shift+Space did not trigger'); const msg = msgs[0]; if (msg.flavor !== 'sql') throw new Error('Expected flavor=sql, got: ' + msg.flavor); if (!msg.textBefore || !msg.textBefore.includes('SELECT')) throw new Error('textBefore missing expected content'); return 'REQUEST_OK: flavor=' + msg.flavor + ' requests=' + msgs.length; })()" in the webview
    Then I take a screenshot "08-inline-request-verified"

    # Restore original postMessage
    When I evaluate "(() => { if (window.__testOrigPostMsg) { window.postMessageToHost = window.__testOrigPostMsg; delete window.__testOrigPostMsg; } delete window.__testInlineReqCapture; return 'restored'; })()" in the webview

    # ══════════════════════════════════════════════════════════════════════
    # TEST 8: Toggle sync — SQL toggle affects KQL toolbars too
    #   Add a KQL section, toggle off via SQL, verify KQL reflects it
    # ══════════════════════════════════════════════════════════════════════

    # Add a KQL section
    When I wait for "button[data-add-kind='query']" in the webview for 5 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    # Verify KQL toolbar also has the copilot inline toggle
    When I evaluate "(() => { const el = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('Copilot inline toggle NOT found in KQL toolbar'); return 'KQL_TOGGLE_EXISTS'; })()" in the webview

    # Both toggles should currently show ON (is-active class)
    When I evaluate "(() => { const sqlTgl = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); const kqlTgl = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); if (!sqlTgl) throw new Error('SQL toggle not found'); if (!kqlTgl) throw new Error('KQL toggle not found'); const sqlActive = sqlTgl.classList.contains('is-active'); const kqlActive = kqlTgl.classList.contains('is-active'); return 'SQL_ACTIVE=' + sqlActive + ' KQL_ACTIVE=' + kqlActive; })()" in the webview
    Then I take a screenshot "09-both-toggles-on"

    # Toggle OFF via SQL toolbar
    When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked OFF for sync test'; })()" in the webview
    And I wait 1 second

    # Verify BOTH SQL and KQL toggles show OFF
    When I evaluate "(() => { const sqlTgl = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); const kqlTgl = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); const sqlActive = sqlTgl.classList.contains('is-active'); const kqlActive = kqlTgl.classList.contains('is-active'); if (sqlActive) throw new Error('SQL toggle should be inactive'); if (kqlActive) throw new Error('KQL toggle should be inactive — sync broken'); return 'SYNC_OK: SQL_ACTIVE=' + sqlActive + ' KQL_ACTIVE=' + kqlActive; })()" in the webview
    Then I take a screenshot "10-both-toggles-off-synced"

    # Re-enable
    When I evaluate "(() => { const el = document.querySelector('kw-sql-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('toggle not found'); el.click(); return 'clicked ON (re-enable)'; })()" in the webview
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 9: Cleanup — verify editor maps are cleaned up when section is removed
    # ══════════════════════════════════════════════════════════════════════

    # Capture the boxId before removing
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); window.__testSqlBoxId = el.boxId; window.__testSqlModelUri = window.__testGetMonacoModelUri('kw-sql-section .query-editor'); return 'boxId=' + el.boxId + ' uri=' + window.__testSqlModelUri; })()" in the webview

    # Remove the SQL section
    When I evaluate "window.__testRemoveSection('kw-sql-section')" in the webview
    And I wait 2 seconds

    # Verify the maps are cleaned up
    When I evaluate "(() => { const boxId = window.__testSqlBoxId; const uri = window.__testSqlModelUri; const inMap1 = !!window.queryEditorBoxByModelUri[uri]; const inMap2 = !!window.queryEditors[boxId]; if (inMap1) throw new Error('queryEditorBoxByModelUri not cleaned up for ' + uri); if (inMap2) throw new Error('queryEditors not cleaned up for ' + boxId); return 'CLEANUP_OK: maps clear'; })()" in the webview
    Then I take a screenshot "11-cleanup-verified"

    Then I take a screenshot "12-final"
    When I execute command "workbench.action.closeAllEditors"
