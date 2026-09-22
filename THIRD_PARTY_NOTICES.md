# Third-Party Notices

Kusto Workbench does not distribute Node.js inside its VSIX. When a user opts into external MCP integration, Kusto Workbench downloads the pinned official Node.js win-x64 archive from nodejs.org, verifies its SHA-256 digest, and caches and installs it under the user's local application-data directory.

Node.js and its included third-party software are distributed under the terms in the upstream `LICENSE` file. That complete file remains inside the downloaded runtime archive and is installed as `NODE-LICENSE.txt` beside the connector runtime.

The connector and provider bundle the following direct dependencies:

- `@modelcontextprotocol/client`, `@modelcontextprotocol/node`, and `@modelcontextprotocol/server` 2.0.0. Their complete upstream licensing-transition, Apache-2.0, and MIT terms are packaged at `dist/mcp-connector/licenses/MODEL_CONTEXT_PROTOCOL_LICENSE.txt`.
- `extract-zip` 2.0.1. Its complete BSD-2-Clause terms are packaged at `dist/mcp-connector/licenses/EXTRACT_ZIP_LICENSE.txt`.
- `jsonc-parser` 3.3.1. The setup bundle uses it for minimal Scout registry edits. Its complete MIT terms are packaged at `dist/mcp-connector/licenses/JSONC_PARSER_LICENSE.txt`.

Other bundled dependencies retain their respective licenses as declared by their packages in `package-lock.json`.