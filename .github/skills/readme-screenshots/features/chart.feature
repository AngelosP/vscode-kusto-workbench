Feature: Capture chart screenshot
  Scenario: Bar chart with grouped bars and legend
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 950 by 950
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "kusto.openQueryEditor"
    And I wait 10 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    When I evaluate "document.querySelectorAll('kw-transformation-section, kw-chart-section, kw-url-section, kw-python-section, kw-markdown-section').forEach(el => el.remove()); 'cleaned extras'" in the webview
    And I wait 1 second
    When I evaluate "__testFocusMonaco('kw-query-section .monaco-editor')" in the webview
    And I wait 1 second
    When I evaluate "__testSetEditorValue(atob('ZGF0YXRhYmxlKERheTogZGF0ZXRpbWUsIFRvb2xBcmVhOiBzdHJpbmcsIENvdW50OiBpbnQpClsKICAgIGRhdGV0aW1lKDIwMjYtMDEtMTEpLCAiNjIyOCIsIDEyNSwKICAgIGRhdGV0aW1lKDIwMjYtMDEtMTEpLCAiMzViNyIsIDExNywKICAgIGRhdGV0aW1lKDIwMjYtMDEtMTEpLCAiZTg1NCIsIDUxLAogICAgZGF0ZXRpbWUoMjAyNi0wMS0xMSksICI0MTFmIiwgMjQsCiAgICBkYXRldGltZSgyMDI2LTAxLTExKSwgIjVkMjUiLCAxMiwKICAgIGRhdGV0aW1lKDIwMjYtMDEtMjApLCAiNjIyOCIsIDY5NCwKICAgIGRhdGV0aW1lKDIwMjYtMDEtMjApLCAiMzViNyIsIDM3NiwKICAgIGRhdGV0aW1lKDIwMjYtMDEtMjApLCAiZTg1NCIsIDIyNCwKICAgIGRhdGV0aW1lKDIwMjYtMDEtMjApLCAiNDExZiIsIDEzMywKICAgIGRhdGV0aW1lKDIwMjYtMDEtMjApLCAiNWQyNSIsIDgzLAogICAgZGF0ZXRpbWUoMjAyNi0wMS0yMCksICJPdGhlciIsIDM3NywKICAgIGRhdGV0aW1lKDIwMjYtMDItMjApLCAiNjIyOCIsIDc1OCwKICAgIGRhdGV0aW1lKDIwMjYtMDItMjApLCAiMzViNyIsIDUyNywKICAgIGRhdGV0aW1lKDIwMjYtMDItMjApLCAiZTg1NCIsIDM3OCwKICAgIGRhdGV0aW1lKDIwMjYtMDItMjApLCAiNDExZiIsIDIwMSwKICAgIGRhdGV0aW1lKDIwMjYtMDItMjApLCAiNWQyNSIsIDIyMywKICAgIGRhdGV0aW1lKDIwMjYtMDItMjApLCAiT3RoZXIiLCA2MzYKXQ=='))" in the webview
    And I wait 2 seconds
    When I evaluate "const sec = document.querySelector('kw-query-section'); window.__kustoExecuteQuery ? __kustoExecuteQuery(sec?.boxId) : executeQuery(sec?.boxId); 'running'" in the webview
    And I wait 8 seconds
    When I evaluate "eval(atob('Y29uc3QgcVNlYyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ2t3LXF1ZXJ5LXNlY3Rpb24nKTsgY29uc3QgcUlkID0gcVNlYz8uYm94SWQ7IGNvbnN0IGNJZCA9IGFkZENoYXJ0Qm94KHsgYWZ0ZXJCb3hJZDogcUlkIH0pOyBjb25zdCBjRWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZChjSWQpOyBjRWwuY29uZmlndXJlKHsgZGF0YVNvdXJjZUlkOiBxSWQsIGNoYXJ0VHlwZTogJ2JhcicsIHhDb2x1bW46ICdEYXknLCB5Q29sdW1uOiAnQ291bnQnLCBsZWdlbmRDb2x1bW46ICdUb29sQXJlYScsIGNoYXJ0VGl0bGU6ICdFeGFtcGxlIGNoYXJ0IHRpdGxlJywgY2hhcnRTdWJ0aXRsZTogJ0NoYXJ0IHN1YnRpdGxlIGFzIHdlbGwnLCBzaG93RGF0YUxhYmVsczogdHJ1ZSwgbGFiZWxNb2RlOiAnYWxsJyB9KTsgY0lk'))" in the webview
    And I wait 5 seconds
    When I evaluate "const cSec = document.querySelector('kw-chart-section'); if (cSec) cSec.scrollIntoView({ block: 'start' }); 'scrolled'" in the webview
    And I wait 1 second
    When I evaluate "__testSetDropdownText('cluster-dropdown', 'clusterName')" in the webview
    When I evaluate "__testSetDropdownText('database-dropdown', 'databaseName')" in the webview
    And I press "Ctrl+S"
    And I wait 2 seconds
    Then I take a screenshot "01-chart"
