function __kustoIndexToAlphaName(index) {
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

function __kustoGetUsedSectionNamesUpper(excludeBoxId) {
	const used = new Set();
	try {
		const excludeId = excludeBoxId ? (String(excludeBoxId) + '_name') : '';
		const inputs = document.querySelectorAll ? document.querySelectorAll('input.query-name') : [];
		for (const el of inputs) {
			try {
				if (!el) continue;
				if (excludeId && el.id === excludeId) continue;
				const v = String(el.value || '').trim();
				if (!v) continue;
				used.add(v.toUpperCase());
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	return used;
}

function __kustoPickNextAvailableSectionLetterName(excludeBoxId) {
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

function __kustoEnsureSectionHasDefaultNameIfMissing(boxId) {
	try {
		const id = String(boxId || '');
		if (!id) return '';
		const input = document.getElementById(id + '_name');
		if (!input) return '';
		const current = String(input.value || '').trim();
		if (current) return current;
		const next = __kustoPickNextAvailableSectionLetterName(id);
		input.value = next;
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		return next;
	} catch {
		return '';
	}
}

// Expose for persistence + extra box types.
try {
	window.__kustoPickNextAvailableSectionLetterName = __kustoPickNextAvailableSectionLetterName;
	window.__kustoEnsureSectionHasDefaultNameIfMissing = __kustoEnsureSectionHasDefaultNameIfMissing;
} catch { /* ignore */ }

function addQueryBox(options) {
	const isFirstBox = !(Array.isArray(queryBoxes) && queryBoxes.length > 0);
	const id = (options && options.id) ? String(options.id) : ('query_' + Date.now());
	const initialQuery = (options && options.initialQuery) ? String(options.initialQuery) : '';
	const isComparison = !!(options && options.isComparison);
	const defaultResultsVisible = (options && typeof options.defaultResultsVisible === 'boolean') ? !!options.defaultResultsVisible : true;
	const defaultComparisonSummaryVisible = isComparison ? true : ((options && typeof options.defaultComparisonSummaryVisible === 'boolean') ? !!options.defaultComparisonSummaryVisible : true);
	const defaultExpanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	queryBoxes.push(id);

	const container = document.getElementById('queries-container');

	const clusterIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M5 3.5h6"/>' +
		'<path d="M4 6h8"/>' +
		'<path d="M3.5 8.5h9"/>' +
		'<path d="M4 11h8"/>' +
		'<path d="M5 13.5h6"/>' +
		'</svg>';

	const databaseIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<ellipse cx="8" cy="4" rx="5" ry="2"/>' +
		'<path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4"/>' +
		'<path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2"/>' +
		'<path d="M3 12c0 1.1 2.2 2 5 2s5-.9 5-2"/>' +
		'</svg>';

	const refreshIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3.5 8a4.5 4.5 0 0 1 7.8-3.1"/>' +
		'<polyline points="11.3 2.7 11.3 5.4 8.6 5.4"/>' +
		'<path d="M12.5 8a4.5 4.5 0 0 1-7.8 3.1"/>' +
		'<polyline points="4.7 13.3 4.7 10.6 7.4 10.6"/>' +
		'</svg>';

	const favoriteStarIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3.8 4.6L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" />' +
		'</svg>';

	const favoritesListIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" />' +
		'<line x1="10" y1="10.5" x2="14.5" y2="10.5" stroke-width="1.4" stroke-linecap="round" />' +
		'<line x1="10" y1="12.5" x2="14.5" y2="12.5" stroke-width="1.4" stroke-linecap="round" />' +
		'<line x1="10" y1="14.5" x2="14.5" y2="14.5" stroke-width="1.4" stroke-linecap="round" />' +
		'</svg>';

	const clusterPickerIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<ellipse cx="8" cy="4" rx="5" ry="2" />' +
		'<path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />' +
		'<path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />' +
		'</svg>';

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

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

	const singleLineIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 8h12"/>' +
		'</svg>';

	const qualifyTablesIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/>' +
		'</svg>';

	const doubleToSingleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';

	const singleToDoubleIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/>' +
		'<path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/>' +
		'</svg>';

	const previewIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z" />' +
		'<circle cx="8" cy="8" r="2.1" />' +
		'</svg>';

	const maximizeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 6V3h3" />' +
		'<path d="M13 10v3h-3" />' +
		'<path d="M3 3l4 4" />' +
		'<path d="M13 13l-4-4" />' +
		'</svg>';

	const summaryIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg">' +
		'<rect x="2" y="10" width="3" height="4"/>' +
		'<rect x="6" y="6" width="3" height="8"/>' +
		'<rect x="10" y="3" width="3" height="11"/>' +
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
			return (window.__kustoQueryEditorConfig && window.__kustoQueryEditorConfig.copilotLogoUri)
				? String(window.__kustoQueryEditorConfig.copilotLogoUri)
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
		'<button type="button" id="' + id + '_autocomplete_btn" data-qe-action="autocomplete" data-qe-overflow-action="autocomplete" data-qe-overflow-label="Trigger autocomplete" class="unified-btn-secondary query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'autocomplete\')" title="Trigger autocomplete\nShortcut: Ctrl+Space" aria-label="Trigger autocomplete (Ctrl+Space)">' +
		'<span class="qe-icon" aria-hidden="true">' + autocompleteIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_caret_docs_toggle" data-qe-overflow-action="caretDocs" data-qe-overflow-label="Smart documentation" class="unified-btn-secondary query-editor-toolbar-btn query-editor-toolbar-toggle' + (caretDocsEnabled ? ' is-active' : '') + '" onclick="toggleCaretDocsEnabled()" title="Smart documentation\nShows Kusto documentation as you move the cursor" aria-pressed="' + (caretDocsEnabled ? 'true' : 'false') + '">' +
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

	// Reusable dropdown markup helpers (loaded via media/queryEditor/dropdown.js)
	const __kustoRenderSelect = (opts) => {
		try {
			if (window.__kustoDropdown && typeof window.__kustoDropdown.renderSelectHtml === 'function') {
				return window.__kustoDropdown.renderSelectHtml(opts);
			}
		} catch { /* ignore */ }
		return '';
	};
	const __kustoRenderMenuDropdown = (opts) => {
		try {
			if (window.__kustoDropdown && typeof window.__kustoDropdown.renderMenuDropdownHtml === 'function') {
				return window.__kustoDropdown.renderMenuDropdownHtml(opts);
			}
		} catch { /* ignore */ }
		return '';
	};

	const favoritesDropdownHtml = __kustoRenderMenuDropdown({
		wrapperClass: 'kusto-favorites-combo',
		wrapperId: id + '_favorites_wrapper',
		wrapperStyle: 'display:none;',
		title: 'Favorites',
		buttonId: id + '_favorites_btn',
		buttonTextId: id + '_favorites_btn_text',
		menuId: id + '_favorites_menu',
		placeholder: 'Select favorite...',
		onToggle: "toggleFavoritesDropdown('" + id + "')"
	});

	// IMPORTANT: Use a single dropdown implementation everywhere (button+menu), even when
	// other code paths still expect a <select>. We keep a hidden backing <select> with the
	// same id so existing selection/persistence code continues to work.
	const clusterSelectHtml = __kustoRenderMenuDropdown({
		wrapperClass: 'half-width',
		title: 'Kusto Cluster',
		iconSvg: clusterIconSvg,
		includeHiddenSelect: true,
		selectId: id + '_connection',
		onChange: "updateDatabaseField('" + id + "'); try{schedulePersist&&schedulePersist()}catch{}",
		buttonId: id + '_connection_btn',
		buttonTextId: id + '_connection_btn_text',
		menuId: id + '_connection_menu',
		placeholder: 'Select Cluster...',
		onToggle: "try{window.__kustoDropdown&&window.__kustoDropdown.toggleSelectMenu&&window.__kustoDropdown.toggleSelectMenu('" + id + "_connection')}catch{}"
	});

	const databaseSelectHtml = __kustoRenderMenuDropdown({
		wrapperClass: 'half-width',
		title: 'Kusto Database',
		iconSvg: databaseIconSvg,
		includeHiddenSelect: true,
		selectId: id + '_database',
		onChange: "onDatabaseChanged('" + id + "'); try{schedulePersist&&schedulePersist()}catch{}",
		buttonId: id + '_database_btn',
		buttonTextId: id + '_database_btn_text',
		menuId: id + '_database_menu',
		placeholder: 'Select Database...',
		onToggle: "try{window.__kustoDropdown&&window.__kustoDropdown.toggleSelectMenu&&window.__kustoDropdown.toggleSelectMenu('" + id + "_database')}catch{}"
	});

	const boxHtml =
		'<div class="query-box' + (isComparison ? ' is-optimized-comparison' : '') + '" id="' + id + '">' +
		'<div class="query-header">' +
		'<div class="query-header-row query-header-row-top">' +
		'<div class="query-name-group">' +
		'<button type="button" class="section-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder section"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
		'<input type="text" class="query-name" placeholder="Query Name (optional)" id="' + id + '_name" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'</div>' +
		'<div class="section-actions">' +
		'<div class="md-tabs" role="tablist" aria-label="Query visibility">' +
		'<button class="unified-btn-secondary md-tab md-max-btn" id="' + id + '_max" type="button" onclick="__kustoMaximizeQueryBox(\'' + id + '\')" title="Fit to contents" aria-label="Fit to contents">' + maximizeIconSvg + '</button>' +
		'<button class="unified-btn-secondary md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleQueryBoxVisibility(\'' + id + '\')" title="Hide" aria-label="Hide">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="unified-btn-secondary unified-btn-icon-only refresh-btn close-btn" onclick="removeQueryBox(\'' + id + '\')" title="Remove query box" aria-label="Remove query box">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-header-row query-header-row-bottom">' +
		(favoritesDropdownHtml ||
			('<div class="kusto-favorites-combo select-wrapper" id="' + id + '_favorites_wrapper" style="display:none;" title="Favorites">' +
			'<button type="button" class="kusto-favorites-btn" id="' + id + '_favorites_btn" onclick="toggleFavoritesDropdown(\'' + id + '\'); event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
			'<span class="kusto-favorites-btn-text" id="' + id + '_favorites_btn_text">Select favorite...</span>' +
			'<span class="kusto-favorites-btn-caret" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg></span>' +
			'</button>' +
			'<div class="kusto-favorites-menu" id="' + id + '_favorites_menu" role="listbox" style="display:none;"></div>' +
			'</div>')) +
		(clusterSelectHtml ||
			('<div class="select-wrapper has-icon half-width" title="Kusto Cluster">' +
			'<span class="select-icon" aria-hidden="true">' + clusterIconSvg + '</span>' +
			'<select id="' + id + '_connection" onchange="updateDatabaseField(\'' + id + '\'); try{schedulePersist&&schedulePersist()}catch{}">' +
			'<option value="" disabled selected hidden>Select Cluster...</option>' +
			'</select>' +
			'</div>')) +
		(databaseSelectHtml ||
			('<div class="select-wrapper has-icon half-width" title="Kusto Database">' +
			'<span class="select-icon" aria-hidden="true">' + databaseIconSvg + '</span>' +
			'<select id="' + id + '_database" onchange="onDatabaseChanged(\'' + id + '\'); try{schedulePersist&&schedulePersist()}catch{}">' +
			'<option value="" disabled selected hidden>Select Database...</option>' +
			'</select>' +
			'</div>')) +
		'<button class="unified-btn-secondary unified-btn-icon-only unified-btn-bordered refresh-btn" onclick="refreshDatabases(\'' + id + '\')" id="' + id + '_refresh" title="Refresh database list" aria-label="Refresh database list">' + refreshIconSvg + '</button>' +
		'<button class="unified-btn-secondary unified-btn-icon-only refresh-btn favorite-btn" onclick="toggleFavoriteForBox(\'' + id + '\')" id="' + id + '_favorite_toggle" title="Add to favorites" aria-label="Add to favorites">' + favoriteStarIconSvg + '</button>' +
		'<button class="unified-btn-secondary unified-btn-icon-only refresh-btn favorites-show-btn" onclick="toggleFavoritesMode(\'' + id + '\')" id="' + id + '_favorites_show" title="Show favorites" aria-label="Show favorites" style="display:none;">' + favoritesListIconSvg + '</button>' +
		'<div class="schema-area" aria-label="Schema status">' +
		'<span class="schema-status" id="' + id + '_schema_status" style="display: none;" title="Loading schema for autocomplete...">' +
		'<span class="schema-spinner" aria-hidden="true"></span>' +
		'<span>Schema…</span>' +
		'</span>' +
		'<span class="schema-loaded" id="' + id + '_schema_loaded" style="display: none;"></span>' +
		'<button class="unified-btn-secondary unified-btn-icon-only unified-btn-bordered refresh-btn" onclick="refreshSchema(\'' + id + '\')" id="' + id + '_schema_refresh" title="Refresh schema" aria-label="Refresh schema">' + refreshIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'</div>' +
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
		'<div class="query-editor-resizer" id="' + id + '_query_resizer" title="Drag to resize editor"></div>' +
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
		'<span id="' + id + '_exec_elapsed">0:00.0</span>' +
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
		'<label class="cache-checkbox">' +
		'<input type="checkbox" id="' + id + '_cache_enabled" checked onchange="toggleCacheControls(\'' + id + '\'); try{schedulePersist&&schedulePersist()}catch{}" />' +
		'Cache results for' +
		'</label>' +
		'<input type="number" id="' + id + '_cache_value" value="1" min="1" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'<select id="' + id + '_cache_unit" onchange="try{schedulePersist&&schedulePersist()}catch{}">' +
		'<option value="minutes">Minutes</option>' +
		'<option value="hours">Hours</option>' +
		'<option value="days" selected>Days</option>' +
		'</select>' +
		'</div>' +
		'</div>' +
		'<div class="results-wrapper" id="' + id + '_results_wrapper" style="display: none;">' +
		'<div class="results" id="' + id + '_results"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_results_resizer" title="Drag to resize results"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	// Do not auto-assign a name; section names are user-defined unless explicitly set by a feature.
	try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
	setRunMode(id, 'take100');

	// Default the connection to the query box above this one (if any).
	// This provides a better UX when adding multiple queries against the same cluster/database.
	try {
		if (!options || (!options.clusterUrl && !options.database)) {
			// Find the previous query box in the DOM (by iterating container children).
			const children = container ? Array.from(container.children || []) : [];
			let prevQueryBoxId = null;
			for (let i = children.length - 1; i >= 0; i--) {
				const child = children[i];
				const childId = child && child.id ? String(child.id) : '';
				if (childId === id) continue; // Skip the box we just added.
				if (childId.startsWith('query_')) {
					prevQueryBoxId = childId;
					break;
				}
			}
			if (prevQueryBoxId) {
				// Get the connection and database from the previous query box.
				const prevConnSel = document.getElementById(prevQueryBoxId + '_connection');
				const prevDbSel = document.getElementById(prevQueryBoxId + '_database');
				const prevConnectionId = prevConnSel ? String(prevConnSel.value || '') : '';
				const prevDatabase = prevDbSel ? String(prevDbSel.value || '') : '';
				if (prevConnectionId && prevConnectionId !== '__enter_new__' && prevConnectionId !== '__import_xml__') {
					// Find the cluster URL for this connection ID.
					let prevClusterUrl = '';
					try {
						const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '') === prevConnectionId) : null;
						prevClusterUrl = conn ? String(conn.clusterUrl || '') : '';
					} catch { /* ignore */ }
					if (prevClusterUrl) {
						const newConnSel = document.getElementById(id + '_connection');
						if (newConnSel && newConnSel.dataset) {
							newConnSel.dataset.desiredClusterUrl = prevClusterUrl;
						}
					}
					if (prevDatabase) {
						const newDbSel = document.getElementById(id + '_database');
						if (newDbSel && newDbSel.dataset) {
							newDbSel.dataset.desired = prevDatabase;
						}
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
		if (isFirstBox && typeof window.__kustoMaybeDefaultFirstBoxToFavoritesMode === 'function') {
			window.__kustoMaybeDefaultFirstBoxToFavoritesMode();
		}
	} catch { /* ignore */ }
	initQueryEditor(id);

	// Default visibility state (results + comparison summary)
	try {
		if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
			window.__kustoResultsVisibleByBoxId = {};
		}
		window.__kustoResultsVisibleByBoxId[id] = defaultResultsVisible;
	} catch { /* ignore */ }
	// Default section visibility state (expanded/collapsed)
	try {
		if (!window.__kustoQueryExpandedByBoxId || typeof window.__kustoQueryExpandedByBoxId !== 'object') {
			window.__kustoQueryExpandedByBoxId = {};
		}
		window.__kustoQueryExpandedByBoxId[id] = defaultExpanded;
	} catch { /* ignore */ }
	try {
		if (!window.__kustoComparisonSummaryVisibleByBoxId || typeof window.__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			window.__kustoComparisonSummaryVisibleByBoxId = {};
		}
		window.__kustoComparisonSummaryVisibleByBoxId[id] = isComparison ? true : defaultComparisonSummaryVisible;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryVisibilityToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyQueryBoxVisibility(id); } catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(id); } catch { /* ignore */ }
	try { __kustoUpdateComparisonSummaryToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(id); } catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(id); } catch { /* ignore */ }

	// Drag handle resize for results output.
	try {
		const wrapper = document.getElementById(id + '_results_wrapper');
		const resizer = document.getElementById(id + '_results_resizer');
		if (wrapper && resizer) {
			const computeResizeBounds = () => {
				let minHeight = 120;
				let maxHeight = 900;
				try {
					const resultsEl = document.getElementById(id + '_results');
					const hasTable = !!(resultsEl && resultsEl.querySelector && resultsEl.querySelector('.table-container'));
					if (hasTable || !resultsEl) {
						return { minHeight, maxHeight };
					}

					const wrapperH = Math.max(0, Math.ceil(wrapper.getBoundingClientRect().height || 0));
					const resultsClientH = Math.max(0, (resultsEl.clientHeight || 0));
					const overheadPx = Math.max(0, wrapperH - resultsClientH);

					let contentPx = 0;
					const children = resultsEl.children ? Array.from(resultsEl.children) : [];
					if (children.length) {
						for (const child of children) {
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

			resizer.addEventListener('mousedown', (e) => {
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

				const startPageY = e.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					try {
						if (typeof __kustoMaybeAutoScrollWhileDragging === 'function') {
							__kustoMaybeAutoScrollWhileDragging(moveEvent.clientY);
						}
					} catch { /* ignore */ }
					const pageY = moveEvent.clientY + (typeof __kustoGetScrollY === 'function' ? __kustoGetScrollY() : 0);
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
						if (typeof window.__kustoClampResultsWrapperHeight === 'function') {
							window.__kustoClampResultsWrapperHeight(id);
						}
					} catch { /* ignore */ }
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}

	// Clamp the query results output wrapper height so it cannot be taller than its contents.
	// This avoids blank slack below short error messages while still allowing the user to
	// resize smaller than contents (scrolling).
	try {
		if (typeof window.__kustoClampResultsWrapperHeight !== 'function') {
			window.__kustoClampResultsWrapperHeight = function (boxId) {
				try {
					const bid = String(boxId || '').trim();
					if (!bid) return;
					const w = document.getElementById(bid + '_results_wrapper');
					const resultsEl = document.getElementById(bid + '_results');
					if (!w || !resultsEl) return;
					// If we have a table container, results are intentionally scrollable; don't clamp.
					if (resultsEl.querySelector && resultsEl.querySelector('.table-container')) return;

					const wrapperH = Math.max(0, Math.ceil(w.getBoundingClientRect().height || 0));
					const resultsClientH = Math.max(0, (resultsEl.clientHeight || 0));
					const overheadPx = Math.max(0, wrapperH - resultsClientH);

					let contentPx = 0;
					const children = resultsEl.children ? Array.from(resultsEl.children) : [];
					if (children.length) {
						for (const child of children) {
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
	
	// Set initial query text if provided
	if (initialQuery) {
		setTimeout(() => {
			const editor = queryEditors[id];
			if (editor) {
				const model = editor.getModel();
				if (model) {
					model.setValue(initialQuery);
				}
			}
		}, 50);
	}
	
	// Check Copilot availability for this box
	try {
		vscode.postMessage({
			type: 'checkCopilotAvailability',
			boxId: id
		});
	} catch { /* ignore */ }
	
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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

function __kustoMaximizeQueryBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const editorEl = document.getElementById(id + '_query_editor');
	const wrapper = editorEl && editorEl.closest ? editorEl.closest('.query-editor-wrapper') : null;
	if (!wrapper) return;
	const FIT_SLACK_PX = 5;
	const applyFitToContent = () => {
		try {
			const ed = (typeof queryEditors === 'object' && queryEditors) ? queryEditors[id] : null;
			if (!ed) return;

			// IMPORTANT: use content height, not scroll height.
			// Monaco's getScrollHeight is often >= the viewport height, which prevents shrinking.
			let contentHeight = 0;
			try {
				const ch = (typeof ed.getContentHeight === 'function') ? ed.getContentHeight() : 0;
				if (ch && Number.isFinite(ch)) contentHeight = Math.max(contentHeight, ch);
			} catch { /* ignore */ }
			if (!contentHeight || !Number.isFinite(contentHeight) || contentHeight <= 0) return;

			const addVisibleRectHeight = (el) => {
				try {
					if (!el) return 0;
					try {
						const cs = getComputedStyle(el);
						if (cs && cs.display === 'none') return 0;
						const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
						let margin = 0;
						try {
							margin += parseFloat(cs.marginTop || '0') || 0;
							margin += parseFloat(cs.marginBottom || '0') || 0;
						} catch { /* ignore */ }
						return Math.max(0, Math.ceil(h + margin));
					} catch { /* ignore */ }
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					return Math.max(0, Math.ceil(h));
				} catch {
					return 0;
				}
			};

			// IMPORTANT: do NOT include the editor clip container height in "chrome".
			// The clip grows/shrinks with the wrapper height; counting it creates a feedback
			// loop where each click increases height further.
			let chrome = 0;
			try {
				const toolbarEl = wrapper.querySelector ? wrapper.querySelector('.query-editor-toolbar') : null;
				chrome += addVisibleRectHeight(toolbarEl);
			} catch { /* ignore */ }
			try {
				const csw = getComputedStyle(wrapper);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			// Extra elements inside the clip area that also take vertical space (banners, resizer, etc.)
			let clipExtras = 0;
			try {
				const clip = (editorEl && editorEl.closest) ? editorEl.closest('.qe-editor-clip') : null;
				if (clip && clip.children) {
					for (const child of Array.from(clip.children)) {
						if (!child || child === editorEl) continue;
						clipExtras += addVisibleRectHeight(child);
					}
				}
			} catch { /* ignore */ }
			try {
				const clip = (editorEl && editorEl.closest) ? editorEl.closest('.qe-editor-clip') : null;
				if (clip) {
					const csc = getComputedStyle(clip);
					clipExtras += (parseFloat(csc.paddingTop || '0') || 0) + (parseFloat(csc.paddingBottom || '0') || 0);
					clipExtras += (parseFloat(csc.borderTopWidth || '0') || 0) + (parseFloat(csc.borderBottomWidth || '0') || 0);
				}
			} catch { /* ignore */ }

			const desired = Math.max(120, Math.min(20000, Math.ceil(chrome + clipExtras + contentHeight + FIT_SLACK_PX)));
			try {
				wrapper.style.height = desired + 'px';
				wrapper.style.minHeight = '0';
			} catch { /* ignore */ }
			try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			try {
				if (typeof ed.layout === 'function') {
					ed.layout();
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	// Fit the KQL editor height to the exact visible content (no inner scrollbar).
	try {
		applyFitToContent();
		setTimeout(applyFitToContent, 50);
		setTimeout(applyFitToContent, 150);
	} catch { /* ignore */ }

	// Fit results to their visible contents (tables + non-tables).
	// This removes vertical scrollbars (by giving the table container enough height)
	// and removes blank slack above the resize grip.
	const applyResultsFitToContent = () => {
		try {
			const w = document.getElementById(id + '_results_wrapper');
			const resultsEl = document.getElementById(id + '_results');
			if (!w || !resultsEl) return;
			try {
				const csw = getComputedStyle(w);
				if (csw && csw.display === 'none') return;
			} catch { /* ignore */ }
			try {
				const csr = getComputedStyle(resultsEl);
				if (csr && csr.display === 'none') return;
			} catch { /* ignore */ }

			// If results are hidden (toggle is off), collapse the wrapper and skip calculations.
			// This avoids adding extra blank space when the tabular results are toggled off.
			let resultsVisible = true;
			try {
				resultsVisible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[id] === false);
			} catch { /* ignore */ }
			if (!resultsVisible) {
				try {
					w.style.height = 'auto';
					w.style.minHeight = '0';
				} catch { /* ignore */ }
				return;
			}

			// Wrapper chrome: resizer + wrapper padding/borders.
			let chrome = 0;
			try {
				for (const child of Array.from(w.children || [])) {
					if (!child || child === resultsEl) continue;
					try {
						const cs = getComputedStyle(child);
						if (cs && cs.display === 'none') continue;
					} catch { /* ignore */ }
					chrome += (child.getBoundingClientRect ? (child.getBoundingClientRect().height || 0) : 0);
				}
			} catch { /* ignore */ }
			try {
				const csw = getComputedStyle(w);
				chrome += (parseFloat(csw.paddingTop || '0') || 0) + (parseFloat(csw.paddingBottom || '0') || 0);
				chrome += (parseFloat(csw.borderTopWidth || '0') || 0) + (parseFloat(csw.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			// Results content: header + tools/search + table (natural content height).
			let resultsContent = 0;
			let hasTable = false;
			try {
				const csr = getComputedStyle(resultsEl);
				resultsContent += (parseFloat(csr.paddingTop || '0') || 0) + (parseFloat(csr.paddingBottom || '0') || 0);
				resultsContent += (parseFloat(csr.borderTopWidth || '0') || 0) + (parseFloat(csr.borderBottomWidth || '0') || 0);
			} catch { /* ignore */ }

			const addVisibleRectHeight = (el) => {
				try {
					if (!el) return 0;
					try {
						const cs = getComputedStyle(el);
						if (cs && cs.display === 'none') return 0;
						const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
						let margin = 0;
						try {
							margin += parseFloat(cs.marginTop || '0') || 0;
							margin += parseFloat(cs.marginBottom || '0') || 0;
						} catch { /* ignore */ }
						return Math.max(0, Math.ceil(h + margin));
					} catch { /* ignore */ }
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					return Math.max(0, Math.ceil(h));
				} catch {
					return 0;
				}
			};

			const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
			resultsContent += addVisibleRectHeight(headerEl);

			const bodyEl = resultsEl.querySelector ? resultsEl.querySelector('.results-body') : null;
			if (bodyEl) {
				try {
					const csb = getComputedStyle(bodyEl);
					resultsContent += (parseFloat(csb.paddingTop || '0') || 0) + (parseFloat(csb.paddingBottom || '0') || 0);
					resultsContent += (parseFloat(csb.borderTopWidth || '0') || 0) + (parseFloat(csb.borderBottomWidth || '0') || 0);
				} catch { /* ignore */ }

				// Use simple selectors (avoid ':scope' compatibility issues).
				const dataSearch = bodyEl.querySelector ? bodyEl.querySelector('.data-search') : null;
				const colSearch = bodyEl.querySelector ? bodyEl.querySelector('.column-search') : null;
				resultsContent += addVisibleRectHeight(dataSearch);
				resultsContent += addVisibleRectHeight(colSearch);

				const tableContainer = bodyEl.querySelector ? bodyEl.querySelector('.table-container') : null;
				if (tableContainer) {
					hasTable = true;
					let tableH = 0;
					// IMPORTANT: use the table element's natural height. The scroll container's
					// scrollHeight is >= clientHeight, which prevents shrinking when oversized.
					try {
						const tableEl = tableContainer.querySelector ? tableContainer.querySelector('table') : null;
						if (tableEl) {
							const oh = (typeof tableEl.offsetHeight === 'number') ? tableEl.offsetHeight : 0;
							if (oh && Number.isFinite(oh)) tableH = Math.max(tableH, oh);
							const rh = (tableEl.getBoundingClientRect ? (tableEl.getBoundingClientRect().height || 0) : 0);
							if (rh && Number.isFinite(rh)) tableH = Math.max(tableH, rh);
						}
					} catch { /* ignore */ }
					// Fallback: if we can't find the table, use the container's scrollHeight.
					if (!tableH) {
						try {
							const sh = (typeof tableContainer.scrollHeight === 'number') ? tableContainer.scrollHeight : 0;
							if (sh && Number.isFinite(sh)) tableH = Math.max(tableH, sh);
						} catch { /* ignore */ }
					}
					// Last resort: rendered container height.
					if (!tableH) {
						tableH = addVisibleRectHeight(tableContainer);
					}
					resultsContent += Math.max(0, Math.ceil(tableH));
				} else {
					// Non-table results (errors, messages): sum the body's children heights.
					try {
						for (const child of Array.from(bodyEl.children || [])) {
							resultsContent += addVisibleRectHeight(child);
						}
					} catch { /* ignore */ }
				}
			} else {
				// Fallback: approximate by summing visible direct children.
				try {
					for (const child of Array.from(resultsEl.children || [])) {
						resultsContent += addVisibleRectHeight(child);
					}
				} catch { /* ignore */ }
			}

			if (!resultsContent || !Number.isFinite(resultsContent) || resultsContent <= 0) return;

			// Extra padding: tabular results need a touch more so the last row isn't clipped.
			const extraPad = hasTable ? 18 : 8; // +10px compared to previous
			// NOTE: For large tables, "Fit to contents" must not expand to thousands of rows.
			// Keep a reasonable max so the table remains scrollable and virtualization can work.
			const maxDesiredPx = hasTable ? 900 : 200000;
			const desiredPx = Math.max(24, Math.min(maxDesiredPx, Math.ceil(chrome + resultsContent + extraPad)));
			try {
				w.style.height = desiredPx + 'px';
				w.style.minHeight = '0';
			} catch { /* ignore */ }
			try { if (w.dataset) w.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
			try {
				if (typeof window.__kustoClampResultsWrapperHeight === 'function') {
					window.__kustoClampResultsWrapperHeight(id);
				}
			} catch { /* ignore */ }
		} catch { /* ignore */ }
	};

	try {
		applyResultsFitToContent();
		setTimeout(applyResultsFitToContent, 50);
		setTimeout(applyResultsFitToContent, 150);
	} catch { /* ignore */ }

	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoUpdateQueryVisibilityToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_toggle');
	if (!btn) {
		return;
	}
	let expanded = true;
	try {
		expanded = !(window.__kustoQueryExpandedByBoxId && window.__kustoQueryExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', expanded);
	btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
	btn.title = expanded ? 'Hide' : 'Show';
	btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
}

function __kustoApplyQueryBoxVisibility(boxId) {
	const box = document.getElementById(boxId);
	if (!box) {
		return;
	}
	let expanded = true;
	try {
		expanded = !(window.__kustoQueryExpandedByBoxId && window.__kustoQueryExpandedByBoxId[boxId] === false);
	} catch { /* ignore */ }
	try {
		box.classList.toggle('is-collapsed', !expanded);
	} catch { /* ignore */ }
	// Monaco often needs a layout pass after being hidden/shown.
	if (expanded) {
		try {
			setTimeout(() => {
				try {
					const ed = (typeof queryEditors === 'object' && queryEditors) ? queryEditors[boxId] : null;
					if (ed && typeof ed.layout === 'function') {
						ed.layout();
					}
					// Update monaco-kusto schema when the section is shown
					// This ensures the correct schema is loaded for autocomplete
					// Pass false for enableMarkers since the box isn't focused, just visible
					if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
						window.__kustoUpdateSchemaForFocusedBox(boxId, false);
					}
				} catch { /* ignore */ }
			}, 0);
		} catch { /* ignore */ }
	}
}

function toggleQueryBoxVisibility(boxId) {
	try {
		if (!window.__kustoQueryExpandedByBoxId || typeof window.__kustoQueryExpandedByBoxId !== 'object') {
			window.__kustoQueryExpandedByBoxId = {};
		}
		const current = !(window.__kustoQueryExpandedByBoxId[boxId] === false);
		window.__kustoQueryExpandedByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryVisibilityToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyQueryBoxVisibility(boxId); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoSetResultsVisible(boxId, visible) {
	try {
		if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
			window.__kustoResultsVisibleByBoxId = {};
		}
		window.__kustoResultsVisibleByBoxId[boxId] = !!visible;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
}

function __kustoLockCacheForBenchmark(boxId) {
	const msg = 'When doing performance benchmarks we cannot use caching.';
	try {
		const checkbox = document.getElementById(boxId + '_cache_enabled');
		const valueInput = document.getElementById(boxId + '_cache_value');
		const unitSelect = document.getElementById(boxId + '_cache_unit');
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
		try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoNormalizeCellForComparison(cell) {
	const stripNumericGrouping = (s) => {
		try {
			return String(s).trim().replace(/[, _]/g, '');
		} catch {
			return '';
		}
	};
	const isNumericString = (s) => {
		try {
			const t = stripNumericGrouping(s);
			if (!t) return false;
			return /^[+-]?(?:\d+\.?\d*|\d*\.?\d+)(?:[eE][+-]?\d+)?$/.test(t);
		} catch {
			return false;
		}
	};
	const tryParseDateMs = (v) => {
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
	const stableStringify = (obj) => {
		const seen = new Set();
		const walk = (v) => {
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
			const out = {};
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
	const normalize = (v) => {
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

function __kustoRowKeyForComparison(row) {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = r.map(__kustoNormalizeCellForComparison);
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoNormalizeColumnNameForComparison(name) {
	try {
		return String(name == null ? '' : name).trim().toLowerCase();
	} catch {
		return '';
	}
}

function __kustoGetNormalizedColumnNameList(state) {
	try {
		const cols = Array.isArray(state && state.columns) ? state.columns : [];
		return cols.map(__kustoNormalizeColumnNameForComparison);
	} catch {
		return [];
	}
}

function __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState) {
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

function __kustoDoColumnOrderMatch(sourceState, comparisonState) {
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

function __kustoBuildColumnIndexMapForNames(state) {
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

function __kustoBuildNameBasedColumnMapping(state, canonicalNames) {
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

function __kustoRowKeyForComparisonWithColumnMapping(row, mapping) {
	try {
		const r = Array.isArray(row) ? row : [];
		const norm = (mapping || []).map((idx) => __kustoNormalizeCellForComparison(idx >= 0 ? r[idx] : undefined));
		return JSON.stringify(norm);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoRowKeyForComparisonIgnoringColumnOrder(row) {
	try {
		const r = Array.isArray(row) ? row : [];
		const parts = r.map(__kustoNormalizeCellForComparison).map((c) => {
			try { return JSON.stringify(c); } catch { return String(c); }
		});
		parts.sort();
		return JSON.stringify(parts);
	} catch {
		try { return String(row); } catch { return '[uncomparable-row]'; }
	}
}

function __kustoAreResultsEquivalentWithDetails(sourceState, comparisonState) {
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
			rowKeyForA = (row) => __kustoRowKeyForComparisonWithColumnMapping(row, aMap);
			rowKeyForB = (row) => __kustoRowKeyForComparisonWithColumnMapping(row, bMap);
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

function __kustoAreResultsEquivalent(sourceState, comparisonState) {
	try {
		return !!__kustoAreResultsEquivalentWithDetails(sourceState, comparisonState).dataMatches;
	} catch {
		return false;
	}
}

function __kustoDoResultHeadersMatch(sourceState, comparisonState) {
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

function __kustoUpdateAcceptOptimizationsButton(comparisonBoxId, enabled, tooltip) {
	const btn = document.getElementById(comparisonBoxId + '_accept_btn');
	if (!btn) {
		return;
	}
	btn.disabled = !enabled;
	btn.title = tooltip || (enabled ? 'Accept Optimizations' : 'Accept Optimizations is enabled when the optimized query has results.');
	btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

function acceptOptimizations(comparisonBoxId) {
	try {
		const meta = (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) ? optimizationMetadataByBoxId[comparisonBoxId] : null;
		const sourceBoxId = meta && meta.sourceBoxId ? meta.sourceBoxId : '';
		const optimizedQuery = meta && typeof meta.optimizedQuery === 'string' ? meta.optimizedQuery : '';
		if (!sourceBoxId || !optimizedQuery) {
			return;
		}
		if (queryEditors[sourceBoxId] && typeof queryEditors[sourceBoxId].setValue === 'function') {
			queryEditors[sourceBoxId].setValue(optimizedQuery);
			try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		}
		try { __kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, false); } catch { /* ignore */ }
		// Remove comparison box and clear metadata links.
		try { removeQueryBox(comparisonBoxId); } catch { /* ignore */ }
		try {
			if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
				delete optimizationMetadataByBoxId[comparisonBoxId];
				if (optimizationMetadataByBoxId[sourceBoxId]) {
					delete optimizationMetadataByBoxId[sourceBoxId];
				}
			}
		} catch { /* ignore */ }
		try { vscode.postMessage({ type: 'showInfo', message: 'Optimizations accepted: source query updated.' }); } catch { /* ignore */ }
	} catch {
		// ignore
	}
}

function __kustoUpdateQueryResultsToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_results_toggle');
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide results' : 'Show results';
	btn.setAttribute('aria-label', visible ? 'Hide results' : 'Show results');
}

function __kustoUpdateComparisonSummaryToggleButton(boxId) {
	const btn = document.getElementById(boxId + '_summary_toggle');
	if (!btn) {
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoComparisonSummaryVisibleByBoxId && window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide comparison summary' : 'Show comparison summary';
	btn.setAttribute('aria-label', visible ? 'Hide comparison summary' : 'Show comparison summary');
}

function __kustoApplyResultsVisibility(boxId) {
	const wrapper = document.getElementById(boxId + '_results_wrapper');
	if (!wrapper) {
		// Support non-query-box results (e.g. URL CSV preview) that render a results block
		// without the surrounding *_results_wrapper.
		let visible = true;
		try {
			visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
		} catch { /* ignore */ }
		try {
			const body = document.getElementById(boxId + '_results_body');
			if (body) {
				body.style.display = visible ? '' : 'none';
			}
		} catch { /* ignore */ }
		try {
			const resultsDiv = document.getElementById(boxId + '_results');
			if (resultsDiv && resultsDiv.classList) {
				resultsDiv.classList.toggle('is-results-hidden', !visible);
			}
		} catch { /* ignore */ }
		try {
			if (typeof __kustoSetResultsToolsVisible === 'function') {
				__kustoSetResultsToolsVisible(boxId, visible);
			}
			if (!visible && typeof __kustoHideResultsTools === 'function') {
				__kustoHideResultsTools(boxId);
			}
		} catch { /* ignore */ }
		// URL (table results): preserve the outer URL section height when hiding/showing results.
		// Height changes should only happen via explicit user resize or explicit "Fit to contents".
		try {
			const urlWrapper = document.getElementById(boxId + '_wrapper');
			const urlContent = document.getElementById(boxId + '_content');
			let hasTable = false;
			try {
				hasTable = !!(urlContent && urlContent.querySelector && urlContent.querySelector('.table-container'));
			} catch { /* ignore */ }
			if (urlWrapper && urlContent && hasTable) {
				// If the user explicitly resized the URL section, remember that height and restore it
				// when results are shown again.
				const userResized = !!(urlWrapper.dataset && urlWrapper.dataset.kustoUserResized === 'true');
				if (!visible) {
					try {
						if (userResized) {
							const inlineHeight = (urlWrapper.style && typeof urlWrapper.style.height === 'string')
								? urlWrapper.style.height.trim()
								: '';
							if (inlineHeight && inlineHeight !== 'auto') {
								urlWrapper.dataset.kustoPrevHeight = inlineHeight;
							} else {
								// Best-effort: capture the rendered height.
								urlWrapper.dataset.kustoPrevHeight = Math.max(0, Math.ceil(urlWrapper.getBoundingClientRect().height)) + 'px';
							}
						}
					} catch { /* ignore */ }
				} else {
					// Showing results: restore prior user height if present. Otherwise keep as-is.
					try {
						if (userResized) {
							const prev = (urlWrapper.dataset && urlWrapper.dataset.kustoPrevHeight) ? String(urlWrapper.dataset.kustoPrevHeight) : '';
							if (prev && prev !== 'auto') {
								urlWrapper.style.height = prev;
							}
						}
					} catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }
		return;
	}
	let visible = true;
	try {
		visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	// Only show wrapper when there's content.
	const resultsDiv = document.getElementById(boxId + '_results');
	const hasContent = !!(resultsDiv && String(resultsDiv.innerHTML || '').trim());
	let hasTable = false;
	try {
		hasTable = !!(resultsDiv && resultsDiv.querySelector && resultsDiv.querySelector('.table-container'));
	} catch { /* ignore */ }
	wrapper.style.display = hasContent ? 'flex' : 'none';
	if (hasContent) {
		const body = document.getElementById(boxId + '_results_body');
		if (body) {
			body.style.display = visible ? '' : 'none';
		}
		try {
			if (typeof __kustoSetResultsToolsVisible === 'function') {
				__kustoSetResultsToolsVisible(boxId, visible);
			}
			if (!visible && typeof __kustoHideResultsTools === 'function') {
				__kustoHideResultsTools(boxId);
			}
		} catch { /* ignore */ }
		const resizer = document.getElementById(boxId + '_results_resizer');
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

function __kustoApplyComparisonSummaryVisibility(boxId) {
	const box = document.getElementById(boxId);
	if (!box) {
		return;
	}
	const banner = box.querySelector('.comparison-summary-banner');
	if (!banner) {
		return;
	}
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].isComparison) {
			banner.style.display = '';
			return;
		}
	} catch { /* ignore */ }
	let visible = true;
	try {
		visible = !(window.__kustoComparisonSummaryVisibleByBoxId && window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
	} catch { /* ignore */ }
	banner.style.display = visible ? '' : 'none';
}

function toggleQueryResultsVisibility(boxId) {
	try {
		if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
			window.__kustoResultsVisibleByBoxId = {};
		}
		const current = !(window.__kustoResultsVisibleByBoxId[boxId] === false);
		window.__kustoResultsVisibleByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(boxId); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function toggleComparisonSummaryVisibility(boxId) {
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].isComparison) {
			// Optimized sections always show summary.
			return;
		}
	} catch { /* ignore */ }
	try {
		if (!window.__kustoComparisonSummaryVisibleByBoxId || typeof window.__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			window.__kustoComparisonSummaryVisibleByBoxId = {};
		}
		const current = !(window.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
		window.__kustoComparisonSummaryVisibleByBoxId[boxId] = !current;
	} catch { /* ignore */ }
	try { __kustoUpdateComparisonSummaryToggleButton(boxId); } catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(boxId); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureCacheBackupMap() {
	if (!window.__kustoCacheBackupByBoxId || typeof window.__kustoCacheBackupByBoxId !== 'object') {
		window.__kustoCacheBackupByBoxId = {};
	}
	return window.__kustoCacheBackupByBoxId;
}

function __kustoBackupCacheSettings(boxId) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	if (map[boxId]) {
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled');
		const valueEl = document.getElementById(boxId + '_cache_value');
		const unitEl = document.getElementById(boxId + '_cache_unit');
		map[boxId] = {
			enabled: enabledEl ? !!enabledEl.checked : true,
			value: valueEl ? (parseInt(valueEl.value) || 1) : 1,
			unit: unitEl ? String(unitEl.value || 'days') : 'days'
		};
	} catch {
		// ignore
	}
}

function __kustoRestoreCacheSettings(boxId) {
	if (!boxId) {
		return;
	}
	const map = __kustoEnsureCacheBackupMap();
	const backup = map[boxId];
	if (!backup) {
		// Ensure controls are re-enabled if we had disabled them.
		try {
			const enabledEl = document.getElementById(boxId + '_cache_enabled');
			const valueEl = document.getElementById(boxId + '_cache_value');
			const unitEl = document.getElementById(boxId + '_cache_unit');
			if (enabledEl) { enabledEl.disabled = false; enabledEl.title = ''; }
			if (valueEl) { valueEl.disabled = false; valueEl.title = ''; }
			if (unitEl) { unitEl.disabled = false; unitEl.title = ''; }
			try { toggleCacheControls(boxId); } catch { /* ignore */ }
		} catch { /* ignore */ }
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled');
		const valueEl = document.getElementById(boxId + '_cache_value');
		const unitEl = document.getElementById(boxId + '_cache_unit');
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function __kustoEnsureRunModeBackupMap() {
	if (!window.__kustoRunModeBackupByBoxId || typeof window.__kustoRunModeBackupByBoxId !== 'object') {
		window.__kustoRunModeBackupByBoxId = {};
	}
	return window.__kustoRunModeBackupByBoxId;
}

function __kustoBackupRunMode(boxId) {
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

function __kustoRestoreRunMode(boxId) {
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

function __kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, active) {
	const ids = [String(sourceBoxId || '').trim(), String(comparisonBoxId || '').trim()].filter(Boolean);
	for (const id of ids) {
		const el = document.getElementById(id);
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
	for (const boxId of queryBoxes) {
		const btn = document.getElementById(boxId + '_caret_docs_toggle');
		if (!btn) {
			continue;
		}
		btn.setAttribute('aria-pressed', caretDocsEnabled ? 'true' : 'false');
		btn.classList.toggle('is-active', !!caretDocsEnabled);
	}
}

function toggleCaretDocsEnabled() {
	caretDocsEnabled = !caretDocsEnabled;
	updateCaretDocsToggleButtons();
	// Hide existing overlays immediately when turning off.
	if (!caretDocsEnabled) {
		try {
			for (const key of Object.keys(caretDocOverlaysByBoxId || {})) {
				const overlay = caretDocOverlaysByBoxId[key];
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
			for (const boxId of queryBoxes) {
				try {
					const banner = document.getElementById(boxId + '_caret_docs');
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
			const overlays = (typeof caretDocOverlaysByBoxId !== 'undefined') ? caretDocOverlaysByBoxId : null;
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
		vscode.postMessage({ type: 'setCaretDocsEnabled', enabled: !!caretDocsEnabled });
	} catch {
		// ignore
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function onQueryEditorToolbarAction(boxId, action) {
	// Focus the editor so Monaco widgets (find/replace) attach correctly.
	try {
		activeQueryEditorBoxId = boxId;
		if (queryEditors[boxId]) {
			queryEditors[boxId].focus();
		}
	} catch {
		// ignore
	}

	if (action === 'search') {
		return runMonacoAction(boxId, 'actions.find');
	}
	if (action === 'replace') {
		return runMonacoAction(boxId, 'editor.action.startFindReplaceAction');
	}
	if (action === 'prettify') {
		try {
			if (typeof window.__kustoPrettifyQueryForBoxId === 'function') {
				window.__kustoPrettifyQueryForBoxId(boxId);
				return;
			}
		} catch { /* ignore */ }
		// Fallback: at least run the basic formatter.
		return runMonacoAction(boxId, 'editor.action.formatDocument');
	}
	if (action === 'singleLine') {
		try {
			if (typeof window.__kustoCopySingleLineQueryForBoxId === 'function') {
				window.__kustoCopySingleLineQueryForBoxId(boxId);
				return;
			}
		} catch { /* ignore */ }
		return;
	}
	if (action === 'autocomplete') {
		try {
			if (typeof window.__kustoTriggerAutocompleteForBoxId === 'function') {
				window.__kustoTriggerAutocompleteForBoxId(boxId);
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
			if (qualifyTablesInFlightByBoxId && qualifyTablesInFlightByBoxId[boxId]) {
				return;
			}
		} catch { /* ignore */ }
		try { qualifyTablesInFlightByBoxId[boxId] = true; } catch { /* ignore */ }
		try { setToolbarActionBusy(boxId, 'qualifyTables', true); } catch { /* ignore */ }
		(async () => {
			try {
				await fullyQualifyTablesInEditor(boxId);
			} finally {
				try { qualifyTablesInFlightByBoxId[boxId] = false; } catch { /* ignore */ }
				try { setToolbarActionBusy(boxId, 'qualifyTables', false); } catch { /* ignore */ }
			}
		})();
		return;
	}
}

function copyQueryAsAdeLink(boxId) {
	const __kustoExtractStatementAtCursor = (editor) => {
		try {
			if (typeof window.__kustoExtractStatementTextAtCursor === 'function') {
				return window.__kustoExtractStatementTextAtCursor(editor);
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
			const blocks = [];
			let inBlock = false;
			let startLine = 1;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
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

			const block = blocks.find(b => cursorLine >= b.startLine && cursorLine <= b.endLine);
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

	const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	// If the cursor is inside the active Monaco editor, use only the statement under the cursor.
	try {
		const isActiveEditor = (typeof activeQueryEditorBoxId !== 'undefined') && (activeQueryEditorBoxId === boxId);
		const hasTextFocus = !!(editor && typeof editor.hasTextFocus === 'function' && editor.hasTextFocus());
		if (editor && (hasTextFocus || isActiveEditor)) {
			const statement = __kustoExtractStatementAtCursor(editor);
			if (statement) {
				query = statement;
			} else {
				try {
					vscode.postMessage({
						type: 'showInfo',
						message: 'Place the cursor inside a query statement (not on a separator) to copy a Data Explorer link for that statement.'
					});
				} catch { /* ignore */ }
				return;
			}
		}
	} catch { /* ignore */ }

	let connectionId = '';
	let database = '';
	try {
		connectionId = String((document.getElementById(boxId + '_connection') || {}).value || '');
		database = String((document.getElementById(boxId + '_database') || {}).value || '');
	} catch { /* ignore */ }

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = String(meta.sourceBoxId || '');
				const sourceConn = document.getElementById(sourceBoxId + '_connection');
				const sourceDb = document.getElementById(sourceBoxId + '_database');
				if (sourceConn && sourceConn.value) {
					connectionId = sourceConn.value;
				}
				if (sourceDb && sourceDb.value) {
					database = sourceDb.value;
				}
			}
		}
	} catch { /* ignore */ }

	if (!String(query || '').trim()) {
		try { vscode.postMessage({ type: 'showInfo', message: 'There is no query text to share.' }); } catch { /* ignore */ }
		return;
	}
	if (!String(connectionId || '').trim()) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Select a cluster connection first.' }); } catch { /* ignore */ }
		return;
	}
	if (!String(database || '').trim()) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Select a database first.' }); } catch { /* ignore */ }
		return;
	}

	try {
		vscode.postMessage({
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

function setToolbarActionBusy(boxId, action, busy) {
	try {
		const root = document.getElementById(boxId);
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
			const toolsBtn = document.getElementById(boxId + '_tools_btn');
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

function closeToolsDropdown(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		if (window.__kustoDropdown && typeof window.__kustoDropdown.closeMenuDropdown === 'function') {
			window.__kustoDropdown.closeMenuDropdown(id + '_tools_btn', id + '_tools_menu');
			return;
		}
	} catch { /* ignore */ }
	try {
		const menu = document.getElementById(id + '_tools_menu');
		if (menu) menu.style.display = 'none';
	} catch { /* ignore */ }
	try {
		const btn = document.getElementById(id + '_tools_btn');
		if (btn) {
			btn.setAttribute('aria-expanded', 'false');
			try { btn.classList && btn.classList.remove('is-active'); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
}

// --- Toolbar overflow handling ---
// Track ResizeObservers per toolbar
const __kustoToolbarResizeObservers = {};
// Track ResizeObservers for run button responsiveness
const __kustoRunBtnResizeObservers = {};

/**
 * Initialize toolbar overflow detection for a query box.
 * Uses ResizeObserver to detect when buttons overflow and shows a "..." menu.
 */
function initToolbarOverflow(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar');
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
function initRunButtonResponsive(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const queryBox = document.getElementById(id);
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
function updateRunButtonResponsive(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn');
	if (!runBtn) return;

	// Get the query box width
	const queryBox = document.getElementById(id);
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
function updateToolbarOverflow(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar');
	const itemsContainer = toolbar && toolbar.querySelector('.qe-toolbar-items');
	const overflowWrapper = document.getElementById(id + '_toolbar_overflow_wrapper');
	if (!toolbar || !itemsContainer || !overflowWrapper) return;

	// Get all toolbar items (buttons, separators, wrappers)
	const items = Array.from(itemsContainer.children);
	if (!items.length) return;

	// First, make all items visible to measure properly
	items.forEach(item => item.classList.remove('qe-in-overflow'));
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
function toggleToolbarOverflow(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_toolbar_overflow_menu');
	const btn = document.getElementById(id + '_toolbar_overflow_btn');
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
		try { window.__kustoDropdown && window.__kustoDropdown.wireMenuInteractions && window.__kustoDropdown.wireMenuInteractions(menu); } catch { /* ignore */ }
	}
}

/**
 * Close the toolbar overflow menu
 */
function closeToolbarOverflow(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_toolbar_overflow_menu');
	const btn = document.getElementById(id + '_toolbar_overflow_btn');
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
	document.querySelectorAll('.qe-toolbar-overflow-menu').forEach(menu => {
		menu.style.display = 'none';
	});
	document.querySelectorAll('.qe-toolbar-overflow-btn').forEach(btn => {
		btn.setAttribute('aria-expanded', 'false');
		btn.classList.remove('is-active');
	});
}

/**
 * Render the overflow menu items based on which buttons are hidden
 */
function renderToolbarOverflowMenu(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const toolbar = document.getElementById(id + '_toolbar');
	const menu = document.getElementById(id + '_toolbar_overflow_menu');
	if (!toolbar || !menu) return;

	const itemsContainer = toolbar.querySelector('.qe-toolbar-items');
	if (!itemsContainer) return;

	// Find all hidden items (those with qe-in-overflow class)
	const hiddenItems = Array.from(itemsContainer.querySelectorAll('.qe-in-overflow'));
	if (!hiddenItems.length) {
		menu.innerHTML = '<div class="qe-toolbar-overflow-item" style="opacity:0.6;cursor:default;">No additional actions</div>';
		return;
	}

	let menuHtml = '';
	let prevWasSep = false;

	hiddenItems.forEach(item => {
		if (item.classList.contains('query-editor-toolbar-sep')) {
			// Add separator in menu (but avoid consecutive separators)
			if (!prevWasSep && menuHtml) {
				menuHtml += '<div class="qe-toolbar-overflow-sep"></div>';
				prevWasSep = true;
			}
			return;
		}
		prevWasSep = false;

		// Handle the tools dropdown specially
		if (item.classList.contains('qe-toolbar-menu-wrapper')) {
			menuHtml += '<div class="qe-toolbar-overflow-item" role="menuitem" tabindex="-1" onclick="closeToolbarOverflow(\'' + id + '\'); toggleToolsDropdown(\'' + id + '\');">' +
				'<span class="qe-icon" aria-hidden="true"><span class="codicon codicon-tools"></span></span>' +
				'<span class="qe-toolbar-overflow-label">Tools</span>' +
				'</div>';
			return;
		}

		// Get action and label from data attributes or title
		const action = item.getAttribute('data-qe-overflow-action') || '';
		const label = item.getAttribute('data-qe-overflow-label') || item.getAttribute('title') || action;
		const iconHtml = item.querySelector('.qe-icon') ? item.querySelector('.qe-icon').innerHTML : '';
		const isDisabled = item.disabled || item.getAttribute('aria-disabled') === 'true';

		if (action && label) {
			const disabledAttr = isDisabled ? ' style="opacity:0.5;cursor:default;" aria-disabled="true"' : '';
			let onclick = '';
			if (!isDisabled) {
				if (action === 'caretDocs') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); toggleCaretDocsEnabled();';
				} else if (action === 'copilotChat') {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); __kustoToggleCopilotChatForBox(\'' + id + '\');';
				} else {
					onclick = 'closeToolbarOverflow(\'' + id + '\'); onQueryEditorToolbarAction(\'' + id + '\', \'' + action + '\');';
				}
			}
			menuHtml += '<div class="qe-toolbar-overflow-item" role="menuitem" tabindex="-1"' + disabledAttr + ' onclick="' + onclick + '">' +
				'<span class="qe-icon" aria-hidden="true">' + iconHtml + '</span>' +
				'<span class="qe-toolbar-overflow-label">' + label + '</span>' +
				'</div>';
		}
	});

	// Remove trailing separator if any
	menuHtml = menuHtml.replace(/<div class="qe-toolbar-overflow-sep"><\/div>$/, '');

	menu.innerHTML = menuHtml || '<div class="qe-toolbar-overflow-item" style="opacity:0.6;cursor:default;">No additional actions</div>';
}

function toggleToolsDropdown(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_tools_menu');
	const btn = document.getElementById(id + '_tools_btn');
	if (!menu || !btn) return;

	try {
		if (window.__kustoDropdown && typeof window.__kustoDropdown.toggleMenuDropdown === 'function') {
			window.__kustoDropdown.toggleMenuDropdown({
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
		try { window.__kustoDropdown && window.__kustoDropdown.wireMenuInteractions && window.__kustoDropdown.wireMenuInteractions(menu); } catch { /* ignore */ }
		try { menu.focus(); } catch { /* ignore */ }
	}
}

function renderToolsMenuForBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const menu = document.getElementById(id + '_tools_menu');
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

	const toolsItemHtml = (iconSvg, labelText) => {
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
		if (window.__kustoDropdown && typeof window.__kustoDropdown.renderMenuItemsHtml === 'function') {
			menu.innerHTML = window.__kustoDropdown.renderMenuItemsHtml(items, {
				dropdownId: id + '_tools',
				onSelectJs: (keyEnc) => {
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

function runMonacoAction(boxId, actionId) {
	const editor = queryEditors[boxId];
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

function replaceAllInEditor(boxId, from, to) {
	const editor = queryEditors[boxId];
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

async function exportQueryToPowerBI(boxId) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	let query = model.getValue() || '';
	// Match the same "active statement" logic used by Run Query.
	try {
		const isActiveEditor = (typeof activeQueryEditorBoxId !== 'undefined') && (activeQueryEditorBoxId === boxId);
		const hasTextFocus = !!(editor && typeof editor.hasTextFocus === 'function' && editor.hasTextFocus());
		if (editor && (hasTextFocus || isActiveEditor)) {
			const statement = (typeof window.__kustoExtractStatementTextAtCursor === 'function')
				? window.__kustoExtractStatementTextAtCursor(editor)
				: null;
			if (statement) {
				query = statement;
			} else {
				try {
					vscode.postMessage({
						type: 'showInfo',
						message: 'Place the cursor inside a query statement (not on a separator) to export that statement to Power BI.'
					});
				} catch { /* ignore */ }
				return;
			}
		}
	} catch { /* ignore */ }
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	const conn = (connections || []).find(c => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch { /* ignore */ }
		return;
	}

	const lines = (query || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const escapeMString = (s) => String(s).replace(/"/g, '""');
	const quotedLines = lines.map(l => '        "' + escapeMString(l) + '"');
	const m =
		'let\n' +
		'    Query = Text.Combine({\n' +
		quotedLines.join(',\n') +
		'\n    }, "#(lf)"),\n' +
		'    Source = AzureDataExplorer.Contents("' + escapeMString(clusterUrl) + '", "' + escapeMString(database) + '", Query)\n' +
		'in\n' +
		'    Source';

	// Write to clipboard instead of changing the editor contents.
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			await navigator.clipboard.writeText(m);
			try {
				vscode.postMessage({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
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
			vscode.postMessage({ type: 'showInfo', message: 'Power BI query copied to clipboard. Paste it into Power BI.' });
		} catch {
			// ignore
		}
	} catch {
		try { vscode.postMessage({ type: 'showInfo', message: 'Failed to copy Power BI query to clipboard.' }); } catch { /* ignore */ }
	}
}

function displayComparisonSummary(sourceBoxId, comparisonBoxId) {
	const sourceState = __kustoGetResultsState(sourceBoxId);
	const comparisonState = __kustoGetResultsState(comparisonBoxId);
	
	if (!sourceState || !comparisonState) {
		return;
	}

	const escapeHtml = (s) => {
		return String(s ?? '')
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;')
			.replace(/'/g, '&#39;');
	};
	const getBoxLabel = (boxId) => {
		try {
			const el = document.getElementById(String(boxId || '') + '_name');
			const name = el ? String(el.value || '').trim() : '';
			return name || String(boxId || '').trim() || 'Dataset';
		} catch {
			return String(boxId || '').trim() || 'Dataset';
		}
	};
	const sourceLabel = getBoxLabel(sourceBoxId);
	const comparisonLabel = getBoxLabel(comparisonBoxId);
	const pluralRows = (n) => (Number(n) === 1 ? 'row' : 'rows');
	
	const sourceRows = sourceState.rows ? sourceState.rows.length : 0;
	const comparisonRows = comparisonState.rows ? comparisonState.rows.length : 0;
	const sourceCols = sourceState.columns ? sourceState.columns.length : 0;
	const comparisonCols = comparisonState.columns ? comparisonState.columns.length : 0;
	
	// Extract execution times
	const sourceExecTime = sourceState.metadata && sourceState.metadata.executionTime || '';
	const comparisonExecTime = comparisonState.metadata && comparisonState.metadata.executionTime || '';
	
	// Parse execution times (e.g., "123ms" or "1.23s")
	const parseExecTime = (timeStr) => {
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
			perfMessage = `<span style="color: #f48771;">\u26a0 ${Math.abs(percentChange)}% slower (${sourceExecTime} \u2192 ${comparisonExecTime})</span>`;
		} else {
			perfMessage = `<span style="color: #cccccc;">\u2248 Same performance (${sourceExecTime})</span>`;
		}
	} else if (sourceExecTime && comparisonExecTime) {
		perfMessage = `<span style="color: #cccccc;">${sourceExecTime} \u2192 ${comparisonExecTime}</span>`;
	}
	
	// Check data consistency
	const details = __kustoAreResultsEquivalentWithDetails(sourceState, comparisonState);
	const dataMatches = !!(details && details.dataMatches);
	const rowOrderMatches = !!(details && details.rowOrderMatches);
	const columnOrderMatches = !!(details && details.columnOrderMatches);
	const columnHeaderNamesMatch = !!(details && details.columnHeaderNamesMatch);
	const warningNeeded = dataMatches && !(rowOrderMatches && columnOrderMatches && columnHeaderNamesMatch);
	const diffReason = (details && typeof details.reason === 'string' && details.reason) ? details.reason : '';
	const diffReasonParts = [];
	try {
		if (diffReason) diffReasonParts.push('Reason: ' + diffReason);
		if (details && typeof details.columnCountA === 'number' && typeof details.columnCountB === 'number') {
			diffReasonParts.push('Columns: ' + String(details.columnCountA) + ' vs ' + String(details.columnCountB));
		}
		if (details && typeof details.rowCountA === 'number' && typeof details.rowCountB === 'number') {
			diffReasonParts.push('Rows: ' + String(details.rowCountA) + ' vs ' + String(details.rowCountB));
		}
		if (details && typeof details.firstMismatchedRowKey === 'string' && details.firstMismatchedRowKey) {
			diffReasonParts.push('Key: ' + details.firstMismatchedRowKey);
		}
	} catch { /* ignore */ }
	const diffTitle = diffReasonParts.length ? ('View diff\n' + diffReasonParts.join('\n')) : 'View diff';

	const yesNo = (v) => (v ? 'yes' : 'no');
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
		let countsLabel = '';
		try {
			const dv = (window && window.__kustoDiffView) ? window.__kustoDiffView : null;
			if (dv && typeof dv.buildModelFromResultsStates === 'function') {
				const model = dv.buildModelFromResultsStates(sourceState, comparisonState, { aLabel: sourceLabel, bLabel: comparisonLabel });
				const p = (model && model.partitions && typeof model.partitions === 'object') ? model.partitions : null;
				const commonCount = Array.isArray(p && p.common) ? p.common.length : 0;
				const onlyACount = Array.isArray(p && p.onlyA) ? p.onlyA.length : 0;
				const onlyBCount = Array.isArray(p && p.onlyB) ? p.onlyB.length : 0;
				countsLabel =
					' (' +
					String(commonCount) + ' matching ' + pluralRows(commonCount) +
					', ' +
					String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + escapeHtml(sourceLabel) +
					', ' +
					String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + escapeHtml(comparisonLabel) +
					')';
			}
		} catch { /* ignore */ }

		// Use JSON.stringify to produce a valid JS string literal (double-quoted) so the
		// inline onclick handler never breaks due to escaping.
		const aBoxIdLit = JSON.stringify(String(sourceBoxId || ''));
		const bBoxIdLit = JSON.stringify(String(comparisonBoxId || ''));
		dataMessage =
			'<span class="comparison-data-diff-icon" aria-hidden="true">\u26a0</span> ' +
			'<a href="#" class="comparison-data-diff comparison-diff-link" ' +
			"onclick='try{openDiffViewModal({ aBoxId: " + aBoxIdLit + ", bBoxId: " + bBoxIdLit + " })}catch{}; return false;' " +
			'title="' + diffTitle.replace(/"/g, '&quot;') + '">Data differs' + countsLabel + '</a>';
	}
	
	// Create or update comparison summary banner
	const comparisonBox = document.getElementById(comparisonBoxId);
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
		vscode.postMessage({
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
		if (!window.__kustoOptimizePrepByBoxId || typeof window.__kustoOptimizePrepByBoxId !== 'object') {
			window.__kustoOptimizePrepByBoxId = {};
		}
		return window.__kustoOptimizePrepByBoxId;
	} catch {
		return {};
	}
}

function __kustoHideOptimizePromptForBox(boxId) {
	const host = document.getElementById(boxId + '_optimize_config');
	if (host) {
		host.style.display = 'none';
		host.innerHTML = '';
	}
	try {
		const pending = __kustoEnsureOptimizePrepByBoxId();
		delete pending[boxId];
	} catch { /* ignore */ }

	try {
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
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
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

function __kustoSetOptimizeInProgress(boxId, inProgress, statusText) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status');
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel');
		const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
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

function __kustoUpdateOptimizeStatus(boxId, statusText) {
	try {
		const statusEl = document.getElementById(boxId + '_optimize_status');
		if (!statusEl) return;
		statusEl.textContent = String(statusText || '');
	} catch { /* ignore */ }
}

function __kustoCancelOptimizeQuery(boxId) {
	try {
		__kustoUpdateOptimizeStatus(boxId, 'Canceling…');
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel');
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch { /* ignore */ }
	try {
		vscode.postMessage({
			type: 'cancelOptimizeQuery',
			boxId: String(boxId || '')
		});
	} catch { /* ignore */ }
}

function __kustoShowOptimizePromptLoading(boxId) {
	const host = document.getElementById(boxId + '_optimize_config');
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
		const state = (typeof vscode !== 'undefined' && vscode && vscode.getState) ? (vscode.getState() || {}) : {};
		if (state && state.lastOptimizeModelId) {
			return String(state.lastOptimizeModelId);
		}
	} catch { /* ignore */ }
	try {
		return String(localStorage.getItem(__kustoOptimizeModelStorageKey) || '');
	} catch { /* ignore */ }
	return '';
}

function __kustoSetLastOptimizeModelId(modelId) {
	const id = String(modelId || '');
	try {
		const state = (typeof vscode !== 'undefined' && vscode && vscode.getState) ? (vscode.getState() || {}) : {};
		state.lastOptimizeModelId = id;
		if (typeof vscode !== 'undefined' && vscode && vscode.setState) {
			vscode.setState(state);
		}
	} catch { /* ignore */ }
	try {
		if (id) {
			localStorage.setItem(__kustoOptimizeModelStorageKey, id);
		}
	} catch { /* ignore */ }
}

function __kustoApplyOptimizeQueryOptions(boxId, models, selectedModelId, promptText) {
	const host = document.getElementById(boxId + '_optimize_config');
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

	const selectEl = document.getElementById(boxId + '_optimize_model');
	if (selectEl) {
		selectEl.innerHTML = '';
		for (const m of safeModels) {
			if (!m || !m.id) {
				continue;
			}
			const opt = document.createElement('option');
			opt.value = String(m.id);
			opt.textContent = String(m.label || m.id);
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

	const promptEl = document.getElementById(boxId + '_optimize_prompt');
	if (promptEl) {
		promptEl.value = String(promptText || '');
	}
}

function __kustoRunOptimizeQueryWithOverrides(boxId) {
	const pending = __kustoEnsureOptimizePrepByBoxId();
	const req = pending[boxId];
	if (!req) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Optimization request is no longer available. Please try again.' }); } catch { /* ignore */ }
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}

	// Optimization naming rule:
	// - If the source section has no name, assign the next available letter (A, B, C, ...)
	// - The optimized section will then use "<source name> (optimized)"
	try {
		const nameEl = document.getElementById(boxId + '_name');
		if (nameEl) {
			let sourceName = String(nameEl.value || '').trim();
			if (!sourceName && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
				sourceName = window.__kustoPickNextAvailableSectionLetterName(boxId);
				nameEl.value = sourceName;
				try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
			}
			if (sourceName) {
				req.queryName = sourceName;
			}
		}
	} catch { /* ignore */ }

	const modelId = (document.getElementById(boxId + '_optimize_model') || {}).value || '';
	const promptText = (document.getElementById(boxId + '_optimize_prompt') || {}).value || '';
	try {
		__kustoSetLastOptimizeModelId(modelId);
	} catch { /* ignore */ }

	// Close prompt UI and show spinner on the main optimize button
	try {
		const host = document.getElementById(boxId + '_optimize_config');
		if (host) {
			host.style.display = 'none';
			host.innerHTML = '';
		}
	} catch { /* ignore */ }

	const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
	if (optimizeBtn) {
		optimizeBtn.disabled = true;
		const originalContent = optimizeBtn.innerHTML;
		optimizeBtn.dataset.originalContent = originalContent;
	}
	try {
		__kustoSetOptimizeInProgress(boxId, true, 'Starting optimization…');
	} catch { /* ignore */ }

	try {
		vscode.postMessage({
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
	} catch (err) {
		console.error('Error sending optimization request:', err);
		try { vscode.postMessage({ type: 'showInfo', message: 'Failed to start query optimization' }); } catch { /* ignore */ }
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

async function optimizeQueryWithCopilot(boxId, comparisonQueryOverride, options) {
	const editor = queryEditors[boxId];
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
		try { vscode.postMessage({ type: 'showInfo', message: 'No query to compare' }); } catch { /* ignore */ }
		return '';
	}
	const overrideText = (typeof comparisonQueryOverride === 'string') ? String(comparisonQueryOverride || '') : '';
	if (comparisonQueryOverride != null && !overrideText.trim()) {
		try { vscode.postMessage({ type: 'showInfo', message: 'No comparison query provided' }); } catch { /* ignore */ }
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
			const nameInput = document.getElementById(boxId + '_name');
			sourceNameForOptimize = nameInput ? String(nameInput.value || '').trim() : '';
			if (!sourceNameForOptimize && typeof window.__kustoPickNextAvailableSectionLetterName === 'function') {
				sourceNameForOptimize = window.__kustoPickNextAvailableSectionLetterName(boxId);
				if (nameInput) {
					nameInput.value = sourceNameForOptimize;
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				}
			}
			if (sourceNameForOptimize) {
				desiredOptimizedName = sourceNameForOptimize + ' (optimized)';
			}
		} catch { /* ignore */ }
	}
	
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return '';
	}
	if (!database) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return '';
	}

	// If a comparison already exists for this source, reuse it.
	try {
		const existingComparisonBoxId = (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId])
			? optimizationMetadataByBoxId[boxId].comparisonBoxId
			: '';
		if (existingComparisonBoxId) {
			const comparisonBoxEl = document.getElementById(existingComparisonBoxId);
			const comparisonEditor = queryEditors && queryEditors[existingComparisonBoxId];
			if (comparisonBoxEl && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
				let nextComparisonQuery = overrideText.trim() ? overrideText : query;
				try {
					if (typeof window.__kustoPrettifyKustoText === 'function') {
						nextComparisonQuery = window.__kustoPrettifyKustoText(nextComparisonQuery);
					}
				} catch { /* ignore */ }
				try { comparisonEditor.setValue(nextComparisonQuery); } catch { /* ignore */ }
				try {
					if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
						optimizationMetadataByBoxId[existingComparisonBoxId] = optimizationMetadataByBoxId[existingComparisonBoxId] || {};
						optimizationMetadataByBoxId[existingComparisonBoxId].sourceBoxId = boxId;
						optimizationMetadataByBoxId[existingComparisonBoxId].isComparison = true;
						optimizationMetadataByBoxId[existingComparisonBoxId].originalQuery = queryEditors[boxId] ? queryEditors[boxId].getValue() : query;
						optimizationMetadataByBoxId[existingComparisonBoxId].optimizedQuery = nextComparisonQuery;
						optimizationMetadataByBoxId[boxId] = optimizationMetadataByBoxId[boxId] || {};
						optimizationMetadataByBoxId[boxId].comparisonBoxId = existingComparisonBoxId;
					}
				} catch { /* ignore */ }
				try {
					if (typeof __kustoSetLinkedOptimizationMode === 'function') {
						__kustoSetLinkedOptimizationMode(boxId, existingComparisonBoxId, true);
					}
				} catch { /* ignore */ }
				// Set the comparison box name.
				try {
					const nameEl = document.getElementById(existingComparisonBoxId + '_name');
					if (nameEl) {
						if (desiredOptimizedName) {
							nameEl.value = desiredOptimizedName;
							try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
						} else {
							// If the comparison box name is missing (or still using the legacy suffix naming),
							// set it to the next available letter.
							const currentName = String(nameEl.value || '').trim();
							let shouldReplace = !currentName;
							if (!shouldReplace) {
								const upper = currentName.toUpperCase();
								if (upper.endsWith(' (COMPARISON)') || upper.endsWith(' (OPTIMIZED)')) {
									shouldReplace = true;
								}
							}
							if (shouldReplace) {
								nameEl.value = __kustoPickNextAvailableSectionLetterName(existingComparisonBoxId);
								try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
							}
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
				if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
					delete optimizationMetadataByBoxId[boxId];
					delete optimizationMetadataByBoxId[existingComparisonBoxId];
				}
			} catch { /* ignore */ }
		}
	} catch { /* ignore */ }

	// Do not auto-name the source section for plain comparisons.
	// For optimization scenarios, we already ensured a name above.
	const nameInput = document.getElementById(boxId + '_name');
	let queryName = sourceNameForOptimize || (nameInput ? String(nameInput.value || '').trim() : '');
	if (!desiredOptimizedName && isOptimizeScenario && queryName) {
		desiredOptimizedName = queryName + ' (optimized)';
	}

	// Create a comparison query box below the source box.
	// If a query override is provided, compare source query vs the provided query.
	let comparisonQuery = overrideText.trim() ? overrideText : query;
	try {
		if (typeof window.__kustoPrettifyKustoText === 'function') {
			comparisonQuery = window.__kustoPrettifyKustoText(comparisonQuery);
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
	} catch (err) {
		console.error('Error creating comparison box:', err);
		try { vscode.postMessage({ type: 'showInfo', message: 'Failed to create comparison section' }); } catch { /* ignore */ }
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
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			optimizationMetadataByBoxId[comparisonBoxId] = {
				sourceBoxId: boxId,
				isComparison: true,
				originalQuery: queryEditors[boxId] ? queryEditors[boxId].getValue() : query,
				optimizedQuery: comparisonQuery
			};
			optimizationMetadataByBoxId[boxId] = {
				comparisonBoxId: comparisonBoxId
			};
		}
	} catch { /* ignore */ }

	// Position the comparison box right after the source box.
	try {
		const sourceBox = document.getElementById(boxId);
		const comparisonBox = document.getElementById(comparisonBoxId);
		if (sourceBox && comparisonBox && sourceBox.parentNode) {
			sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
		}
	} catch { /* ignore */ }

	// Set connection and database to match source.
	try {
		const comparisonConnSelect = document.getElementById(comparisonBoxId + '_connection');
		const comparisonDbSelect = document.getElementById(comparisonBoxId + '_database');
		if (comparisonConnSelect) {
			comparisonConnSelect.value = connectionId;
			comparisonConnSelect.dataset.prevValue = connectionId;
			updateDatabaseField(comparisonBoxId);
			setTimeout(() => {
				try {
					const dbEl = document.getElementById(comparisonBoxId + '_database');
					if (dbEl) {
						dbEl.value = database;
					}
				} catch { /* ignore */ }
			}, 100);
		} else if (comparisonDbSelect) {
			comparisonDbSelect.value = database;
		}
	} catch { /* ignore */ }

	// Set the query name.
	try {
		const comparisonNameInput = document.getElementById(comparisonBoxId + '_name');
		if (comparisonNameInput) {
			if (desiredOptimizedName) {
				comparisonNameInput.value = desiredOptimizedName;
			} else {
				const existing = String(comparisonNameInput.value || '').trim();
				if (!existing) {
					// Use the next available letter name (A, B, C, ...) instead of suffix-based naming.
					comparisonNameInput.value = __kustoPickNextAvailableSectionLetterName(comparisonBoxId);
				}
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

async function fullyQualifyTablesInEditor(boxId) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	const conn = (connections || []).find(c => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Selected connection is missing a cluster URL' }); } catch { /* ignore */ }
		return;
	}

	const currentSchema = schemaByBoxId ? schemaByBoxId[boxId] : null;
	const currentTables = currentSchema && Array.isArray(currentSchema.tables) ? currentSchema.tables : null;
	if (!currentTables || currentTables.length === 0) {
		// Best-effort: request schema fetch and ask the user to retry.
		try { ensureSchemaForBox(boxId); } catch { /* ignore */ }
		try { vscode.postMessage({ type: 'showInfo', message: 'Schema not loaded yet. Wait for “Schema loaded” then try again.' }); } catch { /* ignore */ }
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

async function qualifyTablesInTextPriority(text, opts) {
	const normalizeClusterForKusto = (clusterUrl) => {
		let s = String(clusterUrl || '')
			.trim()
			.replace(/^https?:\/\//i, '')
			.replace(/\/+$/, '')
			.replace(/:\d+$/, '');
		// Azure Data Explorer public cloud clusters
		s = s.replace(/\.kusto\.windows\.net$/i, '');
		return s;
	};

	const currentTables = (opts.currentTables || []).map(t => String(t));
	const currentTableLower = new Set(currentTables.map(t => t.toLowerCase()));

	// Prefer language service to find true table-reference ranges (instead of regex/lexer guessing).
	let candidates = [];
	try {
		if (typeof window.__kustoRequestKqlTableReferences === 'function') {
			const res = await window.__kustoRequestKqlTableReferences({
				text,
				connectionId: opts.connectionId,
				database: opts.currentDatabase,
				boxId: opts.boxId
			});
			const refs = res && Array.isArray(res.references) ? res.references : null;
			if (refs && refs.length) {
				candidates = refs
					.map(r => ({ value: String(r.name || ''), start: Number(r.startOffset), end: Number(r.endOffset) }))
					.filter(r => r.value && Number.isFinite(r.start) && Number.isFinite(r.end) && r.end > r.start);
			}
		}
	} catch {
		// ignore and fall back
	}

	// Fallback: previous best-effort lexer (kept for resilience).
	if (!candidates.length) {
		const isIdentChar = (ch) => /[A-Za-z0-9_\-]/.test(ch);
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
	const fq = (clusterUrl, database, table) => {
		const c = normalizeClusterForKusto(clusterUrl);
		return "cluster('" + c + "').database('" + database + "')." + table;
	};

	const markResolved = (lowerName, clusterUrl, database) => {
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

	const requestSchema = async (connectionId, database) => {
		try {
			if (typeof window.__kustoRequestSchema === 'function') {
				const sch = await window.__kustoRequestSchema(connectionId, database, false);
				try {
					const cid = String(connectionId || '').trim();
					const db = String(database || '').trim();
					if (cid && db && sch) {
						schemaByConnDb[cid + '|' + db] = sch;
					}
				} catch { /* ignore */ }
				return sch;
			}
		} catch {
			// ignore
		}
		return null;
	};

	const requestDatabases = async (connectionId, forceRefresh) => {
		try {
			if (typeof window.__kustoRequestDatabases === 'function') {
				return await window.__kustoRequestDatabases(connectionId, !!forceRefresh);
			}
		} catch {
			// ignore
		}
		try {
			const cid = String(connectionId || '').trim();
			let clusterKey = '';
			try {
				const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '').trim() === cid) : null;
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
			const cached = cachedDatabases && cachedDatabases[String(clusterKey || '').trim()];
			return Array.isArray(cached) ? cached : [];
		} catch {
			return [];
		}
	};

	const schemaTablesLowerCache = new WeakMap();
	const getSchemaTableLowerSet = (schema) => {
		if (!schema || typeof schema !== 'object') return null;
		try {
			const cached = schemaTablesLowerCache.get(schema);
			if (cached) return cached;
			const tables = Array.isArray(schema.tables) ? schema.tables : [];
			const setLower = new Set(tables.map(t => String(t).toLowerCase()));
			schemaTablesLowerCache.set(schema, setLower);
			return setLower;
		} catch {
			return null;
		}
	};

	const tryResolveFromSchema = (schema, clusterUrl, dbName) => {
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

	const scanCachedSchemasForMatches = (schemas, clusterUrl) => {
		for (const entry of schemas) {
			if (!entry) continue;
			const dbName = String(entry.database || '').trim();
			const schema = entry.schema;
			if (!dbName || !schema) continue;
			tryResolveFromSchema(schema, clusterUrl, dbName);
			if (unresolvedLower.size === 0) return;
		}
	};

	const getCachedSchemasForConnection = (connectionId) => {
		const cid = String(connectionId || '').trim();
		if (!cid) return [];
		const prefix = cid + '|';
		const list = [];
		try {
			for (const key of Object.keys(schemaByConnDb || {})) {
				if (!key || !key.startsWith(prefix)) continue;
				const dbName = key.slice(prefix.length);
				if (!dbName) continue;
				list.push({ database: dbName, schema: schemaByConnDb[key] });
			}
		} catch { /* ignore */ }
		list.sort((a, b) => String(a.database).toLowerCase().localeCompare(String(b.database).toLowerCase()));
		return list;
	};

	// Step 2: search all cached schemas in priority order.
	// Priority 2: current cluster (cached).
	if (unresolvedLower.size > 0) {
		const cachedCurrentConn = getCachedSchemasForConnection(opts.connectionId)
			.filter(e => String(e.database) !== String(opts.currentDatabase));
		scanCachedSchemasForMatches(cachedCurrentConn, opts.currentClusterUrl);
	}

	// Priority 3: across all clusters (cached).
	if (unresolvedLower.size > 0) {
		const connById = new Map();
		try {
			for (const c of (connections || [])) {
				if (c && c.id) {
					connById.set(String(c.id), c);
				}
			}
		} catch { /* ignore */ }

		// Deterministic: iterate connections sorted by display clusterUrl.
		const otherConns = Array.from(connById.entries())
			.filter(([cid]) => cid !== String(opts.connectionId || '').trim())
			.map(([cid, c]) => ({ cid, clusterUrl: String((c && c.clusterUrl) || '').trim() }))
			.filter(x => !!x.clusterUrl)
			.sort((a, b) => normalizeClusterForKusto(a.clusterUrl).toLowerCase().localeCompare(normalizeClusterForKusto(b.clusterUrl).toLowerCase()));

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
			if (schemaByConnDb && schemaByConnDb[key]) continue;
			const sch = await requestSchema(cid, dbName);
			tryResolveFromSchema(sch, opts.currentClusterUrl, dbName);
		}

		// Re-scan cached current cluster after fetch.
		if (unresolvedLower.size > 0) {
			const cachedCurrentConn = getCachedSchemasForConnection(cid)
				.filter(e => String(e.database) !== String(opts.currentDatabase));
			scanCachedSchemasForMatches(cachedCurrentConn, opts.currentClusterUrl);
		}
	}

	if (unresolvedLower.size > 0) {
		// Fetch missing schemas for other connections.
		const connById = new Map();
		try {
			for (const c of (connections || [])) {
				if (c && c.id) {
					connById.set(String(c.id), c);
				}
			}
		} catch { /* ignore */ }
		const otherConns = Array.from(connById.entries())
			.filter(([id]) => id !== String(opts.connectionId || '').trim())
			.map(([id, c]) => ({ cid: id, clusterUrl: String((c && c.clusterUrl) || '').trim() }))
			.filter(x => !!x.clusterUrl)
			.sort((a, b) => normalizeClusterForKusto(a.clusterUrl).toLowerCase().localeCompare(normalizeClusterForKusto(b.clusterUrl).toLowerCase()));

		for (const c of otherConns) {
			if (unresolvedLower.size === 0) break;
			let dbs = await requestDatabases(c.cid, false);
			for (const db of (Array.isArray(dbs) ? dbs : [])) {
				if (unresolvedLower.size === 0) break;
				const dbName = String(db || '').trim();
				if (!dbName) continue;
				const key = c.cid + '|' + dbName;
				if (schemaByConnDb && schemaByConnDb[key]) continue;
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

function qualifyTablesInText(text, tables, clusterUrl, database) {
	const normalizeClusterForKusto = (value) => {
		let s = String(value || '')
			.trim()
			.replace(/^https?:\/\//i, '')
			.replace(/\/+$/, '')
			.replace(/:\d+$/, '');
		s = s.replace(/\.kusto\.windows\.net$/i, '');
		return s;
	};

	const isIdentChar = (ch) => /[A-Za-z0-9_\-]/.test(ch);
	const set = new Set((tables || []).map(t => String(t)));
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

function removeQueryBox(boxId) {
	// Dispose Copilot chat state for this query box (if present).
	try {
		if (typeof window.__kustoDisposeCopilotQueryBox === 'function') {
			window.__kustoDisposeCopilotQueryBox(boxId);
		}
	} catch { /* ignore */ }

	// If removing a linked optimized box, exit linked optimization mode and restore cache settings.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				try { __kustoSetLinkedOptimizationMode(sourceBoxId, boxId, false); } catch { /* ignore */ }
				try { delete optimizationMetadataByBoxId[boxId]; } catch { /* ignore */ }
				try { delete optimizationMetadataByBoxId[sourceBoxId]; } catch { /* ignore */ }
			} else if (meta && meta.comparisonBoxId) {
				// If removing the source box, remove the comparison box too.
				const comparisonBoxId = meta.comparisonBoxId;
				try { __kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, false); } catch { /* ignore */ }
				try { removeQueryBox(comparisonBoxId); } catch { /* ignore */ }
				try { delete optimizationMetadataByBoxId[boxId]; } catch { /* ignore */ }
			}
		}
	} catch { /* ignore */ }

	// Stop any running timer/spinner for this box
	setQueryExecuting(boxId, false);
	delete runModesByBoxId[boxId];
	try {
		if (window.__kustoQueryResultJsonByBoxId) {
			delete window.__kustoQueryResultJsonByBoxId[boxId];
		}
	} catch {
		// ignore
	}

	// Disconnect any resize observer
	if (queryEditorResizeObservers[boxId]) {
		try {
			queryEditorResizeObservers[boxId].disconnect();
		} catch {
			// ignore
		}
		delete queryEditorResizeObservers[boxId];
	}

	// Disconnect any visibility observers
	try {
		if (typeof queryEditorVisibilityObservers === 'object' && queryEditorVisibilityObservers && queryEditorVisibilityObservers[boxId]) {
			try { queryEditorVisibilityObservers[boxId].disconnect(); } catch { /* ignore */ }
			delete queryEditorVisibilityObservers[boxId];
		}
	} catch { /* ignore */ }
	try {
		if (typeof queryEditorVisibilityMutationObservers === 'object' && queryEditorVisibilityMutationObservers && queryEditorVisibilityMutationObservers[boxId]) {
			try { queryEditorVisibilityMutationObservers[boxId].disconnect(); } catch { /* ignore */ }
			delete queryEditorVisibilityMutationObservers[boxId];
		}
	} catch { /* ignore */ }

	// Dispose editor if present
	if (queryEditors[boxId]) {
		try {
			queryEditors[boxId].dispose();
		} catch {
			// ignore
		}
		delete queryEditors[boxId];
	}

	// Remove from tracked list
	queryBoxes = queryBoxes.filter(id => id !== boxId);
	try { delete lastQueryTextByBoxId[boxId]; } catch { /* ignore */ }
	try { delete missingClusterUrlsByBoxId[boxId]; } catch { /* ignore */ }
	try {
		if (missingClusterDetectTimersByBoxId && missingClusterDetectTimersByBoxId[boxId]) {
			clearTimeout(missingClusterDetectTimersByBoxId[boxId]);
			delete missingClusterDetectTimersByBoxId[boxId];
		}
	} catch { /* ignore */ }

	// Clear any global pointers if they reference this box
	if (window.lastExecutedBox === boxId) {
		window.lastExecutedBox = null;
	}
	if (window.currentResult && window.currentResult.boxId === boxId) {
		window.currentResult = null;
	}

	// Remove DOM node
	const box = document.getElementById(boxId);
	if (box && box.parentNode) {
		box.parentNode.removeChild(box);
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function toggleCacheControls(boxId) {
	const enabled = document.getElementById(boxId + '_cache_enabled').checked;
	const valueInput = document.getElementById(boxId + '_cache_value');
	const unitSelect = document.getElementById(boxId + '_cache_unit');

	if (valueInput) {
		valueInput.disabled = !enabled;
	}
	if (unitSelect) {
		unitSelect.disabled = !enabled;
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function formatClusterDisplayName(connection) {
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

function normalizeClusterUrlKey(url) {
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

function formatClusterShortName(clusterUrl) {
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

function clusterShortNameKey(clusterUrl) {
	try {
		return String(formatClusterShortName(clusterUrl) || '').trim().toLowerCase();
	} catch {
		return String(clusterUrl || '').trim().toLowerCase();
	}
}

function extractClusterUrlsFromQueryText(queryText) {
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

function extractClusterDatabaseHintsFromQueryText(queryText) {
	const text = String(queryText || '');
	const map = {};
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

function computeMissingClusterUrls(detectedClusterUrls) {
	const detected = Array.isArray(detectedClusterUrls) ? detectedClusterUrls : [];
	if (!detected.length) {
		return [];
	}
	const existingKeys = new Set();
	try {
		for (const c of (connections || [])) {
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

function renderMissingClustersBanner(boxId, missingClusterUrls) {
	const banner = document.getElementById(boxId + '_missing_clusters');
	const textEl = document.getElementById(boxId + '_missing_clusters_text');
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
		.map(u => formatClusterShortName(u))
		.filter(Boolean);
	const label = shortNames.length
		? ('Detected clusters not in your connections: <strong>' + escapeHtml(shortNames.join(', ')) + '</strong>.')
		: 'Detected clusters not in your connections.';
	textEl.innerHTML = label + ' Add them with one click.';
	banner.style.display = 'flex';
}

function updateMissingClustersForBox(boxId, queryText) {
	try {
		lastQueryTextByBoxId[boxId] = String(queryText || '');
	} catch { /* ignore */ }
	try {
		suggestedDatabaseByClusterKeyByBoxId[boxId] = extractClusterDatabaseHintsFromQueryText(queryText);
	} catch { /* ignore */ }
	const detected = extractClusterUrlsFromQueryText(queryText);
	const missing = computeMissingClusterUrls(detected);
	try { missingClusterUrlsByBoxId[boxId] = missing; } catch { /* ignore */ }
	renderMissingClustersBanner(boxId, missing);
}

// Called by Monaco (media/queryEditor/monaco.js) on content changes.
window.__kustoOnQueryValueChanged = function (boxId, queryText) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	try { lastQueryTextByBoxId[id] = String(queryText || ''); } catch { /* ignore */ }
	try {
		if (missingClusterDetectTimersByBoxId[id]) {
			clearTimeout(missingClusterDetectTimersByBoxId[id]);
		}
		missingClusterDetectTimersByBoxId[id] = setTimeout(() => {
			try { updateMissingClustersForBox(id, lastQueryTextByBoxId[id] || ''); } catch { /* ignore */ }
		}, 260);
	} catch {
		// ignore
	}
};

// Called by main.js when the connections list changes.
window.__kustoOnConnectionsUpdated = function () {
	try {
		for (const id of (queryBoxes || [])) {
			updateMissingClustersForBox(id, lastQueryTextByBoxId[id] || '');
		}
	} catch {
		// ignore
	}
	// Apply any pending favorite selections now that connections may exist.
	try {
		for (const id of (queryBoxes || [])) {
			try {
				if (pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[id]) {
					__kustoTryApplyPendingFavoriteSelectionForBox(id);
				}
			} catch { /* ignore */ }
		}
	} catch {
		// ignore
	}
	try {
		if (typeof window.__kustoUpdateFavoritesUiForAllBoxes === 'function') {
			window.__kustoUpdateFavoritesUiForAllBoxes();
		}
	} catch { /* ignore */ }
};

function __kustoFavoriteKey(clusterUrl, database) {
	const c = normalizeClusterUrlKey(String(clusterUrl || '').trim());
	const d = String(database || '').trim().toLowerCase();
	return c + '|' + d;
}

function __kustoGetCurrentClusterUrlForBox(boxId) {
	try {
		const sel = document.getElementById(boxId + '_connection');
		const cid = sel ? String(sel.value || '').trim() : '';
		if (!cid) return '';
		const conn = (connections || []).find(c => c && String(c.id || '') === cid);
		return conn ? String(conn.clusterUrl || '').trim() : '';
	} catch {
		return '';
	}
}

function __kustoGetCurrentDatabaseForBox(boxId) {
	try {
		const sel = document.getElementById(boxId + '_database');
		return sel ? String(sel.value || '').trim() : '';
	} catch {
		return '';
	}
}

function __kustoFindFavorite(clusterUrl, database) {
	const key = __kustoFavoriteKey(clusterUrl, database);
	const list = Array.isArray(kustoFavorites) ? kustoFavorites : [];
	for (const f of list) {
		if (!f) continue;
		const fk = __kustoFavoriteKey(f.clusterUrl, f.database);
		if (fk === key) return f;
	}
	return null;
}

function __kustoGetFavoritesSorted() {
	const list = (Array.isArray(kustoFavorites) ? kustoFavorites : []).slice();
	list.sort((a, b) => {
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

function __kustoMarkNewBoxForFavoritesAutoEnter(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		// Never treat restore-created boxes as "new".
		if (typeof __kustoRestoreInProgress === 'boolean' && __kustoRestoreInProgress) {
			return;
		}
	} catch { /* ignore */ }
	try {
		__kustoAutoEnterFavoritesForNewBoxByBoxId = __kustoAutoEnterFavoritesForNewBoxByBoxId || Object.create(null);
		__kustoAutoEnterFavoritesForNewBoxByBoxId[id] = true;
	} catch { /* ignore */ }
}

function __kustoTryAutoEnterFavoritesModeForNewBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let pending = false;
	try {
		pending = !!(__kustoAutoEnterFavoritesForNewBoxByBoxId && __kustoAutoEnterFavoritesForNewBoxByBoxId[id]);
	} catch { pending = false; }
	if (!pending) return;

	// Don't override an explicit choice for this box.
	try {
		if (favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, id)) {
			try { delete __kustoAutoEnterFavoritesForNewBoxByBoxId[id]; } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	// Wait until favorites are available.
	const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
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

window.__kustoSetAutoEnterFavoritesForBox = function (boxId, clusterUrl, database) {
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

function __kustoTryAutoEnterFavoritesModeForBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	let desired = null;
	try {
		desired = __kustoAutoEnterFavoritesByBoxId && __kustoAutoEnterFavoritesByBoxId[id]
			? __kustoAutoEnterFavoritesByBoxId[id]
			: null;
	} catch { desired = null; }
	if (!desired) return;

	// Only auto-enter if not already in favorites mode.
	try {
		const enabled = !!(favoritesModeByBoxId && favoritesModeByBoxId[id]);
		if (enabled) {
			try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	// Wait until favorites are available.
	const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
	if (!hasAny) return;

	const fav = __kustoFindFavorite(desired.clusterUrl, desired.database);
	if (!fav) return;

	try { __kustoApplyFavoritesMode(id, true); } catch { /* ignore */ }
	try { delete __kustoAutoEnterFavoritesByBoxId[id]; } catch { /* ignore */ }
}

window.__kustoTryAutoEnterFavoritesModeForAllBoxes = function () {
	try {
		for (const id of (queryBoxes || [])) {
			try { __kustoTryAutoEnterFavoritesModeForBox(id); } catch { /* ignore */ }
			try { __kustoTryAutoEnterFavoritesModeForNewBox(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
};

// Default behavior for blank/new docs: if the user has any favorites, start the first
// section in Favorites mode. If they have no favorites, keep the normal cluster/db selects.
let __kustoDidDefaultFirstBoxToFavorites = false;

window.__kustoMaybeDefaultFirstBoxToFavoritesMode = function () {
	try {
		if (__kustoDidDefaultFirstBoxToFavorites) return;
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
		if (!hasAny) return;
		if (!Array.isArray(queryBoxes) || queryBoxes.length !== 1) return;
		const id = String(queryBoxes[0] || '').trim();
		if (!id) return;

		// Don't override an explicit/restored setting for this box.
		try {
			if (favoritesModeByBoxId && Object.prototype.hasOwnProperty.call(favoritesModeByBoxId, id)) {
				return;
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

window.__kustoOnConfirmRemoveFavoriteResult = function (message) {
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

function __kustoFindConnectionIdForClusterUrl(clusterUrl) {
	try {
		const key = normalizeClusterUrlKey(String(clusterUrl || '').trim());
		if (!key) return '';
		for (const c of (connections || [])) {
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
window.__kustoGetSelectionOwnerBoxId = function (boxId) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[id];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				return String(meta.sourceBoxId || '').trim() || id;
			}
		}
	} catch { /* ignore */ }
	return id;
};

function __kustoTryApplyPendingFavoriteSelectionForBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return false;
	let pending = null;
	try {
		pending = pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[id]
			? pendingFavoriteSelectionByBoxId[id]
			: null;
	} catch { /* ignore */ }
	if (!pending) return false;

	const clusterUrl = String(pending.clusterUrl || '').trim();
	const database = String(pending.database || '').trim();
	if (!clusterUrl || !database) {
		try { delete pendingFavoriteSelectionByBoxId[id]; } catch { /* ignore */ }
		return false;
	}

	const connectionId = __kustoFindConnectionIdForClusterUrl(clusterUrl);
	if (!connectionId) {
		return false;
	}

	// Apply to the effective selection owner (matches execution behavior).
	let ownerId = id;
	try {
		ownerId = (typeof window.__kustoGetSelectionOwnerBoxId === 'function')
			? (window.__kustoGetSelectionOwnerBoxId(id) || id)
			: id;
	} catch { ownerId = id; }

	const applyToBox = (targetBoxId) => {
		const tid = String(targetBoxId || '').trim();
		if (!tid) return;
		const connSel = document.getElementById(tid + '_connection');
		const dbSel = document.getElementById(tid + '_database');
		try {
			if (connSel && connSel.dataset) {
				connSel.dataset.desiredClusterUrl = clusterUrl;
			}
			if (dbSel && dbSel.dataset) {
				dbSel.dataset.desired = database;
			}
		} catch { /* ignore */ }
		try {
			if (connSel) {
				connSel.value = connectionId;
			}
			// Keep the unified dropdown button text in sync when selection is applied programmatically.
			try {
				if (window.__kustoDropdown && typeof window.__kustoDropdown.syncSelectBackedDropdown === 'function') {
					window.__kustoDropdown.syncSelectBackedDropdown(tid + '_connection');
				}
			} catch { /* ignore */ }
			updateDatabaseField(tid);
		} catch { /* ignore */ }
		try { if (connSel && connSel.dataset) delete connSel.dataset.desiredClusterUrl; } catch { /* ignore */ }
	};

	applyToBox(ownerId);
	// Keep the originating box UI in sync if it's different.
	if (ownerId !== id) {
		applyToBox(id);
	}

	try { delete pendingFavoriteSelectionByBoxId[id]; } catch { /* ignore */ }
	return true;
}

function __kustoSetElementDisplay(el, display) {
	try {
		if (!el) return;
		el.style.display = display;
	} catch { /* ignore */ }
}

function __kustoApplyFavoritesMode(boxId, enabled) {
	favoritesModeByBoxId = favoritesModeByBoxId || {};
	favoritesModeByBoxId[boxId] = !!enabled;
	const favWrap = document.getElementById(boxId + '_favorites_wrapper');
	const favToggleBtn = document.getElementById(boxId + '_favorite_toggle');
	const favShowBtn = document.getElementById(boxId + '_favorites_show');
	const clusterWrap = document.getElementById(boxId + '_connection')
		? document.getElementById(boxId + '_connection').closest('.select-wrapper')
		: null;
	const dbWrap = document.getElementById(boxId + '_database')
		? document.getElementById(boxId + '_database').closest('.select-wrapper')
		: null;
	const refreshBtn = document.getElementById(boxId + '_refresh');

	// Icons for toggle button state
	const favoritesListIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<path d="M8 1.4l2.1 4.2 4.6.7-3.4 3.3L8 12l-4.1 2.2.8-4.6L1.3 6.3l4.6-.7L8 1.4z" />' +
		'<line x1="10" y1="10.5" x2="14.5" y2="10.5" stroke-width="1.4" stroke-linecap="round" />' +
		'<line x1="10" y1="12.5" x2="14.5" y2="12.5" stroke-width="1.4" stroke-linecap="round" />' +
		'<line x1="10" y1="14.5" x2="14.5" y2="14.5" stroke-width="1.4" stroke-linecap="round" />' +
		'</svg>';
	const clusterPickerIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<ellipse cx="8" cy="4" rx="5" ry="2" />' +
		'<path d="M3 4v8c0 1.1 2.2 2 5 2s5-.9 5-2V4" />' +
		'<path d="M3 8c0 1.1 2.2 2 5 2s5-.9 5-2" />' +
		'</svg>';

	if (enabled) {
		__kustoSetElementDisplay(clusterWrap, 'none');
		__kustoSetElementDisplay(dbWrap, 'none');
		__kustoSetElementDisplay(refreshBtn, 'none');
		// In favorites mode, hide the "add/remove favorite" star button (applies only when selecting cluster+db).
		__kustoSetElementDisplay(favToggleBtn, 'none');
		__kustoSetElementDisplay(favWrap, 'flex');
		// Update the show button to now show "cluster picker" option
		if (favShowBtn) {
			favShowBtn.title = 'Show cluster and database picker';
			favShowBtn.setAttribute('aria-label', 'Show cluster and database picker');
			favShowBtn.innerHTML = clusterPickerIconSvg;
		}
		try { renderFavoritesMenuForBox(boxId); } catch { /* ignore */ }
	} else {
		__kustoSetElementDisplay(favWrap, 'none');
		__kustoSetElementDisplay(clusterWrap, 'flex');
		__kustoSetElementDisplay(dbWrap, 'flex');
		__kustoSetElementDisplay(refreshBtn, 'flex');
		__kustoSetElementDisplay(favToggleBtn, 'flex');
		// Update the show button back to "show favorites"
		if (favShowBtn) {
			favShowBtn.title = 'Show favorites';
			favShowBtn.setAttribute('aria-label', 'Show favorites');
			favShowBtn.innerHTML = favoritesListIconSvg;
		}
		// When switching from favorites -> cluster/database view, the selection may have been set
		// programmatically; ensure the unified dropdown buttons reflect the current hidden <select> values.
		try {
			if (window.__kustoDropdown && typeof window.__kustoDropdown.syncSelectBackedDropdown === 'function') {
				window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_connection');
				window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database');
			}
		} catch { /* ignore */ }
		try { closeFavoritesDropdown(boxId); } catch { /* ignore */ }
	}
}

// Called by main.js when a favorite was just added from a specific query box.
window.__kustoEnterFavoritesModeForBox = function (boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	try {
		const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
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

function __kustoGetFavoriteClusterDbDisplay(fav) {
	let clusterShort = '';
	try {
		clusterShort = (typeof formatClusterShortName === 'function')
			? String(formatClusterShortName(String((fav && fav.clusterUrl) || '')) || '')
			: '';
	} catch { /* ignore */ }
	if (!clusterShort) {
		try {
			clusterShort = String((fav && fav.clusterUrl) || '').trim();
		} catch { /* ignore */ }
	}
	const db = String((fav && fav.database) || '').trim();
	if (!clusterShort || !db) return '';
	return clusterShort + '.' + db;
}

function __kustoFormatFavoriteDisplayHtml(fav) {
	const nameRaw = String((fav && fav.name) || '').trim();
	const clusterDbRaw = __kustoGetFavoriteClusterDbDisplay(fav);
	const displayNameRaw = nameRaw || clusterDbRaw;
	const showSuffix = !!(nameRaw && clusterDbRaw && nameRaw !== clusterDbRaw);
	const name = (typeof escapeHtml === 'function') ? escapeHtml(displayNameRaw) : displayNameRaw;
	const clusterDb = (typeof escapeHtml === 'function') ? escapeHtml(clusterDbRaw) : clusterDbRaw;
	return '<span class="kusto-favorites-primary">' + name + '</span>' + (showSuffix ? (' <span class="kusto-favorites-secondary">(' + clusterDb + ')</span>') : '');
}

function __kustoSetActiveFavoriteMenuItem(boxId, el) {
	const menu = document.getElementById(boxId + '_favorites_menu');
	if (!menu) return;
	const items = Array.from(menu.querySelectorAll('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]'));
	for (const it of items) {
		const active = (it === el);
		it.classList.toggle('is-active', active);
		try { it.setAttribute('aria-selected', active ? 'true' : 'false'); } catch { /* ignore */ }
		try {
			if (active && it.id) {
				menu.setAttribute('aria-activedescendant', it.id);
			}
		} catch { /* ignore */ }
	}
}

function __kustoMoveActiveFavoriteMenuItem(boxId, delta) {
	const menu = document.getElementById(boxId + '_favorites_menu');
	if (!menu) return;
	const items = Array.from(menu.querySelectorAll('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]'));
	if (!items.length) return;
	let idx = items.findIndex(it => it.classList.contains('is-active'));
	let next;
	if (idx < 0) {
		next = (delta >= 0) ? 0 : (items.length - 1);
	} else {
		next = idx + delta;
		if (next < 0) next = items.length - 1;
		if (next >= items.length) next = 0;
	}
	const el = items[next];
	__kustoSetActiveFavoriteMenuItem(boxId, el);
	try { el.focus(); } catch { /* ignore */ }
}

function __kustoWireFavoritesMenuInteractions(boxId) {
	const menu = document.getElementById(boxId + '_favorites_menu');
	if (!menu) return;
	// Avoid double-wiring the same menu element.
	try {
		if (menu.dataset && menu.dataset.kustoWired === '1') {
			return;
		}
		if (menu.dataset) {
			menu.dataset.kustoWired = '1';
		}
	} catch { /* ignore */ }

	// Make the menu itself focusable so we can capture arrow keys without focusing an item.
	try {
		if (!menu.hasAttribute('tabindex')) {
			menu.setAttribute('tabindex', '0');
		}
	} catch { /* ignore */ }

	menu.addEventListener('keydown', (e) => {
		const key = e && e.key ? String(e.key) : '';
		if (key === 'ArrowDown') {
			e.preventDefault();
			__kustoMoveActiveFavoriteMenuItem(boxId, +1);
			return;
		}
		if (key === 'ArrowUp') {
			e.preventDefault();
			__kustoMoveActiveFavoriteMenuItem(boxId, -1);
			return;
		}
		if (key === 'Escape') {
			e.preventDefault();
			try { closeFavoritesDropdown(boxId); } catch { /* ignore */ }
			try {
				const btn = document.getElementById(boxId + '_favorites_btn');
				btn && btn.focus && btn.focus();
			} catch { /* ignore */ }
			return;
		}
		if (key === 'Enter') {
			// If focus is on the trash button, let it handle Enter.
			try {
				const t = e && e.target ? e.target : null;
				if (t && t.classList && (t.classList.contains('kusto-dropdown-trash') || t.classList.contains('kusto-favorites-trash'))) {
					return;
				}
			} catch { /* ignore */ }
			e.preventDefault();
			const active = menu.querySelector('.kusto-dropdown-item.is-active, .kusto-favorites-item.is-active');
			if (active && active.dataset) {
				const k = String(active.dataset.kustoKey || active.dataset.favKey || '');
				if (k) {
					selectFavoriteForBox(boxId, k);
				}
			}
			return;
		}
	});
}

function __kustoApplyFavoriteSelection(boxId, encodedKey, opts) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const keyStr = String(encodedKey || '');
	const closeDropdown = !(opts && opts.closeDropdown === false);

	if (keyStr === '__other__') {
		try { __kustoApplyFavoritesMode(id, false); } catch { /* ignore */ }
		try { window.__kustoUpdateFavoritesUiForAllBoxes(); } catch { /* ignore */ }
		try { window.__kustoUpdateRunEnabledForBox && window.__kustoUpdateRunEnabledForBox(id); } catch { /* ignore */ }
		if (closeDropdown) {
			closeFavoritesDropdown(id);
		}
		return;
	}

	let key = '';
	try { key = decodeURIComponent(keyStr); } catch { key = keyStr; }
	if (key === '__other__') {
		try { __kustoApplyFavoritesMode(id, false); } catch { /* ignore */ }
		try { window.__kustoUpdateFavoritesUiForAllBoxes(); } catch { /* ignore */ }
		try { window.__kustoUpdateRunEnabledForBox && window.__kustoUpdateRunEnabledForBox(id); } catch { /* ignore */ }
		if (closeDropdown) {
			closeFavoritesDropdown(id);
		}
		return;
	}

	const list = __kustoGetFavoritesSorted();
	const fav = list.find(f => __kustoFavoriteKey(f.clusterUrl, f.database) === key);
	if (!fav) {
		closeFavoritesDropdown(id);
		return;
	}

	const clusterUrl = String(fav.clusterUrl || '').trim();
	const database = String(fav.database || '').trim();
	if (!clusterUrl || !database) {
		closeFavoritesDropdown(id);
		return;
	}

	// Always stage the selection; apply immediately if possible, otherwise apply on the next connections refresh.
	try {
		pendingFavoriteSelectionByBoxId = pendingFavoriteSelectionByBoxId || {};
		pendingFavoriteSelectionByBoxId[id] = { clusterUrl, database };
	} catch { /* ignore */ }

	let applied = false;
	try {
		applied = __kustoTryApplyPendingFavoriteSelectionForBox(id);
	} catch { /* ignore */ }

	if (!applied) {
		try {
			vscode.postMessage({ type: 'addConnectionsForClusters', boxId: id, clusterUrls: [clusterUrl] });
		} catch { /* ignore */ }
		try { updateConnectionSelects(); } catch { /* ignore */ }
	}

	// Update monaco-kusto schema when a favorite is selected
	try {
		if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
			window.__kustoUpdateSchemaForFocusedBox(id);
		}
	} catch { /* ignore */ }

	try { window.__kustoUpdateFavoritesUiForAllBoxes(); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try { window.__kustoUpdateRunEnabledForBox && window.__kustoUpdateRunEnabledForBox(id); } catch { /* ignore */ }
	if (closeDropdown) {
		closeFavoritesDropdown(id);
	}
}

function removeFavoriteFromFavoritesMenu(ev, boxId, encodedKey) {
	try { ev && ev.stopPropagation && ev.stopPropagation(); } catch { /* ignore */ }
	try { ev && ev.preventDefault && ev.preventDefault(); } catch { /* ignore */ }
	const id = String(boxId || '').trim();
	if (!id) return;
	let key = '';
	try { key = decodeURIComponent(String(encodedKey || '')); } catch { key = String(encodedKey || ''); }
	const list = __kustoGetFavoritesSorted();
	const fav = list.find(f => __kustoFavoriteKey(f.clusterUrl, f.database) === key);
	if (!fav) {
		try { renderFavoritesMenuForBox(id); } catch { /* ignore */ }
		return;
	}
	const name = String((fav && fav.name) || '').trim();
	const clusterDb = __kustoGetFavoriteClusterDbDisplay(fav);
	const label = name || clusterDb || 'this favorite';
	const clusterUrl = String(fav.clusterUrl || '').trim();
	const database = String(fav.database || '').trim();
	if (!clusterUrl || !database) return;

	// Ask the extension host to confirm, then proceed if approved.
	let requestId = '';
	try {
		requestId = '__kusto_rmfav__' + Date.now() + '_' + Math.random().toString(16).slice(2);
	} catch {
		requestId = '__kusto_rmfav__' + String(Date.now());
	}
	try {
		__kustoConfirmRemoveFavoriteCallbacksById = __kustoConfirmRemoveFavoriteCallbacksById || Object.create(null);
		__kustoConfirmRemoveFavoriteCallbacksById[requestId] = (ok) => {
			if (!ok) return;

			const removedKey = __kustoFavoriteKey(clusterUrl, database);
			let currentKey = '';
			try {
				const currentClusterUrl = __kustoGetCurrentClusterUrlForBox(id);
				const currentDb = __kustoGetCurrentDatabaseForBox(id);
				if (currentClusterUrl && currentDb) {
					currentKey = __kustoFavoriteKey(currentClusterUrl, currentDb);
				}
			} catch { /* ignore */ }
			const removedWasSelected = !!(currentKey && removedKey && currentKey === removedKey);

			// Optimistic UI update.
			try {
				kustoFavorites = (Array.isArray(kustoFavorites) ? kustoFavorites : []).filter(f => __kustoFavoriteKey(f.clusterUrl, f.database) !== removedKey);
			} catch { /* ignore */ }
			try { window.__kustoUpdateFavoritesUiForAllBoxes(); } catch { /* ignore */ }
			try { renderFavoritesMenuForBox(id); } catch { /* ignore */ }

			// Keep menu open and, if we just deleted the active selection, select the next available favorite.
			try {
				const menu = document.getElementById(id + '_favorites_menu');
				if (menu) {
					menu.style.display = 'block';
				}
				if (removedWasSelected) {
					const remaining = __kustoGetFavoritesSorted();
					if (Array.isArray(remaining) && remaining.length) {
						const first = remaining.find(f => f && String(f.clusterUrl || '').trim() && String(f.database || '').trim());
						if (first) {
							const nextEncoded = encodeURIComponent(__kustoFavoriteKey(first.clusterUrl, first.database));
							__kustoApplyFavoriteSelection(id, nextEncoded, { closeDropdown: false });
							try { renderFavoritesMenuForBox(id); } catch { /* ignore */ }
						}
					}
				}
			} catch { /* ignore */ }

			try {
				vscode.postMessage({ type: 'removeFavorite', clusterUrl, database, boxId: id });
			} catch { /* ignore */ }
		};
		// Safety cleanup in case no response arrives.
		setTimeout(() => {
			try { if (__kustoConfirmRemoveFavoriteCallbacksById) delete __kustoConfirmRemoveFavoriteCallbacksById[requestId]; } catch { /* ignore */ }
		}, 20000);
	} catch { /* ignore */ }

	try {
		vscode.postMessage({ type: 'confirmRemoveFavorite', requestId, label, clusterUrl, database, boxId: id });
	} catch {
		// If we can't ask for confirmation, do nothing.
		try { if (__kustoConfirmRemoveFavoriteCallbacksById) delete __kustoConfirmRemoveFavoriteCallbacksById[requestId]; } catch { /* ignore */ }
	}
	return;
}

function __kustoUpdateFavoritesUiForBox(boxId) {
	const favBtn = document.getElementById(boxId + '_favorite_toggle');
	const showBtn = document.getElementById(boxId + '_favorites_show');
	const favWrap = document.getElementById(boxId + '_favorites_wrapper');
	const btnText = document.getElementById(boxId + '_favorites_btn_text');

	const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
	__kustoSetElementDisplay(showBtn, hasAny ? 'flex' : 'none');

	// If we have no favorites anymore, force exit favorites mode.
	try {
		const enabled = !!(favoritesModeByBoxId && favoritesModeByBoxId[boxId]);
		if (enabled && !hasAny) {
			__kustoApplyFavoritesMode(boxId, false);
		}
	} catch { /* ignore */ }

	// Star state for current selection.
	const clusterUrl = __kustoGetCurrentClusterUrlForBox(boxId);
	const db = __kustoGetCurrentDatabaseForBox(boxId);
	const fav = (clusterUrl && db) ? __kustoFindFavorite(clusterUrl, db) : null;
	if (favBtn) {
		const isFav = !!fav;
		favBtn.classList.toggle('is-favorite', isFav);
		favBtn.title = isFav ? 'Remove from favorites' : 'Add to favorites';
		favBtn.setAttribute('aria-label', favBtn.title);
	}

	// Favorites dropdown current label.
	if (btnText) {
		if (fav) {
			btnText.innerHTML = __kustoFormatFavoriteDisplayHtml(fav);
		} else {
			btnText.textContent = 'Select favorite...';
		}
	}

	// Keep wrapper hidden unless favorites mode is enabled.
	try {
		const enabled = !!(favoritesModeByBoxId && favoritesModeByBoxId[boxId]);
		if (favWrap && favWrap.style.display !== (enabled ? 'flex' : 'none')) {
			// Don't stomp if a restore is in progress; only adjust when explicitly toggled.
			// (The row gets rebuilt on restore anyway.)
		}
	} catch { /* ignore */ }
}

window.__kustoUpdateFavoritesUiForAllBoxes = function () {
	try {
		for (const id of (queryBoxes || [])) {
			__kustoUpdateFavoritesUiForBox(id);
		}
	} catch { /* ignore */ }
};

function toggleFavoriteForBox(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const clusterUrl = __kustoGetCurrentClusterUrlForBox(id);
	const database = __kustoGetCurrentDatabaseForBox(id);
	if (!clusterUrl || !database) {
		try {
			vscode.postMessage({ type: 'showInfo', message: 'Select a cluster and database first.' });
		} catch { /* ignore */ }
		return;
	}
	const existing = __kustoFindFavorite(clusterUrl, database);
	if (existing) {
		// Optimistic UI update.
		try {
			kustoFavorites = (Array.isArray(kustoFavorites) ? kustoFavorites : []).filter(f => __kustoFavoriteKey(f.clusterUrl, f.database) !== __kustoFavoriteKey(clusterUrl, database));
		} catch { /* ignore */ }
		try { window.__kustoUpdateFavoritesUiForAllBoxes(); } catch { /* ignore */ }
		try {
			vscode.postMessage({ type: 'removeFavorite', clusterUrl, database, boxId: id });
		} catch { /* ignore */ }
		return;
	}

	const connShort = (typeof formatClusterShortName === 'function') ? formatClusterShortName(clusterUrl) : '';
	const defaultName = (connShort ? connShort : clusterUrl) + '.' + database;
	try {
		vscode.postMessage({ type: 'requestAddFavorite', clusterUrl, database, defaultName, boxId: id });
	} catch { /* ignore */ }
}

function toggleFavoritesMode(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const hasAny = Array.isArray(kustoFavorites) && kustoFavorites.length > 0;
	if (!hasAny) return;
	const enabled = !!(favoritesModeByBoxId && favoritesModeByBoxId[id]);
	__kustoApplyFavoritesMode(id, !enabled);
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(id);
		}
	} catch { /* ignore */ }
}

function closeFavoritesDropdown(boxId) {
	const menu = document.getElementById(boxId + '_favorites_menu');
	const btn = document.getElementById(boxId + '_favorites_btn');
	try {
		if (window.__kustoDropdown && typeof window.__kustoDropdown.closeMenuDropdown === 'function') {
			window.__kustoDropdown.closeMenuDropdown(boxId + '_favorites_btn', boxId + '_favorites_menu');
			return;
		}
	} catch { /* ignore */ }
	if (menu) menu.style.display = 'none';
	if (btn) btn.setAttribute('aria-expanded', 'false');
}

function closeAllFavoritesDropdowns() {
	try {
		for (const id of (queryBoxes || [])) {
			closeFavoritesDropdown(id);
		}
	} catch { /* ignore */ }
}

function toggleFavoritesDropdown(boxId) {
	const id = String(boxId || '').trim();
	const menu = document.getElementById(id + '_favorites_menu');
	const btn = document.getElementById(id + '_favorites_btn');
	if (!menu || !btn) return;
	try {
		if (window.__kustoDropdown && typeof window.__kustoDropdown.toggleMenuDropdown === 'function') {
			window.__kustoDropdown.toggleMenuDropdown({
				buttonId: id + '_favorites_btn',
				menuId: id + '_favorites_menu',
				beforeOpen: () => {
					try { renderFavoritesMenuForBox(id); } catch { /* ignore */ }
				},
				afterOpen: () => {
					// Shared dropdown helper wires keyboard navigation for all menus.
				}
			});
			return;
		}
	} catch { /* ignore */ }
	// Fallback (legacy behavior)
	const next = menu.style.display === 'block' ? 'none' : 'block';
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	if (next === 'block') {
		try { renderFavoritesMenuForBox(id); } catch { /* ignore */ }
	}
	menu.style.display = next;
	btn.setAttribute('aria-expanded', next === 'block' ? 'true' : 'false');
	if (next === 'block') {
		try { __kustoWireFavoritesMenuInteractions(id); } catch { /* ignore */ }
		try { menu.focus(); } catch { /* ignore */ }
	}
}

function renderFavoritesMenuForBox(boxId) {
	const menu = document.getElementById(boxId + '_favorites_menu');
	if (!menu) return;
	let selectedKeyEnc = '';
	try {
		let ownerId = String(boxId || '').trim();
		try {
			ownerId = (typeof window.__kustoGetSelectionOwnerBoxId === 'function')
				? (String(window.__kustoGetSelectionOwnerBoxId(ownerId) || ownerId))
				: ownerId;
		} catch { /* ignore */ }
		const currentClusterUrl = __kustoGetCurrentClusterUrlForBox(ownerId);
		const currentDb = __kustoGetCurrentDatabaseForBox(ownerId);
		if (currentClusterUrl && currentDb) {
			selectedKeyEnc = encodeURIComponent(__kustoFavoriteKey(currentClusterUrl, currentDb));
		}
	} catch { /* ignore */ }
	let list = [];
	try {
		list = __kustoGetFavoritesSorted();
	} catch {
		list = [];
	}
	// Guard against malformed items so one bad entry can't break the whole menu.
	const safe = [];
	try {
		for (const f of (Array.isArray(list) ? list : [])) {
			if (!f) continue;
			const clusterUrl = String(f.clusterUrl || '').trim();
			const database = String(f.database || '').trim();
			if (!clusterUrl || !database) continue;
			safe.push(f);
		}
	} catch { /* ignore */ }
	if (!safe.length) {
		menu.innerHTML = '<div class="kusto-dropdown-empty">No favorites yet.</div>';
		return;
	}
	const useSharedDropdown = !!(window.__kustoDropdown && typeof window.__kustoDropdown.renderMenuItemsHtml === 'function');
	// Prefer shared dropdown renderer (enables optional delete buttons).
	try {
		if (useSharedDropdown) {
			const items = safe.map((f) => {
				const key = encodeURIComponent(__kustoFavoriteKey(f.clusterUrl, f.database));
				return {
					key,
					html: __kustoFormatFavoriteDisplayHtml(f),
					ariaLabel: 'Select favorite',
					selected: !!(selectedKeyEnc && key === selectedKeyEnc),
					// Favorites explicitly opts into delete.
					enableDelete: true
				};
			});

			const otherRowHtml =
				'<div class="kusto-dropdown-item" id="' + boxId + '_favorites_opt_other" role="option" tabindex="-1" aria-selected="false" data-kusto-key="__other__" onclick="selectFavoriteForBox(\'' + boxId + '\', \'__other__\');">' +
					'<div class="kusto-dropdown-item-main"><span class="kusto-favorites-primary">Other...</span></div>' +
				'</div>';

			menu.innerHTML = window.__kustoDropdown.renderMenuItemsHtml(items, {
				dropdownId: boxId + '_favorites',
				emptyHtml: '<div class="kusto-dropdown-empty">No favorites yet.</div>',
				onSelectJs: (keyEnc) => "selectFavoriteForBox('" + boxId + "', '" + keyEnc + "')",
				onDeleteJs: (keyEnc) => "removeFavoriteFromFavoritesMenu(event, '" + boxId + "', '" + keyEnc + "')",
				includeOtherRowHtml: otherRowHtml
			});
		} else {
			throw new Error('dropdown helper not available');
		}
	} catch {
		// Fallback to legacy renderer.
		const trashSvg = __kustoGetTrashIconSvg();
		const rows = [];
		for (let idx = 0; idx < safe.length; idx++) {
			const f = safe[idx];
			try {
				const key = encodeURIComponent(__kustoFavoriteKey(f.clusterUrl, f.database));
				const itemId = boxId + '_favorites_opt_' + idx;
				const isSelected = !!(selectedKeyEnc && key === selectedKeyEnc);
				rows.push(
					'<div class="kusto-favorites-item' + (isSelected ? ' is-active' : '') + '" id="' + itemId + '" role="option" tabindex="-1" aria-selected="' + (isSelected ? 'true' : 'false') + '" data-fav-key="' + key + '" onclick="selectFavoriteForBox(\'' + boxId + '\', \'' + key + '\');">' +
						'<div class="kusto-favorites-item-main">' +
							__kustoFormatFavoriteDisplayHtml(f) +
						'</div>' +
						'<button type="button" class="kusto-favorites-trash" tabindex="-1" title="Remove from favorites" aria-label="Remove from favorites" data-fav-key="' + key + '">' +
							trashSvg +
						'</button>' +
					'</div>'
				);
			} catch { /* ignore */ }
		}
		rows.push(
			'<div class="kusto-favorites-item" id="' + boxId + '_favorites_opt_other" role="option" tabindex="-1" aria-selected="false" data-fav-key="__other__" onclick="selectFavoriteForBox(\'' + boxId + '\', \'__other__\');">' +
			'<div class="kusto-favorites-item-main"><span class="kusto-favorites-primary">Other...</span></div>' +
			'</div>'
		);
		menu.innerHTML = rows.join('');
	}

	// Wire behavior for the freshly rendered items.
	try {
		if (useSharedDropdown && window.__kustoDropdown && typeof window.__kustoDropdown.wireMenuInteractions === 'function') {
			window.__kustoDropdown.wireMenuInteractions(menu);
			// In shared-dropdown mode, aria-selected represents the current selection.
			// Do not attach the legacy handlers that repurpose aria-selected for "active".
		} else {
			const items = Array.from(menu.querySelectorAll('.kusto-dropdown-item[role="option"], .kusto-favorites-item[role="option"]'));
			for (const it of items) {
				it.addEventListener('mouseenter', () => { __kustoSetActiveFavoriteMenuItem(boxId, it); });
				it.addEventListener('focus', () => { __kustoSetActiveFavoriteMenuItem(boxId, it); });
			}
			// Default the initial active item to the current selection if possible.
			try {
				const selectedEl = selectedKeyEnc
					? (menu.querySelector('[data-fav-key="' + selectedKeyEnc + '"], [data-kusto-key="' + selectedKeyEnc + '"]'))
					: null;
				if (selectedEl) {
					__kustoSetActiveFavoriteMenuItem(boxId, selectedEl);
				} else if (items.length) {
					__kustoSetActiveFavoriteMenuItem(boxId, items[0]);
				}
			} catch { /* ignore */ }

			const trashButtons = Array.from(menu.querySelectorAll('.kusto-dropdown-trash, .kusto-favorites-trash'));
			for (const btn of trashButtons) {
				// Reusable dropdown delete buttons already have inline onclick.
				try {
					if (btn && btn.getAttribute && btn.getAttribute('onclick')) {
						continue;
					}
				} catch { /* ignore */ }
				btn.addEventListener('click', (ev) => {
					let k = '';
					try { k = btn && btn.dataset ? String(btn.dataset.kustoKey || btn.dataset.favKey || '') : ''; } catch { k = ''; }
					removeFavoriteFromFavoritesMenu(ev, boxId, k);
				});
			}
		}
	} catch { /* ignore */ }
}

function __kustoLog(boxId, event, message, data, level) {
	// Diagnostics logging disabled.
	return;
	try {
		if (!vscode || typeof vscode.postMessage !== 'function') return;
		vscode.postMessage({
			type: 'log',
			level: level || 'info',
			boxId: boxId ? String(boxId) : undefined,
			event: event ? String(event) : undefined,
			message: message ? String(message) : undefined,
			data
		});
	} catch { /* ignore */ }
}

function selectFavoriteForBox(boxId, encodedKey) {
	const id = String(boxId || '').trim();
	if (!id) return;
	__kustoLog(id, 'favorites.select', 'User selected favorite item', { encodedKey: String(encodedKey || '') });
	__kustoApplyFavoriteSelection(id, encodedKey, { closeDropdown: true });
}

function addMissingClusterConnections(boxId) {
	const id = String(boxId || '').trim();
	if (!id) {
		return;
	}
	const missing = missingClusterUrlsByBoxId[id];
	const clusters = Array.isArray(missing) ? missing.slice() : [];
	if (!clusters.length) {
		return;
	}
	// If this query box has no cluster selected, auto-select the first newly-added cluster
	// once connections refresh.
	try {
		const sel = document.getElementById(id + '_connection');
		const hasSelection = !!(sel && String(sel.value || '').trim());
		if (sel && !hasSelection) {
			const hints = suggestedDatabaseByClusterKeyByBoxId && suggestedDatabaseByClusterKeyByBoxId[id]
				? suggestedDatabaseByClusterKeyByBoxId[id]
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
			sel.dataset.desiredClusterUrl = chosenClusterUrl;

			// If we detected a database for that same fully-qualified reference, stage it too.
			if (chosenDb) {
				const dbEl = document.getElementById(id + '_database');
				if (dbEl) {
					dbEl.dataset.desired = chosenDb;
					// Optimistic restore: show the persisted DB immediately, even before the DB list loads.
					const esc = (typeof escapeHtml === 'function') ? escapeHtml(chosenDb) : chosenDb;
					dbEl.innerHTML =
						'<option value="" disabled hidden>Select Database...</option>' +
						'<option value="' + esc + '">' + esc + '</option>';
					dbEl.value = chosenDb;
						try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(id + '_database'); } catch { /* ignore */ }
				}
			}
		}
	} catch {
		// ignore
	}
	try {
		vscode.postMessage({
			type: 'addConnectionsForClusters',
			boxId: id,
			clusterUrls: clusters
		});
	} catch {
		// ignore
	}
}

function updateConnectionSelects() {
	queryBoxes.forEach(id => {
		const select = document.getElementById(id + '_connection');
		if (select) {
			const currentValue = select.value;
			const desiredClusterUrl = (select.dataset && select.dataset.desiredClusterUrl) ? String(select.dataset.desiredClusterUrl) : '';
			let resolvedDesiredId = '';
			try {
				if (!resolvedDesiredId && desiredClusterUrl) {
					const target = normalizeClusterUrlKey(desiredClusterUrl);
					for (const c of (connections || [])) {
						if (!c) continue;
						if (normalizeClusterUrlKey(c.clusterUrl || '') === target) {
							resolvedDesiredId = String(c.id || '');
							break;
						}
					}
				}
				// Fallback: match by short-name key (case-insensitive). Useful when persisted
				// state stores only a short cluster name.
				if (!resolvedDesiredId && desiredClusterUrl) {
					const targetShort = clusterShortNameKey(desiredClusterUrl);
					for (const c of (connections || [])) {
						if (!c) continue;
						if (clusterShortNameKey(c.clusterUrl || '') === targetShort) {
							resolvedDesiredId = String(c.id || '');
							break;
						}
					}
				}
			} catch {
				// ignore
			}
			const sortedConnections = (connections || []).slice().sort((a, b) => {
				const an = String(formatClusterDisplayName(a) || '').toLowerCase();
				const bn = String(formatClusterDisplayName(b) || '').toLowerCase();
				return an.localeCompare(bn);
			});
			select.innerHTML =
				'<option value="" disabled ' + (currentValue ? '' : 'selected ') + 'hidden>Select Cluster...</option>' +
				'<option value="__enter_new__">Enter new cluster…</option>' +
				'<option value="__import_xml__">Import from .xml file…</option>' +
				sortedConnections
					.map(c => '<option value="' + c.id + '">' + escapeHtml(formatClusterDisplayName(c)) + '</option>')
					.join('');

			// Restore: prefer desired selection from persisted document state.
			if (!currentValue && resolvedDesiredId) {
				select.value = resolvedDesiredId;
				try { delete select.dataset.desiredClusterUrl; } catch { /* ignore */ }
				try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(id + '_connection'); } catch { /* ignore */ }
				updateDatabaseField(id);
			} else if (!currentValue && lastConnectionId) {
				// Pre-fill with last selection if this is a new box.
				select.value = lastConnectionId;
				try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(id + '_connection'); } catch { /* ignore */ }
				updateDatabaseField(id);
			} else if (currentValue && currentValue !== '__import_xml__' && currentValue !== '__enter_new__') {
				select.value = currentValue;
			}
			try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(id + '_connection'); } catch { /* ignore */ }
		}
	});
	try {
		if (typeof window.__kustoUpdateRunEnabledForAllBoxes === 'function') {
			window.__kustoUpdateRunEnabledForAllBoxes();
		}
	} catch { /* ignore */ }
}

function updateDatabaseField(boxId) {
	// If a previous database-load attempt rendered an error into the results area,
	// clear it as soon as the user changes clusters so the UI doesn't look stuck.
	try {
		if (typeof __kustoClearDatabaseLoadError === 'function') {
			__kustoClearDatabaseLoadError(boxId);
		}
	} catch { /* ignore */ }

	const connectionSelect = document.getElementById(boxId + '_connection');
	const connectionId = connectionSelect ? connectionSelect.value : '';
	if (connectionSelect && connectionId === '__enter_new__') {
		const prev = connectionSelect.dataset.prevValue || '';
		connectionSelect.value = prev;
		promptAddConnectionFromDropdown(boxId);
		return;
	}
	if (connectionSelect && connectionId === '__import_xml__') {
		const prev = connectionSelect.dataset.prevValue || '';
		connectionSelect.value = prev;
		importConnectionsFromXmlFile(boxId);
		return;
	}
	if (connectionSelect) {
		connectionSelect.dataset.prevValue = connectionId;
		// Persist selection immediately so VS Code Problems can reflect current schema context.
		try {
			vscode.postMessage({
				type: 'saveLastSelection',
				connectionId: String(connectionId || ''),
				// Connection change invalidates any prior DB selection until the DB dropdown refreshes.
				database: ''
			});
		} catch { /* ignore */ }
	}
	const databaseSelect = document.getElementById(boxId + '_database');
	const refreshBtn = document.getElementById(boxId + '_refresh');
	// Connection changed: clear schema so it doesn't mismatch.
	delete schemaByBoxId[boxId];
	// Also clear in-flight/throttle state so a new schema request can start immediately.
	try {
		if (schemaFetchInFlightByBoxId) {
			schemaFetchInFlightByBoxId[boxId] = false;
		}
		if (lastSchemaRequestAtByBoxId) {
			lastSchemaRequestAtByBoxId[boxId] = 0;
		}
		if (window && window.__kustoSchemaRequestTokenByBoxId) {
			delete window.__kustoSchemaRequestTokenByBoxId[boxId];
		}
		if (databaseSelect && databaseSelect.dataset) {
			delete databaseSelect.dataset.kustoDesiredRefreshAttempted;
		}
		if (typeof setSchemaLoading === 'function') {
			setSchemaLoading(boxId, false);
		}
	} catch { /* ignore */ }

	if (connectionId && databaseSelect) {
		// Check if we have cached databases for this cluster
		let clusterKey = '';
		try {
			const cid = String(connectionId || '').trim();
			const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '').trim() === cid) : null;
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

		const cached = (cachedDatabases && cachedDatabases[String(clusterKey || '').trim()]) || cachedDatabases[connectionId];

		if (cached && cached.length > 0) {
			// Use cached databases immediately
			updateDatabaseSelect(boxId, cached);
			// If we already have a selected DB (restore/last), start schema fetch right away.
			try {
				if (typeof ensureSchemaForBox === 'function') {
					ensureSchemaForBox(boxId, false);
				}
			} catch {
				// ignore
			}
			// Update monaco-kusto schema if we have a cached schema for the new selection
			try {
				if (typeof window.__kustoUpdateSchemaForFocusedBox === 'function') {
					window.__kustoUpdateSchemaForFocusedBox(boxId);
				}
			} catch { /* ignore */ }
			if (refreshBtn) {
				refreshBtn.disabled = false;
			}
			try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
		} else {
			// No cache, need to load from server
			// Keep the dropdown in a loading state and do not replace its contents with a synthetic
			// single-option list. If `dataset.desired` is set, updateDatabaseSelect will apply it
			// once the real database list arrives.
			databaseSelect.innerHTML = '<option value="">Loading databases...</option>';
			databaseSelect.disabled = true;
			if (refreshBtn) {
				// While auto-loading databases after a cluster change, show a spinner in the refresh button.
				try {
					if (!(refreshBtn.dataset && (refreshBtn.dataset.kustoRefreshDbInFlight === '1' || refreshBtn.dataset.kustoAutoDbInFlight === '1'))) {
						if (refreshBtn.dataset) {
							refreshBtn.dataset.kustoAutoDbInFlight = '1';
							refreshBtn.dataset.kustoPrevHtml = String(refreshBtn.innerHTML || '');
						}
						refreshBtn.innerHTML = '<span class="query-spinner" aria-hidden="true"></span>';
						refreshBtn.setAttribute('aria-busy', 'true');
					}
				} catch { /* ignore */ }
				refreshBtn.disabled = true;
			}
			try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }

			// Request databases from the extension
			vscode.postMessage({
				type: 'getDatabases',
				connectionId: connectionId,
				boxId: boxId
			});
		}
	} else if (databaseSelect) {
		databaseSelect.innerHTML = '<option value="" disabled selected hidden>Select Database...</option>';
		databaseSelect.disabled = false;
		if (refreshBtn) {
			refreshBtn.disabled = true;
		}
		try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
	}
	try {
		__kustoUpdateFavoritesUiForBox(boxId);
	} catch { /* ignore */ }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

function __kustoClearDatabaseLoadError(boxId) {
	const bid = String(boxId || '').trim();
	if (!bid) return;
	const resultsDiv = document.getElementById(bid + '_results');
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
						if (window.__kustoResultsVisibleByBoxId) {
							window.__kustoResultsVisibleByBoxId[bid] = desiredVisible;
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

function promptAddConnectionFromDropdown(boxId) {
	try {
		vscode.postMessage({ type: 'promptAddConnection', boxId: boxId });
	} catch {
		// ignore
	}
}

function importConnectionsFromXmlFile(boxId) {
	try {
		// Use the extension host's file picker so we can default to the user's Kusto Explorer folder.
		vscode.postMessage({ type: 'promptImportConnectionsXml', boxId: boxId });
	} catch (e) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Failed to open file picker: ' + (e && e.message ? e.message : String(e)) }); } catch { /* ignore */ }
	}
}

function parseKustoExplorerConnectionsXml(xmlText) {
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

function getChildText(node, localName) {
	if (!node || !node.childNodes) {
		return '';
	}
	for (const child of Array.from(node.childNodes)) {
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

function parseKustoConnectionString(cs) {
	const raw = String(cs || '');
	const parts = raw.split(';').map(p => p.trim()).filter(Boolean);
	const map = {};
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

function refreshDatabases(boxId) {
	const connectionId = document.getElementById(boxId + '_connection').value;
	if (!connectionId) {
		return;
	}

	const databaseSelect = document.getElementById(boxId + '_database');
	const refreshBtn = document.getElementById(boxId + '_refresh');

	if (databaseSelect) {
		try {
			databaseSelect.dataset.kustoPrevHtml = String(databaseSelect.innerHTML || '');
			databaseSelect.dataset.kustoPrevValue = String(databaseSelect.value || '');
			databaseSelect.dataset.kustoRefreshInFlight = 'true';
		} catch { /* ignore */ }
		databaseSelect.disabled = true;
		try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
	}
	if (refreshBtn) {
		try {
			if (refreshBtn.dataset && refreshBtn.dataset.kustoRefreshDbInFlight === '1') {
				return;
			}
			if (refreshBtn.dataset) {
				refreshBtn.dataset.kustoRefreshDbInFlight = '1';
				refreshBtn.dataset.kustoPrevHtml = String(refreshBtn.innerHTML || '');
			}
			refreshBtn.innerHTML = '<span class="query-spinner" aria-hidden="true"></span>';
			refreshBtn.setAttribute('aria-busy', 'true');
		} catch { /* ignore */ }
		refreshBtn.disabled = true;
	}

	vscode.postMessage({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
}

function onDatabasesError(boxId, error) {
	const errText = String(error || '');
	const isEnotfound = /\bENOTFOUND\b/i.test(errText) || /getaddrinfo\s+ENOTFOUND/i.test(errText);

	try {
		const databaseSelect = document.getElementById(boxId + '_database');
		const refreshBtn = document.getElementById(boxId + '_refresh');
		if (databaseSelect) {
			if (isEnotfound) {
				// Cluster is unreachable/invalid: don't keep stale DBs around.
				databaseSelect.innerHTML = '<option value="" disabled selected hidden>Select Database...</option>';
				try { databaseSelect.value = ''; } catch { /* ignore */ }
			} else {
				// Restore previous dropdown contents/value if we snapshotted them.
				try {
					if (databaseSelect.dataset && databaseSelect.dataset.kustoRefreshInFlight === 'true') {
						const prevHtml = databaseSelect.dataset.kustoPrevHtml;
						const prevValue = databaseSelect.dataset.kustoPrevValue;
						if (typeof prevHtml === 'string' && prevHtml) {
							databaseSelect.innerHTML = prevHtml;
						}
						if (typeof prevValue === 'string') {
							databaseSelect.value = prevValue;
						}
					}
				} catch { /* ignore */ }
			}
			databaseSelect.disabled = false;
			try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
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
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
	try {
		if (typeof window.__kustoDisplayBoxError === 'function') {
			// Snapshot current results so we can restore them when the user changes clusters.
			try {
				const bid = String(boxId || '').trim();
				const resultsDiv = bid ? document.getElementById(bid + '_results') : null;
				if (resultsDiv && resultsDiv.dataset) {
					if (resultsDiv.dataset.kustoDbLoadErrorActive !== '1') {
						resultsDiv.dataset.kustoDbLoadErrorPrevHtml = String(resultsDiv.innerHTML || '');
						let visible = '';
						try {
							if (window.__kustoResultsVisibleByBoxId && typeof window.__kustoResultsVisibleByBoxId[bid] === 'boolean') {
								visible = window.__kustoResultsVisibleByBoxId[bid] ? '1' : '0';
							}
						} catch { /* ignore */ }
						if (visible) {
							resultsDiv.dataset.kustoDbLoadErrorPrevVisible = visible;
						}
						resultsDiv.dataset.kustoDbLoadErrorActive = '1';
					}
				}
			} catch { /* ignore */ }
			window.__kustoDisplayBoxError(boxId, error);
		}
	} catch {
		// ignore
	}
}

function updateDatabaseSelect(boxId, databases) {
	const databaseSelect = document.getElementById(boxId + '_database');
	const refreshBtn = document.getElementById(boxId + '_refresh');

	if (databaseSelect) {
		const prevValue = String(databaseSelect.value || '');
		const list = (Array.isArray(databases) ? databases : [])
			.map(d => String(d || '').trim())
			.filter(Boolean)
			.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

		databaseSelect.innerHTML = '<option value="" disabled ' + ((prevValue && list.includes(prevValue)) ? 'hidden' : 'selected hidden') + '>Select Database...</option>' +
			list.map(db => {
				const esc = (typeof escapeHtml === 'function') ? escapeHtml(db) : db;
				return '<option value="' + esc + '">' + esc + '</option>';
			}).join('');
		databaseSelect.disabled = false;
		try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }

		// Update local cache with new databases
		const connectionId = document.getElementById(boxId + '_connection').value;
		if (connectionId) {
			let clusterKey = '';
			try {
				const cid = String(connectionId || '').trim();
				const conn = Array.isArray(connections) ? connections.find(c => c && String(c.id || '').trim() === cid) : null;
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
			cachedDatabases[String(clusterKey || '').trim()] = list;
		}

		// Prefer per-box desired selection (restore), else keep existing, else last selection.
		let desired = '';
		try {
			desired = (databaseSelect.dataset && databaseSelect.dataset.desired)
				? String(databaseSelect.dataset.desired || '')
				: '';
		} catch { /* ignore */ }

		const desiredInList = !!(desired && list.includes(desired));
		let target = '';
		if (desired) {
			// When a favorite/restore is trying to pick a specific DB, never silently fall back
			// to a previous/last DB (that can cause runs to hit the wrong database/cluster).
			if (desiredInList) {
				target = desired;
			} else {
				target = '';
			}
		} else {
			// Normal behavior for manual selection.
			target = (prevValue && list.includes(prevValue))
				? prevValue
				: (lastDatabase && list.includes(lastDatabase))
					? lastDatabase
					: '';
		}

		if (target) {
			databaseSelect.value = target;
		}
		try { window.__kustoDropdown && window.__kustoDropdown.syncSelectBackedDropdown && window.__kustoDropdown.syncSelectBackedDropdown(boxId + '_database'); } catch { /* ignore */ }
		__kustoLog(boxId, 'db.select', 'Resolved database selection', {
			connectionId: document.getElementById(boxId + '_connection') ? document.getElementById(boxId + '_connection').value : '',
			desired,
			desiredInList,
			prevValue,
			target,
			listCount: list.length
		});
		// If we successfully applied the desired selection, clear the desired marker and refresh-attempt flag.
		try {
			if (desired && target === desired) {
				delete databaseSelect.dataset.desired;
				delete databaseSelect.dataset.kustoDesiredRefreshAttempted;
			}
		} catch { /* ignore */ }

		// If we couldn't find the desired DB, auto-refresh the DB list once.
		try {
			if (desired && !desiredInList && databaseSelect.dataset) {
				const attempted = databaseSelect.dataset.kustoDesiredRefreshAttempted === '1';
				if (!attempted) {
					databaseSelect.dataset.kustoDesiredRefreshAttempted = '1';
					// Kick a refresh; keep selection empty until the real list arrives.
					__kustoLog(boxId, 'db.refresh', 'Desired DB missing; auto-refreshing databases once', { desired, connectionId: document.getElementById(boxId + '_connection') ? document.getElementById(boxId + '_connection').value : '' }, 'warn');
					try { refreshDatabases(boxId); } catch { /* ignore */ }
				}
			}
		} catch { /* ignore */ }

		// Only trigger schema refresh if the selected DB actually changed.
		try { __kustoTryAutoEnterFavoritesModeForNewBox(boxId); } catch { /* ignore */ }
		if (target && target !== prevValue) {
			onDatabaseChanged(boxId);
		}
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
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
		}
	} catch { /* ignore */ }
}

function __kustoIsValidConnectionIdForRun(connectionId) {
	const cid = String(connectionId || '').trim();
	if (!cid) return false;
	if (cid === '__enter_new__' || cid === '__import_xml__') return false;
	return true;
}

function __kustoGetEffectiveSelectionOwnerIdForRun(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof window.__kustoGetSelectionOwnerBoxId === 'function') {
			return String(window.__kustoGetSelectionOwnerBoxId(id) || id).trim();
		}
	} catch { /* ignore */ }
	return id;
}

function __kustoIsRunSelectionReady(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return false;

	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);

	// If a favorites selection is still staging/applying, don't allow Run.
	try {
		const pending1 = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[id]);
		const pending2 = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[ownerId]);
		if (pending1 || pending2) {
			return false;
		}
	} catch { /* ignore */ }

	const connEl = document.getElementById(ownerId + '_connection');
	const dbEl = document.getElementById(ownerId + '_database');
	const connectionId = connEl ? String(connEl.value || '').trim() : '';
	const database = dbEl ? String(dbEl.value || '').trim() : '';

	if (!__kustoIsValidConnectionIdForRun(connectionId)) return false;
	if (!database) return false;

	// If DB selection is still being resolved (favorites/restore), block Run.
	try {
		const desiredPending = !!(dbEl && dbEl.dataset && String(dbEl.dataset.desired || '').trim());
		if (desiredPending) return false;
	} catch { /* ignore */ }
	try {
		if (dbEl && dbEl.disabled) return false;
	} catch { /* ignore */ }

	return true;
}

function __kustoHasValidFavoriteSelection(ownerBoxId) {
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

function __kustoClearSchemaSummaryIfNoSelection(boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);
	let connectionId = '';
	let database = '';
	try {
		const connEl = document.getElementById(ownerId + '_connection');
		connectionId = connEl ? String(connEl.value || '').trim() : '';
		const dbEl = document.getElementById(ownerId + '_database');
		database = dbEl ? String(dbEl.value || '').trim() : '';
	} catch {
		connectionId = '';
		database = '';
	}

	// If neither a database nor a favorite is selected, blank the schema summary to avoid stale counts.
	const hasValidCluster = typeof __kustoIsValidConnectionIdForRun === 'function'
		? __kustoIsValidConnectionIdForRun(connectionId)
		: !!connectionId;
	const shouldClear = ((!hasValidCluster || !database) && !__kustoHasValidFavoriteSelection(ownerId));

	// Keep the schema refresh button in sync: hide it when selection isn't valid.
	try {
		const btn = document.getElementById(id + '_schema_refresh');
		if (btn) {
			btn.style.display = shouldClear ? 'none' : '';
		}
	} catch { /* ignore */ }

	if (shouldClear) {
		try {
			if (schemaByBoxId) {
				delete schemaByBoxId[id];
			}
		} catch { /* ignore */ }
		try {
			if (typeof setSchemaLoadedSummary === 'function') {
				setSchemaLoadedSummary(id, '', '', false);
			}
		} catch { /* ignore */ }
	}
}

window.__kustoUpdateRunEnabledForBox = function (boxId) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const runBtn = document.getElementById(id + '_run_btn');
	const runToggle = document.getElementById(id + '_run_toggle');
	const disabledTooltip = 'Select a cluster and database first (or select a favorite)';

	// If a query is currently executing for this box, keep disabled.
	try {
		if (queryExecutionTimers && queryExecutionTimers[id]) {
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

window.__kustoUpdateRunEnabledForAllBoxes = function () {
	try {
		for (const id of (queryBoxes || [])) {
			try { window.__kustoUpdateRunEnabledForBox(id); } catch { /* ignore */ }
		}
	} catch { /* ignore */ }
};

function __kustoApplyRunModeFromMenu(boxId, mode) {
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

function getRunMode(boxId) {
	return runModesByBoxId[boxId] || 'take100';
}

function getRunModeLabelText(mode) {
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

function setRunMode(boxId, mode) {
	runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn');
	if (runBtn) {
		const labelSpan = runBtn.querySelector('.run-btn-label');
		const labelText = getRunModeLabelText(runModesByBoxId[boxId]);
		if (labelSpan) {
			labelSpan.textContent = ' ' + labelText;
		}
		// Update tooltip
		const isEnabled = !runBtn.disabled;
		runBtn.title = labelText + (isEnabled ? '' : '\nSelect a cluster and database first (or select a favorite)');
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function closeRunMenu(boxId) {
	const menu = document.getElementById(boxId + '_run_menu');
	if (menu) {
		menu.style.display = 'none';
	}
}

function closeAllRunMenus() {
	queryBoxes.forEach(id => closeRunMenu(id));
}

function toggleRunMenu(boxId) {
	const menu = document.getElementById(boxId + '_run_menu');
	if (!menu) {
		return;
	}
	const next = menu.style.display === 'block' ? 'none' : 'block';
	closeAllRunMenus();
	menu.style.display = next;
}

const __kustoEventIsInsideDropdownUi = (ev) => {
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

document.addEventListener('click', (ev) => {
	// Clicking inside a dropdown should not dismiss it.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { window.__kustoDropdown && window.__kustoDropdown.closeAllMenus && window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
});

// Close dropdowns on scroll/wheel so they don't float detached from their buttons.
document.addEventListener('scroll', (ev) => {
	// The dropdown menus themselves are scrollable; do not dismiss on internal menu scroll.
	try {
		const target = ev && ev.target ? ev.target : null;
		if (target && target.closest && (target.closest('.kusto-dropdown-menu') || target.closest('.kusto-favorites-menu'))) {
			return;
		}
	} catch { /* ignore */ }
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { window.__kustoDropdown && window.__kustoDropdown.closeAllMenus && window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
}, true); // Use capture to catch scroll events on nested scrollable elements

document.addEventListener('wheel', (ev) => {
	// Allow scrolling inside dropdown menus without dismissing them.
	if (__kustoEventIsInsideDropdownUi(ev)) return;
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { window.__kustoDropdown && window.__kustoDropdown.closeAllMenus && window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
}, { passive: true });

function formatElapsed(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	const tenths = Math.floor((ms % 1000) / 100);
	return minutes + ':' + seconds.toString().padStart(2, '0') + '.' + tenths;
}

function setQueryExecuting(boxId, executing) {
	const runBtn = document.getElementById(boxId + '_run_btn');
	const runToggle = document.getElementById(boxId + '_run_toggle');
	const status = document.getElementById(boxId + '_exec_status');
	const elapsed = document.getElementById(boxId + '_exec_elapsed');
	const cancelBtn = document.getElementById(boxId + '_cancel_btn');

	if (queryExecutionTimers[boxId]) {
		clearInterval(queryExecutionTimers[boxId]);
		delete queryExecutionTimers[boxId];
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
			elapsed.textContent = '0:00.0';
		}

		const start = performance.now();
		queryExecutionTimers[boxId] = setInterval(() => {
			if (elapsed) {
				elapsed.textContent = formatElapsed(performance.now() - start);
			}
		}, 100);
		return;
	}

	try {
		if (typeof window.__kustoUpdateRunEnabledForBox === 'function') {
			window.__kustoUpdateRunEnabledForBox(boxId);
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

function cancelQuery(boxId) {
	try {
		const cancelBtn = document.getElementById(boxId + '_cancel_btn');
		if (cancelBtn) {
			cancelBtn.disabled = true;
		}
	} catch {
		// ignore
	}
	try {
		vscode.postMessage({ type: 'cancelQuery', boxId: boxId });
	} catch {
		// ignore
	}
}

function executeQuery(boxId, mode) {
	const effectiveMode = mode || getRunMode(boxId);
	try {
		if (typeof window.__kustoClearAutoFindInQueryEditor === 'function') {
			window.__kustoClearAutoFindInQueryEditor(boxId);
		}
	} catch { /* ignore */ }
	const __kustoExtractStatementAtCursor = (editor) => {
		try {
			if (typeof window.__kustoExtractStatementTextAtCursor === 'function') {
				return window.__kustoExtractStatementTextAtCursor(editor);
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
			const blocks = [];
			let inBlock = false;
			let startLine = 1;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
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

			const block = blocks.find(b => cursorLine >= b.startLine && cursorLine <= b.endLine);
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

	const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	// If the cursor is inside the active Monaco editor, run only the statement under the cursor.
	try {
		const isActiveEditor = (typeof activeQueryEditorBoxId !== 'undefined') && (activeQueryEditorBoxId === boxId);
		const hasTextFocus = !!(editor && typeof editor.hasTextFocus === 'function' && editor.hasTextFocus());
		if (editor && (hasTextFocus || isActiveEditor)) {
			const statement = __kustoExtractStatementAtCursor(editor);
			if (statement) {
				query = statement;
			} else {
				try {
					vscode.postMessage({
						type: 'showInfo',
						message: 'Place the cursor inside a query statement (not on a separator) to run that statement.'
					});
				} catch { /* ignore */ }
				return;
			}
		}
	} catch { /* ignore */ }
	let connectionId = document.getElementById(boxId + '_connection').value;
	let database = document.getElementById(boxId + '_database').value;
	let cacheEnabled = document.getElementById(boxId + '_cache_enabled').checked;
	const cacheValue = parseInt(document.getElementById(boxId + '_cache_value').value) || 1;
	const cacheUnit = document.getElementById(boxId + '_cache_unit').value;

	let sourceBoxIdForComparison = '';
	let isComparisonBox = false;

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				isComparisonBox = true;
				sourceBoxIdForComparison = String(sourceBoxId || '');
				const sourceConn = document.getElementById(sourceBoxId + '_connection');
				const sourceDb = document.getElementById(sourceBoxId + '_database');
				if (sourceConn && sourceConn.value) {
					connectionId = sourceConn.value;
				}
				if (sourceDb && sourceDb.value) {
					database = sourceDb.value;
				}
			}
			// While linked optimization exists, always disable caching for benchmark runs.
			const hasLinkedOptimization = !!(meta && meta.isComparison)
				|| !!(optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].comparisonBoxId);
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
			const cacheMap = window.__kustoLastRunCacheEnabledByBoxId;
			const sourceLastRunUsedCaching = !!(cacheMap && typeof cacheMap === 'object' && cacheMap[sourceBoxIdForComparison]);
			if (sourceLastRunUsedCaching) {
				// Prevent transient comparisons against stale cached source results.
				try {
					if (window.__kustoResultsByBoxId && typeof window.__kustoResultsByBoxId === 'object') {
						delete window.__kustoResultsByBoxId[sourceBoxIdForComparison];
					}
				} catch { /* ignore */ }
				try {
					__kustoLog(boxId, 'run.compare.rerunSourceNoCache', 'Rerunning source query with caching disabled', {
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
		const pending = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[boxId]);
		const dbEl = document.getElementById(boxId + '_database');
		const desiredPending = !!(dbEl && dbEl.dataset && dbEl.dataset.desired);
		const dbDisabled = !!(dbEl && dbEl.disabled);
		if (pending || desiredPending || dbDisabled) {
			__kustoLog(boxId, 'run.blocked', 'Blocked run because selection is still updating', {
				pending,
				desiredPending,
				dbDisabled,
				connectionId,
				database
			}, 'warn');
			try { vscode.postMessage({ type: 'showInfo', message: 'Waiting for the selected favorite to finish applying (loading databases/schema). Try Run again in a moment.' }); } catch { /* ignore */ }
			return;
		}
	} catch { /* ignore */ }

	if (!query.trim()) {
		return;
	}

	if (!connectionId) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch { /* ignore */ }
		return;
	}
	if (!database) {
		try { vscode.postMessage({ type: 'showInfo', message: 'Please select a database' }); } catch { /* ignore */ }
		return;
	}
	__kustoLog(boxId, 'run.start', 'Executing query', { connectionId, database, queryMode: effectiveMode });

	setQueryExecuting(boxId, true);
	closeRunMenu(boxId);

	// Track the effective cacheEnabled value for this run.
	// When caching is enabled, the extension injects an extra (hidden) first line,
	// so error line numbers need to be adjusted for the visible editor.
	try {
		if (!window.__kustoLastRunCacheEnabledByBoxId || typeof window.__kustoLastRunCacheEnabledByBoxId !== 'object') {
			window.__kustoLastRunCacheEnabledByBoxId = {};
		}
		window.__kustoLastRunCacheEnabledByBoxId[boxId] = !!cacheEnabled;
	} catch { /* ignore */ }

	// Store the last executed box for result display
	window.lastExecutedBox = boxId;

	vscode.postMessage({
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
