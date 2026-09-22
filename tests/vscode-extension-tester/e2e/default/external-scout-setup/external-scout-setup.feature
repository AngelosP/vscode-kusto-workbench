Feature: Automatically configure Scout MCP registration and skill

  Scenario: Real setup controls install, recheck, and selectively remove isolated Scout integration
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 700
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "isolated-scout-setup" from extension host expression:
      """
      (async () => {
        const require = process.getBuiltinModule('node:module').createRequire(vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench').extensionUri.fsPath + '/package.json');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const Module = require('node:module');
        const childProcess = require('node:child_process');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        await extension.activate();
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-scout-setup-e2e-'));
        const home = path.join(root, 'home');
        const local = path.join(root, 'local');
        const connectorRoot = path.join(local, 'KustoWorkbench', 'McpConnector');
        const configPath = path.join(home, '.scout', 'm-mcp-servers.json');
        const skillPath = path.join(home, '.copilot', 'skills', 'kusto-workbench', 'SKILL.md');
        const receiptPath = path.join(local, 'KustoWorkbench', 'ScoutIntegration', 'registration.json');
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        const unrelated = { builtin: true, tools: ['keep_this_tool'] };
        fs.writeFileSync(configPath, JSON.stringify({ servers: { unrelated }, future: 'preserve' }));
        const previousLocalAppData = process.env.LOCALAPPDATA;
        const previousEnabled = vscode.workspace.getConfiguration('kustoWorkbench').inspect('externalTools.enabled')?.globalValue;
        const connector = { root: connectorRoot, command: path.join(connectorRoot, 'node.exe'), args: [path.join(connectorRoot, 'bootstrap.cjs')], connectorVersion: extension.packageJSON.version, schemaHash: 'fixture', launchTargetChanged: false };
        const filename = path.join(extension.extensionUri.fsPath, 'dist', 'external-mcp-setup.js');
        const loaded = new Module(filename);
        loaded.filename = filename;
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
          if (id === 'node:os') return { ...os, homedir: () => home };
          if (id === 'node:child_process') return { ...childProcess, execFile: (file, args, options, callback) => {
            if (args.includes('@(Get-Process -Name scout -ErrorAction SilentlyContinue).Count')) { callback(null, '0', ''); return {}; }
            return childProcess.execFile(file, args, options, callback);
          } };
          return require(id);
        };
        loaded._compile(fs.readFileSync(filename, 'utf8'), filename);
        const fixture = { root, configPath, skillPath, receiptPath, connector, unrelated, setup: loaded.exports, previousLocalAppData, previousEnabled, result: null, registrations: [] };
        fixture.registrations.push(vscode.commands.registerCommand('kw.e2e.configureScout', async () => {
          process.env.LOCALAPPDATA = local;
          try { fixture.result = await loaded.exports.runExternalMcpSetup({ extensionUri: extension.extensionUri, extension }, { info() {}, warn() {}, error() {} }); }
          finally { if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocalAppData; }
          return fixture.result;
        }));
        fixture.registrations.push(vscode.commands.registerCommand('kw.e2e.removeScout', async () => {
          process.env.LOCALAPPDATA = local;
          try { await loaded.exports.disableExternalMcpIntegration(); }
          finally { if (previousLocalAppData === undefined) delete process.env.LOCALAPPDATA; else process.env.LOCALAPPDATA = previousLocalAppData; }
        }));
        globalThis.__scoutSetupFixture = fixture;
        return { isolated: true, configPath, skillPath, installationBoundary: 'prepared connector', runningClientBoundary: 'isolated Scout closed' };
      })()
      """
    When I start command "kw.e2e.configureScout"
    Then I wait for QuickInput title "Configure integration with external tools"
    When I select QuickInput item "Microsoft Scout"
    And I wait 1 second
    And I click "Continue" on the "Visual Studio Code" dialog
    Then I wait for QuickInput title "VS Code profile for Kusto Workbench external tools"
    When I select QuickInput item "Default Profile"
    Then I collect JSON artifact "scout-registration-and-skill" from extension host expression:
      """
      (async () => {
        const require = process.getBuiltinModule('node:module').createRequire(vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench').extensionUri.fsPath + '/package.json');
        const fs = require('node:fs');
        const fixture = globalThis.__scoutSetupFixture;
        const deadline = Date.now() + 10000;
        while (!fixture.result && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (fixture.result?.fullyConfigured !== true || fixture.result?.client !== 'scout' || fixture.result?.requiresManualClientSetup === true) throw new Error('Scout setup did not finish automatically');
        const registry = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
        const server = registry.servers.kusto_workbench;
        if (server?.builtin !== false || server.config.type !== 'command' || server.config.command !== fixture.connector.command || JSON.stringify(server.config.args) !== JSON.stringify(fixture.connector.args)) throw new Error('Wrong Scout MCP registration');
        if (JSON.stringify(registry.servers.unrelated) !== JSON.stringify(fixture.unrelated) || registry.future !== 'preserve') throw new Error('Unrelated Scout settings changed');
        if (!fs.readFileSync(fixture.skillPath, 'utf8').includes('# Kusto Workbench Skill')) throw new Error('Scout skill missing');
        if (!fs.existsSync(fixture.receiptPath)) throw new Error('Owned registration receipt missing');
        fixture.originalRegistry = fs.readFileSync(fixture.configPath, 'utf8');
        fixture.originalSkill = fs.readFileSync(fixture.skillPath, 'utf8');
        fixture.result = null;
        return { registered: true, skillInstalled: true, unrelatedPreserved: true, noManualServerForm: true };
      })()
      """
    When I click at 20, 500
    Then I take a screenshot "scout-automatically-configured"
    When I start command "kw.e2e.configureScout"
    Then I wait for QuickInput title "Configure integration with external tools"
    When I select QuickInput item "Microsoft Scout"
    And I wait 1 second
    And I click "Continue" on the "Visual Studio Code" dialog
    Then I wait for QuickInput title "VS Code profile for Kusto Workbench external tools"
    When I select QuickInput item "Default Profile"
    Then I collect JSON artifact "scout-idempotent-reconfigure" from extension host expression:
      """
      (async () => {
        const require = process.getBuiltinModule('node:module').createRequire(vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench').extensionUri.fsPath + '/package.json');
        const fs = require('node:fs');
        const fixture = globalThis.__scoutSetupFixture;
        const deadline = Date.now() + 10000;
        while (!fixture.result && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        if (fixture.result?.fullyConfigured !== true || fixture.result.requiresClientReload !== false) throw new Error('Scout reconfiguration was not idempotent');
        if (fs.readFileSync(fixture.configPath, 'utf8') !== fixture.originalRegistry || fs.readFileSync(fixture.skillPath, 'utf8') !== fixture.originalSkill) throw new Error('Unchanged Scout configuration was rewritten');
        return { registryIdentical: true, skillIdentical: true, requiresClientReload: false };
      })()
      """
    When I start command "kw.e2e.removeScout"
    Then I wait for QuickInput title "Disable integration with external tools"
    When I select QuickInput item "Remove managed Scout MCP registration and skill"
    Then I collect JSON artifact "scout-selective-removal" from extension host expression:
      """
      (async () => {
        const require = process.getBuiltinModule('node:module').createRequire(vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench').extensionUri.fsPath + '/package.json');
        const fs = require('node:fs');
        const fixture = globalThis.__scoutSetupFixture;
        const deadline = Date.now() + 10000;
        while (fs.existsSync(fixture.skillPath) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        const registry = JSON.parse(fs.readFileSync(fixture.configPath, 'utf8'));
        if (registry.servers.kusto_workbench || fs.existsSync(fixture.receiptPath) || fs.existsSync(fixture.skillPath)) throw new Error('Owned Scout integration was not removed');
        if (JSON.stringify(registry.servers.unrelated) !== JSON.stringify(fixture.unrelated) || registry.future !== 'preserve') throw new Error('Selective removal modified unrelated Scout settings');
        await vscode.workspace.getConfiguration('kustoWorkbench').update('externalTools.enabled', fixture.previousEnabled, vscode.ConfigurationTarget.Global);
        await vscode.commands.executeCommand('kusto.stopExternalMcpProvider');
        for (const registration of fixture.registrations) registration.dispose();
        fs.rmSync(fixture.root, { recursive: true, force: true });
        delete globalThis.__scoutSetupFixture;
        return { ownedRegistrationRemoved: true, managedSkillRemoved: true, unrelatedPreserved: true, fixtureRemoved: true };
      })()
      """