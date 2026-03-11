/**
 * Conversation history entry types and utilities for Copilot Chat.
 *
 * Extracted to allow unit-testing the sanitisation / validation logic
 * without pulling in the full VS Code API surface.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ConversationHistoryEntry =
	| { type: 'user-message'; id: string; text: string; querySnapshot?: string; timestamp: number }
	| { type: 'assistant-message'; id: string; text: string; toolCalls?: Array<{ callId: string; name: string; input: object }>; timestamp: number }
	| { type: 'tool-call'; id: string; callId: string; tool: string; args?: unknown; result: string; removed?: boolean; timestamp: number }
	| { type: 'general-rules'; id: string; content: string; filePath: string; removed?: boolean; timestamp: number }
	| { type: 'devnotes-context'; id: string; content: string; removed?: boolean; timestamp: number };

// ---------------------------------------------------------------------------
// sanitizeConversationHistory
// ---------------------------------------------------------------------------

/**
 * Removes or repositions entries in the conversation history so that every
 * `tool-call` entry references a `callId` that appears in a preceding
 * `assistant-message` entry's `toolCalls` array.
 *
 * This defends against race conditions where a cancelled request's
 * `ensureAllToolCallsHaveResults` pushes tool-call entries to the *end*
 * of the shared history array — potentially after a newer request's
 * `user-message`.
 *
 * The function mutates `history` **in-place** and returns it for convenience.
 */
export function sanitizeConversationHistory(
	history: ConversationHistoryEntry[]
): ConversationHistoryEntry[] {
	// Build the set of valid callIds from assistant-message entries.
	const validCallIds = new Set<string>();
	for (const entry of history) {
		if (entry.type === 'assistant-message' && entry.toolCalls) {
			for (const tc of entry.toolCalls) {
				validCallIds.add(tc.callId);
			}
		}
	}

	// Walk backwards so we can splice without index invalidation.
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (entry.type === 'tool-call') {
			if (!validCallIds.has(entry.callId)) {
				// Orphaned tool-call — remove it.
				history.splice(i, 1);
				continue;
			}

			// The tool-call is valid, but it might be mis-positioned.
			// It should appear *after* its owning assistant-message and
			// *before* the next user-message / assistant-message that is
			// not a tool-call for the same batch.
			// Find the owning assistant-message.
			let ownerIdx = -1;
			for (let j = i - 1; j >= 0; j--) {
				if (
					history[j].type === 'assistant-message' &&
					(history[j] as Extract<ConversationHistoryEntry, { type: 'assistant-message' }>).toolCalls?.some(
						(tc) => tc.callId === entry.callId
					)
				) {
					ownerIdx = j;
					break;
				}
			}

			if (ownerIdx === -1) {
				// The owning assistant-message appears *after* this tool-call
				// (shouldn't happen, but be defensive) — remove the entry and
				// let ensureAllToolCallsHaveResults re-add it in the right place.
				history.splice(i, 1);
				continue;
			}

			// Find the correct insertion point: right after the owning
			// assistant-message, after any existing tool-call siblings.
			let insertAt = ownerIdx + 1;
			while (insertAt < history.length && history[insertAt].type === 'tool-call') {
				if (insertAt === i) {
					// Already in position — nothing to do.
					break;
				}
				insertAt++;
			}

			if (insertAt !== i && insertAt < i) {
				// The entry is too far down — relocate it.
				const [removed] = history.splice(i, 1);
				history.splice(insertAt, 0, removed);
			}
		}
	}

	return history;
}

// ---------------------------------------------------------------------------
// insertMissingToolCallResults
// ---------------------------------------------------------------------------

/**
 * Ensures every tool call from the latest assistant message has a
 * corresponding `tool-call` entry in the conversation history.
 *
 * Unlike the previous `push`-based approach, this inserts missing entries
 * right after the owning assistant-message (and any existing sibling
 * tool-call entries), preventing mis-ordering when new `user-message`
 * entries have already been appended by a concurrent request.
 *
 * @param history        The mutable conversation history array.
 * @param nativeToolCalls The tool calls from the latest assistant response.
 * @param generateId     A function that generates a unique entry id.
 */
export function insertMissingToolCallResults(
	history: ConversationHistoryEntry[],
	nativeToolCalls: Array<{ callId: string; name: string; input: any }>,
	generateId: () => string
): void {
	if (nativeToolCalls.length === 0) {
		return;
	}

	const existingCallIds = new Set(
		history
			.filter((e): e is Extract<ConversationHistoryEntry, { type: 'tool-call' }> => e.type === 'tool-call')
			.map((e) => e.callId)
	);

	const missing = nativeToolCalls.filter((tc) => !existingCallIds.has(tc.callId));
	if (missing.length === 0) {
		return;
	}

	// Find the assistant-message that owns these tool calls.
	// Walk backwards — it's the most recent one that contains any of the callIds.
	let ownerIdx = -1;
	for (let i = history.length - 1; i >= 0; i--) {
		const entry = history[i];
		if (
			entry.type === 'assistant-message' &&
			entry.toolCalls?.some((tc) => nativeToolCalls.some((ntc) => ntc.callId === tc.callId))
		) {
			ownerIdx = i;
			break;
		}
	}

	// Find the insertion point: right after the owner + its existing tool-call siblings.
	let insertAt: number;
	if (ownerIdx >= 0) {
		insertAt = ownerIdx + 1;
		while (insertAt < history.length && history[insertAt].type === 'tool-call') {
			insertAt++;
		}
	} else {
		// Fallback: couldn't find the owner (shouldn't happen).
		// Insert at the end — the sanitizer will clean up if needed.
		insertAt = history.length;
	}

	// Insert the missing entries at the correct position.
	const newEntries: ConversationHistoryEntry[] = missing.map((tc) => ({
		type: 'tool-call' as const,
		id: generateId(),
		callId: tc.callId,
		tool: tc.name,
		args: tc.input,
		result: '[Tool call was not processed — the turn ended before a result could be produced.]',
		timestamp: Date.now()
	}));

	history.splice(insertAt, 0, ...newEntries);
}
