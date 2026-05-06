Feature: HTML dashboard Power BI upgrade notice

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1300 by 950
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Restore-time compatibility scan only warns Power BI-relevant sections
    Given a file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/gates.kqlx" exists

    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/gates.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second

    When I evaluate "(() => { const provenance = (bindings, body) => '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings }) + '</script>' + body; const valid = provenance({ total: { display: { type: 'scalar', agg: 'COUNT' } } }, '<span data-kw-bind=\'total\'>0</span>'); const heat = provenance({ heat: { display: { type: 'heatmap', xColumn: 'Day', valueColumn: 'Requests' } } }, '<div data-kw-bind=\'heat\'></div>'); const badTable = provenance({ 'top-table': { display: { type: 'table', groupBy: ['OS'], columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }] } } }, '<div data-kw-bind=\'top-table\'></div>'); const pureJs = `<main id='manual-chart' data-kw-bind='loose-marker'><svg xmlns='http://www.w3.org/2000/svg' width='160' height='40'><rect width='160' height='40'></rect></svg><script>KustoWorkbench.bindHtml('chart-panel', () => '<b>Manual chart</b>'); document.getElementById('manual-chart');</script></main>`; window.addHtmlBox({ id: 'html_valid_powerbi', name: 'Valid exportable dashboard', code: valid, mode: 'preview', expanded: true, previewHeightPx: 150 }); window.addHtmlBox({ id: 'html_invalid_heatmap', name: 'Unsupported heatmap dashboard', code: heat, mode: 'preview', expanded: true, previewHeightPx: 150, afterBoxId: 'html_valid_powerbi' }); window.addHtmlBox({ id: 'html_invalid_target', name: 'Invalid table target dashboard', code: badTable, mode: 'preview', expanded: true, previewHeightPx: 150, afterBoxId: 'html_invalid_heatmap' }); window.addHtmlBox({ id: 'html_pure_js', name: 'Manual JavaScript dashboard', code: pureJs, mode: 'preview', expanded: true, previewHeightPx: 150, afterBoxId: 'html_invalid_target' }); window.addHtmlBox({ id: 'html_published_old', name: 'Previously published old dashboard', code: '<main>Previously published old dashboard</main>', mode: 'preview', expanded: true, previewHeightPx: 150, afterBoxId: 'html_pure_js', pbiPublishInfo: { workspaceId: 'workspace-1', semanticModelId: 'semantic-1', reportId: 'report-1', reportName: 'Old Report', reportUrl: 'https://powerbi.example/report-1' } }); return 'created Power BI upgrade gate sections'; })()" in the webview
    And I wait 3 seconds
    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds

    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/gates.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "kw-html-section" in the webview for 20 seconds
    And I wait 3 seconds

    When I evaluate "(() => { const get = id => document.getElementById(id); const notice = id => get(id)?.shadowRoot?.querySelector('.power-bi-upgrade-notice'); const text = id => notice(id)?.textContent || ''; const expectNotice = (id, expected) => { const node = notice(id); if (!node) throw new Error(id + ' should show upgrade notice'); if (!text(id).includes(expected)) throw new Error(id + ' notice missing ' + expected + ': ' + text(id)); }; const expectNoNotice = id => { const node = notice(id); if (node) throw new Error(id + ' should not show notice: ' + node.textContent); }; expectNoNotice('html_valid_powerbi'); expectNoNotice('html_pure_js'); expectNoNotice('html_invalid_heatmap'); expectNotice('html_invalid_target', 'Power BI export needs an update'); expectNotice('html_published_old', 'Power BI export needs an update'); const targetNotice = notice('html_invalid_target'); if (targetNotice.querySelector('.power-bi-upgrade-detail')) throw new Error('notice should only render one visible copy line'); const targetIconTitle = targetNotice.querySelector('.power-bi-upgrade-icon')?.getAttribute('title') || ''; if (!targetIconTitle.includes('Some dashboard content is not connected to exportable Power BI elements')) throw new Error('info icon title missing target detail: ' + targetIconTitle); if (!text('html_invalid_target').includes('Update')) throw new Error('Update button missing from actionable notice: ' + text('html_invalid_target')); if (text('html_invalid_target').includes('top-table (table: target must be table or tbody inside table)')) throw new Error('notice leaked raw table reason: ' + text('html_invalid_target')); const oldIconTitle = notice('html_published_old').querySelector('.power-bi-upgrade-icon')?.getAttribute('title') || ''; if (!oldIconTitle.includes('This dashboard needs Power BI export metadata')) throw new Error('info icon title missing old dashboard detail: ' + oldIconTitle); const pure = get('html_pure_js'); const pureRoot = pure?.shadowRoot; const wrapper = pureRoot?.querySelector('.header-tab-tooltip-wrapper'); if (!wrapper) throw new Error('disabled upload wrapper missing'); const title = wrapper.getAttribute('title') || ''; if (!title.includes('not set up for Power BI export yet')) throw new Error('disabled tooltip title missing expected text: ' + title); if (wrapper.getAttribute('tabindex') !== '0') throw new Error('disabled wrapper must be keyboard focusable'); if (wrapper.getAttribute('role') !== 'button') throw new Error('disabled wrapper must expose button role'); if (wrapper.getAttribute('aria-disabled') !== 'true') throw new Error('disabled wrapper must expose aria-disabled'); const describedBy = wrapper.getAttribute('aria-describedby'); const description = describedBy ? pureRoot?.getElementById(describedBy) : null; if (!description?.textContent?.includes('Ask the Kusto Workbench agent')) throw new Error('disabled upload sr-only explanation missing'); const disabledButton = wrapper.querySelector('button.header-tab'); if (!disabledButton?.disabled) throw new Error('pure JS upload button should be disabled'); const heatWrapper = get('html_invalid_heatmap')?.shadowRoot?.querySelector('.header-tab-tooltip-wrapper'); const heatButton = heatWrapper?.querySelector('button.header-tab'); if (!heatButton?.disabled) throw new Error('unsupported heatmap upload button should be disabled'); const heatTitle = heatWrapper?.getAttribute('title') || ''; if (!heatTitle.includes('does not support heatmap visuals yet')) throw new Error('heatmap disabled tooltip missing unsupported message: ' + heatTitle); return 'restore-time gate and disabled upload affordance verified'; })()" in the webview
    Then I take a screenshot "01-powerbi-relevance-gates"

    When I evaluate "(() => { const section = document.getElementById('html_invalid_target'); const root = section?.shadowRoot; const messages = []; window.__e2eCaptureHostMessage = message => { messages.push(message); return false; }; try { const update = root?.querySelector('.power-bi-upgrade-primary'); if (!update) throw new Error('Update button missing'); update.click(); } finally { delete window.__e2eCaptureHostMessage; } if (messages.length !== 1) throw new Error('Expected exactly one upgrade message, got ' + messages.length); const msg = messages[0]; if (msg.sectionId !== 'html_invalid_target') throw new Error('Unexpected sectionId: ' + msg.sectionId); if (msg.sectionName !== 'Invalid table target dashboard') throw new Error('Unexpected sectionName: ' + msg.sectionName); if (!Array.isArray(msg.reasons) || !msg.reasons.includes('top-table (table: target must be table or tbody inside table)')) throw new Error('Missing table target reason: ' + JSON.stringify(msg.reasons)); return 'Update posted requestHtmlDashboardUpgradeWithCopilot'; })()" in the webview

    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/gates.kqlx"

  Scenario: Notice close and persistent dismissal respect the current issue signature
    Given a file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx" exists

    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const html = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } } }) + '</script><main>Missing rendered target</main>'; window.addHtmlBox({ id: 'html_dismissal_case', name: 'Dismissal dashboard', code: html, mode: 'preview', expanded: true, previewHeightPx: 160 }); return 'created dismissal section'; })()" in the webview
    And I wait 3 seconds
    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds

    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#html_dismissal_case" in the webview for 20 seconds
    And I wait 3 seconds
    When I evaluate "(() => { const root = document.getElementById('html_dismissal_case')?.shadowRoot; if (!root?.querySelector('.power-bi-upgrade-notice')) throw new Error('notice should appear before close'); root.querySelector('.power-bi-upgrade-close')?.click(); if (root.querySelector('.power-bi-upgrade-notice')) throw new Error('X should hide notice for current session'); return 'session close hides notice'; })()" in the webview
    Then I take a screenshot "02-session-close-hidden"

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#html_dismissal_case" in the webview for 20 seconds
    And I wait 3 seconds
    When I evaluate "(() => { const root = document.getElementById('html_dismissal_case')?.shadowRoot; if (!root?.querySelector('.power-bi-upgrade-notice')) throw new Error('X close must not persist after reopen'); root.querySelector('.power-bi-upgrade-secondary')?.click(); if (root.querySelector('.power-bi-upgrade-notice')) throw new Error('Dont tell me again should hide notice immediately'); const serialized = document.getElementById('html_dismissal_case')?.serialize(); if (!serialized?.powerBiUpgradeNotice?.dismissedForSignature) throw new Error('dismissal state not serialized: ' + JSON.stringify(serialized)); return 'persistent dismissal serialized'; })()" in the webview
    When I execute command "workbench.action.files.save"
    And I wait 3 seconds
    Then the file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx" should contain "powerBiUpgradeNotice"
    Then I take a screenshot "03-persistent-dismissal-hidden"

    When I execute command "workbench.action.closeAllEditors"
    And I wait 2 seconds
    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#html_dismissal_case" in the webview for 20 seconds
    And I wait 3 seconds
    When I evaluate "(() => { const section = document.getElementById('html_dismissal_case'); const root = section?.shadowRoot; if (root?.querySelector('.power-bi-upgrade-notice')) throw new Error('persisted dismissal should hide same signature after reopen'); const html = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings: { 'top-table': { display: { type: 'table', groupBy: ['OS'], columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }] } } } }) + '</script><div data-kw-bind=\'top-table\'></div>'; section.setCode(html); return 'changed incompatible signature'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const text = document.getElementById('html_dismissal_case')?.shadowRoot?.querySelector('.power-bi-upgrade-notice')?.textContent || ''; if (!text.includes('Some dashboard content is not connected to exportable Power BI elements')) throw new Error('new signature should show new notice, got: ' + text); if (text.includes('top-table (table: target must be table or tbody inside table)')) throw new Error('notice leaked raw table reason: ' + text); return 'new signature reappears'; })()" in the webview
    Then I take a screenshot "04-new-signature-notice"

    When I execute command "workbench.action.files.save"
    And I wait 2 seconds
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/dismissal.kqlx"

  Scenario: Editing a Power BI-enabled HTML section recomputes upgrade status without reload
    Given a file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/edit-recheck.kqlx" exists

    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/edit-recheck.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const valid = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } } }) + '</script><span data-kw-bind=\'total\'>0</span>'; window.addHtmlBox({ id: 'html_edit_recheck', name: 'Edit recheck dashboard', code: valid, mode: 'preview', expanded: true, previewHeightPx: 160 }); return 'created valid edit recheck section'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.getElementById('html_edit_recheck'); if (section?.shadowRoot?.querySelector('.power-bi-upgrade-notice')) throw new Error('valid section should start without notice'); const invalid = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings: { 'top-table': { display: { type: 'table', groupBy: ['OS'], columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }] } } } }) + '</script><div data-kw-bind=\'top-table\'></div>'; section.setCode(invalid); return 'introduced fixable target issue'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const root = document.getElementById('html_edit_recheck')?.shadowRoot; const text = root?.querySelector('.power-bi-upgrade-notice')?.textContent || ''; if (!text.includes('Power BI export needs an update')) throw new Error('new fixable target issue should show notice, got: ' + text); const iconTitle = root?.querySelector('.power-bi-upgrade-icon')?.getAttribute('title') || ''; if (!iconTitle.includes('Some dashboard content is not connected to exportable Power BI elements')) throw new Error('notice info icon missing target detail: ' + iconTitle); if (text.includes('top-table (table: target must be table or tbody inside table)')) throw new Error('notice leaked raw table reason: ' + text); const valid = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } } }) + '</script><span data-kw-bind=\'total\'>0</span>'; document.getElementById('html_edit_recheck').setCode(valid); return 'restored valid binding'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const node = document.getElementById('html_edit_recheck')?.shadowRoot?.querySelector('.power-bi-upgrade-notice'); if (node) throw new Error('notice should clear after valid code is restored: ' + node.textContent); return 'edit recheck clears notice'; })()" in the webview
    And I wait 3 seconds
    When I evaluate "(() => { const node = document.getElementById('html_edit_recheck')?.shadowRoot?.querySelector('.power-bi-upgrade-notice'); if (node) throw new Error('notice reappeared after valid code was stable: ' + node.textContent); return 'edit recheck remains valid after repaint'; })()" in the webview
    Then I take a screenshot "05-edit-recheck-valid-again"

    When I execute command "workbench.action.files.save"
    And I wait 2 seconds
    When I execute command "workbench.action.closeAllEditors"
    And I wait 1 second
    When I delete file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/edit-recheck.kqlx"

  Scenario: Update opens the Kusto Workbench chat with an upgrade prompt
    Given a file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/update-chat.kqlx" exists

    When I open file "tests/vscode-extension-tester/runs/default/html-powerbi-upgrade/update-chat.kqlx" in the editor
    And I wait 8 seconds
    When I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second
    When I evaluate "(() => { const html = '<script type=\'application/kw-provenance\'>' + JSON.stringify({ version: 1, model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } }, bindings: { 'top-table': { display: { type: 'table', groupBy: ['OS'], columns: [{ name: 'OS' }, { name: 'Sessions', agg: 'COUNT' }] } } } }) + '</script><div data-kw-bind=\'top-table\'></div>'; window.addHtmlBox({ id: 'html_update_chat_case', name: 'Update chat dashboard', code: html, mode: 'preview', expanded: true, previewHeightPx: 160 }); return 'created real update chat section'; })()" in the webview
    And I wait 1 second
    When I evaluate "(() => { if (!window.vscode || typeof window.vscode.postMessage !== 'function') throw new Error('window.vscode.postMessage missing before real chat launch'); const messages = []; window.__e2eCaptureHostMessage = message => { messages.push(message); return true; }; try { const root = document.getElementById('html_update_chat_case')?.shadowRoot; const button = root?.querySelector('.power-bi-upgrade-primary'); if (!button) throw new Error('Update button missing before real chat launch'); button.click(); } finally { delete window.__e2eCaptureHostMessage; } if (messages.length !== 1) throw new Error('Expected one real update message, got ' + messages.length); const msg = messages[0]; if (msg.type !== 'requestHtmlDashboardUpgradeWithCopilot') throw new Error('Unexpected message type: ' + msg.type); if (msg.sectionId !== 'html_update_chat_case') throw new Error('Unexpected real update sectionId: ' + msg.sectionId); return 'clicked real Update button and delivered host message'; })()" in the webview
    And I wait 5 seconds
    Then I take a screenshot "06-update-opens-kusto-workbench-chat"
