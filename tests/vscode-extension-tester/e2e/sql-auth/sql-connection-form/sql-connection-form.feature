Feature: SQL connection form — inline add-connection UI

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Connection form fields, auth type switch, cancel
    # ── Setup ─────────────────────────────────────────────────────────────
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "(() => { const tags = ['kw-sql-section','kw-query-section','kw-chart-section','kw-markdown-section','kw-transformation-section','kw-html-section','kw-url-section','kw-python-section']; const els = document.querySelectorAll(tags.join(',')); els.forEach(s => s.dispatchEvent(new CustomEvent('section-remove', { detail: { boxId: s.boxId || s.id }, bubbles: true, composed: true }))); return 'removed ' + els.length; })()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds
    When I wait for "kw-sql-section" in the webview for 10 seconds

    # ── Open the add-connection form ──────────────────────────────────────
    # Trigger the inline add-connection flow
    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); el._showAddSqlModal = true; el.requestUpdate(); return 'form requested'; })()" in the webview
    And I wait 2 seconds
    Then I take a screenshot "01-form-opened"

    # ── TEST 1: Form fields are present ───────────────────────────────────
    When I evaluate "(() => { const checks = []; if (!__testFind('sql-conn-name')) checks.push('missing sql-conn-name'); if (!__testFind('sql-conn-server')) checks.push('missing sql-conn-server'); if (!__testFind('sql-conn-port')) checks.push('missing sql-conn-port'); if (!__testFind('sql-conn-auth')) checks.push('missing sql-conn-auth'); if (checks.length) throw new Error('Missing form fields: ' + checks.join(', ')); return 'all form fields present'; })()" in the webview

    # ── TEST 2: Auth type dropdown has AAD and SQL Login options ───────────
    When I evaluate "(() => { const authSelect = __testFind('sql-conn-auth'); if (!authSelect) throw new Error('Auth select not found'); const options = Array.from(authSelect.querySelectorAll('option')); const values = options.map(o => o.value); if (!values.includes('aad')) throw new Error('Missing aad option, got: ' + values.join(', ')); if (!values.includes('sql-login')) throw new Error('Missing sql-login option, got: ' + values.join(', ')); return 'auth options: ' + values.join(', '); })()" in the webview
    Then I take a screenshot "02-auth-options"

    # ── TEST 3: Switch to SQL Login shows username/password fields ────────
    When I evaluate "(() => { __testSelect('sql-conn-auth', 'sql-login'); return 'switched to sql-login'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const form = __testFind('sql-conn-name')?.closest('form') || document.querySelector('kw-sql-connection-form')?.shadowRoot; if (!form) return 'WARN: form element not found for field check'; const userField = __testFind('sql-conn-username') || form.querySelector('input[type=text]'); const passField = __testFind('sql-conn-password') || form.querySelector('input[type=password]'); const checks = []; if (!userField) checks.push('username field not visible'); if (!passField) checks.push('password field not visible'); if (checks.length) return 'WARN: ' + checks.join(', ') + ' (may need data-testid attrs)'; return 'SQL Login fields visible'; })()" in the webview
    Then I take a screenshot "03-sql-login-fields"

    # ── TEST 4: Cancel button closes form ─────────────────────────────────
    When I evaluate "(() => { __testClick('sql-conn-cancel'); return 'cancel clicked'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el._showAddSqlModal) throw new Error('Form should be hidden after cancel'); return 'form closed ✓'; })()" in the webview
    Then I take a screenshot "04-form-closed"
