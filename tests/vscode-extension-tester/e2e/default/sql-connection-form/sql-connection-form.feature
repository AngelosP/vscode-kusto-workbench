Feature: SQL connection form - inline add-connection UI

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Connection form fields, auth type switch, cancel without saving
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section" in the webview for 10 seconds

    When I evaluate "(async () => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('SQL section not found'); const bannerAdd = __testFind('sql-add-connection'); if (bannerAdd) { bannerAdd.click(); return 'clicked missing-connection add button'; } const serverDropdown = el.shadowRoot?.querySelector('.connection-row kw-dropdown'); if (!serverDropdown) throw new Error('Server dropdown not found'); const btn = serverDropdown.shadowRoot?.querySelector('.kusto-dropdown-btn'); if (!btn) throw new Error('Server dropdown button not found'); btn.click(); await serverDropdown.updateComplete; const action = Array.from(serverDropdown.shadowRoot?.querySelectorAll('.kusto-dropdown-action') || []).find(a => (a.textContent || '').includes('Add new server')); if (!action) throw new Error('Add new server action not found in dropdown'); action.click(); return 'clicked Add new server action'; })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "01-form-opened"

    When I evaluate "(() => { const checks = []; if (!__testFind('sql-conn-name')) checks.push('missing sql-conn-name'); if (!__testFind('sql-conn-server')) checks.push('missing sql-conn-server'); if (!__testFind('sql-conn-port')) checks.push('missing sql-conn-port'); if (!__testFind('sql-conn-auth')) checks.push('missing sql-conn-auth'); if (checks.length) throw new Error('Missing form fields: ' + checks.join(', ')); return 'all form fields present'; })()" in the webview

    When I evaluate "(() => { const authSelect = __testFind('sql-conn-auth'); if (!authSelect) throw new Error('Auth select not found'); const options = Array.from(authSelect.querySelectorAll('option')); const values = options.map(o => o.value); if (!values.includes('aad')) throw new Error('Missing aad option, got: ' + values.join(', ')); if (!values.includes('sql-login')) throw new Error('Missing sql-login option, got: ' + values.join(', ')); return 'auth options: ' + values.join(', '); })()" in the webview
    Then I take a screenshot "02-auth-options"

    When I evaluate "(() => { __testSelect('sql-conn-auth', 'sql-login'); return 'switched to sql-login'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const form = __testFind('sql-conn-name')?.closest('form') || document.querySelector('kw-sql-connection-form')?.shadowRoot; if (!form) throw new Error('Form element not found for SQL login field check'); const userField = __testFind('sql-conn-username') || form.querySelector('input[type=text]'); const passField = __testFind('sql-conn-password') || form.querySelector('input[type=password]'); const checks = []; if (!userField) checks.push('username field not visible'); if (!passField) checks.push('password field not visible'); if (checks.length) throw new Error(checks.join(', ')); return 'SQL Login fields visible'; })()" in the webview
    Then I take a screenshot "03-sql-login-fields"

    When I evaluate "(() => { __testClick('sql-conn-cancel'); return 'cancel clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { if (__testFind('sql-conn-name') || document.querySelector('kw-sql-connection-form')) throw new Error('SQL connection form should be hidden after cancel'); return 'form closed'; })()" in the webview
    Then I take a screenshot "04-form-closed"
    When I execute command "workbench.action.closeAllEditors"
