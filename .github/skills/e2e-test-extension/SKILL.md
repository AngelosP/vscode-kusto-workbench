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

This file is installed into extension repos by `vscode-ext-test install-into-project` at
`.github/skills/e2e-test-extension/SKILL.md`. Rerun `vscode-ext-test install-into-project`
after upgrading the CLI to refresh these framework instructions; repo-specific
knowledge belongs in `repo-knowledge.md`, which the command preserves.

## Execution Modes

The framework has three execution modes:

1. **Default (launch mode):** The CLI downloads and launches a fresh, isolated
   VS Code instance automatically. No F5, no Dev Host, no prerequisites.
   This is the normal way to run tests.

2. **Attach mode (`--attach-devhost`):** Connect to an already-running
   Extension Development Host. Use this when you need to debug the extension
   under test or when you have manually prepared the environment (e.g.
   authenticated, installed additional extensions).

3. **Live stepping (`vscode-ext-test live` or `tests add --live-mode`):**
  Start or attach once, then run Gherkin steps/scripts incrementally. Each
  response includes pass/fail, screenshots, output/log artifact paths, and
  current VS Code state. Use this while discovering the right steps before
  writing the final `.feature` file. Ending a launched live session captures
  a final screenshot before shutting VS Code down; ending an attached session
  only disconnects.

### Live JSONL Protocol

Use `vscode-ext-test live` when you need to keep one VS Code session open while
trying steps one at a time. The command reads one JSON object per line from
stdin and writes one JSON object per line to stdout. Operational logs go to
stderr, so do not parse stderr as protocol output.

Start a session:

```bash
vscode-ext-test live --mode auto
```

Send requests in this shape:

```json
{"id":1,"method":"runStep","params":{"step":"When I execute command \"workbench.action.showCommands\""}}
```

Supported request methods:

| Method | Params | Purpose |
| ------ | ------ | ------- |
| `runStep` | `{ "step": "<single Gherkin step>" }` | Run one Gherkin step |
| `runScript` | `{ "script": "<multi-line Gherkin steps>", "stopOnFailure": true }` | Run a block of Gherkin steps |
| `runExtensionHostScript` | `{ "script": "<JavaScript>", "timeoutMs": 5000 }` | Run diagnostic JavaScript in the VS Code extension host with the `vscode` API available |
| `reset` | `{ "mode": "cleanState" }` or `{ "mode": "reload" }` | Reset state or reload the Dev Host |
| `state` | `{}` | Read current VS Code state |
| `summary` | `{}` | Read live session summary |
| `end` | `{}` | Close the live session |

Common examples:

```jsonl
{"id":1,"method":"runStep","params":{"step":"When I execute command \"workbench.action.showCommands\""}}
{"id":2,"method":"runScript","params":{"script":"Then I wait 1 second\nWhen I press \"Escape\""}}
{"id":3,"method":"runScript","params":{"script":"When I type:\n  \"\"\"\n  first line\n  second line\n  \"\"\""}}
{"id":4,"method":"runExtensionHostScript","params":{"script":"return vscode.window.activeTextEditor?.document.uri.toString();","timeoutMs":5000}}
{"id":5,"method":"state","params":{}}
{"id":6,"method":"end","params":{}}
```

Responses are JSONL envelopes. Session lifecycle messages look like
`{"type":"session_started","summary":{...}}` and
`{"type":"session_ended","summary":{...}}`. Request responses look like
`{"type":"response","id":1,"ok":true,"result":{...}}` or
`{"type":"response","id":1,"ok":false,"error":"..."}`.

Use `runScript` for Gherkin step blocks, doc strings, and multiline text. JSONL
requires one JSON object per physical line, so embedded Gherkin newlines must be
escaped as `\n` inside the JSON string; do not send pretty-printed or literal
multi-line JSON requests. Use `runExtensionHostScript` only for diagnostic
JavaScript that must run inside the extension host.

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

Each screenshot artifact also includes capture metadata in `results.json`,
live `step-result.json` manifests, live JSONL responses, and `report.md`:
the intended Dev Host process id, the captured window process id, window title,
window bounds, and capture method. Use this metadata with the PNG to spot
wrong-window or stale-window captures before trusting the visual state.

