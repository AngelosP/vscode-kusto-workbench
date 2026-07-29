Feature: Exact clipboard share result artifacts

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Share pins A, reopens on B, and denies or revokes unavailable rows
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.share.assertArtifactClipboard()" in the webview for 20 seconds
    When I execute command "workbench.action.closeAllEditors"
