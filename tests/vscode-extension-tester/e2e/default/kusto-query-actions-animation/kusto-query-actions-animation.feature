Feature: Kusto query action hover animation

  Scenario: Compare and Optimize expand from icons to labels
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 900 by 800
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "window.__e2e.workbench.clearSections()" in the webview
    When I wait for "button[data-add-kind='query']" in the webview for 20 seconds
    When I click "button[data-add-kind='query']" in the webview
    When I wait for "kw-query-section [id$='_compare_btn']" in the webview for 10 seconds
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const compare = document.getElementById(section.boxId + '_compare_btn'); const optimize = document.getElementById(section.boxId + '_optimize_btn'); optimize.disabled = false; const compareLabel = compare.querySelector('.optimize-query-label'); const optimizeLabel = optimize.querySelector('.optimize-query-label'); const compareRect = compare.getBoundingClientRect(); const optimizeRect = optimize.getBoundingClientRect(); if (Math.abs(compareRect.width - 28) > 1 || Math.abs(optimizeRect.width - 28) > 1 || compareLabel.getBoundingClientRect().width > 1 || optimizeLabel.getBoundingClientRect().width > 1) throw new Error('Query actions are not icon-only at rest: ' + JSON.stringify({ compare: compareRect.toJSON(), optimize: optimizeRect.toJSON() })); return { compare: compareRect.toJSON(), optimize: optimizeRect.toJSON() }; })()" in the webview
    Then I take a screenshot "01-query-actions-icon-only"

    When I move the mouse to 320, 546
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const compare = document.getElementById(section.boxId + '_compare_btn'); const optimize = document.getElementById(section.boxId + '_optimize_btn'); const label = compare.querySelector('.optimize-query-label'); const style = getComputedStyle(label); const iconTransform = getComputedStyle(compare.querySelector('svg')).transform; const width = compare.getBoundingClientRect().width; if (!compare.matches(':hover') || width < 72 || Number(style.opacity) < 0.99 || label.getBoundingClientRect().width < 36 || iconTransform === 'none' || optimize.getBoundingClientRect().width > 30) throw new Error('Compare hover expansion failed: ' + JSON.stringify({ hovered: compare.matches(':hover'), width, labelWidth: label.getBoundingClientRect().width, opacity: style.opacity, iconTransform, optimizeWidth: optimize.getBoundingClientRect().width })); return { width, labelWidth: label.getBoundingClientRect().width, iconTransform }; })()" in the webview
    Then I take a screenshot "02-compare-expanded"

    When I move the mouse to 20, 20
    And I wait 1 second
    When I move the mouse to 354, 546
    And I wait 1 second
    When I evaluate "(() => { const section = document.querySelector('kw-query-section'); const compare = document.getElementById(section.boxId + '_compare_btn'); const optimize = document.getElementById(section.boxId + '_optimize_btn'); const label = optimize.querySelector('.optimize-query-label'); const style = getComputedStyle(label); const iconTransform = getComputedStyle(optimize.querySelector('svg')).transform; const width = optimize.getBoundingClientRect().width; if (!optimize.matches(':hover') || width < 72 || Number(style.opacity) < 0.99 || label.getBoundingClientRect().width < 36 || iconTransform === 'none' || compare.getBoundingClientRect().width > 30) throw new Error('Optimize hover expansion failed: ' + JSON.stringify({ hovered: optimize.matches(':hover'), width, labelWidth: label.getBoundingClientRect().width, opacity: style.opacity, iconTransform, compareWidth: compare.getBoundingClientRect().width })); return { width, labelWidth: label.getBoundingClientRect().width, iconTransform }; })()" in the webview
    Then I take a screenshot "03-optimize-expanded"

    When I move the mouse to 20, 20
    And I resize the Dev Host to 560 by 800
    And I wait 1 second
    When I evaluate "(async () => { const section = document.querySelector('kw-query-section'); const compare = document.getElementById(section.boxId + '_compare_btn'); const optimize = document.getElementById(section.boxId + '_optimize_btn'); compare.focus({ focusVisible: true }); await new Promise(resolve => setTimeout(resolve, 250)); const compareRect = compare.getBoundingClientRect(); const optimizeRect = optimize.getBoundingClientRect(); const cacheRect = section.querySelector('.cache-controls')?.getBoundingClientRect(); const sectionRect = section.getBoundingClientRect(); const label = compare.querySelector('.optimize-query-label'); if (!compare.matches(':focus-visible') || compareRect.width < 72 || label.getBoundingClientRect().width < 36 || compareRect.right > optimizeRect.left || (cacheRect && optimizeRect.right > cacheRect.left) || compareRect.left < sectionRect.left || compareRect.right > sectionRect.right) throw new Error('Keyboard expansion overlaps at narrow width: ' + JSON.stringify({ focusVisible: compare.matches(':focus-visible'), compare: compareRect.toJSON(), optimize: optimizeRect.toJSON(), cache: cacheRect?.toJSON(), section: sectionRect.toJSON() })); return { compare: compareRect.toJSON(), optimize: optimizeRect.toJSON(), cache: cacheRect?.toJSON() }; })()" in the webview
    Then I take a screenshot "04-compare-keyboard-focus-narrow"
    When I execute command "workbench.action.closeAllEditors"