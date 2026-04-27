Feature: SQL Copilot chat panel — toggle, visibility

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Copilot chat toggle opens and closes panel
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
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
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toolbar = el.querySelector('kw-sql-toolbar'); if (!toolbar) throw new Error('No SQL toolbar'); const sr = toolbar.shadowRoot || toolbar; const copilotBtn = sr.querySelector('.qe-copilot-chat-toggle'); if (!copilotBtn) throw new Error('Copilot toggle button not found'); if (copilotBtn.disabled || copilotBtn.classList.contains('disabled')) throw new Error('Copilot toggle is disabled in sql-auth profile'); copilotBtn.click(); return 'copilot toggle clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const chatPane = el.querySelector('.sql-copilot-pane, kw-copilot-chat'); if (!chatPane) throw new Error('Copilot pane element not found after opening'); const visible = chatPane.style.display !== 'none' && chatPane.offsetHeight > 0; if (!visible) throw new Error('Copilot pane exists but is not visible (display=' + chatPane.style.display + ', h=' + chatPane.offsetHeight + ')'); const data = el.serialize(); if (data.copilotChatVisible !== true) throw new Error('copilotChatVisible should serialize true after opening, got ' + data.copilotChatVisible); return 'copilot chat pane visible'; })()" in the webview
    Then I take a screenshot "03-copilot-panel-open"

    # ── TEST 3: Toggle again closes chat panel ────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toolbar = el.querySelector('kw-sql-toolbar'); if (!toolbar) throw new Error('No SQL toolbar'); const sr = toolbar.shadowRoot || toolbar; const copilotBtn = sr.querySelector('.qe-copilot-chat-toggle'); if (!copilotBtn) throw new Error('Copilot toggle button not found for close'); if (copilotBtn.disabled) throw new Error('Copilot toggle became disabled before close'); copilotBtn.click(); return 'copilot toggle clicked (close)'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.copilotChatVisible !== false) throw new Error('copilotChatVisible should serialize false after close, got ' + data.copilotChatVisible); return 'copilotChatVisible after close: false'; })()" in the webview
    Then I take a screenshot "04-copilot-panel-closed"
    When I execute command "workbench.action.closeAllEditors"
