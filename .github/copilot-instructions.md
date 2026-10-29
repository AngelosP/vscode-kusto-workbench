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

## Bug Fixing

1. Reproduce each reported bug in an automated test before writing a product fix. The test must fail for the reported behavior, not bad setup. Use our own isolated tests and the same steps the user takes; do not rely on their active F5 window.
2. Keep working on reproduction until it succeeds. Improve the test harness, add logging, or use a suitable isolated VS Code profile as needed. Ask for required access or harness support instead of treating unrelated passing tests as proof.
3. For a fix request, fix the product until every valid reproducing test passes. A request for tests or reproduction only still means no product fixes yet.
4. After fixing the bugs, run the full existing regression suite. Fix real failures. Change a test only when the test is wrong, and never weaken a valid test to make the run pass.
5. Call the work done only after every reported bug has been reproduced and fixed, and both the new tests and previous tests pass. A setup failure is not a reproduction; later success does not erase a failed first attempt. If something prevents progress, state what is missing and request the help needed to continue.

Explain progress in plain words: reproduced, not reproduced yet, fixing, or regression testing. Name the current step for each bug and avoid unnecessary technical vocabulary.

## Test Coverage Planning

For every observable behavior change, bug fix, first-time capability, persistence/lifecycle change, or coverage/completion claim, read and follow [`skills/test-coverage-planning/SKILL.md`](skills/test-coverage-planning/SKILL.md). Build a coverage ledger before declaring the work complete: include the exact composed acceptance path, map owners and state transitions, cite existing setup/action/oracle evidence exactly, exercise real user controls in E2E, and justify every excluded or deferred permutation. Separate tests for individual steps do not replace a composed lifecycle when their interaction is the risk.

## Tab Safety

Never use `workbench.action.closeActiveEditor`, `workbench.action.revertAndCloseActiveEditor`, or another focus-based close command for targeted cleanup. It can close Copilot Chat or an unrelated user tab if focus changes. Close only tabs opened by the task, identify them by exact URI, and use `vscode.window.tabGroups.close`; if exact URI targeting is unavailable, leave the tab open. Never close Copilot Chat or an agent conversation.

## Copilot Prompt Files

The `copilot-instructions/` directory contains prompt files used by the extension's own Copilot integration features (query generation, optimization). These are runtime resources, not development instructions.