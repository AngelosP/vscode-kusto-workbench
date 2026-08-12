Feature: Mixed .kqlx document restore

  Verifies that a .kqlx document containing Kusto, Markdown, HTML, and SQL
  sections is saved and reopened through the real custom editor without losing
  section order or section content.

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280x1000
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Save and reopen a mixed document
    Given a file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" exists with content:
      """
      {"kind":"kqlx","version":1,"state":{"sections":[{"id":"query_e2e_kusto","type":"query","name":"Before Kusto","query":"print before_kusto=1","expanded":true},{"id":"markdown_e2e_notes","type":"markdown","title":"Before Markdown","text":"# Before markdown","mode":"markdown","expanded":true},{"id":"html_e2e_dashboard","type":"html","name":"Before HTML","code":"<main>Before HTML</main>","mode":"preview","expanded":true,"previewHeightPx":180},{"id":"sql_e2e_query","type":"sql","name":"Before SQL","query":"SELECT 0 AS before_sql;","serverUrl":"localhost","database":"master","expanded":true,"runMode":"take100"}]}}
      """

    When I open file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    And I wait for "kw-query-section" in the webview for 20 seconds

    When I evaluate "window.__e2e.workbench.beginDocumentCommandCapture()" in the webview
    When I evaluate "(() => { const nl = String.fromCharCode(10); const kustoQuery = 'StormEvents | take 5' + nl + '// e2e_kusto_restore_marker'; const markdownText = '# Markdown Restore' + nl + 'Visible markdown marker'; const htmlCode = '<section style=\'background:#ffffff;color:#111111;padding:18px;font-family:Arial,sans-serif\'><h1 style=\'margin:0 0 8px;font-size:28px;color:#111111\'>HTML Restore Marker</h1><p style=\'margin:0;font-size:18px;color:#111111\' data-kw-bind=\'total\'>HTML preview body</p></section>'; const query = document.getElementById('query_e2e_kusto'); const markdown = document.getElementById('markdown_e2e_notes'); const html = document.getElementById('html_e2e_dashboard'); const sql = document.getElementById('sql_e2e_query'); const queryEditor = window.queryEditors?.query_e2e_kusto; if (!query || !markdown || !html || !sql || !queryEditor) throw new Error('Mixed fixture did not restore all section owners'); query.setName('Kusto Restore'); queryEditor.setValue(kustoQuery); markdown.setName('Markdown Restore'); markdown.setText(markdownText); markdown.setMarkdownMode('preview'); markdown.setExpanded(true); markdown.commitDocumentState(); html.setName('HTML Restore'); html.setCode(htmlCode); html.setMode('preview'); html.setExpanded(true); html.commitDocumentState(); sql.setName('SQL Restore'); sql.setQuery('SELECT 7 AS sql_restore_marker;'); sql.setDesiredServerUrl('localhost'); sql.setDesiredDatabase('master'); return 'mutated mixed sections'; })()" in the webview
    And I wait 5 seconds
    Then I collect JSON artifact "mixed-document-command-settlement" from webview expression "window.__e2e.workbench.waitForDocumentCommands(2, 15000)"

    When I evaluate "(() => { const toggle = document.getElementById('sql_e2e_query_sql_run_toggle'); if (!toggle) throw new Error('SQL run-mode toggle not found for mixed document section'); toggle.click(); const menu = document.getElementById('sql_e2e_query_sql_run_menu'); const plain = Array.from(menu?.querySelectorAll('[role=menuitem]') || []).find(item => (item.textContent || '').trim() === 'Run Query'); if (!plain) throw new Error('Plain Run Query item not found for mixed document section'); plain.click(); return 'populated mixed document'; })()" in the webview
    And I wait 4 seconds
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "01-populated-mixed-document"

    When I evaluate "(() => { const nl = String.fromCharCode(10); const slashN = String.fromCharCode(92) + 'n'; const tags = ['kw-query-section','kw-markdown-section','kw-html-section','kw-sql-section']; const expectedIds = ['query_e2e_kusto','markdown_e2e_notes','html_e2e_dashboard','sql_e2e_query']; const allIds = Array.from(document.querySelectorAll(tags.join(','))).map((el) => el.id); if (allIds.join('|') !== expectedIds.join('|')) throw new Error('Unexpected visible section ids before save: ' + allIds.join(', ')); const directIds = Array.from(document.querySelector('#queries-container').children).filter((el) => tags.includes(el.tagName.toLowerCase())).map((el) => el.id); if (directIds.join('|') !== expectedIds.join('|')) throw new Error('Unexpected persisted DOM order before save: ' + directIds.join(', ')); const query = document.getElementById('query_e2e_kusto').serialize(); const markdown = document.getElementById('markdown_e2e_notes').serialize(); const html = document.getElementById('html_e2e_dashboard').serialize(); const sql = document.getElementById('sql_e2e_query').serialize(); const errors = []; if (!query.query.includes('take 5' + nl + '// e2e_kusto_restore_marker')) errors.push('Kusto query missing real newline marker'); if (query.query.includes(slashN)) errors.push('Kusto query contains literal backslash-n'); if (!markdown.text.includes('Markdown Restore' + nl + 'Visible markdown marker')) errors.push('Markdown text missing real newline marker'); if (markdown.text.includes(slashN)) errors.push('Markdown text contains literal backslash-n'); if (markdown.mode !== 'preview') errors.push('Markdown mode=' + markdown.mode); if (!html.code.includes('HTML Restore Marker')) errors.push('HTML code missing marker'); if (!html.code.includes('HTML preview body')) errors.push('HTML body missing marker'); if (html.mode !== 'preview') errors.push('HTML mode=' + html.mode); if (!sql.query.includes('sql_restore_marker')) errors.push('SQL query missing marker'); if (sql.runMode !== 'plain') errors.push('SQL runMode=' + sql.runMode); if (errors.length) throw new Error(errors.join('; ')); return 'pre-save mixed document verified'; })()" in the webview

    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    Then the file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" should contain "e2e_kusto_restore_marker"
    Then the file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" should contain "Visible markdown marker"
    Then the file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" should contain "HTML Restore Marker"
    Then the file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" should contain "sql_restore_marker"

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-sql-section" in the webview for 20 seconds
    And I wait 4 seconds
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "02-reopened-mixed-document"

    When I evaluate "(() => { const nl = String.fromCharCode(10); const slashN = String.fromCharCode(92) + 'n'; const tags = ['kw-query-section','kw-markdown-section','kw-html-section','kw-sql-section']; const expectedIds = ['query_e2e_kusto','markdown_e2e_notes','html_e2e_dashboard','sql_e2e_query']; const allIds = Array.from(document.querySelectorAll(tags.join(','))).map((el) => el.id); if (allIds.join('|') !== expectedIds.join('|')) throw new Error('Unexpected visible section ids after reopen: ' + allIds.join(', ')); const directIds = Array.from(document.querySelector('#queries-container').children).filter((el) => tags.includes(el.tagName.toLowerCase())).map((el) => el.id); if (directIds.join('|') !== expectedIds.join('|')) throw new Error('Unexpected persisted DOM order after reopen: ' + directIds.join(', ')); const queryEl = document.getElementById('query_e2e_kusto'); const markdownEl = document.getElementById('markdown_e2e_notes'); const htmlEl = document.getElementById('html_e2e_dashboard'); const sqlEl = document.getElementById('sql_e2e_query'); if (!queryEl || !markdownEl || !htmlEl || !sqlEl) throw new Error('Missing one or more mixed sections after reopen'); const query = queryEl.serialize(); const markdown = markdownEl.serialize(); const html = htmlEl.serialize(); const sql = sqlEl.serialize(); const iframe = htmlEl.shadowRoot && htmlEl.shadowRoot.querySelector('iframe.preview-iframe'); const errors = []; if (query.name !== 'Kusto Restore') errors.push('Kusto name=' + query.name); if (!query.query.includes('take 5' + nl + '// e2e_kusto_restore_marker')) errors.push('Kusto query missing real newline marker'); if (query.query.includes(slashN)) errors.push('Kusto query contains literal backslash-n'); if (markdown.title !== 'Markdown Restore') errors.push('Markdown title=' + markdown.title); if (!markdown.text.includes('Markdown Restore' + nl + 'Visible markdown marker')) errors.push('Markdown text missing real newline marker'); if (markdown.text.includes(slashN)) errors.push('Markdown text contains literal backslash-n'); if (markdown.mode !== 'preview') errors.push('Markdown mode=' + markdown.mode); if (html.name !== 'HTML Restore') errors.push('HTML name=' + html.name); if (!html.code.includes('HTML Restore Marker')) errors.push('HTML code missing marker'); if (!html.code.includes('HTML preview body')) errors.push('HTML body missing marker'); if (html.mode !== 'preview') errors.push('HTML mode=' + html.mode); if (!iframe) errors.push('HTML preview iframe missing'); if (iframe && !String(iframe.srcdoc || '').includes('HTML Restore Marker')) errors.push('HTML preview iframe missing marker'); if (iframe && !String(iframe.srcdoc || '').includes('HTML preview body')) errors.push('HTML preview iframe missing body marker'); if (sql.name !== 'SQL Restore') errors.push('SQL name=' + sql.name); if (!sql.query.includes('sql_restore_marker')) errors.push('SQL query missing marker'); if (sql.runMode !== 'plain') errors.push('SQL runMode=' + sql.runMode); if (errors.length) throw new Error(errors.join('; ')); return 'reopened mixed document verified'; })()" in the webview

    When I scroll "kw-html-section" into view
    And I wait 1 second
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "03-reopened-html-preview"

    When I scroll "kw-sql-section" into view
    And I wait 1 second
    When I execute command "workbench.action.focusActiveEditorGroup"
    And I move the mouse to 30, 700
    And I click
    Then I take a screenshot "04-reopened-sql-section"

    When I delete file "tests/vscode-extension-tester/runs/default/mixed-document-restore/workfile.kqlx"
