Feature: Native external-tools integration walkthrough

  Scenario: Follow the README entry command, read client steps, cancel setup, and reopen
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 700
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "integration-before-reading" from extension host expression:
      """
      (() => {
        const enabled = vscode.workspace.getConfiguration('kustoWorkbench').get('externalTools.enabled', false);
        if (enabled) throw new Error('Use an isolated profile with external integration disabled for this test');
        return { enabled };
      })()
      """
    Then I collect JSON artifact "walkthrough-package-installed" from extension host expression:
      """
      (async () => {
        const packagePath = process.env.KUSTO_WORKBENCH_WALKTHROUGH_VSIX;
        if (!packagePath) throw new Error('Build the current VSIX and set KUSTO_WORKBENCH_WALKTHROUGH_VSIX before this opt-in test');
        const packageUri = vscode.Uri.file(packagePath);
        await vscode.workspace.fs.stat(packageUri);
        await vscode.workspace.getConfiguration('workbench').update('welcomePage.walkthroughs.openOnInstall', false, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('workbench.extensions.installExtension', packageUri);
        return { installedInIsolatedHost: true, packagePath };
      })()
      """
    When I execute command "extension.open" with args '["angelos-petropoulos.vscode-kusto-workbench"]'
    Then I wait for "h1" in the webview
    And the webview should contain "Kusto Workbench: External tools - Open walkthrough"
    When I start command "workbench.action.showCommands"
    Then I wait for QuickInput title "Type the name of a command to run."
    When I type "Kusto Workbench: External tools - Open walkthrough"
    Then I wait for QuickInput item "Kusto Workbench: External tools - Open walkthrough"
    When I press "Enter"
    Then the webview should contain "Connect an external agent to Workbench"
    And the webview should contain "Leave No Trace"
    Then I collect JSON artifact "setup-image-loaded" from webview expression:
      """
      (async () => {
        const image = document.querySelector('img[alt="External client selection"]');
        if (!image) throw new Error('The setup screenshot is missing');
        await image.decode();
        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) throw new Error('The setup screenshot did not load');
        return { title: document.querySelector('h1').textContent, screenshotWidth: image.naturalWidth, screenshotHeight: image.naturalHeight };
      })()
      """
    When I click at 20, 500
    Then I take a screenshot "01-native-walkthrough-setup"
    When I click the element "Copilot CLI: use the Workbench agent"
    Then the webview should contain "Copilot CLI"
    And the webview should contain "/agent"
    When I click the element "Vera: add Workbench without switching agents"
    Then the webview should contain "Keep Vera and add Workbench tools"
    And the webview should contain "Do not run /agent kusto-workbench"
    When I click the element "Microsoft Scout: register MCP and a skill"
    Then the webview should contain "Microsoft Scout"
    And the webview should contain "Fully quit Scout"
    When I click the element "Microsoft Copilot: start a Local Code session"
    Then the webview should contain "Microsoft Copilot: Local Code sessions"
    And the webview should contain "may not appear in Code > Customize"
    When I click at 20, 500
    Then I take a screenshot "02-native-walkthrough-local-code"
    When I click the element "Other clients: use local STDIO configuration"
    Then the webview should contain "Other local MCP clients"
    And the webview should contain "cloud-only client"
    When I click the element "Verify, troubleshoot, and remove integration"
    Then the webview should contain "Verify before building a report"
    And the webview should contain "do not replay it blindly"
    When I click the element "Prepare VS Code and configure the connector"
    Then the webview should contain "Connect an external agent to Workbench"
    When I click the element "Configure external tools"
    Then I wait for QuickInput title "Configure integration with external tools"
    And the QuickInput should contain item "Copilot CLI"
    And the QuickInput should contain item "Microsoft Scout"
    And the QuickInput should contain item "Microsoft Copilot (Code)"
    And the QuickInput should contain item "Other MCP client..."
    When I press "Escape"
    And I start command "workbench.action.showCommands"
    Then I wait for QuickInput title "Type the name of a command to run."
    When I type "Kusto Workbench: External tools - Open walkthrough"
    Then I wait for QuickInput item "Kusto Workbench: External tools - Open walkthrough"
    When I press "Enter"
    Then the webview should contain "Connect an external agent to Workbench"
    Then I collect JSON artifact "reading-and-cancellation-are-read-only" from extension host expression:
      """
      (() => {
        const enabled = vscode.workspace.getConfiguration('kustoWorkbench').get('externalTools.enabled', false);
        if (enabled) throw new Error('Reading the walkthrough or cancelling the picker enabled integration');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const walkthrough = extension.packageJSON.contributes.walkthroughs.find(item => item.id === 'kustoWorkbench.externalTools');
        if (walkthrough.steps.length !== 7) throw new Error('Native walkthrough step count changed');
        return { enabled, nativeWalkthroughId: walkthrough.id, renderedClientSteps: 5, totalSteps: walkthrough.steps.length };
      })()
      """