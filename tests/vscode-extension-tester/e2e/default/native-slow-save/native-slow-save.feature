Feature: A native commit cannot leave a late Save lease fencing the next real edit

  Scenario: A delayed final snapshot is released by trusted input after native commit
    Given I collect JSON artifact "slow-save-isolation" from extension host expression "(() => { const fs = process.getBuiltinModule('node:fs'); if (!process.env.KW_PUBLISHED_REPLAY_CONFIG) throw new Error('Use the isolated replay runner'); const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8')); const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench'); if (extension?.extensionPath.toLowerCase() !== config.expectedExtensionPath.toLowerCase() || config.autoSave !== 'off' || !config.cdpPort || vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Expected a fresh manual-Save profile with an explicit CDP port'); return { version: extension.packageJSON.version, cdpPort: config.cdpPort }; })()"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    Then I collect JSON artifact "slow-save-created" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const config = JSON.parse(fs.readFileSync(process.env.KW_PUBLISHED_REPLAY_CONFIG, 'utf8'));
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const hash = value => crypto.createHash('sha256').update(value).digest('hex');
        if (hash(fs.readFileSync(path.join(extension.extensionPath, extension.packageJSON.main))) !== config.expectedExtensionSha256 || hash(fs.readFileSync(config.helperPath)) !== config.helperSha256 || vscode.version !== config.expectedEditorVersion) throw new Error('Slow-Save package identity differs');
        await extension.activate();
        const root = vscode.Uri.file(fs.mkdtempSync(path.join(config.fixtureParent, 'kw-slow-save-')));
        const uri = vscode.Uri.joinPath(root, 'slow.kqlx');
        const initialText = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [{ id: 'slow_markdown', type: 'markdown', title: 'Slow Save', text: 'Slow baseline', mode: 'wysiwyg', expanded: true }] } }, null, 2) + '\n';
        await vscode.workspace.fs.writeFile(uri, Buffer.from(initialText, 'utf8'));
        const require = process.getBuiltinModule('node:module').createRequire(config.helperPath);
        const journal = await require(config.helperPath).createJournal({ fixtureRoot: root.fsPath, evidenceRoot: config.evidenceRoot, initialText });
        const state = { root, uri, config, journal, events: [], armed: false, delayed: false, observers: [], verdict: 'INCOMPLETE' };
        const same = document => document.uri.toString() === uri.toString();
        state.delay = vscode.workspace.onWillSaveTextDocument(event => {
          if (!same(event.document) || !state.armed || state.delayed) return;
          state.delayed = true;
          state.events.push({ kind: 'injected-participant-start', at: Date.now() });
          event.waitUntil(new Promise(resolve => setTimeout(() => { state.events.push({ kind: 'injected-participant-end', at: Date.now() }); resolve([]); }, 1100)));
        });
        state.observers.push(vscode.workspace.onDidChangeTextDocument(event => { if (same(event.document) && event.contentChanges.length) journal.capture(event.document.getText(), { phase: 'buffer:change', documentVersion: event.document.version }); }));
        state.observers.push(vscode.workspace.onWillSaveTextDocument(event => { if (same(event.document)) { state.events.push({ kind: 'will-save', at: Date.now(), reason: event.reason }); journal.capture(event.document.getText(), { phase: 'buffer:will-save', documentVersion: event.document.version, reason: event.reason }); } }));
        state.observers.push(vscode.workspace.onDidSaveTextDocument(document => { if (same(document)) { const event = { kind: 'did-save', at: Date.now(), version: document.version, text: document.getText() }; state.events.push(event); if (state.armed && state.commit) state.commit(event); } }));
        state.persist = async () => { await journal.flush(); await fs.promises.writeFile(path.join(config.evidenceRoot, 'lifecycle-summary.json'), JSON.stringify({ provenance: { ...config, faultInjection: '1100ms preceding participant plus one correlated final snapshot held until trusted input', baselineApplicability: 'separate small Markdown fixture' }, fixtureUri: uri.toString(), verdict: state.verdict, failure: state.failure ?? null, events: state.events, timing: state.timing ?? null, operations: [], journal: journal.summary() }, null, 2)); };
        globalThis.__slowSave = state;
        await state.persist();
        await vscode.commands.executeCommand('vscode.openWith', uri, 'kusto.kqlxEditor', { preview: false });
        return { uri: uri.toString(), initialHash: hash(initialText), faultInjected: true };
      })()
      """
    When I wait for "#slow_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview "slow.kqlx" for 30 seconds
    When I click "#slow_markdown .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "document.querySelector('#slow_markdown .toastui-editor-ww-container .ProseMirror').focus()" in the webview
    And I press "End"
    And I type " Ready"
    Then I collect JSON artifact "slow-save-arm" from webview expression:
      """
      (() => {
        const section = document.getElementById('slow_markdown');
        if (!section || !document.hasFocus() || section.serialize().text.trimEnd() !== 'Slow baseline Ready' || typeof window.vscode?.postMessage !== 'function' || window.__e2eCaptureHostMessage) throw new Error('Wrong frame, focus, initial edit, or occupied capture hook');
        const post = window.vscode.postMessage.bind(window.vscode);
        const state = { held: [], events: [], holdCount: 0, finalRequestId: null, releasing: false, previousHook: window.__e2eCaptureHostMessage };
        const incoming = event => {
          const message = event.data;
          if (message?.type === 'requestFinalPersist' && !state.finalRequestId) state.finalRequestId = message.requestId;
          if (['requestMarkdownCommandBarrier', 'requestFinalPersist', 'markdownDocumentCommandResult'].includes(message?.type)) state.events.push({ direction: 'in', type: message.type, at: Date.now(), commandId: message.commandId ?? null, requestId: message.requestId ?? null, ok: message.ok ?? null });
        };
        const release = reason => {
          if (!state.held.length || state.releasing) return;
          state.releasing = true;
          state.events.push({ type: 'release', reason, at: Date.now() });
          clearTimeout(state.timer);
          for (const message of state.held.splice(0)) post(message);
        };
        const input = event => {
          if (event.isTrusted && event.target?.closest?.('.ProseMirror') && state.held.length) {
            state.events.push({ type: 'trusted-input', at: Date.now() });
            release('trusted-input');
          }
        };
        window.addEventListener('message', incoming, true);
        document.addEventListener('input', input, true);
        window.__e2eCaptureHostMessage = message => {
          if (message.type === 'persistDocument') state.events.push({ direction: 'out', type: message.type, at: Date.now(), flushRequestId: message.flushRequestId ?? null });
          if (message.type === 'markdownDocumentCommandBarrierResult' || message.type === 'markdownDocumentCommand') state.events.push({ direction: 'out', type: message.type, at: Date.now(), commandId: message.commandId ?? null, requestId: message.requestId ?? null, accepted: message.accepted ?? null });
          if (!state.releasing && state.holdCount === 0 && message.type === 'persistDocument' && typeof message.flushRequestId === 'string' && message.flushRequestId.startsWith('final-persist-')) {
            state.holdCount++;
            state.events.push({ type: 'hold', at: Date.now(), requestId: message.flushRequestId });
            state.held.push(message);
            state.timer = setTimeout(() => release('safety-cap'), 2000);
            return false;
          }
          if (state.held.length) { state.held.push(message); return false; }
          return true;
        };
        state.restore = () => { release('cleanup'); window.__e2eCaptureHostMessage = state.previousHook; window.removeEventListener('message', incoming, true); document.removeEventListener('input', input, true); };
        window.__slowSaveCapture = state;
        return { armed: true, text: section.serialize().text, faultInjected: true };
      })()
      """
    Then I collect JSON artifact "slow-save-native-input" from extension host expression:
      """
      (async () => {
        const state = globalThis.__slowSave;
        const path = process.getBuiltinModule('node:path');
        const fs = process.getBuiltinModule('node:fs');
        const require = process.getBuiltinModule('node:module').createRequire(path.join(process.env.APPDATA, 'npm/node_modules/vscode-ext-test/bin/vscode-ext-test.js'));
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString());
        if (!vscode.window.state.focused || vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== state.uri.toString() || !document?.isDirty || JSON.parse(document.getText()).state.sections[0].text.trimEnd() !== 'Slow baseline Ready') throw new Error('The exact dirty native input target is not ready');
        const client = await require('chrome-remote-interface')({ port: state.config.cdpPort, target: targets => targets.filter(target => target.type === 'page').find(target => target.url.includes('workbench.html')) });
        let timer;
        try {
          state.armed = true;
          const committed = new Promise((resolve, reject) => { state.commit = resolve; timer = setTimeout(() => reject(new Error('No native commit after Ctrl+S')), 8000); });
          state.saveStartedAt = Date.now();
          await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 2 });
          await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 's', code: 'KeyS', windowsVirtualKeyCode: 83, modifiers: 0 });
          const commit = await committed;
          clearTimeout(timer);
          state.armed = false;
          await client.Input.dispatchKeyEvent({ type: 'keyDown', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90, text: 'Z' });
          await client.Input.dispatchKeyEvent({ type: 'keyUp', key: 'Z', code: 'KeyZ', windowsVirtualKeyCode: 90 });
          const deadline = commit.at + 1000;
          while (Date.now() < deadline && (!document.isDirty || JSON.parse(document.getText()).state.sections[0].text.trimEnd() !== 'Slow baseline ReadyZ')) await new Promise(resolve => setTimeout(resolve, 10));
          state.timing = { saveStartedAt: state.saveStartedAt, commitAt: commit.at, nextEditAcceptedAt: Date.now(), nextEditVersion: document.version, commitVersion: commit.version };
          if (!document.isDirty || JSON.parse(document.getText()).state.sections[0].text.trimEnd() !== 'Slow baseline ReadyZ' || state.timing.nextEditAcceptedAt - commit.at > 1000) throw new Error('Next trusted edit did not pass the Save fence within one second');
          const acceptedText = document.getText();
          const acceptedVersion = document.version;
          await new Promise(resolve => setTimeout(resolve, 1800));
          if (document.getText() !== acceptedText || document.version !== acceptedVersion || fs.readFileSync(state.uri.fsPath, 'utf8') !== commit.text) throw new Error('Late preparation overwrote the next edit or changed the committed disk bytes');
          state.verdict = 'FAULT_SCENARIO_TIMING_REVIEW_PENDING';
          await state.persist();
          return { timing: state.timing, events: state.events, dirty: document.isDirty, lateOverwrite: false };
        } catch (error) {
          state.verdict = 'WORKFLOW_FAILED';
          state.failure = String(error.message);
          await state.persist();
          return { failure: state.failure, timing: state.timing ?? null, events: state.events };
        } finally { clearTimeout(timer); state.delay.dispose(); await client.close(); }
      })()
      """
    Then I collect JSON artifact "slow-save-wire-timing" from webview expression "(() => { const state = window.__slowSaveCapture; const held = state.events.find(event => event.type === 'hold'); const release = state.events.find(event => event.type === 'release'); const input = state.events.find(event => event.type === 'trusted-input'); state.restore(); return { holdCount: state.holdCount, finalRequestId: state.finalRequestId, held: held ?? null, release: release ?? null, input: input ?? null, events: state.events, text: document.getElementById('slow_markdown').serialize().text, faultInjected: true }; })()"
    Then I collect JSON artifact "slow-save-ordering" from extension host expression "(async () => { const state = globalThis.__slowSave; const fs = process.getBuiltinModule('node:fs'); const path = process.getBuiltinModule('node:path'); const walk = root => fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(path.join(root, entry.name)) : [path.join(root, entry.name)]); const matches = walk(state.config.frameworkRunsRoot).filter(file => path.basename(file) === 'slow-save-wire-timing.json'); if (matches.length !== 1) throw new Error('Expected one actual wire-timing artifact'); const wire = JSON.parse(fs.readFileSync(matches[0], 'utf8')); const barrier = wire.events.find(event => event.type === 'markdownDocumentCommandBarrierResult' && event.accepted); if (state.timing) state.timing.wire = wire; if (!state.delayed || !barrier || wire.holdCount !== 1 || !wire.held || !wire.input || wire.held.requestId !== wire.finalRequestId || wire.release?.reason !== 'trusted-input' || wire.release.at - wire.held.at >= 900 || !state.timing || barrier.at > wire.held.at || wire.held.at >= state.timing.commitAt || state.timing.commitAt > wire.input.at || wire.release.at < state.timing.commitAt) { state.verdict = 'HARNESS_SUSPECT'; state.failure = 'The probe did not reach the intended native early-commit window'; await state.persist(); throw new Error(state.failure); } await state.persist(); if (state.failure) throw new Error(state.failure); const accepted = wire.events.filter(event => event.type === 'markdownDocumentCommandResult' && event.ok); if (!wire.events.some(command => command.type === 'markdownDocumentCommand' && accepted.some(result => result.commandId === command.commandId && result.at >= wire.input.at))) throw new Error('The post-commit command was not acknowledged'); return { timing: state.timing, ordering: 'accepted barrier -> held final snapshot -> native commit -> trusted input -> release -> accepted edit' }; })()"
    Then I collect JSON artifact "slow-save-final-save-target" from extension host expression "(() => { const state = globalThis.__slowSave; if (!vscode.window.state.focused || vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== state.uri.toString()) throw new Error('Wrong final Save target'); return { uri: state.uri.toString(), injectedParticipantDisposed: true }; })()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "slow-save-cleanup" from extension host expression "(async () => { const state = globalThis.__slowSave; const fs = process.getBuiltinModule('node:fs'); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString()); const deadline = Date.now() + 10000; while (Date.now() < deadline && document.isDirty) await new Promise(resolve => setTimeout(resolve, 50)); const text = fs.readFileSync(state.uri.fsPath, 'utf8'); if (document.isDirty || text !== document.getText() || JSON.parse(text).state.sections[0].text.trimEnd() !== 'Slow baseline ReadyZ') throw new Error('Final normal Save did not retain the next edit'); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === state.uri.toString()); if (tabs.some(tab => tab.isDirty) || !await vscode.window.tabGroups.close(tabs)) throw new Error('Exact slow-Save cleanup failed'); for (const observer of state.observers) observer.dispose(); state.verdict = 'FAULT_SCENARIO_BEHAVIOR_CONFIRMED'; await state.persist(); await state.journal.close(); delete globalThis.__slowSave; return { fixtureRetained: state.uri.toString(), nextEditSaved: true, expectedFaultWarnings: true, visualReview: 'unavailable' }; })()"