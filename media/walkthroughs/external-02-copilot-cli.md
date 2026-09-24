# Copilot CLI

Use Copilot CLI to create queries and reports in Workbench from a terminal. No separate custom agent is needed.

## Configure and start

1. Install GitHub Copilot CLI, sign in, and make sure `copilot` is available on your PATH.
2. Run Workbench's **External Tools - Configure integration...** command and choose **Copilot CLI**.
3. Setup registers the `kusto-workbench` MCP server. On reconfiguration it removes an unchanged Workbench-managed legacy CLI agent; user-owned or edited agents are preserved.
4. Start a **new** CLI session normally:

```powershell
copilot
```

5. Ask Copilot CLI to use Kusto Workbench. No `/agent` switch or special launch flags are required.

## Check the connection

Ask:

> Use Kusto Workbench to list the available Workbench windows. Do not query data or change any files.

Review the tool approval prompts. A successful call should return live Workbench instances, or an explicit empty list when no eligible window is running. A registration listed in `/mcp` is not by itself proof that a Workbench window is reachable.

Then describe a report in natural language, identifying the workspace, connection, database, and output file. Copilot CLI can create queries, charts, transformations, Markdown, and HTML, then save the exact report.

## Already using another agent?

The MCP registration is additive. To keep Vera or another agent's identity, stay with that agent and ask it to use the Workbench MCP tools as described in the next step.