Feature: Remote .sqlx file — open from GitHub and verify SQL notebook

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I capture the output channel "Kusto Workbench: Remote File"
    And I wait 2 seconds

  Scenario: Open a remote .sqlx file from GitHub via Open Remote File command
    When I start command "kusto.openRemoteFile"
    And I wait 2 seconds
    When I type "https://github.com/coreai-microsoft/azure-dev-tools/blob/main/product-telemetry/.investigations/angelpe/Temp/sample.sqlx" into the InputBox
    And I press "Enter"
    Then I take a screenshot "01-url-submitted"

    And I wait 25 seconds
    Then I take a screenshot "02-after-download"

    Then I should not see notification "Unsupported file type"
    Then I should not see notification "Failed to open remote file"

    When I wait for "kw-sql-section" in the webview for 30 seconds
    Then I take a screenshot "03-webview-loaded"

    When I evaluate "(() => { const sqlSections = document.querySelectorAll('kw-sql-section').length; const kqlSections = document.querySelectorAll('kw-query-section').length; if (sqlSections === 0 && kqlSections > 0) throw new Error('Found ' + kqlSections + ' Kusto sections but 0 SQL — .sqlx treated as kqlx'); if (sqlSections === 0) throw new Error('No SQL sections found'); return 'SQL=' + sqlSections + ' KQL=' + kqlSections + ' ✓'; })()" in the webview
    Then I take a screenshot "04-sections-verified"

    When I evaluate "(() => { const kind = document.body.dataset.kustoDocumentKind; if (kind !== 'sqlx') throw new Error('Expected documentKind=sqlx, got: ' + kind); return 'documentKind=' + kind + ' ✓'; })()" in the webview
    Then I take a screenshot "05-final"
