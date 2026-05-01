# Kusto Workbench HTML Dashboard Rules

Use this guide whenever you create, edit, repair, validate, or upgrade an HTML dashboard section.

## Dashboard Checklist

1. Start from an event-grain fact query. The query that feeds the dashboard should return raw rows with dimensions and measures, not a set of already-specialized widget queries. Use `summarize`, `make-series`, or top-N shaping only when the resulting grain is still the intended reusable fact model.
2. Keep one fact query as the primary model whenever possible. A dashboard may have supporting query sections, but every exportable value must trace back through the provenance contract.
3. Add or repair a `<script type="application/kw-provenance">` block before finalizing dashboard code.
4. Use `version: 1`, a `model.fact.sectionId`, optional `model.dimensions`, and a `bindings` object. Each binding must define a `display` object with a supported `type` and the fields required by that display shape.
5. Add matching `data-kw-bind="bindingId"` attributes for every exportable scalar, table, repeated table, pivot, bar, pie, and line visual.
6. Render exportable data through the dashboard bridge: `KustoWorkbench.bind(bindingId, value)`, `KustoWorkbench.renderChart(bindingId)`, `KustoWorkbench.renderTable(bindingId)`, and `KustoWorkbench.renderRepeatedTable(bindingId)`. Use `bindHtml()` only for preview-only custom HTML that is not expected to survive Power BI export.
7. Use only supported display types for Power BI export: `scalar`, `table`, `repeatedTable`, `pivot`, `bar`, `pie`, and `line`.
8. For exportable charts, call `KustoWorkbench.renderChart(bindingId)` into the matching `data-kw-bind` target. For exportable table bodies, including visual cells, call `KustoWorkbench.renderTable(bindingId)`. For exportable grouped/repeated table sections, call `KustoWorkbench.renderRepeatedTable(bindingId)` into a visible container target. This keeps the preview and Power BI export path aligned.
9. Add slicers through `model.dimensions` in provenance. The preview injects matching slicer controls and filters the event-grain fact model before bindings compute values.
10. If the dashboard already exists, upgrade it while you work on it. Bring provenance, bindings, slicers, chart rendering, and styling up to the latest contract and capabilities as part of the requested task. Do this silently when deterministic; ask the user only if the upgrade would remove content, change business meaning, or require choosing between ambiguous models.
11. After configuring the HTML section, call `validateHtmlDashboard(sectionId)`. Fix every issue. Treat warnings about legacy/manual chart patterns as upgrade work whenever the user is asking you to modify that dashboard.
12. Preview the section after validation when possible. The final answer should say whether validation passed and mention any remaining limitation.

## Starter Template

