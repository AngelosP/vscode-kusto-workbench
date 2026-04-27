Feature: SQL results table — display, stale overlay, metadata

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Results display correctly, stale overlay on edit, metadata shown
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

    # Focus editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    # ── TEST 1: Execute and verify multi-column results ───────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT TOP 3 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES ORDER BY TABLE_SCHEMA, TABLE_NAME')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertResultColumns('TABLE_SCHEMA,TABLE_NAME,TABLE_TYPE')" in the webview
    Then I take a screenshot "01-multi-column-results"

    # ── TEST 2: Results have correct row count ────────────────────────────
    When I evaluate "window.__e2e.sql.assertRowCount(3)" in the webview

    # ── TEST 3: Edit query → stale overlay appears ────────────────────────
    When I evaluate "window.__e2e.sql.setQuery('SELECT TOP 3 TABLE_SCHEMA, TABLE_NAME, TABLE_TYPE FROM INFORMATION_SCHEMA.TABLES -- modified')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertStaleResults()" in the webview
    Then I take a screenshot "02-stale-overlay"

    # ── TEST 4: Re-run → stale overlay clears ────────────────────────────
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.sql.assertResultsNotStale()" in the webview
    Then I take a screenshot "03-stale-cleared"
    When I execute command "workbench.action.closeAllEditors"
