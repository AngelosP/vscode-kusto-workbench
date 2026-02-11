# Table Tools

The results table is more than just a grid — it has powerful tools for exploring your data right where it is.

## Column Header Actions

**Right-click any column header** to access column tools:

- **Sort ascending / descending** — quickly reorder results by any column.
- **Column statistics** — see min, max, average, count, and distinct count at a glance.
- **Distinct values** — view all unique values in the column with their frequencies.
- **Filter** — narrow your results to specific values without modifying your query.

## Row Inspection

- **Click on a row** to expand it and see all column values in a readable format.
- **Complex values** (JSON objects, dynamic arrays) are rendered with an interactive tree viewer — click to drill into nested structures.

## Copy & Export

- **Select cells** and copy with `Ctrl+C` — data copies in a tab-separated format that pastes cleanly into Excel.
- **Right-click the results area** for additional export options.

## Transformations

For more advanced analysis without writing KQL, you can add a **Transformation section** below your query:

- **Derive** — add calculated columns using expressions
- **Summarize** — aggregate data with group-by
- **Distinct** — extract unique values from a column
- **Pivot** — reshape your data into a pivot table

Click the **+** button below a section and choose **"Transformation"** to try it out.
