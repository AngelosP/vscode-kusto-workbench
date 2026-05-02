---
name: repro-bug
description: >
  Reproduce reported bugs by adding the smallest viable failing test. Use when
  given a bug report, GitHub issue URL, github.com/.../issues/... link, issue
  number, repro case, minimal reproduction, red test, failing regression test,
  actual vs expected behavior, or a request to reproduce a bug without fixing it.
argument-hint: "GitHub issue URL, issue number, or pasted bug report"
---

# repro-bug

Use this skill to turn a reported bug into one or more failing tests in the
repo. The goal is reproduction only. Once the bug is faithfully reproduced by a
test that fails for the reported symptom, stop and report the result. Do not fix
the product code as part of this skill.

## When to Use

- A user gives a GitHub issue URL or issue number and asks to reproduce it.
- A user pastes a bug report with actual and expected behavior.
- A user asks for a minimal reproduction, red test, failing regression test, or
  repro case.
- A user explicitly says to reproduce a bug and not fix it yet.

## Non-Negotiable Stop Rule

This workflow intentionally stops earlier than the normal bug-fix workflow. The
repository generally wants regression tests before fixes, but this skill's job
is only the first half: create the failing repro. After a valid failing test is
in place, do not edit source code to make it pass.

## Input Intake

1. Preserve the report's exact observed behavior, expected behavior, trigger
   steps, affected file type, and environment details.
2. If the input is a GitHub issue URL, fetch or inspect the issue details when
   possible. If the issue is private, inaccessible, or too sparse, ask the user
   for the missing report details instead of guessing from the title.
3. If the input is a bare issue number, resolve it against this repository's
   GitHub issue tracker. Prefer the repository URL from `package.json` or
   `git remote`; for this repo, inspect
   `https://github.com/AngelosP/vscode-kusto-workbench/issues/<number>` when
   possible.
4. If the report mentions a specific mode, reproduce that same mode:
   `.kqlx`, `.sqlx`, `.kql`, `.csl`, `.md`, custom editor, compatibility mode,
   webview viewer, command palette command, connection manager, or notebook
   persistence.
5. Identify the smallest user-visible assertion that proves the bug exists.
   Avoid broad assertions that only prove something failed somewhere.

## Test Selection Protocol

Choose the smallest test type that can faithfully reproduce the bug. Prefer
unit and integration tests over E2E because they are easier to write, maintain,
and execute, but never choose a smaller test if it cannot reproduce the real
bug.

### Prefer Unit or Pure Host Tests

Use these when the bug can be isolated to pure logic, parsing, formatting,
schema inference, serialization, prompt building, host helper behavior, protocol
message handling, or a test harness around a provider method.

Common locations:
- `tests/webview/**/*.test.ts` for Vitest webview and shared-code tests.
- `tests/webview/host/**/*.test.ts` for host-side logic that can run under
  Vitest without a real VS Code extension host.

Common commands:
```powershell
npx vitest run tests/webview/path/to/repro.test.ts
npm run test:webview
```

### Use Webview Unit Tests for Browser-DOM Behavior

Use these when Lit rendering, DOM events, webview state, table/chart helpers, or
browser-side message handling can be reproduced without launching VS Code. Use
the existing webview test helpers and keep the setup close to nearby tests.

### Use Integration Tests for VS Code Host Behavior

Use these when the bug depends on the VS Code extension host API, activation,
commands, language features, custom editor provider lifecycle, persistence with
workspace files, diagnostics, completions, or extension-host services that need
`vscode`.

Common location:
- `tests/integration/**/*.test.ts`

Common command:
```powershell
npm test
```

If a narrow integration-test filter is not already verified for this repo, do
not invent one. Run the nearest reliable command and report the relevant failing
test.

### Escalate to E2E Only When Necessary

Use E2E only when the bug requires native VS Code UI behavior, real webview
embedding, Monaco mouse or keyboard behavior, screenshots, auth/profile flows,
connection-picker behavior with prepared profiles, command-palette interaction,
or cross-surface behavior that smaller tests cannot reproduce.

