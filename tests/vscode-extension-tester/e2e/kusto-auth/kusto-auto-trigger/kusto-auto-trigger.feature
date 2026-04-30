Feature: Kusto auto-trigger autocomplete behavior

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Kusto auto-trigger suggestions respect typing context and toolbar state
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 15 seconds
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.selectSampleDatabase()" in the webview
    When I wait for "kw-query-section[data-test-database-selected='true']" in the webview for 10 seconds
    When I evaluate "window.__e2e.kusto.startCompletionTargetProbe(25000)" in the webview
    When I wait for "kw-query-section[data-test-completion-targets-ready='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.kusto.assertCompletionTargetsReady()" in the webview
    Then I take a screenshot "01-setup-ready"

    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', true)" in the webview
    When I evaluate "window.__e2e.autoTrigger.assertToggleVisible('kusto')" in the webview
    Then I take a screenshot "02-toggle-visible-on"

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second

    When I evaluate "window.__e2e.kusto.setCompletionContext('pipe-operators')" in the webview
    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before enabled pipe auto-trigger')" in the webview
    When I evaluate "window.__e2e.kusto.setQueryAt(window.__e2eKustoCompletionTargets.table + '\n|', 2, 2)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(' ')" in the webview
    When I evaluate "window.__e2e.kusto.assertAutoTriggered('pipe-operators', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionStaysVisible('pipe-operators', 800)" in the webview

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('escape hides kusto suggestions')" in the webview

    When I evaluate "window.__e2e.kusto.setQueryAt(window.__e2eKustoCompletionTargets.table + '\n| where ', 2, 9)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(window.__e2eKustoCompletionTargets.columnPrefix)" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('kusto end-of-word suppression')" in the webview
    Then I take a screenshot "03-end-of-word-suppression"

    When I evaluate "window.__e2e.autoTrigger.clickToggle('kusto')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.assertEnabled(false)" in the webview
    Then I take a screenshot "04-toggle-off"

    When I evaluate "window.__e2e.kusto.setQueryAt(window.__e2eKustoCompletionTargets.table + '\n|', 2, 2)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(' ')" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('kusto disabled auto-trigger')" in the webview
    Then I take a screenshot "05-disabled-no-auto-trigger"

    When I evaluate "window.__e2e.autoTrigger.clickToggle('kusto')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.assertEnabled(true)" in the webview
    Then I take a screenshot "06-toggle-on"

    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before re-enabled pipe auto-trigger')" in the webview
    When I evaluate "window.__e2e.kusto.setQueryAt(window.__e2eKustoCompletionTargets.table + '\n|', 2, 2)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(' ')" in the webview
    When I evaluate "window.__e2e.kusto.assertAutoTriggered('pipe-operators', 3000)" in the webview
    When I evaluate "window.__e2e.kusto.assertCompletionStaysVisible('pipe-operators', 800)" in the webview

    When I execute command "workbench.action.closeAllEditors"