```html
<section class="kw-dashboard">
  <header class="dashboard-header">
    <div>
      <p class="eyebrow">Operations</p>
      <h1>Service Health</h1>
    </div>
  </header>

  <main class="metric-grid">
    <article class="metric-card" data-kw-bind="totalRequests"></article>
    <article class="metric-card" data-kw-bind="failureRate"></article>
  </main>

  <section class="chart-row">
    <article class="panel">
      <h2>Requests Over Time</h2>
      <div class="chart" data-kw-bind="requestsOverTime"></div>
    </article>
    <article class="panel">
      <h2>Failures By Region</h2>
      <div class="chart" data-kw-bind="failuresByRegion"></div>
    </article>
  </section>

  <section class="panel">
    <h2>Recent Failures</h2>
    <table>
      <thead>
        <tr>
          <th>Timestamp</th>
          <th>Region</th>
          <th>Error Code</th>
          <th>Message</th>
          <th>Events</th>
        </tr>
      </thead>
      <tbody data-kw-bind="recentFailures"></tbody>
    </table>
  </section>

  <script type="application/kw-provenance">
  {
    "version": 1,
    "model": {
      "fact": {
        "sectionId": "query-section-id",
        "sectionName": "Service Health Facts",
        "grain": "event"
      },
      "dimensions": [
        { "column": "Region", "label": "Region", "mode": "dropdown" },
        { "column": "Timestamp", "label": "Date", "mode": "between" }
      ]
    },
    "bindings": {
      "totalRequests": {
        "display": { "type": "scalar", "agg": "COUNT", "format": "#,##0" }
      },
      "failureRate": {
        "display": { "type": "scalar", "agg": "AVG", "column": "IsFailure", "format": "0.0%" }
      },
      "requestsOverTime": {
        "display": {
          "type": "line",
          "xAxis": "Timestamp",
          "series": [
            { "agg": "COUNT", "label": "Requests" }
          ]
        }
      },
      "failuresByRegion": {
        "display": {
          "type": "bar",
          "groupBy": "Region",
          "value": { "agg": "SUM", "column": "IsFailure", "format": "#,##0" },
          "top": 10
        }
      },
      "recentFailures": {
        "display": {
          "type": "table",
          "groupBy": ["Timestamp", "Region", "ErrorCode", "Message"],
          "columns": [
            { "name": "Timestamp", "header": "Timestamp" },
            { "name": "Region", "header": "Region" },
            { "name": "ErrorCode", "header": "Error Code" },
            { "name": "Message", "header": "Message" },
            { "name": "Events", "agg": "COUNT", "header": "Events", "format": "#,##0" }
          ],
          "orderBy": { "column": "Timestamp", "direction": "desc" },
          "top": 25
        }
      }
    }
  }
  </script>

  <script>
  KustoWorkbench.onDataReady(function() {
    var kw = KustoWorkbench.agg();
    KustoWorkbench.bind('totalRequests', kw.count());
    KustoWorkbench.bind('failureRate', (kw.avg('IsFailure') * 100).toFixed(1) + '%');
  });
  KustoWorkbench.renderChart('requestsOverTime');
  KustoWorkbench.renderChart('failuresByRegion');
  KustoWorkbench.renderTable('recentFailures');
  </script>
</section>
```

## Fact Query Rules

- Prefer one reusable event-grain query that includes all dimensions and measures needed by the dashboard.
- Keep stable column names. The provenance contract references column names exactly, and Power BI export validates those names.
- Include time columns as real `datetime` values when time-series charts are needed.
- Include categorical dimensions as separate columns, not embedded JSON or formatted strings.
- Include numeric measures as numeric columns whenever the chart needs aggregation.
- Avoid hiding dashboard logic inside custom JavaScript transforms. Put aggregation intent in provenance through `display.agg`, `display.value`, `display.series`, table column specs, or `preAggregate`.

## Provenance Contract

The dashboard provenance block is the export contract. It must be valid JSON inside:

```html
<script type="application/kw-provenance">{ ... }</script>
```

Required shape:

```json
{
  "version": 1,
  "model": {
    "fact": {
      "sectionId": "query-section-id",
      "sectionName": "Fact Query Name",
      "grain": "event"
    },
    "dimensions": [
      { "column": "Region", "label": "Region", "mode": "dropdown" }
    ]
  },
  "bindings": {
    "bindingId": {
      "display": { "type": "scalar | table | repeatedTable | pivot | bar | pie | line" }
    }
  }
}
```

Rules:

- Every exportable DOM target must have `data-kw-bind="bindingId"` and a matching provenance binding.
- Every provenance binding that should appear in the dashboard should have one matching DOM target.
- Keep binding IDs stable and descriptive. They are used by preview code and the export path.
- Do not create bindings for decoration-only UI.

## Display Types

Supported Power BI export display types:

