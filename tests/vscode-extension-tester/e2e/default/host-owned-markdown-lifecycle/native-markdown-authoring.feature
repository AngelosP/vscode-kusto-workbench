Feature: Fresh-host native Markdown authoring preserves an independent source baseline

  # Pre-edit review: approved conditionally on actual trusted native-control evidence.
  # C1: Include one composed cold URI activation -> typing -> Bold -> Undo/Redo ->
  # Manual Save -> exact clean close/reopen -> second typing/Manual Save -> clean close.
  # Owners: Markdown authoring intent, document commands, native Save, rich-file overlay.
  # The neighboring lifecycle feature uses direct mutations and is only partial evidence.
  # Defer Auto Save on, other document kinds, live queries, auth, Production and visual
  # qualification: this companion is restricted to a fresh manual-Save Development host.
  # Never run the parent directory as a substitute for exact-file selection.

  Scenario: Trusted formatting and two manual Saves survive the first public reopen
    Given I collect JSON artifact "native-markdown-fresh-host" from extension host expression:
      """
      (async () => {
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const crypto = process.getBuiltinModule('node:crypto');
        const util = process.getBuiltinModule('node:util');
        const url = process.getBuiltinModule('node:url');
        const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs);
        const cliRoot = process.env.KW_MD_NATIVE_CLI_ROOT;
        const portText = process.env.KW_MD_NATIVE_CDP_PORT;
        const runToken = process.env.KW_MD_NATIVE_RUN_TOKEN;
        if (globalThis.__nativeMarkdownAuthoring || !extension || extension.isActive || tabs.length || vscode.workspace.workspaceFolders?.length) throw new Error('BLOCKED: requires an inactive Workbench, zero tabs, no workspace and no previous companion runtime; do not reset');
        if (process.platform !== 'win32' || !cliRoot || !path.isAbsolute(cliRoot) || !/^[0-9]+$/.test(portText || '') || Number(portText) < 1024 || Number(portText) > 65535 || !/^[a-f0-9]{32}$/.test(runToken || '') || vscode.version !== process.env.KW_MD_NATIVE_VSCODE_VERSION) throw new Error('BLOCKED: launch this exact feature in a fresh isolated CLI host with explicit CDP port, CLI module root, run token and editor version');
        const { CdpClient } = await import(url.pathToFileURL(path.join(cliRoot, 'dist/runner/cdp-client.js')).href);
        const { NativeUIClient } = await import(url.pathToFileURL(path.join(cliRoot, 'dist/runner/native-ui-client.js')).href);
        for (const name of ['connect', 'evaluate', 'evaluateInWebview', 'pressKey', 'typeText', 'listWebviewFrameContexts', 'synchronizeResolvedWebviewForNativeCapture']) if (typeof CdpClient.prototype[name] !== 'function') throw new Error('BLOCKED: installed CdpClient lacks ' + name);
        for (const name of ['start', 'stop', 'listWindows', 'findElement', 'clickMouse', 'focusWindow']) if (typeof NativeUIClient.prototype[name] !== 'function') throw new Error('BLOCKED: installed NativeUIClient lacks ' + name);
        const probe = {
          fs, path, crypto, util, url, extension, CdpClient, NativeUIClient,
          cdp: new CdpClient(Number(portText)), runToken,
          hash: value => crypto.createHash('sha256').update(value).digest('hex'),
          phase: 'fresh-host', passes: new Set(), activations: [], observations: [], saves: [], failures: [], observers: [],
          native: null, owner: null, expectedSavedBytes: null, intentStarted: false,
        };
        globalThis.__nativeMarkdownAuthoring = probe;
        probe.run = async (phase, operation) => {
          probe.phase = phase;
          try { return await operation(); }
          catch (error) {
            const message = String(error?.message || error);
            probe.failures.push({ phase, message, root: probe.owner?.root || null });
            throw new Error(message + '; phase=' + phase + '; retainedFixtureRoot=' + (probe.owner?.root || 'not-staged'));
          }
        };
        await probe.cdp.connect();
        return { extensionInactive: true, tabCount: 0, workspaceFolderCount: 0, duplicateRuntime: false, cdpPort: Number(portText), editorVersion: vscode.version, cliVersion: JSON.parse(fs.readFileSync(path.join(cliRoot, 'package.json'), 'utf8')).version, visualQualification: false, productionQualification: false };
      })()
      """
    Then I collect JSON artifact "native-markdown-private-before-image" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('stage-before-open', async () => {
          if (probe.extension.isActive || vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('Fresh-host guard changed before configuration');
          const files = vscode.workspace.getConfiguration('files');
          for (const [key, value] of [['autoSave', 'off'], ['insertFinalNewline', false], ['trimTrailingWhitespace', false], ['trimFinalNewlines', false]]) await files.update(key, value, vscode.ConfigurationTarget.Global);
          const settings = vscode.workspace.getConfiguration('kustoWorkbench');
          for (const key of ['openKqlFiles', 'openCslFiles', 'openMdFiles', 'openSqlFiles', 'didYouKnow.enabled', 'externalTools.enabled', 'copilotCli.enabled', 'editing.autoTriggerAutocompleteEnabled', 'editing.copilotInlineCompletionsEnabled', 'editing.caretDocsEnabled']) await settings.update(key, false, vscode.ConfigurationTarget.Global);
          if (vscode.workspace.getConfiguration('files').get('autoSave') !== 'off') throw new Error('Fresh owned profile did not accept manual-Save configuration');
          const helpers = await import(probe.url.pathToFileURL(probe.path.join(probe.extension.extensionPath, 'scripts/repro-published-notebook.mjs')).href);
          probe.owner = helpers.createAcceptanceRoot();
          probe.assertRoot = () => helpers.assertAcceptanceRoot(probe.owner);
          const root = probe.assertRoot();
          const token = probe.crypto.randomBytes(12).toString('hex');
          probe.ids = { markdown: 'md_control_' + token, query: 'query_control_' + token, html: 'html_identity_' + token, notes: 'devnotes_control_' + token };
          probe.intro = 'Native Markdown intro paragraph.';
          probe.rawMarkdown = probe.intro + '\r\n\r\n* First bullet\r\n* Second bullet\r\n\r\n+ Third bullet\r\n\r\n- Fourth bullet\r\n\r\n\r\n';
          probe.authoredTail = '\n\n* First bullet\n* Second bullet\n\n\n+ Third bullet\n\n\n- Fourth bullet';
          probe.expectedPlain = probe.intro + ' Nativeword' + probe.authoredTail;
          probe.expectedBold = probe.intro + ' **Nativeword**' + probe.authoredTail;
          probe.expectedSecond = 'Reopenedword ' + probe.intro + ' **Nativeword**' + probe.authoredTail;
          probe.source = {
            kind: 'kqlx', version: 1, futureRoot: { keep: 'native-root', nested: [1, { value: 'unchanged' }] },
            state: { futureState: { keep: 'native-state' }, sections: [
              { id: probe.ids.markdown, type: 'markdown', title: 'Private native authoring', text: probe.rawMarkdown, tab: 'edit', mode: 'wysiwyg', expanded: true, futureMarkdown: { keep: 'native-markdown' } },
              { id: probe.ids.query, type: 'query', name: 'Private unexecuted query', query: 'print NativeMarkdownPrivateQueryNotRun=7', expanded: false, futureQuery: { keep: 'native-query' } },
              { id: probe.ids.html, type: 'html', name: 'Inert identity sentinel', code: '<main>Private identity sentinel</main>', mode: 'preview', expanded: false, dataSourceIds: [probe.ids.query], futureHtml: { keep: 'native-html' } },
              { id: probe.ids.notes, type: 'devnotes', futureDevnotes: { keep: 'native-notes' }, entries: [{ id: 'note_' + token, created: '2026-10-14T00:00:00.000Z', updated: '2026-10-14T00:00:00.000Z', category: 'usage-note', content: 'Private preservation sentinel; never replace this note.', source: 'agent', relatedSectionIds: [probe.ids.markdown], futureNote: { keep: 'native-note-entry' } }] },
              { id: 'future_' + token, type: 'future-section', payload: { keep: ['native-opaque', 17] } },
            ] },
          };
          probe.fileName = 'native-markdown-' + token + '.kqlx';
          probe.uri = vscode.Uri.file(probe.path.join(root, probe.fileName));
          probe.beforePath = probe.path.join(root, 'independent-before-image.kqlx');
          probe.baselineBytes = Buffer.from(JSON.stringify(probe.source, null, 2).replace(/\n/g, '\r\n') + ' \r\n\r\n', 'utf8');
          probe.baselineSha = probe.hash(probe.baselineBytes);
          for (const filePath of [probe.uri.fsPath, probe.beforePath]) probe.fs.writeFileSync(filePath, Buffer.from(probe.baselineBytes), { flag: 'wx' });
          probe.assertIndependent = () => {
            probe.assertRoot();
            for (const filePath of [probe.uri.fsPath, probe.beforePath]) {
              const stat = probe.fs.lstatSync(filePath);
              if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Private source or independent before-image is aliased');
            }
            if (!probe.fs.readFileSync(probe.beforePath).equals(probe.baselineBytes) || probe.hash(probe.fs.readFileSync(probe.beforePath)) !== probe.baselineSha) throw new Error('Independent before-image changed; no rebaseline');
          };
          probe.document = () => {
            const matches = vscode.workspace.textDocuments.filter(document => document.uri.toString() === probe.uri.toString());
            if (matches.length !== 1) throw new Error('Exact private TextDocument is missing or duplicated');
            return matches[0];
          };
          probe.expectedFile = markdown => {
            const expected = structuredClone(probe.source);
            expected.state.sections[0].text = markdown;
            return expected;
          };
          probe.active = () => {
            probe.assertIndependent();
            const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === probe.uri.toString());
            const active = vscode.window.tabGroups.activeTabGroup.activeTab;
            if (tabs.length !== 1 || tabs[0] !== active || !active.isActive || !(active.input instanceof vscode.TabInputCustom) || active.input.viewType !== 'kusto.kqlxEditor') throw new Error('Exact SDK private URI/custom-editor target is not active or is duplicated');
            if (vscode.workspace.getConfiguration('files', { uri: probe.uri, languageId: 'kqlx' }).get('autoSave') !== 'off') throw new Error('Manual-Save configuration changed after the fixture baseline');
            return active;
          };
          probe.untouched = phase => {
            probe.assertIndependent();
            const document = probe.document();
            const bytes = probe.fs.readFileSync(probe.uri.fsPath);
            const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === probe.uri.toString());
            if (document !== probe.initialModel || document.version !== probe.initialVersion || document.isDirty || tabs.some(tab => tab.isDirty) || document.getText() !== probe.baselineBytes.toString('utf8') || !bytes.equals(probe.baselineBytes) || probe.observations.some(event => event.beforeIntent && (event.dirty || event.version !== probe.initialVersion || event.sha256 !== probe.baselineSha)) || probe.saves.length) throw new Error('Untouched bytes/model version/dirty state changed before genuine input; no restoration or setup Save');
            return { phase, uri: probe.uri.toString(), version: document.version, dirty: false, byteLength: bytes.length, sha256: probe.hash(bytes), independentSha256: probe.baselineSha, nativeSaveCount: 0 };
          };
          const capture = document => {
            if (document.uri.toString() !== probe.uri.toString()) return;
            probe.observations.push({ phase: probe.phase, at: Date.now(), beforeIntent: !probe.intentStarted, version: document.version, dirty: document.isDirty, sha256: probe.hash(document.getText()) });
          };
          probe.observers.push(vscode.workspace.onDidChangeTextDocument(event => capture(event.document)));
          probe.observers.push(vscode.workspace.onWillSaveTextDocument(event => {
            if (event.document.uri.toString() === probe.uri.toString()) probe.saves.push({ event: 'will', reason: event.reason, phase: probe.phase, at: Date.now(), version: event.document.version });
          }));
          probe.observers.push(vscode.workspace.onDidSaveTextDocument(document => {
            if (document.uri.toString() === probe.uri.toString()) probe.saves.push({ event: 'did', phase: probe.phase, at: Date.now(), version: document.version });
          }));
          probe.initialModel = await vscode.workspace.openTextDocument(probe.uri);
          probe.initialVersion = probe.initialModel.version;
          if (!Number.isSafeInteger(probe.initialVersion) || probe.initialVersion <= 0) throw new Error('Pre-activation model version is unavailable');
          return { root, fixtureUri: probe.uri.toString(), independentBeforeImage: probe.beforePath, baseline: probe.untouched('before-first-public-activation'), allFixtureWritesBeforeOpen: true, queryExecutedByTest: false, resetFlagsUsed: false };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-first-public-activation" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('first-public-activation', async () => {
          probe.untouched('before-extension-activation');
          await probe.extension.activate();
          const setupTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.viewType === 'kustoFirstLaunchSetup');
          if (setupTabs.length > 1) throw new Error('BLOCKED: duplicate first-launch panels in the fresh host');
          if (setupTabs.length === 1) {
            const focused = await probe.cdp.evaluateInWebview("(() => { const host = document.querySelector('kw-first-launch-setup'); const button = host?.shadowRoot?.querySelector('[data-testid=first-launch-secondary]'); if (!button || button.disabled || button.textContent.trim() !== 'Skip setup') return null; button.focus(); return { focused: host.shadowRoot.activeElement === button, setup: 'automatic' }; })()", undefined, { timeoutMs: 5000 });
            if (focused?.focused !== true || focused.setup !== 'automatic') throw new Error('BLOCKED: real first-launch Skip setup control is unavailable; no reset flags');
            await probe.cdp.pressKey('Enter');
            const deadline = Date.now() + 5000;
            while (vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input?.viewType === 'kustoFirstLaunchSetup')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
            if (vscode.window.tabGroups.all.some(group => group.tabs.length)) throw new Error('BLOCKED: first-launch setup did not close its own panel');
          }
          probe.untouched('after-explicit-native-setup');
          probe.activate = async label => {
            const expectedCount = label === 'first' ? 0 : 1;
            if (probe.activations.length !== expectedCount) throw new Error('Public activation was already attempted; no retry');
            const attempt = { label, targetFileUri: probe.uri.toString(), parsed: false };
            probe.activations.push(attempt);
            const result = await vscode.lm.invokeTool('kusto-workbench_activate-workbench-file', { toolInvocationToken: undefined, input: { targetFileUri: probe.uri.toString() } });
            const parts = result.content.filter(part => typeof part?.value === 'string');
            if (parts.length !== 1) throw new Error('First public activation did not return one parseable response; no retry');
            const value = JSON.parse(parts[0].value);
            Object.assign(attempt, { raw: result, value });
            probe.assertRoot();
            probe.fs.writeFileSync(probe.path.join(probe.owner.root, label + '-public-activation.json'), JSON.stringify(attempt, null, 2), { flag: 'wx' });
            if (value.success !== true || value.isLiveWorkbench !== true || value.uri !== probe.uri.toString()) throw new Error('Public activation did not establish the exact live target URI; no inventory warming or retry');
            probe.active();
            Object.assign(attempt, { parsed: true, success: true, live: true, uri: value.uri, openFileId: value.openFileId || null });
            return { ...attempt };
          };
          const activation = await probe.activate('first');
          return { activation, baseline: probe.untouched('after-first-public-activation'), inventoryWarmingCalls: 0, bundleOnDiskSha256: probe.hash(probe.fs.readFileSync(probe.path.join(probe.extension.extensionPath, probe.extension.packageJSON.main))), developmentLaunchOnly: true };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-constructor-and-lazy-editor" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('constructor-and-lazy-editor', async () => {
          probe.ui = async (focus = false, install = false, waitForBoldEventAfter) => {
            probe.active();
            if (waitForBoldEventAfter !== undefined && (!Number.isSafeInteger(waitForBoldEventAfter) || waitForBoldEventAfter < 0)) throw new Error('Invalid trusted Bold observation offset');
            const read = async current => {
              const section = document.getElementById(current.ids.markdown);
              const identitySection = document.getElementById(current.ids.html);
              if (!section || !identitySection || typeof window.__e2e?.html?.documentOwnershipSnapshot !== 'function' || typeof window.__e2e?.workbench?.documentViewSession !== 'function') return null;
              const identity = window.__e2e.html.documentOwnershipSnapshot(current.ids.html);
              if (identity.documentUri !== current.uri || identity.sourceId !== current.ids.query) throw new Error('Wrong actual document URI/source in the existing HTML ownership snapshot');
              const editorContainer = document.getElementById(current.ids.markdown + '_md_editor');
              const root = editorContainer?.querySelector('.toastui-editor-ww-container .ProseMirror');
              const api = window.__kustoMarkdownEditors?.[current.ids.markdown];
              if (!root || !api || section.serialize().mode !== 'wysiwyg') return null;
              if (api !== section.getEditorApi()) throw new Error('Registered Markdown API is not owned by the current section');
              if (!section.contains(editorContainer) || root.ownerDocument !== document || !root.isConnected || document.getElementById(current.ids.markdown) !== section) throw new Error('ProseMirror does not belong to the current exact Markdown root path');
              if (identity.currentArtifactId !== null || identity.boundArtifactId !== null || document.querySelector('kw-data-table')) throw new Error('Private unexecuted Query acquired result artifacts');
              if (current.install) {
                if (globalThis.__nativeMarkdownControlProbe) throw new Error('Duplicate observer in the same frame');
                const trace = { token: current.token, root, events: [] };
                globalThis.__nativeMarkdownControlProbe = trace;
                for (const type of ['beforeinput', 'input', 'keydown', 'pointerdown', 'mousedown', 'mouseup', 'click']) editorContainer.addEventListener(type, event => {
                  const button = event.target instanceof Element ? event.target.closest('button') : null;
                  trace.events.push({ type, isTrusted: event.isTrusted, at: Date.now(), editingSurface: event.target instanceof Node && root.contains(event.target), bold: !!button && (button.matches('.bold, [aria-label^=Bold], [title^=Bold]') || !!button.querySelector('.bold')), key: event.key || null, ctrlKey: event.ctrlKey === true, shiftKey: event.shiftKey === true, inputType: event.inputType || null, dataLength: typeof event.data === 'string' ? event.data.length : null });
                }, true);
              }
              const trace = globalThis.__nativeMarkdownControlProbe;
              if (trace && (trace.token !== current.token || trace.root !== root)) throw new Error('Observer belongs to a retired Markdown frame/root');
              let settlement;
              if (current.waitForBoldEventAfter !== undefined) {
                if (!trace || !Number.isSafeInteger(current.waitForBoldEventAfter) || current.waitForBoldEventAfter < 0 || current.waitForBoldEventAfter > trace.events.length) throw new Error('Invalid current-frame trusted Bold observation');
                const started = performance.now();
                const deadline = started + 1500;
                const assertCurrent = () => {
                  const liveSection = document.getElementById(current.ids.markdown);
                  const liveContainer = document.getElementById(current.ids.markdown + '_md_editor');
                  const liveRoot = liveContainer?.querySelector('.toastui-editor-ww-container .ProseMirror');
                  if (liveSection !== section || liveContainer !== editorContainer || liveRoot !== root || !root.isConnected || globalThis.__nativeMarkdownControlProbe !== trace || trace.token !== current.token || trace.root !== root || window.__e2e.html.documentOwnershipSnapshot(current.ids.html).documentUri !== current.uri) throw new Error('Trusted Bold observation owner changed while awaiting the same click');
                };
                const delivered = () => trace.events.slice(current.waitForBoldEventAfter).some(event => event.type === 'click' && event.bold && event.isTrusted);
                assertCurrent();
                while (!delivered() && performance.now() < deadline) {
                  await new Promise(resolve => setTimeout(resolve, 25));
                  assertCurrent();
                }
                assertCurrent();
                settlement = { elapsedMs: performance.now() - started, trustedBoldDelivered: delivered(), eventOffset: current.waitForBoldEventAfter };
              }
              if (current.focus) root.focus({ preventScroll: true });
              let focused = document.activeElement;
              while (focused?.shadowRoot?.activeElement) focused = focused.shadowRoot.activeElement;
              const paragraph = root.querySelector(':scope > p:first-child');
              const session = window.__e2e.workbench.documentViewSession();
              const bold = editorContainer.querySelector('button.bold, button[aria-label^=Bold], button[title^=Bold]');
              const boldRect = bold?.getBoundingClientRect();
              const geometry = { frameUrl: location.href, viewport: { width: innerWidth, height: innerHeight, dpr: devicePixelRatio }, boldRect: boldRect ? { x: boldRect.x, y: boldRect.y, width: boldRect.width, height: boldRect.height } : null };
              return { token: current.token, uri: identity.documentUri, viewSessionId: session.viewSessionId, sourceGeneration: session.sourceGeneration, sourceText: section.getText(), editorSourceText: api.getValue(), registeredApiIsCurrent: api === section.getEditorApi(), currentApiText: section.getEditorApi()?.getValue(), paragraphText: paragraph?.textContent ?? null, strong: Array.from(paragraph?.querySelectorAll('strong') || []).map(element => element.textContent), selection: window.getSelection()?.toString() || '', focused: focused === root && root.getRootNode().activeElement === root, documentFocused: document.hasFocus(), visible: document.visibilityState === 'visible', currentRootPath: section.id + '/' + editorContainer.id + '/.toastui-editor-ww-container/.ProseMirror', boldPresent: !!bold && !bold.disabled && bold.getBoundingClientRect().width > 0, events: trace?.events || [], settlement, geometry, queryArtifactAbsent: true };
            };
            const value = await probe.cdp.evaluateInWebview('(' + read.toString() + ')(' + JSON.stringify({ ids: probe.ids, uri: probe.uri.toString(), token: probe.runToken, focus, install, waitForBoldEventAfter }) + ')', undefined, { timeoutMs: 5000 });
            if (!value || value.token !== probe.runToken || value.uri !== probe.uri.toString() || !value.viewSessionId || value.visible !== true) throw new Error('BLOCKED: no exact live URI/token/session-bearing CDP frame; an undefined SDK result is not success');
            probe.active();
            return value;
          };
          const deadline = Date.now() + 15000;
          let ui;
          while (Date.now() < deadline) {
            probe.untouched('while-lazy-editor-initializes');
            try { ui = await probe.ui(); }
            catch (error) {
              if (!String(error.message).startsWith('BLOCKED: no exact live URI/token/session-bearing CDP frame')) throw error;
            }
            if (ui) break;
            await new Promise(resolve => setTimeout(resolve, 75));
          }
          if (!ui || ui.sourceText !== probe.rawMarkdown || ui.editorSourceText !== probe.rawMarkdown || ui.paragraphText !== probe.intro || ui.strong.length || !ui.boldPresent) throw new Error('Initial WYSIWYG constructor/lazy editor did not retain exact raw Markdown and intro paragraph');
          await probe.ui(false, true);
          const synchronization = await probe.cdp.synchronizeResolvedWebviewForNativeCapture();
          const frames = await probe.cdp.listWebviewFrameContexts();
          const context = frames.find(target => target.targetId === synchronization?.targetId)?.contexts.find(candidate => candidate.id === synchronization?.contextId);
          if (!synchronization || synchronization.visibilityState !== 'visible' || !context?.frameId) throw new Error('BLOCKED: actual current target/context/frame identity is unavailable');
          probe.frame = { targetId: synchronization.targetId, contextId: synchronization.contextId, frameId: context.frameId };
          probe.initialViewSession = ui.viewSessionId;
          const shell = await probe.cdp.evaluate('({ title: document.title, focused: document.hasFocus() })');
          if (!shell?.title?.includes(probe.fileName)) throw new Error('BLOCKED: isolated CDP window does not identify the exact private file');
          probe.native = new probe.NativeUIClient();
          await probe.native.start();
          const windows = (await probe.native.listWindows()).filter(window => window.isVisible && window.title === shell.title);
          if (windows.length !== 1 || !windows[0].nativeHandle || !Number.isSafeInteger(windows[0].processId)) throw new Error('BLOCKED: exact private CDP title has no unique actual native window/PID');
          probe.window = windows[0];
          probe.native.targetPid = probe.window.processId;
          await probe.native.focusWindow(probe.window.id);
          probe.passes.add('constructor-raw-source-preserved');
          return { baseline: probe.untouched('after-constructor-and-lazy-editor'), frame: probe.frame, window: { id: probe.window.id, processId: probe.window.processId, nativeHandle: probe.window.nativeHandle }, sourceTextExact: true, introParagraphExact: true, queryArtifactAbsent: true, visualQualification: false };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-trusted-paragraph-input" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('first-genuine-input', async () => {
          const ui = await probe.ui(true);
          if (!ui.focused || !ui.documentFocused || ui.paragraphText !== probe.intro || ui.events.length) throw new Error('Before genuine input the correct current ProseMirror document/root is not focused or input already occurred');
          const baseline = probe.untouched('immediately-before-genuine-input');
          probe.intentStarted = true;
          await probe.cdp.pressKey('Ctrl+Home');
          await probe.cdp.pressKey('End');
          await probe.cdp.typeText(' Nativeword');
          const authored = await probe.ui();
          const trusted = authored.events.filter(event => event.type === 'beforeinput' && event.isTrusted && event.editingSurface);
          probe.assertRoot();
          probe.fs.writeFileSync(probe.path.join(probe.owner.root, 'first-input-state.json'), JSON.stringify({ authored, expectedPlain: probe.expectedPlain, expectedParagraph: probe.intro + ' Nativeword' }, null, 2), { flag: 'wx' });
          if (!authored.focused || !authored.documentFocused || !trusted.length || authored.events.some(event => ['beforeinput', 'input'].includes(event.type) && !event.isTrusted) || authored.sourceText !== probe.expectedPlain || authored.editorSourceText !== probe.expectedPlain || authored.paragraphText !== probe.intro + ' Nativeword' || authored.strong.length) throw new Error('Genuine native paragraph input did not author the exact expected Markdown/current focused root');
          probe.waitModel = async expectedText => {
            const deadline = Date.now() + 10000;
            while (Date.now() < deadline) {
              probe.active();
              const document = probe.document();
              if (document.isDirty && document.version > probe.initialVersion && probe.util.isDeepStrictEqual(JSON.parse(document.getText()), probe.expectedFile(expectedText))) return { dirty: true, version: document.version, sha256: probe.hash(document.getText()), everyOtherFieldExact: true };
              await new Promise(resolve => setTimeout(resolve, 75));
            }
            probe.assertRoot();
            const model = probe.document();
            probe.fs.writeFileSync(probe.path.join(probe.owner.root, 'authored-model-failure.json'), JSON.stringify({ expected: probe.expectedFile(expectedText), actualText: model.getText(), version: model.version, dirty: model.isDirty, observations: probe.observations }, null, 2), { flag: 'wx' });
            throw new Error('Authored host model did not reach the exact text with every other source field unchanged');
          };
          const model = await probe.waitModel(probe.expectedPlain);
          if (!probe.fs.readFileSync(probe.uri.fsPath).equals(probe.baselineBytes) || probe.saves.length) throw new Error('Manual-Save source changed on disk before Ctrl+S');
          probe.passes.add('trusted-paragraph-input');
          return { baseline, currentRootPath: authored.currentRootPath, trustedBeforeInputCount: trusted.length, normalizedOnlyAfterGenuineInput: true, exactAuthoredMarkdown: true, model, queryArtifactAbsent: authored.queryArtifactAbsent };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-trusted-bold-control" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('trusted-bold-control', async () => {
          probe.active();
          await probe.cdp.pressKey('Ctrl+Shift+Left');
          const before = await probe.ui();
          if (!before.focused || !before.documentFocused || before.selection !== 'Nativeword' || before.sourceText !== probe.expectedPlain || !before.boldPresent) throw new Error('Real keyboard did not select the exact word in the current Markdown document before Bold');
          const currentShell = await probe.cdp.evaluate('({ title: document.title })');
          const windows = (await probe.native.listWindows()).filter(window => window.processId === probe.window.processId && window.nativeHandle === probe.window.nativeHandle && window.isVisible && window.title === currentShell?.title && window.title.includes(probe.fileName));
          if (windows.length !== 1) throw new Error('BLOCKED: exact native window owner changed before Bold');
          probe.window = windows[0];
          await probe.native.focusWindow(probe.window.id);
          let button = await probe.native.findElement(probe.window.id, 'Bold', 'Button');
          if (!button) button = await probe.native.findElement(probe.window.id, 'Bold (Ctrl+B)', 'Button');
          const bounds = button?.bounds;
          const windowBounds = windows[0].bounds;
          if (!button || !button.isVisible || !button.isEnabled || !/^Bold(?: \(Ctrl\+B\))?$/.test(button.name) || !bounds || ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0 || bounds.x < windowBounds.x || bounds.y < windowBounds.y || bounds.x + bounds.width > windowBounds.x + windowBounds.width || bounds.y + bounds.height > windowBounds.y + windowBounds.height) throw new Error('BLOCKED: NativeUIClient.findElement cannot resolve a visible Bold button inside the exact owned window after two name probes; no synthetic click or guessed coordinates');
          const selected = await probe.ui();
          if (selected.selection !== 'Nativeword') throw new Error('Native owner resolution changed the selected word before the sole Bold click');
          const geometry = { guest: selected.geometry, window: probe.window, button, errors: [], nativeNodeCount: 0, documents: [] };
          try {
            geometry.synchronization = await probe.cdp.synchronizeResolvedWebviewForNativeCapture();
            if (!geometry.synchronization) throw new Error('Current resolved webview synchronization is missing');
            const helpers = await import(probe.url.pathToFileURL(probe.path.join(probe.extension.extensionPath, 'scripts/repro-published-notebook.mjs')).href);
            geometry.frameOwner = await helpers.readAcceptanceFrameOwner(probe.cdp, geometry.synchronization);
          } catch (error) { geometry.errors.push(String(error?.message || error)); }
          try {
            const tree = await probe.native.getElementTree(probe.window.id);
            const pending = Array.isArray(tree) ? [...tree] : [tree];
            while (pending.length) {
              if (++geometry.nativeNodeCount > 12000) throw new Error('Native tree exceeds the local 12000-node observation bound');
              const node = pending.pop();
              if (!node || typeof node !== 'object') continue;
              const element = node.element || node;
              if (element.controlType === 'Document') geometry.documents.push({ id: element.id, name: element.name, controlType: element.controlType, isVisible: element.isVisible, bounds: element.bounds });
              if (geometry.documents.length > 64) throw new Error('Native Document candidates exceed the local observation bound');
              if (Array.isArray(node.children)) pending.push(...node.children);
            }
            const shell = geometry.frameOwner?.shell;
            const candidates = geometry.documents.filter(element => element.isVisible === true && element.name === shell?.documentTitle);
            geometry.exactDocumentMatches = candidates.length;
            const root = candidates.length === 1 ? candidates[0].bounds : null;
            geometry.nativeShellGeometryProven = !!root && [root.x, root.y, root.width, root.height, shell?.viewport?.width, shell?.viewport?.height, shell?.viewport?.dpr].every(Number.isFinite)
              && Math.abs(root.width - shell.viewport.width * shell.viewport.dpr) <= 2 && Math.abs(root.height - shell.viewport.height * shell.viewport.dpr) <= 2;
          } catch (error) { geometry.errors.push(String(error?.message || error)); }
          probe.assertRoot();
          probe.fs.writeFileSync(probe.path.join(probe.owner.root, 'bold-control-geometry.json'), JSON.stringify(geometry, null, 2), { flag: 'wx' });
          const currentOwner = await probe.cdp.evaluate('({ title: document.title })');
          const owners = (await probe.native.listWindows()).filter(window => window.processId === probe.window.processId && window.nativeHandle === probe.window.nativeHandle && window.isVisible && window.title === currentOwner?.title && window.title.includes(probe.fileName));
          if (owners.length !== 1) throw new Error('Native window owner changed during read-only Bold diagnostics');
          const currentButton = await probe.native.findElement(owners[0].id, button.name, 'Button');
          const sameBounds = (left, right) => !!left && !!right && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(left[key]) && Number.isFinite(right[key]) && left[key] === right[key]) && left.width > 0 && left.height > 0 && right.width > 0 && right.height > 0;
          if (!currentButton || currentButton.name !== button.name || currentButton.controlType !== 'Button' || !currentButton.isVisible || !currentButton.isEnabled || !sameBounds(currentButton.bounds, bounds) || !sameBounds(owners[0].bounds, windowBounds)) throw new Error('Native window or Bold button geometry changed; the original point is no longer admissible');
          const guardedSelection = await probe.ui();
          if (owners.length !== 1 || guardedSelection.uri !== selected.uri || guardedSelection.viewSessionId !== selected.viewSessionId || guardedSelection.currentRootPath !== selected.currentRootPath || guardedSelection.selection !== 'Nativeword' || !guardedSelection.focused || !guardedSelection.documentFocused) throw new Error('Native owner/frame/selection changed during read-only Bold geometry observation');
          if (guardedSelection.events.length < selected.events.length || guardedSelection.events.slice(selected.events.length).some(event => event.bold)) throw new Error('Unexpected Bold activity occurred before the sole submitted click');
          probe.window = owners[0];
          const eventOffset = guardedSelection.events.length;
          const submittedClickPoint = { x: currentButton.bounds.x + currentButton.bounds.width / 2, y: currentButton.bounds.y + currentButton.bounds.height / 2 };
          let after;
          try {
            await probe.native.clickMouse(submittedClickPoint.x, submittedClickPoint.y);
            after = await probe.ui(false, false, eventOffset);
          } catch (error) {
            try {
              probe.assertRoot();
              let hostModel;
              try { const model = probe.document(); hostModel = { text: model.getText(), version: model.version, dirty: model.isDirty }; } catch {}
              probe.fs.writeFileSync(probe.path.join(probe.owner.root, 'bold-control-observation-error.json'), JSON.stringify({ capturedAt: Date.now(), error: String(error?.message || error), before, selected, guardedSelection, currentButton, window: probe.window, submittedClickPoint, eventOffset, hostModel }, null, 2), { flag: 'wx' });
            } catch {}
            throw error;
          }
          const events = after.events.slice(eventOffset);
          const checks = {
            clickedTrusted: events.some(event => event.type === 'click' && event.bold && event.isTrusted),
            noUntrustedBold: !events.some(event => event.bold && !event.isTrusted),
            exactStrong: after.strong.length === 1 && after.strong[0] === 'Nativeword',
            exactSource: after.sourceText === probe.expectedBold,
            exactEditorSource: after.editorSourceText === probe.expectedBold,
            exactParagraph: after.paragraphText === probe.intro + ' Nativeword',
          };
          const hostModel = probe.document();
          let parsedModel;
          let modelParseError;
          try { parsedModel = JSON.parse(hostModel.getText()); } catch (error) { modelParseError = String(error?.message || error); }
          probe.assertRoot();
          probe.fs.writeFileSync(probe.path.join(probe.owner.root, 'bold-control-state.json'), JSON.stringify({
            capturedAt: Date.now(), before, selected, after, checks, eventOffset, events,
            button: currentButton, window: probe.window, currentShell,
            submittedClickPoint,
            expectedBold: probe.expectedBold, expectedParagraph: probe.intro + ' Nativeword',
            hostModel: { text: hostModel.getText(), parsed: parsedModel, parseError: modelParseError, version: hostModel.version, dirty: hostModel.isDirty },
          }, null, 2), { flag: 'wx' });
          if (!events.some(event => event.type === 'click' && event.bold && event.isTrusted) || events.some(event => event.bold && !event.isTrusted) || after.strong.length !== 1 || after.strong[0] !== 'Nativeword' || after.sourceText !== probe.expectedBold || after.editorSourceText !== probe.expectedBold || after.paragraphText !== probe.intro + ' Nativeword') throw new Error('Native physical Bold click lacks an actual trusted toolbar event, exact DOM strong, or exact authored Markdown; no synthetic fallback');
          const model = await probe.waitModel(probe.expectedBold);
          probe.passes.add('trusted-bold-button');
          return { physicalMouse: true, buttonName: button.name, windowId: probe.window.id, processId: probe.window.processId, actualControlEvents: events.filter(event => event.bold), strongWordExact: true, exactBoldMarkdown: true, model };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-native-undo-redo" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('native-undo-redo', async () => {
          const focused = await probe.ui(true);
          if (!focused.focused || !focused.documentFocused || focused.sourceText !== probe.expectedBold) throw new Error('Current Markdown editor is not focused before native Undo');
          const offset = focused.events.length;
          await probe.cdp.pressKey('Ctrl+Z');
          const undone = await probe.ui();
          if (undone.sourceText !== probe.expectedPlain || undone.editorSourceText !== probe.expectedPlain || undone.strong.length || !undone.events.slice(offset).some(event => event.type === 'keydown' && event.isTrusted && event.ctrlKey && event.key?.toLowerCase() === 'z')) throw new Error('Trusted native Undo did not restore the exact pre-Bold model');
          await probe.waitModel(probe.expectedPlain);
          probe.passes.add('native-undo');
          const redoOffset = undone.events.length;
          await probe.cdp.pressKey('Ctrl+Y');
          const redone = await probe.ui();
          if (redone.sourceText !== probe.expectedBold || redone.editorSourceText !== probe.expectedBold || redone.strong.length !== 1 || redone.strong[0] !== 'Nativeword' || !redone.events.slice(redoOffset).some(event => event.type === 'keydown' && event.isTrusted && event.ctrlKey && event.key?.toLowerCase() === 'y')) throw new Error('Trusted native Redo did not restore the exact bold model');
          const model = await probe.waitModel(probe.expectedBold);
          probe.passes.add('native-redo');
          return { trustedUndo: true, undoTextExact: true, trustedRedo: true, redoTextExact: true, model };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-first-manual-save" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('first-manual-save', async () => {
          probe.verifySaved = async (expectedText, eventOffset) => {
            const deadline = Date.now() + 10000;
            let stableKey = null;
            let stableSince = 0;
            while (Date.now() < deadline) {
              const tab = probe.active();
              const document = probe.document();
              const version = document.version;
              const bytes = probe.fs.readFileSync(probe.uri.fsPath);
              let file;
              try { file = JSON.parse(bytes.toString('utf8')); } catch { file = null; }
              const events = probe.saves.slice(eventOffset);
              const will = events.filter(event => event.event === 'will');
              const did = events.filter(event => event.event === 'did');
              const exact = !document.isDirty && !tab.isDirty && document.version === version && document.getText() === bytes.toString('utf8') && probe.util.isDeepStrictEqual(file, probe.expectedFile(expectedText));
              if (exact && will.length === 1 && will[0].reason === vscode.TextDocumentSaveReason.Manual && did.length === 1 && did[0].at >= will[0].at) {
                const key = version + ':' + probe.hash(bytes);
                if (key !== stableKey) { stableKey = key; stableSince = Date.now(); }
                if (Date.now() - stableSince >= 500) {
                  probe.expectedSavedBytes = Buffer.from(bytes);
                  return { uri: probe.uri.toString(), version, dirty: false, byteLength: bytes.length, sha256: probe.hash(bytes), manualWillSaveCount: 1, didSaveCount: 1, events, everyOtherSourceFieldExact: true, rawQueryAndNoteUnchanged: true, resultArtifactsAbsentFromFile: true, saveReplayCount: 0 };
                }
              } else { stableKey = null; stableSince = 0; }
              await new Promise(resolve => setTimeout(resolve, 75));
            }
            throw new Error('The sole Ctrl+S did not produce an observed Manual Save/didSave and exact clean stable saved bytes; no Save replay');
          };
          probe.active();
          await probe.waitModel(probe.expectedBold);
          const ui = await probe.ui();
          if (!ui.focused || !ui.documentFocused || ui.sourceText !== probe.expectedBold || probe.saves.length) throw new Error('First Ctrl+S target or prior Save count is wrong');
          const offset = probe.saves.length;
          await probe.cdp.pressKey('Ctrl+S');
          const saved = await probe.verifySaved(probe.expectedBold, offset);
          probe.passes.add('first-observed-manual-save');
          probe.closeClean = async () => {
            const tab = probe.active();
            const document = probe.document();
            if (!probe.expectedSavedBytes || document.isDirty || tab.isDirty || document.getText() !== probe.expectedSavedBytes.toString('utf8') || !probe.fs.readFileSync(probe.uri.fsPath).equals(probe.expectedSavedBytes)) throw new Error('Refusing dirty or non-exact private tab cleanup; no discard dialog');
            if (!await vscode.window.tabGroups.close(tab, true)) throw new Error('Exact clean private URI tab did not close');
            if (vscode.window.tabGroups.all.some(group => group.tabs.some(candidate => candidate.input?.uri?.toString() === probe.uri.toString()))) throw new Error('Exact private URI tab remained open after tabGroups.close');
            if (!probe.fs.readFileSync(probe.uri.fsPath).equals(probe.expectedSavedBytes)) throw new Error('Clean close changed saved bytes');
            return { closedUri: probe.uri.toString(), closedCount: 1, cleanBeforeClose: true, dirtyDiscard: false, focusBasedClose: false, sourceBytesStable: true };
          };
          return saved;
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-exact-clean-close" from extension host expression "globalThis.__nativeMarkdownAuthoring.run('first-clean-close', () => globalThis.__nativeMarkdownAuthoring.closeClean())"
    Then I collect JSON artifact "native-markdown-first-public-reopen" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('first-public-reopen', async () => {
          const activation = await probe.activate('reopen');
          const deadline = Date.now() + 15000;
          let ui;
          while (Date.now() < deadline) {
            try { ui = await probe.ui(); }
            catch (error) {
              if (!String(error.message).startsWith('BLOCKED: no exact live URI/token/session-bearing CDP frame')) throw error;
            }
            if (ui) break;
            await new Promise(resolve => setTimeout(resolve, 75));
          }
          const document = probe.document();
          if (!ui || ui.viewSessionId === probe.initialViewSession || ui.sourceText !== probe.expectedBold || ui.editorSourceText !== probe.expectedBold || ui.paragraphText !== probe.intro + ' Nativeword' || ui.strong.length !== 1 || ui.strong[0] !== 'Nativeword' || document.isDirty || probe.active().isDirty || document.getText() !== probe.expectedSavedBytes.toString('utf8') || !probe.fs.readFileSync(probe.uri.fsPath).equals(probe.expectedSavedBytes)) throw new Error('First public reopen did not restore exact DOM text/strong, a fresh view session and clean saved bytes');
          await probe.ui(false, true);
          const synchronization = await probe.cdp.synchronizeResolvedWebviewForNativeCapture();
          const frames = await probe.cdp.listWebviewFrameContexts();
          const context = frames.find(target => target.targetId === synchronization?.targetId)?.contexts.find(candidate => candidate.id === synchronization?.contextId);
          if (!synchronization || !context?.frameId) throw new Error('BLOCKED: reopened actual target/context/frame identity is unavailable');
          probe.reopenedFrame = { targetId: synchronization.targetId, contextId: synchronization.contextId, frameId: context.frameId };
          probe.passes.add('first-public-reopen-exact-dom-and-bytes');
          return { activation, firstPublicRequestCount: 1, firstPublicReopenRequestCount: 1, freshViewSession: true, exactDomText: true, exactStrongWord: true, exactSavedBytes: true, dirty: false, frame: probe.reopenedFrame, queryArtifactAbsent: ui.queryArtifactAbsent };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-post-reopen-trusted-input" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('post-reopen-genuine-input', async () => {
          const before = await probe.ui(true);
          if (!before.focused || !before.documentFocused || before.events.length || before.sourceText !== probe.expectedBold) throw new Error('Reopened correct current ProseMirror root was not cleanly focused before native input');
          const version = probe.document().version;
          if (probe.document().isDirty || !probe.fs.readFileSync(probe.uri.fsPath).equals(probe.expectedSavedBytes)) throw new Error('Reopened source changed before the second genuine edit');
          await probe.cdp.pressKey('Ctrl+Home');
          await probe.cdp.typeText('Reopenedword ');
          const after = await probe.ui();
          const trusted = after.events.filter(event => event.type === 'beforeinput' && event.isTrusted && event.editingSurface);
          if (!after.focused || !after.documentFocused || !trusted.length || after.events.some(event => ['beforeinput', 'input'].includes(event.type) && !event.isTrusted) || after.sourceText !== probe.expectedSecond || after.editorSourceText !== probe.expectedSecond || after.paragraphText !== 'Reopenedword ' + probe.intro + ' Nativeword' || after.strong.length !== 1 || after.strong[0] !== 'Nativeword') throw new Error('Second genuine edit changed restored formatting, missed the current root, or failed exact Markdown');
          const model = await probe.waitModel(probe.expectedSecond);
          if (model.version <= version || !probe.fs.readFileSync(probe.uri.fsPath).equals(probe.expectedSavedBytes) || probe.saves.length !== 2) throw new Error('Second edit did not advance the restored model independently of its unsaved disk source');
          probe.passes.add('post-reopen-trusted-input');
          return { currentRootPath: after.currentRootPath, trustedBeforeInputCount: trusted.length, previousVersion: version, model, restoredStrongPreserved: true, queryArtifactAbsent: after.queryArtifactAbsent };
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-second-manual-save" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('second-manual-save', async () => {
          probe.active();
          const ui = await probe.ui();
          if (!ui.focused || !ui.documentFocused || ui.sourceText !== probe.expectedSecond || probe.saves.length !== 2) throw new Error('Second Ctrl+S does not target the exact restored authored editor');
          const offset = probe.saves.length;
          await probe.cdp.pressKey('Ctrl+S');
          const saved = await probe.verifySaved(probe.expectedSecond, offset);
          probe.passes.add('second-observed-manual-save');
          return saved;
        });
      })()
      """
    Then I collect JSON artifact "native-markdown-complete-clean-close" from extension host expression:
      """
      (async () => {
        const probe = globalThis.__nativeMarkdownAuthoring;
        return probe.run('final-exact-clean-close', async () => {
          const ui = await probe.ui();
          if (ui.sourceText !== probe.expectedSecond || ui.strong.length !== 1 || ui.strong[0] !== 'Nativeword' || !ui.queryArtifactAbsent || probe.activations.length !== 2 || probe.activations.some(attempt => attempt.parsed !== true || attempt.live !== true) || probe.saves.length !== 4 || probe.failures.length) throw new Error('Composed native lifecycle evidence is incomplete');
          const cleanup = await probe.closeClean();
          probe.passes.add('final-exact-clean-close');
          for (const observer of probe.observers) observer.dispose();
          probe.native.stop();
          probe.cdp.disconnect();
          const result = { verdict: 'PASS_NATIVE_CONTROLS_AND_PERSISTENCE_ONLY', passedAssertions: Array.from(probe.passes), passCount: probe.passes.size, manualSaveCount: 2, didSaveCount: 2, firstPublicActivationCount: 1, firstPublicReopenCount: 1, fixtureRoot: probe.assertRoot(), independentBeforeImage: probe.beforePath, initialSha256: probe.baselineSha, finalSha256: probe.hash(probe.expectedSavedBytes), everyOtherSourceFieldExact: true, rawQueryAndNoteUnchanged: true, queryArtifactAbsent: true, cleanup, firstFailure: null, failedRootsPreserved: true, visualQualification: false, productionQualification: false };
          delete globalThis.__nativeMarkdownAuthoring;
          return result;
        });
      })()
      """