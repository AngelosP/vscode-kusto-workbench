Feature: Capture share screenshot
  Scenario: Toolbar showing the Share button with tooltip
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280 by 800
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "kusto.openQueryEditor"
    And I wait 10 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    When I evaluate "const sec = document.querySelector('kw-query-section'); const toolbar = sec?.querySelector('kw-query-toolbar'); const btn = toolbar?.shadowRoot?.querySelector('button[title*=Share]') || sec?.querySelector('button[title*=Share]'); const r = btn.getBoundingClientRect(); const t = document.createElement('div'); t.innerHTML = '<b>Share query as link (Azure Data Explorer)</b><br>Copies a shareable URL to your clipboard containing the cluster, database and active query'; t.style.cssText = 'position:fixed;z-index:999999;background:#3c3c3c;color:#ccc;border:1px solid #555;padding:4px 8px;font-size:12px;font-family:Segoe WPC,Segoe UI,sans-serif;white-space:nowrap;pointer-events:none;left:'+(r.left)+'px;top:'+(r.bottom+4)+'px'; document.body.appendChild(t); 'tooltip injected'" in the webview
    And I wait 1 second
    When I evaluate "__testSetDropdownText('cluster-dropdown', 'clusterName')" in the webview
    When I evaluate "__testSetDropdownText('database-dropdown', 'databaseName')" in the webview
    And I wait 1 second
    Then I take a screenshot "01-share-tooltip"
