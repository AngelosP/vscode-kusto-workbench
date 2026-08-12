import * as fs from 'fs';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';

import {
	HostSqlSchemaRequestApplicationHandler,
} from '../../../src/host/sqlSchemaRequestApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';
import type { SqlSchemaRefreshRequest } from '../../../src/host/sql/sqlEditorLifecycleCoordinator';
import {
	sqlResultOwnersEqual,
	type SqlResultOwner,
} from '../../../src/host/sql/sqlEditorSessionRegistry';

const OWNER: SqlResultOwner = Object.freeze({
	connectionId: 'sql-1',
	database: 'Db',
	generation: 1,
	targetSignature: 'target-1',
	principalFingerprint: 'principal-1',
	revocationGeneration: 0,
});

const REQUEST: SqlSchemaRefreshRequest = Object.freeze({
	boxId: 'sql-box',
	sectionInstanceId: 'sql-instance',
	connectionId: 'sql-1',
	database: 'Db',
	targetGeneration: 1,
	forceRefresh: true,
});

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function schemaResult(name: string) {
	return {
		schema: { tables: [name], columnsByTable: { [name]: { Value: 'int' } } },
		fromCache: false,
	};
}

function createHarness() {
	let owner: SqlResultOwner | undefined = OWNER;
	let sectionInstanceId = REQUEST.sectionInstanceId;
	let targetGeneration = REQUEST.targetGeneration;
	let connectionId = REQUEST.connectionId;
	let database = REQUEST.database;
	const getSchema = vi.fn(async () => schemaResult('Default'));
	const postMessage = vi.fn(async () => true);
	const lifecycle = {
		adoptTarget: vi.fn((
			boxId: string,
			candidateInstanceId: string,
			candidateConnectionId: string,
			candidateDatabase: string | undefined,
			candidateGeneration: number,
		) => boxId === REQUEST.boxId
			&& candidateInstanceId === sectionInstanceId
			&& candidateConnectionId === connectionId
			&& candidateDatabase === database
			&& candidateGeneration === targetGeneration),
		dispatchResultOwnerAllowed: vi.fn(async (
			_boxId: string,
			expectedOwner: SqlResultOwner,
			dispatch: () => unknown | PromiseLike<unknown>,
		) => {
			if (!sqlResultOwnersEqual(owner, expectedOwner)) throw new Error('owner invalid');
			return await dispatch();
		}),
		getResultOwner: vi.fn(() => owner),
		isSectionCurrent: vi.fn((_boxId: string, candidateInstanceId: string) =>
			candidateInstanceId === sectionInstanceId),
		isTargetCurrent: vi.fn((
			_boxId: string,
			candidateConnectionId: string,
			candidateDatabase: string | undefined,
			candidateGeneration: number,
		) => candidateConnectionId === connectionId
			&& candidateDatabase === database
			&& candidateGeneration === targetGeneration),
	};
	const output = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };
	const handler = new HostSqlSchemaRequestApplicationHandler({
		lifecycle,
		connectionManager: {
			getConnection: vi.fn(candidate => candidate === connectionId ? {
				id: connectionId,
				name: 'SQL',
				dialect: 'mssql',
				serverUrl: 'server.example',
				authType: 'sql-login',
				username: 'user',
			} : undefined),
		},
		getSchemaService: () => ({ getSchema }),
		postMessage,
		output,
	});
	return {
		handler,
		lifecycle,
		getSchema,
		postMessage,
		output,
		setOwner: (next: SqlResultOwner | undefined) => { owner = next; },
		setSectionInstanceId: (next: string) => { sectionInstanceId = next; },
		setTarget: (nextConnectionId: string, nextDatabase: string, nextGeneration: number) => {
			connectionId = nextConnectionId;
			database = nextDatabase;
			targetGeneration = nextGeneration;
		},
	};
}

function webviewRequest(): IncomingWebviewMessage {
	return {
		type: 'prefetchSqlSchema',
		sqlConnectionId: REQUEST.connectionId,
		database: REQUEST.database,
		boxId: REQUEST.boxId,
		sectionInstanceId: REQUEST.sectionInstanceId,
		targetGeneration: REQUEST.targetGeneration,
		forceRefresh: REQUEST.forceRefresh,
	};
}

