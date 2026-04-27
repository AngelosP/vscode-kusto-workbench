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
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb through the database dropdown
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
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
    When I evaluate "window.__e2e.inline.assertToggleVisible('sql')" in the webview
    Then I take a screenshot "01-toggle-exists"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Verify copilotInlineCompletionsEnabled is ON by default
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.inline.assertGlobalEnabled(true)" in the webview
    Then I take a screenshot "02-inline-state-default"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: Toggle OFF — click the ghost icon toggle → state flips to false
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    # Verify state toggled to OFF
    When I evaluate "window.__e2e.inline.assertGlobalEnabled(false)" in the webview
    Then I take a screenshot "03-toggle-off"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: Toggle ON — click again → state flips back to true
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.assertGlobalEnabled(true)" in the webview
    Then I take a screenshot "04-toggle-on"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: SQL editor is registered in the shared editor maps
    #   queryEditorBoxByModelUri and queryEditors should contain this editor
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.sql.assertEditorMapped()" in the webview
    Then I take a screenshot "05-editor-maps-populated"

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: inlineSuggest option is enabled on the SQL Monaco editor
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.sql.assertInlineSuggestEnabled()" in the webview
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

    When I evaluate "window.__e2e.inline.beginRequestCapture('sql', 'SELECT * FROM SalesLT.Customer WHERE FirstName = ', 1, 50)" in the webview
    And I wait 1 second

    # Trigger inline suggestion manually via Ctrl+Shift+Space
    When I press "Ctrl+Shift+Space"
    And I wait 3 seconds
    Then I take a screenshot "07-after-ctrl-shift-space"

    # Verify a requestCopilotInlineCompletion message was sent with flavor='sql'
    When I evaluate "window.__e2e.inline.assertCapturedRequest('sql', 'SELECT')" in the webview
    Then I take a screenshot "08-inline-request-verified"

    # Restore original postMessage
    When I evaluate "window.__e2e.inline.restoreRequestCapture()" in the webview

    # ══════════════════════════════════════════════════════════════════════
    # TEST 8: Toggle sync — SQL toggle affects KQL toolbars too
    #   Add a KQL section, toggle off via SQL, verify KQL reflects it
    # ══════════════════════════════════════════════════════════════════════

    # Add a KQL section
    When I wait for "button[data-add-kind='query']" in the webview for 5 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    # Verify KQL toolbar also has the copilot inline toggle
    When I evaluate "window.__e2e.inline.assertToggleVisible('kusto')" in the webview

    # Both toggles should currently show ON (is-active class)
    When I evaluate "window.__e2e.inline.assertSqlAndKustoSynced(true)" in the webview
    Then I take a screenshot "09-both-toggles-on"

    # Toggle OFF via SQL toolbar
    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    # Verify BOTH SQL and KQL toggles show OFF
    When I evaluate "window.__e2e.inline.assertSqlAndKustoSynced(false)" in the webview
    Then I take a screenshot "10-both-toggles-off-synced"

    # Re-enable
    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 9: Cleanup — verify editor maps are cleaned up when section is removed
    # ══════════════════════════════════════════════════════════════════════

    # Capture the boxId before removing
    When I evaluate "window.__e2e.inline.rememberEditorMap('sql', 'sql-inline')" in the webview

    # Remove the SQL section
    When I evaluate "window.__e2e.workbench.removeSection('kw-sql-section')" in the webview
    And I wait 2 seconds

    # Verify the maps are cleaned up
    When I evaluate "window.__e2e.inline.assertRememberedEditorMapCleared('sql-inline')" in the webview
    Then I take a screenshot "11-cleanup-verified"

    Then I take a screenshot "12-final"
    When I execute command "workbench.action.closeAllEditors"
