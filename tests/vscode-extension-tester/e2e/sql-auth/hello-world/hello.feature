Feature: Say hi to the audience

  Background:
    Given the extension is in a clean state
    And I wait 8 seconds

  Scenario: Write a friendly SQL query for the viewers
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds

    # Check that Monaco loaded (the fix)
    When I evaluate "(() => { const s = document.querySelector('kw-sql-section'); if (!s) return 'NO_SECTION'; return 'hasEditor=' + !!s._editor + ' monaco=' + !!(window.monaco && window.monaco.editor); })()" in the webview
    And I wait 1 second

    # Wait for editor to be ready (ensureMonaco is async now)
    And I wait 5 seconds

    # Re-check
    When I evaluate "(() => { const s = document.querySelector('kw-sql-section'); if (!s) return 'NO_SECTION'; return 'hasEditor=' + !!s._editor + ' monaco=' + !!(window.monaco && window.monaco.editor); })()" in the webview
    And I wait 1 second
    Then I take a screenshot "01-editor-state"

    # Set the greeting query
    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second
    When I evaluate "(() => { const ed = document.querySelector('kw-sql-section')._editor; if (!ed) return 'STILL NO EDITOR'; ed.setValue('SELECT ' + String.fromCharCode(39) + 'Hi everyone! Thanks for watching!' + String.fromCharCode(39) + ' AS Message'); ed.setPosition({lineNumber:1, column:1}); ed.focus(); return 'set: ' + ed.getValue(); })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "02-after-set"

    # Run it
    When I click "kw-sql-section .sql-run-btn" in the webview
    And I wait 8 seconds
    Then I take a screenshot "03-after-run"
