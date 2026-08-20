---
name: test-coverage-planning
description: >
  Plan cohesive test coverage before and after behavior changes, bug fixes, new
  features, persistence work, lifecycle changes, or completion claims. Build a
  coverage ledger, map state and transition permutations, account for existing
  exact assertions, choose unit/integration/E2E layers, avoid duplicate tests,
  and identify high-value composed scenarios.
---

# Test Coverage Planning

Use this protocol for every observable behavior change, bug fix, first-time
capability, persistence/lifecycle change, and claim that implementation or
coverage is complete. Use it before broad implementation when practical, and
repeat it after implementation because newly discovered owners and transitions
can change the matrix.

The goal is not the largest test count. The goal is a defensible set of tests
where each selected case exercises a distinct contract, owner, branch,
transition, interaction, or failure mode, and every omitted case has an explicit
reason.

## Non-Negotiable Gates

Do not claim coverage or implementation complete until all of these are true:

1. The exact user acceptance path is represented as one composed scenario. Do
   not substitute separate tests for setup, interaction, persistence, and
   restore when their composition is the risk.
2. Every real user control changed or introduced is exercised through that
   control in at least one E2E scenario. Direct APIs may prepare state, but may
   not replace the interaction under test.
3. Existing coverage is credited only by citing its exact setup, action, and
   oracle. A filename, test count, or nearby assertion is not evidence.
4. Persisted and restored behavior is checked at all relevant layers: live UI,
   durable bytes, reopened UI, and post-reopen interaction.
5. Revision/identity-bearing behavior is tested beyond the first revision when
   later revisions take a different branch or can collide with restored state.
6. A counterexample review has attempted to break the selected set using
   dependent surfaces, default/nondefault transitions, failure cleanup, stale
   owners, and realistic existing documents.
7. Every E2E run has reviewed JSON/log artifacts and trustworthy screenshots;
   retries disclose earlier failures and their classification.

## Coverage Design Workflow

### 1. State the Observable Contract

Write the contract in user terms, including what must remain independent.
Examples:

- The query table displays its selected result independently from a Chart's
  bound result index.
- Save/reopen preserves both values and changing either control after reopen
  affects only its owner.

Name the exact acceptance lifecycle, not merely the endpoint.

### 2. Map Owners and Boundaries

List the code owner for each state and transition:

- UI control and event handler
- runtime state/store
- host authorization or protocol
- persistence serializer/materializer
- durable format
- restore/admission path
- dependent consumer binding
- close/reload/reopen coordinator

Two cases are equivalent only when they traverse the same owners and branch
conditions. Similar UI output is not enough.

### 3. Enumerate Dimensions

Consider each relevant dimension. Mark irrelevant dimensions explicitly rather
than silently ignoring them.

| Dimension | Representative values |
|---|---|
| Initial state | fresh, restored, legacy/migrated, dirty, stale owner |
| User trigger | real menu/dropdown/button, shortcut, host/tool request |
| Value transition | default -> nondefault, nondefault -> default, A -> B, same value |
| Execution revision | first result publication, rerun/new revision, failed rerun |
| Lifecycle | live, Save, immediate close, reopen, force reload, rapid reopen |
| Document host | scratch session, rich KQLX/MDX, KQL/CSL companion, viewer |
| Dependent surface | none, Chart, transformation, comparison, share/export/model |
| Target/privacy | runtime-only target, persisted target, retarget, revoked policy |
| Failure timing | before mutation, between stage/commit, after teardown, retry |
| Data shape | same schema/count with changed values, schema change, result count shrink/grow |

Add domain-specific dimensions when they change branch ownership.

### 4. Build the Transition Model

For stateful features, list transitions, not only values. At minimum inspect:

- default -> nondefault
- nondefault -> different nondefault
- nondefault -> default, especially when serialization omits defaults
- live -> saved -> reopened
- revision N -> revision N+1
- valid -> temporarily unavailable -> valid
- source selection changes while a dependent consumer is bound
- successful projection -> failed projection -> identical retry

Known coupled dimensions require the full tuple. Pairwise reduction is allowed
only after exact acceptance paths and known coupled tuples are included.

### 5. Inventory Existing Evidence

For every candidate existing test, record:

