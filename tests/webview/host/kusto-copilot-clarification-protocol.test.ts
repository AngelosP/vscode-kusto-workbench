import { describe, expect, it, vi } from 'vitest';
import {
	createKustoCopilotClarificationRequiredResult,
	createKustoCopilotClarifyingQuestionMessage,
	parseKustoCopilotClarificationRequiredResult,
	parseKustoCopilotClarifyingQuestionMessage,
	parseKustoCopilotClarifyingQuestionMessageFromEnvelope,
} from '../../../src/shared/kustoCopilotClarificationProtocol';
import { captureRuntimeMessageEnvelope } from '../../../src/shared/runtimeMessageEnvelope';

const identity = {
	boxId: 'query_1',
	copilotRequestId: 'copilot-request-1',
	sectionInstanceId: 'section-instance-1',
	targetGeneration: 3,
};

describe('Kusto Copilot clarification protocol', () => {
	it('constructs an exact immutable calling-agent clarification', () => {
		const result = createKustoCopilotClarifyingQuestionMessage(
			identity,
			'entry-1',
			'Which time range?',
			'calling-agent',
		);

		expect(result).toEqual({
			ok: true,
			value: {
				type: 'copilotClarifyingQuestion', ...identity,
				entryId: 'entry-1', question: 'Which time range?',
				responseTarget: 'calling-agent',
			},
		});
		if (result.ok) expect(Object.isFrozen(result.value)).toBe(true);
	});

	it('rejects malformed identities, targets, blank questions, and extra fields', () => {
		for (const message of [
			{ type: 'copilotClarifyingQuestion', ...identity, targetGeneration: -1, entryId: 'e', question: 'q', responseTarget: 'calling-agent' },
			{ type: 'copilotClarifyingQuestion', ...identity, entryId: 'e', question: ' ', responseTarget: 'calling-agent' },
			{ type: 'copilotClarifyingQuestion', ...identity, entryId: 'e', question: 'q', responseTarget: 'other' },
			{ type: 'copilotClarifyingQuestion', ...identity, entryId: 'e', question: 'q', responseTarget: 'calling-agent', extra: true },
		]) {
			expect(parseKustoCopilotClarifyingQuestionMessage(message).ok).toBe(false);
		}
	});

	it('uses the original descriptor snapshot so hidden fields cannot be laundered away', () => {
		const message = {
			type: 'copilotClarifyingQuestion', ...identity,
			entryId: 'entry-1', question: 'Which time range?',
			responseTarget: 'calling-agent',
		};
		Object.defineProperty(message, 'extra', { value: true, enumerable: false });
		const envelope = captureRuntimeMessageEnvelope(message);
		expect(envelope.ok).toBe(true);
		if (!envelope.ok) return;

		expect(parseKustoCopilotClarifyingQuestionMessage(envelope.value).ok).toBe(false);
		expect(parseKustoCopilotClarifyingQuestionMessageFromEnvelope(envelope.descriptorSnapshot).ok).toBe(false);
	});

	it('does not invoke accessors while rejecting clarification traffic', () => {
		const getter = vi.fn(() => 'Which time range?');
		const message = {
			type: 'copilotClarifyingQuestion', ...identity,
			entryId: 'entry-1', responseTarget: 'calling-agent',
		};
		Object.defineProperty(message, 'question', { get: getter, enumerable: true });

		expect(parseKustoCopilotClarifyingQuestionMessage(message).ok).toBe(false);
		expect(getter).not.toHaveBeenCalled();
	});

	it('constructs a canonical clarification-required result', () => {
		const result = createKustoCopilotClarificationRequiredResult('Which time range?', 'query_1');

		expect(result).toEqual({
			ok: true,
			value: {
				outcome: 'clarification-required', success: false,
				question: 'Which time range?', sectionId: 'query_1',
			},
		});
	});

	it('rejects malformed nested results and untrusted file identity', () => {
		for (const result of [
			{ outcome: 'clarification-required', success: true, question: 'q', sectionId: 'query_1' },
			{ outcome: 'clarification-required', success: false, question: '', sectionId: 'query_1' },
			{ outcome: 'clarification-required', success: false, question: 'q', sectionId: 'query_1', openFileId: 'forged' },
			Object.assign(Object.create({ inherited: true }), {
				outcome: 'clarification-required', success: false, question: 'q', sectionId: 'query_1',
			}),
		]) {
			expect(parseKustoCopilotClarificationRequiredResult(result).ok).toBe(false);
		}
	});
});