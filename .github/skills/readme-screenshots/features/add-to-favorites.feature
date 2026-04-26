@screenshot-generator
# Screenshot generator for .github/skills/readme-screenshots; behavioral coverage lives in non-readme E2Es.
Feature: Capture add-to-favorites screenshot
  Scenario: Toolbar with favorites star button and tooltip
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
    When I evaluate "const btn = __testQuery('.favorite-btn'); const r = btn.getBoundingClientRect(); const t = document.createElement('div'); t.textContent = 'Add to favorites'; t.style.cssText = 'position:fixed;z-index:999999;background:#3c3c3c;color:#ccc;border:1px solid #555;padding:2px 6px;font-size:12px;font-family:Segoe WPC,Segoe UI,sans-serif;white-space:nowrap;pointer-events:none;left:'+(r.right+4)+'px;top:'+(r.top+Math.round(r.height/2)-10)+'px'; document.body.appendChild(t); 'tooltip injected'" in the webview
    And I wait 1 second
    Then I take a screenshot "01-favorites-tooltip"
