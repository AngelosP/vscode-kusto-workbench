Feature: VS Code-style rounded scrollbars

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1000 by 700
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "workbench.action.closeAllEditors"
    And I execute command "notifications.clearAll"
    And I execute command "kustoWorkbench.test.resetFirstLaunchSetup"
    And I execute command "kustoWorkbench.test.setIsolatedKustoConnections"
    And I wait 1 second

  Scenario: First-launch overflow uses a thin rounded overlay thumb
    And I start command "kusto.openQueryEditor"
    And I wait for "kw-first-launch-setup" in the webview for 35 seconds
    And I evaluate "(async () => { const sleep = ms => new Promise(resolve => setTimeout(resolve, ms)); let handle; let viewport; for (let attempt = 0; attempt < 100; attempt++) { handle = document.querySelector('.os-scrollbar-vertical .os-scrollbar-handle'); viewport = document.querySelector('#first-launch-scroll [data-overlayscrollbars-viewport]'); if (handle && viewport && viewport.scrollHeight > viewport.clientHeight) break; await sleep(50); } const handleRect = handle?.getBoundingClientRect(); if (!handle || !handleRect || handleRect.height < 1) throw new Error('Overlay scrollbar handle missing'); if (Math.abs(handleRect.width - 8) > 0.1) throw new Error('Overlay scrollbar handle is not 8px wide'); if (getComputedStyle(handle).borderRadius !== '4px') throw new Error('Overlay scrollbar handle is not rounded like VS Code'); if (!viewport || getComputedStyle(viewport).scrollbarWidth !== 'none') throw new Error('Native scrollbar was not hidden'); if (viewport.scrollHeight <= viewport.clientHeight) throw new Error('Overlay viewport did not detect overflow'); viewport.scrollTop = 120; await new Promise(resolve => requestAnimationFrame(() => resolve())); if (viewport.scrollTop < 1) throw new Error('Overlay viewport did not scroll'); return 'thin-rounded-scrollbar-ready'; })()" in the webview for 20 seconds
    Then I collect JSON artifact "rounded-scrollbar" from webview expression "(() => { const handle = document.querySelector('.os-scrollbar-vertical .os-scrollbar-handle'); const viewport = document.querySelector('#first-launch-scroll [data-overlayscrollbars-viewport]'); const handleRect = handle.getBoundingClientRect(); return { borderRadius: getComputedStyle(handle).borderRadius, handleWidth: handleRect.width, handleHeight: handleRect.height, nativeScrollbarWidth: getComputedStyle(viewport).scrollbarWidth, scrollTop: viewport.scrollTop }; })()"
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I click at 30, 400
    Then I take a screenshot "01-rounded-scrollbar"

  Scenario: Main KQLX page scrollbar hides after pointer movement stops
    When I start command "kusto.openQueryEditor"
    And I wait for "kw-first-launch-setup" in the webview for 35 seconds
    When I evaluate "(() => { const viewer = document.querySelector('kw-first-launch-setup'); const button = viewer?.shadowRoot?.querySelector('[data-testid=first-launch-secondary]'); if (!button) throw new Error('Skip setup action missing'); button.click(); return 'setup-skipped'; })()" in the webview
    And I wait 2 seconds
    And I wait for "#queries-container" in the webview for 25 seconds
    And I evaluate "(async () => { const queries = document.querySelector('#queries-container'); if (!queries) throw new Error('Queries container missing'); queries.style.minHeight = '1800px'; window.dispatchEvent(new Event('resize')); for (let attempt = 0; attempt < 100; attempt++) { const scrollbar = document.querySelector('.kw-scroll-viewport > .os-scrollbar-vertical'); const viewport = document.querySelector('.kw-scroll-viewport [data-kw-page-scroll-element]'); if (scrollbar && viewport && !scrollbar.classList.contains('os-scrollbar-unusable') && viewport.scrollHeight > viewport.clientHeight) return 'main-page-overflow-ready'; await new Promise(resolve => setTimeout(resolve, 50)); } throw new Error('Main page overlay scrollbar did not become usable'); })()" in the webview for 20 seconds
    And I evaluate "(async () => { const host = document.querySelector('.kw-scroll-viewport'); const scrollbar = document.querySelector('.kw-scroll-viewport > .os-scrollbar-vertical'); if (!host || !scrollbar) throw new Error('Main page overlay scrollbar missing'); host.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse', clientX: host.clientWidth - 5, clientY: 200 })); await new Promise(resolve => requestAnimationFrame(() => resolve())); if (scrollbar.classList.contains('os-scrollbar-auto-hide-hidden')) throw new Error('Main page scrollbar did not become visible on pointer movement'); document.documentElement.dataset.testScrollbarSeenVisible = 'true'; await new Promise(resolve => setTimeout(resolve, 1200)); await new Promise(resolve => requestAnimationFrame(() => resolve())); const style = getComputedStyle(scrollbar); if (!scrollbar.classList.contains('os-scrollbar-auto-hide-hidden') || style.opacity !== '0' || style.visibility !== 'hidden') throw new Error('Main page scrollbar remained visible after pointer movement stopped'); return 'main-page-scrollbar-hidden'; })()" in the webview for 20 seconds
    Then I collect JSON artifact "main-page-auto-hide" from webview expression "(() => { const scrollbar = document.querySelector('.kw-scroll-viewport > .os-scrollbar-vertical'); const handle = scrollbar.querySelector('.os-scrollbar-handle'); const style = getComputedStyle(scrollbar); return { seenVisible: document.documentElement.dataset.testScrollbarSeenVisible === 'true', autoHideHidden: scrollbar.classList.contains('os-scrollbar-auto-hide-hidden'), opacity: style.opacity, visibility: style.visibility, handleWidth: handle.getBoundingClientRect().width }; })()"
    And I evaluate "(() => { const queries = document.querySelector('#queries-container'); if (queries) queries.style.minHeight = ''; window.dispatchEvent(new Event('resize')); return 'main-page-overflow-cleaned'; })()" in the webview
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    And I evaluate "(() => { const scrollbar = document.querySelector('.kw-scroll-viewport > .os-scrollbar-vertical'); const style = getComputedStyle(scrollbar); if (!scrollbar.classList.contains('os-scrollbar-auto-hide-hidden') || style.opacity !== '0') throw new Error('Main page scrollbar became visible again before capture'); return 'main-page-scrollbar-still-hidden'; })()" in the webview
    Then I take a screenshot "02-main-page-scrollbar-hidden"