Feature: Cached Values Viewer — UI structure, kind switching, sections

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Cached Values viewer renders with all expected UI elements
    # ── Open the Cached Values viewer ─────────────────────────────────────
    When I execute command "kusto.seeCachedValues"
    And I wait 3 seconds
    Then I take a screenshot "01-cv-opened"

    # All queries go through: const sr = document.querySelector('kw-cached-values')?.shadowRoot

    # ── TEST 1: Title renders ─────────────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; if (!sr) throw new Error('No shadow root'); const h1 = sr.querySelector('[data-testid=cv-title]'); if (!h1?.textContent?.includes('Cached Values')) throw new Error('Title wrong: ' + h1?.textContent); return 'title: ' + h1.textContent.trim(); })()" in the webview
    Then I take a screenshot "02-title-visible"

    # ── TEST 2: Refresh button exists ─────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const btn = sr?.querySelector('[data-testid=cv-refresh]'); if (!btn) throw new Error('Refresh button not found'); return 'refresh button found'; })()" in the webview

    # ── TEST 3: Kind picker exists ────────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cv-kind-picker]'); if (!picker) throw new Error('Kind picker not found'); return 'kind picker found'; })()" in the webview
    Then I take a screenshot "03-kind-picker"

    # ── TEST 4: Kusto content sections render ─────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const sections = sr?.querySelectorAll('section') || []; if (sections.length < 2) throw new Error('Expected 2+ sections, got ' + sections.length); const headers = Array.from(sections).map(s => s.querySelector('header strong')?.textContent || 'no-header'); return 'sections: ' + headers.join(' | '); })()" in the webview
    Then I take a screenshot "04-kusto-sections"

    # ── TEST 5: Auth section ──────────────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const sections = sr?.querySelectorAll('section') || []; const auth = Array.from(sections).find(s => s.querySelector('header strong')?.textContent?.toLowerCase()?.includes('auth')); if (!auth) throw new Error('Auth section not found'); return 'auth section found'; })()" in the webview

    # ── TEST 6: Cluster map section ───────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const sections = sr?.querySelectorAll('section') || []; const clusterMap = Array.from(sections).find(s => s.querySelector('header strong')?.textContent?.toLowerCase()?.includes('cluster')); if (!clusterMap) throw new Error('Cluster map section not found'); return 'cluster map section found'; })()" in the webview

    # ── TEST 7: Databases section with clear button ───────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const sections = sr?.querySelectorAll('section') || []; const dbSection = Array.from(sections).find(s => s.querySelector('header strong')?.textContent?.toLowerCase()?.includes('database')); if (!dbSection) throw new Error('Database section not found'); const clearBtn = dbSection.querySelector('.rowActions button'); return 'databases section, clear button: ' + (clearBtn ? 'present' : 'absent'); })()" in the webview
    Then I take a screenshot "05-databases-section"

    # ── TEST 8: Click Refresh ─────────────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; sr?.querySelector('[data-testid=cv-refresh]')?.click(); return 'clicked refresh'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const txt = sr?.querySelector('.small')?.textContent || ''; if (!txt.includes('Last updated')) throw new Error('No timestamp: ' + txt); return 'timestamp: ' + txt.substring(0, 50); })()" in the webview
    Then I take a screenshot "06-after-refresh"

    # ── TEST 9: Switch to SQL mode ────────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cv-kind-picker]'); const btns = picker?.shadowRoot?.querySelectorAll('button') || []; const sqlBtn = Array.from(btns).find(b => b.textContent.toLowerCase().includes('sql')); if (!sqlBtn) throw new Error('SQL button not found'); sqlBtn.click(); return 'switched to SQL'; })()" in the webview
    And I wait 1 second

    # ── TEST 10: SQL sections render ──────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const sections = sr?.querySelectorAll('section') || []; if (sections.length < 2) throw new Error('Expected SQL sections, got ' + sections.length); const headers = Array.from(sections).map(s => s.querySelector('header strong')?.textContent || 'no-header'); return 'SQL sections: ' + headers.join(' | '); })()" in the webview
    Then I take a screenshot "07-sql-sections"

    # ── TEST 11: Switch back to Kusto ─────────────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const picker = sr?.querySelector('[data-testid=cv-kind-picker]'); const btns = picker?.shadowRoot?.querySelectorAll('button') || []; Array.from(btns).find(b => b.textContent.toLowerCase().includes('kusto'))?.click(); return 'back to Kusto'; })()" in the webview
    And I wait 1 second
    Then I take a screenshot "08-back-to-kusto"

    # ── TEST 12: Object viewer element exists ─────────────────────────────
    When I evaluate "(() => { const sr = document.querySelector('kw-cached-values')?.shadowRoot; const ov = sr?.querySelector('kw-object-viewer'); if (!ov) throw new Error('Object viewer not found'); return 'object viewer present'; })()" in the webview
    Then I take a screenshot "09-final"
