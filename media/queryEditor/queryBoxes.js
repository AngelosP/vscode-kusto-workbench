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
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
		'<path d="M4 4h9" />' +
		'<path d="M4 8h9" />' +
		'<path d="M4 12h9" />' +
		'<path d="M2.5 4h.2" />' +
		'<path d="M2.5 8h.2" />' +
		'<path d="M2.5 12h.2" />' +
		'</svg>';

	const closeIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M4 4l8 8"/>' +
		'<path d="M12 4L4 12"/>' +
		'</svg>';

	const caretDocsIconSvg =
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
		'<path d="M3 3.5h10v7H8.2L6 13V10.5H3v-7z"/>' +
		'<path d="M5.2 5.6h5.6"/>' +
		'<path d="M5.2 7.8h4.2"/>' +
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
			'title="Run both queries to compare results. This will be enabled only when results match." aria-label="Accept Optimizations">Accept Optimizations</button>')
		: (
			'<span class="optimize-inline" id="' + id + '_optimize_inline">' +
				'<button class="optimize-query-btn" id="' + id + '_optimize_btn" onclick="optimizeQueryWithCopilot(\'' + id + '\')" ' +
					'title="Optimize query performance" aria-label="Optimize query performance with Copilot">' +
					copilotLogoHtml +
				'</button>' +
				'<span class="optimize-status" id="' + id + '_optimize_status" style="display:none;"></span>' +
				'<button type="button" class="optimize-cancel-btn" id="' + id + '_optimize_cancel" style="display:none;" onclick="__kustoCancelOptimizeQuery(\'' + id + '\')" title="Cancel optimization" aria-label="Cancel optimization">Cancel</button>' +
			'</span>'
		);
	const toolbarHtml =
		'<div class="query-editor-toolbar" role="toolbar" aria-label="Editor tools">' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'prettify\')" title="Prettify query\nApplies Kusto-aware formatting rules (summarize/where/function headers)">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'doubleToSingle\')" title="Replace &quot; with &#39;\nReplaces all double quotes with single quotes">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleToDouble\')" title="Replace &#39; with &quot;\nReplaces all single quotes with double quotes">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'search\')" title="Search\nFind in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M6.5 2a4.5 4.5 0 1 0 2.67 8.13l3.02 3.02a.75.75 0 0 0 1.06-1.06l-3.02-3.02A4.5 4.5 0 0 0 6.5 2zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'replace\')" title="Search and replace\nFind and replace in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M2.5 4.5h8V3l3 2.5-3 2.5V6.5h-8v-2zM13.5 11.5h-8V13l-3-2.5 3-2.5v1.5h8v2z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" id="' + id + '_autocomplete_btn" data-qe-action="autocomplete" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'autocomplete\')" title="Trigger autocomplete\nShortcut: Ctrl+Space" aria-label="Trigger autocomplete (Ctrl+Space)">' +
		'<span class="qe-icon" aria-hidden="true">' + autocompleteIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_caret_docs_toggle" class="query-editor-toolbar-btn query-editor-toolbar-toggle' + (caretDocsEnabled ? ' is-active' : '') + '" onclick="toggleCaretDocsEnabled()" title="Smart documentation tooltips\nShows Kusto documentation as you move the cursor" aria-pressed="' + (caretDocsEnabled ? 'true' : 'false') + '">' +
		'<span class="qe-icon" aria-hidden="true">' + caretDocsIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_copilot_chat_toggle" class="query-editor-toolbar-btn query-editor-toolbar-toggle kusto-copilot-chat-toggle" onclick="__kustoToggleCopilotChatForBox(\'' + id + '\')" title="Copilot chat\nGenerate and run a query with GitHub Copilot" aria-pressed="false" aria-label="Toggle Copilot chat" disabled aria-disabled="true" data-kusto-disabled-by-copilot="1">' +
		'<span class="qe-icon" aria-hidden="true">' + copilotLogoHtml + '</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" class="query-editor-toolbar-btn" data-qe-action="qualifyTables" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'qualifyTables\')" title="Fully qualify tables\nEnsures table references are fully qualified as cluster(\'...\').database(\'...\').Table" aria-label="Fully qualify tables">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'singleLine\')" title="Copy query as single line\nCopies a single-line version to your clipboard (does not modify the editor)">' +
		'<span class="qe-icon" aria-hidden="true">' + singleLineIconSvg + '</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'exportPowerBI\')" title="Export to Power BI\nCopies a Power Query (M) snippet to your clipboard for pasting into Power BI">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="10" width="3" height="4"/><rect x="6" y="6" width="3" height="8"/><rect x="10" y="3" width="3" height="11"/></svg>' +
		'</span>' +
		'</button>' +
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
		'<button class="md-tab md-max-btn" id="' + id + '_max" type="button" onclick="__kustoMaximizeQueryBox(\'' + id + '\')" title="Maximize" aria-label="Maximize">' + maximizeIconSvg + '</button>' +
		'<button class="md-tab" id="' + id + '_toggle" type="button" role="tab" aria-selected="false" onclick="toggleQueryBoxVisibility(\'' + id + '\')" title="Hide" aria-label="Hide">' + previewIconSvg + '</button>' +
		'</div>' +
		'<button class="refresh-btn close-btn" onclick="removeQueryBox(\'' + id + '\')" title="Remove query box" aria-label="Remove query box">' + closeIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-header-row query-header-row-bottom">' +
		(favoritesDropdownHtml ||
			('<div class="kusto-favorites-combo select-wrapper" id="' + id + '_favorites_wrapper" style="display:none;" title="Favorites">' +
			'<button type="button" class="kusto-favorites-btn" id="' + id + '_favorites_btn" onclick="toggleFavoritesDropdown(\'' + id + '\'); event.stopPropagation();" aria-haspopup="listbox" aria-expanded="false">' +
			'<span class="kusto-favorites-btn-text" id="' + id + '_favorites_btn_text">Select favorite...</span>' +
			'<span class="kusto-favorites-btn-caret" aria-hidden="true">▾</span>' +
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
		'<button class="refresh-btn" onclick="refreshDatabases(\'' + id + '\')" id="' + id + '_refresh" title="Refresh database list" aria-label="Refresh database list">' + refreshIconSvg + '</button>' +
		'<button class="refresh-btn favorite-btn" onclick="toggleFavoriteForBox(\'' + id + '\')" id="' + id + '_favorite_toggle" title="Add to favorites" aria-label="Add to favorites">' + favoriteStarIconSvg + '</button>' +
		'<button class="refresh-btn favorites-show-btn" onclick="toggleFavoritesMode(\'' + id + '\')" id="' + id + '_favorites_show" title="Show favorites" aria-label="Show favorites" style="display:none;">' + favoritesListIconSvg + '</button>' +
		'<div class="schema-area" aria-label="Schema status">' +
		'<span class="schema-status" id="' + id + '_schema_status" style="display: none;" title="Loading schema for autocomplete...">' +
		'<span class="schema-spinner" aria-hidden="true"></span>' +
		'<span>Schema…</span>' +
		'</span>' +
		'<span class="schema-loaded" id="' + id + '_schema_loaded" style="display: none;"></span>' +
		'<button class="refresh-btn" onclick="refreshSchema(\'' + id + '\')" id="' + id + '_schema_refresh" title="Refresh schema" aria-label="Refresh schema">' + refreshIconSvg + '</button>' +
		'</div>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor-wrapper">' +
		toolbarHtml +
		'<div class="qe-caret-docs-banner" id="' + id + '_caret_docs" style="display:none;" role="status" aria-live="polite">' +
		'<div class="qe-caret-docs-text" id="' + id + '_caret_docs_text"></div>' +
		'</div>' +
		'<div class="qe-missing-clusters-banner" id="' + id + '_missing_clusters" style="display:none;" role="status" aria-live="polite">' +
		'<div class="qe-missing-clusters-text" id="' + id + '_missing_clusters_text"></div>' +
		'<div class="qe-missing-clusters-actions">' +
		'<button type="button" class="qe-missing-clusters-btn" onclick="addMissingClusterConnections(\'' + id + '\')">Add connections</button>' +
		'</div>' +
		'</div>' +
		'<div class="query-editor" id="' + id + '_query_editor"></div>' +
		'<div class="query-editor-placeholder" id="' + id + '_query_placeholder">Enter your KQL query here...</div>' +
		'<div class="query-editor-resizer" id="' + id + '_query_resizer" title="Drag to resize editor"></div>' +
		'</div>' +
		'<div class="query-actions">' +
		'<div class="query-run">' +
		'<div class="split-button" id="' + id + '_run_split">' +
		'<button class="split-main" id="' + id + '_run_btn" onclick="executeQuery(\'' + id + '\')">▶ Run Query (take 100)</button>' +
		'<button class="split-toggle" id="' + id + '_run_toggle" onclick="toggleRunMenu(\'' + id + '\'); event.stopPropagation();" aria-label="Run query options">▾</button>' +
		'<div class="split-menu" id="' + id + '_run_menu" role="menu">' +
		'<div class="split-menu-item" role="menuitem" onclick="setRunMode(\'' + id + '\', \'plain\'); executeQuery(\'' + id + '\'); closeRunMenu(\'' + id + '\');">Run Query</div>' +
		'<div class="split-menu-item" role="menuitem" onclick="setRunMode(\'' + id + '\', \'take100\'); executeQuery(\'' + id + '\'); closeRunMenu(\'' + id + '\');">Run Query (take 100)</div>' +
		'<div class="split-menu-item" role="menuitem" onclick="setRunMode(\'' + id + '\', \'sample100\'); executeQuery(\'' + id + '\'); closeRunMenu(\'' + id + '\');">Run Query (sample 100)</div>' +
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
		'<div class="optimize-config" id="' + id + '_optimize_config" style="display: none;"></div>' +
		'<div class="results-wrapper" id="' + id + '_results_wrapper" style="display: none;">' +
		'<div class="results" id="' + id + '_results"></div>' +
		'<div class="query-editor-resizer" id="' + id + '_results_resizer" title="Drag to resize results"></div>' +
		'</div>' +
		'</div>';

	container.insertAdjacentHTML('beforeend', boxHtml);
	try { updateCaretDocsToggleButtons(); } catch { /* ignore */ }
	setRunMode(id, 'take100');
	updateConnectionSelects();
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
	try { wrapper.style.height = '900px'; } catch { /* ignore */ }
	try { if (wrapper.dataset) wrapper.dataset.kustoUserResized = 'true'; } catch { /* ignore */ }
	try {
		const ed = (typeof queryEditors === 'object' && queryEditors) ? queryEditors[id] : null;
		if (ed && typeof ed.layout === 'function') {
			ed.layout();
		}
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
	try {
		if (cell === null || cell === undefined) return ['n', null];
		const t = typeof cell;
		if (t === 'string' || t === 'number' || t === 'boolean') return ['p', t, cell];
		if (t !== 'object') return ['p', t, String(cell)];
		// Common table-cell wrapper used by this webview.
		if ('display' in cell && 'full' in cell) {
			return ['h', String(cell.display), String(cell.full), !!cell.isObject];
		}
		return ['o', JSON.stringify(cell)];
	} catch {
		try { return ['o', String(cell)]; } catch { return ['o', '[uncomparable]']; }
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

function __kustoAreResultsEquivalent(sourceState, comparisonState) {
	try {
		const aCols = Array.isArray(sourceState && sourceState.columns) ? sourceState.columns : [];
		const bCols = Array.isArray(comparisonState && comparisonState.columns) ? comparisonState.columns : [];
		if (aCols.length !== bCols.length) return false;
		for (let i = 0; i < aCols.length; i++) {
			if (String(aCols[i]) !== String(bCols[i])) return false;
		}

		const aRows = Array.isArray(sourceState && sourceState.rows) ? sourceState.rows : [];
		const bRows = Array.isArray(comparisonState && comparisonState.rows) ? comparisonState.rows : [];
		if (aRows.length !== bRows.length) return false;

		// Compare as an unordered multiset of rows:
		// - row order may change
		// - but content and multiplicity must match
		const counts = new Map();
		for (const row of aRows) {
			const key = __kustoRowKeyForComparison(row);
			counts.set(key, (counts.get(key) || 0) + 1);
		}
		for (const row of bRows) {
			const key = __kustoRowKeyForComparison(row);
			const prev = counts.get(key) || 0;
			if (prev <= 0) {
				return false;
			}
			if (prev === 1) {
				counts.delete(key);
			} else {
				counts.set(key, prev - 1);
			}
		}
		if (counts.size !== 0) return false;
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
	btn.title = tooltip || (enabled ? 'Accept Optimizations' : 'Accept Optimizations is enabled only when results match.');
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
		// URL CSV: make the outer URL section auto-fit its contents (no slack) when
		// hiding/showing results.
		try {
			const urlWrapper = document.getElementById(boxId + '_wrapper');
			const urlContent = document.getElementById(boxId + '_content');
			if (urlWrapper && urlContent && urlContent.classList && urlContent.classList.contains('url-csv-mode')) {
				// When hiding results, always collapse to minimal height.
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
					urlWrapper.style.height = 'auto';
					urlWrapper.style.minHeight = '0';
				} else {
					// Showing results: restore prior user height if present, otherwise auto-fit.
					try {
						if (userResized) {
							const prev = (urlWrapper.dataset && urlWrapper.dataset.kustoPrevHeight) ? String(urlWrapper.dataset.kustoPrevHeight) : '';
							if (prev && prev !== 'auto') {
								urlWrapper.style.height = prev;
							}
							urlWrapper.style.minHeight = '';
							try {
								setTimeout(() => {
									try {
										if (typeof window.__kustoClampUrlCsvWrapperHeight === 'function') {
											window.__kustoClampUrlCsvWrapperHeight(boxId);
										}
									} catch { /* ignore */ }
								}, 0);
							} catch { /* ignore */ }
						} else {
							urlWrapper.style.height = 'auto';
							urlWrapper.style.minHeight = '0';
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
			const watermarkTitle = 'Smart documentation tooltips';
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

function setToolbarActionBusy(boxId, action, busy) {
	try {
		const root = document.getElementById(boxId);
		if (!root) return;
		const btn = root.querySelector('.query-editor-toolbar-btn[data-qe-action="' + action + '"]');
		if (!btn) return;
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
	} catch {
		// ignore
	}
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
	const query = model.getValue() || '';
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		alert('Please select a cluster connection');
		return;
	}
	if (!database) {
		alert('Please select a database');
		return;
	}
	const conn = (connections || []).find(c => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		alert('Selected connection is missing a cluster URL');
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
		alert('Failed to copy Power BI query to clipboard.');
	}
}

function displayComparisonSummary(sourceBoxId, comparisonBoxId) {
	const sourceState = __kustoGetResultsState(sourceBoxId);
	const comparisonState = __kustoGetResultsState(comparisonBoxId);
	
	if (!sourceState || !comparisonState) {
		return;
	}
	
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
	const rowsMatch = sourceRows === comparisonRows;
	const colsMatch = sourceCols === comparisonCols;
	const deepMatch = __kustoAreResultsEquivalent(sourceState, comparisonState);
	
	let dataMessage = '';
	if (deepMatch) {
		dataMessage = '<span style="color: #89d185;">\u2713 Data matches (row order ignored)</span>';
	} else {
		const parts = [];
		if (!rowsMatch) {
			parts.push(`rows: ${sourceRows} \u2192 ${comparisonRows}`);
		}
		if (!colsMatch) {
			parts.push(`columns: ${sourceCols} \u2192 ${comparisonCols}`);
		}
		dataMessage = `<span style="color: #f48771;">\u26a0 Data differs${parts.length ? (' (' + parts.join(', ') + ')') : ''}</span>`;
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
			<strong>\ud83d\udcca Optimization Comparison</strong>
			<div class="comparison-metrics">
				<div class="comparison-metric">\u26a1 Performance: ${perfMessage}</div>
				<div class="comparison-metric">\ud83d\udccb Data: ${dataMessage}</div>
			</div>
		</div>
	`;
	try {
		if (deepMatch) {
			__kustoUpdateAcceptOptimizationsButton(comparisonBoxId, true, 'Results match. Accept optimizations.');
		} else {
			__kustoUpdateAcceptOptimizationsButton(comparisonBoxId, false, 'Results differ. Accept optimizations is disabled.');
		}
	} catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(comparisonBoxId); } catch { /* ignore */ }
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
		alert('Optimization request is no longer available. Please try again.');
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}

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
		alert('Failed to start query optimization');
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

async function optimizeQueryWithCopilot(boxId) {
	const editor = queryEditors[boxId];
	if (!editor) {
		return;
	}
	const model = editor.getModel();
	if (!model) {
		return;
	}
	
	// Check if optimization is already in progress
	const optimizeBtn = document.getElementById(boxId + '_optimize_btn');
	if (optimizeBtn && optimizeBtn.disabled) {
		console.log('Optimization already in progress for box:', boxId);
		return;
	}

	// Hide results to keep the UI focused during optimization.
	try { __kustoSetResultsVisible(boxId, false); } catch { /* ignore */ }
	
	const query = model.getValue() || '';
	if (!query.trim()) {
		alert('No query to optimize');
		return;
	}
	
	const connectionId = (document.getElementById(boxId + '_connection') || {}).value || '';
	const database = (document.getElementById(boxId + '_database') || {}).value || '';
	if (!connectionId) {
		alert('Please select a cluster connection');
		return;
	}
	if (!database) {
		alert('Please select a database');
		return;
	}

	// Check if query has a name, if not, set one
	const nameInput = document.getElementById(boxId + '_name');
	let queryName = nameInput ? nameInput.value.trim() : '';
	if (!queryName) {
		// Generate a random funny name
		const adjectives = ['Sneaky', 'Dizzy', 'Bouncy', 'Grumpy', 'Fancy', 'Zippy', 'Wobbly', 'Quirky', 'Sleepy', 'Dancing', 'Giggling', 'Hungry', 'Sparkly', 'Fuzzy', 'Clever', 'Mighty', 'Turbo', 'Cosmic', 'Ninja', 'Jolly'];
		const nouns = ['Penguin', 'Octopus', 'Banana', 'Unicorn', 'Dragon', 'Waffle', 'Narwhal', 'Llama', 'Hedgehog', 'Platypus', 'Flamingo', 'Koala', 'Pineapple', 'Dolphin', 'Raccoon', 'Capybara', 'Axolotl', 'Toucan', 'Gecko', 'Otter'];
		const randomAdj = adjectives[Math.floor(Math.random() * adjectives.length)];
		const randomNoun = nouns[Math.floor(Math.random() * nouns.length)];
		const randomNum = Math.floor(Math.random() * 1000);
		queryName = `${randomAdj} ${randomNoun} ${randomNum}`;
		if (nameInput) {
			nameInput.value = queryName;
			try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
		}
	}

	// Store pending request and ask the extension for available models + default prompt.
	try {
		const pending = __kustoEnsureOptimizePrepByBoxId();
		pending[boxId] = { query, connectionId, database, queryName };
	} catch { /* ignore */ }

	if (optimizeBtn) {
		optimizeBtn.disabled = true;
	}
	__kustoShowOptimizePromptLoading(boxId);

	try {
		vscode.postMessage({
			type: 'prepareOptimizeQuery',
			boxId,
			query
		});
	} catch (err) {
		console.error('Error requesting optimize options:', err);
		alert('Failed to prepare query optimization');
		__kustoHideOptimizePromptForBox(boxId);
	}
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
		alert('Please select a cluster connection');
		return;
	}
	if (!database) {
		alert('Please select a database');
		return;
	}
	const conn = (connections || []).find(c => c && c.id === connectionId);
	const clusterUrl = conn ? (conn.clusterUrl || '') : '';
	if (!clusterUrl) {
		alert('Selected connection is missing a cluster URL');
		return;
	}

	const currentSchema = schemaByBoxId ? schemaByBoxId[boxId] : null;
	const currentTables = currentSchema && Array.isArray(currentSchema.tables) ? currentSchema.tables : null;
	if (!currentTables || currentTables.length === 0) {
		// Best-effort: request schema fetch and ask the user to retry.
		try { ensureSchemaForBox(boxId); } catch { /* ignore */ }
		alert('Schema not loaded yet. Wait for “Schema loaded” then try again.');
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
	const clusterWrap = document.getElementById(boxId + '_connection')
		? document.getElementById(boxId + '_connection').closest('.select-wrapper')
		: null;
	const dbWrap = document.getElementById(boxId + '_database')
		? document.getElementById(boxId + '_database').closest('.select-wrapper')
		: null;
	const refreshBtn = document.getElementById(boxId + '_refresh');

	if (enabled) {
		__kustoSetElementDisplay(clusterWrap, 'none');
		__kustoSetElementDisplay(dbWrap, 'none');
		__kustoSetElementDisplay(refreshBtn, 'none');
		// In favorites mode, hide the "add/remove favorite" star button (applies only when selecting cluster+db).
		__kustoSetElementDisplay(favToggleBtn, 'none');
		__kustoSetElementDisplay(favWrap, 'flex');
		try { renderFavoritesMenuForBox(boxId); } catch { /* ignore */ }
	} else {
		__kustoSetElementDisplay(favWrap, 'none');
		__kustoSetElementDisplay(clusterWrap, 'flex');
		__kustoSetElementDisplay(dbWrap, 'flex');
		__kustoSetElementDisplay(refreshBtn, 'flex');
		__kustoSetElementDisplay(favToggleBtn, 'flex');
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

	try { window.__kustoUpdateFavoritesUiForAllBoxes(); } catch { /* ignore */ }
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
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
}

function updateDatabaseField(boxId) {
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
		alert('Failed to open file picker: ' + (e && e.message ? e.message : String(e)));
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
	try {
		const databaseSelect = document.getElementById(boxId + '_database');
		const refreshBtn = document.getElementById(boxId + '_refresh');
		if (databaseSelect) {
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
				if (refreshBtn.dataset && refreshBtn.dataset.kustoRefreshDbInFlight === '1') {
					const prev = refreshBtn.dataset.kustoPrevHtml;
					if (typeof prev === 'string' && prev) {
						refreshBtn.innerHTML = prev;
					}
					try { delete refreshBtn.dataset.kustoPrevHtml; } catch { /* ignore */ }
					try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch { /* ignore */ }
				}
				refreshBtn.removeAttribute('aria-busy');
			} catch { /* ignore */ }
			refreshBtn.disabled = false;
		}
	} catch {
		// ignore
	}
	try {
		if (typeof window.__kustoDisplayBoxError === 'function') {
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
		if (target && target !== prevValue) {
			onDatabaseChanged(boxId);
		}
	}
	if (refreshBtn) {
		try {
			if (refreshBtn.dataset && refreshBtn.dataset.kustoRefreshDbInFlight === '1') {
				const prev = refreshBtn.dataset.kustoPrevHtml;
				if (typeof prev === 'string' && prev) {
					refreshBtn.innerHTML = prev;
				}
				try { delete refreshBtn.dataset.kustoPrevHtml; } catch { /* ignore */ }
				try { delete refreshBtn.dataset.kustoRefreshDbInFlight; } catch { /* ignore */ }
			}
			refreshBtn.removeAttribute('aria-busy');
		} catch { /* ignore */ }
		refreshBtn.disabled = false;
	}
	try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
}

function getRunMode(boxId) {
	return runModesByBoxId[boxId] || 'take100';
}

function getRunModeLabel(mode) {
	switch ((mode || '').toLowerCase()) {
		case 'plain':
			return '▶ Run Query';
		case 'sample100':
			return '▶ Run Query (sample 100)';
		case 'take100':
		default:
			return '▶ Run Query (take 100)';
	}
}

function setRunMode(boxId, mode) {
	runModesByBoxId[boxId] = (mode || 'take100');
	const runBtn = document.getElementById(boxId + '_run_btn');
	if (runBtn) {
		runBtn.textContent = getRunModeLabel(runModesByBoxId[boxId]);
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

document.addEventListener('click', () => {
	closeAllRunMenus();
	closeAllFavoritesDropdowns();
	try { window.__kustoDropdown && window.__kustoDropdown.closeAllMenus && window.__kustoDropdown.closeAllMenus(); } catch { /* ignore */ }
});

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

	if (runBtn) {
		runBtn.disabled = false;
	}
	if (runToggle) {
		runToggle.disabled = false;
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
	const query = queryEditors[boxId] ? queryEditors[boxId].getValue() : '';
	let connectionId = document.getElementById(boxId + '_connection').value;
	let database = document.getElementById(boxId + '_database').value;
	let cacheEnabled = document.getElementById(boxId + '_cache_enabled').checked;
	const cacheValue = parseInt(document.getElementById(boxId + '_cache_value').value) || 1;
	const cacheUnit = document.getElementById(boxId + '_cache_unit').value;

	// In optimized/comparison sections, inherit connection/database from the source box.
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
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
		alert('Please select a cluster connection');
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
