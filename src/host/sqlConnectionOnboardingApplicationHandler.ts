import * as vscode from 'vscode';

import type { SqlConnection, SqlConnectionManager } from './sqlConnectionManager';
import type { IncomingWebviewMessage } from './queryEditorTypes';

type SqlConnectionOnboardingMessage = Extract<IncomingWebviewMessage, {
	type: 'promptAddSqlConnection' | 'addSqlConnection';
}>;

type SqlConnectionAddedResponse = {
	type: 'sqlConnectionAdded';
	boxId?: string;
	connectionId: string;
	connections: SqlConnection[];
};

export interface SqlConnectionOnboardingApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type SqlConnectionOnboardingApplicationHandlerOptions = {
	connectionManager: Pick<SqlConnectionManager, 'addConnection' | 'getConnections'>;
	globalState: Pick<vscode.Memento, 'update'>;
	postMessage: (message: SqlConnectionAddedResponse) => PromiseLike<boolean> | void;
};

export class HostSqlConnectionOnboardingApplicationHandler implements SqlConnectionOnboardingApplicationHandler {
	private disposed = false;

	constructor(private readonly options: SqlConnectionOnboardingApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'promptAddSqlConnection':
			case 'addSqlConnection':
				break;
			default:
				return undefined;
		}
		if (this.disposed) return Promise.resolve();
		return this.handleOnboardingMessage(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleOnboardingMessage(message: SqlConnectionOnboardingMessage): Promise<void> {
		switch (message.type) {
			case 'promptAddSqlConnection':
				await this.promptAddSqlConnection(message.boxId);
				return;
			case 'addSqlConnection':
				await this.addSqlConnectionFromWebview(message);
				return;
		}
	}

	private async promptAddSqlConnection(boxId?: string): Promise<void> {
		const serverUrl = await vscode.window.showInputBox({
			prompt: 'SQL Server address',
			placeHolder: 'myserver.database.windows.net',
			ignoreFocusOut: true,
		});
		if (!serverUrl) return;

		const authType = await vscode.window.showQuickPick(
			[
				{ label: 'Azure AD (default)', id: 'aad' },
				{ label: 'SQL Login (username/password)', id: 'sql-login' },
			],
			{ placeHolder: 'Authentication type', ignoreFocusOut: true },
		);
		if (!authType) return;

		let username: string | undefined;
		let password: string | undefined;
		if (authType.id === 'sql-login') {
			username = await vscode.window.showInputBox({
				prompt: 'Username',
				placeHolder: 'sa',
				ignoreFocusOut: true,
			});
			if (!username) return;
			password = await vscode.window.showInputBox({
				prompt: 'Password',
				password: true,
				ignoreFocusOut: true,
			});
			if (password === undefined) return;
		}

		const name = (await vscode.window.showInputBox({
			prompt: 'Connection name (optional)',
			placeHolder: serverUrl.trim(),
			ignoreFocusOut: true,
		})) || '';

		await this.addAndAcknowledge({
			name: name.trim() || serverUrl.trim(),
			dialect: 'mssql',
			serverUrl: serverUrl.trim(),
			authType: authType.id,
			username,
		}, password, boxId);
	}

	private async addSqlConnectionFromWebview(
		message: Extract<SqlConnectionOnboardingMessage, { type: 'addSqlConnection' }>,
	): Promise<void> {
		const serverUrl = String(message.serverUrl || '').trim();
		if (!serverUrl) return;
		const name = String(message.name || '').trim() || serverUrl;

		await this.addAndAcknowledge({
			name,
			dialect: message.dialect || 'mssql',
			serverUrl,
			authType: message.authType || 'aad',
			username: message.username,
			port: message.port,
			database: message.database,
		}, message.password, message.boxId);
	}

	private async addAndAcknowledge(
		connection: Omit<SqlConnection, 'id'>,
		password: string | undefined,
		boxId: string | undefined,
	): Promise<void> {
		const newConnection = await this.options.connectionManager.addConnection(connection, password);
		await this.options.globalState.update('sql.lastConnectionId', newConnection.id);
		this.options.postMessage({
			type: 'sqlConnectionAdded',
			boxId,
			connectionId: newConnection.id,
			connections: this.options.connectionManager.getConnections(),
		});
	}
}
