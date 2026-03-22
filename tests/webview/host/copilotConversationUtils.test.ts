import { describe, it, expect, beforeEach } from 'vitest';
import {
	type ConversationHistoryEntry,
	sanitizeConversationHistory,
	insertMissingToolCallResults
} from '../../../src/host/copilotConversationUtils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let idSeq = 0;
function resetIds() { idSeq = 0; }
function nextId() { return `test_${++idSeq}`; }

function userMsg(text: string, id?: string): ConversationHistoryEntry {
	return { type: 'user-message', id: id || nextId(), text, timestamp: 1 };
}

function assistantMsg(
	text: string,
	toolCalls: Array<{ callId: string; name: string; input: object }>,
	id?: string
): ConversationHistoryEntry {
	return { type: 'assistant-message', id: id || nextId(), text, toolCalls, timestamp: 1 };
}

function toolCall(callId: string, tool: string, result: string, id?: string): ConversationHistoryEntry {
	return { type: 'tool-call', id: id || nextId(), callId, tool, result, timestamp: 1 };
}

function generalRules(id?: string): ConversationHistoryEntry {
	return { type: 'general-rules', id: id || nextId(), content: 'rules', filePath: 'rules.md', timestamp: 1 };
}

// ---------------------------------------------------------------------------
// sanitizeConversationHistory
// ---------------------------------------------------------------------------

describe('sanitizeConversationHistory', () => {
	beforeEach(() => resetIds());

	it('leaves a clean history unchanged', () => {
		const history: ConversationHistoryEntry[] = [
			generalRules(),
			userMsg('hello'),
			assistantMsg('', [{ callId: 'tc1', name: 'get_schema', input: {} }]),
			toolCall('tc1', 'get_schema', '{"tables":[]}'),
			assistantMsg('done', [{ callId: 'tc2', name: 'respond', input: {} }]),
			toolCall('tc2', 'respond', 'query result')
		];

		const original = history.map((e) => e.id);
		sanitizeConversationHistory(history);
		expect(history.map((e) => e.id)).toEqual(original);
	});

	it('removes orphaned tool-call with no matching assistant-message', () => {
		const orphanedCallId = 'orphan_tc';
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			// No assistant-message that contains orphan_tc
			toolCall(orphanedCallId, 'get_schema', 'some result')
		];

		sanitizeConversationHistory(history);
		expect(history).toHaveLength(1);
		expect(history[0].type).toBe('user-message');
	});

	it('repositions a misplaced tool-call that appears after a later user-message (race condition)', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('request A'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			]),
			toolCall('tc1', 'get_schema', 'schema result'),
			userMsg('request B'),
			toolCall('tc2', 'execute', 'not processed')
		];

		sanitizeConversationHistory(history);

		const tc2Idx = history.findIndex((e) => e.type === 'tool-call' && e.callId === 'tc2');
		const userBIdx = history.findIndex((e) => e.type === 'user-message' && e.text === 'request B');

		expect(tc2Idx).toBeLessThan(userBIdx);

		const tc1Idx = history.findIndex((e) => e.type === 'tool-call' && e.callId === 'tc1');
		expect(tc2Idx).toBe(tc1Idx + 1);
	});

	it('handles multiple orphaned tool-calls', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			toolCall('orphan1', 'tool_a', 'result1'),
			toolCall('orphan2', 'tool_b', 'result2')
		];

		sanitizeConversationHistory(history);
		expect(history).toHaveLength(1);
	});

	it('preserves valid entries while removing orphans from a mixed history', () => {
		const history: ConversationHistoryEntry[] = [
			generalRules(),
			userMsg('hello'),
			assistantMsg('', [{ callId: 'valid_tc', name: 'get_schema', input: {} }]),
			toolCall('valid_tc', 'get_schema', 'schema'),
			toolCall('orphan_tc', 'unknown', 'bad result'),
			userMsg('next question')
		];

		sanitizeConversationHistory(history);
		expect(history).toHaveLength(5);
		expect(history.some((e) => e.type === 'tool-call' && e.callId === 'orphan_tc')).toBe(false);
		expect(history.some((e) => e.type === 'tool-call' && e.callId === 'valid_tc')).toBe(true);
	});

	it('handles empty history', () => {
		const history: ConversationHistoryEntry[] = [];
		sanitizeConversationHistory(history);
		expect(history).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// insertMissingToolCallResults
// ---------------------------------------------------------------------------

describe('insertMissingToolCallResults', () => {
	beforeEach(() => resetIds());

	it('inserts missing tool result right after assistant message', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			]),
			toolCall('tc1', 'get_schema', 'schema result')
		];

		insertMissingToolCallResults(
			history,
			[
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			],
			nextId
		);

		expect(history).toHaveLength(4);
		const tc2Entry = history[3];
		expect(tc2Entry.type).toBe('tool-call');
		expect((tc2Entry as any).callId).toBe('tc2');
	});

	it('inserts at correct position even when user-message was appended after assistant', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('request A'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			]),
			toolCall('tc1', 'get_schema', 'schema result'),
			userMsg('request B')
		];

		insertMissingToolCallResults(
			history,
			[
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			],
			nextId
		);

		expect(history).toHaveLength(5);
		const types = history.map((e) => e.type);
		expect(types).toEqual([
			'user-message',
			'assistant-message',
			'tool-call',
			'tool-call',
			'user-message'
		]);

		const tc2Entry = history[3] as Extract<ConversationHistoryEntry, { type: 'tool-call' }>;
		expect(tc2Entry.callId).toBe('tc2');
	});

	it('does nothing when all results already exist', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			assistantMsg('', [{ callId: 'tc1', name: 'get_schema', input: {} }]),
			toolCall('tc1', 'get_schema', 'schema result')
		];

		insertMissingToolCallResults(
			history,
			[{ callId: 'tc1', name: 'get_schema', input: {} }],
			nextId
		);

		expect(history).toHaveLength(3);
	});

	it('does nothing for empty tool calls', () => {
		const history: ConversationHistoryEntry[] = [userMsg('hello')];
		insertMissingToolCallResults(history, [], nextId);
		expect(history).toHaveLength(1);
	});

	it('inserts at end of history when no owning assistant-message exists (fallback)', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('standalone request')
		];

		insertMissingToolCallResults(
			history,
			[{ callId: 'tc_orphan', name: 'some_tool', input: {} }],
			nextId
		);

		expect(history).toHaveLength(2);
		expect(history[1].type).toBe('tool-call');
		expect((history[1] as any).callId).toBe('tc_orphan');
	});

	it('inserts multiple missing tool results at correct position', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('go'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'a', input: {} },
				{ callId: 'tc2', name: 'b', input: {} },
				{ callId: 'tc3', name: 'c', input: {} }
			]),
			toolCall('tc1', 'a', 'result1')
		];

		insertMissingToolCallResults(
			history,
			[
				{ callId: 'tc1', name: 'a', input: {} },
				{ callId: 'tc2', name: 'b', input: {} },
				{ callId: 'tc3', name: 'c', input: {} }
			],
			nextId
		);

		expect(history).toHaveLength(5);
		expect((history[3] as any).callId).toBe('tc2');
		expect((history[4] as any).callId).toBe('tc3');
	});
});

