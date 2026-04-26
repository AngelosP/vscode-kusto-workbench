Feature: Agent tool execution forces run mode to plain (Run Query)

  When the Kusto Workbench agent writes and executes a query via
  configureKustoQuerySection (the primary agent execution path), the
  run mode must be forced to "plain" so that take-100/sample-100
  limits are never silently appended to agent-generated queries.

  This test posts the exact toolConfigureQuerySection message that
  the host sends when the agent calls configureKustoQuerySection
  with execute: true.

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"

  Scenario: configureKustoQuerySection execute forces take100 to plain
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(() => { const existing = document.querySelector('kw-query-section'); if (existing) return 'ready: boxId=' + (existing.boxId || existing.id); const add = document.querySelector('button[data-add-kind=query]'); if (!add) throw new Error('Kusto add button not found'); add.click(); return 'clicked add Kusto section'; })()" in the webview
    When I wait for "kw-query-section" in the webview for 10 seconds

    # ── Scroll run button into view ───────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); if (btn) btn.scrollIntoView({ block: 'center' }); return 'scrolled'; })()" in the webview
    And I wait 1 second

    # ── BASELINE: mode is take100 ─────────────────────────────────────────
    When I evaluate "window.__testSelectKustoRunMode('take100')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'take100') throw new Error('Expected take100, got: ' + mode); const btn = document.getElementById(el.boxId + '_run_btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (!label.includes('take 100')) throw new Error('Label should show take 100, got: ' + label); return 'BEFORE: mode=' + mode + ', label=' + label; })()" in the webview
    Then I take a screenshot "01-before-take100"

    # ── Fire toolConfigureQuerySection with execute:true ───────────────────
    #    This is the message the host sends when the agent calls
    #    configureKustoQuerySection({ sectionId, query, execute: true })
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolConfigureQuerySection', requestId: 'e2e-exec-1', input: { sectionId: el.boxId, query: 'StormEvents | take 10', execute: true } }, '*'); return 'sent toolConfigureQuerySection execute=true'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT: run mode changed to plain ─────────────────────────────────
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-query-section')); if (sections.length !== 1) throw new Error('Expected exactly 1 Kusto section, got: ' + sections.length); const el = sections[0]; const sectionId = el.boxId || el.id; if (!sectionId) throw new Error('Kusto section has no boxId/id'); const mode = (window.runModesByBoxId || {})[sectionId]; if (mode !== 'plain') throw new Error('FAIL: mode should be plain after agent execute, got: ' + mode); return 'PASS: mode = plain for ' + sectionId; })()" in the webview

    # ── ASSERT: button label updated ──────────────────────────────────────
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-query-section')); if (sections.length !== 1) throw new Error('Expected exactly 1 Kusto section, got: ' + sections.length); const el = sections[0]; const sectionId = el.boxId || el.id; const btn = document.getElementById(sectionId + '_run_btn'); if (!btn) throw new Error('Run button not found for ' + sectionId); const label = btn.querySelector('.run-btn-label')?.textContent?.replace(/\s+/g, ' ').trim() || ''; const fullText = btn.textContent?.replace(/\s+/g, ' ').trim() || ''; if (label !== 'Run Query') throw new Error('FAIL: label should be exactly Run Query, got: ' + label + ' (button=' + fullText + ')'); return 'PASS: visible run label = ' + label; })()" in the webview
    Then I take a screenshot "02-after-plain"
    When I execute command "workbench.action.closeAllEditors"

  Scenario: configureKustoQuerySection execute forces sample100 to plain
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(() => { const existing = document.querySelector('kw-query-section'); if (existing) return 'ready: boxId=' + (existing.boxId || existing.id); const add = document.querySelector('button[data-add-kind=query]'); if (!add) throw new Error('Kusto add button not found'); add.click(); return 'clicked add Kusto section'; })()" in the webview
    When I wait for "kw-query-section" in the webview for 10 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); if (btn) btn.scrollIntoView({ block: 'center' }); return 'scrolled'; })()" in the webview
    And I wait 1 second

    # ── BASELINE: sample100 ───────────────────────────────────────────────
    When I evaluate "window.__testSelectKustoRunMode('sample100')" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'sample100') throw new Error('Expected sample100, got: ' + mode); const btn = document.getElementById(el.boxId + '_run_btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (!label.includes('sample 100')) throw new Error('Label should show sample 100, got: ' + label); return 'BEFORE: mode=' + mode + ', label=' + label; })()" in the webview
    Then I take a screenshot "03-before-sample100"

    # ── Fire toolConfigureQuerySection with execute:true ───────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolConfigureQuerySection', requestId: 'e2e-exec-2', input: { sectionId: el.boxId, query: 'StormEvents | count', execute: true } }, '*'); return 'sent'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT ────────────────────────────────────────────────────────────
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-query-section')); if (sections.length !== 1) throw new Error('Expected exactly 1 Kusto section, got: ' + sections.length); const el = sections[0]; const sectionId = el.boxId || el.id; if (!sectionId) throw new Error('Kusto section has no boxId/id'); const mode = (window.runModesByBoxId || {})[sectionId]; if (mode !== 'plain') throw new Error('FAIL: mode should be plain, got: ' + mode); const btn = document.getElementById(sectionId + '_run_btn'); if (!btn) throw new Error('Run button not found for ' + sectionId); const label = btn.querySelector('.run-btn-label')?.textContent?.replace(/\s+/g, ' ').trim() || ''; const fullText = btn.textContent?.replace(/\s+/g, ' ').trim() || ''; if (label !== 'Run Query') throw new Error('FAIL: label should be exactly Run Query, got: ' + label + ' (button=' + fullText + ')'); return 'PASS: mode=plain, visible run label=' + label; })()" in the webview
    Then I take a screenshot "04-after-plain-from-sample"
    When I execute command "workbench.action.closeAllEditors"

  Scenario: askKustoCopilot also forces mode to plain
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(() => { const existing = document.querySelector('kw-query-section'); if (existing) return 'ready: boxId=' + (existing.boxId || existing.id); const add = document.querySelector('button[data-add-kind=query]'); if (!add) throw new Error('Kusto add button not found'); add.click(); return 'clicked add Kusto section'; })()" in the webview
    When I wait for "kw-query-section" in the webview for 10 seconds

    # ── BASELINE: take100 ─────────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (typeof el.getConnectionId !== 'function' || typeof el.getDatabase !== 'function' || typeof el.copilotWriteQuerySend !== 'function') throw new Error('Kusto section public Copilot APIs are missing'); el.__e2eOrigGetConnectionId = el.getConnectionId.bind(el); el.__e2eOrigGetDatabase = el.getDatabase.bind(el); el.__e2eOrigCopilotWriteQuerySend = el.copilotWriteQuerySend.bind(el); el.getConnectionId = () => 'e2e-stub-conn'; el.getDatabase = () => 'StubDb'; window.__e2eCopilotSendCalled = false; el.copilotWriteQuerySend = function() { window.__e2eCopilotSendCalled = true; window.postMessage({ type: 'copilotWriteQueryDone', boxId: this.boxId, ok: false, message: 'e2e stopped before external Copilot request' }, '*'); }; return 'stubbed public connection/database and Copilot send APIs'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const connectionId = typeof el.getConnectionId === 'function' ? el.getConnectionId() : ''; const database = typeof el.getDatabase === 'function' ? el.getDatabase() : ''; if (connectionId !== 'e2e-stub-conn') throw new Error('Expected public-api connection e2e-stub-conn, got: ' + connectionId); if (database !== 'StubDb') throw new Error('Expected public-api database StubDb, got: ' + database); return 'configured connection/database via public APIs'; })()" in the webview
    And I wait 1 second
    When I evaluate "window.__testSelectKustoRunMode('take100')" in the webview
    And I wait 1 second

    # ── Fire toolDelegateToKustoWorkbenchCopilot ──────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'e2e-copilot', input: { question: 'show events', sectionId: el.boxId } }, '*'); return 'sent'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT: mode is plain ─────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'plain') throw new Error('FAIL: mode should be plain, got: ' + mode); return 'PASS: mode = plain'; })()" in the webview
    When I evaluate "(() => { if (window.__e2eCopilotSendCalled !== true) throw new Error('Expected delegate path to call public copilotWriteQuerySend'); return 'public copilot send was called'; })()" in the webview
    Then I take a screenshot "05-copilot-plain"
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.__e2eOrigGetConnectionId) el.getConnectionId = el.__e2eOrigGetConnectionId; if (el.__e2eOrigGetDatabase) el.getDatabase = el.__e2eOrigGetDatabase; if (el.__e2eOrigCopilotWriteQuerySend) el.copilotWriteQuerySend = el.__e2eOrigCopilotWriteQuerySend; delete el.__e2eOrigGetConnectionId; delete el.__e2eOrigGetDatabase; delete el.__e2eOrigCopilotWriteQuerySend; delete window.__e2eCopilotSendCalled; return 'restored public API overrides'; })()" in the webview
    When I execute command "workbench.action.closeAllEditors"

  Scenario: configureQuerySection without execute does NOT change mode
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(() => { const existing = document.querySelector('kw-query-section'); if (existing) return 'ready: boxId=' + (existing.boxId || existing.id); const add = document.querySelector('button[data-add-kind=query]'); if (!add) throw new Error('Kusto add button not found'); add.click(); return 'clicked add Kusto section'; })()" in the webview
    When I wait for "kw-query-section" in the webview for 10 seconds

    # ── BASELINE: take100 ─────────────────────────────────────────────────
    When I evaluate "window.__testSelectKustoRunMode('take100')" in the webview
    And I wait 1 second

    # ── Fire toolConfigureQuerySection WITHOUT execute ─────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolConfigureQuerySection', requestId: 'e2e-no-exec', input: { sectionId: el.boxId, query: 'StormEvents | take 10' } }, '*'); return 'sent without execute'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT: mode is STILL take100 (not changed) ───────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'take100') throw new Error('FAIL: mode should still be take100 when not executing, got: ' + mode); return 'PASS: mode still take100 (no change without execute)'; })()" in the webview
    Then I take a screenshot "06-no-change-without-execute"
    When I execute command "workbench.action.closeAllEditors"
