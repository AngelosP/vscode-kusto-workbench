import { beforeEach, describe, expect, it, vi } from 'vitest';

const vscodeMocks = vi.hoisted(() => ({
	selectChatModels: vi.fn(),
}));

vi.mock('vscode', async () => {
	const actual = await vi.importActual<typeof import('../../mocks/vscode')>('../../mocks/vscode');
	class CancellationTokenSource {
		readonly token = { isCancellationRequested: false };
		cancel(): void { this.token.isCancellationRequested = true; }
		dispose(): void {}
	}
	return {
		...actual,
		CancellationTokenSource,
		lm: {
			selectChatModels: vscodeMocks.selectChatModels,
		},
	};
});

import * as vscode from 'vscode';
import { CopilotService, type CopilotServiceHost } from '../../../src/host/queryEditorCopilot.js';
import type { KustoConnection } from '../../../src/host/connectionManager.js';
import { appendQueryMode, buildCacheDirective, isControlCommand, normalizeControlCommandForExecution } from '../../../src/host/queryEditorUtils.js';

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
			executeQueryCancelable: vi.fn((_connection: KustoConnection, _database: string, query: string) => {
				capturedQueries.push(query);
				return {
					promise: executeError ? Promise.reject(executeError) : Promise.resolve({ columns: ['x'], rows: [[1]], metadata: {} }),
					cancel: vi.fn(),
					clientActivityId: 'KW.execute_query;test',
				};
			}),
		} as any,
		output: { trace: vi.fn(), debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn(), show: vi.fn() } as any,
		postMessage: vi.fn(),
		findConnection: vi.fn(() => TEST_CONNECTION),
		getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
		formatQueryExecutionErrorForUser: vi.fn((error: unknown) => error instanceof Error ? error.message : String(error)),
		logQueryExecutionError: vi.fn(),
		normalizeClusterUrlKey: (url: string) => url,
		cancelRunningQuery: vi.fn(),
		registerRunningQuery: vi.fn(),
		unregisterRunningQuery: vi.fn(),
		nextQueryRunSeq: () => ++runSeq,
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