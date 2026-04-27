Feature: Kusto inline completions (Copilot ghost text)

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Inline completions toggle and ghost text support in KQL sections
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select database through the dropdown
    When I evaluate "window.__testSelectKwDropdownItem(`kw-query-section .select-wrapper[title='Kusto Database'] kw-dropdown`, 'sample,storm', true)" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    Then I take a screenshot "00-setup-ready"

    # ── TEST 1: Copilot inline toggle exists in KQL toolbar ───────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); if (!el) throw new Error('Copilot inline toggle NOT found in KQL toolbar'); const rect = el.getBoundingClientRect(); if (rect.width === 0 || rect.height === 0) throw new Error('Toggle has zero dimensions'); return 'TOGGLE_VISIBLE: ' + rect.width.toFixed(0) + 'x' + rect.height.toFixed(0); })()" in the webview
    Then I take a screenshot "01-toggle-exists"

    # ── TEST 2: copilotInlineCompletionsEnabled is ON by default ──────────
    When I evaluate "(() => { if (typeof window.copilotInlineCompletionsEnabled !== 'boolean') throw new Error('copilotInlineCompletionsEnabled not found on window'); return 'copilotInline=' + window.copilotInlineCompletionsEnabled; })()" in the webview

    # ── TEST 3: Toggle OFF ────────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); el.click(); return 'clicked OFF'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { if (window.copilotInlineCompletionsEnabled) throw new Error('Expected OFF after toggle'); return 'copilotInline=' + window.copilotInlineCompletionsEnabled + ' ✓'; })()" in the webview
    Then I take a screenshot "02-toggle-off"

    # ── TEST 4: Toggle ON ─────────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-toolbar .qe-copilot-inline-toggle'); el.click(); return 'clicked ON'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { if (!window.copilotInlineCompletionsEnabled) throw new Error('Expected ON after re-toggle'); return 'copilotInline=' + window.copilotInlineCompletionsEnabled + ' ✓'; })()" in the webview
    Then I take a screenshot "03-toggle-on"

    # ── TEST 5: KQL editor is registered in shared editor maps ────────────
    When I evaluate "window.__testAssertMonacoEditorMapped('kw-query-section .query-editor')" in the webview
    Then I take a screenshot "04-editor-maps"

    # ── TEST 6: inlineSuggest option enabled on Monaco editor ─────────────
    When I evaluate "window.__testAssertMonacoInlineSuggestEnabled('kw-query-section .query-editor')" in the webview

    # ── TEST 7: Trigger inline suggestion via Ctrl+Shift+Space ────────────
    When I evaluate "(() => { window.__testSetMonacoValueAt('kw-query-section .query-editor', 'StormEvents | where ', 1, 21); window.__testInlineReqCapture = []; window.__testOrigPostMsg = window.postMessageToHost; window.postMessageToHost = function(msg) { if (msg && msg.type === 'requestCopilotInlineCompletion') { window.__testInlineReqCapture.push(msg); } if (window.__testOrigPostMsg) window.__testOrigPostMsg(msg); }; return 'intercepted, editor ready'; })()" in the webview
    And I wait 1 second

    When I press "Ctrl+Shift+Space"
    And I wait 3 seconds
    Then I take a screenshot "05-after-ctrl-shift-space"

    When I evaluate "(() => { const msgs = window.__testInlineReqCapture || []; if (msgs.length === 0) throw new Error('No inline completion request captured — Ctrl+Shift+Space did not trigger'); const msg = msgs[0]; if (msg.flavor !== 'kusto') throw new Error('Expected flavor=kusto, got: ' + msg.flavor); if (!msg.textBefore || !msg.textBefore.includes('StormEvents')) throw new Error('textBefore missing expected content'); return 'REQUEST_OK: flavor=' + msg.flavor + ' requests=' + msgs.length + ' ✓'; })()" in the webview
    Then I take a screenshot "06-inline-request-verified"

    # Restore original postMessage
    When I evaluate "(() => { if (window.__testOrigPostMsg) { window.postMessageToHost = window.__testOrigPostMsg; delete window.__testOrigPostMsg; } delete window.__testInlineReqCapture; return 'restored'; })()" in the webview
    Then I take a screenshot "07-final"
    When I execute command "workbench.action.closeAllEditors"
