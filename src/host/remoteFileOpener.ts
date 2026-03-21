import * as vscode from 'vscode';
import * as path from 'path';

import { KqlxEditorProvider } from './kqlxEditorProvider';
import { KqlCompatEditorProvider } from './kqlCompatEditorProvider';
import { MdCompatEditorProvider } from './mdCompatEditorProvider';

/** Output channel for remote-file diagnostics. Lazily created on first use. */
let _diagChannel: vscode.OutputChannel | undefined;
function diagLog(msg: string): void {
	if (!_diagChannel) {
		_diagChannel = vscode.window.createOutputChannel('Kusto Workbench: Remote File');
	}
	const ts = new Date().toISOString();
	_diagChannel.appendLine(`[${ts}] ${msg}`);
}
function showDiagChannel(): void {
	if (_diagChannel) {
		_diagChannel.show(true);
	}
}

/**
 * Maps a file extension to the appropriate custom editor view type, or undefined if
 * the extension should be opened with VS Code's default text editor.
 */
function getEditorViewType(extension: string): string | undefined {
	switch (extension) {
		case '.kqlx':
		case '.mdx':
			return KqlxEditorProvider.viewType;
		case '.kql':
		case '.csl':
			return KqlCompatEditorProvider.viewType;
		case '.md':
			return MdCompatEditorProvider.viewType;
		default:
			return undefined;
	}
}

/**
 * Supported file extensions for remote file opening.
 * The order matters for the sidecar detection logic.
 */
const SUPPORTED_EXTENSIONS = ['.kqlx', '.kql.json', '.csl.json', '.kql', '.csl', '.mdx', '.md'];

/**
 * Determines whether a URL path represents a supported file type.
 * Returns the matching extension (e.g. '.kqlx', '.kql.json') or undefined.
 *
 * Strips query parameters and fragments before checking, so URLs like
 * `https://example.com/file.kqlx?token=abc` are correctly recognised.
 */
function detectExtension(urlOrPath: string): string | undefined {
	let pathname = urlOrPath;
	try {
		pathname = new URL(urlOrPath).pathname;
	} catch {
		// Not a full URL — treat the input as a plain path.
		// Still strip anything after '?' or '#'.
		const qIdx = pathname.indexOf('?');
		if (qIdx >= 0) { pathname = pathname.slice(0, qIdx); }
		const hIdx = pathname.indexOf('#');
		if (hIdx >= 0) { pathname = pathname.slice(0, hIdx); }
	}
	const lower = pathname.toLowerCase();
	return SUPPORTED_EXTENSIONS.find(ext => lower.endsWith(ext));
}

/**
 * For sidecar files (.kql.json, .csl.json), returns the base extension (.kql, .csl).
 * For everything else, returns the extension as-is.
 */
function getLocalFileExtension(detectedExt: string): string {
	if (detectedExt === '.kql.json' || detectedExt === '.csl.json') {
		// Sidecar: we need to download both the .kql/.csl and the .json file.
		// The "main" file for opening purposes is .kql/.csl.
		return detectedExt.replace('.json', '');
	}
	return detectedExt;
}

/**
 * Derives a safe local filename from a remote URL.
 * Falls back to a hash-based name if the URL doesn't have a clean filename.
 */
function deriveLocalFilename(remoteUrl: string, extension: string): string {
	try {
		const url = new URL(remoteUrl);
		const segments = url.pathname.split('/').filter(Boolean);
		if (segments.length > 0) {
			const last = segments[segments.length - 1];
			// URL-decode the filename
			const decoded = decodeURIComponent(last);
			// Strip extension from the filename if present so we can add the correct one
			const lower = decoded.toLowerCase();
			for (const ext of SUPPORTED_EXTENSIONS) {
				if (lower.endsWith(ext)) {
					return decoded.slice(0, -ext.length) + extension;
				}
			}
			// No recognized extension in URL; just append
			return decoded + extension;
		}
	} catch {
		// ignore
	}
	// Fallback: hash the URL to create a stable filename
	return `remote-${hashString(remoteUrl)}${extension}`;
}

/** Simple deterministic hash of a string, returned as a base-36 string. */
function hashString(s: string): string {
	let h = 0;
	for (let i = 0; i < s.length; i++) {
		h = ((h << 5) - h + s.charCodeAt(i)) | 0;
	}
	return Math.abs(h).toString(36);
}

/**
 * Creates (and returns) a subdirectory under `remoteDir` based on a hash of the URL.
 * This ensures files with the same name from different sources don't collide.
 * Layout: `remote-files/<hash-of-url>/<filename>`
 */
async function urlSubDir(remoteDir: vscode.Uri, remoteUrl: string): Promise<vscode.Uri> {
	const hash = hashString(remoteUrl);
	const dir = vscode.Uri.joinPath(remoteDir, hash);
	await vscode.workspace.fs.createDirectory(dir);
	return dir;
}

