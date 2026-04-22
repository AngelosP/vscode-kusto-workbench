Feature: KQL companion sidecar — .kql with existing .kql.json skips upgrade prompt

  A .kql file that already has a linked .kql.json companion should open in
  full multi-section mode (compatibilityMode=false). Adding a second section
  must NOT trigger the "Create companion file" upgrade prompt — the section
  should be added directly.

  The fixture directory contains a pre-created sidecar-test.kql.json with
  valid JSON linking back to sidecar-test.kql.

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Open .kql with companion .kql.json and add a section without upgrade prompt

    # ── Setup: ensure the .kql file has content (the .kql.json is pre-created as a fixture)
    Given a file "tests/vscode-extension-tester/e2e/default/kql-companion-sidecar/fixtures/sidecar-test.kql" exists with content "StormEvents | take 10"

    # ── Open the .kql file with the kqlCompat custom editor ───────────
    # Priority is "option", so we open the file first then reopen with custom editor.
    When I open file "tests/vscode-extension-tester/e2e/default/kql-companion-sidecar/fixtures/sidecar-test.kql" in the editor
    And I wait 2 seconds
    When I start command "workbench.action.reopenWithEditor"
    And I wait 1 second
    When I select "Kusto Query (Compatibility Mode)" from the QuickPick
    And I wait 5 seconds
    Then I take a screenshot "01-kql-opened-with-sidecar"

    # ── TEST 1: Verify the query section exists ─────────────────────────
    When I wait for "kw-query-section" in the webview for 10 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No kw-query-section found'); return 'query-section-present'; })()" in the webview

    # ── TEST 2: Verify add-section buttons are visible (sidecar mode) ───
    When I wait for "button[data-add-kind='markdown']" in the webview for 10 seconds
    Then I take a screenshot "02-add-buttons-visible"

    # ── TEST 3: Add a markdown section — should NOT trigger upgrade ─────
    When I click "button[data-add-kind='markdown']" in the webview
    And I wait 3 seconds
    Then I take a screenshot "03-after-add-markdown"

    # ── TEST 4: Verify NO upgrade notification appeared ─────────────────
    Then I should not see notification "companion metadata file"
    And I should not see notification "Create companion file"

    # ── TEST 5: Verify the markdown section was actually added ──────────
    When I evaluate "(() => { const md = document.querySelector('kw-markdown-section'); if (!md) throw new Error('Markdown section was NOT added — expected it to be present after clicking add'); return 'markdown-section-present'; })()" in the webview

    # ── TEST 6: Verify we now have 2 sections total ─────────────────────
    When I evaluate "(() => { const tags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const all = document.querySelectorAll(tags.join(',')); if (all.length !== 2) throw new Error('Expected 2 sections, found ' + all.length); const types = [...all].map(e => e.tagName.toLowerCase()); return 'sections: ' + types.join(', '); })()" in the webview
    Then I take a screenshot "04-two-sections-verified"

    # ── TEST 7: Verify sections serialize correctly (query + markdown) ──
    When I evaluate "(() => { const tags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); const types = [...els].map(el => { try { const s = el.serialize(); return s?.type || 'unknown'; } catch { return 'no-serialize'; } }); if (!types.includes('query')) throw new Error('Missing query section in serialization: ' + types.join(', ')); if (!types.includes('markdown')) throw new Error('Missing markdown section in serialization: ' + types.join(', ')); return 'serialized types: ' + types.join(', '); })()" in the webview
