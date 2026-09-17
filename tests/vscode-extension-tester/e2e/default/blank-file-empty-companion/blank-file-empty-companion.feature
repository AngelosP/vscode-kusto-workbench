Feature: Empty companion files are repaired cleanly with an engine primary

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"

  Scenario: Position the Dev Host for visual evidence
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000

  Scenario Outline: An exact empty <fileKind> companion is repaired without an overwrite prompt
    Then I collect JSON artifact "<fileKind>-empty-companion-created" from extension host expression "(async () => { const root = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-blank-file-empty-companion'); const primaryUri = vscode.Uri.joinPath(root, 'empty.<extension>'); const sidecarUri = vscode.Uri.file(primaryUri.fsPath + '.json'); const sidecar = { kind: '<legacyKind>', version: 1, futureRoot: { keep: '<fileKind>' }, state: { futureState: ['keep'], sections: [] } }; const sidecarText = JSON.stringify(sidecar); await vscode.workspace.fs.createDirectory(root); await vscode.workspace.fs.writeFile(primaryUri, new Uint8Array()); await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(sidecarText)); await vscode.commands.executeCommand('vscode.openWith', primaryUri, '<viewType>', { preview: false }); globalThis.__emptyCompanionPrimaryUri = primaryUri; globalThis.__emptyCompanionSidecarUri = sidecarUri; globalThis.__emptyCompanionOriginalText = sidecarText; return { fileKind: '<fileKind>', primaryPath: primaryUri.fsPath, sidecarPath: sidecarUri.fsPath, sidecarText }; })()"
    When I wait for "#queries-container > <expectedTag>" in the webview for 20 seconds
    And I evaluate "(() => { const sections = Array.from(document.querySelectorAll('#queries-container > kw-query-section, #queries-container > kw-sql-section')); const section = document.querySelector('#queries-container > <expectedTag>'); const serialized = section?.serialize?.(); if (sections.length !== 1 || section?.id !== '<primaryId>' || serialized?.type !== '<sectionKind>' || serialized?.query !== '') throw new Error('Empty <fileKind> companion projection mismatch: ' + JSON.stringify({ count: sections.length, id: section?.id, serialized })); return { sectionId: section.id, sectionType: serialized.type, query: serialized.query }; })()" in the webview
    And I wait 2 seconds
    Then I collect JSON artifact "<fileKind>-empty-companion-clean" from extension host expression "(async () => { const primaryUri = globalThis.__emptyCompanionPrimaryUri; const sidecarUri = globalThis.__emptyCompanionSidecarUri; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === primaryUri.toString()); const primary = new TextDecoder().decode(await vscode.workspace.fs.readFile(primaryUri)); const sidecarText = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri)); const directoryUri = sidecarUri.with({ path: sidecarUri.path.slice(0, sidecarUri.path.lastIndexOf('/')) }); const recoveryPrefix = sidecarUri.path.split('/').pop() + '.recovery-'; const recoveryFiles = (await vscode.workspace.fs.readDirectory(directoryUri)).map(([name]) => name).filter(name => name.startsWith(recoveryPrefix)); if (!document || document.isDirty || primary !== '' || sidecarText !== globalThis.__emptyCompanionOriginalText || recoveryFiles.length) throw new Error('Untouched <fileKind> companion became dirty: ' + JSON.stringify({ found: !!document, dirty: document?.isDirty, primary, sidecarText, recoveryFiles })); return { dirty: false, primaryBytes: 0, sidecarUnchanged: true, recoveryFiles }; })()"
    Then I collect JSON artifact "<fileKind>-empty-companion-hidden-restored" from extension host expression "(async () => { const focusUri = vscode.Uri.joinPath(vscode.Uri.file(process.env.TEMP || process.cwd()), 'kusto-workbench-blank-file-empty-companion', 'focus.txt'); await vscode.workspace.fs.writeFile(focusUri, new TextEncoder().encode('focus')); const focusDocument = await vscode.workspace.openTextDocument(focusUri); await vscode.window.showTextDocument(focusDocument, { preview: false }); await new Promise(resolve => setTimeout(resolve, 750)); await vscode.commands.executeCommand('vscode.openWith', globalThis.__emptyCompanionPrimaryUri, '<viewType>', { preview: false }); globalThis.__emptyCompanionFocusUri = focusUri; return { hidden: true, restored: true }; })()"
    When I wait for "#queries-container > <expectedTag>" in the webview for 20 seconds
    And I wait 1 second
    Then I collect JSON artifact "<fileKind>-empty-companion-section-status" from webview expression "(() => { const sections = Array.from(document.querySelectorAll('#queries-container > kw-query-section, #queries-container > kw-sql-section')); const changed = sections.filter(section => section.hasAttribute('has-changes')).map(section => ({ id: section.id, status: section.getAttribute('has-changes') })); if (sections.length !== 1 || sections[0].id !== '<primaryId>' || changed.length) throw new Error('Untouched <fileKind> companion gained a section-change marker after hide/restore: ' + JSON.stringify({ ids: sections.map(section => section.id), changed })); return { sectionCount: 1, sectionId: sections[0].id, changed }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    And I wait 1 second
    Then I take a screenshot "<fileKind>-empty-companion-repaired"
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    Then I collect JSON artifact "<fileKind>-empty-companion-reopened" from extension host expression "(async () => { await vscode.commands.executeCommand('vscode.openWith', globalThis.__emptyCompanionPrimaryUri, '<viewType>', { preview: false }); return { reopened: true }; })()"
    When I wait for "#queries-container > <expectedTag>" in the webview for 20 seconds
    And I evaluate "(() => { const section = document.querySelector('#queries-container > <expectedTag>'); const shell = section?.shadowRoot?.querySelector('kw-section-shell'); const input = shell?.shadowRoot?.querySelector('input.query-name'); if (!(input instanceof HTMLInputElement)) throw new Error('Section name input unavailable'); input.value = 'Authored <fileKind> metadata'; input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: input.value })); input.dispatchEvent(new Event('change', { bubbles: true })); return { sectionId: section.id, name: input.value }; })()" in the webview
    And I wait 1 second
    And I execute command "workbench.action.files.save"
    And I wait 2 seconds
    Then I collect JSON artifact "<fileKind>-empty-companion-materialized" from extension host expression "(async () => { const primaryUri = globalThis.__emptyCompanionPrimaryUri; const sidecarUri = globalThis.__emptyCompanionSidecarUri; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === primaryUri.toString()); const primary = new TextDecoder().decode(await vscode.workspace.fs.readFile(primaryUri)); const sidecarText = new TextDecoder().decode(await vscode.workspace.fs.readFile(sidecarUri)); const sidecar = JSON.parse(sidecarText); const sections = sidecar?.state?.sections || []; const section = sections[0]; if (!document || document.isDirty || primary !== '' || sidecar.kind !== '<sidecarKind>' || sidecar.futureRoot?.keep !== '<fileKind>' || sidecar.state?.futureState?.[0] !== 'keep' || sections.length !== 1 || section?.id !== '<primaryId>' || section?.type !== '<sectionKind>' || section?.name !== 'Authored <fileKind> metadata' || section?.linkedQueryPath !== 'empty.<extension>') throw new Error('Authored <fileKind> companion did not materialize losslessly: ' + JSON.stringify({ dirty: document?.isDirty, primary, sidecar })); return { dirty: false, primaryBytes: 0, kind: sidecar.kind, sectionId: section.id, sectionType: section.type, sectionName: section.name, linkedQueryPath: section.linkedQueryPath, futureRoot: sidecar.futureRoot, futureState: sidecar.state.futureState }; })()"
    When I execute command "workbench.action.closeAllEditors"
    And I delete file "${TEMP}/kusto-workbench-blank-file-empty-companion/empty.<extension>"
    And I delete file "${TEMP}/kusto-workbench-blank-file-empty-companion/empty.<extension>.json"
    And I delete file "${TEMP}/kusto-workbench-blank-file-empty-companion/focus.txt"

    Examples:
      | fileKind | extension | viewType              | legacyKind | sidecarKind | expectedTag      | sectionKind | primaryId           |
      | KQL      | kql       | kusto.kqlCompatEditor | mdx        | kqlx        | kw-query-section | query       | compat_primary_query |
      | SQL      | sql       | kusto.sqlCompatEditor | kqlx       | sqlx        | kw-sql-section   | sql         | compat_primary_sql   |
