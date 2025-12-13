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
			overflow-x: auto;
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
		}

		.table-container {
			overflow-x: auto;
			max-width: 100%;
		}

		table {
			width: max-content;
			min-width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}

		th, td {
			text-align: left;
			padding: 6px 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
			white-space: nowrap;
		}

		th {
			font-weight: 600;
			background: var(--vscode-list-hoverBackground);
			position: sticky;
			top: 0;
			z-index: 1;
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

			let html = \`
				<div class="results-header">
					<strong>Results:</strong> \${result.metadata.cluster} / \${result.metadata.database}
					(Execution time: \${result.metadata.executionTime})
				</div>
				<div class="table-container">
					<table>
						<thead><tr>\${result.columns.map(c => '<th>' + c + '</th>').join('')}</tr></thead>
						<tbody>
							\${result.rows.map(row => 
								'<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>'
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

		// Add initial query box
		addQueryBox();
	</script>
</body>
</html>`;
	}
}
