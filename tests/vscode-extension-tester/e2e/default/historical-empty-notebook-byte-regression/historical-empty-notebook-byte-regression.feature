Feature: Passive opening of existing empty notebooks preserves their exact source bytes

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"

  Scenario: Position the Dev Host for visual evidence
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000

  Scenario Outline: Existing <shape> <documentKind> notebook keeps exact bytes without Save with autosave <autoSave>
    Then I collect JSON artifact "<documentKind>-<shape>-parameters" from extension host expression "(() => { globalThis.__emptyFixtureConfig = { documentKind: '<documentKind>', shape: '<shape>', autoSave: '<autoSave>' }; return globalThis.__emptyFixtureConfig; })()"
    Then I collect JSON artifact "<documentKind>-<shape>-regression-fixture" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const { documentKind, shape, autoSave } = globalThis.__emptyFixtureConfig;
        const config = vscode.workspace.getConfiguration('files');
        const previousAutoSave = config.inspect('autoSave')?.globalValue;
        const previousDelay = config.inspect('autoSaveDelay')?.globalValue;
        await config.update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Global);
        await config.update('autoSave', autoSave, vscode.ConfigurationTarget.Global);
        const deadline = Date.now() + 5000;
        let effective;
        while (Date.now() < deadline) {
          const current = vscode.workspace.getConfiguration('files');
          effective = { autoSave: current.get('autoSave'), autoSaveDelay: current.get('autoSaveDelay') };
          if (effective.autoSave === autoSave && effective.autoSaveDelay === 1000) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        if (effective.autoSave !== autoSave || effective.autoSaveDelay !== 1000) throw new Error(`Isolated autosave settings did not settle: ${JSON.stringify({ expected: autoSave, effective })}`);
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-empty-notebook-regression-')));
        const uri = vscode.Uri.joinPath(root, `historical.${documentKind}`);
        const otherUri = vscode.Uri.joinPath(root, 'other.kqlx');
        const source = shape === 'blank' ? '' : JSON.stringify({ kind: documentKind, version: 1, state: { sections: [] } });
        if (source && (JSON.parse(source).kind !== documentKind || JSON.parse(source).state.sections.length !== 0)) throw new Error('Invalid zero-section fixture');
        const bytes = Buffer.from(source, 'utf8');
        await vscode.workspace.fs.writeFile(uri, bytes);
        await vscode.workspace.fs.writeFile(otherUri, new TextEncoder().encode('{"kind":"kqlx","version":1,"state":{"sections":[]}}'));
        const before = Buffer.from(await vscode.workspace.fs.readFile(uri));
        if (!before.equals(bytes)) throw new Error('Fixture bytes differ before open');
        const expectedHash = crypto.createHash('sha256').update(before).digest('hex');
        const verify = async phase => {
          const disk = Buffer.from(await vscode.workspace.fs.readFile(uri));
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === uri.toString());
          const actualHash = crypto.createHash('sha256').update(disk).digest('hex');
          if (!disk.equals(before) || (document && (document.isDirty || document.getText() !== source)) || (phase !== 'closed' && (!document || !tab)) || (phase === 'closed' && tab)) {
            throw new Error(`Unexpected ${phase} notebook mutation: ${JSON.stringify({ path: uri.fsPath, expectedHash, actualHash, dirty: document?.isDirty ?? null, memoryEqualsSource: document?.getText() === source, tabOpen: !!tab })}`);
          }
          return { phase, exactBytes: true, expectedHash, actualHash, byteLength: disk.byteLength, dirty: document?.isDirty ?? false, tabOpen: !!tab };
        };
        globalThis.__emptyNotebookRegression = { root, uri, otherUri, verify, previousAutoSave, previousDelay };
        return { path: uri.fsPath, shape, documentKind, autoSave, baselineHash: expectedHash, byteLength: before.byteLength };
      })()
      """
    Then I collect JSON artifact "<documentKind>-<shape>-opened" from extension host expression "(async () => { const fixture = globalThis.__emptyNotebookRegression; await vscode.commands.executeCommand('vscode.openWith', fixture.uri, 'kusto.kqlxEditor', { preview: false }); const activeUri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString(); if (activeUri !== fixture.uri.toString()) throw new Error('Wrong fixture activated: ' + activeUri); return { activeUri }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #queries-container > <expectedTag>" in the webview for 30 seconds
    Then I collect JSON artifact "<documentKind>-<shape>-projected" from webview expression "(() => { const sections = Array.from(document.querySelectorAll('#queries-container > kw-query-section, #queries-container > kw-sql-section, #queries-container > kw-markdown-section, #queries-container > kw-html-section')); const section = sections[0]; const serialized = section?.serialize?.(); if (document.body.dataset.kustoDocumentKind !== '<documentKind>' || sections.length !== 1 || section.tagName.toLowerCase() !== '<expectedTag>' || serialized?.query !== '') throw new Error('Incorrect display-only starter: ' + JSON.stringify({ kind: document.body.dataset.kustoDocumentKind, tags: sections.map(item => item.tagName), serialized })); return { kind: '<documentKind>', projectedSection: section.tagName.toLowerCase(), query: serialized.query }; })()"
    When I wait 2 seconds
    Then I collect JSON artifact "<documentKind>-<shape>-idle-bytes" from extension host expression "globalThis.__emptyNotebookRegression.verify('idle')"
    Then I collect JSON artifact "<documentKind>-<shape>-hidden-bytes" from extension host expression "(async () => { const fixture = globalThis.__emptyNotebookRegression; await vscode.commands.executeCommand('vscode.openWith', fixture.otherUri, 'kusto.kqlxEditor', { preview: false }); const activeUri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString(); if (activeUri !== fixture.otherUri.toString()) throw new Error('Hide did not activate the other fixture: ' + activeUri); return fixture.verify('hidden'); })()"
    When I wait 2 seconds
    Then I collect JSON artifact "<documentKind>-<shape>-hidden-idle-bytes" from extension host expression "globalThis.__emptyNotebookRegression.verify('hidden-idle')"
    Then I collect JSON artifact "<documentKind>-<shape>-revealed" from extension host expression "(async () => { const fixture = globalThis.__emptyNotebookRegression; await vscode.commands.executeCommand('vscode.openWith', fixture.uri, 'kusto.kqlxEditor', { preview: false }); const activeUri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString(); if (activeUri !== fixture.uri.toString()) throw new Error('Reveal selected another fixture: ' + activeUri); return { activeUri }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #queries-container > <expectedTag>" in the webview for 30 seconds
    When I wait 2 seconds
    Then I collect JSON artifact "<documentKind>-<shape>-revealed-bytes" from extension host expression "globalThis.__emptyNotebookRegression.verify('revealed')"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "<documentKind>-<shape>-clean-starter"
    Then I collect JSON artifact "<documentKind>-<shape>-closed-bytes" from extension host expression "(async () => { const fixture = globalThis.__emptyNotebookRegression; const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs); const own = tabs.find(tab => tab.input?.uri?.toString() === fixture.uri.toString()); const other = tabs.find(tab => tab.input?.uri?.toString() === fixture.otherUri.toString()); if (!own || !other) throw new Error('Expected both task-owned tabs before clean close'); await fixture.verify('before-close'); if (!await vscode.window.tabGroups.close(own) || !await vscode.window.tabGroups.close(other)) throw new Error('A task-owned tab did not close cleanly'); return fixture.verify('closed'); })()"
    Then I collect JSON artifact "<documentKind>-<shape>-cleanup" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const fixture = globalThis.__emptyNotebookRegression; const root = path.resolve(fixture.root.fsPath); const parent = path.resolve(process.env.TEMP || process.cwd()); if (path.dirname(root).toLowerCase() !== parent.toLowerCase() || !path.basename(root).startsWith('kw-empty-notebook-regression-') || path.dirname(fixture.uri.fsPath).toLowerCase() !== root.toLowerCase() || path.dirname(fixture.otherUri.fsPath).toLowerCase() !== root.toLowerCase()) throw new Error('Refusing to delete an unowned fixture'); await fixture.verify('closed'); await vscode.workspace.fs.delete(fixture.root, { recursive: true, useTrash: false }); const config = vscode.workspace.getConfiguration('files'); await config.update('autoSave', fixture.previousAutoSave, vscode.ConfigurationTarget.Global); await config.update('autoSaveDelay', fixture.previousDelay, vscode.ConfigurationTarget.Global); delete globalThis.__emptyNotebookRegression; return { deleted: true }; })()"

    Examples:
      | shape        | documentKind | expectedTag      | autoSave   |
      | blank        | kqlx         | kw-query-section | off        |
      | zero-section | kqlx         | kw-query-section | off        |
      | blank        | sqlx         | kw-sql-section   | off        |
      | zero-section | sqlx         | kw-sql-section   | off        |
      | blank        | kqlx         | kw-query-section | afterDelay |
      | zero-section | kqlx         | kw-query-section | afterDelay |
      | blank        | sqlx         | kw-sql-section   | afterDelay |
      | zero-section | sqlx         | kw-sql-section   | afterDelay |

  Scenario Outline: Opening a historical <shape> notebook does not rewrite its source
    Then I collect JSON artifact "<shape>-parameters" from extension host expression "(() => { globalThis.__legacyShape = '<shape>'; return { shape: '<shape>' }; })()"
    Then I collect JSON artifact "<shape>-fixture" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const shape = globalThis.__legacyShape;
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-historical-shape-regression-')));
        const markdown = { id: 'historical_markdown', type: 'markdown', title: 'Historical list', expanded: true, text: shape === 'markdown-mixed'
          ? '* First item\n* Second item\n\n+ Third item\n+ Fourth item\n'
          : '* First item\n* Second item\n* Third item\n' };
        const sections = shape === 'idless-query'
          ? [{ type: 'query', query: 'print Historical=1', expanded: true }]
          : shape === 'markdown-kqlx'
            ? [{ id: 'historical_query', type: 'query', query: 'print Historical=1', expanded: true }, markdown]
            : [markdown];
        const kind = shape === 'markdown-mdx' || shape === 'markdown-mixed' ? 'mdx' : 'kqlx';
        const uri = vscode.Uri.joinPath(root, `historical.${kind}`);
        const otherUri = vscode.Uri.joinPath(root, 'other.kqlx');
        const before = Buffer.from(JSON.stringify({ kind, version: 1, state: { sections } }, null, 2), 'utf8');
        const config = vscode.workspace.getConfiguration('files');
        const previousAutoSave = config.inspect('autoSave')?.globalValue;
        const previousDelay = config.inspect('autoSaveDelay')?.globalValue;
        await config.update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Global);
        await config.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && (vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000)) await new Promise(resolve => setTimeout(resolve, 100));
        if (vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000) throw new Error('Isolated autosave was not enabled');
        await vscode.workspace.fs.writeFile(uri, before);
        await vscode.workspace.fs.writeFile(otherUri, Buffer.from('{"kind":"kqlx","version":1,"state":{"sections":[]}}', 'utf8'));
        const verify = async phase => {
          const actual = Buffer.from(await vscode.workspace.fs.readFile(uri));
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          const result = { phase, shape, exactBytes: actual.equals(before), expectedHash: crypto.createHash('sha256').update(before).digest('hex'), actualHash: crypto.createHash('sha256').update(actual).digest('hex'), dirty: document?.isDirty ?? false, documentMatchesDisk: document ? Buffer.from(document.getText(), 'utf8').equals(before) : true, beforeSections: sections.length, afterSections: actual.length ? JSON.parse(actual.toString('utf8')).state?.sections?.length : null };
          if (!result.exactBytes || result.dirty || !result.documentMatchesDisk) throw new Error(`Open-only historical notebook mutation: ${JSON.stringify(result)}`);
          return result;
        };
        globalThis.__legacyFixture = { root, uri, otherUri, verify, previousAutoSave, previousDelay };
        return { shape, path: uri.fsPath, expectedHash: crypto.createHash('sha256').update(before).digest('hex'), beforeSections: sections.length };
      })()
      """
    Then I collect JSON artifact "<shape>-opened" from extension host expression "(async () => { const fixture = globalThis.__legacyFixture; await vscode.commands.executeCommand('vscode.openWith', fixture.uri, 'kusto.kqlxEditor', { preview: false }); if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== fixture.uri.toString()) throw new Error('Historical test fixture is not active'); return { uri: fixture.uri.toString() }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #queries-container > <expectedTag>" in the webview for 30 seconds
    Then I collect JSON artifact "<shape>-restored-markers" from webview expression "(() => { if ('<shape>' === 'idless-query') return { marker: null }; const section = document.getElementById('historical_markdown'); const actual = section?.serialize?.().text; const lines = String(actual || '').trimEnd().split(String.fromCharCode(10)).filter(line => line.trim()); const expected = '<shape>' === 'markdown-mixed' ? ['* First item', '* Second item', '+ Third item', '+ Fourth item'] : ['* First item', '* Second item', '* Third item']; if (JSON.stringify(lines) !== JSON.stringify(expected)) throw new Error('Opening historical Markdown changed its list markers in the editor: ' + JSON.stringify({ expected, actual })); return { marker: '<shape>' === 'markdown-mixed' ? '* and +' : '*', text: actual }; })()"
    When I wait 2 seconds
    Then I collect JSON artifact "<shape>-open-only-bytes" from extension host expression "globalThis.__legacyFixture.verify('open-idle')"
    Then I collect JSON artifact "<shape>-hidden" from extension host expression "(async () => { const fixture = globalThis.__legacyFixture; await vscode.commands.executeCommand('vscode.openWith', fixture.otherUri, 'kusto.kqlxEditor', { preview: false }); return fixture.verify('hidden'); })()"
    When I wait 2 seconds
    Then I collect JSON artifact "<shape>-hidden-idle-bytes" from extension host expression "globalThis.__legacyFixture.verify('hidden-idle')"
    Then I collect JSON artifact "<shape>-closed" from extension host expression "(async () => { const fixture = globalThis.__legacyFixture; const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs); const target = tabs.find(tab => tab.input?.uri?.toString() === fixture.uri.toString()); const other = tabs.find(tab => tab.input?.uri?.toString() === fixture.otherUri.toString()); if (!target || !other || !await vscode.window.tabGroups.close(target) || !await vscode.window.tabGroups.close(other)) throw new Error('Could not close exact test-owned tabs'); return fixture.verify('closed'); })()"
    Then I collect JSON artifact "<shape>-cleanup" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const fixture = globalThis.__legacyFixture; const root = path.resolve(fixture.root.fsPath); const parent = path.resolve(process.env.TEMP || process.cwd()); if (path.dirname(root).toLowerCase() !== parent.toLowerCase() || !path.basename(root).startsWith('kw-historical-shape-regression-') || path.dirname(fixture.uri.fsPath).toLowerCase() !== root.toLowerCase()) throw new Error('Refusing to delete an unowned historical-shape fixture'); await fixture.verify('closed'); await vscode.workspace.fs.delete(fixture.root, { recursive: true, useTrash: false }); const config = vscode.workspace.getConfiguration('files'); await config.update('autoSave', fixture.previousAutoSave, vscode.ConfigurationTarget.Global); await config.update('autoSaveDelay', fixture.previousDelay, vscode.ConfigurationTarget.Global); delete globalThis.__legacyFixture; return { deleted: true }; })()"

    Examples:
      | shape         | expectedTag         |
      | markdown-mdx  | kw-markdown-section |
      | markdown-mixed | kw-markdown-section |
      | markdown-kqlx | kw-markdown-section |
      | idless-query  | kw-query-section    |

  Scenario: Editing old lists keeps their markers while the toolbar creates dash lists
    Then I collect JSON artifact "mixed-list-edit-fixture" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-markdown-marker-edit-')));
        const uri = vscode.Uri.joinPath(root, 'editing.mdx');
        const text = ['Intro paragraph', '', '* First item', '* Second item', '', '+ Third item', '+ Fourth item', '', 'Footer paragraph', ''].join(String.fromCharCode(10));
        await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ kind: 'mdx', version: 1, state: { sections: [{ id: 'editing_markdown', type: 'markdown', title: 'Mixed lists', text, expanded: true }] } }), 'utf8'));
        globalThis.__mixedListEdit = { root, uri };
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { path: uri.fsPath };
      })()
      """
    When I wait for ".toastui-editor-ww-container .ProseMirror > p:first-child" in the webview "editing.mdx" for 30 seconds
    When I click ".toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    When I press "End"
    When I type " revised"
    Then I collect JSON artifact "mixed-list-edited" from webview expression "(() => { const text = document.getElementById('editing_markdown')?.serialize?.().text || ''; const lines = text.split(String.fromCharCode(10)).filter(line => line.trim()); if (!lines.includes('Intro paragraph revised') || !['* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => lines.includes(line))) throw new Error('Editing outside old lists changed their markers: ' + text); return { lines }; })()"
    When I press "Enter"
    When I click ".toastui-editor-toolbar-icons.bullet-list" in the webview
    When I type "Fresh list"
    Then I collect JSON artifact "mixed-list-toolbar" from webview expression "(() => { const text = document.getElementById('editing_markdown')?.serialize?.().text || ''; const lines = text.split(String.fromCharCode(10)).filter(line => line.trim()); if (!lines.includes('- Fresh list') || !['* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => lines.includes(line))) throw new Error('Toolbar list marker or historical markers differed: ' + text); return { lines }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "mixed-list-saved" from extension host expression "(async () => { const uri = globalThis.__mixedListEdit.uri; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const bytes = await vscode.workspace.fs.readFile(uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const text = file.state.sections[0].text; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); if (!document?.isDirty && text.includes('Intro paragraph revised') && text.includes('- Fresh list') && ['* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => text.split(String.fromCharCode(10)).includes(line))) return { dirty: false, text }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Markdown markers or authored edit were not durable after Save'); })()"
    Then I collect JSON artifact "mixed-list-closed" from extension host expression "(async () => { const uri = globalThis.__mixedListEdit.uri; const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not close the exact clean Markdown fixture'); return { closed: true }; })()"
    Then I collect JSON artifact "mixed-list-reopened" from extension host expression "(async () => { const uri = globalThis.__mixedListEdit.uri; await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); return { reopened: true }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #editing_markdown" in the webview "editing.mdx" for 30 seconds
    Then I collect JSON artifact "mixed-list-reopened-markers" from webview expression "(() => { const text = document.getElementById('editing_markdown')?.serialize?.().text || ''; const lines = text.split(String.fromCharCode(10)).filter(line => line.trim()); if (!lines.includes('- Fresh list') || !['* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => lines.includes(line))) throw new Error('Reopened Markdown lost historical or toolbar list markers: ' + text); return { lines }; })()"
    Then I collect JSON artifact "mixed-list-source-mode" from webview expression "(async () => { const section = document.getElementById('editing_markdown'); const root = section.shadowRoot; const tab = [...root.querySelectorAll('button.md-mode-btn')].find(button => button.getAttribute('aria-label') === 'Markdown' && button.getClientRects().length); if (tab) tab.click(); else { const dropdown = root.querySelector('.md-mode-dropdown-btn'); if (!dropdown?.getClientRects().length) throw new Error('No visible Markdown mode control'); dropdown.click(); await section.updateComplete; const option = [...root.querySelectorAll('.md-mode-dropdown-item')].find(item => item.textContent.trim() === 'Markdown'); if (!option) throw new Error('Markdown mode option is missing'); option.click(); } await section.updateComplete; const mode = section.serialize().mode; if (mode !== 'markdown') throw new Error('The rendered mode control did not enter Markdown mode: ' + mode); return { mode, control: tab ? 'tab' : 'dropdown' }; })()"
    Then I collect JSON artifact "mixed-list-wysiwyg-mode" from webview expression "(async () => { const section = document.getElementById('editing_markdown'); const root = section.shadowRoot; const tab = [...root.querySelectorAll('button.md-mode-btn')].find(button => button.getAttribute('aria-label') === 'WYSIWYG' && button.getClientRects().length); if (tab) tab.click(); else { const dropdown = root.querySelector('.md-mode-dropdown-btn'); if (!dropdown?.getClientRects().length) throw new Error('No visible WYSIWYG mode control'); dropdown.click(); await section.updateComplete; const option = [...root.querySelectorAll('.md-mode-dropdown-item')].find(item => item.textContent.trim() === 'WYSIWYG'); if (!option) throw new Error('WYSIWYG mode option is missing'); option.click(); } await section.updateComplete; const mode = section.serialize().mode; if (mode !== 'wysiwyg') throw new Error('The rendered mode control did not return to WYSIWYG: ' + mode); return { mode, control: tab ? 'tab' : 'dropdown' }; })()"
    Then I collect JSON artifact "mixed-list-after-mode-switch" from webview expression "(() => { const text = document.getElementById('editing_markdown')?.serialize?.().text || ''; const lines = text.split(String.fromCharCode(10)).filter(line => line.trim()); if (!lines.includes('- Fresh list') || !['* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => lines.includes(line))) throw new Error('Switching editor modes changed historical list markers: ' + text); return { lines }; })()"
    Then I collect JSON artifact "mixed-list-equal-host-projection" from webview expression "(() => { const section = document.getElementById('editing_markdown'); section.applyHostDocumentState(section.serialize()); const text = section.serialize().text; const lines = text.split(String.fromCharCode(10)).filter(line => line.trim()); if (!lines.includes('- Fresh list') || !['* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => lines.includes(line))) throw new Error('A later host projection changed existing list markers: ' + text); return { lines }; })()"
    Then I collect JSON artifact "mixed-list-private-markers" from webview expression "(() => { const leaked = [...document.querySelectorAll('[data-kw-saved-bullet-marker]')].map(node => node.outerHTML.slice(0, 160)); if (leaked.length) throw new Error('Private Markdown markers leaked into copyable editor HTML: ' + JSON.stringify(leaked)); return { leaked: 0 }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "mixed-list-mode-saved" from extension host expression "(async () => { const uri = globalThis.__mixedListEdit.uri; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const file = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(uri))); const text = file.state.sections[0].text; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString()); const lines = text.split(String.fromCharCode(10)).filter(line => line.trim()); if (document && !document.isDirty && ['- Fresh list', '* First item', '* Second item', '+ Third item', '+ Fourth item'].every(line => lines.includes(line))) return { dirty: false, lines }; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Saving the mode change lost historical or toolbar list markers'); })()"
    Then I collect JSON artifact "mixed-list-cleanup" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const fixture = globalThis.__mixedListEdit; const root = path.resolve(fixture.root.fsPath); const parent = path.resolve(process.env.TEMP || process.cwd()); if (path.dirname(root).toLowerCase() !== parent.toLowerCase() || !path.basename(root).startsWith('kw-markdown-marker-edit-') || path.dirname(fixture.uri.fsPath).toLowerCase() !== root.toLowerCase()) throw new Error('Refusing to delete unowned Markdown fixture'); const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === fixture.uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not close the exact reopened Markdown fixture'); await vscode.workspace.fs.delete(fixture.root, { recursive: true, useTrash: false }); delete globalThis.__mixedListEdit; return { deleted: true }; })()"

  Scenario: A sidecar-backed Kusto chat restores without rewriting either source file
    Then I collect JSON artifact "compat-chat-fixture" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-sidecar-chat-regression-')));
        const uri = vscode.Uri.joinPath(root, 'historical.kql');
        const sidecarUri = vscode.Uri.file(uri.fsPath + '.json');
        const otherUri = vscode.Uri.joinPath(root, 'other.kqlx');
        const primary = Buffer.from('print Historical=1', 'utf8');
        const sidecar = Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'compat_primary_query', type: 'query', linkedQueryPath: 'historical.kql', expanded: true, copilotChatVisible: true, copilotChatWidthPx: 360 }] } }), 'utf8');
        await vscode.workspace.fs.writeFile(uri, primary);
        await vscode.workspace.fs.writeFile(sidecarUri, sidecar);
        await vscode.workspace.fs.writeFile(otherUri, Buffer.from('{"kind":"kqlx","version":1,"state":{"sections":[]}}', 'utf8'));
        const verify = async phase => {
          const actualPrimary = Buffer.from(await vscode.workspace.fs.readFile(uri));
          const actualSidecar = Buffer.from(await vscode.workspace.fs.readFile(sidecarUri));
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(candidate => candidate.input?.uri?.toString() === uri.toString());
          const result = { phase, primaryExact: actualPrimary.equals(primary), sidecarExact: actualSidecar.equals(sidecar), primaryDirty: document?.isDirty ?? false, tabDirty: tab?.isDirty ?? false };
          if (!result.primaryExact || !result.sidecarExact || result.primaryDirty || result.tabDirty) throw new Error('Open-only sidecar chat mutation: ' + JSON.stringify(result));
          return result;
        };
        globalThis.__sidecarChatFixture = { root, uri, sidecarUri, otherUri, verify };
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlCompatEditor', { preview: false });
        return { path: uri.fsPath, sidecarPath: sidecarUri.fsPath };
      })()
      """
    When I wait for "body[data-kusto-e2e-ready='true'] #compat_primary_query" in the webview "historical.kql" for 30 seconds
    Then I collect JSON artifact "compat-chat-live" from webview expression "(() => { const section = document.getElementById('compat_primary_query'); const serialized = section?.serialize?.(); const visible = section?.getCopilotChatVisible?.(); const width = section?.getCopilotChatWidthPx?.(); if (!visible || serialized?.copilotChatVisible !== true || width !== 360) throw new Error('Sidecar chat state was not restored: ' + JSON.stringify({ visible, width, serialized })); return { visible, width, serializedVisible: serialized.copilotChatVisible }; })()"
    When I wait 2 seconds
    Then I collect JSON artifact "compat-chat-open-bytes" from extension host expression "globalThis.__sidecarChatFixture.verify('open-idle')"
    Then I collect JSON artifact "compat-chat-hidden" from extension host expression "(async () => { const fixture = globalThis.__sidecarChatFixture; await vscode.commands.executeCommand('vscode.openWith', fixture.otherUri, 'kusto.kqlxEditor', { preview: false }); return fixture.verify('hidden'); })()"
    When I wait 2 seconds
    Then I collect JSON artifact "compat-chat-hidden-bytes" from extension host expression "globalThis.__sidecarChatFixture.verify('hidden-idle')"
    Then I collect JSON artifact "compat-chat-closed" from extension host expression "(async () => { const fixture = globalThis.__sidecarChatFixture; const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs); const primary = tabs.find(tab => tab.input?.uri?.toString() === fixture.uri.toString()); const other = tabs.find(tab => tab.input?.uri?.toString() === fixture.otherUri.toString()); if (!primary || !other || !await vscode.window.tabGroups.close(primary) || !await vscode.window.tabGroups.close(other)) throw new Error('Could not close exact task-owned sidecar tabs'); return fixture.verify('closed'); })()"
    Then I collect JSON artifact "compat-chat-cleanup" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const fixture = globalThis.__sidecarChatFixture; const root = path.resolve(fixture.root.fsPath); const parent = path.resolve(process.env.TEMP || process.cwd()); if (path.dirname(root).toLowerCase() !== parent.toLowerCase() || !path.basename(root).startsWith('kw-sidecar-chat-regression-') || path.dirname(fixture.uri.fsPath).toLowerCase() !== root.toLowerCase() || path.dirname(fixture.sidecarUri.fsPath).toLowerCase() !== root.toLowerCase()) throw new Error('Refusing to delete an unowned sidecar fixture'); await fixture.verify('closed'); await vscode.workspace.fs.delete(fixture.root, { recursive: true, useTrash: false }); delete globalThis.__sidecarChatFixture; return { deleted: true }; })()"

  Scenario: Activating saved and automatic heights leaves source bytes alone until the user fits a URL
    Then I collect JSON artifact "layout-height-fixture" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(process.env.TEMP || process.cwd(), 'kw-layout-height-open-')));
        const uri = vscode.Uri.joinPath(root, 'layout.kqlx');
        const template = vscode.Uri.joinPath(root, 'template.kqlx');
        const otherUri = vscode.Uri.joinPath(root, 'other.kqlx');
        const config = vscode.workspace.getConfiguration('files');
        const previousAutoSave = config.inspect('autoSave')?.globalValue;
        const previousDelay = config.inspect('autoSaveDelay')?.globalValue;
        await config.update('autoSaveDelay', 1000, vscode.ConfigurationTarget.Global);
        await config.update('autoSave', 'afterDelay', vscode.ConfigurationTarget.Global);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && (vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000)) await new Promise(resolve => setTimeout(resolve, 100));
        if (vscode.workspace.getConfiguration('files').get('autoSave') !== 'afterDelay' || vscode.workspace.getConfiguration('files').get('autoSaveDelay') !== 1000) throw new Error('Isolated autosave did not settle');
        const sections = [
          { id: 'layout_result_182', type: 'query', name: 'Saved result', query: 'print Value=1', expanded: true, resultsVisible: true, resultsHeightPx: 182, resultJson: JSON.stringify({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} }) },
          { id: 'layout_result_126', type: 'query', name: 'Second saved result', query: 'print Value=2', expanded: true, resultsVisible: true, resultsHeightPx: 126 },
          { id: 'layout_editor_auto', type: 'query', name: 'Automatic editor', query: 'print Value=3', expanded: true, copilotChatVisible: true, copilotChatWidthPx: 360 },
          { id: 'layout_url_auto', type: 'url', name: 'Automatic URL', url: 'https://example.invalid/layout.csv', expanded: true }
        ];
        await vscode.workspace.fs.writeFile(template, Buffer.from(JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2), 'utf8'));
        await vscode.workspace.fs.writeFile(otherUri, Buffer.from('{"kind":"kqlx","version":1,"state":{"sections":[]}}', 'utf8'));
        const prepared = await vscode.commands.executeCommand('kustoWorkbench.test.preparePersistedResultFixture', { engine: 'kusto', templatePath: template.fsPath, outputPath: uri.fsPath });
        if (prepared?.outputPath?.toLowerCase() !== uri.fsPath.toLowerCase() || !prepared.connectionId) throw new Error('Offline result fixture did not prepare: ' + JSON.stringify(prepared));
        const before = Buffer.from(await vscode.workspace.fs.readFile(uri));
        const source = JSON.parse(before.toString('utf8')).state.sections;
        if (source.length !== 4 || source[0].resultsHeightPx !== 182 || source[1].resultsHeightPx !== 126 || 'editorHeightPx' in source[2] || 'outputHeightPx' in source[3]) throw new Error('Layout fixture has the wrong height shapes');
        const expectedHash = crypto.createHash('sha256').update(before).digest('hex');
        const verify = async phase => {
          const actual = Buffer.from(await vscode.workspace.fs.readFile(uri));
          const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === uri.toString());
          const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(item => item.input?.uri?.toString() === uri.toString());
          const actualHash = crypto.createHash('sha256').update(actual).digest('hex');
          const exactBytes = actual.equals(before);
          const dirty = document?.isDirty ?? false;
          if (!exactBytes || dirty || tab?.isDirty || (phase === 'closed' ? !!tab : !tab)) {
            const expectedSections = JSON.parse(before.toString('utf8')).state.sections;
            const actualSections = JSON.parse(actual.toString('utf8')).state.sections;
            const changes = expectedSections.map((section, index) => {
              const next = actualSections[index] || {};
              return { id: section.id, added: Object.keys(next).filter(key => !(key in section)), removed: Object.keys(section).filter(key => !(key in next)), changed: Object.keys(section).filter(key => key in next && JSON.stringify(section[key]) !== JSON.stringify(next[key])) };
            });
            throw new Error('Open-only layout mutation: ' + JSON.stringify({ phase, expectedHash, actualHash, dirty, tabDirty: tab?.isDirty ?? false, tabOpen: !!tab, changes }));
          }
          return { phase, expectedHash, actualHash, exactBytes, dirty, tabOpen: !!tab };
        };
        globalThis.__layoutHeightFixture = { root, uri, otherUri, before, verify, previousAutoSave, previousDelay };
        return { uri: uri.toString(), baselineHash: expectedHash, sourceBytes: before.byteLength };
      })()
      """
    Then I collect JSON artifact "layout-height-tool-activated" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const call = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file', { toolInvocationToken: undefined, input: { targetFileUri: fixture.uri.toString() } }); const result = JSON.parse(String(call.content.find(part => typeof part?.value === 'string')?.value || '{}')); const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString(); if (!result.success || active !== fixture.uri.toString()) throw new Error('Exact tool activation failed: ' + JSON.stringify({ result, active })); return { success: true, active, isLiveWorkbench: result.isLiveWorkbench }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #layout_result_182" in the webview "layout.kqlx" for 30 seconds
    When I wait for "kw-data-table" in the webview for 30 seconds
    Then I collect JSON artifact "layout-height-initial-live" from webview expression "(() => { const first = document.getElementById('layout_result_182'); const second = document.getElementById('layout_result_126'); const editor = document.getElementById('layout_editor_auto'); const url = document.getElementById('layout_url_auto'); const heights = [first?.serialize?.().resultsHeightPx, second?.serialize?.().resultsHeightPx]; const inline = [document.getElementById('layout_result_182_results_wrapper')?.style.height, document.getElementById('layout_result_126_results_wrapper')?.style.height]; if (heights[0] !== 182 || heights[1] !== 126 || inline[0] !== '182px' || inline[1] !== '126px' || editor?.serialize?.().editorHeightPx !== undefined || url?.createDocumentState?.().outputHeightPx !== undefined) throw new Error('Passive layout differs from source: ' + JSON.stringify({ heights, inline, editor: editor?.serialize?.().editorHeightPx, url: url?.createDocumentState?.().outputHeightPx })); return { heights, inline, editorHeight: null, urlHeight: null }; })()"
    When I wait 2 seconds
    Then I collect JSON artifact "layout-height-open-bytes" from extension host expression "globalThis.__layoutHeightFixture.verify('open-idle')"
    Then I collect JSON artifact "layout-height-hidden" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; await vscode.commands.executeCommand('vscode.openWith', fixture.otherUri, 'kusto.kqlxEditor', { preview: false }); return fixture.verify('hidden'); })()"
    When I wait 2 seconds
    Then I collect JSON artifact "layout-height-hidden-idle" from extension host expression "globalThis.__layoutHeightFixture.verify('hidden-idle')"
    Then I collect JSON artifact "layout-height-closed" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(item => item.input?.uri?.toString() === fixture.uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not close the exact layout tab cleanly'); return fixture.verify('closed'); })()"
    Then I collect JSON artifact "layout-height-reactivated" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const call = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file', { toolInvocationToken: undefined, input: { targetFileUri: fixture.uri.toString() } }); const result = JSON.parse(String(call.content.find(part => typeof part?.value === 'string')?.value || '{}')); if (!result.success || vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== fixture.uri.toString()) throw new Error('Tool did not reactivate the same file: ' + JSON.stringify(result)); return { success: true, uri: result.uri }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #layout_url_auto" in the webview "layout.kqlx" for 30 seconds
    Then I collect JSON artifact "layout-height-reopened-live" from webview expression "(() => { const first = document.getElementById('layout_result_182'); const second = document.getElementById('layout_result_126'); const editor = document.getElementById('layout_editor_auto'); const url = document.getElementById('layout_url_auto'); const inline = [document.getElementById('layout_result_182_results_wrapper')?.style.height, document.getElementById('layout_result_126_results_wrapper')?.style.height]; if (inline[0] !== '182px' || inline[1] !== '126px' || first?.serialize?.().resultsHeightPx !== 182 || second?.serialize?.().resultsHeightPx !== 126 || editor?.serialize?.().editorHeightPx !== undefined || url?.createDocumentState?.().outputHeightPx !== undefined) throw new Error('Reopened layout differs from source: ' + JSON.stringify({ inline, first: first?.serialize?.(), second: second?.serialize?.(), editor: editor?.serialize?.(), url: url?.createDocumentState?.() })); return { inline, editorHeight: null, urlHeight: null }; })()"
    When I wait 2 seconds
    Then I collect JSON artifact "layout-height-reopened-bytes" from extension host expression "globalThis.__layoutHeightFixture.verify('reopen-idle')"
    Then I collect JSON artifact "layout-height-loaded-url" from webview expression "(async () => { const section = document.getElementById('layout_url_auto'); const url = section?.createDocumentState?.().url; if (!section || url !== 'https://example.invalid/layout.csv') throw new Error('URL section did not restore'); const requestId = 'layout-local-csv'; const body = 'Value' + String.fromCharCode(10) + '1'; section._activeFetchRequest = { requestId, url }; section._fetchState = { ...section._fetchState, url, expanded: true, loading: true, loaded: false, error: '' }; window.dispatchEvent(new MessageEvent('message', { data: { type: 'urlContent', boxId: section.boxId, requestId, requestedUrl: url, url, kind: 'csv', contentType: 'text/csv', status: 200, body, truncated: false, byteLength: body.length } })); await section.updateComplete; await section.updateComplete; await section.shadowRoot?.querySelector('kw-data-table')?.updateComplete; await new Promise(resolve => setTimeout(resolve, 200)); const visualHeight = section.shadowRoot?.getElementById('output-wrapper')?.style.height; if (!visualHeight || section.createDocumentState().outputHeightPx !== undefined) throw new Error('URL auto-fit was persisted: ' + JSON.stringify({ visualHeight, state: section.createDocumentState() })); return { visualHeight, authoredHeight: null }; })()"
    When I wait 2 seconds
    Then I collect JSON artifact "layout-height-url-auto-bytes" from extension host expression "globalThis.__layoutHeightFixture.verify('url-auto-idle')"
    Then I collect JSON artifact "layout-height-controls" from webview expression "(() => { const section = document.getElementById('layout_url_auto'); const fit = section?.shadowRoot?.querySelector('kw-section-shell')?.shadowRoot?.querySelector('.md-max-btn'); const resizer = section?.shadowRoot?.querySelector('.resizer'); if (!fit || !resizer) throw new Error('Rendered URL Fit controls are missing'); fit.setAttribute('data-testid', 'layout-url-fit'); resizer.setAttribute('data-testid', 'layout-url-resizer'); fit.scrollIntoView({ block: 'center' }); return { fitTitle: fit.title, resizerTitle: resizer.title }; })()"
    When I click "[data-testid='layout-url-fit']" in the webview
    Then I collect JSON artifact "layout-height-user-fit" from webview expression "(() => { const section = document.getElementById('layout_url_auto'); const height = section?.createDocumentState?.().outputHeightPx; const visual = section?.shadowRoot?.getElementById('output-wrapper')?.style.height; if (!Number.isFinite(height) || height < 120 || visual !== height + 'px') throw new Error('Rendered Fit control did not author the URL height: ' + JSON.stringify({ height, visual })); return { height, visual }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "layout-height-user-saved" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const actual = Buffer.from(await vscode.workspace.fs.readFile(fixture.uri)); const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === fixture.uri.toString()); const sections = JSON.parse(actual.toString('utf8')).state.sections; if (!document?.isDirty && sections[3].outputHeightPx >= 120) { if (sections[0].resultsHeightPx !== 182 || sections[1].resultsHeightPx !== 126 || 'editorHeightPx' in sections[2]) throw new Error('User URL Fit changed unrelated saved heights: ' + JSON.stringify(sections.map(section => ({ id: section.id, editorHeightPx: section.editorHeightPx, resultsHeightPx: section.resultsHeightPx })))); return { dirty: false, outputHeightPx: sections[3].outputHeightPx, resultsHeights: [182, 126], editorHeightAbsent: true }; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Explicit URL Fit was not saved'); })()"
    When I double click "[data-testid='layout-url-resizer']" in the webview
    Then I collect JSON artifact "layout-height-user-double-fit" from webview expression "(() => { const section = document.getElementById('layout_url_auto'); const height = section?.createDocumentState?.().outputHeightPx; if (!Number.isFinite(height) || height < 120) throw new Error('URL resizer double-click did not retain an authored height'); return { height }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "layout-height-authored-saved" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const deadline = Date.now() + 10000; while (Date.now() < deadline) { const bytes = Buffer.from(await vscode.workspace.fs.readFile(fixture.uri)); const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === fixture.uri.toString()); const sections = JSON.parse(bytes.toString('utf8')).state.sections; if (!document?.isDirty && sections[3].outputHeightPx >= 120) { fixture.savedUrlHeight = sections[3].outputHeightPx; return { dirty: false, outputHeightPx: fixture.savedUrlHeight, resultHeights: [sections[0].resultsHeightPx, sections[1].resultsHeightPx] }; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Double-click Fit was not saved'); })()"
    Then I collect JSON artifact "layout-height-authored-closed" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(item => item.input?.uri?.toString() === fixture.uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not close the saved URL fixture'); return { savedUrlHeight: fixture.savedUrlHeight, closed: true }; })()"
    Then I collect JSON artifact "layout-height-authored-reactivated" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const call = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file', { toolInvocationToken: undefined, input: { targetFileUri: fixture.uri.toString() } }); const result = JSON.parse(String(call.content.find(part => typeof part?.value === 'string')?.value || '{}')); if (!result.success || vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== fixture.uri.toString()) throw new Error('Authored-height tool reactivation failed: ' + JSON.stringify(result)); return { success: true, savedUrlHeight: fixture.savedUrlHeight }; })()"
    When I wait for "body[data-kusto-e2e-ready='true'] #layout_url_auto" in the webview "layout.kqlx" for 30 seconds
    Then I collect JSON artifact "layout-height-authored-restored" from webview expression "(async () => { const section = document.getElementById('layout_url_auto'); const url = section?.createDocumentState?.().url; if (url !== 'https://example.invalid/layout.csv') throw new Error('Restored URL source changed'); const requestId = 'layout-local-csv-restored'; const body = ['Value', '1', '2', '3', '4', '5'].join(String.fromCharCode(10)); section._activeFetchRequest = { requestId, url }; section._fetchState = { ...section._fetchState, url, expanded: true, loading: true, loaded: false, error: '' }; window.dispatchEvent(new MessageEvent('message', { data: { type: 'urlContent', boxId: section.boxId, requestId, requestedUrl: url, url, kind: 'csv', contentType: 'text/csv', status: 200, body, truncated: false, byteLength: body.length } })); await section.updateComplete; await section.updateComplete; const table = section.shadowRoot?.querySelector('kw-data-table'); await table?.updateComplete; await new Promise(resolve => setTimeout(resolve, 200)); const height = section.createDocumentState().outputHeightPx; const visual = section.shadowRoot?.getElementById('output-wrapper')?.style.height; if (table?.rows?.length !== 5 || !Number.isFinite(height) || visual !== height + 'px') throw new Error('Authored URL height did not survive a changed-content reload: ' + JSON.stringify({ rows: table?.rows?.length, height, visual })); section.scrollIntoView({ block: 'center' }); return { rows: table.rows.length, outputHeightPx: height, visual }; })()"
    Then I collect JSON artifact "layout-height-authored-reopen-bytes" from extension host expression "(async () => { const fixture = globalThis.__layoutHeightFixture; const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === fixture.uri.toString()); const sections = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(fixture.uri))).state.sections; if (document?.isDirty || sections[3].outputHeightPx !== fixture.savedUrlHeight || sections[0].resultsHeightPx !== 182 || sections[1].resultsHeightPx !== 126 || 'editorHeightPx' in sections[2]) throw new Error('Authored height or other layout fields changed on reload: ' + JSON.stringify({ dirty: document?.isDirty, expected: fixture.savedUrlHeight, sections })); return { dirty: false, restoredUrlHeight: sections[3].outputHeightPx, resultHeights: [182, 126], editorHeightAbsent: true }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 30, 700
    Then I take a screenshot "layout-height-after-user-fit"
    Then I collect JSON artifact "layout-height-final" from extension host expression "(async () => { const path = process.getBuiltinModule('node:path'); const fixture = globalThis.__layoutHeightFixture; const root = path.resolve(fixture.root.fsPath); const parent = path.resolve(process.env.TEMP || process.cwd()); if (path.dirname(root).toLowerCase() !== parent.toLowerCase() || !path.basename(root).startsWith('kw-layout-height-open-') || path.dirname(fixture.uri.fsPath).toLowerCase() !== root.toLowerCase()) throw new Error('Refusing to delete an unowned layout fixture'); const document = vscode.workspace.textDocuments.find(item => item.uri.toString() === fixture.uri.toString()); const sections = JSON.parse(new TextDecoder().decode(await vscode.workspace.fs.readFile(fixture.uri))).state.sections; if (document?.isDirty || sections[0].resultsHeightPx !== 182 || sections[1].resultsHeightPx !== 126 || 'editorHeightPx' in sections[2] || !(sections[3].outputHeightPx >= 120)) throw new Error('Saved layout lost authored dimensions: ' + JSON.stringify(sections)); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs); const own = tabs.find(tab => tab.input?.uri?.toString() === fixture.uri.toString()); const other = tabs.find(tab => tab.input?.uri?.toString() === fixture.otherUri.toString()); if (!own || !other || own.isDirty || other.isDirty || !await vscode.window.tabGroups.close(own) || !await vscode.window.tabGroups.close(other)) throw new Error('Could not cleanly close only test-owned layout tabs'); await vscode.commands.executeCommand('kustoWorkbench.test.cleanupPersistedResultFixture'); await vscode.workspace.fs.delete(fixture.root, { recursive: true, useTrash: false }); const config = vscode.workspace.getConfiguration('files'); await config.update('autoSave', fixture.previousAutoSave, vscode.ConfigurationTarget.Global); await config.update('autoSaveDelay', fixture.previousDelay, vscode.ConfigurationTarget.Global); delete globalThis.__layoutHeightFixture; return { savedUrlHeight: sections[3].outputHeightPx, savedResultsHeights: [182, 126], editorHeightAbsent: true, deleted: true }; })()"