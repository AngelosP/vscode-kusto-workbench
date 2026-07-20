import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { StsQueryService } from '../../../src/host/sql/stsQueryService';
import { STS_METHODS } from '../../../src/host/sql/stsProtocol';

type NotificationHandler = (params: any, epoch: number) => void;

class FakeProcessManager {
	epoch = 1;
	isRunning = true;
	requests: Array<{ method: string; params: any; options: any }> = [];
	private readonly handlers = new Map<string, Set<NotificationHandler>>();
	private readonly epochEndHandlers = new Set<(event: any) => void>();
	onRequest: (method: string, params: any) => unknown | Promise<unknown> = () => ({});

	async sendRequest<T>(method: string, params?: unknown, options?: unknown): Promise<T> {
		this.requests.push({ method, params, options });
		return await this.onRequest(method, params) as T;
	}

	onNotification(method: string, handler: NotificationHandler) {
		let handlers = this.handlers.get(method);
		if (!handlers) {
			handlers = new Set();
			this.handlers.set(method, handlers);
		}
		handlers.add(handler);
		return { dispose: () => handlers?.delete(handler) };
	}

	onDidEndEpoch(handler: (event: any) => void) {
		this.epochEndHandlers.add(handler);
		return { dispose: () => this.epochEndHandlers.delete(handler) };
	}

	emit(method: string, params: any): void {
		for (const handler of this.handlers.get(method) ?? []) handler(params, this.epoch);
	}

	endEpoch(): void {
		for (const handler of this.epochEndHandlers) handler({ epoch: this.epoch, error: new Error('crashed') });
	}
}

function createHarness(leaveNoTracePolicy?: any, dispatchSqlOwnerAllowed?: any) {
	let accountMap: Record<string, string> = {};
	const process = new FakeProcessManager();
	const runtime = { getProcessManager: vi.fn().mockResolvedValue(process), dispose: vi.fn() };
	const connectionManager = {
		assertConnectionCurrent: vi.fn().mockResolvedValue(undefined),
		getPasswordForConnection: vi.fn().mockResolvedValue('password'),
	};
	const context = {
		globalState: {
			get: vi.fn((key: string) => key === 'sql.auth.serverAccountMap' ? accountMap : undefined),
			update: vi.fn(async (key: string, value: unknown) => {
				if (key === 'sql.auth.serverAccountMap') accountMap = { ...(value as Record<string, string>) };
			}),
		},
		secrets: { get: vi.fn(), store: vi.fn(), delete: vi.fn() },
	} as any;
	const output = { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any;
	const service = new StsQueryService(runtime as any, connectionManager as any, context, output, leaveNoTracePolicy, dispatchSqlOwnerAllowed);
	const connection = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example',
		authType: 'sql-login', username: 'user',
	};
	return { process, runtime, connectionManager, context, output, service, connection, setAccountMap: (value: Record<string, string>) => { accountMap = value; } };
}

async function waitForRequest(process: FakeProcessManager, method: string, count = 1): Promise<any[]> {
	for (let attempt = 0; attempt < 50; attempt++) {
		const requests = process.requests.filter(request => request.method === method);
		if (requests.length >= count) return requests;
		await Promise.resolve();
	}
	return process.requests.filter(request => request.method === method);
}

function completeConnection(process: FakeProcessManager, ownerUri: string): void {
	process.emit(STS_METHODS.connectComplete, { ownerUri, connectionId: 'connection-1' });
}

