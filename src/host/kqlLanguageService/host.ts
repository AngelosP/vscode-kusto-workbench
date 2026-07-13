import * as vscode from 'vscode';

import { ConnectionManager } from '../connectionManager';
import { DatabaseSchemaIndex } from '../kustoClient';
import { readCachedSchemaFromDiskByCluster } from '../schemaCache';
import { KustoAuthPreferenceService } from '../kustoAuthPreferenceService';
import { KqlLanguageService } from './service';
import { type KqlFindTableReferencesParams, type KqlFindTableReferencesResult, type KqlGetDiagnosticsParams, type KqlGetDiagnosticsResult } from './protocol';

const STORAGE_KEYS = {
	lastConnectionId: 'kusto.lastConnectionId',
	lastDatabase: 'kusto.lastDatabase'
} as const;

export class KqlLanguageServiceHost {
	private readonly service = new KqlLanguageService();
	private readonly authPreferences: KustoAuthPreferenceService;

	constructor(
		private readonly connectionManager: ConnectionManager,
		private readonly context: vscode.ExtensionContext
	) {
		this.authPreferences = KustoAuthPreferenceService.getInstance(context);
	}

	private findConnection(connectionId: string | undefined): { id: string; clusterUrl: string; authorityId?: string } | undefined {
		const cid = String(connectionId || '').trim();
		if (!cid) {
			return undefined;
		}
		const c = this.connectionManager.getConnections().find((x) => x.id === cid);
		if (!c) {
			return undefined;
		}
		return { id: c.id, clusterUrl: String(c.clusterUrl || '').trim(), authorityId: c.authorityId };
	}

	private resolveContext(params: KqlGetDiagnosticsParams): { connectionId?: string; database?: string } {
		const cid = String(params.connectionId || '').trim();
		const db = String(params.database || '').trim();
		const fallbackCid = String(this.context.globalState.get<string>(STORAGE_KEYS.lastConnectionId) || '').trim();
		const fallbackDb = String(this.context.globalState.get<string>(STORAGE_KEYS.lastDatabase) || '').trim();
		return {
			connectionId: cid || fallbackCid || undefined,
			database: db || fallbackDb || undefined
		};
	}

	private async tryGetSchema(connectionId: string | undefined, database: string | undefined): Promise<DatabaseSchemaIndex | undefined> {
		const db = String(database || '').trim();
		if (!db) {
			return undefined;
		}
		const conn = this.findConnection(connectionId);
		if (!conn?.clusterUrl) {
			return undefined;
		}
		const accountId = this.authPreferences.getPreferredAccountId(conn.id);
		if (!accountId) return undefined;
		const accountPartition = this.authPreferences.getAccountPartition(conn.authorityId, accountId);
		const cached = await readCachedSchemaFromDiskByCluster(this.context.globalStorageUri, conn.clusterUrl, db, conn.id, accountPartition);
		return cached?.schema;
	}

	async getDiagnostics(params: KqlGetDiagnosticsParams): Promise<KqlGetDiagnosticsResult> {
		const resolved = this.resolveContext(params);
		const schema = await this.tryGetSchema(resolved.connectionId, resolved.database);
		const diagnostics = this.service.getDiagnostics(params.text, schema);
		return { diagnostics };
	}

	async findTableReferences(params: KqlFindTableReferencesParams): Promise<KqlFindTableReferencesResult> {
		const references = this.service.findTableReferences(params.text);
		return { references };
	}
}
