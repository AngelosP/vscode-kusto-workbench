---
name: health-summary
description: "Run all quality metrics and produce a unified health summary of the extension: bundle sizes, test counts, coverage, TypeScript errors, lint status, and source line counts. Use when the user says 'health check', 'health summary', 'status report', 'how's the project', 'bundle size', 'quality check', 'project stats', or any request for an overview of the extension's current quality metrics."
---

# Health Summary

This skill collects every quality metric for the extension, presents a consolidated report, persists results to a rolling history file, and renders trend graphs. Use it as a recurring checkpoint to spot regressions early.

## When to Use

- "Health check" / "health summary" / "status report"
- "How's the project doing?"
- "Give me the current stats"
- "Bundle size?" / "Coverage?" / "Test count?"
- Any request for a quality overview

---

## History File

All execution history is stored in `.github/skills/health-summary/history.json`. The file has this schema:

```jsonc
{
  // Rolling last 10 executions (any commit, even repeated)
  "recent": [ /* HealthEntry[] — newest first, max 10 */ ],
  // Rolling last 10 unique commits — the LAST execution per commit before moving on
  "commits": [ /* HealthEntry[] — newest first, max 10 */ ]
}
```

Each `HealthEntry`:

```jsonc
{
  "ts":              "2026-03-22T18:30:00Z",  // ISO timestamp
  "commit":          "0c93651",               // short hash from git log -1
  "commitMsg":       "Cleaned up orphaned script", // subject line
  "tests":           2150,                    // total test count
  "testFiles":       61,                      // test file count
  "stmtCov":         28.07,                   // statement coverage %
  "lineCov":         29.68,                   // line coverage %
  "branchCov":       24.79,                   // branch coverage %
  "fnCov":           29.01,                   // function coverage %
  "distTotalKB":     31790.7,                 // total dist/ size in KB
  "extensionKB":     926.4,                   // extension.js
  "webviewKB":       1220.7,                  // webview.bundle.js
  "echartsKB":       585.2,                   // echarts.webview.js
  "toastuiKB":       602.5,                   // toastui-editor.webview.js
  "monacoKB":        10944.4,                 // monaco/
  "hostLines":       16846,                   // src/host TS lines
  "webviewLines":    45527,                   // src/webview TS lines
  "testLines":       20241,                   // tests/ TS lines
  "tscOk":           true,                    // TypeScript clean?
  "lintErrors":      0,
  "lintWarnings":    8
}
```

---

## Workflow

Run each step sequentially. Collect all data before presenting the report. Use terminal commands — do **not** rely on stale cached files.

### Step 1: Version & Git State

```powershell
cd c:\Users\angelpe\source\my-tools\vscode-kusto-workbench
$ver = (Get-Content package.json | ConvertFrom-Json).version; Write-Host "Version: $ver"
git log -1 --format="Commit: %h  %s  (%ai)"
git status --porcelain | Measure-Object | ForEach-Object { Write-Host "Uncommitted files: $($_.Count)" }
```

Capture both the **short hash** and the **subject line** from git log — you'll need them for the history entry.

