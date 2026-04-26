Feature: Comprehensive T-SQL autocomplete exploration

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Explore all interesting T-SQL autocomplete contexts
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1050
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second

    # ── Setup: open editor, add SQL section, connect to sampledb ───────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections
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

    # Trigger STS connect (needed for context-aware completions from SqlToolsService)
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('SQL section not found'); const sqlConnectionId = typeof el.getSqlConnectionId === 'function' ? el.getSqlConnectionId() : ''; const database = typeof el.getDatabase === 'function' ? el.getDatabase() : ''; if (!sqlConnectionId) throw new Error('SQL connection id missing before STS connect'); if (!database) throw new Error('SQL database missing before STS connect'); window.vscode.postMessage({ type: 'stsConnect', boxId: el.boxId, sqlConnectionId, database }); return 'stsConnect: ' + database; })()" in the webview
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

    # Wait for schema to load (prefetchSqlSchema → sqlSchemaData → schemaByBoxId)
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "00-setup-ready"

    # Dump schema state for diagnostics
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('SQL section not found'); const boxId = el.boxId; const schema = window.schemaByBoxId?.[boxId]; if (!schema) throw new Error('No SQL schema for boxId=' + boxId + ', keys=' + Object.keys(window.schemaByBoxId || {}).join(',')); const tableCount = (schema.tables || []).length; const columnTableCount = Object.keys(schema.columnsByTable || {}).length; if (tableCount === 0 && columnTableCount === 0) throw new Error('SQL schema loaded but has no tables/columns'); return 'tables=' + tableCount + ' views=' + (schema.views||[]).length + ' colTables=' + columnTableCount; })()" in the webview

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "(() => { window.__assertSqlSuggestHasRows = (context, expectedAnyCsv) => window.__testAssertVisibleSuggest(context, expectedAnyCsv || '', 'kw-sql-section .query-editor'); window.__setSqlTextAt = (text, line, column) => window.__testSetMonacoValueAt('kw-sql-section .query-editor', text, line, column); window.__triggerSqlSuggest = () => window.__testTriggerMonaco('kw-sql-section .query-editor', 'editor.action.triggerSuggest'); return 'SQL exploration suggest and editor helpers installed'; })()" in the webview

    # ══════════════════════════════════════════════════════════════════════
    # TEST 1: SELECT column list — cursor after "SELECT " in "SELECT | FROM SalesLT.Product"
    # EXPECTED: column names from SalesLT.Product (ProductID, Name, Color, etc.)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SELECT  FROM SalesLT.Product', 1, 8)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "01-select-column-list"
    When I evaluate "__assertSqlSuggestHasRows('T1-SELECT-COLS', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Multi-line SELECT with cursor mid-column-list (user's exact scenario)
    # EXPECTED: column names from the FROM table, not random keywords like PROCEDURE
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT TOP 10\n  ProductID,\n  Name,\n  ProductNumber,\n  Color,\n  \n  ListPrice,\n  Size,\n  Weight\nFROM SalesLT.Product\nORDER BY ProductID;`, 6, 3)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "02-mid-column-list"
    When I evaluate "__assertSqlSuggestHasRows('T2-MID-COLS', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: WHERE clause — cursor after WHERE
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT * FROM SalesLT.Product\nWHERE `, 2, 7)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "03-where-clause"
    When I evaluate "__assertSqlSuggestHasRows('T3-WHERE', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: ORDER BY columns
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT * FROM SalesLT.Product\nORDER BY `, 2, 10)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "04-order-by"
    When I evaluate "__assertSqlSuggestHasRows('T4-ORDERBY', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: GROUP BY columns
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT Color, COUNT(*)\nFROM SalesLT.Product\nGROUP BY `, 3, 10)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "05-group-by"
    When I evaluate "__assertSqlSuggestHasRows('T5-GROUPBY', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: Inside aggregate function — COUNT(|)
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SELECT COUNT() FROM SalesLT.Product', 1, 14)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "06-inside-aggregate"
    When I evaluate "__assertSqlSuggestHasRows('T6-COUNT', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 7: JOIN ON clause — columns from both tables
    # EXPECTED: columns from both Product and ProductCategory
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT *\nFROM SalesLT.Product p\nJOIN SalesLT.ProductCategory c ON p.`, 3, 44)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "07-join-on-alias"
    When I evaluate "__assertSqlSuggestHasRows('T7-JOIN-ON', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 8: JOIN second alias — c. should show ProductCategory columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT *\nFROM SalesLT.Product p\nJOIN SalesLT.ProductCategory c ON p.ProductCategoryID = c.`, 3, 59)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "08-join-second-alias"
    When I evaluate "__assertSqlSuggestHasRows('T8-JOIN-C', 'ProductCategoryID,Name')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 9: UPDATE SET columns
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('UPDATE SalesLT.Product SET ', 1, 28)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "09-update-set"
    When I evaluate "__assertSqlSuggestHasRows('T9-UPDATE', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 10: INSERT INTO table columns — inside parentheses
    # EXPECTED: column names from SalesLT.Product
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('INSERT INTO SalesLT.Product ()', 1, 30)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "10-insert-into-cols"
    When I evaluate "__assertSqlSuggestHasRows('T10-INSERT', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 11: FROM context — "SELECT * FROM " (space after FROM)
    # EXPECTED: table names (SalesLT.Product, SalesLT.ProductCategory, etc.)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SELECT * FROM ', 1, 15)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "11-from-tables"
    When I evaluate "__assertSqlSuggestHasRows('T11-FROM', 'Product,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 12: SalesLT. context — schema-qualified table completion
    # EXPECTED: tables in SalesLT schema (Product, ProductCategory, etc.)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SELECT * FROM SalesLT.', 1, 23)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "12-saleslt-dot"
    When I evaluate "__assertSqlSuggestHasRows('T12-SALESLT', 'Product,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 13: Keyword partial — "SEL" should match SELECT first
    # EXPECTED: SELECT as top suggestion
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SEL', 1, 4)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "13-keyword-sel"
    When I evaluate "__assertSqlSuggestHasRows('T13-SEL', 'SELECT')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 14: HAVING clause
    # EXPECTED: columns or aggregate functions
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT Color, COUNT(*)\nFROM SalesLT.Product\nGROUP BY Color\nHAVING `, 4, 8)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "14-having"
    When I evaluate "__assertSqlSuggestHasRows('T14-HAVING', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 15: CTE / WITH clause — after AS ( SELECT
    # EXPECTED: context-aware completions
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`WITH cte AS (\n  SELECT  FROM SalesLT.Product\n)\nSELECT * FROM cte`, 2, 10)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "15-cte-select"
    When I evaluate "__assertSqlSuggestHasRows('T15-CTE', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 16: Partial table name after FROM — "FROM Prod"
    # EXPECTED: SalesLT.Product and related tables matching "Prod"
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SELECT * FROM Prod', 1, 19)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "16-partial-table"
    When I evaluate "__assertSqlSuggestHasRows('T16-PARTIAL', 'Product')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 17: WHERE with partial column — "WHERE Colo"
    # EXPECTED: Color column should appear
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt('SELECT * FROM SalesLT.Product WHERE Colo', 1, 42)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "17-where-partial-col"
    When I evaluate "__assertSqlSuggestHasRows('T17-WHERECOL', 'Color')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 18: After WHERE condition — "WHERE Color = 'Red' AND "
    # EXPECTED: column names for additional conditions
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT * FROM SalesLT.Product\nWHERE Color = 'Red' AND `, 2, 25)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "18-where-and"
    When I evaluate "__assertSqlSuggestHasRows('T18-AND', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 19: Subquery context — "WHERE ProductID IN (SELECT )"
    # EXPECTED: context-aware (columns or sub-select items)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT * FROM SalesLT.Product\nWHERE ProductCategoryID IN (SELECT  FROM SalesLT.ProductCategory)`, 2, 36)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "19-subquery"
    When I evaluate "__assertSqlSuggestHasRows('T19-SUBQ', 'ProductCategoryID,Name')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 20: JOIN context — second table
    # EXPECTED: table names after JOIN
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__setSqlTextAt(`SELECT * FROM SalesLT.Product\nJOIN `, 2, 6)" in the webview
    And I wait 1 second
    When I evaluate "window.__triggerSqlSuggest()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "20-join-table"
    When I evaluate "__assertSqlSuggestHasRows('T20-JOIN', 'Product,ProductCategory,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    Then I take a screenshot "99-final"
    When I execute command "workbench.action.closeAllEditors"
  And I wait 1 second
