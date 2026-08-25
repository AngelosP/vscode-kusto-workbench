Feature: AZD large-result execution is bounded before transfer

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/kusto-auth/kusto-azd-large-result/azd-large-result.kqlx"
    And I wait 1 second

  Scenario: Plain AZD fact query returns at most 5000 rows without cancellation
    Given a file "tests/vscode-extension-tester/runs/kusto-auth/kusto-azd-large-result/azd-large-result.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"azd_large_result","type":"query","name":"AZD large result","expanded":true,"resultsVisible":true,"clusterUrl":"https://ddazureclients.kusto.windows.net","connectionIdHint":"conn_1765825441805_2yajf0pkw","database":"DevCli","query":"let WindowEnd = startofday(now());\nlet WindowStart = WindowEnd - 30d;\nlet LocalEnvironments = dynamic(['Desktop','Visual Studio','Visual Studio Code','GitHub Codespaces','VS Code Azure GitHub Copilot','Azure CloudShell']);\nAzdOperations\n| where Date >= WindowStart and Date < WindowEnd\n| where ExecutionEnvironment in (LocalEnvironments)\n| where AzdVersion !has 'daily'\n| extend CleanVersion = extract(@\"((?:\\d+)\\.(?:\\d+)\\.(?:\\d+))\", 0, AzdVersion)\n| where parse_version(CleanVersion) >= parse_version('0.8.0')\n| where OperationName != 'cmd.login' and OperationName != 'cmd.logout' and OperationName !startswith 'cmd.auth.'\n| where isnotempty(MachineId)\n| extend ActivityDate = startofday(Date), UserId = tostring(MachineId), CommandGroup = case(OperationName startswith 'cmd.', tostring(split(OperationName, '.')[1]), tostring(split(OperationName, '.')[0]))\n| where isnotempty(CommandGroup)\n| summarize EventCount = count() by ActivityDate, UserId, ExecutionEnvironment, AzdVersion = CleanVersion, CommandGroup\n| project ActivityDate, UserId, ExecutionEnvironment, AzdVersion, CommandGroup, EventCount\n| order by ActivityDate asc","runMode":"plain","cacheEnabled":false},{"id":"azd_large_dashboard","type":"html","name":"AZD large dashboard","code":"<script type=\"application/kw-provenance\">{\"version\":1,\"model\":{\"fact\":{\"sectionId\":\"azd_large_result\",\"sectionName\":\"AZD large result\"}},\"bindings\":{\"total\":{\"display\":{\"type\":\"scalar\",\"agg\":\"COUNT\"}}}}</script><span data-kw-bind=\"total\">0</span>","mode":"preview","expanded":true}]} }
      """
    When I open file "tests/vscode-extension-tester/runs/kusto-auth/kusto-azd-large-result/azd-large-result.kqlx" in the editor
    When I wait for "#azd_large_result[data-test-connection='true'][data-test-database-selected='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "#azd_large_result[data-test-executing='false'][data-test-has-results='true']" in the webview for 180 seconds
    Then I collect JSON artifact "azd-large-result-state" from webview expression "(() => { window.__e2e.kusto.assertNoError(); window.__e2e.kusto.assertResultColumns('ActivityDate,UserId,ExecutionEnvironment,AzdVersion,CommandGroup,EventCount'); window.__e2e.kusto.assertRowCount(5000); const section = document.getElementById('azd_large_result'); return { executing: section.dataset.testExecuting, hasResults: section.dataset.testHasResults, hasError: section.dataset.testHasError, rowCount: 5000 }; })()"
    Then I collect JSON artifact "azd-large-dashboard-validation" from extension host expression "(async () => { const result = await vscode.lm.invokeTool('kusto-workbench_validate-html-dashboard', { toolInvocationToken: undefined, input: { sectionId: 'azd_large_dashboard' } }); const text = String(result.content.find(part => typeof part?.value === 'string')?.value || ''); if (!text || text.startsWith('Error:')) throw new Error('Dashboard validation tool failed: ' + text); const validation = JSON.parse(text); if (validation.success !== true || validation.valid !== true || validation.dataSourceCount !== 1) throw new Error('Dashboard validation failed: ' + text); return { success: validation.success, valid: validation.valid, dataSourceCount: validation.dataSourceCount, factColumns: validation.factColumns }; })()"
    When I move the Dev Host to 0, 0
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "01-azd-large-result-capped"
    When I execute command "workbench.action.files.save"
    And I wait 2 seconds
    Then I collect JSON artifact "azd-large-result-persisted" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/kusto-auth/kusto-azd-large-result/azd-large-result.kqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document || document.isDirty) throw new Error('Saved AZD fixture is unavailable or dirty'); const file = JSON.parse(document.getText()); const query = file.state.sections.find(section => section.id === 'azd_large_result'); const result = query?.resultJson ? JSON.parse(query.resultJson) : undefined; if (!result || result.rows?.length !== 5000) throw new Error('Persisted AZD result is missing or uncapped: ' + JSON.stringify({ hasResult: !!result, rowCount: result?.rows?.length })); return { rowCount: result.rows.length, columns: result.columns.map(column => typeof column === 'string' ? column : column.name), dirty: document.isDirty }; })()"
    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/kusto-auth/kusto-azd-large-result/azd-large-result.kqlx"
