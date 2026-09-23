# Microsoft Copilot: Local Code sessions

This is the **Microsoft Copilot desktop app's Code mode**, not terminal Copilot CLI, Chat, or Cowork.

## Configure your Code account

1. Open Microsoft Copilot, sign in, and open **Code** once to initialize its runtime and account directory.
2. In VS Code, run **Configure integration with external tools...** and choose **Microsoft Copilot (Code)**.
3. Select the VS Code profile. If several Code accounts are initialized, select the exact account directory shown; setup does not guess which one you intend.
4. After installation or an update, quit and reopen Copilot.
5. Select **Code > New session** and set **Where to run this session** to **Local**.

## Use the tools in the session

Ask:

> Use Kusto Workbench to list the available Workbench windows. Do not query data or change any files.

The session can load the **kusto-workbench** skill and call its MCP tools. Review each **Invoke MCP tool** request. For the initial connectivity check, expect read-only calls such as `getWorkbenchGuidance` and `listWorkbenchInstances`; choose **Allow once** when the request matches your intent. Session-wide or permanent approval is not required.

**Local plugins and skills may not appear in Code > Customize.** In the verified build, both are absent from that catalog but work in a Local Code session. Check actual skill loading and completed MCP calls, not catalog visibility alone.

## Compatibility and limits

The local workflow was verified with Copilot desktop **155.0.4283.3** and Code runtime **0.1.229.0**, API 4. Registration uses the bundled plugin commands and an observed desktop account layout. Future app versions can change that layout; the runtime currently warns that direct local plugin installation will eventually require marketplace-based installation.

Cloud Code sessions are not covered. Cowork needs a separate HTTPS-accessible MCP integration; this setup does not configure it or expose your local connector publicly. Terminal CLI and Scout registrations remain independent.