// ─── SharePoint / OneDrive support ──────────────────────────────────────────

/**
 * Hostnames (or hostname suffixes) that indicate a SharePoint / OneDrive sharing URL.
 * These URLs don't have a recognisable file extension in the path — the real filename
 * is only available through the Microsoft Graph API.
 */
const SHAREPOINT_HOST_PATTERNS = [
	'sharepoint.com',
	'onedrive.cloud.microsoft',
	'1drv.ms',
	'onedrive.live.com',
];

/** Returns true when the URL looks like a SharePoint / OneDrive sharing link. */
function isSharePointUrl(url: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return SHAREPOINT_HOST_PATTERNS.some(p => hostname === p || hostname.endsWith(`.${p}`));
	} catch {
		return false;
	}
}

// ─── GitHub URL support ─────────────────────────────────────────────────────

/**
 * GitHub hostnames we recognise for special handling.
 *  • `github.com` — blob/tree viewer URLs → convert to raw
 *  • `raw.githubusercontent.com` — raw content URLs → may need auth for private repos
 */
const GITHUB_HOSTS = ['github.com', 'raw.githubusercontent.com'];

/** Returns true when the URL is a GitHub blob/raw URL. */
function isGitHubUrl(url: string): boolean {
	try {
		const hostname = new URL(url).hostname.toLowerCase();
		return GITHUB_HOSTS.includes(hostname);
	} catch {
		return false;
	}
}

/**
 * Normalizes a GitHub URL for raw content access:
 *  • `github.com/<owner>/<repo>/blob/<ref>/<path>` → `raw.githubusercontent.com/<owner>/<repo>/<ref>/<path>`
 *  • `raw.githubusercontent.com/...` → returned as-is (query params like ?token= preserved)
 *  • Other `github.com` paths → returned as-is (won't match, will fail at fetch time)
 */
function normalizeGitHubUrl(url: string): string {
	try {
		const parsed = new URL(url);
		if (parsed.hostname.toLowerCase() === 'github.com') {
			// Match: /<owner>/<repo>/blob/<ref>/<path...>
			const blobMatch = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(parsed.pathname);
			if (blobMatch) {
				const [, owner, repo, rest] = blobMatch;
				// rest = "<ref>/<path>"
				return `https://raw.githubusercontent.com/${owner}/${repo}/${rest}${parsed.search}`;
			}
		}
		// Already raw.githubusercontent.com or an unrecognised github.com path
		return url;
	} catch {
		return url;
	}
}

/**
 * Fetches content from a GitHub URL, using VS Code's `github` auth provider
 * if the initial unauthenticated request fails with 404 (private repo).
 */
async function fetchGitHubContent(url: string): Promise<string> {
	const rawUrl = normalizeGitHubUrl(url);
	diagLog(`GitHub: fetching ${rawUrl}`);

	// Try without auth first (works for public repos and URLs with embedded tokens).
	const res = await fetch(rawUrl);
	if (res.ok) {
		diagLog(`GitHub: ✓ Got content without auth (${res.status})`);
		return await res.text();
	}

	diagLog(`GitHub: unauthenticated fetch returned ${res.status} — trying with GitHub auth…`);
	try { await res.text(); } catch { /* discard */ }

	// Try with GitHub auth (for private/internal repos).
	let token: string | undefined;
	try {
		const session = await vscode.authentication.getSession('github', ['repo'], { createIfNone: true });
		token = session?.accessToken;
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		diagLog(`GitHub: auth failed: ${msg}`);
	}

	if (!token) {
		throw new Error(
			`GitHub returned HTTP ${res.status}. The repository may be private. ` +
			'Sign-in was attempted but no token was obtained.'
		);
	}

	diagLog(`GitHub: retrying with token…`);
	const authRes = await fetch(rawUrl, {
		headers: { 'Authorization': `token ${token}` }
	});
	if (!authRes.ok) {
		const status = authRes.status;
		try { await authRes.text(); } catch { /* discard */ }
		throw new Error(
			`GitHub returned HTTP ${status} even with authentication. ` +
			'Check that you have access to this repository.'
		);
	}
	diagLog(`GitHub: ✓ Got content with auth (${authRes.status})`);
	return await authRes.text();
}

/**
 * Parses a `Content-Disposition` header to extract the filename.
 * Supports both `filename="..."` and `filename*=UTF-8''...` forms.
 * Returns `undefined` when the header is absent or unparseable.
 */
function parseContentDisposition(header: string | null): string | undefined {
	if (!header) {
		return undefined;
	}
	// Try filename*= (RFC 5987 encoding) first — more reliable for non-ASCII names.
	const starMatch = /filename\*\s*=\s*(?:UTF-8|utf-8)?''(.+?)(?:;|$)/i.exec(header);
	if (starMatch) {
		try {
			return decodeURIComponent(starMatch[1].trim());
		} catch {
			// ignore
		}
	}
	// Fall back to filename="..."
	const plainMatch = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
	if (plainMatch) {
		return plainMatch[1].trim();
	}
	return undefined;
}

