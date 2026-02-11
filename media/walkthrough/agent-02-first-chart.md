# Ask the Agent for Your First Chart

Now that you're connected, let's use the **Kusto Workbench agent** in VS Code to generate your first query and chart, no KQL knowledge needed.

## How to bring up the agent

1. Open the **VS Code Chat panel** (click the Copilot icon in the title bar, or press `Ctrl+Shift+I`).
2. The Kusto Workbench agent is available automatically in the drop-down, and it has access to your connections, schemas, and can create queries, charts, and full reports.

## Your first request

Try asking the agent something like:

> *"Give me the ProductX active user count for the past 30 days, and chart it as a line graph"*

The agent will:

* Find the right tables from your connections
* Write and execute the KQL query
* Add a chart section and configure it to visualize the results

Watch as the query results and chart appear in your notebook. Pay attention how it orchestrates and doesn't write its own Kusto query, instead it asks the intergrated Copilot Chat inside each Kusto section to do the query authoring. Just like you would:

Perhaps it helps to think of things like this:

* **VS Code Kusto Workbench** = data analyst helping you write a complete report end-to-end
* **Copilot Chat integration inside each Kusto section** = a Kusto query expert that will focus on just one database and one query 

## Tips

* Be specific about **time ranges**, the agent uses them to write accurate queries.
* Mention the **product or service name** if your database covers multiple products.
* You can ask for specific chart types: line, bar, area, pie, scatter, or funnel.
* Don't be afraid to ask it to fix itself, or to try again, etc. pretend it's a person.