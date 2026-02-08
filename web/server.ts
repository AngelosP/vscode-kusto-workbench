import express from 'express';
import session from 'express-session';
import crypto from 'crypto';
import path from 'path';
import fs from 'fs';
import https from 'https';
import http from 'http';

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);

// --- Session for GitHub OAuth tokens -----------------------------------------------
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
app.use(session({
	secret: SESSION_SECRET,
	resave: false,
	saveUninitialized: false,
	cookie: {
		httpOnly: true,
		secure: process.env.NODE_ENV === 'production',
		sameSite: 'lax',
		maxAge: 24 * 60 * 60 * 1000 // 24 hours
	}
}));

// Augment session with our fields
declare module 'express-session' {
	interface SessionData {
		githubToken?: string;
		returnUrl?: string;
	}
}

// --- GitHub OAuth config -----------------------------------------------------------
const GITHUB_CLIENT_ID = process.env.GITHUB_OAUTH_CLIENT_ID || '';
const GITHUB_CLIENT_SECRET = process.env.GITHUB_OAUTH_CLIENT_SECRET || '';

// --- Paths -------------------------------------------------------------------------
// server.js runs from web/dist/ (after esbuild). Extension root is two levels up.
// In Azure deployment, the artifact is flattened so media/ and dist/ are siblings.
const extensionRoot = (() => {
	// Try two levels up first (dev: web/dist/ → repo root)
	const twoUp = path.resolve(__dirname, '..', '..');
	if (fs.existsSync(path.join(twoUp, 'media', 'queryEditor.js'))) {
		return twoUp;
	}
	// In deployment, media/ might be a sibling of web/dist/
	const oneUp = path.resolve(__dirname, '..');
	if (fs.existsSync(path.join(oneUp, 'media', 'queryEditor.js'))) {
		return oneUp;
	}
	// Fallback: assume media/ is beside server.js (flat deployment)
	return __dirname;
})();

const webRoot = (() => {
	// Dev: source files are in web/ (one level up from web/dist/)
	const oneUp = path.resolve(__dirname, '..');
	if (fs.existsSync(path.join(oneUp, 'viewer.html'))) {
		return oneUp;
	}
	// Production: static files are copied into web/dist/ by esbuild-web.js
	return __dirname;
})();

// --- Static file serving -----------------------------------------------------------

// Intercept vscode.js → serve the shim instead
app.get('/media/queryEditor/vscode.js', (_req, res) => {
	const shimPath = path.join(webRoot, 'vscode-shim.js');
	res.type('application/javascript').sendFile(shimPath);
});

// Serve media/ from extension root (all the shared webview JS/CSS)
app.use('/media', express.static(path.join(extensionRoot, 'media'), { maxAge: '1h' }));

// Serve dist/ from extension root (Monaco, ECharts, TOAST UI bundles)
app.use('/dist', express.static(path.join(extensionRoot, 'dist'), { maxAge: '1h' }));

// Serve web static files (viewer.html, viewer-boot.js, read-only-overrides.css, etc.)
app.use('/web', express.static(webRoot, { maxAge: '1h' }));

// --- Landing page ------------------------------------------------------------------
app.get('/', (_req, res) => {
	res.sendFile(path.join(webRoot, 'index.html'));
});

// --- Viewer page -------------------------------------------------------------------
app.get('/view', (req, res) => {
	const url = req.query.url;
	if (!url || typeof url !== 'string') {
		return res.status(400).send('Missing ?url= parameter. Provide a GitHub file URL.');
	}
	res.sendFile(path.join(webRoot, 'viewer.html'));
});

// --- GitHub OAuth flow -------------------------------------------------------------
app.get('/auth/github', (req, res) => {
	if (!GITHUB_CLIENT_ID) {
		return res.status(500).send('GitHub OAuth is not configured. Set GITHUB_OAUTH_CLIENT_ID.');
	}
	// Remember where to redirect after auth
	const returnUrl = typeof req.query.returnUrl === 'string' ? req.query.returnUrl : '/';
	req.session.returnUrl = returnUrl;

	const state = crypto.randomBytes(16).toString('hex');
	req.session.oauthState = state;

	const params = new URLSearchParams({
		client_id: GITHUB_CLIENT_ID,
		redirect_uri: `${req.protocol}://${req.get('host')}/auth/github/callback`,
		scope: 'repo',
		state
	});

	res.redirect(`https://github.com/login/oauth/authorize?${params.toString()}`);
});

// Augment session with oauthState
declare module 'express-session' {
	interface SessionData {
		oauthState?: string;
	}
}

app.get('/auth/github/callback', async (req, res) => {
	const { code, state } = req.query;
	if (!code || typeof code !== 'string') {
		return res.status(400).send('Missing authorization code.');
	}
	if (state !== req.session.oauthState) {
		return res.status(403).send('Invalid OAuth state. Please try again.');
	}
	delete req.session.oauthState;

	try {
		const tokenResponse = await httpPost('https://github.com/login/oauth/access_token', {
			client_id: GITHUB_CLIENT_ID,
			client_secret: GITHUB_CLIENT_SECRET,
			code,
			redirect_uri: `${req.protocol}://${req.get('host')}/auth/github/callback`
		}, { Accept: 'application/json' });

		const tokenData = JSON.parse(tokenResponse);
		if (!tokenData.access_token) {
			return res.status(500).send(`GitHub OAuth error: ${tokenData.error_description || tokenData.error || 'unknown error'}`);
		}

		req.session.githubToken = tokenData.access_token;
		const returnUrl = req.session.returnUrl || '/';
		delete req.session.returnUrl;
		res.redirect(returnUrl);
	} catch (err) {
		console.error('GitHub OAuth token exchange failed:', err);
		res.status(500).send('Failed to complete GitHub sign-in. Please try again.');
	}
});

