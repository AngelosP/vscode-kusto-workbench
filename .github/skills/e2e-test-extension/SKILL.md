---
name: e2e-test-extension
description: >
  E2E test and verify VS Code extension behavior using vscode-extension-tester.
  Write Gherkin .feature files, run them against an isolated VS Code instance
  with full capabilities (CDP, input automation, DOM interaction), and review
  structured test results and artifacts.
applyTo: "tests/vscode-extension-tester/**"
---

# e2e-test-extension

Use this skill to create, run, and verify E2E tests for a VS Code extension.

## Execution Modes

The framework has two execution modes:

1. **Default (launch mode):** The CLI downloads and launches a fresh, isolated
   VS Code instance automatically. No F5, no Dev Host, no prerequisites.
   This is the normal way to run tests.

2. **Attach mode (`--attach-devhost`):** Connect to an already-running
   Extension Development Host. Use this when you need to debug the extension
   under test or when you have manually prepared the environment (e.g.
   authenticated, installed additional extensions).

## Build Lifecycle

**The extension is always built automatically before every test run.** You do
NOT need to manually compile — the framework handles it.

Before launching or attaching, the CLI:

1. Reads `package.json` in the extension root (your cwd, or `--extension-path`)
2. Looks for a `compile` script first, then `build` (matching VS Code conventions)
3. Runs `npm run compile` (or `npm run build`) so the latest source is compiled

In **launch mode**, VS Code is then started with `--extensionDevelopmentPath`
pointing at the extension root, so it loads the freshly compiled code directly
from disk — identical to pressing F5.

In **attach mode**, after building, the framework sends
`workbench.action.reloadWindow` to the running Dev Host and waits for it to
come back. This is the same as pressing the restart button in the debug toolbar
— the Extension Host process restarts, reloads all extensions from disk, and
your latest compiled code is active.

**This means every test run is always against the latest source code.** You
can edit TypeScript, save, and immediately run tests — no manual build or
reload step required.

To skip the build (e.g. if you already compiled or want to test the current
compiled state without recompiling):

```bash
vscode-ext-test run --no-build --test-id <test-id>
```

**Running from the extension root.** If your cwd is the extension's root
directory (where `package.json` with `main`, `activationEvents`, etc. lives),
everything resolves automatically — no `--extension-path` needed. For monorepos
where the extension is in a subdirectory, pass `--extension-path packages/my-ext`.

## Your Role

You are a pessimistic, aggressive E2E tester. Your job is to find bugs.
You get promoted and rewarded for catching real bugs. You get reprimanded
for marking a test as passed when the scenario still has issues.

**Rules:**
- Never take shortcuts. Always test the real, full thing end-to-end.
- Never assume something works - verify it with assertions.
- If a scenario passes too easily, be suspicious. Add more assertions.
- Never mark a test as passing unless you have concrete evidence it worked
  (check notifications, output channels, editor content, DOM state).
- If your test passes but you suspect the underlying feature is broken,
  say so explicitly - a false pass is worse than a false fail.
- **A test that only checks "no errors thrown" is NOT a passing test.**
  You MUST verify the expected outcome actually happened.

## Screenshot Verification

Steps passing without errors does NOT mean the test passed. After every test
run, you MUST verify the screenshots.

Screenshots are saved as `.png` files in the run directory. The `report.md`
lists all screenshot file paths.

**To verify screenshots**, use the `view_image` tool with the absolute path
to each `.png` file. This shows you the actual screenshot so you can see
what the Dev Host looked like at that point in the test.

