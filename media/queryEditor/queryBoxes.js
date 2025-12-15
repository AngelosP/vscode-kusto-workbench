function addQueryBox(options) {
	const id = (options && options.id) ? String(options.id) : ('query_' + Date.now());
	const initialQuery = (options && options.initialQuery) ? String(options.initialQuery) : '';
	const isComparison = !!(options && options.isComparison);
	const defaultResultsVisible = (options && typeof options.defaultResultsVisible === 'boolean') ? !!options.defaultResultsVisible : true;
	const defaultComparisonSummaryVisible = isComparison ? true : ((options && typeof options.defaultComparisonSummaryVisible === 'boolean') ? !!options.defaultComparisonSummaryVisible : true);
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
			'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
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
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6.5 2a4.5 4.5 0 1 1 2.78 8.04l3.09 3.09-1.06 1.06-3.09-3.09A4.5 4.5 0 0 1 6.5 2zm0 1.5a3 3 0 1 0 0 6 3 3 0 0 0 0-6z"/></svg>' +
		'</span>' +
		'</button>' +
		'<button type="button" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'replace\')" title="Search and replace\nFind and replace in the current query">' +
		'<span class="qe-icon" aria-hidden="true">' +
		'<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h7v2H3V3zm0 4h10v2H3V7zm0 4h6v2H3v-2z"/><path d="M12.5 2.5l1 1-2.5 2.5-1-1 2.5-2.5zM9 6l1 1-1 1-1-1 1-1z"/></svg>' +
		'</span>' +
		'</button>' +
		'<span class="query-editor-toolbar-sep" aria-hidden="true"></span>' +
		'<button type="button" id="' + id + '_autocomplete_btn" data-qe-action="autocomplete" class="query-editor-toolbar-btn" onclick="onQueryEditorToolbarAction(\'' + id + '\', \'autocomplete\')" title="Trigger autocomplete\nShortcut: Ctrl+Space" aria-label="Trigger autocomplete (Ctrl+Space)">' +
		'<span class="qe-icon" aria-hidden="true">' + autocompleteIconSvg + '</span>' +
		'</button>' +
		'<button type="button" id="' + id + '_caret_docs_toggle" class="query-editor-toolbar-btn query-editor-toolbar-toggle' + (caretDocsEnabled ? ' is-active' : '') + '" onclick="toggleCaretDocsEnabled()" title="Caret docs tooltip\nShows a persistent tooltip near the caret while typing" aria-pressed="' + (caretDocsEnabled ? 'true' : 'false') + '">' +
		'<span class="qe-icon" aria-hidden="true">' + caretDocsIconSvg + '</span>' +
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
	const boxHtml =
		'<div class="query-box' + (isComparison ? ' is-optimized-comparison' : '') + '" id="' + id + '">' +
		'<div class="query-header">' +
		'<div class="query-header-row query-header-row-top">' +
		'<input type="text" class="query-name" placeholder="Query Name (optional)" id="' + id + '_name" oninput="try{schedulePersist&&schedulePersist()}catch{}" />' +
		'<button class="refresh-btn close-btn" onclick="removeQueryBox(\'' + id + '\')" title="Remove query box" aria-label="Remove query box">' + closeIconSvg + '</button>' +
		'</div>' +
		'<div class="query-header-row query-header-row-bottom">' +
		'<div class="select-wrapper has-icon half-width" title="Kusto Cluster">' +
		'<span class="select-icon" aria-hidden="true">' + clusterIconSvg + '</span>' +
		'<select id="' + id + '_connection" onchange="updateDatabaseField(\'' + id + '\'); try{schedulePersist&&schedulePersist()}catch{}">' +
		'<option value="" disabled selected hidden>Select Cluster...</option>' +
		'</select>' +
		'</div>' +
		'<div class="select-wrapper has-icon half-width" title="Kusto Database">' +
		'<span class="select-icon" aria-hidden="true">' + databaseIconSvg + '</span>' +
		'<select id="' + id + '_database" onchange="onDatabaseChanged(\'' + id + '\'); try{schedulePersist&&schedulePersist()}catch{}">' +
		'<option value="" disabled selected hidden>Select Database...</option>' +
		'</select>' +
		'</div>' +
		'<button class="refresh-btn" onclick="refreshDatabases(\'' + id + '\')" id="' + id + '_refresh" title="Refresh database list" aria-label="Refresh database list">' + refreshIconSvg + '</button>' +
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
	initQueryEditor(id);

	// Default visibility state (results + comparison summary)
	try {
		if (!window.__kustoResultsVisibleByBoxId || typeof window.__kustoResultsVisibleByBoxId !== 'object') {
			window.__kustoResultsVisibleByBoxId = {};
		}
		window.__kustoResultsVisibleByBoxId[id] = defaultResultsVisible;
	} catch { /* ignore */ }
	try {
		if (!window.__kustoComparisonSummaryVisibleByBoxId || typeof window.__kustoComparisonSummaryVisibleByBoxId !== 'object') {
			window.__kustoComparisonSummaryVisibleByBoxId = {};
		}
		window.__kustoComparisonSummaryVisibleByBoxId[id] = isComparison ? true : defaultComparisonSummaryVisible;
	} catch { /* ignore */ }
	try { __kustoUpdateQueryResultsToggleButton(id); } catch { /* ignore */ }
	try { __kustoUpdateComparisonSummaryToggleButton(id); } catch { /* ignore */ }
	try { __kustoApplyResultsVisibility(id); } catch { /* ignore */ }
	try { __kustoApplyComparisonSummaryVisibility(id); } catch { /* ignore */ }

	// Drag handle resize for results output.
	try {
		const wrapper = document.getElementById(id + '_results_wrapper');
		const resizer = document.getElementById(id + '_results_resizer');
		if (wrapper && resizer) {
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

				const startY = e.clientY;
				const startHeight = wrapper.getBoundingClientRect().height;

				const onMove = (moveEvent) => {
					const delta = moveEvent.clientY - startY;
					const nextHeight = Math.max(120, Math.min(900, startHeight + delta));
					wrapper.style.height = nextHeight + 'px';
				};
				const onUp = () => {
					document.removeEventListener('mousemove', onMove, true);
					document.removeEventListener('mouseup', onUp, true);
					resizer.classList.remove('is-dragging');
					document.body.style.cursor = previousCursor;
					document.body.style.userSelect = previousUserSelect;
					try { schedulePersist && schedulePersist(); } catch { /* ignore */ }
				};

				document.addEventListener('mousemove', onMove, true);
				document.addEventListener('mouseup', onUp, true);
			});
		}
	} catch {
		// ignore
	}
	
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
		for (let r = 0; r < aRows.length; r++) {
			const ar = Array.isArray(aRows[r]) ? aRows[r] : [];
			const br = Array.isArray(bRows[r]) ? bRows[r] : [];
			if (ar.length !== br.length) return false;
			for (let c = 0; c < ar.length; c++) {
				const an = __kustoNormalizeCellForComparison(ar[c]);
				const bn = __kustoNormalizeCellForComparison(br[c]);
				if (JSON.stringify(an) !== JSON.stringify(bn)) return false;
			}
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
			resizer.style.display = visible ? '' : 'none';
		}
		try {
			if (!visible) {
				// Collapse to just the header (minimum height needed).
				if (wrapper.style.height && wrapper.style.height !== 'auto') {
					wrapper.dataset.kustoPreviousHeight = wrapper.style.height;
				}
				wrapper.style.height = 'auto';
				wrapper.style.minHeight = '0';
			} else {
				// Ensure a usable height when showing results.
				wrapper.style.minHeight = '120px';
				if (!wrapper.style.height || wrapper.style.height === 'auto') {
					if (wrapper.dataset.kustoPreviousHeight) {
						wrapper.style.height = wrapper.dataset.kustoPreviousHeight;
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
		dataMessage = '<span style="color: #89d185;">\u2713 Data matches: identical results</span>';
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

	const isIdentChar = (ch) => /[A-Za-z0-9_\-]/.test(ch);
	const currentTables = (opts.currentTables || []).map(t => String(t));
	const currentTableLower = new Set(currentTables.map(t => t.toLowerCase()));
	const skipNames = new Set();

	// Very small lexer to detect let bindings and collect identifiers.
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

	const candidates = [];
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
			const cached = cachedDatabases && cachedDatabases[String(connectionId || '').trim()];
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
};

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
				updateDatabaseField(id);
			} else if (!currentValue && lastConnectionId) {
				// Pre-fill with last selection if this is a new box.
				select.value = lastConnectionId;
				updateDatabaseField(id);
			} else if (currentValue && currentValue !== '__import_xml__' && currentValue !== '__enter_new__') {
				select.value = currentValue;
			}
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

	if (connectionId && databaseSelect) {
		// Check if we have cached databases for this connection
		const cached = cachedDatabases[connectionId];

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
		} else {
			// No cache, need to load from server
			let desired = '';
			try {
				desired = (databaseSelect.dataset && databaseSelect.dataset.desired)
					? String(databaseSelect.dataset.desired || '')
					: '';
			} catch { /* ignore */ }

			if (desired) {
				const esc = (typeof escapeHtml === 'function') ? escapeHtml(desired) : desired;
				databaseSelect.innerHTML =
					'<option value="" disabled hidden>Select Database...</option>' +
					'<option value="' + esc + '">' + esc + '</option>';
				databaseSelect.value = desired;
			} else {
				databaseSelect.innerHTML = '<option value="">Loading databases...</option>';
			}
			databaseSelect.disabled = true;
			if (refreshBtn) {
				refreshBtn.disabled = true;
			}

			// Start schema fetch immediately if we have a persisted DB selection.
			try {
				if (desired && typeof ensureSchemaForBox === 'function') {
					ensureSchemaForBox(boxId, false);
				}
			} catch {
				// ignore
			}

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
		const key = (r.clusterUrl || '').toLowerCase();
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
		databaseSelect.innerHTML = '<option value="">Refreshing...</option>';
		databaseSelect.disabled = true;
	}
	if (refreshBtn) {
		refreshBtn.disabled = true;
	}

	vscode.postMessage({
		type: 'refreshDatabases',
		connectionId: connectionId,
		boxId: boxId
	});
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

		// Update local cache with new databases
		const connectionId = document.getElementById(boxId + '_connection').value;
		if (connectionId) {
			cachedDatabases[connectionId] = list;
		}

		// Prefer per-box desired selection (restore), else keep existing, else last selection.
		let desired = '';
		try {
			desired = (databaseSelect.dataset && databaseSelect.dataset.desired)
				? String(databaseSelect.dataset.desired || '')
				: '';
		} catch { /* ignore */ }

		const target = (desired && list.includes(desired))
			? desired
			: (prevValue && list.includes(prevValue))
				? prevValue
				: (lastDatabase && list.includes(lastDatabase))
					? lastDatabase
					: '';

		if (target) {
			databaseSelect.value = target;
		}
		try { if (desired && target === desired) delete databaseSelect.dataset.desired; } catch { /* ignore */ }

		// Only trigger schema refresh if the selected DB actually changed.
		if (target && target !== prevValue) {
			onDatabaseChanged(boxId);
		}
	}
	if (refreshBtn) {
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

	if (!query.trim()) {
		return;
	}

	if (!connectionId) {
		alert('Please select a cluster connection');
		return;
	}

	setQueryExecuting(boxId, true);
	closeRunMenu(boxId);

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
