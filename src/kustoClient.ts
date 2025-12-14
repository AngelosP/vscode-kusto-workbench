import { KustoConnection } from './connectionManager';
import * as vscode from 'vscode';

export interface QueryResult {
	columns: string[];
	rows: any[][];
	metadata: {
		cluster: string;
		database: string;
		executionTime: string;
	};
}

export interface DatabaseSchemaIndex {
	tables: string[];
	columnsByTable: Record<string, string[]>;
}

export interface DatabaseSchemaResult {
	schema: DatabaseSchemaIndex;
	fromCache: boolean;
	cacheAgeMs?: number;
	debug?: {
		commandUsed?: string;
		primaryColumns?: string[];
		sampleRowType?: string;
		sampleRowKeys?: string[];
		sampleRowPreview?: string;
	};
}

export class QueryCancelledError extends Error {
	readonly isCancelled = true;
	constructor(message: string = 'Query cancelled') {
		super(message);
		this.name = 'QueryCancelledError';
	}
}

export class KustoQueryClient {
	private clients: Map<string, any> = new Map();
	private databaseCache: Map<string, { databases: string[], timestamp: number }> = new Map();
	private schemaCache: Map<string, { schema: DatabaseSchemaIndex; timestamp: number }> = new Map();
	private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes
	private readonly SCHEMA_CACHE_TTL = 24 * 60 * 60 * 1000; // 1 day

	private normalizeClusterEndpoint(clusterUrl: string): string {
		const raw = String(clusterUrl || '').trim();
		if (!raw) {
			return '';
		}
		try {
			const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
			const u = new URL(withScheme);
			let host = String(u.hostname || '').trim();
			// If we got a short name like "help" or "mycluster.westus", expand it.
			// This intentionally targets the common public ADX domain.
			if (host && !/\.kusto\./i.test(host)) {
				host = `${host}.kusto.windows.net`;
			}
			const protocol = u.protocol && /^https?:$/i.test(u.protocol) ? u.protocol : 'https:';
			return `${protocol}//${host}`;
		} catch {
			// Best-effort string fallback.
			let v = raw;
			if (!/^https?:\/\//i.test(v)) {
				v = `https://${v.replace(/^\/+/, '')}`;
			}
			try {
				const u2 = new URL(v);
				let host = String(u2.hostname || '').trim();
				if (host && !/\.kusto\./i.test(host)) {
					host = `${host}.kusto.windows.net`;
				}
				return `${u2.protocol}//${host}`;
			} catch {
				return v;
			}
		}
	}

	private async getOrCreateClient(connection: KustoConnection): Promise<any> {
		if (this.clients.has(connection.id)) {
			return this.clients.get(connection.id)!;
		}

		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}

		// Get access token using VS Code's built-in authentication
		const session = await vscode.authentication.getSession('microsoft', ['https://kusto.kusto.windows.net/.default'], { createIfNone: true });
		
		if (!session) {
			throw new Error('Failed to authenticate with Microsoft');
		}

		// Dynamic import to handle ESM module
		const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data');
		
		// Use Azure AD access token authentication
		const kcsb = KustoConnectionStringBuilder.withAccessToken(
			clusterEndpoint,
			session.accessToken
		);
		
