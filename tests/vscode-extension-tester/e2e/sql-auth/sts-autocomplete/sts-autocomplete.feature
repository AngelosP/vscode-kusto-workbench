Feature: SQL autocomplete shows schema items

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: SQL autocomplete returns correct schema-aware completions
    # ── Setup ──────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections (close-btn is in shadow DOM — fire events directly)
    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

      # Select sampledb through the database dropdown
      When I evaluate "window.__testSelectKwDropdownItem(`kw-sql-section .select-wrapper[title='SQL Database'] kw-dropdown`, 'sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Wait for schema to load (prefetchSqlSchema → sqlSchemaData → schemaByBoxId)
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "01-schema-ready"

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "(() => { window.__assertSqlSuggest = (context, expectedAnyCsv) => { const widgets = Array.from(document.querySelectorAll('.suggest-widget.visible')).filter(w => !w.classList.contains('hidden') && w.style.display !== 'none' && w.offsetParent !== null); if (widgets.length === 0) throw new Error(context + ': expected visible suggest widget'); const widget = widgets[widgets.length - 1]; const widgetText = (widget.textContent || '').trim(); if (/no suggestions/i.test(widgetText)) throw new Error(context + ': suggest widget reported no suggestions'); const rows = Array.from(widget.querySelectorAll('.monaco-list-row')).filter(r => r.offsetParent !== null); const labels = rows.map(r => ((r.querySelector('.label-name') || {}).textContent || '').trim()).filter(Boolean); if (labels.length === 0) throw new Error(context + ': expected visible suggestions, got 0 labels. Text: ' + widgetText.slice(0, 200)); const expected = String(expectedAnyCsv || '').split(',').map(s => s.trim()).filter(Boolean); if (expected.length && !expected.some(e => labels.some(l => l.toLowerCase().includes(e.toLowerCase())))) throw new Error(context + ': expected one of [' + expected.join(', ') + '], got: ' + labels.slice(0, 20).join(', ')); return context + '(' + labels.length + '): ' + labels.slice(0, 12).join(', '); }; return 'SQL suggest assertion helper installed'; })()" in the webview

    # ── TEST 1: FROM context → tables and views ────────────────────────────
    # Completions are LOCAL (read from schemaByBoxId). No remote calls, no waiting.
    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT * FROM ', 1, 15)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "02-from-tables"
    When I evaluate "__assertSqlSuggest('FROM tables', 'Customer,Product,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 2: SalesLT. → tables in that schema ──────────────────────────
    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT * FROM SalesLT.', 1, 23)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-saleslt-tables"
    When I evaluate "__assertSqlSuggest('SalesLT schema tables', 'Product,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 3: Column completion via alias ────────────────────────────────
    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT p. FROM SalesLT.Product p', 1, 10)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "04-column-alias"
    When I evaluate "__assertSqlSuggest('Product alias columns', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 4: dbo. → tables in dbo schema ───────────────────────────────
    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT * FROM dbo.', 1, 19)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "05-dbo-tables"
    When I evaluate "__assertSqlSuggest('dbo schema tables', '')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 5: Keyword context ────────────────────────────────────────────
    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SEL', 1, 4)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "06-keyword"
    When I evaluate "__assertSqlSuggest('keyword completion', 'SELECT')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 6: Switch to master ───────────────────────────────────────────
      When I evaluate "window.__testSelectKwDropdownItem(`kw-sql-section .select-wrapper[title='SQL Database'] kw-dropdown`, 'master')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "07-db-switched"

    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT * FROM sys.', 1, 19)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "08-master-sys"
    When I evaluate "__assertSqlSuggest('master sys schema tables', '')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 7: Switch back to sampledb ────────────────────────────────────
      When I evaluate "window.__testSelectKwDropdownItem(`kw-sql-section .select-wrapper[title='SQL Database'] kw-dropdown`, 'sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

    When I evaluate "window.__testSetMonacoValueAt('kw-sql-section .query-editor', 'SELECT * FROM SalesLT.', 1, 23)" in the webview
    And I wait 1 second
    When I evaluate "window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest')" in the webview
    And I wait 3 seconds
    Then I take a screenshot "09-restored-saleslt"
    When I evaluate "__assertSqlSuggest('restored sampledb SalesLT tables', 'Product,Customer,Address,SalesOrder')" in the webview

    Then I take a screenshot "10-final"
    When I execute command "workbench.action.closeAllEditors"

