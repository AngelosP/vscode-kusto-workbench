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
    When I evaluate "await new Promise((resolve, reject) => { let n = 0; const iv = setInterval(() => { n++; let el = document.querySelector('kw-query-section'); if (!el && n === 1 && typeof window.addQueryBox === 'function') { try { window.addQueryBox(); } catch(e) {} } if (el) { clearInterval(iv); resolve('ready: boxId=' + (el.boxId || el.id)); } else if (n > 30) { clearInterval(iv); reject(new Error('kw-query-section not found')); } }, 1000); })" in the webview

    # ── Scroll run button into view ───────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); if (btn) btn.scrollIntoView({ block: 'center' }); return 'scrolled'; })()" in the webview
    And I wait 1 second

    # ── BASELINE: mode is take100 ─────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.setRunMode(el.boxId, 'take100'); return 'set take100'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'take100') throw new Error('Expected take100, got: ' + mode); const btn = document.getElementById(el.boxId + '_run_btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (!label.includes('take 100')) throw new Error('Label should show take 100, got: ' + label); return 'BEFORE: mode=' + mode + ', label=' + label; })()" in the webview
    Then I take a screenshot "01-before-take100"

    # ── Fire toolConfigureQuerySection with execute:true ───────────────────
    #    This is the message the host sends when the agent calls
    #    configureKustoQuerySection({ sectionId, query, execute: true })
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolConfigureQuerySection', requestId: 'e2e-exec-1', input: { sectionId: el.boxId, query: 'StormEvents | take 10', execute: true } }, '*'); return 'sent toolConfigureQuerySection execute=true'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT: run mode changed to plain ─────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'plain') throw new Error('FAIL: mode should be plain after agent execute, got: ' + mode); return 'PASS: mode = plain'; })()" in the webview

    # ── ASSERT: button label updated ──────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (label.includes('take') || label.includes('sample') || label.includes('TOP')) throw new Error('FAIL: label still has modifier: ' + label); return 'PASS: label = ' + label; })()" in the webview
    Then I take a screenshot "02-after-plain"

  Scenario: configureKustoQuerySection execute forces sample100 to plain
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I evaluate "await new Promise((resolve, reject) => { let n = 0; const iv = setInterval(() => { n++; let el = document.querySelector('kw-query-section'); if (!el && n === 1 && typeof window.addQueryBox === 'function') { try { window.addQueryBox(); } catch(e) {} } if (el) { clearInterval(iv); resolve('ready'); } else if (n > 30) { clearInterval(iv); reject(new Error('timeout')); } }, 1000); })" in the webview

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); if (btn) btn.scrollIntoView({ block: 'center' }); return 'scrolled'; })()" in the webview
    And I wait 1 second

    # ── BASELINE: sample100 ───────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.setRunMode(el.boxId, 'sample100'); return 'set sample100'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'sample100') throw new Error('Expected sample100, got: ' + mode); const btn = document.getElementById(el.boxId + '_run_btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (!label.includes('sample 100')) throw new Error('Label should show sample 100, got: ' + label); return 'BEFORE: mode=' + mode + ', label=' + label; })()" in the webview
    Then I take a screenshot "03-before-sample100"

    # ── Fire toolConfigureQuerySection with execute:true ───────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolConfigureQuerySection', requestId: 'e2e-exec-2', input: { sectionId: el.boxId, query: 'StormEvents | count', execute: true } }, '*'); return 'sent'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT ────────────────────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'plain') throw new Error('FAIL: mode should be plain, got: ' + mode); const btn = document.getElementById(el.boxId + '_run_btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (label.includes('take') || label.includes('sample') || label.includes('TOP')) throw new Error('FAIL: label still has modifier: ' + label); return 'PASS: mode=plain, label=' + label; })()" in the webview
    Then I take a screenshot "04-after-plain-from-sample"

  Scenario: askKustoCopilot also forces mode to plain
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I evaluate "await new Promise((resolve, reject) => { let n = 0; const iv = setInterval(() => { n++; let el = document.querySelector('kw-query-section'); if (!el && n === 1 && typeof window.addQueryBox === 'function') { try { window.addQueryBox(); } catch(e) {} } if (el) { clearInterval(iv); resolve('ready'); } else if (n > 30) { clearInterval(iv); reject(new Error('timeout')); } }, 1000); })" in the webview

    # ── BASELINE: take100 ─────────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.setRunMode(el.boxId, 'take100'); el._connectionId = 'stub-conn'; el._database = 'StubDb'; return 'set take100 + stubbed connection'; })()" in the webview
    And I wait 1 second

    # ── Fire toolDelegateToKustoWorkbenchCopilot ──────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolDelegateToKustoWorkbenchCopilot', requestId: 'e2e-copilot', input: { question: 'show events', sectionId: el.boxId } }, '*'); return 'sent'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT: mode is plain ─────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'plain') throw new Error('FAIL: mode should be plain, got: ' + mode); return 'PASS: mode = plain'; })()" in the webview
    Then I take a screenshot "05-copilot-plain"

  Scenario: configureQuerySection without execute does NOT change mode
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I evaluate "await new Promise((resolve, reject) => { let n = 0; const iv = setInterval(() => { n++; let el = document.querySelector('kw-query-section'); if (!el && n === 1 && typeof window.addQueryBox === 'function') { try { window.addQueryBox(); } catch(e) {} } if (el) { clearInterval(iv); resolve('ready'); } else if (n > 30) { clearInterval(iv); reject(new Error('timeout')); } }, 1000); })" in the webview

    # ── BASELINE: take100 ─────────────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.setRunMode(el.boxId, 'take100'); return 'set take100'; })()" in the webview
    And I wait 1 second

    # ── Fire toolConfigureQuerySection WITHOUT execute ─────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); window.postMessage({ type: 'toolConfigureQuerySection', requestId: 'e2e-no-exec', input: { sectionId: el.boxId, query: 'StormEvents | take 10' } }, '*'); return 'sent without execute'; })()" in the webview
    And I wait 2 seconds

    # ── ASSERT: mode is STILL take100 (not changed) ───────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const mode = (window.runModesByBoxId || {})[el.boxId]; if (mode !== 'take100') throw new Error('FAIL: mode should still be take100 when not executing, got: ' + mode); return 'PASS: mode still take100 (no change without execute)'; })()" in the webview
    Then I take a screenshot "06-no-change-without-execute"
