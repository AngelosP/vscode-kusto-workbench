// Error parsing utilities and navigation helpers for query error UX.
// Extracted from resultsTable-render.ts during legacy results table removal.
import { escapeHtml } from './utils';
import { ensureResultsShownForTool } from './resultsState';
import { __kustoApplyResultsVisibility } from './queryBoxes-execution';
import { lastRunCacheEnabledByBoxId } from './queryBoxes-execution';
import { queryEditors } from './state';
import { __kustoAutoFindInQueryEditor } from '../monaco/monaco';

let _errorLocationClickHandlerInstalled = false;

// ── Types ────────────────────────────────────────────────────────────────────

export interface ErrorLocation {
	line: number;
	col: number;
	token: string;
}

export interface ErrorUxModel {
	kind: 'none' | 'badrequest' | 'json' | 'text';
	message?: string;
	pretty?: string;
	text?: string;
	location?: ErrorLocation | null;
	autoFindTerm?: string | null;
}

// ── Error parsing helpers ────────────────────────────────────────────────────

export function __kustoTryExtractJsonFromErrorText(raw: any) {
	const text = String(raw || '');
	const firstObj = text.indexOf('{');
	const firstArr = text.indexOf('[');
	let start = -1;
	let end = -1;
	if (firstObj >= 0 && (firstArr < 0 || firstObj < firstArr)) {
		start = firstObj;
		end = text.lastIndexOf('}');
	} else if (firstArr >= 0) {
		start = firstArr;
		end = text.lastIndexOf(']');
	}
	if (start < 0 || end < 0 || end <= start) {
		return null;
	}
	const candidate = text.slice(start, end + 1);
	try {
		return JSON.parse(candidate);
	} catch {
		try {
			const trimmed = candidate.trim();
			return JSON.parse(trimmed);
		} catch (e) { console.error('[kusto]', e); }
		return null;
	}
}

export function __kustoExtractLinePosition(text: any) {
	const s = String(text || '');
	const m = s.match(/\[line:position\s*=\s*(\d+)\s*:\s*(\d+)\s*\]/i);
	if (!m) {
		return null;
	}
	const line = parseInt(m[1], 10);
	const col = parseInt(m[2], 10);
	if (!isFinite(line) || !isFinite(col) || line <= 0 || col <= 0) {
		return null;
	}
	return { line, col, token: `[line:position=${line}:${col}]` };
}

export function __kustoNormalizeBadRequestInnerMessage(msg: any) {
	let s = String(msg || '').trim();
	s = s.replace(/^Request is invalid[^:]*:\s*/i, '');
	s = s.replace(/^(Semantic error:|Syntax error:)\s*/i, '');
	return s.trim();
}

export function __kustoStripLinePositionTokens(text: any) {
	let s = String(text || '');
	s = s.replace(/\s*\[line:position\s*=\s*\d+\s*:\s*\d+\s*\]\s*/gi, ' ');
	s = s.replace(/\s{2,}/g, ' ').trim();
	return s;
}

