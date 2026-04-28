---

name: Kusto Workbench

description: Operate Kusto Workbench to query Azure Data Explorer and SQL sources, build charts, create transformations, author HTML dashboards, validate Power BI-ready reports, and organize notebook analyses. Use when the user mentions Kusto, KQL, Azure Data Explorer, ADX, telemetry queries, SQL sections, charting, dashboards, or Power BI export from Kusto Workbench.

tools: ['createKustoFile', 'askKustoCopilot', 'listKustoConnections', 'listKustoFavorites', 'getKustoSchema', 'refreshKustoSchema', 'searchCachedSchemas', 'listSections', 'addSection', 'removeSection', 'reorderSections', 'collapseExpandSection', 'configureKustoQuerySection', 'updateMarkdownSection', 'configureChart', 'configureTransformation', 'configureHtmlSection', 'getHtmlDashboardGuide', 'validateHtmlDashboard', 'manageDevelopmentNotes', 'askSqlCopilot', 'listSqlConnections', 'configureSqlSection', 'getSqlSchema']

# version: 3 - Auto-updated by Kusto Workbench. Do not remove this line.

---

# Kusto Workbench Skill

Kusto Workbench is a VS Code extension that provides a notebook-like experience for Azure Data Explorer, SQL sections, visual analysis, HTML dashboards, and Power BI-ready report export. You operate it through the tools listed above. Use the tools to take action; do not only describe what you could do.

## Tools Reference

| Tool | Purpose |
| ---- | ------- |
| `#createKustoFile` | Create a new file: `kqlx` for notebooks, `kql` or `csl` for single queries |
| `#listSections` | List notebook sections with IDs, file path, file name, and validation status |
| `#addSection` | Add `query`, `markdown`, `chart`, `transformation`, `url`, `python`, or `html` sections |
| `#removeSection`, `#reorderSections`, `#collapseExpandSection` | Organize notebook sections |
| `#configureKustoQuerySection` | Configure a Kusto query section connection and query text |
| `#askKustoCopilot` | Primary KQL tool: write and execute KQL against a configured section |
| `#listKustoConnections`, `#listKustoFavorites` | Discover configured Kusto connections |
| `#getKustoSchema`, `#refreshKustoSchema`, `#searchCachedSchemas` | Inspect and search Kusto schemas |
| `#configureChart` | Configure chart sections. Always inspect returned validation |
| `#configureTransformation` | Configure derive, summarize, pivot, distinct, join, union, sort, filter, or limit transformations |
| `#configureHtmlSection` | Configure HTML section source, name, and code or preview mode |
| `#getHtmlDashboardGuide` | Read the canonical HTML dashboard rules: `checklist`, `template`, or `full` |
| `#validateHtmlDashboard` | Validate an HTML dashboard section against the current dashboard and Power BI export contract |
| `#updateMarkdownSection` | Update markdown section content |
| `#manageDevelopmentNotes` | Read, add, or remove development notes stored in the open file |
| `#listSqlConnections`, `#configureSqlSection`, `#getSqlSchema`, `#askSqlCopilot` | Work with SQL Server/T-SQL sections and schema-aware SQL questions |

## Workflow

### 1. Ensure A File Is Open

- No file open: call `#createKustoFile` with `fileType: "kqlx"`.
- New `kqlx` files include one empty query section. Reuse it.
- File already open: call `#listSections` before adding or editing sections.
- Use returned section IDs instead of guessing.

### 2. Search For Data Across Connections

When you need to find a table, column, function, or piece of data and do not know which cluster/database contains it:

1. Call `#searchCachedSchemas` with a regex pattern for a fast preliminary result.
2. Call `#listKustoFavorites` and `#listKustoConnections` to build the complete deduplicated connection list.
3. Search the relevant cluster/database schemas with `#getKustoSchema` or targeted query work.
4. Be clear about coverage when presenting results.

### 3. Query Kusto Data

The query section must have a cluster and database configured before `#askKustoCopilot` will work.

If `#askKustoCopilot` fails with no configured cluster:

1. Call `#listKustoFavorites`.
2. Call `#configureKustoQuerySection` with `sectionId`, `clusterUrl`, and `database`.
3. Retry `#askKustoCopilot`.

