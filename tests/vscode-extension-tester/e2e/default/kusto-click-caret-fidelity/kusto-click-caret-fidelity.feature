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
    Given a file "tests/vscode-extension-tester/runs/default/kusto-click-caret-fidelity/native-typing.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"html_click_fidelity_restored","type":"html","name":"Restored Tall HTML Preview","code":"<!doctype html><html><body><main style='height:1500px'>Native caret fixture</main></body></html>","mode":"preview","expanded":true,"previewHeightPx":1655,"previewHeightUserSet":true},{"id":"query_click_fidelity_restored","type":"query","name":"Restored Kusto Click Target","query":"print restored_row_01 = 1\nprint restored_row_02 = 2\nprint restored_row_03 = 3\nprint restored_row_04 = 4\nprint restored_row_05 = 5\nprint restored_row_06 = 6\nprint restored_row_07 = 7\nprint restored_row_08 = 8\nprint restored_row_09 = 9\nprint restored_row_10 = 10\nprint restored_row_11 = 11\nprint restored_row_12 = 12\nprint restored_row_13 = 13\nprint restored_row_14 = 14\nprint restored_row_15 = 15\nprint restored_row_16 = 16\nprint restored_row_17 = 17\nprint restored_row_18 = 18\nprint restored_row_19 = 19\nprint restored_row_20 = 20","expanded":true,"editorHeightPx":260,"resultsVisible":false}],"caretDocsEnabled":true,"autoTriggerAutocompleteEnabled":false}}
      """
    When I open file "tests/vscode-extension-tester/runs/default/kusto-click-caret-fidelity/native-typing.kqlx" in the editor
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
    When I execute command "workbench.action.revertAndCloseActiveEditor"
    When I delete file "tests/vscode-extension-tester/runs/default/kusto-click-caret-fidelity/native-typing.kqlx"
