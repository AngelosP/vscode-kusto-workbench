Feature: Published Workbench notebook lifecycle does not append its own ending

  Scenario: Observe normal section tools and native Save through the published webview
    Given I collect JSON artifact "published-isolation" from extension host expression "(() => { const fs = process.getBuiltinModule('node:fs'); const configPath = process.env.KW_PUBLISHED_REPLAY_CONFIG; if (!configPath) throw new Error('Launch through scripts/repro-published-notebook.mjs'); const config = JSON.parse(fs.readFileSync(configPath, 'utf8')); const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench'); if (!extension || extension.extensionPath.toLowerCase() !== config.expectedExtensionPath.toLowerCase()) throw new Error('Wrong installed extension/profile'); if (vscode.workspace.workspaceFolders?.length || vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Expected an empty isolated window'); return { attemptId: config.attemptId, extensionPath: extension.extensionPath, editorVersion: vscode.version }; })()"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "published-lifecycle-start" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (!extension || extension.extensionPath.toLowerCase() !== config.expectedExtensionPath.toLowerCase()) throw new Error('Wrong installed extension');
        if (extension.packageJSON.version !== config.expectedExtensionVersion || vscode.version !== config.expectedEditorVersion) throw new Error('Unexpected package/editor version');
        if (hash(fs.readFileSync(path.join(extension.extensionPath, extension.packageJSON.main))) !== config.expectedExtensionSha256) throw new Error('Installed extension differs from VSIX');
        if (hash(fs.readFileSync(config.helperPath)) !== config.helperSha256) throw new Error('Journal helper differs from recorded copy');
        await extension.activate();
        if ((await vscode.commands.getCommands(true)).some(name => name.startsWith('kustoWorkbench.test.'))) throw new Error('Published package unexpectedly exposes development-only commands');
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(config.fixtureParent, 'kw-published-lifecycle-')));
        const uri = vscode.Uri.joinPath(root, 'synthetic.kqlx');
        const otherUri = vscode.Uri.joinPath(root, 'other.kqlx');
        const settings = vscode.workspace.getConfiguration('files', { uri, languageId: 'kqlx' });
        if (settings.get('autoSave') !== config.autoSave || settings.get('autoSaveDelay') !== config.autoSaveDelay) throw new Error('Effective Auto Save differs from replay config');
        const largeRows = Array.from({ length: 2578 }, (_, index) => [{ display: String(index), full: 'V'.repeat(2120) }]);
        const sections = Array.from({ length: 4 }, (_, index) => ({
          id: 'query_published_' + index, type: 'query', name: 'Synthetic ' + index,
          expanded: index === 0, resultsVisible: true, query: 'print Value=' + index,
          resultJson: JSON.stringify({ columns: [{ name: 'Payload', type: 'string' }], rows: index === 0 ? largeRows : [[{ display: String(index), full: 'S'.repeat(100) }]] }),
        }));
        const initial = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } }, null, 2).replace(/\n/g, '\r\n') + '\r\n';
        if (config.baselineInitialHash && hash(initial) !== config.baselineInitialHash) throw new Error('Fixture differs from original failed attempt');
        await vscode.workspace.fs.writeFile(uri, Buffer.from(initial, 'utf8'));
        await vscode.workspace.fs.writeFile(otherUri, Buffer.from('{"kind":"kqlx","version":1,"state":{"sections":[]}}'));
        const require = process.getBuiltinModule('node:module').createRequire(config.helperPath);
        const journal = await require(config.helperPath).createJournal({ fixtureRoot: root.fsPath, evidenceRoot: config.evidenceRoot, initialText: initial, mode: config.mode });
        const settingsSnapshot = key => JSON.parse(JSON.stringify(settings.inspect(key), (_field, value) => value === undefined ? null : value));
        const trace = { provenance: { ...config, effectiveSettings: { autoSave: settingsSnapshot('autoSave'), autoSaveDelay: settingsSnapshot('autoSaveDelay') }, initialHash: hash(initial), interaction: 'registered-tool-replay', visualReview: 'unavailable' }, fixtureUri: uri.toString(), phase: 'before-open', operations: [], observerFailures: [], verdict: 'INCOMPLETE' };
        let profiler;
        let profileStop;
        const profileCommand = (method, parameters = {}) => new Promise((resolve, reject) => profiler.post(method, parameters, (error, value) => error ? reject(error) : resolve(value)));
        if (config.profileHostCpu === true) {
          profiler = new (process.getBuiltinModule('node:inspector').Session)();
          profiler.connect();
          await profileCommand('Profiler.enable');
          await profileCommand('Profiler.start');
        }
        const stopHostProfile = () => profileStop ?? (profileStop = (async () => {
          if (!profiler) return;
          trace.profileStopWindow = { startedAt: Date.now(), finishedAt: null };
          try {
            const result = await profileCommand('Profiler.stop');
            await fs.promises.writeFile(path.join(config.evidenceRoot, 'extension-host.cpuprofile'), JSON.stringify(result.profile));
          } catch (error) { trace.profileError = String(error.message); }
          finally { profiler.disconnect(); trace.profileStopWindow.finishedAt = Date.now(); }
        })());
        const generations = new WeakMap();
        let nextGeneration = 0;
        const generation = document => { if (!generations.has(document)) generations.set(document, ++nextGeneration); return generations.get(document); };
        const saveTrace = async () => { await journal.flush(); await fs.promises.writeFile(path.join(config.evidenceRoot, 'lifecycle-summary.json'), JSON.stringify({ ...trace, journal: journal.summary() }, null, 2)); };
        const same = document => document.uri.toString() === uri.toString();
        const observe = (document, event, extra = {}) => {
          try { journal.capture(config.mode === 'minimal' ? undefined : document.getText(), { phase: event + ':' + trace.phase, openGeneration: generation(document), documentVersion: document.version, capturedAt: Date.now(), ...extra }); }
          catch (error) { trace.observerFailures.push(String(error.message)); }
        };
        const observers = [
          vscode.workspace.onDidOpenTextDocument(document => { if (same(document)) observe(document, 'open'); }),
          vscode.workspace.onDidChangeTextDocument(event => { if (same(event.document) && event.contentChanges.length) observe(event.document, 'change', { changes: event.contentChanges.map(change => ({ offset: change.rangeOffset, removedLength: change.rangeLength, insertedLength: change.text.length })) }); }),
          vscode.workspace.onWillSaveTextDocument(event => { if (same(event.document)) observe(event.document, 'will-save', { reason: event.reason }); }),
          vscode.workspace.onDidSaveTextDocument(document => { if (same(document)) observe(document, 'did-save'); }),
          vscode.workspace.onDidCloseTextDocument(document => { if (same(document)) journal.note({ phase: 'close:' + trace.phase, openGeneration: generation(document), documentVersion: document.version }); }),
        ];
        const sample = async phase => {
          trace.phase = phase;
          const document = vscode.workspace.textDocuments.find(same);
          const version = document?.version ?? null;
          const buffer = document ? await journal.checkpoint(document.getText(), { phase: 'buffer:' + phase, openGeneration: generation(document), documentVersion: version }) : null;
          const diskText = await fs.promises.readFile(uri.fsPath, 'utf8');
          const disk = await journal.checkpoint(diskText, { phase: 'disk:' + phase, diskObservedAtRead: Date.now(), documentVersion: version });
          return { phase, buffer, disk, dirty: document?.isDirty ?? false, stable: !document || document.version === version };
        };
        const reject = async (message, outcome = 'WORKFLOW_FAILED') => {
          trace.verdict = outcome;
          trace.failure = message;
          await new Promise(resolve => setTimeout(resolve, 1500));
          trace.failureSample = await sample('passive-after-failure');
          await saveTrace();
          await stopHostProfile();
          await saveTrace();
          throw new Error(message);
        };
        const invoke = async (name, input) => {
          trace.phase = name;
          const operation = { localOperationId: trace.operations.length + 1, name, startedAt: Date.now(), success: false, input: { ...input } };
          for (const key of ['query', 'text']) if (typeof operation.input[key] === 'string') operation.input[key] = { length: input[key].length, sha256: hash(input[key]) };
          trace.operations.push(operation);
          journal.note({ phase: 'tool-start', ...operation });
          let value;
          try {
            const result = await vscode.lm.invokeTool(name, { toolInvocationToken: undefined, input });
            const text = String(result.content.find(part => typeof part?.value === 'string')?.value || '');
            if (!text || text.startsWith('Error:')) throw new Error(text || 'Empty tool response');
            value = JSON.parse(text);
            operation.response = { success: value.success ?? null, sectionId: value.sectionId ?? value.id ?? null, error: value.error ?? null };
            if (value.success === false) operation.error = value.error || JSON.stringify(value);
            else operation.success = true;
          } catch (error) { operation.error = String(error.message); }
          operation.finishedAt = Date.now();
          journal.note({ phase: 'tool-terminal', ...operation });
          await saveTrace();
          if (!operation.success) {
            if (name === 'kusto-workbench_add-section') return { success: false, sectionId: operation.response?.sectionId ?? null, error: operation.error };
            await reject(name + ': ' + operation.error);
          }
          return value;
        };
        const waitSaved = async (phase, query, noteId = null) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const document = vscode.workspace.textDocuments.find(same);
            if (document && !document.isDirty) {
              const snapshot = await sample(phase);
              const expectedIds = sections.map(section => section.id).concat(noteId ? [noteId] : []);
              const actual = snapshot.disk?.sections;
              if (snapshot.stable && !snapshot.dirty && snapshot.buffer?.sha256 === snapshot.disk?.sha256 && actual?.[0]?.query === hash(query) && JSON.stringify(actual.map(section => section.id)) === JSON.stringify(expectedIds)) {
                if (noteId && (actual[4].title !== 'Synthetic note' || actual[4].text !== hash('Note ' + 'N'.repeat(65000)))) await reject('Saved note content/title mismatch');
                await saveTrace();
                return snapshot;
              }
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          await reject('Native Save did not settle to exact intended bytes: ' + phase);
        };
        globalThis.__publishedLifecycle = { root, uri, otherUri, trace, observers, sample, invoke, journal, saveTrace, waitSaved, reject, stopHostProfile };
        const before = await sample('before-open');
        await saveTrace();
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { version: extension.packageJSON.version, extensionPath: extension.extensionPath, uri: uri.toString(), initialBytes: before.disk.byteLength, initialHash: before.disk.sha256, settings: trace.provenance.effectiveSettings };
      })()
      """
    When I wait for "#query_published_0 .monaco-editor" in the webview "synthetic.kqlx" for 30 seconds
    Then I collect JSON artifact "published-live-restore" from webview expression "(() => { const sections = [...document.querySelectorAll('#queries-container > kw-query-section')]; if (sections.length !== 4 || sections[0].serialize?.().query !== 'print Value=0') throw new Error('Published notebook did not restore its query sections'); window.__publishedProtocolObservations = []; window.addEventListener('message', event => { const message = event.data; if (message?.channel !== 'document-view' || window.__publishedProtocolObservations.length >= 256) return; const scalars = Object.fromEntries(Object.entries(message).filter(([key, value]) => value === null || typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string' && value.length < 300)); window.__publishedProtocolObservations.push({ ...scalars, observedAt: Date.now(), error: message.error?.message ?? null }); }); return { sections: sections.length, resultTables: document.querySelectorAll('kw-data-table').length, protocolCapture: 'passive-host-to-webview' }; })()"
    Then I collect JSON artifact "published-tool-edit" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; const listed = await fixture.invoke('kusto-workbench_list-sections', {}); const file = (listed.openFiles || []).find(entry => String(entry.filePath || '').toLowerCase() === fixture.uri.fsPath.toLowerCase()); if (!file?.openFileId) throw new Error('Published file missing from tool inventory'); fixture.openFileId = file.openFileId; const configured = await fixture.invoke('kusto-workbench_configure-query-section', { openFileId: file.openFileId, sectionId: 'query_published_0', query: 'print Published=1' + String.fromCharCode(10) + '//' + 'Q'.repeat(70000), execute: false }); return { success: configured.success, sample: await fixture.sample('query-grown') }; })()"
    Then I collect JSON artifact "published-hidden" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; await vscode.commands.executeCommand('vscode.openWith', fixture.otherUri, 'kusto.kqlxEditor', { preview: false }); return fixture.sample('hidden'); })()"
    Then I collect JSON artifact "published-reactivated" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; await fixture.invoke('kusto-workbench_activate-workbench-file', { openFileId: fixture.openFileId }); if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== fixture.uri.toString()) throw new Error('Tool activated the wrong notebook'); return fixture.sample('reactivated'); })()"
    Then I collect JSON artifact "published-companion-closed" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === fixture.otherUri.toString()); if (tabs.some(tab => tab.isDirty) || !await vscode.window.tabGroups.close(tabs)) throw new Error('Could not close clean test companion'); return { closed: tabs.length }; })()"
    When I wait for "#query_published_0 .monaco-editor" in the webview "synthetic.kqlx" for 30 seconds
    Then I collect JSON artifact "published-note-added" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; const added = await fixture.invoke('kusto-workbench_add-section', { openFileId: fixture.openFileId, type: 'markdown', name: 'Synthetic note', text: 'Note ' + 'N'.repeat(65000) }); fixture.noteId = added.sectionId || added.id || null; return { noteId: fixture.noteId, result: added, sample: await fixture.sample('note-added') }; })()"
    Then I collect JSON artifact "published-command-terminals" from webview expression "(() => ({ direction: 'host-to-webview-only', messages: window.__publishedProtocolObservations || [] }))()"
    Then I collect JSON artifact "published-add-accepted" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; const operation = fixture.trace.operations.at(-1); if (!operation.success) await fixture.reject('kusto-workbench_add-section: ' + operation.error); if (!fixture.noteId) await fixture.reject('New note identity was not returned'); return { accepted: true, noteId: fixture.noteId }; })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "published-save-terminals" from webview expression "(() => ({ direction: 'host-to-webview-only', messages: window.__publishedProtocolObservations || [] }))()"
    Then I collect JSON artifact "published-first-save" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; return fixture.waitSaved('first-save', 'print Published=1' + String.fromCharCode(10) + '//' + 'Q'.repeat(70000), fixture.noteId); })()"
    Then I collect JSON artifact "published-shrink" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; await fixture.invoke('kusto-workbench_configure-query-section', { openFileId: fixture.openFileId, sectionId: 'query_published_0', query: 'print Published=2', execute: false }); await fixture.invoke('kusto-workbench_remove-section', { openFileId: fixture.openFileId, sectionId: fixture.noteId }); return fixture.sample('shrunk'); })()"
    When I execute command "workbench.action.files.save"
    And I execute command "workbench.action.files.save"
    Then I collect JSON artifact "published-reopen" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; await fixture.waitSaved('before-reopen', 'print Published=2'); const tab = vscode.window.tabGroups.all.flatMap(group => group.tabs).find(entry => entry.input?.uri?.toString() === fixture.uri.toString()); if (!tab || tab.isDirty || !await vscode.window.tabGroups.close(tab)) throw new Error('Could not close exact clean synthetic tab'); await vscode.commands.executeCommand('vscode.openWith', fixture.uri, 'kusto.kqlxEditor', { preview: false }); return fixture.sample('reopened'); })()"
    When I wait for "#query_published_0 .monaco-editor" in the webview "synthetic.kqlx" for 30 seconds
    Then I collect JSON artifact "published-reopened-ui" from webview expression "(() => { const sections = [...document.querySelectorAll('#queries-container > kw-query-section')]; if (sections.length !== 4 || sections[0].serialize?.().query !== 'print Published=2') throw new Error('Published reopened UI differs from saved query'); return { sections: sections.length, query: sections[0].serialize().query }; })()"
    Then I collect JSON artifact "published-after-reopen-edit" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; await fixture.invoke('kusto-workbench_configure-query-section', { openFileId: fixture.openFileId, sectionId: 'query_published_0', query: 'print Published=3', execute: false }); return fixture.sample('after-reopen-edit'); })()"
    When I execute command "workbench.action.files.save"
    Then I collect JSON artifact "published-lifecycle-trace" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; await fixture.waitSaved('finished', 'print Published=3'); const journal = await fixture.journal.flush(); if (journal.harnessFailures.length || fixture.trace.observerFailures.length) await fixture.reject('Incomplete journal capture', 'HARNESS_BLOCKED'); if (journal.events.some(entry => entry.valid === false && entry.invalidOrigin !== 'disk-read')) await fixture.reject('Malformed notebook buffer revision observed', 'CORRUPTION_OBSERVED'); if (journal.events.some(entry => entry.invalidOrigin === 'disk-read')) await fixture.reject('Invalid disk checkpoint may overlap a native write; inspect retained bytes', 'HARNESS_SUSPECT'); if (journal.events.some(entry => entry.preservation?.length)) await fixture.reject('Saved payload or original section identity changed', 'PRESERVATION_FAILED'); if (journal.events.some(entry => entry.rawChanges?.length)) await fixture.reject('Original serialized result payload changed', 'PRESERVATION_FAILED'); fixture.trace.verdict = 'PASS_UNREVIEWED_VISUAL'; await fixture.saveTrace(); await fixture.stopHostProfile(); await fixture.saveTrace(); return { ...fixture.trace, journal }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "published-notebook-after-reopen"
    Then I collect JSON artifact "published-lifecycle-cleanup" from extension host expression "(async () => { const fixture = globalThis.__publishedLifecycle; const path = process.getBuiltinModule('node:path'); if (!path.basename(fixture.root.fsPath).startsWith('kw-published-lifecycle-') || path.dirname(fixture.uri.fsPath).toLowerCase() !== fixture.root.fsPath.toLowerCase()) throw new Error('Refusing non-fixture cleanup'); await fixture.sample('cleanup'); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => [fixture.uri.toString(), fixture.otherUri.toString()].includes(tab.input?.uri?.toString())); if (tabs.some(tab => tab.isDirty) || !await vscode.window.tabGroups.close(tabs)) throw new Error('Could not close clean test-owned tabs'); for (const observer of fixture.observers) observer.dispose(); await fixture.saveTrace(); await fixture.journal.close(); await vscode.workspace.fs.delete(fixture.root, { recursive: true, useTrash: false }); delete globalThis.__publishedLifecycle; return { deleted: true, evidenceRetained: true }; })()"