// ---------------------------------------------------------------------------
// Three-way interleaved race condition
// ---------------------------------------------------------------------------

describe('sanitizeConversationHistory – complex interleaving', () => {
	beforeEach(() => resetIds());

	it('repositions tool-calls from 3 interleaved requests correctly', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('request A'),
			assistantMsg('', [
				{ callId: 'tc_a1', name: 'schema', input: {} },
				{ callId: 'tc_a2', name: 'run', input: {} }
			]),
			toolCall('tc_a1', 'schema', 'schema_result'),
			userMsg('request B'),
			assistantMsg('', [
				{ callId: 'tc_b1', name: 'schema', input: {} }
			]),
			userMsg('request C'),
			toolCall('tc_a2', 'run', 'run_result'),
			toolCall('tc_b1', 'schema', 'schema_result_b')
		];

		sanitizeConversationHistory(history);

		const tc_a1_idx = history.findIndex(e => e.type === 'tool-call' && (e as any).callId === 'tc_a1');
		const tc_a2_idx = history.findIndex(e => e.type === 'tool-call' && (e as any).callId === 'tc_a2');
		const tc_b1_idx = history.findIndex(e => e.type === 'tool-call' && (e as any).callId === 'tc_b1');
		const reqB_idx = history.findIndex(e => e.type === 'user-message' && (e as any).text === 'request B');
		const reqC_idx = history.findIndex(e => e.type === 'user-message' && (e as any).text === 'request C');
		const assistB_idx = history.findIndex(e => e.type === 'assistant-message' && (e as any).toolCalls?.some((tc: any) => tc.callId === 'tc_b1'));

		expect(tc_a2_idx).toBe(tc_a1_idx + 1);
		expect(tc_a2_idx).toBeLessThan(reqB_idx);
		expect(tc_b1_idx).toBeGreaterThan(assistB_idx);
		expect(tc_b1_idx).toBeLessThan(reqC_idx);
	});

	it('handles assistant-message with multiple tool-calls, some already positioned correctly', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('go'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'a', input: {} },
				{ callId: 'tc2', name: 'b', input: {} },
				{ callId: 'tc3', name: 'c', input: {} }
			]),
			toolCall('tc1', 'a', 'result1'),
			toolCall('tc2', 'b', 'result2'),
			toolCall('tc3', 'c', 'result3')
		];

		const originalIds = history.map(e => e.id);
		sanitizeConversationHistory(history);
		expect(history.map(e => e.id)).toEqual(originalIds);
	});
});
