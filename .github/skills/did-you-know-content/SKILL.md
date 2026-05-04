---
name: did-you-know-content
description: "Create Kusto Workbench Did you know? tutorial content with compact E2E screenshots. Use when adding tips, tutorial catalog entries, media/tutorials content, screenshot assets, or marketplace-style feature tips."
---

# Did You Know Content

Use this skill when creating or refreshing Kusto Workbench "Did you know?" content in `media/tutorials/`.

## Goal

Produce one polished, accurate, compact tip that feels like a natural completion of the phrase "Did you know?". The Markdown and screenshot should teach the feature directly, with minimal ceremony.

## Required Repo Context

Read these before editing if you have not already loaded them in the current turn:

- `ARCHITECTURE.md`
- `CONTRIBUTING.md`
- `.github/skills/e2e-test-extension/SKILL.md` before creating or running screenshot E2E content

## Content Shape

Each tip normally has these deliverables:

- One catalog entry in `media/tutorials/catalog.v1.json`.
- One Markdown file in `media/tutorials/content/<id>.md`.
- One PNG screenshot in `media/tutorials/content/images/tip-<area>-<topic>.png`.
- A small `@screenshot-generator` E2E scenario when a fresh UI capture is needed.

Catalog entries use this schema:

```json
{
  "id": "chart-zoom",
  "categoryId": "charts",
  "contentUrl": "content/chart-zoom.md",
  "minExtensionVersion": "0.0.0",
  "updateToken": "chart-zoom-2026-05-04"
}
```

Rules:

- Use kebab-case IDs. Prefer category prefixes such as `chart-`, `results-`, `powerbi-`, `editor-`, `agent-`, `copilot-`, or `other-`.
- Keep `minExtensionVersion` at `0.0.0` unless the content must be hidden from older released versions.
- Set `updateToken` to `<id>-YYYY-MM-DD` for new or materially changed content.
- Update `generatedAt` in `catalog.v1.json` when editing the catalog.
- Add items near related content in the existing category group.

## Writing Rules

Markdown files have no frontmatter. The first `#` heading becomes the visible title.

Write the heading as a follow-up to "Did you know?" without repeating those words. Good examples:

- `# You can export dashboards as Power BI reports`
- `# Line, area, bar, and scatter charts support rectangle zoom`
- `# URL sections can turn CSV files into analyzable tables`

Body structure:

```markdown
# <title that completes "Did you know?">

One short paragraph that names the capability and when to use it.

![Specific alt text](images/tip-area-topic.png)

One short paragraph that gives the key action or payoff.
```

Style rules:

- Keep it sweet and compact: usually 2 short paragraphs plus one screenshot.
- Show the concrete interaction, not a broad feature tour.
- Use exact UI strings from source code when naming buttons, labels, or tooltips.
- Do not write a numbered tutorial unless the feature genuinely needs ordered steps.
- Do not include secrets, real tenant names, private cluster names, or customer data.
- Keep image alt text specific and user-facing.

## Screenshot Rules

Use E2E testing skills to create the screenshot whenever the feature is visual or interactive.

1. Create a focused screenshot scenario under `tests/vscode-extension-tester/e2e/<profile>/<test-id>/`.
2. Add `@screenshot-generator` at the top if the scenario is for asset capture rather than behavioral coverage.
3. Prefer the `default` profile and persisted fixtures when authentication is not essential.
4. Stabilize the Dev Host before capture:
   - `When I move the Dev Host to 0, 0`
   - `And I resize the Dev Host to <compact width> by <compact height>`
   - close sidebar, auxiliary bar, and panel
5. Frame the UI tightly enough that the tip reads at a glance. Common sizes: `900x700`, `950x720`, or `950x950` depending on the surface.
6. Mask or replace any real connection/database labels before saving a screenshot asset.
7. Capture the screenshot with `Then I take a screenshot "01-<topic>"`.
8. Read `report.md`, then open every generated PNG with `view_image` before trusting it.
9. Copy or crop the chosen PNG to `media/tutorials/content/images/tip-<area>-<topic>.png`; keep it under 3 MB.

When creating chart screenshots:

- Prefer a persisted `.kqlx` fixture with `resultJson` so the default profile can render the chart without live Kusto auth.
- Show the chart section itself, not the whole notebook.
- Use realistic but synthetic data.
- For chart zoom tips, show a supported chart type (`line`, `area`, `bar`, or `scatter`) and make the `Zoom` control visible. If helpful, click it before capture so the hint appears.

## Validation

Run these after editing tutorial content:

```bash
npm run validate:tutorials
npm run test:webview -- tests/webview/host/tutorialCatalog.test.ts tests/webview/host/tutorialCatalogService.test.ts tests/webview/tutorial-viewer.test.ts
```

If you added a screenshot-generator E2E scenario, run it too:

```bash
vscode-ext-test run --test-id <test-id>
```

Then inspect the generated `report.md` and screenshots with `view_image`.

## Checklist

- Catalog entry has a unique ID, valid category, local content URL, version, and update token.
- Markdown starts with exactly one useful top-level heading.
- Heading reads naturally after "Did you know?".
- Screenshot exists, loads from a relative `images/...png` path, and shows the actual UI state.
- Local validator passes.
- Focused tutorial/viewer tests pass or any failure is reported clearly.