### Step 2: TypeScript Compilation

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 3
```

Report pass/fail and error count if any. Record `tscOk` = true/false.

### Step 3: Lint

```powershell
npm run lint 2>&1 | Select-Object -Last 5
```

Report pass/fail. Parse the "N problems (E errors, W warnings)" line to fill `lintErrors` and `lintWarnings`.

### Step 4: Unit Tests

```powershell
npx vitest run 2>&1 | Select-String "Test Files|Tests "
```

Extract test file count and test count. Record `tests` and `testFiles`.

### Step 5: Coverage

```powershell
npx vitest run --coverage 2>&1 | Select-String "Statements|Lines|Functions|Branches|All files"
```

If the text output doesn't capture all four metrics, fall back to reading the JSON:

```powershell
$json = Get-Content coverage/coverage-summary.json | ConvertFrom-Json
$t = $json.total
Write-Host "Statements: $($t.statements.pct)%"
Write-Host "Branches: $($t.branches.pct)%"
Write-Host "Functions: $($t.functions.pct)%"
Write-Host "Lines: $($t.lines.pct)%"
```

Also report the **coverage gate baseline**:

```powershell
Select-String -Path scripts/coverage-gate.mjs -Pattern "BASELINE_STATEMENTS" | Select-Object -First 1
```

Record `stmtCov`, `lineCov`, `branchCov`, `fnCov`.

### Step 6: Bundle Sizes (requires production build)

```powershell
node esbuild.js --production 2>&1 | Select-Object -Last 5
npm run bundle-size 2>&1
```

Parse each bundle size from the output. Record `extensionKB`, `webviewKB`, `echartsKB`, `toastuiKB`, `monacoKB`, and `distTotalKB`.

### Step 7: Source Size

```powershell
$hostLines = (Get-ChildItem src/host -Recurse -Filter *.ts | Get-Content | Measure-Object -Line).Lines
$webviewLines = (Get-ChildItem src/webview -Recurse -Filter *.ts | Get-Content | Measure-Object -Line).Lines
$testLines = (Get-ChildItem tests -Recurse -Filter *.ts | Get-Content | Measure-Object -Line).Lines
Write-Host "Host source: $hostLines lines"
Write-Host "Webview source: $webviewLines lines"
Write-Host "Tests: $testLines lines"
Write-Host "Total: $($hostLines + $webviewLines + $testLines) lines"
```

Record `hostLines`, `webviewLines`, `testLines`.

### Step 8: VSIX Size (optional — skip if user wants a quick check)

```powershell
npm run vsix 2>&1 | Select-Object -Last 3
Get-ChildItem *.vsix | ForEach-Object { Write-Host "$($_.Name): $([math]::Round($_.Length / 1MB, 2)) MB" }
```

---

## Step 9: Persist History

After all metrics are collected, update `.github/skills/health-summary/history.json`.

### 9a — Read existing history

Read the file. If it doesn't exist or is empty, start with `{ "recent": [], "commits": [] }`.

### 9b — Build the new entry

Construct a `HealthEntry` JSON object from all the values collected in Steps 1-8.

### 9c — Update `recent` (rolling last 10 executions)

1. Prepend the new entry to `recent`.
2. Trim to 10 entries (drop the oldest).

### 9d — Update `commits` (rolling last 10 unique commits)

1. If `commits[0].commit` equals the new entry's `commit` → **replace** `commits[0]` with the new entry (same commit, fresher run).
2. Otherwise → **prepend** the new entry to `commits`.
3. Trim to 10 entries (drop the oldest).

### 9e — Write the file

Write the updated JSON back to `.github/skills/health-summary/history.json` using the `create_file` tool (if new) or `replace_string_in_file` / terminal `Set-Content` for updates. Use **2-space indented JSON** for readability.

---

## Step 10: Report

Present results in a single table, followed by the trend section.

### Current Run Table

```
## Extension Health Summary — <date>

| Metric                    | Value              | Status |
|---------------------------|--------------------|--------|
| Version                   | x.y.z              |        |
| Git commit                | abc1234            |        |
| Uncommitted files         | 0                  | ✅ / ⚠️ |
| TypeScript compilation    | 0 errors           | ✅ / ❌ |
| Lint                      | 0 errors, 0 warns  | ✅ / ❌ |
| Test files                | N                  |        |
| Tests                     | N passed           | ✅ / ❌ |
| Statement coverage        | xx.xx%             | ✅ / ❌ |
| Coverage gate baseline    | xx.xx%             |        |
| extension.js              | xxx KB             | ✅ / ❌ |
| webview.bundle.js         | xxx KB             | ✅ / ❌ |
| echarts.webview.js        | xxx KB             | ✅ / ❌ |
| toastui-editor.webview.js | xxx KB             | ✅ / ❌ |
| monaco/                   | xxx KB             | ✅ / ❌ |
| Bundle gate buffer        | 50 KB              |        |
| Host source               | N lines            |        |
| Webview source            | N lines            |        |
| Test source               | N lines            |        |
| VSIX size (if built)      | x.xx MB            |        |
```

### Status Legend

- ✅ = within limits / passing
- ❌ = failed gate or regression
- ⚠️ = not blocking but worth noting (e.g. uncommitted files)

---

## Step 11: Trend Tables & Graphs

After the main report, render two trend sections using data from history.json.

### 11a — Recent Runs (last 10 executions)

Show a compact table from the `recent` array (newest first):

```
### Recent Runs (last 10 executions)

