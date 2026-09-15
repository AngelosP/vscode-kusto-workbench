Feature: Transformation immutable artifact ownership

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I wait 2 seconds

  Scenario: Transformation pins, rebinds, publishes lineage, and revokes derived output
    When I execute command "kusto.openQueryEditor"
    And I wait for "body[data-kusto-e2e-ready='true']" in the webview "session.kqlx" for 20 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.transformation.assertArtifactPinRebindAndRevoke()" in the webview for 20 seconds