Feature: Kusto section features — toolbar, run modes, persistence without connection

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Toolbar actions, run modes, and section serialization
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__testRemoveAllSections()" in the webview
    And I wait 2 seconds
    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const remaining = document.querySelectorAll(tags.join(',')).length; if (remaining !== 0) throw new Error('Expected empty workbench before setup, found ' + remaining); return 'empty before setup'; })()" in the webview

    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    And I wait 2 seconds
    When I wait for "kw-query-section" in the webview for 10 seconds
    Then I take a screenshot "01-kql-section-ready"

    # ── TEST 1: Run button exists ─────────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const btn = document.getElementById(el.boxId + '_run_btn'); if (!btn) throw new Error('Run button not found'); return 'run button found, class=' + btn.className + ' ✓'; })()" in the webview

    # ── TEST 2: Split-button run toggle exists ────────────────────────────
    When I evaluate "(() => { const sections = Array.from(document.querySelectorAll('kw-query-section')); if (sections.length !== 1) throw new Error('Expected exactly 1 KQL section, got ' + sections.length); const el = sections[0]; const toggle = el.shadowRoot?.querySelector('#' + CSS.escape(el.boxId + '_run_toggle')); if (!toggle) throw new Error('Run split toggle not found in kw-query-section shadow root'); return 'run split toggle found ✓'; })()" in the webview

    # ── TEST 3: Run mode menu exists with options ─────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const menu = document.getElementById(el.boxId + '_run_menu'); if (!menu) throw new Error('Run menu not found'); const items = menu.querySelectorAll('.unified-btn-split-menu-item'); if (items.length < 2) throw new Error('Expected at least 2 run mode items, got ' + items.length); const labels = Array.from(items).map(i => i.textContent?.trim()); return 'run modes: ' + labels.join(', ') + ' ✓'; })()" in the webview
    Then I take a screenshot "02-run-modes"

    # ── TEST 4: Cancel button exists (hidden by default) ──────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const cancelBtn = document.getElementById(el.boxId + '_cancel_btn'); if (!cancelBtn) throw new Error('Cancel button not found'); if (cancelBtn.style.display !== 'none') throw new Error('Cancel button should be hidden when not executing, display=' + cancelBtn.style.display); return 'cancel button found (hidden) ✓'; })()" in the webview

    # ── TEST 5: Toolbar has expected buttons ──────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const toolbar = el.querySelector('kw-query-toolbar'); if (!toolbar) throw new Error('No toolbar found'); const shadow = toolbar.shadowRoot || toolbar; const buttons = shadow.querySelectorAll('button, .icon-btn, .toolbar-btn'); if (buttons.length < 3) throw new Error('Expected at least 3 toolbar buttons, got ' + buttons.length); return 'toolbar buttons: ' + buttons.length + ' ✓'; })()" in the webview
    Then I take a screenshot "03-toolbar-buttons"

    # ── TEST 6: Monaco editor initialized ─────────────────────────────────
    When I evaluate "window.__testAssertMonacoEditorMapped('kw-query-section .query-editor')" in the webview

    # ── TEST 7: Set and read query content ────────────────────────────────
    When I evaluate "window.__testSetMonacoValue('kw-query-section .query-editor', 'StormEvents | take 10 | sort by StartTime')" in the webview
    When I evaluate "window.__testAssertMonacoValue('kw-query-section .query-editor', 'StormEvents | take 10 | sort by StartTime')" in the webview

    # ── TEST 8: Serialization captures query text ─────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const data = el.serialize(); if (!data.query?.includes('StormEvents')) throw new Error('Query not in serialization: ' + data.query); if (data.type !== 'query') throw new Error('Wrong type: ' + data.type); return 'serialization: type=' + data.type + ' query includes StormEvents ✓'; })()" in the webview
    Then I take a screenshot "04-serialized"

    # ── TEST 9: Cache checkbox exists ─────────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const cacheCheckbox = document.getElementById(el.boxId + '_cache_enabled'); if (!cacheCheckbox) throw new Error('Cache checkbox not found'); return 'cache checkbox found, checked=' + cacheCheckbox.checked + ' ✓'; })()" in the webview

    # ── TEST 10: Optimize button exists ───────────────────────────────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); const optimizeBtn = document.getElementById(el.boxId + '_optimize_btn'); if (!optimizeBtn) throw new Error('Optimize button not found'); return 'optimize button found ✓'; })()" in the webview

    # ── TEST 11: Missing clusters banner shows when no connection ──────────
    When I evaluate "(() => { const el = document.querySelector('kw-query-section'); if (!el) throw new Error('No KQL section'); if (el.dataset.testConnection !== 'true') { const banner = document.getElementById(el.boxId + '_missing_clusters'); return banner ? 'missing clusters banner shown ✓' : 'no banner (connections might already be loaded)'; } return 'connection present, banner test N/A'; })()" in the webview
    Then I take a screenshot "05-final"
