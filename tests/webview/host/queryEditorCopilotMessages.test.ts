import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CopilotService, type CopilotServiceHost } from '../../../src/host/queryEditorCopilot';
import type { ConversationHistoryEntry } from '../../../src/host/copilotConversationUtils';
import { QueryRunCoordinator } from '../../../src/host/queryRunCoordinator';
import { SqlExecutionBroker } from '../../../src/host/sql/sqlExecutionBroker';

function makeHost(): CopilotServiceHost {
	const host: any = {
		extensionUri: vscode.Uri.file('/extension'),
		context: {
			globalState: {
				get: () => undefined,
				update: () => Promise.resolve(),
			},
		} as any,
		kustoClient: {} as any,
		output: { trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, log: () => {}, show: () => {} } as any,
		postMessage: () => true,
		findConnection: () => undefined,
		getErrorMessage: (error: unknown) => error instanceof Error ? error.message : String(error),
		formatQueryExecutionErrorForUser: (error: unknown) => error instanceof Error ? error.message : String(error),
		logQueryExecutionError: () => {},
		normalizeClusterUrlKey: (url: string) => url,
		cancelRunningQuery: () => {},
		reserveRunningQueryReplacement: (_boxId: string, _executionId: string) => ({
			cancel: () => {}, runSeq: 1, previousCancellationDelivery: Promise.resolve(true),
		}),
		promoteRunningQueryReservation: () => true,
		registerRunningQuery: () => {},
		unregisterRunningQuery: () => {},
		nextQueryRunSeq: () => 1,
		isRunningQueryCurrent: () => true,
		isControlCommand: () => false,
		appendQueryMode: (query: string) => query,
		normalizeControlCommandForExecution: (query: string) => query,
		buildCacheDirective: () => undefined,
		getCachedSchemaFromDisk: () => Promise.resolve(undefined),
		saveCachedSchemaToDisk: () => Promise.resolve(),
		ensureComparisonBoxInWebview: () => Promise.resolve('comparison'),
		waitForComparisonSummary: () => Promise.resolve({ dataMatches: true, headersMatch: true }),
		deleteComparisonSummary: () => {},
		requestSectionsFromWebview: () => Promise.resolve(undefined),
		revealPanel: () => {},
		assertSqlConnectionAllowed: () => Promise.resolve(),
		dispatchSqlConnectionAllowed: async (_connectionId: string, dispatch: () => unknown) => await dispatch(),
		dispatchSqlResultOwnerAllowed: async (_boxId: string, _owner: unknown, dispatch: () => unknown) => await dispatch(),
		getSqlResultOwner: () => ({
			connectionId: 'sql-a', database: 'Db', generation: 1, targetSignature: 'target-a',
			principalFingerprint: 'principal-a', revocationGeneration: 0,
		}),
		assertSqlResultOwnerAllowed: () => Promise.resolve(),
	};
	host.sqlExecutionBroker = new SqlExecutionBroker({
		queryRuns: new QueryRunCoordinator(),
		getOwnerToken: () => undefined,
		postMessage: (message: unknown) => host.postMessage(message),
	});
	return host;
}

function buildSqlMessages(history: ConversationHistoryEntry[], priorAttempts: Array<{ attempt: number; query?: string; error?: string }> = []) {
	const service = new CopilotService(makeHost());
	(service as any).copilotConversationHistoryByBoxId.set('sql_1', history);
	return (service as any).buildSqlMessagesFromHistory({
		boxId: 'sql_1',
		serverUrl: 'server.example.net',
		database: 'db',
		schemaText: '',
		priorAttempts,
	}) as vscode.LanguageModelChatMessage[];
}

function buildKustoMessages(history: ConversationHistoryEntry[], priorAttempts: Array<{ attempt: number; query?: string; error?: string }> = []) {
	const service = new CopilotService(makeHost());
	(service as any).copilotConversationHistoryByBoxId.set('query_1', history);
	return (service as any).buildMessagesFromHistory({
		boxId: 'query_1',
		clusterUrl: 'https://cluster.example.net',
		database: 'db',
		priorAttempts,
	}) as vscode.LanguageModelChatMessage[];
}

