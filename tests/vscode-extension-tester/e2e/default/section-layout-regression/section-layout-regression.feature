Feature: Section layout regression across all section types

  Background:
    Given the extension is in a clean state
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
