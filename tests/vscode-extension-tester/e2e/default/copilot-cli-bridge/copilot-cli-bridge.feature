Feature: Opt-in Copilot CLI bridge lifecycle

  Background:
    Given the extension is in a clean state
    Then I collect JSON artifact "copilot-cli-workspace-preflight" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule?.('fs');
        const path = process.getBuiltinModule?.('path');
        if (!fs || !path) throw new Error('Node filesystem APIs are unavailable in the extension host');
        const tempRoot = String(process.env.TEMP || '');
        if (!tempRoot) throw new Error('TEMP must be set for the Copilot CLI E2E workspace');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension) throw new Error('Kusto Workbench extension path is unavailable');
        const realpath = value => (fs.realpathSync.native || fs.realpathSync)(value);
        const isWithin = (candidate, root) => {
          const relative = path.relative(root, candidate);
          return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        };
        const canonicalExtension = realpath(extension.extensionUri.fsPath);
        const canonicalTemp = realpath(tempRoot);
        if (isWithin(canonicalTemp, canonicalExtension) || isWithin(canonicalExtension, canonicalTemp)) {
          throw new Error('TEMP overlaps the extension repository: ' + canonicalTemp);
        }
        const expected = path.join(canonicalTemp, 'vscode-kusto-workbench-copilot-cli-bridge');
        const ownerPath = path.join(expected, '.kusto-workbench-e2e-owner');
        const ownerContent = 'copilot-cli-bridge-v1\n';
        const rootStat = fs.lstatSync(expected, { throwIfNoEntry: false });
        if (!rootStat) {
          fs.mkdirSync(expected);
          fs.writeFileSync(ownerPath, ownerContent, { encoding: 'utf8', flag: 'wx' });
        } else {
          if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
            throw new Error('Copilot CLI E2E workspace root is a link or has the wrong type: ' + expected);
          }
          const ownerStat = fs.lstatSync(ownerPath, { throwIfNoEntry: false });
          if (!ownerStat || ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) {
            throw new Error('Copilot CLI E2E workspace ownership marker is invalid: ' + ownerPath);
          }
          if (fs.readFileSync(ownerPath, 'utf8') !== ownerContent) {
            throw new Error('Copilot CLI E2E workspace has a foreign ownership marker: ' + expected);
          }
        }
        const canonicalExpected = realpath(expected);
        const canonicalOwner = realpath(ownerPath);
        if (isWithin(canonicalExpected, canonicalExtension) || isWithin(canonicalExtension, canonicalExpected)) {
          throw new Error('Copilot CLI E2E workspace overlaps the extension repository: ' + canonicalExpected);
        }
        if (!isWithin(canonicalOwner, canonicalExpected)) {
          throw new Error('Copilot CLI E2E ownership marker escaped its workspace: ' + canonicalOwner);
        }
        return { expected: canonicalExpected, ownerPath: canonicalOwner };
      })()
      """
    When I add folder "${TEMP}/vscode-kusto-workbench-copilot-cli-bridge" to the workspace
    Then I collect JSON artifact "copilot-cli-workspace" from extension host expression:
      """
      (() => {
        const fs = process.getBuiltinModule?.('fs');
        const path = process.getBuiltinModule?.('path');
        if (!fs || !path) throw new Error('Node filesystem APIs are unavailable in the extension host');
        const tempRoot = String(process.env.TEMP || '');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!tempRoot || !extension) throw new Error('Copilot CLI workspace validation prerequisites are unavailable');
        const realpath = value => (fs.realpathSync.native || fs.realpathSync)(value);
        const normalize = value => process.platform === 'win32' ? value.toLowerCase() : value;
        const isWithin = (candidate, root) => {
          const relative = path.relative(root, candidate);
          return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
        };
        const expected = realpath(path.join(realpath(tempRoot), 'vscode-kusto-workbench-copilot-cli-bridge'));
        const canonicalExtension = realpath(extension.extensionUri.fsPath);
        const ownerPath = path.join(expected, '.kusto-workbench-e2e-owner');
        const ownerStat = fs.lstatSync(ownerPath, { throwIfNoEntry: false });
        if (!ownerStat || ownerStat.isSymbolicLink() || !ownerStat.isFile() || ownerStat.nlink !== 1) {
          throw new Error('Copilot CLI E2E ownership marker changed after workspace activation: ' + ownerPath);
        }
        if (fs.readFileSync(ownerPath, 'utf8') !== 'copilot-cli-bridge-v1\n') {
          throw new Error('Copilot CLI E2E ownership content changed after workspace activation: ' + ownerPath);
        }
        if (isWithin(expected, canonicalExtension) || isWithin(canonicalExtension, expected)) {
          throw new Error('Copilot CLI E2E workspace overlaps the extension repository after activation: ' + expected);
        }
        const folders = vscode.workspace.workspaceFolders || [];
        const actual = folders.map(folder => realpath(folder.uri.fsPath));
        if (actual.length !== 1 || normalize(actual[0]) !== normalize(expected)) {
          throw new Error('Copilot CLI E2E requires its owned root as the sole workspace folder: ' + JSON.stringify({ expected, actual }));
        }
        return { expected, actual: actual[0], folderCount: actual.length };
      })()
      """

  Scenario: Explicit attachment stays default-off and isolates concurrent CLI sessions
    Then I collect JSON artifact "copilot-cli-lifecycle" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('fs');
        const path = process.getBuiltinModule('path');
        const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
        const previous = configuration.inspect('copilotCli.enabled')?.globalValue;
        const cliTerminals = () => vscode.window.terminals.filter(terminal => terminal.creationOptions?.name === 'Kusto Workbench Copilot CLI');
        const waitFor = async (condition, label, timeout = 20000) => {
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const value = condition();
            if (value) return value;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          const terminals = vscode.window.terminals.map(terminal => ({
            name: terminal.name,
            creationName: terminal.creationOptions?.name || null,
            shellPath: terminal.creationOptions?.shellPath || null,
            exitStatus: terminal.exitStatus || null
          }));
          throw new Error('Timed out waiting for ' + label + ': ' + JSON.stringify(terminals));
        };
        const inspectTerminal = terminal => {
          const options = terminal.creationOptions || {};
          const args = Array.isArray(options.shellArgs) ? options.shellArgs.map(String) : [];
          const configArg = args.find(value => value.startsWith('--additional-mcp-config=@'));
          const addDirArg = args.find(value => value.startsWith('--add-dir='));
          if (!configArg || !addDirArg || !args.includes('--agent=kusto-workbench-cli') || !args.includes('--no-remote-export')) {
            throw new Error('CLI launch arguments are incomplete: ' + JSON.stringify(args));
          }
          if (options.env && Object.keys(options.env).length > 0) throw new Error('CLI launch exposed values through terminal environment variables.');
          if (args.some(value => value.includes('Bearer '))) throw new Error('CLI launch exposed its bearer token in arguments.');
          const configPath = configArg.slice('--additional-mcp-config=@'.length);
          const sessionRoot = path.dirname(configPath);
          const agentRoot = addDirArg.slice('--add-dir='.length);
          const mainAgent = path.join(agentRoot, '.github', 'agents', 'kusto-workbench-cli.agent.md');
          const searchAgent = path.join(agentRoot, '.github', 'agents', 'kusto-workbench-search-cli.agent.md');
          if (!fs.existsSync(mainAgent) || !fs.existsSync(searchAgent)) throw new Error('Generated CLI agents are missing.');
          const mainText = fs.readFileSync(mainAgent, 'utf8');
          if (!mainText.includes('# Kusto Workbench Agent') || !mainText.includes('/listSections')) throw new Error('Generated main agent is incomplete.');
          return { terminal, configPath, sessionRoot, executable: String(options.shellPath || '') };
        };

        const result = {};
        try {
          await vscode.commands.executeCommand('kusto.disconnectCopilotCli');
          await configuration.update('copilotCli.enabled', false, vscode.ConfigurationTarget.Global);
          const disabledBefore = cliTerminals().length;
          await vscode.commands.executeCommand('kusto.connectCopilotCli');
          const disabledAfter = cliTerminals().length;
          if (disabledAfter !== disabledBefore) throw new Error('A CLI terminal started while integration was disabled.');
          result.defaultOff = { enabled: configuration.get('copilotCli.enabled'), before: disabledBefore, after: disabledAfter };

          await configuration.update('copilotCli.enabled', true, vscode.ConfigurationTarget.Global);
          await Promise.allSettled([
            vscode.commands.executeCommand('kusto.connectCopilotCli'),
            vscode.commands.executeCommand('kusto.connectCopilotCli'),
            vscode.commands.executeCommand('kusto.disconnectCopilotCli')
          ]);
          await waitFor(() => cliTerminals().length === 0, 'cold Connect/Disconnect barrier');
          result.raceBarrier = { terminals: 0 };

          const firstConnect = await vscode.commands.executeCommand('kusto.connectCopilotCli');
          const secondConnect = await vscode.commands.executeCommand('kusto.connectCopilotCli');
          if (!firstConnect?.success || !secondConnect?.success) {
            throw new Error('Explicit Connect failed: ' + JSON.stringify({ firstConnect, secondConnect }));
          }
          await waitFor(() => cliTerminals().length === 2, 'two explicit CLI sessions');
          const sessions = cliTerminals().map(inspectTerminal);
          await waitFor(() => sessions.every(session => !fs.existsSync(session.configPath)), 'credential removal after MCP authentication', 30000);
          sessions[0].terminal.dispose();
          await waitFor(() => cliTerminals().length === 1 && !fs.existsSync(sessions[0].sessionRoot), 'one naturally closed CLI session');
          if (!fs.existsSync(sessions[1].sessionRoot)) throw new Error('Closing one terminal removed the surviving CLI session.');
          result.multipleSessions = { before: 2, credentialConfigsRemoved: true, afterNaturalClose: 1, firstRootRemoved: true, survivorRootPresent: true, executable: sessions[1].executable };

          await configuration.update('copilotCli.enabled', false, vscode.ConfigurationTarget.Global);
          await waitFor(() => cliTerminals().length === 0 && !fs.existsSync(sessions[1].sessionRoot), 'setting-disable teardown');
          result.disableTeardown = { terminals: 0, sessionRootsRemoved: true };

          await configuration.update('copilotCli.enabled', true, vscode.ConfigurationTarget.Global);
          const reconnect = await vscode.commands.executeCommand('kusto.connectCopilotCli');
          if (!reconnect?.success) throw new Error('Reconnect before explicit Disconnect failed: ' + JSON.stringify(reconnect));
          const explicitSession = inspectTerminal(await waitFor(() => cliTerminals()[0], 'explicit disconnect session'));
          await vscode.commands.executeCommand('kusto.disconnectCopilotCli');
          await waitFor(() => cliTerminals().length === 0 && !fs.existsSync(explicitSession.sessionRoot), 'explicit disconnect teardown');
          result.explicitDisconnect = { terminals: 0, sessionRootRemoved: true };
          return result;
        } finally {
          await vscode.commands.executeCommand('kusto.disconnectCopilotCli');
          await configuration.update('copilotCli.enabled', previous, vscode.ConfigurationTarget.Global);
        }
      })()
      """
    Then I take a screenshot "copilot-cli-lifecycle-clean"