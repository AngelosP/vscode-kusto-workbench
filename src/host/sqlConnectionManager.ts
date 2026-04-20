import * as vscode from 'vscode';

// ---------------------------------------------------------------------------
// SqlConnection type
// ---------------------------------------------------------------------------

export interface SqlConnection {
	id: string;
	name: string;
	/** Dialect identifier (e.g. `'mssql'`). */
	dialect: string;
	serverUrl: string;
	port?: number;
	database?: string;
	/** Authentication type (e.g. `'aad'`, `'sql-login'`). */
	authType: string;
	/** Username for SQL login auth (never stored in SecretStorage). */
	username?: string;
}

// ---------------------------------------------------------------------------
// Storage keys
// ---------------------------------------------------------------------------

const STORAGE_KEYS = {
	connections: 'sql.connections',
	/** SecretStorage key template: `sql.password.{connectionId}`. */
	passwordPrefix: 'sql.password.',
} as const;

// ---------------------------------------------------------------------------
// SqlConnectionManager
// ---------------------------------------------------------------------------

/**
 * Manages SQL connection entries (CRUD).
 *
 * Mirrors the Kusto `ConnectionManager` pattern:
 * - Connections stored in `globalState` (JSON-serializable structs).
 * - Passwords stored separately in VS Code `SecretStorage`.
 * - Connection IDs use a `sql_` prefix to avoid collision with Kusto IDs.
 */
export class SqlConnectionManager {
	private connections: SqlConnection[] = [];

	constructor(private readonly context: vscode.ExtensionContext) {
		this.loadConnections();
	}

	// ── Read ──────────────────────────────────────────────────────────

	getConnections(): SqlConnection[] {
		return [...this.connections];
	}

	getConnection(id: string): SqlConnection | undefined {
		return this.connections.find(c => c.id === id);
	}

	// ── Create ────────────────────────────────────────────────────────

	async addConnection(
		connection: Omit<SqlConnection, 'id'>,
		password?: string,
	): Promise<SqlConnection> {
		const newConnection: SqlConnection = {
			...connection,
			id: `sql_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`,
		};
		this.connections.push(newConnection);
		await this.saveConnections();

		if (password !== undefined && password !== null) {
			await this.setPassword(newConnection.id, password);
		}

		return newConnection;
	}

	// ── Update ────────────────────────────────────────────────────────

	async updateConnection(id: string, updates: Partial<Omit<SqlConnection, 'id'>>): Promise<void> {
		const index = this.connections.findIndex(c => c.id === id);
		if (index === -1) {
			return;
		}
		this.connections[index] = { ...this.connections[index], ...updates, id };
		await this.saveConnections();
	}

	// ── Delete ────────────────────────────────────────────────────────

	async removeConnection(id: string): Promise<void> {
		this.connections = this.connections.filter(c => c.id !== id);
		await this.saveConnections();
		// Clean up stored password.
		await this.deletePassword(id);
	}

	async clearConnections(): Promise<number> {
		const removed = this.connections.length;
		// Delete all stored passwords.
		for (const c of this.connections) {
			await this.deletePassword(c.id);
		}
		this.connections = [];
		await this.saveConnections();
		return removed;
	}

	// ── Password management (SecretStorage) ───────────────────────────

	async getPassword(connectionId: string): Promise<string | undefined> {
		return this.context.secrets.get(`${STORAGE_KEYS.passwordPrefix}${connectionId}`);
	}

	async setPassword(connectionId: string, password: string): Promise<void> {
		await this.context.secrets.store(`${STORAGE_KEYS.passwordPrefix}${connectionId}`, password);
	}

	async deletePassword(connectionId: string): Promise<void> {
		await this.context.secrets.delete(`${STORAGE_KEYS.passwordPrefix}${connectionId}`);
	}

	// ── Persistence ──────────────────────────────────────────────────

	private loadConnections(): void {
		const stored = this.context.globalState.get<SqlConnection[]>(STORAGE_KEYS.connections);
		if (Array.isArray(stored)) {
			this.connections = stored;
		}
	}

	private async saveConnections(): Promise<void> {
		await this.context.globalState.update(STORAGE_KEYS.connections, this.connections);
	}
}
