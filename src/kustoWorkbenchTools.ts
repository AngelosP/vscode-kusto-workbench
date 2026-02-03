import * as vscode from 'vscode';
import { ConnectionManager, KustoConnection } from './connectionManager';
import { createEmptyKqlxOrMdxFile, KqlxFileKind, KqlxSectionV1 } from './kqlxFormat';

// ─────────────────────────────────────────────────────────────────────────────
// Types for tool inputs
// ─────────────────────────────────────────────────────────────────────────────

export interface ListConnectionsInput {
	// No input required
}

export interface ListFavoritesInput {
	// No input required
}

export interface ListSchemasInput {
	clusterUrl?: string;
	database?: string;
}

export interface ListSectionsInput {
	// No input required
}

export interface AddSectionInput {
	type: 'query' | 'markdown' | 'chart' | 'transformation' | 'url' | 'python';
	/** For query sections: initial query text */
	query?: string;
	/** For query sections: cluster URL to connect to */
	clusterUrl?: string;
	/** For query sections: database to connect to */
	database?: string;
	/** For markdown sections: initial text content */
	text?: string;
	/** For URL sections: the URL to embed */
	url?: string;
	/** For chart sections: data source section ID */
	dataSourceId?: string;
	/** For chart sections: chart type */
	chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel';
	/** Section name/title */
	name?: string;
}

export interface RemoveSectionInput {
	sectionId: string;
}

export interface CollapseSectionInput {
	sectionId: string;
	collapsed: boolean;
}

export interface ReorderSectionsInput {
	/** Array of section IDs in the desired order. All section IDs must be included. */
	sectionIds: string[];
}

export interface ConfigureQuerySectionInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	query?: string;
	clusterUrl?: string;
	database?: string;
	execute?: boolean;
}

export interface UpdateMarkdownSectionInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	text?: string;
	mode?: 'preview' | 'markdown' | 'wysiwyg';
}

export interface ConfigureChartInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	dataSourceId?: string;
	chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel';
	xColumn?: string;
	yColumns?: string[];
	legendColumn?: string;
	legendPosition?: 'left' | 'right' | 'top' | 'bottom';
	showDataLabels?: boolean;
}

export interface ConfigureTransformationInput {
	sectionId: string;
	/** Optional name/title for the section */
	name?: string;
	dataSourceId?: string;
	transformationType?: 'derive' | 'summarize' | 'distinct' | 'pivot';
	// For distinct
	distinctColumn?: string;
	// For summarize
	groupByColumns?: string[];
	aggregations?: Array<{ name?: string; column?: string; function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'distinct' }>;
	// For derive
	deriveColumns?: Array<{ name: string; expression: string }>;
	// For pivot
	pivotRowKeyColumn?: string;
	pivotColumnKeyColumn?: string;
	pivotValueColumn?: string;
	pivotAggregation?: 'sum' | 'avg' | 'count' | 'first';
}

export interface DelegateToKustoWorkbenchCopilotInput {
	/** The question or request to send to Kusto Workbench Copilot */
	question: string;
	/** Optional: The ID of a query section to use. If not provided, one will be created or the first available will be used. */
	sectionId?: string;
	/** Optional: Cluster URL to connect to (e.g., 'https://help.kusto.windows.net'). If not provided, uses the current connection. */
	clusterUrl?: string;
	/** Optional: Database name to use. If not provided, uses the current database. */
	database?: string;
}

