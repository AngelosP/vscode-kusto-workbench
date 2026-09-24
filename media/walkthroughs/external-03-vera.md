# Keep Vera and add Workbench tools

Vera can keep its domain knowledge, analytics tools, and response rules while using Kusto Workbench to create and edit reports. No separate Workbench agent is needed.

## Configure the shared tool connection

1. Run **Configure integration with external tools...** and choose **Copilot CLI**. The Workbench MCP registration is additive; existing Vera servers remain configured.
2. Start a fresh session through your usual launcher:

```powershell
vera
```

3. Stay with Vera. No agent switch is required.
4. Ask Vera to use Workbench as an additional capability:

> Stay as Vera and keep your analytics knowledge and response rules. Use the Kusto Workbench MCP tools to list the available Workbench windows. Read getWorkbenchGuidance first. Do not query data or change files yet.

The verified Vera launcher runs `agency copilot` and reads the normal user MCP configuration. A custom launcher or an isolated Agency profile can load different sources; inspect its configured servers if Workbench is missing.

## Skill versus agent

If the **kusto-workbench** skill is available, Vera can load it without switching its identity. In current Copilot CLI versions, `/skills list` shows discovered skills. A skill adds task instructions to the conversation; `/agent` changes the active agent.

The standalone Copilot CLI setup installs neither a separate agent nor a personal skill. A personal Workbench skill may already be present from Scout setup or an explicit skill installation. If it is not present, ask Vera to load `getWorkbenchGuidance` from the MCP server; that supplies the live workflow.

## Combine the workflows

For an analytics report, tell Vera to keep using its established knowledge and validation tools for the analysis, and use Workbench for the notebook, charts, and saved report. Identify the target workspace and file explicitly. Keep normal tool approvals; no all-tools permission flag is required.

Normal `copilot` sessions and Vera can use the same MCP registration without a Workbench-specific agent.