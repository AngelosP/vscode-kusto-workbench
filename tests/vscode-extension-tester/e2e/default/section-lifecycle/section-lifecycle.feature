Feature: Section lifecycle — add, rename, collapse, expand, remove all section types

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Add, interact with, and remove each section type
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    # Clear all existing sections
    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    # ── TEST 1: Add KQL section ───────────────────────────────────────────
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No kw-query-section found'); return 'KQL section added, boxId=' + (el.boxId || el.id) + ' ✓'; })()" in the webview
    Then I take a screenshot "01-kql-added"

    # ── TEST 2: Rename KQL section ────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); if (!shell) throw new Error('No section shell'); const nameInput = shell.shadowRoot?.querySelector('input.section-name'); if (!nameInput) throw new Error('No name input found'); nameInput.value = 'My KQL Test'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); nameInput.dispatchEvent(new Event('change', { bubbles: true })); return 'renamed ✓'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const data = el.serialize(); if (data.name !== 'My KQL Test') throw new Error('Expected name=My KQL Test, got: ' + data.name); return 'name persisted: ' + data.name + ' ✓'; })()" in the webview

    # ── TEST 3: Collapse and expand KQL section ───────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); const toggleBtn = shell?.shadowRoot?.querySelector('.toggle-btn'); if (!toggleBtn) throw new Error('No toggle button'); toggleBtn.click(); return 'collapsed'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el.classList.contains('is-collapsed')) throw new Error('Should be collapsed'); return 'collapsed ✓'; })()" in the webview
    Then I take a screenshot "02-kql-collapsed"

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); shell?.shadowRoot?.querySelector('.toggle-btn')?.click(); return 'expanded'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (el.classList.contains('is-collapsed')) throw new Error('Should be expanded'); return 'expanded ✓'; })()" in the webview

    # ── TEST 4: Add Chart section ─────────────────────────────────────────
    When I click "button[data-add-kind='chart']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-chart-section'); if (!el) throw new Error('No kw-chart-section found'); return 'Chart section added ✓'; })()" in the webview
    Then I take a screenshot "03-chart-added"

    # ── TEST 5: Add Markdown section ──────────────────────────────────────
    When I click "button[data-add-kind='markdown']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-markdown-section'); if (!el) throw new Error('No kw-markdown-section found'); return 'Markdown section added ✓'; })()" in the webview
    Then I take a screenshot "04-markdown-added"

    # ── TEST 6: Add Transformation section ────────────────────────────────
    When I click "button[data-add-kind='transformation']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-transformation-section'); if (!el) throw new Error('No kw-transformation-section found'); return 'Transformation section added ✓'; })()" in the webview
    Then I take a screenshot "05-transformation-added"

    # ── TEST 7: Add URL section ───────────────────────────────────────────
    When I click "button[data-add-kind='url']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-url-section'); if (!el) throw new Error('No kw-url-section found'); return 'URL section added ✓'; })()" in the webview
    Then I take a screenshot "06-url-added"

    # ── TEST 8: Add HTML section ──────────────────────────────────────────
    When I click "button[data-add-kind='html']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-html-section'); if (!el) throw new Error('No kw-html-section found'); return 'HTML section added ✓'; })()" in the webview
    Then I take a screenshot "07-html-added"

    # ── TEST 9: Add Python section ────────────────────────────────────────
    When I click "button[data-add-kind='python']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-python-section'); if (!el) throw new Error('No kw-python-section found'); return 'Python section added ✓'; })()" in the webview
    Then I take a screenshot "08-python-added"

    # ── TEST 10: Verify section count ─────────────────────────────────────
    When I evaluate "(() => { const tags = ['kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-url-section','kw-html-section','kw-python-section']; let total = 0; const counts = {}; tags.forEach(t => { const c = document.querySelectorAll(t).length; counts[t] = c; total += c; }); if (total !== 7) throw new Error('Expected 7 sections total, got ' + total + ': ' + JSON.stringify(counts)); return 'total sections = ' + total + ' ✓'; })()" in the webview

    # ── TEST 11: Each section serializes with correct type ────────────────
    When I evaluate "(() => { const types = { 'kw-query-section': 'query', 'kw-chart-section': 'chart', 'kw-markdown-section': 'markdown', 'kw-transformation-section': 'transformation', 'kw-url-section': 'url', 'kw-html-section': 'html', 'kw-python-section': 'python' }; const errors = []; Object.entries(types).forEach(([tag, expectedType]) => { const el = document.querySelector(tag); if (!el) { errors.push(tag + ': not found'); return; } if (typeof el.serialize !== 'function') { errors.push(tag + ': no serialize method'); return; } const data = el.serialize(); if (data.type !== expectedType) { errors.push(tag + ': expected type=' + expectedType + ', got=' + data.type); } }); if (errors.length) throw new Error(errors.join('; ')); return 'all section types correct ✓'; })()" in the webview
    Then I take a screenshot "09-all-types-verified"

    # ── TEST 12: Remove all sections one by one ───────────────────────────
    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const tags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const remaining = tags.map(t => ({ tag: t, count: document.querySelectorAll(t).length })).filter(x => x.count > 0); if (remaining.length > 0) throw new Error('Sections still present: ' + JSON.stringify(remaining)); return 'all sections removed ✓'; })()" in the webview
    Then I take a screenshot "10-all-removed"
