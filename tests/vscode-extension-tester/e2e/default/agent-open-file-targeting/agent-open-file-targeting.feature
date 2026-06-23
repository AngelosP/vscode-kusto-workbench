Feature: Agent open file targeting

  Background:
    When I execute command "kusto.openQueryEditor"
    And I wait 2 seconds
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Extension host verifies explicit non-active Workbench targeting
    When I execute command "kustoWorkbench.test.runOpenFileTargetingScenario"
    Then the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-result.json" should exist
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-result.json" should contain "explicitTargetUpdatedNonActive:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-result.json" should contain "activeFilePreserved:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-result.json" should contain "openFilesIncludedBoth:true"

  Scenario: Real custom editors target a non-active file and persist only that file
    When I execute command "kustoWorkbench.test.runOpenFileTargetingScenario" with args '["real-editors"]'
    Then the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should exist
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "realEditorsOpened:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "nonActiveOpenFileIdTargeted:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "activeFileMemoryUnchanged:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "activeFileDiskUnchanged:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "targetFileDiskChanged:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "duplicateSectionIdsVerified:true"

  Scenario: Real custom editor cleanup handles dirty documents after forced failure
    When I execute command "kustoWorkbench.test.runOpenFileTargetingScenario" with args '["real-editors-forced-failure"]'
    Then the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should exist
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "forcedFailureTriggered:true"
    And the file "tests/vscode-extension-tester/runs/default/agent-open-file-targeting-real-result.json" should contain "cleanupNoLiveEditors:true"