Feature: Kusto Copilot clarification handoff

  Background:
    Given the extension is in a clean state
    When I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"
    And I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    And I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I click "button[data-add-kind='query']" in the webview
    And I wait for "kw-query-section" in the webview for 15 seconds
    And I evaluate "window.__e2e.clarification.beginKustoConnectionProjection()" in the webview
    And I execute command "kustoWorkbench.test.seedCopilotClarificationConnection"
    And I evaluate "window.__e2e.clarification.prepareKusto()" in the webview for 20 seconds
    And I execute command "kustoWorkbench.test.clearKustoCopilotDelegations"

  Scenario: Manual clarification keeps its card, toast, reveal, scroll, and deferred focus
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"toolCalls":[{"callId":"manual-time","name":"ask_user_clarifying_question","input":{"question":"Which time range should I use?"}}]}]]'
    And I evaluate "window.__e2e.clarification.submitManual('Create an event trend but ask me for the time range first')" in the webview
    Then I collect JSON artifact "01-manual-clarification" from webview expression "window.__e2e.clarification.assertManual('Which time range should I use?')"
    Then I collect JSON artifact "01-manual-native-notification" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 1); if (model?.manualClarificationNotifications !== 1 || model.manualClarificationSelections.length !== 0) throw new Error('Manual clarification notification was not issued exactly once: ' + JSON.stringify(providers)); return model; })()"
    Then I take a screenshot "01-manual-purple-card-focused"

    When I evaluate "window.__e2e.clarification.collapseAndBlur()" in the webview
    And I click at 1235, 940
    And I wait 2 seconds
    Then I collect JSON artifact "02-current-view-reveals" from webview expression "(() => { const snapshot = window.__e2e.clarification.snapshot('kusto'); if (!snapshot.expanded || !snapshot.inputFocused || snapshot.questionCount !== 1) throw new Error('Current View did not reveal and focus the owned clarification: ' + JSON.stringify(snapshot)); return snapshot; })()"
    Then I collect JSON artifact "02-current-view-selection" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate); if (JSON.stringify(model?.manualClarificationSelections) !== JSON.stringify(['View'])) throw new Error('Native View action was not returned to Kusto Copilot: ' + JSON.stringify(providers)); return model; })()"
    Then I take a screenshot "02-current-view-revealed"

    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"

  Scenario: Delayed View is inert after exact conversation Clear
    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"toolCalls":[{"callId":"manual-clear","name":"ask_user_clarifying_question","input":{"question":"Which environment should I use?"}}]}]]'
    And I evaluate "window.__e2e.clarification.submitManual('Ask me which environment to use')" in the webview
    And I evaluate "window.__e2e.clarification.assertManual('Which environment should I use?')" in the webview for 15 seconds
    Then I collect JSON artifact "03-cleared-native-notification" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate); if (model?.manualClarificationNotifications !== 1) throw new Error('Manual clarification notification was not issued: ' + JSON.stringify(providers)); return model; })()"

    When I evaluate "window.__e2e.clarification.clear('kusto')" in the webview
    And I wait 1 second
    And I evaluate "window.__e2e.clarification.collapseAndBlur()" in the webview
    And I click at 1235, 940
    And I wait 2 seconds
    Then I collect JSON artifact "03-cleared-view-inert" from webview expression "window.__e2e.clarification.assertClearedViewNoop()"
    Then I collect JSON artifact "03-cleared-view-selection" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate); if (JSON.stringify(model?.manualClarificationSelections) !== JSON.stringify(['View'])) throw new Error('Delayed native View action was not delivered: ' + JSON.stringify(providers)); return model; })()"

    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"

  Scenario: Agent clarification is passive and the answer continues the same conversation
    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"toolCalls":[{"callId":"agent-time","name":"ask_user_clarifying_question","input":{"question":"Which time range?"}}]},{"toolCalls":[{"callId":"agent-event","name":"ask_user_clarifying_question","input":{"question":"Which event type?"}}]}]]'
    And I evaluate "window.__e2e.clarification.setDraft('Keep this manual draft')" in the webview
    And I evaluate "window.__e2e.clarification.focusEditor('kusto')" in the webview
    And I start command "kustoWorkbench.test.startKustoCopilotDelegation" with args '["agent-first",{"question":"Build an event trend"}]'
    And I wait 2 seconds
    Then I should not see notification "Kusto Copilot has a clarifying question for you."
    Then I collect JSON artifact "04-agent-passive-first" from webview expression "window.__e2e.clarification.assertPassive('Which time range?', 'Keep this manual draft', 1)"
    Then I collect JSON artifact "04-agent-first-result" from extension host expression "(async () => { const snapshot = await vscode.commands.executeCommand('kustoWorkbench.test.getKustoCopilotDelegationSnapshot'); const record = snapshot.delegations['agent-first']; if (record?.status !== 'resolved' || record.result?.outcome !== 'clarification-required' || record.result?.question !== 'Which time range?' || !record.result?.sectionId) throw new Error('Unexpected first agent clarification: ' + JSON.stringify(record)); return record; })()"

    When I execute command "kustoWorkbench.test.startKustoCopilotDelegation" with args '["agent-follow-up",{"question":"Use the last 30 days."}]'
    Then I should not see notification "Kusto Copilot has a clarifying question for you."
    Then I collect JSON artifact "05-agent-passive-follow-up" from webview expression "window.__e2e.clarification.assertPassive('Which event type?', 'Keep this manual draft', 2)"
    Then I collect JSON artifact "05-agent-continuation" from extension host expression "(async () => { const snapshot = await vscode.commands.executeCommand('kustoWorkbench.test.getKustoCopilotDelegationSnapshot'); const first = snapshot.delegations['agent-first']; const followUp = snapshot.delegations['agent-follow-up']; if (followUp?.status !== 'resolved' || followUp.result?.outcome !== 'clarification-required' || followUp.result?.question !== 'Which event type?') throw new Error('Unexpected follow-up clarification: ' + JSON.stringify(followUp)); if (first.result.sectionId !== followUp.result.sectionId || !first.result.openFileId || first.result.openFileId !== followUp.result.openFileId) throw new Error('Continuation changed file or section identity: ' + JSON.stringify({ first, followUp })); return { first: first.result, followUp: followUp.result }; })()"
    Then I collect JSON artifact "05-agent-model-history" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 2); const second = model?.requests?.[1]; const serialized = JSON.stringify(second || null); if (!model || model.manualClarificationNotifications !== 0 || !serialized.includes('agent-time') || !serialized.includes('tool-result') || !serialized.includes('Use the last 30 days.')) throw new Error('Agent continuation history or passive notification behavior changed: ' + JSON.stringify(providers)); return model; })()"

    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.clearKustoCopilotDelegations"
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"

  Scenario: Busy agent delegation preserves a draft and cannot leak origin into the next manual send
    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"delayMs":2500,"toolCalls":[{"callId":"busy-agent","name":"ask_user_clarifying_question","input":{"question":"Which business unit?"}}]},{"toolCalls":[{"callId":"busy-manual","name":"ask_user_clarifying_question","input":{"question":"Which manual time range?"}}]}]]'
    And I evaluate "window.__e2e.clarification.setDraft('Draft must survive overlap')" in the webview
    And I evaluate "window.__e2e.clarification.focusEditor('kusto')" in the webview
    And I start command "kustoWorkbench.test.startKustoCopilotDelegation" with args '["busy-first",{"question":"Build a business-unit trend"}]'
    And I wait 1 second
    And I execute command "kustoWorkbench.test.startKustoCopilotDelegation" with args '["busy-second",{"question":"This overlapping request must be rejected"}]'
    And I wait 3 seconds
    Then I collect JSON artifact "06-busy-draft-passive" from webview expression "window.__e2e.clarification.assertPassive('Which business unit?', 'Draft must survive overlap', 1)"
    Then I collect JSON artifact "06-busy-results" from extension host expression "(async () => { const snapshot = await vscode.commands.executeCommand('kustoWorkbench.test.getKustoCopilotDelegationSnapshot'); const first = snapshot.delegations['busy-first']; const second = snapshot.delegations['busy-second']; if (first?.result?.outcome !== 'clarification-required' || second?.status !== 'resolved' || second.result?.success !== false || !String(second.result?.error || '').includes('already running')) throw new Error('Busy admission changed: ' + JSON.stringify(snapshot.delegations)); const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate); if (model?.consumedResponses !== 1 || model.manualClarificationNotifications !== 0) throw new Error('Overlapping delegation consumed a model response or showed a notification: ' + JSON.stringify(providers)); return { first, second, consumedResponses: model.consumedResponses }; })()"

    When I evaluate "window.__e2e.clarification.submitManual('Now this is a manual send')" in the webview
    Then I collect JSON artifact "06-manual-origin-restored" from webview expression "window.__e2e.clarification.assertManual('Which manual time range?', 2, 'kusto')"
    Then I collect JSON artifact "06-manual-origin-notification" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate); if (model?.manualClarificationNotifications !== 1) throw new Error('Manual send retained agent origin: ' + JSON.stringify(providers)); return model; })()"

    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.clearKustoCopilotDelegations"
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"

  Scenario: Clear wins over a pending applied-done clarification and stale completion cannot settle twice
    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"toolCalls":[{"callId":"cancel-agent","name":"ask_user_clarifying_question","input":{"question":"Which cancellation range?"}}]}]]'
    And I evaluate "window.__e2e.clarification.beginCapture()" in the webview
    And I evaluate "window.__e2e.clarification.holdAppliedDone()" in the webview
    And I start command "kustoWorkbench.test.startKustoCopilotDelegation" with args '["cancel-pending",{"question":"Ask before cancellation"}]'
    And I evaluate "window.__e2e.clarification.waitForHeldDone(15000)" in the webview for 20 seconds
    And I evaluate "window.__e2e.clarification.assertPassive('Which cancellation range?', '', 1)" in the webview for 15 seconds

    When I evaluate "window.__e2e.clarification.clear('kusto')" in the webview
    And I wait 2 seconds
    And I evaluate "window.__e2e.clarification.releaseHeldDone()" in the webview
    And I wait 2 seconds
    Then I should not see notification "Kusto Copilot has a clarifying question for you."
    Then I collect JSON artifact "07-cancellation-precedence" from extension host expression "(async () => { const snapshot = await vscode.commands.executeCommand('kustoWorkbench.test.getKustoCopilotDelegationSnapshot'); const record = snapshot.delegations['cancel-pending']; const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate); if (record?.status !== 'resolved' || record.result?.success !== false || record.result?.outcome === 'clarification-required' || model?.manualClarificationNotifications !== 0) throw new Error('Cancellation did not win passively: ' + JSON.stringify({ record, providers })); return record; })()"
    Then I collect JSON artifact "07-single-canceled-settlement" from webview expression "(() => { const snapshot = window.__e2e.clarification.assertAbsent('kusto'); if (snapshot.capturedToolResponses.length !== 1 || snapshot.capturedToolResponses[0]?.result?.success !== false || snapshot.capturedToolResponses[0]?.result?.outcome === 'clarification-required') throw new Error('Expected one canceled tool settlement: ' + JSON.stringify(snapshot.capturedToolResponses)); return snapshot; })()"

    When I evaluate "window.__e2e.clarification.restoreCapture()" in the webview
    And I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.clearKustoCopilotDelegations"
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"

  Scenario: Captured file identity follows a renamed target while the focused file stays untouched
    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    Given a file "tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-a.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"query_shared","type":"query","name":"File A","query":"print file = 'A'","expanded":true}]}}
      """
    Given a file "tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-b.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"query_shared","type":"query","name":"File B","query":"print file = 'B'","expanded":true}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-a.kqlx" in the editor
    And I wait for "kw-query-section" in the webview for 20 seconds
    And I evaluate "window.__e2e.clarification.beginKustoConnectionProjection()" in the webview
    And I execute command "kustoWorkbench.test.seedCopilotClarificationConnection"
    And I evaluate "window.__e2e.clarification.prepareKusto()" in the webview for 20 seconds
    And I evaluate "window.__e2e.clarification.setDraft('File A draft')" in the webview
    And I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"delayMs":2500,"toolCalls":[{"callId":"rename-agent","name":"ask_user_clarifying_question","input":{"question":"Which renamed-file range?"}}]}]]'
    And I evaluate "window.__e2e.clarification.pinKustoTarget()" in the webview
    And I start command "kustoWorkbench.test.startKustoCopilotDelegation" with args '["rename-target",{"question":"Ask about the renamed file","sectionId":"query_shared","targetFileRelativePath":"tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-a.kqlx"}]'
    And I wait 1 second
    And I open file "tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-b.kqlx" in the editor
    And I wait for "kw-query-section" in the webview for 20 seconds
    Then I collect JSON artifact "08-rename-while-b-focused" from extension host expression "(async () => { const extension = vscode.extensions.all.find(candidate => candidate.packageJSON?.name === 'vscode-kusto-workbench'); if (!extension) throw new Error('Kusto Workbench extension not found'); const from = vscode.Uri.joinPath(extension.extensionUri, 'tests', 'vscode-extension-tester', 'runs', 'default', 'kusto-copilot-clarification-handoff', 'clarification-a.kqlx'); const to = vscode.Uri.joinPath(extension.extensionUri, 'tests', 'vscode-extension-tester', 'runs', 'default', 'kusto-copilot-clarification-handoff', 'clarification-a-renamed.kqlx'); try { await vscode.workspace.fs.delete(to); } catch {} const edit = new vscode.WorkspaceEdit(); edit.renameFile(from, to, { overwrite: true }); if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code rejected the file rename'); return { from: from.toString(), to: to.toString(), activeTab: vscode.window.tabGroups.activeTabGroup.activeTab?.label || '' }; })()"
    And I wait 4 seconds
    Then I should not see notification "Kusto Copilot has a clarifying question for you."
    Then I collect JSON artifact "08-renamed-open-file-result" from extension host expression "(async () => { const snapshot = await vscode.commands.executeCommand('kustoWorkbench.test.getKustoCopilotDelegationSnapshot'); const record = snapshot.delegations['rename-target']; const renamed = snapshot.openFiles.find(file => String(file.logicalUri || '').replace(/\\/g, '/').endsWith('/clarification-a-renamed.kqlx')); const focusedB = snapshot.openFiles.find(file => String(file.logicalUri || '').replace(/\\/g, '/').endsWith('/clarification-b.kqlx')); if (record?.status !== 'resolved' || record.result?.outcome !== 'clarification-required' || record.result?.openFileId !== renamed?.openFileId || record.result?.openFileId === focusedB?.openFileId) throw new Error('Clarification identity did not follow renamed A: ' + JSON.stringify({ record, renamed, focusedB })); return { result: record.result, renamed, focusedB }; })()"
    Then I collect JSON artifact "08-focused-b-untouched" from webview expression "(() => { const query = `print file = 'B'`; window.__e2e.kusto.assertQuery(query); const section = document.querySelector('kw-query-section'); const chat = section?.getCopilotChatEl?.(); const questionCount = chat?.shadowRoot?.querySelectorAll('.msg-clarifying-question').length || 0; if (questionCount !== 0) throw new Error('Focused file B received A clarification'); return { query, questionCount }; })()"
    Then I collect JSON artifact "08-file-b-disk-unchanged" from extension host expression "(async () => { const extension = vscode.extensions.all.find(candidate => candidate.packageJSON?.name === 'vscode-kusto-workbench'); const uri = vscode.Uri.joinPath(extension.extensionUri, 'tests', 'vscode-extension-tester', 'runs', 'default', 'kusto-copilot-clarification-handoff', 'clarification-b.kqlx'); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(uri)); if (!text.includes(`print file = 'B'`) || text.includes('renamed-file range')) throw new Error('Focused file B changed: ' + text); return { unchanged: true, text }; })()"

    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "kustoWorkbench.test.clearKustoCopilotDelegations"
    And I execute command "workbench.action.files.saveAll"
    And I execute command "workbench.action.closeAllEditors"
    And I delete file "tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-a-renamed.kqlx"
    And I delete file "tests/vscode-extension-tester/runs/default/kusto-copilot-clarification-handoff/clarification-b.kqlx"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"

  Scenario: SQL clarification keeps the existing owner-token flow
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I click "button[data-add-kind='sql']" in the webview
    And I wait for "kw-sql-section" in the webview for 15 seconds
    And I evaluate "window.__e2e.clarification.prepareSql()" in the webview for 20 seconds
    And I evaluate "window.__e2e.clarification.beginCapture()" in the webview
    Then I collect JSON artifact "09-sql-owner-token-clarification" from webview expression "window.__e2e.clarification.injectSql('Which SQL time range?')"
    Then I collect JSON artifact "09-sql-no-kusto-handoff" from webview expression "(() => { const snapshot = window.__e2e.clarification.snapshot('sql'); const starts = window.__e2e.clarification.snapshot('sql').capturedToolResponses; if (starts.some(response => response?.result?.outcome === 'clarification-required')) throw new Error('SQL emitted Kusto clarification handoff: ' + JSON.stringify(starts)); return snapshot; })()"

    When I evaluate "window.__e2e.clarification.restoreCapture()" in the webview
    And I execute command "kustoWorkbench.test.closeQueryEditorSession"
    And I execute command "kustoWorkbench.test.removeCopilotClarificationConnection"