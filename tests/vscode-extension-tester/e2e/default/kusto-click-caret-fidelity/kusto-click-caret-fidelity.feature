Feature: Kusto editor click caret fidelity

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Clicking a Kusto editor in a mixed Kusto and HTML document keeps the caret on the clicked line
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.kusto.assertClickCaretFidelityWithHtmlSection()" in the webview for 20 seconds
    When I click at 30, 700
    Then I take a screenshot "01-kusto-click-caret-fidelity"

  Scenario: Clicking a restored Kusto editor below an HTML preview keeps the caret on the clicked line
    When I open file "tests/vscode-extension-tester/e2e/default/kusto-click-caret-fidelity/fixtures/restored-html-preview-click.kqlx" in the editor
    And I wait 6 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I wait for "kw-html-section" in the webview for 20 seconds
    And I wait for "kw-query-section" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertClickCaretFidelityAfterRestoredHtmlPreviewScroll()" in the webview for 25 seconds
    When I click at 30, 700
    Then I take a screenshot "02-restored-html-preview-kusto-click-caret-fidelity"

  Scenario: Native clicking and typing in a restored Kusto editor below an HTML preview uses the clicked caret
    When I open file "tests/vscode-extension-tester/e2e/default/kusto-click-caret-fidelity/fixtures/restored-html-preview-click.kqlx" in the editor
    And I wait 6 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I wait for "kw-html-section" in the webview for 20 seconds
    And I wait for "kw-query-section" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.prepareRestoredHtmlPreviewNativeClickTarget()" in the webview for 25 seconds
    And I move the mouse to 193, 650
    And I click
    And I type "NATIVE_TYPED"
    When I evaluate "window.__e2e.kusto.assertRestoredHtmlPreviewNativeTyping('NATIVE_TYPED')" in the webview for 10 seconds
    When I click at 30, 700
    Then I take a screenshot "03-restored-html-preview-native-click-and-typing"