export interface CreateFileInput {
	/**
	 * The type of file to create:
	 * - kqlx: Kusto Notebook (rich notebook with multiple sections)
	 * - mdx: Markdown-focused notebook (same format as kqlx, but defaults to markdown-first)
	 * - kql: Plain Kusto query file
	 * - csl: Plain Kusto query file (alternative extension)
	 * - md: Plain markdown file
	 * - kql-sidecar: Creates both a .kql file and its companion .kql.json sidecar file
	 * - csl-sidecar: Creates both a .csl file and its companion .csl.json sidecar file
	 */
	fileType: 'kqlx' | 'mdx' | 'kql' | 'csl' | 'md' | 'kql-sidecar' | 'csl-sidecar';
	/**
	 * The full file path (without extension) where the file should be created.
	 * The LLM must always provide a filename. If not provided, a default will be generated.
	 * Example: '/path/to/my-queries/analysis' will create 'analysis.kqlx' (or appropriate extension)
	 */
	filePath?: string;
	/**
	 * Optional: Initial content to add to the file.
	 * - For kqlx/mdx: An initial query or markdown text
	 * - For kql/csl/kql-sidecar/csl-sidecar: The initial KQL query
	 * - For md: The initial markdown content
	 */
	initialContent?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helper types for favorites
// ─────────────────────────────────────────────────────────────────────────────

interface KustoFavorite {
	name: string;
	clusterUrl: string;
	database: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Orchestrator - manages communication with the active webview
// ─────────────────────────────────────────────────────────────────────────────

// Simplified section type for tool orchestrator (doesn't need full KqlxSectionV1)
interface ToolSection {
	id?: string;
	type: string;
	name?: string;
	title?: string;
	expanded?: boolean;
	clusterUrl?: string;
	database?: string;
	[key: string]: unknown;
}

export class KustoWorkbenchToolOrchestrator {
	private static instance: KustoWorkbenchToolOrchestrator | undefined;
	
	// Callback to post messages to the active webview
	private webviewMessagePoster: ((message: unknown) => void) | undefined;
	// Callback to get the current state from the webview
	private stateGetter: (() => Promise<ToolSection[] | undefined>) | undefined;
	// Callback to get cached schemas
	private schemaGetter: ((clusterUrl?: string, database?: string) => Promise<Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>>) | undefined;
	// Pending responses from webview
	private pendingResponses = new Map<string, { resolve: (value: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private responseSeq = 0;

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly connectionManager: ConnectionManager
	) {}

	static getInstance(context: vscode.ExtensionContext, connectionManager: ConnectionManager): KustoWorkbenchToolOrchestrator {
		if (!KustoWorkbenchToolOrchestrator.instance) {
			KustoWorkbenchToolOrchestrator.instance = new KustoWorkbenchToolOrchestrator(context, connectionManager);
		}
		return KustoWorkbenchToolOrchestrator.instance;
	}

	setWebviewMessagePoster(poster: ((message: unknown) => void) | undefined): void {
		this.webviewMessagePoster = poster;
	}

	setStateGetter(getter: (() => Promise<ToolSection[] | undefined>) | undefined): void {
		this.stateGetter = getter;
	}

	setSchemaGetter(getter: ((clusterUrl?: string, database?: string) => Promise<Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }>>) | undefined): void {
		this.schemaGetter = getter;
	}

	handleWebviewResponse(requestId: string, result: unknown, error?: string): void {
		const pending = this.pendingResponses.get(requestId);
		if (!pending) return;
		this.pendingResponses.delete(requestId);
		clearTimeout(pending.timer);
		if (error) {
			pending.reject(new Error(error));
		} else {
			pending.resolve(result);
		}
	}

	private async sendToWebview<T>(type: string, payload: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
		if (!this.webviewMessagePoster) {
			throw new Error('Kusto Workbench is not currently open. Please open a .kqlx file or use the Query Editor first.');
		}
		
		const requestId = `tool_${++this.responseSeq}_${Date.now()}`;
		
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pendingResponses.delete(requestId);
				reject(new Error('Request timed out'));
			}, timeoutMs);
			
			this.pendingResponses.set(requestId, { 
				resolve: resolve as (value: unknown) => void, 
				reject, 
				timer 
			});
			
