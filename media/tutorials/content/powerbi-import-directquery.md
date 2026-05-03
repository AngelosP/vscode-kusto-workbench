# Power BI exports can use Import or DirectQuery

Import mode packages refreshed data into the Power BI semantic model. DirectQuery keeps the report connected to Kusto at view time, which is the right choice for sensitive or frequently changing sources.

![Power BI export view](images/tip-pbi-export.png)

Leave No Trace sources are kept in DirectQuery mode because Import mode would store query results in the Power BI model.