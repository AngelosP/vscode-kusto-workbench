Feature: SQL favorites — star toggle, mode switch, dropdown

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Add favorite, switch to favorites mode, select, remove
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb so we have a valid connection + database for favorites
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) throw new Error('No SQL databases available'); if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds
    Then I take a screenshot "01-setup-ready"

    # Normalize reusable sql-auth profile state before adding a favorite.
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const matching = (window.sqlFavorites || []).filter(f => f.connectionId === el._sqlConnectionId && String(f.database || '').toLowerCase() === String(el._database || '').toLowerCase()); if (!matching.length) return 'no existing matching favorite'; const star = el.shadowRoot?.querySelector('.favorite-btn'); if (!star) throw new Error('Favorite star button not found for pre-cleanup'); star.click(); return 'removed existing matching favorite'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const remaining = (window.sqlFavorites || []).filter(f => f.connectionId === el._sqlConnectionId && String(f.database || '').toLowerCase() === String(el._database || '').toLowerCase()); if (remaining.length) throw new Error('Pre-cleanup left ' + remaining.length + ' matching favorites'); return 'pre-cleanup verified'; })()" in the webview

    # ── TEST 1: Star button exists in connection row ──────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const star = el.shadowRoot?.querySelector('.favorite-btn'); if (!star) throw new Error('Favorite star button not found in connection row'); return 'star button found ✓'; })()" in the webview

    # ── TEST 2: Click star to add favorite ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const star = el.shadowRoot?.querySelector('.favorite-btn'); if (!star) throw new Error('Favorite star button not found'); star.click(); return 'clicked favorite star for ' + el._database; })()" in the webview
    And I wait 1 second
    When I type "sql-e2e-favorite" into the InputBox
    And I press "Enter"
    And I wait 2 seconds

    # Verify favorite was created (check favorites array)
    When I evaluate "(() => { const favs = window.sqlFavorites || []; const el = document.querySelector('kw-sql-section'); const matching = favs.filter(f => f.connectionId === el._sqlConnectionId && String(f.database || '').toLowerCase() === String(el._database || '').toLowerCase()); if (matching.length !== 1) throw new Error('Expected exactly 1 matching favorite after add, got ' + matching.length + ' of total ' + favs.length); if (matching[0].name !== 'sql-e2e-favorite') throw new Error('Expected favorite name sql-e2e-favorite, got ' + matching[0].name); const star = el.shadowRoot?.querySelector('.favorite-btn'); if (!star?.classList?.contains('favorite-active')) throw new Error('Favorite star should be active after add'); if (!/remove from favorites/i.test(star.title || star.getAttribute('aria-label') || '')) throw new Error('Favorite star should switch to remove state after add'); return 'matching favorite added'; })()" in the webview
    Then I take a screenshot "02-favorite-added"

    # ── TEST 3: Switch to favorites mode ──────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const btn = Array.from(el.shadowRoot?.querySelectorAll('button') || []).find(b => /show favorites/i.test(b.title || b.getAttribute('aria-label') || '')); if (!btn) throw new Error('Favorites-mode button not found'); btn.click(); return 'favorites mode ON via button'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (!data.favoritesMode) throw new Error('favoritesMode should be true in serialized data'); return 'favoritesMode serialized = true ✓'; })()" in the webview
    Then I take a screenshot "03-favorites-mode"

    # ── TEST 4: Favorites dropdown has entries ────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const combo = el.shadowRoot?.querySelector('.sql-favorites-combo kw-dropdown'); if (!combo) throw new Error('Favorites dropdown not found in favorites mode'); const items = combo.items || []; if (items.length < 1) throw new Error('Expected at least 1 item in favorites dropdown, got ' + items.length); return 'favorites dropdown: ' + items.length + ' entries ✓'; })()" in the webview

    # ── TEST 5: Switch back to normal mode ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const btn = Array.from(el.shadowRoot?.querySelectorAll('button') || []).find(b => /show server and database picker/i.test(b.title || b.getAttribute('aria-label') || '')); if (!btn) throw new Error('Server-picker mode button not found'); btn.click(); return 'favorites mode OFF via button'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.favoritesMode) throw new Error('favoritesMode should be false after switching back'); return 'normal mode restored ✓'; })()" in the webview
    Then I take a screenshot "04-normal-mode-restored"

    # ── TEST 6: Remove favorite so reusable sql-auth profile is clean ─────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const matching = (window.sqlFavorites || []).filter(f => f.connectionId === el._sqlConnectionId && String(f.database || '').toLowerCase() === String(el._database || '').toLowerCase()); if (matching.length !== 1) throw new Error('Expected exactly 1 matching favorite before cleanup, got ' + matching.length); const star = el.shadowRoot?.querySelector('.favorite-btn'); if (!star) throw new Error('Favorite star button not found for cleanup'); if (!star.classList.contains('favorite-active')) throw new Error('Favorite star should be active before cleanup'); star.click(); return 'clicked favorite star for cleanup'; })()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const favs = window.sqlFavorites || []; const el = document.querySelector('kw-sql-section'); const remaining = favs.filter(f => f.connectionId === el._sqlConnectionId && String(f.database || '').toLowerCase() === String(el._database || '').toLowerCase()); if (remaining.length) throw new Error('Favorite cleanup left ' + remaining.length + ' matching entries'); const star = el.shadowRoot?.querySelector('.favorite-btn'); if (star?.classList?.contains('favorite-active')) throw new Error('Favorite star should not be active after cleanup'); if (!/add to favorites/i.test(star?.title || star?.getAttribute('aria-label') || '')) throw new Error('Favorite star should return to add state after cleanup'); return 'favorite cleanup verified'; })()" in the webview
    Then I take a screenshot "05-cleaned-up"
    When I execute command "workbench.action.closeAllEditors"