		const client = new Client(kcsb);
		this.clients.set(connection.id, client);
		return client;
	}

	private async createDedicatedClient(connection: KustoConnection): Promise<any> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		if (!clusterEndpoint) {
			throw new Error('Cluster URL is missing.');
		}

		// Get access token using VS Code's built-in authentication
		const session = await vscode.authentication.getSession(
			'microsoft',
			['https://kusto.kusto.windows.net/.default'],
			{ createIfNone: true }
		);
		if (!session) {
			throw new Error('Failed to authenticate with Microsoft');
		}
		const { Client, KustoConnectionStringBuilder } = await import('azure-kusto-data');
		const kcsb = KustoConnectionStringBuilder.withAccessToken(clusterEndpoint, session.accessToken);
		return new Client(kcsb);
	}

	private isLikelyCancellationError(error: unknown): boolean {
		const anyErr = error as any;
		if (anyErr?.isCancelled === true) {
			return true;
		}
		// Axios cancel token errors commonly set __CANCEL or use messages like "canceled".
		if (anyErr?.__CANCEL === true) {
			return true;
		}
		const msg = typeof anyErr?.message === 'string' ? anyErr.message : '';
		return /cancel(l)?ed|canceled|client closed|aborted/i.test(msg);
	}

	async getDatabases(connection: KustoConnection, forceRefresh: boolean = false): Promise<string[]> {
		try {
			const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
			// Check cache first
			if (!forceRefresh) {
				const cached = this.databaseCache.get(clusterEndpoint);
				if (cached && (Date.now() - cached.timestamp) < this.CACHE_TTL) {
					console.log('Returning cached databases for:', clusterEndpoint);
					return cached.databases;
				}
			}

			console.log('Fetching databases for cluster:', clusterEndpoint);
			const client = await this.getOrCreateClient(connection);
			
			console.log('Executing .show databases command');
			const result = await client.execute('', '.show databases');
			console.log('Query result received:', result);
			
			const databases: string[] = [];
			
			// Extract database names from the result
			const primaryResults = result.primaryResults[0];
			console.log('Primary results columns:', primaryResults.columns);
			
			for (const row of primaryResults.rows()) {
				// Database name is typically in the first column
				const dbName = row['DatabaseName'] || row[0];
				if (dbName) {
					databases.push(dbName.toString());
				}
			}
			
			console.log('Databases found:', databases);
			
			// Update cache
			this.databaseCache.set(clusterEndpoint, {
				databases,
				timestamp: Date.now()
			});
			
			return databases;
		} catch (error) {
			console.error('Error fetching databases:', error);
			throw new Error(`Failed to fetch databases: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async executeQuery(
		connection: KustoConnection,
		database: string,
		query: string
	): Promise<QueryResult> {
		const client = await this.getOrCreateClient(connection);
		
		const startTime = Date.now();
		
		try {
			const result = await client.execute(database, query);
			const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';
			
			// Get the primary result
			const primaryResults = result.primaryResults[0];
			
			// Extract column names
			const columns = primaryResults.columns.map((col: any) => col.name || col.type || 'Unknown');
			
			// Helper function to format cell values
			const formatCellValue = (cell: any): { display: string; full: string; isObject?: boolean; rawObject?: any } => {
				if (cell === null || cell === undefined) {
					return { display: 'null', full: 'null' };
				}
				
				// Check if it's a Date object
				if (cell instanceof Date) {
					const full = cell.toString();
					// Format as YYYY-MM-DD HH:MM:SS
					const display = cell.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
					return { display, full };
				}
				
				// Check if it's an object or array (complex structure)
				if (typeof cell === 'object') {
					try {
						// Check if object/array is empty
						const isEmpty = Array.isArray(cell) 
							? cell.length === 0 
							: Object.keys(cell).length === 0;
						
						if (isEmpty) {
							const display = Array.isArray(cell) ? '[]' : '{}';
							return { display, full: display };
						}
						
						const jsonStr = JSON.stringify(cell, null, 2);
						return { 
							display: '[object]', 
							full: jsonStr,
							isObject: true,
							rawObject: cell
						};
					} catch (e) {
						// If JSON.stringify fails, fall back to string representation
						const str = String(cell);
						return { display: str, full: str };
					}
				}
				
				// Check if it's a string that looks like an ISO date
				const str = String(cell);
				const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
				if (isoDateRegex.test(str)) {
					try {
						const date = new Date(str);
						if (!isNaN(date.getTime())) {
							const full = date.toString();
							// Format as YYYY-MM-DD HH:MM:SS
							const display = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
							return { display, full };
						}
					} catch (e) {
						// Not a valid date, fall through
					}
				}
				
				return { display: str, full: str };
			};
			
			// Extract rows
			const rows: any[][] = [];
			for (const row of primaryResults.rows()) {
				// Row might be an object or array, convert to array
				const rowArray: any[] = [];
				if (Array.isArray(row)) {
					rowArray.push(...row);
				} else {
					// If it's an object, extract values based on column order
					for (const col of primaryResults.columns) {
						const value = (row as any)[col.name] ?? (row as any)[col.ordinal];
						rowArray.push(value);
					}
				}
				rows.push(rowArray.map((cell: any) => formatCellValue(cell)));
			}
			
			return {
				columns,
				rows,
				metadata: {
					cluster: connection.clusterUrl,
					database: database,
					executionTime
				}
			};
		} catch (error) {
			console.error('Error executing query:', error);
			
			// Extract more detailed error information
			let errorMessage = 'Unknown error';
			if (error instanceof Error) {
				errorMessage = error.message;
				// Check if there's additional error info from Kusto
				if ((error as any).response?.data) {
					errorMessage = JSON.stringify((error as any).response.data);
				}
			} else {
				errorMessage = String(error);
			}
			
			throw new Error(`Query execution failed: ${errorMessage}`);
		}
	}

	executeQueryCancelable(
		connection: KustoConnection,
		database: string,
		query: string
	): { promise: Promise<QueryResult>; cancel: () => void } {
		let client: any | undefined;
		let cancelled = false;
		const cancel = () => {
			cancelled = true;
			try {
				client?.close?.();
			} catch {
				// ignore
			}
		};

		const promise = (async () => {
			client = await this.createDedicatedClient(connection);
			const startTime = Date.now();
			try {
				const result = await client.execute(database, query);
				const executionTime = ((Date.now() - startTime) / 1000).toFixed(3) + 's';

				const primaryResults = result.primaryResults[0];
				const columns = primaryResults.columns.map((col: any) => col.name || col.type || 'Unknown');

				const formatCellValue = (cell: any): { display: string; full: string; isObject?: boolean; rawObject?: any } => {
					if (cell === null || cell === undefined) {
						return { display: 'null', full: 'null' };
					}
					if (cell instanceof Date) {
						const full = cell.toString();
						const display = cell.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
						return { display, full };
					}
					if (typeof cell === 'object') {
						try {
							const isEmpty = Array.isArray(cell) ? cell.length === 0 : Object.keys(cell).length === 0;
							if (isEmpty) {
								const display = Array.isArray(cell) ? '[]' : '{}';
								return { display, full: display };
							}
							const jsonStr = JSON.stringify(cell, null, 2);
							return { display: '[object]', full: jsonStr, isObject: true, rawObject: cell };
						} catch {
							const str = String(cell);
							return { display: str, full: str };
						}
					}

					const str = String(cell);
					const isoDateRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
					if (isoDateRegex.test(str)) {
						try {
							const date = new Date(str);
							if (!isNaN(date.getTime())) {
								const full = date.toString();
								const display = date.toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
								return { display, full };
							}
						} catch {
							// ignore
						}
					}
					return { display: str, full: str };
				};

				const rows: any[][] = [];
				for (const row of primaryResults.rows()) {
					const rowArray: any[] = [];
					if (Array.isArray(row)) {
						rowArray.push(...row);
					} else {
						for (const col of primaryResults.columns) {
							const value = (row as any)[col.name] ?? (row as any)[col.ordinal];
							rowArray.push(value);
						}
					}
					rows.push(rowArray.map((cell: any) => formatCellValue(cell)));
				}

				return {
					columns,
					rows,
					metadata: {
						cluster: connection.clusterUrl,
						database: database,
						executionTime
					}
				};
			} catch (error) {
				if (cancelled || this.isLikelyCancellationError(error)) {
					throw new QueryCancelledError();
				}
				console.error('Error executing query:', error);
				let errorMessage = 'Unknown error';
				if (error instanceof Error) {
					errorMessage = error.message;
					if ((error as any).response?.data) {
						errorMessage = JSON.stringify((error as any).response.data);
					}
				} else {
					errorMessage = String(error);
				}
				throw new Error(`Query execution failed: ${errorMessage}`);
			} finally {
				try {
					client?.close?.();
				} catch {
					// ignore
				}
			}
		})();

		return { promise, cancel };
	}

	async getDatabaseSchema(
		connection: KustoConnection,
		database: string,
		forceRefresh: boolean = false
	): Promise<DatabaseSchemaResult> {
		const clusterEndpoint = this.normalizeClusterEndpoint(connection.clusterUrl);
		const cacheKey = `${clusterEndpoint}|${database}`;
		if (forceRefresh) {
			this.schemaCache.delete(cacheKey);
		}
		if (!forceRefresh) {
			const cached = this.schemaCache.get(cacheKey);
			if (cached && (Date.now() - cached.timestamp) < this.SCHEMA_CACHE_TTL) {
				return {
					schema: cached.schema,
					fromCache: true,
					cacheAgeMs: Date.now() - cached.timestamp
				};
			}
		}

		const client = await this.getOrCreateClient(connection);

		const tryCommands = [
			'.show database schema as json',
			'.show database schema'
		];

		let lastError: unknown = null;
		for (const command of tryCommands) {
			try {
				const result = await client.execute(database, command);
				const debug = this.buildSchemaDebug(result, command);
				const schema = this.parseDatabaseSchemaResult(result);
				this.schemaCache.set(cacheKey, { schema, timestamp: Date.now() });
				return { schema, fromCache: false, debug };
			} catch (e) {
				lastError = e;
			}
		}

		throw new Error(
			`Failed to fetch database schema: ${lastError instanceof Error ? lastError.message : String(lastError)}`
		);
	}

	private parseDatabaseSchemaResult(result: any): DatabaseSchemaIndex {
		const columnsByTable: Record<string, Set<string>> = {};
		const primary = result?.primaryResults?.[0];
		if (!primary) {
			return { tables: [], columnsByTable: {} };
		}

		// Attempt JSON-based schema first.
		try {
			// Some drivers expose rows() as iterable, not iterator.
			const rowCandidate = primary.rows ? Array.from(primary.rows())[0] : null;
			if (rowCandidate && typeof rowCandidate === 'object') {
				// If the row itself is already an object/array with schema shape, try it.
				this.extractSchemaFromJson(rowCandidate, columnsByTable);
				const direct = this.finalizeSchema(columnsByTable);
				if (direct.tables.length > 0) {
					return direct;
				}

				for (const key of Object.keys(rowCandidate)) {
					const val = (rowCandidate as any)[key];
					if (val && typeof val === 'object') {
						this.extractSchemaFromJson(val, columnsByTable);
						const finalized = this.finalizeSchema(columnsByTable);
						if (finalized.tables.length > 0) {
							return finalized;
						}
						continue;
					}

					if (typeof val === 'string') {
						const trimmed = val.trim();
						if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
							const parsed = JSON.parse(val);
							this.extractSchemaFromJson(parsed, columnsByTable);
							const finalized = this.finalizeSchema(columnsByTable);
							if (finalized.tables.length > 0) {
								return finalized;
							}
						}
					}
				}
			}
		} catch {
			// ignore and fall back to tabular parsing
		}

		// Tabular fallback: try to infer TableName/ColumnName columns.
		const colNames: string[] = (primary.columns ?? []).map((c: any) => String(c.name ?? c.type ?? '')).filter(Boolean);
		const findCol = (candidates: string[]) => {
			const lowered = colNames.map(c => c.toLowerCase());
			for (const cand of candidates) {
				const idx = lowered.indexOf(cand.toLowerCase());
				if (idx >= 0) {
					return colNames[idx];
				}
			}
			return null;
		};
		const tableCol = findCol(['TableName', 'Table', 'Name']);
		const columnCol = findCol(['ColumnName', 'Column', 'Column1', 'Name1']);

		if (primary.rows) {
			for (const row of primary.rows()) {
				const tableName = tableCol ? (row as any)[tableCol] : (row as any)['TableName'];
				const columnName = columnCol ? (row as any)[columnCol] : (row as any)['ColumnName'];
				if (!tableName || !columnName) {
					continue;
				}
				const t = String(tableName);
				const c = String(columnName);
				columnsByTable[t] ??= new Set();
				columnsByTable[t].add(c);
			}
		}

		return this.finalizeSchema(columnsByTable);
	}

	private buildSchemaDebug(result: any, commandUsed: string): DatabaseSchemaResult['debug'] {
		try {
			const primary = result?.primaryResults?.[0];
			const primaryColumns: string[] = (primary?.columns ?? []).map((c: any) => String(c?.name ?? c?.type ?? '')).filter(Boolean);
			let sampleRow: any = null;
			if (primary?.rows) {
				sampleRow = Array.from(primary.rows())[0] ?? null;
			}
			const sampleRowType = sampleRow === null ? 'null' : Array.isArray(sampleRow) ? 'array' : typeof sampleRow;
			const sampleRowKeys = sampleRow && typeof sampleRow === 'object' ? Object.keys(sampleRow).slice(0, 20) : [];
			let sampleRowPreview = '';
			try {
				sampleRowPreview = JSON.stringify(sampleRow)?.slice(0, 500) ?? '';
			} catch {
				sampleRowPreview = String(sampleRow)?.slice(0, 500) ?? '';
			}
			return { commandUsed, primaryColumns, sampleRowType, sampleRowKeys, sampleRowPreview };
		} catch {
			return { commandUsed };
		}
	}

	private extractSchemaFromJson(parsed: any, columnsByTable: Record<string, Set<string>>) {
		if (!parsed) {
			return;
		}

		// Shape observed from `.show database schema as json`:
		// {
		//   Databases: {
		//     <DbName>: {
		//       Name: <DbName>,
		//       Tables: {
		//         <TableName>: { Name: <TableName>, OrderedColumns: [ { Name: ... } ] }
		//       }
		//     }
		//   }
		// }
		const databases = parsed.Databases ?? parsed.databases;
		if (databases && typeof databases === 'object' && !Array.isArray(databases)) {
			for (const [dbKey, dbValue] of Object.entries(databases)) {
				const dbObj: any = dbValue;
				const tablesObj = dbObj?.Tables ?? dbObj?.tables;
				if (tablesObj && typeof tablesObj === 'object' && !Array.isArray(tablesObj)) {
					for (const [tableKey, tableValue] of Object.entries(tablesObj)) {
						const table: any = tableValue;
						const tableName = table?.Name ?? table?.name ?? tableKey;
						if (!tableName) {
							continue;
						}
						const t = String(tableName);
						columnsByTable[t] ??= new Set();
						const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
						if (Array.isArray(cols)) {
							for (const col of cols) {
								const colName = (col as any)?.Name ?? (col as any)?.name;
								if (colName) {
									columnsByTable[t].add(String(colName));
								}
							}
						}
					}
				}

				// Also recurse into each database object for any alternative shapes.
				if (dbObj && typeof dbObj === 'object') {
					this.extractSchemaFromJson(dbObj, columnsByTable);
				}
			}
			return;
		}

		// Common shapes:
		// { Tables: [ { Name, Columns: [ { Name } ] } ] }
		// { tables: [ ... ] }
		const tables = parsed.Tables ?? parsed.tables ?? parsed.databaseSchema?.Tables ?? parsed.databaseSchema?.tables;
		if (Array.isArray(tables)) {
			for (const table of tables) {
				const tableName = table?.Name ?? table?.name;
				if (!tableName) {
					continue;
				}
				const t = String(tableName);
				columnsByTable[t] ??= new Set();
				const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
				if (Array.isArray(cols)) {
					for (const col of cols) {
						const colName = col?.Name ?? col?.name;
						if (colName) {
							columnsByTable[t].add(String(colName));
						}
					}
				}
			}
			return;
		}

		// Another common shape: Tables is a dictionary/object map, not an array.
		if (tables && typeof tables === 'object' && !Array.isArray(tables)) {
			for (const [tableKey, tableValue] of Object.entries(tables)) {
				const table: any = tableValue;
				const tableName = table?.Name ?? table?.name ?? tableKey;
				if (!tableName) {
					continue;
				}
				const t = String(tableName);
				columnsByTable[t] ??= new Set();
				const cols = table?.Columns ?? table?.columns ?? table?.OrderedColumns ?? table?.orderedColumns;
				if (Array.isArray(cols)) {
					for (const col of cols) {
						const colName = (col as any)?.Name ?? (col as any)?.name;
						if (colName) {
							columnsByTable[t].add(String(colName));
						}
					}
				}
			}
			return;
		}

		// If unknown shape, attempt recursive walk looking for {Name, Columns:[{Name}]} patterns.
		if (typeof parsed === 'object') {
			for (const value of Object.values(parsed)) {
				if (Array.isArray(value) || (value && typeof value === 'object')) {
					this.extractSchemaFromJson(value, columnsByTable);
				}
			}
		}
	}

	private finalizeSchema(columnsByTable: Record<string, Set<string>>): DatabaseSchemaIndex {
		const tables = Object.keys(columnsByTable).sort((a, b) => a.localeCompare(b));
		const out: Record<string, string[]> = {};
		for (const t of tables) {
			out[t] = Array.from(columnsByTable[t]).sort((a, b) => a.localeCompare(b));
		}
		return { tables, columnsByTable: out };
	}

	dispose() {
		this.clients.clear();
	}
}
