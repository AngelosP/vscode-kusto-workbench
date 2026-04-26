@screenshot-generator
# Screenshot generator for .github/skills/readme-screenshots; behavioral coverage lives in non-readme E2Es.
Feature: Capture activity-bar screenshot
  Scenario: Activity Bar with Kusto Workbench panel open
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280 by 800
    And I execute command "workbench.view.extension.kustoWorkbench"
    And I wait 3 seconds
    Then I take a screenshot "01-activity-bar"
