Feature: Run Function manual checklist

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900
    And I capture the output channel "Kusto Workbench"
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"

  Scenario: Run Function handles comments, cursor targeting, CRLF, parameters, and fences
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 seconds
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.runFunctionManual.setConnected()" in the webview for 10 seconds
    Then I take a screenshot "01-run-function-section-ready"

    When I evaluate "window.__e2e.kusto.runFunctionManual.leadingComments()" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.runFunctionManual.cursorSecondSameLine()" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.runFunctionManual.crlfSecond()" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.runFunctionManual.openParameterizedDialog()" in the webview for 10 seconds
    Then I take a screenshot "02-parameter-dialog-default"
    When I evaluate "window.__e2e.kusto.runFunctionManual.finishParameterizedDialog()" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.runFunctionManual.fencedKql()" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.runFunctionManual.cursorOutsideShowsNoFunction()" in the webview for 10 seconds
    Then I take a screenshot "03-run-function-checklist-finished"