**Automatic failure screenshots.** When a test step fails, the framework
automatically takes a screenshot of the Dev Host window at the moment of
failure. These are saved as `<N>-failure-<scenario>-<step>.png` in the run
directory alongside any explicit screenshots you requested. This means you
always have a visual record of what went wrong — even if you didn't add a
manual `I take a screenshot` step. Review these failure screenshots carefully;
they show exactly what the user would have seen when the step failed.

**To verify screenshots**, use the `view_image` tool with the absolute path
to each `.png` file. This shows you the actual screenshot so you can see
what the Dev Host looked like at that point in the test.

Example:
\\`\\`\\`
view_image("C:/Users/.../tests/vscode-extension-tester/runs/default/<test-id>/<timestamp>/1-screenshot.png")
\\`\\`\\`

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

**Before requesting a framework fix, exhaust the tools available to you.**
Try different selectors, different webview titles, different step orderings,
longer waits, and the diagnostic steps (`I list the webviews`,
`I list the frame contexts`). Many apparent framework bugs are actually
selector mismatches, timing issues, or missing `data-testid` attributes.
Only after you have genuinely tried and failed should you escalate.

**When you hit a wall** — a missing step, a broken feature, a step that times
out unexpectedly, or any situation where the framework genuinely can't do what
you need — produce a **fix-request prompt** that an agent working in the
`vscode-extension-tester` repository could execute directly to implement the
fix. This is not a bug report for a human — it is an actionable implementation
prompt for another AI agent. Structure it exactly like this:

\\`\\`\\`
## 🛑 Framework Fix Request: [short title]

**What I was trying to do:**
[Describe the test scenario and the specific interaction you needed]

**What step/capability is missing or broken:**
[Be precise — e.g. "There is no step to read the text content of a specific
CSS selector in a webview" or "The 'I wait for' step times out even though
the element exists — it appears to not traverse nested iframes in custom
editor webviews"]

**What I observed:**
[Paste the exact error message, step output, or describe the unexpected behavior.
Include the full step text, the webview title, the selector, and any diagnostic
output from `I list the webviews` or `I list the frame contexts`.]

**What I already tried:**
[List every workaround you attempted and why each failed. This proves the
issue is in the framework, not in your test. E.g. "Tried different selectors,
confirmed element exists via `I evaluate`, waited 15 seconds, used
`I list the frame contexts` which shows only 1 execution context when 2
frames exist."]

**What the framework needs to support:**
[Describe the ideal fix. Reference specific files in the vscode-extension-tester
repo if you know them — e.g. "The `discoverFrameContextIds` method in
`packages/cli/src/runner/cdp-client.ts` needs to..." or "A new Gherkin step
in `packages/cli/src/runner/test-runner.ts` that..."]

**Suggested Gherkin step syntax (if applicable):**
\\`\\`\\`gherkin
Then element ".my-selector" should have text "expected" in the webview
\\`\\`\\`

**Priority:** [blocking — can't write any meaningful test for this feature]
or [degraded — can write a partial test but it misses the key assertion]
\\`\\`\\`

**Do NOT:**
- Write a weaker test as a workaround for a framework limitation
- Skip the critical verification and call it "good enough"
- Assume the test passed because no error was thrown
- Silently move on to the next test

**This fix-request prompt is your primary deliverable when blocked.** A well-
written, actionable prompt is more valuable than a bad test. It should contain
enough detail that an agent can open the vscode-extension-tester repo, read
the prompt, and implement the fix without further clarification.

## Test Workflow

### Live authoring workflow

When you are exploring an unfamiliar UI or fixing a flaky scenario, prefer
live stepping before editing the final feature file:

1. Start a live session with `start_live_session` when one is not already active.
2. Run candidate steps with `run_gherkin_step` or short blocks with `run_gherkin_script`.
3. Use `run_extension_host_script` only for explicit diagnostic JavaScript that must run in the VS Code extension host with the `vscode` API; it is not a Gherkin runner.
4. Inspect the returned screenshots/log artifact paths after each failure or surprising state.
5. Once the steps are stable, write the `.feature` file and verify it with `run_test`.
6. End the session with `end_live_session` so the final screenshot is captured.

