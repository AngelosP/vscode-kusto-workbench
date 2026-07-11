Feature: Fully qualified Kusto references prepare without an editor click

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "kusto.openQueryEditor"
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState"
    And I wait 1 second

  Scenario: KQL compatibility editor background-loads a fully qualified schema before focus
    When I execute command "kustoWorkbench.test.seedSupplementalSchemaDiagnosticsState" with args '["tests/vscode-extension-tester/e2e/default/kusto-fq-open-diagnostics/fixtures/fully-qualified-background.kql"]'
    When I open file "tests/vscode-extension-tester/e2e/default/kusto-fq-open-diagnostics/fixtures/fully-qualified-background.kql" in the editor
    When I wait for "kw-query-section" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview for 28 seconds
    When I evaluate "window.__e2e.kusto.waitForSupplementalState(0, 'loaded', 15000)" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertNoSupplementalWarnings(0)" in the webview
    When I evaluate "window.__e2e.kusto.assertSupplementalBackgroundTrace(0)" in the webview

    When I click "kw-query-section .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.assertColumnCompletionForSection(0, 'RemoteOnlyColumn', 5000)" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.assertNoSupplementalWarnings(0)" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 950, 15
    Then I take a screenshot "01-kql-remote-completion-ready"
    When I execute command "workbench.action.files.revert"
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState"

  Scenario: Restored KQLX sections keep supplemental schemas model-scoped
    When I execute command "kustoWorkbench.test.seedSupplementalSchemaDiagnosticsState"
    When I open file "tests/vscode-extension-tester/e2e/default/kusto-fq-open-diagnostics/fixtures/fully-qualified-multi-section.kqlx" in the editor
    When I wait for "#query_supplemental_first" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview for 28 seconds
    When I wait for "#query_supplemental_second" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.waitForSupplementalState(0, 'loaded', 15000)" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertNoSupplementalWarnings(0)" in the webview
    When I evaluate "window.__e2e.kusto.assertSupplementalBackgroundTrace(0)" in the webview
    When I click "#query_supplemental_first .query-editor" in the webview
    When I evaluate "(() => { const first = document.getElementById('query_supplemental_first'); const second = document.getElementById('query_supplemental_second'); const firstId = first?.boxId || first?.id; const secondId = second?.boxId || second?.id; if (!firstId || !secondId || window.activeQueryEditorBoxId !== firstId) throw new Error('First section must remain active before inactive edit'); const editor = window.queryEditors?.[secondId]; if (!editor) throw new Error('Inactive second editor missing'); editor.setValue('print inactive = 1'); return 'removed inactive supplemental reference'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const first = document.getElementById('query_supplemental_first'); const second = document.getElementById('query_supplemental_second'); const firstId = first?.boxId || first?.id; const secondId = second?.boxId || second?.id; if (!firstId || !secondId || window.activeQueryEditorBoxId !== firstId) throw new Error('Focus moved before inactive supplemental edit'); const editor = window.queryEditors?.[secondId]; editor.setValue(`cluster('supplemental-remote.westus').database('TelemetryDb').RemoteEvents${String.fromCharCode(10)}| project RemoteOnly`); return 'restored inactive supplemental reference'; })()" in the webview
    When I evaluate "window.__e2e.kusto.waitForSupplementalState(1, 'loaded', 15000)" in the webview for 20 seconds
    When I evaluate "(() => { const first = document.getElementById('query_supplemental_first'); const firstId = first?.boxId || first?.id; if (window.activeQueryEditorBoxId !== firstId) throw new Error('Inactive supplemental loading stole focus'); return 'inactive supplemental loaded without focus'; })()" in the webview
    When I evaluate "window.__e2e.kusto.assertNoSupplementalWarnings(1)" in the webview
    When I evaluate "window.__e2e.kusto.assertSupplementalBackgroundTrace(1)" in the webview

    When I click "#query_supplemental_second .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(1, 25000)" in the webview for 28 seconds
    When I evaluate "window.__e2e.kusto.waitForSupplementalState(1, 'loaded', 15000)" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertColumnCompletionForSection(1, 'RemoteOnlyColumn', 5000)" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.assertNoSupplementalWarnings(1)" in the webview
    When I evaluate "window.__e2e.kusto.assertSupplementalBackgroundTrace(1)" in the webview

    When I click "#query_supplemental_first .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.waitForPreparationReady(0, 25000)" in the webview for 28 seconds
    When I evaluate "window.__e2e.kusto.waitForSupplementalState(0, 'loaded', 15000)" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.assertColumnCompletionForSection(0, 'RemoteOnlyColumn', 5000)" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.assertNoSupplementalWarnings(0)" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 950, 15
    Then I take a screenshot "02-kqlx-model-roundtrip-ready"
    When I execute command "workbench.action.files.revert"
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState"
