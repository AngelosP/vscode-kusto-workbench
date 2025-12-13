import * as vscode from 'vscode';
import { ConnectionManager } from './connectionManager';
import { KustoQueryClient } from './kustoClient';

/**
 * Provider for the custom Kusto query editor webview
 */
export class QueryEditorProvider {
	private panel?: vscode.WebviewPanel;
	private kustoClient: KustoQueryClient;

	constructor(
		private readonly extensionUri: vscode.Uri,
		private readonly connectionManager: ConnectionManager
	) {
		this.kustoClient = new KustoQueryClient();
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
						connections
					});
					break;
				case 'getDatabases':
					await this.getDatabases(message.connectionId, message.boxId);
					break;
				case 'executeQuery':
					await this.executeQuery(message.query, message.connectionId, message.database);
					break;
			}
		});

		// Reset panel when disposed
		this.panel.onDidDispose(() => {
			this.panel = undefined;
		});
	}

	private async getDatabases(connectionId: string, boxId: string) {
		const connection = this.connectionManager.getConnections().find(c => c.id === connectionId);
		if (!connection) {
			return;
		}

		try {
			const databases = await this.kustoClient.getDatabases(connection);
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

	private async executeQuery(query: string, connectionId: string, database?: string) {
		const connection = this.connectionManager.getConnections().find(c => c.id === connectionId);
		
		if (!connection) {
			vscode.window.showErrorMessage('Connection not found');
			return;
		}

		if (!database) {
			vscode.window.showErrorMessage('Please select a database');
			return;
		}

		try {
			const result = await this.kustoClient.executeQuery(connection, database, query);
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
		}

		.query-name {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			padding: 4px 8px;
			font-size: 12px;
			flex: 1;
		}

		.query-name:hover {
			border-color: var(--vscode-input-border);
		}

		.query-name:focus {
			outline: none;
			border-color: var(--vscode-focusBorder);
		}

		select {
			background: var(--vscode-dropdown-background);
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			padding: 4px 8px;
			font-size: 12px;
			border-radius: 2px;
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

		table {
			width: 100%;
			border-collapse: collapse;
			font-size: 12px;
		}

		th, td {
			text-align: left;
			padding: 6px 8px;
			border-bottom: 1px solid var(--vscode-panel-border);
		}

		th {
			font-weight: 600;
			background: var(--vscode-list-hoverBackground);
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
	</style>
</head>
<body>
	<div id="queries-container"></div>
	<button class="add-query" onclick="addQueryBox()">+ Add Query Box</button>

	<script>
		const vscode = acquireVsCodeApi();
		let connections = [];
		let queryBoxes = [];

		// Request connections on load
		vscode.postMessage({ type: 'getConnections' });

		window.addEventListener('message', event => {
			const message = event.data;
			switch (message.type) {
				case 'connectionsData':
					connections = message.connections;
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
						<select id="\${id}_connection" onchange="updateDatabaseField('\${id}')">
							<option value="">Select Cluster...</option>
						</select>
						<select id="\${id}_database">
							<option value="">Select Database...</option>
						</select>
					</div>
					<textarea id="\${id}_query" placeholder="Enter your KQL query here..."></textarea>
					<button onclick="executeQuery('\${id}')">▶ Run Query</button>
					<div class="results" id="\${id}_results"></div>
				</div>
			\`;
			
			container.insertAdjacentHTML('beforeend', boxHtml);
			updateConnectionSelects();
		}

		function updateConnectionSelects() {
			queryBoxes.forEach(id => {
				const select = document.getElementById(id + '_connection');
				if (select) {
					const currentValue = select.value;
					select.innerHTML = '<option value="">Select Cluster...</option>' +
						connections.map(c => \`<option value="\${c.id}">\${c.name}</option>\`).join('');
					if (currentValue) {
						select.value = currentValue;
					}
				}
			});
		}

		function updateDatabaseField(boxId) {
			const connectionId = document.getElementById(boxId + '_connection').value;
			const databaseSelect = document.getElementById(boxId + '_database');
			
			if (connectionId && databaseSelect) {
				// Clear and disable while loading
				databaseSelect.innerHTML = '<option value="">Loading databases...</option>';
				databaseSelect.disabled = true;
				
				// Request databases from the extension
				vscode.postMessage({
					type: 'getDatabases',
					connectionId: connectionId,
					boxId: boxId
				});
			} else if (databaseSelect) {
				databaseSelect.innerHTML = '<option value="">Select Database...</option>';
				databaseSelect.disabled = false;
			}
		}

		function updateDatabaseSelect(boxId, databases) {
			const databaseSelect = document.getElementById(boxId + '_database');
			if (databaseSelect) {
				databaseSelect.innerHTML = '<option value="">Select Database...</option>' +
					databases.map(db => \`<option value="\${db}">\${db}</option>\`).join('');
				databaseSelect.disabled = false;
			}
		}

		function executeQuery(boxId) {
			const query = document.getElementById(boxId + '_query').value;
			const connectionId = document.getElementById(boxId + '_connection').value;
			const database = document.getElementById(boxId + '_database').value;

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
				boxId
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
				<table>
					<thead><tr>\${result.columns.map(c => '<th>' + c + '</th>').join('')}</tr></thead>
					<tbody>
						\${result.rows.map(row => 
							'<tr>' + row.map(cell => '<td>' + cell + '</td>').join('') + '</tr>'
						).join('')}
					</tbody>
				</table>
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
