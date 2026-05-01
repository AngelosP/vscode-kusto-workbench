# Build a report with the agent

Open the Kusto Workbench agent and describe the report you want in one sentence. A good first request includes the metric, time range, and visualization shape.

Example request:

```text
Show daily active users for the last 30 days and chart it as a line graph.
```

Review the generated query before relying on the result. The agent can iterate on the same notebook, so follow-up requests like "change this to a rolling 7 day average" work well.
