Feature: SQL Tools Service type fidelity

  Background:
    Given the extension is in a clean state
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds
    When I evaluate "window.__e2e.sql.selectDatabase('sampledb')" in the webview
    When I wait for "kw-sql-section[data-test-schema-ready='true']" in the webview for 60 seconds

  Scenario: Preserve SQL scalar values in the shared query-result contract
    When I evaluate "(() => { const dq = String.fromCharCode(34); const json = '{' + dq + 'a' + dq + ':1}'; const query = `SELECT CAST(NULL AS int) AS NullValue, CAST(1 AS bit) AS BitValue, CAST(9007199254740993 AS bigint) AS BigValue, CAST(1234567890.123456789 AS decimal(28,9)) AS DecimalValue, CAST('2026-07-13T12:34:56.1234567' AS datetime2(7)) AS DateTimeValue, CAST('2026-07-13T12:34:56.1234567+05:30' AS datetimeoffset(7)) AS OffsetValue, CAST('12345678-1234-1234-1234-1234567890ab' AS uniqueidentifier) AS GuidValue, CAST(0x0102FF AS varbinary(3)) AS BinaryValue, N'${json}' AS JsonText, CAST(N'<root><v>1</v></root>' AS xml) AS XmlValue`; return window.__e2e.sql.setQuery(query); })()" in the webview
    When I evaluate "window.__e2e.sql.run()" in the webview
    When I wait for "kw-sql-section[data-test-executing='false'][data-test-has-results='true']" in the webview for 30 seconds
    Then I collect JSON artifact "sql-sts-type-contract" from webview expression "window.__e2e.sql.resultContract()"
    When I evaluate "window.__e2e.sql.assertTypeContract()" in the webview
    When I execute command "workbench.action.closeAllEditors"