`vscode-ext-test tests add` starts this live session automatically by default
when exploration is enabled. Use `--live-mode off` only when you want code-only
test drafting.

When a live session should use an authenticated or prepared profile, pass
`reuseNamedProfile` or `reuseOrCreateNamedProfile` to `start_live_session`.
Auto mode only attaches to an existing Dev Host when its detected user-data
directory matches the requested profile; otherwise it launches the requested
profile.

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

3. **Review artifacts** - artifacts are in `tests/vscode-extension-tester/runs/default/<test-id>/<timestamp>/` (gitignored). Read `report.md` first because it lists all results, screenshot file paths, screenshot capture metadata, webview text evidence, and warnings. Use `results.json` for structured results with per-screenshot capture metadata and per-webview text evidence, `console.log` for scenario/step output and warnings, and `*.png` for the screenshot images. Check the step artifact metadata when native capture fell back, the wrong window may have been captured, or a webview assertion needs text evidence beyond screenshots.

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

## Available Gherkin Steps

- `Given the extension is in a clean state` - reset: close all editors, dismiss notifications, clear output channels
- `When I execute command "<command-id>"` - run any VS Code command (waits for completion)
- `When I execute command "<command-id>" with args '<json>'` - run a VS Code command with arguments (JSON array in single quotes, e.g. `'["arg1","arg2"]'`)
- `When I start command "<command-id>"` - start a VS Code command without waiting (use for commands that show QuickInput dialogs, then interact with the dialog in the next step)
- `When I start command "<command-id>" with args '<json>'` - start a VS Code command with arguments without waiting
- `When I add folder "<path>" to the workspace` - add a folder to the workspace without reloading the window
- `When I inspect the QuickInput` - print the current QuickInput title, value, validation, and item IDs from captured extension-host state or the visible workbench widget
- `When I select QuickInput item "<label>"` / `When I select "<label>" from the QuickInput` - pick an item from captured QuickInput state or the visible workbench widget
- `When I select "<label>" from the QuickPick` - compatibility alias for selecting an open QuickPick item
- `When I enter "<text>" in the QuickInput` - set and accept text after validation clears
- `When I enter text in the QuickInput:` - set and accept multiline doc-string text after validation clears
- `When I type "<text>" into the InputBox` - compatibility alias for entering text in a VS Code InputBox prompt
- `When I type text into the InputBox:` - compatibility alias for entering multiline doc-string text in a VS Code InputBox prompt
- `When I click "<button>" on the dialog` - click a button on a modal dialog
- `When I click "<action>" on notification "<text>"` - resolve a captured VS Code notification action
- `When I select "<label>" from the popup menu` - select an item from a context menu, dropdown, or popup overlay (uses OS-level UI Automation with CDP fallback)
- `When I list the popup menu items` - diagnostic: list all visible items in the current popup menu
- `When I type "<text>"` - type text into whatever is focused (editors, webview Monaco, inputs)
- `When I type:` - type multiline doc-string text into whatever is focused (editors, webview Monaco, inputs)
- `When I press "<key>"` - press a key or combo (Enter, Escape, Ctrl+S, Ctrl+Space, Shift+Tab, F5, etc.)
- `When I click "<css selector>" in the webview` / `When I right click "<css selector>" in the webview` / `When I middle click "<css selector>" in the webview` / `When I double click "<css selector>" in the webview` - click a webview element by stable CSS selector
- `When I click the webview element "<text>"` - click a webview control by visible text, aria-label, title, or role text when no stable selector exists
- `When I evaluate "<js>" in the webview for <n> seconds` - run diagnostic JavaScript in a webview with a caller-provided timeout budget; the timeout must be less than the step timeout
- `When I move the mouse to <x>, <y>` - move the OS cursor to coordinates. In live sessions these are relative to the full Dev Host window/screenshot; in normal batch runs they are absolute screen coordinates.
- `When I click` / `When I right click` / `When I middle click` / `When I double click` - click at the current mouse position
- `When I click at <x>, <y>` / `When I right click at <x>, <y>` / `When I middle click at <x>, <y>` / `When I double click at <x>, <y>` - click coordinates. In live sessions these are relative to the full Dev Host window/screenshot, including title bar and borders; in normal batch runs they are absolute screen coordinates.
- `When I right click the element "<name>"` - open a context menu on an accessible element by name/text
- `When I sign in with Microsoft as "<user>"` - handle Microsoft auth flow
- `Then I should see notification "<text>"` - assert a notification contains text
- `Then I should not see notification "<text>"` - assert NO notification contains text
- `Then I wait for QuickInput item "<label>"` - wait for a visible QuickInput item
- `Then I wait for QuickInput title "<text>"` - wait for a QuickInput title
- `Then I wait for QuickInput value "<value>"` - wait for the current QuickInput value
- `Then the QuickInput should contain item "<label>"` - assert the current QuickInput has an item
- `Then the QuickInput title should contain "<text>"` - assert QuickInput title text
- `Then the QuickInput value should be "<value>"` - assert QuickInput value
- `Then I wait for progress "<title>" to start` / `Then I wait for progress "<title>" to complete` - wait for a tracked long-running operation
- `Then progress "<title>" should be active` / `Then progress "<title>" should be completed` - assert tracked progress state
- `Then the editor should contain "<text>"` - assert the active editor has text
- `Then the editor should contain:` - assert the active editor contains multiline doc-string text
- `Then the output channel "<name>" should contain "<text>"` - assert output channel content
- `Then the output channel "<name>" should contain:` - assert output channel content includes multiline doc-string text
- `Then the output channel "<name>" should not contain "<text>"` - assert output channel does NOT contain text
- `Then the output channel "<name>" should not contain:` - assert output channel content does NOT include multiline doc-string text
- `Then I wait for output channel "<name>" to contain:` / `Then I wait for output channel "<name>" to contain for <n> seconds:` - wait for multiline doc-string text in an output channel
- `Then the file "<path>" should contain:` - assert file content includes multiline doc-string text
- `Then I wait <n> second(s)` - pause for n seconds

