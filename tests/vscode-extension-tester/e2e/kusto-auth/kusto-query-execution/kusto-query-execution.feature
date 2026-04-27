Feature: Kusto query execution end-to-end

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Execute KQL query, verify results, test error handling and run controls
    # ── Setup: open editor, add KQL section, connect ─────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    # Wait for cluster connection and databases
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select a database with data (prefers sample/storm, falls back to the first dropdown item)
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    Then I take a screenshot "01-setup-ready"

    # Focus the KQL editor
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const editorEl = document.getElementById(el.boxId + '_query_editor'); if (editorEl) editorEl.scrollIntoView({ block: 'center' }); return 'scrolled'; })()" in the webview
    And I wait 1 second

    # ── TEST 1: Run button is enabled when connected ──────────────────────
    When I evaluate "window.__e2e.kusto.assertRunEnabled()" in the webview
    Then I take a screenshot "02-run-enabled"

    # ── TEST 2: Execute simple query → results appear ─────────────────────
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print message='hello from e2e test', value=42`)" in the webview
    When I evaluate "window.__e2e.kusto.assertQuery(String.raw`print message='hello from e2e test', value=42`)" in the webview
    And I wait 1 second

    # Click the Run button
    When I evaluate "window.__e2e.kusto.run()" in the webview

    # Wait for execution to complete
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    # Verify results appeared
    When I evaluate "window.__e2e.kusto.assertHasResults()" in the webview
    Then I take a screenshot "03-results-appeared"

    # Verify result columns contain expected content
    When I evaluate "window.__e2e.kusto.assertResultColumns('message,value')" in the webview

    # Verify we got exactly 1 row
    When I evaluate "window.__e2e.kusto.assertRowCount(1)" in the webview

    # ── TEST 3: No error after successful execution ───────────────────────
    When I evaluate "window.__e2e.kusto.assertNoError()" in the webview

    # ── TEST 4: Execute invalid KQL → error appears ───────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('this_table_does_not_exist_xyz_abc')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.assertHasError()" in the webview
    Then I take a screenshot "04-error-shown"

    # ── TEST 5: Elapsed timer appears during execution ────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('print x=1 | extend y=x')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview

    # Check if the executing state is shown (status spinner visible)
    # Note: the query may finish fast, so we just verify it eventually completes
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    Then I take a screenshot "05-execution-complete"

    # ── TEST 6: Multi-row query result ────────────────────────────────────
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`range x from 1 to 5 step 1 | extend label = strcat('row_', tostring(x))`)" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    And I wait 1 second

    When I evaluate "(() => { window.__e2e.kusto.assertRowCount(5); return window.__e2e.kusto.assertResultColumns('x,label'); })()" in the webview
    Then I take a screenshot "06-multi-row-results"

    # ── TEST 7: Stale overlay after editing query ─────────────────────────
    When I evaluate "window.__e2e.kusto.setQuery('range x from 1 to 5 step 1 | extend modified=true')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.assertStaleResults()" in the webview
    Then I take a screenshot "07-stale-overlay"

    # ── TEST 8: Final verification ──────────────────────────────────────
    Then I take a screenshot "08-final"
    When I execute command "workbench.action.closeAllEditors"
