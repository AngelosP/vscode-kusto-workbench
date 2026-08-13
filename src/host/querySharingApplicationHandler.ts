import * as zlib from 'zlib';
import * as vscode from 'vscode';

import { exportAzureDataExplorerClusterPath } from '../shared/kustoClusterUrls';
import {
	admitQuerySharingWebviewMessage,
	parseQuerySharingHostMessage,
	type CopyAdeLinkMessage,
	type QuerySharingHostMessage,
	type ShareToClipboardMessage,
} from '../shared/querySharingProtocol';
import type { KustoConnection } from './connectionManager';
import type { IncomingWebviewMessage } from './queryEditorTypes';

export interface QuerySharingApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type QuerySharingApplicationHandlerOptions = {
	findConnection: (connectionId: string) => Pick<KustoConnection, 'clusterUrl'> | undefined;
	postMessage: (message: QuerySharingHostMessage) => Thenable<boolean>;
	writeClipboardText?: (text: string) => Thenable<void>;
};

export class HostQuerySharingApplicationHandler implements QuerySharingApplicationHandler {
	private readonly writeClipboardText: (text: string) => Thenable<void>;
	private disposed = false;

	constructor(private readonly options: QuerySharingApplicationHandlerOptions) {
		this.writeClipboardText = options.writeClipboardText ?? (text => vscode.env.clipboard.writeText(text));
	}

