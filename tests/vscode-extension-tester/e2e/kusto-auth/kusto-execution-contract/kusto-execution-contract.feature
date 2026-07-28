Feature: Kusto execution remains isolated from SQL Tools Service

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "notifications.clearAll"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds

  Scenario: Execute KQL and preserve result routing
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print message='kusto isolated', value=42`)" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.assertResultColumns('message,value')" in the webview
    When I evaluate "window.__e2e.kusto.assertRowCount(1)" in the webview
    When I evaluate "window.__e2e.kusto.assertNoError()" in the webview
    When I execute command "notifications.clearAll"
    Then I take a screenshot "01-exact-normal-result"
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Immediate rerun supersedes only the exact prior execution
    When I evaluate "window.__e2e.kusto.selectRunMode('plain')" in the webview
    When I evaluate "window.__e2e.kusto.setCacheEnabled(false)" in the webview
    When I evaluate "window.__e2e.kusto.beginHostMessageCapture()" in the webview
    When I evaluate "(() => { window.__exaImmediateTerminals = []; window.__exaImmediateTerminalHandler = event => { const message = event && event.data; if (message && ['queryResult', 'queryError', 'queryCancelled'].includes(message.type)) window.__exaImmediateTerminals.push({ type: message.type, boxId: message.boxId ?? null, executionId: message.executionId ?? null, sectionInstanceId: message.sectionInstanceId ?? null, targetGeneration: message.targetGeneration ?? null, reservationSequence: message.reservationSequence ?? null, reason: message.reason ?? null, error: message.error ?? null, clientActivityId: message.clientActivityId ?? null, dispatch: message.dispatch ?? null }); }; window.addEventListener('message', window.__exaImmediateTerminalHandler); return 'terminal capture armed'; })()" in the webview
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print immediate_rerun='old', value=1`)" in the webview
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const firstExecutionId = window.executeQuery(section.boxId, 'plain'); window.__e2e.kusto.setQuery(String.raw`print immediate_rerun='current', value=2`); const secondExecutionId = window.executeQuery(section.boxId, 'plain'); if (!firstExecutionId || !secondExecutionId || firstExecutionId === secondExecutionId) throw new Error('Immediate rerun did not reserve two exact executions'); return firstExecutionId + ' -> ' + secondExecutionId; })()" in the webview
    And I wait 5 seconds
    Then I collect JSON artifact "immediate-rerun-state" from webview expression "(() => { const section = document.querySelector('kw-query-section'); const outbound = window.__e2e.hostMessageCapture.messages.filter(message => message && ['executeQuery', 'cancelQuery'].includes(message.type)).map(message => ({ type: message.type, boxId: message.boxId ?? null, executionId: message.executionId ?? null, sectionInstanceId: message.sectionInstanceId ?? null, targetGeneration: message.targetGeneration ?? null, producer: message.producer ?? null })); return { outbound, terminals: window.__exaImmediateTerminals, activeExecution: section.getActiveExecution ? section.getActiveExecution() || null : null, executing: section.dataset.testExecuting ?? null, hasResults: section.dataset.testHasResults ?? null, hasError: section.dataset.testHasError ?? null, errorText: document.getElementById(section.boxId + '_error')?.textContent || null }; })()"
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "(() => { window.__e2e.kusto.assertResultColumns('immediate_rerun,value'); window.__e2e.kusto.assertRowCount(1); const messages = window.__e2e.hostMessageCapture.messages.filter(message => message && message.type === 'executeQuery'); if (messages.length < 2) throw new Error('Expected two executeQuery messages, got ' + messages.length); const pair = messages.slice(-2); if (pair[0].executionId === pair[1].executionId) throw new Error('Immediate rerun reused executionId'); for (const message of pair) { if (!message.executionId || !message.sectionInstanceId || !Number.isSafeInteger(message.targetGeneration)) throw new Error('Incomplete execution identity: ' + JSON.stringify(message)); } return pair.map(message => message.executionId).join(' -> '); })()" in the webview
    When I execute command "notifications.clearAll"
    Then I take a screenshot "02-immediate-rerun-current-result"
    When I evaluate "(() => { window.removeEventListener('message', window.__exaImmediateTerminalHandler); delete window.__exaImmediateTerminalHandler; return 'terminal capture restored'; })()" in the webview
    When I evaluate "window.__e2e.kusto.restoreHostMessageCapture()" in the webview
    When I execute command "workbench.action.closeAllEditors"

  Scenario: Database retarget retires the old execution before a fresh result
    When I evaluate "window.__e2e.kusto.selectRunMode('plain')" in the webview
    When I evaluate "window.__e2e.kusto.setCacheEnabled(false)" in the webview
    When I evaluate "window.__e2e.kusto.beginHostMessageCapture()" in the webview
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`let leftRows = range a from 1 to 1500000 step 1 | extend k = a % 4096, s = tostring(a); let rightRows = range b from 1 to 1500000 step 1 | extend k = b % 4096, t = tostring(b); leftRows | join kind=inner hint.strategy=shuffle (rightRows) on k | extend payload = strcat(s, ':', t, ':', tostring(rand())) | summarize pairs=count(), unique_payloads=dcount(payload)` )" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='true']" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.assertStillExecutingWithCancelAfter(3000)" in the webview for 8 seconds
    When I evaluate "window.__e2e.kusto.selectDifferentDatabase()" in the webview
    When I wait for "kw-query-section[data-test-executing='false']" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview for 28 seconds
    When I evaluate "(() => { const messages = window.__e2e.hostMessageCapture.messages; const started = messages.find(message => message && message.type === 'executeQuery'); const cancelled = messages.find(message => message && message.type === 'cancelQuery' && started && message.executionId === started.executionId); if (!started || !cancelled) throw new Error('Missing exact retarget cancellation: ' + JSON.stringify(messages)); if (cancelled.sectionInstanceId !== started.sectionInstanceId || cancelled.targetGeneration !== started.targetGeneration) throw new Error('Retarget cancellation identity mismatch'); return cancelled.executionId; })()" in the webview
    When I evaluate "window.__e2e.kusto.setQuery(String.raw`print after_retarget='current', value=3`)" in the webview
    When I evaluate "window.__e2e.kusto.assertRunEnabled()" in the webview
    When I evaluate "window.__e2e.kusto.run()" in the webview
    When I wait for "kw-query-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "(() => { window.__e2e.kusto.assertResultColumns('after_retarget,value'); window.__e2e.kusto.assertRowCount(1); return window.__e2e.kusto.assertNoError(); })()" in the webview
    When I execute command "notifications.clearAll"
    Then I take a screenshot "03-retarget-current-result"
    When I evaluate "window.__e2e.kusto.restoreHostMessageCapture()" in the webview
    When I execute command "workbench.action.closeAllEditors"