- `scalar`: one value. Use `display.agg`, optional `display.column`, and optional `display.format`.
- `table`: grouped table. Use `display.groupBy`, `display.columns[]`, optional `orderBy`, `top`, `preAggregate`, and `tooltip`. `top` requires `orderBy` so preview and export choose the same rows. Use `columns[].cellBar` for exportable stacked bars inside table cells.
- `repeatedTable`: repeated grouped table sections. Use `repeatBy`, optional `repeatColumns`, optional `repeatOrderBy`, optional `repeatTop`, and `table: { groupBy, columns, orderBy?, top?, tooltip? }`. Bind it to a visible container such as `<div data-kw-bind="errorsByEvent"></div>` and call `KustoWorkbench.renderRepeatedTable(bindingId)`.
- `pivot`: matrix-style grouping. Use `rows`, `pivotBy`, `pivotValues`, `value`, `agg`, optional `format`, `total`, and `preAggregate`.
- `bar`: categorical comparison or segmented status distribution. Use `groupBy` plus either `value: { agg, column?, format? }`, `segments`, `value` with `thresholdBands`, or `value` with `colorRules`. Optional fields: `top`, `colors`, `variant`, `showValueLabels`, `showCategoryLabels`, `preAggregate`, and `tooltip`. Use `scale: "normalized100"` only with `segments`.
- `pie`: part-to-whole categorical chart. Use `groupBy`, `value: { agg, column?, format? }`, optional `top`, `colors`, `preAggregate`, and `tooltip`.
- `line`: time or ordered series. Use `xAxis`, `series: [{ agg, column?, label? }]`, optional `colors`, `preAggregate`, and `tooltip`.

Do not use unsupported display names in provenance. The Power BI exporter rejects them.

## Tooltip Rules

Dashboard tooltips are supported only inside HTML dashboard provenance bindings that render through `KustoWorkbench.renderChart()`, `KustoWorkbench.renderTable()`, or `KustoWorkbench.renderRepeatedTable()` and export to Power BI. Do not use notebook chart `tooltipColumns`, custom mouse handlers, Lit popovers, ECharts tooltips, or shared result-table tooltips for Power BI dashboard behavior.

Add a `tooltip` object to supported dashboard displays:

```json
{
  "tooltip": {
    "fields": [
      { "label": "Devices", "agg": "DCOUNT", "column": "DeviceId", "format": "#,##0" },
      { "label": "Failure %", "agg": "AVG", "column": "FailureRate", "format": "0.0%" }
    ]
  }
}
```

Rules:

- `tooltip.fields` must be non-empty.
- Use `{ "column": "ColumnName" }` for a row value that exists in the rendered row, such as a table group column, a table output column, a bar/pie `groupBy`, or a line `xAxis`.
- Use `{ "agg": "COUNT|SUM|AVG|AVERAGE|MIN|MAX|DCOUNT|DISTINCTCOUNT", "column": "FactColumn" }` for an extra aggregate. `COUNT` is row-count-only and must omit `column`; every other aggregate must include `column`.
- `label` and `format` are optional strings. Avoid `</script>` in tooltip labels and formats because provenance is JSON embedded in a script tag.
- With `preAggregate`, tooltip columns follow the same rules as the display: they can reference only the pre-aggregate output columns, and aggregate fields summarize over those outputs.
- In repeated tables, put `tooltip` on the inner `table` object. Repeated header tooltips are not part of the export contract.
- Power BI export uses static HTML/SVG metadata (`title`, `aria-label`, and SVG `<title>`). This gives native hover text in the HTML Content visual without custom JavaScript; it is not a native Power BI tooltip field well.

## Table Rules

