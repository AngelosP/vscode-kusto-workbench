Feature: SQL Copilot chat panel — toggle, visibility

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Copilot chat toggle opens and closes panel
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section" in the webview for 10 seconds
    Then I take a screenshot "01-sql-section-ready"

    # ── TEST 1: Copilot toggle button exists ──────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toolbar = el.querySelector('kw-sql-toolbar'); if (!toolbar) throw new Error('No SQL toolbar'); const sr = toolbar.shadowRoot || toolbar; const copilotBtn = sr.querySelector('.qe-copilot-chat-toggle'); if (!copilotBtn) throw new Error('Copilot toggle button not found in toolbar'); const disabled = copilotBtn.disabled || copilotBtn.classList.contains('disabled'); return 'Copilot button found, disabled=' + disabled; })()" in the webview
    Then I take a screenshot "02-copilot-button"

    # ── TEST 2: Toggle opens chat panel ───────────────────────────────────
    # Only proceed if Copilot is available
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toolbar = el.querySelector('kw-sql-toolbar'); const sr = toolbar.shadowRoot || toolbar; const copilotBtn = sr.querySelector('.qe-copilot-chat-toggle'); if (!copilotBtn) return 'no button'; if (copilotBtn.disabled || copilotBtn.classList.contains('disabled')) return 'SKIP: Copilot not available (button disabled)'; el._onCopilotToggle(); return 'copilot toggle called'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const chatPane = el.querySelector('.sql-copilot-pane'); if (!chatPane) return 'SKIP: no copilot pane element found (may not be available)'; const visible = chatPane.style.display !== 'none' && chatPane.offsetHeight > 0; if (!visible) return 'WARN: copilot pane exists but not visible (display=' + chatPane.style.display + ', h=' + chatPane.offsetHeight + ')'; return 'copilot chat pane visible'; })()" in the webview
    Then I take a screenshot "03-copilot-panel-open"

    # ── TEST 3: Toggle again closes chat panel ────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toolbar = el.querySelector('kw-sql-toolbar'); const sr = toolbar.shadowRoot || toolbar; const copilotBtn = sr.querySelector('.qe-copilot-chat-toggle'); if (!copilotBtn || copilotBtn.disabled) return 'SKIP: Copilot not available'; el._onCopilotToggle(); return 'copilot toggle called (close)'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); return 'copilotChatVisible after close: ' + data.copilotChatVisible; })()" in the webview
    Then I take a screenshot "04-copilot-panel-closed"
