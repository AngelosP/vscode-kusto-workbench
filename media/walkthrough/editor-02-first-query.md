# Run Your First Query

Now that you're connected, let's execute a query.

## Writing and running a query

1. Click inside the query editor area — you'll see a Monaco editor with full KQL IntelliSense.
2. Type a simple query to get started, for example:

```kql
StormEvents
| take 10
```

3. Press **Shift+Enter** to execute the query, or click the **Run** button in the query toolbar.

The results will appear in a table below the query editor.

## What you'll see

- **Row count and execution time** are displayed in the status bar above the results.
- **Column headers** are clickable for sorting.
- **Large result sets** use virtual scrolling so performance stays smooth even with thousands of rows.

## Keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| Run query | `Shift+Enter` |
| New query section | Click the **+** button below the current section |
| Toggle results | Click the results header to collapse/expand |

You're now ready to explore the tools that make working with results even more powerful.
