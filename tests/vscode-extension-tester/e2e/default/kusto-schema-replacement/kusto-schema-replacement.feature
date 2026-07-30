Feature: Kusto worker schema replacement

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"

  Scenario: Changed compact schema replaces the worker catalog
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview
    When I wait for "kw-query-section" in the webview for 20 seconds
    When I click "kw-query-section .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.setCustomColumnProviderEnabled(false)" in the webview

    When I evaluate "window.__e2e.kusto.applySchemaReplacementFixture('A')" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('Events\n| project VersionOnly⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertRenderedSnapshotsIncludeAndExcludeColumns('worker schema A columns', 'VersionOnlyOld', 'VersionOnlyNew', 3000, 100)" in the webview for 10 seconds

    When I evaluate "window.__e2e.kusto.applySchemaReplacementFixture('B')" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('Events\n| project VersionOnly⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertRenderedSnapshotsIncludeAndExcludeColumns('worker schema B replaces A', 'VersionOnlyNew', 'VersionOnlyOld', 3000, 100)" in the webview for 10 seconds
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.trigger()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.waitExistingAllColumnsVisible('worker schema B acceptance', 'VersionOnlyNew', 5000)" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.acceptSuggestion('project-columns')" in the webview
  	When I evaluate "window.__e2e.kusto.assertQuery('Events\n| project VersionOnlyNew')" in the webview
    And I wait 1 second
  	When I evaluate "window.__e2e.kusto.assertQuery('Events\n| project VersionOnlyNew')" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); section.clearResults(); section.setSchemaInfo({ status: 'loaded', statusText: 'E2E replacement schema B loaded' }); return 'replacement state restored'; })()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.assertQuery('Events\n| project VersionOnlyNew')" in the webview

    When I evaluate "window.__e2e.kusto.setCustomColumnProviderEnabled(true)" in the webview
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"