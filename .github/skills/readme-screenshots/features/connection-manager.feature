Feature: Capture connection-manager screenshot
  Scenario: Connection Manager with schema browser and expanded function
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 800 by 900
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.toggleActivityBarVisibility"
    And I execute command "kusto.manageConnections"
    And I wait 10 seconds
    And I execute command "workbench.action.closeSidebar"
    And I wait 1 second
    # Navigate to cluster > DevCli > Functions
    When I evaluate "const cm = document.querySelector('kw-connection-manager'); const snap = cm?._snapshot; const conn = snap?.connections?.find(c => c.clusterUrl?.includes('ddazureclients')); if (!conn) { 'no conn'; } else { cm._explorerPath = { connectionId: conn.id, database: 'DevCli', section: 'functions' }; cm._vscode.postMessage({ type: 'cluster.expand', connectionId: conn.id }); cm._vscode.postMessage({ type: 'database.refreshSchema', clusterUrl: conn.clusterUrl, database: 'DevCli', source: 'nav' }); cm.requestUpdate(); 'navigated'; }" in the webview "Connection Manager"
    And I wait 15 seconds
    # Click first function chevron to expand
    When I click ".explorer-list-item-chevron" in the webview "Connection Manager"
    And I wait 2 seconds
    # Mask all sensitive data (base64 to avoid escaping issues)
    When I evaluate "eval(atob('Y29uc3QgcmVuYW1lcyA9IHsnQXpkJzonQW5hbHl0aWNzJywnRGV2RGl2RGF0YVxcUm93TGV2ZWxTZWN1cml0eSc6J1NlY3VyaXR5XFxBY2Nlc3NDb250cm9sJywnS3VzdG9Db21wbGV0ZW5lc3MnOidEYXRhUXVhbGl0eScsJ01vbml0b3JlZEV4dGVuc2lvbnMnOidNb25pdG9yaW5nJywnU2NyYXBlcic6J0luZ2VzdGlvbid9Owpjb25zdCB3YWxrID0gKG4pID0+IHsKICBpZiAobi5ub2RlVHlwZSA9PT0gMykgewogICAgbGV0IHQgPSBuLnRleHRDb250ZW50OwogICAgdCA9IHQucmVwbGFjZSgvRGRhenVyZWNsaWVudHMvZywnY2x1c3Rlck5hbWUnKS5yZXBsYWNlKC9kZGF6dXJlY2xpZW50cy9nLCdjbHVzdGVyTmFtZScpOwogICAgdCA9IHQucmVwbGFjZSgvXGJEZXZDbGlcYi9nLCdkYXRhYmFzZU5hbWUnKS5yZXBsYWNlKC9cYkFEU1xiL2csJ2RhdGFiYXNlTmFtZScpOwogICAgdCA9IHQucmVwbGFjZSgvW2EtekEtWjAtOS5fJSstXStAbWljcm9zb2Z0XC5jb20vZywndGVhbUBjb250b3NvLmNvbScpOwogICAgZm9yIChjb25zdCBbayx2XSBvZiBPYmplY3QuZW50cmllcyhyZW5hbWVzKSkgdCA9IHQuc3BsaXQoaykuam9pbih2KTsKICAgIG4udGV4dENvbnRlbnQgPSB0OwogIH0KICBpZiAobi5zaGFkb3dSb290KSBmb3IgKGNvbnN0IGMgb2Ygbi5zaGFkb3dSb290LmNoaWxkTm9kZXMpIHdhbGsoYyk7CiAgZm9yIChjb25zdCBjIG9mIG4uY2hpbGROb2Rlcykgd2FsayhjKTsKfTsKd2Fsayhkb2N1bWVudC5ib2R5KTsKJ21hc2tlZCc='))" in the webview "Connection Manager"
    And I wait 1 second
    Then I take a screenshot "01-connection-manager"
