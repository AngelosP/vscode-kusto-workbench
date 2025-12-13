import * as vscode from 'vscode';

import { ConnectionManager, KustoConnection } from './connectionManager';
import { KustoQueryClient } from './kustoClient';

const OUTPUT_CHANNEL_NAME = 'Notebooks for Kusto';

const STORAGE_KEYS = {
lastConnectionId: 'kusto.lastConnectionId',
lastDatabase: 'kusto.lastDatabase',
cachedDatabases: 'kusto.cachedDatabases'
} as const;

type CacheUnit = 'minutes' | 'hours' | 'days';

type IncomingWebviewMessage =
| { type: 'getConnections' }
| { type: 'getDatabases'; connectionId: string; boxId: string }
| { type: 'refreshDatabases'; connectionId: string; boxId: string }
| {
type: 'executeQuery';
query: string;
connectionId: string;
database?: string;
queryMode?: string;
cacheEnabled?: boolean;
cacheValue?: number;
cacheUnit?: CacheUnit | string;
  }
| { type: 'prefetchSchema'; connectionId: string; database: string; boxId: string };

export class QueryEditorProvider {
private panel?: vscode.WebviewPanel;
private readonly kustoClient = new KustoQueryClient();
private lastConnectionId?: string;
private lastDatabase?: string;
private readonly output = vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);

constructor(
private readonly extensionUri: vscode.Uri,
private readonly connectionManager: ConnectionManager,
private readonly context: vscode.ExtensionContext
) {
this.loadLastSelection();
}

async openEditor(): Promise<void> {
if (this.panel) {
this.panel.reveal(vscode.ViewColumn.One);
return;
}

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

this.panel.webview.html = await this.getHtmlContent(this.panel.webview);

this.panel.webview.onDidReceiveMessage((message: IncomingWebviewMessage) => {
return this.handleWebviewMessage(message);
});

this.panel.onDidDispose(() => {
this.panel = undefined;
});
}

private async handleWebviewMessage(message: IncomingWebviewMessage): Promise<void> {
switch (message.type) {
case 'getConnections':
await this.sendConnectionsData();
return;
case 'getDatabases':
await this.sendDatabases(message.connectionId, message.boxId, false);
return;
case 'refreshDatabases':
await this.sendDatabases(message.connectionId, message.boxId, true);
return;
case 'executeQuery':
await this.executeQueryFromWebview(message);
return;
case 'prefetchSchema':
await this.prefetchSchema(message.connectionId, message.database, message.boxId);
return;
default:
return;
}
}

private postMessage(message: unknown): void {
void this.panel?.webview.postMessage(message);
}

private loadLastSelection(): void {
this.lastConnectionId = this.context.globalState.get<string>(STORAGE_KEYS.lastConnectionId);
this.lastDatabase = this.context.globalState.get<string>(STORAGE_KEYS.lastDatabase);
}

private getCachedDatabases(): Record<string, string[]> {
return this.context.globalState.get<Record<string, string[]>>(STORAGE_KEYS.cachedDatabases, {});
}

private async saveCachedDatabases(connectionId: string, databases: string[]): Promise<void> {
const cached = this.getCachedDatabases();
cached[connectionId] = databases;
await this.context.globalState.update(STORAGE_KEYS.cachedDatabases, cached);
}

private async saveLastSelection(connectionId: string, database?: string): Promise<void> {
this.lastConnectionId = connectionId;
this.lastDatabase = database;
await this.context.globalState.update(STORAGE_KEYS.lastConnectionId, connectionId);
await this.context.globalState.update(STORAGE_KEYS.lastDatabase, database);
}

private findConnection(connectionId: string): KustoConnection | undefined {
return this.connectionManager.getConnections().find((c) => c.id === connectionId);
}

private async sendConnectionsData(): Promise<void> {
const connections = this.connectionManager.getConnections();
const cachedDatabases = this.getCachedDatabases();

this.postMessage({
type: 'connectionsData',
connections,
lastConnectionId: this.lastConnectionId,
lastDatabase: this.lastDatabase,
cachedDatabases
});
}

private async sendDatabases(connectionId: string, boxId: string, forceRefresh: boolean): Promise<void> {
const connection = this.findConnection(connectionId);
if (!connection) {
return;
}

try {
const databases = await this.kustoClient.getDatabases(connection, forceRefresh);
await this.saveCachedDatabases(connectionId, databases);
this.postMessage({ type: 'databasesData', databases, boxId });
} catch (error) {
const errorMessage = error instanceof Error ? error.message : String(error);
vscode.window.showErrorMessage(`Failed to fetch databases: ${errorMessage}`);
this.postMessage({ type: 'databasesData', databases: [], boxId });
}
}

