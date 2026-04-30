Feature: SQL Copilot inline completions without SQL authentication

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Inline completions toggle and request plumbing in SQL sections
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section" in the webview for 15 seconds
    Then I take a screenshot "00-setup-ready"

    When I evaluate "window.__e2e.inline.assertToggleVisible('sql')" in the webview
    Then I take a screenshot "01-toggle-exists"

    When I evaluate "window.__e2e.inline.assertGlobalEnabled(true)" in the webview
    Then I take a screenshot "02-inline-state-default"

    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.assertGlobalEnabled(false)" in the webview
    Then I take a screenshot "03-toggle-off"

    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.assertGlobalEnabled(true)" in the webview
    Then I take a screenshot "04-toggle-on"

    When I evaluate "window.__e2e.sql.assertEditorMapped()" in the webview
    Then I take a screenshot "05-editor-maps-populated"

    When I evaluate "window.__e2e.sql.assertInlineSuggestEnabled()" in the webview
    Then I take a screenshot "06-inline-suggest-option"

    When I scroll "kw-sql-section .query-editor" into view
    And I wait 1 second
    When I click "kw-sql-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.beginRequestCapture('sql', 'SELECT * FROM OfflineItems WHERE Name = ')" in the webview
    And I wait 1 second

    When I press "Ctrl+Shift+Space"
    And I wait 3 seconds
    Then I take a screenshot "07-after-ctrl-shift-space"

    When I evaluate "window.__e2e.inline.assertCapturedRequest('sql', 'SELECT')" in the webview
    Then I take a screenshot "08-inline-request-verified"

    When I evaluate "window.__e2e.inline.restoreRequestCapture()" in the webview

    When I wait for "button[data-add-kind='query']" in the webview for 5 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 10 seconds

    When I evaluate "window.__e2e.inline.assertToggleVisible('kusto')" in the webview
    When I evaluate "window.__e2e.inline.assertSqlAndKustoSynced(true)" in the webview
    Then I take a screenshot "09-both-toggles-on"

    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.assertSqlAndKustoSynced(false)" in the webview
    Then I take a screenshot "10-both-toggles-off-synced"

    When I evaluate "window.__e2e.inline.clickToggle('sql')" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.inline.rememberEditorMap('sql', 'sql-inline')" in the webview

    When I evaluate "window.__e2e.workbench.removeSection('kw-sql-section')" in the webview
    And I wait 2 seconds

    When I evaluate "window.__e2e.inline.assertRememberedEditorMapCleared('sql-inline')" in the webview
    Then I take a screenshot "11-cleanup-verified"

    Then I take a screenshot "12-final"
    When I execute command "workbench.action.closeAllEditors"
