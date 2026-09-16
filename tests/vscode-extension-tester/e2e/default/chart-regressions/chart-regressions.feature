Feature: Chart regressions - live webview state and renderer options

  Background:
    Given the extension is in a clean state
    When I move the Dev Host to 0, 0
    And I resize the Dev Host to 1300 by 950
    And I capture the output channel "Kusto Workbench"
    And I wait 2 seconds

  Scenario: Tool chart titles and heatmap numeric categories survive live rendering
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.clearSections(); })()" in the webview "session.kqlx"
    And I wait 2 seconds

    When I evaluate "(() => { if (!window.__e2e?.chart) throw new Error('Chart E2E bridge unavailable'); return window.__e2e.chart.assertTitleSyncAndHeatmapNumericCategories(); })()" in the webview "session.kqlx"
    And I wait 1 second
    When I evaluate "(() => { if (!window.__e2e?.chart) throw new Error('Chart E2E bridge unavailable'); const chart = document.getElementById('chart_e2e_heatmap_regression'); const canvas = document.getElementById('chart_e2e_heatmap_regression_chart_canvas_preview'); const state = window.chartStateByBoxId?.chart_e2e_heatmap_regression; const error = canvas?.querySelector('.error-message')?.textContent || ''; if (!chart?.isConnected || !canvas || error || !state?.__echarts?.instance) throw new Error('Unstable chart fixture: ' + JSON.stringify({ connected: !!chart?.isConnected, canvas: !!canvas, error, dataSourceId: state?.dataSourceId, canvasId: state?.__echarts?.canvasId })); return 'chart remained connected and rendered'; })()" in the webview "session.kqlx"

  Scenario: Chart consumer pins, rebinds, and revokes immutable result revisions
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.clearSections(); })()" in the webview "session.kqlx"
    And I wait 2 seconds

    When I evaluate "(() => { if (!window.__e2e?.chart) throw new Error('Chart E2E bridge unavailable'); return window.__e2e.chart.assertArtifactPinAndDependentRebind(); })()" in the webview "session.kqlx" for 20 seconds

  Scenario: Automatic axis title gaps clear labels and hand off to the real slider
    When I execute command "kusto.openQueryEditor"
    And I wait 3 seconds
    When I evaluate "(() => { if (!window.__e2e?.workbench) throw new Error('Workbench E2E bridge unavailable'); return window.__e2e.workbench.clearSections(); })()" in the webview "session.kqlx"
    And I wait 2 seconds
    When I evaluate "(() => { if (!window.__e2e?.chart) throw new Error('Chart E2E bridge unavailable'); return window.__e2e.chart.prepareAdaptiveAxisTitleGap(); })()" in the webview "session.kqlx" for 20 seconds

    Then I collect JSON artifact "axis-title-gap-auto" from webview expression:
      """
      (() => {
        const chart = document.getElementById('chart_e2e_axis_title_gap');
        const state = window.chartStateByBoxId?.chart_e2e_axis_title_gap;
        const option = state?.__echarts?.instance?.getOption?.();
        const xAxis = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
        const yAxis = Array.isArray(option?.yAxis) ? option.yAxis[0] : option?.yAxis;
        const grid = Array.isArray(option?.grid) ? option.grid[0] : option?.grid;
        const slider = chart?.shadowRoot?.querySelector('[data-testid="chart-x-axis-title-gap"] input');
        const label = chart?.shadowRoot?.querySelector('[data-testid="chart-x-axis-title-gap"] .slider-ghost-text')?.textContent?.trim();
        const effectiveX = Number(state?.__effectiveXAxisTitleGap);
        if (state?.xAxisSettings?.titleGap !== 30 || state?.yAxisSettings?.titleGap !== 45) throw new Error('Derived gaps were persisted');
        if (!Number.isFinite(effectiveX) || effectiveX <= 55 || slider?.value !== String(effectiveX) || label !== `Auto (${effectiveX}px)`) throw new Error('Automatic slider state mismatch');
        const textLayout = window.__e2e.chart.axisTextLayout('chart_e2e_axis_title_gap');
        return { storedX: state.xAxisSettings.titleGap, storedY: state.yAxisSettings.titleGap, effectiveX, effectiveY: state.__effectiveYAxisTitleGap, optionX: xAxis?.nameGap, optionY: yAxis?.nameGap, rotation: xAxis?.axisLabel?.rotate, gridBottom: grid?.bottom, gridLeft: grid?.left, sliderValue: slider.value, sliderLabel: label, textLayout };
      })()
      """
    When I click "[data-testid='chart-x-axis-settings']" in the webview "session.kqlx"
    And I wait 1 second
    Then I take a screenshot "automatic-axis-title-gap-control"
    When I focus "[data-testid='chart-x-axis-title-gap'] input" in the webview "session.kqlx"
    And I press "ArrowRight"
    And I wait 1 second
    Then I collect JSON artifact "axis-title-gap-manual" from webview expression:
      """
      (() => {
        const chart = document.getElementById('chart_e2e_axis_title_gap');
        const state = window.chartStateByBoxId?.chart_e2e_axis_title_gap;
        const automaticGap = Number(chart?.dataset?.e2eAutomaticXAxisTitleGap);
        const storedGap = Number(state?.xAxisSettings?.titleGap);
        const option = state?.__echarts?.instance?.getOption?.();
        const xAxis = Array.isArray(option?.xAxis) ? option.xAxis[0] : option?.xAxis;
        const slider = chart?.shadowRoot?.querySelector('[data-testid="chart-x-axis-title-gap"] input');
        const label = chart?.shadowRoot?.querySelector('[data-testid="chart-x-axis-title-gap"] .slider-ghost-text')?.textContent?.trim();
        if (storedGap !== automaticGap + 1 || Number(xAxis?.nameGap) !== storedGap || slider?.value !== String(storedGap) || label !== `${storedGap}px`) throw new Error('Manual slider handoff mismatch');
        return { automaticGap, storedGap, optionGap: xAxis.nameGap, sliderValue: slider.value, sliderLabel: label };
      })()
      """
    When I press "Escape"
    And I wait 1 second
    And I execute command "workbench.action.closeSidebar"
    And I execute command "workbench.action.closeAuxiliaryBar"
    And I execute command "workbench.action.closePanel"
    And I execute command "workbench.action.focusActiveEditorGroup"
    Then I take a screenshot "adaptive-axis-title-chart"
