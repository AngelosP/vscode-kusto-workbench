Feature: Native result restoration cannot corrupt a notebook after its tab closes

  Scenario: A production post-Save edit crosses close before a second native Save
    Given I collect JSON artifact "close-race-isolation" from extension host expression "(() => { if (!process.env.KW_PUBLISHED_REPLAY_CONFIG || !process.env.KW_CLOSE_RACE_BASELINE) throw new Error('Use the isolated published replay runner and a row-free authenticated print ReopenProbe = 1 baseline'); if (vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Expected a fresh isolated profile'); return { isolated: true, visualReview: 'unavailable' }; })()"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "close-race-created" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const createRequire = process.getBuiltinModule('node:module').createRequire;
        const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        if (extension?.extensionPath.toLowerCase() !== config.expectedExtensionPath.toLowerCase() || config.autoSave !== 'off' || !config.cdpPort || vscode.version !== config.expectedEditorVersion) throw new Error('Wrong installed package, editor, or Save configuration');
        const main = path.join(extension.extensionPath, extension.packageJSON.main);
        if (hash(fs.readFileSync(main)) !== config.expectedExtensionSha256 || hash(fs.readFileSync(config.helperPath)) !== config.helperSha256) throw new Error('Package or journal identity differs');
        const initialText = fs.readFileSync(process.env.KW_CLOSE_RACE_BASELINE, 'utf8');
        const baseline = JSON.parse(initialText);
        const query = baseline.state.sections.find(section => section.id === 'q_probe');
        const markdown = baseline.state.sections.find(section => section.id === 'm_probe');
        if (baseline.kind !== 'kqlx' || baseline.state.sections.length !== 2 || query?.query !== 'print ReopenProbe = 1' || query.resultJson || query.resultArtifact || markdown?.text !== 'Baseline notes') throw new Error('Expected the dedicated result-free query/Markdown baseline, not a user notebook');
        await extension.activate();
        const api = createRequire(main)('vscode');
        const root = fs.mkdtempSync(path.join(config.fixtureParent, 'kw-close-race-'));
        const uri = vscode.Uri.file(path.join(root, 'close-race.kqlx'));
        fs.writeFileSync(uri.fsPath, initialText);
        const journal = await createRequire(config.helperPath)(config.helperPath).createJournal({ fixtureRoot: root, evidenceRoot: config.evidenceRoot, initialText });
        const state = { config, uri, journal, events: [], edits: [], observers: [], saveCount: 0, armed: false, held: null, verdict: 'INCOMPLETE', lastEventAt: Date.now() };
        const same = document => document.uri.toString() === uri.toString();
        state.current = () => api.workspace.textDocuments.find(same);
        state.tabs = () => api.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri.toString());
        state.snapshot = document => {
          if (!document) return null;
          const text = document.getText();
          let valid = false;
          try { valid = JSON.parse(text).kind === 'kqlx'; } catch {}
          return { version: document.version, closed: document.isClosed, dirty: document.isDirty, length: text.length, lineCount: document.lineCount, eof: document.positionAt(text.length), hash: hash(text), valid };
        };
        state.record = (kind, fields = {}) => { state.lastEventAt = Date.now(); state.events.push({ kind, at: state.lastEventAt, ...fields }); };
        state.persist = async () => {
          await journal.flush();
          fs.writeFileSync(path.join(config.evidenceRoot, 'lifecycle-summary.json'), JSON.stringify({ provenance: { ...config, faultInjection: 'Delay one unchanged Workbench post-commit result edit until exact tab closure plus 100ms for native document disposal', baselineSha256: hash(initialText) }, fixtureUri: uri.toString(), verdict: state.verdict, failure: state.failure ?? null, harnessError: state.harnessError ?? null, events: state.events, edits: state.edits, outcome: state.outcome ?? null, operations: [], journal: journal.summary() }, null, 2));
        };
        state.observers.push(api.workspace.onDidChangeTextDocument(event => {
          if (!same(event.document)) return;
          const snapshot = state.snapshot(event.document);
          state.record('change', { snapshot, changes: event.contentChanges.map(change => ({ offset: change.rangeOffset, removed: change.rangeLength, inserted: change.text.length })) });
          if (event.contentChanges.length) journal.capture(event.document.getText(), { phase: 'buffer:change', documentVersion: event.document.version });
        }));
        state.observers.push(api.workspace.onDidSaveTextDocument(document => { if (same(document)) { state.saveCount++; state.record('did-save', { saveCount: state.saveCount, snapshot: state.snapshot(document) }); journal.capture(document.getText(), { phase: 'buffer:did-save', documentVersion: document.version }); } }));
        state.observers.push(api.workspace.onDidOpenTextDocument(document => { if (same(document)) state.record('document-open', { snapshot: state.snapshot(document) }); }));
        state.observers.push(api.window.tabGroups.onDidChangeTabs(() => state.record('tabs', { tabs: state.tabs().map(tab => ({ preview: tab.isPreview, dirty: tab.isDirty, active: tab.isActive })) })));
        const originalApply = api.workspace.applyEdit;
        api.workspace.applyEdit = async (edit, metadata) => {
          const entry = edit.entries().find(([resource]) => resource.toString() === uri.toString());
          if (!entry) return originalApply(edit, metadata);
          const document = state.current();
          const item = { ordinal: state.edits.length + 1, at: Date.now(), before: state.snapshot(document), replacements: entry[1].map(replacement => ({ range: replacement.range, length: replacement.newText.length, resultBearing: replacement.newText.includes('resultJson') })), stack: new Error().stack };
          state.edits.push(item);
          state.record('edit-start', { ordinal: item.ordinal });
          if (state.held && !state.held.released) state.harnessError = 'Another production edit overtook the held edit';
          if (state.armed && state.saveCount > 0 && item.replacements.some(replacement => replacement.resultBearing)) {
            state.armed = false;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            state.held = { item, document, release, released: false };
            state.record('held', { ordinal: item.ordinal, snapshot: state.snapshot(document) });
            const timer = setTimeout(() => { state.harnessError = 'Close gate exceeded its safety bound'; release(); }, 5000);
            setImmediate(async () => {
              try {
                if (document.isDirty || state.tabs().length !== 1 || state.tabs()[0].isPreview) throw new Error('Expected one clean pinned tab after native commit');
                const closed = await api.window.tabGroups.close(state.tabs());
                state.record('close-settled', { closed, tabCount: state.tabs().length, snapshot: state.snapshot(document) });
                if (!closed || state.tabs().length) throw new Error('Exact tab did not close before release');
                await new Promise(resolve => setTimeout(resolve, 100));
              } catch (error) { state.harnessError = String(error.message); }
              finally { clearTimeout(timer); state.held.released = true; state.record('release', { ordinal: item.ordinal, snapshot: state.snapshot(document) }); release(); }
            });
            await gate;
          }
          const accepted = await originalApply(edit, metadata);
          state.record('edit-completed', { ordinal: item.ordinal, accepted, oldDocument: state.snapshot(document), currentDocument: state.snapshot(state.current()), sameDocument: document === state.current() });
          return accepted;
        };
        state.restore = () => { state.armed = false; state.held?.release(); api.workspace.applyEdit = originalApply; };
        state.nativeSave = async () => {
          if (api.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== uri.toString()) throw new Error('Wrong native Save target');
          const require = createRequire(path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/bin/vscode-ext-test.js'));
          const client = await require('chrome-remote-interface')({ port: config.cdpPort, target: targets => targets.filter(target => target.type === 'page').find(target => target.url.includes('workbench.html')) });
          try {
            await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
            await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 0 });
          } finally { await client.close(); }
        };
        globalThis.__closeRace = state;
        await state.persist();
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { uri: uri.toString(), packageVersion: extension.packageJSON.version, apiInstanceDistinct: api.workspace !== vscode.workspace };
      })()
      """
    Then I wait for "#q_probe_run_btn:not([disabled])" in the webview "close-race.kqlx" for 30 seconds
    When I click "#q_probe_run_btn" in the webview "close-race.kqlx"
    Then I wait for "#q_probe[data-test-executing='false'][data-test-has-results='true']" in the webview "close-race.kqlx" for 30 seconds
    Then I collect JSON artifact "close-race-arm" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeRace;
        const deadline = Date.now() + 15000;
        while (Date.now() < deadline) {
          const document = state.current();
          const query = JSON.parse(document.getText()).state.sections.find(section => section.id === 'q_probe');
          if (document.isDirty && query.resultJson) {
            const result = JSON.parse(query.resultJson);
            const cell = result.rows[0]?.[0];
            if (query.query !== 'print ReopenProbe = 1' || !result.columns.some(column => (column.name ?? column) === 'ReopenProbe') || result.rows.length !== 1 || String(cell?.full ?? cell) !== '1') throw new Error('Unexpected actual query result');
            if (!state.edits.length) throw new Error('The API hook did not observe the real query persistence edit');
            state.armed = true;
            state.record('armed', { snapshot: state.snapshot(document) });
            return { realQuery: true, capturedProductionEdits: state.edits.length, snapshot: state.snapshot(document) };
          }
          await new Promise(resolve => setTimeout(resolve, 20));
        }
        throw new Error('Actual query result did not reach the dirty source buffer');
      })()
      """
    When I press "Ctrl+S"
    Then I collect JSON artifact "close-race-outcome" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeRace;
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        try {
          const gateDeadline = Date.now() + 8000;
          while (Date.now() < gateDeadline && !state.events.some(event => event.kind === 'release')) await new Promise(resolve => setTimeout(resolve, 20));
          if (!state.saveCount) throw new Error('No native commit; race setup was not reached');
          if (!state.held) {
            state.armed = false;
            if (state.current()?.isDirty) throw new Error('Unsettled native Save without the target restoration');
            const closed = await vscode.window.tabGroups.close(state.tabs());
            state.record('close-without-late-edit', { closed, tabCount: state.tabs().length });
            if (!closed || state.tabs().length) throw new Error('No-edit close did not settle');
            throw new Error('RACE_NOT_REACHED: no post-commit restoration was intercepted');
          }
          const settleDeadline = Date.now() + 10000;
          while (Date.now() < settleDeadline && Date.now() - state.lastEventAt < 1500) await new Promise(resolve => setTimeout(resolve, 20));
          if (Date.now() - state.lastEventAt < 1500 || state.harnessError) throw new Error(state.harnessError ?? 'Lifecycle did not become quiet');
          const beforeSecondSave = state.snapshot(state.current());
          const reopenedTabs = state.tabs().map(tab => ({ preview: tab.isPreview, active: tab.isActive, dirty: tab.isDirty }));
          const reopened = reopenedTabs.length > 0;
          fs.writeFileSync(path.join(state.config.evidenceRoot, 'before-second-save.json'), JSON.stringify({ reopened, snapshot: beforeSecondSave, diskText: fs.readFileSync(state.uri.fsPath, 'utf8') }, null, 2));
          if (state.current()) journalCapture();
          function journalCapture() { state.journal.capture(state.current().getText(), { phase: 'buffer:before-second-save', documentVersion: state.current().version }); }
          if (reopened && state.current()?.isDirty) {
            state.record('second-native-save');
            await state.nativeSave();
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline && state.current()?.isDirty) await new Promise(resolve => setTimeout(resolve, 20));
            if (state.current()?.isDirty) throw new Error('Second native Save did not complete');
          }
          const disk = fs.readFileSync(state.uri.fsPath, 'utf8');
          state.journal.capture(disk, { phase: 'disk:after-second-save' });
          let diskError = null;
          try {
            const parsed = JSON.parse(disk);
            if (parsed.kind !== 'kqlx' || parsed.state.sections.find(section => section.id === 'q_probe')?.query !== 'print ReopenProbe = 1' || parsed.state.sections.find(section => section.id === 'm_probe')?.text !== 'Baseline notes') throw new Error('Saved query or Markdown changed');
          } catch (error) { diskError = String(error.message); }
          const invalid = state.events.filter(event => event.kind === 'change' && !event.snapshot.valid);
          const current = state.current();
          state.outcome = { gateCaptured: !!state.held, reorderedEdits: false, reopened, reopenedTabs, beforeSecondSave, afterSecondSave: state.snapshot(current), diskLength: disk.length, diskError, diskMatchesBuffer: !current || current.getText() === disk, invalidRevisions: invalid.map(event => event.snapshot.version) };
          state.failure = invalid.length ? 'Installed Workbench edits under the close gate created invalid notebook JSON' : diskError ?? (current && current.getText() !== disk ? 'Disk differs from the saved buffer' : reopened ? 'Closed notebook reopened automatically' : null);
          state.verdict = state.failure ? 'WORKFLOW_FAILED' : 'PASS_UNREVIEWED_VISUAL';
        } catch (error) {
          state.failure = String(error.message);
          state.verdict = 'HARNESS_SUSPECT';
        } finally {
          state.restore();
          if (!state.current()?.isDirty) await vscode.window.tabGroups.close(state.tabs());
          await state.persist();
          for (const observer of state.observers) observer.dispose();
          await state.journal.close();
        }
        if (state.failure) throw new Error(state.failure + '; retained evidence: ' + state.config.evidenceRoot);
        return state.outcome;
      })()
      """