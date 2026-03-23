---
name: health-summary
description: "Run all quality metrics and produce a unified health summary of the extension: bundle sizes, test counts, coverage, TypeScript errors, lint status, and source line counts. Use when the user says 'health check', 'health summary', 'status report', 'how's the project', 'bundle size', 'quality check', 'project stats', or any request for an overview of the extension's current quality metrics."
---

# Health Summary

This skill collects every quality metric for the extension and presents a single consolidated report. Use it as a recurring checkpoint to spot regressions early.

## When to Use

- "Health check" / "health summary" / "status report"
- "How's the project doing?"
- "Give me the current stats"
- "Bundle size?" / "Coverage?" / "Test count?"
- Any request for a quality overview

## Workflow

Run each step sequentially. Collect all data before presenting the report. Use terminal commands — do **not** rely on stale cached files.

### Step 1: Version & Git State

```powershell
cd c:\Users\angelpe\source\my-tools\vscode-kusto-workbench
$ver = (Get-Content package.json | ConvertFrom-Json).version; Write-Host "Version: $ver"
git log -1 --format="Commit: %h  %s  (%ai)"
git status --porcelain | Measure-Object | ForEach-Object { Write-Host "Uncommitted files: $($_.Count)" }
```

### Step 2: TypeScript Compilation

```powershell
npx tsc --noEmit 2>&1 | Select-Object -Last 3
```

Report pass/fail and error count if any.

### Step 3: Lint

```powershell
npm run lint 2>&1 | Select-Object -Last 5
```

Report pass/fail and warning/error count if any.

### Step 4: Unit Tests

```powershell
npx vitest run 2>&1 | Select-String "Test Files|Tests "
```

Extract test file count, test count, pass/fail.

### Step 5: Coverage

```powershell
npx vitest run --coverage 2>&1 | Select-String "Statements|Lines|Functions|Branches|All files"
```

Extract the overall statement/line/function/branch percentages.

Also report the **coverage gate baseline** from `scripts/coverage-gate.mjs`:

```powershell
Select-String -Path scripts/coverage-gate.mjs -Pattern "BASELINE_STATEMENTS" | Select-Object -First 1
```

### Step 6: Bundle Sizes (requires production build)

Build production and then run the bundle size report:

```powershell
node esbuild.js --production 2>&1 | Select-Object -Last 5
npm run bundle-size 2>&1
```

Also report the **bundle size gate baselines** by scanning the gate script:

```powershell
Select-String -Path scripts/bundle-size-gate.mjs -Pattern "^\s+'" | ForEach-Object { $_.Line.Trim() }
```

### Step 7: Source Size

Count lines in key source directories:

```powershell
$hostLines = (Get-ChildItem src/host -Recurse -Filter *.ts | Get-Content | Measure-Object -Line).Lines
$webviewLines = (Get-ChildItem src/webview -Recurse -Filter *.ts | Get-Content | Measure-Object -Line).Lines
$testLines = (Get-ChildItem tests -Recurse -Filter *.ts | Get-Content | Measure-Object -Line).Lines
Write-Host "Host source: $hostLines lines"
Write-Host "Webview source: $webviewLines lines"
Write-Host "Tests: $testLines lines"
Write-Host "Total: $($hostLines + $webviewLines + $testLines) lines"
```

### Step 8: VSIX Size (optional — skip if user wants a quick check)

```powershell
npm run vsix 2>&1 | Select-Object -Last 3
Get-ChildItem *.vsix | ForEach-Object { Write-Host "$($_.Name): $([math]::Round($_.Length / 1MB, 2)) MB" }
```

## Report Format

Present results in a single table, followed by notes on any failures:

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

**Notes:**
- <any failures, warnings, or notable changes>
```

### Status Legend

- ✅ = within limits / passing
- ❌ = failed gate or regression
- ⚠️ = not blocking but worth noting (e.g. uncommitted files)

## Tips

- For a **quick check** (no production build), skip Steps 6 and 8 and note that bundle sizes were not measured.
- Compare successive runs by checking this report against `coverage/coverage-summary.json` and the baselines in `scripts/bundle-size-gate.mjs` / `scripts/coverage-gate.mjs`.
- If bundle sizes grew, update the baselines in `scripts/bundle-size-gate.mjs` only after confirming the growth is intentional.
- If coverage dropped, check which files lost coverage with `npx vitest run --coverage` and review the text output.
