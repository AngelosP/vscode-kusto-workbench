Feature: Section layout regression across all section types

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1300 by 950
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    And I wait for "#queries-container" in the webview for 20 seconds
    And I evaluate "window.__e2e.workbench.clearSections()" in the webview
    And I wait 1 second

  Scenario: Page scrolling remains stable with every section type
    When I evaluate "window.__e2e.layout.createStressNotebook()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.layout.assertScrollStability()" in the webview
    Then I take a screenshot "01-section-layout-scroll-stability"

  Scenario: Collapse and expand keeps section bodies hidden and visible
    When I evaluate "window.__e2e.layout.createStressNotebook()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.layout.exerciseCollapseExpand()" in the webview
    Then I take a screenshot "02-section-layout-collapse-expand"

  Scenario: Auto-fit and manual resize stay bounded for every section type
    When I evaluate "window.__e2e.layout.createStressNotebook()" in the webview
    And I wait 1 second
    When I evaluate "window.__e2e.layout.exerciseAutoFitAndResize()" in the webview
    Then I take a screenshot "03-section-layout-fit-resize"

  Scenario: Real section controls auto-fit and collapse without shifting ownership
    When I evaluate "window.__e2e.layout.createStressNotebook()" in the webview
    And I wait 1 second
    When I scroll "#e2e_layout_query_query_resizer" into view
    And I evaluate "(() => { const section = document.getElementById('e2e_layout_query'); const wrapper = section?.querySelector('.query-editor-wrapper'); const identity = section?.getSchemaLifecycleIdentity?.(); if (!section || !wrapper || !identity?.sectionInstanceId) throw new Error('Kusto editor ownership is missing'); window.__nativeLayoutSectionBefore = section; window.__nativeLayoutIdentityBefore = identity; window.__nativeLayoutHeightBefore = wrapper.getBoundingClientRect().height; return { height: window.__nativeLayoutHeightBefore, identity }; })()" in the webview
    When I double click "#e2e_layout_query_query_resizer" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.getElementById('e2e_layout_query'); const wrapper = section?.querySelector('.query-editor-wrapper'); const before = Number(window.__nativeLayoutHeightBefore); const after = wrapper?.getBoundingClientRect().height || 0; const identity = section?.getSchemaLifecycleIdentity?.(); if (!section || !wrapper || after < 80 || after > 750 || Math.abs(after - before) < 10) throw new Error('Native double-click did not auto-fit the Kusto editor: ' + JSON.stringify({ before, after })); if (section !== window.__nativeLayoutSectionBefore || identity?.sectionInstanceId !== window.__nativeLayoutIdentityBefore?.sectionInstanceId || document.querySelectorAll('#queries-container > #e2e_layout_query').length !== 1) throw new Error('Auto-fit changed section ownership'); return { before, after, identity }; })()" in the webview
    When I click "#e2e_layout_query_toggle" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.getElementById('e2e_layout_query'); const wrapper = section?.querySelector('.query-editor-wrapper'); const identity = section?.getSchemaLifecycleIdentity?.(); if (section !== window.__nativeLayoutSectionBefore || identity?.sectionInstanceId !== window.__nativeLayoutIdentityBefore?.sectionInstanceId || !section?.classList.contains('is-collapsed') || (wrapper && wrapper.getBoundingClientRect().height > 0)) throw new Error('Real collapse control changed ownership or left the body visible'); return { className: section.className, identity }; })()" in the webview
    When I click "#e2e_layout_query_toggle" in the webview
    And I wait 1 second
    When I evaluate "(() => { const section = document.getElementById('e2e_layout_query'); const wrapper = section?.querySelector('.query-editor-wrapper'); const identity = section?.getSchemaLifecycleIdentity?.(); if (section !== window.__nativeLayoutSectionBefore || identity?.sectionInstanceId !== window.__nativeLayoutIdentityBefore?.sectionInstanceId || section.classList.contains('is-collapsed') || !wrapper || wrapper.getBoundingClientRect().height < 80 || wrapper.getBoundingClientRect().height > 750) throw new Error('Real expand control changed ownership or restored an invalid body'); return { height: wrapper.getBoundingClientRect().height, identity }; })()" in the webview
    Then I take a screenshot "04-native-section-controls"
