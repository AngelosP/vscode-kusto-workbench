Feature: Tutorial viewer

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Open tutorials without a reachable GitHub catalog
    When I execute command "kusto.openTutorials"
    When I wait for "kw-tutorial-viewer" in the webview for 25 seconds
    And I evaluate "(() => { const viewer = document.querySelector('kw-tutorial-viewer'); const root = viewer.shadowRoot; const waitFor = async () => { for (let attempt = 0; attempt < 120; attempt++) { await viewer.updateComplete; const text = root.textContent || ''; if (text.includes('requires a connection to the GitHub repo') && root.querySelector('[data-testid=tutorial-viewer-mode-unavailable]')) return text; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('connection-required tutorial state did not render'); }; return waitFor().then(text => { if (root.querySelector('[data-testid=tutorial-item]')) throw new Error('tutorial items should not render without remote catalog or cache'); if (root.querySelector('[data-testid=tutorial-category-row]')) throw new Error('category rows should not render without remote catalog or cache'); return text; }); })()" in the webview
    Then I take a screenshot "01-tutorial-viewer-unavailable"