| # | Time       | Commit  | Tests | Stmt Cov | Line Cov | Dist KB    | TSC | Lint     |
|---|------------|---------|-------|----------|----------|------------|-----|----------|
| 1 | 18:30 today| 0c93651 | 2150  | 28.07%   | 29.68%   | 31,790 KB  | ✅  | 0E 8W    |
| 2 | 17:15 today| 0c93651 | 2148  | 28.05%   | 29.65%   | 31,788 KB  | ✅  | 0E 8W    |
| ...
```

### 11b — Commit History (last 10 unique commits)

Show a compact table from the `commits` array (newest first):

```
### Commit History (last 10 unique commits)

| # | Date       | Commit  | Message (truncated)       | Tests | Stmt Cov | Line Cov | Dist KB   |
|---|------------|---------|---------------------------|-------|----------|----------|-----------|
| 1 | 2026-03-22 | 0c93651 | Cleaned up orphaned sc... | 2150  | 28.07%   | 29.68%   | 31,790 KB |
| 2 | 2026-03-21 | a1b2c3d | Extract queryBoxes-con... | 2097  | 28.05%   | 29.60%   | 31,750 KB |
| ...
```

### 11c — Trend Charts (Horizontal Bar Charts)

Render two **horizontal bar chart tables** using the **`commits`** array (oldest at top, newest at bottom — chronological reading order).

#### Computation Rules

For each chart, the bar length is computed as a **proportion of a fixed max width of 20 characters** using the `█` (full block) character:

1. Y-axis starts at **0**. The scale max = `max(dataValues) * 1.1` (10% headroom).
2. For each data point: `barLength = round(value / scaleMax * 20)`. Minimum 1 char if value > 0.
3. Display the exact numeric value after the bar.

#### Total dist/ (KB) — Commit Trend

Render a table like this (values from `commits` array, field `distTotalKB`):

```
### Total dist/ — Commit Trend (0 → <scaleMax> KB)

| Commit  | Bar                  | KB       |
|---------|----------------------|----------|
| 0c93651 | ██████████████████   | 31,791   |
| eca5eba | ██████████████████   | 31,792   |
| f3a40f8 | ██████████████████   | 31,792   |
```

#### Line Coverage (%) — Commit Trend

Render a table like this (values from `commits` array, field `lineCov`):

```
### Line Coverage — Commit Trend (0 → <scaleMax>%)

| Commit  | Bar                  | %      |
|---------|----------------------|--------|
| 0c93651 | █████████            | 29.68  |
| eca5eba | █████████            | 29.72  |
| f3a40f8 | █████████            | 29.69  |
```

#### Sparkline Summary

After the bar charts, render a one-line **sparkline** for each metric using the 8 Unicode block characters `▁▂▃▄▅▆▇█`, mapped to the data range:

```
Total dist/ sparkline: ▇▇▇  (0c93651 → f3a40f8)
Line coverage sparkline: ▇█▇  (0c93651 → f3a40f8)
```

**Sparkline rules:**
- Map each value to one of the 8 block chars: `charIndex = round((value - min) / (max - min) * 7)`. If all values are equal, use `▅` for all.
- List commit hashes below as axis labels.

#### Edge Cases
- If there are fewer than 2 data points in `commits`, show "Not enough history for trend charts yet — run the health check after your next commit." instead of charts.

---

## Tips

- For a **quick check** (no production build), skip Steps 6 and 8, record `null` for bundle fields, and note that bundle sizes were not measured. The history entry will still be saved with the available data.
- Compare successive runs by checking the Recent Runs table — same-commit changes show the impact of your edits in real time.
- The Commit History table shows the "steady state" after you were happy with each commit — the trend you want to see going up-and-to-the-right.
- If bundle sizes grew, update the baselines in `scripts/bundle-size-gate.mjs` only after confirming the growth is intentional.
- If coverage dropped, check which files lost coverage with `npx vitest run --coverage` and review the text output.
- The history file is gitignored-safe to commit — it's useful project metadata. But feel free to add it to `.gitignore` if you prefer not to track it.