function sanitizeProviderMessages(messages: vscode.LanguageModelChatMessage[]) {
	const service = new CopilotService(makeHost());
	return (service as any).sanitizeProviderToolMessageSequence(messages) as vscode.LanguageModelChatMessage[];
}

function providerProtocolViolations(messages: vscode.LanguageModelChatMessage[]): string[] {
	const violations: string[] = [];
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i];
		const toolResults = message.content.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart);
		if (toolResults.length > 0) {
			if (message.content.some((part) => !(part instanceof vscode.LanguageModelToolResultPart))) {
				violations.push('tool_result message contains non-tool-result content');
			}
			const seenResultIds = new Set<string>();
			for (const result of toolResults) {
				if (seenResultIds.has(result.callId)) {
					violations.push(`duplicate tool_result ${result.callId}`);
				}
				seenResultIds.add(result.callId);
			}
			const previous = messages[i - 1];
			const previousToolCallIds = new Set(
				previous?.role === vscode.LanguageModelChatMessageRole.Assistant
					? previous.content
						.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart)
						.map((part) => part.callId)
					: []
			);
			for (const result of toolResults) {
				if (!previousToolCallIds.has(result.callId)) {
					violations.push(`tool_result ${result.callId} is not owned by the immediately previous assistant message`);
				}
			}
		}

		const toolCalls = message.content.filter((part): part is vscode.LanguageModelToolCallPart => part instanceof vscode.LanguageModelToolCallPart);
		if (message.role === vscode.LanguageModelChatMessageRole.Assistant && toolCalls.length > 0) {
			const seenToolCallIds = new Set<string>();
			for (const call of toolCalls) {
				if (seenToolCallIds.has(call.callId)) {
					violations.push(`duplicate tool_use ${call.callId}`);
				}
				seenToolCallIds.add(call.callId);
			}
			const next = messages[i + 1];
			const nextToolResultIds = new Set(
				next?.role === vscode.LanguageModelChatMessageRole.User
					? next.content
						.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
						.map((part) => part.callId)
					: []
			);
			for (const call of toolCalls) {
				if (!nextToolResultIds.has(call.callId)) {
					violations.push(`tool_use ${call.callId} is not followed by an immediate tool_result`);
				}
			}
		}
	}
	return violations;
}

