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

export class KustoQueryClient {
	private clients: Map<string, any> = new Map();

	private async getOrCreateClient(connection: KustoConnection): Promise<any> {
		if (this.clients.has(connection.id)) {
			return this.clients.get(connection.id)!;
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
			connection.clusterUrl,
			session.accessToken
		);
		
		const client = new Client(kcsb);
		this.clients.set(connection.id, client);
		return client;
	}

	async getDatabases(connection: KustoConnection): Promise<string[]> {
		try {
			console.log('Fetching databases for cluster:', connection.clusterUrl);
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
			
			// Extract rows
			const rows: any[][] = [];
			for (const row of primaryResults.rows()) {
				rows.push(row.map((cell: any) => cell === null ? 'null' : String(cell)));
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
			throw new Error(`Query execution failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	dispose() {
		this.clients.clear();
	}
}
