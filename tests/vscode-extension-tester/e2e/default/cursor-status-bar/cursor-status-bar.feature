Feature: Webview editor cursor status bar

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Editable Kusto Workbench sections publish line and column cursor status
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.cursorStatus.createNotebook()" in the webview for 20 seconds
    And I evaluate "window.__e2e.cursorStatus.beginCapture()" in the webview
    And I execute command "workbench.action.focusSideBar"
    When I evaluate "window.__e2e.cursorStatus.hoverKusto(2, 3)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('kusto', 2, 3)" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarVisible('kusto', 2, 3)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.focusKusto(2, 3)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('kusto', 2, 3)" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarVisible('kusto', 2, 3)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.setKustoExpanded(false)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertHidden('kusto')" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarHidden()" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.setKustoExpanded(true)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.focusSql(2, 8)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('sql', 2, 8)" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarVisible('sql', 2, 8)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.focusHtml(2, 4)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('html', 2, 4)" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarVisible('html', 2, 4)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.focusPython(2, 6)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('python', 2, 6)" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarVisible('python', 2, 6)" in the webview for 10 seconds
    Then I take a screenshot "01-cursor-status-editable-sections"
    And I evaluate "window.__e2e.cursorStatus.restoreCapture()" in the webview

  Scenario: Preview modes clear cursor status for non-editable surfaces
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.cursorStatus.createNotebook()" in the webview for 20 seconds
    And I evaluate "window.__e2e.cursorStatus.beginCapture()" in the webview
    When I evaluate "window.__e2e.cursorStatus.focusHtml(2, 4)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('html', 2, 4)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.setHtmlPreview()" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertHidden('html')" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarHidden()" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.focusMarkdown(1, 3)" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertVisible('markdown', 1, 3)" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarVisible('markdown', 1, 3)" in the webview for 10 seconds
    When I evaluate "window.__e2e.cursorStatus.setMarkdownPreview()" in the webview for 10 seconds
    Then I evaluate "window.__e2e.cursorStatus.assertHidden('markdown')" in the webview for 10 seconds
    And I evaluate "window.__e2e.cursorStatus.assertStatusBarHidden()" in the webview for 10 seconds
    Then I take a screenshot "02-cursor-status-preview-clears"
    And I evaluate "window.__e2e.cursorStatus.restoreCapture()" in the webview