describe('StsQueryService', () => {
	beforeEach(() => vi.clearAllMocks());

	it('returns the first final-summary result set and pages all announced rows', async () => {
		const { process, service, connection } = createHarness();
		const pageRows = [
			[{ displayValue: '1', invariantCultureDisplayValue: '1' }, { displayValue: 'one', invariantCultureDisplayValue: 'one' }],
			[{ displayValue: '2', invariantCultureDisplayValue: '2' }, { displayValue: 'two', invariantCultureDisplayValue: 'two' }],
		];
		process.onRequest = (method, params) => {
			if (method === STS_METHODS.querySubset) {
				return { resultSubset: { rowCount: 2, rows: pageRows.slice(params.rowsStartIndex, params.rowsStartIndex + params.rowsCount) } };
			}
			return {};
		};

		const execution = service.executeQueryCancelable(connection, 'Db', 'SELECT 1', 20_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);

		// A notification for a later result set arrives first. Final query order is authoritative.
		process.emit(STS_METHODS.resultSetAvailable, {
			ownerUri,
			resultSetSummary: { id: 9, batchId: 9, rowCount: 1, columnInfo: [{ columnName: 'Wrong', dataTypeName: 'int' }] },
		});
		process.emit(STS_METHODS.queryComplete, {
			ownerUri,
			batchSummaries: [{
				id: 0,
				resultSetSummaries: [{
					id: 0, batchId: 0, rowCount: 2, complete: true,
					columnInfo: [
						{ columnName: 'Value', dataTypeName: 'int' },
						{ columnName: 'Label', dataTypeName: 'nvarchar' },
					],
				}],
			}],
		});

		const result = await execution.promise;
		expect(result.columns).toEqual([{ name: 'Value', type: 'int' }, { name: 'Label', type: 'nvarchar' }]);
		expect(result.rows).toEqual([
			[{ display: '1', full: '1' }, { display: 'one', full: 'one' }],
			[{ display: '2', full: '2' }, { display: 'two', full: 'two' }],
		]);
		expect(process.requests.filter(request => request.method === STS_METHODS.querySubset)).toHaveLength(1);
		expect(process.requests.map(request => request.method)).toEqual(expect.arrayContaining([
			STS_METHODS.queryDispose,
			STS_METHODS.disconnect,
		]));
	});

	it('passes a test-only password override to STS without reading SecretStorage', async () => {
		const { process, service, connection, connectionManager } = createHarness();
		process.onRequest = method => method === STS_METHODS.listDatabases
			? { databaseNames: ['DbA'] }
			: {};

		const promise = service.getDatabases(connection, 'draft-password');
		const connect = await waitForRequest(process, STS_METHODS.connect);
		expect(connect[0].params.connection.options.password).toBe('draft-password');
		expect(connectionManager.getPasswordForConnection).not.toHaveBeenCalled();
		completeConnection(process, connect[0].params.ownerUri);

		await expect(promise).resolves.toEqual(['DbA']);
	});

	it('adopts an initially absent AAD principal established during connection', async () => {
		const { process, service, connection } = createHarness();
		connection.authType = 'aad';
		delete (connection as any).username;
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({ accessToken: 'aad-token', account: { id: 'account-a', label: 'Account A' } } as any);
		process.onRequest = method => method === STS_METHODS.listDatabases ? { databaseNames: ['DbA'] } : {};

		const promise = service.getDatabases(connection);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);

		await expect(promise).resolves.toEqual(['DbA']);
	});

	it('rejects database rows when the canonical target changes after STS responds', async () => {
		const { process, service, connection, connectionManager } = createHarness();
		let targetCurrent = true;
		connectionManager.assertConnectionCurrent.mockImplementation(async () => {
			if (!targetCurrent) throw new Error('SQL connection changed while credentials were being resolved.');
		});
		process.onRequest = method => {
			if (method === STS_METHODS.listDatabases) {
				targetCurrent = false;
				return { databaseNames: ['OldTargetDb'] };
			}
			return {};
		};

		const promise = service.getDatabases(connection);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);

		await expect(promise).rejects.toThrow('SQL connection changed');
	});

	it('rejects database rows when an established AAD principal rotates', async () => {
		const { process, service, connection, setAccountMap } = createHarness();
		connection.authType = 'aad';
		delete (connection as any).username;
		setAccountMap({ 'server.example': 'account-a' });
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({ accessToken: 'aad-token', account: { id: 'account-a', label: 'Account A' } } as any);
		process.onRequest = method => {
			if (method === STS_METHODS.listDatabases) {
				setAccountMap({ 'server.example': 'account-b' });
				return { databaseNames: ['AccountASecretDb'] };
			}
			return {};
		};

		const promise = service.getDatabases(connection);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);

		await expect(promise).rejects.toThrow('principal changed');
	});

	it('does not submit STS connect when token resolution returns a different established AAD account', async () => {
		const { process, service, connection, setAccountMap } = createHarness();
		connection.authType = 'aad';
		delete (connection as any).username;
		setAccountMap({ 'server.example': 'account-a' });
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({
			accessToken: 'account-b-token', account: { id: 'account-b', label: 'Account B' },
		} as any);

		await expect(service.getDatabases(connection)).rejects.toThrow('principal changed');

		for (const method of [STS_METHODS.connect, STS_METHODS.listDatabases, STS_METHODS.executeString, STS_METHODS.querySubset]) {
			expect(process.requests.some(request => request.method === method)).toBe(false);
		}
	});

	it('rejects first-AAD work when the canonical account differs from the token account', async () => {
		const { service, connection, context } = createHarness() as any;
		connection.authType = 'aad';
		delete (connection as any).username;
		vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({ accessToken: 'account-a-token', account: { id: 'account-a', label: 'Account A' } } as any);
		const realUpdate = context.globalState.update.getMockImplementation()!;
		context.globalState.update.mockImplementation(async (key: string, value: unknown) => {
			await realUpdate(key, value);
			if (key === 'sql.auth.serverAccountMap') await realUpdate(key, { 'server.example': 'account-b' });
		});

		await expect(service.getDatabases(connection)).rejects.toThrow('principal changed');
	});

	it('pages 2,501 rows exactly once across three subset requests', async () => {
		const { process, service, connection } = createHarness();
		const allRows = Array.from({ length: 2501 }, (_, index) => [{
			displayValue: String(index + 1),
			invariantCultureDisplayValue: String(index + 1),
		}]);
		process.onRequest = (method, params) => method === STS_METHODS.querySubset
			? { resultSubset: { rowCount: allRows.length, rows: allRows.slice(params.rowsStartIndex, params.rowsStartIndex + params.rowsCount) } }
			: {};

		const promise = service.executeQuery(connection, 'Db', 'SELECT n FROM Numbers ORDER BY n', 20_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);
		process.emit(STS_METHODS.queryComplete, {
			ownerUri,
			batchSummaries: [{ resultSetSummaries: [{
				rowCount: allRows.length,
				columnInfo: [{ columnName: 'n', dataTypeName: 'int' }],
			}] }],
		});

		const result = await promise;
		expect(result.rows).toHaveLength(2501);
		expect([0, 999, 1000, 1999, 2000, 2500].map(index => (result.rows[index][0] as any).full))
			.toEqual(['1', '1000', '1001', '2000', '2001', '2501']);
		const subsets = process.requests.filter(request => request.method === STS_METHODS.querySubset);
		expect(subsets.map(request => [request.params.rowsStartIndex, request.params.rowsCount]))
			.toEqual([[0, 1000], [1000, 1000], [2000, 501]]);
	});

	it('rejects a subset response when Leave No Trace is enabled before admission', async () => {
		let allowed = true;
		const policy = {
			getConnectionIds: () => allowed ? [] : ['sql-1'],
			isProtected: () => !allowed,
			refresh: vi.fn(async () => allowed ? [] : ['sql-1']),
			assertAllowed: vi.fn(async () => {
				if (!allowed) throw new Error('Leave No Trace blocked');
			}),
		};
		const { process, service, connection } = createHarness(policy);
		process.onRequest = (method) => {
			if (method === STS_METHODS.querySubset) {
				allowed = false;
				return { resultSubset: { rowCount: 1, rows: [[{ displayValue: 'secret', invariantCultureDisplayValue: 'secret' }]] } };
			}
			return {};
		};

		const promise = service.executeQuery(connection, 'Db', 'SELECT Secret FROM T', 20_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);
		process.emit(STS_METHODS.queryComplete, {
			ownerUri,
			batchSummaries: [{ resultSetSummaries: [{ rowCount: 1, columnInfo: [{ columnName: 'Secret', dataTypeName: 'nvarchar' }] }] }],
		});

		await expect(promise).rejects.toThrow('Leave No Trace blocked');
		expect(process.requests.filter(request => request.method === STS_METHODS.querySubset)).toHaveLength(1);
	});

	it('rejects connection completion when Leave No Trace is enabled before admission', async () => {
		let allowed = true;
		const policy = {
			getConnectionIds: () => allowed ? [] : ['sql-1'],
			isProtected: () => !allowed,
			refresh: vi.fn(async () => allowed ? [] : ['sql-1']),
			assertAllowed: vi.fn(async () => {
				if (!allowed) throw new Error('Leave No Trace blocked');
			}),
		};
		const { process, service, connection } = createHarness(policy);
		const promise = service.executeQuery(connection, 'Db', 'SELECT 1', 20_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		allowed = false;
		completeConnection(process, connect[0].params.ownerUri);

		await expect(promise).rejects.toThrow('Leave No Trace blocked');
		expect(process.requests.some(request => request.method === STS_METHODS.executeString)).toBe(false);
	});

	it('does not dispatch STS connect when canonical admission rejects after preflight', async () => {
		const policy = {
			getConnectionIds: () => [],
			isProtected: () => false,
			refresh: vi.fn(async () => []),
			assertAllowed: vi.fn(async () => undefined),
			dispatchAllowed: vi.fn(async () => { throw new Error('Leave No Trace committed'); }),
		};
		const { process, service, connection } = createHarness(policy);

		await expect(service.executeQuery(connection, 'Db', 'SELECT 1', 20_000))
			.rejects.toThrow('Leave No Trace committed');

		expect(process.requests.some(request => request.method === STS_METHODS.connect)).toBe(false);
	});

	it('does not dispatch STS connect when composite owner admission rejects after preflight', async () => {
		const dispatchOwner = vi.fn(async () => { throw new Error('canonical owner changed'); });
		const { process, service, connection } = createHarness(undefined, dispatchOwner);

		await expect(service.executeQuery(connection, 'Db', 'UPDATE dbo.T SET Value = 1', 20_000))
			.rejects.toThrow('canonical owner changed');

		expect(dispatchOwner).toHaveBeenCalledOnce();
		expect(process.requests.some(request => request.method === STS_METHODS.connect)).toBe(false);
	});

	it('does not dispatch STS connect after cancellation wins during canonical admission', async () => {
		let releaseAdmission!: () => void;
		const admission = new Promise<void>(resolve => { releaseAdmission = resolve; });
		const dispatchOwner = vi.fn(async (_connection, _principal, _revocation, dispatch) => {
			await admission;
			return await dispatch();
		});
		const { process, service, connection } = createHarness(undefined, dispatchOwner);
		const execution = service.executeQueryCancelable(connection, 'Db', 'SELECT 1', 20_000);
		await vi.waitFor(() => expect(dispatchOwner).toHaveBeenCalledOnce());

		execution.cancel();
		releaseAdmission();

		await expect(execution.promise).rejects.toMatchObject({ isCancelled: true });
		await Promise.resolve();
		expect(process.requests.some(request => request.method === STS_METHODS.connect)).toBe(false);
	});

	it('preserves columns for an empty first result set without requesting a subset', async () => {
		const { process, service, connection } = createHarness();
		const promise = service.executeQuery(connection, 'Db', 'SELECT TOP 0 1 AS Value', 20_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);
		process.emit(STS_METHODS.queryComplete, {
			ownerUri,
			batchSummaries: [{ resultSetSummaries: [{ rowCount: 0, columnInfo: [{ columnName: 'Value', dataTypeName: 'int' }] }] }],
		});

		const result = await promise;
		expect(result.columns).toEqual([{ name: 'Value', type: 'int' }]);
		expect(result.rows).toEqual([]);
		expect(process.requests.some(request => request.method === STS_METHODS.querySubset)).toBe(false);
	});

	it('rejects when a later batch reports an error even if a result set exists', async () => {
		const { process, service, connection } = createHarness();
		const promise = service.executeQuery(connection, 'Db', 'SELECT 1; THROW 50000, \'failed\', 1', 20_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);
		process.emit(STS_METHODS.queryMessage, { ownerUri, message: { isError: true, message: 'failed' } });
		process.emit(STS_METHODS.queryComplete, {
			ownerUri,
			batchSummaries: [
				{ hasError: false, resultSetSummaries: [{ rowCount: 1, columnInfo: [{ columnName: 'Value', dataTypeName: 'int' }] }] },
				{ hasError: true, resultSetSummaries: [] },
			],
		});

		await expect(promise).rejects.toThrow('failed');
		expect(process.requests.some(request => request.method === STS_METHODS.querySubset)).toBe(false);
		expect(process.requests.some(request => request.method === STS_METHODS.queryDispose)).toBe(true);
	});

	it('rejects immediately on cancel and sends cancel, dispose, and disconnect exactly once', async () => {
		const { process, service, connection } = createHarness();
		const execution = service.executeQueryCancelable(connection, 'Db', "WAITFOR DELAY '00:00:30'", 60_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);

		execution.cancel();
		await expect(execution.promise).rejects.toMatchObject({ isCancelled: true });
		await waitForRequest(process, STS_METHODS.disconnect);
		expect(process.requests.filter(request => request.method === STS_METHODS.queryCancel)).toHaveLength(1);
		expect(process.requests.filter(request => request.method === STS_METHODS.queryDispose)).toHaveLength(1);
		expect(process.requests.filter(request => request.method === STS_METHODS.disconnect)).toHaveLength(1);

		process.emit(STS_METHODS.queryComplete, { ownerUri, batchSummaries: [] });
		expect(process.requests.filter(request => request.method === STS_METHODS.disconnect)).toHaveLength(1);
	});

	it('fails an active operation when the STS process epoch ends', async () => {
		const { process, service, connection } = createHarness();
		const promise = service.executeQuery(connection, 'Db', 'SELECT 1', 60_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		const ownerUri = connect[0].params.ownerUri;
		completeConnection(process, ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);
		process.endEpoch();
		await expect(promise).rejects.toThrow('outcome may be unknown');
	});

	it('cancels and disposes active work for a connection when Leave No Trace is enabled', async () => {
		const { process, service, connection } = createHarness();
		const execution = service.executeQueryCancelable(connection, 'Db', "WAITFOR DELAY '00:00:30'", 60_000);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);
		await waitForRequest(process, STS_METHODS.executeString);

		await service.cancelConnection(connection.id);
		await expect(execution.promise).rejects.toMatchObject({ isCancelled: true });
		expect(process.requests.filter(request => request.method === STS_METHODS.queryCancel)).toHaveLength(1);
		expect(process.requests.filter(request => request.method === STS_METHODS.queryDispose)).toHaveLength(1);
		expect(process.requests.filter(request => request.method === STS_METHODS.disconnect)).toHaveLength(1);
	});

	it('lists and sorts databases through the connected owner', async () => {
		const { process, service, connection } = createHarness();
		process.onRequest = method => method === STS_METHODS.listDatabases
			? { databaseNames: ['zeta', 'master', 'Alpha'] }
			: {};
		const promise = service.getDatabases(connection);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);
		expect(await promise).toEqual(['Alpha', 'master', 'zeta']);
	});

	it('rejects in-flight database discovery after connection-scoped cancellation', async () => {
		const { process, service, connection } = createHarness();
		let resolveDatabases!: (value: unknown) => void;
		process.onRequest = method => method === STS_METHODS.listDatabases
			? new Promise(resolve => { resolveDatabases = resolve; })
			: {};
		const promise = service.getDatabases(connection);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);
		await waitForRequest(process, STS_METHODS.listDatabases);

		const cancellation = service.cancelConnection(connection.id);
		resolveDatabases({ databaseNames: ['must-not-arrive'] });

		await cancellation;
		await expect(promise).rejects.toMatchObject({ isCancelled: true });
	});

	it('cancels in-flight database discovery when its AbortSignal fires', async () => {
		const { process, service, connection } = createHarness();
		let resolveDatabases!: (value: unknown) => void;
		process.onRequest = method => method === STS_METHODS.listDatabases
			? new Promise(resolve => { resolveDatabases = resolve; })
			: {};
		const controller = new AbortController();
		const promise = service.getDatabases(connection, undefined, false, controller.signal);
		const connect = await waitForRequest(process, STS_METHODS.connect);
		completeConnection(process, connect[0].params.ownerUri);
		await waitForRequest(process, STS_METHODS.listDatabases);

		controller.abort();
		resolveDatabases({ databaseNames: ['must-not-arrive'] });

		await expect(promise).rejects.toMatchObject({ isCancelled: true });
		await waitForRequest(process, STS_METHODS.disconnect);
		expect(process.requests.some(request => request.method === STS_METHODS.disconnect)).toBe(true);
	});
});