Example:
\`\`\`
view_image("C:/Users/.../tests/vscode-extension-tester/runs/default/<test-id>/<timestamp>/1-screenshot.png")
\`\`\`

After viewing each screenshot:
1. Verify the expected UI state is visible
2. Check for error dialogs or unexpected states
3. If a screenshot shows something wrong, the test FAILED - even if all
   steps reported "passed"
4. Report what you see in each screenshot

**Do NOT skip screenshot verification. Do NOT assume screenshots look correct
without viewing them with view_image.**

## ⚠️ Framework R&D Status - Stop and Report When Blocked

**This testing framework is under active R&D.** Not all features are complete,
and you WILL encounter missing capabilities, broken steps, or edge cases that
don't work yet. This is expected.

**When you hit a wall - a missing step, a broken feature, a step that times
out unexpectedly, or any situation where the framework can't do what you need
- you MUST stop immediately and report it.** Do NOT:

- Write a weaker test as a workaround
- Skip the critical verification and call it "good enough"
- Assume the test passed because no error was thrown
- Try to hack around the limitation with creative step combinations
- Silently move on to the next test

**Instead, stop and produce a detailed prompt** that the framework developers
can use to build or fix the missing capability. Structure it exactly like this:

\`\`\`
## 🛑 Framework Blocker: [short title]

**What I was trying to do:**
[Describe the test scenario and the specific interaction you needed]

**What step/capability is missing or broken:**
[Be precise - e.g. "There is no step to read the text content of a specific
CSS selector in a webview" or "The 'I wait for' step times out even though
the element exists - it appears to not traverse nested iframes in custom
editor webviews"]

**What I observed:**
[Paste the exact error message, step output, or describe the unexpected behavior]

**What the framework needs to support:**
[Describe the ideal step or fix - e.g. "A step like 'Then element .foo should
have text bar in the webview' that works inside custom editor webviews with
nested iframes" or "The CDP client needs to enumerate execution contexts
across all frames, not just the top-level frame"]

**Suggested Gherkin step syntax (if applicable):**
\`\`\`gherkin
Then element ".my-selector" should have text "expected" in the webview
\`\`\`

**Workaround attempted (if any):**
[What you tried and why it didn't work]

**Priority:** [blocking - can't write any meaningful test for this feature]
or [degraded - can write a partial test but it misses the key assertion]
\`\`\`

**This prompt is your primary deliverable when blocked.** A well-written
blocker report is more valuable than a bad test. The framework developers
will use it to build the fix, and you can resume testing once it ships.

## Test Workflow

### Default (launch mode - recommended)

1. **Write .feature files** in `tests/vscode-extension-tester/e2e/default/<test-id>/`:
   ```
   mkdir -p tests/vscode-extension-tester/e2e/default/<test-id>
   ```
   ```gherkin
   Feature: Verify CSV export
     Scenario: Export results to CSV
       When I execute command "kusto.exportCsv"
       Then I wait 2 seconds
   ```
   Feature files live in `e2e/` so they are tracked in git.

2. **Run the tests** - the CLI launches an isolated VS Code instance automatically:
   ```bash
   vscode-ext-test run --test-id <test-id>
   ```
   This launches a fresh VS Code, executes all .feature files from
   `e2e/default/<test-id>/`, and writes artifacts to `runs/default/<test-id>/<timestamp>/`.
   Each run uses a unique timestamp so previous results are preserved.

3. **Review artifacts** - artifacts are in `tests/vscode-extension-tester/runs/default/<test-id>/<timestamp>/` (gitignored):
   - `report.md` - read this FIRST. It lists all results AND screenshot file paths.
   - `results.json` - structured results with screenshot paths.
   - `console.log` - structured output log per scenario/step.
   - `*.png` - screenshot images.

4. **Verify screenshots** - use `view_image` on each .png listed in `report.md`. Do NOT skip this step.

### Attach mode (for debugging or pre-authenticated profiles)

Use `--attach-devhost` when you need to connect to an already-running Dev Host
(e.g. launched via F5 for debugging):

```bash
vscode-ext-test run --attach-devhost --test-id <test-id>
```

### Named profiles (for tests requiring authentication)

Organize feature files under a profile folder to associate them with a named
profile that has been pre-authenticated or otherwise prepared:

```
tests/vscode-extension-tester/e2e/<profile-name>/<test-id>/
```

Run with a profile flag:
```bash
vscode-ext-test run --test-id <test-id> --reuse-named-profile <profile-name>
```

Prepare a profile first with:
```bash
vscode-ext-test profile open <profile-name>
```

## Tips

- Test IDs are disposable - create a new one for each investigation.
- The `runs/` directory is gitignored; artifacts are ephemeral.
- By default, each run launches a fresh isolated VS Code instance.
  All steps always work - no prerequisites, no extra flags needed.
- Use `--attach-devhost` only when you need to debug or use a pre-configured environment.

## Available Gherkin Steps

- `Given the extension is in a clean state` - reset: close all editors, dismiss notifications, clear output channels
- `When I execute command "<command-id>"` - run any VS Code command (waits for completion)
- `When I start command "<command-id>"` - start a VS Code command without waiting (use for commands that show InputBox/QuickPick dialogs, then interact with the dialog in the next step)
- `When I select "<label>" from the QuickPick` - pick an item from an open QuickPick
- `When I type "<text>" into the InputBox` - type into a VS Code InputBox prompt
- `When I click "<button>" on the dialog` - click a button on a modal dialog
- `When I type "<text>"` - type text into whatever is focused (editors, webview Monaco, inputs)
- `When I press "<key>"` - press a key or combo (Enter, Escape, Ctrl+S, Ctrl+Space, Shift+Tab, F5, etc.)
- `When I sign in with Microsoft as "<user>"` - handle Microsoft auth flow
- `Then I should see notification "<text>"` - assert a notification contains text
- `Then I should not see notification "<text>"` - assert NO notification contains text
- `Then the editor should contain "<text>"` - assert the active editor has text
- `Then the output channel "<name>" should contain "<text>"` - assert output channel content
- `Then the output channel "<name>" should not contain "<text>"` - assert output channel does NOT contain text
- `Then I wait <n> second(s)` - pause for n seconds

### Click/Focus Elements in Webviews (Windows UI Automation)
These use Windows accessibility to find and click elements by their name or text.
They work for ANY element - including inside webviews, custom editors, and dialogs:
- `When I click the element "<name>"` - click an element by its accessible name/text
- `When I click the "<name>" button` - click a button by name
- `When I click the "<name>" edit` - click a text field by name

Example - click a button inside a webview:
\`\`\`gherkin
When I click the element "Select favorite..."
When I click the element "Run Query"
When I click the "File name:" edit
\`\`\`

### Webview DOM Steps (CSS Selectors via Chrome DevTools)

For complex webviews - multiple sections, tables, panels, custom controls - the
accessibility-name approach often isn't precise enough. These steps use CSS
selectors and Chrome DevTools Protocol so you can target *exactly* the element
you want, including ones that are hidden, off-screen, or inside shadow DOM
(e.g. LitElement, Shoelace, or other Web Component frameworks).

**Shadow DOM is pierced automatically.** All CSS selector steps (`I click`,
`I wait for`, `element should exist`, `element should have text`, etc.)
will find elements inside open shadow roots without any extra work. You write
selectors exactly the same way as for light DOM. The framework tries
`document.querySelector` first (fast path), then recursively walks shadow
roots on miss. **Limitation:** closed shadow roots (`mode: 'closed'`) are
not accessible — this is by design in the web platform.

**You have access to the extension source code when you write tests.** Inspect
the webview's HTML/Lit/React source to find the right selectors (`data-testid`,
class names, ids) - then assert against them directly.

### Improving Webview Testability

Before writing complex webview tests, **think about whether the extension's
webview markup is testable.** If you find yourself writing fragile selectors
based on deeply nested class names, generated IDs, or DOM structure that could
change with any UI refactor - **stop and recommend testability improvements
to the extension source code first.**

The pattern:

1. **Add `data-testid` attributes** to key interactive elements and sections
   in the webview's source code (HTML, Lit, React, Svelte, etc.). Every button,
   form field, section container, status indicator, and action target should
   have a stable `data-testid`. These survive refactors, theming changes, and
   framework upgrades. Examples:
   - `data-testid="add-connection-btn"`
   - `data-testid="connection-form"`
   - `data-testid="results-section"`
   - `data-testid="status-indicator"`

2. **Shadow DOM just works.** CSS selector steps automatically pierce open
   shadow roots. You do NOT need to add `__testFind`/`__testClick` helper
   functions to the webview code. Just use `data-testid` selectors as normal:
   \`\`\`gherkin
   When I click "[data-testid='add-connection-btn']" in the webview
   Then element "[data-testid='status-indicator']" should exist
   Then element "[data-testid='results-section']" should have text "42 rows"
   \`\`\`

   If the webview uses closed shadow roots (`mode: 'closed'`), the framework
   cannot reach inside them. In that rare case, the extension would need to
   expose test helpers on `window` callable via `I evaluate` steps.

3. **Then write your E2E tests** using these stable selectors. A test like
   `When I click "[data-testid='add-connection-btn']" in the webview` is
   rock-solid - it won't break when someone changes the button's CSS class,
   moves it to a different container, or swaps the UI framework.

**When you encounter a webview that lacks `data-testid` attributes, include
this as a recommendation in your test report.** Suggest the specific elements
that need `data-testid` attributes and what values they should have. This is
a framework blocker report (see the R&D section above) - improving testability
in the extension source is part of the testing process.

| Step | Description |
|------|-------------|
| `When I wait for "<sel>" in the webview` | Wait up to 10s for an element to appear |
| `When I wait for "<sel>" in the webview "<title>"` | Restrict to a specific webview |
| `When I wait for "<sel>" in the webview for <n> seconds` | Custom timeout |
| `When I click "<sel>" in the webview` | Click any element by selector |
| `When I click "<sel>" in the webview "<title>"` | Click in a specific webview |
| `When I focus "<sel>" in the webview` | Focus an input or scroll container |
| `When I scroll "<sel>" by <dx> <dy>` | Scroll a container relatively |
| `When I scroll "<sel>" to <x> <y>` | Scroll to absolute coords |
| `When I scroll "<sel>" to the (top\|bottom\|left\|right)` | Jump to an edge |
| `When I scroll "<sel>" into view` | Scroll the element itself into view |
| `When I evaluate "<js>" in the webview` | Run arbitrary JS (escape hatch) |
| `When I list the webviews` | Log all open webview titles and URLs (debugging aid) |
| `Then the webview should contain "<text>"` | Substring match in body text |
| `Then the webview "<title>" should contain "<text>"` | Restrict to a webview |
| `Then element "<sel>" should exist` | Existence assertion |
| `Then element "<sel>" should not exist` | Negative existence |
| `Then element "<sel>" should have text "<text>"` | Text content assertion |

**Webview targeting.** When multiple webviews are open at once (walkthroughs,
panels, sidebar views), pass a `<title>` substring to disambiguate. The match
is case-insensitive and tested against the **HTML `<title>` tag** of the
webview document and the `vscode-webview://` URL — **not** the VS Code panel
title (`WebviewPanel.title`). These can be different! If your title isn't
matching, use the debugging step `When I list the webviews` to see what
titles and URLs the framework actually sees. Check the extension source for
the HTML `<title>` set in the webview HTML template. Omit the title and the
framework tries every webview until one matches.