describe('HostSqlSchemaRequestApplicationHandler', () => {
	it('declines unrelated traffic synchronously', () => {
		const harness = createHarness();

		expect(harness.handler.handleMessage({ type: 'getSqlConnections' })).toBeUndefined();
		expect(harness.lifecycle.adoptTarget).not.toHaveBeenCalled();
		expect(harness.getSchema).not.toHaveBeenCalled();
	});

	it('claims malformed recognized requests before target adoption', async () => {
		const harness = createHarness();
		const malformed = {
			...webviewRequest(),
			forceRefresh: 'yes',
		} as unknown as IncomingWebviewMessage;

		await harness.handler.handleMessage(malformed);

		expect(harness.lifecycle.adoptTarget).not.toHaveBeenCalled();
		expect(harness.lifecycle.getResultOwner).not.toHaveBeenCalled();
		expect(harness.getSchema).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('synchronously supersedes a same-target request and admits only B', async () => {
		const harness = createHarness();
		const requestA = deferred<ReturnType<typeof schemaResult>>();
		const requestB = deferred<ReturnType<typeof schemaResult>>();
		const cachePublications: string[] = [];
		const options: Array<{
			signal?: AbortSignal;
			assertRequestCurrent?: () => void | PromiseLike<void>;
		}> = [];
		harness.getSchema.mockImplementation((_connection, _database, _forceRefresh, requestOptions) => {
			options.push(requestOptions ?? {});
			const request = options.length === 1 ? requestA : requestB;
			return request.promise.then(async result => {
				await requestOptions?.assertRequestCurrent?.();
				cachePublications.push(result.schema.tables[0]);
				return result;
			});
		});

		const first = harness.handler.handleMessage(webviewRequest())!;
		expect(harness.getSchema).toHaveBeenCalledOnce();
		const second = harness.handler.handleMessage(webviewRequest())!;
		expect(harness.getSchema).toHaveBeenCalledTimes(2);
		expect(options[0].signal?.aborted).toBe(true);

		requestB.resolve(schemaResult('SchemaB'));
		await second;
		requestA.resolve(schemaResult('SchemaA'));
		await first;

		expect(cachePublications).toEqual(['SchemaB']);
		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlSchemaData',
			boxId: REQUEST.boxId,
			sectionInstanceId: REQUEST.sectionInstanceId,
			targetGeneration: REQUEST.targetGeneration,
			schema: expect.objectContaining({ tables: ['SchemaB'] }),
		}));
	});

	it('routes lifecycle refreshes without re-adopting the target', async () => {
		const harness = createHarness();

		await harness.handler.requestSchema(REQUEST);

		expect(harness.lifecycle.adoptTarget).not.toHaveBeenCalled();
		expect(harness.getSchema).toHaveBeenCalledWith(
			expect.objectContaining({ id: REQUEST.connectionId }),
			REQUEST.database,
			true,
			expect.objectContaining({
				expectedOwner: {
					principalFingerprint: OWNER.principalFingerprint,
					targetSignature: OWNER.targetSignature,
				},
			}),
		);
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlSchemaData',
			schema: expect.objectContaining({ tables: ['Default'] }),
		}));
	});

	it('does not let a rejected stale request supersede current work', async () => {
		const harness = createHarness();
		const pending = deferred<ReturnType<typeof schemaResult>>();
		let signal: AbortSignal | undefined;
		harness.getSchema.mockImplementation((_connection, _database, _forceRefresh, options) => {
			signal = options?.signal;
			return pending.promise;
		});
		const current = harness.handler.handleMessage(webviewRequest())!;
		harness.lifecycle.adoptTarget.mockReturnValueOnce(false);

		await harness.handler.handleMessage({ ...webviewRequest(), targetGeneration: 0 })!;

		expect(signal?.aborted).toBe(false);
		pending.resolve(schemaResult('Current'));
		await current;
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			schema: expect.objectContaining({ tables: ['Current'] }),
		}));
	});

	it('suppresses stale success and error publication after owner drift', async () => {
		const harness = createHarness();
		const pending = deferred<ReturnType<typeof schemaResult>>();
		harness.getSchema.mockImplementation((_connection, _database, _forceRefresh, options) =>
			pending.promise.then(async result => {
				await options?.assertRequestCurrent?.();
				return result;
			}));
		const request = harness.handler.handleMessage(webviewRequest())!;
		harness.setOwner({ ...OWNER, revocationGeneration: 1 });
		pending.resolve(schemaResult('Stale'));

		await request;

		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(harness.output.error).not.toHaveBeenCalled();
		expect(harness.output.warn).not.toHaveBeenCalled();
	});

	it('publishes one current error and contains owner-admission failures', async () => {
		const harness = createHarness();
		harness.getSchema.mockRejectedValueOnce(new Error('schema unavailable'));

		await harness.handler.handleMessage(webviewRequest());

		expect(harness.postMessage).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'sqlSchemaData',
			schema: null,
			schemaMeta: { error: true, errorMessage: 'schema unavailable' },
		}));

		harness.postMessage.mockClear();
		harness.output.error.mockClear();
		harness.getSchema.mockRejectedValueOnce(new Error('SECRET_SCHEMA_ERROR'));
		harness.lifecycle.dispatchResultOwnerAllowed.mockRejectedValueOnce(new Error('owner invalid'));
		await harness.handler.handleMessage(webviewRequest());
		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(JSON.stringify(harness.output.error.mock.calls)).not.toContain('SECRET_SCHEMA_ERROR');
		expect(harness.output.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
	});

	it('aborts and suppresses pending or later work after disposal', async () => {
		const harness = createHarness();
		const pending = deferred<ReturnType<typeof schemaResult>>();
		let signal: AbortSignal | undefined;
		harness.getSchema.mockImplementation((_connection, _database, _forceRefresh, options) => {
			signal = options?.signal;
			return pending.promise;
		});
		const request = harness.handler.handleMessage(webviewRequest())!;

		harness.handler.dispose();
		harness.handler.dispose();
		expect(signal?.aborted).toBe(true);
		pending.resolve(schemaResult('Late'));
		await request;
		await harness.handler.handleMessage(webviewRequest());

		expect(harness.getSchema).toHaveBeenCalledOnce();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('keeps schema request authority out of QueryEditorProvider', () => {
		const workspaceRoot = path.resolve(__dirname, '../../..');
		const readSource = (relativePath: string) => fs.readFileSync(
			path.join(workspaceRoot, relativePath),
			'utf8',
		);
		const providerSource = readSource('src/host/queryEditorProvider.ts');
		const handlerSource = readSource('src/host/sqlSchemaRequestApplicationHandler.ts');
		const lifecycleSource = readSource('src/host/sql/sqlEditorLifecycleCoordinator.ts');
		const serviceSource = readSource('src/host/sqlEditorSchema.ts');

		expect(providerSource).not.toContain("case 'prefetchSqlSchema':");
		expect(providerSource).not.toContain('private async prefetchSqlSchema(');
		expect(providerSource).not.toContain("type: 'sqlSchemaData'");
		expect(providerSource).toContain('readonly sqlSchemaRequestApplication: SqlSchemaRequestApplicationHandler;');
		expect(providerSource).toContain('prefetchSchema: request => this.sqlSchemaRequestApplication.requestSchema(request)');
		expect(providerSource).toContain('this.sqlSchemaRequestApplication.dispose();');
		expect(handlerSource).toContain('parseSqlSchemaWebviewMessage(message)');
		expect(handlerSource.indexOf('parseSqlSchemaWebviewMessage(message)'))
			.toBeLessThan(handlerSource.indexOf('this.options.lifecycle.adoptTarget('));
		expect(handlerSource).toContain('postMessage: (message: SqlSchemaHostMessage)');
		expect(handlerSource).toContain('private readonly activeRequests = new Map<string, ActiveSqlSchemaRequest>();');
		expect(handlerSource).toContain('previous?.abortController.abort();');
		expect(handlerSource).toContain('assertRequestCurrent: () => this.assertCurrent(active)');
		expect(handlerSource).toContain("type: 'sqlSchemaData'");
		expect(lifecycleSource).toContain('prefetchSchema(request: SqlSchemaRefreshRequest): Promise<void>;');
		expect(serviceSource).toContain('await this.assertCurrentOwner(connection, entry);');
		expect(serviceSource.match(/await this\.assertRequestCurrent\(options\);/g)?.length ?? 0)
			.toBeGreaterThanOrEqual(8);
	});
});