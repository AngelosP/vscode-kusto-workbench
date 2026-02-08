# Kusto Workbench Viewer

Read-only web viewer for `.kqlx` and `.kql` files hosted on GitHub. Users paste a GitHub file URL and the viewer renders the notebook — results tables, charts, markdown — all interactive (sorting, filtering, chart tweaking) but without the ability to run queries or modify the file.

## How it works

The web app reuses the **exact same webview code** from the VS Code extension (`media/` folder) without copying or modifying it. A thin shim replaces the single VS Code API dependency, and a boot script acts as a "micro extension host" that fetches the file from GitHub and posts the same message sequence the real extension would.

```
Browser                          Express Server                    GitHub
  │                                    │                              │
  │  GET /view?url=github.com/...      │                              │
  │───────────────────────────────────>│                              │
  │  viewer.html + shared media/ JS    │                              │
  │<───────────────────────────────────│                              │
  │                                    │                              │
  │  GET /api/fetch-file?url=...       │  GET api.github.com/...      │
  │───────────────────────────────────>│─────────────────────────────>│
  │  .kqlx file content               │  file content                │
  │<───────────────────────────────────│<─────────────────────────────│
  │                                    │
  │  viewer-boot.js parses .kqlx       │
  │  and posts simulated extension     │
  │  host messages to the webview      │
  │  ➜ applyKqlxState() renders UI     │
```

## Supported file types

| URL pattern | Behavior |
|---|---|
| `?url=...file.kqlx` | Fetch and render the Kusto notebook |
| `?url=...file.kql` | Fetch the query, check for a `.kql.json` sidecar in the same directory. If found, render the full notebook; otherwise render as a single query section |
| `?url=...file.csl` | Same as `.kql` (with `.csl.json` sidecar) |
| `?url=...file.kql.json` | Fetch the sidecar, resolve the linked `.kql` file, render the full notebook |

## Architecture

| File | Purpose |
|---|---|
| `server.ts` | Express server — GitHub OAuth, file proxy, static serving |
| `vscode-shim.js` | Replaces `acquireVsCodeApi()` with a no-op stub + browser CSV download |
| `viewer-boot.js` | Fetches files from GitHub, parses `.kqlx`, posts simulated extension messages |
| `viewer.html` | Viewer page — same HTML structure as the extension's `queryEditor.html` |
| `index.html` | Landing page — paste a GitHub URL, sign in/out |
| `read-only-overrides.css` | `--vscode-*` theme fallbacks (light + dark) + hides interactive UI |
| `esbuild-web.js` | Build script — bundles `server.ts`, copies static assets |

### Key design decisions

- **No code copied from `media/`** — the Express server serves `media/` and `dist/` directly from the extension root. The only intercepted file is `media/queryEditor/vscode.js`, which is served as `vscode-shim.js` instead.
- **Extension is unaware of the web app** — no changes to any extension source file. Build isolation is enforced via `tsconfig.json` (`include: ["src"]`), `.vscodeignore` (`web/**`), and ESLint ignores.
- **Message protocol parity** — `viewer-boot.js` posts the same `persistenceMode`, `connectionsData`, `copilotAvailability`, and `documentData` messages that `kqlxEditorProvider.ts` would. The webview code runs identically.

## GitHub OAuth

For public repos, files are fetched without authentication. For private repos, users sign in via GitHub OAuth:

1. User clicks "Sign in with GitHub"
2. Browser redirects to GitHub's authorization page (scope: `repo`)
3. GitHub redirects back to `/auth/github/callback` with an authorization code
4. Server exchanges the code for an access token and stores it in an encrypted session cookie
5. Subsequent `/api/fetch-file` requests use the token to access the GitHub API

### Required environment variables

| Variable | Description |
|---|---|
| `GITHUB_OAUTH_CLIENT_ID` | Client ID from a [GitHub OAuth App](https://github.com/settings/developers) |
| `GITHUB_OAUTH_CLIENT_SECRET` | Client secret from the same OAuth App |
| `SESSION_SECRET` | Random string for signing session cookies |
| `PORT` | Server port (default: `3000`) |

## Local development

### First-time setup

```bash
# From the repo root — install extension deps and build shared assets (Monaco, ECharts, TOAST UI)
npm ci
npm run package

# From web/ — install web-specific deps
cd web
npm install
```

### Inner loop

The web app serves `media/` and `dist/` directly from the extension root at runtime, so changes to the extension's webview code are picked up immediately on browser refresh — no rebuild needed.

| What you changed | What to do |
|---|---|
| **Webview JS** (`media/queryEditor/*.js`) | Just refresh the browser |
| **Webview CSS** (`media/queryEditor.css`) | Just refresh the browser |
| **Web-specific files** (`web/*.js`, `web/*.css`, `web/*.html`) | Just refresh the browser (served directly, not from `dist/`) |
| **`web/server.ts`** | Stop the server → `npm run dev` (rebuilds + restarts) |
| **Extension assets** (Monaco, ECharts, TOAST UI) | Run `npm run package` from the repo root, then refresh |

### Starting the server

```bash
cd web
npm run dev
# → http://localhost:3000
```

This runs `esbuild-web.js` to bundle `server.ts`, then starts the server. The server serves static files from the source tree (`media/`, `dist/`, `web/`), not from `web/dist/`, so you get live changes on refresh.

### Testing

To test with a public `.kqlx` file, no OAuth setup is needed:
```
http://localhost:3000/view?url=https://github.com/owner/repo/blob/main/file.kqlx
```

To test with a private repo, [create a GitHub OAuth App](https://github.com/settings/developers) with callback URL `http://localhost:3000/auth/github/callback`, then create a `web/.env` file with your credentials:
```env
GITHUB_OAUTH_CLIENT_ID="your_client_id"
GITHUB_OAUTH_CLIENT_SECRET="your_client_secret"
```

The `dev` script loads this file automatically via Node's `--env-file` flag. Then just run:
```bash
cd web && npm run dev
```

> **Note**: The `.env` file is git-ignored. Never commit secrets to the repo.

### Tips

- The extension's `npm run watch` task (esbuild + tsc in watch mode) rebuilds `dist/extension.js` and shared assets on change. If you're working on both the extension and the web viewer simultaneously, keep that running — the web server picks up the rebuilt `dist/` assets on refresh.
- Browser DevTools → Network → "Disable cache" is useful during development so refreshes always pick up the latest files.

## Build

```bash
cd web
npm run build        # → web/dist/
```

The build bundles `server.ts` and all Express dependencies into a single `dist/server.js` file, plus copies the static HTML/CSS/JS assets.

## Deployment

Deployed to Azure App Service via the `deploy-web` job in the CI/CD pipeline (`.github/workflows/build.yml`). Deployment is triggered on version tag push (`v*`) alongside the extension's Marketplace publish, but runs as an independent job that can fail and retry separately.

### Azure App Service setup

- **Runtime**: Node.js 20 LTS (Linux)
- **Startup command**: `node web/dist/server.js`
- **App Settings**: Set `GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`, and `SESSION_SECRET`
