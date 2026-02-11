# The VS Code Agent: Full Report Orchestration

Beyond the in-editor Copilot Chat, Kusto Workbench also provides a **VS Code agent** that can orchestrate your entire notebook — creating sections, configuring charts, connecting to clusters, and more.

## How to use the agent

1. Open the **VS Code Chat panel** (click the Copilot icon in the title bar, or press `Ctrl+Shift+I`).
2. The Kusto Workbench agent has access to all the tools needed to build complete reports: adding query sections, configuring connections, creating charts and transformations, and writing markdown documentation.

## What makes the agent different from Copilot Chat?

| Feature | In-Editor Copilot Chat | VS Code Agent |
|---------|----------------------|---------------|
| **Scope** | Single query section | Entire notebook |
| **Can add sections** | No | Yes — queries, charts, markdown, transformations |
| **Can configure connections** | No | Yes — set cluster and database |
| **Can execute queries** | Yes (within the section) | Yes (any section) |
| **Context** | Current query + schema | All sections + connections + schemas |

## Try it

Ask the agent to build something that spans multiple sections:

> *"Create a report with the top 10 error messages for the past 7 days, a bar chart of error counts, and a markdown summary"*

The agent will create the query section, run it, add the chart, configure it, and write the markdown — all in one go.

## Agent + Editor: Best of Both Worlds

Use the **agent** for scaffolding and orchestration. Use the **editor** and **Copilot Chat** for fine-grained query editing. They complement each other perfectly.
