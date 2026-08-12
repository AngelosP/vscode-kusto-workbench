Feature: First-launch setup

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1200 by 900
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "workbench.action.closeAllEditors"
    And I execute command "notifications.clearAll"
    And I execute command "kustoWorkbench.test.resetFirstLaunchSetup"
    And I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    And I wait 1 seconds

  Scenario: Command trigger saves defaults and resumes the original command
    When I start command "kusto.openQueryEditor"
    And I wait 1 second
    And I wait for "kw-first-launch-setup" in the webview for 20 seconds
    And I evaluate "(async () => { const viewer = document.querySelector('kw-first-launch-setup'); if (!viewer) throw new Error('First-launch viewer missing'); const root = viewer.shadowRoot; for (let i = 0; i < 100; i++) { await viewer.updateComplete; if (root.querySelector('[data-testid=first-launch-save]')) break; await new Promise(resolve => setTimeout(resolve, 50)); } const text = root.textContent || ''; for (const expected of ['Welcome to Kusto Workbench', 'Files opened by Workbench', 'Automatic schema completions', 'Copilot inline suggestions', 'Smart documentation (Kusto)', '.kqlx', '.mdx', '.sqlx']) { if (!text.includes(expected)) throw new Error('Missing setup copy: ' + expected); } if (root.querySelectorAll('fieldset').length !== 2) throw new Error('Expected two setup fieldsets'); if (root.querySelectorAll('input[type=checkbox]').length !== 7) throw new Error('Expected seven setup toggles'); if (root.querySelectorAll('.option-icon').length !== 7) throw new Error('Expected shared toolbar/file icons'); const save = root.querySelector('[data-testid=first-launch-save]'); const saveRect = save.getBoundingClientRect(); const footer = root.querySelector('footer'); if (getComputedStyle(footer).position !== 'fixed') throw new Error('Setup command bar is not fixed'); if (saveRect.width < 1 || saveRect.height < 1 || saveRect.bottom > window.innerHeight || saveRect.top < 0) throw new Error('Primary setup action is not visibly inside the viewport'); return 'setup-ready'; })()" in the webview for 20 seconds
    And I evaluate "(async () => { const viewer = document.querySelector('kw-first-launch-setup'); const root = viewer.shadowRoot; const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let logo; let handle; let viewport; for (let i = 0; i < 100; i++) { logo = root.querySelector('.brand-mark img'); handle = document.querySelector('.os-scrollbar-vertical .os-scrollbar-handle'); viewport = document.querySelector('#first-launch-scroll [data-overlayscrollbars-viewport]'); if (logo?.complete && logo.naturalWidth > 0 && handle && viewport && viewport.scrollHeight > viewport.clientHeight) break; await sleep(50); } if (!logo?.src.includes('kusto-workbench-logo.png') || logo.naturalWidth < 1) throw new Error('Workbench logo did not load'); if (!handle || handle.getBoundingClientRect().height < 1) throw new Error('Overlay scrollbar handle missing'); if (getComputedStyle(handle).borderRadius !== '0px') throw new Error('Overlay scrollbar handle is not rectangular'); if (!viewport || getComputedStyle(viewport).scrollbarWidth !== 'none') throw new Error('Native scrollbar was not hidden'); if (viewport.scrollHeight <= viewport.clientHeight) throw new Error('Overlay viewport did not detect initial overflow'); viewport.scrollTop = 120; await new Promise(resolve => requestAnimationFrame(() => resolve())); if (viewport.scrollTop < 1) throw new Error('Overlay viewport could not scroll before a window resize'); viewport.scrollTop = 0; return 'logo-and-scrollbar-ready'; })()" in the webview for 20 seconds
    And I execute command "notifications.clearAll"
    And I click the element "Welcome to Kusto Workbench"
    Then I take a screenshot "01-first-launch-setup"
    When I evaluate "(async () => { const viewer = document.querySelector('kw-first-launch-setup'); const root = viewer.shadowRoot; const set = (id, checked) => { const input = root.querySelector(id); if (!input) throw new Error('Missing ' + id); input.checked = checked; input.dispatchEvent(new Event('change', { bubbles: true })); }; set('#file-openKqlFiles', true); set('#file-openCslFiles', false); set('#file-openMdFiles', true); set('#file-openSqlFiles', true); set('#editing-autoTriggerAutocompleteEnabled', false); set('#editing-copilotInlineCompletionsEnabled', false); set('#editing-caretDocsEnabled', true); await viewer.updateComplete; root.querySelector('[data-testid=first-launch-save]').click(); return 'save-clicked'; })()" in the webview for 20 seconds
    And I wait for "#queries-container" in the webview for 25 seconds
    And I evaluate "(async () => { const addSql = document.querySelector('[data-add-kind=sql]'); if (!addSql) throw new Error('SQL add control missing'); addSql.click(); for (let i = 0; i < 100; i++) { const queryToolbar = document.querySelector('kw-query-toolbar'); const sqlToolbar = document.querySelector('kw-sql-toolbar'); if (queryToolbar && sqlToolbar) { await Promise.all([queryToolbar.updateComplete, sqlToolbar.updateComplete]); const assertToggle = (toolbar, suffix, active) => { const button = toolbar.querySelector('[id$=' + suffix + ']'); if (!button) throw new Error('Missing toggle ' + suffix); if (button.classList.contains('is-active') !== active) throw new Error('Unexpected toggle state for ' + suffix); }; assertToggle(queryToolbar, '_auto_autocomplete_toggle', false); assertToggle(queryToolbar, '_copilot_inline_toggle', false); assertToggle(queryToolbar, '_caret_docs_toggle', true); assertToggle(sqlToolbar, '_auto_autocomplete_toggle', false); assertToggle(sqlToolbar, '_copilot_inline_toggle', false); return 'toolbar-defaults-synchronized'; } await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Kusto and SQL toolbars did not render'); })()" in the webview for 20 seconds
    And I execute command "notifications.clearAll"
    And I click the element "session.kqlx"
    Then I take a screenshot "02-saved-kusto-sql-defaults"

  Scenario: Activity Bar is a first-use trigger and Skip closes setup
    When I execute command "workbench.view.extension.kustoWorkbench"
    And I wait for "kw-first-launch-setup" in the webview for 20 seconds
    And I execute command "notifications.clearAll"
    And I click the element "Welcome to Kusto Workbench"
    And I wait 1 seconds
    Then I take a screenshot "03-activity-bar-trigger"
    When I evaluate "(() => { const viewer = document.querySelector('kw-first-launch-setup'); const button = viewer.shadowRoot.querySelector('[data-testid=first-launch-secondary]'); if (!button || !button.textContent.includes('Skip setup')) throw new Error('Skip setup action missing'); button.click(); return 'skipped'; })()" in the webview
    And I wait 2 seconds
    And I execute command "kusto.openQueryEditor"
    And I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "(() => { if (document.querySelector('kw-first-launch-setup')) throw new Error('Setup reopened after Skip'); return 'skip-persisted'; })()" in the webview

  Scenario: Opening a supported file is a first-use trigger
    When I open file "tests/vscode-extension-tester/e2e/default/first-launch-setup/fixtures/first-launch.kqlx" in the editor
    And I wait for "kw-first-launch-setup" in the webview for 20 seconds
    And I evaluate "(() => { const viewer = document.querySelector('kw-first-launch-setup'); const text = viewer.shadowRoot.textContent || ''; if (!text.includes('Welcome to Kusto Workbench')) throw new Error('Supported file did not trigger setup'); return 'file-triggered'; })()" in the webview
    And I execute command "notifications.clearAll"
    And I click the element "Welcome to Kusto Workbench"
    Then I take a screenshot "04-supported-file-trigger"
    When I evaluate "(() => { const viewer = document.querySelector('kw-first-launch-setup'); viewer.shadowRoot.querySelector('[data-testid=first-launch-secondary]').click(); return 'skipped'; })()" in the webview