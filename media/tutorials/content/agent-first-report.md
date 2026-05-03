# You can ask the agent for the first draft of a whole report

The Kusto Workbench agent is most useful when you ask for an outcome, not just a query. It can create query, chart, markdown, transformation, and Python sections, then wire them into a notebook that you can inspect and refine.

Give it the same context you would give a teammate:

```text
Create a report with daily active users for the last 30 days, a line chart, and a short summary of the trend.
```

![Kusto Workbench agent ready to orchestrate a report](images/tip-agent-orchestration.png)

The first draft is not the finish line. Treat it as a fast scaffold: run the sections, read the generated KQL, and ask follow-ups until the notebook tells the story you actually need.
