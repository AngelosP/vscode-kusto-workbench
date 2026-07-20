import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
	selectChatModels: vi.fn(),
}));

vi.mock('vscode', async () => {
	const actual = await vi.importActual<typeof import('../../mocks/vscode')>('../../mocks/vscode');
	class CancellationTokenSource {
		private readonly listeners = new Set<() => void>();
		readonly token = {
			isCancellationRequested: false,
			onCancellationRequested: (listener: () => void) => {
				this.listeners.add(listener);
				return { dispose: () => this.listeners.delete(listener) };
			},
		};
		cancel(): void {
			if (this.token.isCancellationRequested) return;
			this.token.isCancellationRequested = true;
			for (const listener of [...this.listeners]) listener();
		}
		dispose(): void { this.listeners.clear(); }
	}
	class LanguageModelError extends Error {}
	return {
		...actual,
		CancellationTokenSource,
		LanguageModelError,
		lm: {
			selectChatModels: vscodeMocks.selectChatModels,
		},
	};
});

import * as vscode from 'vscode';
import { CopilotService, type CopilotServiceHost } from '../../../src/host/queryEditorCopilot.js';
import type { KustoConnection } from '../../../src/host/connectionManager.js';
import { appendQueryMode, buildCacheDirective, isControlCommand, normalizeControlCommandForExecution } from '../../../src/host/queryEditorUtils.js';
import { SqlLeaveNoTraceBlockedError } from '../../../src/host/sql/sqlLeaveNoTrace.js';

const TEST_CONNECTION: KustoConnection = {
	id: 'conn-1',
	name: 'Test cluster',
	clusterUrl: 'https://example.kusto.windows.net',
};

function streamParts(parts: unknown[]): AsyncIterable<unknown> {
	return (async function* () {
		for (const part of parts) {
			yield part;
		}
	})();
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
	return { promise, resolve, reject };
}

function createModel(partsByRequest: unknown[][]): any {
	let requestIndex = 0;
	return {
		id: 'test-model',
		name: 'Test Model',
		family: 'test',
		vendor: 'copilot',
		version: '1',
		sendRequest: vi.fn(async () => {
			const parts = partsByRequest[Math.min(requestIndex, partsByRequest.length - 1)] ?? [];
			requestIndex++;
			return { stream: streamParts(parts) };
		}),
	};
}

function createTextModel(text: string): any {
	return {
		id: 'test-model',
		name: 'Test Model',
		family: 'test',
		vendor: 'copilot',
		version: '1',
		sendRequest: vi.fn(async () => ({
			text: streamParts([text]),
		})),
	};
}

function createHost(capturedQueries: string[], executeError?: Error): CopilotServiceHost {
	let runSeq = 0;
	return {
		extensionUri: vscode.Uri.file('/extension'),
		context: {
			globalState: {
				get: () => undefined,
				update: () => Promise.resolve(),
			},
		} as any,
		kustoClient: {
			getAccountPartition: vi.fn(() => 'partition-current'),
			executeQueryCancelable: vi.fn((_connection: KustoConnection, _database: string, query: string) => {
				capturedQueries.push(query);
				return {
					promise: executeError ? Promise.reject(executeError) : Promise.resolve({ columns: ['x'], rows: [[1]], metadata: {} }),
					cancel: vi.fn(),
					clientActivityId: 'KW.execute_query;test',
					getAccountPartition: () => 'partition-current',
				};
			}),
		} as any,
		output: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() } as any,
		postMessage: vi.fn(() => true),
		findConnection: vi.fn(() => TEST_CONNECTION),
		getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
		formatQueryExecutionErrorForUser: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
		logQueryExecutionError: vi.fn(),
		normalizeClusterUrlKey: (url: string) => url,
		cancelRunningQuery: vi.fn(),
		supersedeSqlRunAdmission: vi.fn(() => 1),
		startSqlRunUnderAdmission: vi.fn((_boxId: string, _generation: number, start: () => any, _executionId?: string) => ({ execution: start(), runSeq: ++runSeq })),
		isSqlRunAdmissionCurrent: vi.fn(() => true),
		reserveRunningQueryReplacement: vi.fn((_boxId: string, executionId: string) => ({
			cancel: vi.fn(), runSeq: ++runSeq, previousCancellationDelivery: Promise.resolve(true), executionId,
		})),
		promoteRunningQueryReservation: vi.fn(() => true),
		registerRunningQuery: vi.fn(),
		unregisterRunningQuery: vi.fn(),
		nextQueryRunSeq: () => ++runSeq,
		isRunningQueryCurrent: vi.fn(() => true),
		isControlCommand,
		appendQueryMode,
		normalizeControlCommandForExecution,
		buildCacheDirective: vi.fn((enabled?: boolean, value?: number, unit?: string) => buildCacheDirective(enabled, value, unit)),
		getCachedSchemaFromDisk: () => Promise.resolve(undefined),
		saveCachedSchemaToDisk: () => Promise.resolve(),
		ensureComparisonBoxInWebview: () => Promise.resolve('comparison'),
		waitForComparisonSummary: () => Promise.resolve({ dataMatches: true, headersMatch: true }),
		deleteComparisonSummary: vi.fn(),
		requestSectionsFromWebview: () => Promise.resolve(undefined),
		revealPanel: vi.fn(),
		assertSqlConnectionAllowed: vi.fn(async () => undefined),
		dispatchSqlConnectionAllowed: vi.fn(async (_connectionId: string, dispatch: () => unknown) => await dispatch()),
		dispatchSqlResultOwnerAllowed: vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => await dispatch()),
		getSqlResultOwner: vi.fn(() => ({
			connectionId: 'sql-a', database: 'Db', generation: 1, targetSignature: 'target-a',
			principalFingerprint: 'principal-a', revocationGeneration: 0,
		})),
		assertSqlResultOwnerAllowed: vi.fn(async () => undefined),
	};
}

function createHostWithComparisonCapture(capturedQueries: string[], comparisonQueries: string[]): CopilotServiceHost {
	const host = createHost(capturedQueries);
	host.ensureComparisonBoxInWebview = vi.fn((_sourceBoxId: string, query: string) => {
		comparisonQueries.push(query);
		return Promise.resolve('comparison');
	});
	return host;
}

function createHostWithQueryErrors(capturedQueries: string[], errorsByQuery: Record<string, Error>): CopilotServiceHost {
	const host = createHost(capturedQueries);
	(host.kustoClient.executeQueryCancelable as any) = vi.fn((_connection: KustoConnection, _database: string, query: string) => {
		capturedQueries.push(query);
		const error = errorsByQuery[query];
		return {
			promise: error ? Promise.reject(error) : Promise.resolve({ columns: ['x'], rows: [[1]], metadata: {} }),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;test',
			getAccountPartition: () => 'partition-current',
		};
	});
	return host;
}

function hostMessagesOfType(host: CopilotServiceHost, type: string): any[] {
	return ((host.postMessage as any).mock.calls as unknown[][])
		.map(call => call[0] as any)
		.filter(message => message?.type === type);
}

function normalizeQueryText(query: string): string {
	return String(query || '').replace(/\s+/g, ' ').trim();
}

function expectInlineFilterRowsQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(normalized).toContain('range x from 1 to 10 step 1 | where x > threshold');
	expect(normalized).toContain('};');
	expect(normalized).toContain('FilterRows(5)');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5)'));
	expect(query).not.toMatch(/(^|\n)\s*\.(create-or-alter|create|alter)\s+function\b/i);
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectInlineFilterRowsQueryWithRange(query: string, rangeEnd: number): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(normalized).toContain(`range x from 1 to ${rangeEnd} step 1 | where x > threshold`);
	expect(normalized).toContain('};');
	expect(normalized).toContain('FilterRows(5)');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5)'));
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectInlineFilterRowsQueryAllowingCommentedCommands(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(normalized).toContain('range x from 1 to 10 step 1 | where x > threshold');
	expect(normalized).toContain('};');
	expect(normalized).toContain('FilterRows(5)');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5)'));
	const withoutComments = query
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(line => !line.trimStart().startsWith('//'))
		.join('\n');
	expect(withoutComments).not.toMatch(/(^|\n)\s*\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectInlineMultilineFilterRowsQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(normalized).toContain('range x from 1 to 10 step 1 | where x > threshold | project doubled = x * 2');
	expect(normalized).toContain('};');
	expect(normalized).toContain('FilterRows(5) | take 5');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5) | take 5'));
	expect(query).not.toMatch(/(^|\n)\s*\.(create-or-alter|create|alter)\s+function\b/i);
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectInlineNestedBracesQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(normalized).toContain('dynamic({"key":"value"})');
	expect(normalized).toContain('| where x > threshold');
	expect(normalized).toContain('FilterRows(5) | take 5');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5) | take 5'));
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectInlineBodyCommentQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(query).toContain('// keep this body comment\nrange x from 1 to 10 step 1');
	expect(normalized).toContain('FilterRows(5)');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5)'));
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectInlineSemicolonInvocationQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FilterRows\s*=\s*\(threshold:long\)\s*\{/);
	expect(normalized).toContain('let cutoff = 5; range x from 1 to 10 step 1 | where x > cutoff');
	expect(normalized).toContain('}; FilterRows(5)');
	expect(normalized.indexOf('let FilterRows')).toBeLessThan(normalized.indexOf('FilterRows(5)'));
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectPlainCommentedFakeFunctionQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(query).toMatch(/(^|\n)\s*(\/\/|\/\*)[\s\S]*\.(create-or-alter|create|alter)\s+function\s+Fake\b/i);
	expect(normalized).toContain('print x=1');
	expect(normalized).not.toMatch(/\blet\s+Fake\s*=/i);
	const withoutComments = query
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(line => !line.trimStart().startsWith('//'))
		.join('\n');
	expect(withoutComments).not.toMatch(/(^|\n)\s*\.(create-or-alter|create|alter)\s+function\s+Fake\b/i);
}

function expectInlineTwoFunctionQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toMatch(/\blet\s+FirstRows\s*=\s*\(\)\s*\{/);
	expect(normalized).toMatch(/\blet\s+SecondRows\s*=\s*\(\)\s*\{/);
	expect(normalized).toContain('SecondRows() | take 5');
	expect(normalized.indexOf('let FirstRows')).toBeLessThan(normalized.indexOf('let SecondRows'));
	expect(normalized.indexOf('let SecondRows')).toBeLessThan(normalized.indexOf('SecondRows() | take 5'));
	expect(normalized).not.toMatch(/\.(create-or-alter|create|alter)\s+function\b/i);
}

function expectMetadataAlterQueryUnconverted(query: string, command = '.alter function docstring FilterRows "new docs"'): void {
	const normalized = normalizeQueryText(query);
	expect(normalized).toContain(command);
	expect(normalized).toContain('print x=1');
	expect(normalized).not.toMatch(/\blet\s+FilterRows\s*=/i);
}

function expectNoCacheDirective(query: string): void {
	expect(query).not.toMatch(/^\s*set\s+query_results_cache_max_age\b/i);
}

function expectInlineFakeThenRealQuery(query: string): void {
	const normalized = normalizeQueryText(query);
	expect(query).toMatch(/(^|\n)\s*(\/\/|\/\*)[\s\S]*\.(create-or-alter|create|alter)\s+function\s+Fake\b/i);
	const withoutComments = query
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split(/\r?\n/)
		.filter(line => !line.trimStart().startsWith('//'))
		.join('\n');
	expect(withoutComments).not.toMatch(/(^|\n)\s*\.(create-or-alter|create|alter)\s+function\s+Fake\b/i);
	expect(normalized).not.toMatch(/\blet\s+Fake\s*=/i);
	expectInlineFilterRowsQueryAllowingCommentedCommands(query);
}

function historyToolQueries(service: CopilotService): string[] {
	const history = ((service as any).copilotConversationHistoryByBoxId.get('query_1') ?? []) as any[];
	return history
		.filter(entry => entry?.type === 'tool-call')
		.map(entry => entry?.args?.query)
		.filter((query): query is string => typeof query === 'string');
}

function startMessage(queryMode = 'plain') {
	return {
		type: 'startCopilotWriteQuery' as const,
		boxId: 'query_1',
		flavor: 'kusto' as const,
		connectionId: TEST_CONNECTION.id,
		serverUrl: TEST_CONNECTION.clusterUrl,
		database: 'Samples',
		request: 'Run this function with threshold 5.',
		queryMode,
	};
}

describe('Kusto Copilot function execution', () => {
	it('cancels only the exact Copilot sequence without canceling unrelated source work', () => {
		const host = createHost([]);
		const service = new CopilotService(host);
		const cancel = vi.fn();
		const cts = { cancel: vi.fn() };
		(service as any).runningCopilotWriteQueryByBoxId.set('box-a', {
			cts,
			seq: 8,
			queryCancels: new Set([cancel]),
			kustoAccountPartitionGetters: new Set(),
		});

		service.cancelCopilotWriteQuery('box-a', 7);

		expect(cancel).not.toHaveBeenCalled();
		expect(cts.cancel).not.toHaveBeenCalled();

		service.cancelCopilotWriteQuery('box-a', 8);

		expect(cancel).toHaveBeenCalledOnce();
		expect(cts.cancel).toHaveBeenCalledOnce();
		expect(host.cancelRunningQuery).not.toHaveBeenCalled();
	});

	it('clears only Copilot state owned by affected Kusto connections', () => {
		const host = createHost([]);
		const service = new CopilotService(host);
		const cancelA = vi.fn();
		const cancelB = vi.fn();
		const ctsA = { cancel: vi.fn() };
		const ctsB = { cancel: vi.fn() };
		(service as any).copilotConversationOwnerByBoxId.set('box-a', { flavor: 'kusto', connectionId: 'conn-a' });
		(service as any).copilotConversationOwnerByBoxId.set('box-b', { flavor: 'kusto', connectionId: 'conn-b' });
		(service as any).copilotConversationOwnerByBoxId.set('box-sql', { flavor: 'sql', connectionId: 'sql-a' });
		(service as any).copilotConversationHistoryByBoxId.set('box-a', [{ type: 'user-message', id: 'a', text: 'secret-a' }]);
		(service as any).copilotConversationHistoryByBoxId.set('box-b', [{ type: 'user-message', id: 'b', text: 'keep-b' }]);
		(service as any).copilotConversationHistoryByBoxId.set('box-sql', [{ type: 'user-message', id: 'sql', text: 'keep-sql' }]);
		(service as any).runningCopilotWriteQueryByBoxId.set('box-a', { cts: ctsA, seq: 1, queryCancels: new Set([cancelA]) });
		(service as any).runningCopilotWriteQueryByBoxId.set('box-b', { cts: ctsB, seq: 2, queryCancels: new Set([cancelB]) });

		service.invalidateKustoConnections(['conn-a']);

		expect(cancelA).toHaveBeenCalledOnce();
		expect(ctsA.cancel).toHaveBeenCalledOnce();
		expect(host.cancelRunningQuery).toHaveBeenCalledWith('box-a');
		expect((service as any).copilotConversationHistoryByBoxId.has('box-a')).toBe(false);
		expect((service as any).copilotConversationOwnerByBoxId.has('box-a')).toBe(false);
		expect(cancelB).not.toHaveBeenCalled();
		expect((service as any).copilotConversationHistoryByBoxId.get('box-b')[0].text).toBe('keep-b');
		expect((service as any).copilotConversationHistoryByBoxId.get('box-sql')[0].text).toBe('keep-sql');
	});

	it('cancels and clears SQL Copilot state owned by a protected connection', () => {
		const host = createHost([]);
		const service = new CopilotService(host);
		const cancelSql = vi.fn();
		const cancelOther = vi.fn();
		const ctsSql = { cancel: vi.fn() };
		const ctsOther = { cancel: vi.fn() };
		(service as any).copilotConversationOwnerByBoxId.set('box-sql', { flavor: 'sql', connectionId: 'sql-a' });
		(service as any).copilotConversationOwnerByBoxId.set('box-other', { flavor: 'sql', connectionId: 'sql-b' });
		(service as any).copilotConversationHistoryByBoxId.set('box-sql', [{ type: 'tool-call', id: 'sql', result: 'secret-row' }]);
		(service as any).copilotConversationHistoryByBoxId.set('box-other', [{ type: 'user-message', id: 'other', text: 'keep' }]);
		(service as any).runningCopilotWriteQueryByBoxId.set('box-sql', { cts: ctsSql, seq: 1, queryCancels: new Set([cancelSql]), kustoAccountPartitionGetters: new Set() });
		(service as any).runningCopilotWriteQueryByBoxId.set('box-other', { cts: ctsOther, seq: 2, queryCancels: new Set([cancelOther]), kustoAccountPartitionGetters: new Set() });

		service.invalidateSqlConnections(['sql-a'], ['box-comparison']);

		expect(cancelSql).toHaveBeenCalledOnce();
		expect(ctsSql.cancel).toHaveBeenCalledOnce();
		expect(host.cancelRunningQuery).toHaveBeenCalledWith('box-sql');
		expect((service as any).copilotConversationHistoryByBoxId.has('box-sql')).toBe(false);
		expect((service as any).copilotConversationOwnerByBoxId.has('box-sql')).toBe(false);
		expect(cancelOther).not.toHaveBeenCalled();
		expect((service as any).copilotConversationHistoryByBoxId.get('box-other')[0].text).toBe('keep');
		expect(host.postMessage).toHaveBeenCalledWith({ type: 'sqlCopilotPolicyChanged', boxIds: ['box-sql', 'box-comparison'] });
	});

	it('does not dispatch an inline SQL prompt when its owner is invalidated during model selection', async () => {
		const modelSelection = deferred<any[]>();
		const model = createTextModel('FROM SecretTable');
		vscodeMocks.selectChatModels.mockReturnValue(modelSelection.promise);
		const host = createHost([]);
		const service = new CopilotService(host);
		const owner = {
			connectionId: 'sql-a', database: 'Db', generation: 1,
			targetSignature: 'target-a', principalFingerprint: 'principal-a', revocationGeneration: 0,
		};

		const request = service.handleCopilotInlineCompletionRequest({
			type: 'requestCopilotInlineCompletion', requestId: 'inline-1', boxId: 'sql-inline',
			textBefore: 'SELECT * ', textAfter: '', flavor: 'sql', ownerToken: 'owner-a',
		}, owner, 'owner-a');
		await vi.waitFor(() => expect(vscodeMocks.selectChatModels).toHaveBeenCalledOnce());
		service.invalidateSqlConnections(['sql-a']);
		modelSelection.resolve([model]);
		await request;

		expect(model.sendRequest).not.toHaveBeenCalled();
	});

	it('does not dispatch an inline Kusto prompt after disposal during model selection', async () => {
		const modelSelection = deferred<any[]>();
		const model = createTextModel('| take 10');
		vscodeMocks.selectChatModels.mockReturnValue(modelSelection.promise);
		const host = createHost([]);
		const service = new CopilotService(host);

		const request = service.handleCopilotInlineCompletionRequest({
			type: 'requestCopilotInlineCompletion', requestId: 'inline-kusto-1', boxId: 'query-inline',
			textBefore: 'StormEvents ', textAfter: '', flavor: 'kusto',
		});
		await vi.waitFor(() => expect(vscodeMocks.selectChatModels).toHaveBeenCalledOnce());
		service.dispose();
		modelSelection.resolve([model]);
		await request;

		expect(model.sendRequest).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'copilotInlineCompletionResult')).toHaveLength(0);
		expect((service as any)._cachedInlineModel).toBeNull();
		expect((service as any)._cachedInlineModelAt).toBe(0);
	});

	it('does not recreate shared SQL history when invalidated during schema preflight', async () => {
		const model = createModel([[new vscode.LanguageModelTextPart('must not run')]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		const schema = deferred<any>();
		const sqlConnection = {
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		};
		const sqlSchemaService = { getSchema: vi.fn(() => schema.promise) } as any;

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Owner A secret request', currentQuery: 'SELECT Secret FROM A',
		}, { getConnection: vi.fn(() => sqlConnection) } as any, sqlSchemaService, undefined);
		await vi.waitFor(() => expect(sqlSchemaService.getSchema).toHaveBeenCalledOnce());
		service.invalidateSqlConnections(['sql-a']);
		schema.resolve({ schema: { tables: ['Secret'], columnsByTable: {} } });
		await request;

		expect(model.sendRequest).not.toHaveBeenCalled();
		expect((service as any).copilotConversationHistoryByBoxId.has('sql-source')).toBe(false);
		expect((service as any).copilotConversationOwnerByBoxId.has('sql-source')).toBe(false);
	});

	it('does not dispatch a SQL model request when canonical LNT admission rejects', async () => {
		const model = createModel([[new vscode.LanguageModelTextPart('must not run')]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.dispatchSqlResultOwnerAllowed = vi.fn(async () => { throw new Error('Leave No Trace committed'); });
		const service = new CopilotService(host);
		const sqlConnection = {
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		};

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write a query.', currentQuery: 'SELECT 1',
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, undefined);

		expect(model.sendRequest).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual(expect.objectContaining({
			boxId: 'sql-source', ok: false, message: 'SQL section owner changed. Retry the request.',
		}));
		expect(JSON.stringify(hostMessagesOfType(host, 'copilotWriteQueryDone'))).not.toContain('Leave No Trace committed');
	});

	it('maps initial SQL policy preflight failures to a generic terminal response', async () => {
		const host = createHost([]);
		host.assertSqlConnectionAllowed = vi.fn(async () => { throw new Error('C:\\private\\sql-policy.lock failed'); });
		const service = new CopilotService(host);

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write a query.', currentQuery: 'SELECT 1', sqlOwnerToken: 'owner-token',
		}, { getConnection: vi.fn() } as any, { getSchema: vi.fn() } as any, undefined);

		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual(expect.objectContaining({
			boxId: 'sql-source', ok: false, ownerToken: 'owner-token',
			message: 'SQL section owner changed. Retry the request.',
		}));
		expect(JSON.stringify(hostMessagesOfType(host, 'copilotWriteQueryDone'))).not.toContain('sql-policy.lock');
	});

	it('cancels SQL Copilot while initial policy preflight is pending', async () => {
		const host = createHost([]);
		const policy = deferred<void>();
		host.assertSqlConnectionAllowed = vi.fn(() => policy.promise);
		const service = new CopilotService(host);
		const getConnection = vi.fn();
		const getSchema = vi.fn();

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write a query.', currentQuery: 'SELECT 1', sqlOwnerToken: 'owner-token',
		}, { getConnection } as any, { getSchema } as any, undefined);
		await vi.waitFor(() => expect(host.assertSqlConnectionAllowed).toHaveBeenCalledOnce());
		service.cancelCopilotWriteQuery('sql-source');
		policy.resolve();
		await request;

		expect(getConnection).not.toHaveBeenCalled();
		expect(getSchema).not.toHaveBeenCalled();
		expect(vscodeMocks.selectChatModels).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual(expect.objectContaining({
			boxId: 'sql-source', ok: false, ownerToken: 'owner-token', message: 'Canceled.',
		}));
	});

	it('does not publish or retain a no-tool SQL narrative when exact owner admission rejects', async () => {
		const model = createModel([[new vscode.LanguageModelTextPart('SECRET_NARRATIVE')]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let admission = 0;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			admission++;
			if (admission === 2) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Explain the query.', currentQuery: 'SELECT 1',
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, undefined);

		expect(hostMessagesOfType(host, 'copilotWriteQueryStatus').some(message => message.role === 'assistant')).toBe(false);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('SECRET_NARRATIVE');
	});

	it('does not publish rules or current-query snapshots after owner admission is revoked during schema preflight', async () => {
		const model = createModel([[new vscode.LanguageModelTextPart('must not run')]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let blockPublication = false;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Owner A request', currentQuery: 'SELECT SECRET_A',
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => { blockPublication = true; return { schema: { tables: ['SecretTable'], columnsByTable: {} } }; }),
		} as any, undefined);

		expect(model.sendRequest).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'copilotGeneralQueryRulesLoaded')).toEqual([]);
		expect(hostMessagesOfType(host, 'copilotUserQuerySnapshot')).toEqual([]);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('SECRET_A');
	});

	it('suppresses terminal model failures after exact owner admission is revoked', async () => {
		let blockPublication = false;
		const model = createModel([[]]);
		model.sendRequest.mockImplementation(async () => {
			blockPublication = true;
			throw new Error('SECRET_MODEL_FAILURE');
		});
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db', request: 'Fail.', currentQuery: 'SELECT 1',
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, undefined);

		expect(JSON.stringify(hostMessagesOfType(host, 'copilotWriteQueryDone'))).not.toContain('SECRET_MODEL_FAILURE');
	});

	it('does not publish or retain get_sql_schema output when exact owner admission rejects', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('schema-call', 'get_sql_schema', {}),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let blockPublication = false;
		const originalSendRequest = model.sendRequest.getMockImplementation()!;
		model.sendRequest.mockImplementation(async (...args: any[]) => {
			const response = await originalSendRequest(...args);
			blockPublication = true;
			return response;
		});
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect schema.', currentQuery: 'SELECT 1', enabledTools: ['get_sql_schema'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: ['SecretTable'], columnsByTable: {} } })),
		} as any, undefined);

		expect(hostMessagesOfType(host, 'copilotWriteQueryToolResult')).toEqual([]);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('SecretTable');
	});

	it('does not publish or retain a SQL tool result when canonical admission rejects at publication', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('execute-call', 'execute_sql_query', { query: 'SELECT Secret FROM T' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let blockPublication = false;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		host.refreshSqlConnectionsData = vi.fn(async () => undefined);
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.resolve({ columns: [{ name: 'Secret' }], rows: [['SECRET_A']], metadata: {} })
					.then(result => { blockPublication = true; return result; }),
				cancel: vi.fn(),
			})),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(host.refreshSqlConnectionsData).toHaveBeenCalledOnce();
		expect(host.supersedeSqlRunAdmission).toHaveBeenCalledWith('sql-source', { notifyWebview: true });
		expect(host.startSqlRunUnderAdmission).toHaveBeenCalledWith(
			'sql-source', 1, expect.any(Function), expect.stringMatching(/^sql-copilot-/),
		);
		expect(hostMessagesOfType(host, 'copilotExecutedQuery')).toEqual([]);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('SECRET_A');
	});

	it.each([
		['false', () => false],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('cancels exploratory SQL and withholds its result when required delivery is %s', async (_label, delivery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_sql_query', { query: 'SELECT Secret FROM T' })],
			[new vscode.LanguageModelTextPart('MUST_NOT_USE_HIDDEN_SQL_RESULT')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'copilotExecutedQuery' ? delivery() : true);
		const cancel = vi.fn();
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.resolve({ columns: [{ name: 'Secret' }], rows: [['SECRET_A']], metadata: {} }),
				cancel,
			})),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(cancel).toHaveBeenCalledOnce();
		expect(model.sendRequest).toHaveBeenCalledOnce();
		const history = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || []);
		expect(history).not.toMatch(/SECRET_A|MUST_NOT_USE_HIDDEN_SQL_RESULT/);
	});

	it.each([
		['false', () => false],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('cancels exploratory SQL and withholds its error when required delivery is %s', async (_label, delivery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_sql_query', { query: 'SELECT Secret FROM T' })],
			[new vscode.LanguageModelTextPart('MUST_NOT_USE_HIDDEN_SQL_ERROR')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'copilotExecutedQuery' ? delivery() : true);
		const cancel = vi.fn();
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({ promise: Promise.reject(new Error('SECRET_SQL_ERROR')), cancel })),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(cancel).toHaveBeenCalledOnce();
		expect(model.sendRequest).toHaveBeenCalledOnce();
		const history = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || []);
		expect(history).not.toMatch(/SECRET_SQL_ERROR|MUST_NOT_USE_HIDDEN_SQL_ERROR/);
	});

	it.each([
		['result', () => Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} })],
		['error', () => Promise.reject(new Error('query failed'))],
	] as const)('owner-tokens exploratory SQL %s payloads', async (_label, createPromise) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart(
				'execute-call', 'execute_sql_query', { query: 'SELECT 1 AS Value' },
			)],
			[new vscode.LanguageModelTextPart('Done.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
			sqlOwnerToken: 'owner-token',
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, { executeQueryCancelable: vi.fn(() => ({ promise: createPromise(), cancel: vi.fn() })) } as any);

		expect(hostMessagesOfType(host, 'copilotExecutedQuery')).toEqual([
			expect.objectContaining({ boxId: 'sql-source', ownerToken: 'owner-token' }),
		]);
	});

	it('does not start exploratory SQL when its atomic admission was superseded', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('execute-call', 'execute_sql_query', { query: 'UPDATE Sensitive SET Value = 1' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.startSqlRunUnderAdmission = vi.fn(() => { throw new Error('SQL Copilot write-query canceled'); });
		const sqlClient = { executeQueryCancelable: vi.fn() } as any;
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(host.startSqlRunUnderAdmission).toHaveBeenCalledOnce();
		expect(sqlClient.executeQueryCancelable).not.toHaveBeenCalled();
	});

	it('does not publish or retain SQL execution errors after exact owner admission is revoked', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('execute-call', 'execute_sql_query', { query: 'SELECT Secret FROM T' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let blockPublication = false;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.reject(new Error('SECRET_SQL_ERROR')).catch(error => { blockPublication = true; throw error; }),
				cancel: vi.fn(),
			})),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(JSON.stringify(hostMessagesOfType(host, 'copilotExecutedQuery'))).not.toContain('SECRET_SQL_ERROR');
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('SECRET_SQL_ERROR');
	});

	it('does not publish or retain an exploratory SQL error after a newer run wins admission', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('execute-call', 'execute_sql_query', { query: 'SELECT Secret FROM T' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let admissionCurrent = true;
		host.isSqlRunAdmissionCurrent = vi.fn(() => admissionCurrent);
		const pending = deferred<any>();
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() })),
		} as any;
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Inspect data.', currentQuery: 'SELECT 1', enabledTools: ['execute_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(sqlClient.executeQueryCancelable).toHaveBeenCalledOnce());
		admissionCurrent = false;
		pending.reject(new Error('STALE_EXPLORATORY_ERROR'));
		await request;

		expect(JSON.stringify(hostMessagesOfType(host, 'copilotExecutedQuery'))).not.toContain('STALE_EXPLORATORY_ERROR');
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('STALE_EXPLORATORY_ERROR');
	});

	it('does not publish or retain a SQL auto-run result when canonical admission rejects at publication', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('final-call', 'respond_to_sql_query', { query: 'SELECT Secret FROM T' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let blockPublication = false;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		host.refreshSqlConnectionsData = vi.fn(async () => undefined);
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.resolve({ columns: [{ name: 'Secret' }], rows: [['SECRET_A']], metadata: {} })
					.then(result => { blockPublication = true; return result; }),
				cancel: vi.fn(),
			})),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write and run a query.', currentQuery: 'SELECT 1', enabledTools: ['respond_to_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(host.refreshSqlConnectionsData).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'queryResult')).toEqual([]);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('Query ran successfully');
	});

	it('refreshes SQL principal ownership before publishing a successful auto-run result', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('final-call', 'respond_to_sql_query', { query: 'SELECT 1 AS Value' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.refreshSqlConnectionsData = vi.fn(async () => undefined);
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }),
				cancel: vi.fn(),
			})),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write and run a query.', currentQuery: 'SELECT 1', enabledTools: ['respond_to_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(host.refreshSqlConnectionsData).toHaveBeenCalledOnce();
		expect(host.supersedeSqlRunAdmission).toHaveBeenCalledWith('sql-source', { notifyWebview: true });
		expect(hostMessagesOfType(host, 'queryResult')).toEqual([expect.objectContaining({ boxId: 'sql-source' })]);
	});

	it.each([
		['false', () => false],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('does not retain SQL auto-run success when required result delivery is %s', async (_label, delivery) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('final-call', 'respond_to_sql_query', { query: 'SELECT 1 AS Value' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		(host.postMessage as any).mockImplementation((message: any) => message?.type === 'queryResult' ? delivery() : true);
		host.refreshSqlConnectionsData = vi.fn(async () => undefined);
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const cancel = vi.fn();
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }), cancel,
			})),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write and run a query.', currentQuery: 'SELECT 1', enabledTools: ['respond_to_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(cancel).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ ok: true }));
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || []))
			.not.toContain('Query ran successfully.');
	});

	it('does not publish or retain a Copilot result after a newer SQL admission wins', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('final-call', 'respond_to_sql_query', { query: 'SELECT Secret FROM T' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let admissionCurrent = true;
		host.isSqlRunAdmissionCurrent = vi.fn(() => admissionCurrent);
		const pending = deferred<any>();
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({ promise: pending.promise, cancel: vi.fn() })),
		} as any;
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write and run a query.', currentQuery: 'SELECT 1', enabledTools: ['respond_to_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(sqlClient.executeQueryCancelable).toHaveBeenCalledOnce());
		admissionCurrent = false;
		pending.resolve({ columns: [{ name: 'Secret' }], rows: [['SECRET_A']], metadata: {} });
		await request;

		expect(hostMessagesOfType(host, 'queryResult')).toEqual([]);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('SECRET_A');
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('Query ran successfully');
	});

	it('does not clear or box-cancel a newer manual SQL run when Copilot Stop arrives late', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('final-call', 'respond_to_sql_query', { query: 'SELECT 1 AS OldValue' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let admissionCurrent = true;
		host.isSqlRunAdmissionCurrent = vi.fn(() => admissionCurrent);
		const pending = deferred<any>();
		const transportCancel = vi.fn(() => pending.reject({ isCancelled: true }));
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({ promise: pending.promise, cancel: transportCancel })),
		} as any;
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write and run a query.', currentQuery: 'SELECT 1', enabledTools: ['respond_to_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(sqlClient.executeQueryCancelable).toHaveBeenCalledOnce());
		admissionCurrent = false;
		(host.cancelRunningQuery as any).mockClear();
		service.cancelCopilotWriteQuery('sql-source');
		await request;

		expect(transportCancel).toHaveBeenCalledOnce();
		expect(host.cancelRunningQuery).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'copilotWriteQueryExecuting'))
			.not.toContainEqual(expect.objectContaining({ executing: false }));
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual(expect.objectContaining({
			boxId: 'sql-source', ok: false, message: 'Canceled.',
		}));
	});

	it('does not publish final SQL error or retry state when canceled during composite publication', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('final-call', 'respond_to_sql_query', { query: 'SELECT Secret FROM T' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let admissionCurrent = true;
		host.isSqlRunAdmissionCurrent = vi.fn(() => admissionCurrent);
		const publication = deferred<void>();
		let publicationCalls = 0;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			publicationCalls += 1;
			if (publicationCalls === 4) await publication.promise;
			return await dispatch();
		});
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({ promise: Promise.reject(new Error('FINAL_SECRET_ERROR')), cancel: vi.fn() })),
		} as any;
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Write and run a query.', currentQuery: 'SELECT 1', enabledTools: ['respond_to_sql_query'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(publicationCalls).toBeGreaterThanOrEqual(4));
		admissionCurrent = false;
		publication.resolve();
		await request;

		expect(JSON.stringify(hostMessagesOfType(host, 'queryError'))).not.toContain('Query failed to execute.');
		expect(JSON.stringify(hostMessagesOfType(host, 'copilotWriteQueryStatus'))).not.toContain('Retrying');
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('sql-source') || [])).not.toContain('FINAL_SECRET_ERROR');
		expect(JSON.stringify((host.output.error as any).mock.calls)).not.toContain('FINAL_SECRET_ERROR');
	});

	it('rejects an in-flight SQL comparison result when final owner admission becomes protected', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call',
				'respond_to_query_performance_optimization_request',
				{ query: 'SELECT 2 AS Value' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		let ownerAssertions = 0;
		host.ensureComparisonBoxInWebview = vi.fn(async () => 'query_cmp_sql');
		host.assertSqlResultOwnerAllowed = vi.fn(async (boxId: string) => {
			ownerAssertions++;
			if (boxId === 'query_cmp_sql') throw new Error('Leave No Trace blocked');
		});
		const sqlConnection = {
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		};
		const sqlConnectionManager = { getConnection: vi.fn(() => sqlConnection) } as any;
		const sqlSchemaService = { getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })) } as any;
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({
				promise: Promise.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} }),
				cancel: vi.fn(),
			})),
		} as any;
		const service = new CopilotService(host);

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql_source',
			sqlConnectionId: 'sql-a',
			database: 'Db',
			request: 'Optimize this query.',
			currentQuery: 'SELECT 1 AS Value',
			enabledTools: ['respond_to_query_performance_optimization_request'],
		}, sqlConnectionManager, sqlSchemaService, sqlClient);

		const resultMessages = hostMessagesOfType(host, 'queryResult');
		expect(resultMessages).toEqual([
			expect.objectContaining({ boxId: 'sql_source' }),
		]);
		expect(resultMessages.some(message => message.boxId === 'query_cmp_sql')).toBe(false);
		expect(ownerAssertions).toBeGreaterThanOrEqual(2);
		expect(host.assertSqlResultOwnerAllowed).toHaveBeenCalledWith('query_cmp_sql', {
			connectionId: 'sql-a', database: 'Db', generation: 1,
			targetSignature: 'target-a', principalFingerprint: 'principal-a', revocationGeneration: 0,
		});
		expect(host.supersedeSqlRunAdmission).toHaveBeenCalledWith('sql_source', { notifyWebview: true });
		expect(host.supersedeSqlRunAdmission).toHaveBeenCalledWith('query_cmp_sql', { notifyWebview: true });
		expect(host.startSqlRunUnderAdmission).toHaveBeenCalledTimes(1);
		expect((host.startSqlRunUnderAdmission as any).mock.calls.every((call: any[]) => /^sql-copilot-/.test(call[3]))).toBe(true);
	});

	it('does not launch either comparison query when ownership changes during editor preparation', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call',
				'respond_to_query_performance_optimization_request',
				{ query: 'SELECT 2 AS Value' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const comparison = deferred<string>();
		let ownerCurrent = true;
		host.ensureComparisonBoxInWebview = vi.fn(() => comparison.promise);
		host.assertSqlResultOwnerAllowed = vi.fn(async () => {
			if (!ownerCurrent) throw new Error('SQL result owner changed before response admission.');
		});
		const sqlConnection = {
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		};
		const sqlClient = { executeQueryCancelable: vi.fn() } as any;
		const service = new CopilotService(host);

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql_source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Optimize this query.', currentQuery: 'SELECT 1 AS Value',
			enabledTools: ['respond_to_query_performance_optimization_request'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(host.ensureComparisonBoxInWebview).toHaveBeenCalledOnce());
		ownerCurrent = false;
		comparison.resolve('query_cmp_sql');
		await request;

		expect(sqlClient.executeQueryCancelable).not.toHaveBeenCalled();
	});

	it('cancels the real comparison execution handle without canceling source work', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call',
				'respond_to_query_performance_optimization_request',
				{ query: 'SELECT 2 AS Value' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.ensureComparisonBoxInWebview = vi.fn(async () => 'query_cmp_sql');
		const sourceCancel = vi.fn();
		let rejectComparison!: (error: Error) => void;
		const comparisonPromise = new Promise<any>((_resolve, reject) => { rejectComparison = reject; });
		const comparisonCancel = vi.fn(() => {
			const error = new Error('Canceled');
			(error as any).isCancelled = true;
			rejectComparison(error);
		});
		let executionCount = 0;
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => {
				executionCount++;
				if (executionCount === 1) {
					return {
						promise: Promise.resolve({ columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {} }),
						cancel: sourceCancel,
					};
				}
				return { promise: comparisonPromise, cancel: comparisonCancel };
			}),
		} as any;
		const service = new CopilotService(host);
		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql_source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Optimize this query.', currentQuery: 'SELECT 1 AS Value',
			enabledTools: ['respond_to_query_performance_optimization_request'],
		}, { getConnection: vi.fn(() => ({
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		})) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(sqlClient.executeQueryCancelable).toHaveBeenCalledTimes(2));
		const sequence = (service as any).runningCopilotWriteQueryByBoxId.get('sql_source').seq;

		service.cancelCopilotQueryTarget('sql_source', 'query_cmp_sql', sequence);
		await request;

		expect(comparisonCancel).toHaveBeenCalledOnce();
		expect(sourceCancel).not.toHaveBeenCalled();
		expect(host.cancelRunningQuery).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'queryResult').some(message => message.boxId === 'query_cmp_sql')).toBe(false);
		expect(host.startSqlRunUnderAdmission).toHaveBeenCalledTimes(2);
		expect((host.startSqlRunUnderAdmission as any).mock.calls.map((call: any[]) => call[0])).toEqual(['sql_source', 'query_cmp_sql']);
		expect((host.startSqlRunUnderAdmission as any).mock.calls.every((call: any[]) => /^sql-copilot-/.test(call[3]))).toBe(true);
	});

	it.each([
		['source', 'sql_source', 'Original query failed to execute.'],
		['optimized', 'query_cmp_sql', 'Optimized query failed to execute.'],
	] as const)('does not publish a stale %s comparison error after newer admission', async (_label, staleBoxId, staleMessage) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'SELECT 2 AS Value' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.ensureComparisonBoxInWebview = vi.fn(async () => 'query_cmp_sql');
		const currentByBox: Record<string, boolean> = { sql_source: true, query_cmp_sql: true };
		host.isSqlRunAdmissionCurrent = vi.fn((boxId: string) => currentByBox[boxId] !== false);
		const pending = deferred<any>();
		let executionCount = 0;
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => {
				executionCount += 1;
				const isStaleExecution = staleBoxId === 'sql_source' ? executionCount === 1 : executionCount === 2;
				return {
					promise: isStaleExecution
						? pending.promise
						: Promise.resolve({ columns: [{ name: 'Value' }], rows: [[1]], metadata: {} }),
					cancel: vi.fn(),
				};
			}),
		} as any;
		const service = new CopilotService(host);

		const request = service.startSqlCopilotWriteQuery({
			boxId: 'sql_source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Optimize this query.', currentQuery: 'SELECT 1 AS Value',
			enabledTools: ['respond_to_query_performance_optimization_request'],
		}, { getConnection: vi.fn(() => ({
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		})) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);
		await vi.waitFor(() => expect(sqlClient.executeQueryCancelable).toHaveBeenCalledTimes(staleBoxId === 'sql_source' ? 1 : 2));
		currentByBox[staleBoxId] = false;
		pending.reject(new Error(`STALE_${staleBoxId}`));
		await request;

		expect(hostMessagesOfType(host, 'queryError')).not.toContainEqual(expect.objectContaining({
			boxId: staleBoxId, error: staleMessage,
		}));
	});

	it('does not publish comparison completion after exact owner admission is revoked', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart('opt-call', 'respond_to_query_performance_optimization_request', { query: 'SELECT 2 AS Value' }),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.ensureComparisonBoxInWebview = vi.fn(async () => 'query_cmp_sql');
		let executionCount = 0;
		let blockPublication = false;
		host.dispatchSqlResultOwnerAllowed = vi.fn(async (_boxId: string, _owner: unknown, dispatch: () => unknown) => {
			if (blockPublication) throw new SqlLeaveNoTraceBlockedError();
			return await dispatch();
		});
		const service = new CopilotService(host);
		const sqlConnection = { id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad' };
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => {
				executionCount++;
				const result = Promise.resolve({ columns: [{ name: 'Value' }], rows: [[executionCount]], metadata: {} });
				return {
					promise: executionCount === 2 ? result.then(value => { blockPublication = true; return value; }) : result,
					cancel: vi.fn(),
				};
			}),
		} as any;

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql-source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Optimize.', currentQuery: 'SELECT 1 AS Value',
			enabledTools: ['respond_to_query_performance_optimization_request'],
		}, { getConnection: vi.fn(() => sqlConnection) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).not.toContainEqual(expect.objectContaining({ ok: true, message: expect.stringContaining('Comparison ready') }));
	});

	it.each([
		['false', () => false],
		['undefined', () => undefined],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('cancels SQL comparison transport when required begin delivery is %s', async (_label, delivery) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'SELECT 2 AS Value' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.ensureComparisonBoxInWebview = vi.fn(async () => 'query_cmp_sql');
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'copilotWriteQueryExecuting' && message.executing === true ? delivery() : true);
		const pending = deferred<any>();
		const cancel = vi.fn(() => pending.reject(Object.assign(new Error('cancelled'), { isCancelled: true })));
		const sqlClient = {
			executeQueryCancelable: vi.fn(() => ({ promise: pending.promise, cancel })),
		} as any;
		const service = new CopilotService(host);

		await service.startSqlCopilotWriteQuery({
			boxId: 'sql_source', sqlConnectionId: 'sql-a', database: 'Db',
			request: 'Optimize.', currentQuery: 'SELECT 1 AS Value',
			enabledTools: ['respond_to_query_performance_optimization_request'],
		}, { getConnection: vi.fn(() => ({
			id: 'sql-a', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		})) } as any, {
			getSchema: vi.fn(async () => ({ schema: { tables: [], columnsByTable: {} } })),
		} as any, sqlClient);

		expect(cancel).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'queryResult')).toHaveLength(0);
	});

	it('adopts the first established Copilot owner and cancels a later rotation', () => {
		const host = createHost([]);
		const service = new CopilotService(host);
		let producingPartition = 'partition-a';
		const cancel = vi.fn();
		const cts = { cancel: vi.fn() };
		(service as any).copilotConversationOwnerByBoxId.set('box-a', { flavor: 'kusto', connectionId: 'conn-a' });
		(service as any).copilotConversationHistoryByBoxId.set('box-a', [{ type: 'user-message', id: 'a', text: 'secret-a' }]);
		(service as any).runningCopilotWriteQueryByBoxId.set('box-a', {
			cts, seq: 1, queryCancels: new Set([cancel]), kustoAccountPartitionGetters: new Set([() => producingPartition]),
		});

		service.invalidateKustoConnections(['conn-a'], { preserveEstablishingAccountPartition: 'partition-a' });
		expect((service as any).copilotConversationOwnerByBoxId.get('box-a').accountPartition).toBe('partition-a');
		expect(cancel).not.toHaveBeenCalled();

		producingPartition = 'partition-b';
		service.invalidateKustoConnections(['conn-a'], { preserveEstablishingAccountPartition: 'partition-b' });
		expect(cancel).toHaveBeenCalledOnce();
		expect(cts.cancel).toHaveBeenCalledOnce();
		expect((service as any).copilotConversationHistoryByBoxId.has('box-a')).toBe(false);
	});
	beforeEach(() => {
		vscodeMocks.selectChatModels.mockReset();
	});

	it('executes final function-definition responses as inline function invocations instead of raw control commands', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineFilterRowsQuery(setQueryMessages[0].query);
	});

	it.each([
		['line comment before .create function', '// generated helper\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['block comment before .create-or-alter function', '/* generated helper */\n.create-or-alter function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['multiline block comment before .create function', '/*\n generated helper\n*/\n\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['with clause before .create-or-alter function', '.create-or-alter function with (folder="Helpers", docstring="Filter helper") FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['ifnotexists before .create function', '.create function ifnotexists FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['.alter function', '.alter function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['comment before .alter function', '// generated helper\n.alter function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['fenced Kusto code block', '```kusto\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)\n```'],
	])('executes final function-definition responses with %s as inline invocations', async (_label, functionQuery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineFilterRowsQuery(setQueryMessages[0].query);
	});

	it.each([
		['line commented .create', '// .create function Fake() { print fake=1 }\nprint x=1'],
		['block commented .create-or-alter', '/* .create-or-alter function Fake() { print fake=1 } */\nprint x=1'],
		['multiline block commented .alter', '/*\n.alter function Fake() { print fake=1 }\n*/\nprint x=1'],
	])('does not convert commented-out function definitions in final Copilot responses: %s', async (_label, functionQuery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectPlainCommentedFakeFunctionQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectPlainCommentedFakeFunctionQuery(setQueryMessages[0].query);
	});

	it('stores inline final-response queries in Copilot conversation history', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const service = new CopilotService(createHost(capturedQueries));

		await service.startCopilotWriteQuery(startMessage());

		const queries = historyToolQueries(service);
		expect(queries).toHaveLength(1);
		expectInlineFilterRowsQuery(queries[0]);
	});

	it('converts multiple final-response function definitions before invoking the second function', async () => {
		const functionQuery = '.create function FirstRows() { range x from 1 to 3 step 1 }\n.create function SecondRows() { range y from 4 to 6 step 1 }\nSecondRows() | take 5';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineTwoFunctionQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineTwoFunctionQuery(setQueryMessages[0].query);
	});

	it('converts semicolon-separated final-response function definitions before invocation', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { let cutoff = 5; range x from 1 to 10 step 1 | where x > cutoff }; FilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineSemicolonInvocationQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineSemicolonInvocationQuery(setQueryMessages[0].query);
	});

	it('does not convert metadata-only alter function final responses', async () => {
		const functionQuery = '.alter function docstring FilterRows "new docs"\nprint x=1';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectMetadataAlterQueryUnconverted(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectMetadataAlterQueryUnconverted(setQueryMessages[0].query);
	});

	it('does not convert definition-only function final responses into inline queries', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expect(normalizeQueryText(capturedQueries[0])).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(capturedQueries[0])).not.toMatch(/\blet\s+FilterRows\s*=/i);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expect(normalizeQueryText(setQueryMessages[0].query)).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(setQueryMessages[0].query)).not.toMatch(/\blet\s+FilterRows\s*=/i);
	});

	it('strips leading comments from management-only final-response execution while preserving visible query text', async () => {
		const functionQuery = '  // generated helper\r\n\t.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\n// keep visible';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expect(capturedQueries[0]).toBe('.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\n// keep visible');
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expect(setQueryMessages[0].query).toBe(functionQuery.trim());
	});

	it('does not convert definition-only final responses with trailing comments into inline queries', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\n// helper comment';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expect(normalizeQueryText(capturedQueries[0])).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(capturedQueries[0])).not.toMatch(/\blet\s+FilterRows\s*=/i);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expect(normalizeQueryText(setQueryMessages[0].query)).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(setQueryMessages[0].query)).not.toMatch(/\blet\s+FilterRows\s*=/i);
	});

	it('does not convert metadata-only alter folder final responses', async () => {
		const functionQuery = '.alter function folder FilterRows "new/folder"\nprint x=1';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expectMetadataAlterQueryUnconverted(capturedQueries[0], '.alter function folder FilterRows "new/folder"');
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectMetadataAlterQueryUnconverted(setQueryMessages[0].query, '.alter function folder FilterRows "new/folder"');
	});

	it('keeps inline final-response query text visible and in history when execution fails', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries, new Error('synthetic final-response failure'));
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries.length).toBeGreaterThan(0);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages.length).toBeGreaterThan(0);
		expectInlineFilterRowsQuery(setQueryMessages[0].query);
		const queries = historyToolQueries(service);
		expect(queries.length).toBeGreaterThan(0);
		expectInlineFilterRowsQuery(queries[0]);
	});

	it('converts optimization comparison function definitions before preparing and executing comparison queries', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('opt-call', 'respond_to_query_performance_optimization_request', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const comparisonQueries: string[] = [];
		const host = createHostWithComparisonCapture(capturedQueries, comparisonQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery({
			...startMessage(),
			currentQuery: 'print source=1',
			request: 'Optimize this query.',
		});

		expect(comparisonQueries).toHaveLength(2);
		expectInlineFilterRowsQuery(comparisonQueries[0]);
		expect(capturedQueries.length).toBeGreaterThanOrEqual(2);
		expectInlineFilterRowsQuery(capturedQueries[capturedQueries.length - 1]);
	});

	it('waits for prior manual Kusto cancellation before starting an optimization source run', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'print optimized=1' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHostWithComparisonCapture([], []);
		const cancellationDelivery = deferred<void>();
		let reservationCalls = 0;
		host.reserveRunningQueryReplacement = vi.fn((boxId: string) => {
			reservationCalls++;
			return {
				cancel: vi.fn(), runSeq: reservationCalls,
				previousCancellationDelivery: reservationCalls === 1 ? cancellationDelivery.promise.then(() => {
				host.postMessage({ type: 'queryCancelled', boxId, executionId: 'manual-source' });
				return true;
				}) : Promise.resolve(true),
			};
		});
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery({
			...startMessage(), currentQuery: 'print source=1', request: 'Optimize this query.',
		});
		await vi.waitFor(() => expect(host.reserveRunningQueryReplacement).toHaveBeenCalledWith(
			'query_1', expect.stringMatching(/^kusto-comparison-/),
		));
		expect(host.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(host.promoteRunningQueryReservation).not.toHaveBeenCalled();

		cancellationDelivery.resolve();
		await request;

		const messages = vi.mocked(host.postMessage).mock.calls.map(call => call[0] as any);
		const cancellationIndex = messages.findIndex(message => message.type === 'queryCancelled' && message.executionId === 'manual-source');
		const beginIndex = messages.findIndex(message => message.type === 'copilotWriteQueryExecuting'
			&& message.boxId === 'query_1' && message.executing === true);
		expect(cancellationIndex).toBeGreaterThanOrEqual(0);
		expect(beginIndex).toBeGreaterThan(cancellationIndex);
	});

	it('abandons optimization when a newer manual run replaces its pending reservation', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'print optimized=1' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHostWithComparisonCapture([], []);
		const cancellationDelivery = deferred<boolean>();
		const reservationCancel = vi.fn();
		let reservationCurrent = true;
		host.reserveRunningQueryReplacement = vi.fn(() => ({
			cancel: reservationCancel, runSeq: 41, previousCancellationDelivery: cancellationDelivery.promise,
		}));
		host.isRunningQueryCurrent = vi.fn((_boxId, cancel, runSeq) =>
			reservationCurrent && cancel === reservationCancel && runSeq === 41);
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery({
			...startMessage(), currentQuery: 'print source=1', request: 'Optimize this query.',
		});
		await vi.waitFor(() => expect(host.reserveRunningQueryReplacement).toHaveBeenCalledOnce());
		reservationCurrent = false;
		cancellationDelivery.resolve(true);
		await request;

		expect(host.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(host.promoteRunningQueryReservation).not.toHaveBeenCalled();
		expect(host.unregisterRunningQuery).toHaveBeenCalledWith('query_1', reservationCancel, 41);
	});

	it.each([
		['false', () => false],
		['undefined', () => undefined],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('cancels Kusto comparison transport when required begin delivery is %s', async (_label, delivery) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'print optimized=1' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHostWithComparisonCapture([], []);
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'copilotWriteQueryExecuting' && message.executing === true ? delivery() : true);
		const pending = deferred<any>();
		const cancel = vi.fn(() => pending.reject(Object.assign(new Error('cancelled'), { isCancelled: true })));
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: pending.promise, cancel, clientActivityId: 'KW.execute_query;begin-failure',
			getAccountPartition: () => 'partition-current',
		});
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery({
			...startMessage(), currentQuery: 'print source=1', request: 'Optimize this query.',
		});

		expect(cancel).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'queryResult')).toHaveLength(0);
	});

	it('does not report comparison success when Stop arrives during optimized-query refresh', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'print optimized=1' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHostWithComparisonCapture([], []);
		const optimizedRefresh = deferred<void>();
		let refreshCalls = 0;
		host.refreshConnectionsData = vi.fn(async () => {
			refreshCalls++;
			if (refreshCalls === 2) await optimizedRefresh.promise;
		});
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery({
			...startMessage(), currentQuery: 'print source=1', request: 'Optimize this query.',
		});
		await vi.waitFor(() => expect(host.refreshConnectionsData).toHaveBeenCalledTimes(2));
		service.cancelCopilotWriteQuery('query_1');
		optimizedRefresh.resolve();
		await request;

		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ ok: true, message: expect.stringContaining('Optimized query') }));
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []))
			.not.toContain('Comparison ready');
	});

	it.each([
		['source', 'query_1', 1],
		['comparison', 'comparison', 2],
	] as const)('does not publish a stale %s Kusto comparison result after manual takeover', async (_label, staleBoxId, staleRefreshCall) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'opt-call', 'respond_to_query_performance_optimization_request', { query: 'print optimized=1' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHostWithComparisonCapture([], []);
		const refreshGate = deferred<void>();
		let refreshCalls = 0;
		let staleRun = false;
		host.refreshConnectionsData = vi.fn(async () => {
			refreshCalls++;
			if (refreshCalls === staleRefreshCall) await refreshGate.promise;
		});
		host.isRunningQueryCurrent = vi.fn((boxId: string) => !(staleRun && boxId === staleBoxId));
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery({
			...startMessage(), currentQuery: 'print source=1', request: 'Optimize this query.',
		});
		await vi.waitFor(() => expect(host.refreshConnectionsData).toHaveBeenCalledTimes(staleRefreshCall));
		staleRun = true;
		refreshGate.resolve();
		await request;

		expect(hostMessagesOfType(host, 'queryResult'))
			.not.toContainEqual(expect.objectContaining({ boxId: staleBoxId }));
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ ok: true, message: expect.stringContaining('Optimized query') }));
		expect(host.promoteRunningQueryReservation).toHaveBeenCalledWith(
			staleBoxId, expect.any(Function), expect.any(Number), expect.any(Function), expect.any(String),
			expect.stringMatching(/^kusto-comparison-/),
		);
		expect(host.unregisterRunningQuery).toHaveBeenCalledWith(
			staleBoxId, expect.any(Function), expect.any(Number),
		);
	});

	it('strips leading comments from raw control commands in optimization comparison execution', async () => {
		const candidateQuery = '// optimized metadata\n.show tables';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('opt-call', 'respond_to_query_performance_optimization_request', { query: candidateQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const comparisonQueries: string[] = [];
		const host = createHostWithComparisonCapture(capturedQueries, comparisonQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery({
			...startMessage(),
			currentQuery: '// source metadata\n.show databases',
			request: 'Optimize this query.',
		});

		expect(comparisonQueries).toHaveLength(2);
		expect(comparisonQueries[0]).toBe(candidateQuery);
		expect(capturedQueries).toContain('.show databases');
		expect(capturedQueries).toContain('.show tables');
		expect(capturedQueries).not.toContain('// source metadata\n.show databases');
		expect(capturedQueries).not.toContain(candidateQuery);
	});

	it('logs stripped execution payloads while formatting original errors for optimization comparison failures', async () => {
		const sourceError = new Error('synthetic source failure');
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('opt-call', 'respond_to_query_performance_optimization_request', { query: '// optimized metadata\n.show tables' })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHostWithQueryErrors(capturedQueries, { '.show databases': sourceError });
		const comparisonQueries: string[] = [];
		host.ensureComparisonBoxInWebview = vi.fn((_sourceBoxId: string, query: string) => {
			comparisonQueries.push(query);
			return Promise.resolve('comparison');
		});
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery({
			...startMessage(),
			currentQuery: '// source metadata\n.show databases',
			request: 'Optimize this query.',
		});

		expect(capturedQueries).toEqual(['.show databases']);
		expect(host.logQueryExecutionError).toHaveBeenCalledWith(sourceError, TEST_CONNECTION, 'Samples', 'query_1', '.show databases');
		expect(host.formatQueryExecutionErrorForUser).toHaveBeenCalledWith(sourceError, TEST_CONNECTION, 'Samples');
		expect(comparisonQueries).toHaveLength(1);
		expect(comparisonQueries[0]).toBe('// optimized metadata\n.show tables');
	});

	it('converts optimization source function definitions before running source comparison queries', async () => {
		const sourceQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const candidateQuery = '.create function FilterRows(threshold:long) { range x from 1 to 20 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('opt-call', 'respond_to_query_performance_optimization_request', { query: candidateQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const comparisonQueries: string[] = [];
		const host = createHostWithComparisonCapture(capturedQueries, comparisonQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery({
			...startMessage(),
			currentQuery: sourceQuery,
			request: 'Optimize this query.',
		});

		expect(capturedQueries.length).toBeGreaterThanOrEqual(2);
		expectInlineFilterRowsQueryWithRange(capturedQueries[0], 10);
		expectInlineFilterRowsQueryWithRange(capturedQueries[capturedQueries.length - 1], 20);
	});

	it('converts standalone optimize responses before posting optimizeQueryReady', async () => {
		const functionQuery = '```kusto\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)\n```';
		const model = createTextModel(functionQuery);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.optimizeQueryWithCopilot({
			type: 'optimizeQuery',
			boxId: 'query_1',
			query: 'print source=1',
			queryName: 'Source',
			connectionId: TEST_CONNECTION.id,
			database: 'Samples',
		});

		const readyMessages = hostMessagesOfType(host, 'optimizeQueryReady');
		expect(readyMessages).toHaveLength(1);
		expectInlineFilterRowsQuery(readyMessages[0].optimizedQuery);
	});

	it('does not dispatch standalone optimization after disposal during model selection', async () => {
		const modelSelection = deferred<any[]>();
		const model = createTextModel('print optimized=1');
		vscodeMocks.selectChatModels.mockReturnValue(modelSelection.promise);
		const host = createHost([]);
		const service = new CopilotService(host);

		const request = service.optimizeQueryWithCopilot({
			type: 'optimizeQuery', boxId: 'query_1', query: 'print source=1', queryName: 'Source',
			connectionId: TEST_CONNECTION.id, database: 'Samples',
		});
		await vi.waitFor(() => expect(vscodeMocks.selectChatModels).toHaveBeenCalledOnce());
		service.dispose();
		modelSelection.resolve([model]);
		await request;

		expect(model.sendRequest).not.toHaveBeenCalled();
		expect(hostMessagesOfType(host, 'optimizeQueryReady')).toHaveLength(0);
		expect(hostMessagesOfType(host, 'optimizeQueryError')).toHaveLength(0);
	});

	it('does not let an older standalone optimization remove or publish over a newer one', async () => {
		const firstResponse = deferred<any>();
		const secondResponse = deferred<any>();
		const model = createTextModel('') as any;
		model.sendRequest = vi.fn()
			.mockReturnValueOnce(firstResponse.promise)
			.mockReturnValueOnce(secondResponse.promise);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		const message = {
			type: 'optimizeQuery' as const, boxId: 'query_1', query: 'print source=1', queryName: 'Source',
			connectionId: TEST_CONNECTION.id, database: 'Samples',
		};

		const first = service.optimizeQueryWithCopilot(message);
		await vi.waitFor(() => expect(model.sendRequest).toHaveBeenCalledTimes(1));
		const second = service.optimizeQueryWithCopilot({ ...message, query: 'print source=2' });
		await vi.waitFor(() => expect(model.sendRequest).toHaveBeenCalledTimes(2));
		const secondOwner = (service as any).runningOptimizeByBoxId.get('query_1');

		firstResponse.resolve({ text: streamParts(['print stale=1']) });
		await first;
		expect((service as any).runningOptimizeByBoxId.get('query_1')).toBe(secondOwner);

		secondResponse.resolve({ text: streamParts(['print current=2']) });
		await second;
		expect(hostMessagesOfType(host, 'optimizeQueryReady')).toEqual([
			expect.objectContaining({ boxId: 'query_1', optimizedQuery: 'print current=2' }),
		]);
	});

	it.each([
		['line-commented fake', '// .create function Fake() { print fake=1 }\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['block-commented fake', '/* .create function Fake() { print fake=1 } */\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['multiline-block-commented fake', '/*\n.create function Fake() { print fake=1 }\n*/\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
	])('ignores %s functions before real final-response functions', async (_label, functionQuery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFakeThenRealQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineFakeThenRealQuery(setQueryMessages[0].query);
	});

	it('executes execute_kusto_query function definitions as inline function invocations instead of raw control commands', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineFilterRowsQuery(executedMessages[0].query);
	});

	it('does not publish or retain account A tool results after the snapshot adopts account B', async () => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: 'print marker="value"' })],
			[new vscode.LanguageModelTextPart('Done.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const snapshot = deferred<void>();
		let currentPartition = 'partition-a';
		(host.kustoClient.getAccountPartition as any).mockImplementation(() => currentPartition);
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: Promise.resolve({ columns: ['marker'], rows: [['SECRET_A']], metadata: {} }),
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;account-a',
			getAccountPartition: () => 'partition-a',
		});
		host.refreshConnectionsData = vi.fn(async () => snapshot.promise);
		const service = new CopilotService(host);

		const run = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.refreshConnectionsData).toHaveBeenCalled());
		currentPartition = 'partition-b';
		snapshot.resolve();
		await run;

		expect(hostMessagesOfType(host, 'copilotExecutedQuery')).toEqual([]);
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || [])).not.toContain('SECRET_A');
	});

	it('does not start Kusto transport after disposal during model selection', async () => {
		const models = deferred<any[]>();
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="late"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockReturnValue(models.promise);
		const host = createHost([]);
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(vscodeMocks.selectChatModels).toHaveBeenCalledOnce());
		service.dispose();
		models.resolve([model]);
		await request;

		expect(host.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(host.registerRunningQuery).not.toHaveBeenCalled();
	});

	it('does not publish a final Copilot result superseded during connection refresh', async () => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: 'print marker="stale"' })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const snapshot = deferred<void>();
		let runIsCurrent = true;
		host.refreshConnectionsData = vi.fn(async () => snapshot.promise);
		host.isRunningQueryCurrent = vi.fn(() => runIsCurrent);
		const service = new CopilotService(host);

		const run = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.refreshConnectionsData).toHaveBeenCalled());
		runIsCurrent = false;
		snapshot.resolve();
		await run;

		expect(hostMessagesOfType(host, 'queryResult')).toEqual([]);
		expect(hostMessagesOfType(host, 'ensureResultsVisible')).toEqual([]);
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toEqual([
			{ type: 'copilotWriteQueryDone', boxId: 'query_1', ok: false, message: '' },
		]);
		expect(hostMessagesOfType(host, 'copilotWriteQueryExecuting'))
			.not.toContainEqual(expect.objectContaining({ executing: false }));
		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).not.toContain('Query ran successfully.');
		expect(historyText).not.toContain('not processed');
		expect(historyText).not.toContain('final-call');
	});

	it('waits for prior manual Kusto cancellation before starting a final run', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="copilot"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const cancellationDelivery = deferred<void>();
		host.reserveRunningQueryReplacement = vi.fn((boxId: string) => ({
			cancel: vi.fn(), runSeq: 1,
			previousCancellationDelivery: cancellationDelivery.promise.then(() => {
				host.postMessage({ type: 'queryCancelled', boxId, executionId: 'manual-final' });
				return true;
			}),
		}));
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.reserveRunningQueryReplacement).toHaveBeenCalledWith(
			'query_1', expect.stringMatching(/^kusto-copilot-/),
		));
		expect(host.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(host.promoteRunningQueryReservation).not.toHaveBeenCalled();

		cancellationDelivery.resolve();
		await request;

		const messages = vi.mocked(host.postMessage).mock.calls.map(call => call[0] as any);
		const cancellationIndex = messages.findIndex(message => message.type === 'queryCancelled' && message.executionId === 'manual-final');
		const beginIndex = messages.findIndex(message => message.type === 'copilotWriteQueryExecuting'
			&& message.boxId === 'query_1' && message.executing === true);
		expect(cancellationIndex).toBeGreaterThanOrEqual(0);
		expect(beginIndex).toBeGreaterThan(cancellationIndex);
	});

	it('abandons a final run when a newer manual run replaces its pending reservation', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="copilot"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const cancellationDelivery = deferred<boolean>();
		const reservationCancel = vi.fn();
		let reservationCurrent = true;
		host.reserveRunningQueryReplacement = vi.fn(() => ({
			cancel: reservationCancel, runSeq: 42, previousCancellationDelivery: cancellationDelivery.promise,
		}));
		host.isRunningQueryCurrent = vi.fn((_boxId, cancel, runSeq) =>
			reservationCurrent && cancel === reservationCancel && runSeq === 42);
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.reserveRunningQueryReplacement).toHaveBeenCalledOnce());
		reservationCurrent = false;
		cancellationDelivery.resolve(true);
		await request;

		expect(host.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(host.promoteRunningQueryReservation).not.toHaveBeenCalled();
		expect(host.unregisterRunningQuery).toHaveBeenCalledWith('query_1', reservationCancel, 42);
	});

	it('Stop interrupts a pending Kusto cancellation delivery and retires its reservation', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="copilot"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const reservationCancel = vi.fn();
		host.reserveRunningQueryReplacement = vi.fn(() => ({
			cancel: reservationCancel,
			runSeq: 77,
			previousCancellationDelivery: new Promise<boolean>(() => undefined),
		}));
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.reserveRunningQueryReplacement).toHaveBeenCalledOnce());
		service.cancelCopilotWriteQuery('query_1');
		await Promise.race([
			request,
			new Promise<void>((_resolve, reject) => setTimeout(() => reject(new Error('Stop did not settle reservation wait')), 250)),
		]);

		expect(host.kustoClient.executeQueryCancelable).not.toHaveBeenCalled();
		expect(host.unregisterRunningQuery).toHaveBeenCalledWith('query_1', reservationCancel, 77);
	});

	it.each([
		['false', () => false],
		['undefined', () => undefined],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('cancels final Kusto transport when required begin delivery is %s', async (_label, delivery) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="copilot"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'copilotWriteQueryExecuting' && message.executing === true ? delivery() : true);
		const pending = deferred<any>();
		const cancel = vi.fn(() => pending.reject(Object.assign(new Error('cancelled'), { isCancelled: true })));
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: pending.promise, cancel, clientActivityId: 'KW.execute_query;begin-failure',
			getAccountPartition: () => 'partition-current',
		});
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(cancel).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'queryResult')).toHaveLength(0);
	});

	it.each([
		['false', () => false],
		['undefined', () => undefined],
		['rejected', () => Promise.reject(new Error('delivery rejected'))],
	] as const)('does not retain final Kusto success when required result delivery is %s', async (_label, delivery) => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="copilot"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'queryResult' ? delivery() : true);
		const cancel = vi.fn();
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: Promise.resolve({ columns: ['marker'], rows: [['copilot']], metadata: {} }),
			cancel,
			clientActivityId: 'KW.execute_query;result-delivery-failure',
			getAccountPartition: () => 'partition-current',
		});
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(cancel).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ ok: true }));
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []))
			.not.toContain('Query ran successfully.');
	});

	it('does not announce final Kusto success after manual takeover during result delivery', async () => {
		const model = createModel([[
			new vscode.LanguageModelToolCallPart(
				'final-call', 'respond_to_all_other_queries', { query: 'print marker="copilot"' },
			),
		]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const delivery = deferred<boolean>();
		let runIsCurrent = true;
		(host.postMessage as any).mockImplementation((message: any) =>
			message?.type === 'queryResult' ? delivery.promise : true);
		host.isRunningQueryCurrent = vi.fn(() => runIsCurrent);
		const service = new CopilotService(host);

		const request = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(hostMessagesOfType(host, 'queryResult')).toHaveLength(1));
		runIsCurrent = false;
		delivery.resolve(true);
		await request;

		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ ok: true }));
		expect(JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []))
			.not.toContain('Query ran successfully.');
	});

	it('settles without stale cancellation when a final Copilot query is superseded before rejection', async () => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: 'print marker="stale"' })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const execution = deferred<any>();
		let runIsCurrent = true;
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: execution.promise,
			cancel: vi.fn(),
			clientActivityId: 'KW.execute_query;superseded-cancel',
			getAccountPartition: () => 'partition-current',
		});
		host.isRunningQueryCurrent = vi.fn(() => runIsCurrent);
		const service = new CopilotService(host);

		const run = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.promoteRunningQueryReservation).toHaveBeenCalledOnce());
		runIsCurrent = false;
		execution.reject({ isCancelled: true });
		await run;

		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toEqual([
			{ type: 'copilotWriteQueryDone', boxId: 'query_1', ok: false, message: '' },
		]);
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ message: 'Canceled.' }));
		expect(hostMessagesOfType(host, 'copilotWriteQueryExecuting'))
			.not.toContainEqual(expect.objectContaining({ executing: false }));
		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).not.toContain('not processed');
		expect(historyText).not.toContain('final-call');
	});

	it('clears final-query execution UI when Copilot Stop cancels the owned run', async () => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: 'print marker="stop"' })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const execution = deferred<any>();
		const transportCancel = vi.fn(() => execution.reject({ isCancelled: true }));
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: execution.promise,
			cancel: transportCancel,
			clientActivityId: 'KW.execute_query;explicit-stop',
			getAccountPartition: () => 'partition-current',
		});
		const service = new CopilotService(host);

		const run = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.promoteRunningQueryReservation).toHaveBeenCalledOnce());
		service.cancelCopilotWriteQuery('query_1');
		await run;

		expect(transportCancel).toHaveBeenCalledOnce();
		const executionMessages = hostMessagesOfType(host, 'copilotWriteQueryExecuting');
		expect(executionMessages).toEqual([
			expect.objectContaining({
				type: 'copilotWriteQueryExecuting', boxId: 'query_1', executing: true,
				executionId: expect.stringMatching(/^kusto-copilot-/),
			}),
			expect.objectContaining({
				type: 'copilotWriteQueryExecuting', boxId: 'query_1', executing: false,
				executionId: expect.stringMatching(/^kusto-copilot-/),
			}),
		]);
		expect(executionMessages[1].executionId).toBe(executionMessages[0].executionId);
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual({
			type: 'copilotWriteQueryDone', boxId: 'query_1', ok: false, message: 'Canceled.',
		});
	});

	it('does not cancel or clear a newer manual Kusto run when Copilot Stop arrives late', async () => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: 'print marker="old"' })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const snapshot = deferred<void>();
		const transportCancel = vi.fn();
		let runIsCurrent = true;
		(host.kustoClient.executeQueryCancelable as any).mockReturnValue({
			promise: Promise.resolve({ columns: ['marker'], rows: [['old']], metadata: {} }),
			cancel: transportCancel,
			clientActivityId: 'KW.execute_query;late-stop',
			getAccountPartition: () => 'partition-current',
		});
		host.refreshConnectionsData = vi.fn(async () => snapshot.promise);
		host.isRunningQueryCurrent = vi.fn(() => runIsCurrent);
		const service = new CopilotService(host);

		const run = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.refreshConnectionsData).toHaveBeenCalledOnce());
		runIsCurrent = false;
		(host.cancelRunningQuery as any).mockClear();
		service.cancelCopilotWriteQuery('query_1');
		snapshot.resolve();
		await run;

		expect(host.cancelRunningQuery).not.toHaveBeenCalled();
		expect(transportCancel).toHaveBeenCalledOnce();
		expect(hostMessagesOfType(host, 'copilotWriteQueryExecuting'))
			.not.toContainEqual(expect.objectContaining({ executing: false }));
	});

	it('removes only the old unfinished tool turn when a newer Copilot request replaces it', async () => {
		const firstExecution = deferred<any>();
		let executionCount = 0;
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('old-final-call', 'respond_to_all_other_queries', { query: 'print marker="old"' })],
			[new vscode.LanguageModelTextPart('NEW_REQUEST_RESPONSE')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		(host.kustoClient.executeQueryCancelable as any).mockImplementation(() => {
			executionCount++;
			return {
				promise: firstExecution.promise,
				cancel: vi.fn(() => firstExecution.reject({ isCancelled: true })),
				clientActivityId: `KW.execute_query;overlap-${executionCount}`,
				getAccountPartition: () => 'partition-current',
			};
		});
		const service = new CopilotService(host);
		(service as any).copilotConversationHistoryByBoxId.set('query_1', [{
			type: 'assistant-message', id: 'stable-earlier', text: 'STABLE_EARLIER', toolCalls: [], timestamp: 1,
		}]);

		const firstRun = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.promoteRunningQueryReservation).toHaveBeenCalledOnce());
		const secondRun = service.startCopilotWriteQuery({
			...startMessage(), request: 'Second request', requireToolUse: false,
		});
		await Promise.all([firstRun, secondRun]);

		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).toContain('STABLE_EARLIER');
		expect(historyText).toContain('NEW_REQUEST_RESPONSE');
		expect(historyText).not.toContain('old-final-call');
		expect(historyText).not.toContain('not processed');
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual({
			type: 'copilotWriteQueryDone', boxId: 'query_1', ok: true, message: '',
		});
		expect(hostMessagesOfType(host, 'copilotWriteQueryDone'))
			.not.toContainEqual(expect.objectContaining({ message: 'Canceled.' }));
	});

	it('keeps a newer Copilot request when an old optional-query refresh resumes', async () => {
		const snapshot = deferred<void>();
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('old-execute-call', 'execute_kusto_query', { query: 'print marker="old"' })],
			[new vscode.LanguageModelTextPart('NEW_OPTIONAL_OVERLAP_RESPONSE')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		host.refreshConnectionsData = vi.fn(async () => snapshot.promise);
		const service = new CopilotService(host);
		const invalidate = vi.spyOn(service, 'invalidateKustoConnections');
		(service as any).copilotConversationHistoryByBoxId.set('query_1', [{
			type: 'assistant-message', id: 'stable-earlier', text: 'STABLE_OPTIONAL_EARLIER', toolCalls: [], timestamp: 1,
		}]);

		const firstRun = service.startCopilotWriteQuery(startMessage());
		await vi.waitFor(() => expect(host.refreshConnectionsData).toHaveBeenCalledOnce());
		const secondRun = service.startCopilotWriteQuery({
			...startMessage(), request: 'Second optional-overlap request', requireToolUse: false,
		});
		await vi.waitFor(() => expect(hostMessagesOfType(host, 'copilotWriteQueryDone')).toContainEqual({
			type: 'copilotWriteQueryDone', boxId: 'query_1', ok: true, message: '',
		}));
		snapshot.resolve();
		await Promise.all([firstRun, secondRun]);

		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).toContain('STABLE_OPTIONAL_EARLIER');
		expect(historyText).toContain('NEW_OPTIONAL_OVERLAP_RESPONSE');
		expect(historyText).not.toContain('old-execute-call');
		expect(historyText).not.toContain('not processed');
		expect(invalidate).not.toHaveBeenCalled();
	});

	it('does not append a replaced Kusto request after delayed model selection', async () => {
		const modelSelection = deferred<any[]>();
		const model = createModel([[new vscode.LanguageModelTextPart('NEW_PREFLIGHT_RESPONSE')]]);
		vscodeMocks.selectChatModels
			.mockReturnValueOnce(modelSelection.promise)
			.mockResolvedValueOnce([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		(service as any).copilotConversationHistoryByBoxId.set('query_1', [{
			type: 'assistant-message', id: 'stable-preflight', text: 'STABLE_PREFLIGHT', toolCalls: [], timestamp: 1,
		}]);

		const firstRun = service.startCopilotWriteQuery({ ...startMessage(), request: 'OLD_PREFLIGHT_REQUEST' });
		await vi.waitFor(() => expect(vscodeMocks.selectChatModels).toHaveBeenCalledOnce());
		const secondRun = service.startCopilotWriteQuery({
			...startMessage(), request: 'NEW_PREFLIGHT_REQUEST', requireToolUse: false,
		});
		modelSelection.resolve([model]);
		await Promise.all([firstRun, secondRun]);

		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).toContain('STABLE_PREFLIGHT');
		expect(historyText).toContain('NEW_PREFLIGHT_REQUEST');
		expect(historyText).toContain('NEW_PREFLIGHT_RESPONSE');
		expect(historyText).not.toContain('OLD_PREFLIGHT_REQUEST');
	});

	it('does not append delayed rules from a replaced Kusto request', async () => {
		const rules = deferred<{ content: string; filePath: string }>();
		const model = createModel([[new vscode.LanguageModelTextPart('NEW_RULES_RESPONSE')]]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		(service as any).readGeneralQueryRules = vi.fn()
			.mockReturnValueOnce(rules.promise)
			.mockResolvedValueOnce({ content: '', filePath: '' });

		const firstRun = service.startCopilotWriteQuery({ ...startMessage(), request: 'OLD_RULES_REQUEST' });
		await vi.waitFor(() => expect((service as any).readGeneralQueryRules).toHaveBeenCalledOnce());
		const secondRun = service.startCopilotWriteQuery({
			...startMessage(), request: 'NEW_RULES_REQUEST', requireToolUse: false,
		});
		rules.resolve({ content: 'STALE_RULES_CONTENT', filePath: 'stale-rules.md' });
		await Promise.all([firstRun, secondRun]);

		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).toContain('NEW_RULES_REQUEST');
		expect(historyText).toContain('NEW_RULES_RESPONSE');
		expect(historyText).not.toContain('OLD_RULES_REQUEST');
		expect(historyText).not.toContain('STALE_RULES_CONTENT');
		expect(hostMessagesOfType(host, 'copilotGeneralQueryRulesLoaded'))
			.not.toContainEqual(expect.objectContaining({ preview: 'STALE_RULES_CONTENT' }));
	});

	it('rolls back removed rules and dev-notes markers before the replacement request loads context', async () => {
		const firstModelRequest = deferred<any>();
		const model = {
			...createModel([]),
			sendRequest: vi.fn()
				.mockReturnValueOnce(firstModelRequest.promise)
				.mockResolvedValueOnce({ stream: streamParts([new vscode.LanguageModelTextPart('NEW_CONTEXT_RESPONSE')]) }),
		};
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		(service as any).readGeneralQueryRules = vi.fn(async () => ({ content: 'RULES_CONTEXT', filePath: 'rules.md' }));
		(service as any).getDevNotesContent = vi.fn(async () => 'DEV_NOTES_CONTEXT');

		const firstRun = service.startCopilotWriteQuery({ ...startMessage(), request: 'OLD_CONTEXT_REQUEST' });
		await vi.waitFor(() => expect(model.sendRequest).toHaveBeenCalledOnce());
		const secondRun = service.startCopilotWriteQuery({
			...startMessage(), request: 'NEW_CONTEXT_REQUEST', requireToolUse: false,
		});
		firstModelRequest.resolve({ stream: streamParts([]) });
		await Promise.all([firstRun, secondRun]);

		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect((service as any).readGeneralQueryRules).toHaveBeenCalledTimes(2);
		expect((service as any).getDevNotesContent).toHaveBeenCalledTimes(2);
		expect(historyText.match(/RULES_CONTEXT/g)).toHaveLength(1);
		expect(historyText.match(/DEV_NOTES_CONTEXT/g)).toHaveLength(1);
		expect(historyText).toContain('NEW_CONTEXT_REQUEST');
		expect(historyText).not.toContain('OLD_CONTEXT_REQUEST');
	});

	it('does not cache a canceled extended-schema lookup failure', async () => {
		const host = createHost([]);
		const diskRead = deferred<any>();
		host.getCachedSchemaFromDisk = vi.fn()
			.mockReturnValueOnce(diskRead.promise)
			.mockResolvedValueOnce({
				timestamp: Date.now(),
				schema: { tables: ['RealTable'], columnsByTable: {}, functions: [] },
			});
		const service = new CopilotService(host);
		const canceledToken = { isCancellationRequested: false } as any;
		const firstLookup = (service as any).getExtendedSchemaToolResult(
			TEST_CONNECTION, 'Samples', 'query_1', canceledToken,
		);
		canceledToken.isCancellationRequested = true;
		diskRead.resolve({
			timestamp: Date.now(),
			schema: { tables: ['StaleTable'], columnsByTable: {}, functions: [] },
		});

		await expect(firstLookup).rejects.toThrow('Copilot write-query canceled');
		const retry = await (service as any).getExtendedSchemaToolResult(
			TEST_CONNECTION, 'Samples', 'query_1', { isCancellationRequested: false },
		);

		expect(host.getCachedSchemaFromDisk).toHaveBeenCalledTimes(2);
		expect(retry.result).toContain('RealTable');
		expect(retry.result).not.toContain('Copilot write-query canceled');
	});

	it.each([
		['extended schema', 'get_extended_schema', 'getExtendedSchemaToolResult', { result: 'STALE_SCHEMA_RESULT', label: 'stale schema' }],
		['best practices', 'get_query_optimization_best_practices', 'readOptimizeQueryRules', 'STALE_BEST_PRACTICES'],
	] as const)('does not retain delayed %s output after request replacement', async (_label, toolName, methodName, staleResult) => {
		const delayedTool = deferred<any>();
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('old-optional-call', toolName, toolName === 'get_extended_schema' ? { database: 'Samples' } : {})],
			[new vscode.LanguageModelTextPart('NEW_OPTIONAL_TOOL_RESPONSE')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const host = createHost([]);
		const service = new CopilotService(host);
		(service as any)[methodName] = vi.fn(() => delayedTool.promise);
		(service as any).copilotConversationHistoryByBoxId.set('query_1', [{
			type: 'assistant-message', id: 'stable-optional', text: 'STABLE_OPTIONAL_TOOL', toolCalls: [], timestamp: 1,
		}]);

		const firstRun = service.startCopilotWriteQuery({ ...startMessage(), request: `OLD_${toolName}` });
		await vi.waitFor(() => expect((service as any)[methodName]).toHaveBeenCalledOnce());
		const secondRun = service.startCopilotWriteQuery({
			...startMessage(), request: 'NEW_OPTIONAL_TOOL_REQUEST', requireToolUse: false,
		});
		delayedTool.resolve(staleResult);
		await Promise.all([firstRun, secondRun]);

		const historyText = JSON.stringify((service as any).copilotConversationHistoryByBoxId.get('query_1') || []);
		expect(historyText).toContain('STABLE_OPTIONAL_TOOL');
		expect(historyText).toContain('NEW_OPTIONAL_TOOL_REQUEST');
		expect(historyText).toContain('NEW_OPTIONAL_TOOL_RESPONSE');
		expect(historyText).not.toContain(`OLD_${toolName}`);
		expect(historyText).not.toContain('old-optional-call');
		expect(historyText).not.toContain('STALE_SCHEMA_RESULT');
		expect(historyText).not.toContain('STALE_BEST_PRACTICES');
		expect(JSON.stringify(hostMessagesOfType(host, 'copilotWriteQueryToolResult')))
			.not.toMatch(/STALE_SCHEMA_RESULT|STALE_BEST_PRACTICES/);
	});

	it('strips leading comments from raw control commands in execute_kusto_query while preserving visible tool text', async () => {
		const rawQuery = '  // inspect metadata\r\n\t.show tables';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: rawQuery })],
			[new vscode.LanguageModelTextPart('The command executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toEqual(['.show tables']);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expect(executedMessages[0].query).toBe(rawQuery.trim());
	});

	it('stores inline executed-query tool queries in Copilot conversation history', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const service = new CopilotService(createHost(capturedQueries));

		await service.startCopilotWriteQuery(startMessage());

		const queries = historyToolQueries(service);
		expect(queries).toHaveLength(1);
		expectInlineFilterRowsQuery(queries[0]);
	});

	it('reports failed execute_kusto_query function definitions with inline visible query text', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function failed as expected for this repro.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries, new Error('synthetic Kusto failure'));
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expect(executedMessages[0].resultSummary).toBe('Error');
		expectInlineFilterRowsQuery(executedMessages[0].query);
		const queries = historyToolQueries(service);
		expect(queries).toHaveLength(1);
		expectInlineFilterRowsQuery(queries[0]);
	});

	it('executes leading-comment function definitions from Copilot as inline function invocations', async () => {
		const functionQuery = '/*\n generated helper\n*/\n\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineFilterRowsQuery(executedMessages[0].query);
	});

	it.each([
		['line commented .create', '// .create function Fake() { print fake=1 }\nprint x=1'],
		['block commented .create-or-alter', '/* .create-or-alter function Fake() { print fake=1 } */\nprint x=1'],
		['multiline block commented .alter', '/*\n.alter function Fake() { print fake=1 }\n*/\nprint x=1'],
	])('does not convert commented-out function definitions in execute_kusto_query calls: %s', async (_label, functionQuery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The plain query executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectPlainCommentedFakeFunctionQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectPlainCommentedFakeFunctionQuery(executedMessages[0].query);
	});

	it('converts multiple execute_kusto_query function definitions before invoking the second function', async () => {
		const functionQuery = '.create function FirstRows() { range x from 1 to 3 step 1 }\n.create function SecondRows() { range y from 4 to 6 step 1 }\nSecondRows() | take 5';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineTwoFunctionQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineTwoFunctionQuery(executedMessages[0].query);
	});

	it('converts semicolon-separated execute_kusto_query function definitions before invocation', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { let cutoff = 5; range x from 1 to 10 step 1 | where x > cutoff }; FilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineSemicolonInvocationQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineSemicolonInvocationQuery(executedMessages[0].query);
	});

	it('does not convert metadata-only alter function execute_kusto_query calls', async () => {
		const functionQuery = '.alter function docstring FilterRows "new docs"\nprint x=1';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The query executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectMetadataAlterQueryUnconverted(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectMetadataAlterQueryUnconverted(executedMessages[0].query);
	});

	it('does not convert definition-only execute_kusto_query function commands into inline queries', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The management command executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expect(normalizeQueryText(capturedQueries[0])).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(capturedQueries[0])).not.toMatch(/\blet\s+FilterRows\s*=/i);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expect(normalizeQueryText(executedMessages[0].query)).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(executedMessages[0].query)).not.toMatch(/\blet\s+FilterRows\s*=/i);
	});

	it('does not convert definition-only execute_kusto_query commands with trailing comments into inline queries', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\n/* helper comment */';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The management command executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expect(normalizeQueryText(capturedQueries[0])).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(capturedQueries[0])).not.toMatch(/\blet\s+FilterRows\s*=/i);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expect(normalizeQueryText(executedMessages[0].query)).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(executedMessages[0].query)).not.toMatch(/\blet\s+FilterRows\s*=/i);
	});

	it('does not convert metadata-only alter folder execute_kusto_query calls', async () => {
		const functionQuery = '.alter function folder FilterRows "new/folder"\nprint x=1';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The query executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expectMetadataAlterQueryUnconverted(capturedQueries[0], '.alter function folder FilterRows "new/folder"');
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectMetadataAlterQueryUnconverted(executedMessages[0].query, '.alter function folder FilterRows "new/folder"');
	});

	it('does not convert management-only multi-command function scripts', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold };\n.alter function docstring FilterRows "new docs"';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The management script executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectNoCacheDirective(capturedQueries[0]);
		expect(normalizeQueryText(capturedQueries[0])).toContain('.create function FilterRows(threshold:long)');
		expect(normalizeQueryText(capturedQueries[0])).toContain('.alter function docstring FilterRows "new docs"');
		expect(normalizeQueryText(capturedQueries[0])).not.toMatch(/\blet\s+FilterRows\s*=/i);
	});

	it.each([
		['line-commented fake', '// .create function Fake() { print fake=1 }\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['block-commented fake', '/* .create function Fake() { print fake=1 } */\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['multiline-block-commented fake', '/*\n.create function Fake() { print fake=1 }\n*/\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
	])('ignores %s functions before real execute_kusto_query functions', async (_label, functionQuery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFakeThenRealQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineFakeThenRealQuery(executedMessages[0].query);
	});

	it.each([
		['create-or-alter', '/* generated helper */\n.create-or-alter function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['create-or-alter with clause', '.create-or-alter function with (folder="Helpers", docstring="Filter helper") FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['create ifnotexists', '.create function ifnotexists FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['alter', '.alter function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['commented alter', '// generated helper\n.alter function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)'],
		['fenced kql code block', '```kql\n.create function FilterRows(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }\nFilterRows(5)\n```'],
	])('executes %s function definitions from Copilot as inline function invocations', async (_label, functionQuery) => {
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineFilterRowsQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineFilterRowsQuery(executedMessages[0].query);
	});

	it('preserves multiline function bodies and trailing invocation pipelines from final Copilot responses', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) {\nrange x from 1 to 10 step 1\n| where x > threshold\n| project doubled = x * 2\n}\nFilterRows(5) | take 5';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineMultilineFilterRowsQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineMultilineFilterRowsQuery(setQueryMessages[0].query);
	});

	it('preserves line comments inside function bodies from final Copilot responses', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) {\n// keep this body comment\nrange x from 1 to 10 step 1\n| where x > threshold\n}\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineBodyCommentQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineBodyCommentQuery(setQueryMessages[0].query);
	});

	it('preserves nested braces in function bodies from final Copilot responses', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) {\nrange x from 1 to 10 step 1\n| extend payload = dynamic({"key":"value"})\n| where x > threshold\n}\nFilterRows(5) | take 5';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('final-call', 'respond_to_all_other_queries', { query: functionQuery })],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineNestedBracesQuery(capturedQueries[0]);
		const setQueryMessages = hostMessagesOfType(host, 'copilotWriteQuerySetQuery');
		expect(setQueryMessages).toHaveLength(1);
		expectInlineNestedBracesQuery(setQueryMessages[0].query);
	});

	it('preserves multiline function bodies and trailing invocation pipelines from Copilot execution', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) {\nrange x from 1 to 10 step 1\n| where x > threshold\n| project doubled = x * 2\n}\nFilterRows(5) | take 5';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineMultilineFilterRowsQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineMultilineFilterRowsQuery(executedMessages[0].query);
	});

	it('preserves line comments inside function bodies from Copilot execution', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) {\n// keep this body comment\nrange x from 1 to 10 step 1\n| where x > threshold\n}\nFilterRows(5)';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineBodyCommentQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineBodyCommentQuery(executedMessages[0].query);
	});

	it('preserves nested braces in function bodies before trailing invocation pipelines', async () => {
		const functionQuery = '.create function FilterRows(threshold:long) {\nrange x from 1 to 10 step 1\n| extend payload = dynamic({"key":"value"})\n| where x > threshold\n}\nFilterRows(5) | take 5';
		const model = createModel([
			[new vscode.LanguageModelToolCallPart('execute-call', 'execute_kusto_query', { query: functionQuery })],
			[new vscode.LanguageModelTextPart('The function executed successfully.')],
		]);
		vscodeMocks.selectChatModels.mockResolvedValue([model]);
		const capturedQueries: string[] = [];
		const host = createHost(capturedQueries);
		const service = new CopilotService(host);

		await service.startCopilotWriteQuery(startMessage());

		expect(capturedQueries).toHaveLength(1);
		expectInlineNestedBracesQuery(capturedQueries[0]);
		const executedMessages = hostMessagesOfType(host, 'copilotExecutedQuery');
		expect(executedMessages).toHaveLength(1);
		expectInlineNestedBracesQuery(executedMessages[0].query);
	});
});