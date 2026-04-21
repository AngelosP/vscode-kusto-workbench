---
name: readme-screenshots
description: >
  Replace marketplace screenshots in the README with fresh captures.
  Use when the user says 'update screenshots', 'refresh README images',
  'retake marketplace screenshots', 'replace screenshots',
  'new screenshots for marketplace', or any request to update the visual
  assets in the README.
---

# readme-screenshots

Capture, crop, and replace the marketplace PNG screenshots referenced in
README.md. Uses the e2e testing framework for UI navigation and screenshots,
and PowerShell for cropping.

## When to Use

- "Update screenshots" / "refresh README images"
- "Retake marketplace screenshots" / "replace screenshots"
- "New screenshots for marketplace"
- Any request to update the visual assets in the README

## Prerequisites

1. **Authenticated named profiles.** The `kusto-auth` and `sql-auth` profiles
   must be prepared and authenticated. Verify with:
   ```bash
   vscode-ext-test profile open kusto-auth
   vscode-ext-test profile open sql-auth
   ```

2. **Window resize steps available.** The e2e framework must support:
   - `When I resize the Dev Host to <W> by <H>`
   - `When I resize the window to <W> by <H>` (alias)
   - `When I move the Dev Host to <X>, <Y>`
   - `When I move the Dev Host to <X> <Y>` (no-comma variant)

3. **Windows PowerShell (powershell.exe) available** for cropping via
   `System.Drawing`. Do NOT use `pwsh` (PowerShell Core) — it does not
   include `System.Drawing` by default.

4. **Windows display scaling set to 100%.** Higher DPI scaling (125%, 150%)
   causes the screenshot pixel dimensions to differ from the window
   dimensions, making crop coordinates unpredictable. Set display scaling
   to 100% before starting a capture run.

5. **Know the monitor layout.** Before writing feature files, detect the
   available monitors so you can position the Dev Host window on the right
   screen with the right dimensions. Run:
   ```powershell
   Add-Type -AssemblyName System.Windows.Forms
   [System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
       $b = $_.Bounds
       [PSCustomObject]@{
           Device      = $_.DeviceName
           Primary     = $_.Primary
           Width       = $b.Width
           Height      = $b.Height
           X           = $b.X
           Y           = $b.Y
           Orientation = if ($b.Width -ge $b.Height) { 'Landscape' } else { 'Portrait' }
       }
   } | Format-Table -AutoSize
   ```
   Use this to decide:
   - **Which monitor** to place the window on (`I move the Dev Host to X, Y`)
   - **Max window size** — don't exceed the monitor's resolution
   - **Portrait monitors** are ideal for tall screenshots (markdown, full
     query+results+chart combos) since they support heights up to 2560px
   - **Landscape monitors** are better for wide screenshots (settings,
     connection manager)
   - The primary monitor at (0, 0) is the safest default

6. **Consistent VS Code theme.** All screenshots must use the same theme.
   Ensure the profiles are configured with the target theme (Dark Modern
   or whichever theme the existing screenshots use). Set the theme
   explicitly if needed:
   ```gherkin
   When I execute command "workbench.action.selectTheme"
   ```

## Workflow

### Phase 1: Preparation

1. Read `screenshots.json` (co-located in this skill folder) for the full
   manifest of all screenshots — filenames, profiles, tiers, commands,
   window sizes, crop hints, and notes.

2. Verify profiles are authenticated. If tokens are expired, open the
   profile with `vscode-ext-test profile open <profile>`, sign in, close
   VS Code, and try again.

3. **Plan the batch order.** Group screenshots by profile to avoid repeated
   profile switching:
   - First: all `default` profile screenshots (no auth needed)
   - Then: all `kusto-auth` screenshots
   - Then: all `sql-auth` screenshots

4. Within each profile group, start with `easy` tier screenshots, then
   `medium`, then `hard`.

### Phase 2: Capture (per screenshot)

5. Create a test-id directory for the batch:
   ```
   tests/vscode-extension-tester/e2e/<profile>/readme-ss-<batch>/
   ```

