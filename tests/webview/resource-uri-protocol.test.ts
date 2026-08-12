import { describe, expect, it } from 'vitest';

import {
	isResourceUriHostMessageType,
	isResourceUriWebviewMessageType,
	parseResourceUriHostMessage,
	parseResourceUriWebviewMessage,
} from '../../src/shared/resourceUriProtocol.js';

describe('resource URI protocol', () => {
	it('accepts requests without normalizing exact strings or optional base URIs', () => {
		const requests = [
			{
				type: 'resolveResourceUri', requestId: ' request-1 ',
				path: ' ./images/logo.png ', baseUri: '',
			},
			{
				type: 'resolveResourceUri', requestId: 'request-2', path: '',
			},
		] as const;

		for (const request of requests) {
			expect(isResourceUriWebviewMessageType(request)).toBe(true);
			const parsed = parseResourceUriWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) expect(parsed.value).toBe(request);
		}
	});

	it('accepts canonical results without normalizing exact strings', () => {
		const results = [
			{
				type: 'resolveResourceUriResult', requestId: ' request-1 ',
				ok: true, uri: '',
			},
			{
				type: 'resolveResourceUriResult', requestId: ' request-2 ',
				ok: false, error: '',
			},
		] as const;

		for (const result of results) {
			expect(isResourceUriHostMessageType(result)).toBe(true);
			const parsed = parseResourceUriHostMessage(result);
			expect(parsed).toEqual({ ok: true, value: result });
			if (parsed.ok) expect(parsed.value).toBe(result);
		}
	});

	it('claims and rejects malformed recognized requests', () => {
		const valid = {
			type: 'resolveResourceUri', requestId: 'request-1',
			path: './images/logo.png', baseUri: '',
		} as const;
		for (const request of [
			Object.assign([], valid),
			{ ...valid, requestId: 1 },
			{ ...valid, requestId: '   ' },
			{ ...valid, path: 42 },
			{ ...valid, baseUri: null },
		]) {
			expect(isResourceUriWebviewMessageType(request)).toBe(true);
			expect(parseResourceUriWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('claims and rejects malformed or mixed recognized results', () => {
		const valid = {
			type: 'resolveResourceUriResult', requestId: 'request-1',
			ok: true, uri: 'vscode-webview://current',
		} as const;
		for (const result of [
			Object.assign([], valid),
			{ ...valid, requestId: 1 },
			{ ...valid, requestId: '' },
			{ ...valid, ok: 'yes' },
			{ type: 'resolveResourceUriResult', requestId: 'request-1', ok: true },
			{ ...valid, uri: 42 },
			{ ...valid, error: 'mixed' },
			{ type: 'resolveResourceUriResult', requestId: 'request-1', ok: false },
			{ type: 'resolveResourceUriResult', requestId: 'request-1', ok: false, error: 42 },
			{
				type: 'resolveResourceUriResult', requestId: 'request-1',
				ok: false, error: 'failed', uri: 'forged',
			},
		]) {
			expect(isResourceUriHostMessageType(result)).toBe(true);
			expect(parseResourceUriHostMessage(result)).toMatchObject({ ok: false });
		}
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isResourceUriWebviewMessageType({ type: 'fetchUrl' })).toBe(false);
		expect(isResourceUriHostMessageType({ type: 'urlContent' })).toBe(false);
		expect(parseResourceUriWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseResourceUriWebviewMessage({ type: 'resolveResourceUriResult' }))
			.toMatchObject({ ok: false });
		expect(parseResourceUriHostMessage([])).toMatchObject({ ok: false });
		expect(parseResourceUriHostMessage({ type: 'resolveResourceUri' }))
			.toMatchObject({ ok: false });
	});
});
