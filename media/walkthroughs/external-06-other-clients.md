# Other local MCP clients

Use this path for a client that supports a **local command / STDIO MCP server** and can call tools from it.

## Add the connector

1. Run **External Tools - Configure integration...** and choose **Other MCP client...**.
2. Review the consent and select your VS Code profile. Workbench installs the local connector, enables the provider, and copies portable MCP configuration to the clipboard.
3. Use your client's documented server-management flow to apply that configuration. The clipboard output is guidance; Workbench has not registered it in the other client for you.
4. Keep the executable in **command** and the bootstrap path in the **args array**, as copied. Do not combine them into a single quoted executable path. Spaces in paths are normal.
5. Start or reconnect the client's MCP session and ask it to load `getWorkbenchGuidance`, then call `listWorkbenchInstances`.

The guide teaches the client how to choose a Workbench window, create and edit sections, validate charts or HTML, save reports, and recover safely from uncertain results. A client that only knows the tool names may still need this guidance before it can orchestrate a report.

## Keep the local boundary

Use the stable STDIO connector configuration, not a copied internal HTTP endpoint or bearer token. Workbench discovers current providers and handles their changing endpoints internally.

The client must run on the same supported Windows machine. A cloud-only client cannot launch this local command. Cowork's documented connector format requires public HTTPS and appropriate authentication, which is a separate integration project, not a setting in this walkthrough. Do not publish the local provider anonymously or disable its security checks.