Feature: Delayed supplemental schemas do not expose transient diagnostics

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeSidebar"
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "workbench.action.closePanel"
    When I execute command "kusto.openQueryEditor"
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState"
    And I wait 2 seconds

  Scenario: KS207 and KS208 stay hidden through delayed acquisition of reference seventeen
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait for "body[data-kusto-e2e-ready='true']" in the webview "session.kqlx"
    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section" in the webview for 15 seconds
    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', false)" in the webview
    When I evaluate "(() => { document.querySelectorAll('[data-testid^=e2e-proof-authoritative-supplemental-fixture]').forEach(element => element.remove()); const proof = document.createElement('div'); proof.dataset.testid = 'e2e-proof-authoritative-supplemental-fixture-pending'; proof.hidden = true; document.body.appendChild(proof); window.__e2e.kusto.scheduleNoContextAutocompleteRetryFixture(5000, 17, true).then(result => { proof.dataset.testid = 'e2e-proof-authoritative-supplemental-fixture'; proof.textContent = result; }).catch(error => { proof.dataset.testid = 'e2e-proof-authoritative-supplemental-fixture-failure'; proof.textContent = error instanceof Error ? error.message : String(error); }); return 'authoritative supplemental fixture started'; })()" in the webview
    When I wait for "[data-testid='e2e-proof-authoritative-supplemental-fixture'], [data-testid='e2e-proof-authoritative-supplemental-fixture-failure']" in the webview for 25 seconds
    Then I collect JSON artifact "authoritative-supplemental-fixture" from webview expression "(() => { const proof = document.querySelector('[data-testid=e2e-proof-authoritative-supplemental-fixture], [data-testid=e2e-proof-authoritative-supplemental-fixture-failure]'); return { outcome: proof?.dataset.testid || '', message: proof?.textContent || '', lifecycle: window.__e2e.kusto.schemaLifecycleSnapshot() }; })()"
    When I wait for "[data-testid='e2e-proof-authoritative-supplemental-fixture']" in the webview for 5 seconds
    When I evaluate "window.__e2e.kusto.assertPreparationReady(0)" in the webview
    When I evaluate "(() => { const states = window.__e2e.kusto.supplementalSnapshot(); if (states.length !== 17) throw new Error('Expected exactly 17 owned supplemental states, got ' + states.length); return 'owned supplemental states=' + states.length; })()" in the webview
    When I evaluate "(async () => { const section = document.querySelector('kw-query-section'); const editor = window.queryEditors?.[section?.boxId]; const model = editor?.getModel?.(); if (!model?.uri || !window.__e2e?.kusto) throw new Error('Delayed supplemental E2E context unavailable'); const diagnosticLeaks = []; const sampleMarkers = () => { const markers = monaco.editor.getModelMarkers({ owner: 'kusto', resource: model.uri }).filter(marker => ['KS207', 'KS208'].includes(String(typeof marker.code === 'object' ? marker.code?.value : marker.code).toUpperCase())); if (markers.length) diagnosticLeaks.push({ at: Date.now(), markers: markers.map(marker => ({ code: typeof marker.code === 'object' ? marker.code?.value : marker.code, message: marker.message, startLineNumber: marker.startLineNumber, startColumn: marker.startColumn, endLineNumber: marker.endLineNumber, endColumn: marker.endColumn })) }); }; sampleMarkers(); const diagnosticTimer = setInterval(sampleMarkers, 25); let failure = ''; let loadedState = ''; try { window.__e2e.kusto.clearCrossClusterTrace(); const triggered = await window.__e2e.kusto.triggerSuggest(); if (!triggered) throw new Error('Supplemental acquisition trigger was rejected'); loadedState = await window.__e2e.kusto.waitForSupplementalState(0, 'loaded', 20000); window.__e2e.kusto.assertNoSupplementalWarnings(0); } catch (error) { failure = error instanceof Error ? error.message : String(error); } finally { clearInterval(diagnosticTimer); sampleMarkers(); } const success = !failure && diagnosticLeaks.length === 0; const proof = document.createElement('div'); proof.dataset.testid = success ? 'e2e-proof-delayed-supplemental-diagnostics' : 'e2e-proof-delayed-supplemental-diagnostics-failure'; proof.textContent = JSON.stringify({ success, failure, loadedState, leakCount: diagnosticLeaks.length, diagnosticLeaks, lifecycle: window.__e2e.kusto.schemaLifecycleSnapshot(), supplementalStates: window.__e2e.kusto.supplementalSnapshot(), crossClusterTrace: window.__e2e.kusto.getCrossClusterTrace() }); proof.hidden = true; document.body.appendChild(proof); return proof.dataset.testid; })()" in the webview for 28 seconds
    When I wait for "[data-testid='e2e-proof-delayed-supplemental-diagnostics'], [data-testid='e2e-proof-delayed-supplemental-diagnostics-failure']" in the webview for 5 seconds
    Then I collect JSON artifact "delayed-supplemental-diagnostics" from webview expression "JSON.parse((document.querySelector('[data-testid=e2e-proof-delayed-supplemental-diagnostics]') || document.querySelector('[data-testid=e2e-proof-delayed-supplemental-diagnostics-failure]')).textContent)"
    When I wait for "[data-testid='e2e-proof-delayed-supplemental-diagnostics']" in the webview for 5 seconds
    Then I take a screenshot "01-reference-seventeen-loaded"
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
