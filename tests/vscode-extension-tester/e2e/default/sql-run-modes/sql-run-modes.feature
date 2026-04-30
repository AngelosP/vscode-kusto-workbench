Feature: SQL run modes - split button, plain vs TOP 100

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Run mode defaults to TOP 100, can switch modes, label updates without a SQL connection
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I wait for "kw-sql-section" in the webview for 15 seconds
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.dataset.testSqlConnection !== 'false') throw new Error('Default SQL run-mode test must not have an active connection'); if (el.dataset.testDatabaseSelected !== 'false') throw new Error('Default SQL run-mode test must not have a selected database'); return 'offline SQL section ready'; })()" in the webview
    Then I take a screenshot "01-sql-section-ready"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; const mode = window.getRunMode ? window.getRunMode(boxId) : (window.runModesByBoxId || {})[boxId]; if (mode !== 'top100') throw new Error('Default run mode should be top100, got: ' + mode); return 'default mode = top100'; })()" in the webview

    When I evaluate "(() => { const btn = document.querySelector('kw-sql-section .sql-run-btn'); if (!btn) throw new Error('Run button not found'); const label = btn.querySelector('.run-btn-label')?.textContent?.trim() || btn.textContent?.trim(); if (!label.includes('TOP 100')) throw new Error('Button label should contain TOP 100, got: ' + label); return 'label = ' + label; })()" in the webview
    Then I take a screenshot "02-default-top100"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const toggle = el.querySelector('.unified-btn-split-toggle'); if (!toggle) throw new Error('Split button dropdown toggle not found'); const menu = el.querySelector('.unified-btn-split-menu'); if (!menu) throw new Error('Split button menu not found'); const items = menu.querySelectorAll('.unified-btn-split-menu-item'); if (items.length < 2) throw new Error('Expected at least 2 menu items, found ' + items.length); return 'split button: toggle found, menu with ' + items.length + ' items'; })()" in the webview

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; const toggle = document.getElementById(boxId + '_sql_run_toggle'); if (!toggle) throw new Error('Run-mode toggle not found'); toggle.click(); const menu = document.getElementById(boxId + '_sql_run_menu'); const item = Array.from(menu?.querySelectorAll('[role=menuitem]') || []).find(i => (i.textContent || '').trim() === 'Run Query'); if (!item) throw new Error('Plain Run Query menu item not found'); item.click(); return 'clicked plain run mode'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; const mode = (window.runModesByBoxId || {})[boxId]; if (mode !== 'plain') throw new Error('Mode should be plain, got: ' + mode); const btn = el.querySelector('.sql-run-btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (label.includes('TOP 100')) throw new Error('Label should not contain TOP 100 in plain mode, got: ' + label); return 'plain mode: mode=' + mode + ', label=' + label; })()" in the webview
    Then I take a screenshot "03-plain-mode"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; const toggle = document.getElementById(boxId + '_sql_run_toggle'); if (!toggle) throw new Error('Run-mode toggle not found'); toggle.click(); const menu = document.getElementById(boxId + '_sql_run_menu'); const item = Array.from(menu?.querySelectorAll('[role=menuitem]') || []).find(i => (i.textContent || '').includes('TOP 100')); if (!item) throw new Error('TOP 100 menu item not found'); item.click(); return 'clicked top100 run mode'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.boxId || el.id; const mode = (window.runModesByBoxId || {})[boxId]; if (mode !== 'top100') throw new Error('Mode should be top100, got: ' + mode); const btn = el.querySelector('.sql-run-btn'); const label = btn?.querySelector('.run-btn-label')?.textContent?.trim() || ''; if (!label.includes('TOP 100')) throw new Error('Label should contain TOP 100, got: ' + label); return 'top100 mode: mode=' + mode + ', label=' + label; })()" in the webview
    Then I take a screenshot "04-top100-restored"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.runMode !== 'top100') throw new Error('Serialized runMode should be top100, got: ' + data.runMode); return 'serialized runMode=' + data.runMode; })()" in the webview
    When I execute command "workbench.action.closeAllEditors"
