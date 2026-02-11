# Result caching & run modes

Kusto Workbench has smart features to help you iterate faster and avoid expensive full-table scans.

## Run Modes: Take 100 & Sample 100

Click the **dropdown arrow** next to the Run button to choose a run mode:

| Mode | What it does |
| ---- | ------------ |
| **Run Query (take 100)** | Appends \` |
| **Run Query (sample 100)** | Appends \` |
| **Run Query** | Executes your query exactly as written with no limit. Use this when you need the full result set. |

The selected mode is **remembered per query section**, so each section can have its own configuration.

## Result Caching

When you save your notebook, **query results are saved with it**. This means:

* Reopening the file shows results immediately, no need to re-run queries.
* You can share files with colleagues and they'll see the data without needing cluster access (never share outside of a company controlled environment, like GitHub, Sharepoint, etc and **<span style="color: #ab4642">never share with people who should not have access to the data</span>**!).
* Charts and transformations built on cached results also load instantly.

To refresh stale data, simply re-run the query.

> **Tip:** If your cluster is marked as **Leave No Trace**, results are intentionally *not* persisted to protect sensitive data. Look in the Connection Manager for how to mark a cluster as **Leave No Trace**.