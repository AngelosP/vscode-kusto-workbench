# You can build Workbench reports from Copilot CLI or Scout

Open **External Tools** below **Export Agent Skill** in Quick Access and select **Configure...**. Choose your client and VS Code profile; you can return here anytime to reconfigure the integration.

![External Tools configuration in the Kusto Workbench Quick Access view](images/tip-copilot-external-mcp-clients.png)

Copilot CLI setup installs the **Kusto Workbench** agent: launch `copilot` normally and select it with `/agent`. Scout setup automatically installs its MCP registration and skill; close Scout before first-time setup, then reopen it. Ask for a report in natural language; the client uses an exact Workbench instance to create, edit, and save it without taking over your active editor.