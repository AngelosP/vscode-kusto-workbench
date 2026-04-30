Feature: SQL section lifecycle - add, rename, collapse, expand, remove

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Add, rename, collapse, expand, and remove SQL section without a SQL connection
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds

    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 2 seconds

    When I wait for "button[data-add-kind='sql']" in the webview for 20 seconds
    When I click "button[data-add-kind='sql']" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el) throw new Error('No kw-sql-section found after adding'); if (!el.id || !el.id.startsWith('sql_')) throw new Error('SQL section ID should start with sql_, got: ' + el.id); return 'SQL section added with id=' + el.id; })()" in the webview
    Then I take a screenshot "01-section-added"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const boxId = el.getAttribute('box-id') || el.id; if (!boxId) throw new Error('No box-id attribute'); if (typeof el.serialize !== 'function') throw new Error('Section has no serialize method'); const data = el.serialize(); if (data.type !== 'sql') throw new Error('Expected type=sql, got: ' + data.type); return 'type=sql, boxId=' + boxId; })()" in the webview

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); if (!shell) throw new Error('No section shell found'); const nameInput = shell.shadowRoot?.querySelector('input.section-name'); if (!nameInput) throw new Error('No name input found'); nameInput.value = 'My SQL Test'; nameInput.dispatchEvent(new Event('input', { bubbles: true })); nameInput.dispatchEvent(new Event('change', { bubbles: true })); return 'renamed to My SQL Test'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const data = el.serialize(); if (data.name !== 'My SQL Test') throw new Error('Expected name=My SQL Test, got: ' + data.name); return 'name persisted: ' + data.name; })()" in the webview
    Then I take a screenshot "02-renamed"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); if (!shell) throw new Error('No shell'); const toggleBtn = shell.shadowRoot?.querySelector('.toggle-btn'); if (!toggleBtn) throw new Error('No toggle button'); toggleBtn.click(); return 'clicked collapse'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (!el.classList.contains('is-collapsed')) throw new Error('Section should have is-collapsed class after toggle'); const editorWrapper = el.querySelector('.query-editor-wrapper'); if (editorWrapper && editorWrapper.offsetHeight > 10) throw new Error('Editor wrapper should be hidden when collapsed, height=' + editorWrapper.offsetHeight); return 'collapsed'; })()" in the webview
    Then I take a screenshot "03-collapsed"

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); const shell = el.shadowRoot?.querySelector('kw-section-shell'); const toggleBtn = shell.shadowRoot?.querySelector('.toggle-btn'); toggleBtn.click(); return 'clicked expand'; })()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el.classList.contains('is-collapsed')) throw new Error('Section should not have is-collapsed class after expand'); return 'expanded'; })()" in the webview
    Then I take a screenshot "04-expanded"

    When I evaluate "window.__e2e.workbench.removeSection('kw-sql-section')" in the webview
    And I wait 2 seconds

    When I evaluate "(() => { const el = document.querySelector('kw-sql-section'); if (el) throw new Error('SQL section should be removed from DOM but still found'); return 'section removed'; })()" in the webview
    Then I take a screenshot "05-removed"
