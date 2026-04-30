Feature: SQL auto-trigger fallback completions without SQL authentication

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Auto-trigger fallback suggestions respect typing context and toolbar state
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section" in the webview for 15 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testSqlConnection !== 'false') throw new Error('Default SQL auto-trigger test must not have an active connection'); if (el.dataset.testSchemaReady !== 'false') throw new Error('Default SQL auto-trigger test must not have loaded schema'); return 'offline SQL section ready'; })()" in the webview
    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('sql', true)" in the webview
    When I evaluate "window.__e2e.autoTrigger.assertSqlToggleVisible()" in the webview
    Then I take a screenshot "01-toggle-exists"

    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.assertHidden('before enabled SQL paren auto-trigger')" in the webview
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT COUNT', 1, 13)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.assertHidden('after setting SQL paren baseline')" in the webview
    When I evaluate "window.__e2e.suggest.sql.typeText('(')" in the webview
    When I evaluate "window.__e2e.suggest.sql.waitExistingAllVisible('auto-trigger COUNT paren keyword fallback', 'SELECT,FROM,WHERE', 5000)" in the webview
    Then I take a screenshot "02-auto-trigger-paren-keywords"
    When I press "Escape"
    And I wait 1 second

    When I evaluate "window.__e2e.autoTrigger.clickSqlToggle()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.assertEnabled(false)" in the webview

    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT COUNT', 1, 13)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.typeText('(')" in the webview
    And I wait 2 seconds
    Then I take a screenshot "03-no-auto-trigger-disabled"
    When I evaluate "window.__e2e.suggest.sql.assertHidden('disabled SQL auto-trigger')" in the webview

    When I evaluate "window.__e2e.autoTrigger.clickSqlToggle()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.assertEnabled(true)" in the webview
    Then I take a screenshot "04-toggle-restored"

    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT ', 1, 8)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.typeText('N')" in the webview
    And I wait 2 seconds
    Then I take a screenshot "05-end-of-word-suppression"
    When I evaluate "window.__e2e.suggest.sql.assertHidden('SQL end-of-word suppression')" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.assertHidden('before enabled SQL dot auto-trigger')" in the webview
    When I evaluate "window.__e2e.suggest.sql.setTextAt('SELECT * FROM dbo', 1, 18)" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.sql.assertHidden('after setting SQL dot baseline')" in the webview
    When I evaluate "window.__e2e.suggest.sql.typeText('.')" in the webview
    When I evaluate "window.__e2e.suggest.sql.waitExistingAllVisible('auto-trigger dbo dot keyword fallback', 'SELECT,FROM,WHERE', 5000)" in the webview
    Then I take a screenshot "06-auto-trigger-dot-keywords"
    When I press "Escape"
    And I wait 1 second

    Then I take a screenshot "07-final"
    When I execute command "workbench.action.closeAllEditors"