/**
 * Follows redirect hops manually while accumulating cookies across hops.
 *
 * SharePoint sharing links rely on cookie-based authentication:
 *  • The sharing token embedded in the URL (`e=...`) is validated during the redirect chain
 *  • SharePoint sets `FedAuth` / `rtFa` cookies that authorise subsequent requests
 *  • Node's `fetch` does NOT maintain a cookie jar, so `redirect: 'follow'` silently
 *    drops these cookies, causing downstream 401s
 *
 * This function manually follows redirects (up to `maxHops`), forwarding accumulated
 * `Set-Cookie` values as a `Cookie` header on each subsequent request.
 *
 * It also tracks **intermediate URLs** that look like SharePoint sharing URLs
 * (contain `/:u:/`, `/:w:/`, `/:x:/`, `/:p:/`, etc. in the path). These intermediate
 * URLs are the only ones that support the `download=1` query parameter — the final
 * viewer page URL (e.g. `_layouts/15/onedrive.aspx?id=...`) does not.
 *
 * When the chain settles (no more redirects, or a non-redirect response), returns the
 * final `Response` (with body unconsumed), the accumulated cookies string, the final
 * URL, and the best candidate sharing URL for download.
 */
async function fetchWithCookies(
	url: string,
	maxHops: number = 15,
	bearerToken?: string
): Promise<{ response: Response; cookies: string; finalUrl: string; sharingUrl: string | undefined }> {
	const cookieJar = new Map<string, string>(); // name → "name=value"

	const mergeCookies = (res: Response): void => {
		// `getSetCookie()` returns an array of raw Set-Cookie header values.
		// Fallback: `get('set-cookie')` gives a comma-joined string (less reliable
		// but works in Node versions that don't expose getSetCookie).
		let rawValues: string[] = [];
		try {
			rawValues = (res.headers as any).getSetCookie?.() ?? [];
		} catch {
			// ignore
		}
		if (rawValues.length === 0) {
			const joined = res.headers.get('set-cookie');
			if (joined) {
				// Rough split — good enough for SharePoint's simple cookie names.
				rawValues = joined.split(/,(?=[^ ]+=)/);
			}
		}
		for (const raw of rawValues) {
			const nameValue = raw.split(';')[0]?.trim();
			if (!nameValue) { continue; }
			const eqIdx = nameValue.indexOf('=');
			const name = eqIdx > 0 ? nameValue.slice(0, eqIdx) : nameValue;
			cookieJar.set(name, nameValue);
		}
	};

	const cookieHeader = (): string => [...cookieJar.values()].join('; ');

	// SharePoint sharing URLs have a path segment like /:u:/ /:w:/ /:x:/ /:p:/ /:b:/ /:v:/ /:o:/ /:t:/ /:f:/
	// These are the ONLY URLs that support `download=1`.
	const sharingPathPattern = /\/:[a-z]:\//i;
	let sharingUrl: string | undefined;

	diagLog(`--- fetchWithCookies start ---`);
	diagLog(`  initial URL: ${url}`);
	diagLog(`  maxHops: ${maxHops}`);
	diagLog(`  bearerToken: ${bearerToken ? 'present' : '(none)'}`);

	let current = url;
	for (let hop = 0; hop < maxHops; hop++) {
		// Track sharing URLs as we encounter them in the chain.
		try {
			const parsed = new URL(current);
			if (sharingPathPattern.test(parsed.pathname)) {
				sharingUrl = current;
				diagLog(`  [hop ${hop}] ★ Captured sharing URL: ${current}`);
			}
		} catch {
			// ignore
		}

		const headers: Record<string, string> = {};
		const ck = cookieHeader();
		if (ck) {
			headers['Cookie'] = ck;
		}
		if (bearerToken) {
			headers['Authorization'] = `Bearer ${bearerToken}`;
		}

		diagLog(`  [hop ${hop}] GET ${current}`);
		diagLog(`  [hop ${hop}]   cookies: ${ck ? `${cookieJar.size} cookie(s) — names: ${[...cookieJar.keys()].join(', ')}` : '(none)'}`);

		let res: Response;
		try {
			res = await fetch(current, { method: 'GET', redirect: 'manual', headers });
		} catch (err: unknown) {
			const msg = `Network error at hop ${hop + 1}: ${err instanceof Error ? err.message : String(err)}`;
			diagLog(`  [hop ${hop}]   ✗ ${msg}`);
			throw new Error(msg);
		}

		const prevCookieCount = cookieJar.size;
		mergeCookies(res);
		const newCookies = cookieJar.size - prevCookieCount;

		diagLog(`  [hop ${hop}]   → HTTP ${res.status} ${res.statusText}`);
		diagLog(`  [hop ${hop}]   content-type: ${res.headers.get('content-type') ?? '(none)'}`);
		if (newCookies > 0) {
			diagLog(`  [hop ${hop}]   +${newCookies} new cookie(s) — total: ${cookieJar.size} — names: ${[...cookieJar.keys()].join(', ')}`);
		}

		const status = res.status;
		// 3xx redirect
		if (status >= 300 && status < 400) {
			const location = res.headers.get('location');
			if (!location) {
				diagLog(`  [hop ${hop}]   redirect with no Location header — treating as final`);
				return { response: res, cookies: cookieHeader(), finalUrl: current, sharingUrl };
			}
			diagLog(`  [hop ${hop}]   Location: ${location}`);
			try {
				current = new URL(location, current).toString();
			} catch {
				diagLog(`  [hop ${hop}]   ✗ Could not parse Location as URL`);
				return { response: res, cookies: cookieHeader(), finalUrl: current, sharingUrl };
			}
			// Consume and discard redirect body to free resources.
			try { await res.text(); } catch { /* ignore */ }
			continue;
		}

		// Non-redirect response — this is our final answer.
		diagLog(`  [hop ${hop}]   ✓ Final response (non-redirect)`);
		return { response: res, cookies: cookieHeader(), finalUrl: current, sharingUrl };
	}

	// Exhausted max hops — do one final normal fetch with cookies.
	diagLog(`  \u26a0 Exhausted ${maxHops} hops — doing one final fetch`);
	const headers: Record<string, string> = {};
	const ck = cookieHeader();
	if (ck) {
		headers['Cookie'] = ck;
	}	if (bearerToken) {
		headers['Authorization'] = `Bearer ${bearerToken}`;
	}	const finalRes = await fetch(current, { redirect: 'manual', headers });
	mergeCookies(finalRes);
	diagLog(`  Final fetch: HTTP ${finalRes.status} ${finalRes.statusText}`);
	diagLog(`--- fetchWithCookies end ---`);
	return { response: finalRes, cookies: cookieHeader(), finalUrl: current, sharingUrl };
}

