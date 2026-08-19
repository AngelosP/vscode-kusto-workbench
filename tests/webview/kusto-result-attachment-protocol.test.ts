import { describe, expect, it } from 'vitest';

import {
	createKustoResultAttachmentCommittedMessage,
	createKustoResultSelectionRequest,
	createKustoResultSelectionResultMessage,
	parseKustoResultAttachmentHostMessage,
	parseKustoResultAttachmentWebviewMessage,
	parseKustoResultAttachmentWebviewMessageFromEnvelope,
} from '../../src/shared/kustoResultAttachmentProtocol.js';
import { captureRuntimeMessageEnvelope } from '../../src/shared/runtimeMessageEnvelope.js';

describe('Kusto result attachment protocol', () => {
	it('constructs and parses an exact committed attachment confirmation', () => {
		const created = createKustoResultAttachmentCommittedMessage({
			publicationId: 'publication-1', boxId: 'query-1', executionId: 'execution-1',
			sectionInstanceId: 'instance-1', targetGeneration: 3,
			primaryArtifactId: 'result:query-1:7', resultSetCount: 2, selectedResultIndex: 1,
		});

		expect(created.ok).toBe(true);
		if (!created.ok) return;
		expect(parseKustoResultAttachmentHostMessage(created.value)).toEqual(created);
		expect(Object.isFrozen(created.value)).toBe(true);
	});

	it('constructs and parses exact selection requests and results', () => {
		const request = createKustoResultSelectionRequest({
			requestId: 'selection-1', boxId: 'query-1', sectionInstanceId: 'instance-1',
			targetGeneration: 3, primaryArtifactId: 'result:query-1:7', resultIndex: 1,
		});
		expect(request.ok).toBe(true);
		if (!request.ok) return;
		expect(parseKustoResultAttachmentWebviewMessage(request.value)).toEqual(request);

		const result = createKustoResultSelectionResultMessage({
			requestId: 'selection-1', boxId: 'query-1', primaryArtifactId: 'result:query-1:7',
			resultIndex: 1, accepted: true,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(parseKustoResultAttachmentHostMessage(result.value)).toEqual(result);
	});

	it('rejects malformed, unsafe, extra-field, and wrong-direction messages', () => {
		const validRequest = {
			type: 'selectKustoResult', requestId: 'selection-1', boxId: 'query-1',
			sectionInstanceId: 'instance-1', targetGeneration: 3,
			primaryArtifactId: 'result:query-1:7', resultIndex: 1,
		};
		for (const malformed of [
			{ ...validRequest, resultIndex: -1 },
			{ ...validRequest, resultIndex: 1.5 },
			{ ...validRequest, targetGeneration: Number.MAX_SAFE_INTEGER + 1 },
			{ ...validRequest, extra: true },
			['selectKustoResult'],
		]) {
			expect(parseKustoResultAttachmentWebviewMessage(malformed).ok).toBe(false);
		}
		expect(parseKustoResultAttachmentHostMessage(validRequest).ok).toBe(false);
	});

	it('rejects descriptor laundering through the generic runtime envelope', () => {
		const validRequest = {
			type: 'selectKustoResult', requestId: 'selection-1', boxId: 'query-1',
			sectionInstanceId: 'instance-1', targetGeneration: 3,
			primaryArtifactId: 'result:query-1:7', resultIndex: 1,
		};
		const customPrototype = Object.assign(Object.create({ inherited: true }), validRequest);
		const hiddenExtra = { ...validRequest };
		Object.defineProperty(hiddenExtra, 'hidden', { value: true, enumerable: false });

		for (const malformed of [customPrototype, hiddenExtra]) {
			const envelope = captureRuntimeMessageEnvelope(malformed);
			expect(envelope.ok).toBe(true);
			if (!envelope.ok) continue;
			expect(parseKustoResultAttachmentWebviewMessage(envelope.value).ok).toBe(false);
			expect(parseKustoResultAttachmentWebviewMessageFromEnvelope(envelope.descriptorSnapshot).ok).toBe(false);
		}
	});
});