Tips:

- Pass `sectionId` to target an existing query section.
- Specify date ranges when they matter.
- For cross-cluster or cross-database joins, provide fully qualified names because `#askKustoCopilot` cannot infer them by itself.

### 4. Query SQL Data

Use SQL tools for SQL Server/T-SQL work.

1. Call `#listSqlConnections` when the server/database is unknown.
2. Use `#getSqlSchema` or `#askSqlCopilot` for schema-aware query generation.
3. Use `#configureSqlSection` to set connection, database, query text, and execute when appropriate.

### 5. Build Visualizations

1. Run the source query first; charts need data.
2. Add or identify a chart section.
3. Call `#configureChart` with the correct data source and chart parameters.
4. Check `validation.valid`. If false, read `validation.issues` and fix parameters before calling the chart complete.

### 6. Transform Data

1. Ensure the source section has results.
2. Add or identify a transformation section.
3. Call `#configureTransformation` to link sources and configure the operation.
4. Reorder sections so the transformed flow reads clearly.

### 7. Author HTML Dashboards

Use HTML sections for interactive dashboards, rich reports, and Power BI-ready dashboard surfaces.

1. Call `#getHtmlDashboardGuide` with `mode: "checklist"` before creating, editing, repairing, or upgrading a dashboard. Use `full` for complex repairs and `template` for a starter dashboard.
2. Create or identify an event-grain fact query with `#askKustoCopilot`. It should return all columns needed for KPIs, tables, charts, and slicers.
3. Add or identify the HTML section.
4. Configure HTML with a `<script type="application/kw-provenance">` block, matching `data-kw-bind` attributes, `KustoWorkbench.agg()`, `bind()`, `bindHtml()`, and `renderChart()`.
5. Use only supported export display types: `scalar`, `table`, `pivot`, `bar`, `pie`, and `line`.
6. Use `KustoWorkbench.renderChart(bindingId)` for exportable charts. Manual SVG, canvas, ECharts, D3, or `bindHtml()` charts are preview-only unless represented by provenance bindings.
7. Use `preAggregate` for supported table, pivot, bar, pie, and line bindings that need two-level aggregation, such as per-session distinct counts followed by a distribution. Keep `compute.name` distinct from fact and preAggregate group columns.
8. Call `#configureHtmlSection`, then `#validateHtmlDashboard`. Fix all issues and revalidate before switching to preview mode.

Upgrade on touch:

- When the user asks you to modify an existing dashboard, upgrade it to the latest dashboard contracts, specs, and capabilities as part of the requested work.
- Upgrade provenance, bindings, slicer dimensions, exportable chart rendering, preview bridge usage, and responsive styling when deterministic.
- Replace legacy manual exportable chart rendering with provenance chart bindings plus `KustoWorkbench.renderChart(bindingId)`.
- Add or repair `data-kw-bind` targets so Power BI export can resolve every exportable value.
- Do this silently as part of the dashboard task. Ask the user only if the change would remove visible content, alter metric meaning, or require choosing between ambiguous fact models.

### 8. Document And Organize

- Use markdown sections for observations, summaries, methodology, and recommendations.
- Use `#reorderSections` with all section IDs in desired order.
- Use `#manageDevelopmentNotes` for durable implementation notes and gotchas stored in the file.

## Verifying Tool Responses

Never assume success. Always check responses for `success`, `error`, and validation details.

For `#askKustoCopilot` connection errors, follow the returned `fix` instructions and retry.

For `#configureChart`, if `validation.valid` is false, read `validation.issues` and fix the chart parameters.

For `#validateHtmlDashboard`, fix every issue before calling the dashboard Power BI export-ready. Warnings identify compatibility or upgrade work.

## Key Rules

- Configure Kusto query sections before calling `#askKustoCopilot`.
- Charts and transformations need source sections with results first.
- Use `#listSections` when you need section IDs.
- Be proactive: execute, visualize, document, validate, and organize without asking permission for obvious next steps.
- Use fully qualified names when joining data across databases or clusters.
- Never update an open Kusto Workbench file from outside the editor unless absolutely necessary. Use Kusto Workbench tools so section chat history is preserved.