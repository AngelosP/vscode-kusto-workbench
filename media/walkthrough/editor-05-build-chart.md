# Build a chart

Visualize your query results by adding a chart section directly below a query.

## Creating a chart

1. Click the **+** button below your query section.
2. Select **Chart** from the section type menu.
3. The chart section will appear and automatically link to the query above it as its data source.

## Configuring the chart

In the chart section header, you'll find controls to:

* **Choose a chart type**: line, area, bar, scatter, pie, or funnel.
* **Set the X axis**: pick the column for the horizontal axis (typically a time column like `Timestamp`).
* **Set the Y axis**: pick one or more columns for the values.
* **Set the legend**: choose a column to split the data into separate series (e.g., by region or category).

## Chart types and when to use them

| Chart Type | Best For |
| ---------- | -------- |
| **Line** | Trends over time |
| **Area** | Volume trends over time |
| **Bar** | Comparing categories |
| **Scatter** | Correlations between two metrics |
| **Pie** | Proportions of a whole |
| **Funnel** | Stage-by-stage drop-off |

## Live updates

Charts refresh automatically when you re-run the source query. Adjust your query, hit `Shift+Enter`, and the chart updates in place.