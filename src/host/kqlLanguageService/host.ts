import * as vscode from 'vscode';

import { ConnectionManager } from '../connectionManager';
import { DatabaseSchemaIndex } from '../kustoClient';
import { readCachedSchemaFromDisk } from '../schemaCache';
import { KqlLanguageService } from './service';
import { type KqlFindTableReferencesParams, type KqlFindTableReferencesResult, type KqlGetDiagnosticsParams, type KqlGetDiagnosticsResult } from './protocol';

const STORAGE_KEYS = {
	lastConnectionId: 'kusto.lastConnectionId',
	lastDatabase: 'kusto.lastDatabase'
} as const;

export class KqlLanguageServiceHost {
	private readonly service = new KqlLanguageService();

	constructor(
		private readonly connectionManager: ConnectionManager,
		private readonly context: vscode.ExtensionContext
	) {}

	private findConnection(connectionId: string | undefined): { id: string; clusterUrl: string } | undefined {
		const cid = String(connectionId || '').trim();
		if (!cid) {
			return undefined;
		}
		const c = this.connectionManager.getConnections().find((x) => x.id === cid);
		if (!c) {
			return undefined;
		}
		return { id: c.id, clusterUrl: String(c.clusterUrl || '').trim() };
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
		const cacheKey = `${conn.clusterUrl}|${db}`;
		const cached = await readCachedSchemaFromDisk(this.context.globalStorageUri, cacheKey);
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