### Multiline Text

Do not put literal newlines inside quoted step arguments. Quoted arguments are
for single-line values. For multiline editor text, code blocks, JSON, strings
with many quotes, or any payload where line breaks matter, use a Gherkin doc
string on the colon-ended step form:

```gherkin
When I type:
  """
  first line
  second line
  """
Then the editor should contain:
  """
  first line
  second line
  """
```

In live sessions, send doc-string blocks with `run_gherkin_script` or JSONL
`runScript`, not as a single quoted `run_gherkin_step` string with literal line
breaks.

### Reliable Input Targeting

Use the most semantic target that can reach the UI:

1. Prefer VS Code commands and QuickInput inspection/selection/text steps when the behavior is command-driven; these steps fall back to the visible workbench QuickInput widget when no extension-host session was intercepted.
2. For webviews, prefer stable CSS selectors such as `[data-testid='...']`; selector clicks use DOM-first activation and collect diagnostics on failure.
3. If a webview has no stable selector, use `I click the webview element "<text>"` before falling back to native automation.
4. For workbench/native UI, use accessible-name clicks such as `I click the element "Run Query"` or `I right click the element "Explorer"`.
5. Prefer QuickInput/progress/notification wait steps over fixed sleeps.
6. Use raw coordinates only as a last resort. In live sessions, raw coordinates are full Dev Host window/screenshot-relative; in normal batch runs, they are absolute screen coordinates. Stabilize the window first with `I resize the Dev Host...` / `I move the Dev Host...`.

Right-clicking and popup selection are two separate actions: first use a
right-click step to open the context menu, then use
`When I select "<label>" from the popup menu`.

### Settings

Change or verify any VS Code or extension-contributed setting at runtime:

- `When I set setting "<key>" to "<value>"` - set a setting (applies to user/global scope by default)
- `Then setting "<key>" should be "<value>"` - assert a setting has the expected value

**Value parsing.** The value is JSON-parsed when possible:
- `"true"` / `"false"` → boolean
- `"42"` → number
- `"null"` → resets the setting to its default (VS Code treats `null` as "remove override")
- Anything that is not valid JSON stays as a plain string (e.g. `"on"`, `"hello"`)

**Works for any setting** — built-in VS Code settings (`editor.fontSize`,
`editor.minimap.enabled`) and extension-contributed settings
(`myExtension.enableFeature`, `extensionTester.controllerPort`).

