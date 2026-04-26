@screenshot-generator
# Screenshot generator for .github/skills/readme-screenshots; behavioral coverage lives in non-readme E2Es.
Feature: Capture sql-sections screenshot for README
  Scenario: SQL query with results — mirrors the Kusto query editor screenshot
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1050
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "kusto.openQueryEditor"
    And I wait 10 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds

    # Remove all existing sections
    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    # Add SQL section
    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    # Wait for SQL connection and databases
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) return 'no section'; const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

    # Focus the SQL editor and set a nice multi-line query
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "(() => { const NL = String.fromCharCode(10); const el = document.querySelector('kw-sql-section'); const ed = el._editor; ed.setValue('SELECT TOP 5' + NL + '  pc.Name           AS Category,' + NL + '  COUNT(*)          AS Products,' + NL + '  ROUND(AVG(p.ListPrice), 2)  AS AvgPrice,' + NL + '  MIN(p.ListPrice)  AS MinPrice,' + NL + '  MAX(p.ListPrice)  AS MaxPrice' + NL + 'FROM SalesLT.Product p' + NL + 'JOIN SalesLT.ProductCategory pc' + NL + '  ON p.ProductCategoryID = pc.ProductCategoryID' + NL + 'GROUP BY pc.Name' + NL + 'ORDER BY Products DESC;'); ed.focus(); return 'query set, lines=' + ed.getModel().getLineCount(); })()" in the webview
    And I wait 2 seconds

    # Execute the query
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.querySelector('.sql-run-btn').click(); return 'clicked run'; })()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false']" in the webview for 30 seconds
    And I wait 2 seconds

    # Verify results appeared
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testHasResults !== 'true') throw new Error('No results: ' + el.dataset.testHasResults); return 'results present'; })()" in the webview

    # Mask server and database names with placeholders (avoid double quotes to not break step regex)
    When I evaluate "(() => { const sec = document.querySelector('kw-sql-section'); const dds = Array.from(sec.shadowRoot.querySelectorAll('kw-dropdown')); let msg = ''; if (dds[0]) { const btn = dds[0].shadowRoot.querySelector('.kusto-dropdown-btn-text'); if (btn) { btn.textContent = 'serverName'; msg += 'server masked; '; } } if (dds[1]) { const btn = dds[1].shadowRoot.querySelector('.kusto-dropdown-btn-text'); if (btn) { btn.textContent = 'databaseName'; msg += 'db masked; '; } } return msg || 'nothing masked'; })()" in the webview

    # Remove the default query section if still present
    When I evaluate "(() => { const qs = document.querySelector('kw-query-section'); if (qs) { qs.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: qs.boxId || qs.id }, bubbles: true, composed: true })); return 'removed kql section'; } return 'no kql section'; })()" in the webview
    And I wait 1 second

    # Save to clear unsaved indicator
    And I press "Ctrl+S"
    And I wait 2 seconds

    # Ensure the query editor (not Connection Manager) is the active tab
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 1 second
    When I evaluate "(() => { const sec = document.querySelector('kw-sql-section'); if (!sec) return 'no section found'; sec.scrollIntoView({block: 'start'}); return 'scrolled to section'; })()" in the webview
    And I wait 1 second

    Then I take a screenshot "01-sql-sections"
