Feature: Kusto execution remains isolated from SQL Tools Service

  Background:
    Given the extension is in a clean state
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

  Scenario: Execute KQL and preserve result routing
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print message='kusto isolated', value=42`)" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.assertResultColumns('message,value')" in the webview
    When I evaluate "window.__e2e.kusto.assertRowCount(1)" in the webview
    When I evaluate "window.__e2e.kusto.assertNoError()" in the webview
    When I execute command "workbench.action.closeAllEditors"