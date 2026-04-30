Feature: Kusto auto-trigger autocomplete without authentication

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Kusto auto-trigger suggestions respect typing context and toolbar state without schema
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 15 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.dataset.testConnection !== 'false') throw new Error('Default Kusto auto-trigger test must not have an active connection'); if (el.dataset.testDatabaseSelected !== 'false') throw new Error('Default Kusto auto-trigger test must not have a selected database'); const boxId = el.boxId || el.id; if (boxId && window.schemaByBoxId?.[boxId]) throw new Error('Default Kusto auto-trigger test must not have loaded schema for ' + boxId); return 'offline Kusto section ready: boxId=' + boxId; })()" in the webview
    When I evaluate "window.__e2e.autoTrigger.ensureEnabled('kusto', true)" in the webview
    When I evaluate "window.__e2e.autoTrigger.assertToggleVisible('kusto')" in the webview
    Then I take a screenshot "01-toggle-visible-on"

    When I scroll "kw-query-section .query-editor" into view
    And I wait 1 second
    When I click "kw-query-section .query-editor" in the webview
    And I wait 1 second

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before enabled pipe auto-trigger')" in the webview
    When I evaluate "window.__e2e.kusto.setQueryAt('print marker = 1\n|', 2, 2)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(' ')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.waitExistingAllVisible('kusto pipe operator auto-trigger without schema', 'where,project', 5000)" in the webview
    Then I take a screenshot "02-pipe-suggestions-without-schema"

    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('escape hides kusto suggestions')" in the webview

    When I evaluate "window.__e2e.kusto.setQueryAt('print marker = ', 1, 16)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText('x')" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('kusto end-of-word suppression without schema')" in the webview
    Then I take a screenshot "03-end-of-word-suppression"

    When I evaluate "window.__e2e.autoTrigger.clickToggle('kusto')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.assertEnabled(false)" in the webview
    Then I take a screenshot "04-toggle-off"

    When I evaluate "window.__e2e.kusto.setQueryAt('print marker = 1\n|', 2, 2)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(' ')" in the webview
    And I wait 2 seconds
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('kusto disabled auto-trigger without schema')" in the webview
    Then I take a screenshot "05-disabled-no-auto-trigger"

    When I evaluate "window.__e2e.autoTrigger.clickToggle('kusto')" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.autoTrigger.assertEnabled(true)" in the webview
    When I press "Escape"
    And I wait 1 second
    When I evaluate "window.__e2e.suggest.kusto.hide()" in the webview
    When I evaluate "window.__e2e.suggest.kusto.assertHidden('before re-enabled pipe auto-trigger')" in the webview
    Then I take a screenshot "06-toggle-on"

    When I evaluate "window.__e2e.kusto.setQueryAt('print marker = 1\n|', 2, 2)" in the webview
    When I evaluate "window.__e2e.suggest.kusto.typeText(' ')" in the webview
    When I evaluate "window.__e2e.suggest.kusto.waitExistingAllVisible('re-enabled kusto pipe operator auto-trigger without schema', 'where,project', 5000)" in the webview
    Then I take a screenshot "07-reenabled-pipe-suggestions"

    When I execute command "workbench.action.closeAllEditors"
