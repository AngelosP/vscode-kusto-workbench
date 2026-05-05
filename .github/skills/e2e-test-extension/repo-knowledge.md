# Repo-Specific Testing Knowledge

This file is your persistent knowledge base for E2E testing this specific
codebase with vscode-extension-tester. Unlike SKILL.md (which is overwritten
on every `vscode-ext-test init` to stay current with framework updates),
**this file is never overwritten** — it accumulates knowledge across sessions.

## How to Use

Read this file before every test session. Update it after every session with
anything new you learned. Structure it however makes sense for this repo.

## Extension Commands

<!-- List the command IDs this extension registers and what they do -->

- `kusto.openQueryEditor` opens the persistent scratch/session editor.
- `workbench.action.files.save` works for saving a custom `.kqlx` editor after webview-driven `schedulePersist()` updates the backing document.

## Webview Selectors

<!-- CSS selectors, data-testid values, and webview titles that work for this extension -->

- Main notebook container: `#queries-container`.
- Section tags are stable and usable through webview CSS/evaluate steps: `kw-query-section`, `kw-markdown-section`, `kw-html-section`, `kw-sql-section`.
- Add buttons use `button[data-add-kind='<kind>']`, with kinds including `query`, `sql`, `html`, and `markdown`.
- The section creation/removal window bridges are available in E2E webview evaluation: `addQueryBox`/`removeQueryBox`, `addMarkdownBox`/`removeMarkdownBox`, `addHtmlBox`/`removeHtmlBox`, `addSqlBox`/`removeSqlBox`.

## Activation & Setup Quirks

<!-- E.g. "needs a .kql file open before commands are available" -->

- Opening an empty `.kqlx` initializes one default Kusto section. Tests that need exact section counts should remove it first and assert the workbench is empty before setup.
- For reliable multi-line strings inside `I evaluate` steps, build newlines with `String.fromCharCode(10)` rather than relying on `\n` escaping through Gherkin and JavaScript string layers.
- In default launch mode, SQL sections may show `No SQL connections configured.`. This is expected unless the test uses a prepared profile or attach mode with SQL auth state.

## Known Issues & Workarounds

<!-- Flaky areas, timing-sensitive steps, framework workarounds -->

- For persistence E2E tests, assert both visible section IDs (`document.querySelectorAll(...)`) and direct `#queries-container.children` order, because persistence serializes direct DOM child order.
- Add explicit screenshots after scrolling to HTML/SQL sections; a top-of-document screenshot can pass assertions while hiding lower restored sections.
- This installed `vscode-ext-test` CLI does not currently provide the documented `I set setting ...` / `setting ... should be ...` Gherkin steps. Use per-test `e2e.settings.json` `workspaceSettings` for deterministic settings, or assert settings indirectly through the extension UI/state.
- In the Did you know viewer, DOM-driven `I evaluate` clicks on footer actions are more reliable than generic `I click "[data-testid='tutorial-standard-mute']" in the webview`; the selector click can miss that footer link even when the element exists.

## Testability Recommendations

<!-- data-testid attributes you recommended adding to the extension source -->
