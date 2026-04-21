Feature: Capture markdown screenshot
  Scenario: WYSIWYG markdown editor with rich formatting
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 950 by 1440
    And I wait 1 second
    When I start command "workbench.action.files.openFile"
    And I wait 3 seconds
    And I open the file "C:\Users\angelpe\AppData\Local\Temp\toastui-demo.md"
    And I wait 3 seconds
    And I start command "workbench.action.reopenWithEditor"
    And I wait 2 seconds
    And I type "Kusto Markdown"
    And I wait 1 second
    And I press "Enter"
    And I wait 8 seconds
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.toggleActivityBarVisibility"
    And I wait 2 seconds
    Then I take a screenshot "01-markdown"
