Feature: Native result restoration cannot corrupt a notebook after its tab closes

  Scenario: A production post-Save edit crosses close before a second native Save
    Given I collect JSON artifact "close-race-isolation" from extension host expression "(() => { if (!process.env.KW_PUBLISHED_REPLAY_CONFIG || !process.env.KW_CLOSE_RACE_BASELINE) throw new Error('Use the isolated published replay runner and a row-free authenticated print ReopenProbe = 1 baseline'); if (vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Expected a fresh isolated profile'); const mode = process.env.KW_CLOSE_RACE_PUBLICATION_MODE ?? 'edit'; if (mode !== 'edit' && mode !== 'file') throw new Error('KW_CLOSE_RACE_PUBLICATION_MODE must be edit or file'); return { isolated: true, mode, visualReview: 'unavailable' }; })()"
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
        const mode = process.env.KW_CLOSE_RACE_PUBLICATION_MODE ?? 'edit';
        if (mode !== 'edit' && mode !== 'file') throw new Error('KW_CLOSE_RACE_PUBLICATION_MODE must be edit or file');
        const gateKind = mode === 'file' ? 'fs.promises.open(r+)' : 'workspace.applyEdit';
        const faultInjection = mode === 'file'
          ? 'Declared harness gate, not a user control: hold the first post-commit fs.promises.open(fixture, r+) until exact tab closure plus 100ms for native document disposal, then call the original open unchanged'
          : 'Declared harness gate, not a user control: delay one unchanged Workbench post-commit result edit until exact tab closure plus 100ms for native document disposal';
        const state = { config, uri, journal, api, main, hash, mode, gateKind, events: [], edits: [], opens: [], observers: [], saveCount: 0, armed: false, held: null, phase: 'setup', verdict: 'INCOMPLETE', lastEventAt: Date.now() };
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
          fs.writeFileSync(path.join(config.evidenceRoot, 'lifecycle-summary.json'), JSON.stringify({ provenance: { ...config, mode, gateKind, faultInjection, baselineSha256: hash(initialText) }, fixtureUri: uri.toString(), phase: state.phase, verdict: state.verdict, failure: state.failure ?? null, harnessError: state.harnessError ?? null, events: state.events, edits: state.edits, opens: state.opens, outcome: state.outcome ?? null, operations: [], journal: journal.summary() }, null, 2));
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
          const item = { ordinal: state.edits.length + 1, at: Date.now(), saveCount: state.saveCount, before: state.snapshot(document), replacements: entry[1].map(replacement => ({ range: replacement.range, length: replacement.newText.length, resultBearing: replacement.newText.includes('resultJson') })), stack: new Error().stack };
          state.edits.push(item);
          state.record('edit-start', { ordinal: item.ordinal });
          if (state.held && !state.held.released) state.harnessError = 'Another production edit overtook the held edit';
          if (mode === 'edit' && state.armed && state.saveCount > 0 && item.replacements.some(replacement => replacement.resultBearing)) {
            state.armed = false;
            let release;
            const gate = new Promise(resolve => { release = resolve; });
            state.held = { kind: gateKind, item, document, release, released: false };
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
        const fsPromises = fs.promises;
        const originalOpen = fsPromises.open;
        if (mode === 'file') {
          fsPromises.open = async function (...args) {
            const [target, flags] = args;
            if (target !== uri.fsPath || flags !== 'r+') return Reflect.apply(originalOpen, this, args);
            const item = { ordinal: state.opens.length + 1, at: Date.now(), saveCount: state.saveCount, armed: state.armed, diskHash: hash(fs.readFileSync(uri.fsPath)), stack: new Error().stack };
            state.opens.push(item);
            state.record('open-start', { ordinal: item.ordinal, saveCount: item.saveCount, armed: item.armed });
            if (state.held && !state.held.released) state.harnessError = 'Another fixture publication open overtook the held open';
            if (state.armed && state.saveCount > 0) {
              state.armed = false;
              const document = state.current();
              let release;
              const gate = new Promise(resolve => { release = resolve; });
              state.held = { kind: gateKind, item, document, release, released: false };
              state.record('held', { kind: gateKind, ordinal: item.ordinal, snapshot: state.snapshot(document) });
              const timer = setTimeout(() => { state.harnessError = 'Close gate exceeded its safety bound'; release(); }, 5000);
              setImmediate(async () => {
                try {
                  if (!document || document.isDirty || state.tabs().length !== 1 || state.tabs()[0].isPreview) throw new Error('Expected one clean pinned tab after native commit');
                  const closed = await api.window.tabGroups.close(state.tabs());
                  state.record('close-settled', { closed, tabCount: state.tabs().length, snapshot: state.snapshot(document) });
                  if (!closed || state.tabs().length) throw new Error('Exact tab did not close before release');
                  await new Promise(resolve => setTimeout(resolve, 100));
                  if (hash(fs.readFileSync(uri.fsPath)) !== item.diskHash) throw new Error('Another writer changed the fixture while the publication open was held');
                } catch (error) { state.harnessError = String(error.message); }
                finally { clearTimeout(timer); state.held.released = true; state.record('release', { ordinal: item.ordinal, snapshot: state.snapshot(document), currentDocument: state.snapshot(state.current()) }); release(); }
              });
              await gate;
            }
            const handle = await Reflect.apply(originalOpen, this, args);
            state.record('open-completed', { ordinal: item.ordinal });
            return handle;
          };
          if (fsPromises.open === originalOpen) throw new Error('Could not install the fixture publication gate');
        }
        state.restore = () => { state.armed = false; state.held?.release(); api.workspace.applyEdit = originalApply; fsPromises.open = originalOpen; };
        state.inspect = text => {
          try {
            const parsed = JSON.parse(text);
            const query = parsed.state?.sections?.find(section => section.id === 'q_probe');
            if (parsed.kind !== 'kqlx' || query?.query !== 'print ReopenProbe = 1' || parsed.state.sections.find(section => section.id === 'm_probe')?.text !== 'Baseline notes') return { error: 'Saved query or Markdown changed', resultPresent: false };
            if (state.expectedQueryName && query.name !== state.expectedQueryName) return { error: 'The second accepted query-title edit was not preserved', resultPresent: false };
            let resultPresent = false;
            try {
              const result = JSON.parse(query.resultJson || 'null');
              const cell = result?.rows?.[0]?.[0];
              resultPresent = !!result && result.columns.some(column => (column.name ?? column) === 'ReopenProbe') && result.rows.length === 1 && String(cell?.full ?? cell) === '1';
            } catch {}
            return { error: null, resultPresent };
          } catch (error) { return { error: String(error.message), resultPresent: false }; }
        };
        state.packageUnchanged = () => hash(fs.readFileSync(main)) === config.expectedExtensionSha256 && hash(fs.readFileSync(config.helperPath)) === config.helperSha256;
        state.finalize = async () => {
          if (state.finalized) return;
          state.finalized = true;
          state.restore();
          try { if (state.tabs().length && !state.current()?.isDirty) await api.window.tabGroups.close(state.tabs()); }
          finally {
            for (const observer of state.observers) observer.dispose();
            await journal.flush();
            state.journalSummary = await journal.close();
            await state.persist();
          }
        };
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
        return { uri: uri.toString(), mode, gateKind, packageVersion: extension.packageJSON.version, apiInstanceDistinct: api.workspace !== vscode.workspace };
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
            return { realQuery: true, mode: state.mode, gateKind: state.gateKind, capturedProductionEdits: state.edits.length, snapshot: state.snapshot(document) };
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
            if (state.mode === 'file') throw new Error('FILE_GATE_NOT_REACHED: no post-commit r+ publication open of the exact fixture was intercepted; the direct-publication gate cannot pass uncaptured');
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
          if (state.mode === 'edit' && reopened && state.current()?.isDirty) {
            state.record('second-native-save');
            await state.nativeSave();
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline && state.current()?.isDirty) await new Promise(resolve => setTimeout(resolve, 20));
            if (state.current()?.isDirty) throw new Error('Second native Save did not complete');
          }
          let disk = fs.readFileSync(state.uri.fsPath, 'utf8');
          if (state.mode === 'file') {
            const publicationDeadline = Date.now() + 10000;
            const settled = () => { const current = state.current(); return state.inspect(disk).resultPresent && (!current || (!current.isDirty && (!state.tabs().length || current.getText() === disk))); };
            while (Date.now() < publicationDeadline && !settled()) { await new Promise(resolve => setTimeout(resolve, 50)); disk = fs.readFileSync(state.uri.fsPath, 'utf8'); }
          }
          state.journal.capture(disk, { phase: state.mode === 'file' ? 'disk:after-publication' : 'disk:after-second-save' });
          const inspection = state.inspect(disk);
          const diskError = inspection.error;
          const invalid = state.events.filter(event => event.kind === 'change' && !event.snapshot.valid);
          const current = state.current();
          const postCommitEdits = state.edits.filter(edit => edit.saveCount > 0).map(edit => edit.ordinal);
          state.outcome = { mode: state.mode, gateKind: state.gateKind, heldKind: state.held.kind, gateCaptured: !!state.held, reorderedEdits: false, reopened, reopenedTabs, beforeSecondSave, afterSecondSave: state.snapshot(current), diskLength: disk.length, diskError, resultPresent: inspection.resultPresent, diskMatchesBuffer: !current || current.getText() === disk, invalidRevisions: invalid.map(event => event.snapshot.version), postCommitEdits, publicationOpens: state.opens.map(open => ({ ordinal: open.ordinal, saveCount: open.saveCount, armed: open.armed })), packageUnchanged: state.packageUnchanged() };
          state.failure = invalid.length ? 'Installed Workbench edits under the close gate created invalid notebook JSON' : diskError ?? (current?.isDirty ? 'A closed notebook retained a dirty buffer' : current && current.getText() !== disk && (state.mode === 'edit' || reopened) ? 'Disk differs from the saved buffer' : reopened ? 'Closed notebook reopened automatically' : !state.outcome.packageUnchanged ? 'Installed package or journal identity changed' : null);
          if (!state.failure && state.mode === 'file') {
            if (state.held.kind !== 'fs.promises.open(r+)') state.failure = 'The direct-publication gate did not capture the fixture open';
            else if (postCommitEdits.length) state.failure = 'Workbench applied ' + postCommitEdits.length + ' target WorkspaceEdit(s) after the first native commit';
            else if (!inspection.resultPresent) state.failure = 'The actual ReopenProbe result was not published to disk after close';
          }
          if (state.failure) state.verdict = 'WORKFLOW_FAILED';
          else state.phase = 'close-verified';
        } catch (error) {
          state.failure = String(error.message);
          state.verdict = 'HARNESS_SUSPECT';
        } finally {
          state.restore();
          if (state.failure) await state.finalize();
          else {
            if (state.tabs().length && !state.current()?.isDirty) await state.api.window.tabGroups.close(state.tabs());
            await state.persist();
          }
        }
        if (state.failure) throw new Error(state.failure + '; retained evidence: ' + state.config.evidenceRoot);
        return state.outcome;
      })()
      """
    Then I collect JSON artifact "close-race-user-reopen" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeRace;
        try {
          if (state.phase !== 'close-verified' || state.tabs().length) throw new Error('Explicit user reopen is allowed only after verified close evidence without automatic reopen');
          state.reopenEventOffset = state.events.length;
          state.record('explicit-user-reopen');
          await vscode.commands.executeCommand('vscode.openWith', state.uri, 'kusto.kqlxEditor', { preview: false });
          const fs = process.getBuiltinModule('node:fs');
          const deadline = Date.now() + 10000;
          const reconciled = () => {
            const current = state.current();
            const disk = fs.readFileSync(state.uri.fsPath, 'utf8');
            return current && !current.isDirty && current.getText() === disk && state.inspect(disk).resultPresent;
          };
          while (Date.now() < deadline && !reconciled()) await new Promise(resolve => setTimeout(resolve, 25));
          if (!reconciled()) throw new Error('The explicitly reopened native document did not adopt the exact saved results');
          state.phase = 'user-reopened';
          await state.persist();
          return { mode: state.mode, uri: state.uri.toString(), tabs: state.tabs().length };
        } catch (error) {
          state.failure = String(error.message);
          state.verdict = 'HARNESS_SUSPECT';
          await state.finalize();
          throw new Error(state.failure + '; retained evidence: ' + state.config.evidenceRoot);
        }
      })()
      """
    Then I wait for "#q_probe[data-test-executing='false'][data-test-has-results='true']" in the webview "close-race.kqlx" for 30 seconds
    Then I collect JSON artifact "close-race-reopened-ui" from webview expression "(() => { const section = document.getElementById('q_probe'); const wrapper = document.getElementById('q_probe_results_wrapper'); const height = wrapper ? wrapper.getBoundingClientRect().height : 0; if (section?.dataset.testHasResults !== 'true' || !wrapper || wrapper.style.display === 'none' || !height) throw new Error('Restored query results are not visible after explicit reopen'); return { resultsVisible: true, height }; })()"
    Then I wait for "#q_probe_run_btn:not([disabled])" in the webview "close-race.kqlx" for 30 seconds
    And I evaluate "(() => { const section = document.getElementById('q_probe'); if (!section) throw new Error('Missing query section'); delete document.body.dataset.closeRaceRerun; let started = false; const observer = new MutationObserver(() => { if (section.dataset.testExecuting === 'true') started = true; else if (started && section.dataset.testHasResults === 'true') { document.body.dataset.closeRaceRerun = 'done'; observer.disconnect(); } }); observer.observe(section, { attributes: true, attributeFilter: ['data-test-executing', 'data-test-has-results'] }); })()" in the webview
    When I click "#q_probe_run_btn" in the webview "close-race.kqlx"
    Then I wait for "body[data-close-race-rerun='done']" in the webview "close-race.kqlx" for 30 seconds
    Then I collect JSON artifact "close-race-second-edit" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeRace;
        try {
          state.expectedQueryName = 'After explicit reopen';
          const result = await vscode.lm.invokeTool('kusto-workbench_configure-query-section', {
            toolInvocationToken: undefined,
            input: { targetFileUri: state.uri.toString(), sectionId: 'q_probe', name: state.expectedQueryName, execute: false },
          });
          const response = JSON.parse(result.content.find(part => typeof part.value === 'string')?.value ?? '{}');
          if (response.success !== true) throw new Error('The registered Workbench title edit was not accepted');
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline && (!state.current()?.isDirty || Date.now() - state.lastEventAt < 1500)) await new Promise(resolve => setTimeout(resolve, 20));
          if (Date.now() - state.lastEventAt < 1500) throw new Error('The reopened Run edit did not settle');
          const current = state.current();
          if (!current || state.tabs().length !== 1) throw new Error('Expected exactly the explicitly reopened notebook');
          const bufferChanges = state.events.slice(state.reopenEventOffset).filter(event => event.kind === 'change' && event.changes.length).length;
          state.secondEdit = { dirty: current.isDirty, bufferChanges, snapshot: state.snapshot(current) };
          state.journal.capture(current.getText(), { phase: 'buffer:before-reopened-save', documentVersion: current.version });
          if (!current.isDirty || !state.inspect(current.getText()).resultPresent || state.inspect(current.getText()).error) throw new Error('SECOND_EDIT_NOT_EXERCISED: the accepted title edit and result did not reach the dirty source');
          if (state.api.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== state.uri.toString()) throw new Error('Wrong native Save target');
          state.reopenSaveCount = state.saveCount;
          await state.persist();
          return state.secondEdit;
        } catch (error) {
          state.failure = String(error.message);
          state.verdict = 'HARNESS_SUSPECT';
          await state.finalize();
          throw new Error(state.failure + '; retained evidence: ' + state.config.evidenceRoot);
        }
      })()
      """
    When I press "Ctrl+S"
    Then I collect JSON artifact "close-race-complete" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeRace;
        const fs = process.getBuiltinModule('node:fs');
        try {
          const deadline = Date.now() + 10000;
          while (Date.now() < deadline && (state.current()?.isDirty || state.saveCount === state.reopenSaveCount)) await new Promise(resolve => setTimeout(resolve, 20));
          const current = state.current();
          if (!current || current.isDirty || state.saveCount === state.reopenSaveCount) throw new Error('Native Save after explicit reopen did not complete');
          const quietDeadline = Date.now() + 10000;
          while (Date.now() < quietDeadline && Date.now() - state.lastEventAt < 1500) await new Promise(resolve => setTimeout(resolve, 20));
          if (Date.now() - state.lastEventAt < 1500) throw new Error('Reopened Save lifecycle did not become quiet');
          const disk = fs.readFileSync(state.uri.fsPath, 'utf8');
          state.journal.capture(disk, { phase: 'disk:after-reopened-save' });
          const inspection = state.inspect(disk);
          const invalid = state.events.filter(event => event.kind === 'change' && !event.snapshot.valid);
          const packageUnchanged = state.packageUnchanged();
          state.outcome = { ...state.outcome, secondEdit: state.secondEdit, reopenedSave: { saveCount: state.saveCount, snapshot: state.snapshot(current), diskLength: disk.length, diskError: inspection.error, resultPresent: inspection.resultPresent, diskMatchesBuffer: current.getText() === disk, invalidRevisions: invalid.map(event => event.snapshot.version), packageUnchanged } };
          state.failure = invalid.length ? 'Invalid notebook JSON revision observed' : inspection.error ?? (!inspection.resultPresent ? 'The actual ReopenProbe result was not preserved by the reopened Save' : current.getText() !== disk ? 'Disk differs from the saved buffer after reopened Save' : !packageUnchanged ? 'Installed package or journal identity changed' : null);
          state.verdict = state.failure ? 'WORKFLOW_FAILED' : 'PASS_UNREVIEWED_VISUAL';
          if (!state.failure) state.phase = 'complete';
        } catch (error) {
          state.failure = String(error.message);
          state.verdict = 'HARNESS_SUSPECT';
        } finally {
          await state.finalize();
        }
        if (state.failure) throw new Error(state.failure + '; retained evidence: ' + state.config.evidenceRoot);
        return { verdict: state.verdict, outcome: state.outcome, journal: state.journalSummary };
      })()
      """

  Scenario: Native close prompt Save, Don't Save, and Cancel keep exact notebook bytes
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    Then I collect JSON artifact "close-choice-setup" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        if (!process.env.KW_PUBLISHED_REPLAY_CONFIG || !process.env.KW_CLOSE_RACE_BASELINE) throw new Error('Use the isolated published replay runner and the authenticated print ReopenProbe = 1 baseline');
        const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        if (extension?.extensionPath.toLowerCase() !== config.expectedExtensionPath.toLowerCase() || vscode.version !== config.expectedEditorVersion || config.autoSave !== 'off' || vscode.workspace.getConfiguration('files').get('autoSave') !== 'off') throw new Error('Wrong installed package, editor, or Save configuration');
        const main = path.join(extension.extensionPath, extension.packageJSON.main);
        const packageUnchanged = () => hash(fs.readFileSync(main)) === config.expectedExtensionSha256 && hash(fs.readFileSync(config.helperPath)) === config.helperSha256;
        if (!packageUnchanged()) throw new Error('Package or journal identity differs');
        const parent = path.resolve(config.fixtureParent).toLowerCase() + path.sep;
        if (vscode.window.tabGroups.all.flatMap(group => group.tabs).some(tab => tab.input?.uri?.scheme !== 'file' || !path.resolve(tab.input.uri.fsPath).toLowerCase().startsWith(parent))) throw new Error('Expected an isolated profile without user tabs');
        const initialText = fs.readFileSync(process.env.KW_CLOSE_RACE_BASELINE, 'utf8');
        const baseline = JSON.parse(initialText);
        const baselineQuery = baseline.state?.sections?.find(section => section.id === 'q_probe');
        if (baseline.kind !== 'kqlx' || baseline.state.sections.length !== 2 || baselineQuery?.query !== 'print ReopenProbe = 1' || baselineQuery.resultJson || baselineQuery.resultArtifact || baseline.state.sections.find(section => section.id === 'm_probe')?.text !== 'Baseline notes') throw new Error('Expected the dedicated result-free query/Markdown baseline');
        await extension.activate();
        const root = fs.mkdtempSync(path.join(config.fixtureParent, 'kw-close-choice-'));
        const files = { save: 'close-choice.kqlx', discard: 'close-discard.kqlx', cancel: 'close-cancel.kqlx' };
        const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
        const state = { hash, packageUnchanged, originalName: baselineQuery.name, baselineSha256: hash(initialText), cases: {}, events: [], outcomes: {}, observers: [], lastEventAt: Date.now(), phase: 'setup', verdict: 'INCOMPLETE' };
        const matches = (name, uri) => !!uri && state.cases[name]?.uri.toString() === uri.toString();
        const caseOf = uri => Object.keys(state.cases).find(name => matches(name, uri));
        state.record = (name, kind, fields = {}) => { state.lastEventAt = Date.now(); state.events.push({ case: name, kind, at: state.lastEventAt, ...fields }); };
        state.doc = name => vscode.workspace.textDocuments.find(document => matches(name, document.uri));
        state.tabs = name => vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => matches(name, tab.input?.uri));
        state.disk = name => fs.readFileSync(state.cases[name].uri.fsPath, 'utf8');
        state.activeIs = name => matches(name, vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri);
        state.inspect = (text, expect) => {
          let parsed;
          try { parsed = JSON.parse(text); } catch (error) { return 'Invalid notebook JSON: ' + error.message; }
          const sections = parsed.state?.sections ?? [];
          const query = sections.find(section => section.id === 'q_probe');
          if (parsed.kind !== 'kqlx' || sections.length !== 2 || query?.query !== 'print ReopenProbe = 1' || sections.find(section => section.id === 'm_probe')?.text !== 'Baseline notes') return 'Query or Markdown changed';
          if ('name' in expect && query.name !== expect.name) return 'Expected query title ' + JSON.stringify(expect.name) + ', found ' + JSON.stringify(query.name);
          let result = false;
          try { const value = JSON.parse(query.resultJson || 'null'); const cell = value?.rows?.[0]?.[0]; result = !!value && value.columns.some(column => (column.name ?? column) === 'ReopenProbe') && value.rows.length === 1 && String(cell?.full ?? cell) === '1'; } catch {}
          if (expect.result && !result) return 'Actual ReopenProbe = 1 result missing';
          if (expect.result === false && (query.resultJson || query.resultArtifact)) return 'Unexpected result after a non-executing edit';
          return null;
        };
        state.waitFor = async (predicate, ms, message) => { const deadline = Date.now() + ms; while (Date.now() < deadline && !predicate()) await sleep(25); if (!predicate()) throw new Error(message); };
        state.quiet = async (check = () => {}) => { const start = Date.now(); while (Date.now() - start < 1500 || Date.now() - state.lastEventAt < 1500) { check(); if (Date.now() - start > 10000) throw new Error('Lifecycle did not become quiet'); await sleep(25); } check(); };
        state.open = async name => {
          const uri = vscode.Uri.file(path.join(root, files[name]));
          fs.writeFileSync(uri.fsPath, initialText);
          state.cases[name] = { uri, saves: 0 };
          state.record(name, 'created');
          await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
          await state.waitFor(() => state.doc(name) && state.tabs(name).length === 1 && !state.tabs(name)[0].isPreview, 10000, 'Fresh notebook did not open pinned: ' + files[name]);
          return uri.toString();
        };
        state.armClose = async (name, expect) => {
          const item = state.cases[name];
          await state.waitFor(() => state.doc(name)?.isDirty && !state.inspect(state.doc(name).getText(), expect), 15000, 'Expected dirty source did not arrive: ' + files[name]);
          await state.quiet();
          const document = state.doc(name);
          const error = state.inspect(document.getText(), expect);
          if (error || !document.isDirty) throw new Error(error ?? 'Source became clean before close');
          if (state.tabs(name).length !== 1 || state.tabs(name)[0].isPreview || !state.activeIs(name)) throw new Error('Expected one active pinned tab before native Ctrl+W');
          item.diskSha256 = hash(state.disk(name));
          if (item.diskSha256 !== state.baselineSha256) throw new Error('Disk changed before the close prompt');
          item.savesBefore = item.saves;
          return { dirty: true, version: document.version, bufferSha256: hash(document.getText()), diskSha256: item.diskSha256 };
        };
        state.editTitle = async (name, title) => {
          const result = await vscode.lm.invokeTool('kusto-workbench_configure-query-section', { toolInvocationToken: undefined, input: { targetFileUri: state.cases[name].uri.toString(), sectionId: 'q_probe', name: title, execute: false } });
          const response = JSON.parse(result.content.find(part => typeof part.value === 'string')?.value ?? '{}');
          if (response.success !== true) throw new Error('The registered Workbench title edit was not accepted');
          return state.armClose(name, { result: false, name: title });
        };
        state.closeClean = async name => {
          const tabs = state.tabs(name);
          if (!tabs.length) return;
          if (tabs.some(tab => tab.isDirty) || state.doc(name)?.isDirty) throw new Error('Refusing to close a dirty tab: ' + files[name]);
          if (!await vscode.window.tabGroups.close(tabs) || state.tabs(name).length) throw new Error('Exact tab did not close: ' + files[name]);
        };
        state.persist = () => fs.writeFileSync(path.join(config.evidenceRoot, 'close-choice-summary.json'), JSON.stringify({ provenance: { scenario: 'close-choice', expectedExtensionSha256: config.expectedExtensionSha256, editorVersion: vscode.version, baselineSha256: state.baselineSha256, journal: 'none; lifecycle-summary.json belongs to the first scenario' }, root, phase: state.phase, verdict: state.verdict, failure: state.failure ?? null, cases: Object.fromEntries(Object.entries(state.cases).map(([name, item]) => [name, { ...item, uri: item.uri.toString() }])), outcomes: state.outcomes, events: state.events }, null, 2));
        state.finalize = async () => {
          if (state.finalized) return;
          state.finalized = true;
          try { for (const name of Object.keys(state.cases)) if (state.tabs(name).length && !state.tabs(name).some(tab => tab.isDirty) && !state.doc(name)?.isDirty) await vscode.window.tabGroups.close(state.tabs(name)); }
          finally { for (const observer of state.observers) observer.dispose(); state.persist(); }
        };
        state.step = async (label, body) => {
          try { const value = await body(); state.outcomes[label] = value; state.phase = label; state.persist(); return value; }
          catch (error) { state.failure = label + ': ' + error.message; state.verdict = 'FAILED'; await state.finalize().catch(() => {}); throw new Error(state.failure + '; retained evidence: ' + config.evidenceRoot); }
        };
        state.observers.push(
          vscode.workspace.onDidChangeTextDocument(event => { const name = caseOf(event.document.uri); if (!name) return; let valid = false; try { valid = JSON.parse(event.document.getText()).kind === 'kqlx'; } catch {} state.record(name, 'change', { version: event.document.version, dirty: event.document.isDirty, valid, changes: event.contentChanges.length }); }),
          vscode.workspace.onDidSaveTextDocument(document => { const name = caseOf(document.uri); if (name) { state.cases[name].saves++; state.record(name, 'did-save', { saves: state.cases[name].saves, sha256: hash(document.getText()) }); } }),
          vscode.workspace.onDidOpenTextDocument(document => { const name = caseOf(document.uri); if (name) state.record(name, 'document-open'); }),
          vscode.workspace.onDidCloseTextDocument(document => { const name = caseOf(document.uri); if (name) state.record(name, 'document-close'); }),
          vscode.window.tabGroups.onDidChangeTabs(event => { for (const name of new Set([...event.opened, ...event.closed, ...event.changed].map(tab => caseOf(tab.input?.uri)).filter(Boolean))) state.record(name, 'tabs', { count: state.tabs(name).length, dirty: state.tabs(name).some(tab => tab.isDirty) }); }));
        globalThis.__closeChoice = state;
        return state.step('setup', async () => ({ uri: await state.open('save') }));
      })()
      """
    Then I wait for "#q_probe_run_btn:not([disabled])" in the webview "close-choice.kqlx" for 30 seconds
    When I click "#q_probe_run_btn" in the webview "close-choice.kqlx"
    Then I wait for "#q_probe[data-test-executing='false'][data-test-has-results='true']" in the webview "close-choice.kqlx" for 30 seconds
    Then I collect JSON artifact "close-choice-save-ready" from extension host expression "globalThis.__closeChoice.step('save-ready', () => globalThis.__closeChoice.armClose('save', { result: true }))"
    When I press "Ctrl+W"
    And I wait 1 second
    When I click "Save" on the "Visual Studio Code" dialog
    Then I collect JSON artifact "close-choice-save-outcome" from extension host expression:
      """
      globalThis.__closeChoice.step('save-outcome', async () => {
        const state = globalThis.__closeChoice;
        const item = state.cases.save;
        await state.waitFor(() => item.saves > item.savesBefore && !state.tabs('save').length && !state.inspect(state.disk('save'), { result: true }), 15000, 'Close-prompt Save did not record didSave, close the exact tab, and publish the actual result');
        const offset = state.events.length;
        await state.quiet(() => { if (state.tabs('save').length) throw new Error('The saved notebook reopened automatically'); });
        const disk = state.disk('save');
        const error = state.inspect(disk, { result: true }) ?? (state.doc('save')?.isDirty ? 'A closed notebook retained a dirty buffer' : null);
        if (error) throw new Error(error);
        return { saves: item.saves, diskSha256: state.hash(disk), diskLength: disk.length, eventsAfterClose: state.events.slice(offset).map(event => event.kind) };
      })
      """
    Then I collect JSON artifact "close-choice-discard-open" from extension host expression "globalThis.__closeChoice.step('discard-open', async () => ({ uri: await globalThis.__closeChoice.open('discard') }))"
    Then I wait for "#q_probe_run_btn:not([disabled])" in the webview "close-discard.kqlx" for 30 seconds
    Then I collect JSON artifact "close-choice-discard-edit" from extension host expression "globalThis.__closeChoice.step('discard-edit', () => globalThis.__closeChoice.editTitle('discard', 'Changes Test'))"
    When I press "Ctrl+W"
    And I wait 1 second
    When I click "Don't Save" on the "Visual Studio Code" dialog
    Then I collect JSON artifact "close-choice-discard-outcome" from extension host expression:
      """
      globalThis.__closeChoice.step('discard-outcome', async () => {
        const state = globalThis.__closeChoice;
        const item = state.cases.discard;
        await state.waitFor(() => !state.tabs('discard').length, 10000, "Don't Save did not close the exact tab");
        await state.quiet(() => { if (state.tabs('discard').length) throw new Error('The discarded notebook reopened automatically'); });
        if (item.saves !== item.savesBefore) throw new Error("Don't Save produced a native save");
        if (state.hash(state.disk('discard')) !== state.baselineSha256) throw new Error("Disk bytes differ from the baseline after Don't Save");
        state.record('discard', 'explicit-user-reopen');
        await vscode.commands.executeCommand('vscode.openWith', item.uri, 'kusto.kqlxEditor', { preview: false });
        await state.waitFor(() => state.tabs('discard').length === 1 && state.doc('discard')?.getText() === state.disk('discard'), 10000, 'Explicit reopen did not load the disk bytes');
        return { closedWithoutSave: true, diskSha256: state.baselineSha256 };
      })
      """
    Then I wait for "#q_probe_run_btn:not([disabled])" in the webview "close-discard.kqlx" for 30 seconds
    Then I collect JSON artifact "close-choice-cancel-open" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeChoice;
        const reopened = await state.step('discard-reopened', async () => {
          await state.quiet();
          const document = state.doc('discard');
          const error = state.inspect(document.getText(), { result: false, name: state.originalName });
          if (error || document.isDirty || state.hash(document.getText()) !== state.baselineSha256 || state.hash(state.disk('discard')) !== state.baselineSha256) throw new Error(error ?? 'Reopened notebook is not the exact clean baseline');
          await state.closeClean('discard');
          return { originalTitle: state.originalName ?? null, exactBaseline: true };
        });
        const opened = await state.step('cancel-open', async () => ({ uri: await state.open('cancel') }));
        return { reopened, opened };
      })()
      """
    Then I wait for "#q_probe_run_btn:not([disabled])" in the webview "close-cancel.kqlx" for 30 seconds
    Then I collect JSON artifact "close-choice-cancel-edit" from extension host expression "globalThis.__closeChoice.step('cancel-edit', () => globalThis.__closeChoice.editTitle('cancel', 'Cancel Test'))"
    When I press "Ctrl+W"
    And I wait 1 second
    When I click "Cancel" on the "Visual Studio Code" dialog
    Then I collect JSON artifact "close-choice-cancel-outcome" from extension host expression:
      """
      globalThis.__closeChoice.step('cancel-outcome', async () => {
        const state = globalThis.__closeChoice;
        const item = state.cases.cancel;
        await state.quiet(() => { if (state.tabs('cancel').length !== 1) throw new Error('Cancel did not keep exactly one tab open'); });
        const document = state.doc('cancel');
        const error = state.inspect(document.getText(), { result: false, name: 'Cancel Test' });
        if (error || !document.isDirty || !state.tabs('cancel')[0].isDirty) throw new Error(error ?? 'Cancel did not keep the dirty source');
        if (item.saves !== item.savesBefore || state.hash(state.disk('cancel')) !== state.baselineSha256) throw new Error('Cancel changed the disk baseline');
        if (!state.activeIs('cancel')) throw new Error('Wrong native Save target');
        return { dirty: true, diskSha256: state.baselineSha256 };
      })
      """
    When I press "Ctrl+S"
    Then I collect JSON artifact "close-choice-complete" from extension host expression:
      """
      (async () => {
        const state = globalThis.__closeChoice;
        const result = await state.step('complete', async () => {
          const item = state.cases.cancel;
          const saved = () => { const document = state.doc('cancel'); const disk = state.disk('cancel'); return item.saves > item.savesBefore && document && !document.isDirty && document.getText() === disk && !state.inspect(disk, { result: false, name: 'Cancel Test' }); };
          await state.waitFor(saved, 10000, 'Native Ctrl+S cleanup did not save the exact dirty source');
          await state.quiet(() => { if (!saved()) throw new Error('Cleanup Save did not stay clean and valid'); });
          await state.closeClean('cancel');
          if (Object.keys(state.cases).some(name => state.tabs(name).length)) throw new Error('Fixture tabs remain open');
          if (state.events.some(event => event.kind === 'change' && !event.valid)) throw new Error('Invalid notebook JSON revision observed');
          if (!state.packageUnchanged()) throw new Error('Installed package or journal identity changed');
          state.verdict = 'PASS_UNREVIEWED_VISUAL';
          return { verdict: state.verdict, saves: Object.fromEntries(Object.entries(state.cases).map(([name, value]) => [name, value.saves])) };
        });
        await state.finalize();
        return result;
      })()
      """