private async executeQueryFromWebview(
message: Extract<IncomingWebviewMessage, { type: 'executeQuery' }>
): Promise<void> {
await this.saveLastSelection(message.connectionId, message.database);

const connection = this.findConnection(message.connectionId);
if (!connection) {
vscode.window.showErrorMessage('Connection not found');
return;
}

if (!message.database) {
vscode.window.showErrorMessage('Please select a database');
return;
}

const queryWithMode = this.appendQueryMode(message.query, message.queryMode);
const cacheDirective = this.buildCacheDirective(message.cacheEnabled, message.cacheValue, message.cacheUnit);
const finalQuery = cacheDirective ? `${cacheDirective}\n${queryWithMode}` : queryWithMode;

try {
const result = await this.kustoClient.executeQuery(connection, message.database, finalQuery);
this.postMessage({ type: 'queryResult', result });
} catch (error) {
const errorMessage = error instanceof Error ? error.message : String(error);
vscode.window.showErrorMessage(`Query execution failed: ${errorMessage}`);
this.postMessage({ type: 'queryError', error: errorMessage });
}
}

private buildCacheDirective(
cacheEnabled?: boolean,
cacheValue?: number,
cacheUnit?: CacheUnit | string
): string | undefined {
if (!cacheEnabled || !cacheValue || !cacheUnit) {
return undefined;
}

const unit = String(cacheUnit).toLowerCase();
let timespan: string | undefined;
switch (unit) {
case 'minutes':
timespan = `time(${cacheValue}m)`;
break;
case 'hours':
timespan = `time(${cacheValue}h)`;
break;
case 'days':
timespan = `time(${cacheValue}d)`;
break;
default:
return undefined;
}

return `set query_results_cache_max_age = ${timespan};`;
}

private appendQueryMode(query: string, queryMode?: string): string {
const mode = (queryMode ?? '').toLowerCase();
let fragment = '';
switch (mode) {
case 'take100':
fragment = '| take 100';
break;
case 'sample100':
fragment = '| sample 100';
break;
case 'plain':
case '':
default:
return query;
}

const base = query.replace(/\s+$/g, '').replace(/;+\s*$/g, '');
return `${base}\n${fragment}`;
}

private async prefetchSchema(connectionId: string, database: string, boxId: string): Promise<void> {
const connection = this.findConnection(connectionId);
if (!connection || !database) {
return;
}

try {
this.output.appendLine(`[schema] request connectionId=${connectionId} db=${database}`);
const result = await this.kustoClient.getDatabaseSchema(connection, database, false);
const schema = result.schema;

const tablesCount = schema.tables?.length ?? 0;
let columnsCount = 0;
for (const cols of Object.values(schema.columnsByTable || {})) {
columnsCount += cols.length;
}

this.output.appendLine(
`[schema] loaded db=${database} tables=${tablesCount} columns=${columnsCount} fromCache=${result.fromCache}`
);
if (tablesCount === 0 || columnsCount === 0) {
const d = result.debug;
if (d) {
this.output.appendLine(`[schema] debug command=${d.commandUsed ?? ''}`);
this.output.appendLine(`[schema] debug columns=${(d.primaryColumns ?? []).join(', ')}`);
this.output.appendLine(
`[schema] debug sampleRowType=${d.sampleRowType ?? ''} keys=${(d.sampleRowKeys ?? []).join(', ')}`
);
this.output.appendLine(`[schema] debug sampleRowPreview=${d.sampleRowPreview ?? ''}`);
}
}

this.postMessage({
type: 'schemaData',
boxId,
connectionId,
database,
schema,
schemaMeta: {
fromCache: result.fromCache,
cacheAgeMs: result.cacheAgeMs,
tablesCount,
columnsCount,
debug: result.debug
}
});
} catch (error) {
const errorMessage = error instanceof Error ? error.message : String(error);
this.output.appendLine(`[schema] error db=${database}: ${errorMessage}`);
this.postMessage({ type: 'schemaError', boxId, connectionId, database, error: errorMessage });
}
}

private async getHtmlContent(webview: vscode.Webview): Promise<string> {
const templateUri = vscode.Uri.joinPath(this.extensionUri, 'media', 'queryEditor.html');
const templateBytes = await vscode.workspace.fs.readFile(templateUri);
const template = new TextDecoder('utf-8').decode(templateBytes);

const monacoVsUri = webview
.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs'))
.toString();
const monacoLoaderUri = webview
.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs', 'loader.js'))
.toString();
const monacoCssUri = webview
.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs', 'editor', 'editor.main.css'))
.toString();

return template
.replaceAll('{{monacoVsUri}}', monacoVsUri)
.replaceAll('{{monacoLoaderUri}}', monacoLoaderUri)
.replaceAll('{{monacoCssUri}}', monacoCssUri);
}
}
