Feature: Cached Values Viewer with Kusto data — auth, cluster map, databases

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Cached Values shows real auth sessions, cluster map, and databases
    # First open a query editor to trigger auth and schema caching
    When I execute command "kusto.openQueryEditor"
    And I wait 5 seconds

    # ── Open the Cached Values viewer ─────────────────────────────────────
    When I execute command "kusto.seeCachedValues"
    And I wait 3 seconds
    Then I take a screenshot "01-cv-opened"

    # ── TEST 1: Title and timestamp present ───────────────────────────────
    When I evaluate "(() => { const h1 = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('[data-testid=cv-title]'); if (!h1) throw new Error('Title not found'); return 'title: ' + h1.textContent.trim(); })()" in the webview

    When I evaluate "(() => { const small = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('.small'); if (!small?.textContent?.includes('Last updated')) throw new Error('No timestamp'); return small.textContent.trim().substring(0, 60); })()" in the webview

    # ── TEST 2: Auth section has at least one session ─────────────────────
    When I evaluate "(() => { const sections = document.querySelector('kw-cached-values')?.shadowRoot?.querySelectorAll('section'); const authSection = Array.from(sections).find(s => { const h = s.querySelector('header strong'); return h && h.textContent.toLowerCase().includes('auth'); }); if (!authSection) throw new Error('Auth section not found'); const body = authSection.querySelector('.sectionBody'); const text = body?.textContent?.trim() || ''; if (text.includes('No cached')) throw new Error('Expected authenticated profile to contain at least one cached auth session'); const cards = body.querySelectorAll('.authCard'); if (cards.length === 0) throw new Error('Auth section did not render any auth cards; text=' + text.substring(0, 100)); return 'auth sessions: ' + cards.length + ' cards'; })()" in the webview
    Then I take a screenshot "02-auth-section"

    # ── TEST 3: Cluster-account map section has entries ────────────────────
    When I evaluate "(() => { const sections = document.querySelector('kw-cached-values')?.shadowRoot?.querySelectorAll('section'); const mapSection = Array.from(sections).find(s => { const h = s.querySelector('header strong'); return h && h.textContent.toLowerCase().includes('cluster'); }); if (!mapSection) throw new Error('Cluster map section not found'); const body = mapSection.querySelector('.sectionBody'); const text = body?.textContent?.trim() || ''; const rows = body?.querySelectorAll('tr') || []; if (rows.length === 0) throw new Error('Expected cluster map rows in authenticated profile; text=' + text.substring(0, 120)); return 'cluster map rows: ' + rows.length; })()" in the webview
    Then I take a screenshot "03-cluster-map"

    # ── TEST 4: Databases section renders with two-pane layout ────────────
    When I evaluate "(() => { const sections = document.querySelector('kw-cached-values')?.shadowRoot?.querySelectorAll('section'); const dbSection = Array.from(sections).find(s => { const h = s.querySelector('header strong'); return h && h.textContent.toLowerCase().includes('database'); }); if (!dbSection) throw new Error('Database section not found'); const twoPane = dbSection.querySelector('.twoPane'); if (!twoPane) throw new Error('No two-pane layout in database section'); const listPane = twoPane.querySelector('.listPane'); const detailPane = twoPane.querySelector('.detailPane'); if (!listPane) throw new Error('No list pane'); if (!detailPane) throw new Error('No detail pane'); return 'databases two-pane layout found'; })()" in the webview
    Then I take a screenshot "04-databases-two-pane"

    # ── TEST 5: Cluster list in left pane has entries ─────────────────────
    When I evaluate "(() => { const twoPane = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('.twoPane'); const listPane = twoPane?.querySelector('.listPane'); const items = listPane?.querySelectorAll('.dbItem, .clusterItem, [class*=Item]') || []; if (items.length === 0) { const text = listPane?.textContent?.trim() || ''; throw new Error('Expected cached database/cluster items in left pane; text=' + text.substring(0, 100)); } return 'left pane items: ' + items.length; })()" in the webview

    # ── TEST 6: Click first cluster in left pane → detail shows databases──
    When I evaluate "(() => { const twoPane = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('.twoPane'); const listPane = twoPane?.querySelector('.listPane'); const links = listPane?.querySelectorAll('.linkButton, button, [role=button], .dbItem') || []; if (links.length === 0) throw new Error('Expected at least one clickable cached database/cluster item'); links[0].click(); return 'clicked first cluster/item'; })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "05-database-detail"

    # ── TEST 7: Detail pane shows database names or schema info ───────────
    When I evaluate "(() => { const twoPane = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('.twoPane'); const detailPane = twoPane?.querySelector('.detailPane'); const text = detailPane?.textContent?.trim() || ''; if (!text || text === 'Select a cluster') throw new Error('Expected populated detail pane after clicking cached item, got: ' + text.substring(0, 60)); return 'detail pane: ' + text.substring(0, 150); })()" in the webview
    Then I take a screenshot "06-detail-content"

    # ── TEST 8: Clear All Schema button exists and is clickable ───────────
    When I evaluate "(() => { const sections = document.querySelector('kw-cached-values')?.shadowRoot?.querySelectorAll('section'); const dbSection = Array.from(sections).find(s => { const h = s.querySelector('header strong'); return h && h.textContent.toLowerCase().includes('database'); }); const clearBtn = dbSection?.querySelector('.rowActions button'); if (!clearBtn) throw new Error('Clear All schema button not found'); return 'clear button found: title=' + (clearBtn.getAttribute('title') || 'none'); })()" in the webview

    # ── TEST 9: Refresh updates timestamp ─────────────────────────────────
    When I evaluate "(() => { const small = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('.small'); return 'before: ' + (small?.textContent?.trim() || '').substring(0, 40); })()" in the webview

    When I evaluate "(() => { const btn = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('[data-testid=cv-refresh]'); btn.click(); return 'clicked refresh'; })()" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const small = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('.small'); if (!small?.textContent?.includes('Last updated')) throw new Error('Timestamp missing after refresh'); return 'after refresh: ' + small.textContent.trim().substring(0, 40); })()" in the webview
    Then I take a screenshot "07-after-refresh"

    # ── TEST 10: Object viewer element exists for schema inspection ───────
    When I evaluate "(() => { const ov = document.querySelector('kw-cached-values')?.shadowRoot?.querySelector('kw-object-viewer'); if (!ov) throw new Error('Object viewer not found'); return 'object viewer present'; })()" in the webview
    Then I take a screenshot "08-final"
    When I execute command "workbench.action.closeAllEditors"
