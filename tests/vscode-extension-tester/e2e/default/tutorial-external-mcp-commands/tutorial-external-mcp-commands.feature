@screenshot-generator
Feature: External tools from Quick Access

  Scenario: Configure from the card, cancel, and reopen without changing integration
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1100 by 1000
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "workbench.view.extension.kustoWorkbench"
    When I wait for "[data-testid='configure-external-tools']" in the webview
    And I evaluate "document.querySelector('[data-testid=quick-access-external-tools]').scrollIntoView({block:'center'}); 'scrolled'" in the webview
    Then I collect JSON artifact "quick-access-layout" from webview expression:
      """
      (() => {
        const card = document.querySelector('[data-testid=quick-access-external-tools]');
        const button = card.querySelector('button');
        const previous = card.previousElementSibling;
        const bounds = card.getBoundingClientRect();
        if (!previous.textContent.includes('Export Agent Skill')) throw new Error('External Tools is not directly below Export Agent Skill');
        if (button.textContent.trim() !== 'Configure...') throw new Error('Configure label mismatch');
        if (bounds.top < 0 || bounds.bottom > innerHeight) throw new Error('External Tools is clipped');
        if (document.documentElement.scrollWidth > innerWidth) throw new Error('Quick Access overflows horizontally');
        return {
          previousTitle: previous.querySelector('.card-title').textContent.trim(),
          title: card.querySelector('.card-title').textContent.trim(),
          viewportWidth: innerWidth,
          viewportHeight: innerHeight,
          card: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
          button: button.textContent.trim()
        };
      })()
      """
    Then I collect JSON artifact "quick-access-commands" from extension host expression:
      """
      (() => {
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const contributions = extension.packageJSON.contributes;
        const toolbar = contributions.menus['view/title'].map(entry => entry.command);
        if (!toolbar.includes('kusto.enableExternalTools')) throw new Error('Configure shortcut missing');
        if (toolbar.includes('kusto.showExternalToolsStatus')) throw new Error('Status shortcut still in Quick Access');
        if (!contributions.commands.some(entry => entry.command === 'kusto.showExternalToolsStatus')) throw new Error('Status command was removed');
        return { toolbar, statusCommandRetained: true };
      })()
      """
    When I click at 20, 500
    Then I take a screenshot "01-external-tools-quick-access"
    When I click "[data-testid='configure-external-tools']" in the webview
    Then I wait for QuickInput title "Configure integration with external tools"
    And the QuickInput should contain item "Copilot CLI"
    And the QuickInput should contain item "Microsoft Scout"
    And the QuickInput should contain item "Other MCP client..."
    Then I take a screenshot "02-external-tools-clients"
    When I press "Escape"
    And I click "[data-testid='configure-external-tools']" in the webview
    Then I wait for QuickInput title "Configure integration with external tools"
    And the QuickInput should contain item "Copilot CLI"
    And the QuickInput should contain item "Microsoft Scout"
    And the QuickInput should contain item "Other MCP client..."
    When I press "Escape"
    And I start command "workbench.action.showCommands"
    Then I wait for QuickInput title "Type the name of a command to run."
    And I type "Kusto Workbench: External tools - Show integration status"
    Then I wait for QuickInput item "Kusto Workbench: External tools - Show integration status"
    When I press "Escape"