/**
 * Downloads a file from a SharePoint / OneDrive sharing link.
 *
 * Strategy (multi-layer, each attempt builds on the previous):
 *
 *  **Layer 1 – Direct download** (`download=1` on the original sharing URL):
 *   Append `download=1` to the sharing URL before following ANY redirects. The CDN
 *   gateway at `onedrive.cloud.microsoft` may honour this and redirect directly to
 *   file content, bypassing the HTML viewer entirely. This works for anonymous /
 *   "anyone with the link" shares.
 *
 *  **Layer 2 – Microsoft Graph /shares/ API**:
 *   Use Graph's dedicated sharing-link resolution endpoint to download the file
 *   programmatically. This works for org-internal shares when VS Code's auth
 *   provider can obtain a Graph token with `Files.Read.All`.
 *   See: https://learn.microsoft.com/graph/api/shares-get
 *
 *  **Layer 3 – Browser fallback**:
 *   If all programmatic attempts fail, offer to open the link in the user's
 *   system browser where they're already authenticated.
 */
async function fetchSharePointFile(url: string): Promise<{ filename: string; content: string }> {
	diagLog(`=== fetchSharePointFile ===`);
	diagLog(`Original URL: ${url}`);

	// ── Layer 1: try download=1 on the original sharing URL ────────────────
	diagLog(`Layer 1: Trying download=1 on the original sharing URL…`);
	const dlUrlDirect = new URL(url);
	dlUrlDirect.searchParams.set('download', '1');
	diagLog(`  URL: ${dlUrlDirect.toString()}`);

	const layer1 = await fetchWithCookies(dlUrlDirect.toString());
	diagLog(`Layer 1 result:`);
	diagLog(`  status:       ${layer1.response.status} ${layer1.response.statusText}`);
	diagLog(`  content-type: ${layer1.response.headers.get('content-type') ?? '(none)'}`);
	diagLog(`  finalUrl:     ${layer1.finalUrl}`);

	// Did we get actual file content?
	const layer1ct = (layer1.response.headers.get('content-type') ?? '').toLowerCase();
	const layer1IsFile = layer1.response.ok && !layer1ct.includes('text/html');

	if (layer1IsFile) {
		diagLog(`Layer 1: ✓ Got file content directly!`);
		return extractFileResult(layer1.response, layer1.finalUrl, url);
	}

	// Discard the body from Layer 1 so resources are freed.
	try { await layer1.response.text(); } catch { /* ignore */ }

	// ── Layer 2: Microsoft Graph /shares/ API ──────────────────────────────
	diagLog(`Layer 2: Trying Microsoft Graph shares API…`);
	const graphResult = await tryGraphSharesDownload(url);
	if (graphResult) {
		diagLog(`Layer 2: ✓ Got file content via Graph API!`);
		return graphResult;
	}
	diagLog(`Layer 2: ✗ Graph approach did not succeed.`);

	// ── Layer 3: browser fallback ──────────────────────────────────────────
	diagLog(`Layer 3: All programmatic download attempts failed. Offering browser fallback.`);
	showDiagChannel();

	const openInBrowser = 'Open in Browser';
	const choice = await vscode.window.showErrorMessage(
		'Could not download the file from SharePoint. ' +
		'This usually happens when the sharing link requires sign-in that cannot be performed automatically from VS Code.\n\n' +
		'You can open the link in your browser (where you\'re signed in), download the file, then open the local copy with "Kusto Workbench: Open Remote File" or by dragging it into VS Code.',
		{ modal: false },
		openInBrowser
	);
	if (choice === openInBrowser) {
		await vscode.env.openExternal(vscode.Uri.parse(url));
	}

	throw new SharePointBrowserFallbackError();
}

