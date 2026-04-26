Feature: Kusto Copilot chat panel — toggle, visibility

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Copilot chat toggle opens and closes panel in Kusto section
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
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
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No KQL section'); const toolbar = el.querySelector('kw-query-toolbar'); if (!toolbar) throw new Error('No KQL toolbar'); const copilotBtn = toolbar.querySelector('.kusto-copilot-chat-toggle'); if (!copilotBtn) throw new Error('Copilot chat toggle not found'); if (copilotBtn.disabled) throw new Error('Copilot chat toggle is disabled in kusto-auth profile'); copilotBtn.click(); return 'copilot toggle clicked'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const chatPane = el.querySelector('.kusto-copilot-pane, .copilot-chat-pane, kw-copilot-chat'); if (!chatPane) throw new Error('Copilot pane element not found after opening'); const visible = chatPane.style.display !== 'none' && chatPane.offsetHeight > 0; if (!visible) throw new Error('Copilot pane exists but is not visible'); const data = el.serialize(); if (data.copilotChatVisible !== true) throw new Error('copilotChatVisible should serialize true after opening, got ' + data.copilotChatVisible); return 'copilot chat pane visible'; })()" in the webview
    Then I take a screenshot "03-copilot-panel-toggle"

    # ── TEST 4: Serialization captures copilotChatVisible state ───────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (typeof el.serialize !== 'function') throw new Error('No serialize method'); const data = el.serialize(); if (data.copilotChatVisible !== true) throw new Error('Expected copilotChatVisible=true while panel is open, got ' + data.copilotChatVisible); return 'copilotChatVisible=true'; })()" in the webview

    # ── TEST 5: Toggle again closes chat panel ────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('kw-query-toolbar'); if (!toolbar) throw new Error('No KQL toolbar'); const copilotBtn = toolbar.querySelector('.kusto-copilot-chat-toggle'); if (!copilotBtn) throw new Error('Copilot chat toggle not found for close'); if (copilotBtn.disabled) throw new Error('Copilot chat toggle became disabled before close'); copilotBtn.click(); return 'copilot toggle clicked (close)'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const data = el.serialize(); if (data.copilotChatVisible !== false) throw new Error('Expected copilotChatVisible=false after close, got ' + data.copilotChatVisible); return 'after close: copilotChatVisible=false'; })()" in the webview
    Then I take a screenshot "04-copilot-panel-closed"
    When I execute command "workbench.action.closeAllEditors"
