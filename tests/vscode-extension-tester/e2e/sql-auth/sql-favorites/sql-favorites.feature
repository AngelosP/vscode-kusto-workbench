Feature: SQL favorites — star toggle, mode switch, dropdown

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Add favorite, switch to favorites mode, select, remove
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section[data-test-sql-connection='true']" in the webview for 15 seconds
    When I wait for "kw-sql-section[data-test-databases-loading='false'][data-test-has-databases='true']" in the webview for 30 seconds

    # Select sampledb so we have a valid connection + database for favorites
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const dbs = el._databases || []; const t = dbs.find(d => d.toLowerCase().includes('sample')) || dbs[0]; if (!t) return 'no dbs'; if (el._database !== t) { el.setDatabase(t); el.dispatchEvent(new CustomEvent('sql-database-changed', { detail: { boxId: el.boxId || el.id, database: t }, bubbles: true, composed: true })); } return 'db=' + el._database; })()" in the webview
    When I wait for "kw-sql-section[data-test-database-selected='true']" in the webview for 10 seconds
    Then I take a screenshot "01-setup-ready"

    # ── TEST 1: Star button exists in connection row ──────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const star = el.shadowRoot?.querySelector('.favorite-btn'); if (!star) throw new Error('Favorite star button not found in connection row'); return 'star button found ✓'; })()" in the webview

    # ── TEST 2: Click star to add favorite ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; el.dispatchEvent(new CustomEvent('sql-favorite-toggle', { detail: { boxId, connectionId: el._sqlConnectionId, database: el._database }, bubbles: true, composed: true })); return 'dispatched favorite-toggle for ' + el._database; })()" in the webview
    And I wait 2 seconds

    # Verify favorite was created (check favorites array)
    When I evaluate "(() => { const favs = window.sqlFavorites || []; if (favs.length < 1) throw new Error('Expected at least 1 favorite after toggle, got ' + favs.length); return 'favorites count = ' + favs.length + ' ✓'; })()" in the webview
    Then I take a screenshot "02-favorite-added"

    # ── TEST 3: Switch to favorites mode ──────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.setFavoritesMode(true); return 'favorites mode ON'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (!data.favoritesMode) throw new Error('favoritesMode should be true in serialized data'); return 'favoritesMode serialized = true ✓'; })()" in the webview
    Then I take a screenshot "03-favorites-mode"

    # ── TEST 4: Favorites dropdown has entries ────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const combo = el.shadowRoot?.querySelector('.sql-favorites-combo kw-dropdown'); if (!combo) throw new Error('Favorites dropdown not found in favorites mode'); const items = combo.items || []; if (items.length < 1) throw new Error('Expected at least 1 item in favorites dropdown, got ' + items.length); return 'favorites dropdown: ' + items.length + ' entries ✓'; })()" in the webview

    # ── TEST 5: Switch back to normal mode ────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el.setFavoritesMode(false); return 'favorites mode OFF'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.favoritesMode) throw new Error('favoritesMode should be false after switching back'); return 'normal mode restored ✓'; })()" in the webview
    Then I take a screenshot "04-normal-mode-restored"