/** Sentinel error to distinguish "user was offered browser fallback" from real errors. */
class SharePointBrowserFallbackError extends Error {
	constructor() {
		super('SharePoint download redirected to browser');
		this.name = 'SharePointBrowserFallbackError';
	}
}

/**
 * Extracts the downloaded file's name and content from a successful response.
 */
async function extractFileResult(
	response: Response,
	finalUrl: string,
	originalUrl: string
): Promise<{ filename: string; content: string }> {
	const contentDisposition = response.headers.get('content-disposition');
	let filename = parseContentDisposition(contentDisposition);

	if (!filename) {
		try {
			const finalPath = new URL(finalUrl).pathname;
			const lastSegment = decodeURIComponent(finalPath.split('/').filter(Boolean).pop() ?? '');
			if (lastSegment && detectExtension(lastSegment)) {
				filename = lastSegment;
			}
		} catch {
			// ignore
		}
	}

	if (!filename) {
		try {
			const responseUrl = response.url || finalUrl;
			const respPath = new URL(responseUrl).pathname;
			const lastSegment = decodeURIComponent(respPath.split('/').filter(Boolean).pop() ?? '');
			if (lastSegment && detectExtension(lastSegment)) {
				filename = lastSegment;
			}
		} catch {
			// ignore
		}
	}

	if (!filename) {
		filename = `shared-file-${hashString(originalUrl)}`;
	}

	diagLog(`  Filename resolved to: ${filename}`);
	diagLog(`  content-disposition: ${contentDisposition ?? '(none)'}`);

	const content = await response.text();
	diagLog(`  Downloaded ${content.length} characters`);

	return { filename, content };
}

/**
 * Attempts to download a shared file via Microsoft Graph's /shares/ API.
 *
 * The Graph shares endpoint resolves sharing URLs to driveItem content without
 * requiring direct SharePoint API access. It uses `Files.Read.All` on the
 * Graph resource, which has a different permission surface than SharePoint's
 * direct API.
 *
 * See: https://learn.microsoft.com/graph/api/shares-get
 *
 * @returns The file content and name, or `undefined` if the attempt fails.
 */
async function tryGraphSharesDownload(sharingUrl: string): Promise<{ filename: string; content: string } | undefined> {
	// Encode the sharing URL for Graph's shares API:
	// base64url-encode the URL and prepend 'u!'
	const encodedUrl = 'u!' + Buffer.from(sharingUrl).toString('base64url');

	// First, get the driveItem metadata to learn the filename.
	const graphMetaUrl = `https://graph.microsoft.com/v1.0/shares/${encodedUrl}/driveItem`;
	const graphContentUrl = `https://graph.microsoft.com/v1.0/shares/${encodedUrl}/driveItem/content`;
	diagLog(`  Graph metadata URL: ${graphMetaUrl}`);
	diagLog(`  Graph content URL:  ${graphContentUrl}`);

	// Acquire a Graph token — try silently first, then interactively.
	const token = await tryAcquireGraphToken();
	if (!token) {
		diagLog(`  ✗ Could not acquire Graph token`);
		return undefined;
	}

	const authHeaders = { 'Authorization': `Bearer ${token}` };

	// ── Step 1: get driveItem metadata (for filename) ─────────────────────
	let filename: string | undefined;
	try {
		const metaRes = await fetch(graphMetaUrl, { headers: authHeaders });
		diagLog(`  Metadata response: ${metaRes.status} ${metaRes.statusText}`);
		if (metaRes.ok) {
			const meta = await metaRes.json() as { name?: string };
			filename = meta.name;
			diagLog(`  driveItem.name: ${filename ?? '(none)'}`);
		} else {
			const errorBody = await metaRes.text();
			diagLog(`  ✗ Metadata error: ${errorBody.substring(0, 300)}`);
			// If metadata fails, the content endpoint will likely also fail.
			// But let's try anyway — 403 on metadata might still allow content
			// access in some edge cases.
		}
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		diagLog(`  ✗ Metadata fetch error: ${msg}`);
	}

	// ── Step 2: download the file content ─────────────────────────────────
	try {
		// Graph's /content endpoint returns a 302 redirect to a pre-authenticated
		// download URL. Using redirect:'follow' lets fetch handle it automatically.
		const contentRes = await fetch(graphContentUrl, {
			headers: authHeaders,
			redirect: 'follow'
		});

		diagLog(`  Content response: ${contentRes.status} ${contentRes.statusText}`);
		diagLog(`  content-type: ${contentRes.headers.get('content-type') ?? '(none)'}`);
		diagLog(`  content-disposition: ${contentRes.headers.get('content-disposition') ?? '(none)'}`);

		if (!contentRes.ok) {
			const errorBody = await contentRes.text();
			diagLog(`  ✗ Content error: ${errorBody.substring(0, 300)}`);
			return undefined;
		}

		// Prefer filename from Content-Disposition, then metadata, then fallback.
		const cdFilename = parseContentDisposition(contentRes.headers.get('content-disposition'));
		if (!filename) {
			filename = cdFilename;
		}
		if (!filename) {
			filename = `shared-file-${hashString(sharingUrl)}`;
		}

		const content = await contentRes.text();
		diagLog(`  ✓ Downloaded ${content.length} characters as "${filename}"`);
		return { filename, content };
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		diagLog(`  ✗ Content fetch error: ${msg}`);
		return undefined;
	}
}

