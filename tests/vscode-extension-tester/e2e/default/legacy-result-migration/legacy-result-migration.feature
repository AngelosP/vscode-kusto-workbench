Feature: Legacy persisted Kusto result migration

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeAuxiliaryBar"

  Scenario: Markerless result is adopted once and powers its chart after reopen
    When I delete file "tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx"
    When I execute command "kustoWorkbench.test.preparePersistedResultFixture" with args '[{"engine":"kusto","legacyKusto":true,"templatePath":"tests/vscode-extension-tester/e2e/default/legacy-result-migration/fixtures/legacy-chart.kqlx","outputPath":"tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx"}]'
    When I open file "tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx" in the editor
    When I wait for "kw-query-section" in the webview "legacy-chart.kqlx" for 20 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.waitForPersistedResult('query_legacy_migration', 19000); })()" in the webview "legacy-chart.kqlx" for 20 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3); })()" in the webview "legacy-chart.kqlx"
    Then I collect JSON artifact "legacy-migration-first-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open legacy migration fixture not found'); let text = ''; let file; const deadline = Date.now() + 10000; while (Date.now() < deadline) { text = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri)); file = JSON.parse(text); const section = file.state.sections.find(entry => entry.id === 'query_legacy_migration'); if (typeof section?.kustoAccountPartition === 'string' && section.kustoAccountPartition && section.kustoLeaveNoTraceRevision === 0) break; await new Promise(resolve => setTimeout(resolve, 100)); } const section = file.state.sections.find(entry => entry.id === 'query_legacy_migration'); if (!section?.kustoAccountPartition || section.kustoLeaveNoTraceRevision !== 0) throw new Error('Legacy provenance was not persisted: ' + JSON.stringify(section)); if (!section.resultJson?.includes('legacy-result-migration-e2e')) throw new Error('Exact legacy result payload was not retained'); if (section.resultArtifact) throw new Error('Privileged legacy artifact descriptor survived migration: ' + JSON.stringify(section.resultArtifact)); globalThis.__legacyResultMigrationBytes = text; return { partition: section.kustoAccountPartition, revision: section.kustoLeaveNoTraceRevision, hasResult: true, legacyArtifactRemoved: true, bytes: text.length }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "01-legacy-result-migrated"

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx" in the editor
    When I wait for "kw-query-section" in the webview "legacy-chart.kqlx" for 20 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.waitForPersistedResult('query_legacy_migration', 19000); })()" in the webview "legacy-chart.kqlx" for 20 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.assertMigratedResultChart('query_legacy_migration', 'chart_legacy_migration', 3); })()" in the webview "legacy-chart.kqlx"
    Then I collect JSON artifact "legacy-migration-reopened-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Reopened legacy migration fixture not found'); const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(document.uri)); if (text !== globalThis.__legacyResultMigrationBytes) throw new Error('Second open rewrote migrated bytes'); const section = JSON.parse(text).state.sections.find(entry => entry.id === 'query_legacy_migration'); if (!section?.kustoAccountPartition || section.kustoLeaveNoTraceRevision !== 0 || section.resultArtifact) throw new Error('Reopened migration state changed: ' + JSON.stringify(section)); return { byteStable: true, partition: section.kustoAccountPartition, revision: section.kustoLeaveNoTraceRevision, legacyArtifactRemoved: true }; })()"
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "02-legacy-result-reopened"

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.cleanupPersistedResultFixture"
    When I delete file "tests/vscode-extension-tester/runs/default/legacy-result-migration/legacy-chart.kqlx"