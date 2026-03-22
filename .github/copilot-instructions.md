# VS Code Extension: Kusto Workbench

## Project Identity

* **Extension Name**: Kusto Workbench
* **Internal Name**: vscode-kusto-workbench
* **Language**: TypeScript
* **Purpose**: A VS Code extension providing a notebook-like experience for Kusto Query Language (KQL) — query editing, execution, charting, and more.
* **Key Technologies**: VS Code Extension API, Monaco Editor, Lit web components, ECharts, Azure Kusto SDK

## Documentation

| Document | Purpose |
| -------- | ------- |
| [`ARCHITECTURE.md`](../../ARCHITECTURE.md) | Architecture reference — file inventories, communication patterns, key types, feature designs, architectural decisions and rationale |
| [`CONTRIBUTING.md`](../../CONTRIBUTING.md) | Development rules — build/test commands, code conventions, implementation patterns, how-to guides |

Read `ARCHITECTURE.md` to understand the system structure. Read `CONTRIBUTING.md` before making changes.

## Working Style

Use subagents to parallelize independent tasks wherever possible — research, file reads, code searches, reviews — as long as it does not compromise the quality of the end result. When tasks have dependencies between them, run them sequentially; when they don't, run them in parallel. Even write tasks, as long as they are across different files.

## Copilot Prompt Files

The `copilot-instructions/` directory contains prompt files used by the extension's own Copilot integration features (query generation, optimization). These are runtime resources, not development instructions.