Feature: Kusto inline completions (Copilot ghost text)

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Inline completions toggle and ghost text support in KQL sections
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select database through the dropdown
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    Then I take a screenshot "00-setup-ready"

    # ── TEST 1: Copilot inline toggle exists in KQL toolbar ───────────────
    When I evaluate "window.__e2e.inline.assertToggleVisible('kusto')" in the webview
    Then I take a screenshot "01-toggle-exists"

    # ── TEST 2: copilotInlineCompletionsEnabled is ON by default ──────────
    When I evaluate "window.__e2e.inline.assertGlobalEnabled(true)" in the webview

    # ── TEST 3: Toggle OFF ────────────────────────────────────────────────
    When I evaluate "window.__e2e.inline.clickToggle('kusto')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.assertGlobalEnabled(false)" in the webview
    Then I take a screenshot "02-toggle-off"

    # ── TEST 4: Toggle ON ─────────────────────────────────────────────────
    When I evaluate "window.__e2e.inline.clickToggle('kusto')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.assertGlobalEnabled(true)" in the webview
    Then I take a screenshot "03-toggle-on"

    # ── TEST 5: KQL editor is registered in shared editor maps ────────────
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    Then I take a screenshot "04-editor-maps"

    # ── TEST 6: inlineSuggest option enabled on Monaco editor ─────────────
    When I evaluate "window.__e2e.kusto.assertInlineSuggestEnabled()" in the webview

    # ── TEST 7: Trigger inline suggestion via Ctrl+Shift+Space ────────────
    When I evaluate "window.__e2e.inline.beginRequestCapture('kusto', 'StormEvents | where ', 1, 21)" in the webview
    And I wait 1 second

    When I press "Ctrl+Shift+Space"
    And I wait 3 seconds
    Then I take a screenshot "05-after-ctrl-shift-space"

    When I evaluate "window.__e2e.inline.assertCapturedRequest('kusto', 'StormEvents')" in the webview
    Then I take a screenshot "06-inline-request-verified"

    # Restore original postMessage
    When I evaluate "window.__e2e.inline.restoreRequestCapture()" in the webview
    Then I take a screenshot "07-final"
    When I execute command "workbench.action.closeAllEditors"