6. Write a `.feature` file for each screenshot that:
   - Moves the window to a known position to anchor coordinates:
     `When I move the Dev Host to 0, 0`
   - Resizes the window to the size from the manifest:
     `When I resize the Dev Host to <width> by <height>`
   - Navigates to the required UI state (execute commands, type text,
     wait for elements, click buttons — whatever the manifest describes)
   - Takes a labeled screenshot:
     `Then I take a screenshot "<filename>"`

   Example:
   ```gherkin
   Feature: Capture activity-bar screenshot
     Scenario: Activity Bar with tooltip
       Given the extension is in a clean state
       When I move the Dev Host to 0, 0
       And I resize the Dev Host to 1280 by 800
       And I execute command "workbench.view.extension.kustoWorkbench"
       And I wait 2 seconds
       Then I take a screenshot "activity-bar"
   ```

7. Run the test:
   ```bash
   vscode-ext-test run --test-id readme-ss-<batch> --reuse-named-profile <profile>
   ```

8. **View the raw screenshot** with `view_image` to verify the UI state is
   correct. The raw screenshot is in:
   ```
   tests/vscode-extension-tester/runs/<profile>/readme-ss-<batch>/<label>.png
   ```

9. If the state is wrong, adjust the `.feature` file and re-run. Do NOT
   proceed to cropping until the raw screenshot looks correct.

### Phase 3: Crop

