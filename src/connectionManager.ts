import * as vscode from 'vscode';

export interface KustoConnection {
	id: string;
	name: string;
	clusterUrl: string;
	database?: string;
}

/**
 * Manages Kusto cluster connections
 */
export class ConnectionManager {
	private connections: KustoConnection[] = [];
	private readonly storageKey = 'kusto.connections';

	constructor(private context: vscode.ExtensionContext) {
		this.loadConnections();
	}

	private loadConnections() {
		const stored = this.context.globalState.get<KustoConnection[]>(this.storageKey);
		if (stored) {
			this.connections = stored;
		}
	}

	private async saveConnections() {
		await this.context.globalState.update(this.storageKey, this.connections);
	}

	getConnections(): KustoConnection[] {
		return [...this.connections];
	}

	async addConnection(connection: Omit<KustoConnection, 'id'>): Promise<KustoConnection> {
		const newConnection: KustoConnection = {
			...connection,
			id: `conn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
		};
		this.connections.push(newConnection);
		await this.saveConnections();
		return newConnection;
	}

	async removeConnection(id: string): Promise<void> {
		this.connections = this.connections.filter(c => c.id !== id);
		await this.saveConnections();
	}

	async clearConnections(): Promise<number> {
		const removed = this.connections.length;
		this.connections = [];
		await this.saveConnections();
		return removed;
	}

	async updateConnection(id: string, updates: Partial<KustoConnection>): Promise<void> {
		const index = this.connections.findIndex(c => c.id === id);
		if (index !== -1) {
			this.connections[index] = { ...this.connections[index], ...updates };
			await this.saveConnections();
		}
	}

	async showConnectionManager() {
		const actions = [
			{ label: '$(add) Add New Connection', action: 'add' },
			{ label: '$(list-unordered) View Connections', action: 'list' }
		];

		const selection = await vscode.window.showQuickPick(actions, {
			placeHolder: 'Manage Kusto Connections'
		});

		if (selection?.action === 'add') {
			await this.addConnectionDialog();
		} else if (selection?.action === 'list') {
			await this.listConnections();
		}
	}

	private async addConnectionDialog() {
		const name = await vscode.window.showInputBox({
			prompt: 'Connection Name',
			placeHolder: 'My Kusto Cluster'
		});

		if (!name) {return;}

		const clusterUrl = await vscode.window.showInputBox({
			prompt: 'Cluster URL',
			placeHolder: 'https://mycluster.region.kusto.windows.net'
		});

		if (!clusterUrl) {return;}

		const database = await vscode.window.showInputBox({
			prompt: 'Default Database (optional)',
			placeHolder: 'MyDatabase'
		});

		await this.addConnection({ name, clusterUrl, database });
		vscode.window.showInformationMessage(`Connection "${name}" added successfully!`);
	}

	private async listConnections() {
		if (this.connections.length === 0) {
			vscode.window.showInformationMessage('No connections configured. Add one first!');
			return;
		}

		const items = this.connections.map(conn => ({
			label: conn.name,
			description: conn.clusterUrl,
			detail: conn.database ? `Default DB: ${conn.database}` : 'No default database',
			connection: conn
		}));

		const selection = await vscode.window.showQuickPick(items, {
			placeHolder: 'Select a connection to manage'
		});

		if (selection) {
			const action = await vscode.window.showQuickPick([
				{ label: '$(trash) Delete', action: 'delete' },
				{ label: '$(edit) Edit', action: 'edit' }
			]);

			if (action?.action === 'delete') {
				await this.removeConnection(selection.connection.id);
				vscode.window.showInformationMessage(`Connection "${selection.connection.name}" deleted.`);
			}
		}
	}
}
