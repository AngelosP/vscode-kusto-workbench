// Viewer Boot Script
// Acts as a "micro extension host" — fetches the .kqlx / .kql+.json from GitHub,
// parses it, and posts the same sequence of messages that the real extension host
// would send to the webview. This way all existing webview code (queryBoxes.js,
// resultsTable.js, etc.) works identically.

(function() {
	'use strict';

	// ---- .kqlx parser (mirrors src/kqlxFormat.ts parseKqlxText) ----

	function parseKqlxText(text, options) {
		var raw = String(text || '').trim();
		var defaultKind = (options && options.defaultKind) || 'kqlx';
		if (!raw) {
			return { ok: true, file: { kind: defaultKind, version: 1, state: { sections: [] } } };
		}

		var parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (e) {
			return { ok: false, error: 'Invalid JSON: ' + (e && e.message ? e.message : String(e)) };
		}

		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { ok: false, error: 'Invalid file: root must be a JSON object.' };
		}

		var allowedKinds = (options && Array.isArray(options.allowedKinds) && options.allowedKinds.length > 0)
			? options.allowedKinds
			: ['kqlx'];

		var kind = parsed.kind;
		var version = parsed.version;
		if (typeof kind !== 'string' || allowedKinds.indexOf(kind) === -1) {
			return { ok: false, error: 'Invalid file: missing or invalid "kind".' };
		}
		if (version !== 1) {
			return { ok: false, error: 'Unsupported file version: ' + String(version) };
		}

		var state = parsed.state;
		if (!state || typeof state !== 'object' || Array.isArray(state)) {
			return { ok: false, error: 'Invalid file: missing or invalid "state".' };
		}

		var sections = Array.isArray(state.sections) ? state.sections : [];
		var caretDocsEnabled = (typeof state.caretDocsEnabled === 'boolean') ? state.caretDocsEnabled : undefined;

		return {
			ok: true,
			file: {
				kind: kind,
				version: 1,
				state: {
					caretDocsEnabled: caretDocsEnabled,
					sections: sections
				}
			}
		};
	}

	// ---- URL helpers ----

	function getQueryParam(name) {
		var params = new URLSearchParams(window.location.search);
		return params.get(name);
	}

	/**
	 * Given a GitHub file URL, compute the sibling file URL.
	 * e.g., for "...blob/main/queries/test.kql" + "test.kql.json"
	 * → "...blob/main/queries/test.kql.json"
	 */
	function getSiblingUrl(baseUrl, siblingFilename) {
		try {
			var parts = baseUrl.split('/');
			parts[parts.length - 1] = siblingFilename;
			return parts.join('/');
		} catch {
			return null;
		}
	}

	function getFilenameFromUrl(url) {
		try {
			var parts = url.split('/');
			return parts[parts.length - 1] || '';
		} catch {
			return '';
		}
	}

	// ---- Fetch helpers ----

	async function fetchFile(url) {
		var apiUrl = '/api/fetch-file?url=' + encodeURIComponent(url);
		var response = await fetch(apiUrl);

		if (!response.ok) {
			var body;
			try { body = await response.json(); } catch { body = null; }

			if (body && body.requiresAuth && body.authUrl) {
				throw { requiresAuth: true, authUrl: body.authUrl, status: response.status };
			}
			throw { message: (body && body.error) || ('HTTP ' + response.status), status: response.status };
		}

		return await response.text();
	}

	async function tryFetchFile(url) {
		try {
			return { ok: true, content: await fetchFile(url) };
		} catch (err) {
			if (err && err.requiresAuth) throw err; // bubble auth errors
			return { ok: false, error: err };
		}
	}

	// ---- Post a simulated extension-host message to the webview ----

	function postExtensionMessage(message) {
		window.dispatchEvent(new MessageEvent('message', { data: message }));
	}

	// ---- Loading UI ----

	function showLoading(text) {
		var el = document.getElementById('viewer-loading');
		if (el) {
			el.style.display = '';
			var msgEl = el.querySelector('.viewer-loading-message');
			if (msgEl) msgEl.textContent = text || 'Loading...';
		}
	}

	function hideLoading() {
		var el = document.getElementById('viewer-loading');
		if (el) el.style.display = 'none';
	}

	function showError(title, detail, authUrl) {
		hideLoading();
		var el = document.getElementById('viewer-error');
		if (!el) return;
		el.style.display = '';
		var titleEl = el.querySelector('.viewer-error-title');
		var detailEl = el.querySelector('.viewer-error-detail');
		var authEl = el.querySelector('.viewer-error-auth');
		if (titleEl) titleEl.textContent = title;
		if (detailEl) detailEl.textContent = detail || '';
		if (authEl) {
			if (authUrl) {
				authEl.style.display = '';
				authEl.href = authUrl;
			} else {
				authEl.style.display = 'none';
			}
		}
	}

	function updateBanner(filename, githubUrl) {
		var el = document.getElementById('viewer-banner');
		if (!el) return;
		el.style.display = '';
		var nameEl = el.querySelector('.viewer-banner-filename');
		var linkEl = el.querySelector('.viewer-banner-github-link');
		if (nameEl) nameEl.textContent = filename || '';
		if (linkEl) {
			linkEl.href = githubUrl || '#';
			linkEl.style.display = githubUrl ? '' : 'none';
		}
	}

	// ---- Main boot sequence ----

	async function boot() {
		var githubUrl = getQueryParam('url');
		if (!githubUrl) {
			showError('No file URL provided', 'Add a ?url= parameter with a GitHub file URL.');
			return;
		}

		var filename = getFilenameFromUrl(githubUrl);
		var lowerFilename = filename.toLowerCase();

		showLoading('Fetching ' + filename + '...');
		updateBanner(filename, githubUrl);

		try {
			var state;
			var documentKind = 'kqlx';

			if (lowerFilename.endsWith('.kqlx')) {
				// --- .kqlx file: single fetch, parse as KqlxFileV1 ---
				var content = await fetchFile(githubUrl);
				var parsed = parseKqlxText(content, { allowedKinds: ['kqlx', 'mdx'] });
				if (!parsed.ok) {
					showError('Invalid .kqlx file', parsed.error);
					return;
				}
				state = parsed.file.state;
				documentKind = parsed.file.kind;

			} else if (lowerFilename.endsWith('.kql.json') || lowerFilename.endsWith('.csl.json')) {
				// --- .kql.json sidecar: parse it, then fetch the linked .kql ---
				var sidecarContent = await fetchFile(githubUrl);
				var sidecarParsed = parseKqlxText(sidecarContent, { allowedKinds: ['kqlx'] });
				if (!sidecarParsed.ok) {
					showError('Invalid sidecar file', sidecarParsed.error);
					return;
				}
				state = sidecarParsed.file.state;

				// Find the first query section with linkedQueryPath
				var firstQuery = null;
				for (var i = 0; i < state.sections.length; i++) {
					var sec = state.sections[i];
					if ((sec.type === 'query' || sec.type === 'copilotQuery') && sec.linkedQueryPath) {
						firstQuery = sec;
						break;
					}
				}

				if (firstQuery && firstQuery.linkedQueryPath) {
					showLoading('Fetching linked query file...');
					var linkedUrl = getSiblingUrl(githubUrl, firstQuery.linkedQueryPath);
					if (linkedUrl) {
						var linkedResult = await tryFetchFile(linkedUrl);
						if (linkedResult.ok) {
							firstQuery.query = linkedResult.content;
						}
					}
				}

			} else if (lowerFilename.endsWith('.kql') || lowerFilename.endsWith('.csl')) {
				// --- .kql file: fetch the query text, then check for sidecar ---
				var queryText = await fetchFile(githubUrl);

				// Try to fetch sibling .kql.json sidecar
				var sidecarUrl = githubUrl + '.json';
				showLoading('Checking for companion .json file...');
				var sidecarResult = await tryFetchFile(sidecarUrl);

				if (sidecarResult.ok) {
					var sidecarParsed2 = parseKqlxText(sidecarResult.content, { allowedKinds: ['kqlx'] });
					if (sidecarParsed2.ok) {
						state = sidecarParsed2.file.state;
						// Inject query text into first query section
						for (var j = 0; j < state.sections.length; j++) {
							var sec2 = state.sections[j];
							if (sec2.type === 'query' || sec2.type === 'copilotQuery') {
								sec2.query = queryText;
								break;
							}
						}
					} else {
						// Sidecar exists but is invalid → fall back to compatibility mode
						state = { sections: [{ type: 'query', query: queryText }] };
					}
				} else {
					// No sidecar → compatibility mode (single query section)
					state = { sections: [{ type: 'query', query: queryText }] };
				}

			} else {
				showError('Unsupported file type', 'Supported: .kqlx, .kql, .csl, .kql.json, .csl.json');
				return;
			}

			// ---- Send initialization messages (same sequence as the real extension host) ----

			showLoading('Rendering...');

			// 1. persistenceMode — tell the webview this is a read-only document
			postExtensionMessage({
				type: 'persistenceMode',
				isSessionFile: false,
				documentUri: githubUrl,
				compatibilityMode: false,
				documentKind: documentKind,
				allowedSectionKinds: [], // empty → hides all "Add" buttons
				defaultSectionKind: 'query'
			});

			// 2. connectionsData — empty, no connections available in read-only mode
			postExtensionMessage({
				type: 'connectionsData',
				connections: [],
				lastConnectionId: null,
				lastDatabase: null,
				cachedDatabases: {},
				favorites: [],
				leaveNoTraceClusters: [],
				caretDocsEnabled: false,
				autoTriggerAutocompleteEnabled: false,
				copilotInlineCompletionsEnabled: false
			});

			// 3. copilotAvailability — not available in viewer
			postExtensionMessage({
				type: 'copilotAvailability',
				available: false,
				boxId: '__kusto_global__'
			});

			// 4. documentData — the main payload
			postExtensionMessage({
				type: 'documentData',
				ok: true,
				state: state,
				documentUri: githubUrl
			});

			hideLoading();

			// 5. After rendering, make all Monaco editors read-only
			setTimeout(function() {
				makeEditorsReadOnly();
			}, 1500);

			// Retry a few times to catch editors that initialize late
			setTimeout(function() { makeEditorsReadOnly(); }, 3000);
			setTimeout(function() { makeEditorsReadOnly(); }, 5000);

		} catch (err) {
			if (err && err.requiresAuth) {
				showError(
					'Authentication required',
					'This file is in a private repository. Sign in with GitHub to access it.',
					err.authUrl
				);
			} else {
				showError(
					'Failed to load file',
					(err && err.message) || String(err)
				);
			}
		}
	}

	// ---- Make editors read-only ----

	function makeEditorsReadOnly() {
		try {
			// queryEditors is a global from queryBoxes.js
			if (typeof queryEditors !== 'undefined' && queryEditors) {
				for (var key in queryEditors) {
					if (queryEditors.hasOwnProperty(key)) {
						var editor = queryEditors[key];
						if (editor && typeof editor.updateOptions === 'function') {
							editor.updateOptions({ readOnly: true });
						}
					}
				}
			}
		} catch (e) {
			// ignore
		}

		// Also disable Python editors if any
		try {
			if (typeof pythonEditors !== 'undefined' && pythonEditors) {
				for (var key2 in pythonEditors) {
					if (pythonEditors.hasOwnProperty(key2)) {
						var editor2 = pythonEditors[key2];
						if (editor2 && typeof editor2.updateOptions === 'function') {
							editor2.updateOptions({ readOnly: true });
						}
					}
				}
			}
		} catch (e2) {
			// ignore
		}
	}

	// ---- Disable persistence ----
	// Override schedulePersist to prevent writes in case it gets re-enabled.
	try {
		window.__kustoPersistenceEnabled = false;
		var origSchedulePersist = window.schedulePersist;
		window.schedulePersist = function() {
			// no-op in read-only viewer
		};
	} catch {
		// ignore — function may not be defined yet
	}

	// ---- Intercept the webview's initial postMessage calls ----
	// The webview's main.js sends getConnections, checkCopilotAvailability, and requestDocument
	// on load. Our vscode shim silently drops them, and our boot() function sends the
	// responses proactively. But we need to wait for the scripts to finish loading.

	// Wait for the webview scripts to initialize, then boot.
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', function() { setTimeout(boot, 100); });
	} else {
		setTimeout(boot, 100);
	}
})();
