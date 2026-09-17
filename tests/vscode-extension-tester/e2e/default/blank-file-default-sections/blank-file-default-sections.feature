Feature: Blank files open with an engine-appropriate default section

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"

  Scenario: Position the Dev Host for visual evidence
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000

  Scenario Outline: A blank <fileKind> file opens ready to edit
    Then I collect JSON artifact "<fileKind>-blank-created" from extension host expression "(async () => { const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-blank-file-default-sections'); const uri = vscode.Uri.joinPath(root, 'blank.<extension>'); await vscode.workspace.fs.createDirectory(root); await vscode.workspace.fs.writeFile(uri, new Uint8Array()); await vscode.commands.executeCommand('vscode.openWith', uri, '<viewType>', { preview: false }); globalThis.__blankDefaultSectionUri = uri; return { fileKind: '<fileKind>', path: uri.fsPath, byteLength: 0 }; })()"
    When I wait for "#queries-container > <expectedTag>" in the webview for 20 seconds
    And I evaluate "(() => { const actual = document.body.dataset.kustoDocumentKind; if (actual !== '<documentKind>') throw new Error('Expected <documentKind>, got ' + actual); return actual; })()" in the webview
    Then I collect JSON artifact "<fileKind>-blank-live" from webview expression:
      """
      (() => {
        const allSelector = '#queries-container > kw-query-section, #queries-container > kw-sql-section, #queries-container > kw-chart-section, #queries-container > kw-markdown-section, #queries-container > kw-transformation-section, #queries-container > kw-python-section, #queries-container > kw-url-section, #queries-container > kw-html-section';
        const sections = Array.from(document.querySelectorAll(allSelector));
        const documentKind = document.body.dataset.kustoDocumentKind;
        const isKusto = documentKind === 'kqlx' || documentKind === 'kql';
        const expectedTag = isKusto ? 'kw-query-section' : 'kw-sql-section';
        const unexpectedTag = isKusto ? 'kw-sql-section' : 'kw-query-section';
        const sectionKind = isKusto ? 'query' : 'sql';
        const expected = Array.from(document.querySelectorAll('#queries-container > ' + expectedTag));
        const unexpected = Array.from(document.querySelectorAll('#queries-container > ' + unexpectedTag));
        if (sections.length !== 1 || expected.length !== 1 || unexpected.length !== 0) {
          throw new Error('Blank ' + documentKind + ' section mismatch: ' + JSON.stringify(sections.map(section => ({ id: section.id, tag: section.tagName }))));
        }
        const serialized = typeof expected[0].serialize === 'function' ? expected[0].serialize() : undefined;
        if (!serialized || serialized.type !== sectionKind || serialized.query !== '') {
          throw new Error('Blank ' + documentKind + ' starter is not an editable empty ' + sectionKind + ': ' + JSON.stringify(serialized));
        }
        return { documentKind, sectionKind: serialized.type, sectionId: expected[0].id, sectionCount: sections.length, query: serialized.query };
      })()
      """
    Then I collect JSON artifact "<fileKind>-blank-source" from extension host expression:
      """
      (async () => {
        const uri = globalThis.__blankDefaultSectionUri;
        const document = uri && vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
        if (!document) throw new Error('Blank document is not open');
        const diskBytes = await vscode.workspace.fs.readFile(document.uri);
        if (document.isDirty || document.getText() !== '' || diskBytes.byteLength !== 0) {
          throw new Error('Opening blank document mutated its source: ' + JSON.stringify({ path: uri.fsPath, dirty: document.isDirty, text: document.getText(), byteLength: diskBytes.byteLength }));
        }
        return { dirty: false, text: '', byteLength: 0 };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    And I wait 1 second
    Then I take a screenshot "<fileKind>-blank-default-section"
    When I execute command "workbench.action.closeAllEditors"
    And I delete file "${TEMP}/kusto-workbench-blank-file-default-sections/blank.<extension>"

    Examples:
      | fileKind | extension | viewType              | documentKind | expectedTag      | unexpectedTag    | sectionKind |
      | KQLX     | kqlx      | kusto.kqlxEditor      | kqlx         | kw-query-section | kw-sql-section   | query       |
      | KQL      | kql       | kusto.kqlCompatEditor | kql          | kw-query-section | kw-sql-section   | query       |
      | SQLX     | sqlx      | kusto.kqlxEditor      | sqlx         | kw-sql-section   | kw-query-section | sql         |
      | SQL      | sql       | kusto.sqlCompatEditor | sql          | kw-sql-section   | kw-query-section | sql         |

  Scenario Outline: A blank native <fileKind> starter persists through reopen and a second edit
    Then I collect JSON artifact "<fileKind>-lifecycle-created" from extension host expression "(async () => { const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-blank-file-default-sections'); const uri = vscode.Uri.joinPath(root, 'lifecycle.<extension>'); await vscode.workspace.fs.createDirectory(root); await vscode.workspace.fs.writeFile(uri, new Uint8Array()); await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); globalThis.__blankDefaultSectionLifecycleUri = uri; return { fileKind: '<fileKind>', path: uri.fsPath, byteLength: 0 }; })()"
    When I wait for "#queries-container > <expectedTag> .monaco-editor" in the webview for 20 seconds
    And I evaluate "window.__testSetMonacoValue('<expectedTag> .monaco-editor', '<firstQuery>')" in the webview
    And I wait 1 second
    And I execute command "workbench.action.files.save"
    And I wait 2 seconds
    Then I collect JSON artifact "<fileKind>-lifecycle-first-save" from extension host expression "(async () => { const uri = globalThis.__blankDefaultSectionLifecycleUri; const document = uri && vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); if (!document) throw new Error('Saved <fileKind> document is unavailable'); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); const file = JSON.parse(text); const sections = file?.state?.sections || []; const section = sections[0]; if (document.isDirty || sections.length !== 1 || section?.type !== '<sectionKind>' || section?.query !== '<firstQuery>' || !section?.id) throw new Error('First <fileKind> Save did not persist one exact starter: ' + JSON.stringify({ dirty: document.isDirty, sections })); globalThis.__blankDefaultSectionLifecycleId = section.id; return { dirty: false, sectionCount: 1, sectionId: section.id, sectionType: section.type, query: section.query }; })()"
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    Then I collect JSON artifact "<fileKind>-lifecycle-reopened" from extension host expression "(async () => { const uri = globalThis.__blankDefaultSectionLifecycleUri; await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); return { reopened: true, sectionId: globalThis.__blankDefaultSectionLifecycleId }; })()"
    When I wait for "#queries-container > <expectedTag> .monaco-editor" in the webview for 20 seconds
    And I evaluate "(() => { const sections = Array.from(document.querySelectorAll('#queries-container > kw-query-section, #queries-container > kw-sql-section')); const section = document.querySelector('#queries-container > <expectedTag>'); const serialized = section?.serialize?.(); if (sections.length !== 1 || serialized?.type !== '<sectionKind>' || serialized?.query !== '<firstQuery>') throw new Error('Reopened <fileKind> starter mismatch: ' + JSON.stringify({ count: sections.length, serialized })); return { sectionId: section.id, sectionType: serialized.type, query: serialized.query }; })()" in the webview
    And I evaluate "window.__testSetMonacoValue('<expectedTag> .monaco-editor', '<secondQuery>')" in the webview
    And I wait 1 second
    And I execute command "workbench.action.files.save"
    And I wait 2 seconds
    Then I collect JSON artifact "<fileKind>-lifecycle-second-save" from extension host expression "(async () => { const uri = globalThis.__blankDefaultSectionLifecycleUri; const document = uri && vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); if (!document) throw new Error('Re-saved <fileKind> document is unavailable'); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); const file = JSON.parse(text); const sections = file?.state?.sections || []; const section = sections[0]; if (document.isDirty || sections.length !== 1 || section?.id !== globalThis.__blankDefaultSectionLifecycleId || section?.type !== '<sectionKind>' || section?.query !== '<secondQuery>') throw new Error('Second <fileKind> Save did not retain the starter: ' + JSON.stringify({ dirty: document.isDirty, expectedId: globalThis.__blankDefaultSectionLifecycleId, sections })); return { dirty: false, sectionCount: 1, sectionId: section.id, sectionType: section.type, query: section.query }; })()"
    When I execute command "workbench.action.closeAllEditors"
    And I delete file "${TEMP}/kusto-workbench-blank-file-default-sections/lifecycle.<extension>"

    Examples:
      | fileKind | extension | expectedTag      | sectionKind | firstQuery       | secondQuery      |
      | KQLX     | kqlx      | kw-query-section | query       | print Pass=1     | print Pass=2     |
      | SQLX     | sqlx      | kw-sql-section   | sql         | SELECT 1 AS Pass | SELECT 2 AS Pass |