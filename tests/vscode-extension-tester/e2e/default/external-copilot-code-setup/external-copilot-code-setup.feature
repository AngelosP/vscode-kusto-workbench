Feature: Configure Microsoft Copilot Code independently of other external clients

  Scenario: Select Code, install and verify a scoped plugin, reconfigure, then remove it
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 700
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "isolated-code-target" from extension host expression:
      """
      (async () => {
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const require = process.getBuiltinModule('node:module').createRequire(extension.extensionUri.fsPath + '/package.json');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const Module = require('node:module');
        const childProcess = require('node:child_process');
        const actualRuntime = process.env.KUSTO_WORKBENCH_COPILOT_CODE_RUNTIME;
        if (!actualRuntime || !fs.existsSync(actualRuntime)) throw new Error('Set KUSTO_WORKBENCH_COPILOT_CODE_RUNTIME to the installed Code backend for this opt-in test');
        await extension.activate();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-copilot-code-e2e-'));
        const local = path.join(root, 'local');
        const userData = path.join(local, 'Microsoft', 'Copilot', 'User Data');
        const runtimeVersion = path.basename(path.dirname(actualRuntime));
        const runtime = path.join(userData, 'CopilotCodeTabRuntime', runtimeVersion);
        const manifestBytes = fs.readFileSync(path.join(path.dirname(actualRuntime), 'manifest.json'));
        const accountId = 'a'.repeat(32);
        const codeHome = path.join(userData, 'CopilotCodingHome', accountId);
        const otherCodeHome = path.join(userData, 'CopilotCodingHome', 'b'.repeat(32));
        const otherAccountConfiguration = JSON.stringify({ custom: 'unselected-account-sentinel' });
        fs.mkdirSync(runtime, { recursive: true });
        fs.mkdirSync(codeHome, { recursive: true });
        fs.mkdirSync(otherCodeHome, { recursive: true });
        fs.writeFileSync(path.join(otherCodeHome, 'config.json'), otherAccountConfiguration);
        fs.writeFileSync(path.join(runtime, 'manifest.json'), manifestBytes);
        fs.writeFileSync(path.join(runtime, 'copilot.exe'), 'prepared runtime boundary');
        fs.writeFileSync(path.join(runtime, 'github_copilot.dll'), 'prepared runtime boundary');
        const connectorRoot = path.join(local, 'KustoWorkbench', 'McpConnector');
        const connector = { root: connectorRoot, command: path.join(connectorRoot, 'node.exe'), args: [path.join(connectorRoot, 'bootstrap.cjs')], connectorVersion: extension.packageJSON.version, schemaHash: 'fixture', launchTargetChanged: false };
        const previousLocalAppData = process.env.LOCALAPPDATA;
        const previousEnabled = vscode.workspace.getConfiguration('kustoWorkbench').inspect('externalTools.enabled')?.globalValue;
        const setupPath = path.join(extension.extensionUri.fsPath, 'dist', 'external-mcp-setup.js');
        const loaded = new Module(setupPath);
        loaded.filename = setupPath;
        loaded.paths = Module._nodeModulePaths(extension.extensionUri.fsPath);
        loaded.require = id => {
          if (id === 'vscode') return {
            Uri: vscode.Uri, UIKind: vscode.UIKind, ProgressLocation: vscode.ProgressLocation,
            ConfigurationTarget: vscode.ConfigurationTarget, CancellationError: vscode.CancellationError,
            workspace: vscode.workspace, env: vscode.env,
            window: {
              showQuickPick: vscode.window.showQuickPick, showInputBox: vscode.window.showInputBox,
              showWarningMessage: vscode.window.showWarningMessage, showInformationMessage: vscode.window.showInformationMessage,
              withProgress: (options, action) => options.title === 'Installing Kusto Workbench MCP connector and verified runtime...' ? Promise.resolve(connector) : vscode.window.withProgress(options, action)
            }
          };
          if (id === 'node:child_process') return { ...childProcess, execFile: (file, args, options, callback) => {
            const aclHelper = path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
            if (file === aclHelper && options.env.KUSTO_WORKBENCH_SECURE_DIRECTORY === path.join(local, 'KustoWorkbench')) return childProcess.execFile(file, args, options, callback);
            if (file !== path.join(runtime, 'copilot.exe') || options.env.COPILOT_HOME !== codeHome || options.cwd !== codeHome) throw new Error('Code command escaped the isolated account');
            return childProcess.execFile(actualRuntime, args, options, callback);
          } };
          return require(id);
        };
        loaded._compile(fs.readFileSync(setupPath, 'utf8'), setupPath);
        const fixture = { root, codeHome, otherCodeHome, otherAccountConfiguration, local, connector, actualRuntime, previousEnabled, result: null, failure: null, registrations: [] };
        const scope = async action => {
          process.env.LOCALAPPDATA = local;
          try { return await action(); }
          catch (error) { fixture.failure = error.message; throw error; }
          finally { if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocalAppData; }
        };
        fixture.registrations.push(vscode.commands.registerCommand('kw.e2e.configureCode', () => scope(async () => {
          fixture.result = await loaded.exports.runExternalMcpSetup({ extensionUri: extension.extensionUri, extension }, { info() {}, warn() {}, error() {} });
        })));
        fixture.registrations.push(vscode.commands.registerCommand('kw.e2e.removeCode', () => scope(async () => {
          await loaded.exports.disableExternalMcpIntegration(); fixture.removed = true;
        })));
        globalThis.__codeSetupFixture = fixture;
        return { isolatedCodeHome: codeHome, preparedConnector: true, actualBackendCommands: true, runtimeVersion, manifestPrefixHex: manifestBytes.subarray(0, 3).toString('hex') };
      })()
      """
    When I start command "kw.e2e.configureCode"
    Then I wait for QuickInput title "Configure integration with external tools"
    When I select QuickInput item "Microsoft Copilot (Code)"
    And I wait 1 second
    And I click "Continue" on the "Visual Studio Code" dialog
    Then I wait for QuickInput title "VS Code profile for Kusto Workbench external tools"
    When I select QuickInput item "Default Profile"
    Then I wait for QuickInput title "Microsoft Copilot Code account"
    And the QuickInput should contain item "Code account bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    When I select QuickInput item "Code account aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then I collect JSON artifact "code-plugin-installed" from extension host expression:
      """
      (async () => {
        const require = process.getBuiltinModule('node:module').createRequire(vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench').extensionUri.fsPath + '/package.json');
        const fs = require('node:fs'); const path = require('node:path'); const childProcess = require('node:child_process');
        const fixture = globalThis.__codeSetupFixture;
        const deadline = Date.now() + 30000;
        while (!fixture.result && !fixture.failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (fixture.failure) throw new Error(fixture.failure);
        if (fixture.result?.client !== 'copilot-code' || fixture.result?.fullyConfigured !== true) throw new Error('Copilot Code setup did not complete');
        const invoke = args => JSON.parse(childProcess.execFileSync(fixture.actualRuntime, ['--no-auto-update', ...args], { cwd: fixture.codeHome, encoding: 'utf8', windowsHide: true, env: { ...process.env, COPILOT_HOME: fixture.codeHome, COPILOT_AUTO_UPDATE: 'false' } }));
        const server = invoke(['mcp','list','--json']).mcpServers['kusto-workbench'];
        const skill = invoke(['skill','list','--json']).find(entry => entry.name === 'kusto-workbench');
        if (server?.source !== 'plugin' || server.command !== fixture.connector.command || JSON.stringify(server.args) !== JSON.stringify(fixture.connector.args) || server.enabled !== true) throw new Error('Code MCP component not verified');
        if (skill?.source !== 'plugin' || skill.enabled !== true || !skill.path.startsWith(fixture.codeHome)) throw new Error('Code skill not verified');
        if (fs.readFileSync(path.join(fixture.otherCodeHome, 'config.json'), 'utf8') !== fixture.otherAccountConfiguration || fs.readdirSync(fixture.otherCodeHome).join() !== 'config.json') throw new Error('Unselected Code account changed during setup');
        fixture.receiptPath = path.join(fixture.local, 'KustoWorkbench', 'CopilotCode', 'a'.repeat(32), 'receipt.json');
        fixture.receipt = fs.readFileSync(fixture.receiptPath, 'utf8');
        fixture.result = null;
        return { pluginMcpVerified: true, pluginSkillVerified: true, isolatedAccount: true, unselectedAccountUnchanged: true };
      })()
      """
    When I click at 20, 500
    Then I take a screenshot "copilot-code-configured"
    When I start command "kw.e2e.configureCode"
    Then I wait for QuickInput title "Configure integration with external tools"
    When I select QuickInput item "Microsoft Copilot (Code)"
    And I wait 1 second
    And I click "Continue" on the "Visual Studio Code" dialog
    Then I wait for QuickInput title "VS Code profile for Kusto Workbench external tools"
    When I select QuickInput item "Default Profile"
    Then I wait for QuickInput title "Microsoft Copilot Code account"
    When I select QuickInput item "Code account aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then I collect JSON artifact "code-plugin-idempotent" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs'); const fixture = globalThis.__codeSetupFixture;
        const deadline = Date.now() + 30000;
        while (!fixture.result && !fixture.failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (fixture.failure) throw new Error(fixture.failure);
        if (fixture.result?.fullyConfigured !== true || fixture.result.requiresClientReload !== false || fs.readFileSync(fixture.receiptPath, 'utf8') !== fixture.receipt) throw new Error('Code reconfiguration changed an exact installation');
        return { requiresClientReload: false, receiptUnchanged: true };
      })()
      """
    When I start command "kw.e2e.removeCode"
    Then I wait for QuickInput title "Disable integration with external tools"
    When I select QuickInput item "Remove Microsoft Copilot (Code) managed plugin"
    Then I wait for QuickInput title "Microsoft Copilot Code account"
    When I select QuickInput item "Code account aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    Then I collect JSON artifact "code-plugin-removed" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs'); const childProcess = process.getBuiltinModule('node:child_process'); const path = process.getBuiltinModule('node:path');
        const fixture = globalThis.__codeSetupFixture; const deadline = Date.now() + 30000;
        while (!fixture.removed && !fixture.failure && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (fixture.failure) throw new Error(fixture.failure);
        if (!fixture.removed || fs.existsSync(fixture.receiptPath)) throw new Error('Code plugin ownership was not removed');
        const servers = JSON.parse(childProcess.execFileSync(fixture.actualRuntime, ['--no-auto-update','mcp','list','--json'], { cwd: fixture.codeHome, encoding: 'utf8', windowsHide: true, env: { ...process.env, COPILOT_HOME: fixture.codeHome, COPILOT_AUTO_UPDATE: 'false' } }));
        if (servers.mcpServers['kusto-workbench']) throw new Error('Code still exposes the Workbench MCP server');
        if (fs.readFileSync(path.join(fixture.otherCodeHome, 'config.json'), 'utf8') !== fixture.otherAccountConfiguration || fs.readdirSync(fixture.otherCodeHome).join() !== 'config.json') throw new Error('Unselected Code account changed during reconfiguration or removal');
        await vscode.workspace.getConfiguration('kustoWorkbench').update('externalTools.enabled', fixture.previousEnabled, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('kusto.stopExternalMcpProvider');
        for (const registration of fixture.registrations) registration.dispose();
        fs.rmSync(fixture.root, { recursive: true, force: true }); delete globalThis.__codeSetupFixture;
        return { managedPluginRemoved: true, unselectedAccountUnchanged: true, isolatedFixtureRemoved: true };
      })()
      """