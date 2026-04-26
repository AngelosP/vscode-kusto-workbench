@screenshot-generator
# Screenshot generator for .github/skills/readme-screenshots; behavioral coverage lives in non-readme E2Es.
Feature: Capture python-sections screenshot
  Scenario: Python section with pandas code and output
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 950 by 2200
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "kusto.openQueryEditor"
    And I wait 10 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    # Remove all existing sections
    When I evaluate "document.querySelectorAll('kw-query-section, kw-transformation-section, kw-chart-section, kw-url-section, kw-python-section, kw-markdown-section').forEach(el => el.remove()); 'cleaned'" in the webview
    And I wait 1 second
    # Add a Python section
    When I evaluate "const id = addPythonBox(); id" in the webview
    And I wait 5 seconds
    # Set section name
    When I evaluate "const py = document.querySelector('kw-python-section'); if (py) { py._title = 'Pandas Sales Analysis'; py.requestUpdate(); 'named'; } else { 'no python section'; }" in the webview
    And I wait 1 second
    # Focus the Python Monaco editor and set code
    When I evaluate "__testFocusMonaco('kw-python-section .monaco-editor')" in the webview
    And I wait 1 second
    When I evaluate "__testSetEditorValue(atob('aW1wb3J0IHBhbmRhcyBhcyBwZAppbXBvcnQgbnVtcHkgYXMgbnAKCiMgLS0tIFNhbXBsZSBEYXRhOiBNb250aGx5IHByb2R1Y3Qgc2FsZXMgYWNyb3NzIHJlZ2lvbnMgLS0tCmRhdGEgPSB7CiAgICAnTW9udGgnOiBbJ0phbicsJ0phbicsJ0phbicsJ0ZlYicsJ0ZlYicsJ0ZlYicsJ01hcicsJ01hcicsJ01hcicsCiAgICAgICAgICAgICAgJ0phbicsJ0phbicsJ0phbicsJ0ZlYicsJ0ZlYicsJ0ZlYicsJ01hcicsJ01hcicsJ01hciddLAogICAgJ1JlZ2lvbic6IFsnTm9ydGgnLCdTb3V0aCcsJ1dlc3QnLCdOb3J0aCcsJ1NvdXRoJywnV2VzdCcsJ05vcnRoJywnU291dGgnLCdXZXN0JywKICAgICAgICAgICAgICAgJ05vcnRoJywnU291dGgnLCdXZXN0JywnTm9ydGgnLCdTb3V0aCcsJ1dlc3QnLCdOb3J0aCcsJ1NvdXRoJywnV2VzdCddLAogICAgJ1Byb2R1Y3QnOiBbJ0FscGhhJywnQWxwaGEnLCdBbHBoYScsJ0FscGhhJywnQWxwaGEnLCdBbHBoYScsJ0FscGhhJywnQWxwaGEnLCdBbHBoYScsCiAgICAgICAgICAgICAgICAnQmV0YScsJ0JldGEnLCdCZXRhJywnQmV0YScsJ0JldGEnLCdCZXRhJywnQmV0YScsJ0JldGEnLCdCZXRhJ10sCiAgICAnVW5pdHMnOiBbMTIwLDk1LDIwMCwxMzUsMTEwLDE4MCwxNTAsMTMwLDIxMCwgODAsNzAsMTUwLDkwLDg1LDE0MCwxMDAsOTUsMTYwXSwKICAgICdSZXZlbnVlJzogWzI0MDAsMTkwMCw0MjAwLDI4MDAsMjMwMCwzNjAwLDMxMDAsMjcwMCw0NjAwLCAxMjAwLDEwNTAsMjcwMCwxNTAwLDEzMjAsMjI1MCwxNjUwLDE1MDAsMjUwMF0KfQpkZiA9IHBkLkRhdGFGcmFtZShkYXRhKQoKIyBQaXZvdDogUmV2ZW51ZSBieSBSZWdpb24gYW5kIFByb2R1Y3QKcGl2b3QgPSBkZi5waXZvdF90YWJsZSh2YWx1ZXM9J1JldmVudWUnLCBpbmRleD0nUmVnaW9uJywKICAgICAgICAgICAgICAgICAgICAgICBjb2x1bW5zPSdQcm9kdWN0JywgYWdnZnVuYz0nc3VtJywgbWFyZ2lucz1UcnVlKQpwcmludChwaXZvdCkKcHJpbnQoKQoKIyBNb250aC1vdmVyLU1vbnRoIFJldmVudWUgR3Jvd3RoICglKQptb250aGx5ID0gZGYucGl2b3RfdGFibGUodmFsdWVzPSdSZXZlbnVlJywgaW5kZXg9J01vbnRoJywKICAgICAgICAgICAgICAgICAgICAgICAgIGNvbHVtbnM9J1Byb2R1Y3QnLCBhZ2dmdW5jPSdzdW0nKQpncm93dGggPSBtb250aGx5LnBjdF9jaGFuZ2UoKSAqIDEwMApwcmludCgiTW9udGgtb3Zlci1Nb250aCBSZXZlbnVlIEdyb3d0aCAoJSkiKQpwcmludChncm93dGgucm91bmQoMSkpCnByaW50KCkKCiMgVG9wIFJlZ2lvbiBwZXIgUHJvZHVjdAp0b3AgPSBkZi5ncm91cGJ5KFsnUHJvZHVjdCcsJ1JlZ2lvbiddKVsnUmV2ZW51ZSddLnN1bSgpLnJlc2V0X2luZGV4KCkKdG9wID0gdG9wLmxvY1t0b3AuZ3JvdXBieSgnUHJvZHVjdCcpWydSZXZlbnVlJ10uaWR4bWF4KCldCnByaW50KCJUb3AgUmVnaW9uIHBlciBQcm9kdWN0IikKcHJpbnQodG9wLnRvX3N0cmluZyhpbmRleD1GYWxzZSkpCnByaW50KCkKCiMgU3VtbWFyeSBTdGF0aXN0aWNzCnByaW50KCJTdW1tYXJ5IFN0YXRpc3RpY3MiKQpwcmludChkZi5ncm91cGJ5KCdQcm9kdWN0JylbWydVbml0cycsJ1JldmVudWUnXV0uZGVzY3JpYmUoKS5yb3VuZCgxKSk='))" in the webview
    And I wait 2 seconds
    # Run the Python code
    When I click ".run-btn" in the webview
    And I wait 15 seconds
    And I press "Ctrl+S"
    And I wait 2 seconds
    Then I take a screenshot "01-python-sections"