**Scrolling a specific section or table.** Find a stable selector for the
container (not the page) - e.g. `section[data-testid="results-table"] .scroll-body`
or `.kw-section--results .table-scroll`. Then:

\`\`\`gherkin
Scenario: Scroll the results table
  When I execute command "kusto.runQuery"
  And I wait for ".kw-results .scroll-body" in the webview
  And I scroll ".kw-results .scroll-body" to the bottom
  Then element ".kw-results tr:last-child" should exist
\`\`\`

\`\`\`gherkin
Scenario: Horizontally scroll a wide table
  When I scroll ".kw-results .scroll-body" by 800 0
  Then element ".kw-results th[data-col="timestamp"]" should exist
\`\`\`

\`\`\`gherkin
Scenario: Click a button in a specific section of the dashboard
  When I click ".kw-section--charts button.export" in the webview "Dashboard"
  Then I should see notification "Export complete"
\`\`\`

**Escape hatch - evaluate JS.** Use sparingly, but when the selector-based
steps cannot express what you need (e.g. you need to inspect a virtualized
list's internal state), reach for `I evaluate`:

\`\`\`gherkin
When I evaluate "document.querySelectorAll('.row').length" in the webview
\`\`\`

The expression is wrapped in an IIFE; return a value via the last expression.
Async expressions are awaited.

### Capturing Output Channels

The controller automatically wraps every `vscode.window.createOutputChannel`
call so it can read back what was written - even for channels created by the
extension under test. After every scenario, the captured content is dumped to
the run's artifacts directory:

```
runs/<test-id>/output-channels/
  Kusto_Workbench.log              # cumulative across all scenarios
  Kusto_Workbench__formatted.log
  My_Scenario_Name/
    Kusto_Workbench.log            # only this scenario's content (snapshot)
    Kusto_Workbench__formatted.log
