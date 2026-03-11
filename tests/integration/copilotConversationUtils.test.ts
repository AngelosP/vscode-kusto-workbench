import * as assert from 'assert';

import {
	ConversationHistoryEntry,
	sanitizeConversationHistory,
	insertMissingToolCallResults
} from '../../src/host/copilotConversationUtils';

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

suite('sanitizeConversationHistory', () => {
	setup(() => resetIds());

	test('leaves a clean history unchanged', () => {
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
		assert.deepStrictEqual(history.map((e) => e.id), original, 'Clean history should be unchanged');
	});

	test('removes orphaned tool-call with no matching assistant-message', () => {
		const orphanedCallId = 'orphan_tc';
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			// No assistant-message that contains orphan_tc
			toolCall(orphanedCallId, 'get_schema', 'some result')
		];

		sanitizeConversationHistory(history);
		assert.strictEqual(history.length, 1, 'Orphaned tool-call should be removed');
		assert.strictEqual(history[0].type, 'user-message');
	});

	test('repositions a misplaced tool-call that appears after a later user-message (race condition)', () => {
		// This simulates the race condition:
		// Request A: user-msg-A, assistant(TC_1, TC_2), tool-call(TC_1)
		// Request B adds: user-msg-B
		// Request A's finally adds: tool-call(TC_2) at the END
		const history: ConversationHistoryEntry[] = [
			userMsg('request A'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			]),
			toolCall('tc1', 'get_schema', 'schema result'),
			userMsg('request B'),                   // ← from Request B
			toolCall('tc2', 'execute', 'not processed') // ← pushed by Request A's finally (wrong position!)
		];

		sanitizeConversationHistory(history);

		// After sanitization, tc2 should be repositioned right after tc1,
		// before user-msg-B.
		const types = history.map((e) => e.type);
		const tc2Idx = history.findIndex((e) => e.type === 'tool-call' && e.callId === 'tc2');
		const userBIdx = history.findIndex((e) => e.type === 'user-message' && e.text === 'request B');

		assert.ok(tc2Idx < userBIdx,
			`tool-call(tc2) at index ${tc2Idx} should come before user-msg-B at index ${userBIdx}. Order: ${JSON.stringify(types)}`);

		// The tool-call for tc2 should be right after tc1
		const tc1Idx = history.findIndex((e) => e.type === 'tool-call' && e.callId === 'tc1');
		assert.strictEqual(tc2Idx, tc1Idx + 1,
			`tool-call(tc2) should be immediately after tool-call(tc1)`);
	});

	test('handles multiple orphaned tool-calls', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			toolCall('orphan1', 'tool_a', 'result1'),
			toolCall('orphan2', 'tool_b', 'result2')
		];

		sanitizeConversationHistory(history);
		assert.strictEqual(history.length, 1, 'Both orphaned tool-calls should be removed');
	});

	test('preserves valid entries while removing orphans from a mixed history', () => {
		const history: ConversationHistoryEntry[] = [
			generalRules(),
			userMsg('hello'),
			assistantMsg('', [{ callId: 'valid_tc', name: 'get_schema', input: {} }]),
			toolCall('valid_tc', 'get_schema', 'schema'),
			toolCall('orphan_tc', 'unknown', 'bad result'), // orphan
			userMsg('next question')
		];

		sanitizeConversationHistory(history);
		assert.strictEqual(history.length, 5, 'Only orphan should be removed');
		assert.ok(
			!history.some((e) => e.type === 'tool-call' && e.callId === 'orphan_tc'),
			'Orphan should be gone'
		);
		assert.ok(
			history.some((e) => e.type === 'tool-call' && e.callId === 'valid_tc'),
			'Valid tool call should remain'
		);
	});

	test('handles empty history', () => {
		const history: ConversationHistoryEntry[] = [];
		sanitizeConversationHistory(history);
		assert.strictEqual(history.length, 0);
	});
});

// ---------------------------------------------------------------------------
// insertMissingToolCallResults
// ---------------------------------------------------------------------------

suite('insertMissingToolCallResults', () => {
	setup(() => resetIds());

	test('inserts missing tool result right after assistant message', () => {
		const history: ConversationHistoryEntry[] = [
			userMsg('hello'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			]),
			toolCall('tc1', 'get_schema', 'schema result')
			// tc2 is missing
		];

		insertMissingToolCallResults(
			history,
			[
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			],
			nextId
		);

		// tc2 should be inserted right after tc1 (position 3)
		assert.strictEqual(history.length, 4);
		const tc2Entry = history[3];
		assert.strictEqual(tc2Entry.type, 'tool-call');
		assert.strictEqual((tc2Entry as any).callId, 'tc2');
	});

	test('inserts at correct position even when user-message was appended after assistant', () => {
		// Simulates the race condition: Request B's user-message was already
		// appended while Request A's tool processing was still in-flight
		const history: ConversationHistoryEntry[] = [
			userMsg('request A'),
			assistantMsg('', [
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			]),
			toolCall('tc1', 'get_schema', 'schema result'),
			userMsg('request B') // ← appended by Request B before Request A finishes
		];

		insertMissingToolCallResults(
			history,
			[
				{ callId: 'tc1', name: 'get_schema', input: {} },
				{ callId: 'tc2', name: 'execute', input: {} }
			],
			nextId
		);

		// tc2 should be inserted at index 3 (after tc1, before user-msg-B)
		assert.strictEqual(history.length, 5);
		const types = history.map((e) => e.type);
		assert.deepStrictEqual(types, [
			'user-message',
			'assistant-message',
			'tool-call',
			'tool-call', // ← newly inserted tc2
			'user-message'
		], `Unexpected order: ${JSON.stringify(types)}`);

		const tc2Entry = history[3] as Extract<ConversationHistoryEntry, { type: 'tool-call' }>;
		assert.strictEqual(tc2Entry.callId, 'tc2');
	});

	test('does nothing when all results already exist', () => {
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

		assert.strictEqual(history.length, 3, 'No entries should be added');
	});

	test('does nothing for empty tool calls', () => {
		const history: ConversationHistoryEntry[] = [userMsg('hello')];
		insertMissingToolCallResults(history, [], nextId);
		assert.strictEqual(history.length, 1);
	});
});
