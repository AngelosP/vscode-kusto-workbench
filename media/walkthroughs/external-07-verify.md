# Verify before building a report

## Start with a read-only check

Open the intended Workbench workspace in VS Code, then ask your connected client:

> Use Kusto Workbench to list the available Workbench windows. Do not query data, launch windows, or change files.

Look for a completed `listWorkbenchInstances` call and a live result. If several windows are returned, identify the intended workspace explicitly. The client must use its exact `instanceId`, not whichever window is foreground or first in a list.

Then try a report request with a clear target:

> In my analysis workspace, use the connection and database I specify to create a report of daily query failures for the last seven days. Add a bar chart and a Markdown summary. Save it as a new failures-report.kqlx without bringing VS Code to the foreground.

Supply your real connection, database, and output folder. Ask the client to confirm the saved file. Background work should use exact file and section identities and must not overwrite an existing report.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| No Workbench instances | Open an eligible local VS Code window, check that the provider is enabled, and use the intended profile. Registration alone does not prove a window is reachable. |
| Target profile has the wrong extension version | Install the same Workbench build into that profile, reload its window, and rerun Configure. |
| Setting is not registered after a VSIX update | Run **Developer: Reload Window**, then retry setup. |
| Copilot Code plugin is missing from Customize | Start a new **Local** Code session and test its actual MCP calls. The catalog can omit working local plugins. |
| Vera loses its identity | Start through `vera` and use Workbench as a tool or skill. Do not select `/agent kusto-workbench`. |
| Scout setup asks you to close the app | Quit its tray process too, then retry. Do not edit the registry while Scout is running. |
| Client requests permission | Inspect the exact tool and target. Approve once if appropriate; do not bypass your organization's policy. |
| Setup reports a conflicting or edited registration | Inspect the named client entry. Workbench preserves it; do not delete unrelated settings or credentials to retry. |
| A tool timed out after a possible edit | Inspect the same instance and file before retrying. The edit may already have completed; do not replay it blindly. |

**Kusto Workbench: External tools - Show integration status** summarizes the provider, connector, and client registrations. Pair it with the live check above; it does not certify every running client conversation.

## Reconfigure or clean up

Rerun **Configure integration with external tools...** to repair setup or change the profile used for future cold launches. A launch-profile change requires a fresh client session.

Run **Kusto Workbench: External tools - Disable or remove integration...** to select exactly what to remove: provider enablement, a managed client integration, the startup companion, or the local connector and its runtime cache. Disabling the provider affects all external clients. Removing only one client does not require removing the shared connector.

Scout removal requires Scout to be closed. Code plugin removal targets the selected Code account. Unowned or edited agent/skill/plugin content is preserved. No cleanup is required just to finish reading this walkthrough.