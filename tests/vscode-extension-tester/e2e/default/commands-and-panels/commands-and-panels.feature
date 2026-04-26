Feature: Connection manager — open, view, interact

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Open connection manager and verify it renders
    # ── TEST 1: Open connection manager via command ───────────────────────
    When I execute command "kusto.manageConnections"
    And I wait 3 seconds
    When I wait for "kw-connection-manager" in the webview for 20 seconds
    Then I take a screenshot "01-connection-manager-opened"
    # The connection manager renders in its own webview panel.
    # Screenshot verification confirms it opened and rendered.

  Scenario: Open query editor and verify add-section controls
    # ── TEST 3: Open query editor ─────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I wait for "#queries-container" in the webview for 20 seconds

    # ── TEST 4: All add-section buttons are present ───────────────────────
    When I evaluate "(() => { const kinds = ['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown']; const missing = kinds.filter(k => !document.querySelector('[data-add-kind=' + k + ']')); if (missing.length) throw new Error('Missing add buttons: ' + missing.join(', ')); return 'all ' + kinds.length + ' add buttons present'; })()" in the webview
    Then I take a screenshot "03-add-buttons-present"

  Scenario: Cached values viewer command
    # ── TEST 5: Show cached values ────────────────────────────────────────
    When I execute command "kusto.seeCachedValues"
    And I wait 3 seconds
    When I wait for "kw-cached-values" in the webview for 20 seconds
    Then I take a screenshot "04-cached-values"

  Scenario: Activity bar view
    # ── TEST 6: Activity bar ──────────────────────────────────────────────
    When I execute command "workbench.view.extension.kustoWorkbench"
    And I wait 2 seconds
    Then I take a screenshot "05-activity-bar"
