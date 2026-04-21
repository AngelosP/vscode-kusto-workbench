Feature: Capture prettify screenshot
  Scenario: Toolbar showing the Prettify button with tooltip
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1280 by 800
    And I execute command "kusto.openQueryEditor"
    And I wait 5 seconds
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 1 second
    And I type " "
    And I press "Ctrl+S"
    And I wait 2 seconds
    When I evaluate "const sec = document.querySelector('kw-query-section'); const toolbar = sec?.querySelector('kw-query-toolbar'); const btn = toolbar?.shadowRoot?.querySelector('button[title*=Prettify]') || sec?.querySelector('button[title*=Prettify]'); const r = btn.getBoundingClientRect(); const t = document.createElement('div'); t.innerHTML = '<b>Prettify query</b><br>Applies Kusto-aware formatting rules (summarize/where/function headers)'; t.style.cssText = 'position:fixed;z-index:999999;background:#3c3c3c;color:#ccc;border:1px solid #555;padding:4px 8px;font-size:12px;font-family:Segoe WPC,Segoe UI,sans-serif;white-space:nowrap;pointer-events:none;left:'+(r.left)+'px;top:'+(r.bottom+4)+'px'; document.body.appendChild(t); 'tooltip injected'" in the webview
    And I wait 1 second
    Then I take a screenshot "01-prettify-tooltip"
