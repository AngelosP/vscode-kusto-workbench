@screenshot-generator
# Screenshot generator for .github/skills/readme-screenshots; behavioral coverage lives in non-readme E2Es.
Feature: Capture transformation screenshot
  Scenario: Transformation section in Calculate mode with derived column
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 850 by 950
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
    When I evaluate "__testSetEditorValue(atob('ZGF0YXRhYmxlKERheTogZGF0ZXRpbWUsIFVzZXJUeXBlOiBzdHJpbmcsIFVzZXJzOiBpbnQsIFNlc3Npb25zOiBpbnQpClsKICAgIGRhdGV0aW1lKDIwMjYtMDMtMjgpLCAiRXh0ZXJuYWwiLCAxMTQxLCAxMjY5LAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yOCksICJJbnRlcm5hbCIsIDQwNCwgNDIyLAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yNyksICJFeHRlcm5hbCIsIDM2NTksIDM2MjcsCiAgICBkYXRldGltZSgyMDI2LTAzLTI3KSwgIkludGVybmFsIiwgMTU4OCwgMTY1OSwKICAgIGRhdGV0aW1lKDIwMjYtMDMtMjYpLCAiRXh0ZXJuYWwiLCAzOTE0LCAzOTExLAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yNiksICJJbnRlcm5hbCIsIDE2OTMsIDE4MDksCiAgICBkYXRldGltZSgyMDI2LTAzLTI1KSwgIkV4dGVybmFsIiwgNDAwOCwgMzk2OSwKICAgIGRhdGV0aW1lKDIwMjYtMDMtMjUpLCAiSW50ZXJuYWwiLCAxNzE1LCAxODEwLAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yNCksICJFeHRlcm5hbCIsIDM1MjEsIDM0ODgsCiAgICBkYXRldGltZSgyMDI2LTAzLTI0KSwgIkludGVybmFsIiwgMTQ4OSwgMTU2NywKICAgIGRhdGV0aW1lKDIwMjYtMDMtMjMpLCAiRXh0ZXJuYWwiLCAyODcxLCAyODMwLAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yMyksICJJbnRlcm5hbCIsIDEyMDUsIDEyODksCiAgICBkYXRldGltZSgyMDI2LTAzLTIyKSwgIkV4dGVybmFsIiwgMjY1NSwgMjYwMSwKICAgIGRhdGV0aW1lKDIwMjYtMDMtMjIpLCAiSW50ZXJuYWwiLCAxMTAyLCAxMTc3LAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yMSksICJFeHRlcm5hbCIsIDM4NDQsIDM3OTksCiAgICBkYXRldGltZSgyMDI2LTAzLTIxKSwgIkludGVybmFsIiwgMTYyMiwgMTcxMCwKICAgIGRhdGV0aW1lKDIwMjYtMDMtMjApLCAiRXh0ZXJuYWwiLCAzNzAyLCAzNjg4LAogICAgZGF0ZXRpbWUoMjAyNi0wMy0yMCksICJJbnRlcm5hbCIsIDE1NDQsIDE2MzQKXQ=='))" in the webview
    And I wait 2 seconds
    When I evaluate "const sec = document.querySelector('kw-query-section'); window.__kustoExecuteQuery ? __kustoExecuteQuery(sec?.boxId) : executeQuery(sec?.boxId); 'running'" in the webview
    And I wait 8 seconds
    When I evaluate "eval(atob('Y29uc3QgcVNlYyA9IGRvY3VtZW50LnF1ZXJ5U2VsZWN0b3IoJ2t3LXF1ZXJ5LXNlY3Rpb24nKTsgY29uc3QgcUlkID0gcVNlYz8uYm94SWQ7IGNvbnN0IHRJZCA9IGFkZFRyYW5zZm9ybWF0aW9uQm94KHsgYWZ0ZXJCb3hJZDogcUlkIH0pOyBjb25zdCB0RWwgPSBkb2N1bWVudC5nZXRFbGVtZW50QnlJZCh0SWQpOyB0RWwuY29uZmlndXJlKHsgZGF0YVNvdXJjZUlkOiBxSWQsIHRyYW5zZm9ybWF0aW9uVHlwZTogJ2Rlcml2ZScsIGRlcml2ZUNvbHVtbnM6IFt7IG5hbWU6ICdVc2Vyc1BlclNlc3Npb24nLCBleHByZXNzaW9uOiAnUm91bmQoVXNlcnMgLyBTZXNzaW9ucywgMikgKyAiJSInIH1dIH0pOyB0SWQ='))" in the webview
    And I wait 3 seconds
    When I evaluate "const tSec = document.querySelector('kw-transformation-section'); if (tSec) tSec.scrollIntoView({ block: 'start' }); 'scrolled'" in the webview
    And I wait 1 second
    When I evaluate "__testSetDropdownText('cluster-dropdown', 'clusterName')" in the webview
    When I evaluate "__testSetDropdownText('database-dropdown', 'databaseName')" in the webview
    And I press "Ctrl+S"
    And I wait 2 seconds
    Then I take a screenshot "01-transformation"
