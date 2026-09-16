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
          if (root.querySelectorAll('[data-overlay-scroll]').length !== 1 || !panel.hasAttribute('data-overlay-scroll')) throw new Error('Whole dialog is not the only scroll owner');
          for (const selector of ['.sd-h', '.sd-b', '.ppd-status-success', '.sd-f']) {
            if (root.querySelector(selector).parentElement !== panel) throw new Error('Dialog region is outside the viewport: ' + selector);
          }
          const rail = panel.querySelector('.os-scrollbar-vertical');
          const handle = rail?.querySelector('.os-scrollbar-handle');
          if (!handle || panel.querySelectorAll('.os-scrollbar-vertical').length !== 1 || getComputedStyle(panel).scrollbarWidth !== 'none') throw new Error('Expected one overlay scrollbar and no native scrollbar');
          const railRect = rail.getBoundingClientRect();
          const handleStyle = getComputedStyle(handle);
          if (Math.abs(railRect.height - panel.clientHeight) > 2 || Math.abs(railRect.top - panelRect.top - panel.clientTop) > 2) throw new Error('Scrollbar does not span the whole dialog');
          if (Math.abs(parseFloat(handleStyle.width) - 8) > 1 || parseFloat(handleStyle.borderRadius) <= 0) throw new Error('Scrollbar thumb does not match VS Code');
          if (panel.scrollWidth > panel.clientWidth + 1 || root.querySelector('.sd-b').scrollTop !== 0) throw new Error('Unexpected nested or horizontal form scrolling');
          return { viewport: { width: innerWidth, height: innerHeight }, panel: { width: panelRect.width, height: panelRect.height, scrollTop: panel.scrollTop, scrollHeight: panel.scrollHeight }, scrollbar: { railHeight: railRect.height, thumbWidth: handleStyle.width, radius: handleStyle.borderRadius, color: handleStyle.backgroundColor }, status: { width: statusRect.width, height: statusRect.height }, text: status.textContent.replace(/\s+/g, ' ').trim(), links };
        };
        fixture.captureScroll = () => {
          const root = dialog.shadowRoot;
          const panel = root.querySelector('.sd');
          const page = document.querySelector('.kw-scroll-viewport [data-kw-page-scroll-element="true"]') ?? document.querySelector('.kw-scroll-viewport [data-overlayscrollbars-viewport]') ?? document.scrollingElement;
          return { scrollTop: panel.scrollTop, maximum: panel.scrollHeight - panel.clientHeight, pageScrollTop: page?.scrollTop ?? 0, regionTops: ['.sd-h', '.sd-b', '.ppd-status-success', '.sd-f'].map(selector => root.querySelector(selector).getBoundingClientRect().top) };
        };
        fixture.assertScrolled = async direction => {
          await new Promise(requestAnimationFrame);
          const before = fixture.scrollBefore;
          const after = fixture.captureScroll();
          const delta = after.scrollTop - before.scrollTop;
          if (delta * direction <= 1 || after.pageScrollTop !== before.pageScrollTop) throw new Error('Keyboard input did not scroll only the dialog: ' + JSON.stringify({ before, after }));
          if (after.regionTops.some((top, index) => Math.abs(before.regionTops[index] - top - delta) > 1)) throw new Error('Header, form, status, and footer did not scroll together');
          fixture.scrollBefore = after;
          return { delta, before, after };
        };
        dialog.shadowRoot.addEventListener('click', event => {
          const link = event.composedPath().find(node => node instanceof HTMLAnchorElement && node.classList.contains('ppd-success-link'));
          if (!link) return;
          fixture.links.push({ href: link.href, target: link.target, rel: link.rel });
          event.preventDefault();
          event.stopPropagation();
        });
        fixture.show = async () => {
          dialog.show([{ name: 'Fact Events', sectionId: 'status-query', clusterUrl: 'https://cluster.example', database: 'Samples', query: 'FactEvents', columns: [{ name: 'Day', type: 'datetime' }] }], '<main></main>', 'Operations Dashboard', 1912, 'status-html');
          await dialog.updateComplete;
          return { visible: !!dialog.shadowRoot.querySelector('.sd') };
        };
        await fixture.show();
        return { fixture: 'production dialog with intercepted service boundary', externalPublishing: false };
      })()
      """
    When I wait for ".ppd-combo .ppd-input" in the webview
    And I click ".ppd-combo .ppd-input" in the webview
    And I click ".ppd-combo-item" in the webview
    And I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "first-import-publish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('import', true, true)"
    And element ".ppd-success-text" should have text "Published Successfully"
    When I scroll ".sd[data-overlay-scroll]" to the bottom
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
    And I scroll ".sd[data-overlay-scroll]" to the top
    Then I collect JSON artifact "compact-scroll-start" from webview expression:
      """
      (() => {
        const fixture = document.querySelector('kw-publish-pbi-dialog').__statusFixture;
        const before = fixture.captureScroll();
        if (before.maximum <= 100 || before.scrollTop !== 0) throw new Error('Compact dialog must overflow from the top');
        fixture.scrollBefore = before;
        return before;
      })()
      """
    And I take a screenshot "02-compact-form-top"
    When I focus ".sd[data-overlay-scroll]" in the webview
    And I press "PageDown"
    Then I collect JSON artifact "compact-dialog-page-down" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.assertScrolled(1)"
    When I scroll ".sd[data-overlay-scroll]" to the bottom
    Then I collect JSON artifact "compact-import-status" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.measure()"
    And I take a screenshot "03-compact-import-status"
    When I focus ".sd[data-overlay-scroll]" in the webview
    Then I collect JSON artifact "compact-scroll-bottom" from webview expression "(() => { const fixture = document.querySelector('kw-publish-pbi-dialog').__statusFixture; return fixture.scrollBefore = fixture.captureScroll(); })()"
    When I press "PageUp"
    Then I collect JSON artifact "compact-dialog-page-up" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.assertScrolled(-1)"
    When I scroll ".sd[data-overlay-scroll]" to the bottom
    And I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "incomplete-refresh-republish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('import', false, false)"
    And element ".ppd-success-text" should have text "Updated Successfully"
    When I scroll ".sd[data-overlay-scroll]" to the bottom
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
    And I take a screenshot "04-compact-incomplete-refresh"
    When I resize the Dev Host to 1000 by 700
    And I click ".ppd-mode-copy:nth-child(2)" in the webview
    And I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "direct-query-republish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('directQuery', false, undefined)"
    When I scroll ".sd[data-overlay-scroll]" to the bottom
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
    And I take a screenshot "05-direct-query-status"
    When I click ".sd-f .sd-btn:not(.sd-btn-primary)" in the webview
    Then element ".ppd-status-success" should not exist
    And element ".sd[data-overlay-scroll]" should not exist
    Then I collect JSON artifact "publish-status-reopen" from webview expression:
      """
      (async () => {
        const dialog = document.querySelector('kw-publish-pbi-dialog');
        if (dialog.shadowRoot.querySelector('.os-scrollbar')) throw new Error('Closed dialog leaked a scrollbar');
        const reopened = await dialog.__statusFixture.show();
        const panel = dialog.shadowRoot.querySelector('.sd[data-overlay-scroll]');
        if (panel.scrollTop !== 0 || panel.querySelectorAll('.os-scrollbar-vertical').length !== 1) throw new Error('Reopened dialog did not get exactly one fresh scrollbar');
        return reopened;
      })()
      """
    When I resize the Dev Host to 420 by 560
    And I wait for ".ppd-combo .ppd-input" in the webview
    And I scroll ".sd[data-overlay-scroll]" to the bottom
    And I click ".sd-f .sd-btn-primary" in the webview
    Then I collect JSON artifact "reopened-import-publish" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.complete('import', true, true)"
    When I scroll ".sd[data-overlay-scroll]" to the top
    And I focus ".sd[data-overlay-scroll]" in the webview
    Then I collect JSON artifact "reopened-scroll-start" from webview expression "(() => { const fixture = document.querySelector('kw-publish-pbi-dialog').__statusFixture; return fixture.scrollBefore = fixture.captureScroll(); })()"
    When I press "PageDown"
    Then I collect JSON artifact "reopened-dialog-page-down" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.assertScrolled(1)"
    When I scroll ".sd[data-overlay-scroll]" to the bottom
    Then I collect JSON artifact "reopened-import-status" from webview expression "document.querySelector('kw-publish-pbi-dialog').__statusFixture.measure()"
    And I take a screenshot "06-reopened-compact-status"
    When I click ".sd-f .sd-btn:not(.sd-btn-primary)" in the webview
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