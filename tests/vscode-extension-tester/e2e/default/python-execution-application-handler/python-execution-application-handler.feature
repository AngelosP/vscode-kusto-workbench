Feature: Python execution application handler

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"

  Scenario: Python execution renders and persists exact host output
    Given a file "tests/vscode-extension-tester/runs/default/python-execution-application-handler/python-execution.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"python_hst3","type":"python","name":"HST-3 Python","code":"print('HST3:' + str(sum([7, 8, 9])))","output":"","expanded":true,"editorHeightPx":180}]}}
      """
    And I wait 1 second

    When I open file "tests/vscode-extension-tester/runs/default/python-execution-application-handler/python-execution.kqlx" in the editor
    When I wait for "#python_hst3" in the webview for 20 seconds
    When I evaluate "(async () => { const section = document.getElementById('python_hst3'); const deadline = Date.now() + 10000; while (Date.now() < deadline) { if (section?._editor && !section.shadowRoot?.querySelector('.run-btn')?.disabled) return 'python ready'; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Python section did not become runnable'); })()" in the webview for 15 seconds
    When I click ".run-btn" in the webview
    When I evaluate "(async () => { const section = document.getElementById('python_hst3'); const deadline = Date.now() + 20000; while (Date.now() < deadline) { await section.updateComplete; const state = section.createDocumentState(); const output = section.shadowRoot?.querySelector('.python-output')?.textContent ?? ''; if (state.output === 'HST3:24' && output === 'HST3:24' && !section.shadowRoot?.querySelector('.run-btn')?.disabled) return { output, code: state.code, running: false }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Exact Python output did not arrive: ' + JSON.stringify(section.createDocumentState())); })()" in the webview for 25 seconds
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "hst3-python-execution" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/python-execution-application-handler/python-execution.kqlx'; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (document && !document.isDirty) { const file = JSON.parse(document.getText()); const python = file.state.sections.find(section => section.id === 'python_hst3'); if (python?.code?.includes('sum([7, 8, 9])') !== true || python?.output?.trim() !== 'HST3:24') throw new Error('Host buffer lost Python execution state: ' + JSON.stringify(python)); return { code: python.code, output: python.output, dirty: document.isDirty }; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Python execution Save did not settle'); })()"
    When I execute command "workbench.action.closeAllEditors"
    When I open file "tests/vscode-extension-tester/runs/default/python-execution-application-handler/python-execution.kqlx" in the editor
    When I wait for "#python_hst3" in the webview for 20 seconds
    When I evaluate "(async () => { const section = document.getElementById('python_hst3'); await section.updateComplete; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const state = section.createDocumentState(); const output = section.shadowRoot?.querySelector('.python-output')?.textContent ?? ''; if (state.output === 'HST3:24' && output === 'HST3:24') return { output, code: state.code }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Persisted Python output did not restore'); })()" in the webview for 15 seconds
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "hst3-python-execution"
    Then I collect JSON artifact "hst3-python-execution-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/python-execution-application-handler/python-execution.kqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open HST-3 Python fixture not found'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const python = file.state.sections.find(section => section.id === 'python_hst3'); if (python?.output?.trim() !== 'HST3:24') throw new Error('Durable Python output mismatch: ' + JSON.stringify(python)); return { code: python.code, output: python.output, normalizedOutput: python.output.trim(), dirty: document.isDirty }; })()"

    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/default/python-execution-application-handler/python-execution.kqlx"