- Use `KustoWorkbench.renderTable(bindingId)` for every exportable `table` binding.
- Bind either a full `<table data-kw-bind="bindingId"></table>` or a `<tbody data-kw-bind="bindingId"></tbody>` inside a table.
- Do not use `bindHtml(...toTable())` for tables that need to export visual cells, custom row HTML, or generated `<td>` content. That path is preview-only because Power BI export rebuilds table rows from provenance.
- Keep plain table columns as `{ "name": "ColumnName" }` for grouped dimensions or `{ "name": "OutputName", "agg": "COUNT|SUM|AVG|MIN|MAX|DCOUNT", "sourceColumn": "FactColumn" }` for computed values.
- Use `orderBy` whenever you use `top`; table specs with `top` but no `orderBy` are invalid.
- Add stacked bars inside cells with a visual-only column that has `name`, optional `header`, and `cellBar`. Do not add `agg`, `sourceColumn`, or `format` to the cell-bar column itself.
- Cell bars currently support stacked `segments` only. Use standalone `bar` displays for threshold bands, whole-bar color rules, legends, or axis labels.
- Add conditional table-cell formatting with `columns[].cellFormat` directly on the grouped or aggregate column being displayed. Do not use table-level `cellFormats`, `conditionalFormats`, or format-only columns; those are legacy/unsupported shapes and will not export reliably.
- For aggregate columns, always set `name` to the output alias and `sourceColumn` to the fact column being summarized. The displayed cell value comes from `columns[].name`; `cellFormat.valueColumn` is only for comparing against a different already-summarized numeric column.
- `cellFormat.rules[]` are first-match numeric threshold rules over raw summarized values, not the formatted display string. For percent-like columns, prefer query values as fractions from `0` to `1`, use `format: "0.##%"`, and compare thresholds on that same fractional scale, such as `0.8` for 80%. If the query returns percentage points like `80`, divide by 100 in the query before binding or use a non-percent numeric format.
- Dashboard percent formats follow Power BI semantics: `format: "0.##%"` renders `0.68` as `68%` in preview and export. Do not pre-multiply values before applying a `%` format.
- In unioned dashboard fact queries where different row families populate different metrics, keep non-applicable numeric metrics as typed nulls and aggregate display columns with `MAX`, `MIN`, or another appropriate aggregation over the real source column. Do not create separate display columns that only contain null placeholders.
- `cellFormat.mode` defaults to `"badge"`; use `"cell"` to apply the style to the whole `<td>`. Supported inline styles are `backgroundColor`, `color`, and `fontWeight` (`"normal"`, `"600"`, or `"bold"`). Keep colors simple hex/rgb/hsl/named colors.
- Do not combine `cellFormat` and `cellBar` on one column. Do not use `cellFormat` in `repeatColumns`; use it in the inner repeated table's `table.columns` instead.
- Add row hover details with `display.tooltip`; the preview and Power BI export attach safe `title` and `aria-label` metadata to generated rows.

Example table-cell status bar:

```html
<table data-kw-bind="serviceHealth"></table>
<script>
KustoWorkbench.renderTable('serviceHealth');
</script>
```

```json
{
  "display": {
    "type": "table",
    "groupBy": ["Service"],
    "columns": [
      { "name": "Service", "header": "Service" },
      { "name": "Total", "agg": "COUNT", "header": "Events", "format": "#,##0" },
      {
        "name": "Breakdown",
        "header": "Status",
        "cellBar": {
          "segments": [
            { "agg": "SUM", "column": "Succeeded", "label": "Succeeded", "color": "#2E7D32" },
            { "agg": "SUM", "column": "Warning", "label": "Warning", "color": "#F9A825" },
            { "agg": "SUM", "column": "Failed", "label": "Failed", "color": "#C62828" }
          ],
          "scale": "normalized100",
          "width": 160,
          "height": 10
        }
      }
    ],
    "orderBy": { "column": "Total", "direction": "desc" },
    "top": 25
  }
}
```

`scale: "normalized100"` makes each nonzero row fill the cell width and show that row's proportions. `scale: "relative"` scales each row against the largest rendered row total.

Example conditional percentage badge:

```json
{
  "name": "SuccessRate",
  "header": "Success %",
  "agg": "AVG",
  "sourceColumn": "SuccessRate",
  "format": "0.##%",
  "cellFormat": {
    "mode": "badge",
    "rules": [
      { "operator": "<", "value": 0.8, "backgroundColor": "#FDE7E9", "color": "#C62828", "fontWeight": "600" }
    ],
    "defaultStyle": { "backgroundColor": "#E7F3E7", "color": "#2E7D32", "fontWeight": "600" }
  }
}
```

## Repeated Table Rules

- Use `KustoWorkbench.renderRepeatedTable(bindingId)` for every exportable `repeatedTable` binding.
- Bind repeated tables to a visible non-table container, such as `<div data-kw-bind="errorsByEvent"></div>`. Do not bind them to `<table>`, `<tbody>`, hidden elements, or `<template>`.
- Use `repeatBy` for the outer group columns and `repeatColumns` for header values or aggregate counts shown above each inner table. If `repeatColumns` is omitted, the repeat group columns are shown.
- Use `table.groupBy` and `table.columns` for the inner table rows. Inner table columns follow the same rules as normal table columns, including `columns[].cellBar` and `columns[].cellFormat`.
- Put repeated-table row hover details on `table.tooltip`; outer repeated headers do not currently emit exportable hover details.
- Use `repeatOrderBy` whenever you use `repeatTop`; use `table.orderBy` whenever the inner `table` uses `top`.

