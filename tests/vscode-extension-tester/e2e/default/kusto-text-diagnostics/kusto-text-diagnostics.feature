Feature: KQL custom editor does not show stale diagnostics

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 1 second

  Scenario: Valid custom-editor KQL file has no Monaco Kusto errors when schema is unavailable
    When I execute command "kustoWorkbench.test.seedKustoTextDiagnosticsState"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-text-diagnostics/foreign-valid.kql" exists with content:
      """
      StormEvents
      | take 10
      """

    When I open file "tests/vscode-extension-tester/runs/default/kusto-text-diagnostics/foreign-valid.kql" in the editor
    When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    When I evaluate "__testFocusMonaco('kw-query-section .monaco-editor')" in the webview
    And I wait 3 seconds

    Then I collect JSON artifact "kql-custom-editor-diagnostics" from webview expression "(() => { const diag = window.__e2e.kusto.suggestDiagnostics('valid kql file without loaded schema'); const errorMarkers = (diag.markers || []).filter(marker => marker.owner === 'kusto' && marker.severity === monaco.MarkerSeverity.Error); if (errorMarkers.length) { throw new Error('Expected no Monaco Kusto error markers for valid custom-editor KQL without loaded schema, got: ' + JSON.stringify(errorMarkers)); } return diag; })()"