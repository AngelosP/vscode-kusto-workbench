Feature: Kusto Workbench Smoke Test
  Verify the Kusto Workbench extension activates and is responsive

  # Available commands (add your own scenarios below):
#   kusto.openQueryEditor - Open Query Editor
#   kusto.openKqlxFile - Open .kqlx File
#   kusto.openMdxFile - Open .mdx File
#   kusto.saveKqlxAs - Save Session As... (.kqlx)
#   kusto.manageConnections - Manage Connections
#   kusto.deleteAllConnections - Delete All Connections
#   kusto.seeCachedValues - Show Cached Values
#   kusto.resetCopilotModelSelection - Reset Copilot Model Selection
#   kusto.openRemoteFile - Open Remote File
#   kusto.openWalkthroughs - Open Walkthroughs...
#   kusto.openCustomAgent - Open Kusto Workbench Custom Agent
#   kusto.showDevelopmentNotes - Show Development Notes
#   kusto.exportSkill - Export Agent Skill...

  Scenario: Extension activates
    # This just verifies the extension host is up and the controller responds
    Then I wait 2 seconds

  Scenario: Activity bar view opens
    When I execute command "workbench.view.extension.kustoWorkbench"
    Then I wait 1 second
