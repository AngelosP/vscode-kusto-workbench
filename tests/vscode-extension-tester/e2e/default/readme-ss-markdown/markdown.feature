@screenshot-generator
# Screenshot generator for .github/skills/readme-screenshots; behavioral coverage lives in non-readme E2Es.
Feature: Capture markdown screenshot
  Scenario: WYSIWYG markdown editor with rich formatting
    Given the extension is in a clean state
    When I move the Dev Host to 2560, -254
    And I resize the Dev Host to 950 by 2200
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.toggleActivityBarVisibility"
    And I wait 1 second
    When I start command "workbench.action.files.openFile"
    And I wait 3 seconds
    And I open the file "C:\Users\angelpe\AppData\Local\Temp\toastui-demo.md"
    And I wait 3 seconds
    And I start command "workbench.action.reopenWithEditor"
    And I wait 2 seconds
    And I select "Kusto Markdown (.md)" from the popup menu
    And I wait 8 seconds
    Then I take a screenshot "01-markdown"
