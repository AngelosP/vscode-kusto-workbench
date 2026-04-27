Feature: SQL STS diagnostics — red squiggles for invalid T-SQL

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Invalid SQL shows diagnostic markers, fixing clears them
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

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

    # Explicitly trigger STS connect (matches sts-ac-v2 pattern)
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('SQL section not found'); const sqlConnectionId = typeof el.getSqlConnectionId === 'function' ? el.getSqlConnectionId() : ''; const database = typeof el.getDatabase === 'function' ? el.getDatabase() : ''; if (!sqlConnectionId) throw new Error('SQL connection id missing before STS connect'); if (!database) throw new Error('SQL database missing before STS connect'); window.vscode.postMessage({ type: 'stsConnect', boxId: el.boxId, sqlConnectionId, database }); return 'stsConnect: ' + database; })()" in the webview

    # Wait for STS to be ready (may take time for download + startup)
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds
    Then I take a screenshot "01-sts-ready"

    # Focus editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: Type invalid SQL → diagnostic markers appear ──────────────
    When I evaluate "window.__testSetMonacoValue('kw-sql-section .query-editor', 'SELEC * FORM invalid_syntax_here')" in the webview

    # Wait for STS to process and push diagnostics (may take a few seconds)
    And I wait 8 seconds

    When I evaluate "window.__testAssertMonacoMarkers('kw-sql-section .query-editor', 'any')" in the webview
    Then I take a screenshot "02-diagnostics-visible"

    # Verify at least one marker exists
    When I evaluate "window.__testAssertMonacoMarkers('kw-sql-section .query-editor', 'any')" in the webview

    # ── TEST 2: Fix the SQL → markers should clear ────────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-sql-section .query-editor', 'SELECT 1 AS test_value')" in the webview
    And I wait 8 seconds

    When I evaluate "window.__testAssertMonacoMarkers('kw-sql-section .query-editor', 'none')" in the webview
    Then I take a screenshot "03-markers-cleared"

    # ── TEST 3: Kusto section should NOT have SQL diagnostics ─────────────
    # Add a Kusto section and verify no SQL markers leak to it
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds

    When I evaluate "window.__testAssertMonacoMarkers('kw-query-section .query-editor', 'none', 'sql-sts')" in the webview
    Then I take a screenshot "04-kusto-isolation"
    When I execute command "workbench.action.closeAllEditors"
