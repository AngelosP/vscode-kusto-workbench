Feature: SQL Copilot chat panel — toggle, visibility

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1050
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Copilot chat toggle opens and closes panel
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section" in the webview for 10 seconds
    # ── TEST 1: Copilot toggle button exists ──────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toolbar = el.querySelector('kw-sql-toolbar'); if (!toolbar) throw new Error('No SQL toolbar'); const sr = toolbar.shadowRoot || toolbar; const copilotBtn = sr.querySelector('[data-testid=sql-copilot-chat-toggle]'); if (!copilotBtn) throw new Error('Copilot toggle button not found in toolbar'); const disabled = copilotBtn.disabled || copilotBtn.classList.contains('disabled'); return 'Copilot button found, disabled=' + disabled; })()" in the webview

    # ── TEST 2: Toggle opens chat panel ───────────────────────────────────
    When I click "[data-testid='sql-copilot-chat-toggle']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const chatPane = el.querySelector('.sql-copilot-pane, kw-copilot-chat'); if (!chatPane) throw new Error('Copilot pane element not found after opening'); const visible = chatPane.style.display !== 'none' && chatPane.offsetHeight > 0; if (!visible) throw new Error('Copilot pane exists but is not visible (display=' + chatPane.style.display + ', h=' + chatPane.offsetHeight + ')'); const data = el.serialize(); if (data.copilotChatVisible !== true) throw new Error('copilotChatVisible should serialize true after opening, got ' + data.copilotChatVisible); return 'copilot chat pane visible'; })()" in the webview

    # ── TEST 3: Toggle again closes chat panel ────────────────────────────
    When I click "[data-testid='sql-copilot-chat-toggle']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (el.getCopilotChatVisible?.() !== false || data.copilotChatVisible === true) throw new Error('Copilot chat remained visible after close: ' + JSON.stringify({ live: el.getCopilotChatVisible?.(), serialized: data.copilotChatVisible })); return 'Copilot chat closed and false remained canonically omitted'; })()" in the webview
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Conversational replies, tool rounds, and cancellation settle through real controls
    When I execute command "workbench.action.closeAllEditors"
    And I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I click "button[data-add-kind='sql']" in the webview
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 20 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"text":"SQL_PRE_READY_RETRY_RESULT"}]]'
    And I execute command "kustoWorkbench.test.resetCopilotChatFirstTime"
    And I evaluate "window.__e2e.kusto.resetCopilotFirstTimeState()" in the webview
    When I click "[data-testid='sql-copilot-chat-toggle']" in the webview
    When I click "Use this Copilot Chat window" on the "Visual Studio Code" dialog
    When I wait for "[data-testid='copilot-chat-input']" in the webview for 15 seconds
    When I wait for "[data-testid='copilot-chat-tools']:not([disabled])" in the webview for 15 seconds

    When I evaluate "(() => { const section = document.querySelector('kw-sql-section'); const ownerToken = String(section?.getCopilotOwnerToken?.() || ''); if (!ownerToken) throw new Error('SQL owner token was unavailable before the pre-readiness test'); section.setStsReady(false); if (section.getCopilotOwnerToken?.()) throw new Error('SQL owner token remained available after entering pre-readiness state'); return { ownerTokenWasPresent: true, stsReady: section.dataset.testStsReady }; })()" in the webview
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "Retry this SQL request when ready."
    And I press "Enter"
    Then I collect JSON artifact "sql-copilot-pre-ready-rejection" from webview expression "(() => { const snapshot = window.__e2e.copilot.snapshot('sql'); const notification = 'SQL Tools Service is still connecting. Try again when the connection is ready.'; if (snapshot.running || snapshot.progress || snapshot.inputValue !== 'Retry this SQL request when ready.' || snapshot.sendAction !== 'Send Copilot request' || snapshot.messages.some(message => message.kind === 'user' && message.text === snapshot.inputValue) || !snapshot.messages.some(message => message.kind === 'notification' && message.text === notification)) throw new Error('Pre-readiness SQL send was not rejected retryably: ' + JSON.stringify(snapshot)); return snapshot; })()"
    Then I collect JSON artifact "sql-copilot-pre-ready-model" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const consumedResponses = providers.map(provider => provider.model?.consumedResponses || 0); if (consumedResponses.some(count => count !== 0)) throw new Error('Pre-readiness SQL send reached the model: ' + JSON.stringify(providers)); return { consumedResponses }; })()"
    When I evaluate "window.__e2e.sql.connectSts()" in the webview
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds
    When I evaluate "window.__e2e.copilot.beginObservation('sql')" in the webview
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I press "Enter"
    Then I collect JSON artifact "sql-copilot-pre-ready-retry-settlement" from webview expression "(async () => { const result = await window.__e2e.copilot.finishObservation('SQL_PRE_READY_RETRY_RESULT', 15000); const matchingUsers = result.messages.filter(message => message.kind === 'user' && message.text === 'Retry this SQL request when ready.'); if (matchingUsers.length !== 1 || result.inputValue !== '' || result.running || result.progress) throw new Error('Post-readiness retry did not settle exactly once: ' + JSON.stringify(result)); return result; })()"
    Then I collect JSON artifact "sql-copilot-pre-ready-retry-model" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 1); if (!model || model.rounds.length !== 1) throw new Error('Post-readiness SQL retry did not consume exactly one model response: ' + JSON.stringify(providers)); return { consumedResponses: model.consumedResponses, rounds: model.rounds }; })()"
    When I click "[data-testid='copilot-chat-clear']" in the webview
    When I wait for "[data-testid='copilot-chat-tools']:not([disabled])" in the webview for 15 seconds
    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"text":"SQL_ALL_TOOLS_OFF_RESULT"}]]'

    When I click "[data-testid='copilot-chat-tools']" in the webview
    When I click "[data-testid='copilot-chat-tool-respond_to_query_performance_optimization_request']" in the webview
    When I click "[data-testid='copilot-chat-tool-respond_to_sql_query']" in the webview
    When I click "[data-testid='copilot-chat-tool-ask_user_clarifying_question']" in the webview
    When I click "[data-testid='copilot-chat-tool-get_sql_schema']" in the webview
    When I click "[data-testid='copilot-chat-tool-get_query_optimization_best_practices']" in the webview
    When I click "[data-testid='copilot-chat-tool-execute_sql_query']" in the webview
    Then I collect JSON artifact "sql-copilot-all-tools-off-selection" from webview expression "(() => { const snapshot = window.__e2e.copilot.snapshot('sql'); const panel = document.querySelector('kw-copilot-chat')?.shadowRoot?.querySelector('.tools-panel'); if (snapshot.enabledTools.length !== 0 || snapshot.tools.some(tool => tool.checked) || !panel) throw new Error('Not every SQL Copilot tool was disabled through the rendered controls: ' + JSON.stringify({ snapshot, panel: !!panel })); return { enabledTools: snapshot.enabledTools, tools: snapshot.tools, panelOpen: true }; })()"
    When I press "Escape"
    When I evaluate "window.__e2e.copilot.beginObservation('sql')" in the webview
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "Answer this conversationally with every tool disabled."
    And I press "Enter"
    Then I collect JSON artifact "sql-copilot-all-tools-off-settlement" from webview expression "window.__e2e.copilot.finishObservation('SQL_ALL_TOOLS_OFF_RESULT', 15000)"
    Then I collect JSON artifact "sql-copilot-all-tools-off-model" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 1); if (!model || model.rounds.length !== 1 || model.rounds[0].offeredToolNames.length !== 0) throw new Error('Explicit all-off SQL selection restored default tools: ' + JSON.stringify(providers)); return { consumedResponses: model.consumedResponses, rounds: model.rounds }; })()"
    When I click "[data-testid='copilot-chat-clear']" in the webview
    When I wait for "[data-testid='copilot-chat-tools']:not([disabled])" in the webview for 15 seconds

    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"toolCalls":[{"callId":"sql-schema-round","name":"get_sql_schema","input":{}}]},{"text":"SQL_CONVERSATIONAL_RESULT"}]]'
    When I click "[data-testid='copilot-chat-tools']" in the webview
    When I click "[data-testid='copilot-chat-tool-execute_sql_query']" in the webview
    Then I collect JSON artifact "sql-copilot-tool-selection" from webview expression "(() => { const snapshot = window.__e2e.copilot.snapshot('sql'); const execute = snapshot.tools.find(tool => tool.name === 'execute_sql_query'); const panel = document.querySelector('kw-copilot-chat')?.shadowRoot?.querySelector('.tools-panel'); if (!execute || execute.checked || !panel) throw new Error('Native SQL tool toggle did not remain open and unchecked: ' + JSON.stringify({ snapshot, panel: !!panel })); return { execute, enabledTools: snapshot.enabledTools, panelOpen: true }; })()"
    When I press "Escape"

    When I evaluate "window.__e2e.copilot.beginObservation('sql')" in the webview
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "Inspect the schema, then answer this in chat."
    And I press "Enter"
    Then I collect JSON artifact "sql-copilot-conversational-settlement" from webview expression "(async () => { const result = await window.__e2e.copilot.finishObservation('SQL_CONVERSATIONAL_RESULT', 15000); if (!result.progressValues.includes('Generating response (round 1)…') || !result.progressValues.includes('Generating response (round 2)…')) throw new Error('SQL model rounds did not advance visibly: ' + JSON.stringify(result.progressValues)); if (result.quietForMs < 250 || result.maxLongTaskMs > 2000) throw new Error('SQL Copilot renderer did not become quiescent: ' + JSON.stringify(result)); return result; })()"
    Then I collect JSON artifact "sql-copilot-round-timing" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 2); const rounds = model?.rounds || []; if (rounds.length !== 2 || rounds.some(round => round.offeredToolNames.includes('execute_sql_query'))) throw new Error('Unexpected SQL scripted rounds: ' + JSON.stringify(rounds)); const gapMs = rounds[1].requestStartedMs - rounds[0].completedAtMs; if (gapMs < 0 || gapMs > 2000) throw new Error('Extension overhead between SQL model rounds exceeded 2 seconds: ' + gapMs); return { consumedResponses: model.consumedResponses, rounds, gapMs }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "05-conversational-result"

    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"toolCalls":[{"callId":"sql-execute-round","name":"execute_sql_query","input":{"query":"SELECT 1 AS AgentRound"}}]},{"text":"SQL_EXECUTION_ROUND_RESULT"}]]'
    When I click "[data-testid='copilot-chat-tools']" in the webview
    When I click "[data-testid='copilot-chat-tool-execute_sql_query']" in the webview
    Then I collect JSON artifact "sql-copilot-execution-tool-selection" from webview expression "(() => { const snapshot = window.__e2e.copilot.snapshot('sql'); const execute = snapshot.tools.find(tool => tool.name === 'execute_sql_query'); const panel = document.querySelector('kw-copilot-chat')?.shadowRoot?.querySelector('.tools-panel'); if (!execute?.checked || !panel) throw new Error('SQL execution tool did not remain open and checked: ' + JSON.stringify({ snapshot, panel: !!panel })); return { execute, enabledTools: snapshot.enabledTools, panelOpen: true }; })()"
    When I press "Escape"
    When I evaluate "window.__e2e.copilot.beginObservation('sql')" in the webview
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "Run one SQL tool round, then answer in chat."
    And I press "Enter"
    Then I collect JSON artifact "sql-copilot-execution-round-settlement" from webview expression "(async () => { const result = await window.__e2e.copilot.finishObservation('SQL_EXECUTION_ROUND_RESULT', 25000); if (!result.messages.some(message => message.kind === 'tool' && message.toolName === 'execute_sql_query')) throw new Error('SQL execution tool result was not rendered: ' + JSON.stringify(result)); if (!result.progressValues.includes('Generating response (round 1)…') || !result.progressValues.includes('Generating response (round 2)…') || result.maxLongTaskMs > 2000) throw new Error('SQL execution round did not remain responsive: ' + JSON.stringify(result)); return result; })()"
    Then I collect JSON artifact "sql-copilot-execution-round-timing" from extension host expression "(async () => { const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 2); const rounds = model?.rounds || []; if (rounds.length !== 2 || rounds.some(round => !round.offeredToolNames.includes('execute_sql_query'))) throw new Error('SQL execution tool was not offered in both rounds: ' + JSON.stringify(rounds)); const gapMs = rounds[1].requestStartedMs - rounds[0].completedAtMs; if (gapMs < 0 || gapMs > 15000) throw new Error('SQL execution overhead between model rounds exceeded 15 seconds: ' + gapMs); return { consumedResponses: model.consumedResponses, rounds, gapMs }; })()"

    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"text":"AGENT_REQUIRED_TOOL_RETRY"},{"toolCalls":[{"callId":"sql-agent-final","name":"respond_to_sql_query","input":{"query":"SELECT 2 AS AgentDelegated"}}]}]]'
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "MANUAL_SQL_DRAFT"
    Then I collect JSON artifact "sql-copilot-agent-delegation" from extension host expression "(async () => { const options = input => ({ toolInvocationToken: undefined, input }); const resultText = result => String(result.content.find(part => typeof part?.value === 'string')?.value || ''); const sections = JSON.parse(resultText(await vscode.lm.invokeTool('kusto-workbench_list-sections', options({})))); const section = sections.sections.find(candidate => candidate.type === 'sql'); if (!section?.id) throw new Error('No SQL section available for agent delegation: ' + JSON.stringify(sections)); const result = JSON.parse(resultText(await vscode.lm.invokeTool('kusto-workbench_ask-sql-copilot', options({ sectionId: section.id, question: 'Generate the delegated SQL query.' })))); if (result.success !== true || !String(result.query || '').includes('AgentDelegated')) throw new Error('SQL agent delegation did not return its exact generated query: ' + JSON.stringify(result)); const providers = await vscode.commands.executeCommand('kustoWorkbench.test.getCopilotDevelopmentModelSnapshot'); const model = providers.map(provider => provider.model).find(candidate => candidate?.consumedResponses === 2); if (!model || model.rounds.length !== 2) throw new Error('SQL agent delegation did not retry required prose: ' + JSON.stringify(providers)); return { result, consumedResponses: model.consumedResponses, offeredToolNames: model.rounds.map(round => round.offeredToolNames) }; })()"
    Then I collect JSON artifact "sql-copilot-agent-draft" from webview expression "(() => { const snapshot = window.__e2e.copilot.snapshot('sql'); if (snapshot.running || snapshot.progress || snapshot.inputValue !== 'MANUAL_SQL_DRAFT') throw new Error('SQL agent delegation changed the manual draft or remained busy: ' + JSON.stringify(snapshot)); if (!snapshot.messages.some(message => message.kind === 'assistant' && message.text === 'AGENT_REQUIRED_TOOL_RETRY')) throw new Error('Required-tool retry narrative was not visible: ' + JSON.stringify(snapshot.messages)); return snapshot; })()"
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I press "Ctrl+A"
    And I press "Backspace"

    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"delayMs":5000,"text":"MUST_NOT_RENDER_AFTER_ESCAPE"}]]'
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "Cancel this request with Escape."
    And I press "Enter"
    When I wait for "[data-testid='copilot-chat-progress']" in the webview for 10 seconds
    And I press "Escape"
    Then I collect JSON artifact "sql-copilot-escape-cancel" from webview expression "(async () => { const deadline = performance.now() + 5000; let snapshot; do { snapshot = window.__e2e.copilot.snapshot('sql'); if (!snapshot.running && !snapshot.progress) break; await new Promise(resolve => setTimeout(resolve, 25)); } while (performance.now() < deadline); if (snapshot.running || snapshot.progress || snapshot.messages.some(message => message.text.includes('MUST_NOT_RENDER_AFTER_ESCAPE'))) throw new Error('Escape did not cancel SQL Copilot cleanly: ' + JSON.stringify(snapshot)); return snapshot; })()"

    When I execute command "kustoWorkbench.test.configureCopilotDevelopmentModel" with args '[[{"delayMs":5000,"text":"MUST_NOT_RENDER_AFTER_STOP"}]]'
    When I focus "[data-testid='copilot-chat-input']" in the webview
    And I type "Cancel this request with Stop."
    And I press "Enter"
    When I wait for "[data-testid='copilot-chat-progress']" in the webview for 10 seconds
    When I click "[data-testid='copilot-chat-send-stop']" in the webview
    Then I collect JSON artifact "sql-copilot-stop-cancel" from webview expression "(async () => { const deadline = performance.now() + 5000; let snapshot; do { snapshot = window.__e2e.copilot.snapshot('sql'); if (!snapshot.running && !snapshot.progress) break; await new Promise(resolve => setTimeout(resolve, 25)); } while (performance.now() < deadline); if (snapshot.running || snapshot.progress || snapshot.messages.some(message => message.text.includes('MUST_NOT_RENDER_AFTER_STOP'))) throw new Error('Stop did not cancel SQL Copilot cleanly: ' + JSON.stringify(snapshot)); return snapshot; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 700
    Then I take a screenshot "06-stop-settled"

    When I execute command "kustoWorkbench.test.clearCopilotDevelopmentModel"
    And I execute command "workbench.action.closeAllEditors"