			this.webviewMessagePoster!({ type, requestId, ...payload });
		});
	}

	// ─────────────────────────────────────────────────────────────────────────
	// Tool implementations
	// ─────────────────────────────────────────────────────────────────────────

	async listConnections(): Promise<{ connections: KustoConnection[] }> {
		const connections = this.connectionManager.getConnections();
		return { connections };
	}

	async listFavorites(): Promise<{ favorites: KustoFavorite[] }> {
		const raw = this.context.globalState.get<unknown>('kusto.favorites');
		if (!Array.isArray(raw)) {
			return { favorites: [] };
		}
		const favorites: KustoFavorite[] = [];
		for (const item of raw) {
			if (!item || typeof item !== 'object') continue;
			const maybe = item as Partial<KustoFavorite>;
			const name = String(maybe.name || '').trim();
			const clusterUrl = String(maybe.clusterUrl || '').trim();
			const database = String(maybe.database || '').trim();
			if (name && clusterUrl && database) {
				favorites.push({ name, clusterUrl, database });
			}
		}
		return { favorites };
	}

	async listSchemas(input: ListSchemasInput): Promise<{ schemas: Array<{ clusterUrl: string; database: string; tables: string[]; functions: string[] }> }> {
		if (!this.schemaGetter) {
			return { schemas: [] };
		}
		const schemas = await this.schemaGetter(input.clusterUrl, input.database);
		return { schemas };
	}

	async listSections(): Promise<{ sections: Array<{ id: string; type: string; name?: string; expanded?: boolean; clusterUrl?: string; database?: string }> }> {
		if (!this.stateGetter) {
			throw new Error('Kusto Workbench is not currently open.');
		}
		const rawSections = await this.stateGetter();
		if (!rawSections) {
			return { sections: [] };
		}
		const sections = rawSections.map((s, idx) => {
			const id = typeof s.id === 'string' ? s.id : `section_${idx}`;
			const type = typeof s.type === 'string' ? s.type : 'unknown';
			const name = typeof s.name === 'string' ? s.name : (typeof s.title === 'string' ? s.title : '');
			const expanded = s.expanded !== false;
			const clusterUrl = typeof s.clusterUrl === 'string' ? s.clusterUrl : '';
			const database = typeof s.database === 'string' ? s.database : '';
			return { id, type, name, expanded, clusterUrl, database };
		});
		return { sections };
	}

	async addSection(input: AddSectionInput): Promise<{ sectionId: string; success: boolean }> {
		return this.sendToWebview('toolAddSection', { input });
	}

	async removeSection(input: RemoveSectionInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolRemoveSection', { sectionId: input.sectionId });
	}

	async collapseSection(input: CollapseSectionInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolCollapseSection', { sectionId: input.sectionId, collapsed: input.collapsed });
	}

	async reorderSections(input: ReorderSectionsInput): Promise<{ success: boolean; error?: string }> {
		return this.sendToWebview('toolReorderSections', { sectionIds: input.sectionIds });
	}

	async configureQuerySection(input: ConfigureQuerySectionInput): Promise<{ success: boolean; resultPreview?: string }> {
		return this.sendToWebview('toolConfigureQuerySection', { input });
	}

	async updateMarkdownSection(input: UpdateMarkdownSectionInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolUpdateMarkdownSection', { input });
	}

	async configureChart(input: ConfigureChartInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolConfigureChart', { input });
	}

	async configureTransformation(input: ConfigureTransformationInput): Promise<{ success: boolean }> {
		return this.sendToWebview('toolConfigureTransformation', { input });
	}

	async delegateToKustoWorkbenchCopilot(input: DelegateToKustoWorkbenchCopilotInput): Promise<{
		success: boolean;
		answer: string;
		query?: string;
		executed?: boolean;
		rowCount?: number;
		columns?: string[];
		results?: Array<Record<string, unknown>>;
		error?: string;
		timedOut?: boolean;
	}> {
		return this.sendToWebview('toolDelegateToKustoWorkbenchCopilot', { input }, 180000); // 3 minute timeout for Copilot + query execution
	}

	async createFile(input: CreateFileInput): Promise<{
		success: boolean;
		filePath?: string;
		error?: string;
	}> {
		const { fileType, filePath: requestedPath, initialContent } = input;

		// Determine the file extension and editor to use
		let extension: string;
		let sidecarExtension: string | undefined;
		let editorId: string;
		let isSidecar = false;
		let kqlxKind: KqlxFileKind | undefined;

		switch (fileType) {
			case 'kqlx':
				extension = '.kqlx';
				editorId = 'kusto.kqlxEditor';
				kqlxKind = 'kqlx';
				break;
			case 'mdx':
				extension = '.mdx';
				editorId = 'kusto.kqlxEditor';
				kqlxKind = 'mdx';
				break;
			case 'kql':
				extension = '.kql';
				editorId = 'kusto.kqlCompatEditor';
				break;
			case 'csl':
				extension = '.csl';
				editorId = 'kusto.kqlCompatEditor';
				break;
			case 'md':
				extension = '.md';
				editorId = 'kusto.mdCompatEditor';
				break;
			case 'kql-sidecar':
				extension = '.kql';
				sidecarExtension = '.kql.json';
				editorId = 'kusto.kqlCompatEditor';
				isSidecar = true;
				break;
			case 'csl-sidecar':
				extension = '.csl';
				sidecarExtension = '.csl.json';
				editorId = 'kusto.kqlCompatEditor';
				isSidecar = true;
				break;
			default:
				return { success: false, error: `Unknown file type: ${fileType}` };
		}

		// Determine the file URI
		let fileUri: vscode.Uri | undefined;
		
		if (requestedPath) {
			// Use the provided path (add extension if not present)
			let fullPath = requestedPath;
			if (!fullPath.endsWith(extension)) {
				fullPath = fullPath + extension;
			}
			fileUri = vscode.Uri.file(fullPath);
		} else {
			// Generate a default filename in the workspace folder
			const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri;
			if (!workspaceFolder) {
				return { success: false, error: 'No workspace folder open. Please provide a full file path or open a folder first.' };
			}
			
			// Generate a unique filename based on the file type and timestamp
			const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
			const baseName = fileType === 'kqlx' || fileType === 'mdx' 
				? `kusto-notebook-${timestamp}`
				: fileType === 'md'
					? `notes-${timestamp}`
					: `query-${timestamp}`;
			
			fileUri = vscode.Uri.joinPath(workspaceFolder, baseName + extension);
		}

		if (!fileUri) {
			return { success: false, error: 'File creation cancelled' };
		}

		try {
			// Create the file content based on file type
			let content: string;
			
			if (kqlxKind) {
				// Create kqlx/mdx notebook
				const file = createEmptyKqlxOrMdxFile(kqlxKind);
				
				// Add initial content as a section if provided
				if (initialContent) {
					const initialSection: KqlxSectionV1 = {
						type: kqlxKind === 'mdx' ? 'markdown' : 'query',
						expanded: true,
						...(kqlxKind === 'mdx' 
							? { text: initialContent } 
							: { query: initialContent }
						)
					};
					file.state.sections.push(initialSection);
				}
				
				content = JSON.stringify(file, null, 2);
			} else if (fileType === 'md') {
				// Plain markdown file
				content = initialContent || '';
			} else {
				// Plain KQL/CSL file
				content = initialContent || '';
			}

			// Write the main file
			await vscode.workspace.fs.writeFile(fileUri, new TextEncoder().encode(content));

			// Create sidecar file if needed
			if (isSidecar && sidecarExtension) {
				const sidecarPath = fileUri.fsPath.replace(extension, sidecarExtension);
				const sidecarUri = vscode.Uri.file(sidecarPath);
				
				// Create empty sidecar with link to main file
				const baseName = fileUri.fsPath.split(/[\\/]/).pop() || '';
				const sidecarContent = JSON.stringify({
					kind: 'kqlx',
					version: 1,
					state: {
						linkedQueryPath: baseName,
						sections: []
					}
				}, null, 2);
				
				await vscode.workspace.fs.writeFile(sidecarUri, new TextEncoder().encode(sidecarContent));
			}

			// Open the file with the appropriate editor
			await vscode.commands.executeCommand('vscode.openWith', fileUri, editorId);

			return { success: true, filePath: fileUri.fsPath };
		} catch (err) {
			return {
				success: false,
				error: `Failed to create file: ${err instanceof Error ? err.message : String(err)}`
			};
		}
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool implementations as LanguageModelTool classes
// ─────────────────────────────────────────────────────────────────────────────

export class ListConnectionsTool implements vscode.LanguageModelTool<ListConnectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListConnectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listConnections();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ListFavoritesTool implements vscode.LanguageModelTool<ListFavoritesInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListFavoritesInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listFavorites();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ListSchemasTool implements vscode.LanguageModelTool<ListSchemasInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ListSchemasInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listSchemas(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ListSectionsTool implements vscode.LanguageModelTool<ListSectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		_options: vscode.LanguageModelToolInvocationOptions<ListSectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.listSections();
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class AddSectionTool implements vscode.LanguageModelTool<AddSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<AddSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.addSection(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class RemoveSectionTool implements vscode.LanguageModelTool<RemoveSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<RemoveSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.removeSection(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class CollapseSectionTool implements vscode.LanguageModelTool<CollapseSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CollapseSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.collapseSection(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ReorderSectionsTool implements vscode.LanguageModelTool<ReorderSectionsInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ReorderSectionsInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.reorderSections(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureQuerySectionTool implements vscode.LanguageModelTool<ConfigureQuerySectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureQuerySectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureQuerySection(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class UpdateMarkdownSectionTool implements vscode.LanguageModelTool<UpdateMarkdownSectionInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<UpdateMarkdownSectionInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.updateMarkdownSection(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureChartTool implements vscode.LanguageModelTool<ConfigureChartInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureChartInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureChart(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class ConfigureTransformationTool implements vscode.LanguageModelTool<ConfigureTransformationInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<ConfigureTransformationInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.configureTransformation(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}
}

export class DelegateToKustoWorkbenchCopilotTool implements vscode.LanguageModelTool<DelegateToKustoWorkbenchCopilotInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<DelegateToKustoWorkbenchCopilotInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.delegateToKustoWorkbenchCopilot(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<DelegateToKustoWorkbenchCopilotInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const question = options.input?.question || 'your question';
		return {
			invocationMessage: `Asking Kusto Workbench Copilot: "${question.slice(0, 100)}${question.length > 100 ? '...' : ''}"`
		};
	}
}

export class CreateFileTool implements vscode.LanguageModelTool<CreateFileInput> {
	constructor(private orchestrator: KustoWorkbenchToolOrchestrator) {}

	async invoke(
		options: vscode.LanguageModelToolInvocationOptions<CreateFileInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.LanguageModelToolResult> {
		try {
			const result = await this.orchestrator.createFile(options.input);
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(JSON.stringify(result, null, 2))
			]);
		} catch (err) {
			return new vscode.LanguageModelToolResult([
				new vscode.LanguageModelTextPart(`Error: ${err instanceof Error ? err.message : String(err)}`)
			]);
		}
	}

	async prepareInvocation(
		options: vscode.LanguageModelToolInvocationPrepareOptions<CreateFileInput>,
		_token: vscode.CancellationToken
	): Promise<vscode.PreparedToolInvocation> {
		const fileType = options.input?.fileType || 'kqlx';
		const filePath = options.input?.filePath;
		const message = filePath
			? `Creating ${fileType} file: ${filePath}`
			: `Creating new ${fileType} file...`;
		return {
			invocationMessage: message
		};
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Registration helper
// ─────────────────────────────────────────────────────────────────────────────

export function registerKustoWorkbenchTools(
	context: vscode.ExtensionContext,
	connectionManager: ConnectionManager
): KustoWorkbenchToolOrchestrator {
	const orchestrator = KustoWorkbenchToolOrchestrator.getInstance(context, connectionManager);

	// Register all tools using the languageModelTools[].name values from package.json
	// This is how VS Code binds the manifest contribution to the implementation
	context.subscriptions.push(
		vscode.lm.registerTool('kusto-workbench_list-connections', new ListConnectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-favorites', new ListFavoritesTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-schemas', new ListSchemasTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_list-sections', new ListSectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_add-section', new AddSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_remove-section', new RemoveSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_collapse-section', new CollapseSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_reorder-sections', new ReorderSectionsTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-query-section', new ConfigureQuerySectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_update-markdown-section', new UpdateMarkdownSectionTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-chart', new ConfigureChartTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_configure-transformation', new ConfigureTransformationTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_ask-kusto-copilot', new DelegateToKustoWorkbenchCopilotTool(orchestrator)),
		vscode.lm.registerTool('kusto-workbench_create-file', new CreateFileTool(orchestrator))
	);

	return orchestrator;
}
