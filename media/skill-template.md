---

name: Kusto Workbench

description: Operate Kusto Workbench to query Azure Data Explorer, build charts, and create notebook reports. Use when the user mentions Kusto, KQL, Azure Data Explorer, ADX, or asks to query/chart telemetry data.

tools: ['createKustoFile', 'askKustoCopilot', 'listKustoConnections', 'listKustoFavorites', 'getKustoSchema', 'refreshKustoSchema', 'searchCachedSchemas', 'listSections', 'addSection', 'removeSection', 'reorderSections', 'collapseExpandSection', 'configureKustoQuerySection', 'updateMarkdownSection', 'configureChart', 'configureTransformation']

# version: 2 — Auto-updated by Kusto Workbench. Do not remove this line.

---

# Kusto Workbench Skill

Kusto Workbench is a VS Code extension that provides a notebook-like experience for Azure Data Explorer (Kusto). You operate it through the tools listed above. **Use the tools to take action; don't just describe what you could do.**

## Tools Reference

| Tool | Purpose |
| ---- | ------- |
| `#createKustoFile` | Create a new file (`kqlx` for notebooks, `kql`/`csl` for single queries) |
| `#askKustoCopilot` | **PRIMARY**: Write and execute KQL queries. The target section must have a connection configured first. |
| `#listKustoConnections` | List configured cluster connections |
| `#listKustoFavorites` | List favorite cluster/database pairs |
| `#getKustoSchema` | Get database schema (tables, columns, functions) for a cluster |
| `#refreshKustoSchema` | Force-refresh schema from the Kusto cluster (bypasses cache) |
| `#searchCachedSchemas` | Search all cached schemas for tables, columns, or functions by regex pattern |
| `#listSections` | List notebook sections with IDs and validation status |
| `#addSection` | Add a section: `query`, `markdown`, `chart`, `transformation`, `url`, `python` |
| `#removeSection` | Remove a section by ID |
| `#reorderSections` | Reorder all sections by providing IDs in desired order |
| `#collapseExpandSection` | Collapse or expand a section |
| `#configureKustoQuerySection` | Configure a query section's connection (set cluster, database, query text) |
| `#updateMarkdownSection` | Update markdown section content |
| `#configureChart` | Configure a chart; returns a `validation` object to verify success |
| `#configureTransformation` | Configure a transformation (derive, summarize, pivot, distinct) |

## Workflow

### 1. Ensure a file is open

* No file open? Call `#createKustoFile` with `fileType: "kqlx"`.
* New kqlx files include one empty query section. Reuse it; do not add another.
* File already open? Call `#listSections` to find existing sections before adding new ones.

### 2. Searching for data across connections

When you need to find a table, column, function, or piece of data and you don't know which cluster/database contains it:

1. **Fast search first:** Call `#searchCachedSchemas` with a regex pattern. These are preliminary results; the cache only covers previously connected databases.
2. **Enumerate all connections:** Call `#listKustoFavorites` and `#listKustoConnections`. Build the complete deduplicated list of every cluster URL + database pair.
3. **Search each connection:** For each cluster/database pair, use `#getKustoSchema` to check for the target schema element.

### 3. Querying data with `#askKustoCopilot`

The query section **must have a cluster and database configured** before `#askKustoCopilot` will work.

**If `#askKustoCopilot` fails with "no cluster connection configured":**

1. Call `#listKustoFavorites` to find saved cluster/database pairs.
2. Call `#configureKustoQuerySection` with `sectionId`, `clusterUrl`, and `database`.
3. Retry `#askKustoCopilot`.

**Example setup flow:**

```
1. #listKustoFavorites → returns [{clusterUrl: "https://help.kusto.windows.net", database: "Samples"}]
2. #configureKustoQuerySection(sectionId: "query_1", clusterUrl: "https://help.kusto.windows.net", database: "Samples")
3. #askKustoCopilot(question: "Show top 10 events", sectionId: "query_1")
```

**Pass `sectionId`** to target an existing query section instead of creating a new one.

**Tips for `#askKustoCopilot`:**

* Always specify the date range you are interested in, unless you don't have that information.
* Do not tell it exactly how to find data in the selected database; it knows the schema better than you do.
* It cannot cross databases or clusters on its own. For cross-cluster/database joins, provide fully qualified table names.

### 4. Building visualizations

1. Run query via `#askKustoCopilot` first; the chart needs data.
2. Call `#addSection` with type `"chart"`.
3. Call `#configureChart` with the correct parameters:

| Chart Type | Required Parameters |
| ---------- | ------------------- |
| `line`, `area`, `bar`, `scatter` | `dataSourceId` + `chartType` + `xColumn` + `yColumns` (array) |
| `pie`, `funnel` | `dataSourceId` + `chartType` + `labelColumn` + `valueColumn` |

4. **Check `validation.valid` in the response.** If `false`, read `validation.issues` and `availableColumns` to fix parameters.

### 5. Transformations

1. Ensure the source section has data.
2. Call `#addSection` with type `"transformation"`.
3. Call `#configureTransformation` to link to source and configure the type.

### 6. Documentation

Call `#addSection` with type `"markdown"`, then `#updateMarkdownSection`.

### 7. Reorganizing content

1. Call `#listSections` to get all section IDs.
2. Call `#reorderSections` with ALL section IDs in the desired order.

You must include every section ID. Missing or unknown IDs will cause an error.

## Verifying Tool Responses

**Never assume success.** Always check responses for errors and validation.

**Connection errors from `#askKustoCopilot`:**

```json
{
  "success": false,
  "error": "Query section has no cluster connection configured.",
  "fix": "Use #configureKustoQuerySection to set up the connection first."
}
```

Follow the `fix` instructions and retry.

**Chart validation from `#configureChart`:**

```json
{
  "success": true,
  "validation": {
    "valid": false,
    "issues": ["bar chart requires yColumns..."],
    "availableColumns": ["timestamp", "count", "category"]
  }
}
```

If `validation.valid` is `false`, read `issues` and fix the parameters.

## Key Rules

* **Connection first:** Configure the query section with `#configureKustoQuerySection` before calling `#askKustoCopilot`.
* **Sequencing:** Charts and transformations need their data source to have results first.
* **Section IDs:** Use `#listSections` when you need a section ID.
* **Be proactive:** Execute, visualize, and document without asking permission.
* **Cross-cluster joins:** Provide fully qualified names when joining data across databases or clusters; `#askKustoCopilot` cannot resolve them on its own.
