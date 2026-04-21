Feature: Capture settings screenshot
  Scenario: VS Code settings showing Kusto Workbench settings
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280 by 800
    And I execute command "workbench.action.openSettings"
    And I wait 2 seconds
    And I type "kustoWorkbench"
    And I wait 2 seconds
    Then I take a screenshot "01-settings"
