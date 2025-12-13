import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { KustoQueryClient } from './kustoClient';

/**
 * Provider for the custom Kusto query editor webview
 */
export class QueryEditorProvider {
	private panel?: vscode.WebviewPanel;
	private kustoClient: KustoQueryClient;
	private lastConnectionId?: string;
	private lastDatabase?: string;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager,
		private readonly context: vscode.ExtensionContext
	) {
		this.kustoClient = new KustoQueryClient();
		this.loadLastSelection();
	}

	openEditor() {
		// If we already have a panel, reveal it
		if (this.panel) {
			this.panel.reveal(vscode.ViewColumn.One);
			return;
		}

		// Create a new webview panel
		this.panel = vscode.window.createWebviewPanel(
			'kustoQueryEditor',
			'Kusto Query Editor',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				localResourceRoots: [this.extensionUri],
				retainContextWhenHidden: true
			}
		);

		this.panel.webview.html = this.getHtmlContent(this.panel.webview);

		// Handle messages from the webview
		this.panel.webview.onDidReceiveMessage(async (message) => {
			switch (message.type) {
				case 'getConnections':
					const connections = this.connectionManager.getConnections();
					this.panel?.webview.postMessage({
						type: 'connectionsData',
						connections,
						lastConnectionId: this.lastConnectionId,
						lastDatabase: this.lastDatabase
					});
					break;
				case 'getDatabases':
					await this.getDatabases(message.connectionId, message.boxId, false);
					break;
				case 'refreshDatabases':
					await this.getDatabases(message.connectionId, message.boxId, true);
					break;
				case 'executeQuery':
					this.saveLastSelection(message.connectionId, message.database);
					await this.executeQuery(message.query, message.connectionId, message.database, 
						message.cacheEnabled, message.cacheValue, message.cacheUnit);
					break;
			}
		});

		// Reset panel when disposed
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	private loadLastSelection() {
		this.lastConnectionId = this.context.globalState.get('kusto.lastConnectionId');
		this.lastDatabase = this.context.globalState.get('kusto.lastDatabase');
	}

	private async saveLastSelection(connectionId: string, database: string) {
		this.lastConnectionId = connectionId;
		this.lastDatabase = database;
		await this.context.globalState.update('kusto.lastConnectionId', connectionId);
		await this.context.globalState.update('kusto.lastDatabase', database);
	}

	private async getDatabases(connectionId: string, boxId: string, forceRefresh: boolean) {
		const connection = this.connectionManager.getConnections().find(c => c.id === connectionId);
		if (!connection) {
			return;
		}

		try {
			const databases = await this.kustoClient.getDatabases(connection, forceRefresh);
			this.panel?.webview.postMessage({
				type: 'databasesData',
				databases: databases,
				boxId: boxId
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Failed to fetch databases: ${errorMessage}`);
			this.panel?.webview.postMessage({
				type: 'databasesData',
				databases: [],
				boxId: boxId
			});
		}
	}

	private async executeQuery(query: string, connectionId: string, database?: string, 
		cacheEnabled?: boolean, cacheValue?: number, cacheUnit?: string) {
		const connection = this.connectionManager.getConnections().find(c => c.id === connectionId);
		
		if (!connection) {
			vscode.window.showErrorMessage('Connection not found');
			return;
		}

		if (!database) {
			vscode.window.showErrorMessage('Please select a database');
			return;
		}

		// Add cache directive if enabled
		let finalQuery = query;
		if (cacheEnabled && cacheValue && cacheUnit) {
			// Convert cache duration to timespan format
			let timespan = '';
			switch (cacheUnit) {
				case 'minutes':
					timespan = `time(${cacheValue}m)`;
					break;
				case 'hours':
					timespan = `time(${cacheValue}h)`;
					break;
				case 'days':
					timespan = `time(${cacheValue}d)`;
					break;
			}
			if (timespan) {
				finalQuery = `set query_results_cache_max_age = ${timespan};\n${query}`;
			}
		}

		try {
			const result = await this.kustoClient.executeQuery(connection, database, finalQuery);
			this.panel?.webview.postMessage({
				type: 'queryResult',
				result: result
			});
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			vscode.window.showErrorMessage(`Query execution failed: ${errorMessage}`);
			this.panel?.webview.postMessage({
				type: 'queryError',
				error: errorMessage
			});
		}
	}

	private getHtmlContent(webview: vscode.Webview): string {
		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>Kusto Query Editor</title>
	<style>
		* {
			box-sizing: border-box;
			margin: 0;
			padding: 0;
		}
		
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			padding: 16px;
		}

		.query-box {
			border: 1px solid var(--vscode-input-border);
			border-radius: 4px;
			padding: 12px;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
		}

		.query-header {
			display: flex;
			gap: 8px;
			margin-bottom: 8px;
			align-items: center;
			flex-wrap: wrap;
		}

		.query-name {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			padding: 4px 8px;
			font-size: 12px;
			flex: 1 1 150px;
			min-width: 100px;
		}

		.query-name:hover {
			border-color: var(--vscode-input-border);
		}

		.query-name:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}

		.select-wrapper {
			position: relative;
			flex: 1 1 200px;
			min-width: 40px;
			display: flex;
			align-items: center;
			gap: 4px;
		}

		.select-wrapper select {
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			border-radius: 2px;
			width: 100%;
			cursor: pointer;
		}

		.select-wrapper select:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.select-wrapper::before {
			content: attr(data-icon);
			position: absolute;
			left: 8px;
			top: 50%;
			transform: translateY(-50%);
			pointer-events: none;
			font-size: 14px;
			z-index: 1;
		}

		.refresh-btn {
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 2px;
			display: flex;
			align-items: center;
			justify-content: center;
			min-width: 28px;
			height: 28px;
		}

		.refresh-btn:hover {
			background: var(--vscode-list-hoverBackground);
		}

		.refresh-btn:active {
			opacity: 0.7;
		}

		.refresh-btn:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.select-wrapper select {
			padding-left: 28px;
		}

		.select-wrapper.icon-only {
			width: 40px;
			min-width: 40px;
			flex: 0 0 40px;
		}

		.select-wrapper.icon-only select {
			padding-left: 8px;
			padding-right: 8px;
			text-indent: -9999px;
			color: transparent;
		}

		.select-wrapper.icon-only select option {
			text-indent: 0;
			color: var(--vscode-dropdown-foreground);
		}

		@media (max-width: 700px) {
			.select-wrapper {
				flex: 0 0 40px;
				width: 40px;
				min-width: 40px;
			}
			
			.select-wrapper select {
				padding-left: 8px;
				padding-right: 8px;
				text-indent: -9999px;
				color: transparent;
			}
			
			.select-wrapper select option {
				text-indent: 0;
				color: var(--vscode-dropdown-foreground);
			}

			.select-wrapper::before {
				left: 50%;
				transform: translate(-50%, -50%);
			}
		}

		textarea {
			width: 100%;
			min-height: 120px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 8px;
			font-family: var(--vscode-editor-font-family);
			font-size: 13px;
			resize: vertical;
			margin: 8px 0;
		}

		textarea:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}

		button {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			padding: 6px 14px;
			cursor: pointer;
			font-size: 13px;
			border-radius: 2px;
		}

		button:hover {
			background: var(--vscode-button-hoverBackground);
		}

		button:active {
			opacity: 0.8;
		}

		.results {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			padding: 12px;
			margin-top: 8px;
			border-radius: 4px;
			display: none;
			max-width: 100%;
		}

		.results.visible {
			display: block;
		}

		.results-header {
			font-size: 12px;
			color: var(--vscode-descriptionForeground);
			margin-bottom: 8px;
			padding-bottom: 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			justify-content: space-between;
			align-items: center;
			flex-wrap: wrap;
			gap: 8px;
		}

		.data-search {
			display: flex;
			gap: 4px;
			align-items: center;
			min-width: 300px;
		}

		.data-search input {
			flex: 1;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 2px;
		}

		.data-search input:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}

		.data-search-nav {
			display: flex;
			gap: 2px;
		}

		.data-search-nav button {
			padding: 2px 8px;
			font-size: 11px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 2px;
			cursor: pointer;
		}

		.data-search-nav button:hover:not(:disabled) {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.data-search-nav button:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.data-search-info {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			white-space: nowrap;
		}

		.column-search {
			position: relative;
			min-width: 200px;
		}

		.column-search input {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 2px;
			width: 100%;
		}

		.column-search input:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}

		.column-autocomplete {
			position: absolute;
			top: 100%;
			left: 0;
			right: 0;
			max-height: 200px;
			overflow-y: auto;
			background: var(--vscode-dropdown-background);
			border: 1px solid var(--vscode-dropdown-border);
			border-top: none;
			border-radius: 0 0 4px 4px;
			z-index: 1000;
			display: none;
		}

		.column-autocomplete.visible {
			display: block;
		}

		.column-autocomplete-item {
			padding: 6px 8px;
			cursor: pointer;
			font-size: 12px;
		}

		.column-autocomplete-item:hover,
		.column-autocomplete-item.selected {
			background: var(--vscode-list-hoverBackground);
		}

		.table-container {
			overflow: auto;
			max-width: 100%;
			max-height: 600px;
			position: relative;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 2px;
		}

		.table-container:focus {
			outline: 1px solid var(--vscode-focusBorder);
		}

		table {
			width: max-content;
			min-width: 100%;
			border-collapse: collapse;
			font-size: 12px;
			user-select: none;
		}

		th, td {
			text-align: left;
			padding: 6px 8px;
			border-right: 1px solid var(--vscode-panel-border);
			border-bottom: 1px solid var(--vscode-panel-border);
			white-space: nowrap;
			position: relative;
			max-width: 75ch;
			overflow: hidden;
			text-overflow: ellipsis;
		}

		th {
			font-weight: 600;
			background: var(--vscode-list-hoverBackground);
			position: sticky;
			top: 0;
			z-index: 2;
		}

		.row-selector {
			width: 40px;
			min-width: 40px;
			max-width: 40px;
			text-align: center;
			background: var(--vscode-editor-background);
			cursor: pointer;
			position: sticky;
			left: 0;
			z-index: 10;
			user-select: none;
			border-right: 2px solid var(--vscode-panel-border);
		}

		th.row-selector {
			z-index: 100;
			background: var(--vscode-list-hoverBackground);
		}

		td.selected-cell {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
			outline: 2px solid var(--vscode-focusBorder);
			outline-offset: -2px;
		}

		td[title]:hover {
			cursor: help;
		}

		td.search-match {
			background: var(--vscode-editor-findMatchBackground);
			outline: 1px solid var(--vscode-editor-findMatchBorder);
		}

		td.search-match-current {
			background: var(--vscode-editor-findMatchHighlightBackground);
			outline: 2px solid var(--vscode-editor-findMatchHighlightBorder);
			outline-offset: -2px;
		}

		.object-view-btn {
			margin-left: 6px;
			padding: 2px 6px;
			font-size: 11px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: 1px solid var(--vscode-button-border);
			border-radius: 3px;
			cursor: pointer;
			vertical-align: middle;
		}

		.object-view-btn:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.object-viewer-modal {
			display: none;
			position: fixed;
			top: 0;
			left: 0;
			right: 0;
			bottom: 0;
			background: rgba(0, 0, 0, 0.6);
			z-index: 10000;
			align-items: center;
			justify-content: center;
		}

		.object-viewer-modal.visible {
			display: flex;
		}

		.object-viewer-content {
			background: var(--vscode-editor-background);
			border: 1px solid var(--vscode-panel-border);
			border-radius: 4px;
			width: 80%;
			max-width: 1200px;
			height: 80%;
			display: flex;
			flex-direction: column;
			box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
		}

		.object-viewer-header {
			padding: 12px 16px;
			border-bottom: 1px solid var(--vscode-panel-border);
			display: flex;
			justify-content: space-between;
			align-items: center;
			background: var(--vscode-editorGroupHeader-tabsBackground);
		}

		.object-viewer-header h3 {
			margin: 0;
			font-size: 14px;
			font-weight: 600;
		}

		.object-viewer-search {
			display: flex;
			gap: 8px;
			align-items: center;
			flex: 1;
			margin: 0 16px;
		}

		.object-viewer-search input {
			flex: 1;
			max-width: 300px;
			padding: 4px 8px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 2px;
		}

		.object-viewer-search-results {
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
		}

		.object-viewer-close {
			padding: 4px 12px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
			border: none;
			border-radius: 2px;
			cursor: pointer;
		}

		.object-viewer-close:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.object-viewer-body {
			flex: 1;
			overflow: auto;
			padding: 16px;
		}

		.object-viewer-json {
			font-family: var(--vscode-editor-font-family);
			font-size: var(--vscode-editor-font-size);
			white-space: pre;
			line-height: 1.6;
		}

		.json-key {
			color: var(--vscode-symbolIcon-propertyForeground, #9cdcfe);
		}

		.json-string {
			color: var(--vscode-symbolIcon-stringForeground, #ce9178);
		}

		.json-number {
			color: var(--vscode-symbolIcon-numberForeground, #b5cea8);
		}

		.json-boolean {
			color: var(--vscode-symbolIcon-booleanForeground, #569cd6);
		}

		.json-null {
			color: var(--vscode-symbolIcon-nullForeground, #569cd6);
		}

		.json-highlight {
			background: var(--vscode-editor-findMatchHighlightBackground);
			border-radius: 2px;
		}

		tr.selected-row {
			background: var(--vscode-list-inactiveSelectionBackground);
		}

		tr.selected-row td {
			background: var(--vscode-list-inactiveSelectionBackground);
		}

		tr.selected-row .row-selector {
			background: var(--vscode-list-activeSelectionBackground);
			color: var(--vscode-list-activeSelectionForeground);
		}

		.add-query {
			width: 100%;
			margin-top: 16px;
			background: var(--vscode-button-secondaryBackground);
			color: var(--vscode-button-secondaryForeground);
		}

		.add-query:hover {
			background: var(--vscode-button-secondaryHoverBackground);
		}

		.cache-controls {
			display: flex;
			gap: 8px;
			align-items: center;
			margin-top: 8px;
			margin-bottom: 8px;
			font-size: 12px;
		}

		.cache-checkbox {
			display: flex;
			align-items: center;
			gap: 4px;
			cursor: pointer;
		}

		.cache-checkbox input[type="checkbox"] {
			cursor: pointer;
		}

		.cache-controls select,
		.cache-controls input[type="number"] {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 2px;
			width: 70px;
		}

		.cache-controls select:disabled,
		.cache-controls input[type="number"]:disabled {
			opacity: 0.5;
			cursor: not-allowed;
		}

		.cache-info {
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
		}
	</style>
</head>
<body>
	<div id="queries-container"></div>
	<button class="add-query" onclick="addQueryBox()">+ Add Query Box</button>

	<!-- Object Viewer Modal -->
	<div id="objectViewer" class="object-viewer-modal" onclick="closeObjectViewer(event)">
		<div class="object-viewer-content" onclick="event.stopPropagation()">
			<div class="object-viewer-header">
				<h3>Object Viewer</h3>
				<div class="object-viewer-search">
					<input type="text" id="objectViewerSearch" placeholder="Search in JSON..." 
						   oninput="searchInObjectViewer()" />
					<span class="object-viewer-search-results" id="objectViewerSearchResults"></span>
				</div>
				<button class="object-viewer-close" onclick="closeObjectViewer()">Close</button>
			</div>
			<div class="object-viewer-body">
				<div id="objectViewerContent" class="object-viewer-json"></div>
			</div>
		</div>
	</div>

	<script>
		const vscode = acquireVsCodeApi();
		let connections = [];
		let queryBoxes = [];
		let lastConnectionId = null;
		let lastDatabase = null;

		// Request connections on load
		vscode.postMessage({ type: 'getConnections' });

		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.type) {
				case 'connectionsData':
					connections = message.connections;
					lastConnectionId = message.lastConnectionId;
					lastDatabase = message.lastDatabase;
					updateConnectionSelects();
					break;
				case 'databasesData':
					updateDatabaseSelect(message.boxId, message.databases);
					break;
				case 'queryResult':
					displayResult(message.result);
					break;
				case 'queryError':
					displayError(message.error);
					break;
			}
		});

		function addQueryBox() {
			const id = 'query_' + Date.now();
			queryBoxes.push(id);
			
			const container = document.getElementById('queries-container');
			const boxHtml = \`
				<div class="query-box" id="\${id}">
					<div class="query-header">
						<input type="text" class="query-name" placeholder="Query Name (optional)" 
							   id="\${id}_name" />
						<div class="select-wrapper" data-icon="🖥️">
							<select id="\${id}_connection" onchange="updateDatabaseField('\${id}')">
								<option value="">Select Cluster...</option>
							</select>
						</div>
						<div class="select-wrapper" data-icon="📊">
							<select id="\${id}_database">
								<option value="">Select Database...</option>
							</select>
						</div>
						<button class="refresh-btn" onclick="refreshDatabases('\${id}')" 
								id="\${id}_refresh" title="Refresh database list">
							🔄
						</button>
					</div>
					<textarea id="\${id}_query" placeholder="Enter your KQL query here..."></textarea>
					<div class="cache-controls">
						<label class="cache-checkbox">
							<input type="checkbox" id="\${id}_cache_enabled" checked onchange="toggleCacheControls('\${id}')" />
							Cache results for
						</label>
						<input type="number" id="\${id}_cache_value" value="1" min="1" />
						<select id="\${id}_cache_unit">
							<option value="minutes">Minutes</option>
							<option value="hours">Hours</option>
							<option value="days" selected>Days</option>
						</select>
						<span class="cache-info">(reduces query costs)</span>
					</div>
					<button onclick="executeQuery('\${id}')">▶ Run Query</button>
					<div class="results" id="\${id}_results"></div>
				</div>
			\`;
			
			container.insertAdjacentHTML('beforeend', boxHtml);
			updateConnectionSelects();
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
		}

		function updateConnectionSelects() {
			queryBoxes.forEach(id => {
				const select = document.getElementById(id + '_connection');
				if (select) {
					const currentValue = select.value;
					select.innerHTML = '<option value="">Select Cluster...</option>' +
						connections.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
					
					// Pre-fill with last selection if this is a new box
					if (!currentValue && lastConnectionId) {
						select.value = lastConnectionId;
						// Trigger database loading
						updateDatabaseField(id);
					} else if (currentValue) {
						select.value = currentValue;
					}
				}
			});
		}

		function updateDatabaseField(boxId) {
			const connectionId = document.getElementById(boxId + '_connection').value;
			const databaseSelect = document.getElementById(boxId + '_database');
			const refreshBtn = document.getElementById(boxId + '_refresh');
			
			if (connectionId && databaseSelect) {
				// Clear and disable while loading
				databaseSelect.innerHTML = '<option value="">Loading databases...</option>';
				databaseSelect.disabled = true;
				if (refreshBtn) {
					refreshBtn.disabled = true;
				}
				
				// Request databases from the extension
				vscode.postMessage({
					type: 'getDatabases',
					connectionId: connectionId,
					boxId: boxId
				});
			} else if (databaseSelect) {
				databaseSelect.innerHTML = '<option value="">Select Database...</option>';
				databaseSelect.disabled = false;
				if (refreshBtn) {
					refreshBtn.disabled = true;
				}
			}
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
				databaseSelect.innerHTML = '<option value="">Select Database...</option>' +
					databases.map(db => \`<option value="\${db}">\${db}</option>\`).join('');
				databaseSelect.disabled = false;
				
				// Pre-fill with last selection if available
				if (lastDatabase && databases.includes(lastDatabase)) {
					databaseSelect.value = lastDatabase;
				}
			}
			if (refreshBtn) {
				refreshBtn.disabled = false;
			}
		}

		function executeQuery(boxId) {
			const query = document.getElementById(boxId + '_query').value;
			const connectionId = document.getElementById(boxId + '_connection').value;
			const database = document.getElementById(boxId + '_database').value;
			const cacheEnabled = document.getElementById(boxId + '_cache_enabled').checked;
			const cacheValue = parseInt(document.getElementById(boxId + '_cache_value').value) || 1;
			const cacheUnit = document.getElementById(boxId + '_cache_unit').value;

			if (!query.trim()) {
				return;
			}

			if (!connectionId) {
				alert('Please select a cluster connection');
				return;
			}

			vscode.postMessage({
				type: 'executeQuery',
				query,
				connectionId,
				database,
				boxId,
				cacheEnabled,
				cacheValue,
				cacheUnit
			});

			// Store the last executed box for result display
			window.lastExecutedBox = boxId;
		}

		function displayResult(result) {
			const boxId = window.lastExecutedBox;
			if (!boxId) {return;}

			const resultsDiv = document.getElementById(boxId + '_results');
			if (!resultsDiv) {return;}

			// Store result data for navigation
			window.currentResult = {
				boxId: boxId,
				columns: result.columns,
				rows: result.rows,
				metadata: result.metadata,
				selectedCell: null,
				selectedRows: new Set(),
				searchMatches: [],
				currentSearchIndex: -1
			};

			let html = \`
				<div class="results-header">
					<div>
						<strong>Results:</strong> \${result.metadata.cluster} / \${result.metadata.database}
						(Execution time: \${result.metadata.executionTime})
					</div>
					<div class="data-search">
						<input type="text" placeholder="Search data..." 
							   id="\${boxId}_data_search"
							   oninput="searchData('\${boxId}')"
							   onkeydown="handleDataSearchKeydown(event, '\${boxId}')" />
						<div class="data-search-nav">
							<button id="\${boxId}_search_prev" onclick="previousSearchMatch('\${boxId}')" disabled title="Previous (Shift+Enter)">↑</button>
							<button id="\${boxId}_search_next" onclick="nextSearchMatch('\${boxId}')" disabled title="Next (Enter)">↓</button>
						</div>
						<span class="data-search-info" id="\${boxId}_search_info"></span>
					</div>
					<div class="column-search">
						<input type="text" placeholder="Scroll to column..." 
							   id="\${boxId}_column_search"
							   oninput="filterColumns('\${boxId}')"
							   onkeydown="handleColumnSearchKeydown(event, '\${boxId}')" />
						<div class="column-autocomplete" id="\${boxId}_column_autocomplete"></div>
					</div>
				</div>
				<div class="table-container" id="\${boxId}_table_container" tabindex="0"
					 onkeydown="handleTableKeydown(event, '\${boxId}')">
					<table id="\${boxId}_table">
						<thead><tr>
							<th class="row-selector">#</th>
							\${result.columns.map((c, i) => '<th data-col="' + i + '">' + c + '</th>').join('')}
						</tr></thead>
						<tbody>
							\${result.rows.map((row, rowIdx) => 
								'<tr data-row="' + rowIdx + '">' +
								'<td class="row-selector" onclick="toggleRowSelection(' + rowIdx + ', \\'' + boxId + '\\')">' + (rowIdx + 1) + '</td>' +
								row.map((cell, colIdx) => {
									// Check if cell is an object with display and full properties
									const hasHover = typeof cell === 'object' && cell !== null && 'display' in cell && 'full' in cell;
									const displayValue = hasHover ? cell.display : cell;
									const fullValue = hasHover ? cell.full : cell;
									const isObject = cell && cell.isObject;
									const title = hasHover && displayValue !== fullValue && !isObject ? ' title="' + fullValue + '"' : '';
									const viewBtn = isObject ? '<button class="object-view-btn" onclick="event.stopPropagation(); openObjectViewer(' + rowIdx + ', ' + colIdx + ', \\'' + boxId + '\\')">View</button>' : '';
									return '<td data-row="' + rowIdx + '" data-col="' + colIdx + '"' + title + ' ' +
										'onclick="selectCell(' + rowIdx + ', ' + colIdx + ', \\'' + boxId + '\\')">' + 
										displayValue + viewBtn + '</td>';
								}).join('') + 
								'</tr>'
							).join('')}
						</tbody>
					</table>
				</div>
			\`;

			resultsDiv.innerHTML = html;
			resultsDiv.classList.add('visible');
		}

		function displayError(error) {
			const boxId = window.lastExecutedBox;
			if (!boxId) {return;}

			const resultsDiv = document.getElementById(boxId + '_results');
			if (!resultsDiv) {return;}

			resultsDiv.innerHTML = \`
				<div class="results-header" style="color: var(--vscode-errorForeground);">
					<strong>Error:</strong> \${error}
				</div>
			\`;
			resultsDiv.classList.add('visible');
		}
		function selectCell(row, col, boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			// Clear previous selection
			const prevCell = document.querySelector('#' + boxId + '_table td.selected-cell');
			if (prevCell) {
				prevCell.classList.remove('selected-cell');
			}
			
			// Select new cell
			const cell = document.querySelector('#' + boxId + '_table td[data-row="' + row + '"][data-col="' + col + '"]');
			if (cell) {
				cell.classList.add('selected-cell');
				window.currentResult.selectedCell = { row, col };
				
				// Scroll cell into view
				cell.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
				
				// Focus the container for keyboard navigation
				const container = document.getElementById(boxId + '_table_container');
				if (container) {
					container.focus();
				}
			}
		}

		function toggleRowSelection(row, boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const rowElement = document.querySelector('#' + boxId + '_table tr[data-row="' + row + '"]');
			if (!rowElement) {return;}
			
			if (window.currentResult.selectedRows.has(row)) {
				window.currentResult.selectedRows.delete(row);
				rowElement.classList.remove('selected-row');
			} else {
				window.currentResult.selectedRows.add(row);
				rowElement.classList.add('selected-row');
			}
		}

		function openObjectViewer(row, col, boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const cellData = window.currentResult.rows[row][col];
			if (!cellData || !cellData.isObject) {return;}
			
			const modal = document.getElementById('objectViewer');
			const content = document.getElementById('objectViewerContent');
			const searchInput = document.getElementById('objectViewerSearch');
			
			// Store the JSON data for searching
			window.currentObjectViewerData = {
				raw: cellData.full,
				formatted: formatJson(cellData.full)
			};
			
			content.innerHTML = window.currentObjectViewerData.formatted;
			modal.classList.add('visible');
			
			// Check if there's an active data search and if this cell is a search match
			const dataSearchInput = document.getElementById(boxId + '_data_search');
			const dataSearchTerm = dataSearchInput ? dataSearchInput.value : '';
			
			if (dataSearchTerm && window.currentResult.searchMatches && 
			    window.currentResult.searchMatches.some(m => m.row === row && m.col === col)) {
				// Automatically search for the same term in the object viewer
				searchInput.value = dataSearchTerm;
				searchInObjectViewer();
			} else {
				// Clear search
				searchInput.value = '';
				document.getElementById('objectViewerSearchResults').textContent = '';
			}
		}

		function closeObjectViewer(event) {
			if (event && event.target !== event.currentTarget && !event.currentTarget.classList.contains('object-viewer-close')) {
				return;
			}
			
			const modal = document.getElementById('objectViewer');
			modal.classList.remove('visible');
			window.currentObjectViewerData = null;
		}

		function formatJson(jsonString) {
			try {
				const obj = typeof jsonString === 'string' ? JSON.parse(jsonString) : jsonString;
				return syntaxHighlightJson(obj);
			} catch (e) {
				return '<span class="json-string">' + escapeHtml(jsonString) + '</span>';
			}
		}

		function syntaxHighlightJson(obj, indent = 0) {
			const indentStr = '  '.repeat(indent);
			const nextIndent = '  '.repeat(indent + 1);
			
			if (obj === null) {
				return '<span class="json-null">null</span>';
			}
			
			if (typeof obj === 'string') {
				return '<span class="json-string">"' + escapeHtml(obj) + '"</span>';
			}
			
			if (typeof obj === 'number') {
				return '<span class="json-number">' + obj + '</span>';
			}
			
			if (typeof obj === 'boolean') {
				return '<span class="json-boolean">' + obj + '</span>';
			}
			
			if (Array.isArray(obj)) {
				if (obj.length === 0) {
					return '[]';
				}
				
				let result = '[\\n';
				obj.forEach((item, index) => {
					result += nextIndent + syntaxHighlightJson(item, indent + 1);
					if (index < obj.length - 1) {
						result += ',';
					}
					result += '\\n';
				});
				result += indentStr + ']';
				return result;
			}
			
			if (typeof obj === 'object') {
				const keys = Object.keys(obj);
				if (keys.length === 0) {
					return '{}';
				}
				
				let result = '{\\n';
				keys.forEach((key, index) => {
					result += nextIndent + '<span class="json-key">"' + escapeHtml(key) + '"</span>: ';
					result += syntaxHighlightJson(obj[key], indent + 1);
					if (index < keys.length - 1) {
						result += ',';
					}
					result += '\\n';
				});
				result += indentStr + '}';
				return result;
			}
			
			return String(obj);
		}

		function escapeHtml(str) {
			const div = document.createElement('div');
			div.textContent = str;
			return div.innerHTML;
		}

		function searchInObjectViewer() {
			if (!window.currentObjectViewerData) {return;}
			
			const searchTerm = document.getElementById('objectViewerSearch').value.toLowerCase();
			const content = document.getElementById('objectViewerContent');
			const resultsSpan = document.getElementById('objectViewerSearchResults');
			
			if (!searchTerm) {
				content.innerHTML = window.currentObjectViewerData.formatted;
				resultsSpan.textContent = '';
				return;
			}
			
			// Count matches in the raw JSON
			const rawJson = window.currentObjectViewerData.raw.toLowerCase();
			const matches = (rawJson.match(new RegExp(escapeRegex(searchTerm), 'g')) || []).length;
			
			// Highlight matches in the formatted JSON
			const highlightedHtml = highlightSearchTerm(window.currentObjectViewerData.formatted, searchTerm);
			content.innerHTML = highlightedHtml;
			
			resultsSpan.textContent = matches > 0 ? matches + ' match' + (matches !== 1 ? 'es' : '') : 'No matches';
			
			// Scroll to first match
			const firstMatch = content.querySelector('.json-highlight');
			if (firstMatch) {
				firstMatch.scrollIntoView({ block: 'center', behavior: 'smooth' });
			}
		}

		function highlightSearchTerm(html, searchTerm) {
			// Create a temporary div to work with the HTML
			const tempDiv = document.createElement('div');
			tempDiv.innerHTML = html;
			
			// Function to highlight text in text nodes
			function highlightInNode(node) {
				if (node.nodeType === Node.TEXT_NODE) {
					const text = node.textContent;
					const lowerText = text.toLowerCase();
					const lowerSearch = searchTerm.toLowerCase();
					
					if (lowerText.includes(lowerSearch)) {
						const parts = [];
						let lastIndex = 0;
						let index = lowerText.indexOf(lowerSearch);
						
						while (index !== -1) {
							// Add text before match
							if (index > lastIndex) {
								parts.push(document.createTextNode(text.substring(lastIndex, index)));
							}
							
							// Add highlighted match
							const span = document.createElement('span');
							span.className = 'json-highlight';
							span.textContent = text.substring(index, index + searchTerm.length);
							parts.push(span);
							
							lastIndex = index + searchTerm.length;
							index = lowerText.indexOf(lowerSearch, lastIndex);
						}
						
						// Add remaining text
						if (lastIndex < text.length) {
							parts.push(document.createTextNode(text.substring(lastIndex)));
						}
						
						// Replace the text node with highlighted parts
						const parent = node.parentNode;
						parts.forEach(part => parent.insertBefore(part, node));
						parent.removeChild(node);
					}
				} else if (node.nodeType === Node.ELEMENT_NODE) {
					// Recursively process child nodes
					Array.from(node.childNodes).forEach(child => highlightInNode(child));
				}
			}
			
			highlightInNode(tempDiv);
			return tempDiv.innerHTML;
		}

		function escapeRegex(str) {
			return str.replace(/[-\/\\\\^$*+?.()|[\\]{}]/g, '\\\\$&');
		}

		function searchData(boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const searchInput = document.getElementById(boxId + '_data_search');
			const searchTerm = searchInput.value.toLowerCase();
			const infoSpan = document.getElementById(boxId + '_search_info');
			const prevBtn = document.getElementById(boxId + '_search_prev');
			const nextBtn = document.getElementById(boxId + '_search_next');
			
			// Clear previous search highlights
			document.querySelectorAll('#' + boxId + '_table td.search-match, #' + boxId + '_table td.search-match-current')
				.forEach(cell => {
					cell.classList.remove('search-match', 'search-match-current');
				});
			
			window.currentResult.searchMatches = [];
			window.currentResult.currentSearchIndex = -1;
			
			if (!searchTerm) {
				infoSpan.textContent = '';
				prevBtn.disabled = true;
				nextBtn.disabled = true;
				return;
			}
			
			// Search through all cells
			window.currentResult.rows.forEach((row, rowIdx) => {
				row.forEach((cell, colIdx) => {
					let cellText = '';
					
					// Extract searchable text from cell
					if (typeof cell === 'object' && cell !== null) {
						// If it's a formatted cell object, search in both display and full values
						if ('display' in cell) {
							cellText = cell.display + ' ' + (cell.full || '');
						} else {
							cellText = JSON.stringify(cell);
						}
					} else {
						cellText = String(cell);
					}
					
					// Check if search term is in cell text
					if (cellText.toLowerCase().includes(searchTerm)) {
						window.currentResult.searchMatches.push({ row: rowIdx, col: colIdx });
					}
				});
			});
			
			// Update UI
			const matchCount = window.currentResult.searchMatches.length;
			if (matchCount > 0) {
				infoSpan.textContent = matchCount + ' match' + (matchCount !== 1 ? 'es' : '');
				prevBtn.disabled = false;
				nextBtn.disabled = false;
				
				// Highlight all matches
				window.currentResult.searchMatches.forEach(match => {
					const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]');
					if (cell) {
						cell.classList.add('search-match');
					}
				});
				
				// Jump to first match
				window.currentResult.currentSearchIndex = 0;
				highlightCurrentSearchMatch(boxId);
			} else {
				infoSpan.textContent = 'No matches';
				prevBtn.disabled = true;
				nextBtn.disabled = true;
			}
		}

		function nextSearchMatch(boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const matches = window.currentResult.searchMatches;
			if (matches.length === 0) {return;}
			
			window.currentResult.currentSearchIndex = (window.currentResult.currentSearchIndex + 1) % matches.length;
			highlightCurrentSearchMatch(boxId);
		}

		function previousSearchMatch(boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const matches = window.currentResult.searchMatches;
			if (matches.length === 0) {return;}
			
			window.currentResult.currentSearchIndex = (window.currentResult.currentSearchIndex - 1 + matches.length) % matches.length;
			highlightCurrentSearchMatch(boxId);
		}

		function highlightCurrentSearchMatch(boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const matches = window.currentResult.searchMatches;
			const currentIndex = window.currentResult.currentSearchIndex;
			
			if (currentIndex < 0 || currentIndex >= matches.length) {return;}
			
			// Remove current highlight from all cells
			document.querySelectorAll('#' + boxId + '_table td.search-match-current')
				.forEach(cell => cell.classList.remove('search-match-current'));
			
			// Highlight current match
			const match = matches[currentIndex];
			const cell = document.querySelector('#' + boxId + '_table td[data-row="' + match.row + '"][data-col="' + match.col + '"]');
			
			if (cell) {
				cell.classList.add('search-match-current');
				cell.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
			}
			
			// Update info text
			const infoSpan = document.getElementById(boxId + '_search_info');
			if (infoSpan) {
				infoSpan.textContent = (currentIndex + 1) + ' of ' + matches.length;
			}
		}

		function handleDataSearchKeydown(event, boxId) {
			if (event.key === 'Enter') {
				event.preventDefault();
				if (event.shiftKey) {
					previousSearchMatch(boxId);
				} else {
					nextSearchMatch(boxId);
				}
			}
		}

		function handleTableKeydown(event, boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			// Handle copy to clipboard (Ctrl+C or Cmd+C)
			if ((event.ctrlKey || event.metaKey) && event.key === 'c') {
				event.preventDefault();
				copySelectionToClipboard(boxId);
				return;
			}
			
			const cell = window.currentResult.selectedCell;
			if (!cell) {
				// If no cell selected, select first cell
				if (['ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown'].includes(event.key)) {
					event.preventDefault();
					selectCell(0, 0, boxId);
				}
				return;
			}
			
			let newRow = cell.row;
			let newCol = cell.col;
			const maxRow = window.currentResult.rows.length - 1;
			const maxCol = window.currentResult.columns.length - 1;
			
			switch(event.key) {
				case 'ArrowRight':
					if (newCol < maxCol) {
						newCol++;
						event.preventDefault();
					}
					break;
				case 'ArrowLeft':
					if (newCol > 0) {
						newCol--;
						event.preventDefault();
					}
					break;
				case 'ArrowDown':
					if (newRow < maxRow) {
						newRow++;
						event.preventDefault();
					}
					break;
				case 'ArrowUp':
					if (newRow > 0) {
						newRow--;
						event.preventDefault();
					}
					break;
				case 'Home':
					if (event.ctrlKey) {
						newRow = 0;
						newCol = 0;
					} else {
						newCol = 0;
					}
					event.preventDefault();
					break;
				case 'End':
					if (event.ctrlKey) {
						newRow = maxRow;
						newCol = maxCol;
					} else {
						newCol = maxCol;
					}
					event.preventDefault();
					break;
				default:
					return;
			}
			
			if (newRow !== cell.row || newCol !== cell.col) {
				selectCell(newRow, newCol, boxId);
			}
		}

		function filterColumns(boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			const input = document.getElementById(boxId + '_column_search');
			const autocomplete = document.getElementById(boxId + '_column_autocomplete');
			if (!input || !autocomplete) {return;}
			
			const query = input.value.toLowerCase();
			
			if (!query) {
				autocomplete.classList.remove('visible');
				return;
			}
			
			const matches = window.currentResult.columns
				.map((col, idx) => ({ name: col, index: idx }))
				.filter(col => col.name.toLowerCase().includes(query));
			
			if (matches.length === 0) {
				autocomplete.classList.remove('visible');
				return;
			}
			
			autocomplete.innerHTML = matches.map((col, idx) => 
				'<div class="column-autocomplete-item' + (idx === 0 ? ' selected' : '') + '" ' +
				'data-col-index="' + col.index + '" ' +
				'onclick="scrollToColumn(' + col.index + ', \\'' + boxId + '\\')">' + 
				col.name + '</div>'
			).join('');
			
			autocomplete.classList.add('visible');
			window.currentAutocompleteIndex = 0;
		}

		function handleColumnSearchKeydown(event, boxId) {
			const autocomplete = document.getElementById(boxId + '_column_autocomplete');
			if (!autocomplete || !autocomplete.classList.contains('visible')) {return;}
			
			const items = autocomplete.querySelectorAll('.column-autocomplete-item');
			if (items.length === 0) {return;}
			
			if (event.key === 'ArrowDown') {
				event.preventDefault();
				window.currentAutocompleteIndex = (window.currentAutocompleteIndex + 1) % items.length;
				updateAutocompleteSelection(items);
			} else if (event.key === 'ArrowUp') {
				event.preventDefault();
				window.currentAutocompleteIndex = (window.currentAutocompleteIndex - 1 + items.length) % items.length;
				updateAutocompleteSelection(items);
			} else if (event.key === 'Enter') {
				event.preventDefault();
				const selected = items[window.currentAutocompleteIndex];
				if (selected) {
					const colIndex = parseInt(selected.getAttribute('data-col-index'));
					scrollToColumn(colIndex, boxId);
					autocomplete.classList.remove('visible');
					const input = document.getElementById(boxId + '_column_search');
					if (input) {input.value = '';}
				}
			} else if (event.key === 'Escape') {
				event.preventDefault();
				autocomplete.classList.remove('visible');
			}
		}

		function updateAutocompleteSelection(items) {
			items.forEach((item, idx) => {
				if (idx === window.currentAutocompleteIndex) {
					item.classList.add('selected');
					item.scrollIntoView({ block: 'nearest' });
				} else {
					item.classList.remove('selected');
				}
			});
		}

		function scrollToColumn(colIndex, boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			// Select first cell in that column first
			selectCell(0, colIndex, boxId);
			
			// Then scroll the container to center the column
			setTimeout(() => {
				const cell = document.querySelector('#' + boxId + '_table td[data-row="0"][data-col="' + colIndex + '"]');
				if (cell) {
					cell.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
				}
			}, 100);
		}

		function copySelectionToClipboard(boxId) {
			if (!window.currentResult || window.currentResult.boxId !== boxId) {return;}
			
			// Check if any rows are selected
			if (window.currentResult.selectedRows.size > 0) {
				// Copy selected rows in tab-delimited format
				const rowIndices = Array.from(window.currentResult.selectedRows).sort((a, b) => a - b);
				const textToCopy = rowIndices.map(rowIdx => {
					const row = window.currentResult.rows[rowIdx];
					return row.join('\\t');
				}).join('\\n');
				
				navigator.clipboard.writeText(textToCopy).then(() => {
					console.log('Copied ' + rowIndices.length + ' row(s) to clipboard');
				}).catch(err => {
					console.error('Failed to copy rows:', err);
				});
			} else if (window.currentResult.selectedCell) {
				// Copy single cell value
				const cell = window.currentResult.selectedCell;
				const value = window.currentResult.rows[cell.row][cell.col];
				
				navigator.clipboard.writeText(value).then(() => {
					console.log('Copied cell value to clipboard:', value);
				}).catch(err => {
					console.error('Failed to copy cell:', err);
				});
			}
		}

		// Add initial query box
		addQueryBox();
	</script>
</body>
</html>`;
	}
}