**Settings persist across scenarios** within the same test run. They are NOT
reverted by the `the extension is in a clean state` reset step. If you need
a clean baseline, explicitly set the value back at the start of each scenario.

Example:

\\`\\`\\`gherkin
Feature: Extension respects font size setting
  Scenario: Large font
    When I set setting "editor.fontSize" to "24"
    Then setting "editor.fontSize" should be "24"

  Scenario: Boolean toggle
    When I set setting "editor.minimap.enabled" to "false"
    Then setting "editor.minimap.enabled" should be "false"

  Scenario: Extension setting
    When I set setting "myExtension.maxResults" to "100"
    Then setting "myExtension.maxResults" should be "100"

  Scenario: Reset to default
    When I set setting "editor.fontSize" to "null"
\\`\\`\\`

### Click/Focus Elements by Accessible Name (Windows UI Automation)
These use Windows accessibility to find and click elements by their name or text.
They work for ANY element - including inside webviews, custom editors, and dialogs:
- `When I click the element "<name>"` - click an element by its accessible name/text
- `When I right click the element "<name>"` - right-click an element by its accessible name/text
- `When I middle click the element "<name>"` - middle-click an element by its accessible name/text
- `When I double click the element "<name>"` - double-click an element by its accessible name/text
- `When I click the "<name>" button` - click a button by name
- `When I click the "<name>" edit` - click a text field by name

Example - click a button inside a webview:
\\`\\`\\`gherkin
When I click the element "Select favorite..."
When I click the element "Run Query"
When I click the "File name:" edit
\\`\\`\\`

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
   \\`\\`\\`gherkin
   When I click "[data-testid='add-connection-btn']" in the webview
   Then element "[data-testid='status-indicator']" should exist
   Then element "[data-testid='results-section']" should have text "42 rows"
   \\`\\`\\`

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
| `When I right click "<sel>" in the webview` | Right-click an element by selector |
| `When I middle click "<sel>" in the webview` | Middle-click an element by selector |
| `When I double click "<sel>" in the webview` | Double-click an element by selector |
| `When I focus "<sel>" in the webview` | Focus an input or scroll container |
| `When I scroll "<sel>" by <dx> <dy>` | Scroll a container relatively |
| `When I scroll "<sel>" to <x> <y>` | Scroll to absolute coords |
| `When I scroll "<sel>" to the (top\\|bottom\\|left\\|right)` | Jump to an edge |
| `When I scroll "<sel>" into view` | Scroll the element itself into view |
| `When I evaluate "<js>" in the webview` | Run arbitrary JS (escape hatch) |
| `When I list the webviews` | Log all open webview titles, probed DOM titles, URLs, and bounded visible text evidence (debugging aid) |
| `When I list the frame contexts` | Log all execution contexts (frames) inside webview targets — shows context IDs, origins, frame IDs, and the frame tree. Use to diagnose when evaluate/click steps can't find elements inside nested iframes. |
| `When I list the frame contexts in the webview "<title>"` | Same, but restricted to a specific webview |
| `Then the webview should contain "<text>"` | Substring match in body text; records bounded webview text evidence in `results.json` and `report.md` |
| `Then the webview "<title>" should contain "<text>"` | Restrict to a webview and record target-attributed text evidence |
| `Then element "<sel>" should exist` | Existence assertion |
| `Then element "<sel>" should not exist` | Negative existence |
| `Then element "<sel>" should have text "<text>"` | Text content assertion; records selector-scoped webview text evidence |
| `Then element "<sel>" should have text "<text>" in the webview` | Text content assertion; records selector-scoped webview text evidence |
| `Then element "<sel>" should have text "<text>" in the webview "<title>"` | Restrict selector text assertion to a specific webview and record target-attributed evidence |

**Webview targeting.** When multiple webviews are open at once (walkthroughs,
panels, sidebar views), pass a `<title>` substring to disambiguate. The
framework uses a 3-tier matching strategy (all case-insensitive):

1. **CDP target title / URL** — the fastest check; matches the title and URL
   that Chrome DevTools Protocol reports for each webview target.
