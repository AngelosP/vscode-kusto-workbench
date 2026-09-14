Feature: Connection Manager progressive Search and Back navigation
  Connection and database metadata are display fixtures only, never registered host owners.
  Search, selection, categories, dismissal, and reload use real controls and transport.
  Saved-state evidence is the host globalState projection, not direct durable-byte inspection.

  Background:
    Given I capture the output channel "Kusto Workbench"
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 700
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "kusto.manageConnections"
    And I wait for "[data-testid='cm-filter-all']" in the webview for 20 seconds

  Scenario: Target tags and independent search bits survive per-kind save and native webview reload
    Then I collect JSON artifact "cm-search-fixture" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        const root = manager.shadowRoot;
        const clone = value => JSON.parse(JSON.stringify(value));
        const equal = (actual, expected, label) => {
          if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ': ' + JSON.stringify({ actual, expected }));
        };
        const waitFor = async (predicate, label) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            await manager.updateComplete;
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Timed out: ' + label);
        };
        await waitFor(() => !!manager._snapshot, 'initial host snapshot');
        const initial = clone(manager._snapshot);
        if (initial.connections.length || initial.sqlConnections?.length) throw new Error('This default-profile scenario requires an empty host inventory');
        const metadata = {
          connections: [
            { id: 'cm-e2e-kusto-a', name: 'Cluster A', clusterUrl: 'https://cm-e2e-kusto-a.invalid', database: '' },
            { id: 'cm-e2e-kusto-b', name: 'Cluster B', clusterUrl: 'https://cm-e2e-kusto-b.invalid', database: '' }
          ],
          cachedDatabases: { 'cm-e2e-kusto-a': ['A1', 'A2'], 'cm-e2e-kusto-b': ['B1', 'B2'] },
          sqlConnections: [
            { id: 'cm-e2e-sql-a', name: 'Server A - North America production analytics and reporting warehouse', serverUrl: 'cm-e2e-sql-a.invalid', dialect: 'mssql', authType: 'aad' },
            { id: 'cm-e2e-sql-b', name: 'Server B', serverUrl: 'cm-e2e-sql-b.invalid', dialect: 'mssql', authType: 'aad' }
          ],
          sqlCachedDatabases: { 'cm-e2e-sql-a': ['A1', 'A2'], 'cm-e2e-sql-b': ['B1', 'B2'] }
        };
        const evidence = { messages: [], starts: [], responses: [], snapshots: [], saved: {}, ui: {}, geometry: {}, browser: [], lastRequestIndex: -1 };
        const project = state => clone({ kind: state.kind, scope: state.scope, targets: state.targets ?? [], query: state.query, categories: state.categories, contentToggles: state.contentToggles });
        const state = () => project(manager._search);
        const live = () => ({
          state: state(), kind: root.querySelector('[data-testid=cm-explorer-panel]').dataset.testKind,
          scope: root.querySelector('[data-testid=cm-search-scope]')?.value ?? null,
          query: root.querySelector('[data-testid=cm-search-input]')?.value ?? null,
          tags: Array.from(root.querySelectorAll('[data-testid=cm-search-target-tag]'), tag => {
            const label = tag.querySelector('[data-testid=cm-search-target-label]');
            const remove = tag.querySelector('[data-testid=cm-search-target-remove]');
            return { connectionId: tag.dataset.connectionId, database: tag.dataset.database, label: label?.textContent.trim() ?? null, title: tag.title, labelTitle: label?.title ?? null, removeConnectionId: remove?.dataset.connectionId ?? null, removeDatabase: remove?.dataset.database ?? null, removeLabel: remove?.getAttribute('aria-label') ?? null, removeTitle: remove?.title ?? null };
          }),
          categories: Array.from(root.querySelectorAll('[data-testid=cm-search-category]'), chip => ({ id: chip.dataset.category, active: chip.getAttribute('aria-pressed'), content: chip.classList.contains('content-on'), disabled: chip.disabled })),
          resultsVisible: !!root.querySelector('[data-testid=cm-search-results]'),
          count: root.querySelector('.search-result-count')?.textContent.trim() ?? null
        });
        const forward = manager.postMessage.bind(manager);
        manager.postMessage = message => {
          evidence.messages.push(clone(message));
          if (message.type === 'search') evidence.starts.push(clone({ requestId: message.requestId, results: manager._search.results, loading: manager._search.loading }));
          return forward(message);
        };
        window.addEventListener('message', event => {
          const payload = event.data?.type === 'kustoPublicationStage' ? event.data.payload : event.data;
          if (payload?.type === 'searchResults') evidence.responses.push(clone(payload));
          if (payload?.type !== 'snapshot') return;
          const snapshot = payload.snapshot;
          evidence.snapshots.push(clone(snapshot));
          Object.assign(snapshot, clone(metadata));
        }, true);
        manager._snapshot = { ...manager._snapshot, ...clone(metadata) };
        manager.requestUpdate();
        await manager.updateComplete;
        equal(manager._snapshot.searchState, initial.searchState, 'Metadata decoration changed host Search state');
        evidence.view = async (label, kind, scope, targets, query, categories, labels = []) => {
          await manager.updateComplete;
          const actual = live();
          equal([actual.kind, actual.state.kind, actual.scope, actual.state.scope, actual.state.targets, actual.state.query], [kind, kind, scope, scope, targets, query], label);
          equal(actual.categories.map(category => category.id), categories, label + ' categories');
          const visible = categories.length > 0;
          equal([actual.query, !!root.querySelector('[data-testid=cm-search-categories]'), actual.resultsVisible], [visible ? query : null, visible, visible], label + ' progressive controls');
          equal(Array.from(root.querySelectorAll('.search-section-label'), element => element.textContent.trim()), visible ? ['Where to search', 'What to search for'] : ['Where to search'], label + ' progressive labels');
          const picker = root.querySelector('[data-testid=cm-search-target-picker]');
          const targetList = root.querySelector('[data-testid=cm-search-targets]');
          equal([!!picker, !!targetList], [scope === 'selected', scope === 'selected'], label + ' target controls visibility');
          equal(actual.tags, (scope === 'selected' ? targets : []).map((target, index) => ({ connectionId: target.connectionId, database: target.database ?? '', label: labels[index], title: labels[index], labelTitle: labels[index], removeConnectionId: target.connectionId, removeDatabase: target.database ?? '', removeLabel: 'Remove ' + labels[index], removeTitle: 'Remove ' + labels[index] })), label + ' exact individual tags');
          if (picker) {
            const addLabel = kind === 'sql' ? 'Add servers or databases' : 'Add clusters or databases';
            equal([picker.getAttribute('aria-label'), picker.title, picker.disabled, picker.textContent.trim()], [addLabel, addLabel, false, ''], label + ' accessible icon-only plus');
            equal(Array.from(targetList.children, child => child.dataset.testid), [...targets.map(() => 'cm-search-target-tag'), 'cm-search-target-picker'], label + ' plus follows tags');
          }
          evidence.ui[label] = actual;
          return actual;
        };
        evidence.bits = async (label, bits, views = true) => {
          await manager.updateComplete;
          const actual = live();
          const kusto = actual.kind === 'kusto';
          equal(bits.length, kusto ? 4 : 2, label + ' expected bit count');
          const categories = kusto ? { clusters: true, databases: true, tables: bits[0], functions: bits[2] } : { servers: true, databases: true, tables: bits[0], views, storedProcedures: true };
          const contentToggles = kusto ? { tables: bits[1], functions: bits[3] } : { tables: bits[1], views: false, storedProcedures: false };
          equal([actual.state.categories, actual.state.contentToggles], [categories, contentToggles], label + ' independent stored bits without foreign keys');
          const ids = kusto ? ['clusters', 'databases', 'tables', 'tableColumns', 'functions', 'functionBody'] : ['servers', 'databases', 'tables', 'tableColumns', 'views', 'storedProcedures'];
          const visible = actual.state.scope !== 'selected' || actual.state.targets.length > 0;
          const whole = actual.state.scope !== 'selected' || actual.state.targets.some(target => target.database === undefined);
          equal(actual.categories, (visible ? ids.filter(id => whole || (id !== 'clusters' && id !== 'servers')) : []).map(id => ({ id, active: String(id === 'tableColumns' ? bits[1] : id === 'functionBody' ? bits[3] : categories[id]), content: false, disabled: false })), label + ' independent enabled buttons');
          evidence.ui[label] = actual;
          return actual;
        };
        evidence.layout = async (label, narrow = false) => {
          await manager.updateComplete;
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const container = root.querySelector('[data-testid=cm-search-container]');
          const bounds = container.getBoundingClientRect();
          const compact = bounds.width <= 600;
          for (const button of container.querySelectorAll('[data-testid=cm-search-category]')) {
            const text = button.querySelector('.search-chip-text');
            const icon = button.querySelector('.search-chip-icon');
            const rect = button.getBoundingClientRect();
            if (!text || !icon || (getComputedStyle(text).display === 'none') !== compact || (getComputedStyle(icon).display !== 'none') !== compact) throw new Error(label + ': incorrect responsive filter mode for ' + button.dataset.category);
            if (compact && (Math.abs(rect.width - 32) > 1 || Math.abs(rect.height - 24) > 1 || icon.getBoundingClientRect().width <= 0 || button.title !== button.getAttribute('aria-label'))) throw new Error(label + ': compact filter lost icon, dimensions, or accessible label for ' + button.dataset.category);
          }
          const controls = Array.from(container.querySelectorAll('button, input, select'));
          const rectangles = controls.map(control => {
            const rect = control.getBoundingClientRect();
            const painted = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            const name = control.getAttribute('aria-label') || root.querySelector('label[for="' + control.id + '"]')?.textContent.trim() || control.title;
            if (!name || control.disabled || rect.width <= 0 || rect.height <= 0 || rect.left < Math.max(0, bounds.left) - 1 || rect.right > Math.min(innerWidth, bounds.right) + 1 || rect.top < 0 || rect.bottom > innerHeight + 1 || !(painted === control || control.contains(painted))) throw new Error(label + ': control is unnamed, disabled, clipped or covered: ' + control.outerHTML);
            return { name, ...rect.toJSON() };
          });
          for (const [index, rect] of rectangles.entries()) {
            for (const other of rectangles.slice(index + 1)) {
              if (Math.min(rect.right, other.right) - Math.max(rect.left, other.left) > 1 && Math.min(rect.bottom, other.bottom) - Math.max(rect.top, other.top) > 1) throw new Error(label + ': overlapping controls: ' + rect.name + ' / ' + other.name);
            }
          }
          const tags = Array.from(root.querySelectorAll('[data-testid=cm-search-target-tag]'), tag => {
            const text = tag.querySelector('[data-testid=cm-search-target-label]');
            const textRect = text.getBoundingClientRect();
            const removeRect = tag.querySelector('[data-testid=cm-search-target-remove]').getBoundingClientRect();
            const rect = tag.getBoundingClientRect();
            if (textRect.width <= 0 || textRect.right > removeRect.left + 1 || textRect.left < rect.left || removeRect.right > rect.right + 1 || text.title !== text.textContent.trim()) throw new Error(label + ': tag text covers removal or loses its full label');
            return { label: text.textContent.trim(), truncated: text.scrollWidth > text.clientWidth, ellipsis: getComputedStyle(text).textOverflow, ...rect.toJSON() };
          });
          const scope = root.querySelector('[data-testid=cm-search-scope]').getBoundingClientRect();
          if (tags.length && tags[0].left >= scope.right - 1 && Math.abs(tags[0].top - scope.top) > 1) throw new Error(label + ': scope dropdown is not aligned with the first tag row: ' + JSON.stringify({ scopeTop: scope.top, tagTop: tags[0].top }));
          if (narrow && (manager.getBoundingClientRect().width > 461 || !tags.some(tag => tag.truncated && tag.ellipsis === 'ellipsis') || !tags.some(tag => tag.top > tags[0].bottom - 1))) throw new Error(label + ': long-label tags did not wrap at the narrow width');
          evidence.geometry[label] = { viewport: { width: innerWidth, height: innerHeight }, componentWidth: manager.getBoundingClientRect().width, scope: scope.toJSON(), controls: rectangles, tags };
          return evidence.geometry[label];
        };
        evidence.dialog = async label => {
          await manager.updateComplete;
          const dialog = root.querySelector('[data-testid=cm-search-target-dialog]');
          const bounds = dialog?.getBoundingClientRect();
          const footer = dialog?.querySelector('.modal-footer')?.getBoundingClientRect();
          const body = dialog?.querySelector('.modal-body')?.getBoundingClientRect();
          if (!dialog?.matches(':modal') || !bounds || bounds.width <= 0 || bounds.left < 0 || bounds.top < 0 || bounds.right > innerWidth + 1 || bounds.bottom > innerHeight + 1 || !footer || !body || body.bottom > footer.top + 1 || footer.bottom > bounds.bottom + 1) throw new Error(label + ': dialog or footer is clipped');
          for (const testId of ['cm-search-target-filter', 'cm-search-target-cancel', 'cm-search-target-apply']) {
            const control = dialog.querySelector('[data-testid=' + testId + ']');
            const rect = control.getBoundingClientRect();
            const painted = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (rect.width <= 0 || rect.height <= 0 || rect.left < bounds.left || rect.right > bounds.right + 1 || rect.top < bounds.top || rect.bottom > bounds.bottom + 1 || !(painted === control || control.contains(painted))) throw new Error(label + ': control is clipped or covered: ' + testId);
          }
          for (const checkbox of dialog.querySelectorAll('input[type=checkbox]')) {
            const rect = checkbox.getBoundingClientRect();
            const painted = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            if (rect.width <= 0 || rect.top < body.top || rect.bottom > body.bottom + 1 || rect.left < bounds.left || rect.right > bounds.right + 1 || painted !== checkbox) throw new Error(label + ': picker choice is clipped or covered: ' + checkbox.getAttribute('aria-label'));
          }
          if (dialog.scrollWidth > dialog.clientWidth + 2 || dialog.querySelector('.modal-content').scrollWidth > dialog.clientWidth + 2) throw new Error(label + ': dialog content overflows horizontally');
          evidence.geometry[label] = { viewport: { width: innerWidth, height: innerHeight }, componentWidth: manager.getBoundingClientRect().width, dialog: bounds.toJSON(), footer: footer.toJSON() };
          return evidence.geometry[label];
        };
        evidence.request = async (label, kind, targets, query, connectionCategory, bits, views = true) => {
          const actual = await evidence.bits(label + '-bits', bits, views);
          equal([actual.state.kind, actual.state.targets, actual.state.query], [kind, targets, query], label + ' live request inputs');
          const find = () => evidence.messages.slice(evidence.lastRequestIndex + 1).filter(message => message.type === 'search' && message.kind === kind && message.query === query && JSON.stringify(message.targets) === JSON.stringify(targets)).at(-1);
          await waitFor(() => find() && !manager._search.loading && !manager._search._searchDebounceTimer && evidence.responses.some(response => response.requestId === find().requestId && response.completed), label + ' real host terminal');
          const request = find();
          equal(request.scope, 'selected', label + ' request scope');
          equal(request.categories, { ...actual.state.categories, [kind === 'sql' ? 'servers' : 'clusters']: connectionCategory }, label + ' exact effective request categories');
          equal(request.contentToggles, actual.state.contentToggles, label + ' exact request content bits');
          equal(evidence.starts.find(start => start.requestId === request.requestId), { requestId: request.requestId, results: [], loading: true }, label + ' fresh search at dispatch');
          equal(manager._search.results, [], label + ' ownerless results');
          equal(root.querySelector('[data-testid=cm-search-results] .empty-state-title')?.textContent.trim(), 'No results', label + ' terminal UI');
          equal(root.querySelector('.search-result-count')?.textContent.trim(), '0 results', label + ' result count');
          evidence.lastRequestIndex = evidence.messages.indexOf(request);
          evidence.ui[label] = live();
          return clone(request);
        };
        evidence.mark = () => { evidence.actionIndex = evidence.messages.length; evidence.activeRequest = manager._search._activeRequestId; evidence.draftBaseline = { state: state(), results: clone(manager._search.results), messages: evidence.messages.filter(message => ['search', 'search.cancel', 'search.saveState'].includes(message.type)).length }; return clone(evidence.draftBaseline); };
        evidence.unchanged = async label => {
          await new Promise(resolve => setTimeout(resolve, 650));
          await manager.updateComplete;
          equal({ state: state(), results: clone(manager._search.results), messages: evidence.messages.filter(message => ['search', 'search.cancel', 'search.saveState'].includes(message.type)).length }, evidence.draftBaseline, label + ' changed committed state or emitted work');
          if (root.querySelector('[data-testid=cm-search-target-dialog]') || root.activeElement !== root.querySelector('[data-testid=cm-search-target-picker]')) throw new Error(label + ': dialog dismissal or focus restoration failed');
          evidence.ui[label] = live();
          return label;
        };
        evidence.removed = async (label, targets) => {
          await manager.updateComplete;
          const expected = { ...evidence.draftBaseline.state, targets };
          equal(state(), expected, label + ' removal changes only the exact target');
          const messages = evidence.messages.slice(evidence.actionIndex);
          if (!messages.some(message => message.type === 'search.saveState' && JSON.stringify(project(message.state)) === JSON.stringify(expected))) throw new Error(label + ': removal did not immediately save');
          if (evidence.activeRequest && !messages.some(message => message.type === 'search.cancel' && message.requestId === evidence.activeRequest)) throw new Error(label + ': removal did not cancel the old request');
          if (root.querySelector('[data-testid=cm-search-target-dialog]') || root.activeElement !== (root.querySelector('[data-testid=cm-search-target-remove]') ?? root.querySelector('[data-testid=cm-search-target-picker]'))) throw new Error(label + ': removal opened the picker or lost focus');
          if (!targets.length) {
            await new Promise(resolve => setTimeout(resolve, 650));
            equal([manager._search.results, manager._search.loading, manager._search._searchDebounceTimer, manager._search._activeRequestId], [[], false, null, null], label + ' empty selection retires work');
            if (evidence.messages.slice(evidence.actionIndex).some(message => message.type === 'search')) throw new Error(label + ': empty selection started a search');
          }
          evidence.ui[label] = live();
          return evidence.ui[label];
        };
        evidence.save = async label => {
          const expected = state();
          await waitFor(() => !manager._search._saveDebounceTimer && evidence.messages.some(message => message.type === 'search.saveState' && JSON.stringify(project(message.state)) === JSON.stringify(expected)), label + ' real saveState transport');
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const revision = manager._snapshot.revision;
            manager.postMessage({ type: 'requestSnapshot' });
            await waitFor(() => manager._snapshot.revision > revision, label + ' newer host snapshot');
            const saved = manager._snapshot.searchState;
            if (saved && JSON.stringify(project(saved)) === JSON.stringify(expected)) {
              equal(saved.lastResults, [], label + ' saved ownerless results');
              evidence.saved[label] = clone({ source: 'host snapshot.searchState', activeKind: manager._snapshot.activeKind, revision: manager._snapshot.revision, searchState: saved });
              return evidence.saved[label];
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(label + ': host did not restore the committed search state');
        };
        evidence.equal = equal;
        evidence.live = live;
        evidence.waitFor = waitFor;
        window.__cmSearchEvidence = evidence;
        return { initialHostInventory: { kusto: initial.connections.length, sql: initial.sqlConnections?.length ?? 0 }, metadata, searchStateInjected: false };
      })()
      """
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (!root.querySelector('[data-testid=cm-filter-all].active') || root.querySelector('[data-testid=cm-breadcrumb-back]')) throw new Error('All should be active without a Back button at root'); return 'root browser controls ready'; })()" in the webview
    When I click "[data-testid='cm-kusto-connection-row'][data-connection-id='cm-e2e-kusto-a']" in the webview
    And I wait for "[data-testid='cm-breadcrumb-back']" in the webview
    When I click ".explorer-list-item:has(> .explorer-list-item-icon.database)" in the webview
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); const crumbs = Array.from(manager.shadowRoot.querySelectorAll('.breadcrumb-item'), crumb => crumb.textContent.trim()); window.__cmSearchEvidence.equal(crumbs, ['All', 'Cluster A', 'A1'], 'database breadcrumb'); window.__cmSearchEvidence.browser.push(crumbs); return crumbs; })()" in the webview
    When I click "[data-testid='cm-breadcrumb-back']" in the webview
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); window.__cmSearchEvidence.equal(manager._explorerPath, { connectionId: 'cm-e2e-kusto-a' }, 'database Back'); return 'Back returned to Cluster A'; })()" in the webview
    When I click "[data-testid='cm-breadcrumb-back']" in the webview
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); if (manager._explorerPath !== null || manager.shadowRoot.querySelector('[data-testid=cm-breadcrumb-back]')) throw new Error('Back did not return to root'); return 'root Back button hidden'; })()" in the webview

    When I click "[data-testid='cm-filter-search']" in the webview
    And I wait for "[data-testid='cm-search-scope']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; const container = root.querySelector('[data-testid=cm-search-container]'); if (container.firstElementChild?.textContent.trim() !== 'Where to search') throw new Error('Where to search must be first'); const scope = root.querySelector('[data-testid=cm-search-scope]'); window.__cmSearchEvidence.equal(Array.from(scope.options, option => [option.value, option.textContent.trim()]), [['selected', 'Specific cluster(s) or database(s)'], ['cached', 'All cached connections (fast)'], ['everything', 'All connections (slow)']], 'exact scope options'); return 'progressive Search starts with scope'; })()" in the webview
    When I evaluate "window.__cmSearchEvidence.view('selected-empty', 'kusto', 'selected', [], '', [])" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-empty-defaults', [true, false, true, false])" in the webview
    When I evaluate "window.__cmSearchEvidence.layout('scope-first-controls')" in the webview
    Then I take a screenshot "01-search-scope-first"

    When I focus "[data-testid='cm-search-scope']" in the webview
    When I press "Home"
    When I press "ArrowDown"
    When I press "Tab"
    When I evaluate "window.__cmSearchEvidence.view('cached', 'kusto', 'cached', [], '', ['clusters', 'databases', 'tables', 'tableColumns', 'functions', 'functionBody'])" in the webview
    When I focus "[data-testid='cm-search-scope']" in the webview
    When I press "End"
    When I press "Tab"
    When I evaluate "window.__cmSearchEvidence.view('everything', 'kusto', 'everything', [], '', ['clusters', 'databases', 'tables', 'tableColumns', 'functions', 'functionBody'])" in the webview
    When I focus "[data-testid='cm-search-scope']" in the webview
    When I press "Home"
    When I press "Tab"
    When I evaluate "window.__cmSearchEvidence.view('selected-again', 'kusto', 'selected', [], '', [])" in the webview

    When I click "[data-testid='cm-search-target-picker']" in the webview
    And I wait for "[data-testid='cm-search-target-dialog'][open]" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (root.activeElement !== root.querySelector('[data-testid=cm-search-target-filter]')) throw new Error('Picker filter should receive focus: ' + JSON.stringify({ active: root.activeElement?.outerHTML, documentActive: document.activeElement?.tagName, focused: document.hasFocus() })); return 'picker filter focused'; })()" in the webview
    When I click "[data-testid='cm-search-target-cluster'][data-connection-id='cm-e2e-kusto-a']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-kusto-a']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-kusto-b']" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-kusto-b'][data-database='B1']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; const whole = root.querySelector('[data-testid=cm-search-target-cluster][data-connection-id=cm-e2e-kusto-a]'); const partial = root.querySelector('[data-testid=cm-search-target-cluster][data-connection-id=cm-e2e-kusto-b]'); const databases = Array.from(root.querySelectorAll('[data-testid=cm-search-target-database]'), input => [input.dataset.database, input.checked]); if (!whole.checked || partial.checked || !partial.indeterminate || partial.getAttribute('aria-checked') !== 'mixed') throw new Error('Whole-cluster and mixed checkbox states are wrong'); window.__cmSearchEvidence.equal(databases, [['A1', true], ['A2', true], ['B1', true], ['B2', false]], 'mixed picker databases'); window.__cmSearchEvidence.equal(document.querySelector('kw-connection-manager')._search.targets, [], 'draft must not commit early'); return 'whole A plus B1 draft'; })()" in the webview
    When I click "[data-testid='cm-search-target-filter']" in the webview
    When I type "B1"
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; window.__cmSearchEvidence.equal(Array.from(root.querySelectorAll('[data-testid=cm-search-target-cluster]'), input => input.dataset.connectionId), ['cm-e2e-kusto-b'], 'database filter cluster'); window.__cmSearchEvidence.equal(Array.from(root.querySelectorAll('[data-testid=cm-search-target-database]'), input => input.dataset.database), ['B1'], 'database filter leaf'); return 'picker filter keeps only B1'; })()" in the webview
    When I press "Ctrl+A"
    When I press "Backspace"
    When I evaluate "window.__cmSearchEvidence.dialog('desktop-mixed-picker')" in the webview
    Then I take a screenshot "02-search-mixed-picker"
    When I click "[data-testid='cm-search-target-apply']" in the webview
    When I evaluate "window.__cmSearchEvidence.view('mixed', 'kusto', 'selected', [{ connectionId: 'cm-e2e-kusto-a' }, { connectionId: 'cm-e2e-kusto-b', database: 'B1' }], '', ['clusters', 'databases', 'tables', 'tableColumns', 'functions', 'functionBody'], ['Cluster A (all databases)', 'Cluster B / B1'])" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-names-only', [true, false, true, false])" in the webview

    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-tables-both', [true, true, true, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tables']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-columns-only', [false, true, true, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-tables-off', [false, false, true, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-columns-restored', [false, true, true, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='functionBody']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-functions-both', [false, true, true, true])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='functions']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-body-only', [false, true, false, true])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='functionBody']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-functions-off', [false, true, false, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='functionBody']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-content-only', [false, true, false, true])" in the webview
    When I evaluate "(() => { if (window.__cmSearchEvidence.messages.some(message => message.type === 'search') || window.__cmSearchEvidence.live().query !== '') throw new Error('Truth-state controls or empty broad scopes started a search'); return 'both four-state matrices used only real controls before typing'; })()" in the webview
    When I evaluate "window.__cmSearchEvidence.layout('desktop-kusto-all-controls')" in the webview
    Then I take a screenshot "03-search-kusto-tags-independent-bits"

    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-remove'][data-connection-id='cm-e2e-kusto-a'][data-database='']" in the webview
    When I evaluate "window.__cmSearchEvidence.removed('remove-whole-kusto-a', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }])" in the webview
    When I evaluate "window.__cmSearchEvidence.view('database-only-before-query', 'kusto', 'selected', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], '', ['databases', 'tables', 'tableColumns', 'functions', 'functionBody'], ['Cluster B / B1'])" in the webview
    When I click "[data-testid='cm-search-input']" in the webview
    When I type "cm-kusto-db-only"
    When I evaluate "window.__cmSearchEvidence.request('database-only-typed-query', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-db-only', false, [false, true, false, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.request('columns-off-rerun', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-db-only', false, [false, false, false, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.request('columns-on-rerun', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-db-only', false, [false, true, false, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='functionBody']" in the webview
    When I evaluate "window.__cmSearchEvidence.request('body-off-rerun', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-db-only', false, [false, true, false, false])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='functionBody']" in the webview
    When I evaluate "window.__cmSearchEvidence.request('body-on-rerun', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-db-only', false, [false, true, false, true])" in the webview for 20 seconds

    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (root.querySelector('[data-testid=cm-search-target-cluster][data-connection-id=cm-e2e-kusto-a]').checked || !root.querySelector('[data-testid=cm-search-target-database][data-connection-id=cm-e2e-kusto-b][data-database=B1]').checked || root.querySelector('[data-testid=cm-search-target-database][data-connection-id=cm-e2e-kusto-b][data-database=B2]').checked) throw new Error('Plus did not retain only B1 after removing A'); return 'remaining database is prechecked'; })()" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-kusto-b'][data-database='B2']" in the webview
    When I click "[data-testid='cm-search-target-cancel']" in the webview
    When I evaluate "window.__cmSearchEvidence.unchanged('cancel-draft')" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (!root.querySelector('[data-testid=cm-search-target-database][data-database=B1]').checked || root.querySelector('[data-testid=cm-search-target-database][data-database=B2]').checked) throw new Error('Cancelled B2 draft returned'); return 'committed B1 restored in picker'; })()" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-kusto-b'][data-database='B1']" in the webview
    When I press "Escape"
    When I evaluate "window.__cmSearchEvidence.unchanged('escape-draft')" in the webview

    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-kusto-b'][data-database='B2']" in the webview
    When I click "[data-testid='cm-search-target-apply']" in the webview
    When I evaluate "window.__cmSearchEvidence.request('two-databases-request', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }, { connectionId: 'cm-e2e-kusto-b', database: 'B2' }], 'cm-kusto-db-only', false, [false, true, false, true])" in the webview for 20 seconds
    When I evaluate "window.__cmSearchEvidence.view('same-parent-tags', 'kusto', 'selected', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }, { connectionId: 'cm-e2e-kusto-b', database: 'B2' }], 'cm-kusto-db-only', ['databases', 'tables', 'tableColumns', 'functions', 'functionBody'], ['Cluster B / B1', 'Cluster B / B2'])" in the webview
    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-remove'][data-connection-id='cm-e2e-kusto-b'][data-database='B1']" in the webview
    When I evaluate "window.__cmSearchEvidence.removed('remove-only-b1', [{ connectionId: 'cm-e2e-kusto-b', database: 'B2' }])" in the webview
    When I evaluate "window.__cmSearchEvidence.request('same-parent-b2-survives', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B2' }], 'cm-kusto-db-only', false, [false, true, false, true])" in the webview for 20 seconds
    When I evaluate "window.__cmSearchEvidence.view('only-b2-tag', 'kusto', 'selected', [{ connectionId: 'cm-e2e-kusto-b', database: 'B2' }], 'cm-kusto-db-only', ['databases', 'tables', 'tableColumns', 'functions', 'functionBody'], ['Cluster B / B2'])" in the webview
    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-remove'][data-connection-id='cm-e2e-kusto-b'][data-database='B2']" in the webview
    When I evaluate "window.__cmSearchEvidence.removed('remove-last-tag', [])" in the webview
    When I evaluate "window.__cmSearchEvidence.view('cleared-with-retained-query', 'kusto', 'selected', [], 'cm-kusto-db-only', [])" in the webview
    When I evaluate "window.__cmSearchEvidence.layout('last-tag-only-scope-plus')" in the webview

    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-kusto-b']" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-kusto-b'][data-database='B1']" in the webview
    When I click "[data-testid='cm-search-target-apply']" in the webview
    When I evaluate "window.__cmSearchEvidence.request('reselected-remembered-query', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-db-only', false, [false, true, false, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-input']" in the webview
    When I press "Ctrl+A"
    When I type "cm-kusto-persist"
    When I evaluate "window.__cmSearchEvidence.request('kusto-save-request', 'kusto', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-persist', false, [false, true, false, true])" in the webview for 20 seconds
    When I evaluate "window.__cmSearchEvidence.save('kusto')" in the webview for 40 seconds

    When I click "[data-testid='cm-filter-all']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (root.querySelector('[data-testid=cm-search-container]') || !root.querySelector('[data-testid=cm-filter-all].active')) throw new Error('All did not leave Search'); return 'All browser restored'; })()" in the webview
    When I click "button[title='SQL']" in the webview
    And I wait for "[data-testid='cm-sql-filter-search']" in the webview
    When I click "[data-testid='cm-sql-filter-search']" in the webview
    When I evaluate "window.__cmSearchEvidence.view('sql-selected-empty', 'sql', 'selected', [], '', [])" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-defaults-no-kusto-leak', [true, false])" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-cluster'][data-connection-id='cm-e2e-sql-a']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-sql-b']" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-sql-b'][data-database='B1']" in the webview
    When I click "[data-testid='cm-search-target-apply']" in the webview
    When I evaluate "window.__cmSearchEvidence.view('sql-mixed', 'sql', 'selected', [{ connectionId: 'cm-e2e-sql-a' }, { connectionId: 'cm-e2e-sql-b', database: 'B1' }], '', ['servers', 'databases', 'tables', 'tableColumns', 'views', 'storedProcedures'], ['Server A - North America production analytics and reporting warehouse (all databases)', 'Server B / B1'])" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-names-only', [true, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-tables-both', [true, true])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tables']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-columns-only', [false, true])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-tables-off', [false, false])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-columns-restored', [false, true])" in the webview
    When I click "[data-testid='cm-search-category'][data-category='views']" in the webview
    When I evaluate "(() => { const chip = document.querySelector('kw-connection-manager').shadowRoot.querySelector('[data-testid=cm-search-category][data-category=views]'); if (chip.getAttribute('aria-pressed') !== 'true' || !chip.classList.contains('content-on')) throw new Error('SQL Views lost its legacy names-and-columns state'); return 'Views legacy content state retained'; })()" in the webview
    When I click "[data-testid='cm-search-category'][data-category='views']" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('sql-columns-only-views-disabled', [false, true], false)" in the webview
    When I click "[data-testid='cm-search-input']" in the webview
    When I type "cm-sql-persist"
    When I evaluate "window.__cmSearchEvidence.request('sql-mixed-request', 'sql', [{ connectionId: 'cm-e2e-sql-a' }, { connectionId: 'cm-e2e-sql-b', database: 'B1' }], 'cm-sql-persist', true, [false, true], false)" in the webview for 20 seconds
    When I evaluate "(async () => { const manager = document.querySelector('kw-connection-manager'); manager.style.maxWidth = '720px'; manager.style.marginInline = 'auto'; const geometry = await window.__cmSearchEvidence.layout('wrapped-tags-beside-scope'); if (geometry.tags.length < 2 || geometry.tags[0].left < geometry.scope.right || !geometry.tags.some(tag => tag.top > geometry.tags[0].bottom - 1)) throw new Error('Expected multiple tag rows beside the scope dropdown'); return geometry; })()" in the webview
    Then I take a screenshot "04a-search-wrapped-tags-aligned"
    When I resize the Dev Host to 700 by 650
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); manager.style.maxWidth = '460px'; manager.style.marginInline = 'auto'; return 'narrow component constraint only; search state unchanged'; })()" in the webview
    When I evaluate "window.__cmSearchEvidence.layout('narrow-sql-long-tag-all-controls', true)" in the webview
    Then I take a screenshot "04-search-narrow-long-tags-controls"
    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-sql-a']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; window.__cmSearchEvidence.equal(Array.from(root.querySelectorAll('[data-testid=cm-search-target-database]'), input => [input.dataset.database, input.checked]), [['A1', true], ['A2', true], ['B1', true], ['B2', false]], 'SQL mixed prechecked draft'); return 'SQL plus preserves the whole server and B1'; })()" in the webview
    When I evaluate "window.__cmSearchEvidence.dialog('narrow-sql-picker')" in the webview
    When I click "[data-testid='cm-search-target-cancel']" in the webview
    When I evaluate "window.__cmSearchEvidence.unchanged('sql-narrow-picker-cancel')" in the webview
    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-remove'][data-connection-id='cm-e2e-sql-a'][data-database='']" in the webview
    When I evaluate "window.__cmSearchEvidence.removed('remove-whole-sql-a', [{ connectionId: 'cm-e2e-sql-b', database: 'B1' }])" in the webview
    When I evaluate "window.__cmSearchEvidence.request('sql-database-only-request', 'sql', [{ connectionId: 'cm-e2e-sql-b', database: 'B1' }], 'cm-sql-persist', false, [false, true], false)" in the webview for 20 seconds
    When I evaluate "window.__cmSearchEvidence.view('sql-database-only', 'sql', 'selected', [{ connectionId: 'cm-e2e-sql-b', database: 'B1' }], 'cm-sql-persist', ['databases', 'tables', 'tableColumns', 'views', 'storedProcedures'], ['Server B / B1'])" in the webview
    When I evaluate "window.__cmSearchEvidence.mark()" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-sql-b'][data-database='B2']" in the webview
    When I click "[data-testid='cm-search-target-cancel']" in the webview
    When I evaluate "window.__cmSearchEvidence.unchanged('sql-cancel-draft')" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-sql-b'][data-database='B1']" in the webview
    When I press "Escape"
    When I evaluate "window.__cmSearchEvidence.unchanged('sql-escape-draft')" in the webview
    When I evaluate "window.__cmSearchEvidence.save('sql')" in the webview for 40 seconds

    When I click "button[title='Kusto']" in the webview
    And I wait for "[data-testid='cm-filter-search'].active" in the webview
    When I evaluate "window.__cmSearchEvidence.view('kusto-after-sql', 'kusto', 'selected', [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }], 'cm-kusto-persist', ['databases', 'tables', 'tableColumns', 'functions', 'functionBody'], ['Cluster B / B1'])" in the webview
    When I evaluate "window.__cmSearchEvidence.bits('kusto-after-sql-no-bit-leak', [false, true, false, true])" in the webview
    When I evaluate "window.__cmSearchEvidence.save('kusto-after-sql')" in the webview for 40 seconds
    When I resize the Dev Host to 1000 by 700
    When I evaluate "(() => { const manager = document.querySelector('kw-connection-manager'); manager.style.maxWidth = ''; manager.style.marginInline = ''; return 'desktop component restored'; })()" in the webview
    Then I collect JSON artifact "cm-search-saved-host-projections" from webview expression "window.__cmSearchEvidence.saved"
    Then I collect JSON artifact "cm-search-emitted-requests" from webview expression:
      """
      (() => {
        const evidence = window.__cmSearchEvidence;
        const searches = evidence.messages.filter(message => message.type === 'search');
        if (!searches.length || searches.some(message => message.scope !== 'selected' || !message.targets?.length || message.targets.some(target => !['cm-e2e-kusto-a', 'cm-e2e-kusto-b', 'cm-e2e-sql-a', 'cm-e2e-sql-b'].includes(target.connectionId)))) throw new Error('A search escaped the ownerless selected fixture');
        return { searches, starts: evidence.starts, saves: evidence.messages.filter(message => message.type === 'search.saveState'), cancellations: evidence.messages.filter(message => message.type === 'search.cancel'), hostTerminals: evidence.responses };
      })()
      """
    Then I collect JSON artifact "cm-search-live-ui" from webview expression "({ checkpoints: window.__cmSearchEvidence.ui, geometry: window.__cmSearchEvidence.geometry, browser: window.__cmSearchEvidence.browser })"
    Then I collect JSON artifact "cm-search-reload-command" from extension host expression:
      """
      (async () => {
        const command = 'workbench.action.webview.reloadWebviewAction';
        const commands = await vscode.commands.getCommands(true);
        if (!commands.includes(command)) throw new Error('Developer: Reload Webviews is unavailable; report this before substituting Reload Window');
        return { command, available: true, vscodeVersion: vscode.version };
      })()
      """
    When I execute command "workbench.action.webview.reloadWebviewAction"
    And I wait for "[data-testid='cm-filter-all'].active" in the webview for 20 seconds
    When I click "[data-testid='cm-filter-search']" in the webview
    And I wait for "[data-testid='cm-search-input']" in the webview for 20 seconds
    Then I collect JSON artifact "cm-search-restored-before-metadata" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        await manager.updateComplete;
        const root = manager.shadowRoot;
        const snapshot = manager._snapshot;
        if (window.__cmSearchEvidence || manager._search._editedKinds.size || !snapshot || snapshot.connections.length || snapshot.sqlConnections?.length) throw new Error('Expected a fresh, unedited webview with undecorated host inventory');
        const expectedTargets = [{ connectionId: 'cm-e2e-kusto-b', database: 'B1' }];
        for (const state of [snapshot.searchState, manager._search]) {
          if (state?.kind !== 'kusto' || state.scope !== 'selected' || state.query !== 'cm-kusto-persist' || JSON.stringify(state.targets) !== JSON.stringify(expectedTargets) || JSON.stringify(state.contentToggles) !== JSON.stringify({ tables: true, functions: true }) || JSON.stringify(state.categories) !== JSON.stringify({ clusters: true, databases: true, tables: false, functions: false })) throw new Error('Content-only Kusto state was not restored from the host: ' + JSON.stringify(state));
        }
        const categories = Array.from(root.querySelectorAll('[data-testid=cm-search-category]'), chip => [chip.dataset.category, chip.getAttribute('aria-pressed'), chip.disabled, chip.classList.contains('content-on')]);
        const query = root.querySelector('[data-testid=cm-search-input]').value;
        const scope = root.querySelector('[data-testid=cm-search-scope]').value;
        const tags = Array.from(root.querySelectorAll('[data-testid=cm-search-target-tag]'), tag => [tag.dataset.connectionId, tag.dataset.database, tag.querySelector('[data-testid=cm-search-target-label]')?.textContent.trim(), tag.title]);
        if (query !== 'cm-kusto-persist' || scope !== 'selected' || JSON.stringify(tags) !== JSON.stringify([['cm-e2e-kusto-b', 'B1', 'cm-e2e-kusto-b / B1', 'cm-e2e-kusto-b / B1']]) || JSON.stringify(categories) !== JSON.stringify([['databases', 'true', false, false], ['tables', 'false', false, false], ['tableColumns', 'true', false, false], ['functions', 'false', false, false], ['functionBody', 'true', false, false]])) throw new Error('Fresh tags and independent controls did not restore before metadata decoration');
        const proof = JSON.parse(JSON.stringify({ source: 'fresh host snapshot.searchState before metadata decoration', searchState: snapshot.searchState, live: { query, scope, tags, categories } }));
        window.__cmReloadProof = { beforeMetadata: proof, messages: [], starts: [], responses: [], host: {}, live: {}, geometry: {}, lastRequestIndex: -1 };
        return proof;
      })()
      """
    Then I collect JSON artifact "cm-search-reloaded-metadata" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        const root = manager.shadowRoot;
        const proof = window.__cmReloadProof;
        const clone = value => JSON.parse(JSON.stringify(value));
        const metadata = {
          connections: [
            { id: 'cm-e2e-kusto-a', name: 'Cluster A', clusterUrl: 'https://cm-e2e-kusto-a.invalid', database: '' },
            { id: 'cm-e2e-kusto-b', name: 'Cluster B', clusterUrl: 'https://cm-e2e-kusto-b.invalid', database: '' }
          ],
          cachedDatabases: { 'cm-e2e-kusto-a': ['A1', 'A2'], 'cm-e2e-kusto-b': ['B1', 'B2'] },
          sqlConnections: [
            { id: 'cm-e2e-sql-a', name: 'Server A - North America production analytics and reporting warehouse', serverUrl: 'cm-e2e-sql-a.invalid', dialect: 'mssql', authType: 'aad' },
            { id: 'cm-e2e-sql-b', name: 'Server B', serverUrl: 'cm-e2e-sql-b.invalid', dialect: 'mssql', authType: 'aad' }
          ],
          sqlCachedDatabases: { 'cm-e2e-sql-a': ['A1', 'A2'], 'cm-e2e-sql-b': ['B1', 'B2'] }
        };
        const equal = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ': ' + JSON.stringify({ actual, expected })); };
        const project = state => clone({ kind: state.kind, scope: state.scope, targets: state.targets ?? [], query: state.query, categories: state.categories, contentToggles: state.contentToggles });
        const expected = (kind, database, bits = kind === 'kusto' ? [false, true, false, true] : [false, true]) => ({ kind, scope: 'selected', targets: database === null ? [] : [{ connectionId: 'cm-e2e-' + kind + '-b', database }], query: 'cm-' + kind + '-persist', categories: kind === 'kusto' ? { clusters: true, databases: true, tables: bits[0], functions: bits[2] } : { servers: true, databases: true, tables: bits[0], views: false, storedProcedures: true }, contentToggles: kind === 'kusto' ? { tables: bits[1], functions: bits[3] } : { tables: bits[1], views: false, storedProcedures: false } });
        const waitFor = async (predicate, label) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            await manager.updateComplete;
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Timed out: ' + label);
        };
        const forward = manager.postMessage.bind(manager);
        manager.postMessage = message => {
          proof.messages.push(clone(message));
          if (message.type === 'search') proof.starts.push(clone({ requestId: message.requestId, results: manager._search.results, loading: manager._search.loading }));
          return forward(message);
        };
        window.addEventListener('message', event => {
          const payload = event.data?.type === 'kustoPublicationStage' ? event.data.payload : event.data;
          if (payload?.type === 'searchResults') proof.responses.push(clone(payload));
          if (payload?.type === 'snapshot') Object.assign(payload.snapshot, clone(metadata));
        }, true);
        const searchStateBefore = clone(manager._snapshot.searchState);
        manager._snapshot = { ...manager._snapshot, ...clone(metadata) };
        manager.requestUpdate();
        await manager.updateComplete;
        equal(manager._snapshot.searchState, searchStateBefore, 'Metadata decoration changed host Search state');
        proof.inspect = (label, kind, database, bits) => {
          const state = project(manager._search);
          const wanted = expected(kind, database, bits);
          equal(state, wanted, label + ' exact live state without foreign bits');
          equal(root.querySelector('[data-testid=cm-explorer-panel]').dataset.testKind, kind, label + ' active kind');
          equal(root.querySelector('[data-testid=cm-search-scope]')?.value, 'selected', label + ' live scope');
          equal(root.querySelector('[data-testid=cm-search-input]')?.value ?? null, database === null ? null : state.query, label + ' progressive live query');
          equal([!!root.querySelector('[data-testid=cm-search-categories]'), !!root.querySelector('[data-testid=cm-search-results]')], [database !== null, database !== null], label + ' progressive controls');
          const tags = Array.from(root.querySelectorAll('[data-testid=cm-search-target-tag]'), tag => {
            const text = tag.querySelector('[data-testid=cm-search-target-label]');
            const remove = tag.querySelector('[data-testid=cm-search-target-remove]');
            return { connectionId: tag.dataset.connectionId, database: tag.dataset.database, label: text?.textContent.trim() ?? null, title: tag.title, labelTitle: text?.title ?? null, removeConnectionId: remove?.dataset.connectionId ?? null, removeDatabase: remove?.dataset.database ?? null, removeLabel: remove?.getAttribute('aria-label') ?? null, removeTitle: remove?.title ?? null };
          });
          const tagLabel = (kind === 'kusto' ? 'Cluster B / ' : 'Server B / ') + database;
          equal(tags, wanted.targets.map(target => ({ connectionId: target.connectionId, database, label: tagLabel, title: tagLabel, labelTitle: tagLabel, removeConnectionId: target.connectionId, removeDatabase: database, removeLabel: 'Remove ' + tagLabel, removeTitle: 'Remove ' + tagLabel })), label + ' live tag identity and labels');
          const picker = root.querySelector('[data-testid=cm-search-target-picker]');
          if (!picker || root.querySelector('[data-testid=cm-search-targets]')?.lastElementChild !== picker) throw new Error(label + ': plus must follow restored tags');
          equal(picker?.getAttribute('aria-label'), kind === 'kusto' ? 'Add clusters or databases' : 'Add servers or databases', label + ' accessible plus');
          const categories = Array.from(root.querySelectorAll('[data-testid=cm-search-category]'), chip => ({ id: chip.dataset.category, active: chip.getAttribute('aria-pressed'), content: chip.classList.contains('content-on'), disabled: chip.disabled }));
          const ids = database === null ? [] : kind === 'kusto' ? ['databases', 'tables', 'tableColumns', 'functions', 'functionBody'] : ['databases', 'tables', 'tableColumns', 'views', 'storedProcedures'];
          equal(categories, ids.map(id => ({ id, active: String(id === 'tableColumns' ? wanted.contentToggles.tables : id === 'functionBody' ? wanted.contentToggles.functions : wanted.categories[id]), content: false, disabled: false })), label + ' enabled independent buttons');
          const controls = Array.from(root.querySelector('[data-testid=cm-search-container]').querySelectorAll('button, input, select'), control => {
            const rect = control.getBoundingClientRect();
            const painted = root.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
            const name = control.getAttribute('aria-label') || root.querySelector('label[for="' + control.id + '"]')?.textContent.trim() || control.title;
            if (!name || control.disabled || rect.width <= 0 || rect.height <= 0 || rect.left < 0 || rect.right > innerWidth + 1 || rect.top < 0 || rect.bottom > innerHeight + 1 || !(painted === control || control.contains(painted))) throw new Error(label + ': restored control is unnamed, disabled, clipped or covered: ' + control.outerHTML);
            return { name, ...rect.toJSON() };
          });
          proof.geometry[label] = { viewport: { width: innerWidth, height: innerHeight }, controls };
          proof.live[label] = { state, scope: 'selected', query: database === null ? null : state.query, tags, categories };
          return proof.live[label];
        };
        proof.settled = async (label, kind, database, bits) => {
          const wanted = expected(kind, database, bits);
          const offset = proof.lastRequestIndex + 1;
          const find = () => proof.messages.slice(offset).filter(message => message.type === 'search' && message.kind === kind && message.query === wanted.query && JSON.stringify(message.targets) === JSON.stringify(wanted.targets)).at(-1);
          await waitFor(() => find() && !manager._search.loading && !manager._search._searchDebounceTimer && proof.responses.some(response => response.requestId === find().requestId && response.completed), label + ' post-reload real terminal');
          const request = find();
          equal([request.scope, request.categories, request.contentToggles], ['selected', { ...wanted.categories, [kind === 'kusto' ? 'clusters' : 'servers']: false }, wanted.contentToggles], label + ' exact post-reload request bits');
          equal(proof.starts.find(start => start.requestId === request.requestId), { requestId: request.requestId, results: [], loading: true }, label + ' fresh post-reload dispatch');
          equal(manager._search.results, [], 'post-reload ownerless results');
          equal(root.querySelector('.search-result-count')?.textContent.trim(), '0 results', 'post-reload result count');
          equal(root.querySelector('[data-testid=cm-search-results] .empty-state-title')?.textContent.trim(), 'No results', 'post-reload terminal UI');
          if (!proof.messages.slice(offset).some(message => message.type === 'search.saveState' && JSON.stringify(project(message.state)) === JSON.stringify(wanted))) throw new Error(label + ': post-reload control did not emit saveState');
          proof.lastRequestIndex = proof.messages.indexOf(request);
          return proof.inspect(label, kind, database, bits);
        };
        proof.mark = () => { proof.actionIndex = proof.messages.length; return project(manager._search); };
        proof.removed = async (label, kind) => {
          await manager.updateComplete;
          const actual = proof.inspect(label, kind, null);
          if (!proof.messages.slice(proof.actionIndex).some(message => message.type === 'search.saveState' && JSON.stringify(project(message.state)) === JSON.stringify(expected(kind, null)))) throw new Error(label + ': restored removal did not immediately save');
          if (root.querySelector('[data-testid=cm-search-target-dialog]') || root.activeElement !== root.querySelector('[data-testid=cm-search-target-picker]')) throw new Error(label + ': restored removal lost plus focus');
          await new Promise(resolve => setTimeout(resolve, 650));
          equal([manager._search.results, manager._search.loading, manager._search._activeRequestId, manager._search._searchDebounceTimer], [[], false, null, null], label + ' empty restored scope is idle');
          if (proof.messages.slice(proof.actionIndex).some(message => message.type === 'search')) throw new Error(label + ': restored empty selection started a search');
          return actual;
        };
        proof.readHost = async (label, kind, database, bits) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            const revision = manager._snapshot.revision;
            manager.postMessage({ type: 'requestSnapshot' });
            await waitFor(() => manager._snapshot.revision > revision, label + ' newer host snapshot');
            const hostState = manager._snapshot.searchState;
            if (hostState && JSON.stringify(project(hostState)) === JSON.stringify(expected(kind, database, bits))) {
              equal(hostState.lastResults, [], label + ' host results');
              proof.host[label] = clone({ source: 'host snapshot.searchState', activeKind: manager._snapshot.activeKind, revision: manager._snapshot.revision, searchState: hostState });
              return proof.inspect(label, kind, database, bits);
            }
            await new Promise(resolve => setTimeout(resolve, 100));
          }
          throw new Error(label + ': saved host projection did not match');
        };
        proof.waitFor = waitFor;
        proof.inspect('kusto-restored', 'kusto', 'B1');
        return { decoratedFields: Object.keys(metadata), hostSearchStateUnchanged: true, live: proof.live['kusto-restored'] };
      })()
      """
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (!root.querySelector('[data-testid=cm-search-target-database][data-connection-id=cm-e2e-kusto-b][data-database=B1]').checked || root.querySelector('[data-testid=cm-search-target-database][data-connection-id=cm-e2e-kusto-b][data-database=B2]').checked) throw new Error('Restored Kusto picker did not select B1 only'); return 'restored Kusto picker is editable'; })()" in the webview
    When I press "Escape"
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (root.querySelector('[data-testid=cm-search-target-dialog]') || root.activeElement !== root.querySelector('[data-testid=cm-search-target-picker]')) throw new Error('Restored picker Escape lost plus focus'); return window.__cmReloadProof.inspect('kusto-restored-picker-dismissed', 'kusto', 'B1'); })()" in the webview
    When I evaluate "window.__cmReloadProof.mark()" in the webview
    When I click "[data-testid='cm-search-target-remove'][data-connection-id='cm-e2e-kusto-b'][data-database='B1']" in the webview
    When I evaluate "window.__cmReloadProof.removed('kusto-last-tag-after-reload', 'kusto')" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-kusto-b']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (Array.from(root.querySelectorAll('[data-testid=cm-search-target-database]')).some(input => input.checked)) throw new Error('Removed Kusto B1 remained selected in the reopened picker'); return 'restored empty scope has no prechecked databases'; })()" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-kusto-b'][data-database='B2']" in the webview
    When I click "[data-testid='cm-search-target-apply']" in the webview
    When I evaluate "window.__cmReloadProof.settled('kusto-reselected-after-reload', 'kusto', 'B2')" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='tables']" in the webview
    When I evaluate "window.__cmReloadProof.settled('kusto-names-on-after-reload', 'kusto', 'B2', [true, true, false, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmReloadProof.settled('kusto-columns-off-after-reload', 'kusto', 'B2', [true, false, false, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='functions']" in the webview
    When I evaluate "window.__cmReloadProof.settled('kusto-function-names-on-after-reload', 'kusto', 'B2', [true, false, true, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='functionBody']" in the webview
    When I evaluate "window.__cmReloadProof.settled('kusto-body-off-after-reload', 'kusto', 'B2', [true, false, true, false])" in the webview for 20 seconds
    When I evaluate "window.__cmReloadProof.readHost('kusto-after-edit', 'kusto', 'B2', [true, false, true, false])" in the webview for 40 seconds
    When I click "button[title='SQL']" in the webview
    And I wait for "[data-testid='cm-sql-filter-search'].active" in the webview
    When I evaluate "(() => { if (document.querySelector('kw-connection-manager')._search._editedKinds.has('sql')) throw new Error('SQL was edited before its host restore'); return 'SQL remains unedited in the fresh controller'; })()" in the webview
    When I evaluate "(async () => { const manager = document.querySelector('kw-connection-manager'); const proof = window.__cmReloadProof; await proof.waitFor(() => manager._snapshot.activeKind === 'sql' && manager._snapshot.searchState?.kind === 'sql' && manager._search.kind === 'sql' && manager._search.query === 'cm-sql-persist', 'SQL ordinary snapshot restore before explicit request'); return proof.inspect('sql-restored-before-request', 'sql', 'B1'); })()" in the webview for 20 seconds
    When I evaluate "window.__cmReloadProof.readHost('sql-restored', 'sql', 'B1')" in the webview for 40 seconds
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (!root.querySelector('[data-testid=cm-search-target-database][data-connection-id=cm-e2e-sql-b][data-database=B1]').checked || root.querySelector('[data-testid=cm-search-target-database][data-connection-id=cm-e2e-sql-b][data-database=B2]').checked) throw new Error('Restored SQL picker did not select B1 only'); return 'restored SQL picker is editable'; })()" in the webview
    When I click "[data-testid='cm-search-target-cancel']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (root.querySelector('[data-testid=cm-search-target-dialog]') || root.activeElement !== root.querySelector('[data-testid=cm-search-target-picker]')) throw new Error('Restored SQL picker Cancel lost plus focus'); return window.__cmReloadProof.inspect('sql-restored-picker-dismissed', 'sql', 'B1'); })()" in the webview
    When I evaluate "window.__cmReloadProof.mark()" in the webview
    When I click "[data-testid='cm-search-target-remove'][data-connection-id='cm-e2e-sql-b'][data-database='B1']" in the webview
    When I evaluate "window.__cmReloadProof.removed('sql-last-tag-after-reload', 'sql')" in the webview
    When I click "[data-testid='cm-search-target-picker']" in the webview
    When I click "[data-testid='cm-search-target-expand'][data-connection-id='cm-e2e-sql-b']" in the webview
    When I evaluate "(() => { const root = document.querySelector('kw-connection-manager').shadowRoot; if (Array.from(root.querySelectorAll('[data-testid=cm-search-target-database]')).some(input => input.checked)) throw new Error('Removed SQL B1 remained selected in the reopened picker'); return 'SQL restored empty scope has no prechecked databases'; })()" in the webview
    When I click "[data-testid='cm-search-target-database'][data-connection-id='cm-e2e-sql-b'][data-database='B2']" in the webview
    When I click "[data-testid='cm-search-target-apply']" in the webview
    When I evaluate "window.__cmReloadProof.settled('sql-reselected-after-reload', 'sql', 'B2')" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='tables']" in the webview
    When I evaluate "window.__cmReloadProof.settled('sql-names-on-after-reload', 'sql', 'B2', [true, true])" in the webview for 20 seconds
    When I click "[data-testid='cm-search-category'][data-category='tableColumns']" in the webview
    When I evaluate "window.__cmReloadProof.settled('sql-columns-off-after-reload', 'sql', 'B2', [true, false])" in the webview for 20 seconds
    When I evaluate "window.__cmReloadProof.readHost('sql-after-edit', 'sql', 'B2', [true, false])" in the webview for 40 seconds
    When I click "button[title='Kusto']" in the webview
    When I evaluate "window.__cmReloadProof.readHost('kusto-after-sql-edit', 'kusto', 'B2', [true, false, true, false])" in the webview for 40 seconds
    Then I take a screenshot "05-search-post-reload-tags-controls"
    Then I collect JSON artifact "cm-search-post-reload" from webview expression:
      """
      (() => {
        const proof = window.__cmReloadProof;
        const searches = proof.messages.filter(message => message.type === 'search');
        if (!searches.some(message => message.kind === 'kusto') || !searches.some(message => message.kind === 'sql') || searches.some(message => message.scope !== 'selected' || !message.targets?.length || message.targets.some(target => !['cm-e2e-kusto-b', 'cm-e2e-sql-b'].includes(target.connectionId)))) throw new Error('Post-reload search did not stay within selected ownerless targets');
        return { beforeMetadata: proof.beforeMetadata, savedHostProjections: proof.host, live: proof.live, geometry: proof.geometry, searches, starts: proof.starts, saves: proof.messages.filter(message => message.type === 'search.saveState'), cancellations: proof.messages.filter(message => message.type === 'search.cancel'), hostTerminals: proof.responses, durableBytesInspected: false };
      })()
      """

  Scenario: Column result clicks select the exact nested Kusto source and respect Back before another column
    When I click "[data-testid='cm-filter-all']" in the webview
    Then I collect JSON artifact "cm-column-kusto-fixture" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        const root = manager.shadowRoot;
        const clone = value => JSON.parse(JSON.stringify(value));
        const equal = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ': ' + JSON.stringify({ actual, expected })); };
        const waitFor = async (predicate, label) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            await manager.updateComplete;
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Timed out: ' + label + ': ' + JSON.stringify(window.__cmKustoColumnSource?.diagnostics() ?? { fixtureInstalled: false }));
        };
        await waitFor(() => manager._snapshot?.activeKind === 'kusto' && !manager._search._saveDebounceTimer && !manager._search.loading, 'settled original Kusto state');
        const original = clone(manager._snapshot);
        const inheritedEmptyHost = window.__cmReloadProof?.beforeMetadata?.source === 'fresh host snapshot.searchState before metadata decoration';
        const inheritedIds = ['cm-e2e-kusto-a', 'cm-e2e-kusto-b', 'cm-e2e-sql-a', 'cm-e2e-sql-b'];
        const originalIds = [...original.connections, ...(original.sqlConnections ?? [])].map(connection => connection.id);
        if (originalIds.length && (!inheritedEmptyHost || originalIds.some(id => !inheritedIds.includes(id)))) throw new Error('Requires the empty isolated default host, optionally decorated by scenario one');
        if (original.searchState?.kind !== 'kusto') throw new Error('Missing original host Kusto preferences for teardown');
        const native = manager._vscode;
        const originalSchemas = manager._databaseSchemas;
        const originalExpanded = manager._expandedTables;
        const originalLive = clone({ ...original.searchState, query: manager._search.query, scope: manager._search.scope, targets: manager._search.targets, categories: manager._search.categories, contentToggles: manager._search.contentToggles, lastResults: manager._search.results });
        const connectionId = 'cm-column-kusto';
        const database = 'Telemetry';
        const dbKey = connectionId + '|' + database;
        const metadata = { connections: [{ id: connectionId, name: 'Column source cluster', clusterUrl: 'https://cm-column-kusto.invalid', database: '' }], cachedDatabases: { [connectionId]: [database, 'OtherDB'] }, sqlConnections: [], sqlCachedDatabases: {} };
        const columns = { ...Object.fromEntries(Array.from({ length: 70 }, (_, index) => ['A' + String(index).padStart(2, '0'), 'System.String'])), DurationMs: 'System.Int64', DurationMsP95: 'System.Double' };
        const schema = { tables: ['Orders', 'OtherTable'], tableFolders: { Orders: 'Observability/API', OtherTable: 'Observability/API' }, columnTypesByTable: { Orders: columns, OtherTable: { DurationMs: 'System.String' } } };
        const base = { category: 'column', kind: 'kusto', connectionId, connectionName: 'Column source cluster', database, parentName: 'Orders', parentKind: 'table', name: 'DurationMs', columnType: 'System.Int64' };
        const results = [base, { ...base, parentName: 'OtherTable', columnType: 'System.String' }, { ...base, database: 'OtherDB', columnType: 'System.Real' }, { ...base, name: 'DurationMsP95', columnType: 'System.Double' }];
        const fixtureState = { kind: 'kusto', query: 'DurationMs', scope: 'selected', targets: [{ connectionId }], categories: { clusters: false, databases: false, tables: false, functions: false }, contentToggles: { tables: true, functions: false }, lastResults: clone(results) };
        const preferences = state => [state?.kind, state?.scope, state?.targets ?? [], state?.query, state?.categories, state?.contentToggles];
        const evidence = { outgoing: [], injected: [], events: [], clicks: [], reveals: [], error: null };
        evidence.diagnostics = () => ({ counts: { outgoing: evidence.outgoing.length, injected: evidence.injected.length, events: evidence.events.length, clicks: evidence.clicks.length, liveResults: manager._search.results.length, renderedResults: root.querySelectorAll('[data-testid=cm-search-result]').length }, activeRequestId: manager._search._activeRequestId, loading: manager._search.loading, query: manager._search.query, outgoing: clone(evidence.outgoing), injected: clone(evidence.injected), events: clone(evidence.events), error: evidence.error });
        const resultSelector = column => '[data-testid="cm-search-result"][data-category="column"][data-connection-id="' + connectionId + '"][data-database="' + database + '"][data-parent="Orders"][data-name="' + column + '"]';
        const path = () => { const current = manager._explorerPath; return current ? { connectionId: current.connectionId, database: current.database ?? null, section: current.section ?? null, folderPath: current.folderPath ?? [], tableName: current.tableName ?? null, columnName: current.columnName ?? null } : null; };
        const onClick = event => {
          const row = event.composedPath().find(node => node instanceof HTMLElement && node.dataset.testid === 'cm-search-result');
          if (row) evidence.clicks.push({ selector: resultSelector(row.dataset.name), category: row.dataset.category, connectionId: row.dataset.connectionId, database: row.dataset.database, parent: row.dataset.parent, name: row.dataset.name });
        };
        const onMessage = event => {
          const payload = event.data?.type === 'kustoPublicationStage' ? event.data.payload : event.data;
          evidence.events.push({ type: event.data?.type ?? null, payloadType: payload?.type ?? null, requestId: payload?.requestId ?? null, completed: payload?.completed ?? null, resultCount: Array.isArray(payload?.results) ? payload.results.length : null, activeRequestId: manager._search._activeRequestId, liveResultCount: manager._search.results.length, loading: manager._search.loading, payloadFrozen: Object.isFrozen(payload), resultsWritable: payload && Object.getOwnPropertyDescriptor(payload, 'results')?.writable || false });
          if (payload?.type === 'snapshot') Object.assign(payload.snapshot, clone(metadata));
        };
        manager._vscode = { postMessage: message => { evidence.outgoing.push(clone(message)); return native.postMessage(message); } };
        window.addEventListener('message', onMessage, true);
        root.addEventListener('click', onClick, true);
        window.__cmKustoColumnSource = evidence;
        manager.postMessage({ type: 'search.saveState', kind: 'kusto', state: { ...clone(fixtureState), lastResults: [] } });
        const setupDeadline = Date.now() + 15000;
        while (Date.now() < setupDeadline) {
          const revision = manager._snapshot.revision;
          manager.postMessage({ type: 'requestSnapshot' });
          await waitFor(() => manager._snapshot.revision > revision, 'newer host snapshot for initial fixture preferences');
          if (JSON.stringify(preferences(manager._snapshot.searchState)) === JSON.stringify(preferences(fixtureState))) break;
        }
        equal(preferences(manager._snapshot.searchState), preferences(fixtureState), 'initial fixture preferences settled through native transport');
        manager._snapshot = { ...manager._snapshot, ...clone(metadata) };
        manager._databaseSchemas = { ...originalSchemas, [dbKey]: schema, [connectionId + '|OtherDB']: { tables: ['Orders'], columnTypesByTable: { Orders: { DurationMs: 'System.Real' } } } };
        manager._search.restoreState(clone(fixtureState), 'kusto');
        evidence.injected.push({ source: 'settled initial SearchState, not a host query response', state: clone(fixtureState) });
        manager.requestUpdate();
        await manager.updateComplete;
        equal([path(), manager._search._activeRequestId, manager._search.loading, manager._search._searchDebounceTimer], [null, null, false, null], 'fixture starts idle with no source navigation');
        evidence.results = async label => {
          await waitFor(() => evidence.error || (!manager._search.loading && root.querySelectorAll('[data-testid=cm-search-result]').length === results.length), 'settled initial column results');
          if (evidence.error) throw new Error(evidence.error);
          equal(root.querySelector('[data-testid=cm-search-input]')?.value, 'DurationMs', 'restored fixture query');
          equal(preferences(manager._search), preferences(fixtureState), 'restored selected fixture scope and filters');
          equal(manager._search.results, results, 'exact retained initial results');
          equal(evidence.outgoing.filter(message => message.type === 'search'), [], 'presentation fixture must not execute a host search');
          equal(evidence.injected.length, 1, 'navigation must retain the original result set');
          if (evidence.clicks.length === 1) equal(path(), { connectionId, database, section: 'tables', folderPath: ['Observability'], tableName: null, columnName: null }, 'Search must not bounce back before the second click');
          const rows = Array.from(root.querySelectorAll('[data-testid=cm-search-result]'));
          equal(rows.map(row => [row.dataset.category, row.dataset.connectionId, row.dataset.database, row.dataset.parent, row.dataset.name]), results.map(result => [result.category, result.connectionId, result.database, result.parentName, result.name]), 'distinct source identities');
          const geometry = rows.map((row, index) => {
            const name = row.querySelector('.explorer-list-item-name');
            const type = row.querySelector('[data-testid=cm-search-column-type]');
            const suffix = '(' + results[index].columnType + ')';
            const bounds = row.getBoundingClientRect();
            const nameRect = name.getBoundingClientRect();
            const typeRect = type?.getBoundingClientRect();
            const contextRect = row.querySelector('.search-result-context').getBoundingClientRect();
            if (row.matches(':hover') || !type || name.nextElementSibling !== type || type.textContent !== suffix || row.querySelectorAll('[data-testid=cm-search-column-type]').length !== 1 || row.textContent.split(suffix).length !== 2 || [row, ...row.querySelectorAll('[title]')].some(element => element.title.includes(results[index].columnType))) throw new Error('Type must appear once inline, never depend on hover or duplicate a tooltip');
            const style = getComputedStyle(type);
            if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || !typeRect || typeRect.width <= 0 || typeRect.height <= 0 || typeRect.left < nameRect.right || typeRect.right > contextRect.left + 1 || Math.abs(typeRect.top + typeRect.height / 2 - nameRect.top - nameRect.height / 2) > 2 || bounds.top < 0 || bounds.bottom > innerHeight) throw new Error('Inline type is hidden, clipped, or overlaps its name/context');
            return { identity: clone(row.dataset), name: name.textContent, type: type.textContent, hovered: false, rowRect: bounds.toJSON(), typeRect: typeRect.toJSON() };
          });
          return { label, clickTarget: resultSelector('DurationMs'), sourcePathBeforeClick: path(), clicks: clone(evidence.clicks), rows: geometry, initialFixture: clone(evidence.injected), diagnostics: evidence.diagnostics() };
        };
        evidence.selected = async column => {
          const selector = '[data-testid="cm-schema-column"][data-table="Orders"][data-column="' + column + '"][data-selected="true"]';
          await waitFor(() => { const row = root.querySelector(selector); return row && root.activeElement === row && window.getSelection()?.toString() === column; }, 'focused exact column ' + column);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const row = root.querySelector(selector);
          const name = row.querySelector('.explorer-schema-col-name');
          const wrapper = row.closest('.explorer-list-item-wrapper');
          const content = root.querySelector('.explorer-content');
          const scroller = manager._osCtrl.getInstance(content)?.elements().viewport ?? content;
          const rowRect = row.getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          const viewportRect = scroller.getBoundingClientRect();
          const selection = window.getSelection();
          const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
          equal(path(), { connectionId, database, section: 'tables', folderPath: ['Observability', 'API'], tableName: 'Orders', columnName: column }, 'exact deepest source path');
          equal(Array.from(root.querySelectorAll('.breadcrumb-item'), crumb => crumb.textContent.trim()), ['All', 'Column source cluster', database, 'Tables', 'Observability', 'API'], 'source breadcrumb');
          equal(root.querySelectorAll('[data-testid=cm-schema-column][data-selected=true]').length, 1, 'only one source column selected');
          if (!row.classList.contains('selected') || row.getAttribute('aria-current') !== 'true' || root.activeElement !== row || document.activeElement !== manager || !document.hasFocus() || !wrapper?.classList.contains('expanded') || wrapper.querySelector(':scope > .explorer-list-item .explorer-list-item-name')?.textContent !== 'Orders' || !wrapper.querySelector(':scope > .explorer-list-item .explorer-list-item-chevron.expanded')) throw new Error('Source row lost selection, native focus, or expanded table');
          if (!range || selection.toString() !== column || range.startContainer !== name || range.endContainer !== name || range.startOffset !== 0 || range.endOffset !== name.childNodes.length || range.toString() !== column || name.closest('[data-testid=cm-schema-column]') !== row) throw new Error('Browser selection is not the exact column-name node');
          if (scroller.scrollTop <= 0 || rowRect.width <= 0 || rowRect.height <= 0 || rowRect.top < Math.max(0, contentRect.top, viewportRect.top) - 1 || rowRect.bottom > Math.min(innerHeight, contentRect.bottom, viewportRect.bottom) + 1 || rowRect.left < Math.max(contentRect.left, viewportRect.left) - 1 || rowRect.right > Math.min(contentRect.right, viewportRect.right) + 1) throw new Error('Late alphabetical column was not scrolled into the active explorer viewport');
          equal(evidence.clicks.at(-1), { selector: resultSelector(column), category: 'column', connectionId, database, parent: 'Orders', name: column }, 'real result-row click');
          const proof = { clickTarget: resultSelector(column), sourcePath: path(), expanded: true, selectedRow: { selector, className: row.className, table: row.dataset.table, column: row.dataset.column, selected: row.dataset.selected, ariaCurrent: row.getAttribute('aria-current'), focused: root.activeElement === row }, selection: { text: selection.toString(), rangeText: range.toString(), startNode: range.startContainer.nodeName, endNode: range.endContainer.nodeName, startOffset: range.startOffset, endOffset: range.endOffset, exactNameNode: true, nameParent: name.parentElement.className }, rowRect: rowRect.toJSON(), contentRect: contentRect.toJSON(), viewportRect: viewportRect.toJSON(), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight };
          evidence.reveals.push(proof);
          return proof;
        };
        evidence.back = async () => {
          let samples = 0;
          const deadline = Date.now() + 650;
          do {
            await manager.updateComplete;
            equal(path(), { connectionId, database, section: 'tables', folderPath: ['Observability'], tableName: null, columnName: null }, 'Back must remain in the parent folder');
            if (root.querySelector('[data-testid=cm-schema-column][data-selected=true]')) throw new Error('Back retained a selected column');
            samples++;
            await new Promise(resolve => setTimeout(resolve, 50));
          } while (Date.now() < deadline);
          equal(evidence.clicks.length, 1, 'Back did not trigger another result');
          return { sourcePath: path(), samples, selectedRows: 0, resultClicks: evidence.clicks.length };
        };
        evidence.cleanup = async () => {
          let contractError = null;
          try {
            await waitFor(() => !manager._search._saveDebounceTimer && !manager._search._searchDebounceTimer && !manager._search.loading, 'fixture timers settled');
            equal(evidence.clicks.map(click => click.name), ['DurationMs', 'DurationMsP95'], 'two distinct result controls used');
            if (evidence.outgoing.some(message => message.type === 'database.getSchema' || message.type === 'table.preview')) throw new Error('Cached source unexpectedly requested schema or preview data');
          } catch (error) { contractError = error; }
          window.removeEventListener('message', onMessage, true);
          root.removeEventListener('click', onClick, true);
          manager._vscode = native;
          manager._databaseSchemas = originalSchemas;
          manager._expandedTables = originalExpanded;
          manager._snapshot = original;
          manager._search.restoreState(originalLive, 'kusto');
          native.postMessage({ type: 'search.saveState', kind: 'kusto', state: clone(original.searchState) });
          const deadline = Date.now() + 15000;
          let restored = false;
          while (Date.now() < deadline) {
            const revision = manager._snapshot.revision;
            native.postMessage({ type: 'requestSnapshot' });
            await waitFor(() => manager._snapshot.revision > revision, 'newer host snapshot during teardown');
            if (JSON.stringify(preferences(manager._snapshot.searchState)) === JSON.stringify(preferences(original.searchState))) { restored = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (!restored) throw new Error('Original host Kusto preferences did not restore');
          if (manager._snapshot.connections.some(connection => connection.id === connectionId) || manager._databaseSchemas[dbKey] || manager._explorerPath !== null) throw new Error('Navigation fixture leaked after teardown');
          delete window.__cmKustoColumnSource;
          if (contractError) throw contractError;
          return { nativeTransportRestored: manager._vscode === native, originalPreferencesRestored: true, fixtureMetadataRemoved: true, clicks: evidence.clicks, reveals: evidence.reveals };
        };
        window.__cmKustoColumnSource = evidence;
        return { inventoryGuard: inheritedEmptyHost ? 'scenario-one undecorated empty-host guard plus exact inherited display IDs' : 'current empty host snapshot', originalDisplayIds: originalIds, metadata, cachedSchema: schema, selectedColumnInjected: false, expandedSourceInjected: false, initialSearchState: clone(fixtureState), queryExecutionUnderTest: false };
      })()
      """
    When I click "[data-testid='cm-filter-search']" in the webview
    When I move the mouse to 20, 20
    Then I collect JSON artifact "cm-column-kusto-inline-before-click" from webview expression "window.__cmKustoColumnSource.results('before-first-click')"
    Then I take a screenshot "06-column-kusto-inline-type-no-hover"
    When I click "[data-testid='cm-search-result'][data-category='column'][data-connection-id='cm-column-kusto'][data-database='Telemetry'][data-parent='Orders'][data-name='DurationMs']" in the webview
    Then I collect JSON artifact "cm-column-kusto-selected" from webview expression "window.__cmKustoColumnSource.selected('DurationMs')"
    Then I take a screenshot "07-column-kusto-selected-in-viewport"
    When I click "[data-testid='cm-breadcrumb-back']" in the webview
    Then I collect JSON artifact "cm-column-kusto-back-stable" from webview expression "window.__cmKustoColumnSource.back()"
    When I click "[data-testid='cm-filter-search']" in the webview
    When I move the mouse to 20, 20
    Then I collect JSON artifact "cm-column-kusto-before-second-click" from webview expression "window.__cmKustoColumnSource.results('after-Back-before-explicit-second-click')"
    When I click "[data-testid='cm-search-result'][data-category='column'][data-connection-id='cm-column-kusto'][data-database='Telemetry'][data-parent='Orders'][data-name='DurationMsP95']" in the webview
    Then I collect JSON artifact "cm-column-kusto-second-selected" from webview expression "window.__cmKustoColumnSource.selected('DurationMsP95')"
    When I click ".breadcrumb-item" in the webview
    Then I collect JSON artifact "cm-column-kusto-cleanup" from webview expression "window.__cmKustoColumnSource.cleanup()"

  Scenario: SQL view column clicks wait for matching schema and resolve a second column without a parent hint
    Then I collect JSON artifact "cm-column-kusto-preferences-before-sql" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        const deadline = Date.now() + 15000;
        while ((manager._snapshot?.activeKind !== 'kusto' || manager._snapshot.searchState?.kind !== 'kusto' || manager._search.kind !== 'kusto' || manager._search.loading || manager._search._saveDebounceTimer || manager._search._searchDebounceTimer) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        await manager.updateComplete;
        if (manager._snapshot?.activeKind !== 'kusto' || manager._snapshot.searchState?.kind !== 'kusto' || manager._search.kind !== 'kusto' || manager._search.loading || manager._search._saveDebounceTimer || manager._search._searchDebounceTimer) throw new Error('Original Kusto preferences must be settled before the SQL fixture');
        const project = state => ({ kind: state.kind, scope: state.scope, targets: state.targets ?? [], query: state.query, categories: state.categories, contentToggles: state.contentToggles });
        window.__cmColumnKustoBaseline = JSON.parse(JSON.stringify({ host: project(manager._snapshot.searchState), live: project(manager._search) }));
        return window.__cmColumnKustoBaseline;
      })()
      """
    When I click "button[title='SQL']" in the webview
    And I wait for "[data-testid='cm-sql-filter-all']" in the webview
    Then I collect JSON artifact "cm-column-sql-view-fixture" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        const root = manager.shadowRoot;
        const clone = value => JSON.parse(JSON.stringify(value));
        const equal = (actual, expected, label) => { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(label + ': ' + JSON.stringify({ actual, expected })); };
        const waitFor = async (predicate, label) => {
          const deadline = Date.now() + 15000;
          while (Date.now() < deadline) {
            await manager.updateComplete;
            if (predicate()) return;
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          throw new Error('Timed out: ' + label + ': ' + JSON.stringify(window.__cmSqlViewColumnSource?.diagnostics() ?? { fixtureInstalled: false }));
        };
        await waitFor(() => manager._snapshot?.activeKind === 'sql' && manager._search.kind === 'sql' && !manager._search._saveDebounceTimer && !manager._search.loading, 'native SQL kind switch and host snapshot');
        const original = clone(manager._snapshot);
        const inheritedEmptyHost = window.__cmReloadProof?.beforeMetadata?.source === 'fresh host snapshot.searchState before metadata decoration';
        const inheritedIds = ['cm-e2e-kusto-a', 'cm-e2e-kusto-b', 'cm-e2e-sql-a', 'cm-e2e-sql-b'];
        const originalIds = [...original.connections, ...(original.sqlConnections ?? [])].map(connection => connection.id);
        if (originalIds.length && (!inheritedEmptyHost || originalIds.some(id => !inheritedIds.includes(id)))) throw new Error('Requires the empty isolated default host, optionally decorated by scenario one');
        if (original.searchState?.kind !== 'sql' || window.__cmKustoColumnSource) throw new Error('Missing original SQL preferences or preceding fixture teardown');
        const native = manager._vscode;
        const originalSchemas = manager._sqlDatabaseSchemas;
        const originalExpanded = manager._expandedTables;
        const originalLive = clone({ ...original.searchState, query: manager._search.query, scope: manager._search.scope, targets: manager._search.targets, categories: manager._search.categories, contentToggles: manager._search.contentToggles, lastResults: manager._search.results });
        const connectionId = 'cm-column-sql-view';
        const database = 'Telemetry';
        const dbKey = connectionId + '|' + database;
        const metadata = { connections: [], cachedDatabases: {}, sqlConnections: [{ id: connectionId, name: 'Column source server', serverUrl: 'cm-column-sql-view.invalid', dialect: 'mssql', authType: 'aad' }], sqlCachedDatabases: { [connectionId]: [database, 'OtherDB'] } };
        const columns = { ...Object.fromEntries(Array.from({ length: 70 }, (_, index) => ['A' + String(index).padStart(2, '0'), 'nvarchar'])), DurationMs: 'bigint', DurationMsP95: 'decimal(18,2)' };
        const schema = { tables: ['OtherTable'], views: ['Orders'], columnsByTable: { Orders: columns, OtherTable: { DurationMs: 'nvarchar' } } };
        const base = { category: 'column', kind: 'sql', connectionId, connectionName: 'Column source server', database, parentName: 'Orders', name: 'DurationMs' };
        const results = [{ ...base, parentKind: 'view', columnType: 'bigint' }, { ...base, parentKind: 'table', parentName: 'OtherTable', columnType: 'nvarchar' }, { ...base, parentKind: 'view', database: 'OtherDB', columnType: 'nvarchar' }, { ...base, name: 'DurationMsP95', columnType: 'decimal(18,2)' }];
        const fixtureState = { kind: 'sql', query: 'DurationMs', scope: 'selected', targets: [{ connectionId }], categories: { servers: false, databases: false, tables: false, views: true, storedProcedures: false }, contentToggles: { tables: true, views: true, storedProcedures: false }, lastResults: clone(results) };
        const preferences = state => [state?.kind, state?.scope, state?.targets ?? [], state?.query, state?.categories, state?.contentToggles];
        const evidence = { outgoing: [], injected: [], events: [], schemaRequests: [], schemaReplies: [], clicks: [], reveals: [], pending: null, error: null };
        evidence.diagnostics = () => ({ counts: { outgoing: evidence.outgoing.length, injected: evidence.injected.length, events: evidence.events.length, clicks: evidence.clicks.length, liveResults: manager._search.results.length, renderedResults: root.querySelectorAll('[data-testid=cm-search-result]').length }, activeRequestId: manager._search._activeRequestId, loading: manager._search.loading, query: manager._search.query, outgoing: clone(evidence.outgoing), injected: clone(evidence.injected), events: clone(evidence.events), schemaRequests: clone(evidence.schemaRequests), schemaReplies: clone(evidence.schemaReplies), error: evidence.error });
        const resultSelector = column => '[data-testid="cm-search-result"][data-category="column"][data-connection-id="' + connectionId + '"][data-database="' + database + '"][data-parent="Orders"][data-name="' + column + '"]';
        const path = () => { const current = manager._sqlExplorerPath; return current ? { connectionId: current.connectionId, database: current.database ?? null, section: current.section ?? null, tableName: current.tableName ?? null, columnName: current.columnName ?? null } : null; };
        const onClick = event => {
          const row = event.composedPath().find(node => node instanceof HTMLElement && node.dataset.testid === 'cm-search-result');
          if (row) evidence.clicks.push({ selector: resultSelector(row.dataset.name), category: row.dataset.category, connectionId: row.dataset.connectionId, database: row.dataset.database, parent: row.dataset.parent, name: row.dataset.name });
        };
        const onMessage = event => {
          const payload = event.data?.type === 'kustoPublicationStage' ? event.data.payload : event.data;
          evidence.events.push({ type: event.data?.type ?? null, payloadType: payload?.type ?? null, requestId: payload?.requestId ?? null, completed: payload?.completed ?? null, resultCount: Array.isArray(payload?.results) ? payload.results.length : null, activeRequestId: manager._search._activeRequestId, liveResultCount: manager._search.results.length, loading: manager._search.loading, payloadFrozen: Object.isFrozen(payload), resultsWritable: payload && Object.getOwnPropertyDescriptor(payload, 'results')?.writable || false });
          if (payload?.type === 'snapshot') Object.assign(payload.snapshot, clone(metadata));
          if (payload?.type === 'sql.schemaLoaded' && payload.connectionId === connectionId && payload.database === database) evidence.schemaReplies.push({ requestId: payload.requestId ?? null, connectionId: payload.connectionId, database: payload.database });
        };
        manager._vscode = { postMessage: message => {
          evidence.outgoing.push(clone(message));
          if (message.type === 'sql.database.getSchema' && message.connectionId === connectionId && message.database === database) {
            evidence.schemaRequests.push(clone(message));
            const requestId = 'cm-column-sql-view-schema-' + evidence.schemaRequests.length;
            evidence.pending = { type: 'sql.schemaLoaded', connectionId, database, requestId, schema: clone(schema) };
            window.postMessage({ type: 'sql.loadingSchema', connectionId, database, requestId }, '*');
          }
          return native.postMessage(message);
        } };
        window.addEventListener('message', onMessage, true);
        root.addEventListener('click', onClick, true);
        window.__cmSqlViewColumnSource = evidence;
        manager.postMessage({ type: 'search.saveState', kind: 'sql', state: { ...clone(fixtureState), lastResults: [] } });
        const setupDeadline = Date.now() + 15000;
        while (Date.now() < setupDeadline) {
          const revision = manager._snapshot.revision;
          manager.postMessage({ type: 'requestSnapshot' });
          await waitFor(() => manager._snapshot.revision > revision, 'newer host snapshot for initial SQL fixture preferences');
          if (JSON.stringify(preferences(manager._snapshot.searchState)) === JSON.stringify(preferences(fixtureState))) break;
        }
        equal(preferences(manager._snapshot.searchState), preferences(fixtureState), 'initial SQL fixture preferences settled through native transport');
        manager._snapshot = { ...manager._snapshot, ...clone(metadata) };
        manager._sqlDatabaseSchemas = { ...originalSchemas, [connectionId + '|OtherDB']: { tables: [], views: ['Orders'], columnsByTable: { Orders: { DurationMs: 'nvarchar' } } } };
        if (manager._sqlDatabaseSchemas[dbKey]) throw new Error('Target SQL schema must be absent before the real result click');
        manager._search.restoreState(clone(fixtureState), 'sql');
        evidence.injected.push({ source: 'settled initial SearchState, not a host query response', state: clone(fixtureState) });
        manager.requestUpdate();
        await manager.updateComplete;
        equal([path(), manager._search._activeRequestId, manager._search.loading, manager._search._searchDebounceTimer], [null, null, false, null], 'SQL fixture starts idle with no source navigation');
        evidence.results = async label => {
          await waitFor(() => evidence.error || (!manager._search.loading && root.querySelectorAll('[data-testid=cm-search-result]').length === results.length), 'settled initial SQL column results');
          if (evidence.error) throw new Error(evidence.error);
          equal(root.querySelector('[data-testid=cm-search-input]')?.value, 'DurationMs', 'restored SQL fixture query');
          equal(preferences(manager._search), preferences(fixtureState), 'restored selected SQL fixture scope and filters');
          equal(manager._search.results, results, 'exact retained initial SQL results');
          equal(evidence.outgoing.filter(message => message.type === 'search'), [], 'SQL presentation fixture must not execute a host search');
          equal(evidence.injected.length, 1, 'navigation retained its original search results');
          if (evidence.clicks.length === 1) equal(path(), { connectionId, database, section: null, tableName: null, columnName: null }, 'no SQL auto-reveal before another click');
          const rows = Array.from(root.querySelectorAll('[data-testid=cm-search-result]'));
          equal(rows.map(row => [row.dataset.category, row.dataset.connectionId, row.dataset.database, row.dataset.parent, row.dataset.name]), results.map(result => [result.category, result.connectionId, result.database, result.parentName, result.name]), 'distinct SQL source identities');
          const geometry = rows.map((row, index) => {
            const name = row.querySelector('.explorer-list-item-name');
            const type = row.querySelector('[data-testid=cm-search-column-type]');
            const suffix = '(' + results[index].columnType + ')';
            if (row.matches(':hover') || !type || name.nextElementSibling !== type || type.textContent !== suffix || row.querySelectorAll('[data-testid=cm-search-column-type]').length !== 1 || row.textContent.split(suffix).length !== 2 || [row, ...row.querySelectorAll('[title]')].some(element => element.title.includes(results[index].columnType))) throw new Error('SQL type is not a single non-hover inline sibling');
            const rect = type.getBoundingClientRect();
            const nameRect = name.getBoundingClientRect();
            const style = getComputedStyle(type);
            if (style.display === 'none' || style.visibility !== 'visible' || Number(style.opacity) === 0 || rect.width <= 0 || rect.height <= 0 || rect.left < nameRect.right || rect.right > row.querySelector('.search-result-context').getBoundingClientRect().left + 1 || Math.abs(rect.top + rect.height / 2 - nameRect.top - nameRect.height / 2) > 2 || rect.top < 0 || rect.bottom > innerHeight) throw new Error('SQL inline type is hidden, clipped, or overlapping');
            return { identity: clone(row.dataset), type: type.textContent, hovered: false, rowRect: row.getBoundingClientRect().toJSON(), typeRect: rect.toJSON() };
          });
          return { label, clickTarget: resultSelector('DurationMs'), sourcePathBeforeClick: path(), rows: geometry, initialFixture: clone(evidence.injected), diagnostics: evidence.diagnostics(), clicks: clone(evidence.clicks), secondResultParentHint: results[3].parentKind ?? null };
        };
        evidence.loading = async label => {
          await waitFor(() => evidence.pending && manager._sqlSchemaRequestIds.get(dbKey) === evidence.pending.requestId && root.querySelector('.explorer-content .loading-state'), 'pending SQL schema loading UI');
          equal(path(), { connectionId, database, section: 'views', tableName: 'Orders', columnName: 'DurationMs' }, 'view parent hint before schema arrival');
          equal(evidence.schemaRequests, [{ type: 'sql.database.getSchema', connectionId, database }], 'real source click schema request');
          equal(root.querySelector('.explorer-content .loading-state').textContent.trim(), 'Loading schema...', 'visible loading state');
          if (manager._sqlDatabaseSchemas[dbKey] || root.querySelector('[data-testid=cm-schema-column]')) throw new Error('A missing or stale schema revealed a column early');
          return { label, clickTarget: resultSelector('DurationMs'), sourcePath: path(), request: clone(evidence.schemaRequests[0]), pendingRequestId: evidence.pending.requestId, observedSchemaReplies: clone(evidence.schemaReplies), loadingText: root.querySelector('.loading-state').textContent.trim(), selectedRows: 0, targetSchemaPresent: false };
        };
        evidence.rejectStale = async () => {
          if (!evidence.pending) throw new Error('No captured schema response');
          window.postMessage({ ...clone(evidence.pending), requestId: evidence.pending.requestId + '-stale' }, '*');
          await waitFor(() => evidence.schemaReplies.some(reply => reply.requestId === evidence.pending.requestId + '-stale'), 'stale SQL response actually received');
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          return evidence.loading('stale-schema-rejected');
        };
        evidence.selected = async column => {
          const selector = '[data-testid="cm-schema-column"][data-table="Orders"][data-column="' + column + '"][data-selected="true"]';
          await waitFor(() => { const row = root.querySelector(selector); return row && root.activeElement === row && window.getSelection()?.toString() === column; }, 'focused exact SQL view column ' + column);
          await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
          const row = root.querySelector(selector);
          const name = row.querySelector('.explorer-schema-col-name');
          const wrapper = row.closest('.explorer-list-item-wrapper');
          const content = root.querySelector('.explorer-content');
          const scroller = manager._osCtrl.getInstance(content)?.elements().viewport ?? content;
          const rowRect = row.getBoundingClientRect();
          const contentRect = content.getBoundingClientRect();
          const viewportRect = scroller.getBoundingClientRect();
          const selection = window.getSelection();
          const range = selection.rangeCount === 1 ? selection.getRangeAt(0) : null;
          equal(path(), { connectionId, database, section: 'views', tableName: 'Orders', columnName: column }, 'schema-classified SQL view source');
          equal(Array.from(root.querySelectorAll('.breadcrumb-item'), crumb => crumb.textContent.trim()), ['All', 'Column source server', database, 'Views'], 'SQL view breadcrumb');
          equal(root.querySelectorAll('[data-testid=cm-schema-column][data-selected=true]').length, 1, 'one SQL source selection');
          if (!row.classList.contains('selected') || row.getAttribute('aria-current') !== 'true' || root.activeElement !== row || document.activeElement !== manager || !document.hasFocus() || !wrapper?.classList.contains('expanded') || wrapper.querySelector(':scope > .explorer-list-item .explorer-list-item-name')?.textContent !== 'Orders' || !wrapper.querySelector(':scope > .explorer-list-item .explorer-list-item-chevron.expanded')) throw new Error('SQL source is not expanded, selected, and natively focused');
          if (!range || selection.toString() !== column || range.startContainer !== name || range.endContainer !== name || range.startOffset !== 0 || range.endOffset !== name.childNodes.length || range.toString() !== column || name.closest('[data-testid=cm-schema-column]') !== row) throw new Error('SQL browser selection does not belong to the exact column-name node');
          if (scroller.scrollTop <= 0 || rowRect.width <= 0 || rowRect.height <= 0 || rowRect.top < Math.max(0, contentRect.top, viewportRect.top) - 1 || rowRect.bottom > Math.min(innerHeight, contentRect.bottom, viewportRect.bottom) + 1 || rowRect.left < Math.max(contentRect.left, viewportRect.left) - 1 || rowRect.right > Math.min(contentRect.right, viewportRect.right) + 1) throw new Error('SQL column is outside the active scrolled explorer viewport');
          if (manager._sqlSchemaRequestIds.has(dbKey)) throw new Error('Matching schema did not consume its loading request');
          equal(evidence.clicks.at(-1), { selector: resultSelector(column), category: 'column', connectionId, database, parent: 'Orders', name: column }, 'real SQL result-row click');
          const proof = { clickTarget: resultSelector(column), sourcePath: path(), expanded: true, selectedRow: { selector, className: row.className, table: row.dataset.table, column: row.dataset.column, selected: row.dataset.selected, ariaCurrent: row.getAttribute('aria-current'), focused: root.activeElement === row }, selection: { text: selection.toString(), rangeText: range.toString(), startNode: range.startContainer.nodeName, endNode: range.endContainer.nodeName, startOffset: range.startOffset, endOffset: range.endOffset, exactNameNode: true, nameParent: name.parentElement.className }, rowRect: rowRect.toJSON(), contentRect: contentRect.toJSON(), viewportRect: viewportRect.toJSON(), scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight, schemaRequest: clone(evidence.schemaRequests[0]), deliveredRequestId: evidence.pending.requestId, parentHint: results.find(result => result.database === database && result.parentName === 'Orders' && result.name === column)?.parentKind ?? null };
          evidence.reveals.push(proof);
          return proof;
        };
        evidence.back = async () => {
          let samples = 0;
          const deadline = Date.now() + 650;
          do {
            await manager.updateComplete;
            equal(path(), { connectionId, database, section: null, tableName: null, columnName: null }, 'SQL Back must remain at the database overview');
            if (root.querySelector('[data-testid=cm-schema-column][data-selected=true]')) throw new Error('SQL Back retained a selected column');
            samples++;
            await new Promise(resolve => setTimeout(resolve, 50));
          } while (Date.now() < deadline);
          equal(evidence.clicks.length, 1, 'SQL Back did not click another result');
          return { sourcePath: path(), samples, selectedRows: 0, resultClicks: evidence.clicks.length };
        };
        evidence.cleanup = async () => {
          let contractError = null;
          try {
            await waitFor(() => !manager._search._saveDebounceTimer && !manager._search._searchDebounceTimer && !manager._search.loading, 'SQL fixture timers settled');
            equal(evidence.clicks.map(click => click.name), ['DurationMs', 'DurationMsP95'], 'distinct SQL column controls');
            equal(evidence.schemaRequests, [{ type: 'sql.database.getSchema', connectionId, database }], 'second click reuses the resolved view schema');
            if (evidence.outgoing.some(message => message.type === 'sql.table.preview')) throw new Error('Column navigation requested SQL preview data');
          } catch (error) { contractError = error; }
          window.removeEventListener('message', onMessage, true);
          root.removeEventListener('click', onClick, true);
          manager._vscode = native;
          manager._sqlDatabaseSchemas = originalSchemas;
          manager._expandedTables = originalExpanded;
          manager._snapshot = original;
          manager._search.restoreState(originalLive, 'sql');
          if (!original.sqlExpandedConnections?.includes(connectionId)) native.postMessage({ type: 'sql.cluster.collapse', connectionId });
          native.postMessage({ type: 'search.saveState', kind: 'sql', state: clone(original.searchState) });
          const deadline = Date.now() + 15000;
          let restored = false;
          while (Date.now() < deadline) {
            const revision = manager._snapshot.revision;
            native.postMessage({ type: 'requestSnapshot' });
            await waitFor(() => manager._snapshot.revision > revision, 'newer host SQL snapshot during teardown');
            if (JSON.stringify(preferences(manager._snapshot.searchState)) === JSON.stringify(preferences(original.searchState)) && JSON.stringify(manager._snapshot.sqlExpandedConnections ?? []) === JSON.stringify(original.sqlExpandedConnections ?? [])) { restored = true; break; }
            await new Promise(resolve => setTimeout(resolve, 50));
          }
          if (!restored) throw new Error('Original host SQL preferences or expansion state did not restore');
          if (manager._snapshot.sqlConnections.some(connection => connection.id === connectionId) || manager._sqlDatabaseSchemas[dbKey] || manager._sqlExplorerPath !== null) throw new Error('SQL fixture leaked after teardown');
          delete window.__cmSqlViewColumnSource;
          if (contractError) throw contractError;
          return { nativeTransportRestored: manager._vscode === native, originalPreferencesRestored: true, originalExpansionRestored: true, expandedConnectionIds: manager._snapshot.sqlExpandedConnections ?? [], fixtureMetadataRemoved: true, clicks: evidence.clicks, reveals: evidence.reveals };
        };
        window.__cmSqlViewColumnSource = evidence;
        return { inventoryGuard: inheritedEmptyHost ? 'scenario-one undecorated empty-host guard plus exact inherited display IDs' : 'current empty host snapshot', originalDisplayIds: originalIds, metadata, deferredSchema: schema, schemaInitiallyAbsent: true, selectedColumnInjected: false, expandedSourceInjected: false, initialSearchState: clone(fixtureState), queryExecutionUnderTest: false };
      })()
      """
    When I click "[data-testid='cm-sql-filter-search']" in the webview
    When I move the mouse to 20, 20
    Then I collect JSON artifact "cm-column-sql-view-inline-before-click" from webview expression "window.__cmSqlViewColumnSource.results('before-first-click')"
    When I click "[data-testid='cm-search-result'][data-category='column'][data-connection-id='cm-column-sql-view'][data-database='Telemetry'][data-parent='Orders'][data-name='DurationMs']" in the webview
    Then I collect JSON artifact "cm-column-sql-view-loading" from webview expression "window.__cmSqlViewColumnSource.loading('before-matching-schema')"
    Then I collect JSON artifact "cm-column-sql-view-stale-schema" from webview expression "window.__cmSqlViewColumnSource.rejectStale()"
    When I evaluate "(() => { const fixture = window.__cmSqlViewColumnSource; if (!fixture.pending) throw new Error('No schema request captured from the real result click'); window.postMessage(fixture.pending, '*'); return 'matching incoming SQL schema delivered'; })()" in the webview
    Then I collect JSON artifact "cm-column-sql-view-selected" from webview expression "window.__cmSqlViewColumnSource.selected('DurationMs')"
    Then I take a screenshot "08-column-sql-view-selected-in-viewport"
    When I click "[data-testid='cm-sql-breadcrumb-back']" in the webview
    Then I collect JSON artifact "cm-column-sql-view-back-stable" from webview expression "window.__cmSqlViewColumnSource.back()"
    When I click "[data-testid='cm-sql-filter-search']" in the webview
    When I move the mouse to 20, 20
    Then I collect JSON artifact "cm-column-sql-view-before-second-click" from webview expression "window.__cmSqlViewColumnSource.results('after-Back-before-explicit-second-click')"
    When I click "[data-testid='cm-search-result'][data-category='column'][data-connection-id='cm-column-sql-view'][data-database='Telemetry'][data-parent='Orders'][data-name='DurationMsP95']" in the webview
    Then I collect JSON artifact "cm-column-sql-view-second-selected" from webview expression "window.__cmSqlViewColumnSource.selected('DurationMsP95')"
    When I click ".breadcrumb-item" in the webview
    Then I collect JSON artifact "cm-column-sql-view-cleanup" from webview expression "window.__cmSqlViewColumnSource.cleanup()"
    When I click "button[title='Kusto']" in the webview
    And I wait for "[data-testid='cm-filter-all'].active" in the webview
    Then I collect JSON artifact "cm-column-source-final-profile" from webview expression:
      """
      (async () => {
        const manager = document.querySelector('kw-connection-manager');
        const deadline = Date.now() + 15000;
        while (manager._snapshot?.activeKind !== 'kusto' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
        await manager.updateComplete;
        const original = window.__cmColumnKustoBaseline;
        const snapshot = manager._snapshot;
        const project = state => [state.kind, state.scope, state.targets ?? [], state.query, state.categories, state.contentToggles];
        if (!original || snapshot.activeKind !== 'kusto' || window.__cmKustoColumnSource || window.__cmSqlViewColumnSource || [...snapshot.connections, ...(snapshot.sqlConnections ?? [])].some(connection => connection.id.startsWith('cm-column-')) || JSON.stringify(project(manager._search)) !== JSON.stringify(project(original.live)) || JSON.stringify(project(snapshot.searchState)) !== JSON.stringify(project(original.host))) throw new Error('Column fixtures changed the original kind, host preferences, or live search state');
        delete window.__cmColumnKustoBaseline;
        return { activeKind: snapshot.activeKind, fixtureObserversRemoved: true, fixtureMetadataRemoved: true, originalPreferencesRestored: true, originalQuery: original.host.query, hostSearchState: JSON.parse(JSON.stringify(snapshot.searchState)) };
      })()
      """
