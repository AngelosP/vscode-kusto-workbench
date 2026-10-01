Feature: Native Save controls retain authored notes and saved results

  Scenario: Native typing, repeated shortcuts, formatting and linked Save survive reopen
    Given I collect JSON artifact "native-save-isolation" from extension host expression "(() => { const fs = process.getBuiltinModule('node:fs'); if (!process.env.KW_PUBLISHED_REPLAY_CONFIG) throw new Error('Launch through scripts/repro-published-notebook.mjs'); const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8')); const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench'); if (extension?.extensionPath.toLowerCase() !== config.expectedExtensionPath.toLowerCase() || config.autoSave !== 'off' || vscode.workspace.workspaceFolders?.length || vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Expected an empty isolated manual-Save profile'); return { version: extension.packageJSON.version, editorVersion: vscode.version, autoSave: config.autoSave }; })()"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "native-save-created" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (extension.packageJSON.version !== config.expectedExtensionVersion || vscode.version !== config.expectedEditorVersion || hash(fs.readFileSync(path.join(extension.extensionPath, extension.packageJSON.main))) !== config.expectedExtensionSha256 || hash(fs.readFileSync(config.helperPath)) !== config.helperSha256) throw new Error('Package or helper provenance mismatch');
        await extension.activate();
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(config.fixtureParent, 'kw-native-save-')));
        const require = process.getBuiltinModule('node:module').createRequire(config.helperPath);
        const { createJournal } = require(config.helperPath);
        const fixtures = [];
        const observers = [];
        const checkpoints = [];
        const failures = [];
        const trace = { provenance: { ...config, baselineApplicability: 'different native-controls fixture', resultProvenance: 'seeded saved results; no query execution' }, operations: [], verdict: 'INCOMPLETE' };
        let active;
        const same = (document, fixture) => document.uri.toString() === fixture.uri.toString();
        const persistEvidence = async () => {
          for (const fixture of fixtures) await fixture.journal.flush();
          await fs.promises.writeFile(path.join(config.evidenceRoot, 'lifecycle-summary.json'), JSON.stringify({ ...trace, fixtureUri: fixtures[0]?.uri.toString(), checkpoints, failures, journal: fixtures[0]?.journal.summary(), relatedJournals: fixtures.slice(1).map(fixture => ({ name: fixture.name, evidenceRoot: fixture.evidenceRoot, journal: fixture.journal.summary() })) }, null, 2));
        };
        const guard = () => {
          if (!active || !vscode.window.state.focused || vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== active.uri.toString()) throw new Error('Native input target is not the focused test notebook');
          return { uri: active.uri.toString(), focused: true };
        };
        const open = async (name, linked = false, formatting = false) => {
          const uri = vscode.Uri.joinPath(root, name + '.kqlx');
          const linkedUri = linked ? vscode.Uri.joinPath(root, name + '.kql') : null;
          const resultJson = JSON.stringify({ columns: [{ name: 'Value', type: 'long' }], rows: [[7], [9]] });
          const query = { id: 'save_query', type: 'query', name: 'Saved values', expanded: true, editorHeightPx: 110, resultsHeightPx: 110, resultsVisible: true, resultJson };
          if (linked) { query.linkedQueryPath = name + '.kql'; await vscode.workspace.fs.writeFile(linkedUri, Buffer.from('print Linked=1', 'utf8')); }
          else query.query = 'print Saved=7';
          const initial = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [query, { id: 'save_markdown', type: 'markdown', title: 'Native note', text: 'Native baseline', mode: 'wysiwyg', expanded: true }] } }, null, 2) + (formatting ? '   ' : '\n');
          await vscode.workspace.fs.writeFile(uri, Buffer.from(initial, 'utf8'));
          const evidenceRoot = fixtures.length ? path.join(config.evidenceRoot, name) : config.evidenceRoot;
          fs.mkdirSync(evidenceRoot, { recursive: true });
          const journal = await createJournal({ fixtureRoot: root.fsPath, evidenceRoot, initialText: initial });
          const fixture = { name, uri, linkedUri, resultJson, journal, evidenceRoot, phase: 'open', initialHash: hash(initial), settings: JSON.parse(JSON.stringify(vscode.workspace.getConfiguration('files', { uri, languageId: 'kqlx' }).inspect('autoSave'), (_key, value) => value === undefined ? null : value)), saveEvents: [], generation: 0 };
          const generations = new WeakMap();
          const capture = (document, event, extra = {}) => {
            try {
              if (!generations.has(document)) generations.set(document, ++fixture.generation);
              fixture.journal.capture(document.getText(), { phase: event + ':' + fixture.phase, openGeneration: generations.get(document), documentVersion: document.version, ...extra });
            } catch (error) { failures.push(String(error.message)); }
          };
          observers.push(vscode.workspace.onDidOpenTextDocument(document => { if (same(document, fixture)) capture(document, 'open'); }));
          observers.push(vscode.workspace.onDidChangeTextDocument(event => { if (same(event.document, fixture) && event.contentChanges.length) capture(event.document, 'change'); }));
          observers.push(vscode.workspace.onWillSaveTextDocument(event => { const resource = same(event.document, fixture) ? 'notebook' : event.document.uri.toString() === fixture.linkedUri?.toString() ? 'linked' : null; if (resource) { fixture.saveEvents.push({ phase: fixture.phase, resource, event: 'will', at: Date.now(), reason: event.reason, version: event.document.version }); if (resource === 'notebook') capture(event.document, 'will-save', { reason: event.reason }); } }));
          observers.push(vscode.workspace.onDidSaveTextDocument(document => { const resource = same(document, fixture) ? 'notebook' : document.uri.toString() === fixture.linkedUri?.toString() ? 'linked' : null; if (resource) { fixture.saveEvents.push({ phase: fixture.phase, resource, event: 'did', at: Date.now(), version: document.version }); if (resource === 'notebook') capture(document, 'did-save'); } }));
          fixtures.push(fixture);
          active = fixture;
          await persistEvidence();
          await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
          if (vscode.workspace.getConfiguration('files', { uri, languageId: 'kqlx' }).get('autoSave') !== 'off') throw new Error('Manual shortcut test requires Auto Save off');
          return { uri: uri.toString(), initialHash: fixture.initialHash, initialTrailingWhitespace: formatting, linked: !!linkedUri };
        };
        const phase = name => { guard(); active.phase = name; active.eventStart = active.saveEvents.length; return { ...guard(), phase: name }; };
        const verify = async (markdown, query = null) => {
          const fixture = active;
          const deadline = Date.now() + 10000;
          let stableSince = 0;
          let stableKey = '';
          while (Date.now() < deadline) {
            const document = vscode.workspace.textDocuments.find(candidate => same(candidate, fixture));
            if (!document || document.isDirty) { stableKey = ''; stableSince = 0; await new Promise(resolve => setTimeout(resolve, 75)); continue; }
            const version = document?.version;
            const disk = await fs.promises.readFile(fixture.uri.fsPath, 'utf8');
            let file;
            try { file = JSON.parse(disk); } catch {
              fixture.transientDiskReads = (fixture.transientDiskReads ?? 0) + 1;
              await fs.promises.writeFile(path.join(fixture.evidenceRoot, 'transient-disk-read-' + fixture.transientDiskReads + '.kqlx'), disk);
              fixture.journal.note({ phase: 'in-progress-disk-read', documentVersion: version, byteLength: Buffer.byteLength(disk), observation: fixture.transientDiskReads });
            }
            const sections = file?.state?.sections;
            const linkedText = fixture.linkedUri ? await fs.promises.readFile(fixture.linkedUri.fsPath, 'utf8') : null;
            const linkedDocument = fixture.linkedUri ? vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === fixture.linkedUri.toString()) : null;
            const linkedClean = !fixture.linkedUri || !!linkedDocument && !linkedDocument.isDirty && linkedDocument.getText() === linkedText;
            const shapeMatches = sections?.length === 2 && sections[0].id === 'save_query' && sections[1].id === 'save_markdown' && sections[0].resultJson === fixture.resultJson && sections[1].title === 'Native note' && sections[1].text?.trimEnd() === markdown && (sections[1].mode ?? 'wysiwyg') === 'wysiwyg';
            const queryMatches = fixture.linkedUri ? sections?.[0]?.linkedQueryPath === fixture.name + '.kql' && !Object.hasOwn(sections[0], 'query') && linkedText?.trimEnd() === query : sections?.[0]?.query === 'print Saved=7';
            if (document && !document.isDirty && document.version === version && document.getText() === disk && shapeMatches && queryMatches && linkedClean) {
              const key = version + ':' + hash(disk) + ':' + hash(linkedText ?? '');
              if (stableKey !== key) { stableKey = key; stableSince = Date.now(); }
              if (Date.now() - stableSince >= 500) {
                const events = fixture.saveEvents.slice(fixture.eventStart ?? 0);
                const savedResource = fixture.linkedUri ? 'linked' : 'notebook';
                if (!events.some(event => event.resource === savedResource && event.event === 'will' && event.reason === 1) || !events.some(event => event.resource === savedResource && event.event === 'did')) throw new Error('Ctrl+S did not cause an observed native Manual Save of the ' + savedResource);
                const entry = await fixture.journal.checkpoint(disk, { phase: 'disk:' + fixture.phase, documentVersion: version });
                const value = { fixture: fixture.name, phase: fixture.phase, dirty: false, hash: entry.sha256, markdown: sections[1].text, linkedText, linkedClean, linkedVersion: linkedDocument?.version ?? null, saveEvents: events, finalNewline: /\r?\n$/.test(disk), settings: { insertFinalNewline: vscode.workspace.getConfiguration('files', fixture.uri).get('insertFinalNewline'), trimTrailingWhitespace: vscode.workspace.getConfiguration('files', fixture.uri).get('trimTrailingWhitespace') } };
                checkpoints.push(value);
                await persistEvidence();
                return value;
              }
            } else { stableKey = ''; stableSince = 0; }
            await new Promise(resolve => setTimeout(resolve, 75));
          }
          trace.verdict = 'WORKFLOW_FAILED';
          trace.failure = 'Native Save did not reach exact stable bytes: ' + fixture.phase;
          await persistEvidence();
          throw new Error(trace.failure);
        };
        const close = async () => {
          if (active.linkedUri && vscode.workspace.textDocuments.some(document => document.uri.toString() === active.linkedUri.toString() && document.isDirty)) throw new Error('Refusing to carry a dirty hidden linked buffer through reopen');
          const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => [active.uri.toString(), active.linkedUri?.toString()].includes(tab.input?.uri?.toString()));
          if (!tabs.length || tabs.some(tab => tab.isDirty) || !await vscode.window.tabGroups.close(tabs)) throw new Error('Refusing non-clean exact-tab cleanup');
          return { closed: tabs.length };
        };
        globalThis.__nativeSave = { root, fixtures, observers, checkpoints, failures, trace, open, phase, guard, verify, close, persistEvidence, get active() { return active; } };
        return open('native');
      })()
      """
    When I wait for "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview "native.kqlx" for 30 seconds
    Then I collect JSON artifact "native-first-target" from extension host expression "globalThis.__nativeSave.phase('first-native-save')"
    When I click "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "document.querySelector('#save_markdown .toastui-editor-ww-container .ProseMirror').focus()" in the webview
    And I press "End"
    And I type " FirstEdit"
    Then I collect JSON artifact "native-first-live" from webview expression "(() => { const section = document.getElementById('save_markdown'); let focused = document.activeElement; while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement; const text = section.serialize().text; const state = { text, tag: focused?.tagName ?? null, className: focused?.className ?? null, documentFocused: document.hasFocus() }; if (!focused?.closest('.ProseMirror') || text.trimEnd() !== 'Native baseline FirstEdit') throw new Error('Native Markdown input/focus did not reach the intended editor: ' + JSON.stringify(state)); return state; })()"
    Then I collect JSON artifact "native-first-save-target" from extension host expression "globalThis.__nativeSave.guard()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "native-first-saved" from extension host expression "globalThis.__nativeSave.verify('Native baseline FirstEdit')"
    Then I collect JSON artifact "native-double-target" from extension host expression "globalThis.__nativeSave.phase('double-shortcut-and-next-edit')"
    When I click "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "document.querySelector('#save_markdown .toastui-editor-ww-container .ProseMirror').focus()" in the webview
    And I press "End"
    And I type " DoubleEdit"
    And I press "Ctrl+S"
    And I press "Ctrl+S"
    And I type " FollowingEdit"
    Then I collect JSON artifact "native-double-live" from webview expression "(() => { const text = document.getElementById('save_markdown').serialize().text; if (text.trimEnd() !== 'Native baseline FirstEdit DoubleEdit FollowingEdit') throw new Error('The edit after double Ctrl+S was lost: ' + text); return { text }; })()"
    Then I collect JSON artifact "native-double-save-target" from extension host expression "globalThis.__nativeSave.guard()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "native-double-saved" from extension host expression "globalThis.__nativeSave.verify('Native baseline FirstEdit DoubleEdit FollowingEdit')"
    Then I collect JSON artifact "native-closed" from extension host expression "globalThis.__nativeSave.close()"
    Then I collect JSON artifact "native-reopened" from extension host expression "(async () => { const fixture = globalThis.__nativeSave.active; await vscode.commands.executeCommand('vscode.openWith', fixture.uri, 'kusto.kqlxEditor', { preview: false }); return { uri: fixture.uri.toString() }; })()"
    When I wait for "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview "native.kqlx" for 30 seconds
    Then I collect JSON artifact "native-reopened-text" from webview expression "(() => { const text = document.getElementById('save_markdown').serialize().text; if (text.trimEnd() !== 'Native baseline FirstEdit DoubleEdit FollowingEdit') throw new Error('Reopened Markdown differs'); return { text }; })()"
    Then I collect JSON artifact "native-reopened-target" from extension host expression "globalThis.__nativeSave.phase('after-reopen-native-save')"
    When I click "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "document.querySelector('#save_markdown .toastui-editor-ww-container .ProseMirror').focus()" in the webview
    And I press "End"
    And I type " ReopenedEdit"
    And I press "Ctrl+S"
    Then I collect JSON artifact "native-reopened-saved" from extension host expression "globalThis.__nativeSave.verify('Native baseline FirstEdit DoubleEdit FollowingEdit ReopenedEdit')"
    Then I collect JSON artifact "native-formatting-created" from extension host expression "(async () => { const fixture = globalThis.__nativeSave; await fixture.close(); const config = vscode.workspace.getConfiguration('files'); await config.update('insertFinalNewline', true, vscode.ConfigurationTarget.Global); await config.update('trimTrailingWhitespace', true, vscode.ConfigurationTarget.Global); await config.update('trimFinalNewlines', true, vscode.ConfigurationTarget.Global); const current = vscode.workspace.getConfiguration('files'); if (!current.get('insertFinalNewline') || !current.get('trimTrailingWhitespace') || !current.get('trimFinalNewlines')) throw new Error('Formatting settings did not apply'); return fixture.open('formatting', false, true); })()"
    When I wait for "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview "formatting.kqlx" for 30 seconds
    Then I collect JSON artifact "native-formatting-target" from extension host expression "globalThis.__nativeSave.phase('formatting-save-and-next-edit')"
    When I click "#save_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "document.querySelector('#save_markdown .toastui-editor-ww-container .ProseMirror').focus()" in the webview
    And I press "End"
    And I type " FormattedEdit"
    And I press "Ctrl+S"
    And I type " FollowingEdit"
    And I press "Ctrl+S"
    Then I collect JSON artifact "native-formatting-saved" from extension host expression "globalThis.__nativeSave.verify('Native baseline FormattedEdit FollowingEdit')"
    Then I collect JSON artifact "native-linked-created" from extension host expression "(async () => { const fixture = globalThis.__nativeSave; await fixture.close(); const settings = vscode.workspace.getConfiguration('files'); for (const key of ['insertFinalNewline', 'trimTrailingWhitespace', 'trimFinalNewlines']) await settings.update(key, false, vscode.ConfigurationTarget.Global); const current = vscode.workspace.getConfiguration('files'); if (['insertFinalNewline', 'trimTrailingWhitespace', 'trimFinalNewlines'].some(key => current.get(key) !== false)) throw new Error('Linked control inherited formatting settings'); return fixture.open('linked', true); })()"
    When I wait for "#save_query .monaco-editor" in the webview "linked.kqlx" for 30 seconds
    Then I collect JSON artifact "native-linked-hydrated" from webview expression "(() => { const editor = window.queryEditors?.save_query; if (editor?.getValue().trimEnd() !== 'print Linked=1') throw new Error('Linked native query was not hydrated'); editor.focus(); return { query: editor.getValue() }; })()"
    Then I collect JSON artifact "native-linked-target" from extension host expression "globalThis.__nativeSave.phase('linked-native-save')"
    When I press "Ctrl+A"
    And I type "print Linked=2222"
    And I press "Ctrl+S"
    Then I collect JSON artifact "native-linked-saved" from extension host expression "globalThis.__nativeSave.verify('Native baseline', 'print Linked=2222')"
    Then I collect JSON artifact "native-linked-reopened" from extension host expression "(async () => { const fixture = globalThis.__nativeSave; const uri = fixture.active.uri; await fixture.close(); await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false }); return { uri: uri.toString() }; })()"
    When I wait for "#save_query .monaco-editor" in the webview "linked.kqlx" for 30 seconds
    Then I collect JSON artifact "native-linked-reopened-ui" from webview expression "(() => { const editor = window.queryEditors?.save_query; if (editor?.getValue().trimEnd() !== 'print Linked=2222') throw new Error('Linked query differs after reopen'); editor.focus(); return { query: editor.getValue() }; })()"
    Then I collect JSON artifact "native-linked-second-target" from extension host expression "globalThis.__nativeSave.phase('linked-post-reopen-save')"
    When I press "Ctrl+A"
    And I type "print Linked=333333"
    Then I collect JSON artifact "native-linked-second-input" from webview expression "(() => { const editor = window.queryEditors?.save_query; const state = { query: editor?.getValue(), editorFocused: editor?.hasTextFocus(), documentFocused: document.hasFocus(), visibility: document.visibilityState }; if (state.query !== 'print Linked=333333' || !state.editorFocused || !state.documentFocused || state.visibility !== 'visible') throw new Error('Post-reopen native input missed the live editor: ' + JSON.stringify(state)); return state; })()"
    Then I collect JSON artifact "native-linked-second-buffers" from extension host expression "(() => { const probe = globalThis.__nativeSave; probe.guard(); const fixture = probe.active; const fs = process.getBuiltinModule('node:fs'); return { notebook: vscode.workspace.textDocuments.filter(document => document.uri.toString() === fixture.uri.toString()).map(document => ({ dirty: document.isDirty, version: document.version })), linked: vscode.workspace.textDocuments.filter(document => document.uri.toString() === fixture.linkedUri.toString()).map(document => ({ dirty: document.isDirty, text: document.getText(), version: document.version })), disk: fs.readFileSync(fixture.linkedUri.fsPath, 'utf8') }; })()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "native-linked-second-saved" from extension host expression "globalThis.__nativeSave.verify('Native baseline', 'print Linked=333333')"
    Then I collect JSON artifact "native-save-complete" from extension host expression "(async () => { const fixture = globalThis.__nativeSave; for (const entry of fixture.fixtures) { const journal = await entry.journal.flush(); if (journal.harnessFailures.length || journal.events.some(event => event.valid === false || event.preservation?.length || event.rawChanges?.length)) throw new Error('Native lifecycle lost data or evidence: ' + entry.name); } if (fixture.failures.length) throw new Error('Native observation failed'); fixture.trace.verdict = 'PASS_UNREVIEWED_VISUAL'; await fixture.persistEvidence(); await fixture.close(); for (const observer of fixture.observers) observer.dispose(); for (const entry of fixture.fixtures) await entry.journal.close(); const result = { checkpoints: fixture.checkpoints, fixturesRetained: fixture.root.fsPath, visualReview: 'unavailable', resultProvenance: 'seeded' }; delete globalThis.__nativeSave; return result; })()"