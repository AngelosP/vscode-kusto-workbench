Feature: Capture import-connections screenshot
  Scenario: Cluster dropdown showing import from XML option
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280 by 800
    And I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 1 second
    And I type " "
    And I press "Ctrl+S"
    And I wait 2 seconds
    When I evaluate "__testOpenDropdown('cluster-dropdown')" in the webview
    And I wait 1 second
    When I evaluate "const dd = __testFind('cluster-dropdown'); dd._focusedIndex = 1; dd.requestUpdate(); 'focused-import'" in the webview
    And I wait 1 second
    Then I take a screenshot "01-dropdown-open"
