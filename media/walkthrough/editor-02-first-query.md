# Run your first query

Now that you're connected, let's execute a query.

## Writing and running a query

1. Click inside the query editor area, you'll see a Monaco editor with full KQL IntelliSense.
2. Look at the toolbar, explore it for a bit. It has a couple of features you want to make sure are tweaked to your liking
    1. Auto-completions as you type. If you keep them on, they pop-up on their own. Turn it off to exclusively control when they pop up using CTRL+SPACE.
    2. Copilot inline suggestions, aka ghost text. Toggle that on / off as you please. You can trigger it manually through SHIFT+SPACE.
    3. Smart documentation. It is meant to help those familiar with SQL and other data platforms be reminded how Kusto syntax works via a permanent banner at the top that tracks the cursor and shows documentation. 
3. Type a simple query to get started, for example:

```kql
StormEvents
| take 10
```

3. Press **Shift+Enter** to execute the query, or click the **Run** button in the query toolbar.

The results will appear in a table below the query editor.

## What you'll see

* **Row count and execution time** are displayed in the status bar above the results.
* **Column headers** are clickable for sorting.
* **Large result sets** use virtual scrolling so performance stays smooth even with thousands of rows.