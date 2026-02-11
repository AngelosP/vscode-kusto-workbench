# Result Caching & Run Modes

Kusto Workbench has smart features to help you iterate faster and avoid expensive full-table scans.

## Run Modes: Take 100 & Sample 100

Click the **dropdown arrow** next to the Run button to choose a run mode:

| Mode | What it does |
|------|-------------|
| **Run Query (take 100)** | Appends `\| take 100` to your query, returning the first 100 rows. This is the **default** and is great for quick previews. |
| **Run Query (sample 100)** | Appends `\| sample 100`, returning 100 *random* rows. Useful when you want a representative spread of data instead of just the first rows. |
| **Run Query** | Executes your query exactly as written with no limit. Use this when you need the full result set. |

The selected mode is **remembered per query section**, so each section can have its own default.

## Result Caching

When you save your `.kqlx` notebook, **query results are saved with it**. This means:

- Reopening the file shows results immediately — no need to re-run queries.
- You can share `.kqlx` files with colleagues and they'll see the data without needing cluster access.
- Charts and transformations built on cached results also load instantly.

To refresh stale data, simply re-run the query.

> **Tip:** If your cluster is marked as **"Leave No Trace"**, results are intentionally *not* persisted to protect sensitive data.
