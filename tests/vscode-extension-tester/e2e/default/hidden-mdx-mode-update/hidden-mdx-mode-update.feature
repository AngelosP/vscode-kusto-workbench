Feature: Mode-only updates of a fresh hidden MDX use its inventory identity

  Scenario: The first hidden default-mode update succeeds without activation
    Given I collect JSON artifact "hidden-mdx-first-attempt" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const os = process.getBuiltinModule('node:os');
        const assert = process.getBuiltinModule('node:assert/strict');
        const hash = text => process.getBuiltinModule('node:crypto').createHash('sha256').update(text).digest('hex');
        const tabs = () => vscode.window.tabGroups.all.flatMap(group => group.tabs);
        assert.equal(tabs().length, 0, 'Use a fresh workspace; never reset existing editor tabs');
        assert.equal(globalThis.__hiddenMdxMode, undefined);
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-hidden-mdx-mode-'));
        const state = { root, uris: [], calls: [], activationCount: 0 };
        globalThis.__hiddenMdxMode = state;
        const invoke = async (name, input) => {
          const start = performance.now();
          const record = { name, input };
          state.calls.push(record);
          const response = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
          const text = response.content.filter(part => typeof part?.value === 'string').map(part => part.value).join('\n');
          if (text.startsWith('Error:')) record.error = text;
          else record.value = JSON.parse(text);
          record.elapsedMs = performance.now() - start;
          return record;
        };
        state.invoke = invoke;
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        assert.ok(extension);
        await extension.activate();
        const content = '## Hidden MDX mode regression\n\nPreserve this content.';
        const create = async (type, name, initialContent) => {
          const record = await invoke('kusto-workbench_create-file', {
            fileType: type, filePath: path.join(root, name), initialContent, reveal: false,
          });
          assert.equal(record.value?.success, true, 'File creation failed: ' + JSON.stringify(record));
          const uri = vscode.Uri.file(record.value.filePath);
          state.uris.push(uri.toString());
          return uri;
        };
        const uri = await create('mdx', 'editable-notes', content);
        state.uri = uri.toString();
        state.file = uri.fsPath;
        const original = fs.readFileSync(uri.fsPath, 'utf8');
        const originalSection = JSON.parse(original).state.sections[0];
        assert.equal(originalSection.type, 'markdown');
        assert.equal(originalSection.text, content);
        assert.equal(originalSection.id, undefined);
        assert.equal(originalSection.mode, undefined);
        state.original = original;
        for (const type of ['kqlx', 'sqlx', 'kql', 'csl', 'md', 'kql-sidecar', 'csl-sidecar']) {
          const other = await create(type, 'other-' + type, type === 'sqlx' ? 'SELECT 1 AS Other' : type === 'md' ? '# Other' : 'print Other = 1');
          if (type === 'kqlx') state.distractorUri = other.toString();
        }
        const deadline = performance.now() + 30000;
        let target;
        while (performance.now() < deadline) {
          const listed = await invoke('kusto-workbench_list-sections', {});
          target = listed.value?.openFiles?.find(file => file.uri === state.uri);
          if (target?.isLiveWorkbench && !target.isActive && target.sections?.length === 1 && target.sections[0].id !== 'section_0') break;
          if (performance.now() >= deadline) break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(target?.isLiveWorkbench, true, 'No live MDX inventory metadata');
        assert.equal(target?.isActive, false, 'MDX was not hidden before the first call');
        assert.equal(target.sections.length, 1);
        assert.equal(target.sections[0].type, 'markdown');
        assert.notEqual(target.sections[0].id, 'section_0');
        const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === state.uri);
        assert.ok(document);
        assert.equal(document.isDirty, false);
        assert.equal(document.getText(), original);
        assert.equal(fs.readFileSync(state.file, 'utf8'), original);
        state.input = { targetFileUri: state.uri, sectionId: target.sections[0].id, mode: 'wysiwyg' };
        state.first = await invoke('kusto-workbench_update-markdown-section', state.input);
        const after = await invoke('kusto-workbench_list-sections', {});
        const current = after.value?.openFiles?.find(file => file.uri === state.uri);
        assert.equal(current?.isActive, false, 'Mode update activated the target');
        assert.equal(current?.sections?.[0]?.id, state.input.sectionId, 'Inventory identity changed');
        assert.equal(document.getText(), original, 'Default-mode update rewrote the buffer');
        assert.equal(document.isDirty, false, 'Default-mode update dirtied the document');
        assert.equal(fs.readFileSync(state.file, 'utf8'), original, 'Default-mode update rewrote saved bytes');
        state.files = fs.readdirSync(root).map(name => path.join(root, name));
        return { root, targetUri: state.uri, sectionId: state.input.sectionId, first: state.first,
          hiddenBefore: true, hiddenAfter: true, byteStable: true, originalSha256: hash(original), activationCount: 0 };
      })()
      """
    Then I collect JSON artifact "hidden-mdx-activation-control" from extension host expression:
      """
      (async () => {
        const assert = process.getBuiltinModule('node:assert/strict');
        const fs = process.getBuiltinModule('node:fs');
        const state = globalThis.__hiddenMdxMode;
        state.activationCount++;
        const activation = await state.invoke('kusto-workbench_activate-workbench-file', { targetFileUri: state.uri });
        assert.equal(activation.value?.success, true);
        assert.equal(activation.value?.isLiveWorkbench, true);
        assert.equal(activation.value?.uri, state.uri);
        assert.equal(vscode.window.tabGroups.all.some(group => group.isActive && group.activeTab?.input?.uri?.toString() === state.uri), true);
        state.control = await state.invoke('kusto-workbench_update-markdown-section', state.input);
        assert.equal(state.control.value?.success, true, 'Identical call failed after ordinary activation');
        const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === state.uri);
        assert.ok(document);
        assert.equal(document.isDirty, false);
        assert.equal(document.getText(), state.original);
        assert.equal(fs.readFileSync(state.file, 'utf8'), state.original);
        return { activationCount: state.activationCount, control: state.control, byteStable: true };
      })()
      """
    When I wait for "kw-markdown-section" in the webview "editable-notes.mdx" for 30 seconds
    Then I collect JSON artifact "mdx-visible-default-mode" from webview expression "(() => { const section = document.querySelector('kw-markdown-section'); const button = section?.shadowRoot?.querySelector('.md-mode-btn[role=tab][aria-selected=true]'); const mode = button?.getAttribute('aria-label'); if (mode !== 'WYSIWYG') throw new Error('Expected the visible MDX WYSIWYG mode, got ' + mode); return { sectionId: section.id, mode }; })()"
    Then the webview "editable-notes.mdx" should contain "Hidden MDX mode regression"
    Then I collect JSON artifact "hidden-mdx-retire-distractors" from extension host expression:
      """
      (async () => {
        const state = globalThis.__hiddenMdxMode;
        const assert = process.getBuiltinModule('node:assert/strict');
        const others = new Set(state.uris.filter(uri => uri !== state.uri));
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => others.has(tab.input?.uri?.toString()));
        assert.equal(tabs.some(tab => tab.isDirty), false);
        assert.equal(await vscode.window.tabGroups.close(tabs, true), true);
        assert.equal(vscode.window.tabGroups.all.some(group => group.isActive && group.activeTab?.input?.uri?.toString() === state.uri), true);
        return { closedOwnedDistractors: tabs.length, targetStillActive: true, measuredCallsAlreadyComplete: true };
      })()
      """
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I press "Escape"
    Then I take a screenshot "mdx-default-mode-control"
    Then I collect JSON artifact "hidden-mdx-nondefault-save-reopen" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const assert = process.getBuiltinModule('node:assert/strict');
        const state = globalThis.__hiddenMdxMode;
        const content = '## Hidden preview persistence\n\nKeep this second document independent.';
        const created = await state.invoke('kusto-workbench_create-file', {
          fileType: 'mdx', filePath: path.join(state.root, 'preview-notes'), initialContent: content, reveal: false,
        });
        assert.equal(created.value?.success, true);
        const uri = vscode.Uri.file(created.value.filePath).toString();
        const file = created.value.filePath;
        state.uris.push(uri);
        state.files.push(file);
        state.preview = { uri, file, content };
        const original = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(original.state.sections.length, 1);
        assert.equal(original.state.sections[0].id, undefined);
        assert.equal(original.state.sections[0].mode, undefined);
        const other = await state.invoke('kusto-workbench_activate-workbench-file', { targetFileUri: state.distractorUri });
        assert.equal(other.value?.success, true);
        const deadline = performance.now() + 30000;
        let target;
        while (performance.now() < deadline) {
          const listed = await state.invoke('kusto-workbench_list-sections', {});
          target = listed.value?.openFiles?.find(candidate => candidate.uri === uri);
          if (target?.isLiveWorkbench && !target.isActive && target.sections?.[0]?.id && target.sections[0].id !== 'section_0') break;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(target?.isLiveWorkbench, true);
        assert.equal(target?.isActive, false);
        assert.equal(target.sections.length, 1);
        assert.notEqual(target.sections[0].id, 'section_0');
        state.preview.first = await state.invoke('kusto-workbench_update-markdown-section', {
          targetFileUri: uri, sectionId: target.sections[0].id, mode: 'preview',
        });
        assert.equal(state.preview.first.value?.success, true, 'First hidden nondefault mode call failed');
        const saved = await state.invoke('kusto-workbench_save-workbench-file', { targetFileUri: uri });
        assert.equal(saved.value?.success, true);
        assert.equal(saved.value?.saved, true);
        const durable = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.equal(durable.state.sections.length, 1);
        assert.equal(durable.state.sections[0].text, content);
        assert.equal(durable.state.sections[0].mode, 'preview');
        assert.equal(fs.readFileSync(state.file, 'utf8'), state.original, 'Updating the second document changed the first');
        const targetTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri);
        assert.equal(targetTabs.length, 1);
        assert.equal(targetTabs[0].isActive, false, 'Update or Save revealed the target');
        assert.equal(targetTabs[0].isDirty, false);
        assert.equal(state.calls.filter(call => call.name === 'kusto-workbench_activate-workbench-file' && call.input.targetFileUri === uri).length, 0);
        assert.equal(await vscode.window.tabGroups.close(targetTabs, true), true);
        const reopened = await state.invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri });
        assert.equal(reopened.value?.success, true);
        assert.equal(reopened.value?.isLiveWorkbench, true);
        return { firstHiddenCall: state.preview.first, savedMode: durable.state.sections[0].mode,
          contentPreserved: true, noRevealBeforeClose: true, reopened: true, firstDocumentUnchanged: true };
      })()
      """
    When I wait for "kw-markdown-section" in the webview "preview-notes.mdx" for 30 seconds
    Then I collect JSON artifact "mdx-restored-preview-mode" from webview expression "(() => { const section = document.querySelector('kw-markdown-section'); const mode = section?.shadowRoot?.querySelector('.md-mode-btn[role=tab][aria-selected=true]')?.getAttribute('aria-label'); if (mode !== 'Preview') throw new Error('Saved Preview mode did not reopen: ' + mode); return { sectionId: section.id, mode }; })()"
    Then the webview "preview-notes.mdx" should contain "Hidden preview persistence"
    Then I take a screenshot "mdx-preview-after-reopen"
    Then I collect JSON artifact "hidden-mdx-default-after-reopen" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const assert = process.getBuiltinModule('node:assert/strict');
        const state = globalThis.__hiddenMdxMode;
        const { uri, file, content } = state.preview;
        const listed = await state.invoke('kusto-workbench_list-sections', {});
        const target = listed.value?.openFiles?.find(candidate => candidate.uri === uri);
        assert.equal(target?.isLiveWorkbench, true);
        assert.equal(target.sections.length, 1);
        const other = await state.invoke('kusto-workbench_activate-workbench-file', { targetFileUri: state.distractorUri });
        assert.equal(other.value?.success, true);
        const updated = await state.invoke('kusto-workbench_update-markdown-section', {
          targetFileUri: uri, sectionId: target.sections[0].id, mode: 'wysiwyg',
        });
        assert.equal(updated.value?.success, true);
        const saved = await state.invoke('kusto-workbench_save-workbench-file', { targetFileUri: uri });
        assert.equal(saved.value?.success, true);
        const savedText = fs.readFileSync(file, 'utf8');
        const durable = JSON.parse(savedText);
        const section = durable.state.sections[0];
        assert.equal(durable.state.sections.length, 1);
        assert.equal(section.text, content);
        assert.equal(section.mode ?? (section.tab === 'preview' ? 'preview' : 'wysiwyg'), 'wysiwyg');
        const invalid = await state.invoke('kusto-workbench_update-markdown-section', {
          targetFileUri: uri, sectionId: 'missing_mdx_section', mode: 'preview',
        });
        assert.match(invalid.error ?? '', /Markdown section not found/);
        assert.equal(fs.readFileSync(file, 'utf8'), savedText, 'Invalid ID changed saved bytes');
        const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri);
        assert.ok(document);
        assert.equal(document.getText(), savedText);
        assert.equal(document.isDirty, false);
        const targetTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri);
        assert.equal(targetTabs.length, 1);
        assert.equal(targetTabs[0].isActive, false);
        assert.equal(await vscode.window.tabGroups.close(targetTabs, true), true);
        const reopened = await state.invoke('kusto-workbench_activate-workbench-file', { targetFileUri: uri });
        assert.equal(reopened.value?.success, true);
        assert.equal(reopened.value?.isLiveWorkbench, true);
        assert.equal(fs.readFileSync(state.file, 'utf8'), state.original);
        return { defaultRestored: true, hiddenUpdateSucceeded: true, invalidIdRejected: true,
          firstDocumentUnchanged: true, reopened: true };
      })()
      """
    When I wait for "kw-markdown-section" in the webview "preview-notes.mdx" for 30 seconds
    Then I collect JSON artifact "mdx-restored-default-mode" from webview expression "(() => { const section = document.querySelector('kw-markdown-section'); const mode = section?.shadowRoot?.querySelector('.md-mode-btn[role=tab][aria-selected=true]')?.getAttribute('aria-label'); if (mode !== 'WYSIWYG') throw new Error('Default mode did not reopen: ' + mode); return { sectionId: section.id, mode }; })()"
    Then the webview "preview-notes.mdx" should contain "Hidden preview persistence"
    Then I take a screenshot "mdx-default-after-second-reopen"
    Then I collect JSON artifact "hidden-mdx-cleanup" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const assert = process.getBuiltinModule('node:assert/strict');
        const state = globalThis.__hiddenMdxMode;
        const owned = new Set(state.uris);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => owned.has(tab.input?.uri?.toString()));
        assert.equal(tabs.some(tab => tab.isDirty), false, 'Preserve an unexpectedly dirty test document');
        assert.equal(await vscode.window.tabGroups.close(tabs, true), true);
        assert.equal(vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => owned.has(tab.input?.uri?.toString())), false);
        for (const file of state.files) {
          assert.equal(path.relative(state.root, path.dirname(file)), '');
          assert.equal(fs.lstatSync(file).isFile(), true);
          assert.equal(fs.lstatSync(file).isSymbolicLink(), false);
          fs.unlinkSync(file);
        }
        fs.rmdirSync(state.root);
        return { closedOwnedTabs: tabs.length, deletedOwnedFiles: state.files.length };
      })()
      """
    Then I collect JSON artifact "hidden-mdx-first-call-assertion" from extension host expression "(() => { const state = globalThis.__hiddenMdxMode; if (state.first.value?.success !== true) throw new Error('First hidden mode-only call failed before activation: ' + JSON.stringify(state.first)); return { firstSucceeded: true, controlSucceeded: state.control.value?.success === true, activationCount: state.activationCount }; })()"
