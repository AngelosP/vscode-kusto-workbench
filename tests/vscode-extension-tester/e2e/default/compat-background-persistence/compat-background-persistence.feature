# Run in an isolated fresh workspace with --env KW_BACKGROUND_CDP_PORT=<the CLI CDP port>.
# Capture holds only the first real hidden reply; all later Save traffic remains untouched.
# The final close fault drops capture replies but must preserve the acknowledged dirty draft.
Feature: Compatibility background snapshots preserve native Save and reopen

  Scenario Outline: Compatibility <mode> <saveMode> <closeChoice> <extension>
    Given I collect JSON artifact "background-case" from extension host expression "(() => { globalThis.__compatBackgroundCase = { extension: '<extension>', kind: '<kind>', primary: '<primary>', initial: '<initial>', viewType: '<viewType>', mode: '<mode>', saveMode: '<saveMode>', closeChoice: '<closeChoice>', closedNote: '<closedNote>', failed: '<failed>', recovered: '<recovered>' }; return globalThis.__compatBackgroundCase; })()"
    Given I collect JSON artifact "background-fixture" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const os = process.getBuiltinModule('node:os');
        const testCase = globalThis.__compatBackgroundCase;
        if (vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Use an empty isolated workspace; refusing pre-existing tabs');
        if (vscode.workspace.getConfiguration('files').get('autoSave') !== 'off') throw new Error('This manual-Save scenario requires Auto Save off');
        const autoSaveBefore = vscode.workspace.getConfiguration('files').inspect('autoSave')?.workspaceValue;
        if (testCase.saveMode === 'focus') {
          const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
          if (!workspace || path.dirname(workspace).toLowerCase() !== os.tmpdir().toLowerCase()
            || !path.basename(workspace).startsWith('kw-background-ui-')) throw new Error('Auto Save requires the dedicated temporary test workspace');
          await vscode.workspace.getConfiguration('files').update('autoSave', 'onFocusChange', vscode.ConfigurationTarget.Workspace);
        }
        const port = Number(process.env.KW_BACKGROUND_CDP_PORT);
        if (!Number.isInteger(port) || port <= 0) throw new Error('Set KW_BACKGROUND_CDP_PORT to the isolated CLI CDP port');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        await extension.activate();
        const fixtureParent = testCase.saveMode === 'focus' ? vscode.workspace.workspaceFolders[0].uri.fsPath : os.tmpdir();
        const root = fs.mkdtempSync(path.join(fixtureParent, 'kw-background-persist-'));
        const uri = vscode.Uri.file(path.join(root, 'background.' + testCase.extension));
        if (vscode.workspace.getConfiguration('files', uri).get('autoSave') !== (testCase.saveMode === 'focus' ? 'onFocusChange' : 'off')) throw new Error('The fixture resource has the wrong Auto Save setting');
        const sidecar = uri.fsPath + '.json';
        const other = vscode.Uri.file(path.join(root, 'other.kqlx'));
        const source = testCase.initial;
        const metadata = JSON.stringify({ kind: testCase.kind, version: 1, state: { sections: [
          { id: 'primary_bg', type: testCase.primary, linkedQueryPath: path.basename(uri.fsPath), expanded: true },
          { id: 'background_note', type: 'markdown', text: 'Before', mode: 'wysiwyg', expanded: true }
        ] } }, null, 2) + '\n';
        fs.writeFileSync(uri.fsPath, source, { flag: 'wx' });
        fs.writeFileSync(sidecar, metadata, { flag: 'wx' });
        fs.writeFileSync(other.fsPath, JSON.stringify({ kind: 'kqlx', version: 1, state: { sections: [
          { id: 'other_note', type: 'markdown', text: 'Independent tab', mode: 'preview' }
        ] } }), { flag: 'wx' });
        const workbenchRequire = process.getBuiltinModule('node:module').createRequire(path.join(extension.extensionPath, extension.packageJSON.main));
        const window = workbenchRequire('vscode').window;
        const original = window.showErrorMessage;
        const originalWarning = window.showWarningMessage;
        const errors = [];
        const errorEvents = [];
        const prompts = [];
        function record(...args) { errors.push(String(args[0])); errorEvents.push({ message: String(args[0]), at: Date.now() }); return Reflect.apply(original, this, args); }
        function recordWarning(...args) {
          if (args[1]?.modal === true) prompts.push({ message: String(args[0]), buttons: args.slice(2) });
          return Reflect.apply(originalWarning, this, args);
        }
        window.showErrorMessage = record;
        window.showWarningMessage = recordWarning;
        const state = { root, uri, sidecar, other, source, metadata, errors, errorEvents, prompts, window, original, record, originalWarning, recordWarning, testCase, autoSaveBefore, nativeSaves: [], willSaves: [] };
        state.willSaveSubscription = vscode.workspace.onWillSaveTextDocument(event => {
          if (event.document.uri.toString() === uri.toString()) state.willSaves.push({ at: Date.now(), reason: event.reason, text: event.document.getText() });
        });
        state.saveSubscription = vscode.workspace.onDidSaveTextDocument(document => {
          if (document.uri.toString() === uri.toString()) state.nativeSaves.push({ at: Date.now(), text: document.getText(), dirty: document.isDirty });
        });
        state.waitSaved = async (expectedQuery, expectedNote = 'Before Current Newer') => {
          const end = Date.now() + 10000;
          while (Date.now() < end) {
            const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
            const saved = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
            if (document && !document.isDirty && document.getText() === expectedQuery
              && fs.readFileSync(uri.fsPath, 'utf8') === expectedQuery
              && saved.state.sections.find(section => section.id === 'background_note')?.text.trimEnd() === expectedNote
              && state.nativeSaves.some(event => event.text === expectedQuery)) return saved;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === uri.toString());
          throw new Error('Native Save did not commit the exact current primary and companion state: ' + JSON.stringify({
            expectedQuery, text: document?.getText(), dirty: document?.isDirty, errors, nativeSaves: state.nativeSaves,
            willSaves: state.willSaves, active: vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString(),
            resourceAutoSave: vscode.workspace.getConfiguration('files', uri).get('autoSave'),
            source: fs.readFileSync(uri.fsPath, 'utf8'), metadata: JSON.parse(fs.readFileSync(sidecar, 'utf8'))
          }));
        };
        state.capture = async label => {
          const targets = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
          const pages = targets.filter(target => target.type === 'page' && /workbench\.html/.test(target.url));
          if (pages.length !== 1) throw new Error('Expected one isolated workbench');
          const socket = new WebSocket(pages[0].webSocketDebuggerUrl);
          await new Promise((resolve, reject) => {
            socket.addEventListener('open', resolve, { once: true });
            socket.addEventListener('error', reject, { once: true });
          });
          let sequence = 0;
          const call = (method, params) => new Promise((resolve, reject) => {
            const id = ++sequence;
            const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('CDP capture timed out')); }, 5000);
            const receive = event => {
              const message = JSON.parse(event.data);
              if (message.id !== id) return;
              clearTimeout(timer);
              socket.removeEventListener('message', receive);
              if (message.error) reject(new Error(message.error.message)); else resolve(message.result);
            };
            socket.addEventListener('message', receive);
            socket.send(JSON.stringify({ id, method, params }));
          });
          try {
            const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString();
            if (active !== uri.toString()) throw new Error('Wrong screenshot tab');
            const image = await call('Page.captureScreenshot', { format: 'png' });
            const screenshot = path.join(root, label + '.png');
            fs.writeFileSync(screenshot, Buffer.from(image.data, 'base64'), { flag: 'wx' });
            return { screenshot, active, pageId: pages[0].id };
          } finally { socket.close(); }
        };
        globalThis.__compatBackground = state;
        await vscode.commands.executeCommand('vscode.openWith', uri, testCase.viewType, { preview: false });
        return { uri: uri.toString(), root, initialTabCount: 0, mode: testCase.mode };
      })()
      """
    When I wait for "#primary_bg .monaco-editor" in the webview for 30 seconds
    When I wait for "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview for 30 seconds
    When I click "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "(() => { const editor = document.querySelector('#background_note .toastui-editor-ww-container .ProseMirror'); editor.focus(); if (document.activeElement !== editor) throw new Error('Markdown input target is not focused'); return 'Markdown focused'; })()" in the webview
    And I press "End"
    And I type " Current"
    When I evaluate "window.__compatBackgroundMode = '<mode>'" in the webview
    Then I collect JSON artifact "background-wire-armed" from webview expression:
      """
      (() => {
        if (window.__e2eCaptureHostMessage || typeof window.vscode?.postMessage !== 'function') throw new Error('Capture hook unavailable or occupied');
        if (document.getElementById('background_note').serialize().text.trimEnd() !== 'Before Current') throw new Error('The real Markdown edit did not land');
        const post = window.vscode.postMessage.bind(window.vscode);
        const state = { requests: [], acknowledgements: [], held: null, released: null, heldAt: null, noop: false, mode: window.__compatBackgroundMode };
        if (!['delayed', 'superseded'].includes(state.mode)) throw new Error('Missing scenario mode');
        const incoming = event => {
          const message = event.data;
          if (message?.type === 'requestFinalPersist') state.requests.push({ requestId: message.requestId, reason: message.reason, at: Date.now() });
          if (message?.type === 'persistDocumentAck') state.acknowledgements.push({ snapshotId: message.snapshotId, editRevision: message.editRevision, at: Date.now() });
        };
        window.addEventListener('message', incoming, true);
        state.release = () => {
          if (!state.held || state.released) return;
          state.released = Date.now();
          post(state.held);
        };
        state.hook = message => {
          if (message.type !== 'persistDocument') return true;
          if (message.testOnlyNoop) { state.noop = true; throw new Error('Persistence suppression invalidates this test'); }
          if (!state.held && message.reason === 'hidden' && typeof message.flushRequestId === 'string') {
            state.held = structuredClone(message);
            state.heldAt = Date.now();
            if (state.mode === 'delayed') state.timer = setTimeout(state.release, 3000);
            return false;
          }
          return true;
        };
        state.restore = () => {
          if (window.__e2eCaptureHostMessage !== state.hook) throw new Error('Capture ownership changed');
          clearTimeout(state.timer);
          window.__e2eCaptureHostMessage = undefined;
          window.removeEventListener('message', incoming, true);
        };
        window.__e2eCaptureHostMessage = state.hook;
        window.__compatBackgroundWire = state;
        return { armed: true, mode: state.mode };
      })()
      """
    When I collect JSON artifact "background-hidden" from extension host expression "(async () => { const state = globalThis.__compatBackground; await vscode.commands.executeCommand('vscode.openWith', state.other, 'kusto.kqlxEditor', { preview: false }); if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== state.other.toString()) throw new Error('The other tab did not become active'); return { hidden: true, at: Date.now() }; })()"
    And I wait 4 seconds
    Then I collect JSON artifact "background-hidden-no-error" from extension host expression "(() => { const state = globalThis.__compatBackground; if (state.errors.length) throw new Error(JSON.stringify(state.errors)); if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== state.other.toString()) throw new Error('The hidden editor was activated prematurely'); return { errors: [], hidden: true }; })()"
    When I collect JSON artifact "background-reveal" from extension host expression "(async () => { const state = globalThis.__compatBackground; await vscode.commands.executeCommand('vscode.openWith', state.uri, '<viewType>', { preview: false }); return { uri: state.uri.toString() }; })()"
    When I wait for "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview for 15 seconds
    Then I collect JSON artifact "background-held-reply" from webview expression:
      """
      (async () => {
        const state = window.__compatBackgroundWire;
        if (!state?.held || state.noop || !state.held.snapshotId || Date.now() - state.heldAt < 2000
          || !state.requests.some(request => request.requestId === state.held.flushRequestId && request.reason === 'hidden')) throw new Error('No genuine hidden reply was held across the original deadline');
        if (state.mode === 'delayed') {
          const end = Date.now() + 5000;
          while (!state.acknowledgements.some(ack => ack.snapshotId === state.held.snapshotId) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
          if (!state.released || !state.acknowledgements.some(ack => ack.snapshotId === state.held.snapshotId)) throw new Error('The delayed background snapshot was not actually admitted');
        } else if (state.released || state.acknowledgements.some(ack => ack.snapshotId === state.held.snapshotId)) {
          throw new Error('The obsolete snapshot was released before the foreground Save');
        }
        return { heldAt: state.heldAt, releasedAt: state.released, requests: state.requests, acknowledgements: state.acknowledgements };
      })()
      """
    When I click "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "(() => { const editor = document.querySelector('#background_note .toastui-editor-ww-container .ProseMirror'); editor.focus(); if (document.activeElement !== editor) throw new Error('Markdown input target is not focused'); return 'Markdown focused'; })()" in the webview
    And I press "End"
    And I type " Newer"
    When I scroll "#primary_bg .query-editor" into view
    When I click "#primary_bg .query-editor" in the webview
    And I evaluate "(() => { const section = document.getElementById('primary_bg'); const input = section.querySelector('.monaco-editor textarea, .monaco-editor [contenteditable=true]'); if (!input) throw new Error('Missing native Monaco input'); input.focus(); if (!section.contains(document.activeElement)) throw new Error('Primary input is not focused'); return 'primary input focused'; })()" in the webview
    And I press "Ctrl+A"
    And I type "<edited>"
    Then I collect JSON artifact "background-native-save-ready" from extension host expression "(async () => { const state = globalThis.__compatBackground; const end = Date.now() + 5000; while (Date.now() < end) { const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString()); if (document?.isDirty && document.getText() === '<edited>') return { dirty: true, expectedQuery: '<edited>' }; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('The actual primary edit did not reach the native dirty document'); })()"
    When I press "<saveKey>"
    Then I collect JSON artifact "background-native-save-committed" from extension host expression "(async () => { const state = globalThis.__compatBackground; await state.waitSaved('<edited>'); const reason = state.testCase.saveMode === 'focus' ? vscode.TextDocumentSaveReason.FocusOut : vscode.TextDocumentSaveReason.Manual; if (!state.willSaves.some(event => event.reason === reason && event.text === '<edited>')) throw new Error('The required native Save trigger was not observed'); state.savedPrimary = process.getBuiltinModule('node:fs').readFileSync(state.uri.fsPath, 'utf8'); state.savedMetadata = process.getBuiltinModule('node:fs').readFileSync(state.sidecar, 'utf8'); if (state.errors.length) throw new Error(JSON.stringify(state.errors)); await vscode.commands.executeCommand('vscode.openWith', state.uri, state.testCase.viewType, { preview: false }); return { nativeSaves: state.nativeSaves, willSaves: state.willSaves, sourceAndCompanionVerified: true }; })()"
    When I evaluate "(() => { window.__compatBackgroundWire.release(); return 'original hidden reply released without modification'; })()" in the webview
    And I wait 1 second
    Then I collect JSON artifact "background-late-reply-proof" from webview expression "(() => { const state = window.__compatBackgroundWire; const oldAck = state.acknowledgements.some(ack => ack.snapshotId === state.held.snapshotId); if ('<mode>' === 'superseded' && oldAck) throw new Error('Obsolete hidden reply was acknowledged after Save'); if (!state.requests.some(request => request.reason === 'save')) throw new Error('Native Save did not request fresh state'); const result = { oldReplyAcknowledged: oldAck, requests: state.requests, acknowledgements: state.acknowledgements }; state.restore(); return result; })()"
    Then I collect JSON artifact "background-stable-save-and-close" from extension host expression:
      """
      (async () => {
        const state = globalThis.__compatBackground;
        const fs = process.getBuiltinModule('node:fs');
        const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString());
        if (!document || document.isDirty || document.getText() !== state.savedPrimary
          || fs.readFileSync(state.uri.fsPath, 'utf8') !== state.savedPrimary
          || fs.readFileSync(state.sidecar, 'utf8') !== state.savedMetadata || state.errors.length) throw new Error('Late reply changed native saved state');
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === state.uri.toString());
        if (tabs.length !== 1 || !await vscode.window.tabGroups.close(tabs)) throw new Error('Exact source tab did not close');
        await vscode.commands.executeCommand('vscode.openWith', state.uri, state.testCase.viewType, { preview: false });
        return { reopened: state.uri.toString(), sourceAndCompanionUnchanged: true };
      })()
      """
    When I wait for "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview for 20 seconds
    Then I evaluate "(() => { const note = document.getElementById('background_note').serialize(); const primary = document.getElementById('primary_bg').serialize(); if (note.text.trimEnd() !== 'Before Current Newer' || primary.query !== '<edited>') throw new Error('Reopened UI differs from native saved bytes'); return 'reopened state verified'; })()" in the webview
    When I scroll "#primary_bg .query-editor" into view
    When I click "#primary_bg .query-editor" in the webview
    And I evaluate "(() => { const section = document.getElementById('primary_bg'); const input = section.querySelector('.monaco-editor textarea, .monaco-editor [contenteditable=true]'); if (!input) throw new Error('Missing native Monaco input'); input.focus(); if (!section.contains(document.activeElement)) throw new Error('Primary input is not focused'); return 'primary input focused'; })()" in the webview
    And I press "Ctrl+A"
    And I type "<reopened>"
    Then I collect JSON artifact "background-reopened-save-ready" from extension host expression "(async () => { const state = globalThis.__compatBackground; const end = Date.now() + 5000; while (Date.now() < end) { const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString()); if (document?.isDirty && document.getText() === '<reopened>') return { dirty: true, expectedQuery: '<reopened>' }; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('The reopened primary edit did not reach the native dirty document before the Save trigger'); })()"
    When I press "<saveKey>"
    Then I collect JSON artifact "background-reopened-save" from extension host expression "(async () => { const state = globalThis.__compatBackground; await state.waitSaved('<reopened>'); await vscode.commands.executeCommand('vscode.openWith', state.uri, state.testCase.viewType, { preview: false }); state.closeBaselineMetadata = process.getBuiltinModule('node:fs').readFileSync(state.sidecar, 'utf8'); if (state.testCase.saveMode === 'focus') await vscode.workspace.getConfiguration('files').update('autoSave', state.autoSaveBefore, vscode.ConfigurationTarget.Workspace); return state.capture('background-reopened-<mode>-<extension>'); })()"
    Then I collect JSON artifact "background-close-wire-armed" from webview expression:
      """
      (() => {
        if (!document.getElementById('primary_bg') || !document.getElementById('background_note')) throw new Error('Not the source fixture');
        if (window.__e2eCaptureHostMessage) throw new Error('Capture hook still occupied');
        const state = { ordinaryDelivered: [], acknowledgements: [], backgroundHeld: null, blockOrdinary: false, documentCommands: 0 };
        window.addEventListener('message', event => {
          if (event.data?.type === 'persistDocumentAck') state.acknowledgements.push(event.data.snapshotId);
        }, true);
        state.hook = message => {
          if (message.type === 'markdownDocumentCommand') state.documentCommands++;
          if (message.type !== 'persistDocument') return true;
          if (message.testOnlyNoop) throw new Error('Persistence suppression invalidates close coverage');
          if (message.reason === 'beforeunload') return false;
          if (message.flushRequestId && message.reason === 'hidden') {
            state.backgroundHeld = { snapshotId: message.snapshotId, requestId: message.flushRequestId, at: Date.now(), note: message.state.sections.find(section => section.id === 'background_note')?.text };
            return false;
          }
          if (!message.flushRequestId) {
            if (state.blockOrdinary) return false;
            state.ordinaryDelivered.push({ snapshotId: message.snapshotId, note: message.state.sections.find(section => section.id === 'background_note')?.text });
          }
          return true;
        };
        window.__e2eCaptureHostMessage = state.hook;
        window.__compatCloseWire = state;
        return { armed: true, unloadIntentionallyDropped: true };
      })()
      """
    When I click "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview
    And I evaluate "(() => { const editor = document.querySelector('#background_note .toastui-editor-ww-container .ProseMirror'); editor.focus(); if (document.activeElement !== editor) throw new Error('Markdown close input is not focused'); return 'Markdown focused'; })()" in the webview
    And I press "End"
    And I type " Closing"
    Then I collect JSON artifact "background-close-acknowledged-edit" from webview expression:
      """
      (async () => {
        const state = window.__compatCloseWire;
        if (!state || window.__e2eCaptureHostMessage !== state.hook) throw new Error('Not the source capture owner');
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const draft = state.ordinaryDelivered.find(snapshot => snapshot.note?.trimEnd() === 'Before Current Newer Closing'
            && state.acknowledgements.includes(snapshot.snapshotId));
          if (draft) {
            if (state.documentCommands || document.getElementById('background_note').serialize().text.trimEnd() !== draft.note.trimEnd()) throw new Error('The acknowledged draft differs from the real edit');
            state.blockOrdinary = true;
            return { acknowledgedDraft: draft, documentCommands: 0 };
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('The real closing edit was not acknowledged before capture failure');
      })()
      """
    When I collect JSON artifact "background-close-hide" from extension host expression "(async () => { const state = globalThis.__compatBackground; await vscode.commands.executeCommand('vscode.openWith', state.other, 'kusto.kqlxEditor', { preview: false }); return { hidden: vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() === state.other.toString() }; })()"
    And I wait 3 seconds
    Then I collect JSON artifact "background-close-pending" from webview expression "(() => { const state = window.__compatCloseWire; if (!state?.backgroundHeld || Date.now() - state.backgroundHeld.at < 2000 || state.backgroundHeld.note?.trimEnd() !== 'Before Current Newer Closing' || state.documentCommands) throw new Error('The actual latest hidden close snapshot was not held beyond the Save deadline'); return { backgroundHeld: state.backgroundHeld, ordinaryDelivered: state.ordinaryDelivered, documentCommands: state.documentCommands }; })()"
    When I collect JSON artifact "background-exact-native-close" from extension host expression "(async () => { const state = globalThis.__compatBackground; const fs = process.getBuiltinModule('node:fs'); if (vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri?.toString() !== state.other.toString()) throw new Error('Hidden capture inspection activated the source'); if (fs.readFileSync(state.sidecar, 'utf8') !== state.closeBaselineMetadata || state.errors.length) throw new Error('The held closing edit was prematurely saved or reported as an error'); const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === state.uri.toString()); if (tabs.length !== 1 || !await vscode.window.tabGroups.close(tabs, true)) throw new Error('Exact hidden tab close failed'); return { closed: true }; })()"
    Then I collect JSON artifact "background-real-close-prompt" from extension host expression "(async () => { const state = globalThis.__compatBackground; const end = Date.now() + 5000; while (!state.prompts.length && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50)); if (state.prompts.length !== 1 || state.prompts[0].message !== 'You have unsaved notebook metadata changes in background.' + state.testCase.extension + '.json. Save them now?' || JSON.stringify(state.prompts[0].buttons) !== JSON.stringify(['Save', 'Discard']) || state.errors.length) throw new Error('Close did not preserve the acknowledged draft before reporting capture failure: ' + JSON.stringify({ prompts: state.prompts, errors: state.errors })); return state.prompts[0]; })()"
    When I click the "<closeChoice>" button
    Then I collect JSON artifact "background-close-choice-bytes" from extension host expression:
      """
      (async () => {
        const state = globalThis.__compatBackground;
        const fs = process.getBuiltinModule('node:fs');
        state.expectedCloseError = 'Failed to save companion metadata: Timed out waiting for the final ' + state.testCase.extension.toUpperCase() + ' metadata snapshot.';
        const end = Date.now() + 5000;
        while (Date.now() < end) {
          const text = fs.readFileSync(state.sidecar, 'utf8');
          const note = JSON.parse(text).state.sections.find(section => section.id === 'background_note')?.text.trimEnd();
          if (state.errors.some(error => error !== state.expectedCloseError) || state.errors.length > 1) throw new Error(JSON.stringify(state.errors));
          if (state.errors.length === 1 && note === state.testCase.closedNote && (state.testCase.closeChoice !== 'Discard' || text === state.closeBaselineMetadata)) {
            await vscode.commands.executeCommand('vscode.openWith', state.uri, state.testCase.viewType, { preview: false });
            return { closeChoice: state.testCase.closeChoice, note, injectedCaptureFailure: state.errors[0] };
          }
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        throw new Error('The real close choice did not preserve the expected companion bytes');
      })()
      """
    When I wait for "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview for 20 seconds
    Then I evaluate "(() => { if (document.getElementById('background_note').serialize().text.trimEnd() !== '<closedNote>' || document.getElementById('primary_bg').serialize().query !== '<reopened>') throw new Error('The native close outcome did not restore correctly'); return 'close outcome restored'; })()" in the webview
    Then I collect JSON artifact "foreground-fault-armed" from webview expression:
      """
      (() => {
        if (!document.getElementById('primary_bg') || window.__e2eCaptureHostMessage) throw new Error('Wrong source fixture or occupied capture hook');
        const post = window.vscode.postMessage.bind(window.vscode);
        const state = { held: null, requests: [], acknowledgements: [] };
        state.incoming = event => {
          if (event.data?.type === 'requestFinalPersist') state.requests.push({ requestId: event.data.requestId, reason: event.data.reason });
          if (event.data?.type === 'persistDocumentAck') state.acknowledgements.push(event.data.snapshotId);
        };
        state.hook = message => {
          if (message.testOnlyNoop) throw new Error('Noop cannot prove native persistence');
          if (!state.held && message.type === 'persistDocument' && message.reason === 'save' && message.flushRequestId) {
            state.held = structuredClone(message);
            return false;
          }
          return true;
        };
        state.release = () => {
          if (!state.held || window.__e2eCaptureHostMessage !== state.hook) throw new Error('No owned final reply to release');
          window.__e2eCaptureHostMessage = undefined;
          post(state.held);
        };
        window.addEventListener('message', state.incoming, true);
        window.__e2eCaptureHostMessage = state.hook;
        window.__compatForegroundFault = state;
        return { armed: true, fault: 'one real native Save reply held beyond its unchanged deadline' };
      })()
      """
    When I scroll "#primary_bg .query-editor" into view
    When I click "#primary_bg .query-editor" in the webview
    And I evaluate "(() => { const section = document.getElementById('primary_bg'); const input = section.querySelector('.monaco-editor textarea, .monaco-editor [contenteditable=true]'); input.focus(); if (!section.contains(document.activeElement)) throw new Error('Primary input is not focused'); return 'primary input focused'; })()" in the webview
    And I press "Ctrl+A"
    And I type "<failed>"
    Then I collect JSON artifact "foreground-native-ready" from extension host expression "(async () => { const state = globalThis.__compatBackground; const end = Date.now() + 5000; while (Date.now() < end) { const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString()); if (document?.isDirty && document.getText() === state.testCase.failed) return { dirty: true }; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('The final-Save fault has no native dirty input'); })()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "foreground-native-commit-and-failure" from extension host expression:
      """
      (async () => {
        const state = globalThis.__compatBackground;
        state.expectedFinalError = 'Timed out waiting for the final ' + state.testCase.extension.toUpperCase() + ' metadata snapshot.';
        await state.waitSaved(state.testCase.failed, state.testCase.closedNote);
        const end = Date.now() + 5000;
        while (!state.errors.includes(state.expectedFinalError) && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 50));
        if (JSON.stringify(state.errors) !== JSON.stringify([state.expectedCloseError, state.expectedFinalError])) throw new Error('The genuine native final-capture failure was not reported exactly once: ' + JSON.stringify(state.errors));
        const commit = state.nativeSaves.find(event => event.text === state.testCase.failed);
        const failure = state.errorEvents.find(event => event.message === state.expectedFinalError);
        if (!commit || commit.at >= failure.at) throw new Error('The probe did not observe native commit before final-capture failure');
        state.foregroundCommittedMetadata = process.getBuiltinModule('node:fs').readFileSync(state.sidecar, 'utf8');
        return { commitAt: commit.at, failureAt: failure.at, committedPrimary: state.testCase.failed, failure: failure.message };
      })()
      """
    When I click "#primary_bg .query-editor" in the webview
    And I evaluate "(() => { const section = document.getElementById('primary_bg'); const input = section.querySelector('.monaco-editor textarea, .monaco-editor [contenteditable=true]'); input.focus(); if (!section.contains(document.activeElement)) throw new Error('Primary input is not focused'); return 'primary input focused'; })()" in the webview
    And I press "Ctrl+A"
    And I type "<recovered>"
    Then I collect JSON artifact "foreground-newer-edit-ready" from extension host expression "(async () => { const state = globalThis.__compatBackground; const end = Date.now() + 5000; while (Date.now() < end) { const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString()); if (document?.isDirty && document.getText() === state.testCase.recovered) return { dirty: true }; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('A genuine failed capture blocked the next native edit'); })()"
    When I evaluate "(() => { window.__compatForegroundFault.release(); return 'expired final reply released unchanged'; })()" in the webview
    And I wait 1 second
    Then I collect JSON artifact "foreground-expired-reply-preserved-edit" from extension host expression "(() => { const state = globalThis.__compatBackground; const fs = process.getBuiltinModule('node:fs'); const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === state.uri.toString()); if (!document?.isDirty || document.getText() !== state.testCase.recovered || fs.readFileSync(state.uri.fsPath, 'utf8') !== state.testCase.failed || fs.readFileSync(state.sidecar, 'utf8') !== state.foregroundCommittedMetadata) throw new Error('The expired final reply changed the newer dirty edit or committed bytes'); return { dirty: true, oldReplyDidNotOverwrite: true }; })()"
    When I press "Ctrl+S"
    Then I collect JSON artifact "foreground-confirmed-retry" from extension host expression "(async () => { const state = globalThis.__compatBackground; await state.waitSaved(state.testCase.recovered, state.testCase.closedNote); if (JSON.stringify(state.errors) !== JSON.stringify([state.expectedCloseError, state.expectedFinalError])) throw new Error(JSON.stringify(state.errors)); return { confirmedQuery: state.testCase.recovered, metadata: state.testCase.closedNote }; })()"
    Then I collect JSON artifact "foreground-expired-reply-proof" from webview expression "(() => { const state = window.__compatForegroundFault; if (!state.held || state.acknowledgements.includes(state.held.snapshotId) || state.requests.filter(request => request.reason === 'save').length !== 2) throw new Error('Expired reply was acknowledged or confirmed Save did not request fresh state'); window.removeEventListener('message', state.incoming, true); return { expiredReplyAcknowledged: false, requests: state.requests }; })()"
    When I collect JSON artifact "foreground-reopen" from extension host expression "(async () => { const state = globalThis.__compatBackground; const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === state.uri.toString()); if (tabs.length !== 1 || tabs[0].isDirty || !await vscode.window.tabGroups.close(tabs)) throw new Error('Confirmed native Save did not leave a clean close'); await vscode.commands.executeCommand('vscode.openWith', state.uri, state.testCase.viewType, { preview: false }); return { reopened: state.uri.toString() }; })()"
    When I wait for "#background_note .toastui-editor-ww-container .ProseMirror > p:first-child" in the webview for 20 seconds
    Then I evaluate "(() => { if (document.getElementById('background_note').serialize().text.trimEnd() !== '<closedNote>' || document.getElementById('primary_bg').serialize().query !== '<recovered>') throw new Error('Confirmed Save after capture failure did not restore correctly'); return 'post-failure Save restored'; })()" in the webview
    Then I collect JSON artifact "background-close-restored" from extension host expression "globalThis.__compatBackground.capture('background-close-<mode>-<extension>')"
    Then I collect JSON artifact "background-cleanup" from extension host expression:
      """
      (async () => {
        const state = globalThis.__compatBackground;
        const fs = process.getBuiltinModule('node:fs');
        state.saveSubscription.dispose();
        state.willSaveSubscription.dispose();
        const owned = new Set([state.uri.toString(), state.other.toString()]);
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => owned.has(tab.input?.uri?.toString()));
        if (tabs.some(tab => tab.isDirty) || !await vscode.window.tabGroups.close(tabs)) throw new Error('Owned tab cleanup failed');
        if (vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Unexpected tabs remain');
        if (JSON.stringify(state.errors) !== JSON.stringify([state.expectedCloseError, state.expectedFinalError])) throw new Error(JSON.stringify(state.errors));
        if (state.window.showErrorMessage !== state.record || state.window.showWarningMessage !== state.recordWarning) throw new Error('Notification capture ownership changed');
        state.window.showErrorMessage = state.original;
        state.window.showWarningMessage = state.originalWarning;
        await vscode.commands.executeCommand('notifications.clearAll');
        for (const file of [state.uri.fsPath, state.sidecar, state.other.fsPath]) fs.unlinkSync(file);
        delete globalThis.__compatBackground;
        delete globalThis.__compatBackgroundCase;
        return { finalTabs: 0, fixtureDocumentsRemoved: true, notificationHookRestored: true, screenshotFolder: state.root };
      })()
      """

    Examples:
      | mode       | saveMode | closeChoice | extension | primary | kind | viewType              | initial                | edited                 | reopened               | failed                 | recovered              | saveKey       | closedNote                   |
      | delayed    | manual   | Save        | kql       | query   | kqlx | kusto.kqlCompatEditor | print Background = 1   | print Background = 2   | print Background = 3   | print Background = 4   | print Background = 5   | Ctrl+S        | Before Current Newer Closing |
      | delayed    | manual   | Discard     | sql       | sql     | sqlx | kusto.sqlCompatEditor | SELECT 1 AS Background | SELECT 2 AS Background | SELECT 3 AS Background | SELECT 4 AS Background | SELECT 5 AS Background | Ctrl+S        | Before Current Newer         |
      | superseded | manual   | Discard     | kql       | query   | kqlx | kusto.kqlCompatEditor | print Background = 1   | print Background = 2   | print Background = 3   | print Background = 4   | print Background = 5   | Ctrl+S        | Before Current Newer         |
      | superseded | manual   | Save        | sql       | sql     | sqlx | kusto.sqlCompatEditor | SELECT 1 AS Background | SELECT 2 AS Background | SELECT 3 AS Background | SELECT 4 AS Background | SELECT 5 AS Background | Ctrl+S        | Before Current Newer Closing |
      | delayed    | focus    | Save        | kql       | query   | kqlx | kusto.kqlCompatEditor | print Background = 1   | print Background = 2   | print Background = 3   | print Background = 4   | print Background = 5   | Ctrl+PageDown | Before Current Newer Closing |
      | superseded | focus    | Discard     | sql       | sql     | sqlx | kusto.sqlCompatEditor | SELECT 1 AS Background | SELECT 2 AS Background | SELECT 3 AS Background | SELECT 4 AS Background | SELECT 5 AS Background | Ctrl+PageDown | Before Current Newer         |
