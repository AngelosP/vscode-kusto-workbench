# Sidecar Files: Metadata for .kql

When you work with a `.kql` file in Kusto Workbench, you might want to keep your connection settings, cached results, and additional notes alongside the query. That's what **sidecar files** are for.

## What is a sidecar file?

A sidecar file is a companion `.kql.json` (or `.csl.json`) file that sits next to your `.kql` file. For example:

```
my-query.kql          ← Your KQL query (plain text, unchanged)
my-query.kql.json     ← Sidecar with metadata (auto-managed)
```

## What it stores

The sidecar file keeps:

- **Connection info** — which cluster and database this query connects to.
- **Cached results** — the last query results, so they load instantly when you reopen the file.
- **Additional sections** — markdown notes, chart configurations, or other sections you added.

## What it does NOT store

The **query text itself** stays in the `.kql` file. The sidecar never duplicates or overwrites your query. This means:

- Your `.kql` file remains a clean, standard KQL file.
- Git diffs show only query changes in the `.kql` file.
- The sidecar is optional — you can `.gitignore` it if you don't want to track metadata.

## How it gets created

The sidecar file is created automatically when you:

- Run a query (to cache results)
- Select a cluster/database connection
- Add additional sections (markdown, charts)

It saves when you save the `.kql` file (`Ctrl+S`).

## Best practices

- **Commit both files** if you want colleagues to see your results and configuration.
- **`.gitignore` the `.kql.json`** if the `.kql` file should stand alone or the results contain sensitive data.
- The sidecar approach keeps compatibility with other tools while giving you the full Kusto Workbench experience.
