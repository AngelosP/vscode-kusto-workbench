Feature: Exported skill includes dashboard rules sidecar

  Background:
    Given the extension is in a clean state
    And I wait 2 seconds

  Scenario: Export Agent Skill writes SKILL.md and html-dashboard-rules.md
    When I start command "kusto.exportSkill"
    Then I wait for QuickInput title "Where"
    When I press "Enter"
    And I wait 1 second

    Then the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\SKILL.md" should exist
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" should exist
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\SKILL.md" should contain "# version: 12"
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\SKILL.md" should contain "./html-dashboard-rules.md"
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\SKILL.md" should contain "# Kusto Workbench Skill"
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" should contain "# Kusto Workbench HTML Dashboard Rules"
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" should contain "## Dashboard Checklist"
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" should contain "KustoWorkbench.renderTable(bindingId)"
    And the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" should contain "## Validation Workflow"

  Scenario: Existing sidecar local edits are not overwritten without consent
    Given a file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\SKILL.md" exists with content "custom-skill-marker"
    Given a file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" exists with content "custom-dashboard-sidecar-marker"

    When I start command "kusto.exportSkill"
    Then I wait for QuickInput title "Where"
    When I press "Enter"
    And I wait 1 second
    And I press "Escape"

    Then the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\SKILL.md" should contain "custom-skill-marker"
    Then the file "${VSCODE_EXT_TEST_WORKSPACE}\.github\skills\kusto-workbench\html-dashboard-rules.md" should contain "custom-dashboard-sidecar-marker"
