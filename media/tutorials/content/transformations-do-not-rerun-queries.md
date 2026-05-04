# Transformations do not re-run the Kusto queries

Transformation sections work from cached result data. Filter, project, summarize, pivot, sort, or calculate a derived column without sending the original Kusto query again.

![Transformation section working from cached result data](images/tip-results-transformations.png)

Use a transformation when the source query should stay stable but the analysis needs another shaped view. Add one from the section picker and choose Transformation.

![Add section menu with Transformation highlighted](images/tip-results-add-transformation.png)