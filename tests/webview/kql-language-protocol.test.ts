import { describe, expect, it } from 'vitest';

import {
	KqlDiagnosticSeverity,
	isKqlLanguageHostMessageType,
	isKqlLanguageResponseForMethod,
	isKqlLanguageWebviewMessageType,
	parseKqlLanguageHostMessage,
	parseKqlLanguageWebviewMessage,
} from '../../src/shared/kqlLanguageProtocol.js';

describe('KQL language protocol', () => {
	it('accepts both request methods without normalizing request IDs or params', () => {
		const params = {
			text: ' StormEvents ',
			connectionId: ' connection ',
			database: ' Samples ',
			boxId: ' query-1 ',
			uri: ' file:///workspace/query.kql ',
		};
		const requests = [
			{ type: 'kqlLanguageRequest', requestId: ' diagnostics-1 ', method: 'textDocument/diagnostic', params },
			{ type: 'kqlLanguageRequest', requestId: ' references-1 ', method: 'kusto/findTableReferences', params },
		] as const;

		for (const request of requests) {
			expect(isKqlLanguageWebviewMessageType(request)).toBe(true);
			const parsed = parseKqlLanguageWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) {
				expect(parsed.value).toBe(request);
				expect(parsed.value.params).toBe(params);
			}
		}
	});

	it('accepts diagnostic, reference, and failure responses without cloning nested values', () => {
		const diagnostics = [{
			range: { start: { line: 0, character: 1 }, end: { line: 2, character: 3 } },
			severity: KqlDiagnosticSeverity.Warning,
			message: 'Unknown column.',
			code: 'KW_UNKNOWN_COLUMN',
			source: 'kusto-workbench',
		}];
		const references = [{ name: 'StormEvents', startOffset: 0, endOffset: 11 }];
		const responses = [
			{ type: 'kqlLanguageResponse', requestId: 'diagnostics-1', ok: true, result: { diagnostics } },
			{ type: 'kqlLanguageResponse', requestId: 'references-1', ok: true, result: { references } },
			{ type: 'kqlLanguageResponse', requestId: 'failure-1', ok: false, error: { message: '' } },
		] as const;

		for (const response of responses) {
			expect(isKqlLanguageHostMessageType(response)).toBe(true);
			const parsed = parseKqlLanguageHostMessage(response);
			expect(parsed).toEqual({ ok: true, value: response });
			if (parsed.ok) expect(parsed.value).toBe(response);
		}
		const diagnosticsResponse = parseKqlLanguageHostMessage(responses[0]);
		if (diagnosticsResponse.ok && diagnosticsResponse.value.ok) {
			expect(diagnosticsResponse.value.result).toBe(responses[0].result);
		}
		const referencesResponse = parseKqlLanguageHostMessage(responses[1]);
		if (referencesResponse.ok && referencesResponse.value.ok) {
			expect(referencesResponse.value.result).toBe(responses[1].result);
		}
	});

	it('matches successful result branches to their originating method and permits failures for either', () => {
		const diagnostics = {
			type: 'kqlLanguageResponse', requestId: 'diagnostics-1', ok: true,
			result: { diagnostics: [] },
		} as const;
		const references = {
			type: 'kqlLanguageResponse', requestId: 'references-1', ok: true,
			result: { references: [] },
		} as const;
		const failure = {
			type: 'kqlLanguageResponse', requestId: 'failure-1', ok: false,
			error: { message: 'Unavailable.' },
		} as const;

		expect(isKqlLanguageResponseForMethod(diagnostics, 'textDocument/diagnostic')).toBe(true);
		expect(isKqlLanguageResponseForMethod(diagnostics, 'kusto/findTableReferences')).toBe(false);
		expect(isKqlLanguageResponseForMethod(references, 'kusto/findTableReferences')).toBe(true);
		expect(isKqlLanguageResponseForMethod(references, 'textDocument/diagnostic')).toBe(false);
		expect(isKqlLanguageResponseForMethod(failure, 'textDocument/diagnostic')).toBe(true);
		expect(isKqlLanguageResponseForMethod(failure, 'kusto/findTableReferences')).toBe(true);
	});

	it('rejects malformed recognized requests while preserving the discriminator claim', () => {
		const arrayRequest = Object.assign([], {
			type: 'kqlLanguageRequest', requestId: 'array-1', method: 'kusto/findTableReferences',
			params: { text: 'StormEvents' },
		});
		for (const request of [
			arrayRequest,
			{ type: 'kqlLanguageRequest', requestId: 1, method: 'kusto/findTableReferences', params: { text: 'StormEvents' } },
			{ type: 'kqlLanguageRequest', requestId: '   ', method: 'kusto/findTableReferences', params: { text: 'StormEvents' } },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'workspace/symbol', params: { text: 'StormEvents' } },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: null },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: [] },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: { text: 42 } },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: { text: '', connectionId: 42 } },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: { text: '', database: null } },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: { text: '', boxId: false } },
			{ type: 'kqlLanguageRequest', requestId: 'request-1', method: 'textDocument/diagnostic', params: { text: '', uri: 7 } },
		]) {
			expect(isKqlLanguageWebviewMessageType(request)).toBe(true);
			expect(parseKqlLanguageWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('rejects malformed response branches and identities', () => {
		const arrayResponse = Object.assign([], {
			type: 'kqlLanguageResponse', requestId: 'array-1', ok: true, result: { references: [] },
		});
		for (const response of [
			arrayResponse,
			{ type: 'kqlLanguageResponse', requestId: 1, ok: true, result: { references: [] } },
			{ type: 'kqlLanguageResponse', requestId: '   ', ok: true, result: { references: [] } },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: 'yes', result: { references: [] } },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: true },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: true, result: [] },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: true, result: {} },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: true, result: { diagnostics: [], references: [] } },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: true, result: { references: [] }, error: { message: 'mixed' } },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: false, error: null },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: false, error: { message: 42 } },
			{ type: 'kqlLanguageResponse', requestId: 'response-1', ok: false, error: { message: 'failed' }, result: { references: [] } },
		]) {
			expect(isKqlLanguageHostMessageType(response)).toBe(true);
			expect(parseKqlLanguageHostMessage(response)).toMatchObject({ ok: false });
		}
	});

	it('rejects sparse or malformed diagnostic arrays', () => {
		const sparseDiagnostics = new Array<unknown>(1);
		const inheritedDiagnostics = new Array<unknown>(1);
		const inheritedPrototype = Object.create(Array.prototype) as unknown[];
		inheritedPrototype[0] = {
			range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
			severity: 1, message: 'Inherited',
		};
		Object.setPrototypeOf(inheritedDiagnostics, inheritedPrototype);
		const validRange = { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } };
		for (const diagnostics of [
			sparseDiagnostics,
			inheritedDiagnostics,
			[null],
			[{ range: null, severity: 1, message: 'Bad range' }],
			[{ range: { ...validRange, start: { line: -1, character: 0 } }, severity: 1, message: 'Bad line' }],
			[{ range: { ...validRange, end: { line: 0, character: 0.5 } }, severity: 1, message: 'Bad character' }],
			[{ range: validRange, severity: 0, message: 'Bad severity' }],
			[{ range: validRange, severity: 5, message: 'Bad severity' }],
			[{ range: validRange, severity: 1, message: 42 }],
			[{ range: validRange, severity: 1, message: 'Bad code', code: 42 }],
			[{ range: validRange, severity: 1, message: 'Bad source', source: false }],
		]) {
			const response = {
				type: 'kqlLanguageResponse', requestId: 'diagnostics-1', ok: true,
				result: { diagnostics },
			};
			expect(parseKqlLanguageHostMessage(response)).toMatchObject({ ok: false });
		}
	});

	it('rejects sparse or malformed table-reference arrays', () => {
		const sparseReferences = new Array<unknown>(1);
		const inheritedReferences = new Array<unknown>(1);
		const inheritedPrototype = Object.create(Array.prototype) as unknown[];
		inheritedPrototype[0] = { name: 'Inherited', startOffset: 0, endOffset: 9 };
		Object.setPrototypeOf(inheritedReferences, inheritedPrototype);
		for (const references of [
			sparseReferences,
			inheritedReferences,
			[null],
			[{ name: 42, startOffset: 0, endOffset: 1 }],
			[{ name: 'StormEvents', startOffset: -1, endOffset: 11 }],
			[{ name: 'StormEvents', startOffset: 0.5, endOffset: 11 }],
			[{ name: 'StormEvents', startOffset: 0, endOffset: '11' }],
			[{ name: 'StormEvents', startOffset: 0, endOffset: Number.MAX_SAFE_INTEGER + 1 }],
		]) {
			const response = {
				type: 'kqlLanguageResponse', requestId: 'references-1', ok: true,
				result: { references },
			};
			expect(parseKqlLanguageHostMessage(response)).toMatchObject({ ok: false });
		}
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isKqlLanguageWebviewMessageType({ type: 'getConnections' })).toBe(false);
		expect(isKqlLanguageHostMessageType({ type: 'schemaData' })).toBe(false);
		expect(parseKqlLanguageWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseKqlLanguageWebviewMessage({ type: 'kqlLanguageResponse' })).toMatchObject({ ok: false });
		expect(parseKqlLanguageHostMessage([])).toMatchObject({ ok: false });
		expect(parseKqlLanguageHostMessage({ type: 'kqlLanguageRequest' })).toMatchObject({ ok: false });
	});
});
