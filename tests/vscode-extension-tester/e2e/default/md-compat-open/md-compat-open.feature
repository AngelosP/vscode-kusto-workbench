Feature: Markdown compatibility editor file open

  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"
    And I capture the output channel "Log (Extension Host)"
    And I wait 2 seconds

  Scenario: Reopen With activates the Kusto Markdown custom editor on a cold markdown file
    When I open file "CHANGELOG.md" in the editor
    And I wait 1 second
    When I start command "workbench.action.reopenWithEditor"
    And I wait 2 seconds
    And I select "Kusto Markdown (.md)" from the popup menu
    When I wait for "kw-markdown-section" in the webview for 30 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-markdown-section'); if (!section) throw new Error('Cold Reopen With markdown section did not render'); const text = String(section.text || section.getAttribute('text') || section.serialize?.()?.text || ''); if (!text.includes('Changelog') && !text.includes('CHANGELOG')) throw new Error('Cold Reopen With section missing CHANGELOG content: ' + text.slice(0, 120)); return 'cold reopen loaded CHANGELOG with ' + text.length + ' chars'; })()" in the webview for 10 seconds
    When I execute command "workbench.action.closeAllEditors"

  Scenario: A real .md file opens in the Kusto Markdown compatibility editor
    When I execute command "kustoWorkbench.test.openMdCompatFile" with args '["CHANGELOG.md"]'
    When I wait for "kw-markdown-section" in the webview for 30 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-markdown-section'); if (!section) throw new Error('Markdown compat section did not render'); const text = String(section.text || section.getAttribute('text') || section.serialize?.()?.text || ''); if (!text.includes('Changelog') && !text.includes('CHANGELOG')) throw new Error('Markdown compat section missing CHANGELOG content: ' + text.slice(0, 120)); return 'md compat loaded CHANGELOG with ' + text.length + ' chars'; })()" in the webview for 10 seconds
    When I execute command "workbench.action.closeAllEditors"

  Scenario: A real .md file opens through the markdown editor association
    When I execute command "kustoWorkbench.test.openMdCompatFileViaAssociation" with args '["CHANGELOG.md"]'
    When I wait for "kw-markdown-section" in the webview for 30 seconds
    When I evaluate "(() => { const section = document.querySelector('kw-markdown-section'); if (!section) throw new Error('Markdown association section did not render'); const text = String(section.text || section.getAttribute('text') || section.serialize?.()?.text || ''); if (!text.includes('Changelog') && !text.includes('CHANGELOG')) throw new Error('Markdown association section missing CHANGELOG content: ' + text.slice(0, 120)); return 'md association loaded CHANGELOG with ' + text.length + ' chars'; })()" in the webview for 10 seconds
    When I execute command "workbench.action.closeAllEditors"