export function __kustoTryExtractAutoFindTermFromMessage(message: any) {
	try {
		const msg = String(message || '');
		if (!msg.trim()) return null;
		// Kusto common pitfall: calling notempty() with no args.
		try {
			const lower = msg.toLowerCase();
			const looksLikeSem0219 = lower.includes('sem0219');
			const looksLikeArity1 = lower.includes('function expects 1 argument');
			const mentionsNotEmpty = /\bnotempty\b/i.test(msg);
			if ((looksLikeSem0219 || looksLikeArity1) && mentionsNotEmpty) {
				return 'notempty';
			}
		} catch (e) { console.error('[kusto]', e); }
		let m = msg.match(/\bSEM0139\b\s*:\s*Failed\s+to\s+resolve\s+expression\s*(['"])(.*?)\1/i);
		if (!m) {
			m = msg.match(/\bSEM0260\b\s*:\s*Unknown\s+function\s*:\s*(['"])(.*?)\1/i);
		}
		if (!m) {
			m = msg.match(/\bnamed\s*(['"])(.*?)\1/i);
		}
		if (!m) {
			m = msg.match(/\bSEM\d{4}\b[^\n\r]*?(['"])(.*?)\1/i);
		}
		if (m && m[2]) {
			const t = String(m[2]);
			if (t.length > 0 && t.length <= 400) {
				return t;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

// ── Error model builder ──────────────────────────────────────────────────────

export function __kustoBuildErrorUxModel(rawError: any): ErrorUxModel {
	const raw = (rawError === null || rawError === undefined) ? '' : String(rawError);
	if (!raw.trim()) {
		return { kind: 'none' };
	}

	const json = __kustoTryExtractJsonFromErrorText(raw);
	if (json && json.error && typeof json.error === 'object') {
		const code = String(json.error.code || '').trim();
		if (code === 'General_BadRequest') {
			const inner = (json.error.innererror && typeof json.error.innererror === 'object') ? json.error.innererror : null;
			const candidateMsg =
				(inner && (inner['@message'] || inner.message)) ||
				(json.error['@message'] || json.error.message) ||
				raw;
			const normalized = __kustoNormalizeBadRequestInnerMessage(candidateMsg);
			let loc = __kustoExtractLinePosition(candidateMsg) || __kustoExtractLinePosition(normalized) || __kustoExtractLinePosition(raw);
			if (!loc && inner) {
				try {
					const line = parseInt(inner['@line'] || inner.line || '', 10);
					const col = parseInt(inner['@pos'] || inner.pos || '', 10);
					if (isFinite(line) && isFinite(col) && line > 0 && col > 0) {
						loc = { line, col, token: `[line:position=${line}:${col}]` };
					}
				} catch (e) { console.error('[kusto]', e); }
			}
			const autoFindTerm = __kustoTryExtractAutoFindTermFromMessage(String(normalized || candidateMsg || ''));
			return { kind: 'badrequest', message: normalized || raw, location: loc || null, autoFindTerm };
		}

		try {
			return { kind: 'json', pretty: JSON.stringify(json, null, 2) };
		} catch (e) { console.error('[kusto]', e); }
	}

	return {
		kind: 'text',
		text: raw,
		autoFindTerm: __kustoTryExtractAutoFindTermFromMessage(raw)
	};
}

function __kustoMaybeAdjustLocationForCacheLine(boxId: any, location: any) {
	if (!location || typeof location !== 'object') {
		return location;
	}
	const bid = String(boxId || '').trim();
	if (!bid) {
		return location;
	}
	let cacheEnabled = false;
	try {
		cacheEnabled = !!(lastRunCacheEnabledByBoxId[bid]);
	} catch {
		cacheEnabled = false;
	}
	if (!cacheEnabled) {
		return location;
	}
	const line = parseInt(String(location.line || ''), 10);
	const col = parseInt(String(location.col || ''), 10);
	if (!isFinite(line) || line <= 0) {
		return location;
	}
	const nextLine = Math.max(1, line - 1);
	return {
		...location,
		line: nextLine,
		col: isFinite(col) && col > 0 ? col : location.col,
		token: `[line:position=${nextLine}:${isFinite(col) && col > 0 ? col : (location.col || 1)}]`
	};
}

// ── Navigate to query location ───────────────────────────────────────────────

function __kustoNavigateToQueryLocation(event: any, boxId: any, line: any, col: any) {
	try {
		if (event && typeof event.preventDefault === 'function') {
			event.preventDefault();
		}
		if (event && typeof event.stopPropagation === 'function') {
			event.stopPropagation();
		}
	} catch (e) { console.error('[kusto]', e); }
	const bid = String(boxId || '').trim();
	const ln = parseInt(String(line), 10);
	const cn = parseInt(String(col), 10);
	if (!bid || !isFinite(ln) || !isFinite(cn) || ln <= 0 || cn <= 0) {
		return;
	}
	try {
		const boxEl = document.getElementById(bid);
		if (boxEl && typeof boxEl.scrollIntoView === 'function') {
			boxEl.scrollIntoView({ block: 'start', behavior: 'smooth' });
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		const editor = queryEditors ? queryEditors[bid] : null;
		if (!editor) return;
		const pos = { lineNumber: ln, column: cn };
		try { editor.focus(); } catch (e) { console.error('[kusto]', e); }
		try { if (typeof editor.setPosition === 'function') editor.setPosition(pos); } catch (e) { console.error('[kusto]', e); }
		try { if (typeof editor.revealPositionInCenter === 'function') editor.revealPositionInCenter(pos); } catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof editor.setSelection === 'function') {
				editor.setSelection({ startLineNumber: ln, startColumn: cn, endLineNumber: ln, endColumn: cn });
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

// Delegated click handler for clickable error locations.
try {
	if (!_errorLocationClickHandlerInstalled) {
		_errorLocationClickHandlerInstalled = true;
		document.addEventListener('click', (event) => {
			try {
				const target = event && event.target ? event.target : null;
				if (!target || typeof (target as any).closest !== 'function') {
					return;
				}
				const link = (target as any).closest('a.kusto-error-location');
				if (!link) {
					return;
				}
				const boxId = String(link.getAttribute('data-boxid') || '').trim();
				const line = parseInt(String(link.getAttribute('data-line') || ''), 10);
				const col = parseInt(String(link.getAttribute('data-col') || ''), 10);
				if (!boxId || !isFinite(line) || !isFinite(col)) {
					return;
				}
				__kustoNavigateToQueryLocation(event, boxId, line, col);
			} catch (e) { console.error('[kusto]', e); }
		}, true);
	}
} catch (e) { console.error('[kusto]', e); }

// ── Render error into section ────────────────────────────────────────────────
// Centralized error UX renderer — delegates to section's displayError() method
// when available, falls back to raw HTML injection for non-Lit sections.

export function __kustoRenderErrorUx(boxId: any, error: any, clientActivityId?: string) {
	const bid = String(boxId || '').trim();
	if (!bid) return;
	try { ensureResultsShownForTool(bid); } catch (e) { console.error('[kusto]', e); }

	const model = __kustoBuildErrorUxModel(error);
	try {
		if (model && model.location) {
			model.location = __kustoMaybeAdjustLocationForCacheLine(bid, model.location);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (model && model.kind === 'badrequest' && model.location && model.message) {
			model.message = __kustoStripLinePositionTokens(model.message);
		}
	} catch (e) { console.error('[kusto]', e); }

	if (!model || model.kind === 'none') {
		return;
	}

	// Delegate to the Lit section element if it has displayError().
	const sectionEl = document.getElementById(bid);
	if (sectionEl && typeof (sectionEl as any).displayError === 'function') {
		(sectionEl as any).displayError(model, clientActivityId);
		return;
	}

	// Fallback: render into the results div directly.
	const resultsDiv = document.getElementById(bid + '_results');
	if (!resultsDiv) return;
	let html = '';
	if (model.kind === 'badrequest') {
		const msgEsc = escapeHtml(model.message || '');
		let locHtml = '';
		if (model.location && model.location.line && model.location.col) {
			const line = model.location.line;
			const col = model.location.col;
			locHtml =
				` <a href="#" class="kusto-error-location"` +
				` data-boxid="${bid}"` +
				` data-line="${line}"` +
				` data-col="${col}"` +
				` title="Go to line ${line}, column ${col}">` +
				escapeHtml(`Line ${line}, Col ${col}`) +
				`</a>`;
		}
		html =
			`<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">` +
			`<div><strong>${msgEsc}</strong>${locHtml}</div>` +
			`</div>`;
	} else if (model.kind === 'json') {
		html =
			`<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">` +
			`<pre style="margin:0; white-space:pre-wrap; word-break:break-word; font-family: var(--vscode-editor-font-family);">` +
			escapeHtml(model.pretty || '') +
			`</pre>` +
			`</div>`;
	} else {
		const lines = String(model.text || '').split(/\r?\n/).map(l => escapeHtml(l)).join('<br>');
		html =
			`<div class="results-header kusto-error-ux" style="color: var(--vscode-errorForeground);">` +
			lines +
			`</div>`;
	}
	resultsDiv.innerHTML = html;
	resultsDiv.classList.add('visible');
	try {
		__kustoApplyResultsVisibility(bid);
	} catch (e) { console.error('[kusto]', e); }

	// Special UX: on SEM0139, auto-find the unresolved expression in the query editor.
	try {
		if (model && model.autoFindTerm && __kustoAutoFindInQueryEditor) {
			setTimeout(() => {
				try { __kustoAutoFindInQueryEditor!(bid, String(model.autoFindTerm)); } catch (e) { console.error('[kusto]', e); }
			}, 0);
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoDisplayBoxError(boxId: any, error: any) {
	const bid = String(boxId || '').trim();
	if (!bid) return;
	__kustoRenderErrorUx(bid, error);
}

// Window bridges removed (D8) — both functions exported, all consumers use ES imports.
