Feature: Document-kind section capabilities

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"

  Scenario: Report a known incompatible MDX section without changing the file
    Given a file "tests/vscode-extension-tester/runs/default/document-capabilities/incompatible.mdx" exists with content:
      """
      {"kind":"mdx","version":1,"state":{"sections":[{"id":"query_invalid_mdx","type":"query","query":"print value = 1"},{"id":"future_invalid_mdx","type":"future-section","payload":{"keep":true}}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/document-capabilities/incompatible.mdx" in the editor
    Then the webview should contain "Invalid Kusto Workbench file"
    Then the webview should contain "Invalid .mdx"
    Then the webview should contain "query_invalid_mdx"
    Then the webview should contain "incompatible known type"
    When I execute command "notifications.clearAll"
    Then I take a screenshot "01-incompatible-mdx-read-only"
    Then I collect JSON artifact "incompatible-mdx-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/document-capabilities/incompatible.mdx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open incompatible MDX fixture not found'); if (document.isDirty) throw new Error('Invalid MDX unexpectedly became dirty'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const ids = file.state.sections.map(section => section.id); if (ids.join('|') !== 'query_invalid_mdx|future_invalid_mdx') throw new Error('Invalid MDX content changed: ' + ids.join(',')); return { kind: file.kind, ids, queryType: file.state.sections[0].type, futurePayload: file.state.sections[1].payload, dirty: document.isDirty }; })()"

    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/default/document-capabilities/incompatible.mdx"

  Scenario: Render only MDX-approved sections and add controls
    Given a file "tests/vscode-extension-tester/runs/default/document-capabilities/valid-future.mdx" exists with content:
      """
      {"kind":"mdx","version":1,"futureRoot":{"keep":true},"state":{"futureState":"opaque","sections":[{"id":"markdown_mdx_1","type":"markdown","title":"MDX Notes","text":"# Document capabilities"},{"id":"future_mdx_1","type":"future-section","payload":{"nested":[1,2,3]}},{"id":"url_mdx_1","type":"url","url":""},{"id":"devnotes_mdx_1","type":"devnotes","entries":[]},{"id":"transform_mdx_1","type":"transformation","name":"Derived"}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/document-capabilities/valid-future.mdx" in the editor
    When I wait for "kw-markdown-section" in the webview for 20 seconds
    When I wait for "kw-url-section" in the webview for 20 seconds
    When I wait for "kw-transformation-section" in the webview for 20 seconds
    When I evaluate "(() => { const visualTags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-transformation-section','kw-markdown-section','kw-python-section','kw-url-section','kw-html-section']; const ids = Array.from(document.querySelectorAll(visualTags.join(','))).map(element => element.id); const expectedIds = ['markdown_mdx_1','url_mdx_1','transform_mdx_1']; if (ids.join('|') !== expectedIds.join('|')) throw new Error('Unexpected MDX visual sections: ' + ids.join(',')); const visibleKinds = Array.from(new Set(Array.from(document.querySelectorAll('[data-add-kind]')).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none').map(element => element.getAttribute('data-add-kind')))); const expectedKinds = ['transformation','url','markdown']; if (visibleKinds.slice().sort().join('|') !== expectedKinds.slice().sort().join('|')) throw new Error('Unexpected MDX add controls: ' + visibleKinds.join(',')); if (document.getElementById('future_mdx_1') || document.getElementById('devnotes_mdx_1')) throw new Error('Opaque or hidden sections were rendered as visual sections'); if (document.body.dataset.kustoDocumentKind !== 'mdx') throw new Error('Document kind projection was not mdx'); return { ids, visibleKinds, documentKind: document.body.dataset.kustoDocumentKind }; })()" in the webview
    When I scroll ".add-controls" into view
    Then I take a screenshot "02-valid-mdx-capabilities"
    Then I collect JSON artifact "valid-mdx-capabilities" from webview expression "(() => { const visualTags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-transformation-section','kw-markdown-section','kw-python-section','kw-url-section','kw-html-section']; const ids = Array.from(document.querySelectorAll(visualTags.join(','))).map(element => element.id); const visibleKinds = Array.from(new Set(Array.from(document.querySelectorAll('[data-add-kind]')).filter(element => element.getClientRects().length > 0 && getComputedStyle(element).display !== 'none').map(element => element.getAttribute('data-add-kind')))); return { ids, visibleKinds, documentKind: document.body.dataset.kustoDocumentKind }; })()"
    Then I collect JSON artifact "valid-mdx-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/document-capabilities/valid-future.mdx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open valid MDX fixture not found'); if (document.isDirty) throw new Error('Valid MDX unexpectedly became dirty during restore'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const ids = file.state.sections.map(section => section.id); const expectedIds = ['markdown_mdx_1','future_mdx_1','url_mdx_1','devnotes_mdx_1','transform_mdx_1']; if (ids.join('|') !== expectedIds.join('|')) throw new Error('MDX section order changed: ' + ids.join(',')); if (file.futureRoot?.keep !== true || file.state.futureState !== 'opaque') throw new Error('Future root/state data was lost'); if (file.state.sections[1].payload?.nested?.join(',') !== '1,2,3') throw new Error('Opaque future payload was lost'); return { kind: file.kind, ids, futureRoot: file.futureRoot, futureState: file.state.futureState, futurePayload: file.state.sections[1].payload, dirty: document.isDirty }; })()"

    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/default/document-capabilities/valid-future.mdx"

  Scenario: Preserve an opaque-only MDX without inserting a default section
    Given a file "tests/vscode-extension-tester/runs/default/document-capabilities/opaque-only.mdx" exists with content:
      """
      {"kind":"mdx","version":1,"futureRoot":{"keep":"root"},"state":{"futureState":{"keep":true},"sections":[{"id":"future_only_mdx","type":"future-section","payload":{"nested":[4,5,6]}}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/document-capabilities/opaque-only.mdx" in the editor
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(() => { const visualTags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-transformation-section','kw-markdown-section','kw-python-section','kw-url-section','kw-html-section']; const ids = Array.from(document.querySelectorAll(visualTags.join(','))).map(element => element.id); if (ids.length) throw new Error('Opaque-only MDX acquired visual sections: ' + ids.join(',')); if (document.getElementById('future_only_mdx')) throw new Error('Opaque future section was rendered'); return { ids, documentKind: document.body.dataset.kustoDocumentKind }; })()" in the webview
    When I execute command "workbench.action.files.save"
    And I wait 1 second
    Then I take a screenshot "03-opaque-only-mdx"
    Then I collect JSON artifact "opaque-only-mdx-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/document-capabilities/opaque-only.mdx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open opaque-only MDX fixture not found'); if (document.isDirty) throw new Error('Opaque-only MDX unexpectedly became dirty'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const ids = file.state.sections.map(section => section.id); if (ids.join('|') !== 'future_only_mdx') throw new Error('Opaque-only MDX acquired sections: ' + ids.join(',')); if (file.futureRoot?.keep !== 'root' || file.state.futureState?.keep !== true || file.state.sections[0].payload?.nested?.join(',') !== '4,5,6') throw new Error('Opaque-only MDX data changed'); return { kind: file.kind, ids, futureRoot: file.futureRoot, futureState: file.state.futureState, payload: file.state.sections[0].payload, dirty: document.isDirty }; })()"

    When I execute command "workbench.action.closeAllEditors"
    When I delete file "tests/vscode-extension-tester/runs/default/document-capabilities/opaque-only.mdx"

  Scenario: Persist SQL optimization comparisons as SQLX-compatible sections
    Given a file "tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx" exists with content:
      """
      {"kind":"sqlx","version":1,"state":{"sections":[{"id":"sql_source_e2e","type":"sql","name":"Source SQL","query":"SELECT 1 AS Value","expanded":true}]}}
      """

    When I execute command "kustoWorkbench.test.seedCod2SqlConnection"
    When I open file "tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx" in the editor
    When I wait for "#sql_source_e2e" in the webview for 20 seconds
    When I evaluate "(async () => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const source = document.getElementById('sql_source_e2e'); const connection = (window.sqlConnections || []).find(candidate => candidate.name === 'COD-2 E2E SQL'); if (source && connection) { window.sqlCachedDatabases[connection.id] = ['Db']; source.setDesiredDatabase('Db'); source.setConnections(window.sqlConnections, { lastConnectionId: connection.id, cachedDatabases: window.sqlCachedDatabases }); await source.updateComplete; if (source.getConnectionId() === connection.id && source.getDatabase() === 'Db') return { connectionId: connection.id, database: source.getDatabase() }; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('COD-2 SQL source target was not adopted'); })()" in the webview for 15 seconds
    And I wait 1 second
    When I execute command "kustoWorkbench.test.prepareSqlComparison" with args '["sql_source_e2e","SELECT 2 AS Value"]'
    When I wait for "kw-sql-section[id^='sql_cmp_']" in the webview for 20 seconds
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-sql-section')); if (sections.length !== 2) throw new Error('Expected two SQL sections, found ' + sections.length); const serialized = sections.map(section => section.serialize()); const comparisonElement = sections.find(section => section.id !== 'sql_source_e2e'); const comparison = serialized.find(section => section.id !== 'sql_source_e2e'); if (!comparisonElement || comparisonElement.hasAttribute('data-sql-comparison-admission-request-id')) throw new Error('SQL comparison remained provisional after host commit'); if (!comparison || comparison.type !== 'sql' || comparison.query !== 'SELECT 2 AS Value' || comparison.comparisonSourceBoxId !== 'sql_source_e2e') throw new Error('Invalid SQL comparison: ' + JSON.stringify(comparison)); window.schedulePersist('sql-comparison-e2e', true); return serialized; })()" in the webview
    When I evaluate "(() => { const comparison = Array.from(document.querySelectorAll('kw-sql-section')).find(section => section.id !== 'sql_source_e2e'); if (!comparison) throw new Error('Committed SQL comparison was not found'); window.__committedSqlComparisonId = comparison.id; return comparison.id; })()" in the webview
    When I execute command "kustoWorkbench.test.assertNestedSqlComparisonRejected" with args '["SELECT 99 AS Value"]'
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-sql-section')); if (sections.length !== 2 || sections.some(section => section.id !== 'sql_source_e2e' && section.id !== window.__committedSqlComparisonId)) throw new Error('Nested comparison rejection mutated sections: ' + sections.map(section => section.id).join(',')); return sections.map(section => section.serialize()); })()" in the webview
    And I wait 1 second
    When I execute command "workbench.action.files.save"
    And I wait 1 second
    When I execute command "workbench.action.closeAllEditors"
    When I open file "tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx" in the editor
    When I wait for "kw-sql-section[id^='sql_cmp_']" in the webview for 20 seconds
    When I evaluate "(async () => { const deadline = Date.now() + 10000; while (Date.now() < deadline) { const source = document.getElementById('sql_source_e2e'); const connection = (window.sqlConnections || []).find(candidate => candidate.name === 'COD-2 E2E SQL'); if (source && connection) { window.sqlCachedDatabases[connection.id] = ['Db']; source.setDesiredDatabase('Db'); source.setConnections(window.sqlConnections, { lastConnectionId: connection.id, cachedDatabases: window.sqlCachedDatabases }); await source.updateComplete; if (source.getConnectionId() === connection.id && source.getDatabase() === 'Db') return { connectionId: connection.id, database: source.getDatabase() }; } await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error('Restored COD-2 SQL source target was not adopted'); })()" in the webview for 15 seconds
    And I wait 1 second
    When I evaluate "(async () => { const elements = Array.from(document.querySelectorAll('kw-sql-section')); const serialized = elements.map(section => section.serialize()); if (serialized.length !== 2 || serialized.some(section => section.type !== 'sql')) throw new Error('SQLX restored an incompatible section: ' + JSON.stringify(serialized)); const comparison = serialized.find(section => section.id !== 'sql_source_e2e'); if (comparison?.comparisonSourceBoxId !== 'sql_source_e2e' || comparison?.query !== 'SELECT 2 AS Value') throw new Error('SQL comparison lineage was not restored'); for (const section of elements) { section.clearResults?.(); section.requestUpdate?.(); } await Promise.all(elements.map(section => section.updateComplete)); return serialized; })()" in the webview
    Then I collect JSON artifact "sqlx-comparison-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Open SQLX comparison fixture not found'); if (document.isDirty) throw new Error('SQLX comparison unexpectedly remained dirty'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const types = file.state.sections.map(section => section.type); if (types.join('|') !== 'sql|sql') throw new Error('SQLX contains incompatible types: ' + types.join(',')); const comparison = file.state.sections.find(section => section.id !== 'sql_source_e2e'); if (comparison?.comparisonSourceBoxId !== 'sql_source_e2e' || comparison?.query !== 'SELECT 2 AS Value') throw new Error('Persisted SQL comparison is invalid'); return { kind: file.kind, ids: file.state.sections.map(section => section.id), types, comparisonSourceBoxId: comparison.comparisonSourceBoxId, comparisonQuery: comparison.query, dirty: document.isDirty }; })()"

    When I evaluate "(() => { const comparison = Array.from(document.querySelectorAll('kw-sql-section')).find(section => section.id !== 'sql_source_e2e'); if (!comparison) throw new Error('Restored comparison not found for removal'); const removedId = comparison.id; window.removeSqlBox(removedId); if (document.getElementById(removedId)) throw new Error('Removed comparison remains in the DOM'); if (document.querySelectorAll('kw-sql-section').length !== 1) throw new Error('Expected only the SQL source after removal'); window.__removedSqlComparisonId = removedId; return removedId; })()" in the webview
    When I execute command "kustoWorkbench.test.prepareSqlComparison" with args '["sql_source_e2e","SELECT 3 AS Value"]'
    When I wait for "kw-sql-section[id^='sql_cmp_']" in the webview for 20 seconds
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-sql-section')); if (sections.length !== 2) throw new Error('Expected one recreated comparison'); const comparison = sections.find(section => section.id !== 'sql_source_e2e'); if (!comparison || comparison.id === window.__removedSqlComparisonId || comparison.hasAttribute('data-sql-comparison-admission-request-id') || comparison.serialize().query !== 'SELECT 3 AS Value') throw new Error('SQL comparison recreation retained stale or provisional state'); window.schedulePersist('sql-comparison-recreated-e2e', true); return comparison.id; })()" in the webview
    And I wait 1 second
    When I execute command "workbench.action.files.save"
    And I wait 1 second
    When I execute command "workbench.action.closeAllEditors"
    When I open file "tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx" in the editor
    When I wait for "kw-sql-section[id^='sql_cmp_']" in the webview for 20 seconds
    When I evaluate "(() => { const serialized = Array.from(document.querySelectorAll('kw-sql-section')).map(section => section.serialize()); if (serialized.length !== 2 || serialized.some(section => section.type !== 'sql')) throw new Error('Recreated SQL comparison did not reopen exactly once'); const comparison = serialized.find(section => section.id !== 'sql_source_e2e'); if (comparison?.query !== 'SELECT 3 AS Value' || comparison?.comparisonSourceBoxId !== 'sql_source_e2e') throw new Error('Recreated comparison lineage is stale'); return serialized; })()" in the webview
    Then I collect JSON artifact "sqlx-comparison-recreated-file" from extension host expression "(async () => { const suffix = '/tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx'; const document = vscode.workspace.textDocuments.find(candidate => candidate.uri.path.replace(/\\/g, '/').endsWith(suffix)); if (!document) throw new Error('Recreated SQLX comparison fixture not found'); const bytes = await vscode.workspace.fs.readFile(document.uri); const file = JSON.parse(new TextDecoder().decode(bytes)); const comparisons = file.state.sections.filter(section => section.id !== 'sql_source_e2e'); if (comparisons.length !== 1 || comparisons[0].type !== 'sql' || comparisons[0].query !== 'SELECT 3 AS Value' || comparisons[0].comparisonSourceBoxId !== 'sql_source_e2e') throw new Error('Recreated SQL comparison file is invalid: ' + JSON.stringify(file.state.sections)); return { ids: file.state.sections.map(section => section.id), types: file.state.sections.map(section => section.type), comparisonQuery: comparisons[0].query, comparisonSourceBoxId: comparisons[0].comparisonSourceBoxId, dirty: document.isDirty }; })()"

    When I execute command "workbench.action.closeAllEditors"
    When I execute command "kustoWorkbench.test.removeCod2SqlConnection"
    When I delete file "tests/vscode-extension-tester/runs/default/document-capabilities/sql-comparison.sqlx"