/**
 * Acquires a Microsoft Graph access token via VS Code's `microsoft` auth provider.
 *
 * Tries silently first (reusing an existing session without any UI), then falls
 * back to an interactive prompt if no session exists yet.
 *
 * @returns The access token string, or `undefined` if acquisition fails.
 */
async function tryAcquireGraphToken(): Promise<string | undefined> {
	const scopes = ['https://graph.microsoft.com/Files.Read.All'];
	diagLog(`  Requesting Graph auth with scopes: ${scopes.join(', ')}`);

	// 1. Try silently — reuse an existing session without any UI.
	try {
		const silent = await vscode.authentication.getSession('microsoft', scopes, { silent: true });
		if (silent?.accessToken) {
			diagLog(`  ✓ Got Graph token silently (account: ${silent.account.label})`);
			return silent.accessToken;
		}
	} catch {
		// No existing session — expected.
	}

	// 2. Try interactively — show login dialog if needed.
	try {
		const session = await vscode.authentication.getSession('microsoft', scopes, { createIfNone: true });
		if (session?.accessToken) {
			diagLog(`  ✓ Got Graph token interactively (account: ${session.account.label})`);
			return session.accessToken;
		}
		diagLog(`  ✗ Session returned but no access token`);
	} catch (err: unknown) {
		const msg = err instanceof Error ? err.message : String(err);
		diagLog(`  ✗ Graph auth failed: ${msg}`);
	}

	return undefined;
}

// ─── Core open-remote-file logic ────────────────────────────────────────────

/**
 * Downloads a remote file and saves it to the extension's global storage directory
 * (same location as session.kqlx). Then opens it with the appropriate editor.
 *
 * Supports:
 *  • Plain HTTP/HTTPS URLs with a recognisable file extension
 *  • SharePoint / OneDrive sharing links (resolved via Microsoft Graph)
 *  • Sidecar files (.kql.json / .csl.json) — downloads both parts
 */
export async function openRemoteFile(context: vscode.ExtensionContext, remoteUrl: string): Promise<void> {
	const sharePoint = isSharePointUrl(remoteUrl);
	const gitHub = isGitHubUrl(remoteUrl);
	const detectedExt = detectExtension(remoteUrl);

	// For plain URLs we require a recognisable extension up-front.
	// For SharePoint links the real filename is discovered at download time.
	if (!sharePoint && !detectedExt) {
		const supported = SUPPORTED_EXTENSIONS.join(', ');
		void vscode.window.showErrorMessage(
			`Unsupported file type. The URL must point to a file with one of these extensions: ${supported}\n\nSharePoint / OneDrive sharing links are also supported.`
		);
		return;
	}

	await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'Opening remote file…',
			cancellable: false
		},
		async (progress) => {
			try {
				// Ensure remote-files directory exists
				await vscode.workspace.fs.createDirectory(context.globalStorageUri);
				const remoteDir = vscode.Uri.joinPath(context.globalStorageUri, 'remote-files');
				await vscode.workspace.fs.createDirectory(remoteDir);

				if (sharePoint) {
					await openSharePointFile(context, remoteUrl, remoteDir, progress);
				} else if (gitHub) {
					await openGitHubRemoteFile(context, remoteUrl, detectedExt!, remoteDir, progress);
				} else {
					await openPlainRemoteFile(context, remoteUrl, detectedExt!, remoteDir, progress);
				}
			} catch (err: unknown) {
				// SharePointBrowserFallbackError means we already showed the user
				// a helpful prompt — don't show a second generic error message.
				if (err instanceof SharePointBrowserFallbackError) {
					return;
				}
				const message = err instanceof Error ? err.message : String(err);
				void vscode.window.showErrorMessage(`Failed to open remote file: ${message}`);
			}
		}
	);
}