Before writing E2E tests, load and follow the existing E2E skill:
- `.github/skills/e2e-test-extension/SKILL.md`
- `.github/skills/e2e-test-extension/repo-knowledge.md`
- `tests/vscode-extension-tester/E2E_HELPERS.md`

Use the E2E skill's exploration workflow first. Prefer `vscode-ext-test tests
add` with live exploration or `vscode-ext-test live` so you can progressively
send steps, inspect screenshots, inspect artifacts, and discover stable
selectors before committing a final `.feature` file. Prefer existing
`window.__e2e` helpers from `E2E_HELPERS.md` when they cover the behavior.

Final E2E repros normally live under:
- `tests/vscode-extension-tester/e2e/default/<test-id>/`
- `tests/vscode-extension-tester/e2e/kusto-auth/<test-id>/`
- `tests/vscode-extension-tester/e2e/sql-auth/<test-id>/`

Run final E2E repros with the profile that matches the directory:
```powershell
# default profile
vscode-ext-test run --test-id <test-id>

# named authenticated profiles
vscode-ext-test run --test-id <test-id> --reuse-named-profile kusto-auth
vscode-ext-test run --test-id <test-id> --reuse-named-profile sql-auth
```

Always inherit the E2E skill's evidence rules: inspect generated reports,
verify screenshots with `view_image`, reject tests that only check that no error
was thrown, and use stable selectors or explicit testability hooks.

## Repro Loop

1. Inspect nearby code and tests until you understand the behavior path.
2. Pick the smallest viable test type using the protocol above.
3. Add one focused failing test or the smallest set of failing tests needed to
   cover the reported behavior.
4. Run the targeted test first when possible.
5. Confirm the failure is caused by the reported bug, not by bad setup, import
   mistakes, timing, stale build output, missing auth, missing selectors, or an
   assertion that does not match the report.
6. If the test fails for the wrong reason, fix the test setup and rerun. Do not
   modify product source to make the failure appear.
7. Once a test fails for the reported symptom, stop.

Good repro failures usually have all of these properties:
- The assertion names the expected user-visible behavior.
- The actual failure output maps directly to the report.
- A nearby baseline still passes, or the setup is narrow enough that unrelated
  breakage is unlikely.
- The test would pass if the product bug were fixed.

## E2E Blocker Path

If unit, webview, and integration tests cannot reproduce the bug and E2E is
required, but `vscode-ext-test` cannot perform a required action or assertion,
stop and report the blocker. Do not write a weaker test that misses the bug.
This skill also overrides any E2E guidance that would add product testability
hooks during reproduction: do not add or modify product selectors, `data-testid`
attributes, or app-only helper APIs while using `repro-bug`. Report the missing
testability hook as the next required product change instead.

Blockers include:
- No framework step or API for the needed interaction.
- No way to assert the relevant state.
- Missing stable selector or testability hook in the app.
- Screenshots or artifacts cannot verify the scenario reliably.
- Required auth/profile state cannot be prepared safely.

When blocked by the E2E framework, produce the fix-request prompt required by
the `e2e-test-extension` skill. Include what you tried, exact errors or missing
steps, selectors/webview titles involved, and the framework capability needed.
For missing app selectors or testability hooks, report the product-side hook
needed rather than using the E2E framework fix-request format.

## Completion Report

When the repro succeeds, report:
- The bug input source you reproduced.
- The test type selected and why smaller test types were or were not enough.
- Files added or changed.
- Exact command run.
- The failing test name and the important failure output.
- Why that failure matches the reported bug.

Also state clearly that the product bug has not been fixed yet and that the new
test is expected to fail until the bug is fixed.

When reproduction is not possible, report:
- What you tried.
- Why each attempted test type could not reproduce the issue.
- The missing product details, testability hook, auth/profile setup, or
   `vscode-ext-test` capability needed next.