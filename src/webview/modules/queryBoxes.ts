// Query boxes module — converted from legacy/queryBoxes.js
// Window bridge exports at bottom for remaining legacy callers.
export {};

const _win = window as unknown as Record<string, any>;

// Diagnostics logging — no-op (was removed from original source, callers remain).
function __kustoLog(_boxId?: any, _event?: any, _message?: any, _data?: any, _level?: any) { return; }
(window as any).__kustoLog = __kustoLog;

function __kustoIndexToAlphaName( index: any) {
	// Excel-like column naming: 0->A, 25->Z, 26->AA, ...
	try {
		let n = Math.max(0, Math.floor(Number(index) || 0));
		let out = '';
		while (true) {
			const r = n % 26;
			out = String.fromCharCode(65 + r) + out;
			n = Math.floor(n / 26) - 1;
			if (n < 0) break;
		}
		return out || 'A';
	} catch {
		return 'A';
	}
}

function __kustoGetUsedSectionNamesUpper( excludeBoxId: any) {
	const used = new Set();
	try {
		const container = document.getElementById('queries-container') as any;
		if (container) {
			const children = Array.from(container.children || []);
			for (const child of children as any[]) {
				try {
					if (!child || !child.id) continue;
					if (excludeBoxId && child.id === excludeBoxId) continue;
					// Try Lit element first.
					if (typeof child.getName === 'function') {
						const v = String(child.getName() || '').trim();
						if (v) used.add(v.toUpperCase());
						continue;
					}
					// Legacy fallback: look for input.query-name inside.
					const input = child.querySelector ? child.querySelector('input.query-name') : null;
					if (input) {
						const v = String(input.value || '').trim();
						if (v) used.add(v.toUpperCase());
					}
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }
	return used;
}

function __kustoPickNextAvailableSectionLetterName( excludeBoxId: any) {
	try {
		const used = __kustoGetUsedSectionNamesUpper(excludeBoxId);
		for (let i = 0; i < 5000; i++) {
			const candidate = __kustoIndexToAlphaName(i).toUpperCase();
			if (!used.has(candidate)) {
				return candidate;
			}
		}
	} catch {
		// ignore
	}
	return 'A';
}

function __kustoEnsureSectionHasDefaultNameIfMissing( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return '';
		const current = __kustoGetSectionName(id);
		if (current) return current;
		const next = __kustoPickNextAvailableSectionLetterName(id);
		__kustoSetSectionName(id, next);
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		return next;
	} catch {
		return '';
	}
}

// Expose for persistence + extra box types.
try {
	(window as any).__kustoPickNextAvailableSectionLetterName = __kustoPickNextAvailableSectionLetterName;
	(window as any).__kustoEnsureSectionHasDefaultNameIfMissing = __kustoEnsureSectionHasDefaultNameIfMissing;
} catch { /* ignore */ }

// ── Global accessor helpers for query section connection/database ──────────
// These functions abstract access to the connection/database state,
// working with both the Lit <kw-query-section> element's public API.
// Use these instead of document.getElementById(boxId + '_connection').
function __kustoGetConnectionId( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getConnectionId === 'function') return el.getConnectionId();
	} catch { /* ignore */ }
	return '';
}

function __kustoGetDatabase( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getDatabase === 'function') return el.getDatabase();
	} catch { /* ignore */ }
	return '';
}

function __kustoGetClusterUrl( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getClusterUrl === 'function') return el.getClusterUrl();
	} catch { /* ignore */ }
	return '';
}

function __kustoGetQuerySectionElement( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getConnectionId === 'function') return el;
	} catch { /* ignore */ }
	return null;
}

// Expose globally for other modules (main.js, monaco.js, schema.js, copilotQueryBoxes.js).
try {
	(window as any).__kustoGetConnectionId = __kustoGetConnectionId;
	(window as any).__kustoGetDatabase = __kustoGetDatabase;
	(window as any).__kustoGetClusterUrl = __kustoGetClusterUrl;
	(window as any).__kustoGetQuerySectionElement = __kustoGetQuerySectionElement;
} catch { /* ignore */ }

function __kustoGetSectionName( boxId: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.getName === 'function') return el.getName();
	} catch { /* ignore */ }
	return '';
}

function __kustoSetSectionName( boxId: any, name: any) {
	try {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.setName === 'function') { el.setName(String(name || '')); return; }
	} catch { /* ignore */ }
}

try {
	(window as any).__kustoGetSectionName = __kustoGetSectionName;
	(window as any).__kustoSetSectionName = __kustoSetSectionName;
} catch { /* ignore */ }

function addQueryBox( options: any) {
	const isFirstBox = !(Array.isArray(_win.queryBoxes) && _win.queryBoxes.length > 0);
	const id = (options && options.id) ? String(options.id) : ('query_' + Date.now());
	const initialQuery = (options && options.initialQuery) ? String(options.initialQuery) : '';
	const isComparison = !!(options && options.isComparison);
	const defaultResultsVisible = (options && typeof options.defaultResultsVisible === 'boolean') ? !!options.defaultResultsVisible : true;
	const defaultComparisonSummaryVisible = isComparison ? true : ((options && typeof options.defaultComparisonSummaryVisible === 'boolean') ? !!options.defaultComparisonSummaryVisible : true);
	const defaultExpanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	_win.queryBoxes.push(id);

	const container = document.getElementById('queries-container') as any;

	// ── SVG icons used by toolbar buttons (light DOM) ──
	// Header/connection row icons (cluster, database, refresh, favorites, schema, close,
	// maximize, share) are now in kw-query-section.ts shadow DOM and deleted from here.

	const caretDocsIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3.5h10v9H3v-9z"/>' +
		'<path d="M3 6h10"/>' +
		'<path d="M5 8.2h6"/>' +
		'<path d="M5 10.4h4.2"/>' +
		'</svg>';

	const autocompleteIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 4.5h10"/>' +
		'<path d="M3 7.5h6"/>' +
		'<path d="M3 10.5h4"/>' +
		'<path d="M10.2 9.2l2.3 2.3"/>' +
		'<path d="M12.5 9.2v2.3h-2.3"/>' +
		'</svg>';

	// Ghost icon for inline/ghost text completions
	const ghostIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M8 1C5.2 1 3 3.2 3 6v6c0 .3.1.6.4.8.2.2.5.2.8.1l1.3-.7 1.3.7c.3.2.7.2 1 0L8 12.2l.2.7c.3.2.7.2 1 0l1.3-.7 1.3.7c.3.1.6.1.8-.1.3-.2.4-.5.4-.8V6c0-2.8-2.2-5-5-5zm-2 6.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm4 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/>' +
		'</svg>';

	// Compare queries icon: two panels with left-right arrows showing comparison
	// Simple bold design that reads well at small sizes
	const diffIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		// Left panel
		'<rect x="1.5" y="3" width="4.5" height="10" rx="1" />' +
		// Right panel
		'<rect x="10" y="3" width="4.5" height="10" rx="1" />' +
		// Comparison arrows in center: arrows pointing toward each other
		'<path d="M7 6l1.5 1.5L7 9" />' +
		'<path d="M9 6l-1.5 1.5L9 9" />' +
		'</svg>';

	const copilotLogoUri = (() => {
		try {
			return ((window as any).__kustoQueryEditorConfig && (window as any).__kustoQueryEditorConfig.copilotLogoUri)
				? String((window as any).__kustoQueryEditorConfig.copilotLogoUri)
				: '';
		} catch {
			return '';
		}
	})();
	const copilotLogoHtml = copilotLogoUri
		? ('<img class="copilot-logo" src="' + copilotLogoUri + '" alt="" aria-hidden="true" />')
		: (
			'<svg class="copilot-logo-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
			'<rect x="3" y="3" width="10" height="9" rx="2" />' +
			'<path d="M6 12v1" />' +
			'<path d="M10 12v1" />' +
			'<circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" />' +
			'<circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" />' +
			'<path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" />' +
			'</svg>'
		);

	const optimizeOrAcceptHtml = isComparison
		? ('<button class="accept-optimizations-btn" id="' + id + '_accept_btn" onclick="acceptOptimizations(\'' + id + '\')" disabled ' +
			'title="Run both queries to compare results. This will be enabled when the optimized query has results." aria-label="Accept Optimizations">Accept Optimizations</button>')
		: (
			'<span class="optimize-inline" id="' + id + '_optimize_inline">' +
				'<button class="optimize-query-btn" id="' + id + '_optimize_btn" onclick="optimizeQueryWithCopilot(\'' + id + '\', null, { skipExecute: true })" ' +
					'title="Compare two queries" aria-label="Compare two queries">' +
					diffIconSvg +
				'</button>' +
			'</span>'
		);

	const toolsIconSvg = '<span class="codicon codicon-tools" aria-hidden="true"></span>';

	const toolsDropdownHtml =
		'<span class="qe-toolbar-menu-wrapper" id="' + id + '_tools_wrapper">' +
			'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn qe-toolbar-dropdown-btn" id="' + id + '_tools_btn" onclick="toggleToolsDropdown(\'' + id + '\'); event.stopPropagation();" title="Tools" aria-label="Tools" aria-haspopup="listbox" aria-expanded="false">' +
				'<span class="qe-icon qe-tools-icon" aria-hidden="true">' + toolsIconSvg + '</span>' +
				'<span class="qe-toolbar-caret" aria-hidden="true"><svg width="8" height="8" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 2.5L4 5.5L6.5 2.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg></span>' +
				'<span class="schema-spinner qe-tools-spinner" aria-hidden="true" style="display:none;"></span>' +
			'</button>' +
			'<div class="kusto-dropdown-menu qe-toolbar-dropdown-menu" id="' + id + '_tools_menu" role="listbox" tabindex="-1" style="display:none;"></div>' +
		'</span>';
	const toolbarHtml =
		'<div class="query-editor-toolbar" role="toolbar" aria-label="Editor tools" id="' + id + '_toolbar">' +
		'<div class="qe-toolbar-items">' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn qe-undo-btn" data-qe-overflow-action="undo" data-qe-overflow-label="Undo" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'undo\')" title="Undo (Ctrl+Z)" aria-label="Undo">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn qe-redo-btn" data-qe-overflow-action="redo" data-qe-overflow-label="Redo" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'redo\')" title="Redo (Ctrl+Y)" aria-label="Redo">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn" data-qe-overflow-action="prettify" data-qe-overflow-label="Prettify query" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'prettify\')" title="Prettify query\nApplies Kusto-aware formatting rules (summarize/where/function headers)">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>' +
		'</span>' +
		'</button>' +
		toolsDropdownHtml +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn" data-qe-overflow-action="search" data-qe-overflow-label="Search" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'search\')" title="Search\nFind in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M6.5 2a4.5 4.5 0 1 0 2.67 8.13l3.02 3.02a.75.75 0 0 0 1.06-1.06l-3.02-3.02A4.5 4.5 0 0 0 6.5 2zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn" data-qe-overflow-action="replace" data-qe-overflow-label="Search and replace" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'replace\')" title="Search and replace\nFind and replace in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M2.5 4.5h8V3l3 2.5-3 2.5V6.5h-8v-2zM13.5 11.5h-8V13l-3-2.5 3-2.5v1.5h8v2z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" id="' + id + '_auto_autocomplete_toggle" data-qe-overflow-action="autoAutocomplete" data-qe-overflow-label="Auto-completions as you type" class="unified-btn-secondary query-editor-toolbar-btn query-editor-toolbar-toggle qe-auto-autocomplete-toggle' + (_win.autoTriggerAutocompleteEnabled ? ' is-active' : '') + '" onclick="toggleAutoTriggerAutocompleteEnabled()" title="Automatically trigger schema-based completions dropdown as you type\nShortcut for manual trigger: CTRL + SPACE" aria-pressed="' + (_win.autoTriggerAutocompleteEnabled ? 'true' : 'false') + '" aria-label="Automatically trigger schema-based completions dropdown as you type">' +
		'<span class="qe-icon" aria-hidden="true">' + autocompleteIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_copilot_inline_toggle" data-qe-overflow-action="copilotInline" data-qe-overflow-label="Copilot inline suggestions" class="unified-btn-secondary query-editor-toolbar-btn query-editor-toolbar-toggle qe-copilot-inline-toggle' + (_win.copilotInlineCompletionsEnabled ? ' is-active' : '') + '" onclick="toggleCopilotInlineCompletionsEnabled()" title="Automatically trigger Copilot inline completions (ghost text) as you type\nShortcut for manual trigger: SHIFT + SPACE" aria-pressed="' + (_win.copilotInlineCompletionsEnabled ? 'true' : 'false') + '" aria-label="Copilot inline suggestions">' +
		'<span class="qe-icon" aria-hidden="true">' + ghostIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_caret_docs_toggle" data-qe-overflow-action="caretDocs" data-qe-overflow-label="Smart documentation" class="unified-btn-secondary query-editor-toolbar-btn query-editor-toolbar-toggle' + (_win.caretDocsEnabled ? ' is-active' : '') + '" onclick="toggleCaretDocsEnabled()" title="Smart documentation\nShows Kusto documentation based on cursor placement (not on mouse hover; on actual cursor placement inside the editor)" aria-pressed="' + (_win.caretDocsEnabled ? 'true' : 'false') + '">' +
		'<span class="qe-icon" aria-hidden="true">' + caretDocsIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_copilot_chat_toggle" data-qe-overflow-action="copilotChat" data-qe-overflow-label="Copilot chat" class="unified-btn-secondary query-editor-toolbar-btn query-editor-toolbar-toggle kusto-copilot-chat-toggle" onclick="__kustoToggleCopilotChatForBox(\'' + id + '\')" title="Copilot chat\nGenerate and run a query with GitHub Copilot" aria-pressed="false" aria-label="Toggle Copilot chat" disabled aria-disabled="true" data-kusto-disabled-by-copilot="1">' +
		'<span class="qe-icon" aria-hidden="true">' + copilotLogoHtml + '</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn" data-qe-overflow-action="exportPowerBI" data-qe-overflow-label="Export to Power BI" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'exportPowerBI\')" title="Export to Power BI\nCopies a Power Query (M) snippet to your clipboard for pasting into Power BI">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="10" width="3" height="4"/><rect x="6" y="6" width="3" height="8"/><rect x="10" y="3" width="3" height="11"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="unified-btn-secondary query-editor-toolbar-btn" data-qe-overflow-action="copyAdeLink" data-qe-overflow-label="Share query as link" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'copyAdeLink\')" title="Share query as link (Azure Data Explorer)\nCopies a shareable URL to your clipboard containing the cluster, database and active query" aria-label="Share query as link (Azure Data Explorer)">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<span class="codicon codicon-link" aria-hidden="true"></span>' +
		'</span>' +
		'</button>' +
		'</div>' +
		'<span class="qe-toolbar-overflow-wrapper" id="' + id + '_toolbar_overflow_wrapper">' +
			'<button type="button" class="qe-toolbar-overflow-btn" id="' + id + '_toolbar_overflow_btn" onclick="toggleToolbarOverflow(\'' + id + '\'); event.stopPropagation();" title="More actions" aria-label="More actions" aria-haspopup="true" aria-expanded="false">' +
				'<span aria-hidden="true">···</span>' +
			'</button>' +
			'<div class="qe-toolbar-overflow-menu kusto-dropdown-menu" id="' + id + '_toolbar_overflow_menu" role="menu" tabindex="-1" style="display:none;"></div>' +
		'</span>' +
		'</div>';

	// ── Connection row is now rendered by <kw-query-section> shadow DOM ──
	// No dropdown HTML generation needed — the Lit component handles cluster,
	// database, favorites, refresh, favorite toggle, schema info popover.

	const boxHtml =
		'<kw-query-section class="query-box' + (isComparison ? ' is-optimized-comparison' : '') + '" id="' + id + '" box-id="' + id + '">' +
		'<div class="query-editor-wrapper">' +
		toolbarHtml +
		'<div class="qe-editor-clip">' +
		'<div class="qe-caret-docs-banner" id="' + id + '_caret_docs" style="display:none;" role="status" aria-live="polite">' +
		'<div class="qe-caret-docs-text" id="' + id + '_caret_docs_text"></div>' +
		'</div>' +
		'<div class="qe-missing-clusters-banner" id="' + id + '_missing_clusters" style="display:none;" role="status" aria-live="polite">' +
		'<div class="qe-missing-clusters-text" id="' + id + '_missing_clusters_text"></div>' +
		'<div class="qe-missing-clusters-actions">' +
		'<button type="button" class="unified-btn-primary qe-missing-clusters-btn" onclick="addMissingClusterConnections(\'' + id + '\')">Add connections</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor" id="' + id + '_query_editor"></div>' +
		'<div class="query-editor-placeholder" id="' + id + '_query_placeholder">Enter your KQL query here...</div>' +
		'<div class="query-editor-resizer" id="' + id + '_query_resizer" title="Drag to resize editor\nDouble-click to fit to contents"></div>' +
		'</div>' +
		'</div>' +
		'<div class="query-actions">' +
		'<div class="query-run">' +
		'<div class="unified-btn-split" id="' + id + '_run_split">' +
		'<button class="unified-btn-split-main" id="' + id + '_run_btn" onclick="executeQuery(\'' + id + '\')" disabled title="Run Query (take 100)\nSelect a cluster and database first (or select a favorite)">▶<span class="run-btn-label"> Run Query (take 100)</span></button>' +
		'<button class="unified-btn-split-toggle" id="' + id + '_run_toggle" onclick="toggleRunMenu(\'' + id + '\'); event.stopPropagation();" aria-label="Run query options" title="Run query options"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></button>' +
		'<div class="unified-btn-split-menu" id="' + id + '_run_menu" role="menu">' +
		'<div class="unified-btn-split-menu-item" role="menuitem" onclick="__kustoApplyRunModeFromMenu(\'' + id + '\', \'plain\');">Run Query</div>' +
		'<div class="unified-btn-split-menu-item" role="menuitem" onclick="__kustoApplyRunModeFromMenu(\'' + id + '\', \'take100\');">Run Query (take 100)</div>' +
		'<div class="unified-btn-split-menu-item" role="menuitem" onclick="__kustoApplyRunModeFromMenu(\'' + id + '\', \'sample100\');">Run Query (sample 100)</div>' +
		'</div>' +
		'</div>' +
		optimizeOrAcceptHtml +
		'' +
		'<span class="query-exec-status" id="' + id + '_exec_status" style="display: none;">' +
		'<span class="query-spinner" aria-hidden="true"></span>' +
		'<span id="' + id + '_exec_elapsed">0:00</span>' +
		'</span>' +
		'<button class="refresh-btn cancel-btn" id="' + id + '_cancel_btn" onclick="cancelQuery(\'' + id + '\')" style="display: none;" title="Cancel running query" aria-label="Cancel running query">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<circle cx="8" cy="8" r="6" />' +
		'<path d="M5.5 5.5l5 5" />' +
		'<path d="M10.5 5.5l-5 5" />' +
		'</svg>' +
		'</button>' +
		'</div>' +
		'<div class="cache-controls">' +
		'<span class="cache-label" id="' + id + '_cache_label" onclick="toggleCachePopup(\'' + id + '\')" title="Click to configure cache duration">Cache results</span>' +
		'<input type="checkbox" id="' + id + '_cache_enabled" checked onchange="toggleCachePill(\'' + id + '\'); try{schedulePersist&&schedulePersist()}catch{}" class="cache-checkbox" title="Toggle result caching" />' +
		'<div class="cache-popup" id="' + id + '_cache_popup">' +
		'<div class="cache-popup-content">' +
		'<span class="cache-popup-label">Cache results for</span>' +
		'<div class="cache-popup-inputs">' +
		'<input type="number" id="' + id + '_cache_value" value="1" min="1" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'<select id="' + id + '_cache_unit" onchange="try{schedulePersist&&schedulePersist()}catch{}">' +
		'<option value="minutes">Minutes</option>' +
		'<option value="hours">Hours</option>' +
		'<option value="days" selected>Days</option>' +
		'</select>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="results-wrapper" id="' + id + '_results_wrapper" style="display: none;" data-kusto-no-editor-focus="true">' +
		'<div class="results" id="' + id + '_results"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_results_resizer" title="Drag to resize results\nDouble-click to fit to contents"></div>' +
		'</div>' +
		'</kw-query-section>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	// Do not auto-assign a name; section names are user-defined unless explicitly set by a feature.
	try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
	setRunMode(id, 'take100');

	// ── Wire up <kw-query-section> event listeners ──
	const kwEl = document.getElementById(id) as any;
	if (kwEl) {
		kwEl.addEventListener('connection-changed', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			// Clear schema so it doesn't mismatch.
			try { delete _win.schemaByBoxId[boxId]; } catch { /* ignore */ }
			try { if (_win.schemaFetchInFlightByBoxId) _win.schemaFetchInFlightByBoxId[boxId] = false; } catch { /* ignore */ }
			try { if (_win.lastSchemaRequestAtByBoxId) _win.lastSchemaRequestAtByBoxId[boxId] = 0; } catch { /* ignore */ }
			try { if ((window as any).__kustoSchemaRequestTokenByBoxId) delete (window as any).__kustoSchemaRequestTokenByBoxId[boxId]; } catch { /* ignore */ }
			try { if (typeof _win.setSchemaLoading === 'function') _win.setSchemaLoading(boxId, false); } catch { /* ignore */ }
			// Persist selection.
			try {
				if (!_win.__kustoRestoreInProgress) {
					(_win.vscode as any).postMessage({
						type: 'saveLastSelection',
						connectionId: String(detail.connectionId || ''),
						database: ''
					});
				}
			} catch { /* ignore */ }
			// Load database list.
			if (detail.connectionId) {
				try {
					const cid = String(detail.connectionId || '').trim();
					const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
					const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
					let clusterKey = '';
					if (clusterUrl) {
						let u = clusterUrl;
						if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
						try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
					}
					const cached = (_win.cachedDatabases && _win.cachedDatabases[clusterKey]) || _win.cachedDatabases[detail.connectionId];
					if (cached && cached.length > 0) {
						if (typeof kwEl.setDatabases === 'function') kwEl.setDatabases(cached);
						// Background refresh
						(_win.vscode as any).postMessage({ type: 'getDatabases', connectionId: detail.connectionId, boxId: boxId });
						try { if (typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(true); } catch { /* ignore */ }
					} else {
						if (typeof kwEl.setDatabasesLoading === 'function') kwEl.setDatabasesLoading(true);
						(_win.vscode as any).postMessage({ type: 'getDatabases', connectionId: detail.connectionId, boxId: boxId });
					}
				} catch { /* ignore */ }
			}
			try { __kustoUpdateFavoritesUiForBox(boxId); } catch { /* ignore */ }
			try { if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') (window as any).__kustoUpdateRunEnabledForBox(boxId); } catch { /* ignore */ }
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		});
		kwEl.addEventListener('database-changed', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { _win.onDatabaseChanged(boxId); } catch { /* ignore */ }
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		});
		kwEl.addEventListener('refresh-databases', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { refreshDatabases(boxId); } catch { /* ignore */ }
		});
		kwEl.addEventListener('favorite-toggle', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { toggleFavoriteForBox(boxId); } catch { /* ignore */ }
		});
		kwEl.addEventListener('favorites-mode-changed', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try {
				if (typeof _win.favoritesModeByBoxId === 'object') {
					_win.favoritesModeByBoxId[boxId] = !!detail.favoritesMode;
				}
			} catch { /* ignore */ }
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		});
		kwEl.addEventListener('favorite-selected', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try {
				// Connection changed — load databases and select the favorite's database.
				if (detail.connectionId) {
					(_win.vscode as any).postMessage({ type: 'getDatabases', connectionId: detail.connectionId, boxId: boxId });
				}
			} catch { /* ignore */ }
			try { if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') (window as any).__kustoUpdateRunEnabledForBox(boxId); } catch { /* ignore */ }
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		});
		kwEl.addEventListener('favorite-removed', (e: any) => {
			const detail = e.detail || {};
			try { removeFavorite(detail.clusterUrl, detail.database); } catch { /* ignore */ }
		});
		kwEl.addEventListener('schema-refresh', (e: any) => {
			const detail = e.detail || {};
			const boxId = detail.boxId || id;
			try { _win.refreshSchema(boxId); } catch { /* ignore */ }
		});
	}

	// Default the connection to the query box above this one (if any).
	// This provides a better UX when adding multiple queries against the same cluster/database.
	try {
		if (!options || (!options.clusterUrl && !options.database)) {
			// Find the previous query box in the DOM (by iterating container children).
			const children = container ? Array.from(container.children || []) as any[] : [];
			let prevQueryBoxId = null;
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				const childId = child && child.id ? String(child.id) : '';
				if (childId === id) continue;
				if (childId.startsWith('query_')) {
					prevQueryBoxId = childId;
					break;
				}
			}
			if (prevQueryBoxId) {
				const prevEl = document.getElementById(prevQueryBoxId) as any;
				const prevConnId = prevEl && typeof prevEl.getConnectionId === 'function' ? prevEl.getConnectionId() : '';
				const prevDb = prevEl && typeof prevEl.getDatabase === 'function' ? prevEl.getDatabase() : '';
				if (prevConnId) {
					let prevClusterUrl = '';
					try {
						const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '') === prevConnId) : null;
						prevClusterUrl = conn ? String(conn.clusterUrl || '') : '';
					} catch { /* ignore */ }
					if (prevClusterUrl && kwEl && typeof kwEl.setDesiredClusterUrl === 'function') {
						kwEl.setDesiredClusterUrl(prevClusterUrl);
					}
					if (prevDb && kwEl && typeof kwEl.setDesiredDatabase === 'function') {
						kwEl.setDesiredDatabase(prevDb);
					}
				}
			}
		}
	} catch { /* ignore */ }

	updateConnectionSelects();
	// For newly added sections, if the prefilled cluster+db matches an existing favorite,
	// automatically switch to Favorites mode.
	try {
		if (!isComparison) {
			__kustoMarkNewBoxForFavoritesAutoEnter(id);
			__kustoTryAutoEnterFavoritesModeForNewBox(id);
		}
	} catch { /* ignore */ }
	// If this is the first section and the user has favorites, default to Favorites mode.
	// (Otherwise, keep the normal cluster+database dropdowns visible.)
	try {
		if (isFirstBox && typeof (window as any).__kustoMaybeDefaultFirstBoxToFavoritesMode === 'function') {
			(window as any).__kustoMaybeDefaultFirstBoxToFavoritesMode();
		}
	} catch { /* ignore */ }
	_win.initQueryEditor(id);

	// Default visibility state (results + comparison summary)
	try {
		if (!(window as any).__kustoResultsVisibleByBoxId || typeof (window as any).__kustoResultsVisibleByBoxId !== 'object') {
			(window as any).__kustoResultsVisibleByBoxId = {};
		}
		(window as any).__kustoResultsVisibleByBoxId[id] = defaultResultsVisible;
	} catch { /* ignore */ }
	// Default section visibility state (expanded/collapsed)
	try {
		if (!(window as any).__kustoQueryExpandedByBoxId || typeof (window as any).__kustoQueryExpandedByBoxId !== 'object') {
			(window as any).__kustoQueryExpandedByBoxId = {};
		}
		(window as any).__kustoQueryExpandedByBoxId[id] = defaultExpanded;
	} catch { /* ignore */ }
	try {
		if (!(window as any).__kustoComparisonSummaryVisibleByBoxId || typeof (window as any).__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			(window as any).__kustoComparisonSummaryVisibleByBoxId = {};
		}
		(window as any).__kustoComparisonSummaryVisibleByBoxId[id] = isComparison ? true : defaultComparisonSummaryVisible;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryVisibilityToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyQueryBoxVisibility(id); } catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(id); } catch { /* ignore */ }
	try { __kustoUpdateComparisonSummaryToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(id); } catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(id); } catch { /* ignore */ }

	// Drag handle resize for results output.
	try {
		const wrapper = document.getElementById(id + '_results_wrapper') as any;
		const resizer = document.getElementById(id + '_results_resizer') as any;
		if (wrapper && resizer) {
			const computeResizeBounds = () => {
				let minHeight = 120;
				let maxHeight = 900;
				try {
					const resultsEl = document.getElementById(id + '_results') as any;
					// Detect table content: legacy .table-container OR <kw-data-table> element.
					const hasLegacyTable = !!(resultsEl && resultsEl.querySelector && resultsEl.querySelector('.table-container'));
					const dataTableEl = resultsEl && resultsEl.querySelector ? resultsEl.querySelector('kw-data-table') : null;
					if (hasLegacyTable) {
						return { minHeight, maxHeight };
					}
					// <kw-data-table>: cap maxHeight to fit all rows (no blank space below).
					if (dataTableEl) {
						try {
							if (typeof dataTableEl.getContentHeight === 'function') {
								const contentH = dataTableEl.getContentHeight();
								if (contentH > 0) {
									// Add wrapper chrome: resizer + border-top.
									const resizerEl = document.getElementById(id + '_results_resizer') as any;
									const resizerH = resizerEl ? resizerEl.getBoundingClientRect().height : 12;
									maxHeight = Math.max(minHeight, Math.min(900, contentH + resizerH + 1));
								}
							}
						} catch { /* ignore */ }
						return { minHeight, maxHeight };
					}
					if (!resultsEl) {
						return { minHeight, maxHeight };
					}

					const wrapperH = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height || 0));
					const resultsClientH = Math.max(0, (resultsEl.clientHeight || 0));
					const overheadPx = Math.max(0, wrapperH - resultsClientH);

					let contentPx = 0;
					const children = resultsEl.children ? Array.from(resultsEl.children) : [];
					if (children.length) {
						for (const child of children as any[]) {
							try {
								const rectH = Math.max(0, Math.ceil(child.getBoundingClientRect().height || 0));
								let margin = 0;
								try {
									const cs = getComputedStyle(child);
									margin += parseFloat(cs.marginTop || '0') || 0;
									margin += parseFloat(cs.marginBottom || '0') || 0;
								} catch { /* ignore */ }
								contentPx += rectH + Math.ceil(margin);
							} catch { /* ignore */ }
						}
					} else {
						const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
						contentPx = headerEl ? Math.max(0, Math.ceil(headerEl.getBoundingClientRect().height || 0)) : 0;
					}

					const desiredPx = Math.max(0, Math.ceil(overheadPx + contentPx + 8));
					maxHeight = Math.min(900, desiredPx);
					minHeight = Math.min(maxHeight, Math.max(24, Math.ceil(overheadPx + 8)));
				} catch { /* ignore */ }
				return { minHeight, maxHeight };
			};

			resizer.addEventListener('mousedown', (e: any) => {
				try {
					e.preventDefault();
					e.stopPropagation();
				} catch {
					// ignore
				}
				try { wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }

				resizer.classList.add('is-dragging');
				const previousCursor = document.body.style.cursor;
				const previousUserSelect = document.body.style.userSelect;
				document.body.style.cursor = 'ns-resize';
				document.body.style.userSelect = 'none';

				const startPageY = e.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent: any) => {
					try {
						if (typeof _win.__kustoMaybeAutoScrollWhileDragging === 'function') {
							_win.__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof _win.__kustoGetScrollY === 'function' ? _win.__kustoGetScrollY() : 0);
					const delta = pageY - startPageY;
					const bounds = computeResizeBounds();
					const minHeight = (bounds && typeof bounds.minHeight === 'number') ? bounds.minHeight : 24;
					const maxHeight = (bounds && typeof bounds.maxHeight === 'number') ? bounds.maxHeight : 900;
					const nextHeight = Math.max(minHeight, Math.min(maxHeight, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try {
						// Ensure we never leave slack after a drag on error-only content.
						if (typeof (window as any).__kustoClampResultsWrapperHeight === 'function') {
							(window as any).__kustoClampResultsWrapperHeight(id);
						}
					} catch { /* ignore */ }
					try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});

			// Double-click on the results resizer: auto-size results to fit contents.
			resizer.addEventListener('dblclick', () => {
				try {
					__kustoAutoSizeResults(id);
				} catch { /* ignore */ }
			});
		}
	} catch {
		// ignore
	}

	// Clamp the query results output wrapper height so it cannot be taller than its contents.
	// This avoids blank slack below short error messages while still allowing the user to
	// resize smaller than contents (scrolling).
	try {
		if (typeof (window as any).__kustoClampResultsWrapperHeight !== 'function') {
			(window as any).__kustoClampResultsWrapperHeight = function (boxId: any) {
				try {
					const bid = String(boxId || '').trim();
					if (!bid) return;
					const w = document.getElementById(bid + '_results_wrapper') as any;
					const resultsEl = document.getElementById(bid + '_results') as any;
					if (!w || !resultsEl) return;
					// If we have a table container (legacy or kw-data-table), results are intentionally scrollable; don't clamp.
					if (resultsEl.querySelector && (resultsEl.querySelector('.table-container') || resultsEl.querySelector('kw-data-table'))) return;

					const wrapperH = Math.max(0, Math.ceil(w.getBoundingClientRect().height || 0));
					const resultsClientH = Math.max(0, (resultsEl.clientHeight || 0));
					const overheadPx = Math.max(0, wrapperH - resultsClientH);

					let contentPx = 0;
					const children = resultsEl.children ? Array.from(resultsEl.children) : [];
					if (children.length) {
						for (const child of children as any[]) {
							try {
								const rectH = Math.max(0, Math.ceil(child.getBoundingClientRect().height || 0));
								let margin = 0;
								try {
									const cs = getComputedStyle(child);
									margin += parseFloat(cs.marginTop || '0') || 0;
									margin += parseFloat(cs.marginBottom || '0') || 0;
								} catch { /* ignore */ }
								contentPx += rectH + Math.ceil(margin);
							} catch { /* ignore */ }
						}
					} else {
						const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
						contentPx = headerEl ? Math.max(0, Math.ceil(headerEl.getBoundingClientRect().height || 0)) : 0;
					}

					const desiredPx = Math.max(0, Math.ceil(overheadPx + contentPx + 8));

					if (wrapperH > (desiredPx + 1)) {
						w.style.height = desiredPx + 'px';
						w.style.minHeight = '0';
						try {
							if (w.dataset && w.dataset.kustoUserResized === 'true') {
								w.dataset.kustoPrevHeight = w.style.height;
							}
						} catch { /* ignore */ }
					}
				} catch {
					// ignore
				}
			};
		}
	} catch { /* ignore */ }
	
	// Set initial query text if provided — use the pending-text map so the Monaco editor
	// picks it up reliably during async initialization (instead of a fragile setTimeout).
	if (initialQuery) {
		try {
			(window as any).__kustoPendingQueryTextByBoxId = (window as any).__kustoPendingQueryTextByBoxId || {};
			(window as any).__kustoPendingQueryTextByBoxId[id] = initialQuery;
		} catch { /* ignore */ }
	}
	
	// Check Copilot availability for this box
	try {
		(_win.vscode as any).postMessage({
			type: 'checkCopilotAvailability',
			boxId: id
		});
	} catch { /* ignore */ }
	
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		const controls = document.querySelector('.add-controls');
		if (controls && typeof controls.scrollIntoView === 'function') {
			controls.scrollIntoView({ block: 'end' });
		}
	} catch {
		// ignore
	}
	return id;
}

