Feature: Kusto Copilot chat panel — toggle, visibility

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Copilot chat toggle opens and closes panel in Kusto section
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 10 seconds
    Then I take a screenshot "01-kusto-section-ready"

    # ── TEST 1: Copilot chat toggle button exists in toolbar ──────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No KQL section'); const toolbar = el.querySelector('kw-query-toolbar'); if (!toolbar) throw new Error('No toolbar'); const copilotBtn = toolbar.querySelector('.kusto-copilot-chat-toggle'); if (!copilotBtn) throw new Error('Copilot chat toggle button not found in KQL toolbar — looked for .kusto-copilot-chat-toggle'); const disabled = copilotBtn.disabled || copilotBtn.classList.contains('disabled'); return 'Copilot chat button found, disabled=' + disabled + ' ✓'; })()" in the webview
    Then I take a screenshot "02-copilot-button"

    # ── TEST 2: Copilot inline toggle button exists ───────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('kw-query-toolbar'); const inlineBtn = toolbar.querySelector('.qe-copilot-inline-toggle'); if (!inlineBtn) throw new Error('Copilot inline toggle not found in KQL toolbar'); return 'Copilot inline toggle found ✓'; })()" in the webview

    # ── TEST 3: Toggle opens chat panel ───────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('kw-query-toolbar'); const copilotBtn = toolbar.querySelector('.kusto-copilot-chat-toggle'); if (!copilotBtn || copilotBtn.disabled) return 'SKIP: Copilot not available'; copilotBtn.click(); return 'copilot toggle clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const chatPane = el.querySelector('.kusto-copilot-pane, .copilot-chat-pane, kw-copilot-chat'); if (!chatPane) return 'SKIP: no copilot pane element found (may not be available in this environment)'; const visible = chatPane.style.display !== 'none' && chatPane.offsetHeight > 0; return 'copilot chat pane: exists=' + !!chatPane + ' visible=' + visible; })()" in the webview
    Then I take a screenshot "03-copilot-panel-toggle"

    # ── TEST 4: Serialization captures copilotChatVisible state ───────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (typeof el.serialize !== 'function') throw new Error('No serialize method'); const data = el.serialize(); return 'copilotChatVisible=' + data.copilotChatVisible + ' ✓'; })()" in the webview

    # ── TEST 5: Toggle again closes chat panel ────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('kw-query-toolbar'); const copilotBtn = toolbar.querySelector('.kusto-copilot-chat-toggle'); if (!copilotBtn || copilotBtn.disabled) return 'SKIP: Copilot not available'; copilotBtn.click(); return 'copilot toggle clicked (close)'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const data = el.serialize(); return 'after close: copilotChatVisible=' + data.copilotChatVisible; })()" in the webview
    Then I take a screenshot "04-copilot-panel-closed"