	private postMessage(message: QuerySharingHostMessage): Thenable<boolean> {
		const parsed = parseQuerySharingHostMessage(message);
		return parsed.ok ? this.options.postMessage(parsed.value) : Promise.resolve(false);
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const admission = admitQuerySharingWebviewMessage(message);
		if (!admission.recognized) return undefined;
		if (!admission.parsed.ok) return Promise.resolve();
		switch (admission.parsed.value.type) {
			case 'copyAdeLink':
				return this.copyAdeLink(admission.parsed.value);
			case 'shareToClipboard':
				return this.shareToClipboard(admission.parsed.value);
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private async copyAdeLink(message: CopyAdeLinkMessage): Promise<void> {
		if (this.disposed) return;
		try {
			const query = message.query.trim();
			const database = message.database.trim();
			const connectionId = message.connectionId.trim();
			if (!query) {
				vscode.window.showInformationMessage('No query text to share.');
				return;
			}
			if (!connectionId) {
				vscode.window.showInformationMessage('Select a cluster connection first.');
				return;
			}
			if (!database) {
				vscode.window.showInformationMessage('Select a database first.');
				return;
			}

			const connection = this.options.findConnection(connectionId);
			if (!connection) {
				vscode.window.showErrorMessage('Connection not found.');
				return;
			}
			const adxClusterPath = exportAzureDataExplorerClusterPath(connection.clusterUrl.trim());
			if (!adxClusterPath) {
				vscode.window.showErrorMessage('Could not determine cluster name for the selected connection.');
				return;
			}

			let encoded = '';
			try {
				const gz = zlib.gzipSync(Buffer.from(query, 'utf8'));
				encoded = gz.toString('base64').replace(/=+$/g, '');
			} catch {
				vscode.window.showErrorMessage('Failed to encode the query for Azure Data Explorer.');
				return;
			}

			const url =
				`https://dataexplorer.azure.com/clusters/${encodeURIComponent(adxClusterPath)}` +
				`/databases/${encodeURIComponent(database)}` +
				`?query=${encodeURIComponent(encoded)}`;

			await this.writeClipboardText(url);
			if (this.disposed) return;
			vscode.window.showInformationMessage('Azure Data Explorer link copied to clipboard.');
		} catch {
			if (!this.disposed) {
				vscode.window.showErrorMessage('Failed to copy Azure Data Explorer link.');
			}
		}
	}

	private async shareToClipboard(message: ShareToClipboardMessage): Promise<void> {
		if (this.disposed) return;
		try {
			const {
				engine, includeTitle, includeQuery, includeResults,
				sectionName, queryText, connectionId, database,
				columns, rowsData, totalRows
			} = message;

			if (!includeTitle && !includeQuery && !includeResults) {
				vscode.window.showInformationMessage('Select at least one section to share.');
				return;
			}

			const htmlParts: string[] = [];
			const textParts: string[] = [];

			let adeUrl = '';
			try {
				const trimmedQuery = queryText.trim();
				const trimmedConnectionId = connectionId.trim();
				const trimmedDatabase = database.trim();
				if (engine !== 'sql' && trimmedQuery && trimmedConnectionId && trimmedDatabase) {
					const connection = this.options.findConnection(trimmedConnectionId);
					if (connection) {
						const adxClusterPath = exportAzureDataExplorerClusterPath(connection.clusterUrl.trim());
						if (adxClusterPath) {
							const gz = zlib.gzipSync(Buffer.from(trimmedQuery, 'utf8'));
							const encoded = gz.toString('base64').replace(/=+$/g, '');
							adeUrl =
								`https://dataexplorer.azure.com/clusters/${encodeURIComponent(adxClusterPath)}` +
								`/databases/${encodeURIComponent(trimmedDatabase)}` +
								`?query=${encodeURIComponent(encoded)}`;
						}
					}
				}
			} catch {
				// If URL generation fails, just skip the link.
			}

			const escHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

			if (includeTitle) {
				const title = sectionName || (engine === 'sql' ? 'SQL Query' : 'Kusto Query');
				if (adeUrl) {
					htmlParts.push(`<b>${escHtml(title)}</b><br><a href="${escHtml(adeUrl)}">Direct link to query</a>`);
					textParts.push(`${title}\nDirect link to query: ${adeUrl}`);
				} else {
					htmlParts.push(`<b>${escHtml(title)}</b>`);
					textParts.push(title);
				}
			}

			if (includeQuery) {
				const query = queryText.trim();
				if (query) {
					htmlParts.push(
						`<b style="font-size:13px">Query</b>` +
						`<pre style="background:#1e1e1e;color:#d4d4d4;padding:12px 16px;border-radius:6px;font-family:'Cascadia Code','Consolas','Courier New',monospace;font-size:13px;overflow-x:auto;white-space:pre;border:1px solid #333;margin-top:4px"><code class="${engine === 'sql' ? 'sql' : 'kql'}">${escHtml(query)}</code></pre>`
					);
					textParts.push('Query\n' + query);
				}
			}

			if (includeResults && Array.isArray(columns) && columns.length > 0 && Array.isArray(rowsData) && rowsData.length > 0) {
				const thCells = columns.map(column => `<th align="left" style="border:1px solid #555;padding:6px 10px;background:#2d2d2d;color:#e0e0e0;text-align:left;font-weight:600;font-size:12px;white-space:nowrap">${escHtml(column)}</th>`).join('');
				const bodyRows = rowsData.map((row, rowIndex) => {
					const background = rowIndex % 2 === 0 ? '#1e1e1e' : '#252526';
					const cells = row.map(value => `<td align="left" style="border:1px solid #444;padding:4px 10px;color:#d4d4d4;font-size:12px;white-space:nowrap;text-align:left">${escHtml(value)}</td>`).join('');
					return `<tr style="background:${background}">${cells}</tr>`;
				}).join('');

				const escCell = (value: string) => value.replace(/\|/g, '\\|').replace(/\n/g, ' ');
				const headerRow = '| ' + columns.map(escCell).join(' | ') + ' |';
				const separator = '| ' + columns.map(() => '---').join(' | ') + ' |';
				const dataRows = rowsData.map(row =>
					'| ' + row.map(escCell).join(' | ') + ' |'
				).join('\n');

				const shownRows = rowsData.length;
				const total = typeof totalRows === 'number' && totalRows > 0 ? totalRows : shownRows;
				const summaryLine = total > shownRows
					? `Showing ${shownRows.toLocaleString()} of ${total.toLocaleString()} rows`
					: `${shownRows.toLocaleString()} rows`;

				htmlParts.push(
					`<b style="font-size:13px">Results</b><br>` +
					`<span style="font-size:11px;color:#888;font-style:italic">${escHtml(summaryLine)}</span>` +
					`<table style="border-collapse:collapse;font-family:'Segoe UI',sans-serif;margin:4px 0"><thead><tr>${thCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
				);

				textParts.push('Results\n' + summaryLine + '\n' + headerRow + '\n' + separator + '\n' + dataRows);
			}

			if (htmlParts.length === 0) {
				vscode.window.showInformationMessage('Nothing to share â€” the selected sections are empty.');
				return;
			}

			const html = htmlParts.join('<br><br>');
			const text = textParts.join('\n\n');

			this.postMessage({ type: 'shareContentReady', html, text });
			vscode.window.showInformationMessage('Copied to clipboard and ready to paste into Teams.');
		} catch {
			if (!this.disposed) {
				vscode.window.showErrorMessage('Failed to copy share content to clipboard.');
			}
		}
	}
}
