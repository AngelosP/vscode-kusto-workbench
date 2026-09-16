Feature: Power BI publish status presentation

  Scenario: Publish status and destination links remain visible through compact re-publishing
    Given a file "tests/vscode-extension-tester/runs/default/powerbi-publish-status/status.kqlx" exists
    When I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 700
    And I open file "tests/vscode-extension-tester/runs/default/powerbi-publish-status/status.kqlx" in the editor
    And I wait for "body[data-kusto-e2e-ready='true']" in the webview "status.kqlx" for 25 seconds
    Then I collect JSON artifact "publish-status-editor" from extension host expression:
      """
      (() => {
        const uri = vscode.window.tabGroups.activeTabGroup.activeTab?.input?.uri;
        if (!uri?.path.endsWith('/tests/vscode-extension-tester/runs/default/powerbi-publish-status/status.kqlx')) throw new Error('Fixture editor is not active');
        globalThis.__publishStatusEditorUri = uri.toString();
        return { uri: uri.toString() };
      })()
      """
    Then I collect JSON artifact "publish-status-fixture" from webview expression:
      """
      (async () => {
        if (window.__e2eCaptureHostMessage) throw new Error('Another capture is active');
        const dialog = document.createElement('kw-publish-pbi-dialog');
        document.body.appendChild(dialog);
        await dialog.updateComplete;
        const fixture = { pending: null, requests: [], links: [] };
        dialog.__statusFixture = fixture;
        window.__e2eCaptureHostMessage = message => {
          if (message.type === 'getPbiWorkspaces') {
            setTimeout(() => dialog.handleHostMessage({ type: 'pbiWorkspacesResult', requestId: message.requestId, boxId: message.boxId, ok: true, workspaces: [{ id: 'status-workspace', name: 'Analytics', isPersonal: false }] }), 0);
            return false;
          }
          if (message.type === 'publishToPowerBI') {
            fixture.pending = message;
            fixture.requests.push(message);
            return false;
          }
          if (message.type === 'cancelDashboardWorkflow') return false;
          return true;
        };
        fixture.complete = async (dataMode, scheduleConfigured, initialRefreshTriggered) => {
          const request = fixture.pending;
          if (!request || request.dataMode !== dataMode) throw new Error('Missing real publish request for ' + dataMode);
          const primary = dialog.shadowRoot.querySelector('.sd-btn-primary');
          if (!primary.disabled || !primary.textContent.includes('ublishing...')) throw new Error('Publishing state missing');
          fixture.pending = null;
          dialog.handleHostMessage({ type: 'publishToPowerBIResult', requestId: request.requestId, boxId: request.boxId, ok: true, reportUrl: 'https://app.powerbi.com/groups/status-workspace/reports/status-report', scheduleConfigured, initialRefreshTriggered, dataMode, semanticModelId: 'status-model', reportId: 'status-report', workspaceId: request.workspaceId, workspaceName: 'Analytics', reportName: request.reportName });
          await dialog.updateComplete;
          if (dialog.shadowRoot.querySelectorAll('.ppd-success-link').length !== 2) throw new Error('Destination links missing');
          return { dataMode, publishCount: fixture.requests.length };
        };
        fixture.measure = () => {
          const root = dialog.shadowRoot;
          const panel = root.querySelector('.sd');
          const status = root.querySelector('.ppd-status-success');
          const footer = root.querySelector('.sd-f');
          const panelRect = panel.getBoundingClientRect();
          const statusRect = status.getBoundingClientRect();
          const footerRect = footer.getBoundingClientRect();
          if (Math.abs(statusRect.left - panelRect.left - panel.clientLeft) > 1 || Math.abs(statusRect.width - panel.clientWidth) > 1) throw new Error('Status background is not edge-to-edge');
          if (status.scrollHeight > status.clientHeight + 1 || status.scrollWidth > status.clientWidth + 1) throw new Error('Status content is clipped');
          if (Math.abs(statusRect.bottom - footerRect.top) > 1 || footerRect.bottom > panelRect.bottom) throw new Error('Status and footer overlap or have an outer gap');
          const links = Array.from(root.querySelectorAll('.ppd-success-link')).map(link => {
            const rect = link.getBoundingClientRect();
            if (rect.width < 1 || rect.height < 1 || rect.left < statusRect.left || rect.right > statusRect.right || rect.top < statusRect.top || rect.bottom > statusRect.bottom) throw new Error('Link is clipped: ' + link.textContent);
            return { text: link.textContent.trim(), href: link.href, top: rect.top, bottom: rect.bottom };
          });
          const icons = Array.from(root.querySelectorAll('.ppd-success-detail-row .codicon'));
          const summaryIcon = root.querySelector('.ppd-success-check').getBoundingClientRect();
          if (icons.some(icon => icon.getBoundingClientRect().width >= summaryIcon.width)) throw new Error('Child status icons are not smaller than summary');
          if (root.querySelector('.ppd-success-schedule')) throw new Error('Old status pill remains');
          if (panelRect.top < 0 || panelRect.bottom > innerHeight) throw new Error('Dialog exceeds viewport');
          return { viewport: { width: innerWidth, height: innerHeight }, panel: { width: panelRect.width, height: panelRect.height }, status: { width: statusRect.width, height: statusRect.height }, text: status.textContent.replace(/\s+/g, ' ').trim(), links };
        };
        dialog.shadowRoot.addEventListener('click', event => {
          const link = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.classList.contains('ppd-success-link'));
          if (!link) return;
          fixture.links.push({ href: link.href, target: link.target, rel: link.rel });
          event.preventDefault();
          event.stopPropagation();
        });
        dialog.show([{ name: 'Fact Events', sectionId: 'status-query', clusterUrl: 'https://cluster.example', database: 'Samples', query: 'FactEvents', columns: [{ name: 'Day', type: 'datetime' }] }], '<main></main>', 'Operations Dashboard', 1912, 'status-html');
        await dialog.updateComplete;
        return { fixture: 'production dialog with intercepted service boundary', externalPublishing: false };
      })()
      """
    When I wait for ".ppd-combo .ppd-input" in the webview
    And I click ".ppd-combo .ppd-input" in the webview
    And I click ".ppd-combo-item" in the webview
    And I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "first-import-publish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('import', true, true)"
    And element ".ppd-success-text" should have text "Published Successfully"
    Then I collect JSON artifact "wide-import-status" from webview expression:
      """
      (() => {
        const dialog = document.querySelector('kw-publish-pbi-dialog');
        const measurement = dialog.__statusFixture.measure();
        if (dialog.shadowRoot.querySelectorAll('.ppd-success-detail-row .codicon-check').length !== 2) throw new Error('Completed child checkmarks missing');
        if (!measurement.text.includes('Daily refresh scheduled for 1:00 AM UTC') || !measurement.text.includes('Initial refresh requested')) throw new Error('Unclear Import status');
        return measurement;
      })()
      """
    And I take a screenshot "01-wide-import-status"
    When I click ".ppd-success-link:first-child" in the webview
    And I click ".ppd-success-link:last-child" in the webview
    Then I collect JSON artifact "clicked-publish-destinations" from webview expression:
      """
      (() => {
        const links = document.querySelector('kw-publish-pbi-dialog').__statusFixture.links;
        const expected = ['https://app.powerbi.com/groups/status-workspace/reports/status-report', 'https://app.powerbi.com/groups/status-workspace/settings/datasets/status-model'];
        if (links.length !== 2 || links.some((link, index) => link.href !== expected[index] || link.target !== '_blank' || link.rel !== 'noopener noreferrer')) throw new Error('Incorrect clicked destination: ' + JSON.stringify(links));
        return { links, externalNavigationSuppressed: true };
      })()
      """
    When I resize the Dev Host to 420 by 560
    Then I collect JSON artifact "compact-import-status" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.measure()"
    And I take a screenshot "02-compact-import-status"
    When I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "incomplete-refresh-republish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('import', false, false)"
    And element ".ppd-success-text" should have text "Updated Successfully"
    Then I collect JSON artifact "compact-incomplete-refresh-status" from webview expression:
      """
      (() => {
        const dialog = document.querySelector('kw-publish-pbi-dialog');
        const measurement = dialog.__statusFixture.measure();
        if (dialog.shadowRoot.querySelectorAll('.ppd-success-detail-row .codicon-warning').length !== 2 || dialog.shadowRoot.querySelector('.ppd-success-detail-row .codicon-check')) throw new Error('Incomplete refresh steps incorrectly marked done');
        if (!measurement.text.includes('Refresh schedule not configured') || !measurement.text.includes('Initial refresh not started')) throw new Error('Missing incomplete refresh status');
        return measurement;
      })()
      """
    And I take a screenshot "03-compact-incomplete-refresh"
    When I resize the Dev Host to 1000 by 700
    And I click ".ppd-mode-copy:nth-child(2)" in the webview
    And I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "direct-query-republish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('directQuery', false, undefined)"
    Then I collect JSON artifact "direct-query-status" from webview expression:
      """
      (() => {
        const dialog = document.querySelector('kw-publish-pbi-dialog');
        const measurement = dialog.__statusFixture.measure();
        if (!measurement.text.includes('Direct Query uses live data; no scheduled refresh needed') || measurement.text.includes('Initial refresh') || dialog.shadowRoot.querySelector('.codicon-warning')) throw new Error('Direct Query incorrectly requires Import refresh');
        const requests = dialog.__statusFixture.requests;
        if (requests.length !== 3 || requests[0].reportId || requests.slice(1).some(request => request.reportId !== 'status-report' || request.semanticModelId !== 'status-model')) throw new Error('Re-publish lost destination identity');
        return measurement;
      })()
      """
    And I take a screenshot "04-direct-query-status"
    When I click ".sd-f .sd-btn:not(.sd-btn-primary)" in the webview
    Then element ".ppd-status-success" should not exist
    Then I collect JSON artifact "publish-status-cleanup" from webview expression:
      """
      (() => {
        const dialog = document.querySelector('kw-publish-pbi-dialog');
        dialog.remove();
        delete window.__e2eCaptureHostMessage;
        return { removed: !document.querySelector('kw-publish-pbi-dialog') };
      })()
      """
    Then I collect JSON artifact "publish-status-close-editor" from extension host expression:
      """
      (async () => {
        const uri = globalThis.__publishStatusEditorUri;
        if (typeof uri !== 'string') throw new Error('Fixture editor URI was not captured');
        const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input?.uri?.toString() === uri);
        if (tabs.length !== 1 || tabs[0].isDirty) throw new Error('Expected one clean fixture editor');
        if (!await vscode.window.tabGroups.close(tabs)) throw new Error('Could not close fixture editor');
        delete globalThis.__publishStatusEditorUri;
        return { closedUri: uri };
      })()
      """