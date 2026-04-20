# Kusto Workbench Viewer — Browser Extension

A Chromium browser extension (Chrome / Edge) that renders `.kqlx`, `.sqlx`, `.kql`, and `.csl` Kusto notebook files inline on **GitHub**, **Azure DevOps**, and **raw file URLs**.

## What's Included

| Component | Description |
| --- | --- |
| `manifest.json` | Manifest V3 extension manifest |
| `background.js` | Service worker for opening standalone viewer tabs |
| `viewer.html` | Sandboxed viewer page (embedded in-page) |
| `viewer-standalone.html` | Standalone viewer page (opened in a new tab) |
| `viewer-boot.js` / `viewer-standalone-boot.js` | Bootstrap scripts for the viewer |
| `queryEditor-loader.js` | Loads the query editor UI assets |
| `src/content-script.ts` | Content script injected into supported pages |
| `src/providers/` | Site-specific integrations (GitHub, Azure DevOps, raw URLs) |
| `esbuild.js` | Build script that bundles everything into `dist/` |

## Prerequisites

- **Node.js** (v18+)
- The **root project** must be built first — the browser extension depends on shared assets (Monaco editor, ECharts, Toast UI, media files) produced by the root build.

## Build Steps

### 1. Build the root project

From the **repository root** (`vscode-kusto-workbench/`):

```bash
npm ci
npm run package
```

This produces the `dist/` folder at the repo root with Monaco, ECharts, Toast UI, and other vendor assets that the browser extension needs.

### 2. Install browser extension dependencies

From the `browser-ext/` folder:

```bash
cd browser-ext
npm install
```

### 3. Build the browser extension

```bash
npm run build
```

This runs `node esbuild.js --production` which:

1. Bundles `src/content-script.ts` → `dist/content-script.js`
2. Copies static files (viewer HTML, boot scripts, manifest, background worker)
3. Copies shared media assets from `media/` (CSS, images, query editor JS)
4. Copies built vendor assets from the root `dist/` (Monaco, ECharts, Toast UI)
5. Replaces `vscode.js` with the browser shim

The complete, loadable extension is output to `browser-ext/dist/`.

> **Tip:** During development you can use `npm run dev` (unminified) or `npm run watch` (watch mode for the content script).

## Loading Unpacked (for testing)

1. Open `chrome://extensions` (Chrome) or `edge://extensions` (Edge)
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `browser-ext/dist/` folder

## Creating the .zip for Submission

Once you've confirmed the extension works by loading it unpacked:

### On Windows (PowerShell)

```powershell
cd browser-ext\dist
Compress-Archive -Path .\* -DestinationPath ..\kusto-workbench-viewer.zip -Force
```

### On macOS / Linux

```bash
cd browser-ext/dist
zip -r ../kusto-workbench-viewer.zip .
```

This produces `browser-ext/kusto-workbench-viewer.zip` — the file you upload to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) or the [Microsoft Edge Add-ons Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/overview).

## Submission Checklist

- [ ] Root project built (`npm run package` at repo root)
- [ ] Browser extension built with `npm run build` (production mode)
- [ ] Extension tested locally via "Load unpacked"
- [ ] `.zip` created from the contents of `browser-ext/dist/`
- [ ] `.zip` uploaded to the store developer dashboard
- [ ] Version in `manifest.json` updated if this is an update to an existing listing

## Available Scripts

| Script | Description |
| --- | --- |
| `npm run build` | Production build (minified, no source maps) |
| `npm run dev` | Development build (unminified, with source maps) |
| `npm run watch` | Watch mode — rebuilds content script on changes |
| `npm run clean` | Deletes `dist/` |
