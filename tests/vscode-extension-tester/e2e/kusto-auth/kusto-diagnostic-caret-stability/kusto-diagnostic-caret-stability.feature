Feature: Kusto diagnostics remain visible during caret movement

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 800
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Syntax and unresolved-expression diagnostics survive left and right arrow movement
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
    And I wait 5 seconds

    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertEditorMapped()" in the webview
    When I evaluate "window.__e2e.kusto.waitForCompletionTargets(25000)" in the webview for 28 seconds
    When I evaluate "(() => { window.__e2eDiagnosticCaretWaitForVisible = async (expectedText, expectedMessage, label) => { let lastError = null; for (let attempt = 0; attempt < 40; attempt++) { try { return label + ': ' + window.__e2e.kusto.assertDiagnosticVisible(expectedText, expectedMessage); } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 100)); } } throw lastError || new Error('Timed out waiting for visible diagnostic over ' + expectedText + ' for ' + label); }; window.__e2eDiagnosticCaretFocusAt = (lineNumber, column) => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('Missing query section'); const editor = window.queryEditors[el.boxId]; if (!editor) throw new Error('Missing query editor'); editor.focus(); editor.setPosition({ lineNumber, column }); return 'focused caret at ' + lineNumber + ':' + column; }; window.__e2eDiagnosticCaretPosition = () => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('Missing query section'); const editor = window.queryEditors[el.boxId]; if (!editor) throw new Error('Missing query editor'); const pos = editor.getPosition(); return { lineNumber: pos.lineNumber, column: pos.column }; }; window.__e2eDiagnosticCaretSimulateKustoDecorationRefresh = () => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('Missing query section'); const editor = window.queryEditors[el.boxId]; if (!editor) throw new Error('Missing query editor'); const model = editor.getModel(); const currentMarkers = monaco.editor.getModelMarkers({ owner: 'kusto', resource: model.uri }); if (!currentMarkers.length) throw new Error('No current Kusto markers to replay'); const oldDecorations = model.getAllDecorations().filter(d => d.options && d.options.className === 'squiggly-error').map(d => d.id); if (!oldDecorations.length) throw new Error('No current squiggly-error decorations to clear'); model.deltaDecorations(oldDecorations, []); const markerData = currentMarkers.map(({ owner, resource, ...marker }) => marker); monaco.editor.setModelMarkers(model, 'kusto', markerData); return 'replayed ' + markerData.length + ' markers after clearing ' + oldDecorations.length + ' squiggly decorations'; }; return 'diagnostic visibility helpers installed'; })()" in the webview

    When I evaluate "(() => { const line = '| project columnA, columnB*'; const query = `print columnA=1, columnB=2\n${line}`; const fixedQuery = 'print columnA=1, columnB=2\n| project columnA, columnB'; window.__e2eDiagnosticCaretRepro = { line, query, fixedQuery, cursorColumn: line.length + 1 }; window.__e2e.kusto.setQuery(query); window.__e2eDiagnosticCaretFocusAt(2, line.length + 1); return 'query=' + query; })()" in the webview
    When I evaluate "window.__e2eDiagnosticCaretWaitForVisible('*', 'Missing expression', 'trailing star before caret movement')" in the webview for 6 seconds
    Then I take a screenshot "01-trailing-star-marker-visible"

    When I evaluate "window.__e2eDiagnosticCaretFocusAt(2, window.__e2eDiagnosticCaretRepro.cursorColumn)" in the webview
    When I press "Left"
    When I press "Left"
    When I press "Left"
    When I press "Left"
    When I press "Left"
    When I press "Left"
    When I press "Left"
    When I press "Left"
    And I wait 1 second
    When I evaluate "(() => { const pos = window.__e2eDiagnosticCaretPosition(); if (pos.lineNumber !== 2 || pos.column >= window.__e2eDiagnosticCaretRepro.cursorColumn) throw new Error('Native Left keypresses did not move the Monaco caret left: ' + JSON.stringify({ pos, cursorColumn: window.__e2eDiagnosticCaretRepro.cursorColumn })); window.__e2eDiagnosticCaretLeftColumn = pos.column; return 'caret after left keypresses: ' + pos.lineNumber + ':' + pos.column; })()" in the webview
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    And I wait 2 seconds
    When I evaluate "(() => { const pos = window.__e2eDiagnosticCaretPosition(); if (pos.lineNumber !== 2 || pos.column <= window.__e2eDiagnosticCaretLeftColumn) throw new Error('Native Right keypresses did not move the Monaco caret right: ' + JSON.stringify({ pos, leftColumn: window.__e2eDiagnosticCaretLeftColumn })); return 'caret after right keypresses: ' + pos.lineNumber + ':' + pos.column; })()" in the webview
    When I evaluate "window.__e2eDiagnosticCaretWaitForVisible('*', 'Missing expression', 'trailing star after native arrow movement')" in the webview for 6 seconds
    Then I take a screenshot "02-trailing-star-marker-survives-arrow-movement"

    When I evaluate "(() => { const line = '| project EventCount, EventName, 2o3'; const query = `print EventCount=1, EventName='x'\n${line}`; const fixedQuery = `print EventCount=1, EventName='x'\n| project EventCount, EventName`; window.__e2eDiagnosticCaretRepro = { line, query, fixedQuery, cursorColumn: line.length + 1 }; window.__e2e.kusto.setQuery(query); window.__e2eDiagnosticCaretFocusAt(2, line.length + 1); return 'query=' + query; })()" in the webview
    When I evaluate "window.__e2eDiagnosticCaretWaitForVisible('2o3', 'does not refer', '2o3 before caret movement')" in the webview for 6 seconds
    Then I take a screenshot "03-unresolved-expression-marker-visible"

    When I evaluate "window.__e2eDiagnosticCaretFocusAt(2, window.__e2eDiagnosticCaretRepro.cursorColumn)" in the webview
    When I press "Left"
    When I press "Left"
    When I press "Left"
    When I press "Left"
    And I wait 1 second
    When I evaluate "(() => { const pos = window.__e2eDiagnosticCaretPosition(); if (pos.lineNumber !== 2 || pos.column >= window.__e2eDiagnosticCaretRepro.cursorColumn) throw new Error('Native Left keypresses did not move the Monaco caret left for 2o3: ' + JSON.stringify({ pos, cursorColumn: window.__e2eDiagnosticCaretRepro.cursorColumn })); window.__e2eDiagnosticCaretLeftColumn = pos.column; return 'caret after 2o3 left keypresses: ' + pos.lineNumber + ':' + pos.column; })()" in the webview
    When I press "Right"
    When I press "Right"
    When I press "Right"
    When I press "Right"
    And I wait 2 seconds
    When I evaluate "(() => { const pos = window.__e2eDiagnosticCaretPosition(); if (pos.lineNumber !== 2 || pos.column <= window.__e2eDiagnosticCaretLeftColumn) throw new Error('Native Right keypresses did not move the Monaco caret right for 2o3: ' + JSON.stringify({ pos, leftColumn: window.__e2eDiagnosticCaretLeftColumn })); return 'caret after 2o3 right keypresses: ' + pos.lineNumber + ':' + pos.column; })()" in the webview
    When I evaluate "window.__e2eDiagnosticCaretWaitForVisible('2o3', 'does not refer', '2o3 after native arrow movement')" in the webview for 6 seconds
    Then I take a screenshot "04-unresolved-expression-marker-survives-arrow-movement"

    When I evaluate "(() => { const result = window.__e2eDiagnosticCaretSimulateKustoDecorationRefresh(); return result + '; ' + window.__e2e.kusto.assertDiagnosticVisible('2o3', 'does not refer'); })()" in the webview
    Then I take a screenshot "05-unresolved-expression-marker-survives-decoration-refresh"

    When I evaluate "(() => { window.__e2e.kusto.setQuery(window.__e2eDiagnosticCaretRepro.fixedQuery); return 'removed unresolved expression'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.kusto.assertMarkers('none', 'kusto', 'error')" in the webview
    Then I take a screenshot "06-marker-clears-after-fix"