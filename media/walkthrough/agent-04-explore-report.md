# Explore and tweak your report

The agent got you started, now take a closer look at what it built and optionally make manual adjustments if you feel like it. It's completely up to you whether to keep using the agent, or tweak things manually. You can do both, in any order, just make sure you keep saving your progress.

## Kusto query editor

Click on the query section to see the KQL the agent wrote. You can:

* **Edit the query** directly in the Monaco editor: full IntelliSense, syntax highlighting, and error diagnostics are built in.
* **Re-run** the query with `Shift+Enter` or the Run button.
* Use **"Run Query (take 100)"** or **"Run Query (sample 100)"** from the run button dropdown to preview results without scanning the full dataset.

## Kusto query results

Below the query, you'll see the results table. Try:

* **Clicking column headers** to sort
* **Right-clicking a column** to access column tools like filtering, statistics, and distinct values
* **Clicking inside complex cells** to inspect complex or nested values

## Charts

Click on the chart section header to expand its configuration:

* **Change the chart type**: switch between line, bar, area, pie, scatter, and funnel
* **Adjust axes**: pick different columns for X, Y, and legend
* **Toggle data labels** and reposition the legend

Every change updates the chart live. When you're happy with the result, save the file (`Ctrl+S`), everything persists in the file.