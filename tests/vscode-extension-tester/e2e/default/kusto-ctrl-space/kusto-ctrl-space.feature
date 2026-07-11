Feature: Kusto Ctrl+Space autocomplete shortcut

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    When I execute command "kusto.openQueryEditor"
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState"
    And I wait 2 seconds

  Scenario: Ctrl+Space opens Kusto suggestions in the real webview editor
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 15 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('Kusto section missing'); if (el.dataset.testConnection !== 'false') throw new Error('Default Ctrl+Space test must not have an active connection'); return 'offline Kusto section ready'; })()" in the webview
    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before Ctrl+Space')" in the webview
    When I evaluate "window.__e2e.kusto.setQueryAt('print marker = 1\n| ', 2, 3)" in the webview
    When I press "Ctrl+Space"
    When I evaluate "window.__e2e.suggest.kusto.waitExistingAllVisible('manual Ctrl+Space Kusto fallback operators', 'where,project', 5000)" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 950, 15
    Then I take a screenshot "01-ctrl-space-suggest-visible"

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"

  Scenario: Ctrl+Space opens suggestions inside a function over a fully qualified remote table
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 15 seconds

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before FQ function Ctrl+Space')" in the webview
    When I evaluate "window.__e2e.kusto.applySemanticCompletionFixture()" in the webview
    When I evaluate "window.__e2e.kusto.setSemanticScenario('first-timestamp')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('after setting semantic scenario before Ctrl+Space')" in the webview
    When I press "Ctrl+Space"
    When I evaluate "window.__e2e.kusto.assertSemanticScenarioVisible('first-timestamp')" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 950, 15
    Then I take a screenshot "02-fq-function-ctrl-space-suggest-visible"
    When I evaluate "window.__e2e.kusto.assertSemanticScenarioVisible('first-timestamp')" in the webview

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"

  Scenario: Ctrl+Space loads a fully qualified remote schema without a primary selection
    When I execute command "kustoWorkbench.test.seedSupplementalSchemaDiagnosticsState"
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section" in the webview for 15 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el || el.dataset.testConnection !== 'false') throw new Error('Expected no primary Kusto connection'); return 'no primary selection'; })()" in the webview
    When I click "kw-query-section .query-editor" in the webview
    When I evaluate "window.__e2e.kusto.setQueryWithCaretMarkerStrict('cluster(\'supplemental-remote.westus.kusto.windows.net\').database(\'TelemetryDb\').RemoteEvents\n| project RemoteO⟦caret⟧')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I press "Ctrl+Space"
    When I evaluate "window.__e2e.suggest.kusto.waitExistingAllColumnsVisible('no-primary fully qualified Ctrl+Space', 'RemoteOnlyColumn', 10000)" in the webview for 15 seconds
    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
    When I execute command "kustoWorkbench.test.cleanupSupplementalSchemaDiagnosticsState"

  Scenario: Ctrl+Space falls back after a missing remote schema timeout
    When I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.enableIsolatedKustoConnections()" in the webview
    When I evaluate "window.__e2e.workbench.assertIsolatedKustoConnections()" in the webview

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 15 seconds

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.applySemanticCompletionFixture()" in the webview
    When I evaluate "window.__e2e.kusto.setMissingRemoteSchemaScenario()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before missing remote Ctrl+Space')" in the webview
    When I press "Ctrl+Space"
    When I evaluate "window.__e2e.suggest.kusto.waitVisible('missing remote schema fallback after bounded wait', 'where,project,tostring', 4000)" in the webview
    When I execute command "workbench.action.focusActiveEditorGroup"
    When I click at 950, 15
    Then I take a screenshot "03-missing-remote-fallback-visible"

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.clearIsolatedKustoConnections"