app.get('/auth/status', (req, res) => {
	res.json({ authenticated: !!req.session.githubToken });
});

app.post('/auth/logout', (req, res) => {
	req.session.destroy(() => {
		res.json({ ok: true });
	});
});

// --- File fetch proxy --------------------------------------------------------------
// Fetches a file from GitHub on behalf of the client, using the user's OAuth token
// if available. This avoids CORS issues and handles private repo auth.
app.get('/api/fetch-file', async (req, res) => {
	const rawUrl = req.query.url;
	if (!rawUrl || typeof rawUrl !== 'string') {
		return res.status(400).json({ error: 'Missing ?url= parameter.' });
	}

	try {
		const { apiUrl, isRaw } = githubUrlToApiUrl(rawUrl);
		const headers: Record<string, string> = {
			'User-Agent': 'KustoWorkbenchViewer/1.0'
		};

		if (req.session.githubToken) {
			headers['Authorization'] = `Bearer ${req.session.githubToken}`;
		}

		if (!isRaw) {
			// GitHub API: request raw content
			headers['Accept'] = 'application/vnd.github.raw+json';
		}

		const content = await httpGet(apiUrl, headers);
		res.type('text/plain').send(content);
	} catch (err: any) {
		const status = err?.statusCode || 500;
		const message = err?.message || 'Failed to fetch file.';

		if (status === 401 || status === 403 || status === 404) {
			res.status(status).json({
				error: message,
				requiresAuth: !req.session.githubToken,
				authUrl: GITHUB_CLIENT_ID ? `/auth/github?returnUrl=${encodeURIComponent(`/view?url=${encodeURIComponent(rawUrl)}`)}` : null
			});
		} else {
			res.status(status).json({ error: message });
		}
	}
});

// --- URL parsing helpers -----------------------------------------------------------

/**
 * Convert a GitHub blob/raw URL into a GitHub API contents URL.
 * Supports:
 *   https://github.com/{owner}/{repo}/blob/{ref}/{path}
 *   https://raw.githubusercontent.com/{owner}/{repo}/{ref}/{path}
 *   https://api.github.com/repos/{owner}/{repo}/contents/{path}?ref={ref}
 */
function githubUrlToApiUrl(url: string): { apiUrl: string; isRaw: boolean } {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw Object.assign(new Error('Invalid URL.'), { statusCode: 400 });
	}

	// Already a GitHub API URL
	if (parsed.hostname === 'api.github.com' && parsed.pathname.includes('/contents/')) {
		return { apiUrl: url, isRaw: false };
	}

	// raw.githubusercontent.com/{owner}/{repo}/{ref}/{path...}
	if (parsed.hostname === 'raw.githubusercontent.com') {
		const parts = parsed.pathname.split('/').filter(Boolean);
		if (parts.length < 4) {
			throw Object.assign(new Error('Invalid raw GitHub URL.'), { statusCode: 400 });
		}
		const [owner, repo, ref, ...pathParts] = parts;
		return {
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${pathParts.join('/')}?ref=${ref}`,
			isRaw: false
		};
	}

	// github.com/{owner}/{repo}/blob/{ref}/{path...}
	if (parsed.hostname === 'github.com') {
		const parts = parsed.pathname.split('/').filter(Boolean);
		// Expect: owner, repo, "blob", ref, path...
		if (parts.length < 5 || parts[2] !== 'blob') {
			throw Object.assign(new Error('URL must be a GitHub file link (e.g., github.com/owner/repo/blob/main/file.kqlx).'), { statusCode: 400 });
		}
		const [owner, repo, , ref, ...pathParts] = parts;
		return {
			apiUrl: `https://api.github.com/repos/${owner}/${repo}/contents/${pathParts.join('/')}?ref=${ref}`,
			isRaw: false
		};
	}

	throw Object.assign(new Error('URL must be from github.com or raw.githubusercontent.com.'), { statusCode: 400 });
}

// --- HTTP helpers ------------------------------------------------------------------

function httpGet(url: string, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const mod = url.startsWith('https') ? https : http;
		const req = mod.get(url, { headers }, (res) => {
			// Follow redirects
			if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				return httpGet(res.headers.location, headers).then(resolve, reject);
			}
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				const body = Buffer.concat(chunks).toString('utf-8');
				if (res.statusCode && res.statusCode >= 400) {
					reject(Object.assign(new Error(body || `HTTP ${res.statusCode}`), { statusCode: res.statusCode }));
				} else {
					resolve(body);
				}
			});
		});
		req.on('error', reject);
	});
}

function httpPost(url: string, data: Record<string, string>, headers: Record<string, string> = {}): Promise<string> {
	return new Promise((resolve, reject) => {
		const body = JSON.stringify(data);
		const parsed = new URL(url);
		const mod = parsed.protocol === 'https:' ? https : http;
		const req = mod.request({
			hostname: parsed.hostname,
			port: parsed.port,
			path: parsed.pathname + parsed.search,
			method: 'POST',
			headers: {
				...headers,
				'Content-Type': 'application/json',
				'Content-Length': Buffer.byteLength(body)
			}
		}, (res) => {
			const chunks: Buffer[] = [];
			res.on('data', (chunk: Buffer) => chunks.push(chunk));
			res.on('end', () => {
				resolve(Buffer.concat(chunks).toString('utf-8'));
			});
		});
		req.on('error', reject);
		req.write(body);
		req.end();
	});
}

// --- Start server ------------------------------------------------------------------
app.listen(PORT, () => {
	console.log(`Kusto Workbench Viewer running at http://localhost:${PORT}`);
});
