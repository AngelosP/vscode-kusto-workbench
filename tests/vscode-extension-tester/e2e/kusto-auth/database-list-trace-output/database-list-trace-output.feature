Feature: Kusto database-list Trace output capture

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    When I resize the Dev Host to 1280x1000
    When I execute command "workbench.action.closeAuxiliaryBar"
    And I wait 2 seconds

  Scenario: Forced database refresh is readable from the Kusto Workbench channel
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I wait for "kw-query-section[data-test-connection='true']" in the webview for 20 seconds

    When I set the output channel "Kusto Workbench" log level to "Trace"
    Then the output channel "Kusto Workbench" log level should be "Trace"

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No Kusto query section'); const connectionId = el.getConnectionId(); if (!connectionId) throw new Error('No Kusto connection'); el.dispatchEvent(new CustomEvent('refresh-databases', { detail: { boxId: el.boxId, connectionId }, bubbles: true, composed: true })); return 'database refresh dispatched'; })()" in the webview
    When I wait for "kw-query-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    Then the output channel "Kusto Workbench" should contain "[database-list:"
    Then the output channel "Kusto Workbench" should contain "service.live-fetch.start"
    Then the output channel "Kusto Workbench" should contain "client.request.start"
    Then I wait for output channel "Kusto Workbench" to contain "client.success" for 45 seconds
    Then the output channel "Kusto Workbench" should have been captured
