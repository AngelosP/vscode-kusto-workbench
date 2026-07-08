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

  Scenario: Control-command function strings do not appear as Kusto Workbench Problems
  When I execute command "kustoWorkbench.test.seedKustoTextDiagnosticsState"
  When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
  Given a file "tests/vscode-extension-tester/runs/default/kusto-text-diagnostics/control-function.kql" exists with content:
    """
    .create-or-alter function with
    (
      folder = "FoundryToolkit",
      docstring = "Get the top-level error category of VS Code Foundry extension failures."
    )
    getFoundryTkErrorCategory
    (
      errorMessage: string
    )
    {
      let message = tolower(errorMessage);
      case(
        message contains "projectblocked" or message contains "blocked from accessing the agents service",
          "Project blocked from Agents service",
        message contains "user-provided acr not found",
          "ACR lookup failed",
        "Uncategorized error (catch-all)"
      )
    }
    """

  When I open file "tests/vscode-extension-tester/runs/default/kusto-text-diagnostics/control-function.kql" in the editor
  When I wait for "kw-query-section .monaco-editor" in the webview for 30 seconds
  And I wait 1 second

  Then I collect JSON artifact "kql-control-command-problems" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/kusto-text-diagnostics/control-function.kql'; const doc = vscode.workspace.textDocuments.find(d => d.uri.path.replace(/\\\\/g, '/').endsWith(suffix)); if (!doc) { throw new Error('Could not find opened control-command KQL document. Open docs: ' + vscode.workspace.textDocuments.map(d => d.uri.toString()).join(', ')); } await vscode.commands.executeCommand('kusto.refreshTextEditorDiagnostics'); await new Promise(resolve => setTimeout(resolve, 800)); const diagnostics = vscode.languages.getDiagnostics(doc.uri).map(d => ({ source: d.source || '', code: typeof d.code === 'object' ? JSON.stringify(d.code) : String(d.code || ''), message: d.message, severity: d.severity })); const falseTables = diagnostics.filter(d => d.source === 'Kusto Workbench' && d.code === 'KW_UNKNOWN_TABLE' && /`(accessing|Agents|failed)`/.test(d.message)); if (falseTables.length) { throw new Error('Expected no Kusto Workbench unknown-table diagnostics from control-command string content, got: ' + JSON.stringify(falseTables)); } return { uri: doc.uri.toString(), diagnostics, falseTables }; })()"