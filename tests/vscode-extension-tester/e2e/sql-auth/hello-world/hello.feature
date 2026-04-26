Feature: Say hi to the audience

  Background:
    Given the extension is in a clean state
    And I wait 8 seconds

  Scenario: Write a friendly SQL query for the viewers
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "(() => { if (!document.querySelector('kw-sql-section')) { const add = document.querySelector('button[data-add-kind=sql]'); if (!add) throw new Error('SQL section missing and add SQL button not found'); add.click(); return 'added sql section'; } return 'sql section already present'; })()" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section .monaco-editor" in the webview for 20 seconds
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const target = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!target) throw new Error('No SQL database available for hello-world query'); if (el._database !== target) { el.setDatabase(target); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: target }, bubbles: true, composed: true })); } return 'database=' + target; })()" in the webview

    # Check that Monaco loaded (the fix)
    When I evaluate "(() => { const s = document.querySelector('kw-sql-section'); if (!s) throw new Error('SQL section missing'); if (!s._editor) throw new Error('SQL Monaco editor missing'); if (!(window.monaco && window.monaco.editor)) throw new Error('window.monaco.editor missing'); return 'hasEditor=true monaco=true'; })()" in the webview
    And I wait 1 second

    # Wait for editor to be ready (ensureMonaco is async now)
    And I wait 5 seconds

    # Re-check
    When I evaluate "(() => { const s = document.querySelector('kw-sql-section'); if (!s) throw new Error('SQL section missing on re-check'); if (!s._editor) throw new Error('SQL Monaco editor missing on re-check'); if (!(window.monaco && window.monaco.editor)) throw new Error('window.monaco.editor missing on re-check'); return 'hasEditor=true monaco=true'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "01-editor-state"

    # Set the greeting query
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; if (!ed) throw new Error('SQL editor missing before setting greeting query'); ed.setValue('SELECT ' + String.fromCharCode(39) + 'Hi everyone! Thanks for watching!' + String.fromCharCode(39) + ' AS Message'); ed.setPosition({lineNumber:1, column:1}); ed.focus(); return 'set: ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "02-after-set"

    # Run it
    When I click "kw-sql-section .sql-run-btn" in the webview
    When I wait for "kw-sql-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dt = el.querySelector('.sql-results-body kw-data-table'); if (!dt) throw new Error('No SQL results data table'); const cols = (dt.columns || []).map(c => c.name || c); if (!cols.includes('Message')) throw new Error('Expected Message column, got: ' + cols.join(', ')); const rows = dt.rows || []; if (rows.length !== 1) throw new Error('Expected exactly one greeting row, got ' + rows.length); const value = rows[0][cols.indexOf('Message')]; if (String(value) !== 'Hi everyone! Thanks for watching!') throw new Error('Unexpected greeting value: ' + value); return 'greeting result verified'; })()" in the webview
    Then I take a screenshot "03-after-run"
    When I execute command "workbench.action.closeAllEditors"
