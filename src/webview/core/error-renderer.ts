// Error rendering and navigation — delegates to Lit section or falls back to raw HTML.
// Extracted from modules/errorUtils.ts during Session 7 restructure.
import { escapeHtml } from './utils';
import { ensureResultsShownForTool } from './results-state';
import { __kustoApplyResultsVisibility } from '../sections/query-execution.controller';
import { lastRunCacheEnabledByBoxId } from '../sections/query-execution.controller';
import { queryEditors } from './state';
import { __kustoAutoFindInQueryEditor } from '../monaco/monaco';
import {
	__kustoBuildErrorUxModel,
	__kustoStripLinePositionTokens,
} from '../shared/error-parser';

let _errorLocationClickHandlerInstalled = false;

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
