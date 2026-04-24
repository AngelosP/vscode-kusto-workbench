// Lightweight persistence and message handling for the md-only webview.
// Provides the `window.schedulePersist` bridge and handles the minimal
// set of host→webview messages needed for .md file editing.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages.js';
import { KwMarkdownSection, markdownBoxes, markdownEditors } from '../sections/kw-markdown-section.js';

const _win = window as any;

// ── schedulePersist (thin implementation) ─────────────────────────────────

let _persistTimer: ReturnType<typeof setTimeout> | null = null;
let _persistEnabled = false;

function schedulePersist(): void {
	if (!_persistEnabled || pState.restoreInProgress) return;
	if (_persistTimer) clearTimeout(_persistTimer);
	_persistTimer = setTimeout(() => {
		_persistTimer = null;
		try {
			const sections: Array<Record<string, unknown>> = [];
			for (const boxId of markdownBoxes) {
				const el = document.getElementById(boxId) as KwMarkdownSection | null;
				if (el && typeof el.serialize === 'function') {
					sections.push(el.serialize());
				}
			}
			postMessageToHost({ type: 'persistDocument', state: { sections } } as any);
		} catch (e) { console.error('[kusto]', e); }
	}, 300);
}

_win.schedulePersist = schedulePersist;

// ── Resource URI resolver ─────────────────────────────────────────────────

const _resourceResolvers: Record<string, { resolve: (v: string | null) => void }> = {};

_win.__kustoResolveResourceUri = async function (args: any): Promise<string | null> {
	const p = (args && typeof args.path === 'string') ? String(args.path) : '';
	const baseUri = (args && typeof args.baseUri === 'string') ? String(args.baseUri) : '';
	if (!p || !_win.vscode) return null;
	const requestId = 'resuri_' + Date.now() + '_' + Math.random().toString(16).slice(2);
	return new Promise((resolve) => {
		const timer = setTimeout(() => {
			delete _resourceResolvers[requestId];
			resolve(null);
		}, 2000);
		_resourceResolvers[requestId] = {
			resolve: (result) => {
				clearTimeout(timer);
				resolve(result);
			}
		};
		try {
			postMessageToHost({ type: 'resolveResourceUri', requestId, path: p, baseUri } as any);
		} catch {
			delete _resourceResolvers[requestId];
			clearTimeout(timer);
			resolve(null);
		}
	});
};

// ── Message handler ───────────────────────────────────────────────────────

let _initialized = false;

window.addEventListener('message', (event) => {
	const message = event.data;
	if (!message || typeof message.type !== 'string') return;

	switch (message.type) {
		case 'persistenceMode':
			try {
				pState.isSessionFile = !!message.isSessionFile;
				if (typeof message.documentUri === 'string') pState.documentUri = String(message.documentUri);
				if (typeof message.documentKind === 'string') {
					pState.documentKind = String(message.documentKind);
					try { document.body.dataset.kustoDocumentKind = String(message.documentKind); } catch { /* ignore */ }
				}
				pState.compatibilityMode = !!message.compatibilityMode;
				if (Array.isArray(message.allowedSectionKinds)) pState.allowedSectionKinds = message.allowedSectionKinds;
				if (typeof message.defaultSectionKind === 'string') pState.defaultSectionKind = String(message.defaultSectionKind);
				if (typeof message.compatibilitySingleKind === 'string') pState.compatibilitySingleKind = String(message.compatibilitySingleKind);
				if (typeof message.upgradeRequestType === 'string') pState.upgradeRequestType = String(message.upgradeRequestType);
				if (typeof message.compatibilityTooltip === 'string') pState.compatibilityTooltip = String(message.compatibilityTooltip);
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'documentData': {
			const forceReload = !!message.forceReload;
			try {
				// Also apply capabilities from documentData (same as persistenceMode).
				if (typeof message.documentKind === 'string') {
					pState.documentKind = String(message.documentKind);
					try { document.body.dataset.kustoDocumentKind = String(message.documentKind); } catch { /* ignore */ }
				}
				if (typeof message.documentUri === 'string') pState.documentUri = String(message.documentUri);
				if (message.compatibilityMode !== undefined) pState.compatibilityMode = !!message.compatibilityMode;

				const sections = message.state?.sections;
				if (!Array.isArray(sections)) break;
				const first = sections.find((s: any) => s && String(s.type || '') === 'markdown');
				const text = first ? String(first.text || '') : '';

				if (_initialized && !forceReload) break;

				if (_initialized && forceReload) {
					// Update existing section rather than creating a new one.
					const boxId = markdownBoxes.length ? markdownBoxes[0] : '';
					if (boxId) {
						const el = document.getElementById(boxId) as KwMarkdownSection | null;
						if (el && typeof el.setText === 'function') {
							el.setText(text);
						} else {
							// Fallback: set via editor API.
							const api = markdownEditors[boxId];
							if (api && typeof api.setValue === 'function') {
								api.setValue(text);
							}
						}
					}
					break;
				}

				// First load: create the markdown section.
				_initialized = true;
				_persistEnabled = true;
				pState.restoreInProgress = true;
				try {
					KwMarkdownSection.addMarkdownBox({ text, mdAutoExpand: true });
				} finally {
					pState.restoreInProgress = false;
				}
			} catch (e) { console.error('[kusto]', e); }
			break;
		}

		case 'revealTextRange':
			try {
				if (typeof _win.__kustoRevealTextRangeFromHost === 'function') {
					_win.__kustoRevealTextRangeFromHost(message);
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'changedSections':
			// plainMd mode doesn't render kw-section-shell, so glow is not applicable.
			// Store for potential future use.
			break;

		case 'resolveResourceUriResult':
			try {
				const reqId = String(message.requestId || '');
				const r = _resourceResolvers[reqId];
				if (r && typeof r.resolve === 'function') {
					const uri = (message.ok && typeof message.uri === 'string') ? String(message.uri) : null;
					r.resolve(uri);
					delete _resourceResolvers[reqId];
				}
			} catch (e) { console.error('[kusto]', e); }
			break;

		case 'settingsUpdate':
			// Handle alternating row color CSS variable (harmless no-op for md).
			break;

		default:
			break;
	}
});
