import * as vscode from 'vscode';

import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { SqlEditorLifecycleCoordinator } from './sql/sqlEditorLifecycleCoordinator';
import {
	admitSqlStsEditorLanguageWebviewMessage,
	type SqlStsEditorLanguageWebviewMessage,
} from '../shared/sqlStsEditorLanguageProtocol';
import {
	clearSqlTokenOverride,
	setSqlServerAccountMapEntry,
	setSqlTokenOverride,
} from './sql/sqlAuthState';

type SqlEditorLifecycleMessage = Extract<IncomingWebviewMessage, {
	type:
		| 'sqlSectionOpen'
		| 'retireSqlTarget'
		| 'testSetSqlAuthOverride'
		| 'testClearSqlAuthOverride';
}> | SqlStsEditorLanguageWebviewMessage;

type SqlEditorLifecycle = Pick<SqlEditorLifecycleCoordinator,
	| 'openSection'
	| 'retireTarget'
	| 'handleLanguageRequest'
	| 'didOpen'
	| 'didChange'
	| 'didClose'
	| 'connect'>;

export interface SqlEditorLifecycleApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type SqlEditorLifecycleApplicationHandlerOptions = {
	context: vscode.ExtensionContext;
	lifecycle: SqlEditorLifecycle;
};

export class HostSqlEditorLifecycleApplicationHandler
	implements SqlEditorLifecycleApplicationHandler {
	private disposed = false;

	constructor(private readonly options: SqlEditorLifecycleApplicationHandlerOptions) {}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		const stsAdmission = admitSqlStsEditorLanguageWebviewMessage(message);
		if (stsAdmission.recognized) {
			if (this.disposed || !stsAdmission.parsed.ok) return Promise.resolve();
			return this.handleSqlEditorLifecycleMessage(stsAdmission.parsed.value);
		}
		switch (message.type) {
			case 'sqlSectionOpen':
			case 'retireSqlTarget':
			case 'testSetSqlAuthOverride':
			case 'testClearSqlAuthOverride':
				if (this.disposed) return Promise.resolve();
				return this.handleSqlEditorLifecycleMessage(message);
			default:
				return undefined;
		}
	}

	dispose(): void {
		this.disposed = true;
	}

	private async handleSqlEditorLifecycleMessage(message: SqlEditorLifecycleMessage): Promise<void> {
		switch (message.type) {
			case 'sqlSectionOpen':
				this.options.lifecycle.openSection(message.boxId, message.sectionInstanceId);
				return;
			case 'retireSqlTarget':
				this.options.lifecycle.retireTarget(
					message.boxId,
					message.sectionInstanceId,
					message.targetGeneration,
				);
				return;
			case 'testSetSqlAuthOverride':
				if (this.options.context.extensionMode === vscode.ExtensionMode.Production) return;
				await setSqlServerAccountMapEntry(
					this.options.context,
					message.serverUrl,
					message.accountId,
				);
				await setSqlTokenOverride(this.options.context, message.accountId, message.token);
				return;
			case 'testClearSqlAuthOverride':
				if (this.options.context.extensionMode === vscode.ExtensionMode.Production) return;
				await clearSqlTokenOverride(this.options.context, message.accountId);
				return;
			case 'stsRequest':
				await this.options.lifecycle.handleLanguageRequest(
					message.requestId,
					message.method,
					message.params,
				);
				return;
			case 'stsDidOpen':
				this.options.lifecycle.didOpen(message.boxId, message.sectionInstanceId, message.text);
				return;
			case 'stsDidChange':
				await this.options.lifecycle.didChange(message.boxId, message.sectionInstanceId, message.text);
				return;
			case 'stsDidClose':
				this.options.lifecycle.didClose(message.boxId, message.sectionInstanceId);
				return;
			case 'stsConnect':
				await this.options.lifecycle.connect(
					message.boxId,
					message.sectionInstanceId,
					message.sqlConnectionId,
					message.database,
					message.targetGeneration,
					message.expectedOwner,
				);
				return;
		}
	}
}