Example repeated table:

```html
<div data-kw-bind="errorsByEvent"></div>
<script>
KustoWorkbench.renderRepeatedTable('errorsByEvent');
</script>
```

```json
{
  "display": {
    "type": "repeatedTable",
    "repeatBy": ["EventName"],
    "repeatColumns": [
      { "name": "EventName", "header": "Event" },
      { "name": "Occurrences", "agg": "COUNT", "header": "Occurrences", "format": "#,##0" }
    ],
    "repeatOrderBy": { "column": "Occurrences", "direction": "desc" },
    "repeatTop": 10,
    "table": {
      "groupBy": ["Message", "ErrorCode"],
      "columns": [
        { "name": "Message", "header": "Message" },
        { "name": "ErrorCode", "header": "Code" },
        { "name": "Rows", "agg": "COUNT", "header": "Rows", "format": "#,##0" }
      ],
      "orderBy": { "column": "Rows", "direction": "desc" },
      "top": 5
    }
  }
}
```

## Chart Rules

- Use `KustoWorkbench.renderChart(bindingId)` for every exportable `bar`, `pie`, and `line` visual.
- Do not hand-build exportable charts with SVG, canvas, ECharts, D3, or HTML bars.
- Do not use `bindHtml()` to render exportable charts unless the target is intentionally preview-only and not represented as a chart in Power BI.
- If an existing dashboard has manual chart functions such as `buildLineChart`, `buildPieChart`, or `buildBarChart`, upgrade them to provenance chart bindings when touching the dashboard.
- Keep chart containers sized with CSS so the preview does not shift while data loads.
- Add chart hover details with `display.tooltip`; the preview and Power BI export attach SVG `<title>` plus safe `title`/`aria-label` metadata to bar, pie, and line chart marks. Line charts show visible point markers at each tooltip target so users can see where to hover.

### Bar Chart Options

Simple bars keep the existing shape:

```json
{
  "display": {
    "type": "bar",
    "groupBy": "Region",
    "value": { "agg": "COUNT", "format": "#,##0" },
    "top": 10
  }
}
```

Use `segments` when the fact query already exposes one numeric column per status or bucket. This renders one stacked horizontal bar per `groupBy` value.

```json
{
  "display": {
    "type": "bar",
    "groupBy": "Service",
    "segments": [
      { "agg": "SUM", "column": "Healthy", "label": "Healthy", "color": "#2E7D32" },
      { "agg": "SUM", "column": "Warning", "label": "Warning", "color": "#F9A825" },
      { "agg": "SUM", "column": "Critical", "label": "Critical", "color": "#C62828" }
    ]
  }
}
```

For screenshot-style compact status bars, combine `segments` with `scale: "normalized100"` and `variant: "distribution"`. Each nonzero row fills the full available bar width and segment widths show that row's proportions.

```json
{
  "display": {
    "type": "bar",
    "groupBy": "Service",
    "segments": [
      { "agg": "SUM", "column": "Succeeded", "color": "#2E7D32" },
      { "agg": "SUM", "column": "Failed", "color": "#C62828" }
    ],
    "scale": "normalized100",
    "variant": "distribution",
    "showValueLabels": false
  }
}
```

Use `thresholdBands` when one value should be split across fixed numeric ranges. Bands must start at `0`, be contiguous, and can set `scaleMax` to control the full bar width. `thresholdBands` does not use `scale: "normalized100"`.

```json
{
  "display": {
    "type": "bar",
    "groupBy": "Service",
    "value": { "agg": "AVG", "column": "LatencyMs", "format": "#,##0 ms" },
    "thresholdBands": {
      "scaleMax": 1000,
      "bands": [
        { "min": 0, "max": 250, "color": "#2E7D32" },
        { "min": 250, "max": 750, "color": "#F9A825" },
        { "min": 750, "max": 1000, "color": "#C62828" }
      ]
    }
  }
}
```

