Feature: Recover a KQLX notebook with repeated trailing content

  Scenario: Recover a copy from the read-only invalid-file view
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "damaged-notebook-created" from extension host expression:
      """
      (async () => {
        const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kw-repeated-suffix-recovery-e2e');
        const fs = process.getBuiltinModule('node:fs');
        if (fs.existsSync(root.fsPath)) throw new Error('Recovery test root already exists; refusing to overwrite it');
        const source = vscode.Uri.joinPath(root, 'damaged.kqlx');
        const recovered = vscode.Uri.joinPath(root, 'recovered.kqlx');
        const file = { kind: 'kqlx', version: 1, state: { sections: [
          { id: 'query_1', type: 'query', name: 'Synthetic', expanded: true, resultsVisible: true,
            query: 'print Recovered=1', futureField: { preserved: true },
            resultJson: JSON.stringify({ columns: [{ name: 'Payload', type: 'string' }], rows: [[{ display: 'synthetic', full: 'R'.repeat(3500) }]] }) },
          { id: 'query_2', type: 'query', name: 'Second synthetic', expanded: false, query: 'print Sibling=1' },
        ] } };
        const validText = JSON.stringify(file, null, 2).replace(/\n/g, '\r\n');
        const block = validText.slice(-1536);
        const damagedText = validText + block.repeat(3) + '\r\n';
        const validBytes = new TextEncoder().encode(validText);
        const damagedBytes = new TextEncoder().encode(damagedText);
        JSON.parse(validText);
        try { JSON.parse(damagedText); throw new Error('The synthetic document must be invalid'); }
        catch (error) { if (error.message === 'The synthetic document must be invalid') throw error; }
        await vscode.workspace.fs.createDirectory(root);
        await vscode.workspace.fs.writeFile(source, damagedBytes);
        globalThis.__repeatedSuffixRecovery = { root, source, recovered, validBytes, damagedBytes, resultJson: file.state.sections[0].resultJson };
        await vscode.commands.executeCommand('vscode.openWith', source, 'kusto.kqlxEditor', { preview: false });
        return { sourceBytes: damagedBytes.byteLength, repairedBytes: validBytes.byteLength, removedBytes: damagedBytes.byteLength - validBytes.byteLength, sections: 2 };
      })()
      """
    When I wait for "a[href^='command:kustoWorkbench.recoverKqlx.']" in the webview for 20 seconds
    Then the webview should contain "Invalid Kusto Workbench file"
    Then I collect JSON artifact "damaged-notebook-unchanged" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__repeatedSuffixRecovery;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.source.toString());
        const bytes = await vscode.workspace.fs.readFile(probe.source);
        if (!Buffer.from(bytes).equals(Buffer.from(probe.damagedBytes)) || document?.isDirty) throw new Error('Opening the damaged notebook modified its source');
        return { sourceUnchanged: true, dirty: false, bytes: bytes.byteLength };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "repair-option-in-read-only-file"
    When I click the element "Recover a Copy"
    And I click "Recover a Copy" on the "Visual Studio Code" dialog
    And I save the file as "${TEMP}\kw-repeated-suffix-recovery-e2e\recovered.kqlx"
    Then I collect JSON artifact "recovered-copy-exact" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__repeatedSuffixRecovery;
        const fs = process.getBuiltinModule('node:fs');
        const deadline = Date.now() + 15000;
        while (!fs.existsSync(probe.recovered.fsPath) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!fs.existsSync(probe.recovered.fsPath)) throw new Error('Recovered copy was not created after Save As');
        const original = await vscode.workspace.fs.readFile(probe.source);
        const saved = await vscode.workspace.fs.readFile(probe.recovered);
        if (!Buffer.from(original).equals(Buffer.from(probe.damagedBytes)) || !Buffer.from(saved).equals(Buffer.from(probe.validBytes))) {
          throw new Error('Recovery must preserve the original and copy only its valid prefix');
        }
        const file = JSON.parse(new TextDecoder().decode(saved));
        if (file.state.sections.length !== 2 || file.state.sections[0].resultJson !== probe.resultJson || file.state.sections[0].futureField.preserved !== true) {
          throw new Error('Recovered section content or result attachment changed');
        }
        return { originalUnchanged: true, recoveredBytes: saved.byteLength, sections: 2, savedResultUnchanged: true };
      })()
      """
    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    And I evaluate "(() => { const section = document.querySelector('kw-query-section'); if (section?.serialize?.().query !== 'print Recovered=1') throw new Error('Recovered editor did not restore the original query'); return { queryRestored: true }; })()" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "recovered-copy-opened"
    When I evaluate "window.__testSetMonacoValue('kw-query-section .monaco-editor', 'print Recovered=2')" in the webview
    Then I collect JSON artifact "recovered-copy-dirty" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__repeatedSuffixRecovery;
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.recovered.toString());
        const deadline = Date.now() + 15000;
        while (document && (!document.isDirty || !document.getText().includes('print Recovered=2')) && Date.now() < deadline) {
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (!document?.isDirty || !document.getText().includes('print Recovered=2')) throw new Error('Edit to recovered copy did not reach the backing document');
        return { dirty: true };
      })()
      """
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "recovered-copy-resaved" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__repeatedSuffixRecovery;
        const source = await vscode.workspace.fs.readFile(probe.source);
        const file = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(probe.recovered)));
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === probe.recovered.toString());
        if (!Buffer.from(source).equals(Buffer.from(probe.damagedBytes)) || document?.isDirty
          || file.state.sections[0].query !== 'print Recovered=2' || file.state.sections[0].resultJson !== probe.resultJson) {
          throw new Error('Saving the recovered copy changed the source or its saved result');
        }
        return { originalUnchanged: true, queryEdited: true, savedResultUnchanged: true, dirty: false };
      })()
      """
    Then I collect JSON artifact "recovery-fixture-removed" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__repeatedSuffixRecovery;
        if (probe?.root?.path.split('/').pop() !== 'kw-repeated-suffix-recovery-e2e'
          || probe.source.path !== probe.root.path + '/damaged.kqlx'
          || probe.recovered.path !== probe.root.path + '/recovered.kqlx') throw new Error('Refusing ambiguous recovery fixture cleanup');
        const entries = await vscode.workspace.fs.readDirectory(probe.root);
        if (entries.map(entry => entry[0]).sort().join(',') !== 'damaged.kqlx,recovered.kqlx') throw new Error('Unexpected recovery fixture contents');
        for (const uri of [probe.source, probe.recovered]) {
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString());
          if (document?.isDirty || tabs.length !== 1 || !await vscode.window.tabGroups.close(tabs[0])) throw new Error('Could not close the exact clean fixture tab');
        }
        await vscode.workspace.fs.delete(probe.recovered, { useTrash: false });
        await vscode.workspace.fs.delete(probe.source, { useTrash: false });
        await vscode.workspace.fs.delete(probe.root, { useTrash: false });
        delete globalThis.__repeatedSuffixRecovery;
        return { fixtureRemoved: true, unrelatedTabsClosed: false };
      })()
      """