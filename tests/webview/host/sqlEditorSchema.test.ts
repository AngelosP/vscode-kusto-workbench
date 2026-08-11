import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
	getSqlSchemaCacheDirUri,
	getSqlSchemaCacheFileUri,
	readCachedSqlSchemaFromDisk,
	SqlSchemaService,
	sqlSchemaCacheKey,
	sqlSchemaPrincipalFingerprint,
	sqlSchemaTargetSignature,
	SQL_SCHEMA_CACHE_VERSION,
} from '../../../src/host/sqlEditorSchema';
import { captureSqlSchemaCacheGeneration, clearSqlSchemaCacheFiles } from '../../../src/host/sqlSchemaCacheGeneration';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

describe('SqlSchemaService Leave No Trace policy', () => {
	it('distinguishes SQL Login principals whose usernames differ only by case', () => {
		const context = { globalState: { get: vi.fn(() => ({})) } } as any;
		const upper = { id: 'sql-1', serverUrl: 'server.example', authType: 'sql-login', username: 'ReportUser' } as any;
		const lower = { ...upper, username: 'reportuser' };
		expect(sqlSchemaPrincipalFingerprint(context, upper)).not.toBe(sqlSchemaPrincipalFingerprint(context, lower));
	});

	it('scopes disk cache keys to the exact SQL connection owner', () => {
		const ownerA = { principalFingerprint: 'principal-a', targetSignature: 'target-a' };
		expect(sqlSchemaCacheKey('Db', 'sql-home', ownerA))
			.not.toBe(sqlSchemaCacheKey('Db', 'sql-guest', ownerA));
		expect(sqlSchemaCacheKey('Db', 'sql-home', ownerA))
			.not.toBe(sqlSchemaCacheKey('Db', 'sql-home', { ...ownerA, principalFingerprint: 'principal-b' }));
		expect(sqlSchemaCacheKey('Db', 'sql-home', ownerA))
			.not.toBe(sqlSchemaCacheKey('Db', 'sql-home', { ...ownerA, targetSignature: 'target-b' }));
		expect(sqlSchemaCacheKey('Db', 'sql-home', ownerA))
			.not.toBe(sqlSchemaCacheKey('db', 'sql-home', ownerA));
	});

	it.each([
		{ name: 'legacy version', mutate: (entry: Record<string, unknown>) => { entry.version = SQL_SCHEMA_CACHE_VERSION - 1; } },
		{ name: 'missing target owner', mutate: (entry: Record<string, unknown>) => { delete entry.targetSignature; } },
		{ name: 'changed port owner', mutate: (_entry: Record<string, unknown>) => undefined, expectedPort: 1434 },
	])('rejects a $name schema entry', async ({ mutate, expectedPort }) => {
		const storageUri = vscode.Uri.file(`/sql-schema-v4-${expectedPort ?? 'shape'}`);
		const connection = {
			id: 'sql-1', dialect: 'mssql', serverUrl: 'server.example', port: 1433,
			database: 'master', authType: 'sql-login', username: 'ReportUser',
		} as any;
		const principalFingerprint = sqlSchemaPrincipalFingerprint({ globalState: { get: vi.fn() } } as any, connection)!;
		const owner = { principalFingerprint, targetSignature: sqlSchemaTargetSignature(connection) };
		const cacheKey = sqlSchemaCacheKey('Db', connection.id, owner);
		const cacheGeneration = await captureSqlSchemaCacheGeneration(storageUri);
		const entry: Record<string, unknown> = {
			version: SQL_SCHEMA_CACHE_VERSION,
			schema: { tables: ['Secret'], columnsByTable: {} },
			timestamp: Date.now(),
			serverUrl: connection.serverUrl,
			database: 'Db',
			connectionId: connection.id,
			cacheGeneration,
			...owner,
		};
		mutate(entry);
		await vscode.workspace.fs.writeFile(
			getSqlSchemaCacheFileUri(storageUri, cacheKey),
			Buffer.from(JSON.stringify(entry), 'utf8'),
		);
		const expectedOwner = expectedPort
			? { ...owner, targetSignature: sqlSchemaTargetSignature({ ...connection, port: expectedPort }) }
			: owner;

		await expect(readCachedSqlSchemaFromDisk(storageUri, cacheKey, {
			connectionId: connection.id,
			...expectedOwner,
		})).resolves.toBeUndefined();
	});

	it('revalidates after a live schema fetch before returning or caching it', async () => {
		const pending = deferred<any>();
		let allowed = true;
		const getDatabaseSchema = vi.fn(() => pending.promise);
		const assertSqlConnectionAllowed = vi.fn(async () => {
			if (!allowed) throw new Error('Leave No Trace blocked');
		});
		const service = new SqlSchemaService({
			context: {
				globalStorageUri: { toString: () => 'file:///storage' },
				globalState: { get: vi.fn(() => ({})) },
			} as any,
			sqlClient: { getDatabaseSchema } as any,
			output: { warn: vi.fn(), error: vi.fn() } as any,
			assertSqlConnectionAllowed,
			postMessage: vi.fn(),
		});
		const connection = { id: 'sql-sensitive', serverUrl: 'server.example', authType: 'sql-login', username: 'user' } as any;

		const result = service.getSchema(connection, 'Db', true);
		await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledOnce());
		allowed = false;
		pending.resolve({ tables: ['Secret'], columnsByTable: { Secret: { Value: 'int' } } });

		await expect(result).rejects.toThrow('Leave No Trace blocked');
		expect(assertSqlConnectionAllowed.mock.calls.length).toBeGreaterThanOrEqual(2);
	});

	it('does not rebind a stale schema request to a changed same-ID target', async () => {
		const policy = deferred<void>();
		const captured = { id: 'sql-1', dialect: 'mssql', serverUrl: 'server-a.example', authType: 'sql-login', username: 'user' } as any;
		let current = captured;
		const getDatabaseSchema = vi.fn();
		const service = new SqlSchemaService({
			context: { globalStorageUri: vscode.Uri.file('/schema-target-drift'), globalState: { get: vi.fn(() => ({})) } } as any,
			sqlClient: { getDatabaseSchema } as any,
			output: { warn: vi.fn(), error: vi.fn() } as any,
			assertSqlConnectionAllowed: vi.fn(() => policy.promise),
			getCurrentSqlConnection: () => current,
			postMessage: vi.fn(),
		});

		const request = service.getSchema(captured, 'Db', true);
		current = { ...captured, serverUrl: 'server-b.example' };
		policy.resolve(undefined);

		await expect(request).rejects.toThrow('identity changed');
		expect(getDatabaseSchema).not.toHaveBeenCalled();
	});

	it('does not dispatch schema queries after AbortSignal cancellation during policy readiness', async () => {
		const policy = deferred<void>();
		const controller = new AbortController();
		const connection = { id: 'sql-1', dialect: 'mssql', serverUrl: 'server.example', authType: 'sql-login', username: 'user' } as any;
		const getDatabaseSchema = vi.fn();
		const service = new SqlSchemaService({
			context: { globalStorageUri: vscode.Uri.file('/schema-abort'), globalState: { get: vi.fn(() => ({})) } } as any,
			sqlClient: { getDatabaseSchema } as any,
			output: { warn: vi.fn(), error: vi.fn() } as any,
			assertSqlConnectionAllowed: vi.fn(() => policy.promise),
			getCurrentSqlConnection: () => connection,
			postMessage: vi.fn(),
		});

		const request = service.getSchema(connection, 'Db', true, { signal: controller.signal });
		controller.abort();
		policy.resolve(undefined);

		await expect(request).rejects.toMatchObject({ isCancelled: true });
		expect(getDatabaseSchema).not.toHaveBeenCalled();
	});

	it('removes A inside the disk CAS when a newer same-target request supersedes it', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-request-cas-'));
		const storageUri = vscode.Uri.file(directory);
		const fsApi = vscode.workspace.fs as any;
		const originalRename = fsApi.rename;
		const firstRenameEntered = deferred<void>();
		const releaseFirstRename = deferred<void>();
		let renameCount = 0;
		fsApi.rename = vi.fn(async (source: vscode.Uri, target: vscode.Uri) => {
			renameCount += 1;
			if (renameCount === 1) {
				firstRenameEntered.resolve(undefined);
				await releaseFirstRename.promise;
			}
			const bytes = await fsApi.readFile(source);
			await fsApi.writeFile(target, bytes);
			await fsApi.delete(source, { useTrash: false });
		});
		try {
			const schemaA = deferred<any>();
			const schemaB = deferred<any>();
			const getDatabaseSchema = vi.fn()
				.mockImplementationOnce(() => schemaA.promise)
				.mockImplementationOnce(() => schemaB.promise);
			const connection = {
				id: 'sql-1', dialect: 'mssql', serverUrl: 'server.example',
				authType: 'sql-login', username: 'user',
			} as any;
			const service = new SqlSchemaService({
				context: { globalStorageUri: storageUri, globalState: { get: vi.fn(() => ({})) } } as any,
				sqlClient: { getDatabaseSchema } as any,
				output: { warn: vi.fn(), error: vi.fn() } as any,
				assertSqlConnectionAllowed: vi.fn(async () => undefined),
				getCurrentSqlConnection: () => connection,
				postMessage: vi.fn(),
			});
			let currentRequest = 'A';
			const assertCurrent = (requestId: string) => {
				if (currentRequest !== requestId) throw new Error(`request ${requestId} superseded`);
			};
			const requestA = service.getSchema(connection, 'Db', true, {
				assertRequestCurrent: () => assertCurrent('A'),
			});
			await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledOnce());
			schemaA.resolve({ tables: ['SchemaA'], columnsByTable: {} });
			await firstRenameEntered.promise;

			currentRequest = 'B';
			const requestB = service.getSchema(connection, 'Db', true, {
				assertRequestCurrent: () => assertCurrent('B'),
			});
			releaseFirstRename.resolve(undefined);
			await expect(requestA).rejects.toThrow('request A superseded');
			await vi.waitFor(() => expect(getDatabaseSchema).toHaveBeenCalledTimes(2));
			schemaB.resolve({ tables: ['SchemaB'], columnsByTable: {} });
			await expect(requestB).resolves.toEqual({
				schema: { tables: ['SchemaB'], columnsByTable: {} },
				fromCache: false,
			});

			const owner = {
				principalFingerprint: sqlSchemaPrincipalFingerprint(
					{ globalState: { get: vi.fn(() => ({})) } } as any,
					connection,
				)!,
				targetSignature: sqlSchemaTargetSignature(connection),
			};
			const cacheKey = sqlSchemaCacheKey('Db', connection.id, owner);
			await expect(readCachedSqlSchemaFromDisk(storageUri, cacheKey, {
				connectionId: connection.id,
				...owner,
			})).resolves.toMatchObject({ schema: { tables: ['SchemaB'] } });
		} finally {
			if (originalRename === undefined) delete fsApi.rename;
			else fsApi.rename = originalRename;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('invalidates an existing service memory cache after Clear All advances the shared generation', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-memory-clear-'));
		const fsApi = vscode.workspace.fs as any;
		const originalRename = fsApi.rename;
		const originalDelete = fsApi.delete;
		fsApi.rename = vi.fn(async () => undefined);
		fsApi.delete = vi.fn(async () => undefined);
		try {
			const storageUri = vscode.Uri.file(directory);
			const firstSchema = { tables: ['BeforeClear'], columnsByTable: {} };
			const secondSchema = { tables: ['AfterClear'], columnsByTable: {} };
			const getDatabaseSchema = vi.fn()
				.mockResolvedValueOnce(firstSchema)
				.mockResolvedValueOnce(secondSchema);
			const service = new SqlSchemaService({
				context: { globalStorageUri: storageUri, globalState: { get: vi.fn(() => ({})) } } as any,
				sqlClient: { getDatabaseSchema } as any,
				output: { warn: vi.fn(), error: vi.fn() } as any,
				assertSqlConnectionAllowed: vi.fn(async () => undefined),
				postMessage: vi.fn(),
			});
			const connection = { id: 'sql-1', serverUrl: 'server.example', authType: 'sql-login', username: 'user' } as any;

			await expect(service.getSchema(connection, 'Db')).resolves.toEqual({ schema: firstSchema, fromCache: false });
			await expect(service.getSchema(connection, 'Db')).resolves.toEqual({ schema: firstSchema, fromCache: true });
			expect(getDatabaseSchema).toHaveBeenCalledOnce();

			await clearSqlSchemaCacheFiles(storageUri, getSqlSchemaCacheDirUri(storageUri));

			await expect(service.getSchema(connection, 'Db')).resolves.toEqual({ schema: secondSchema, fromCache: false });
			expect(getDatabaseSchema).toHaveBeenCalledTimes(2);
		} finally {
			if (originalRename === undefined) delete fsApi.rename;
			else fsApi.rename = originalRename;
			if (originalDelete === undefined) delete fsApi.delete;
			else fsApi.delete = originalDelete;
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});

	it('does not resurrect a surviving old schema file after the generation marker is deleted', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-schema-marker-loss-'));
		const storageUri = vscode.Uri.file(directory);
		const connection = {
			id: 'sql-1', dialect: 'mssql', serverUrl: 'server.example',
			authType: 'sql-login', username: 'user',
		} as any;
		try {
			const owner = {
				principalFingerprint: sqlSchemaPrincipalFingerprint({ globalState: { get: vi.fn() } } as any, connection)!,
				targetSignature: sqlSchemaTargetSignature(connection),
			};
			const cacheKey = sqlSchemaCacheKey('Db', connection.id, owner);
			const oldGeneration = await captureSqlSchemaCacheGeneration(storageUri);
			await vscode.workspace.fs.writeFile(getSqlSchemaCacheFileUri(storageUri, cacheKey), Buffer.from(JSON.stringify({
				version: SQL_SCHEMA_CACHE_VERSION,
				schema: { tables: ['BeforeClear'], columnsByTable: {} },
				timestamp: Date.now(), serverUrl: connection.serverUrl, database: 'Db',
				connectionId: connection.id, ...owner, cacheGeneration: oldGeneration,
			}), 'utf8'));
			fs.unlinkSync(path.join(directory, 'sql-schema-cache-generation.v1.json'));

			await expect(readCachedSqlSchemaFromDisk(storageUri, cacheKey, { connectionId: connection.id, ...owner }))
				.resolves.toBeUndefined();
			expect(await captureSqlSchemaCacheGeneration(storageUri)).not.toBe(oldGeneration);
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