/**
 * Handles a plain HTTP/HTTPS URL with a known file extension.
 */
async function openPlainRemoteFile(
	_context: vscode.ExtensionContext,
	remoteUrl: string,
	detectedExt: string,
	remoteDir: vscode.Uri,
	progress: vscode.Progress<{ message?: string }>
): Promise<void> {
	const isSidecar = detectedExt === '.kql.json' || detectedExt === '.csl.json';
	const localExt = getLocalFileExtension(detectedExt);
	const localFilename = deriveLocalFilename(remoteUrl, localExt);
	const subDir = await urlSubDir(remoteDir, remoteUrl);
	const localUri = vscode.Uri.joinPath(subDir, localFilename);

	if (isSidecar) {
		const baseQueryUrl = remoteUrl.slice(0, -('.json'.length));
		const sidecarUrl = remoteUrl;

		progress.report({ message: 'Downloading query file…' });
		const queryContent = await fetchRemoteContent(baseQueryUrl);
		await vscode.workspace.fs.writeFile(localUri, new TextEncoder().encode(queryContent));

		progress.report({ message: 'Downloading sidecar file…' });
		const sidecarContent = await fetchRemoteContent(sidecarUrl);
		const sidecarLocalUri = vscode.Uri.joinPath(subDir, localFilename + '.json');
		await vscode.workspace.fs.writeFile(sidecarLocalUri, new TextEncoder().encode(sidecarContent));
	} else {
		progress.report({ message: 'Downloading file…' });
		const content = await fetchRemoteContent(remoteUrl);
		await vscode.workspace.fs.writeFile(localUri, new TextEncoder().encode(content));
	}

	await openLocalFile(localUri, localExt, progress);
}

/**
 * Handles a GitHub URL (blob or raw.githubusercontent.com).
 * Normalizes blob URLs to raw, and uses GitHub auth for private repos.
 */
async function openGitHubRemoteFile(
	_context: vscode.ExtensionContext,
	remoteUrl: string,
	detectedExt: string,
	remoteDir: vscode.Uri,
	progress: vscode.Progress<{ message?: string }>
): Promise<void> {
	const normalizedUrl = normalizeGitHubUrl(remoteUrl);
	const localExt = getLocalFileExtension(detectedExt);
	const localFilename = deriveLocalFilename(normalizedUrl, localExt);
	const subDir = await urlSubDir(remoteDir, remoteUrl);
	const localUri = vscode.Uri.joinPath(subDir, localFilename);

	const isSidecar = detectedExt === '.kql.json' || detectedExt === '.csl.json';

	if (isSidecar) {
		// For sidecar files, also download the companion .kql/.csl file.
		const baseQueryUrl = normalizedUrl.replace(/\.json(\?|$)/, '$1');
		const sidecarUrl = normalizedUrl;

		progress.report({ message: 'Downloading query file from GitHub…' });
		const queryContent = await fetchGitHubContent(baseQueryUrl);
		await vscode.workspace.fs.writeFile(localUri, new TextEncoder().encode(queryContent));

		progress.report({ message: 'Downloading sidecar file from GitHub…' });
		const sidecarContent = await fetchGitHubContent(sidecarUrl);
		const sidecarLocalUri = vscode.Uri.joinPath(subDir, localFilename + '.json');
		await vscode.workspace.fs.writeFile(sidecarLocalUri, new TextEncoder().encode(sidecarContent));
	} else {
		progress.report({ message: 'Downloading file from GitHub…' });
		const content = await fetchGitHubContent(normalizedUrl);
		await vscode.workspace.fs.writeFile(localUri, new TextEncoder().encode(content));
	}

	await openLocalFile(localUri, localExt, progress);
}

/**
 * Handles a SharePoint / OneDrive sharing link.
 */
async function openSharePointFile(
	_context: vscode.ExtensionContext,
	remoteUrl: string,
	remoteDir: vscode.Uri,
	progress: vscode.Progress<{ message?: string }>
): Promise<void> {
	progress.report({ message: 'Downloading from SharePoint…' });
	const { filename, content } = await fetchSharePointFile(remoteUrl);

	// Validate that the downloaded file has a supported extension
	const ext = detectExtension(filename);
	if (!ext) {
		const supported = SUPPORTED_EXTENSIONS.join(', ');
		throw new Error(
			`The file "${filename}" from SharePoint has an unsupported extension. Supported: ${supported}`
		);
	}

	const localExt = getLocalFileExtension(ext);
	// Sanitise the filename for the local filesystem (keep it recognisable)
	const safeName = filename.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
	const subDir = await urlSubDir(remoteDir, remoteUrl);
	const localUri = vscode.Uri.joinPath(subDir, safeName);

	progress.report({ message: 'Saving file locally…' });
	await vscode.workspace.fs.writeFile(localUri, new TextEncoder().encode(content));

	// For sidecar scenarios (.kql.json / .csl.json) — the Graph link points to the
	// sidecar JSON, and we'd need the companion query file too. In practice SharePoint
	// sharing links point to a single file, so sidecar isn't applicable here. But we
	// handle the extension correctly regardless.

	await openLocalFile(localUri, localExt, progress);
}

