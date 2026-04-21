Feature: Capture export-skill screenshot
  Scenario: Activity Bar panel showing Export Agent Skill
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280 by 800
    And I execute command "workbench.view.extension.kustoWorkbench"
    And I wait 3 seconds
    Then I take a screenshot "01-export-skill"
