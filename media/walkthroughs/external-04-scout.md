# Microsoft Scout

Workbench configures Scout's MCP registration and installs a Workbench skill so you can ask for reports in natural language.

## Configure safely

1. **Fully quit Scout**, including its system-tray process, before first-time registration. Scout reads its MCP configuration at startup and can overwrite external changes while it is running.
2. Run **Configure integration with external tools...** in VS Code and choose **Microsoft Scout**.
3. Review the consent and choose your VS Code profile. You do not need to fill out Scout's **Add Server** form.
4. Reopen Scout and start a **new conversation**.
5. Ask:

> Use Kusto Workbench to list the available Workbench windows, without querying data or editing any files.

Review Scout's tool approval prompts, then identify the workspace and report you want it to use.

## Existing installations

An existing matching manual server is reused without rewriting it or taking ownership. Other servers, credentials, discovered tools, and approval settings are preserved. A conflicting or user-edited entry is left unchanged rather than silently replaced.

Automatic registration uses the local format verified with Scout **0.23.779.0**. Unknown configuration formats fail safely. This applies to Scout's normal desktop installation, not separate development or cloud stores.

## Repair or remove

Close Scout before registration changes or managed removal, rerun setup, then reopen it. Removing the Scout integration deletes only unchanged Workbench-managed registration and skill content; pre-existing manual configuration is preserved.