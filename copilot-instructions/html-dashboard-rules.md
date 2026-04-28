# Kusto Workbench HTML Dashboard Rules

Use this guide whenever you create, edit, repair, validate, or upgrade an HTML dashboard section.

## Dashboard Checklist

1. Start from an event-grain fact query. The query that feeds the dashboard should return raw rows with dimensions and measures, not a set of already-specialized widget queries. Use `summarize`, `make-series`, or top-N shaping only when the resulting grain is still the intended reusable fact model.
2. Keep one fact query as the primary model whenever possible. A dashboard may have supporting query sections, but every exportable value must trace back through the provenance contract.
3. Add or repair a `<script type="application/kw-provenance">` block before finalizing dashboard code.
4. Use `version: 1`, a `model.fact.sectionId`, optional `model.dimensions`, and a `bindings` object. Each binding must define a `display` object with a supported `type` and the fields required by that display shape.
5. Add matching `data-kw-bind="bindingId"` attributes for every exportable scalar, table, pivot, bar, pie, and line visual.
6. Render data through the dashboard bridge: `KustoWorkbench.bind(bindingId, value)`, `KustoWorkbench.bindHtml(bindingId, html)`, and `KustoWorkbench.renderChart(bindingId)`. Do not render exportable charts with manual SVG/canvas/chart libraries.
7. Use only supported display types for Power BI export: `scalar`, `table`, `pivot`, `bar`, `pie`, and `line`.
8. For exportable charts, call `KustoWorkbench.renderChart(bindingId)` into the matching `data-kw-bind` target. This keeps the preview and Power BI export path aligned.
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
    KustoWorkbench.bindHtml('recentFailures', kw.groupBy(['Timestamp', 'Region', 'ErrorCode', 'Message'])
      .addCount('Events')
      .orderBy('Timestamp', 'desc')
      .topN(25, 'Timestamp', 'desc')
      .toTable(['Timestamp', 'Region', 'Error Code', 'Message', 'Events']));
  });
  KustoWorkbench.renderChart('requestsOverTime');
  KustoWorkbench.renderChart('failuresByRegion');
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
      "display": { "type": "scalar | table | pivot | bar | pie | line" }
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
- `table`: grouped table. Use `display.groupBy`, `display.columns[]`, optional `orderBy`, `top`, and `preAggregate`.
- `pivot`: matrix-style grouping. Use `rows`, `pivotBy`, `pivotValues`, `value`, `agg`, optional `format`, `total`, and `preAggregate`.
- `bar`: categorical comparison. Use `groupBy`, `value: { agg, column?, format? }`, optional `top`, `colors`, and `preAggregate`.
- `pie`: part-to-whole categorical chart. Use `groupBy`, `value: { agg, column?, format? }`, optional `top`, `colors`, and `preAggregate`.
- `line`: time or ordered series. Use `xAxis`, `series: [{ agg, column?, label? }]`, optional `colors`, and `preAggregate`.

Do not use unsupported display names in provenance. The Power BI exporter rejects them.

## Chart Rules

- Use `KustoWorkbench.renderChart(bindingId)` for every exportable `bar`, `pie`, and `line` visual.
- Do not hand-build exportable charts with SVG, canvas, ECharts, D3, or HTML bars.
- Do not use `bindHtml()` to render exportable charts unless the target is intentionally preview-only and not represented as a chart in Power BI.
- If an existing dashboard has manual chart functions such as `buildLineChart`, `buildPieChart`, or `buildBarChart`, upgrade them to provenance chart bindings when touching the dashboard.
- Keep chart containers sized with CSS so the preview does not shift while data loads.

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

Use `preAggregate` when a binding needs a two-level aggregation, such as distinct skills per session followed by session-count distribution. Supported on table, pivot, bar, pie, and line bindings.

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