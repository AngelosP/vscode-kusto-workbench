Feature: All section types remain functional

  Background:
    Given the extension is in a clean state
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    When I execute command "kusto.openQueryEditor"
    And I wait for "body[data-kusto-e2e-ready='true']" in the webview "session.kqlx" for 20 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview

  Scenario: Create, validate, and remove every section type
    When I evaluate "window.__e2e.layout.createStressNotebook()" in the webview for 40 seconds
    And I wait 1 second
    When I evaluate "(() => { const tags = ['kw-query-section','kw-sql-section','kw-chart-section','kw-transformation-section','kw-python-section','kw-url-section','kw-html-section','kw-markdown-section']; const missing = tags.filter(tag => !document.querySelector(tag)); if (missing.length) throw new Error('Missing sections: ' + missing.join(', ')); return 'all section types present'; })()" in the webview
    When I evaluate "window.__e2e.layout.assertScrollStability()" in the webview for 20 seconds
    When I evaluate "window.__e2e.layout.exerciseCollapseExpand()" in the webview
    When I evaluate "window.__e2e.layout.exerciseAutoFitAndResize()" in the webview
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I evaluate "(() => { const remaining = document.querySelectorAll('kw-query-section,kw-sql-section,kw-chart-section,kw-transformation-section,kw-python-section,kw-url-section,kw-html-section,kw-markdown-section'); if (remaining.length) throw new Error('Expected no sections after cleanup'); return 'all sections removed'; })()" in the webview
    When I execute command "workbench.action.closeAllEditors"