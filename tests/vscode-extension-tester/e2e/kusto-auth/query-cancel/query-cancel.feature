Feature: Kusto query cancellation

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Cancel a true long-running Kusto query and immediately run another query
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    When I evaluate "window.__e2e.kusto.selectRunMode('plain')" in the webview
    When I evaluate "window.__e2e.kusto.setCacheEnabled(false)" in the webview
    Then I take a screenshot "01-cancel-setup-ready"

    When I evaluate "window.__e2e.kusto.beginHostMessageCapture()" in the webview
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`let leftRows = range a from 1 to 1500000 step 1 | extend k = a % 4096, s = tostring(a); let rightRows = range b from 1 to 1500000 step 1 | extend k = b % 4096, t = tostring(b); leftRows | join kind=inner hint.strategy=shuffle (rightRows) on k | extend payload = strcat(s, ':', t, ':', tostring(rand())) | summarize pairs=count(), unique_payloads=dcount(payload)`)" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='true']" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.assertCancelButtonVisibleEnabled()" in the webview
    When I evaluate "window.__e2e.kusto.assertStillExecutingWithCancelAfter(15000)" in the webview for 20 seconds
    Then I take a screenshot "02-long-query-running-cancel-visible"

    When I evaluate "window.__e2e.kusto.clickCancel()" in the webview
    When I evaluate "window.__e2e.kusto.assertHostMessageCaptured('cancelQuery', document.querySelector('kw-query-section').boxId, 5000)" in the webview for 8 seconds
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertNotStuck()" in the webview
    When I evaluate "window.__e2e.kusto.assertCancelledText()" in the webview
    Then I take a screenshot "03-long-query-cancelled-not-stuck"

    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print after_true_long_cancel='ok', value=1`)" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "(() => { window.__e2e.kusto.assertResultColumns('after_true_long_cancel,value'); return window.__e2e.kusto.assertRowCount(1); })()" in the webview
    Then I take a screenshot "04-follow-up-query-succeeds"
    When I evaluate "window.__e2e.kusto.restoreHostMessageCapture()" in the webview

  Scenario: Fast query cancel race never leaves the section stuck
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    When I evaluate "window.__e2e.kusto.selectRunMode('plain')" in the webview
    When I evaluate "window.__e2e.kusto.setCacheEnabled(false)" in the webview

    When I evaluate "window.__e2e.kusto.beginHostMessageCapture()" in the webview
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print fast_cancel_race='ok'`)" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I evaluate "(() => { try { return window.__e2e.kusto.clickCancel(); } catch (error) { return 'query completed before cancel was clickable: ' + (error && error.message ? error.message : String(error)); } })()" in the webview
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.assertNotStuck()" in the webview
    Then I take a screenshot "05-fast-query-race-not-stuck"

    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print race_recovery='ok', value=2`)" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "(() => { window.__e2e.kusto.assertResultColumns('race_recovery,value'); return window.__e2e.kusto.assertRowCount(1); })()" in the webview
    Then I take a screenshot "06-fast-race-follow-up-query-succeeds"
    When I evaluate "window.__e2e.kusto.restoreHostMessageCapture()" in the webview
    When I execute command "workbench.action.closeAllEditors"