10. Determine crop coordinates by examining the raw screenshot. Note the
    region of interest (the manifest's `cropHints` field gives guidance).

11. Crop using **Windows PowerShell** (not pwsh):
    ```powershell
    Add-Type -AssemblyName System.Drawing
    $src = [System.Drawing.Image]::FromFile("C:\absolute\path\to\raw.png")
    $rect = [System.Drawing.Rectangle]::new($x, $y, $width, $height)
    $cropped = $src.Clone($rect, $src.PixelFormat)
    $cropped.Save("C:\absolute\path\to\media\marketplace\<filename>.png")
    $src.Dispose(); $cropped.Dispose()
    ```

    If running in `pwsh` and `System.Drawing` is not available, either:
    - Switch to `powershell.exe` for the crop command
    - Or install `System.Drawing.Common`: `Install-Package System.Drawing.Common`

12. **View the cropped image** with `view_image` to verify quality and
    framing. If the crop is off, adjust coordinates and re-crop.

### Phase 4: Back Up & Replace

13. **Before overwriting**, back up the original screenshot — but only if
    the backup does not already exist:
    ```powershell
    if (-not (Test-Path "media\marketplace\<filename>.old.png")) {
        Rename-Item "media\marketplace\<filename>.png" "<filename>.old.png"
    }
    ```
    The `.old.png` file preserves the **original file that was on disk
    when the replacement session started**. It must only be created once.
    If `.old.png` already exists, skip the rename — otherwise you would
    replace the original with one of your own intermediate attempts.
    On subsequent crop adjustments, only `<filename>.png` changes;
    `.old.png` always points back to the pre-session original so you can
    compare against it or revert cleanly.

    The `take-screenshot.ps1` script follows this rule: it only renames
    the current `.png` to `.old.png` when no `.old.png` exists yet.

14. Write the cropped image to `media/marketplace/<filename>.png` (the crop
    step in Phase 3 can write directly to this path, or copy here now).

15. For screenshots that need no cropping (full window captures), copy
    the raw screenshot directly:
    ```powershell
    Copy-Item "path\to\raw.png" "media\marketplace\<filename>.png" -Force
    ```

16. **View the new image** with `view_image` to verify it looks correct.

### Phase 5: Cleanup & Verify

17. After all screenshots in a batch are done, verify every image looks
    correct by viewing each one with `view_image`.

18. The `tests/vscode-extension-tester/runs/` directory is gitignored.
    Feature files in `e2e/` can be deleted after the batch — they are
    disposable and not meant to be committed.

19. Check that all 20 active README image references point to files that
    exist in `media/marketplace/`.

20. The `.old.png` backup files remain in `media/marketplace/` for manual
    comparison. Once you are satisfied with the new screenshots, delete
    them:
    ```powershell
    Remove-Item "media\marketplace\*.old.png"
    ```
    Do NOT commit `.old.png` files — they are temporary backups.

## Screenshot Manifest

The `screenshots.json` file in this folder defines every screenshot. Fields:

| Field | Type | Description |
|-------|------|-------------|
| `filename` | string | Target PNG basename in `media/marketplace/` |
| `profile` | string | Named profile: `default`, `kusto-auth`, or `sql-auth` |
| `tier` | string | `easy`, `medium`, or `hard` (hard = manual assist needed) |
| `description` | string | What the screenshot should show |
| `readmeLine` | number | Approximate line in README.md (informational — may drift after edits) |
| `altText` | string | Alt text from the README image reference (stable identifier) |
| `commands` | string[] | VS Code commands to reach the UI state |
| `windowSize` | object | `{ "width": N, "height": N }` for the Dev Host |
| `cropHints` | string | Description of what region to crop (exact pixels determined at runtime) |
| `notes` | string | Gotchas, timing requirements, special setup |
| `todo` | boolean | If `true`, the screenshot is planned but not yet rendered in README |

Use `altText` (not `readmeLine`) as the stable identifier when matching
screenshots to README references.

## Gotchas & Lessons Learned

1. **Crop coordinates are resolution-dependent.** The raw screenshot captures
   the entire desktop area. Crop coordinates depend on window position and
   DPI scaling. Always use `When I move the Dev Host to 0, 0` before
   screenshots to anchor the window position to the top-left corner.

2. **Wait times matter.** UI elements like autocomplete dropdowns, query
   results tables, and chart renders need explicit waits. Use
   `I wait N seconds` generously — under-waiting produces incomplete
   screenshots. Prefer `I wait for "<selector>" in the webview` over
   blind waits when possible.

3. **Theme consistency.** All screenshots must use the same VS Code theme.
   Before starting a capture run, verify the theme is correct in the
   profile. Do not mix light and dark themes across screenshots.

4. **Tooltip screenshots are timing-sensitive.** Screenshots showing
   tooltips (e.g., `prettify`, `share`, `add-to-favorites`) require
   hovering an element and capturing before the tooltip fades. Use the
   Windows UI Automation click step to hover, then immediately take the
   screenshot. May need multiple attempts.

5. **Hard-tier screenshots need special handling:**
   - `vscode-custom-agent`: Needs a live Copilot model conversation.
     Open the profile manually, type an @mention, then use
     `--attach-devhost` mode to screenshot.
   - `multi-account`: Needs the Cached Values viewer with multiple
     authenticated accounts. Pre-populate in the profile.
   - `python-sections`: Needs Python installed with pandas/numpy.
     Run the code manually first, then screenshot.
   - `html-dashboard`: Needs a pre-built HTML section in a `.kqlx`
     file. Create the file, open it, then screenshot.

6. **Batch by profile.** Run all `default` screenshots together, then
   `kusto-auth`, then `sql-auth`. This avoids repeated profile switching
   overhead and keeps auth tokens fresh within a batch.

7. **DPI / display scaling.** Windows display scaling (125%, 150%, 200%)
   causes pixel dimensions to differ from logical dimensions. At 150%
   DPI, a 1280x800 window produces a ~1920x1200 screenshot. Set display
   scaling to 100% before capturing, or adjust crop coordinates to match
   the actual pixel dimensions reported by `view_image`.

8. **Feature files are disposable.** Create unique test-ids per screenshot
   batch (e.g., `readme-ss-20260420`). Don't reuse old test-ids. The
   `runs/` directory is gitignored but accumulates stale data.

9. **Window resize step syntax:**
   - `When I resize the Dev Host to 1280 by 800` — resize window
   - `When I resize the window to 1280 by 800` — alias, works the same
   - `When I move the Dev Host to 0, 0` — move window (supports negative coords)
   - `When I move the Dev Host to 0 0` — no-comma variant also works

10. **Verify the screenshot before cropping.** Always `view_image` the raw
    screenshot first. If the UI state is wrong (wrong panel open, results
    not loaded, wrong theme), fix the feature file and re-run. Do not
    waste time cropping a bad screenshot.

11. **PowerShell version matters.** Use `powershell.exe` (Windows
    PowerShell 5.1) for the `System.Drawing` crop commands. PowerShell
    Core (`pwsh`) does not include `System.Drawing` by default and will
    throw unless `System.Drawing.Common` is installed.

12. **README image path variants.** Some README references use
    `./media/marketplace/` while others use `media/marketplace/`. Both
    resolve to the same file. The `filename` field in the manifest is
    just the basename (e.g., `kusto-query-editor.png`). The replacement
    phase always targets `media/marketplace/<filename>`.

13. **Use `default` profile to avoid leaking secrets.** Screenshots that
    show connection dropdowns, cluster names, or database names MUST use
    the `default` profile (no auth, no saved connections). Real cluster
    URLs and database names are secrets — never include them in
    marketplace screenshots. Only use `kusto-auth` or `sql-auth` when the
    screenshot genuinely requires authenticated data (e.g., query results).

14. **Opening dropdowns: use `__testOpenDropdown`.** The webview exposes
    `window.__testOpenDropdown(testId)` which finds a `kw-dropdown` by
    `data-testid`, calls `_openMenu()`, and neutralizes all dismiss
    handlers so the menu stays open for screenshots. Without this, the
    dropdown closes before the screenshot is taken. Example:
    ```gherkin
    When I evaluate "__testOpenDropdown('cluster-dropdown')" in the webview
    ```

15. **Highlighting a specific dropdown item.** After opening a dropdown
    with `__testOpenDropdown`, set `_focusedIndex` to highlight a specific
    entry (0-indexed). Call `requestUpdate()` to re-render:
    ```gherkin
    When I evaluate "const dd = __testFind('cluster-dropdown'); dd._focusedIndex = 1; dd.requestUpdate(); 'done'" in the webview
    ```

16. **Clear placeholder text and save before screenshots.** A fresh editor
    shows ghost placeholder text ("Enter your KQL query here...") and has
    a green unsaved-changes border. To get a clean grey border with no
    placeholder, type a space then save:
    ```gherkin
    And I type " "
    And I press "Ctrl+S"
    And I wait 2 seconds
    ```

17. **Always focus the active editor group.** After `kusto.openQueryEditor`,
    run `workbench.action.focusActiveEditorGroup` before any `I evaluate`
    steps. Without this, the evaluate may run in the wrong webview
    (e.g., Copilot Chat panel instead of the custom editor):
    ```gherkin
    And I execute command "workbench.action.focusActiveEditorGroup"
    And I wait 2 seconds
    ```

18. **Crop must include section borders.** When cropping to a section area,
    ensure the crop region starts a few pixels above and to the left of
    the section content to include both the top border line and the left
    border (with the `:` drag handle). Missing borders look unfinished.

19. **Available `data-testid` values for dropdowns:**
    - `cluster-dropdown` — the Kusto cluster picker in query sections
    - More will be added as needed; check `kw-query-section.ts` and
      `kw-sql-section.ts` for current values.

## Tips

- Run one screenshot at a time to iterate quickly on the feature file
  and crop region. Batch mode is for the final pass.
- Group "easy" tier screenshots first to build momentum and validate
  the workflow before tackling medium and hard ones.
- Keep the `screenshots.json` manifest updated if window dimensions,
  commands, or crop regions change between runs.
- After all screenshots are replaced, open the README in VS Code's
  Markdown preview to do a visual scan — confirm all images render
  correctly and look good together.
- For hard-tier screenshots, consider using `--attach-devhost` mode:
  prepare the UI state manually, then let the agent attach and take
  the screenshot + crop.

## Reusable Screenshot Scripts

Each screenshot has a permanent `.feature` file in this skill's `features/`
directory plus exact `crop` coordinates in `screenshots.json`. A runner
script automates the full capture-and-crop pipeline.

### Directory structure

```
.github/skills/readme-screenshots/
  SKILL.md                           # this file
  screenshots.json                   # manifest with crop coordinates
  take-screenshot.ps1                # runner script
  features/
    import-connections.feature        # proven, committed feature files
    ...                               # one per screenshot
```

### Running a screenshot

```powershell
# From the repo root:
.\.github\skills\readme-screenshots\take-screenshot.ps1 import-connections

# Skip the compile step (if already built):
.\.github\skills\readme-screenshots\take-screenshot.ps1 import-connections -NoBuild

# Re-crop from the last raw capture (no e2e run):
.\.github\skills\readme-screenshots\take-screenshot.ps1 import-connections -CropOnly
```

The script:
1. Reads `screenshots.json` for the profile and crop coordinates
2. Copies the `.feature` file from `features/` into the e2e directory
3. Runs `vscode-ext-test run` with the correct profile
4. Backs up the existing PNG as `<name>.old.png`
5. Crops and saves the new PNG to `media/marketplace/`

### Adding a new screenshot script

1. Create `features/<name>.feature` with the proven Gherkin steps
2. Add exact `"crop": { "x": N, "y": N, "width": N, "height": N }` to
   the entry in `screenshots.json`
3. Test: `.\.github\skills\readme-screenshots\take-screenshot.ps1 <name>`
4. Verify with `view_image`, adjust crop coordinates, re-run with `-CropOnly`
