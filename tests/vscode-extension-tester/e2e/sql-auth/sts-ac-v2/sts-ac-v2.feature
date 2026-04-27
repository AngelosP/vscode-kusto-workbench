Feature: STS-powered SQL autocomplete verification

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: STS completions provide context-aware columns and tables
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 1050
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second

    # ── Setup: open editor, add SQL section, connect to sampledb ───────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Remove all existing sections
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb through the database dropdown
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true'][data-test-database='sampledb']" in the webview for 10 seconds

    # Trigger STS connect
    When I evaluate "window.__e2e.sql.connectSts()" in the webview
    When I wait for "kw-sql-section[data-test-sts-ready='true']" in the webview for 120 seconds

    # Wait for schema
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "00-setup-ready"

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.assertEditorMapped()" in the webview

    # ── WARM UP STS: fire a trivial completion to force STS to index the document ──
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT 1', 1, 9)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 1: SELECT column list — "SELECT | FROM SalesLT.Product"
    # Using String.fromCharCode(10) for proper newlines not needed here (single line)
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT  FROM SalesLT.Product', 1, 8)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "01-select-column-list"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T1 SELECT column list', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 2: Multi-line SELECT mid-column-list (your screenshot scenario)
    # Using proper newlines via String.fromCharCode(10) = LF
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt(`SELECT TOP 10\n  ProductID,\n  Name,\n  ProductNumber,\n  Color,\n  \n  ListPrice,\n  Size,\n  Weight\nFROM SalesLT.Product\nORDER BY ProductID;`, 6, 3)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "02-mid-column-list"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T2 multi-line column list', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 3: WHERE clause columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt(`SELECT * FROM SalesLT.Product\nWHERE `, 2, 7)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "03-where-clause"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T3 WHERE columns', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 4: ORDER BY columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt(`SELECT * FROM SalesLT.Product\nORDER BY `, 2, 10)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "04-order-by"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T4 ORDER BY columns', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 5: JOIN ON alias p. → Product columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt(`SELECT *\nFROM SalesLT.Product p\nJOIN SalesLT.ProductCategory c ON p.`, 3, 44)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "05-join-on-alias"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T5 JOIN alias columns', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 6: FROM tables — "SELECT * FROM |"
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM ', 1, 15)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "06-from-tables"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T6 FROM tables', 'Product,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 7: SalesLT. → schema-qualified tables
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM SalesLT.', 1, 23)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "07-saleslt-dot"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T7 SalesLT schema tables', 'Product,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 8: Keyword partial — "SEL" → SELECT
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SEL', 1, 4)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "08-keyword-sel"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T8 keyword completion', 'SELECT')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 9: WHERE partial column — "WHERE Colo" → Color
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM SalesLT.Product WHERE Colo', 1, 42)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "09-where-partial-col"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T9 partial column completion', 'Color')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ══════════════════════════════════════════════════════════════════════
    # TEST 10: Subquery SELECT columns
    # ══════════════════════════════════════════════════════════════════════
    When I evaluate "window.__e2e.suggest.sql.setTextAt(`SELECT * FROM SalesLT.Product\nWHERE ProductCategoryID IN (SELECT  FROM SalesLT.ProductCategory)`, 2, 36)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 8 seconds
    Then I take a screenshot "10-subquery"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('T10 subquery columns', 'ProductCategoryID,Name')" in the webview
    When I press "Escape"
    And I wait 1 second

    Then I take a screenshot "99-final"
    When I execute command "workbench.action.closeAllEditors"
  And I wait 1 second