describe('Copilot provider message serialization', () => {
	it('flags malformed provider tool-result sequences in the test validator', () => {
		expect(providerProtocolViolations([
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart('call_1', 'execute_sql_query', {}),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('ok')]),
				new vscode.LanguageModelTextPart('mixed text'),
			]),
		])).toContain('tool_result message contains non-tool-result content');

		expect(providerProtocolViolations([
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart('call_1', 'execute_sql_query', {}),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('ok')]),
				new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('duplicate')]),
			]),
		])).toContain('duplicate tool_result call_1');

		expect(providerProtocolViolations([
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart('call_1', 'execute_sql_query', {}),
				new vscode.LanguageModelToolCallPart('call_1', 'execute_sql_query', {}),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart('call_1', [new vscode.LanguageModelTextPart('ok')]),
			]),
		])).toContain('duplicate tool_use call_1');

		expect(providerProtocolViolations([
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart('call_1', 'execute_sql_query', {}),
			]),
			vscode.LanguageModelChatMessage.User('ordinary text'),
		])).toContain('tool_use call_1 is not followed by an immediate tool_result');
	});

	it('repairs SQL provider protocol failure when a tool-use turn is missing its immediate result', () => {
		const messages = buildSqlMessages([
			{
				type: 'user-message',
				id: 'user_1',
				text: 'write a query',
				timestamp: 1,
			},
			{
				type: 'assistant-message',
				id: 'assistant_1',
				text: '',
				toolCalls: [{ callId: 'call_missing', name: 'execute_sql_query', input: { query: 'select 1' } }],
				timestamp: 2,
			},
			{
				type: 'user-message',
				id: 'user_2',
				text: 'follow-up text that must not separate tool_use from tool_result',
				timestamp: 3,
			},
		], [{ attempt: 1, query: 'select 1', error: 'boom' }]);

		expect(providerProtocolViolations(messages)).toEqual([]);
	});

	it('drops orphan SQL tool results that are not owned by the immediately previous assistant', () => {
		const messages = buildSqlMessages([
			{
				type: 'user-message',
				id: 'user_1',
				text: 'write a query',
				timestamp: 1,
			},
			{
				type: 'assistant-message',
				id: 'assistant_1',
				text: '',
				toolCalls: [{ callId: 'call_1', name: 'execute_sql_query', input: { query: 'select 1' } }],
				timestamp: 2,
			},
			{
				type: 'tool-call',
				id: 'tool_1',
				callId: 'call_1',
				tool: 'execute_sql_query',
				result: '1 row',
				timestamp: 3,
			},
			{
				type: 'user-message',
				id: 'user_2',
				text: 'next request',
				timestamp: 4,
			},
		]);

		const resultMessages = messages.filter(message =>
			message.content.some(part => part instanceof vscode.LanguageModelToolResultPart)
		);

		expect(providerProtocolViolations(messages)).toEqual([]);
		expect(resultMessages).toHaveLength(1);
	});

	it('drops an unexpected tool result id from the immediate result message', () => {
		const messages = sanitizeProviderMessages([
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart('expected_call', 'execute_sql_query', { query: 'select 1' }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart('unexpected_call', [
					new vscode.LanguageModelTextPart('wrong result for another tool use'),
				]),
			]),
		]);

		expect(providerProtocolViolations(messages)).toEqual([]);
		const resultIds = messages
			.flatMap(message => message.content)
			.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
			.map(part => part.callId);
		expect(resultIds).toEqual(['expected_call']);
	});

	it('moves a late SQL tool result before ordinary user text instead of losing it', () => {
		const messages = buildSqlMessages([
			{
				type: 'user-message',
				id: 'user_1',
				text: 'write a query',
				timestamp: 1,
			},
			{
				type: 'assistant-message',
				id: 'assistant_1',
				text: '',
				toolCalls: [{ callId: 'late_call', name: 'execute_sql_query', input: { query: 'select 1' } }],
				timestamp: 2,
			},
			{
				type: 'user-message',
				id: 'user_2',
				text: 'ordinary text that was incorrectly between tool use and result',
				timestamp: 3,
			},
			{
				type: 'tool-call',
				id: 'late_result',
				callId: 'late_call',
				tool: 'execute_sql_query',
				result: 'real result that should be preserved',
				timestamp: 4,
			},
		]);

		const assistantIndex = messages.findIndex(message =>
			message.role === vscode.LanguageModelChatMessageRole.Assistant &&
			message.content.some(part => part instanceof vscode.LanguageModelToolCallPart && part.callId === 'late_call')
		);
		const immediateResult = messages[assistantIndex + 1];
		const resultText = immediateResult.content
			.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
			.flatMap(part => part.content)
			.map(part => part.value)
			.join('\n');
		const allUserText = messages
			.flatMap(message => message.content)
			.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
			.map(part => part.value)
			.join('\n');

		expect(providerProtocolViolations(messages)).toEqual([]);
		expect(resultText).toContain('real result that should be preserved');
		expect(allUserText).toContain('ordinary text that was incorrectly between tool use and result');
	});

	it('prefers a later real tool result over an earlier placeholder for the same tool use', () => {
		const messages = sanitizeProviderMessages([
			vscode.LanguageModelChatMessage.Assistant([
				new vscode.LanguageModelToolCallPart('call_1', 'execute_sql_query', { query: 'select 1' }),
			]),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart('call_1', [
					new vscode.LanguageModelTextPart('[Tool result was not recorded]'),
				]),
			]),
			vscode.LanguageModelChatMessage.User('ordinary follow-up text'),
			vscode.LanguageModelChatMessage.User([
				new vscode.LanguageModelToolResultPart('call_1', [
					new vscode.LanguageModelTextPart('real result wins'),
				]),
			]),
		]);

		const immediateResult = messages[1];
		const resultText = immediateResult.content
			.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
			.flatMap(part => part.content)
			.map(part => part.value)
			.join('\n');
		const allUserText = messages
			.flatMap(message => message.content)
			.filter((part): part is vscode.LanguageModelTextPart => part instanceof vscode.LanguageModelTextPart)
			.map(part => part.value)
			.join('\n');

		expect(providerProtocolViolations(messages)).toEqual([]);
		expect(resultText).toContain('real result wins');
		expect(resultText).not.toContain('[Tool result was not recorded]');
		expect(allUserText).toContain('ordinary follow-up text');
	});

	it('repairs Kusto provider protocol failure when a tool-use turn is missing its immediate result', () => {
		const messages = buildKustoMessages([
			{
				type: 'user-message',
				id: 'user_1',
				text: 'write a query',
				timestamp: 1,
			},
			{
				type: 'assistant-message',
				id: 'assistant_1',
				text: '',
				toolCalls: [{ callId: 'missing_kusto_call', name: 'execute_kusto_query', input: { query: 'print x=1' } }],
				timestamp: 2,
			},
			{
				type: 'user-message',
				id: 'user_2',
				text: 'follow-up text',
				timestamp: 3,
			},
		]);

		expect(providerProtocolViolations(messages)).toEqual([]);
	});

	it('uses recorded final-response tool results instead of a synthetic not-processed placeholder', () => {
		const service = new CopilotService(makeHost());
		const history: ConversationHistoryEntry[] = [
			{
				type: 'user-message',
				id: 'user_1',
				text: 'write final query',
				timestamp: 1,
			},
			{
				type: 'assistant-message',
				id: 'assistant_1',
				text: '',
				toolCalls: [{ callId: 'final_call', name: 'respond_to_all_other_queries', input: { query: 'print x=1' } }],
				timestamp: 2,
			},
		];
		(service as any).appendToolCallHistoryResult(
			history,
			'query_1',
			' final_call ',
			'respond_to_all_other_queries',
			{ query: 'print x=1' },
			'Query ran successfully.'
		);
		(service as any).copilotConversationHistoryByBoxId.set('query_1', history);

		const messages = (service as any).buildMessagesFromHistory({
			boxId: 'query_1',
			clusterUrl: 'https://cluster.example.net',
			database: 'db',
		}) as vscode.LanguageModelChatMessage[];
		const resultText = messages
			.flatMap(message => message.content)
			.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
			.flatMap(part => part.content)
			.map(part => part.value)
			.join('\n');

		expect(providerProtocolViolations(messages)).toEqual([]);
		expect(resultText).toContain('Query ran successfully.');
		expect(resultText).not.toContain('Tool call was not processed');
	});

	it('keeps a valid Kusto multi-tool result batch provider-valid', () => {
		const messages = buildKustoMessages([
			{
				type: 'user-message',
				id: 'user_1',
				text: 'run both',
				timestamp: 1,
			},
			{
				type: 'assistant-message',
				id: 'assistant_1',
				text: '',
				toolCalls: [
					{ callId: 'call_a', name: 'execute_kusto_query', input: { query: 'print a=1' } },
					{ callId: 'call_b', name: 'execute_kusto_query', input: { query: 'print b=2' } },
				],
				timestamp: 2,
			},
			{
				type: 'tool-call',
				id: 'tool_a',
				callId: 'call_a',
				tool: 'execute_kusto_query',
				result: '1 row',
				timestamp: 3,
			},
			{
				type: 'tool-call',
				id: 'tool_b',
				callId: 'call_b',
				tool: 'execute_kusto_query',
				result: '1 row',
				timestamp: 4,
			},
		]);

		const resultMessage = messages.find(message =>
			message.content.some(part => part instanceof vscode.LanguageModelToolResultPart)
		);
		const resultIds = resultMessage?.content
			.filter((part): part is vscode.LanguageModelToolResultPart => part instanceof vscode.LanguageModelToolResultPart)
			.map(part => part.callId);

		expect(providerProtocolViolations(messages)).toEqual([]);
		expect(resultIds).toEqual(['call_a', 'call_b']);
	});
});