/**
 * Opens a local file with the appropriate custom editor.
 */
async function openLocalFile(
	localUri: vscode.Uri,
	localExt: string,
	progress: vscode.Progress<{ message?: string }>
): Promise<void> {
	progress.report({ message: 'Opening file…' });
	const viewType = getEditorViewType(localExt);
	if (viewType) {
		await vscode.commands.executeCommand('vscode.openWith', localUri, viewType, {
			viewColumn: vscode.ViewColumn.One
		});
	} else {
		await vscode.commands.executeCommand('vscode.open', localUri, {
			viewColumn: vscode.ViewColumn.One
		});
	}
}

/**
 * Fetches text content from a remote URL.
 * Supports http/https URLs.
 */
async function fetchRemoteContent(url: string): Promise<string> {
	// Validate URL
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error(`Invalid URL: ${url}`);
	}

	if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
		throw new Error(`Unsupported protocol "${parsed.protocol}". Only http and https are supported.`);
	}

	// Use globalThis.fetch (available in Node 18+ which VS Code ships with)
	const response = await fetch(url);
	if (!response.ok) {
		throw new Error(`HTTP ${response.status} ${response.statusText} when fetching ${url}`);
	}
	return await response.text();
}

// ─── URL validation helper ──────────────────────────────────────────────────

/**
 * Returns `undefined` if the URL is valid for our purposes, or an error message string.
 * Used by both the input box validation and the URI handler.
 */
function validateRemoteUrl(value: string): string | undefined {
	if (!value.trim()) {
		return 'URL is required';
	}
	try {
		const parsed = new URL(value.trim());
		if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
			return 'Only http and https URLs are supported';
		}
	} catch {
		return 'Please enter a valid URL';
	}
	const trimmed = value.trim();
	// SharePoint / OneDrive links are always valid (extension comes from metadata)
	if (isSharePointUrl(trimmed)) {
		return undefined;
	}
	// GitHub URLs — validate after normalizing (blob→raw)
	if (isGitHubUrl(trimmed)) {
		const normalized = normalizeGitHubUrl(trimmed);
		const ext = detectExtension(normalized);
		if (!ext) {
			return `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')}`;
		}
		return undefined;
	}
	const ext = detectExtension(trimmed);
	if (!ext) {
		return `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(', ')} (SharePoint / OneDrive and GitHub links are also supported)`;
	}
	return undefined;
}

/**
 * Registers the URI handler for:
 *   vscode://angelos-petropoulos.vscode-kusto-workbench/open?file=<uri>
 *
 * And the "Open Remote File" palette command.
 */
export function registerRemoteFileOpener(context: vscode.ExtensionContext): void {
	// URI Handler: vscode://angelos-petropoulos.vscode-kusto-workbench/open?file=<encoded-url>
	context.subscriptions.push(
		vscode.window.registerUriHandler({
			async handleUri(uri: vscode.Uri) {
				try {
					if (uri.path !== '/open') {
						void vscode.window.showErrorMessage(
							`Unknown Kusto Workbench URI path: "${uri.path}". Expected "/open".`
						);
						return;
					}

					const params = new URLSearchParams(uri.query);
					const fileUrl = params.get('file');

					if (!fileUrl) {
						void vscode.window.showErrorMessage(
							'Missing "file" parameter. Usage: vscode://angelos-petropoulos.vscode-kusto-workbench/open?file=<url>'
						);
						return;
					}

					await openRemoteFile(context, fileUrl);
				} catch (err: unknown) {
					const message = err instanceof Error ? err.message : String(err);
					void vscode.window.showErrorMessage(`Failed to handle Kusto Workbench URI: ${message}`);
				}
			}
		})
	);

	// Palette command: "Open Remote File"
	context.subscriptions.push(
		vscode.commands.registerCommand('kusto.openRemoteFile', async () => {
			const url = await vscode.window.showInputBox({
				title: 'Open Remote File',
				prompt: 'Enter the URL of the file to open (direct link or SharePoint / OneDrive sharing link)',
				placeHolder: 'https://example.com/path/to/file.kqlx  or  SharePoint sharing link',
				validateInput: validateRemoteUrl
			});

			if (!url) {
				return; // user cancelled
			}

			await openRemoteFile(context, url.trim());
		})
	);
}
