Feature: Did you know embedded file popup

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 760
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I wait 2 seconds

  Scenario: File-open compact popup appears inside the Kusto editor webview
    When I execute command "kustoWorkbench.dev.resetDidYouKnowState"
    And I open file "tests/vscode-extension-tester/e2e/default/did-you-know-embedded-popup/fixtures/embedded-did-you-know.kqlx" in the editor
    And I wait for "kw-query-section .monaco-editor" in the webview for 25 seconds
    And I wait for "#kw-embedded-tutorial-viewer-host kw-tutorial-viewer" in the webview for 25 seconds
    And I evaluate "(async () => { const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); const waitFor = async predicate => { for (let attempt = 0; attempt < 160; attempt++) { const value = await predicate(); if (value) return value; await sleep(100); } throw new Error('Timed out waiting for embedded Did you know popup'); }; const host = await waitFor(() => document.querySelector('#kw-embedded-tutorial-viewer-host')); const viewer = await waitFor(() => host.querySelector('kw-tutorial-viewer')); const root = viewer.shadowRoot; await waitFor(async () => { await viewer.updateComplete; return viewer.snapshot && root.querySelector('[data-testid=tutorial-viewer-mode-compact]') && root.querySelector('[data-testid=tutorial-compact-got-it]'); }); const standaloneViewer = document.body.matches('kw-tutorial-viewer') || document.body.firstElementChild?.matches?.('kw-tutorial-viewer'); if (standaloneViewer) throw new Error('Did you know viewer mounted as the standalone webview body instead of the embedded overlay'); if (!document.querySelector('kw-query-section')) throw new Error('Expected to still be inside the Kusto editor webview body'); const overlayRect = host.getBoundingClientRect(); if (overlayRect.width < 300 || overlayRect.height < 200) throw new Error('Embedded overlay should fill the editor webview, got ' + JSON.stringify(overlayRect.toJSON())); return { embedded: true, mode: viewer.mode, overlay: overlayRect.toJSON() }; })()" in the webview for 25 seconds
    Then I take a screenshot "01-embedded-kqlx-popup"
    And I evaluate "(async () => { const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); const waitFor = async predicate => { for (let attempt = 0; attempt < 80; attempt++) { const value = await predicate(); if (value) return value; await sleep(100); } throw new Error('Timed out dismissing embedded Did you know popup'); }; const viewer = document.querySelector('#kw-embedded-tutorial-viewer-host kw-tutorial-viewer'); const button = viewer?.shadowRoot?.querySelector('[data-testid=tutorial-compact-got-it]'); if (!button) throw new Error('Missing embedded Got it button'); button.click(); await waitFor(() => !document.querySelector('#kw-embedded-tutorial-viewer-host')); return 'dismissed'; })()" in the webview for 15 seconds