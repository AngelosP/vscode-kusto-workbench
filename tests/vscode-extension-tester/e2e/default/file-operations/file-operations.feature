Feature: File operations — serialization roundtrip and section content

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Create session with sections, verify serialization preserves content
    # ── Setup: create a session with multiple sections ────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Clear existing sections
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    # Add a KQL section with content
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I wait for "kw-query-section .monaco-editor" in the webview for 20 seconds
    When I evaluate "window.__e2e.kusto.setQuery('print message=roundtrip_test')" in the webview
    When I evaluate "window.__e2e.kusto.assertQuery('print message=roundtrip_test')" in the webview

    # Rename the section
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); const nameInput = shell?.shadowRoot?.querySelector('input.section-name'); if (nameInput) { nameInput.value = 'Roundtrip Query'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); nameInput.dispatchEvent(new Event('change', { bubbles: true })); } return 'renamed'; })()" in the webview

    # Add a markdown section
    When I click "button[data-add-kind='markdown']" in the webview
    And I wait 2 seconds

    # Add a chart section
    When I click "button[data-add-kind='chart']" in the webview
    And I wait 2 seconds
    Then I take a screenshot "01-session-with-content"

    # ── TEST 1: Verify session has 3 sections ─────────────────────────────
    When I evaluate "(() => { const kql = document.querySelectorAll('kw-query-section').length; const md = document.querySelectorAll('kw-markdown-section').length; const chart = document.querySelectorAll('kw-chart-section').length; if (kql !== 1) throw new Error('Expected 1 KQL, got ' + kql); if (md !== 1) throw new Error('Expected 1 markdown, got ' + md); if (chart !== 1) throw new Error('Expected 1 chart, got ' + chart); return 'sections: KQL=' + kql + ' MD=' + md + ' Chart=' + chart; })()" in the webview

    # ── TEST 2: Serialization captures all sections correctly ─────────────
    When I evaluate "(() => { const sections = []; document.querySelectorAll('kw-query-section, kw-markdown-section, kw-chart-section, kw-sql-section').forEach(el => { if (typeof el.serialize === 'function') sections.push(el.serialize()); }); if (sections.length < 3) throw new Error('Expected 3 serialized sections, got ' + sections.length); const types = sections.map(s => s.type); if (!types.includes('query')) throw new Error('Missing query'); if (!types.includes('markdown')) throw new Error('Missing markdown'); if (!types.includes('chart')) throw new Error('Missing chart'); const querySection = sections.find(s => s.type === 'query'); if (!querySection.query?.includes('roundtrip')) throw new Error('Query text lost: ' + querySection.query); if (querySection.name !== 'Roundtrip Query') throw new Error('Section name lost: ' + querySection.name); return 'serialization verified: ' + types.join(','); })()" in the webview
    Then I take a screenshot "02-serialization-verified"

    # ── TEST 3: Open a second query editor (new session) ──────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Verify a fresh editor opens with default sections
    When I evaluate "(() => { const sections = document.querySelectorAll('kw-query-section, kw-sql-section, kw-chart-section, kw-markdown-section, kw-transformation-section'); return 'sections in new editor: ' + sections.length; })()" in the webview
    Then I take a screenshot "03-fresh-editor"
