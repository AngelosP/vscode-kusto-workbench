# Post-v4.7.4 Regression Test Plan

## Goal

Reduce the probability of shipping a broken user workflow after the large post-v4.7.4 architecture and feature changes. Tests must falsify concrete failure modes. Coverage percentage is not a release goal.

## Change Review

The `v4.7.4..HEAD` delta spans 659 files: 133 host source files, 103 webview source files, 28 shared source files, 19 browser-extension files, 253 Vitest files, 6 extension-host test files, and 90 native E2E assets.

The highest-risk themes are:

1. Exact execution, cancellation, result artifacts, derived consumers, and privacy admission.
2. Native document and compatibility-sidecar startup, Save, close, reload, and lossless persistence.
3. Kusto/SQL connection, database, schema, completion, and editor lifecycle identity.
4. Human interaction: focus, caret placement, typing, scrolling, menus, toolbars, resize, collapse, dialogs, and native pickers.
5. Browser viewer acquisition, navigation replacement, read-only composition, and listener cleanup.
6. Host workflow extraction where behavior should remain unchanged but routing, disposal, or settlement can regress.

## Test-Layer Rules

Use the lowest layer that can conclusively falsify the risk:

| Risk | Required layer |
| --- | --- |
| Pure parsing, shaping, identity, stale response, cancellation, disposal, retry, timeout | Vitest unit/state-machine test |
| VS Code document lifecycle, filesystem, sidecar locks, commands, SecretStorage | Extension-host integration test |
| Focus, typing, pointer coordinates, scrolling, popup dismissal, toolbar overflow, resize, collapse, native dialogs/pickers | Native E2E |
| Browser page injection, navigation, iframe, download, responsive layout | Built-browser Playwright test |

Do not replace a native interaction with `element.click()`, synthetic mouse events, or direct `scrollTop` assignment when the browser/OS event path is the behavior under test.

## Native User Journeys

These journeys are release gates because unit tests cannot prove their input and geometry behavior:

| Journey | Test ID | Assertions |
| --- | --- | --- |
| Scrolled Monaco click and typing | `kusto-click-caret-fidelity` | Native click maps to the intended line; uninterrupted typing changes that model and rendered row; caret advances exactly; page scroll remains stable |
| Responsive toolbar overflow | `sql-toolbar-actions` | Real overflow appears at narrow width; hidden Search action opens Monaco Find; action closes menu; real page scroll dismisses a reopened menu |
| Section controls and layout | `section-layout-regression` | Native double-click auto-fit changes bounded height; real collapse/expand hides and restores content without replacing section ownership |
| Compatibility close | `kql-companion-close` | Dirty metadata remains off disk; native Save/Discard modal appears; Save writes exact sidecar state; reopen restores it |
| Horizontal table keyboard navigation | `tabular-keyboard-horizontal-scroll` plus authenticated table suites | Real arrow/Page keys move the active table viewport without moving the page |
| Result export/share | `csv-result-artifacts`, `share-result-artifacts`, authenticated result suites | Real buttons and native picker/clipboard adapters use the exact current artifact and reject revoked data |
| Startup and persistence | `host-owned-markdown-lifecycle`, `kusto-restored-startup`, SQL persistence suites | Initial projection appears once; Save/close/reopen preserve state and reject predecessor traffic |
| Query execution and cancellation | `kusto-execution-contract`, `query-cancel`, `sql-sts-execution-contract` | Real Run/Cancel controls preserve exact owner identity, replacement, target changes, terminal state, and recovery |

Every E2E run must include semantic assertions, foreground-valid screenshots, and manual screenshot review for clipping, overlap, stale menus, dialogs, or error UI.

## Deterministic Coverage

The following contracts belong in unit or integration suites:

- Protocol parsers reject malformed recognized traffic before service, router, waiter, or UI effects.
- Startup queues continue after one handler rejection and preserve admission order.
- Reorder persistence is immediate so Save/close cannot overtake the new order.
- Compatibility and native persistence preserve unknown fields, opaque sections, order, revisions, and exact Save barriers.
- Execution and schema/database responses require current section, target, request, principal, and policy identity.
- Cancellation, replacement, timeout, and disposal settle once and suppress late publication.
- Remote URLs preserve signed query/fragment data; downloads are size- and time-bounded; retries stop on disposal.
- Browser navigation physically aborts old downloads, bounds streamed bytes, and removes iframe scroll/resize listeners.
- Privacy transitions purge rendered, shared, persisted, derived, and model-bound rows.

## Release Gates

Run in this order so failures remain diagnosable:

```powershell
npm run check-types
npm run lint
npx vitest run --maxWorkers=1
npm run test:coverage-gate
npm run compile-tests
npm test
npm run package
npm run bundle-size:gate
npm run build --prefix browser-ext
```

Then run the native behavior subset above against `default`, `kusto-auth`, and `sql-auth` named profiles. Run `npm run test:e2e:full:behavior` for a release candidate after profile checks pass.

## Flake Policy

- Preserve the first failure and its artifacts.
- Rerun the exact failed file/scenario unchanged once.
- A passing rerun is a flake suspect, not a clean first attempt.
- Repeated failures, failures in changed code, or screenshot defects block release.
- Known filesystem-lock races must be reported with both the full-run result and isolated rerun result.

## Remaining Gaps

1. Native section drag/reorder needs a selector-based OS drag step in `vscode-extension-tester`. Current deterministic coverage proves reorder durability, but synthetic drag is not accepted as human E2E evidence.
2. A never-settling nested webview initializer can outlive panel cancellation/disposal. The fix must preserve pre-handler `beforeunload` state; racing disposal and dropping that state is not acceptable.
3. Editor database loading needs a bounded timeout owned by the existing lifecycle coordinator so a sole malformed/lost terminal cannot leave controls loading forever.
4. The browser viewer still needs built-browser adversarial coverage for forged pre-adoption page messages and repeated SPA navigation.