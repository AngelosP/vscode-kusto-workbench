# Table tools

The results table is more than just a grid, it has powerful tools for exploring your data right where it is.

## Column header actions

**Right-click any column header** to access column tools:

* **Sort ascending / descending**: quickly reorder results by any column.
* **Column statistics**: see min, max, average, count, and distinct count at a glance.
* **Distinct values**: view all unique values in the column with their frequencies.
* **Filter**: narrow your results to specific values without modifying your query.

## Row & cell inspection

* **Search across the entire dataset:** Even inside JSON objects, any string can be searched across the entire dataset.
* **Complex values** (JSON objects, dynamic arrays) are rendered with an interactive viewer, click into the cell to drill into.
* **Double click on any cell:** you get a nice viewer with search for it.
* **Navigate to any column by name** when the results have a bunch of them.

## Transformations

For more advanced analysis **without writing KQL,** you can add a **Transformation section** below your query:

* **Derive**: add calculated columns using expressions
* **Summarize**: aggregate data with group-by
* **Distinct**: extract unique values from a column
* **Pivot**: reshape your data into a pivot table

Click the **+** button below a section and choose **Transformation** to try it out.