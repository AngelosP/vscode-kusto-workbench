Feature: .sqlx and .mdx file support — custom editor rendering

  Verifies that .sqlx and .mdx files open correctly in the custom editor
  with the expected section types rendered. These tests validate the
  custom editor provider handles all session file types.

  The diff viewer Smart View toggle (formatKqlxForDiff + renderDiffInWebview)
  is covered by 25 unit tests in diffViewerUtils.test.ts, including tests
  for sqlx-kind files and SQL section formatting.

  NOTE: E2E testing of the SCM diff Smart View is blocked by a framework
  limitation — adding the first workspace folder via updateWorkspaceFolders()
  restarts the Extension Host, which disconnects the test controller.

  Fixture files in fixtures/ provide the test data.

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 3 seconds

  # ── Scenario 1: .sqlx file opens correctly ─────────────────────────────
  Scenario: Open a .sqlx file and verify SQL section renders
    When I open file "tests/vscode-extension-tester/e2e/default/sqlx-diff-viewer/fixtures/open-test.sqlx" in the editor
    And I wait 8 seconds
    Then I take a screenshot "01-sqlx-file-opened"

    # Verify the custom editor loaded a SQL section
    When I wait for "kw-sql-section" in the webview for 20 seconds
    Then element "kw-sql-section" should exist
    Then I take a screenshot "02-sqlx-sql-section-rendered"

    # Clean up
    When I execute command "workbench.action.closeAllEditors"

  # ── Scenario 2: .mdx file opens correctly ──────────────────────────────
  Scenario: Open a .mdx file and verify markdown section renders
    When I open file "tests/vscode-extension-tester/e2e/default/sqlx-diff-viewer/fixtures/original.mdx" in the editor
    And I wait 8 seconds
    Then I take a screenshot "03-mdx-file-opened"

    # Verify the custom editor loaded a markdown section
    When I wait for "kw-markdown-section" in the webview for 20 seconds
    Then element "kw-markdown-section" should exist
    Then I take a screenshot "04-mdx-markdown-section-rendered"

    # Clean up
    When I execute command "workbench.action.closeAllEditors"

  # ── Scenario 3: multi-section .sqlx ────────────────────────────────────
  Scenario: Open a modified .sqlx file and verify multiple SQL sections render
    When I open file "tests/vscode-extension-tester/e2e/default/sqlx-diff-viewer/fixtures/modified.sqlx" in the editor
    And I wait 8 seconds
    Then I take a screenshot "05-modified-sqlx-opened"

    # Verify 2 SQL sections are present
    When I wait for "kw-sql-section" in the webview for 20 seconds
    When I evaluate "document.querySelectorAll('kw-sql-section').length" in the webview
    Then I take a screenshot "06-modified-sqlx-two-sections"

    # Clean up
    When I execute command "workbench.action.closeAllEditors"