Use `colorRules` when the whole bar should change color based on its computed value. Rules are evaluated in order and fall back to the normal chart palette.

```json
{
  "display": {
    "type": "bar",
    "groupBy": "Service",
    "value": { "agg": "AVG", "column": "FailureRate", "format": "0.0%" },
    "colorRules": [
      { "operator": ">=", "value": 0.1, "color": "#C62828" },
      { "operator": ">=", "value": 0.03, "color": "#F9A825" },
      { "operator": "<", "value": 0.03, "color": "#2E7D32" }
    ]
  }
}
```

## Slicers

Use `model.dimensions` for filter controls that should affect preview bindings and export behavior. The extension injects slicer controls above the dashboard and composes filters with AND semantics before bindings compute values.

```json
{
  "model": {
    "dimensions": [
      { "column": "Region", "label": "Region", "mode": "dropdown" },
      { "column": "Severity", "label": "Severity", "mode": "list" },
      { "column": "Timestamp", "label": "Date", "mode": "between" }
    ]
  }
}
```

Rules:

- Use `mode: "dropdown"`, `"list"`, or `"between"`. Date and datetime dimensions default to `between`.
- Do not hand-code slicer controls for exportable filters unless there is a specific preview-only reason.
- Slicers should filter the fact model, not only hide already-rendered DOM nodes.

## PreAggregate

Use `preAggregate` when a binding needs a two-level aggregation, such as distinct skills per session followed by session-count distribution. Supported on table, repeatedTable, pivot, bar, pie, and line bindings.

```json
{
  "display": {
    "type": "bar",
    "groupBy": "SkillCount",
    "value": { "agg": "COUNT", "format": "#,##0" },
    "preAggregate": {
      "groupBy": "SessionId",
      "compute": { "name": "SkillCount", "agg": "DISTINCTCOUNT", "column": "SkillName" }
    }
  }
}
```

Rules:

- `groupBy` may be a string or an array of strings.
- `compute.name` must not collide with an existing fact column name or the `groupBy` output columns.
- If `compute.agg` is not `COUNT`, provide `compute.column`.

## Styling Defaults

- Build the actual dashboard as the first screen, not a marketing page.
- Use compact, scan-friendly operational layouts: header, filters, KPI strip, charts, detail table.
- Keep cards at 8px radius or less unless matching an existing local style.
- Do not put cards inside cards.
- Use responsive grid constraints, aspect ratios, and fixed tool/control dimensions to prevent layout shifts.
- Avoid one-note palettes. Use restrained neutrals with a small number of semantic accents.
- Ensure all text fits on desktop and mobile without overlap.

## Upgrade On Touch

When a user asks you to modify an existing dashboard, inspect and upgrade the dashboard to the latest Kusto Workbench dashboard contract while completing the requested task.

Perform deterministic upgrades silently:

- Add missing `version: 1` provenance when the fact model is clear.
- Repair stale or missing `data-kw-bind` targets.
- Replace legacy manual chart rendering with provenance chart bindings and `KustoWorkbench.renderChart()`.
- Add or repair slicer definitions and bridge calls when the current UI already implies those filters.
- Rename only internal binding IDs when references can be updated consistently.
- Update styling to current responsive dashboard expectations when it does not change business meaning.

Ask the user before upgrading when:

- The fact query or primary model is ambiguous.
- The upgrade would remove visible content or change the metric definition.
- A manual visual has no obvious supported Power BI equivalent.
- Multiple dashboard contracts could be valid and the choice affects user expectations.

## Validation Workflow

1. Call `getHtmlDashboardGuide({ "mode": "checklist" })` before dashboard work. Use `full` when repairing a complex or failing dashboard, and `template` when creating a new dashboard from scratch.
2. Configure the HTML section with `configureHtmlSection`.
3. Call `validateHtmlDashboard({ "sectionId": "..." })`.
4. Fix every returned issue. Treat warnings as required upgrades when the user is asking you to modify that dashboard and the fix is deterministic.
5. Re-run validation after fixes.
6. Switch the HTML section to preview mode only after validation is clean or after clearly explaining any remaining blocker.