```

**You don't need to declare anything for default capture** - every channel is
captured. Use the steps below to make capture explicit (which also switches the
controller into allow-list mode, so only the declared channels are dumped):

| Step | Description |
|------|-------------|
| `Given I capture the output channel "<name>"` | Declare a channel to capture |
| `Given I stop capturing the output channel "<name>"` | Remove from allow-list |
| `Then the output channel "<name>" should have been captured` | Asserts non-empty |
| `Then the output channel "<name>" should contain "<text>"` | Substring assertion |
| `Then the output channel "<name>" should not contain "<text>"` | Negative assertion |

Example - capture a specific channel and verify a log line:

\`\`\`gherkin
Feature: Query execution writes a structured trace
  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"

  Scenario: Trace contains the executed query
    When I execute command "kusto.runQuery"
    And I wait 3 seconds
    Then the output channel "Kusto Workbench" should contain "StormEvents | take 10"
    And the output channel "Kusto Workbench" should have been captured
\`\`\`

**Important caveat.** Channels created by the target extension *before the
controller activates* cannot be captured retroactively - VS Code's API does
not expose enumeration of existing output channels. The controller declares
`activationEvents: ["*"]` so it activates as early as possible, but if your
extension creates a channel synchronously inside its own `activate()` and
loses the activation race, the channel will not be wrapped. The fix is to
defer channel creation by one tick (`queueMicrotask` / `setImmediate`) inside
your extension, or to call `createOutputChannel` lazily on first use.

### Native OS Automation (Windows)
- `When I save the file as "<path>"` - handle Save As dialog: type filename, click Save
- `When I open the file "<path>"` - handle Open File dialog: type filename, click Open
- `When I click "<button>" on the "<title>" dialog` - click a button on any native dialog
- `When I cancel the Save As dialog` - dismiss a Save/Open dialog
- `When I resize the (window|Dev Host) to <width>x<height>` - resize the Dev Host window (also accepts "<width> by <height>")
- `When I move the (window|Dev Host) to <x>, <y>` - move the Dev Host window (negative coords OK)

### Screenshots
- `Then I take a screenshot` - capture the full screen, saved to the run directory
- `Then I take a screenshot "label"` - capture with a descriptive label (e.g. "after-query-runs")

### File Utilities (direct via code - no UI dialogs)
Use these for test setup when you don't need to test the actual dialog interaction:
- `Given a file "<path>" exists` - create an empty file (relative to cwd or absolute)
- `Given a file "<path>" exists with content "<text>"` - create a file with content
- `Given a temp file "<name>" exists` - create in OS temp directory
- `Given a temp file "<name>" exists with content "<text>"` - create temp file with content
- `When I open file "<path>" in the editor` - open file directly (no Open dialog)
- `When I delete file "<path>"` - delete a file
- `Then the file "<path>" should exist` - assert file exists on disk
- `Then the file "<path>" should contain "<text>"` - assert file content

### Clean State

Every test should start from a known state. Use Background to reset before each scenario:

\`\`\`gherkin
Feature: My tests
  Background:
    Given the extension is in a clean state
    And I wait 1 second

  Scenario: First test
    When I execute command "myExtension.doSomething"
    ...
\`\`\`

The reset step closes all editors, dismisses notifications, clears output channels,
and closes panels/sidebars. This ensures each scenario starts from the same baseline.

## Tips

- Test IDs are disposable - create a new one for each investigation.
- The `runs/` directory is gitignored; artifacts are ephemeral.
- By default, each run launches a fresh isolated VS Code instance.
  All steps always work - no prerequisites, no extra flags needed.
- Use `--attach-devhost` only when you need to debug or use a pre-configured environment.

## Focus & Input

The framework uses two layers to control focus and input:

1. **VS Code commands** - navigate to panels, editors, views:
   ```gherkin
   When I execute command "workbench.action.focusActiveEditorGroup"
   When I execute command "workbench.view.extension.myPanel"
   ```

2. **Type and press** - send keystrokes to whatever is currently focused:
   ```gherkin
   When I type "StormEvents | take 10"
   When I press "Ctrl+Enter"
   ```

### Example: type into a webview Monaco editor

```gherkin
Scenario: Run a Kusto query
  When I execute command "workbench.action.focusActiveEditorGroup"
  And I type "StormEvents | take 10"
  And I press "Shift+Enter"
  Then I wait 3 seconds
```