function __kustoAutoSizeEditor( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_query_editor') as any;
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const FIT_SLACK_PX = 5;
	const apply = () => {
		try {
			const ed = (typeof _win.queryEditors === 'object' && _win.queryEditors) ? _win.queryEditors[id] : null;
			if (!ed) return;
			let contentHeight = 0;
			try {
				const ch = (typeof ed.getContentHeight === 'function') ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch { /* ignore */ }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			const addVisibleRectHeight = (el: any) => {
				try {
					if (!el) return 0;
					const cs = getComputedStyle(el);
					if (cs && cs.display === 'none') return 0;
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					let margin = 0;
					try { margin += parseFloat(cs.marginTop || '0') || 0; margin += parseFloat(cs.marginBottom || '0') || 0; } catch { /* ignore */ }
					return Math.max(0, Math.ceil(h + margin));
				} catch { return 0; }
			};

			let chrome = 0;
			try { chrome += addVisibleRectHeight(wrapper.querySelector ? wrapper.querySelector('.query-editor-toolbar') : null); } catch { /* ignore */ }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			let clipExtras = 0;
			try {
				const clip = editorEl.closest ? editorEl.closest('.qe-editor-clip') : null;
				if (clip && clip.children) {
					for (const child of Array.from(clip.children)) {
						if (!child || child === editorEl) continue;
						clipExtras += addVisibleRectHeight(child);
					}
				}
				if (clip) {
					const csc = getComputedStyle(clip);
					clipExtras += (parseFloat(csc.paddingTop || '0') || 0) + (parseFloat(csc.paddingBottom || '0') || 0);
					clipExtras += (parseFloat(csc.borderTopWidth || '0') || 0) + (parseFloat(csc.borderBottomWidth || '0') || 0);
				}
			} catch { /* ignore */ }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + clipExtras + contentHeight + FIT_SLACK_PX)));
			wrapper.style.height = desired + 'px';
			wrapper.style.minHeight = '0';
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			try { if (typeof ed.layout === 'function') ed.layout(); } catch { /* ignore */ }
		} catch { /* ignore */ }
	};
	try { apply(); setTimeout(apply, 50); setTimeout(apply, 150); } catch { /* ignore */ }
}

