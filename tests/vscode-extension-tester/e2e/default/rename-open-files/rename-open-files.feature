Feature: Rename open Workbench files

  Background:
    When I execute command "workbench.action.closeAllEditors"
    And I execute command "notifications.clearAll"

  Scenario: Renaming pinned and preview Workbench editors does not leave stale old-name editors
    When I execute command "kustoWorkbench.test.runRenameOpenFilesScenario"
    Then the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should exist
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "pinnedCaseRenameNewVisible:true"
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "pinnedCaseRenameOldAbsent:true"
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "pinnedCaseRenameLive:true"
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "previewRenameNewVisible:true"
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "previewRenameOldAbsent:true"
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "previewRenameLive:true"
    And the file "tests/vscode-extension-tester/runs/default/rename-open-files-result.json" should contain "noDuplicateOldAndNew:true"
