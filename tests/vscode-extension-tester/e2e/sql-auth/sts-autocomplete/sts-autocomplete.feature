Feature: SQL autocomplete shows schema items

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: SQL autocomplete returns correct schema-aware completions
    # ── Setup ──────────────────────────────────────────────────────────────
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

    # Wait for schema to load (prefetchSqlSchema → sqlSchemaData → schemaByBoxId)
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "01-schema-ready"

    # Focus the SQL editor
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.sql.assertEditorMapped()" in the webview

    # ── TEST 1: FROM context → tables and views ────────────────────────────
    # Completions are LOCAL (read from schemaByBoxId). No remote calls, no waiting.
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM ', 1, 15)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "02-from-tables"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('FROM tables', 'Customer,Product,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 2: SalesLT. → tables in that schema ──────────────────────────
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM SalesLT.', 1, 23)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-saleslt-tables"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('SalesLT schema tables', 'Product,Customer,Address,SalesOrder')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 3: Column completion via alias ────────────────────────────────
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT p. FROM SalesLT.Product p', 1, 10)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "04-column-alias"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('Product alias columns', 'ProductID,Name,Color,ListPrice')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 4: dbo. → tables in dbo schema ───────────────────────────────
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM dbo.', 1, 19)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "05-dbo-tables"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('dbo schema tables', '')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 5: Keyword context ────────────────────────────────────────────
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SEL', 1, 4)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "06-keyword"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('keyword completion', 'SELECT')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 6: Switch to master ───────────────────────────────────────────
      When I evaluate "window.__e2e.sql.selectDatabase('master')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds
    Then I take a screenshot "07-db-switched"

    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM sys.', 1, 19)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "08-master-sys"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('master sys schema tables', '')" in the webview
    When I press "Escape"
    And I wait 1 second

    # ── TEST 7: Switch back to sampledb ────────────────────────────────────
      When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM SalesLT.', 1, 23)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.trigger()" in the webview
    And I wait 3 seconds
    Then I take a screenshot "09-restored-saleslt"
    When I evaluate "window.__e2e.suggest.sql.assertVisible('restored sampledb SalesLT tables', 'Product,Customer,Address,SalesOrder')" in the webview

    Then I take a screenshot "10-final"
    When I execute command "workbench.action.closeAllEditors"

