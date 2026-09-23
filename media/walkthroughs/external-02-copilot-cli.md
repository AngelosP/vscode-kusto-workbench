# Copilot CLI

Use this path when you want the dedicated **Kusto Workbench** agent to orchestrate queries and reports in a terminal.

## Configure and start

1. Install GitHub Copilot CLI, sign in, and make sure `copilot` is available on your PATH.
2. Run Workbench's **Configure integration with external tools...** command and choose **Copilot CLI**.
3. Setup registers the `kusto-workbench` MCP server and installs the user-level Workbench custom agent. Conflicting registrations and user-edited agent files are not overwritten.
4. Start a **new** CLI session normally:

```powershell
copilot
```

5. Inside that session, enter `/agent` and select **Kusto Workbench**. No special launch flags are required.

## Check the connection

Ask:

> Use Kusto Workbench to list the available Workbench windows. Do not query data or change any files.

Review the tool approval prompts. A successful call should return live Workbench instances, or an explicit empty list when no eligible window is running. A registration listed in `/mcp` is not by itself proof that a Workbench window is reachable.

Then describe a report in natural language, identifying the workspace, connection, database, and output file. The agent can create queries, charts, transformations, Markdown, and HTML, then save the exact report.

## Already using another agent?

`/agent kusto-workbench` selects a different agent; it is not an additive capability toggle. To keep Vera or another existing agent's identity, stay with that agent and use the Workbench MCP tools or skill as described in the next step.