function __kustoAutoSizeResults( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const w = document.getElementById(id + '_results_wrapper') as any;
	const resultsEl = document.getElementById(id + '_results') as any;
	if (!w || !resultsEl) return;
	try { if (getComputedStyle(w).display === 'none') return; } catch { /* ignore */ }

	const dataTableEl = resultsEl.querySelector ? resultsEl.querySelector('kw-data-table') : null;
	if (dataTableEl && typeof dataTableEl.getContentHeight === 'function') {
		const contentH = dataTableEl.getContentHeight();
		if (contentH > 0) {
			// Wrapper chrome: resizer + border-top.
			const resizerEl = document.getElementById(id + '_results_resizer') as any;
			const resizerH = resizerEl ? resizerEl.getBoundingClientRect().height : 12;
			const wrapperBorder = 1;
			const desiredPx = contentH + resizerH + wrapperBorder;
			// Cap: heightNeededToShowAllRows or 750px, whichever is smaller.
			w.style.height = Math.max(120, Math.min(750, Math.ceil(desiredPx))) + 'px';
			w.style.minHeight = '0';
			try { if (w.dataset) w.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		}
		return;
	}

	// Legacy fallback for non-kw-data-table results (errors, old table-container, etc.)
	try {
		let chrome = 0;
		try {
			for (const child of Array.from(w.children || []) as any[]) {
				if (!child || child === resultsEl) continue;
				try { if (getComputedStyle(child).display === 'none') continue; } catch { /* ignore */ }
				chrome += (child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0);
			}
		} catch { /* ignore */ }
		try {
			const csw = getComputedStyle(w);
			chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
			chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
		} catch { /* ignore */ }

		let contentH = 0;
		try {
			for (const child of Array.from(resultsEl.children || []) as any[]) {
				try {
					const cs = getComputedStyle(child);
					if (cs && cs.display === 'none') continue;
					const h = child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0;
					const margin = (parseFloat(cs.marginTop || '0') || 0) + (parseFloat(cs.marginBottom || '0') || 0);
					contentH += Math.ceil(h + margin);
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		if (contentH > 0) {
			const desiredPx = Math.max(24, Math.min(900, Math.ceil(chrome + contentH + 8)));
			w.style.height = desiredPx + 'px';
			w.style.minHeight = '0';
			try { if (w.dataset) w.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

function __kustoMaximizeQueryBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;

	// 1. Auto-size the Monaco editor.
	__kustoAutoSizeEditor(id);

	// 2. Auto-size the tabular results.
	__kustoAutoSizeResults(id);
	setTimeout(() => __kustoAutoSizeResults(id), 50);
	setTimeout(() => __kustoAutoSizeResults(id), 150);

	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateQueryVisibilityToggleButton( boxId: any) {
	// Toggle button is now in shadow DOM — the Lit element handles its own rendering
	// based on the _expanded state. Nothing to do here.
}

function __kustoApplyQueryBoxVisibility( boxId: any) {
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (!kwEl) return;
	let expanded = true;
	try {
		expanded = !((window as any).__kustoQueryExpandedByBoxId && (window as any).__kustoQueryExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	if (typeof kwEl.setExpanded === 'function') {
		kwEl.setExpanded(expanded);
	}
	// Monaco often needs a layout pass after being hidden/shown.
	if (expanded) {
		try {
			setTimeout(() => {
				try {
					const ed = (typeof _win.queryEditors === 'object' && _win.queryEditors) ? _win.queryEditors[boxId] : null;
					if (ed && typeof ed.layout === 'function') {
						ed.layout();
					}
					if (typeof (window as any).__kustoUpdateSchemaForFocusedBox === 'function') {
						(window as any).__kustoUpdateSchemaForFocusedBox(boxId, false);
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	}
}

function toggleQueryBoxVisibility( boxId: any) {
	try {
		if (!(window as any).__kustoQueryExpandedByBoxId || typeof (window as any).__kustoQueryExpandedByBoxId !== 'object') {
			(window as any).__kustoQueryExpandedByBoxId = {};
		}
		const current = !((window as any).__kustoQueryExpandedByBoxId[boxId] === false);
		(window as any).__kustoQueryExpandedByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoApplyQueryBoxVisibility(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoSetResultsVisible( boxId: any, visible: any) {
	try {
		if (!(window as any).__kustoResultsVisibleByBoxId || typeof (window as any).__kustoResultsVisibleByBoxId !== 'object') {
			(window as any).__kustoResultsVisibleByBoxId = {};
		}
		(window as any).__kustoResultsVisibleByBoxId[boxId] = !!visible;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
}

function __kustoLockCacheForBenchmark( boxId: any) {
	const msg = 'When doing performance benchmarks we cannot use caching.';
	try {
		const checkbox = document.getElementById(boxId + '_cache_enabled') as any;
		const valueInput = document.getElementById(boxId + '_cache_value') as any;
		const unitSelect = document.getElementById(boxId + '_cache_unit') as any;
		if (checkbox) {
			checkbox.checked = false;
			checkbox.disabled = true;
			checkbox.title = msg;
			try {
				const label = checkbox.closest('label');
				if (label) {
					label.title = msg;
				}
			} catch { /* ignore */ }
		}
		if (valueInput) {
			valueInput.disabled = true;
			valueInput.title = msg;
		}
		if (unitSelect) {
			unitSelect.disabled = true;
			unitSelect.title = msg;
		}
		try { toggleCacheControls(boxId); } catch { /* ignore */ }
		try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoNormalizeCellForComparison( cell: any) {
	const stripNumericGrouping = (s: any) => {
		try {
			return String(s).trim().replace(/[, _]/g, '');
		} catch {
			return '';
		}
	};
	const isNumericString = (s: any) => {
		try {
			const t = stripNumericGrouping(s);
			if (!t) return false;
			return /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(t);
		} catch {
			return false;
		}
	};
	const tryParseDateMs = (v: any) => {
		try {
			if (v instanceof Date) {
				const t = v.getTime();
				return isFinite(t) ? t : null;
			}
			const s = String(v).trim();
			if (!s) return null;
			// Don't treat pure numbers as dates.
			if (isNumericString(s)) return null;
			// First attempt: native parse
			let t = Date.parse(s);
			if (isFinite(t)) return t;
			// Kusto-ish: "YYYY-MM-DD HH:mm:ss(.fffffff)?(Z)?" -> convert to ISO-ish
			let iso = s;
			if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso)) {
				iso = iso.replace(' ', 'T');
			}
			// Trim fractional seconds beyond milliseconds for JS Date.parse
			iso = iso.replace(/\.(\d{3})\d+/, '.$1');
			// If it looks like a timestamp but lacks timezone, treat as UTC to stabilize comparisons.
			if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(iso)) {
				iso = iso + 'Z';
			}
			t = Date.parse(iso);
			return isFinite(t) ? t : null;
		} catch {
			return null;
		}
	};
	const stableStringify = (obj: any) => {
		const seen = new Set();
		const walk = (v: any): any => {
			if (v === null || v === undefined) return v;
			const t = typeof v;
			if (t === 'string' || t === 'number' || t === 'boolean') return v;
			if (v instanceof Date) {
				const ms = v.getTime();
				return isFinite(ms) ? { $date: ms } : { $date: String(v) };
			}
			if (t !== 'object') return String(v);
			if (seen.has(v)) return '[circular]';
			seen.add(v);
			if (Array.isArray(v)) {
				return v.map(walk);
			}
			const out: any = {};
			for (const k of Object.keys(v).sort()) {
				try {
					out[k] = walk(v[k]);
				} catch {
					out[k] = '[unreadable]';
				}
			}
			seen.delete(v);
			return out;
		};
		try {
			return JSON.stringify(walk(obj));
		} catch {
			try { return String(obj); } catch { return '[unstringifiable]'; }
		}
	};
	const normalize = (v: any) => {
		try {
			if (v === null || v === undefined) return ['n', null];
			const t = typeof v;
			if (t === 'number') {
				return ['num', isFinite(v) ? v : String(v)];
			}
			if (t === 'boolean') return ['bool', v ? 1 : 0];
			if (t === 'string') {
				const s = String(v);
				if (isNumericString(s)) {
					const num = parseFloat(stripNumericGrouping(s));
					if (isFinite(num)) return ['num', num];
				}
				const ms = tryParseDateMs(s);
				if (ms !== null) return ['date', ms];
				return ['str', s];
			}
			if (v instanceof Date) {
				const ms = v.getTime();
				return ['date', isFinite(ms) ? ms : String(v)];
			}
			if (t !== 'object') return ['p', t, String(v)];
			// Common table-cell wrapper used by this webview.
			if (v && typeof v === 'object' && 'full' in v && v.full !== undefined && v.full !== null) {
				return normalize(v.full);
			}
			if (v && typeof v === 'object' && 'display' in v && v.display !== undefined && v.display !== null) {
				return normalize(v.display);
			}
			return ['obj', stableStringify(v)];
		} catch {
			try { return ['obj', String(v)]; } catch { return ['obj', '[uncomparable]']; }
		}
	};

	try {
		return normalize(cell);
	} catch {
		try { return ['obj', String(cell)]; } catch { return ['obj', '[uncomparable]']; }
	}
}

function __kustoRowKeyForComparison( row: any) {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = r.map(__kustoNormalizeCellForComparison);
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoNormalizeColumnNameForComparison( name: any) {
	try {
		return String(name == null ? '' : name).trim().toLowerCase();
	} catch {
		return '';
	}
}

function __kustoGetNormalizedColumnNameList( state: any) {
	try {
		const cols = Array.isArray(state && state.columns) ? state.columns : [];
		return cols.map(__kustoNormalizeColumnNameForComparison);
	} catch {
		return [];
	}
}

function __kustoDoColumnHeaderNamesMatch( sourceState: any, comparisonState: any) {
	try {
		const a = __kustoGetNormalizedColumnNameList(sourceState).slice().sort();
		const b = __kustoGetNormalizedColumnNameList(comparisonState).slice().sort();
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoGetColumnDifferences( sourceState: any, comparisonState: any) {
	// Returns { onlyInA: string[], onlyInB: string[] } with original (non-normalized) column names.
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		const aNorm = aCols.map(__kustoNormalizeColumnNameForComparison);
		const bNorm = bCols.map(__kustoNormalizeColumnNameForComparison);
		const aSet = new Set(aNorm);
		const bSet = new Set(bNorm);
		const onlyInA = [];
		const onlyInB = [];
		for (let i = 0; i < aCols.length; i++) {
			if (!bSet.has(aNorm[i])) {
				onlyInA.push(String(aCols[i]));
			}
		}
		for (let i = 0; i < bCols.length; i++) {
			if (!aSet.has(bNorm[i])) {
				onlyInB.push(String(bCols[i]));
			}
		}
		return { onlyInA, onlyInB };
	} catch {
		return { onlyInA: [], onlyInB: [] };
	}
}

function __kustoDoColumnOrderMatch( sourceState: any, comparisonState: any) {
	try {
		const a = __kustoGetNormalizedColumnNameList(sourceState);
		const b = __kustoGetNormalizedColumnNameList(comparisonState);
		if (a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoDoRowOrderMatch( sourceState: any, comparisonState: any) {
	try {
		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) return false;
		// Build column mapping by name for consistent comparison.
		const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
		if (!columnHeaderNamesMatch) return false;
		const canonicalNames = __kustoGetNormalizedColumnNameList(sourceState).slice().sort();
		const aMap = __kustoBuildNameBasedColumnMapping(sourceState, canonicalNames);
		const bMap = __kustoBuildNameBasedColumnMapping(comparisonState, canonicalNames);
		const rowKeyForA = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, aMap);
		const rowKeyForB = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, bMap);
		for (let i = 0; i < aRows.length; i++) {
			if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) {
				return false;
			}
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoBuildColumnIndexMapForNames( state: any) {
	const cols = Array.isArray(state && state.columns) ? state.columns : [];
	const map = new Map();
	for (let i = 0; i < cols.length; i++) {
		const n = __kustoNormalizeColumnNameForComparison(cols[i]);
		if (!map.has(n)) {
			map.set(n, []);
		}
		map.get(n).push(i);
	}
	return map;
}

function __kustoBuildNameBasedColumnMapping( state: any, canonicalNames: any) {
	try {
		const map = __kustoBuildColumnIndexMapForNames(state);
		const mapping = [];
		for (const name of canonicalNames) {
			const list = map.get(name) || [];
			mapping.push(list.length ? list.shift() : -1);
			map.set(name, list);
		}
		return mapping;
	} catch {
		return [];
	}
}

function __kustoRowKeyForComparisonWithColumnMapping( row: any, mapping: any) {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = (mapping || []).map((idx: any) => __kustoNormalizeCellForComparison(idx >= 0 ? r[idx] : undefined));
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoRowKeyForComparisonIgnoringColumnOrder( row: any) {
	try {
		const r = Array.isArray(row) ? row : [];
		const parts = r.map(__kustoNormalizeCellForComparison).map((c: any) => {
			try { return JSON.stringify(c); } catch { return String(c); }
		});
		parts.sort();
		return JSON.stringify(parts);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoAreResultsEquivalentWithDetails( sourceState: any, comparisonState: any) {
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) {
			return {
				dataMatches: false,
				rowOrderMatches: false,
				columnOrderMatches: false,
				columnHeaderNamesMatch: false,
				reason: 'columnCountMismatch',
				columnCountA: aCols.length,
				columnCountB: bCols.length
			};
		}

		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) {
			return {
				dataMatches: false,
				rowOrderMatches: false,
				columnOrderMatches: false,
				columnHeaderNamesMatch: __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState),
				reason: 'rowCountMismatch',
				rowCountA: aRows.length,
				rowCountB: bRows.length
			};
		}

		const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
		const columnOrderMatches = __kustoDoColumnOrderMatch(sourceState, comparisonState);

		// Data equivalence prioritizes values:
		// - ignore row order always
		// - ignore column order always
		// - ignore column header names when needed
		let rowKeyForA = null;
		let rowKeyForB = null;
		let rowOrderMatches = false;

		if (columnHeaderNamesMatch) {
			// Align columns by header name (case-insensitive) using a canonical sorted name list.
			const canonicalNames = __kustoGetNormalizedColumnNameList(sourceState).slice().sort();
			const aMap = __kustoBuildNameBasedColumnMapping(sourceState, canonicalNames);
			const bMap = __kustoBuildNameBasedColumnMapping(comparisonState, canonicalNames);
			rowKeyForA = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, aMap);
			rowKeyForB = (row: any) => __kustoRowKeyForComparisonWithColumnMapping(row, bMap);
			// Row order matches means: after aligning columns by name, each row matches in sequence.
			rowOrderMatches = true;
			for (let i = 0; i < aRows.length; i++) {
				if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) {
					rowOrderMatches = false;
					break;
				}
			}
		} else {
			// No reliable column-name alignment; compare each row as an unordered multiset of cell values.
			rowKeyForA = __kustoRowKeyForComparisonIgnoringColumnOrder;
			rowKeyForB = __kustoRowKeyForComparisonIgnoringColumnOrder;
			rowOrderMatches = true;
			for (let i = 0; i < aRows.length; i++) {
				if (rowKeyForA(aRows[i]) !== rowKeyForB(bRows[i])) {
					rowOrderMatches = false;
					break;
				}
			}
		}

		const counts = new Map();
		for (const row of aRows) {
			const key = rowKeyForA(row);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		for (const row of bRows) {
			const key = rowKeyForB(row);
			const prev = counts.get(key) || 0;
			if (prev <= 0) {
				return {
					dataMatches: false,
					rowOrderMatches,
					columnOrderMatches,
					columnHeaderNamesMatch,
					reason: 'extraOrMismatchedRow',
					firstMismatchedRowKey: key
				};
			}
			if (prev === 1) {
				counts.delete(key);
			} else {
				counts.set(key, prev - 1);
			}
		}
		const dataMatches = counts.size === 0;
		if (!dataMatches) {
			let firstMissingKey = '';
			try {
				for (const k of counts.keys()) { firstMissingKey = k; break; }
			} catch { /* ignore */ }
			return {
				dataMatches,
				rowOrderMatches,
				columnOrderMatches,
				columnHeaderNamesMatch,
				reason: 'missingRow',
				firstMismatchedRowKey: firstMissingKey
			};
		}
		return { dataMatches, rowOrderMatches, columnOrderMatches, columnHeaderNamesMatch };
	} catch {
		return {
			dataMatches: false,
			rowOrderMatches: false,
			columnOrderMatches: false,
			columnHeaderNamesMatch: false,
			reason: 'exception'
		};
	}
}

function __kustoAreResultsEquivalent( sourceState: any, comparisonState: any) {
	try {
		return !!__kustoAreResultsEquivalentWithDetails(sourceState, comparisonState).dataMatches;
	} catch {
		return false;
	}
}

function __kustoDoResultHeadersMatch( sourceState: any, comparisonState: any) {
	try {
		// Historical name: keep behavior for any callers that expect strict header equality.
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) return false;
		for (let i = 0; i < aCols.length; i++) {
			if (String(aCols[i]) !== String(bCols[i])) return false;
		}
		return true;
	} catch {
		return false;
	}
}

function __kustoUpdateAcceptOptimizationsButton( comparisonBoxId: any, enabled: any, tooltip: any) {
	const btn = document.getElementById(comparisonBoxId + '_accept_btn') as any;
	if (!btn) {
		return;
	}
	btn.disabled = !enabled;
	btn.title = tooltip || (enabled ? 'Accept Optimizations' : 'Accept Optimizations is enabled when the optimized query has results.');
	btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function acceptOptimizations( comparisonBoxId: any) {
	try {
		const meta = (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) ? _win.optimizationMetadataByBoxId[comparisonBoxId] : null;
		const sourceBoxId = meta && meta.sourceBoxId ? meta.sourceBoxId : '';
		const optimizedQuery = meta && typeof meta.optimizedQuery === 'string' ? meta.optimizedQuery : '';
		if (!sourceBoxId || !optimizedQuery) {
			return;
		}
		if (_win.queryEditors[sourceBoxId] && typeof _win.queryEditors[sourceBoxId].setValue === 'function') {
			_win.queryEditors[sourceBoxId].setValue(optimizedQuery);
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		}
		try { __kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, false); } catch { /* ignore */ }
		// Remove comparison box and clear metadata links.
		try { removeQueryBox(comparisonBoxId); } catch { /* ignore */ }
		try {
			if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
				delete _win.optimizationMetadataByBoxId[comparisonBoxId];
				if (_win.optimizationMetadataByBoxId[sourceBoxId]) {
					delete _win.optimizationMetadataByBoxId[sourceBoxId];
				}
			}
		} catch { /* ignore */ }
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Optimizations accepted: source query updated.' }); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoUpdateQueryResultsToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_results_toggle') as any;
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !((window as any).__kustoResultsVisibleByBoxId && (window as any).__kustoResultsVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide results' : 'Show results';
	btn.setAttribute('aria-label', visible ? 'Hide results' : 'Show results');
}

function __kustoUpdateComparisonSummaryToggleButton( boxId: any) {
	const btn = document.getElementById(boxId + '_summary_toggle') as any;
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !((window as any).__kustoComparisonSummaryVisibleByBoxId && (window as any).__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide comparison summary' : 'Show comparison summary';
	btn.setAttribute('aria-label', visible ? 'Hide comparison summary' : 'Show comparison summary');
}

function __kustoApplyResultsVisibility( boxId: any) {
	const wrapper = document.getElementById(boxId + '_results_wrapper') as any;
	if (!wrapper) {
		// Support non-query-box results (e.g. URL CSV preview) that render a results block
		// without the surrounding *_results_wrapper.
		let visible = true;
		try {
			visible = !((window as any).__kustoResultsVisibleByBoxId && (window as any).__kustoResultsVisibleByBoxId[boxId] === false);
		} catch { /* ignore */ }
		try {
			const body = document.getElementById(boxId + '_results_body') as any;
			if (body) {
				body.style.display = visible ? '' : 'none';
			}
		} catch { /* ignore */ }
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv && resultsDiv.classList) {
				resultsDiv.classList.toggle('is-results-hidden', !visible);
			}
		} catch { /* ignore */ }
		try {
			if (typeof _win.__kustoSetResultsToolsVisible === 'function') {
				_win.__kustoSetResultsToolsVisible(boxId, visible);
			}
			if (!visible && typeof _win.__kustoHideResultsTools === 'function') {
				_win.__kustoHideResultsTools(boxId);
			}
		} catch { /* ignore */ }
		return;
	}
	let visible = true;
	try {
		visible = !((window as any).__kustoResultsVisibleByBoxId && (window as any).__kustoResultsVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	// Only show wrapper when there's content.
	const resultsDiv = document.getElementById(boxId + '_results') as any;
	const hasContent = !!(resultsDiv && String(resultsDiv.innerHTML || '').trim());
	let hasTable = false;
	try {
		hasTable = !!(resultsDiv && resultsDiv.querySelector && (resultsDiv.querySelector('.table-container') || resultsDiv.querySelector('kw-data-table')));
	} catch { /* ignore */ }

	// <kw-data-table> manages its own show/hide internally.
	// Just ensure the wrapper and resizer are visible; don't apply legacy collapse/expand.
	if (resultsDiv && resultsDiv.querySelector && resultsDiv.querySelector('kw-data-table')) {
		wrapper.style.display = 'flex';
		const resizer = document.getElementById(boxId + '_results_resizer') as any;
		if (resizer) resizer.style.display = '';
		if (!wrapper.style.height || wrapper.style.height === 'auto') {
			wrapper.style.height = '300px';
		}
		return;
	}

	wrapper.style.display = hasContent ? 'flex' : 'none';
	if (hasContent) {
		const body = document.getElementById(boxId + '_results_body') as any;
		if (body) {
			body.style.display = visible ? '' : 'none';
		}
		try {
			if (typeof _win.__kustoSetResultsToolsVisible === 'function') {
				_win.__kustoSetResultsToolsVisible(boxId, visible);
			}
			if (!visible && typeof _win.__kustoHideResultsTools === 'function') {
				_win.__kustoHideResultsTools(boxId);
			}
		} catch { /* ignore */ }
		const resizer = document.getElementById(boxId + '_results_resizer') as any;
		if (resizer) {
			// Cleaner UI: only show the resize handle when a successful results table is rendered.
			resizer.style.display = (visible && hasTable) ? '' : 'none';
		}
		try {
			if (!visible) {
				// Collapse to just the header (minimum height needed).
				if (wrapper.style.height && wrapper.style.height !== 'auto') {
					wrapper.dataset.kustoPreviousHeight = wrapper.style.height;
				}
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else if (!hasTable) {
				// Error-only (or non-table) content: hug content and hide resizer.
				try {
					if (wrapper.style.height && wrapper.style.height !== 'auto') {
						wrapper.dataset.kustoPrevSuccessHeight = wrapper.style.height;
					}
				} catch { /* ignore */ }
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else {
				// Successful results table: allow resizing.
				wrapper.style.minHeight = '120px';
				if (!wrapper.style.height || wrapper.style.height === 'auto') {
					if (wrapper.dataset.kustoPreviousHeight) {
						wrapper.style.height = wrapper.dataset.kustoPreviousHeight;
					} else if (wrapper.dataset.kustoPrevSuccessHeight) {
						wrapper.style.height = wrapper.dataset.kustoPrevSuccessHeight;
					} else {
						wrapper.style.height = '240px';
					}
				}
				// Guardrail: never allow the wrapper to become so tall that the table can't scroll.
				// A huge persisted/previous height makes the container as tall as the full table,
				// which removes the scrollbar and kills virtualization performance.
				try {
					const m = String(wrapper.style.height || '').trim().match(/^([0-9]+)px$/i);
					if (m) {
						const px = parseInt(m[1], 10);
						if (isFinite(px)) {
							const clamped = Math.max(120, Math.min(900, px));
							if (clamped !== px) {
								wrapper.style.height = clamped + 'px';
							}
						}
					}
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }
	}
}

function __kustoApplyComparisonSummaryVisibility( boxId: any) {
	const box = document.getElementById(boxId) as any;
	if (!box) {
		return;
	}
	const banner = box.querySelector('.comparison-summary-banner');
	if (!banner) {
		return;
	}
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId && _win.optimizationMetadataByBoxId[boxId] && _win.optimizationMetadataByBoxId[boxId].isComparison) {
			banner.style.display = '';
			return;
		}
	} catch { /* ignore */ }
	let visible = true;
	try {
		visible = !((window as any).__kustoComparisonSummaryVisibleByBoxId && (window as any).__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	banner.style.display = visible ? '' : 'none';
}

function toggleQueryResultsVisibility( boxId: any) {
	try {
		if (!(window as any).__kustoResultsVisibleByBoxId || typeof (window as any).__kustoResultsVisibleByBoxId !== 'object') {
			(window as any).__kustoResultsVisibleByBoxId = {};
		}
		const current = !((window as any).__kustoResultsVisibleByBoxId[boxId] === false);
		(window as any).__kustoResultsVisibleByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
	try {
		if (typeof (window as any).__kustoOnResultsVisibilityToggled === 'function') {
			(window as any).__kustoOnResultsVisibilityToggled(boxId);
		}
	} catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function toggleComparisonSummaryVisibility( boxId: any) {
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId && _win.optimizationMetadataByBoxId[boxId] && _win.optimizationMetadataByBoxId[boxId].isComparison) {
			// Optimized sections always show summary.
			return;
		}
	} catch { /* ignore */ }
	try {
		if (!(window as any).__kustoComparisonSummaryVisibleByBoxId || typeof (window as any).__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			(window as any).__kustoComparisonSummaryVisibleByBoxId = {};
		}
		const current = !((window as any).__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
		(window as any).__kustoComparisonSummaryVisibleByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateComparisonSummaryToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureCacheBackupMap() {
	if (!(window as any).__kustoCacheBackupByBoxId || typeof (window as any).__kustoCacheBackupByBoxId !== 'object') {
		(window as any).__kustoCacheBackupByBoxId = {};
	}
	return (window as any).__kustoCacheBackupByBoxId;
}

function __kustoBackupCacheSettings( boxId: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	if (map[boxId]) {
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		map[boxId] = {
			enabled: enabledEl ? !!enabledEl.checked : true,
			value: valueEl ? (parseInt(valueEl.value) || 1) : 1,
			unit: unitEl ? String(unitEl.value || 'days') : 'days'
		};
	} catch {
		// ignore
	}
}

function __kustoRestoreCacheSettings( boxId: any) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	const backup = map[boxId];
	if (!backup) {
		// Ensure controls are re-enabled if we had disabled them.
		try {
			const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
			const valueEl = document.getElementById(boxId + '_cache_value') as any;
			const unitEl = document.getElementById(boxId + '_cache_unit') as any;
			if (enabledEl) { enabledEl.disabled = false; enabledEl.title = ''; }
			if (valueEl) { valueEl.disabled = false; valueEl.title = ''; }
			if (unitEl) { unitEl.disabled = false; unitEl.title = ''; }
			try { toggleCacheControls(boxId); } catch { /* ignore */ }
		} catch { /* ignore */ }
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		if (enabledEl) {
			enabledEl.checked = !!backup.enabled;
			enabledEl.disabled = false;
			enabledEl.title = '';
			try {
				const label = enabledEl.closest('label');
				if (label) { label.title = ''; }
			} catch { /* ignore */ }
		}
		if (valueEl) {
			valueEl.value = String(backup.value || 1);
			valueEl.disabled = false;
			valueEl.title = '';
		}
		if (unitEl) {
			unitEl.value = String(backup.unit || 'days');
			unitEl.disabled = false;
			unitEl.title = '';
		}
		try { toggleCacheControls(boxId); } catch { /* ignore */ }
	} catch {
		// ignore
	}
	try { delete map[boxId]; } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureRunModeBackupMap() {
	if (!(window as any).__kustoRunModeBackupByBoxId || typeof (window as any).__kustoRunModeBackupByBoxId !== 'object') {
		(window as any).__kustoRunModeBackupByBoxId = {};
	}
	return (window as any).__kustoRunModeBackupByBoxId;
}

function __kustoBackupRunMode( boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	// Only back up once per optimization session.
	if (map[boxId] && typeof map[boxId].mode === 'string') {
		return;
	}
	try {
		map[boxId] = { mode: String(getRunMode(boxId) || 'take100') };
	} catch {
		map[boxId] = { mode: 'take100' };
	}
}

function __kustoRestoreRunMode( boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	const backup = map[boxId];
	if (!backup || typeof backup.mode !== 'string') {
		return;
	}
	try {
		setRunMode(boxId, String(backup.mode || 'take100'));
	} catch { /* ignore */ }
	try { delete map[boxId]; } catch { /* ignore */ }
}

function __kustoSetLinkedOptimizationMode( sourceBoxId: any, comparisonBoxId: any, active: any) {
	const ids = [String(sourceBoxId || '').trim(), String(comparisonBoxId || '').trim()].filter(Boolean);
	for (const id of ids) {
		const el = document.getElementById(id) as any;
		if (!el) continue;
		if (active) {
			try { __kustoBackupCacheSettings(id); } catch { /* ignore */ }
			try { __kustoBackupRunMode(id); } catch { /* ignore */ }
			try { setRunMode(id, 'plain'); } catch { /* ignore */ }
			el.classList.add('has-linked-optimization');
		} else {
			el.classList.remove('has-linked-optimization');
			try { __kustoRestoreCacheSettings(id); } catch { /* ignore */ }
			try { __kustoRestoreRunMode(id); } catch { /* ignore */ }
		}
	}
}

function updateCaretDocsToggleButtons() {
	for (const boxId of _win.queryBoxes) {
		const btn = document.getElementById(boxId + '_caret_docs_toggle') as any;
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', _win.caretDocsEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!_win.caretDocsEnabled);
	}
}

function updateAutoTriggerAutocompleteToggleButtons() {
	for (const boxId of _win.queryBoxes) {
		const btn = document.getElementById(boxId + '_auto_autocomplete_toggle') as any;
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', _win.autoTriggerAutocompleteEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!_win.autoTriggerAutocompleteEnabled);
	}
}

function toggleAutoTriggerAutocompleteEnabled() {
	_win.autoTriggerAutocompleteEnabled = !_win.autoTriggerAutocompleteEnabled;
	try { (window as any).__kustoAutoTriggerAutocompleteEnabledUserSet = true; } catch { /* ignore */ }
	updateAutoTriggerAutocompleteToggleButtons();
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		(_win.vscode as any).postMessage({ type: 'setAutoTriggerAutocompleteEnabled', enabled: !!_win.autoTriggerAutocompleteEnabled });
	} catch {
		// ignore
	}

	// When enabling, kick once for the currently focused editor (matches ADX feel).
	if (_win.autoTriggerAutocompleteEnabled) {
		try {
			const boxId = (typeof _win.activeQueryEditorBoxId === 'string') ? _win.activeQueryEditorBoxId : null;
			if (boxId && typeof (window as any).__kustoTriggerAutocompleteForBoxId === 'function') {
				(window as any).__kustoTriggerAutocompleteForBoxId(boxId);
			}
		} catch { /* ignore */ }
	}
}

function updateCopilotInlineCompletionsToggleButtons() {
	for (const boxId of _win.queryBoxes) {
		const btn = document.getElementById(boxId + '_copilot_inline_toggle') as any;
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', _win.copilotInlineCompletionsEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!_win.copilotInlineCompletionsEnabled);
	}
}

function toggleCopilotInlineCompletionsEnabled() {
	_win.copilotInlineCompletionsEnabled = !_win.copilotInlineCompletionsEnabled;
	try { (window as any).__kustoCopilotInlineCompletionsEnabledUserSet = true; } catch { /* ignore */ }
	updateCopilotInlineCompletionsToggleButtons();
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		(_win.vscode as any).postMessage({ type: 'setCopilotInlineCompletionsEnabled', enabled: !!_win.copilotInlineCompletionsEnabled });
	} catch {
		// ignore
	}
}

function toggleCaretDocsEnabled() {
	_win.caretDocsEnabled = !_win.caretDocsEnabled;
	updateCaretDocsToggleButtons();
	// Hide existing overlays immediately when turning off.
	if (!_win.caretDocsEnabled) {
		try {
			for (const key of Object.keys(_win.caretDocOverlaysByBoxId || {})) {
				const overlay = _win.caretDocOverlaysByBoxId[key];
				if (overlay && typeof overlay.hide === 'function') {
					overlay.hide();
				}
			}
		} catch {
			// ignore
		}
	} else {
		// When turning on, show the banner immediately (watermark) without waiting for cursor movement.
		try {
			const watermarkTitle = 'Smart documentation';
			const watermarkBody = 'Kusto documentation will appear here as the cursor moves around';
			for (const boxId of _win.queryBoxes) {
				try {
					const banner = document.getElementById(boxId + '_caret_docs') as any;
					const text = document.getElementById(boxId + '_caret_docs_text') || banner;
					if (banner) {
						banner.style.display = 'flex';
					}
					if (text) {
						text.innerHTML =
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-title">' +
							watermarkTitle +
							'</div>' +
							'<div class="qe-caret-docs-line qe-caret-docs-watermark-body">' +
							watermarkBody +
							'</div>';
						if (text.classList) {
							text.classList.add('is-watermark');
						}
					}
				} catch { /* ignore */ }
			}
		} catch { /* ignore */ }

		// Then refresh any Monaco-driven overlays so real docs content replaces the watermark.
		try {
			const overlays = (typeof _win.caretDocOverlaysByBoxId !== 'undefined') ? _win.caretDocOverlaysByBoxId : null;
			if (overlays && typeof overlays === 'object') {
				for (const key of Object.keys(overlays)) {
					try {
						const o = overlays[key];
						if (o && typeof o.update === 'function') {
							o.update();
						}
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	}
	try {
		(_win.vscode as any).postMessage({ type: 'setCaretDocsEnabled', enabled: !!_win.caretDocsEnabled });
	} catch {
		// ignore
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function onQueryEditorToolbarAction( boxId: any, action: any) {
	// Focus the editor so Monaco widgets (find/replace) attach correctly.
	try {
		_win.activeQueryEditorBoxId = boxId;
		if (_win.queryEditors[boxId]) {
			_win.queryEditors[boxId].focus();
		}
	} catch {
		// ignore
	}

	if (action === 'undo') {
		try {
			const editor = _win.queryEditors[boxId];
			if (editor) {
				editor.trigger('toolbar', 'undo', null);
			}
		} catch { /* ignore */ }
		return;
	}
	if (action === 'redo') {
		try {
			const editor = _win.queryEditors[boxId];
			if (editor) {
				editor.trigger('toolbar', 'redo', null);
			}
		} catch { /* ignore */ }
		return;
	}
	if (action === 'search') {
		return runMonacoAction(boxId, 'actions.find');
	}
	if (action === 'replace') {
		return runMonacoAction(boxId, 'editor.action.startFindReplaceAction');
	}
	if (action === 'prettify') {
		try {
			if (typeof (window as any).__kustoPrettifyQueryForBoxId === 'function') {
				(window as any).__kustoPrettifyQueryForBoxId(boxId);
				return;
			}
		} catch { /* ignore */ }
		// Fallback: at least run the basic formatter.
		return runMonacoAction(boxId, 'editor.action.formatDocument');
	}
	if (action === 'singleLine') {
		try {
			if (typeof (window as any).__kustoCopySingleLineQueryForBoxId === 'function') {
				(window as any).__kustoCopySingleLineQueryForBoxId(boxId);
				return;
			}
		} catch { /* ignore */ }
		return;
	}
	if (action === 'autocomplete') {
		try {
			if (typeof (window as any).__kustoTriggerAutocompleteForBoxId === 'function') {
				(window as any).__kustoTriggerAutocompleteForBoxId(boxId);
				return;
			}
		} catch {
			// ignore
		}
		return runMonacoAction(boxId, 'editor.action.triggerSuggest');
	}
	if (action === 'doubleToSingle') {
		return replaceAllInEditor(boxId, '"', "'");
	}
	if (action === 'singleToDouble') {
		return replaceAllInEditor(boxId, "'", '"');
	}
	if (action === 'exportPowerBI') {
		return exportQueryToPowerBI(boxId);
	}
	if (action === 'copyAdeLink') {
		return copyQueryAsAdeLink(boxId);
	}
	if (action === 'qualifyTables') {
		try {
			if (_win.qualifyTablesInFlightByBoxId && _win.qualifyTablesInFlightByBoxId[boxId]) {
				return;
			}
		} catch { /* ignore */ }
		try { _win.qualifyTablesInFlightByBoxId[boxId] = true; } catch { /* ignore */ }
		try { setToolbarActionBusy(boxId, 'qualifyTables', true); } catch { /* ignore */ }
		(async () => {
			try {
				await fullyQualifyTablesInEditor(boxId);
			} finally {
				try { _win.qualifyTablesInFlightByBoxId[boxId] = false; } catch { /* ignore */ }
				try { setToolbarActionBusy(boxId, 'qualifyTables', false); } catch { /* ignore */ }
			}
		})();
		return;
	}
}

function copyQueryAsAdeLink( boxId: any) {
	const __kustoExtractStatementAtCursor = (editor: any) => {
		try {
			if (typeof (window as any).__kustoExtractStatementTextAtCursor === 'function') {
				return (window as any).__kustoExtractStatementTextAtCursor(editor);
			}
		} catch { /* ignore */ }
		try {
			if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') {
				return null;
			}
			const model = editor.getModel();
			const pos = editor.getPosition();
			if (!model || !pos || typeof model.getLineCount !== 'function') {
				return null;
			}
			const cursorLine = pos.lineNumber;
			if (typeof cursorLine !== 'number' || !isFinite(cursorLine) || cursorLine < 1) {
				return null;
			}
			const lineCount = model.getLineCount();
			if (!lineCount || cursorLine > lineCount) {
				return null;
			}

			// Statements are separated by one or more blank lines.
			// Blank lines inside triple-backtick (```) multi-line string literals are NOT separators.
			const blocks = [];
			let inBlock = false;
			let startLine = 1;
			let inTripleBacktick = false;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
				// Track triple-backtick state.
				let tripleCount = 0;
				for (let ci = 0; ci < lineText.length - 2; ci++) {
					if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') {
						tripleCount++;
						ci += 2;
					}
				}
				if (tripleCount % 2 === 1) inTripleBacktick = !inTripleBacktick;
				if (inTripleBacktick) {
					if (!inBlock) { startLine = ln; inBlock = true; }
					continue;
				}
				const isBlank = !String(lineText || '').trim();
				if (isBlank) {
					if (inBlock) {
						blocks.push({ startLine, endLine: ln - 1 });
						inBlock = false;
					}
					continue;
				}
				if (!inBlock) {
					startLine = ln;
					inBlock = true;
				}
			}
			if (inBlock) {
				blocks.push({ startLine, endLine: lineCount });
			}

			const block = blocks.find((b: any) => cursorLine >= b.startLine && cursorLine <= b.endLine);
			if (!block) {
				// Cursor is on a blank separator line (or the editor is empty).
				return null;
			}

			const endCol = (typeof model.getLineMaxColumn === 'function')
				? model.getLineMaxColumn(block.endLine)
				: 1;
			const range = {
				startLineNumber: block.startLine,
				startColumn: 1,
				endLineNumber: block.endLine,
				endColumn: endCol
			};
			let text = '';
			try {
				text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : '';
			} catch {
				text = '';
			}
			const trimmed = String(text || '').trim();
			return trimmed || null;
		} catch {
			return null;
		}
	};

	const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	// If the editor has multiple statements (blank-line separated), use only the statement at cursor.
	try {
		if (editor) {
			const model = editor.getModel && editor.getModel();
			const blocks = (model && typeof (window as any).__kustoGetStatementBlocksFromModel === 'function')
				? (window as any).__kustoGetStatementBlocksFromModel(model)
				: [];
			const hasMultipleStatements = blocks && blocks.length > 1;
			if (hasMultipleStatements) {
				const statement = __kustoExtractStatementAtCursor(editor);
				if (statement) {
					query = statement;
				} else {
					try {
						(_win.vscode as any).postMessage({
							type: 'showInfo',
							message: 'Place the cursor inside a query statement (not on a separator) to copy a Data Explorer link for that statement.'
						});
					} catch { /* ignore */ }
					return;
				}
			}
		}
	} catch { /* ignore */ }

	let connectionId = __kustoGetConnectionId(boxId);
	let database = __kustoGetDatabase(boxId);

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = String(meta.sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(sourceBoxId);
				const srcDb = __kustoGetDatabase(sourceBoxId);
				if (srcConnId) connectionId = srcConnId;
				if (srcDb) database = srcDb;
			}
		}
	} catch { /* ignore */ }

	if (!String(query || '').trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'There is no query text to share.' }); } catch { /* ignore */ }
		return;
	}
	if (!String(connectionId || '').trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Select a cluster connection first.' }); } catch { /* ignore */ }
		return;
	}
	if (!String(database || '').trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Select a database first.' }); } catch { /* ignore */ }
		return;
	}

	try {
		(_win.vscode as any).postMessage({
			type: 'copyAdeLink',
			query,
			connectionId,
			database,
			boxId
		});
	} catch {
		// ignore
	}
}

/**
 * Opens the Share modal for a query section, allowing users to copy
 * title, query, and results to clipboard formatted for Teams.
 */
function __kustoOpenShareModal( boxId: any) {
	if (!boxId) return;

	const modal = document.getElementById('shareModal') as any;
	if (!modal) return;

	// Store the active box id on the modal.
	modal.dataset.boxId = boxId;

	// Pre-populate the section name.
	const nameInput = null;
	const sectionName = __kustoGetSectionName(boxId);
	const titleEl = document.getElementById('shareModal_title') as any;
	if (titleEl) titleEl.textContent = sectionName || 'Kusto Query';

	// Determine whether results are available.
	const state = (typeof _win.__kustoGetResultsState === 'function') ? _win.__kustoGetResultsState(boxId) : null;
	const hasResults = !!(state && Array.isArray(state.columns) && state.columns.length > 0 && Array.isArray(state.rows) && state.rows.length > 0);
	const totalRows = hasResults ? state.rows.length : 0;
	const resultsCheck = document.getElementById('shareModal_chk_results') as any;
	if (resultsCheck) {
		resultsCheck.checked = hasResults;
		resultsCheck.disabled = !hasResults;
	}
	const resultsLabel = document.getElementById('shareModal_label_results') as any;
	if (resultsLabel) {
		resultsLabel.classList.toggle('share-modal-option-disabled', !hasResults);
	}

	// Set up row limit input with total row count.
	const rowLimitInput = document.getElementById('shareModal_rowLimit') as any;
	if (rowLimitInput) {
		rowLimitInput.max = String(totalRows || 200);
		rowLimitInput.value = String(Math.min(totalRows || 10, 10));
		rowLimitInput.disabled = !hasResults;
	}
	const rowLimitGroup = document.getElementById('shareModal_rowLimitGroup') as any;
	if (rowLimitGroup) {
		rowLimitGroup.style.display = hasResults ? '' : 'none';
	}
	const resultsSubtitle = document.getElementById('shareModal_results_subtitle') as any;
	if (resultsSubtitle) {
		resultsSubtitle.textContent = 'Formatted as a table';
	}
	const rowLimitTotal = document.getElementById('shareModal_rowLimitTotal') as any;
	if (rowLimitTotal) {
		rowLimitTotal.textContent = 'of ' + totalRows.toLocaleString() + ' rows';
	}

	// Determine whether we have connection info for the ADE link.
	let connectionId = '';
	let database = '';
	try {
		connectionId = __kustoGetConnectionId(boxId);
		database = __kustoGetDatabase(boxId);
	} catch { /* ignore */ }

	// Inherit from source box if this is a comparison section.
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const src = String(meta.sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(src);
				const srcDb = __kustoGetDatabase(src);
				if (srcConnId) connectionId = srcConnId;
				if (srcDb) database = srcDb;
			}
		}
	} catch { /* ignore */ }

	const hasLink = !!(String(connectionId || '').trim() && String(database || '').trim());
	const linkCheck = document.getElementById('shareModal_chk_title') as any;
	if (linkCheck) {
		linkCheck.checked = hasLink;
		linkCheck.disabled = !hasLink;
	}
	const linkLabel = document.getElementById('shareModal_label_title') as any;
	if (linkLabel) {
		linkLabel.classList.toggle('share-modal-option-disabled', !hasLink);
	}

	// Also update the link subtitle with a preview of what we'll generate.
	const linkSubtitle = document.getElementById('shareModal_link_subtitle') as any;
	if (linkSubtitle) {
		linkSubtitle.textContent = hasLink ? 'Includes a Direct link to query (Azure Data Explorer)' : 'Select a cluster and database to include a link';
	}

	// Reset the query checkbox.
	const queryCheck = document.getElementById('shareModal_chk_query') as any;
	if (queryCheck) {
		const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
		const hasQuery = !!(editor && String(editor.getValue() || '').trim());
		queryCheck.checked = hasQuery;
		queryCheck.disabled = !hasQuery;
	}

	// Show the modal.
	modal.classList.add('visible');
}

function __kustoCloseShareModal( event?: any) {
	if (event && event.target && event.target.id !== 'shareModal') return;
	const modal = document.getElementById('shareModal') as any;
	if (modal) modal.classList.remove('visible');
}

function __kustoShareCopyToClipboard() {
	const modal = document.getElementById('shareModal') as any;
	if (!modal) return;
	const boxId = modal.dataset.boxId;
	if (!boxId) return;

	const includeTitle = !!(document.getElementById('shareModal_chk_title') as any || {}).checked;
	const includeQuery = !!(document.getElementById('shareModal_chk_query') as any || {}).checked;
	const includeResults = !!(document.getElementById('shareModal_chk_results') as any || {}).checked;

	if (!includeTitle && !includeQuery && !includeResults) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Select at least one section to share.' }); } catch { /* ignore */ }
		return;
	}

	// Gather query text.
	let queryText = '';
	try {
		const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
		queryText = editor ? (editor.getValue() || '') : '';
	} catch { /* ignore */ }

	// Gather connection info.
	let connectionId = '';
	let database = '';
	try {
		connectionId = __kustoGetConnectionId(boxId);
		database = __kustoGetDatabase(boxId);
	} catch { /* ignore */ }
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const src = String(meta.sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(src);
				const srcDb = __kustoGetDatabase(src);
				if (srcConnId) connectionId = srcConnId;
				if (srcDb) database = srcDb;
			}
		}
	} catch { /* ignore */ }

	// Gather results data.
	let columns = [];
	let rowsData = [];
	let totalRows = 0;
	if (includeResults) {
		try {
			const state = (typeof _win.__kustoGetResultsState === 'function') ? _win.__kustoGetResultsState(boxId) : null;
			if (state && Array.isArray(state.columns) && Array.isArray(state.rows)) {
				// columns are plain strings in state.columns.
				columns = state.columns.map((c: any) => (c && typeof c === 'object' && c.name) ? String(c.name) : String(c ?? ''));
				totalRows = state.rows.length;
				// Read the user-configured row limit from the Share modal input.
				let rowLimit = 10;
				try {
					const rlInput = document.getElementById('shareModal_rowLimit') as any;
					if (rlInput) {
						const parsed = parseInt(rlInput.value, 10);
						if (parsed > 0) rowLimit = parsed;
					}
				} catch { /* ignore */ }
				const maxRows = Math.min(totalRows, rowLimit);
				for (let i = 0; i < maxRows; i++) {
					const row = state.rows[i];
					if (!Array.isArray(row)) continue;
					const vals = [];
					for (let j = 0; j < row.length; j++) {
						const cell = row[j];
						// Use the same display pipeline as the results table so
						// numbers have commas, dates are formatted, etc.
						const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
						const displayValue = hasHover ? cell.display : cell;
						const formatted = (typeof _win.__kustoFormatCellDisplayValueForTable === 'function')
							? _win.__kustoFormatCellDisplayValueForTable(displayValue)
							: String(displayValue ?? '');
						vals.push(String(formatted ?? ''));
					}
					rowsData.push(vals);
				}
			}
		} catch { /* ignore */ }
	}

	// Get section name.
	let sectionName = '';
	try {
		sectionName = __kustoGetSectionName(boxId);
	} catch { /* ignore */ }

	// Send to extension to build ADE link and copy to clipboard.
	try {
		(_win.vscode as any).postMessage({
			type: 'shareToClipboard',
			boxId,
			includeTitle,
			includeQuery,
			includeResults,
			sectionName,
			queryText,
			connectionId,
			database,
			columns,
			rowsData,
			totalRows
		});
	} catch { /* ignore */ }

	// Close the modal.
	__kustoCloseShareModal();
}

function setToolbarActionBusy( boxId: any, action: any, busy: any) {
	try {
		const root = document.getElementById(boxId) as any;
		if (!root) return;
		const btn = root.querySelector('.query-editor-toolbar-btn[data-qe-action="' + action + '"]');
		if (btn) {
			if (busy) {
				if (!btn.dataset.qePrevHtml) {
					btn.dataset.qePrevHtml = btn.innerHTML;
				}
				btn.disabled = true;
				btn.setAttribute('aria-busy', 'true');
				btn.innerHTML = '<span class="schema-spinner" aria-hidden="true"></span>';
			} else {
				btn.disabled = false;
				btn.removeAttribute('aria-busy');
				if (btn.dataset.qePrevHtml) {
					btn.innerHTML = btn.dataset.qePrevHtml;
					delete btn.dataset.qePrevHtml;
				}
			}
		}

		// If the action button is not present (because it lives inside a dropdown menu),
		// reflect the busy state on the tools dropdown button.
		if (!btn && action === 'qualifyTables') {
			const toolsBtn = document.getElementById(boxId + '_tools_btn') as any;
			if (!toolsBtn) return;
			try {
				const icon = toolsBtn.querySelector('.qe-tools-icon');
				const caret = toolsBtn.querySelector('.qe-toolbar-caret');
				const spinner = toolsBtn.querySelector('.qe-tools-spinner');
				if (busy) {
					toolsBtn.classList.add('is-busy');
					toolsBtn.setAttribute('aria-busy', 'true');
					if (icon) icon.style.display = 'none';
					if (caret) caret.style.display = 'none';
					if (spinner) spinner.style.display = '';
				} else {
					toolsBtn.classList.remove('is-busy');
					toolsBtn.removeAttribute('aria-busy');
					if (icon) icon.style.display = '';
					if (caret) caret.style.display = '';
					if (spinner) spinner.style.display = 'none';
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function closeToolsDropdown( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		if ((window as any).__kustoDropdown && typeof (window as any).__kustoDropdown.closeMenuDropdown === 'function') {
			(window as any).__kustoDropdown.closeMenuDropdown(id + '_tools_btn', id + '_tools_menu');
			return;
		}
	} catch { /* ignore */ }
	try {
		const menu = document.getElementById(id + '_tools_menu') as any;
		if (menu) menu.style.display = 'none';
	} catch { /* ignore */ }
	try {
		const btn = document.getElementById(id + '_tools_btn') as any;
		if (btn) {
			btn.setAttribute('aria-expanded', 'false');
			try { btn.classList && btn.classList.remove('is-active'); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

// --- Toolbar overflow handling ---
// Track ResizeObservers per toolbar
const __kustoToolbarResizeObservers: any = {};
// Track ResizeObservers for run button responsiveness
const __kustoRunBtnResizeObservers: any = {};

/**
 * Initialize toolbar overflow detection for a query box.
 * Uses ResizeObserver to detect when buttons overflow and shows a "..." menu.
 */
function initToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar') as any;
	if (!toolbar) return;

	// Clean up any existing observer
	if (__kustoToolbarResizeObservers[id]) {
		try { __kustoToolbarResizeObservers[id].disconnect(); } catch { /* ignore */ }
	}

	// Create new observer
	const observer = new ResizeObserver(() => {
		try { updateToolbarOverflow(id); } catch { /* ignore */ }
	});
	observer.observe(toolbar);
	__kustoToolbarResizeObservers[id] = observer;

	// Initial check
	requestAnimationFrame(() => {
		try { updateToolbarOverflow(id); } catch { /* ignore */ }
	});

	// Also initialize run button responsiveness
	initRunButtonResponsive(boxId);
}

/**
 * Initialize responsive behavior for the Run button.
 * When the query box is narrow, hide the label and show only the play icon.
 */
function initRunButtonResponsive( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const queryBox = document.getElementById(id) as any;
	if (!queryBox) return;

	// Clean up any existing observer
	if (__kustoRunBtnResizeObservers[id]) {
		try { __kustoRunBtnResizeObservers[id].disconnect(); } catch { /* ignore */ }
	}

	// Create new observer on the query box itself
	const observer = new ResizeObserver(() => {
		try { updateRunButtonResponsive(id); } catch { /* ignore */ }
	});
	observer.observe(queryBox);
	__kustoRunBtnResizeObservers[id] = observer;

	// Initial check
	requestAnimationFrame(() => {
		try { updateRunButtonResponsive(id); } catch { /* ignore */ }
	});
}

/**
 * Update run button compact/expanded state based on available width.
 */
function updateRunButtonResponsive( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn') as any;
	if (!runBtn) return;

	// Get the query box width
	const queryBox = document.getElementById(id) as any;
	if (!queryBox) return;
	const boxWidth = queryBox.offsetWidth;

	// Threshold: if box is narrower than 400px, use compact mode
	const compactThreshold = 400;
	if (boxWidth < compactThreshold) {
		runBtn.classList.add('is-compact');
	} else {
		runBtn.classList.remove('is-compact');
	}
}

/**
 * Update overflow state for a toolbar - hide overflowing items and show overflow menu
 */
function updateToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar') as any;
	const itemsContainer = toolbar && toolbar.querySelector('.qe-toolbar-items');
	const overflowWrapper = document.getElementById(id + '_toolbar_overflow_wrapper') as any;
	if (!toolbar || !itemsContainer || !overflowWrapper) return;

	// Get all toolbar items (buttons, separators, wrappers)
	const items = Array.from(itemsContainer.children) as any[];
	if (!items.length) return;

	// First, make all items visible to measure properly
	items.forEach((item: any) => item.classList.remove('qe-in-overflow'));
	overflowWrapper.classList.remove('is-visible');

	// Get available width (toolbar width minus padding and overflow button width)
	const toolbarStyle = getComputedStyle(toolbar);
	const paddingLeft = parseFloat(toolbarStyle.paddingLeft) || 0;
	const paddingRight = parseFloat(toolbarStyle.paddingRight) || 0;
	const gap = parseFloat(getComputedStyle(itemsContainer).gap) || 4;
	const overflowBtnWidth = 36; // Approximate width of overflow button
	const availableWidth = toolbar.clientWidth - paddingLeft - paddingRight - overflowBtnWidth - gap;

	// Calculate cumulative widths to find where overflow starts
	let totalWidth = 0;
	let overflowStartIndex = -1;

	for (let i = 0; i < items.length; i++) {
		const item = items[i];
		const itemWidth = item.offsetWidth + (i > 0 ? gap : 0);
		totalWidth += itemWidth;

		if (totalWidth > availableWidth && overflowStartIndex === -1) {
			// Find the previous separator to make a clean break
			let breakIndex = i;
			for (let j = i - 1; j >= 0; j--) {
				if (items[j].classList.contains('query-editor-toolbar-sep')) {
					breakIndex = j;
					break;
				}
			}
			overflowStartIndex = breakIndex;
			break;
		}
	}

	// If everything fits, no overflow needed
	if (overflowStartIndex === -1) {
		return;
	}

	// Hide items that overflow
	for (let i = overflowStartIndex; i < items.length; i++) {
		items[i].classList.add('qe-in-overflow');
	}

	// Show the overflow button
	overflowWrapper.classList.add('is-visible');
}

/**
 * Toggle the toolbar overflow menu
 */
function toggleToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_toolbar_overflow_menu') as any;
	const btn = document.getElementById(id + '_toolbar_overflow_btn') as any;
	if (!menu || !btn) return;

	const isOpen = menu.style.display === 'block';

	// Close all other menus first
	try { closeAllRunMenus(); } catch { /* ignore */ }
	try { closeAllFavoritesDropdowns && closeAllFavoritesDropdowns(); } catch { /* ignore */ }
	try { closeToolsDropdown(id); } catch { /* ignore */ }

	if (isOpen) {
		closeToolbarOverflow(id);
	} else {
		// Render the menu content
		renderToolbarOverflowMenu(id);
		menu.style.display = 'block';
		btn.setAttribute('aria-expanded', 'true');
		btn.classList.add('is-active');

		// Position the menu using fixed positioning (to escape overflow:hidden)
		try {
			const btnRect = btn.getBoundingClientRect();
			const menuRect = menu.getBoundingClientRect();
			const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
			
			// Start with left-aligned to button
			let left = btnRect.left;
			
			// If menu would overflow right edge, align to right edge of button instead
			if (left + menuRect.width > viewportWidth - 8) {
				left = btnRect.right - menuRect.width;
			}
			
			// Ensure it doesn't go off the left edge either
			if (left < 8) {
				left = 8;
			}
			
			menu.style.left = left + 'px';
			menu.style.top = btnRect.bottom + 'px';
		} catch { /* ignore */ }

		// Wire keyboard nav if available
		try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.wireMenuInteractions && (window as any).__kustoDropdown.wireMenuInteractions(menu); } catch { /* ignore */ }
	}
}

/**
 * Toggle overflow submenu (accordion style)
 */
function toggleOverflowSubmenu( element: any, event: any) {
	if (event) {
		event.stopPropagation();
	}
	if (!element) return;
	
	const isExpanded = element.getAttribute('aria-expanded') === 'true';
	const submenuItems = element.nextElementSibling;
	
	if (submenuItems && submenuItems.classList.contains('qe-toolbar-overflow-submenu-items')) {
		if (isExpanded) {
			element.setAttribute('aria-expanded', 'false');
			submenuItems.classList.remove('is-expanded');
		} else {
			element.setAttribute('aria-expanded', 'true');
			submenuItems.classList.add('is-expanded');
		}
	}
}

/**
 * Close the toolbar overflow menu
 */
function closeToolbarOverflow( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_toolbar_overflow_menu') as any;
	const btn = document.getElementById(id + '_toolbar_overflow_btn') as any;
	if (menu) menu.style.display = 'none';
	if (btn) {
		btn.setAttribute('aria-expanded', 'false');
		btn.classList.remove('is-active');
	}
}

/**
 * Close all toolbar overflow menus
 */
function closeAllToolbarOverflowMenus() {
	document.querySelectorAll('.qe-toolbar-overflow-menu').forEach((menu: any) =>  {
		menu.style.display = 'none';
	});
	document.querySelectorAll('.qe-toolbar-overflow-btn').forEach((btn: any) =>  {
		btn.setAttribute('aria-expanded', 'false');
		btn.classList.remove('is-active');
	});
}

/**
 * Render the overflow menu items based on which buttons are hidden
 */
function renderToolbarOverflowMenu( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar') as any;
	const menu = document.getElementById(id + '_toolbar_overflow_menu') as any;
	if (!toolbar || !menu) return;

	const itemsContainer = toolbar.querySelector('.qe-toolbar-items');
	if (!itemsContainer) return;

	// Find all hidden items (those with qe-in-overflow class)
	const hiddenItems = Array.from(itemsContainer.querySelectorAll('.qe-in-overflow'));
	if (!hiddenItems.length) {
		menu.innerHTML = '<div class="qe-toolbar-overflow-item" style="opacity:0.6;cursor:default;">No additional actions</div>';
		return;
	}

	// Checkmark SVG for active toggle items
	const checkmarkSvg = '<svg class="qe-overflow-checkmark" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>';
	const emptyCheckmarkPlaceholder = '<span class="qe-overflow-checkmark-placeholder" style="width:14px;height:14px;display:inline-block;"></span>';

	// Tools submenu icons (same as in renderToolsMenuForBox)
	const __toolsDoubleToSingleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';
	const __toolsSingleToDoubleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';
	const __toolsQualifyTablesIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/>' +
		'</svg>';
	const __toolsSingleLineIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 8h12"/>' +
		'</svg>';
	const submenuArrowSvg = '<svg class="qe-overflow-submenu-arrow" viewBox="0 0 8 8" width="8" height="8" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

	let menuHtml = '';
	let prevWasSep = false;
	let hasAnyToggleItem = false;

	// First pass: check if there are any toggle items so we know if we need the checkmark column
	hiddenItems.forEach((item: any) =>  {
		if (item.classList.contains('query-editor-toolbar-toggle')) {
			hasAnyToggleItem = true;
		}
	});

	hiddenItems.forEach((item: any) =>  {
		if (item.classList.contains('query-editor-toolbar-sep')) {
			// Add separator in menu (but avoid consecutive separators)
			if (!prevWasSep && menuHtml) {
				menuHtml += '<div class="qe-toolbar-overflow-sep"></div>';
				prevWasSep = true;
			}
			return;
		}
		prevWasSep = false;

		// Handle the tools dropdown specially - render as expandable accordion
		if (item.classList.contains('qe-toolbar-menu-wrapper')) {
			const toolsSubmenuHtml =
				'<div class="qe-toolbar-overflow-submenu-items">' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'doubleToSingle\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsDoubleToSingleIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Replace &quot; with &#39;</span>' +
					'</div>' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'singleToDouble\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsSingleToDoubleIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Replace &#39; with &quot;</span>' +
					'</div>' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'qualifyTables\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsQualifyTablesIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Fully qualify tables</span>' +
					'</div>' +
					'<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'singleLine\');">' +
						'<span class="qe-icon" aria-hidden="true">' + __toolsSingleLineIconSvg + '</span>' +
						'<span class="qe-toolbar-overflow-label">Copy query as single line</span>' +
					'</div>' +
				'</div>';
			menuHtml += '<div class="qe-toolbar-overflow-item qe-overflow-has-submenu" role="menuitem" tabindex="-1" aria-expanded="false" onclick="toggleOverflowSubmenu(this, event);">' +
				(hasAnyToggleItem ? emptyCheckmarkPlaceholder : '') +
				'<span class="qe-icon" aria-hidden="true"><span class="codicon codicon-tools"></span></span>' +
				'<span class="qe-toolbar-overflow-label">Tools</span>' +
				submenuArrowSvg +
				'</div>' +
				toolsSubmenuHtml;
			return;
		}

		// Get action and label from data attributes or title
		const action = item.getAttribute('data-qe-overflow-action') || '';
		const label = item.getAttribute('data-qe-overflow-label') || item.getAttribute('title') || action;
		const iconHtml = item.querySelector('.qe-icon') ? item.querySelector('.qe-icon').innerHTML : '';
		const isDisabled = item.disabled || item.getAttribute('aria-disabled') === 'true';
		const isToggle = item.classList.contains('query-editor-toolbar-toggle');
		const isActive = item.classList.contains('is-active');

		if (action && label) {
			const disabledAttr = isDisabled ? ' style="opacity:0.5;cursor:default;" aria-disabled="true"' : '';
			const activeClass = isActive ? ' qe-overflow-item-active' : '';
			let onclick = '';
			if (!isDisabled) {
				if (action === 'caretDocs') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleCaretDocsEnabled();';
				} else if (action === 'autoAutocomplete') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleAutoTriggerAutocompleteEnabled();';
				} else if (action === 'copilotInline') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleCopilotInlineCompletionsEnabled();';
				} else if (action === 'copilotChat') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); __kustoToggleCopilotChatForBox(\'' + id + '\');';
				} else {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'' + action + '\');';
				}
			}
			// Add checkmark indicator for toggle items
			const checkmarkHtml = hasAnyToggleItem ? (isToggle && isActive ? checkmarkSvg : emptyCheckmarkPlaceholder) : '';
			menuHtml += '<div class="qe-toolbar-overflow-item' + activeClass + '" role="menuitem" tabindex="-1"' + disabledAttr + ' onclick="' + onclick + '">' +
				checkmarkHtml +
				'<span class="qe-icon" aria-hidden="true">' + iconHtml + '</span>' +
				'<span class="qe-toolbar-overflow-label">' + label + '</span>' +
				'</div>';
		}
	});

	// Remove trailing separator if any
	menuHtml = menuHtml.replace(/<div class="qe-toolbar-overflow-sep"><\/div>$/, '');

	menu.innerHTML = menuHtml || '<div class="qe-toolbar-overflow-item" style="opacity:0.6;cursor:default;">No additional actions</div>';
}

function toggleToolsDropdown( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_tools_menu') as any;
	const btn = document.getElementById(id + '_tools_btn') as any;
	if (!menu || !btn) return;

	try {
		if ((window as any).__kustoDropdown && typeof (window as any).__kustoDropdown.toggleMenuDropdown === 'function') {
			(window as any).__kustoDropdown.toggleMenuDropdown({
				buttonId: id + '_tools_btn',
				menuId: id + '_tools_menu',
				beforeOpen: () => {
					try { renderToolsMenuForBox(id); } catch { /* ignore */ }
				},
				afterOpen: () => {
					// Shared dropdown helper wires keyboard navigation.
				}
			});
			return;
		}
	} catch { /* ignore */ }

	// Fallback (legacy behavior)
	const next = menu.style.display === 'block' ? 'none' : 'block';
	try { closeAllRunMenus(); } catch { /* ignore */ }
	try { closeAllFavoritesDropdowns && closeAllFavoritesDropdowns(); } catch { /* ignore */ }
	if (next === 'block') {
		try { renderToolsMenuForBox(id); } catch { /* ignore */ }
	}
	menu.style.display = next;
	btn.setAttribute('aria-expanded', next === 'block' ? 'true' : 'false');
	try {
		if (next === 'block') {
			btn.classList && btn.classList.add('is-active');
		} else {
			btn.classList && btn.classList.remove('is-active');
		}
	} catch { /* ignore */ }
	if (next === 'block') {
		try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.wireMenuInteractions && (window as any).__kustoDropdown.wireMenuInteractions(menu); } catch { /* ignore */ }
		try { menu.focus(); } catch { /* ignore */ }
	}
}

function renderToolsMenuForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_tools_menu') as any;
	if (!menu) return;

	// IMPORTANT: keep icons local here.
	// The toolbar HTML builder defines some SVG consts in a different scope; referencing them here can
	// throw at runtime and prevent the menu from rendering/opening.
	const __toolsDoubleToSingleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';

	const __toolsSingleToDoubleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';

	const __toolsQualifyTablesIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/>' +
		'</svg>';

	const __toolsSingleLineIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 8h12"/>' +
		'</svg>';

	const toolsItemHtml = (iconSvg: any, labelText: any) => {
		return (
			'<span class="qe-icon" aria-hidden="true">' + String(iconSvg || '') + '</span>' +
			'<span class="qe-toolbar-menu-label">' + String(labelText || '') + '</span>'
		);
	};

	const items = [
		{ key: 'doubleToSingle', html: toolsItemHtml(__toolsDoubleToSingleIconSvg, 'Replace &quot; with &#39;'), ariaLabel: 'Replace " with \'', selected: false },
		{ key: 'singleToDouble', html: toolsItemHtml(__toolsSingleToDoubleIconSvg, 'Replace &#39; with &quot;'), ariaLabel: 'Replace \' with "', selected: false },
		{ key: 'qualifyTables', html: toolsItemHtml(__toolsQualifyTablesIconSvg, 'Fully qualify tables'), ariaLabel: 'Fully qualify tables', selected: false },
		{ key: 'singleLine', html: toolsItemHtml(__toolsSingleLineIconSvg, 'Copy query as single line'), ariaLabel: 'Copy query as single line', selected: false }
	];

	try {
		if ((window as any).__kustoDropdown && typeof (window as any).__kustoDropdown.renderMenuItemsHtml === 'function') {
			menu.innerHTML = (window as any).__kustoDropdown.renderMenuItemsHtml(items, {
				dropdownId: id + '_tools',
				onSelectJs: (keyEnc: any) => {
					return (
						"onQueryEditorToolbarAction('" + id + "', '" + keyEnc + "');" +
						" try{window.__kustoDropdown&&window.__kustoDropdown.closeMenuDropdown&&window.__kustoDropdown.closeMenuDropdown('" + id + "_tools_btn','" + id + "_tools_menu')}catch{}"
					);
				}
			});
			return;
		}
	} catch { /* ignore */ }

	// Minimal fallback markup (should rarely be used)
	menu.innerHTML = [
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'doubleToSingle\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsDoubleToSingleIconSvg, 'Replace &quot; with &#39;') + '</div></div>',
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleToDouble\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsSingleToDoubleIconSvg, 'Replace &#39; with &quot;') + '</div></div>',
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'qualifyTables\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsQualifyTablesIconSvg, 'Fully qualify tables') + '</div></div>',
		'<div class="kusto-dropdown-item" role="option" tabindex="-1" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleLine\'); closeToolsDropdown(\'' + id + '\')"><div class="kusto-dropdown-item-main">' + toolsItemHtml(__toolsSingleLineIconSvg, 'Copy query as single line') + '</div></div>'
	].join('');
}

function runMonacoAction( boxId: any, actionId: any) {
	const editor = _win.queryEditors[boxId];
	if (!editor) {
		return;
	}
	try {
		const action = editor.getAction(actionId);
		if (action && typeof action.run === 'function') {
			action.run();
			return;
		}
	} catch {
		// ignore
	}
}

function replaceAllInEditor( boxId: any, from: any, to: any) {
	const editor = _win.queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const value = model.getValue();
	if (!value) {
		return;
	}
	const next = value.split(from).join(to);
	if (next === value) {
		return;
	}
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch {
		// ignore
	}
}

async function exportQueryToPowerBI( boxId: any) {
	const editor = _win.queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	let query = model.getValue() || '';
	// If the editor has multiple statements (blank-line separated), use only the statement at cursor.
	try {
		const blocks = (typeof (window as any).__kustoGetStatementBlocksFromModel === 'function')
			? (window as any).__kustoGetStatementBlocksFromModel(model)
			: [];
		const hasMultipleStatements = blocks && blocks.length > 1;
		if (hasMultipleStatements) {
			const statement = (typeof (window as any).__kustoExtractStatementTextAtCursor === 'function')
				? (window as any).__kustoExtractStatementTextAtCursor(editor)
				: null;
			if (statement) {
				query = statement;
			} else {
				try {
					(_win.vscode as any).postMessage({
						type: 'showInfo',
						message: 'Place the cursor inside a query statement (not on a separator) to export that statement to Power BI.'
					});
				} catch { /* ignore */ }
				return;
			}
		}
	} catch { /* ignore */ }
	const connectionId = __kustoGetConnectionId(boxId);
	const database = __kustoGetDatabase(boxId);
	if (!connectionId) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	const conn = (_win.connections || []).find((c: any) => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch { /* ignore */ }
		return;
	}

	const normalizedQuery = (query || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
	const escapeMString = (s: any) => String(s).replace(/"/g, '""');
	// Escape and indent each line of the query for readability inside the M string
	const indentedQuery = normalizedQuery.split('\n').map((l: any) => '        ' + escapeMString(l)).join('\n');
	const m =
		'let\n' +
		'    Query = Text.Combine({"\n' +
		indentedQuery + '\n' +
		'    "}, ""),\n' +
		'    Source = AzureDataExplorer.Contents("' + escapeMString(clusterUrl) + '", "' + escapeMString(database) + '", Query)\n' +
		'in\n' +
		'    Source';

	// Write to clipboard instead of changing the editor contents.
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(m);
			try {
				(_win.vscode as any).postMessage({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
			} catch {
				// ignore
			}
			return;
		}
	} catch {
		// fall through
	}

	// Fallback path (older webview/permission edge cases).
	try {
		const ta = document.createElement('textarea');
		ta.value = m;
		ta.setAttribute('readonly', '');
		ta.style.position = 'fixed';
		ta.style.left = '-9999px';
		ta.style.top = '0';
		(document.body || document.documentElement).appendChild(ta);
		ta.focus();
		ta.select();
		const ok = document.execCommand('copy');
		try { ta.parentNode && ta.parentNode.removeChild(ta); } catch { /* ignore */ }
		if (!ok) {
			throw new Error('copy failed');
		}
		try {
			(_win.vscode as any).postMessage({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
		} catch {
			// ignore
		}
	} catch {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to copy Power BI query to clipboard.' }); } catch { /* ignore */ }
	}
}

function displayComparisonSummary( sourceBoxId: any, comparisonBoxId: any) {
	const sourceState = _win.__kustoGetResultsState(sourceBoxId);
	const comparisonState = _win.__kustoGetResultsState(comparisonBoxId);
	
	if (!sourceState || !comparisonState) {
		return;
	}

	const escapeHtml = (s: any) => {
		return String(s ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const getBoxLabel = (boxId: any) => {
		try {
			const name = __kustoGetSectionName(boxId);
			return name || String(boxId || '').trim() || 'Dataset';
		} catch {
			return String(boxId || '').trim() || 'Dataset';
		}
	};
	const sourceLabel = getBoxLabel(sourceBoxId);
	const comparisonLabel = getBoxLabel(comparisonBoxId);
	const pluralRows = (n: any) => (Number(n) === 1 ? 'row' : 'rows');
	
	const sourceRows = sourceState.rows ? sourceState.rows.length : 0;
	const comparisonRows = comparisonState.rows ? comparisonState.rows.length : 0;
	const sourceCols = sourceState.columns ? sourceState.columns.length : 0;
	const comparisonCols = comparisonState.columns ? comparisonState.columns.length : 0;
	
	// Extract execution times
	const sourceExecTime = sourceState.metadata && sourceState.metadata.executionTime || '';
	const comparisonExecTime = comparisonState.metadata && comparisonState.metadata.executionTime || '';
	
	// Parse execution times (e.g., "123ms" or "1.23s")
	const parseExecTime = (timeStr: any) => {
		if (!timeStr) return null;
		const match = timeStr.match(/([\d.]+)\s*(ms|s)/);
		if (!match) return null;
		const value = parseFloat(match[1]);
		const unit = match[2];
		return unit === 's' ? value * 1000 : value; // Convert to ms
	};
	
	const sourceMs = parseExecTime(sourceExecTime);
	const comparisonMs = parseExecTime(comparisonExecTime);
	
	let perfMessage = '';
	if (sourceMs !== null && comparisonMs !== null && sourceMs > 0) {
		const diff = sourceMs - comparisonMs;
		const percentChange = ((diff / sourceMs) * 100).toFixed(1);
		if (diff > 0) {
			perfMessage = `<span style="color: #89d185;">\u2713 ${percentChange}% faster (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else if (diff < 0) {
			perfMessage = `<span style="color: #f48771;">\u26a0 ${Math.abs(Number(percentChange))}% slower (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else {
			perfMessage = `<span style="color: #cccccc;">\u2248 Same performance (${sourceExecTime})</span>`;
		}
	} else if (sourceExecTime && comparisonExecTime) {
		perfMessage = `<span style="color: #cccccc;">${sourceExecTime} \u2192 ${comparisonExecTime}</span>`;
	}

	// ─── Server-side statistics comparison ───
	const sourceStats = (sourceState.metadata && sourceState.metadata.serverStats) || null;
	const comparisonStats = (comparisonState.metadata && comparisonState.metadata.serverStats) || null;

	// Helper: format a delta metric line.
	// sourceVal/comparisonVal are numbers (or null/undefined to skip).
	// options: { emoji, label, formatter, lowerIsBetter (default true), unit (for raw fallback) }
	const formatDelta = (sourceVal: any, comparisonVal: any, opts: any) => {
		const emoji = opts.emoji || '';
		const label = opts.label || '';
		const fmt = opts.formatter || ((v: any) => String(v));
		const lowerIsBetter = opts.lowerIsBetter !== false;

		if (sourceVal == null || comparisonVal == null || !isFinite(sourceVal) || !isFinite(comparisonVal)) {
			return null; // not available
		}

		const sFormatted = fmt(sourceVal);
		const cFormatted = fmt(comparisonVal);

		if (sourceVal === 0 && comparisonVal === 0) {
			return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		}

		const diff = sourceVal - comparisonVal;
		if (diff === 0) {
			return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		}

		const base = sourceVal !== 0 ? sourceVal : 1;
		const pct = Math.abs((diff / base) * 100).toFixed(1);
		// "improved" means lower-is-better and value went down, or higher-is-better and value went up.
		const improved = lowerIsBetter ? (diff > 0) : (diff < 0);
		const verb = lowerIsBetter ? (improved ? 'less' : 'more') : (improved ? 'more' : 'less');
		const color = improved ? '#89d185' : '#f48771';
		const icon = improved ? '\u2713' : '\u26a0';

		return `<div class="comparison-metric">${emoji} ${label}: <span style="color: ${color};">${icon} ${pct}% ${verb} (${sFormatted} \u2192 ${cFormatted})</span></div>`;
	};

	// Formatters
	const fmtCpuMs = (ms: any) => {
		if (ms < 1000) { return ms.toFixed(1) + 'ms'; }
		return (ms / 1000).toFixed(3) + 's';
	};
	const fmtBytes = (bytes: any) => {
		if (bytes == null || !isFinite(bytes)) { return '?'; }
		if (bytes < 1024) { return bytes + ' B'; }
		if (bytes < 1024 * 1024) { return (bytes / 1024).toFixed(1) + ' KB'; }
		if (bytes < 1024 * 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
		return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
	};
	const fmtNum = (n: any) => {
		if (n == null) { return '?'; }
		return Number(n).toLocaleString();
	};

	// Build per-metric lines (only shown when server stats are available for both)
	let cpuMessage = null;
	let memoryMessage = null;
	let extentsMessage = null;
	let cacheMessage = null;

	if (sourceStats && comparisonStats) {
		cpuMessage = formatDelta(sourceStats.cpuTimeMs, comparisonStats.cpuTimeMs, {
			emoji: '\uD83D\uDDA5\uFE0F', label: 'Server CPU', formatter: fmtCpuMs, lowerIsBetter: true
		});
		memoryMessage = formatDelta(sourceStats.peakMemoryPerNode, comparisonStats.peakMemoryPerNode, {
			emoji: '\uD83D\uDCBE', label: 'Peak memory', formatter: fmtBytes, lowerIsBetter: true
		});
		extentsMessage = formatDelta(sourceStats.extentsScanned, comparisonStats.extentsScanned, {
			emoji: '\uD83D\uDCCA', label: 'Extents scanned', formatter: fmtNum, lowerIsBetter: true
		});

		// Cache hit rate: compute as percentage hits/(hits+misses), compare the rates.
		const cacheRate = (stats: any) => {
			const mh = typeof stats.memoryCacheHits === 'number' ? stats.memoryCacheHits : 0;
			const mm = typeof stats.memoryCacheMisses === 'number' ? stats.memoryCacheMisses : 0;
			const dh = typeof stats.diskCacheHits === 'number' ? stats.diskCacheHits : 0;
			const dm = typeof stats.diskCacheMisses === 'number' ? stats.diskCacheMisses : 0;
			const hits = mh + dh;
			const total = hits + mm + dm;
			return total > 0 ? (hits / total) * 100 : null;
		};
		const sourceRate = cacheRate(sourceStats);
		const comparisonRate = cacheRate(comparisonStats);
		const fmtRate = (r: any) => r.toFixed(1) + '%';
		cacheMessage = formatDelta(sourceRate, comparisonRate, {
			emoji: '\uD83C\uDFAF', label: 'Cache hit rate', formatter: fmtRate, lowerIsBetter: false
		});
	}
	
	// Check data consistency.
	// Data matches if:
	// 1. Same columns (names match, order doesn't matter)
	// 2. Same rows (no unmatched rows in either dataset, order doesn't matter)
	const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
	
	let rowsMatch = false;
	let commonCount = 0;
	let onlyACount = 0;
	let onlyBCount = 0;
	let countsLabel = '';
	try {
		const dv = (window && (window as any).__kustoDiffView) ? (window as any).__kustoDiffView : null;
		if (dv && typeof dv.buildModelFromResultsStates === 'function') {
			const model = dv.buildModelFromResultsStates(sourceState, comparisonState, { aLabel: sourceLabel, bLabel: comparisonLabel });
			const p = (model && model.partitions && typeof model.partitions === 'object') ? model.partitions : null;
			commonCount = Array.isArray(p && p.common) ? p.common.length : 0;
			onlyACount = Array.isArray(p && p.onlyA) ? p.onlyA.length : 0;
			onlyBCount = Array.isArray(p && p.onlyB) ? p.onlyB.length : 0;
			countsLabel =
				' (' +
				String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' +
				String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + _win.escapeHtml(sourceLabel) +
				', ' +
				String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + _win.escapeHtml(comparisonLabel) +
				')';
			rowsMatch = (onlyACount === 0 && onlyBCount === 0);
		}
	} catch { /* ignore */ }

	// Data matches only if both columns AND rows match.
	const dataMatches = columnHeaderNamesMatch && rowsMatch;

	// Additional metadata for warnings (order differences don't affect data matching).
	const rowOrderMatches = __kustoDoRowOrderMatch(sourceState, comparisonState);
	const columnOrderMatches = __kustoDoColumnOrderMatch(sourceState, comparisonState);
	const warningNeeded = dataMatches && !(rowOrderMatches && columnOrderMatches);

	const yesNo = (v: any) => (v ? 'yes' : 'no');
	const warningTitle =
		'Order of rows matches: ' + yesNo(rowOrderMatches) + '\n' +
		'Order of columns matches: ' + yesNo(columnOrderMatches) + '\n' +
		'Names of column headers match: ' + yesNo(columnHeaderNamesMatch);

	let dataMessage = '';
	if (dataMatches) {
		dataMessage =
			'<span class="comparison-data-match">\u2713 Data matches</span>' +
			(warningNeeded
				? '<span class="comparison-warning-icon" title="' + warningTitle.replace(/"/g, '&quot;') + '">\u26a0</span>'
				: '');
	} else {
		// Determine if the difference is in columns, rows, or both.
		const columnDiff = __kustoGetColumnDifferences(sourceState, comparisonState);
		const hasColumnDiff = columnDiff.onlyInA.length > 0 || columnDiff.onlyInB.length > 0;
		const hasRowDiff = onlyACount > 0 || onlyBCount > 0;

		let diffLabel = '';
		let diffTitle = 'View diff';
		if (hasColumnDiff && !hasRowDiff) {
			// Only column differences
			const parts = [];
			if (columnDiff.onlyInA.length > 0) {
				parts.push(String(columnDiff.onlyInA.length) + ' missing ' + (columnDiff.onlyInA.length === 1 ? 'column' : 'columns') + ' in ' + _win.escapeHtml(comparisonLabel));
			}
			if (columnDiff.onlyInB.length > 0) {
				parts.push(String(columnDiff.onlyInB.length) + ' extra ' + (columnDiff.onlyInB.length === 1 ? 'column' : 'columns') + ' in ' + _win.escapeHtml(comparisonLabel));
			}
			diffLabel = ' (' + parts.join(', ') + ')';
			const titleParts = ['View diff'];
			if (columnDiff.onlyInA.length > 0) {
				titleParts.push('Missing in ' + comparisonLabel + ': ' + columnDiff.onlyInA.join(', '));
			}
			if (columnDiff.onlyInB.length > 0) {
				titleParts.push('Extra in ' + comparisonLabel + ': ' + columnDiff.onlyInB.join(', '));
			}
			diffTitle = titleParts.join('\n');
		} else if (hasRowDiff && !hasColumnDiff) {
			// Only row differences
			diffLabel = ' (' +
				String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' +
				String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + _win.escapeHtml(sourceLabel) +
				', ' +
				String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + _win.escapeHtml(comparisonLabel) +
				')';
			diffTitle = 'View diff\nUnmatched rows: ' + String(onlyACount) + ' in ' + sourceLabel + ', ' + String(onlyBCount) + ' in ' + comparisonLabel;
		} else if (hasColumnDiff && hasRowDiff) {
			// Both column and row differences
			const colParts = [];
			if (columnDiff.onlyInA.length > 0) {
				colParts.push(String(columnDiff.onlyInA.length) + ' missing');
			}
			if (columnDiff.onlyInB.length > 0) {
				colParts.push(String(columnDiff.onlyInB.length) + ' extra');
			}
			diffLabel = ' (' + colParts.join('/') + ' columns, ' +
				String(onlyACount + onlyBCount) + ' unmatched ' + pluralRows(onlyACount + onlyBCount) + ')';
			diffTitle = 'View diff\nColumn differences and row differences detected.';
		}

		// Use JSON.stringify to produce a valid JS string literal (double-quoted) so the
		// inline onclick handler never breaks due to escaping.
		const aBoxIdLit = JSON.stringify(String(sourceBoxId || ''));
		const bBoxIdLit = JSON.stringify(String(comparisonBoxId || ''));
		dataMessage =
			'<span class="comparison-data-diff-icon" aria-hidden="true">\u26a0</span> ' +
			'<a href="#" class="comparison-data-diff comparison-diff-link" ' +
			"onclick='try{openDiffViewModal({ aBoxId: " + aBoxIdLit + ", bBoxId: " + bBoxIdLit + " })}catch{}; return false;' " +
			'title="' + diffTitle.replace(/"/g, '&quot;') + '">Data differs' + diffLabel + '</a>';
	}
	
	// Create or update comparison summary banner
	const comparisonBox = document.getElementById(comparisonBoxId) as any;
	if (!comparisonBox) {
		return;
	}
	
	// Find or create the banner element
	let banner = comparisonBox.querySelector('.comparison-summary-banner');
	if (!banner) {
		banner = document.createElement('div');
		banner.className = 'comparison-summary-banner';
		// Insert banner right before the editor wrapper (below the header).
		const editorWrapper = comparisonBox.querySelector('.query-editor-wrapper');
		if (editorWrapper && editorWrapper.parentNode) {
			editorWrapper.parentNode.insertBefore(banner, editorWrapper);
		}
	}
	
	banner.innerHTML = `
		<div class="comparison-summary-content">
			<strong>How do the two queries compare?</strong>
			<div class="comparison-metrics">
				<div class="comparison-metric">\u26a1 Execution speed: ${perfMessage}</div>
				${cpuMessage || ''}
				${memoryMessage || ''}
				${extentsMessage || ''}
				${cacheMessage || ''}
				<div class="comparison-metric">\ud83d\udccb Data returned: ${dataMessage}</div>
			</div>
		</div>
	`;
	try {
		const acceptTooltip = dataMatches
			? (warningNeeded
				? 'Data matches, but row/column ordering or header details differ. Accept optimizations with caution.'
				: 'Results match. Accept optimizations.')
			: 'Results differ. Accept optimizations is enabled — review the diff before accepting.';
		__kustoUpdateAcceptOptimizationsButton(comparisonBoxId, true, acceptTooltip);
	} catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(comparisonBoxId); } catch { /* ignore */ }

	// Notify the extension backend so it can coordinate validation retries.
	try {
		(_win.vscode as any).postMessage({
			type: 'comparisonSummary',
			sourceBoxId: String(sourceBoxId || ''),
			comparisonBoxId: String(comparisonBoxId || ''),
			dataMatches: !!dataMatches,
			headersMatch: !!columnHeaderNamesMatch,
			rowOrderMatches: !!rowOrderMatches,
			columnOrderMatches: !!columnOrderMatches
		});
	} catch { /* ignore */ }
}

function __kustoEnsureOptimizePrepByBoxId() {
	try {
		if (!(window as any).__kustoOptimizePrepByBoxId || typeof (window as any).__kustoOptimizePrepByBoxId !== 'object') {
			(window as any).__kustoOptimizePrepByBoxId = {};
		}
		return (window as any).__kustoOptimizePrepByBoxId;
	} catch {
		return {};
	}
}

function __kustoHideOptimizePromptForBox( boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (host) {
		host.style.display = 'none';
		host.innerHTML = '';
	}
	try {
		const pending = __kustoEnsureOptimizePrepByBoxId();
		delete pending[boxId];
	} catch { /* ignore */ }

	try {
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
		if (optimizeBtn) {
			optimizeBtn.disabled = false;
			if (optimizeBtn.dataset && optimizeBtn.dataset.originalContent) {
				optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
				delete optimizeBtn.dataset.originalContent;
			}
		}
	} catch { /* ignore */ }

	try {
		__kustoSetOptimizeInProgress(boxId, false, '');
	} catch { /* ignore */ }
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') {
			(window as any).__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

function __kustoSetOptimizeInProgress( boxId: any, inProgress: any, statusText: any) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status') as any;
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
		if (!statusEl || !cancelBtn) {
			return;
		}
		const on = !!inProgress;
		try {
			if (optimizeBtn && optimizeBtn.dataset) {
				if (on) {
					optimizeBtn.dataset.kustoOptimizeInProgress = '1';
					optimizeBtn.disabled = true;
				} else {
					delete optimizeBtn.dataset.kustoOptimizeInProgress;
				}
			}
		} catch { /* ignore */ }
		statusEl.style.display = on ? '' : 'none';
		cancelBtn.style.display = on ? '' : 'none';
		if (on) {
			statusEl.textContent = String(statusText || 'Optimizing…');
			cancelBtn.disabled = false;

			try {
				const text = String(statusText || '');
				const shouldStartSpinner = /waiting\s+for\s+copilot\s+response/i.test(text);
				const spinnerAlreadyOn = !!(optimizeBtn && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeSpinnerActive === '1');
				if (optimizeBtn && (shouldStartSpinner || spinnerAlreadyOn)) {
					if (!optimizeBtn.dataset.originalContent) {
						optimizeBtn.dataset.originalContent = optimizeBtn.innerHTML;
					}
					optimizeBtn.dataset.kustoOptimizeSpinnerActive = '1';
					optimizeBtn.innerHTML = '<span class="query-spinner" aria-hidden="true"></span>';
				}
			} catch { /* ignore */ }
		} else {
			statusEl.textContent = '';
			cancelBtn.disabled = false;
			try {
				if (optimizeBtn && optimizeBtn.dataset) {
					delete optimizeBtn.dataset.kustoOptimizeSpinnerActive;
					if (optimizeBtn.dataset.originalContent) {
						optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
						delete optimizeBtn.dataset.originalContent;
					}
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
}

function __kustoUpdateOptimizeStatus( boxId: any, statusText: any) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status') as any;
		if (!statusEl) return;
		statusEl.textContent = String(statusText || '');
	} catch { /* ignore */ }
}

function __kustoCancelOptimizeQuery( boxId: any) {
	try {
		__kustoUpdateOptimizeStatus(boxId, 'Canceling…');
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch { /* ignore */ }
	try {
		(_win.vscode as any).postMessage({
			type: 'cancelOptimizeQuery',
			boxId: String(boxId || '')
		});
	} catch { /* ignore */ }
}

function __kustoShowOptimizePromptLoading( boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) {
		return;
	}
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-loading">Loading optimization options…</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoHideOptimizePromptForBox(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';
}

const __kustoOptimizeModelStorageKey = 'kusto.optimize.lastModelId';

function __kustoGetLastOptimizeModelId() {
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && (_win.vscode as any).getState) ? ((_win.vscode as any).getState() || {}) : {};
		if (state && state.lastOptimizeModelId) {
			return String(state.lastOptimizeModelId);
		}
	} catch { /* ignore */ }
	try {
		return String(localStorage.getItem(__kustoOptimizeModelStorageKey) || '');
	} catch { /* ignore */ }
	return '';
}

function __kustoSetLastOptimizeModelId( modelId: any) {
	const id = String(modelId || '');
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && (_win.vscode as any).getState) ? ((_win.vscode as any).getState() || {}) : {};
		state.lastOptimizeModelId = id;
		if (typeof _win.vscode !== 'undefined' && _win.vscode && (_win.vscode as any).setState) {
			(_win.vscode as any).setState(state);
		}
	} catch { /* ignore */ }
	try {
		if (id) {
			localStorage.setItem(__kustoOptimizeModelStorageKey, id);
		}
	} catch { /* ignore */ }
}

function __kustoApplyOptimizeQueryOptions( boxId: any, models: any, selectedModelId: any, promptText: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) {
		return;
	}

	const safeModels = Array.isArray(models) ? models : [];
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-row">' +
		'<label class="optimize-config-label" for="' + boxId + '_optimize_model">Model</label>' +
		'<select class="optimize-config-select" id="' + boxId + '_optimize_model"></select>' +
		'</div>' +
		'<div class="optimize-config-row">' +
		'<label class="optimize-config-label" for="' + boxId + '_optimize_prompt">Prompt</label>' +
		'<textarea class="optimize-config-textarea" id="' + boxId + '_optimize_prompt" spellcheck="false"></textarea>' +
		'</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-run-btn" onclick="__kustoRunOptimizeQueryWithOverrides(\'' + boxId + '\')">Optimize</button>' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoHideOptimizePromptForBox(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';

	const selectEl = document.getElementById(boxId + '_optimize_model') as any;
	if (selectEl) {
		selectEl.innerHTML = '';
		for (const m of safeModels) {
			if (!m || !m.id) {
				continue;
			}
			const opt = document.createElement('option');
			opt.value = String(m.id);
			const label = String(m.label || m.id);
			const id = String(m.id);
			opt.textContent = (label && label !== id) ? label + ' (' + id + ')' : id;
			opt.setAttribute('data-short-label', label);
			selectEl.appendChild(opt);
		}

		const preferredModelId = __kustoGetLastOptimizeModelId();
		let preferredExists = false;
		if (preferredModelId) {
			for (let i = 0; i < selectEl.options.length; i++) {
				if (selectEl.options[i].value === preferredModelId) {
					preferredExists = true;
					break;
				}
			}
		}

		if (preferredExists) {
			selectEl.value = preferredModelId;
		} else if (selectedModelId) {
			selectEl.value = String(selectedModelId);
		}
		if (!selectEl.value && selectEl.options && selectEl.options.length > 0) {
			selectEl.selectedIndex = 0;
		}
	}

	const promptEl = document.getElementById(boxId + '_optimize_prompt') as any;
	if (promptEl) {
		promptEl.value = String(promptText || '');
	}
}

function __kustoRunOptimizeQueryWithOverrides( boxId: any) {
	const pending = __kustoEnsureOptimizePrepByBoxId();
	const req = pending[boxId];
	if (!req) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Optimization request is no longer available. Please try again.' }); } catch { /* ignore */ }
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}

	// Optimization naming rule:
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - The optimized section will then use "<source name> (optimized)"
	try {
		let sourceName = __kustoGetSectionName(boxId);
		if (!sourceName && typeof (window as any).__kustoPickNextAvailableSectionLetterName === 'function') {
			sourceName = (window as any).__kustoPickNextAvailableSectionLetterName(boxId);
			__kustoSetSectionName(boxId, sourceName);
			try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
		}
		if (sourceName) {
			req.queryName = sourceName;
		}
	} catch { /* ignore */ }

	const modelId = (document.getElementById(boxId + '_optimize_model') as any || {}).value || '';
	const promptText = (document.getElementById(boxId + '_optimize_prompt') as any || {}).value || '';
	try {
		__kustoSetLastOptimizeModelId(modelId);
	} catch { /* ignore */ }

	// Close prompt UI and show spinner on the main optimize button
	try {
		const host = document.getElementById(boxId + '_optimize_config') as any;
		if (host) {
			host.style.display = 'none';
			host.innerHTML = '';
		}
	} catch { /* ignore */ }

	const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
	if (optimizeBtn) {
		optimizeBtn.disabled = true;
		const originalContent = optimizeBtn.innerHTML;
		optimizeBtn.dataset.originalContent = originalContent;
	}
	try {
		__kustoSetOptimizeInProgress(boxId, true, 'Starting optimization…');
	} catch { /* ignore */ }

	try {
		(_win.vscode as any).postMessage({
			type: 'optimizeQuery',
			query: String(req.query || ''),
			connectionId: String(req.connectionId || ''),
			database: String(req.database || ''),
			boxId,
			queryName: String(req.queryName || ''),
			modelId: String(modelId || ''),
			promptText: String(promptText || '')
		});
		delete pending[boxId];
	} catch (err: any) {
		console.error('Error sending optimization request:', err);
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to start query optimization' }); } catch { /* ignore */ }
		// Restore button state
		if (optimizeBtn) {
			optimizeBtn.disabled = false;
			if (optimizeBtn.dataset.originalContent) {
				optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
				delete optimizeBtn.dataset.originalContent;
			}
		}
		__kustoHideOptimizePromptForBox(boxId);
	}
}

async function optimizeQueryWithCopilot( boxId: any, comparisonQueryOverride: any, options: any) {
	const editor = _win.queryEditors[boxId];
	if (!editor) {
		return '';
	}
	const model = editor.getModel();
	if (!model) {
		return '';
	}

	const shouldExecute = !(options && options.skipExecute === true);
	const isManualCompareOnly = !shouldExecute;

	// Defensive: opening the comparison/diff view should never trigger/keep any
	// optimize (LLM) prompt state. If the optimize prompt was open or pending from
	// earlier, clear it so the diff view remains strictly non-LLM.
	if (isManualCompareOnly) {
		try { __kustoHideOptimizePromptForBox(boxId); } catch { /* ignore */ }
		try { __kustoSetOptimizeInProgress(boxId, false, ''); } catch { /* ignore */ }
	}

	// Hide results to keep the UI focused during comparison setup.
	try { __kustoSetResultsVisible(boxId, false); } catch { /* ignore */ }

	const query = model.getValue() || '';
	if (!query.trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'No query to compare' }); } catch { /* ignore */ }
		return '';
	}
	const overrideText = (typeof comparisonQueryOverride === 'string') ? String(comparisonQueryOverride || '') : '';
	if (comparisonQueryOverride != null && !overrideText.trim()) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'No comparison query provided' }); } catch { /* ignore */ }
		return '';
	}
	// Optimization naming rule (applies when we are creating an "optimized" comparison section):
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - Name the optimized section "<source name> (optimized)"
	//
	// This applies to:
	// - The Copilot optimize flow (optimized override query provided)
	// - The "Compare two queries" button (creates the optimized comparison section first)
	const isCompareButtonScenario = isManualCompareOnly && (comparisonQueryOverride == null);
	const isOptimizeScenario = ((comparisonQueryOverride != null) && !!overrideText.trim()) || isCompareButtonScenario;
	let sourceNameForOptimize = '';
	let desiredOptimizedName = '';
	if (isOptimizeScenario) {
		try {
			const nameInput = null;
			sourceNameForOptimize = __kustoGetSectionName(boxId);
			if (!sourceNameForOptimize && typeof (window as any).__kustoPickNextAvailableSectionLetterName === 'function') {
				sourceNameForOptimize = (window as any).__kustoPickNextAvailableSectionLetterName(boxId);
				__kustoSetSectionName(boxId, sourceNameForOptimize);
				try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
			}
			if (sourceNameForOptimize) {
				desiredOptimizedName = sourceNameForOptimize + ' (optimized)';
			}
		} catch { /* ignore */ }
	}
	
	const connectionId = __kustoGetConnectionId(boxId);
	const database = __kustoGetDatabase(boxId);
	if (!connectionId) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return '';
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return '';
	}

	// If a comparison already exists for this source, reuse it.
	try {
		const existingComparisonBoxId = (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId && _win.optimizationMetadataByBoxId[boxId])
			? _win.optimizationMetadataByBoxId[boxId].comparisonBoxId
			: '';
		if (existingComparisonBoxId) {
			const comparisonBoxEl = document.getElementById(existingComparisonBoxId) as any;
			const comparisonEditor = _win.queryEditors && _win.queryEditors[existingComparisonBoxId];
			if (comparisonBoxEl && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
				let nextComparisonQuery = overrideText.trim() ? overrideText : query;
				try {
					if (typeof (window as any).__kustoPrettifyKustoText === 'function') {
						nextComparisonQuery = (window as any).__kustoPrettifyKustoText(nextComparisonQuery);
					}
				} catch { /* ignore */ }
				try { comparisonEditor.setValue(nextComparisonQuery); } catch { /* ignore */ }
				try {
					if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
						_win.optimizationMetadataByBoxId[existingComparisonBoxId] = _win.optimizationMetadataByBoxId[existingComparisonBoxId] || {};
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].sourceBoxId = boxId;
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].isComparison = true;
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].originalQuery = _win.queryEditors[boxId] ? _win.queryEditors[boxId].getValue() : query;
						_win.optimizationMetadataByBoxId[existingComparisonBoxId].optimizedQuery = nextComparisonQuery;
						_win.optimizationMetadataByBoxId[boxId] = _win.optimizationMetadataByBoxId[boxId] || {};
						_win.optimizationMetadataByBoxId[boxId].comparisonBoxId = existingComparisonBoxId;
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoSetLinkedOptimizationMode === 'function') {
						__kustoSetLinkedOptimizationMode(boxId, existingComparisonBoxId, true);
					}
				} catch { /* ignore */ }
				// Set the comparison box name.
				try {
					if (desiredOptimizedName) {
						__kustoSetSectionName(existingComparisonBoxId, desiredOptimizedName);
						try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
					} else {
						const currentName = __kustoGetSectionName(existingComparisonBoxId);
						let shouldReplace = !currentName;
						if (!shouldReplace) {
							const upper = currentName.toUpperCase();
							if (upper.endsWith(' (COMPARISON)') || upper.endsWith(' (OPTIMIZED)')) {
								shouldReplace = true;
							}
						}
						if (shouldReplace) {
							__kustoSetSectionName(existingComparisonBoxId, __kustoPickNextAvailableSectionLetterName(existingComparisonBoxId));
							try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
						}
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoSetResultsVisible === 'function') {
						__kustoSetResultsVisible(boxId, false);
						__kustoSetResultsVisible(existingComparisonBoxId, false);
					}
				} catch { /* ignore */ }
				if (shouldExecute) {
					try {
						executeQuery(boxId);
						setTimeout(() => {
							try { executeQuery(existingComparisonBoxId); } catch { /* ignore */ }
						}, 100);
					} catch { /* ignore */ }
				}
				return existingComparisonBoxId;
			}
			// Stale mapping: comparison was removed; clear and fall back to creating a new one.
			try {
				if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
					delete _win.optimizationMetadataByBoxId[boxId];
					delete _win.optimizationMetadataByBoxId[existingComparisonBoxId];
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	// Do not auto-name the source section for plain comparisons.
	// For optimization scenarios, we already ensured a name above.
	let queryName = sourceNameForOptimize || __kustoGetSectionName(boxId);
	if (!desiredOptimizedName && isOptimizeScenario && queryName) {
		desiredOptimizedName = queryName + ' (optimized)';
	}

	// Create a comparison query box below the source box.
	// If a query override is provided, compare source query vs the provided query.
	let comparisonQuery = overrideText.trim() ? overrideText : query;
	try {
		if (typeof (window as any).__kustoPrettifyKustoText === 'function') {
			comparisonQuery = (window as any).__kustoPrettifyKustoText(comparisonQuery);
		}
	} catch { /* ignore */ }

	let comparisonBoxId = '';
	try {
		comparisonBoxId = addQueryBox({
			id: 'query_cmp_' + Date.now(),
			initialQuery: comparisonQuery,
			isComparison: true,
			defaultResultsVisible: false
		});
	} catch (err: any) {
		console.error('Error creating comparison box:', err);
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to create comparison section' }); } catch { /* ignore */ }
		return '';
	}

	try {
		if (typeof __kustoSetResultsVisible === 'function') {
			__kustoSetResultsVisible(boxId, false);
			__kustoSetResultsVisible(comparisonBoxId, false);
		}
	} catch { /* ignore */ }
	try {
		if (typeof __kustoSetLinkedOptimizationMode === 'function') {
			__kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, true);
		}
	} catch { /* ignore */ }

	// Store comparison metadata (reuses the existing optimization comparison flow).
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			_win.optimizationMetadataByBoxId[comparisonBoxId] = {
				sourceBoxId: boxId,
				isComparison: true,
				originalQuery: _win.queryEditors[boxId] ? _win.queryEditors[boxId].getValue() : query,
				optimizedQuery: comparisonQuery
			};
			_win.optimizationMetadataByBoxId[boxId] = {
				comparisonBoxId: comparisonBoxId
			};
		}
	} catch { /* ignore */ }

	// Position the comparison box right after the source box.
	try {
		const sourceBox = document.getElementById(boxId) as any;
		const comparisonBox = document.getElementById(comparisonBoxId) as any;
		if (sourceBox && comparisonBox && sourceBox.parentNode) {
			sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
		}
	} catch { /* ignore */ }

	// Set connection and database to match source.
	try {
		const compKwEl = __kustoGetQuerySectionElement(comparisonBoxId);
		if (compKwEl) {
			if (typeof compKwEl.setConnectionId === 'function') compKwEl.setConnectionId(connectionId);
			if (typeof compKwEl.setDesiredDatabase === 'function') compKwEl.setDesiredDatabase(database);
			compKwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: comparisonBoxId, connectionId: connectionId },
				bubbles: true, composed: true,
			}));
			setTimeout(() => {
				try {
					if (typeof compKwEl.setDatabase === 'function') compKwEl.setDatabase(database);
				} catch { /* ignore */ }
			}, 100);
		}
	} catch { /* ignore */ }

	// Set the query name.
	try {
		if (desiredOptimizedName) {
			__kustoSetSectionName(comparisonBoxId, desiredOptimizedName);
		} else {
			const existing = __kustoGetSectionName(comparisonBoxId);
			if (!existing) {
				__kustoSetSectionName(comparisonBoxId, __kustoPickNextAvailableSectionLetterName(comparisonBoxId));
			}
		}
	} catch { /* ignore */ }

	if (shouldExecute) {
		// Execute both queries for comparison.
		try {
			executeQuery(boxId);
			setTimeout(() => {
				try { executeQuery(comparisonBoxId); } catch { /* ignore */ }
			}, 100);
		} catch { /* ignore */ }
	}

	return comparisonBoxId;
}

async function fullyQualifyTablesInEditor( boxId: any) {
	const editor = _win.queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const connectionId = __kustoGetConnectionId(boxId);
	const database = __kustoGetDatabase(boxId);
	if (!connectionId) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	const conn = (_win.connections || []).find((c: any) => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch { /* ignore */ }
		return;
	}

	const currentSchema = _win.schemaByBoxId ? _win.schemaByBoxId[boxId] : null;
	const currentTables = currentSchema && Array.isArray(currentSchema.tables) ? currentSchema.tables : null;
	if (!currentTables || currentTables.length === 0) {
		// Best-effort: request schema fetch and ask the user to retry.
		try { _win.ensureSchemaForBox(boxId); } catch { /* ignore */ }
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Schema not loaded yet. Wait for “Schema loaded” then try again.' }); } catch { /* ignore */ }
		return;
	}

	const text = model.getValue() || '';
	const next = await qualifyTablesInTextPriority(text, {
		boxId,
		connectionId,
		currentDatabase: database,
		currentClusterUrl: clusterUrl,
		currentTables
	});
	if (next === text) {
		return;
	}
	try {
		editor.executeEdits('toolbar', [{ range: model.getFullModelRange(), text: next }]);
		editor.focus();
	} catch {
		// ignore
	}
}

async function qualifyTablesInTextPriority( text: any, opts: any) {
	const normalizeClusterForKusto = (clusterUrl: any) => {
		let s = String(clusterUrl || '')
			.trim()
			.replace(/^https?:\/\//i, '')
			.replace(/\/+$/, '')
			.replace(/:\d+$/, '');
		// Azure Data Explorer public cloud clusters
		s = s.replace(/\.kusto\.windows\.net$/i, '');
		return s;
	};

	const currentTables = (opts.currentTables || []).map((t: any) => String(t));
	const currentTableLower = new Set(currentTables.map((t: any) => t.toLowerCase()));

	// Prefer language service to find true table-reference ranges (instead of regex/lexer guessing).
	let candidates = [];
	try {
		if (typeof (window as any).__kustoRequestKqlTableReferences === 'function') {
			const res = await (window as any).__kustoRequestKqlTableReferences({
				text,
				connectionId: opts.connectionId,
				database: opts.currentDatabase,
				boxId: opts.boxId
			});
			const refs = res && Array.isArray(res.references) ? res.references : null;
			if (refs && refs.length) {
				candidates = refs
					.map((r: any) => ({ value: String(r.name || ''), start: Number(r.startOffset), end: Number(r.endOffset) }))
					.filter((r: any) => r.value && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
			}
		}
	} catch {
		// ignore and fall back
	}

	// Fallback: previous best-effort lexer (kept for resilience).
	if (!candidates.length) {
		const isIdentChar = (ch: any) => /[A-Za-z0-9_\-]/.test(ch);
		const skipNames = new Set();
		const tokens = [];
		{
			let i = 0;
			let inS = false;
			let inLineComment = false;
			let inBlockComment = false;
			while (i < text.length) {
				const ch = text[i];
				const next = text[i + 1];
				if (inLineComment) {
					if (ch === '\n') inLineComment = false;
					i++;
					continue;
				}
				if (inBlockComment) {
					if (ch === '*' && next === '/') {
						inBlockComment = false;
						i += 2;
						continue;
					}
					i++;
					continue;
				}
				if (inS) {
					if (ch === "'") {
						inS = false;
					}
					i++;
					continue;
				}
				if (ch === '/' && next === '/') {
					inLineComment = true;
					i += 2;
					continue;
				}
				if (ch === '/' && next === '*') {
					inBlockComment = true;
					i += 2;
					continue;
				}
				if (ch === "'") {
					inS = true;
					i++;
					continue;
				}
				if ((ch === '_' || /[A-Za-z]/.test(ch)) && !inS) {
					let j = i + 1;
					while (j < text.length && isIdentChar(text[j])) j++;
					const value = text.slice(i, j);
					tokens.push({ value, start: i, end: j });
					i = j;
					continue;
				}
				i++;
			}
		}

		for (let idx = 0; idx < tokens.length; idx++) {
			const t = tokens[idx];
			if (!t || String(t.value).toLowerCase() !== 'let') {
				continue;
			}
			const nameTok = tokens[idx + 1];
			if (!nameTok) continue;
			let k = nameTok.end;
			while (k < text.length && /\s/.test(text[k])) k++;
			if (text[k] === '=') {
				skipNames.add(nameTok.value);
			}
		}

		for (const tok of tokens) {
			if (skipNames.has(tok.value)) {
				continue;
			}
			// Skip if already qualified (immediate '.' before name).
			let p = tok.start - 1;
			while (p >= 0 && text[p] === ' ') p--;
			if (p >= 0 && text[p] === '.') {
				continue;
			}
			// Skip if this looks like a function call.
			let a = tok.end;
			while (a < text.length && text[a] === ' ') a++;
			if (text[a] === '(') {
				continue;
			}
			candidates.push(tok);
		}
	}

	if (!candidates.length) {
		return text;
	}

	// Resolve each distinct candidate name to its best fully-qualified reference.
	const unresolvedLower = new Set();
	for (const c of candidates) {
		unresolvedLower.add(String(c.value).toLowerCase());
	}
	const resolvedLocationByLower = new Map();
	const fq = (clusterUrl: any, database: any, table: any) => {
		const c = normalizeClusterForKusto(clusterUrl);
		return "cluster('" + c + "').database('" + database + "')." + table;
	};

	const markResolved = (lowerName: any, clusterUrl: any, database: any) => {
		if (!lowerName || resolvedLocationByLower.has(lowerName)) {
			return;
		}
		resolvedLocationByLower.set(lowerName, {
			clusterUrl: String(clusterUrl || ''),
			database: String(database || '')
		});
		unresolvedLower.delete(lowerName);
	};

	// Priority 1: current DB (cached).
	for (const lowerName of Array.from(unresolvedLower)) {
		if (currentTableLower.has(lowerName)) {
			markResolved(lowerName, opts.currentClusterUrl, opts.currentDatabase);
		}
	}

	const requestSchema = async (connectionId: any, database: any) => {
		try {
			if (typeof (window as any).__kustoRequestSchema === 'function') {
				const sch = await (window as any).__kustoRequestSchema(connectionId, database, false);
				try {
					const cid = String(connectionId || '').trim();
					const db = String(database || '').trim();
					if (cid && db && sch) {
						_win.schemaByConnDb[cid + '|' + db] = sch;
					}
				} catch { /* ignore */ }
				return sch;
			}
		} catch {
			// ignore
		}
		return null;
	};

	const requestDatabases = async (connectionId: any, forceRefresh: any) => {
		try {
			if (typeof (window as any).__kustoRequestDatabases === 'function') {
				return await (window as any).__kustoRequestDatabases(connectionId, !!forceRefresh);
			}
		} catch {
			// ignore
		}
		try {
			const cid = String(connectionId || '').trim();
			let clusterKey = '';
			try {
				const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
				const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
				if (clusterUrl) {
					let u = clusterUrl;
					if (!/^https?:\/\//i.test(u)) {
						u = 'https://' + u;
					}
					try {
						clusterKey = String(new URL(u).hostname || '').trim().toLowerCase();
					} catch {
						clusterKey = String(clusterUrl || '').trim().toLowerCase();
					}
				}
			} catch { /* ignore */ }
			const cached = _win.cachedDatabases && _win.cachedDatabases[String(clusterKey || '').trim()];
			return Array.isArray(cached) ? cached : [];
		} catch {
			return [];
		}
	};

	const schemaTablesLowerCache = new WeakMap();
	const getSchemaTableLowerSet = (schema: any) => {
		if (!schema || typeof schema !== 'object') return null;
		try {
			const cached = schemaTablesLowerCache.get(schema);
			if (cached) return cached;
			const tables = Array.isArray(schema.tables) ? schema.tables : [];
			const setLower = new Set(tables.map((t: any) => String(t).toLowerCase()));
			schemaTablesLowerCache.set(schema, setLower);
			return setLower;
		} catch {
			return null;
		}
	};

	const tryResolveFromSchema = (schema: any, clusterUrl: any, dbName: any) => {
		if (!schema || !dbName || unresolvedLower.size === 0) {
			return;
		}
		const tableLowerSet = getSchemaTableLowerSet(schema);
		if (!tableLowerSet) {
			return;
		}
		for (const lowerName of Array.from(unresolvedLower)) {
			if (tableLowerSet.has(lowerName)) {
				markResolved(lowerName, clusterUrl, dbName);
			}
		}
	};

	const scanCachedSchemasForMatches = (schemas: any, clusterUrl: any) => {
		for (const entry of schemas) {
			if (!entry) continue;
			const dbName = String(entry.database || '').trim();
			const schema = entry.schema;
			if (!dbName || !schema) continue;
			tryResolveFromSchema(schema, clusterUrl, dbName);
			if (unresolvedLower.size === 0) return;
		}
	};

	const getCachedSchemasForConnection = (connectionId: any) => {
		const cid = String(connectionId || '').trim();
		if (!cid) return [];
		const prefix = cid + '|';
		const list = [];
		try {
			for (const key of Object.keys(_win.schemaByConnDb || {})) {
				if (!key || !key.startsWith(prefix)) continue;
				const dbName = key.slice(prefix.length);
				if (!dbName) continue;
				list.push({ database: dbName, schema: _win.schemaByConnDb[key] });
			}
		} catch { /* ignore */ }
		list.sort((a: any, b: any) => String(a.database).toLowerCase().localeCompare(String(b.database).toLowerCase()));
		return list;
	};

	// Step 2: search all cached schemas in priority order.
	// Priority 2: current cluster (cached).
	if (unresolvedLower.size > 0) {
		const cachedCurrentConn = getCachedSchemasForConnection(opts.connectionId)
			.filter((e: any) => String(e.database) !== String(opts.currentDatabase));
		scanCachedSchemasForMatches(cachedCurrentConn, opts.currentClusterUrl);
	}

	// Priority 3: across all clusters (cached).
	if (unresolvedLower.size > 0) {
		const connById = new Map();
		try {
			for (const c of (_win.connections || [])) {
				if (c && c.id) {
					connById.set(String(c.id), c);
				}
			}
		} catch { /* ignore */ }

		// Deterministic: iterate connections sorted by display clusterUrl.
		const otherConns = Array.from(connById.entries())
			.filter(([cid]) => cid !== String(opts.connectionId || '').trim())
			.map(([cid, c]) => ({ cid, clusterUrl: String((c && c.clusterUrl) || '').trim() }))
			.filter((x: any) => !!x.clusterUrl)
			.sort((a: any, b: any) => normalizeClusterForKusto(a.clusterUrl).toLowerCase().localeCompare(normalizeClusterForKusto(b.clusterUrl).toLowerCase()));

		for (const c of otherConns) {
			if (unresolvedLower.size === 0) break;
			const cached = getCachedSchemasForConnection(c.cid);
			scanCachedSchemasForMatches(cached, c.clusterUrl);
		}
	}

	// Step 3: if still unmatched, fetch missing schemas, then repeat Step 2 against the newly-cached data.
	if (unresolvedLower.size > 0) {
		// Fetch missing schemas for current connection first.
		const cid = String(opts.connectionId || '').trim();
		let dbs = await requestDatabases(cid, false);
		for (const db of (Array.isArray(dbs) ? dbs : [])) {
			if (unresolvedLower.size === 0) break;
			const dbName = String(db || '').trim();
			if (!dbName || dbName === String(opts.currentDatabase)) continue;
			const key = cid + '|' + dbName;
			if (_win.schemaByConnDb && _win.schemaByConnDb[key]) continue;
			const sch = await requestSchema(cid, dbName);
			tryResolveFromSchema(sch, opts.currentClusterUrl, dbName);
		}

		// Re-scan cached current cluster after fetch.
		if (unresolvedLower.size > 0) {
			const cachedCurrentConn = getCachedSchemasForConnection(cid)
				.filter((e: any) => String(e.database) !== String(opts.currentDatabase));
			scanCachedSchemasForMatches(cachedCurrentConn, opts.currentClusterUrl);
		}
	}

	if (unresolvedLower.size > 0) {
		// Fetch missing schemas for other connections.
		const connById = new Map();
		try {
			for (const c of (_win.connections || [])) {
				if (c && c.id) {
					connById.set(String(c.id), c);
				}
			}
		} catch { /* ignore */ }
		const otherConns = Array.from(connById.entries())
			.filter(([id]) => id !== String(opts.connectionId || '').trim())
			.map(([id, c]) => ({ cid: id, clusterUrl: String((c && c.clusterUrl) || '').trim() }))
			.filter((x: any) => !!x.clusterUrl)
			.sort((a: any, b: any) => normalizeClusterForKusto(a.clusterUrl).toLowerCase().localeCompare(normalizeClusterForKusto(b.clusterUrl).toLowerCase()));

		for (const c of otherConns) {
			if (unresolvedLower.size === 0) break;
			let dbs = await requestDatabases(c.cid, false);
			for (const db of (Array.isArray(dbs) ? dbs : [])) {
				if (unresolvedLower.size === 0) break;
				const dbName = String(db || '').trim();
				if (!dbName) continue;
				const key = c.cid + '|' + dbName;
				if (_win.schemaByConnDb && _win.schemaByConnDb[key]) continue;
				const sch = await requestSchema(c.cid, dbName);
				tryResolveFromSchema(sch, c.clusterUrl, dbName);
			}

			// Re-scan cached for this connection after fetch.
			if (unresolvedLower.size > 0) {
				const cached = getCachedSchemasForConnection(c.cid);
				scanCachedSchemasForMatches(cached, c.clusterUrl);
			}
		}
	}

	// Apply replacements from end to start.
	const replacements = [];
	for (const tok of candidates) {
		const lower = String(tok.value).toLowerCase();
		const loc = resolvedLocationByLower.get(lower);
		if (!loc || !loc.clusterUrl || !loc.database) continue;
		replacements.push({ start: tok.start, end: tok.end, fq: fq(loc.clusterUrl, loc.database, String(tok.value)) });
	}
	if (!replacements.length) {
		return text;
	}

	let out = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		out = out.slice(0, r.start) + r.fq + out.slice(r.end);
	}
	return out;
}

function qualifyTablesInText( text: any, tables: any, clusterUrl: any, database: any) {
	const normalizeClusterForKusto = (value: any) => {
		let s = String(value || '')
			.trim()
			.replace(/^https?:\/\//i, '')
			.replace(/\/+$/, '')
			.replace(/:\d+$/, '');
		s = s.replace(/\.kusto\.windows\.net$/i, '');
		return s;
	};

	const isIdentChar = (ch: any) => /[A-Za-z0-9_\-]/.test(ch);
	const set = new Set((tables || []).map((t: any) => String(t)));
	const skipNames = new Set();

	// Very small lexer to detect let bindings and skip qualifying those names.
	const tokens = [];
	{
		let i = 0;
		let inS = false;
		let inLineComment = false;
		let inBlockComment = false;
		while (i < text.length) {
			const ch = text[i];
			const next = text[i + 1];
			if (inLineComment) {
				if (ch === '\n') inLineComment = false;
				i++;
				continue;
			}
			if (inBlockComment) {
				if (ch === '*' && next === '/') {
					inBlockComment = false;
					i += 2;
					continue;
				}
				i++;
				continue;
			}
			if (inS) {
				if (ch === "'") {
					inS = false;
				}
				i++;
				continue;
			}
			if (ch === '/' && next === '/') {
				inLineComment = true;
				i += 2;
				continue;
			}
			if (ch === '/' && next === '*') {
				inBlockComment = true;
				i += 2;
				continue;
			}
			if (ch === "'") {
				inS = true;
				i++;
				continue;
			}
			if ((ch === '_' || /[A-Za-z]/.test(ch)) && !inS) {
				let j = i + 1;
				while (j < text.length && isIdentChar(text[j])) j++;
				const value = text.slice(i, j);
				tokens.push({ value, start: i, end: j });
				i = j;
				continue;
			}
			i++;
		}
	}

	for (let idx = 0; idx < tokens.length; idx++) {
		const t = tokens[idx];
		if (!t || String(t.value).toLowerCase() !== 'let') {
			continue;
		}
		const nameTok = tokens[idx + 1];
		if (!nameTok) continue;
		// If the next non-ws char after the identifier is '=', treat it as a let binding.
		let k = nameTok.end;
		while (k < text.length && /\s/.test(text[k])) k++;
		if (text[k] === '=') {
			skipNames.add(nameTok.value);
		}
	}

	const replacements = [];
	for (const tok of tokens) {
		if (!set.has(tok.value)) {
			continue;
		}
		if (skipNames.has(tok.value)) {
			continue;
		}
		// Skip if already qualified (immediate '.' before name).
		let p = tok.start - 1;
		while (p >= 0 && text[p] === ' ') p--;
		if (p >= 0 && text[p] === '.') {
			continue;
		}
		// Skip if this looks like a function call.
		let a = tok.end;
		while (a < text.length && text[a] === ' ') a++;
		if (text[a] === '(') {
			continue;
		}
		replacements.push({ start: tok.start, end: tok.end, value: tok.value });
	}

	if (replacements.length === 0) {
		return text;
	}

	// Apply from end to start.
	let out = text;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const r = replacements[i];
		const fq = "cluster('" + normalizeClusterForKusto(clusterUrl) + "').database('" + database + "')." + r.value;
		out = out.slice(0, r.start) + fq + out.slice(r.end);
	}
	return out;
}

function removeQueryBox( boxId: any) {
	// Dispose Copilot chat state for this query box (if present).
	try {
		if (typeof (window as any).__kustoDisposeCopilotQueryBox === 'function') {
			(window as any).__kustoDisposeCopilotQueryBox(boxId);
		}
	} catch { /* ignore */ }

	// If removing a linked optimized box, exit linked optimization mode and restore cache settings.
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				try { __kustoSetLinkedOptimizationMode(sourceBoxId, boxId, false); } catch { /* ignore */ }
				try { delete _win.optimizationMetadataByBoxId[boxId]; } catch { /* ignore */ }
				try { delete _win.optimizationMetadataByBoxId[sourceBoxId]; } catch { /* ignore */ }
			} else if (meta && meta.comparisonBoxId) {
				// If removing the source box, remove the comparison box too.
				const comparisonBoxId = meta.comparisonBoxId;
				try { __kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, false); } catch { /* ignore */ }
				try { removeQueryBox(comparisonBoxId); } catch { /* ignore */ }
				try { delete _win.optimizationMetadataByBoxId[boxId]; } catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	// Stop any running timer/spinner for this box
	setQueryExecuting(boxId, false);
	delete _win.runModesByBoxId[boxId];
	try {
		if ((window as any).__kustoQueryResultJsonByBoxId) {
			delete (window as any).__kustoQueryResultJsonByBoxId[boxId];
		}
	} catch {
		// ignore
	}

	// Disconnect any resize observer
	if (_win.queryEditorResizeObservers[boxId]) {
		try {
			_win.queryEditorResizeObservers[boxId].disconnect();
		} catch {
			// ignore
		}
		delete _win.queryEditorResizeObservers[boxId];
	}

	// Disconnect any visibility observers
	try {
		if (typeof _win.queryEditorVisibilityObservers === 'object' && _win.queryEditorVisibilityObservers && _win.queryEditorVisibilityObservers[boxId]) {
			try { _win.queryEditorVisibilityObservers[boxId].disconnect(); } catch { /* ignore */ }
			delete _win.queryEditorVisibilityObservers[boxId];
		}
	} catch { /* ignore */ }
	try {
		if (typeof _win.queryEditorVisibilityMutationObservers === 'object' && _win.queryEditorVisibilityMutationObservers && _win.queryEditorVisibilityMutationObservers[boxId]) {
			try { _win.queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch { /* ignore */ }
			delete _win.queryEditorVisibilityMutationObservers[boxId];
		}
	} catch { /* ignore */ }

	// Dispose editor if present
	if (_win.queryEditors[boxId]) {
		try {
			_win.queryEditors[boxId].dispose();
		} catch {
			// ignore
		}
		delete _win.queryEditors[boxId];
	}

	// Remove from tracked list
	_win.queryBoxes = _win.queryBoxes.filter((id: any) => id !== boxId);
	try { delete _win.lastQueryTextByBoxId[boxId]; } catch { /* ignore */ }
	try { delete _win.missingClusterUrlsByBoxId[boxId]; } catch { /* ignore */ }
	try {
		if (_win.missingClusterDetectTimersByBoxId && _win.missingClusterDetectTimersByBoxId[boxId]) {
			clearTimeout(_win.missingClusterDetectTimersByBoxId[boxId]);
			delete _win.missingClusterDetectTimersByBoxId[boxId];
		}
	} catch { /* ignore */ }

	// Clear any global pointers if they reference this box
	if ((window as any).lastExecutedBox === boxId) {
		(window as any).lastExecutedBox = null;
	}
	if ((window as any).currentResult && (window as any).currentResult.boxId === boxId) {
		(window as any).currentResult = null;
	}

	// Remove DOM node
	const box = document.getElementById(boxId) as any;
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function toggleCachePill( boxId: any) {
	const checkbox = document.getElementById(boxId + '_cache_enabled') as any;
	const label = document.getElementById(boxId + '_cache_label') as any;
	if (label) {
		label.classList.toggle('disabled', !checkbox.checked);
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function toggleCachePopup( boxId: any) {
	const popup = document.getElementById(boxId + '_cache_popup') as any;
	if (!popup) return;
	
	const isOpen = popup.classList.contains('open');
	
	// Close all other popups first
	document.querySelectorAll('.cache-popup.open').forEach((p: any) =>  {
		if (p !== popup) p.classList.remove('open');
	});
	
	popup.classList.toggle('open', !isOpen);
	
	if (!isOpen) {
		// Add click-outside listener
		setTimeout(() => {
			const closeHandler = (e: any) => {
				if (!popup.contains(e.target) && !e.target.closest('#' + boxId + '_cache_label')) {
					popup.classList.remove('open');
					document.removeEventListener('click', closeHandler);
				}
			};
			document.addEventListener('click', closeHandler);
		}, 0);
	}
}

// Keep for backward compatibility
function toggleCacheControls( boxId: any) {
	toggleCachePill(boxId);
}

function formatClusterDisplayName( connection: any) {
	if (!connection) {
		return '';
	}
	const url = String(connection.clusterUrl || '').trim();
	if (url) {
		try {
			const u = new URL(url);
			const hostname = String(u.hostname || '').trim();
			const lower = hostname.toLowerCase();
			if (lower.endsWith('.kusto.windows.net')) {
				return hostname.slice(0, hostname.length - '.kusto.windows.net'.length);
			}
			return hostname || url;
		} catch {
			// ignore
		}
	}
	return String(connection.name || connection.clusterUrl || '').trim();
}

function normalizeClusterUrlKey( url: any) {
	try {
		const raw = String(url || '').trim();
		if (!raw) return '';
		const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
		const u = new URL(withScheme);
		return (u.origin + u.pathname).replace(/\/+$/, '').toLowerCase();
	} catch {
		return String(url || '').trim().replace(/\/+$/, '').toLowerCase();
	}
}

function formatClusterShortName( clusterUrl: any) {
	const raw = String(clusterUrl || '').trim();
	if (!raw) {
		return '';
	}
	try {
		const withScheme = /^https?:\/\//i.test(raw) ? raw : ('https://' + raw.replace(/^\/+/, ''));
		const u = new URL(withScheme);
		const host = String(u.hostname || '').trim();
		if (!host) {
			return raw;
		}
		const first = host.split('.')[0];
		return first || host;
	} catch {
		// Fall back to a best-effort host extraction
		const m = raw.match(/([a-z0-9-]+)(?:\.[a-z0-9.-]+)+/i);
		if (m && m[1]) {
			return m[1];
		}
		return raw;
	}
}

function clusterShortNameKey( clusterUrl: any) {
	try {
		return String(formatClusterShortName(clusterUrl) || '').trim().toLowerCase();
	} catch {
		return String(clusterUrl || '').trim().toLowerCase();
	}
}

function extractClusterUrlsFromQueryText( queryText: any) {
	const text = String(queryText || '');
	if (!text) {
		return [];
	}
	// Primary pattern: cluster('https://...') or cluster("...")
	const urls = [];
	try {
		const re = /\bcluster\s*\(\s*(['"])([^'"\r\n]+?)\1\s*\)/ig;
		let m;
		while ((m = re.exec(text)) !== null) {
			const u = String(m[2] || '').trim();
			if (u) urls.push(u);
		}
	} catch {
		// ignore
	}
	// Unique by cluster short-name key (case-insensitive)
	const seen = new Set();
	const out = [];
	for (const u of urls) {
		const key = clusterShortNameKey(u);
		if (!key || seen.has(key)) continue;
		seen.add(key);
		out.push(u);
	}
	return out;
}

function extractClusterDatabaseHintsFromQueryText( queryText: any) {
	const text = String(queryText || '');
	const map: any = {};
	if (!text) {
		return map;
	}
	// Pattern: cluster('...').database('...') (case-insensitive, with whitespace)
	try {
		const re = /\bcluster\s*\(\s*(['"])([^'"\r\n]+?)\1\s*\)\s*\.\s*database\s*\(\s*(['"])([^'"\r\n]+?)\3\s*\)/ig;
		let m;
		while ((m = re.exec(text)) !== null) {
			const clusterUrl = String(m[2] || '').trim();
			const database = String(m[4] || '').trim();
			if (!clusterUrl || !database) continue;
			const key = clusterShortNameKey(clusterUrl);
			if (!key) continue;
			if (!map[key]) {
				map[key] = database;
			}
		}
	} catch {
		// ignore
	}
	return map;
}

function computeMissingClusterUrls( detectedClusterUrls: any) {
	const detected = Array.isArray(detectedClusterUrls) ? detectedClusterUrls : [];
	if (!detected.length) {
		return [];
	}
	const existingKeys = new Set();
	try {
		for (const c of (_win.connections || [])) {
			if (!c) continue;
			const key = clusterShortNameKey(c.clusterUrl || '');
			if (key) existingKeys.add(key);
		}
	} catch {
		// ignore
	}
	const missing = [];
	for (const u of detected) {
		const key = clusterShortNameKey(u);
		if (!key) continue;
		if (!existingKeys.has(key)) {
			missing.push(u);
		}
	}
	return missing;
}

function renderMissingClustersBanner( boxId: any, missingClusterUrls: any) {
	const banner = document.getElementById(boxId + '_missing_clusters') as any;
	const textEl = document.getElementById(boxId + '_missing_clusters_text') as any;
	if (!banner || !textEl) {
		return;
	}
	const missing = Array.isArray(missingClusterUrls) ? missingClusterUrls : [];
	if (!missing.length) {
		banner.style.display = 'none';
		textEl.innerHTML = '';
		return;
	}
	const shortNames = missing
		.map((u: any) => formatClusterShortName(u))
		.filter(Boolean);
	const label = shortNames.length
		? ('Detected clusters not in your connections: <strong>' + _win.escapeHtml(shortNames.join(', ')) + '</strong>.')
		: 'Detected clusters not in your connections.';
	textEl.innerHTML = label + ' Add them with one click.';
	banner.style.display = 'flex';
}

function updateMissingClustersForBox( boxId: any, queryText: any) {
	try {
		_win.lastQueryTextByBoxId[boxId] = String(queryText || '');
	} catch { /* ignore */ }
	try {
		_win.suggestedDatabaseByClusterKeyByBoxId[boxId] = extractClusterDatabaseHintsFromQueryText(queryText);
	} catch { /* ignore */ }
	const detected = extractClusterUrlsFromQueryText(queryText);
	const missing = computeMissingClusterUrls(detected);
	try { _win.missingClusterUrlsByBoxId[boxId] = missing; } catch { /* ignore */ }
	renderMissingClustersBanner(boxId, missing);
}

// Called by Monaco (media/queryEditor/monaco.js) on content changes.
(window as any).__kustoOnQueryValueChanged = function (boxId: any, queryText: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	try { _win.lastQueryTextByBoxId[id] = String(queryText || ''); } catch { /* ignore */ }
	try {
		if (_win.missingClusterDetectTimersByBoxId[id]) {
			clearTimeout(_win.missingClusterDetectTimersByBoxId[id]);
		}
		_win.missingClusterDetectTimersByBoxId[id] = setTimeout(() => {
			try { updateMissingClustersForBox(id, _win.lastQueryTextByBoxId[id] || ''); } catch { /* ignore */ }
		}, 260);
	} catch {
		// ignore
	}
};

// Called by main.js when the connections list changes.
(window as any).__kustoOnConnectionsUpdated = function () {
	try {
		for (const id of (_win.queryBoxes || [])) {
			updateMissingClustersForBox(id, _win.lastQueryTextByBoxId[id] || '');
		}
	} catch {
		// ignore
	}
	// Apply any pending favorite selections now that connections may exist.
	try {
		for (const id of (_win.queryBoxes || [])) {
			try {
				if (_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]) {
					__kustoTryApplyPendingFavoriteSelectionForBox(id);
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		if (typeof (window as any).__kustoUpdateFavoritesUiForAllBoxes === 'function') {
			(window as any).__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch { /* ignore */ }
};

function __kustoFavoriteKey( clusterUrl: any, database: any) {
	const c = normalizeClusterUrlKey(String(clusterUrl || '').trim());
	const d = String(database || '').trim().toLowerCase();
	return c + '|' + d;
}

function __kustoGetCurrentClusterUrlForBox( boxId: any) {
	return __kustoGetClusterUrl(boxId);
}

function __kustoGetCurrentDatabaseForBox( boxId: any) {
	return __kustoGetDatabase(boxId);
}

function __kustoFindFavorite( clusterUrl: any, database: any) {
	const key = __kustoFavoriteKey(clusterUrl, database);
	const list = Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : [];
	for (const f of list) {
		if (!f) continue;
		const fk = __kustoFavoriteKey(f.clusterUrl, f.database);
		if (fk === key) return f;
	}
	return null;
}

function __kustoGetFavoritesSorted() {
	const list = (Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []).slice();
	list.sort((a: any, b: any) => {
		const an = String((a && a.name) || '').toLowerCase();
		const bn = String((b && b.name) || '').toLowerCase();
		return an.localeCompare(bn);
	});
	return list;
}

// Auto-enter Favorites mode when restoring a .kqlx selection that matches an existing favorite.
// This is intended to run only for boxes restored from disk, not for arbitrary user selections.
let __kustoAutoEnterFavoritesByBoxId = Object.create(null);

// For newly-added sections (not restore): if the prefilled cluster+db matches an existing
// favorite, switch that box into Favorites mode.
let __kustoAutoEnterFavoritesForNewBoxByBoxId = Object.create(null);

function __kustoMarkNewBoxForFavoritesAutoEnter( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		// Never treat restore-created boxes as "new".
		if (typeof _win.__kustoRestoreInProgress === 'boolean' && _win.__kustoRestoreInProgress) {
			return;
		}
	} catch { /* ignore */ }
	try {
		__kustoAutoEnterFavoritesForNewBoxByBoxId = __kustoAutoEnterFavoritesForNewBoxByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesForNewBoxByBoxId[id] = true;
	} catch { /* ignore */ }
}

function __kustoTryAutoEnterFavoritesModeForNewBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let pending = false;
	try {
		pending = !!(__kustoAutoEnterFavoritesForNewBoxByBoxId && __kustoAutoEnterFavoritesForNewBoxByBoxId[id]);
	} catch { pending = false; }
	if (!pending) return;

	// Don't override an explicit choice for this box.
	try {
		if (_win.favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(_win.favoritesModeByBoxId, id)) {
			try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	// Wait until favorites are available.
	const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
	if (!hasAny) return;

	const clusterUrl = __kustoGetCurrentClusterUrlForBox(id);
	const db = __kustoGetCurrentDatabaseForBox(id);
	if (!clusterUrl || !db) return;

	const fav = __kustoFindFavorite(clusterUrl, db);
	try {
		if (fav) {
			__kustoApplyFavoritesMode(id, true);
			__kustoUpdateFavoritesUiForBox(id);
		}
	} catch { /* ignore */ }
	// Either way, we've reached a stable selection; only do this once.
	try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch { /* ignore */ }
}

(window as any).__kustoSetAutoEnterFavoritesForBox = function (boxId: any, clusterUrl: any, database: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	try {
		__kustoAutoEnterFavoritesByBoxId = __kustoAutoEnterFavoritesByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesByBoxId[id] = { clusterUrl: c, database: d };
	} catch { /* ignore */ }
};

function __kustoTryAutoEnterFavoritesModeForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let desired = null;
	try {
		desired = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id]
			? __kustoAutoEnterFavoritesByBoxId[id]
			: null;
	} catch { desired = null; }
	if (!desired) return;

	// Wait until favorites are available.
	const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
	if (!hasAny) return;

	const fav = __kustoFindFavorite(desired.clusterUrl, desired.database);
	if (!fav) {
		// No matching favorite — ensure we're NOT in favorites mode so the
		// cluster/database dropdowns are visible and the user can see the connection.
		try {
			const isInFavMode = !!(_win.favoritesModeByBoxId && _win.favoritesModeByBoxId[id]);
			if (isInFavMode) {
				__kustoApplyFavoritesMode(id, false);
			}
		} catch { /* ignore */ }
		try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch { /* ignore */ }
		return;
	}

	try { __kustoApplyFavoritesMode(id, true); } catch { /* ignore */ }
	try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch { /* ignore */ }
}

(window as any).__kustoTryAutoEnterFavoritesModeForAllBoxes = function () {
	try {
		for (const id of (_win.queryBoxes || [])) {
			try { __kustoTryAutoEnterFavoritesModeForBox(id); } catch { /* ignore */ }
			try { __kustoTryAutoEnterFavoritesModeForNewBox(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
};

// Default behavior for blank/new docs: if the user has any favorites, start the first
// section in Favorites mode. If they have no favorites, keep the normal cluster/db selects.
let __kustoDidDefaultFirstBoxToFavorites = false;

(window as any).__kustoMaybeDefaultFirstBoxToFavoritesMode = function () {
	try {
		if (__kustoDidDefaultFirstBoxToFavorites) return;
		const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
		if (!hasAny) return;
		if (!Array.isArray(_win.queryBoxes) || _win.queryBoxes.length !== 1) return;
		const id = String(_win.queryBoxes[0] || '').trim();
		if (!id) return;

		// Don't override an explicit/restored setting for this box.
		try {
			if (_win.favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(_win.favoritesModeByBoxId, id)) {
				return;
			}
		} catch { /* ignore */ }

		// If the box has a stashed desired connection that doesn't match any favorite,
		// don't enter favorites mode — let the cluster/database dropdowns show instead.
		try {
			let desiredCluster = '';
			let desiredDb = '';
			const pending = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id];
			if (pending) {
				desiredCluster = pending.clusterUrl || '';
				desiredDb = pending.database || '';
			}
			if (!desiredCluster) {
				const kwEl = __kustoGetQuerySectionElement(id);
				desiredCluster = kwEl ? __kustoGetClusterUrl(id) : '';
			}
			if (!desiredDb) {
				desiredDb = __kustoGetDatabase(id);
			}
			if (desiredCluster && desiredDb) {
				const fav = __kustoFindFavorite(desiredCluster, desiredDb);
				if (!fav) {
					// Connection exists but no matching favorite — skip favorites mode.
					__kustoDidDefaultFirstBoxToFavorites = true;
					return;
				}
			}
		} catch { /* ignore */ }

		__kustoApplyFavoritesMode(id, true);
		try { __kustoUpdateFavoritesUiForBox(id); } catch { /* ignore */ }
		__kustoDidDefaultFirstBoxToFavorites = true;
	} catch { /* ignore */ }
};

// Webviews are sandboxed; confirm()/alert() may be blocked unless allow-modals is set.
// Route confirmation via the extension host so we can use VS Code's native modal.
let __kustoConfirmRemoveFavoriteCallbacksById = Object.create(null);

(window as any).__kustoOnConfirmRemoveFavoriteResult = function (message: any) {
	try {
		const m = (message && typeof message === 'object') ? message : {};
		const requestId = String(m.requestId || '');
		const ok = !!m.ok;
		if (!requestId) return;
		const cb = __kustoConfirmRemoveFavoriteCallbacksById && __kustoConfirmRemoveFavoriteCallbacksById[requestId];
		try { delete __kustoConfirmRemoveFavoriteCallbacksById[requestId]; } catch { /* ignore */ }
		if (typeof cb === 'function') {
			try { cb(ok); } catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
};

function __kustoFindConnectionIdForClusterUrl( clusterUrl: any) {
	try {
		const key = normalizeClusterUrlKey(String(clusterUrl || '').trim());
		if (!key) return '';
		for (const c of (_win.connections || [])) {
			if (!c) continue;
			if (normalizeClusterUrlKey(c.clusterUrl || '') === key) {
				return String(c.id || '').trim();
			}
		}
	} catch {
		// ignore
	}
	return '';
}

// For optimized/comparison boxes, execution inherits cluster/db from the source box.
// Expose this so schema/autocomplete and favorites selection can follow the same path.
(window as any).__kustoGetSelectionOwnerBoxId = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[id];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				return String(meta.sourceBoxId || '').trim() || id;
			}
		}
	} catch { /* ignore */ }
	return id;
};

function __kustoTryApplyPendingFavoriteSelectionForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;
	let pending = null;
	try {
		pending = _win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]
			? _win.pendingFavoriteSelectionByBoxId[id]
			: null;
	} catch { /* ignore */ }
	if (!pending) return false;

	const clusterUrl = String(pending.clusterUrl || '').trim();
	const database = String(pending.database || '').trim();
	if (!clusterUrl || !database) {
		try { delete _win.pendingFavoriteSelectionByBoxId[id]; } catch { /* ignore */ }
		return false;
	}

	const connectionId = __kustoFindConnectionIdForClusterUrl(clusterUrl);
	if (!connectionId) {
		return false;
	}

	// Apply to the effective selection owner (matches execution behavior).
	let ownerId = id;
	try {
		ownerId = (typeof (window as any).__kustoGetSelectionOwnerBoxId === 'function')
			? ((window as any).__kustoGetSelectionOwnerBoxId(id) || id)
			: id;
	} catch { ownerId = id; }

	const applyToBox = (targetBoxId: any) => {
		const tid = String(targetBoxId || '').trim();
		if (!tid) return;
		const kwEl = __kustoGetQuerySectionElement(tid);
		if (!kwEl) return;
		try {
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(clusterUrl);
			if (typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(database);
		} catch { /* ignore */ }
		try {
			if (connectionId && typeof kwEl.setConnectionId === 'function') {
				kwEl.setConnectionId(connectionId);
			}
			// Trigger database loading.
			kwEl.dispatchEvent(new CustomEvent('connection-changed', {
				detail: { boxId: tid, connectionId: connectionId, clusterUrl: clusterUrl },
				bubbles: true, composed: true,
			}));
		} catch { /* ignore */ }
	};

	applyToBox(ownerId);
	// Keep the originating box UI in sync if it's different.
	if (ownerId !== id) {
		applyToBox(id);
	}

	try { delete _win.pendingFavoriteSelectionByBoxId[id]; } catch { /* ignore */ }
	return true;
}

function __kustoSetElementDisplay( el: any, display: any) {
	try {
		if (!el) return;
		el.style.display = display;
	} catch { /* ignore */ }
}

function __kustoUpdateFavoritesUiForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const kwEl = __kustoGetQuerySectionElement(id);
	if (kwEl && typeof kwEl.setFavorites === 'function') {
		kwEl.setFavorites(Array.isArray(_win.kustoFavorites) ? _win.kustoFavorites : []);
	}
}

(window as any).__kustoUpdateFavoritesUiForAllBoxes = function () {
	try {
		_win.queryBoxes.forEach((id: any) =>  {
			try { __kustoUpdateFavoritesUiForBox(id); } catch { /* ignore */ }
		});
	} catch { /* ignore */ }
};

// Toggle the current cluster+database as a favorite for a given query box.
// Sends a message to the extension host which handles add/remove + persistence.
function toggleFavoriteForBox( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const clusterUrl = __kustoGetClusterUrl(id);
	const database = __kustoGetDatabase(id);
	if (!clusterUrl || !database) return;

	const existing = __kustoFindFavorite(clusterUrl, database);
	if (existing) {
		// Already a favorite — remove it.
		(_win.vscode as any).postMessage({ type: 'removeFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	} else {
		// Not a favorite yet — request add (extension host shows input box for name).
		(_win.vscode as any).postMessage({ type: 'requestAddFavorite', clusterUrl: clusterUrl, database: database, boxId: id });
	}
}

// Remove a specific favorite by cluster+database.
function removeFavorite( clusterUrl: any, database: any) {
	const c = String(clusterUrl || '').trim();
	const d = String(database || '').trim();
	if (!c || !d) return;
	(_win.vscode as any).postMessage({ type: 'removeFavorite', clusterUrl: c, database: d });
}

// Favorites dropdowns are now managed by the Lit component's shadow DOM.
// This function must exist because the document click/scroll/wheel handlers
// call it without a try/catch guard.
function closeAllFavoritesDropdowns() {
	// no-op — Lit component handles its own dropdown lifecycle.
}

function __kustoApplyFavoritesMode( boxId: any, enabled: any) {
	_win.favoritesModeByBoxId = _win.favoritesModeByBoxId || {};
	_win.favoritesModeByBoxId[boxId] = !!enabled;

	// Delegate to the Lit element — it handles showing/hiding favorites vs cluster/database
	// dropdowns in its shadow DOM render.
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setFavoritesMode === 'function') {
		kwEl.setFavoritesMode(!!enabled);
	}
}

// Called by main.js when a favorite was just added from a specific query box.
(window as any).__kustoEnterFavoritesModeForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		const hasAny = Array.isArray(_win.kustoFavorites) && _win.kustoFavorites.length > 0;
		if (!hasAny) return;
		__kustoApplyFavoritesMode(id, true);
		__kustoUpdateFavoritesUiForBox(id);
	} catch { /* ignore */ }
};

function __kustoGetTrashIconSvg() {
	return (
		'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<path d="M6 2.5h4" />' +
		'<path d="M3.5 4.5h9" />' +
		'<path d="M5 4.5l.7 9h4.6l.7-9" />' +
		'<path d="M6.6 7v4.8" />' +
		'<path d="M9.4 7v4.8" />' +
		'</svg>'
	);
}


function addMissingClusterConnections( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	const missing = _win.missingClusterUrlsByBoxId[id];
	const clusters = Array.isArray(missing) ? missing.slice() : [];
	if (!clusters.length) {
		return;
	}
	// If this query box has no cluster selected, auto-select the first newly-added cluster
	// once connections refresh.
	try {
		const hasSelection = !!__kustoGetConnectionId(id);
		const kwEl = __kustoGetQuerySectionElement(id);
		if (kwEl && !hasSelection) {
			const hints = _win.suggestedDatabaseByClusterKeyByBoxId && _win.suggestedDatabaseByClusterKeyByBoxId[id]
				? _win.suggestedDatabaseByClusterKeyByBoxId[id]
				: {};
			let chosenClusterUrl = '';
			let chosenDb = '';
			for (const u of clusters) {
				const key = clusterShortNameKey(u);
				const db = key && hints ? String(hints[key] || '') : '';
				if (db) {
					chosenClusterUrl = String(u || '').trim();
					chosenDb = db;
					break;
				}
			}
			if (!chosenClusterUrl) {
				chosenClusterUrl = String(clusters[0] || '').trim();
				const key0 = clusterShortNameKey(chosenClusterUrl);
				chosenDb = key0 && hints ? String(hints[key0] || '') : '';
			}
			if (typeof kwEl.setDesiredClusterUrl === 'function') kwEl.setDesiredClusterUrl(chosenClusterUrl);
			if (chosenDb && typeof kwEl.setDesiredDatabase === 'function') kwEl.setDesiredDatabase(chosenDb);
		}
	} catch {
		// ignore
	}
	try {
		(_win.vscode as any).postMessage({
			type: 'addConnectionsForClusters',
			boxId: id,
			clusterUrls: clusters
		});
	} catch {
		// ignore
	}
}

function updateConnectionSelects() {
	_win.queryBoxes.forEach((id: any) =>  {
		const el = __kustoGetQuerySectionElement(id);
		if (el && typeof el.setConnections === 'function') {
			// Delegate to the Lit element — it handles desired/current/last resolution internally.
			el.setConnections(_win.connections || [], { lastConnectionId: _win.lastConnectionId || '' });
		}
		try { __kustoUpdateFavoritesUiForBox(id); } catch { /* ignore */ }
	});
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForAllBoxes === 'function') {
			(window as any).__kustoUpdateRunEnabledForAllBoxes();
		}
	} catch { /* ignore */ }
}

function updateDatabaseField( boxId: any) {
	// If a previous database-load attempt rendered an error into the results area,
	// clear it as soon as the user changes clusters so the UI doesn't look stuck.
	try {
		if (typeof __kustoClearDatabaseLoadError === 'function') {
			__kustoClearDatabaseLoadError(boxId);
		}
	} catch { /* ignore */ }

	const connectionId = __kustoGetConnectionId(boxId);
	if (!connectionId) return;

	// For Lit elements, connection-changed events already handle database loading.
	// This function is only called as a manual trigger from legacy code paths.
	// All query sections are <kw-query-section> Lit elements.
	// The connection-changed event handler (wired in addQueryBox) handles
	// database loading, schema clearing, and persistence.
	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl) {
		kwEl.dispatchEvent(new CustomEvent('connection-changed', {
			detail: { boxId: boxId, connectionId: connectionId, clusterUrl: __kustoGetClusterUrl(boxId) },
			bubbles: true, composed: true,
		}));
	}
}

function __kustoClearDatabaseLoadError( boxId: any) {
	const bid = String(boxId || '').trim();
	if (!bid) return;
	const resultsDiv = document.getElementById(bid + '_results') as any;
	if (!resultsDiv || !resultsDiv.dataset) return;

	try {
		if (resultsDiv.dataset.kustoDbLoadErrorActive !== '1') {
			return;
		}
		const prevHtml = resultsDiv.dataset.kustoDbLoadErrorPrevHtml;
		const prevVisible = resultsDiv.dataset.kustoDbLoadErrorPrevVisible;
		if (typeof prevHtml === 'string') {
			resultsDiv.innerHTML = prevHtml;
		}
		try {
			if (typeof prevVisible === 'string' && prevVisible.length) {
				const desiredVisible = (prevVisible === '1');
				if (typeof __kustoSetResultsVisible === 'function') {
					__kustoSetResultsVisible(bid, desiredVisible);
				} else {
					try {
						if ((window as any).__kustoResultsVisibleByBoxId) {
							(window as any).__kustoResultsVisibleByBoxId[bid] = desiredVisible;
						}
						if (typeof __kustoApplyResultsVisibility === 'function') {
							__kustoApplyResultsVisibility(bid);
						}
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
	} finally {
		try {
			delete resultsDiv.dataset.kustoDbLoadErrorActive;
			delete resultsDiv.dataset.kustoDbLoadErrorPrevHtml;
			delete resultsDiv.dataset.kustoDbLoadErrorPrevVisible;
		} catch { /* ignore */ }
	}
}

function promptAddConnectionFromDropdown( boxId: any) {
	try {
		(_win.vscode as any).postMessage({ type: 'promptAddConnection', boxId: boxId });
	} catch {
		// ignore
	}
}

function importConnectionsFromXmlFile( boxId: any) {
	try {
		// Use the extension host's file picker so we can default to the user's Kusto Explorer folder.
		(_win.vscode as any).postMessage({ type: 'promptImportConnectionsXml', boxId: boxId });
	} catch (e: any) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch { /* ignore */ }
	}
}

function parseKustoExplorerConnectionsXml( xmlText: any) {
	const text = String(xmlText || '');
	if (!text.trim()) {
		return [];
	}
	let doc;
	try {
		doc = new DOMParser().parseFromString(text, 'application/xml');
	} catch {
		return [];
	}
	// Detect parse errors.
	try {
		const err = doc.getElementsByTagName('parsererror');
		if (err && err.length) {
			return [];
		}
	} catch {
		// ignore
	}

	const nodes = Array.from(doc.getElementsByTagName('ServerDescriptionBase'));
	const results = [];
	for (const node of nodes) {
		const name = getChildText(node, 'Name');
		const details = getChildText(node, 'Details');
		const connectionString = getChildText(node, 'ConnectionString');
		const parsed = parseKustoConnectionString(connectionString);
		let clusterUrl = (parsed.dataSource || details || '').trim();
		if (!clusterUrl) {
			continue;
		}
		// Normalize URL-ish strings.
		if (!/^https?:\/\//i.test(clusterUrl)) {
			clusterUrl = 'https://' + clusterUrl.replace(/^\/+/, '');
		}
		results.push({
			name: (name || '').trim() || clusterUrl,
			clusterUrl: clusterUrl.trim(),
			database: (parsed.initialCatalog || '').trim() || undefined
		});
	}

	// De-dupe within the file.
	const seen = new Set();
	const deduped = [];
	for (const r of results) {
		let key = '';
		try {
			key = (typeof normalizeClusterUrlKey === 'function')
				? normalizeClusterUrlKey(r.clusterUrl || '')
				: String(r.clusterUrl || '').trim().replace(/\/+$/g, '').toLowerCase();
		} catch {
			key = String(r.clusterUrl || '').trim().replace(/\/+$/g, '').toLowerCase();
		}
		if (!key || seen.has(key)) {
			continue;
		}
		seen.add(key);
		deduped.push(r);
	}
	return deduped;
}

function getChildText( node: any, localName: any) {
	if (!node || !node.childNodes) {
		return '';
	}
	for (const child of Array.from(node.childNodes) as any[]) {
		if (!child || child.nodeType !== 1) {
			continue;
		}
		const ln = child.localName || child.nodeName;
		if (String(ln).toLowerCase() === String(localName).toLowerCase()) {
			return String(child.textContent || '');
		}
	}
	return '';
}

function parseKustoConnectionString( cs: any) {
	const raw = String(cs || '');
	const parts = raw.split(';').map((p: any) => p.trim()).filter(Boolean);
	const map: any = {};
	for (const part of parts) {
		const idx = part.indexOf('=');
		if (idx <= 0) {
			continue;
		}
		const key = part.slice(0, idx).trim().toLowerCase();
		const val = part.slice(idx + 1).trim();
		map[key] = val;
	}
	return {
		dataSource: map['data source'] || map['datasource'] || map['server'] || map['address'] || '',
		initialCatalog: map['initial catalog'] || map['database'] || ''
	};
}

function refreshDatabases( boxId: any) {
	const connectionId = __kustoGetConnectionId(boxId);
	if (!connectionId) return;

	const kwEl = __kustoGetQuerySectionElement(boxId);
	if (kwEl && typeof kwEl.setRefreshLoading === 'function') {
		kwEl.setRefreshLoading(true);
		kwEl.setDatabasesLoading(true);
	}

	(_win.vscode as any).postMessage({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
}

function onDatabasesError( boxId: any, error: any, responseConnectionId: any) {
	const errText = String(error || '');
	const isEnotfound = /\bENOTFOUND\b/i.test(errText) || /getaddrinfo\s+ENOTFOUND/i.test(errText);

	// If the response includes a connectionId, verify it matches the currently selected connection.
	// This prevents stale error responses (from a slow request for a previous cluster) from affecting
	// the dropdown when the user has already switched to a different cluster.
	if (responseConnectionId) {
		const currentConnectionId = __kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			// Response is for a different connection than currently selected - ignore it.
			// Still stop any spinner that might be running.
			const refreshBtn = document.getElementById(boxId + '_refresh') as any;
			if (refreshBtn) {
				try {
					if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
						const prev = refreshBtn.dataset.kustoPrevHtml;
						if (typeof prev === 'string' && prev) {
							refreshBtn.innerHTML = prev;
						}
						try { delete refreshBtn.dataset.kustoPrevHtml; } catch { /* ignore */ }
						try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch { /* ignore */ }
						try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch { /* ignore */ }
					}
					refreshBtn.removeAttribute('aria-busy');
					refreshBtn.disabled = false;
				} catch { /* ignore */ }
			}
			return;
		}
	}

	try {
		const databaseSelect = document.getElementById(boxId + '_database') as any;
		const refreshBtn = document.getElementById(boxId + '_refresh') as any;
		if (databaseSelect) {
			// Check if we have previous content to restore (from a manual refresh)
			const hadPreviousContent = databaseSelect.dataset && 
				databaseSelect.dataset.kustoRefreshInFlight === 'true' &&
				typeof databaseSelect.dataset.kustoPrevHtml === 'string' && 
				databaseSelect.dataset.kustoPrevHtml;
			
			if (isEnotfound) {
				// Cluster is unreachable/invalid: show failure message
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch { /* ignore */ }
			} else if (hadPreviousContent) {
				// Restore previous dropdown contents/value if we snapshotted them (manual refresh case).
				try {
					const prevHtml = databaseSelect.dataset.kustoPrevHtml;
					const prevValue = databaseSelect.dataset.kustoPrevValue;
					if (typeof prevHtml === 'string' && prevHtml) {
						databaseSelect.innerHTML = prevHtml;
					}
					if (typeof prevValue === 'string') {
						databaseSelect.value = prevValue;
					}
				} catch { /* ignore */ }
			} else {
				// No previous content (initial load failed): show failure message
				databaseSelect.innerHTML = '<option value="" disabled selected>Failed to load database list.</option>';
				try { databaseSelect.value = ''; } catch { /* ignore */ }
			}
			databaseSelect.disabled = false;
			try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.syncSelectBackedDropdown && (window as any).__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
			try {
				if (databaseSelect.dataset) {
					delete databaseSelect.dataset.kustoRefreshInFlight;
					delete databaseSelect.dataset.kustoPrevHtml;
					delete databaseSelect.dataset.kustoPrevValue;
				}
			} catch { /* ignore */ }
		}
		if (refreshBtn) {
			try {
				if (refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1')) {
					const prev = refreshBtn.dataset.kustoPrevHtml;
					if (typeof prev === 'string' && prev) {
						refreshBtn.innerHTML = prev;
					}
					try { delete refreshBtn.dataset.kustoPrevHtml; } catch { /* ignore */ }
					try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch { /* ignore */ }
					try { delete refreshBtn.dataset.kustoAutoDbInFlight; } catch { /* ignore */ }
				}
				refreshBtn.removeAttribute('aria-busy');
			} catch { /* ignore */ }
			refreshBtn.disabled = false;
		}
	} catch {
		// ignore
	}
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') {
			(window as any).__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
	// Note: We no longer show inline errors in the results section for database load failures.
	// The extension now uses VS Code notifications instead for a consistent experience.
}

function updateDatabaseSelect( boxId: any, databases: any, responseConnectionId: any) {
	const kwEl = __kustoGetQuerySectionElement(boxId);

	// If the response includes a connectionId, verify it matches the currently selected connection.
	if (responseConnectionId) {
		const currentConnectionId = __kustoGetConnectionId(boxId);
		const responseConnId = String(responseConnectionId || '').trim();
		if (currentConnectionId && responseConnId && currentConnectionId !== responseConnId) {
			// Response is for a different connection — ignore it, stop spinner.
			if (kwEl && typeof kwEl.setRefreshLoading === 'function') kwEl.setRefreshLoading(false);
			return;
		}
	}

	const list = (Array.isArray(databases) ? databases : [])
		.map((d: any) => String(d || '').trim())
		.filter(Boolean)
		.sort((a: any, b: any) => a.toLowerCase().localeCompare(b.toLowerCase()));

	// Update local cache.
	const connectionId = __kustoGetConnectionId(boxId);
	if (connectionId) {
		let clusterKey = '';
		try {
			const cid = String(connectionId || '').trim();
			const conn = Array.isArray(_win.connections) ? _win.connections.find((c: any) => c && String(c.id || '').trim() === cid) : null;
			const clusterUrl = conn && conn.clusterUrl ? String(conn.clusterUrl) : '';
			if (clusterUrl) {
				let u = clusterUrl;
				if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
				try { clusterKey = String(new URL(u).hostname || '').trim().toLowerCase(); } catch { clusterKey = clusterUrl.trim().toLowerCase(); }
			}
		} catch { /* ignore */ }
		_win.cachedDatabases[String(clusterKey || '').trim()] = list;
	}

	// Delegate to the Lit element.
	if (kwEl && typeof kwEl.setDatabases === 'function') {
		kwEl.setDatabases(list, _win.lastDatabase || '');
		kwEl.setRefreshLoading(false);
	}

	try { __kustoTryAutoEnterFavoritesModeForNewBox(boxId); } catch { /* ignore */ }
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') {
			(window as any).__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

function __kustoIsValidConnectionIdForRun( connectionId: any) {
	const cid = String(connectionId || '').trim();
	if (!cid) return false;
	if (cid === '__enter_new__' || cid === '__import_xml__') return false;
	return true;
}

function __kustoGetEffectiveSelectionOwnerIdForRun( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof (window as any).__kustoGetSelectionOwnerBoxId === 'function') {
			return String((window as any).__kustoGetSelectionOwnerBoxId(id) || id).trim();
		}
	} catch { /* ignore */ }
	return id;
}

function __kustoIsRunSelectionReady( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return false;

	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);

	// If a favorites selection is still staging/applying, don't allow Run.
	try {
		const pending1 = !!(_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[id]);
		const pending2 = !!(_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[ownerId]);
		if (pending1 || pending2) {
			return false;
		}
	} catch { /* ignore */ }

	const connectionId = __kustoGetConnectionId(ownerId);
	const database = __kustoGetDatabase(ownerId);

	if (!__kustoIsValidConnectionIdForRun(connectionId)) return false;
	if (!database) return false;

	// If DB selection is still being resolved (favorites/restore), block Run.
	try {
		const dbEl: any = null; // Legacy: never defined, kept for safety
		const desiredPending = !!(dbEl && dbEl.dataset && String(dbEl.dataset.desired || '').trim());
		if (desiredPending) return false;
	} catch { /* ignore */ }
	try {
		if (false) return false; // Legacy: dbEl was never defined in this function
	} catch { /* ignore */ }

	return true;
}

function __kustoHasValidFavoriteSelection( ownerBoxId: any) {
	try {
		const id = String(ownerBoxId || '').trim();
		if (!id) return false;
		// Treat "favorite selected" as: the current (clusterUrl, db) matches a known favorite.
		const clusterUrl = (typeof __kustoGetCurrentClusterUrlForBox === 'function')
			? String(__kustoGetCurrentClusterUrlForBox(id) || '').trim()
			: '';
		const db = (typeof __kustoGetCurrentDatabaseForBox === 'function')
			? String(__kustoGetCurrentDatabaseForBox(id) || '').trim()
			: '';
		if (!clusterUrl || !db) return false;
		return typeof __kustoFindFavorite === 'function' ? !!__kustoFindFavorite(clusterUrl, db) : false;
	} catch {
		return false;
	}
}

function __kustoClearSchemaSummaryIfNoSelection( boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);
	let connectionId = __kustoGetConnectionId(ownerId);
	let database = __kustoGetDatabase(ownerId);

	// If neither a database nor a favorite is selected, blank the schema summary to avoid stale counts.
	const hasValidCluster = typeof __kustoIsValidConnectionIdForRun === 'function'
		? __kustoIsValidConnectionIdForRun(connectionId)
		: !!connectionId;
	const shouldClear = ((!hasValidCluster || !database) && !__kustoHasValidFavoriteSelection(ownerId));

	// Keep the schema refresh button in sync: hide it when selection isn't valid.
	try {
		const btn = document.getElementById(id + '_schema_refresh') as any;
		if (btn) {
			btn.style.display = shouldClear ? 'none' : '';
		}
	} catch { /* ignore */ }

	if (shouldClear) {
		try {
			if (_win.schemaByBoxId) {
				delete _win.schemaByBoxId[id];
			}
		} catch { /* ignore */ }
		try {
			if (typeof _win.setSchemaLoadedSummary === 'function') {
				_win.setSchemaLoadedSummary(id, '', '', false);
			}
		} catch { /* ignore */ }
	}
}

(window as any).__kustoUpdateRunEnabledForBox = function (boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn') as any;
	const runToggle = document.getElementById(id + '_run_toggle') as any;
	const disabledTooltip = 'Select a cluster and database first (or select a favorite)';

	// If a query is currently executing for this box, keep disabled.
	try {
		if (_win.queryExecutionTimers && _win.queryExecutionTimers[id]) {
			if (runBtn) runBtn.disabled = true;
			if (runToggle) runToggle.disabled = true;
			return;
		}
	} catch { /* ignore */ }

	// Also keep schema summary in sync with selection state.
	try { __kustoClearSchemaSummaryIfNoSelection(id); } catch { /* ignore */ }

	const enabled = __kustoIsRunSelectionReady(id);
	if (runBtn) {
		runBtn.disabled = !enabled;
		try {
			// When disabled, provide a helpful tooltip instead of looking "broken".
			const modeLabel = getRunModeLabelText(getRunMode(id));
			runBtn.title = enabled ? modeLabel : (modeLabel + '\n' + disabledTooltip);
			// Also keep ARIA label helpful when disabled.
			runBtn.setAttribute('aria-label', enabled ? modeLabel : disabledTooltip);
		} catch { /* ignore */ }
	}
	// Keep the split dropdown usable so users can change run mode even before selection is ready.
	if (runToggle) runToggle.disabled = false;
};

(window as any).__kustoUpdateRunEnabledForAllBoxes = function () {
	try {
		for (const id of (_win.queryBoxes || [])) {
			try { (window as any).__kustoUpdateRunEnabledForBox(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
};

function __kustoApplyRunModeFromMenu( boxId: any, mode: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	setRunMode(id, mode);
	// Only execute if selection is valid; otherwise we just changed the default run mode.
	try {
		if (__kustoIsRunSelectionReady(id)) {
			executeQuery(id, mode);
		}
	} catch { /* ignore */ }
	try { closeRunMenu(id); } catch { /* ignore */ }
}

function getRunMode( boxId: any) {
	return _win.runModesByBoxId[boxId] || 'take100';
}

function getRunModeLabelText( mode: any) {
	switch ((mode || '').toLowerCase()) {
		case 'plain':
			return 'Run Query';
		case 'sample100':
			return 'Run Query (sample 100)';
		case 'take100':
		default:
			return 'Run Query (take 100)';
	}
}

function setRunMode( boxId: any, mode: any) {
	_win.runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	if (runBtn) {
		const labelSpan = runBtn.querySelector('.run-btn-label');
		const labelText = getRunModeLabelText(_win.runModesByBoxId[boxId]);
		if (labelSpan) {
			labelSpan.textContent = ' ' + labelText;
		}
		// Update tooltip
		const isEnabled = !runBtn.disabled;
		runBtn.title = labelText + (isEnabled ? '' : '\nSelect a cluster and database first (or select a favorite)');
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch { /* ignore */ }
}

function closeRunMenu( boxId: any) {
	const menu = document.getElementById(boxId + '_run_menu') as any;
	if (menu) {
		menu.style.display = 'none';
	}
}

function closeAllRunMenus() {
	if (!_win.queryBoxes) return;
	_win.queryBoxes.forEach((id: any) => closeRunMenu(id));
}

function toggleRunMenu( boxId: any) {
	const menu = document.getElementById(boxId + '_run_menu') as any;
	if (!menu) {
		return;
	}
	const next = menu.style.display === 'block' ? 'none' : 'block';
	closeAllRunMenus();
	menu.style.display = next;
}

const __kustoEventIsInsideDropdownUi = (ev: any) => {
	try {
		const t = ev && ev.target ? ev.target : null;
		if (!t || !t.closest) return false;
		// Note: dropdowns/menus are used for cluster/database/favorites and some tool UI.
		return !!(
			t.closest('.kusto-dropdown-menu') ||
			t.closest('.kusto-favorites-menu') ||
			t.closest('.kusto-dropdown-btn') ||
			t.closest('.kusto-favorites-btn') ||
			t.closest('.kusto-dropdown-wrapper') ||
			t.closest('.qe-toolbar-dropdown-menu') ||
			t.closest('.qe-toolbar-overflow-menu')
		);
	} catch {
		return false;
	}
};

document.addEventListener('click', (ev: any) => {
	// Clicking inside a dropdown should not dismiss it.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.closeAllMenus && (window as any).__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
});

// Close dropdowns on scroll/wheel so they don't float detached from their buttons.
document.addEventListener('scroll', (ev: any) => {
	// The dropdown menus themselves are scrollable; do not dismiss on internal menu scroll.
	try {
		const target = ev && ev.target ? ev.target : null;
		if (target && target.closest && (target.closest('.kusto-dropdown-menu') || target.closest('.kusto-favorites-menu'))) {
			return;
		}
	} catch { /* ignore */ }
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.closeAllMenus && (window as any).__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
}, true); // Use capture to catch scroll events on nested scrollable elements

document.addEventListener('wheel', (ev: any) => {
	// Allow scrolling inside dropdown menus without dismissing them.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { (window as any).__kustoDropdown && (window as any).__kustoDropdown.closeAllMenus && (window as any).__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
}, { passive: true });

function formatElapsed( ms: any) {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	return minutes + ':' + seconds.toString().padStart(2, '0');
}

function setQueryExecuting( boxId: any, executing: any) {
	const runBtn = document.getElementById(boxId + '_run_btn') as any;
	const runToggle = document.getElementById(boxId + '_run_toggle') as any;
	const status = document.getElementById(boxId + '_exec_status') as any;
	const elapsed = document.getElementById(boxId + '_exec_elapsed') as any;
	const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;

	if (_win.queryExecutionTimers[boxId]) {
		clearInterval(_win.queryExecutionTimers[boxId]);
		delete _win.queryExecutionTimers[boxId];
	}

	if (executing) {
		if (runBtn) {
			runBtn.disabled = true;
		}
		if (runToggle) {
			runToggle.disabled = true;
		}
		if (cancelBtn) {
			cancelBtn.disabled = false;
			cancelBtn.style.display = 'flex';
		}
		closeRunMenu(boxId);
		if (status) {
			status.style.display = 'inline-flex';
		}
		if (elapsed) {
			elapsed.textContent = '0:00';
		}

		// Clear stale results/errors from the previous query so the user
		// doesn't see an old error while a new query is running.
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv) {
				resultsDiv.innerHTML = '';
				resultsDiv.classList.remove('visible');
			}
		} catch { /* ignore */ }

		const start = performance.now();
		_win.queryExecutionTimers[boxId] = setInterval(() => {
			if (elapsed) {
				elapsed.textContent = formatElapsed(performance.now() - start);
			}
		}, 1000);
		return;
	}

	try {
		if (typeof (window as any).__kustoUpdateRunEnabledForBox === 'function') {
			(window as any).__kustoUpdateRunEnabledForBox(boxId);
		} else {
			if (runBtn) {
				runBtn.disabled = false;
			}
			if (runToggle) {
				runToggle.disabled = false;
			}
		}
	} catch {
		if (runBtn) {
			runBtn.disabled = false;
		}
		if (runToggle) {
			runToggle.disabled = false;
		}
	}
	if (cancelBtn) {
		cancelBtn.disabled = true;
		cancelBtn.style.display = 'none';
	}
	if (status) {
		status.style.display = 'none';
	}
}

function cancelQuery( boxId: any) {
	try {
		const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch {
		// ignore
	}
	try {
		(_win.vscode as any).postMessage({ type: 'cancelQuery', boxId: boxId });
	} catch {
		// ignore
	}
}

function executeQuery( boxId: any, mode?: any) {
	const effectiveMode = mode || getRunMode(boxId);
	try {
		if (typeof (window as any).__kustoClearAutoFindInQueryEditor === 'function') {
			(window as any).__kustoClearAutoFindInQueryEditor(boxId);
		}
	} catch { /* ignore */ }
	const __kustoExtractStatementAtCursor = (editor: any) => {
		try {
			if (typeof (window as any).__kustoExtractStatementTextAtCursor === 'function') {
				return (window as any).__kustoExtractStatementTextAtCursor(editor);
			}
		} catch { /* ignore */ }
		try {
			if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') {
				return null;
			}
			const model = editor.getModel();
			const pos = editor.getPosition();
			if (!model || !pos || typeof model.getLineCount !== 'function') {
				return null;
			}
			const cursorLine = pos.lineNumber;
			if (typeof cursorLine !== 'number' || !isFinite(cursorLine) || cursorLine < 1) {
				return null;
			}
			const lineCount = model.getLineCount();
			if (!lineCount || cursorLine > lineCount) {
				return null;
			}

			// Statements are separated by one or more blank lines.
			// Blank lines inside triple-backtick (```) multi-line string literals are NOT separators.
			const blocks = [];
			let inBlock = false;
			let startLine = 1;
			let inTripleBacktick = false;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
				// Track triple-backtick state.
				let tripleCount = 0;
				for (let ci = 0; ci < lineText.length - 2; ci++) {
					if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') {
						tripleCount++;
						ci += 2;
					}
				}
				if (tripleCount % 2 === 1) inTripleBacktick = !inTripleBacktick;
				if (inTripleBacktick) {
					if (!inBlock) { startLine = ln; inBlock = true; }
					continue;
				}
				const isBlank = !String(lineText || '').trim();
				if (isBlank) {
					if (inBlock) {
						blocks.push({ startLine, endLine: ln - 1 });
						inBlock = false;
					}
					continue;
				}
				if (!inBlock) {
					startLine = ln;
					inBlock = true;
				}
			}
			if (inBlock) {
				blocks.push({ startLine, endLine: lineCount });
			}

			const block = blocks.find((b: any) => cursorLine >= b.startLine && cursorLine <= b.endLine);
			if (!block) {
				// Cursor is on a blank separator line (or the editor is empty).
				return null;
			}

			const endCol = (typeof model.getLineMaxColumn === 'function')
				? model.getLineMaxColumn(block.endLine)
				: 1;
			const range = {
				startLineNumber: block.startLine,
				startColumn: 1,
				endLineNumber: block.endLine,
				endColumn: endCol
			};
			let text = '';
			try {
				text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : '';
			} catch {
				text = '';
			}
			const trimmed = String(text || '').trim();
			return trimmed || null;
		} catch {
			return null;
		}
	};

	const editor = _win.queryEditors[boxId] ? _win.queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	// If the editor has multiple statements (blank-line separated), run only the statement at cursor.
	// IMPORTANT: Do NOT add checks for hasTextFocus or activeQueryEditorBoxId here!
	// When clicking the Run button, the editor loses focus before this code executes, which would
	// cause the full editor content to be sent instead of just the active statement. This was a
	// regression bug - always check for multiple statements and extract at cursor unconditionally.
	try {
		if (editor) {
			const model = editor.getModel && editor.getModel();
			const blocks = (model && typeof (window as any).__kustoGetStatementBlocksFromModel === 'function')
				? (window as any).__kustoGetStatementBlocksFromModel(model)
				: [];
			const hasMultipleStatements = blocks && blocks.length > 1;
			if (hasMultipleStatements) {
				const statement = __kustoExtractStatementAtCursor(editor);
				if (statement) {
					query = statement;
				} else {
					// Cursor is on a separator line between statements.
					try {
						(_win.vscode as any).postMessage({
							type: 'showInfo',
							message: 'Place the cursor inside a query statement (not on a separator) to run that statement.'
						});
					} catch { /* ignore */ }
					return;
				}
			}
		}
	} catch { /* ignore */ }
	let connectionId = __kustoGetConnectionId(boxId);
	let database = __kustoGetDatabase(boxId);
	let cacheEnabled = (document.getElementById(boxId + '_cache_enabled') as any).checked;
	const cacheValue = parseInt((document.getElementById(boxId + '_cache_value') as any).value) || 1;
	const cacheUnit = (document.getElementById(boxId + '_cache_unit') as any).value;

	let sourceBoxIdForComparison = '';
	let isComparisonBox = false;

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof _win.optimizationMetadataByBoxId === 'object' && _win.optimizationMetadataByBoxId) {
			const meta = _win.optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				isComparisonBox = true;
				sourceBoxIdForComparison = String(sourceBoxId || '');
				const srcConnId = __kustoGetConnectionId(sourceBoxId);
				const srcDb = __kustoGetDatabase(sourceBoxId);
				if (srcConnId) {
					connectionId = srcConnId;
				}
				if (srcDb) {
					database = srcDb;
				}
			}
			// While linked optimization exists, always disable caching for benchmark runs.
			const hasLinkedOptimization = !!(meta && meta.isComparison)
				|| !!(_win.optimizationMetadataByBoxId[boxId] && _win.optimizationMetadataByBoxId[boxId].comparisonBoxId);
			if (hasLinkedOptimization) {
				cacheEnabled = false;
			}
		}
	} catch { /* ignore */ }

	// Cache consistency policy for comparisons:
	// If the source box was last executed with caching enabled, rerun it once with caching disabled
	// before (or alongside) running the comparison box. This avoids cached-vs-live drift causing
	// false mismatches when queries are otherwise unchanged.
	try {
		if (isComparisonBox && sourceBoxIdForComparison) {
			const cacheMap = (window as any).__kustoLastRunCacheEnabledByBoxId;
			const sourceLastRunUsedCaching = !!(cacheMap && typeof cacheMap === 'object' && cacheMap[sourceBoxIdForComparison]);
			if (sourceLastRunUsedCaching) {
				// Prevent transient comparisons against stale cached source results.
				try {
					if ((window as any).__kustoResultsByBoxId && typeof (window as any).__kustoResultsByBoxId === 'object') {
						delete (window as any).__kustoResultsByBoxId[sourceBoxIdForComparison];
					}
				} catch { /* ignore */ }
				try {
					_win.__kustoLog(boxId, 'run.compare.rerunSourceNoCache', 'Rerunning source query with caching disabled', {
						sourceBoxId: sourceBoxIdForComparison
					});
				} catch { /* ignore */ }
				try {
					// This run will inherit the linked-optimization behavior and force cacheEnabled=false.
					executeQuery(sourceBoxIdForComparison, effectiveMode);
				} catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	// Safety: if a favorites switch is still pending/applying, do not run.
	try {
		const pending = !!(_win.pendingFavoriteSelectionByBoxId && _win.pendingFavoriteSelectionByBoxId[boxId]);
		const dbEl = document.getElementById(boxId + '_database') as any;
		const desiredPending = !!(dbEl && dbEl.dataset && dbEl.dataset.desired);
		const dbDisabled = !!(dbEl && dbEl.disabled);
		if (pending || desiredPending || dbDisabled) {
			_win.__kustoLog(boxId, 'run.blocked', 'Blocked run because selection is still updating', {
				pending,
				desiredPending,
				dbDisabled,
				connectionId,
				database
			}, 'warn');
			try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Waiting for the selected favorite to finish applying (loading databases/schema). Try Run again in a moment.' }); } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	if (!query.trim()) {
		return;
	}

	if (!connectionId) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { (_win.vscode as any).postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	_win.__kustoLog(boxId, 'run.start', 'Executing query', { connectionId, database, queryMode: effectiveMode });

	setQueryExecuting(boxId, true);
	closeRunMenu(boxId);

	// Track the effective cacheEnabled value for this run.
	// When caching is enabled, the extension injects an extra (hidden) first line,
	// so error line numbers need to be adjusted for the visible editor.
	try {
		if (!(window as any).__kustoLastRunCacheEnabledByBoxId || typeof (window as any).__kustoLastRunCacheEnabledByBoxId !== 'object') {
			(window as any).__kustoLastRunCacheEnabledByBoxId = {};
		}
		(window as any).__kustoLastRunCacheEnabledByBoxId[boxId] = !!cacheEnabled;
	} catch { /* ignore */ }

	// Store the last executed box for result display
	(window as any).lastExecutedBox = boxId;

	(_win.vscode as any).postMessage({
		type: 'executeQuery',
		query,
		queryMode: effectiveMode,
		connectionId,
		database,
		boxId,
		cacheEnabled,
		cacheValue,
		cacheUnit
	});
}

// ── Window bridges for remaining legacy callers ──
(window as any).optimizeQueryWithCopilot = optimizeQueryWithCopilot;
(window as any).exportQueryToPowerBI = exportQueryToPowerBI;
(window as any).fullyQualifyTablesInEditor = fullyQualifyTablesInEditor;
(window as any).qualifyTablesInTextPriority = qualifyTablesInTextPriority;
(window as any).__kustoIndexToAlphaName = __kustoIndexToAlphaName;
(window as any).__kustoGetUsedSectionNamesUpper = __kustoGetUsedSectionNamesUpper;
(window as any).addQueryBox = addQueryBox;
(window as any).__kustoAutoSizeEditor = __kustoAutoSizeEditor;
(window as any).__kustoAutoSizeResults = __kustoAutoSizeResults;
(window as any).__kustoMaximizeQueryBox = __kustoMaximizeQueryBox;
(window as any).__kustoUpdateQueryVisibilityToggleButton = __kustoUpdateQueryVisibilityToggleButton;
(window as any).__kustoApplyQueryBoxVisibility = __kustoApplyQueryBoxVisibility;
(window as any).toggleQueryBoxVisibility = toggleQueryBoxVisibility;
(window as any).__kustoSetResultsVisible = __kustoSetResultsVisible;
(window as any).__kustoLockCacheForBenchmark = __kustoLockCacheForBenchmark;
(window as any).__kustoNormalizeCellForComparison = __kustoNormalizeCellForComparison;
(window as any).__kustoRowKeyForComparison = __kustoRowKeyForComparison;
(window as any).__kustoNormalizeColumnNameForComparison = __kustoNormalizeColumnNameForComparison;
(window as any).__kustoGetNormalizedColumnNameList = __kustoGetNormalizedColumnNameList;
(window as any).__kustoDoColumnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch;
(window as any).__kustoGetColumnDifferences = __kustoGetColumnDifferences;
(window as any).__kustoDoColumnOrderMatch = __kustoDoColumnOrderMatch;
(window as any).__kustoDoRowOrderMatch = __kustoDoRowOrderMatch;
(window as any).__kustoBuildColumnIndexMapForNames = __kustoBuildColumnIndexMapForNames;
(window as any).__kustoBuildNameBasedColumnMapping = __kustoBuildNameBasedColumnMapping;
(window as any).__kustoRowKeyForComparisonWithColumnMapping = __kustoRowKeyForComparisonWithColumnMapping;
(window as any).__kustoRowKeyForComparisonIgnoringColumnOrder = __kustoRowKeyForComparisonIgnoringColumnOrder;
(window as any).__kustoAreResultsEquivalentWithDetails = __kustoAreResultsEquivalentWithDetails;
(window as any).__kustoAreResultsEquivalent = __kustoAreResultsEquivalent;
(window as any).__kustoDoResultHeadersMatch = __kustoDoResultHeadersMatch;
(window as any).__kustoUpdateAcceptOptimizationsButton = __kustoUpdateAcceptOptimizationsButton;
(window as any).acceptOptimizations = acceptOptimizations;
(window as any).__kustoUpdateQueryResultsToggleButton = __kustoUpdateQueryResultsToggleButton;
(window as any).__kustoUpdateComparisonSummaryToggleButton = __kustoUpdateComparisonSummaryToggleButton;
(window as any).__kustoApplyResultsVisibility = __kustoApplyResultsVisibility;
(window as any).__kustoApplyComparisonSummaryVisibility = __kustoApplyComparisonSummaryVisibility;
(window as any).toggleQueryResultsVisibility = toggleQueryResultsVisibility;
(window as any).toggleComparisonSummaryVisibility = toggleComparisonSummaryVisibility;
(window as any).__kustoEnsureCacheBackupMap = __kustoEnsureCacheBackupMap;
(window as any).__kustoBackupCacheSettings = __kustoBackupCacheSettings;
(window as any).__kustoRestoreCacheSettings = __kustoRestoreCacheSettings;
(window as any).__kustoEnsureRunModeBackupMap = __kustoEnsureRunModeBackupMap;
(window as any).__kustoBackupRunMode = __kustoBackupRunMode;
(window as any).__kustoRestoreRunMode = __kustoRestoreRunMode;
(window as any).__kustoSetLinkedOptimizationMode = __kustoSetLinkedOptimizationMode;
(window as any).updateCaretDocsToggleButtons = updateCaretDocsToggleButtons;
(window as any).updateAutoTriggerAutocompleteToggleButtons = updateAutoTriggerAutocompleteToggleButtons;
(window as any).toggleAutoTriggerAutocompleteEnabled = toggleAutoTriggerAutocompleteEnabled;
(window as any).updateCopilotInlineCompletionsToggleButtons = updateCopilotInlineCompletionsToggleButtons;
(window as any).toggleCopilotInlineCompletionsEnabled = toggleCopilotInlineCompletionsEnabled;
(window as any).toggleCaretDocsEnabled = toggleCaretDocsEnabled;
(window as any).onQueryEditorToolbarAction = onQueryEditorToolbarAction;
(window as any).copyQueryAsAdeLink = copyQueryAsAdeLink;
(window as any).__kustoOpenShareModal = __kustoOpenShareModal;
(window as any).__kustoCloseShareModal = __kustoCloseShareModal;
(window as any).__kustoShareCopyToClipboard = __kustoShareCopyToClipboard;
(window as any).setToolbarActionBusy = setToolbarActionBusy;
(window as any).closeToolsDropdown = closeToolsDropdown;
(window as any).initToolbarOverflow = initToolbarOverflow;
(window as any).initRunButtonResponsive = initRunButtonResponsive;
(window as any).updateRunButtonResponsive = updateRunButtonResponsive;
(window as any).updateToolbarOverflow = updateToolbarOverflow;
(window as any).toggleToolbarOverflow = toggleToolbarOverflow;
(window as any).toggleOverflowSubmenu = toggleOverflowSubmenu;
(window as any).closeToolbarOverflow = closeToolbarOverflow;
(window as any).closeAllToolbarOverflowMenus = closeAllToolbarOverflowMenus;
(window as any).renderToolbarOverflowMenu = renderToolbarOverflowMenu;
(window as any).toggleToolsDropdown = toggleToolsDropdown;
(window as any).renderToolsMenuForBox = renderToolsMenuForBox;
(window as any).runMonacoAction = runMonacoAction;
(window as any).replaceAllInEditor = replaceAllInEditor;
(window as any).displayComparisonSummary = displayComparisonSummary;
(window as any).__kustoEnsureOptimizePrepByBoxId = __kustoEnsureOptimizePrepByBoxId;
(window as any).__kustoHideOptimizePromptForBox = __kustoHideOptimizePromptForBox;
(window as any).__kustoSetOptimizeInProgress = __kustoSetOptimizeInProgress;
(window as any).__kustoUpdateOptimizeStatus = __kustoUpdateOptimizeStatus;
(window as any).__kustoCancelOptimizeQuery = __kustoCancelOptimizeQuery;
(window as any).__kustoShowOptimizePromptLoading = __kustoShowOptimizePromptLoading;
(window as any).__kustoGetLastOptimizeModelId = __kustoGetLastOptimizeModelId;
(window as any).__kustoSetLastOptimizeModelId = __kustoSetLastOptimizeModelId;
(window as any).__kustoApplyOptimizeQueryOptions = __kustoApplyOptimizeQueryOptions;
(window as any).__kustoRunOptimizeQueryWithOverrides = __kustoRunOptimizeQueryWithOverrides;
(window as any).qualifyTablesInText = qualifyTablesInText;
(window as any).removeQueryBox = removeQueryBox;
(window as any).toggleCachePill = toggleCachePill;
(window as any).toggleCachePopup = toggleCachePopup;
(window as any).toggleCacheControls = toggleCacheControls;
(window as any).formatClusterDisplayName = formatClusterDisplayName;
(window as any).normalizeClusterUrlKey = normalizeClusterUrlKey;
(window as any).formatClusterShortName = formatClusterShortName;
(window as any).clusterShortNameKey = clusterShortNameKey;
(window as any).extractClusterUrlsFromQueryText = extractClusterUrlsFromQueryText;
(window as any).extractClusterDatabaseHintsFromQueryText = extractClusterDatabaseHintsFromQueryText;
(window as any).computeMissingClusterUrls = computeMissingClusterUrls;
(window as any).renderMissingClustersBanner = renderMissingClustersBanner;
(window as any).updateMissingClustersForBox = updateMissingClustersForBox;
(window as any).__kustoFavoriteKey = __kustoFavoriteKey;
(window as any).__kustoGetCurrentClusterUrlForBox = __kustoGetCurrentClusterUrlForBox;
(window as any).__kustoGetCurrentDatabaseForBox = __kustoGetCurrentDatabaseForBox;
(window as any).__kustoFindFavorite = __kustoFindFavorite;
(window as any).__kustoGetFavoritesSorted = __kustoGetFavoritesSorted;
(window as any).__kustoMarkNewBoxForFavoritesAutoEnter = __kustoMarkNewBoxForFavoritesAutoEnter;
(window as any).__kustoTryAutoEnterFavoritesModeForNewBox = __kustoTryAutoEnterFavoritesModeForNewBox;
(window as any).__kustoTryAutoEnterFavoritesModeForBox = __kustoTryAutoEnterFavoritesModeForBox;
(window as any).__kustoFindConnectionIdForClusterUrl = __kustoFindConnectionIdForClusterUrl;
(window as any).__kustoTryApplyPendingFavoriteSelectionForBox = __kustoTryApplyPendingFavoriteSelectionForBox;
(window as any).__kustoSetElementDisplay = __kustoSetElementDisplay;
(window as any).__kustoUpdateFavoritesUiForBox = __kustoUpdateFavoritesUiForBox;
(window as any).toggleFavoriteForBox = toggleFavoriteForBox;
(window as any).removeFavorite = removeFavorite;
(window as any).closeAllFavoritesDropdowns = closeAllFavoritesDropdowns;
(window as any).__kustoApplyFavoritesMode = __kustoApplyFavoritesMode;
(window as any).__kustoGetTrashIconSvg = __kustoGetTrashIconSvg;
(window as any).addMissingClusterConnections = addMissingClusterConnections;
(window as any).updateConnectionSelects = updateConnectionSelects;
(window as any).updateDatabaseField = updateDatabaseField;
(window as any).__kustoClearDatabaseLoadError = __kustoClearDatabaseLoadError;
(window as any).promptAddConnectionFromDropdown = promptAddConnectionFromDropdown;
(window as any).importConnectionsFromXmlFile = importConnectionsFromXmlFile;
(window as any).parseKustoExplorerConnectionsXml = parseKustoExplorerConnectionsXml;
(window as any).getChildText = getChildText;
(window as any).parseKustoConnectionString = parseKustoConnectionString;
(window as any).refreshDatabases = refreshDatabases;
(window as any).onDatabasesError = onDatabasesError;
(window as any).updateDatabaseSelect = updateDatabaseSelect;
(window as any).__kustoIsValidConnectionIdForRun = __kustoIsValidConnectionIdForRun;
(window as any).__kustoGetEffectiveSelectionOwnerIdForRun = __kustoGetEffectiveSelectionOwnerIdForRun;
(window as any).__kustoIsRunSelectionReady = __kustoIsRunSelectionReady;
(window as any).__kustoHasValidFavoriteSelection = __kustoHasValidFavoriteSelection;
(window as any).__kustoClearSchemaSummaryIfNoSelection = __kustoClearSchemaSummaryIfNoSelection;
(window as any).__kustoApplyRunModeFromMenu = __kustoApplyRunModeFromMenu;
(window as any).getRunMode = getRunMode;
(window as any).getRunModeLabelText = getRunModeLabelText;
(window as any).setRunMode = setRunMode;
(window as any).closeRunMenu = closeRunMenu;
(window as any).closeAllRunMenus = closeAllRunMenus;
(window as any).toggleRunMenu = toggleRunMenu;
(window as any).formatElapsed = formatElapsed;
(window as any).setQueryExecuting = setQueryExecuting;
(window as any).cancelQuery = cancelQuery;
(window as any).executeQuery = executeQuery;
