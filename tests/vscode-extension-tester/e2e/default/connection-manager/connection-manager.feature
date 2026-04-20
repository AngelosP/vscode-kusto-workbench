Feature: Connection Manager — UI structure, kind switching, modal, empty state

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Connection Manager renders with all expected UI elements
    # ── Open the Connection Manager ───────────────────────────────────────
    When I execute command "kusto.manageConnections"
    And I wait 3 seconds
    Then I take a screenshot "01-cm-opened"

    # Helper: all queries go through shadow root
    # const sr = document.querySelector('kw-connection-manager')?.shadowRoot

    # ── TEST 1: Title renders ─────────────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; if (!sr) throw new Error('No shadow root'); const h1 = sr.querySelector('h1'); if (!h1?.textContent?.includes('Connection Manager')) throw new Error('Title wrong: ' + h1?.textContent); return 'title: ' + h1.textContent.trim(); })()" in the webview
    Then I take a screenshot "02-title-visible"

    # ── TEST 2: Kind picker with Kusto/SQL tabs ───────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cm-kind-picker]'); if (!picker) throw new Error('Kind picker not found'); return 'kind picker found'; })()" in the webview

    # ── TEST 3: Explorer panel metadata ───────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const panel = sr?.querySelector('[data-testid=cm-explorer-panel]'); if (!panel) throw new Error('Explorer panel not found'); return 'kind=' + panel.dataset.testKind + ' connections=' + panel.dataset.testConnections + ' sql=' + panel.dataset.testSqlConnections; })()" in the webview
    Then I take a screenshot "03-kind-picker"

    # ── TEST 4: Add Connection button ─────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const btn = sr?.querySelector('[data-testid=cm-add-connection]'); if (!btn) throw new Error('Add Connection button not found'); return 'Add connection button: ' + btn.textContent.trim(); })()" in the webview

    # ── TEST 5: Default kind is Kusto ─────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const panel = sr?.querySelector('[data-testid=cm-explorer-panel]'); if (panel?.dataset.testKind !== 'kusto') throw new Error('Expected kusto, got: ' + panel?.dataset.testKind); return 'default kind = kusto'; })()" in the webview

    # ── TEST 6: Empty state when no connections ───────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const panel = sr?.querySelector('[data-testid=cm-explorer-panel]'); const count = parseInt(panel?.dataset.testConnections || '0', 10); if (count === 0) { const empty = sr?.querySelector('[data-testid=cm-empty-state]'); if (!empty) throw new Error('No empty state for 0 connections'); return 'empty state visible'; } return 'has ' + count + ' connections'; })()" in the webview
    Then I take a screenshot "04-empty-or-list"

    # ── TEST 7: Click Add Connection → modal opens ────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-add-connection]')?.click(); return 'clicked add'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const modal = sr?.querySelector('[data-testid=cm-modal-overlay]'); if (!modal) throw new Error('Modal did not open'); const h2 = sr?.querySelector('[data-testid=cm-modal-content] h2'); if (!h2?.textContent?.includes('Add')) throw new Error('Wrong header: ' + h2?.textContent); return 'modal: ' + h2.textContent; })()" in the webview
    Then I take a screenshot "05-modal-open"

    # ── TEST 8: Modal has Kusto form + Cancel + Save ──────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const content = sr?.querySelector('[data-testid=cm-modal-content]'); const footer = content?.querySelector('.modal-footer'); const btns = footer?.querySelectorAll('button') || []; const labels = Array.from(btns).map(b => b.textContent.trim()); if (!labels.some(l => l.includes('Cancel'))) throw new Error('No Cancel'); if (!labels.some(l => l.includes('Save'))) throw new Error('No Save'); const form = content?.querySelector('kw-kusto-connection-form'); if (!form) throw new Error('No Kusto form'); return 'form + Cancel + Save'; })()" in the webview
    Then I take a screenshot "06-modal-form"

    # ── TEST 9: Close modal via Cancel ────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-modal-content] .modal-footer button')?.click(); return 'clicked cancel'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; if (sr?.querySelector('[data-testid=cm-modal-overlay]')) throw new Error('Modal still open'); return 'modal closed'; })()" in the webview
    Then I take a screenshot "07-modal-closed"

    # ── TEST 10: Switch to SQL mode ───────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cm-kind-picker]'); const btns = picker?.shadowRoot?.querySelectorAll('button') || []; const sqlBtn = Array.from(btns).find(b => b.textContent.toLowerCase().includes('sql')); if (!sqlBtn) throw new Error('SQL tab not found'); sqlBtn.click(); return 'clicked SQL'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const kind = sr?.querySelector('[data-testid=cm-explorer-panel]')?.dataset.testKind; if (kind !== 'sql') throw new Error('Expected sql, got: ' + kind); return 'SQL mode active'; })()" in the webview
    Then I take a screenshot "08-sql-mode"

    # ── TEST 11: SQL Add Connection → SQL modal with SQL form ─────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-add-connection]')?.click(); return 'clicked add in SQL mode'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const h2 = sr?.querySelector('[data-testid=cm-modal-content] h2'); if (!h2?.textContent?.includes('SQL')) throw new Error('Not SQL modal: ' + h2?.textContent); const form = sr?.querySelector('[data-testid=cm-modal-content] kw-sql-connection-form'); if (!form) throw new Error('No SQL form'); return 'SQL modal: ' + h2.textContent; })()" in the webview
    Then I take a screenshot "09-sql-modal"

    # Close SQL modal
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; sr?.querySelector('[data-testid=cm-modal-content] .modal-footer button')?.click(); return 'closed'; })()" in the webview
    And I wait 1 second

    # ── TEST 12: Switch back to Kusto ─────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cm-kind-picker]'); const btns = picker?.shadowRoot?.querySelectorAll('button') || []; Array.from(btns).find(b => b.textContent.toLowerCase().includes('kusto'))?.click(); return 'back to Kusto'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; if (sr?.querySelector('[data-testid=cm-explorer-panel]')?.dataset.testKind !== 'kusto') throw new Error('Not Kusto'); return 'Kusto mode restored'; })()" in the webview

    # ── TEST 13: Import/Export buttons in Kusto mode ──────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-connection-manager')?.shadowRoot; const btns = sr?.querySelectorAll('.header-btn') || []; const labels = Array.from(btns).map(b => b.textContent.trim()); if (!labels.some(l => l.includes('Import'))) throw new Error('No Import button'); if (!labels.some(l => l.includes('Export'))) throw new Error('No Export button'); return 'Import + Export visible'; })()" in the webview
    Then I take a screenshot "10-final"