- exact test and line or scenario
- setup values
- interaction fidelity
- lifecycle boundaries crossed
- oracle asserted
- revision/build/profile used
- whether it failed before the fix or otherwise demonstrates sensitivity

Classify evidence:

- **Exact**: same contract, owners, transition, and oracle
- **Partial**: covers one boundary but not the composed lifecycle
- **Lower-layer**: proves a pure branch but not user behavior
- **Duplicate**: adds no distinct branch or oracle
- **Stale**: predates relevant implementation or ran a different build/profile

Only Exact evidence can replace a proposed scenario. Partial evidence may reduce
lower-layer duplication but cannot replace the composed path.

### 6. Select Tests by Risk and Layer

Use the cheapest layer that can faithfully exercise each distinct branch:

- Pure/unit tests: value matrices, parsers, reducers, default omission,
  validation, all result indexes, malformed inputs
- Webview tests: DOM events, Lit state, dropdown behavior, independent stores,
  render routing
- Host/integration tests: authorization, revisions, close/reload ordering,
  durable writes, multi-panel ownership
- E2E: real controls, VS Code custom-editor lifecycle, auth/profile behavior,
  cross-surface composition, screenshots

Every E2E row must name the unique boundary or interaction it adds. Put broad
Cartesian value matrices in parameterized lower-layer tests.

### 7. Reduce Without Hiding Risk

Start with the raw matrix, then reduce using these rules:

1. Keep the exact acceptance path mandatory.
2. Keep every prior escaped-defect path mandatory.
3. Keep each distinct owner/branch at least once.
4. Keep default-removal and nondefault-addition transitions when serialization
   differs.
5. Use pairwise representatives only for dimensions shown to be independent.
6. Use one representative per document host only when host ownership is truly
   shared; otherwise test each owner.
7. Exclude a case only with one of:
   - exact existing assertion
   - proven same owner and branch
   - lower-layer exhaustive coverage plus one E2E representative
   - impossible state with cited validation
   - tracked blocker or deferred risk

"Seems similar", "covered indirectly", and "too many permutations" are not
valid rationales.

### 8. Perform Counterexample Review

Before completion, ask a pessimistic reviewer or perform the equivalent review:

- What if the producer and consumer select different indexes?
- What if a default value is omitted from disk?
- What if data values change but schema and row count do not?
- What if result count shrinks or grows?
- What if the same file is reopened, reloaded, or reopened rapidly?
- What if a later section fails after an earlier section was recreated?
- What if the current profile maps the same physical target to another opaque ID?
- What if the test used direct state injection while users use a rendered control?
- What if revision 1 passes but revision 2 collides with restored local state?
- What assertion would have failed before the implementation change?

Turn concrete uncovered counterexamples into ledger rows before declaring done.

## Coverage Ledger Template

Create this ledger in the working notes, plan, PR description, or task summary
for substantial behavior changes. Keep it current as tests reveal new paths.

```markdown
# Coverage Ledger: <change>

Contract: <observable user behavior>
Exact acceptance lifecycle: <setup -> interaction -> transitions -> boundaries -> oracle>
Owners/boundaries: <modules, protocols, durable format, dependent surfaces>
Raw dimensions: <dimension=value sets>
Reduction rule: <why selected representatives cover the raw matrix>

| ID | Composed lifecycle / transition | Unique owner or branch | Existing exact evidence | Decision | Layer and interaction fidelity | Oracle | Result |
|---|---|---|---|---|---|---|---|
| C1 | ... | ... | test:line or none | Include | E2E, real dropdown | live + disk + reopen | pending |
| C2 | ... | same as C1 | test:line | Exclude | exact existing | ... | n/a |
```

Allowed decisions: `Include`, `Existing`, `Exclude`, `Defer`.

Every `Existing` row needs an exact reference and setup/action/oracle match.
Every `Exclude` or `Defer` row needs a concrete rationale. Every `Include` row
must identify the failure it can detect that another included row cannot.

## Completion Report

Report:

- exact composed scenarios added or reused
- new owner/transition paths each scenario explores
- cases deliberately excluded and why
- first failing evidence for bugs found during coverage expansion
- final executable validation and artifact review
- remaining risks, profile/build limitations, or untested hosts

If the user can reproduce a bug only in an installed build while E2E uses a
workspace build, state that build distinction explicitly and provide a current
Development Host or package. Never present a workspace-build pass as proof that
an older installed build works.
