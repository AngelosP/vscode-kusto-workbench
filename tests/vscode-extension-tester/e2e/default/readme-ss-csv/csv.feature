Feature: Capture csv screenshot
  Scenario: URL section loading a GitHub-hosted CSV
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1050 by 700
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.toggleActivityBarVisibility"
    And I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    When I evaluate "const id = addUrlBox({ url: 'https://raw.githubusercontent.com/plotly/datasets/refs/heads/master/data.csv', expanded: true }); const el = document.getElementById(id); if (el) el._requestFetch(); id" in the webview
    And I wait 8 seconds
    When I evaluate "const boxes = document.querySelectorAll('kw-query-section'); boxes.forEach(b => b.remove()); 'removed query sections'" in the webview
    And I wait 1 second
    And I press "Ctrl+S"
    And I wait 2 seconds
    Then I take a screenshot "01-csv-loaded"