2. **Tab activation** — if tier 1 misses, the framework asks VS Code to
   activate (bring to front) the tab whose label matches, ensuring the
   webview's DOM is live for the next step.
3. **DOM title probe** — connects to each webview via CDP and evaluates
   `document.title` across all frames (including nested cross-origin
   iframes). This catches webviews whose CDP target title is generic but
   whose inner HTML sets a meaningful `<title>`.

**Cross-origin iframe support.** VS Code webview panels use deeply nested
cross-origin iframes (main renderer → `vscode-webview://` outer → inner
content frame). The framework automatically discovers all execution contexts
across all frames within each webview target — including inner iframes whose
contexts may take longer to register. When interacting with custom editor
webviews that use Web Components (Lit, Shoelace, etc.) rendered inside these
nested frames, all CSS selector steps and evaluate steps traverse every frame
automatically. If you suspect a frame discovery issue (e.g. an element exists
but the framework can't find it), use `When I list the frame contexts` to
inspect which execution contexts and frames were discovered.

This means **the VS Code tab label usually works as the title** — the
framework will find it via tab activation + DOM probing even when the CDP
target title doesn't match. If your title still isn't matching, use the
debugging step `When I list the webviews` to see what titles, probed titles,
and URLs the framework actually sees. Omit the title and the framework tries
every webview until one matches.

**Scrolling a specific section or table.** Find a stable selector for the
container (not the page) - e.g. `section[data-testid="results-table"] .scroll-body`
or `.kw-section--results .table-scroll`. Then:

\\`\\`\\`gherkin
Scenario: Scroll the results table
  When I execute command "kusto.runQuery"
  And I wait for ".kw-results .scroll-body" in the webview
  And I scroll ".kw-results .scroll-body" to the bottom
  Then element ".kw-results tr:last-child" should exist
\\`\\`\\`

\\`\\`\\`gherkin
Scenario: Horizontally scroll a wide table
  When I scroll ".kw-results .scroll-body" by 800 0
  Then element ".kw-results th[data-col=\"timestamp\"]" should exist
\\`\\`\\`

\\`\\`\\`gherkin
Scenario: Click a button in a specific section of the dashboard
  When I click ".kw-section--charts button.export" in the webview "Dashboard"
  Then I should see notification "Export complete"
\\`\\`\\`

**Escape hatch - evaluate JS.** Use sparingly, but when the selector-based
steps cannot express what you need (e.g. you need to inspect a virtualized
list's internal state), reach for `I evaluate`:

\\`\\`\\`gherkin
When I evaluate "document.querySelectorAll('.row').length" in the webview
\\`\\`\\`

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

\\`\\`\\`gherkin
Feature: Query execution writes a structured trace
  Background:
    Given the extension is in a clean state
    And I capture the output channel "Kusto Workbench"

  Scenario: Trace contains the executed query
    When I execute command "kusto.runQuery"
    And I wait 3 seconds
    Then the output channel "Kusto Workbench" should contain "StormEvents | take 10"
    And the output channel "Kusto Workbench" should have been captured
\\`\\`\\`

**Important caveat.** Channels created by the target extension *before the
controller activates* cannot be captured retroactively - VS Code's API does
not expose enumeration of existing output channels. The controller declares
`activationEvents: ["*"]` so it activates as early as possible, but if your
extension creates a channel synchronously inside its own `activate()` and
loses the activation race, the channel will not be wrapped. The fix is to
defer channel creation by one tick (`queueMicrotask` / `setImmediate`) inside
your extension, or to call `createOutputChannel` lazily on first use.

### Native OS Automation (Windows)

These steps use a FlaUI bridge (.NET) to automate native Windows dialogs that
VS Code cannot control via its API — file pickers, message boxes, window
management.

| Step | Description |
|------|-------------|
| `When I open the file "<path>"` | Handle Open File dialog: type filename, press Enter |
| `When I save the file as "<path>"` | Handle Save As dialog: type filename, press Enter |
| `When I click "<button>" on the "<title>" dialog` | Click a button on any native dialog by title |
| `When I cancel the Save As dialog` | Dismiss a Save/Open dialog (presses Escape) |
| `When I cancel the Open dialog` | Same — works for any file dialog variant |
| `When I resize the (window\\|Dev Host) to <W>x<H>` | Resize the Dev Host window |
| `When I move the (window\\|Dev Host) to <x>, <y>` | Move the Dev Host window |

**Important: triggering native dialogs from VS Code.**

Native file dialogs appear when you run commands like
`workbench.action.files.openFile` (Ctrl+O) or `workbench.action.files.save`
with an untitled file. These commands **block until the dialog is dismissed**,
so you MUST use `I start command` (fire-and-forget), NOT `I execute command`
(which waits for completion and would hang).

After starting the command, **wait for the dialog to appear** before
interacting with it:

\\`\\`\\`gherkin
When I start command "workbench.action.files.openFile"
And I wait 3 seconds
And I open the file "C:\\Users\\me\\data.csv"
\\`\\`\\`

**Paths must be absolute.** The file dialog types the path into the OS "File
name:" edit field and presses Enter. Relative paths resolve relative to
whatever folder the dialog is currently browsing — which is unpredictable.
Always use absolute paths.

**Tip — use `${TEMP}` for temp files.** The `${VAR}` syntax resolves from
environment variables. Combine with the temp file step:

\\`\\`\\`gherkin
Given a temp file "test-data.txt" exists with content "hello world"
When I start command "workbench.action.files.openFile"
And I wait 3 seconds
And I open the file "${TEMP}\\test-data.txt"
And I wait 2 seconds
Then the editor should contain "hello world"
\\`\\`\\`

### Screenshots
- `Then I take a screenshot` - capture the targeted Extension Development Host window, saved to the run directory with Dev Host PID, captured window title/bounds, and capture method metadata
- `Then I take a screenshot "label"` - capture the targeted Dev Host with a descriptive label (e.g. "after-query-runs") and the same capture metadata

### File Utilities (direct via code - no UI dialogs)
Use these for test setup when you don't need to test the actual dialog interaction:
- `Given a file "<path>" exists` - create an empty file (relative to cwd or absolute)
- `Given a file "<path>" exists with content "<text>"` - create a file with content
- `Given a file "<path>" exists with content:` - create a file with multiline doc-string content
- `Given a temp file "<name>" exists` - create in OS temp directory
- `Given a temp file "<name>" exists with content "<text>"` - create temp file with content
- `Given a temp file "<name>" exists with content:` - create temp file with multiline doc-string content
- `When I open file "<path>" in the editor` - open file directly (no Open dialog)
- `When I delete file "<path>"` - delete a file
- `Then the file "<path>" should exist` - assert file exists on disk
- `Then the file "<path>" should contain "<text>"` - assert file content
- `Then the file "<path>" should contain:` - assert file content includes multiline doc-string text

### Clean State

Every test should start from a known state. Use Background to reset before each scenario:

\\`\\`\\`gherkin
Feature: My tests
  Background:
    Given the extension is in a clean state
    And I wait 1 second

  Scenario: First test
    When I execute command "myExtension.doSomething"
    ...
\\`\\`\\`

The reset step closes all editors, dismisses notifications, clears output channels,
and closes panels/sidebars. This ensures each scenario starts from the same baseline.

## Repo-Specific Knowledge

When you run `vscode-ext-test install-into-project`, a `repo-knowledge.md` file is created in
`.github/skills/e2e-test-extension/` alongside this SKILL.md. Unlike SKILL.md
(which is overwritten on every `install-into-project` to stay current with framework updates),
**`repo-knowledge.md` is never overwritten** — it is your persistent,
repo-specific knowledge base.

Use `repo-knowledge.md` to record things you learn about testing THIS specific
codebase that would help in future test sessions:

- Which command IDs the extension registers and what they do
- Webview titles and CSS selectors that work (or don't work) for this extension
- Extension activation quirks (e.g. "needs a .kql file open before commands are available")
- Auth flows or environment setup required for specific features
- Known flaky areas or timing-sensitive steps that need longer waits
- `data-testid` attributes that exist (or that you recommended adding)
- Workarounds for framework limitations specific to this extension's UI

**Read `repo-knowledge.md` before every test session.** It contains hard-won
knowledge from previous sessions. **Update it after every session** with
anything new you learned.

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
