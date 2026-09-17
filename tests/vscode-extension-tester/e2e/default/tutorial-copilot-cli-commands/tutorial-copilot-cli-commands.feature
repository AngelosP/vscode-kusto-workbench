@screenshot-generator
Feature: Capture Copilot CLI Command Palette actions

  Scenario: Integrated, external, and disconnect commands
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 520
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I start command "workbench.action.showCommands"
    And I wait 1 second
    When I type "Kusto Workbench: Copilot CLI"
    And I wait 1 second
    Then I take a screenshot "01-copilot-cli-commands"