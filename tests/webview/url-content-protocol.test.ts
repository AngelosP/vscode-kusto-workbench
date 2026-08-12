import { describe, expect, it } from 'vitest';

import {
	admitUrlContentHostMessage,
	admitUrlContentWebviewMessage,
	isUrlContentHostMessageType,
	isUrlContentWebviewMessageType,
	parseUrlContentHostMessage,
	parseUrlContentWebviewMessage,
} from '../../src/shared/urlContentProtocol.js';

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

describe('URL content protocol', () => {
	it('snapshots requests without normalizing exact strings', () => {
		const requests = [
			{ type: 'fetchUrl', boxId: ' url-section ', url: '', requestId: ' request-1 ' },
			{ type: 'fetchUrl', boxId: 'url-section', url: ' https://example.com/data.csv ', requestId: 'request-2' },
		] as const;

		for (const request of requests) {
			expect(isUrlContentWebviewMessageType(request)).toBe(true);
			const parsed = parseUrlContentWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) expect(parsed.value).not.toBe(request);
		}
	});

	it('snapshots canonical content and error branches with exact values', () => {
		const deliveries = [
			{
				type: 'urlContent', boxId: 'url-section', requestId: 'request-image',
				requestedUrl: 'https://example.com/image', url: 'https://cdn.example.com/image.png',
				contentType: 'image/png', status: 200, byteLength: 4,
				kind: 'image', dataUri: 'data:image/png;base64,iVBORw==',
			},
			...(['csv', 'html', 'text'] as const).map(kind => ({
				type: 'urlContent' as const, boxId: 'url-section', requestId: `request-${kind}`,
				requestedUrl: `https://example.com/${kind}`, url: `https://cdn.example.com/${kind}`,
				contentType: `text/${kind}`, status: 200, byteLength: 0,
				kind, body: '', truncated: false,
			})),
			{
				type: 'urlError', boxId: 'url-section', requestId: 'request-error',
				requestedUrl: '', error: 'Invalid URL.',
			},
		] as const;

		for (const delivery of deliveries) {
			expect(isUrlContentHostMessageType(delivery)).toBe(true);
			const parsed = parseUrlContentHostMessage(delivery);
			expect(parsed).toEqual({ ok: true, value: delivery });
			if (parsed.ok) expect(parsed.value).not.toBe(delivery);
		}
	});

	it('accepts null-prototype records and ignores inherited forbidden fields', () => {
		const request = Object.assign(Object.create(null), {
			type: 'fetchUrl', boxId: 'url-section', url: '', requestId: 'request-null-prototype',
		});
		const text = Object.assign(Object.create({ dataUri: 'inherited' }), {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-text',
			requestedUrl: 'https://example.com/text', url: 'https://example.com/text',
			contentType: 'text/plain', status: 200,
			byteLength: 0, kind: 'text', body: '', truncated: false,
		});
		const error = Object.assign(Object.create({ kind: 'text', body: 'inherited' }), {
			type: 'urlError', boxId: 'url-section', requestId: 'request-error',
			requestedUrl: '', error: 'Invalid URL.',
		});

		const parsedRequest = parseUrlContentWebviewMessage(request);
		const parsedText = parseUrlContentHostMessage(text);
		const parsedError = parseUrlContentHostMessage(error);
		expect(parsedRequest).toEqual({ ok: true, value: { ...request } });
		expect(parsedText).toEqual({
			ok: true,
			value: {
				type: 'urlContent', boxId: 'url-section', requestId: 'request-text',
				requestedUrl: 'https://example.com/text', url: 'https://example.com/text',
				contentType: 'text/plain', status: 200, byteLength: 0,
				kind: 'text', body: '', truncated: false,
			},
		});
		expect(parsedError).toEqual({
			ok: true,
			value: {
				type: 'urlError', boxId: 'url-section', requestId: 'request-error',
				requestedUrl: '', error: 'Invalid URL.',
			},
		});
	});

	it('claims and rejects every inherited required field', () => {
		const request = {
			type: 'fetchUrl', boxId: 'url-section', url: 'https://example.com/data.csv', requestId: 'request-1',
		};
		for (const key of ['type', 'boxId', 'url', 'requestId']) {
			const inherited = inheritField(request, key);
			expect(isUrlContentWebviewMessageType(inherited)).toBe(true);
			expect(parseUrlContentWebviewMessage(inherited)).toMatchObject({ ok: false });
		}

		const text = {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-text',
			requestedUrl: 'https://example.com/text', url: 'https://example.com/text',
			contentType: 'text/plain', status: 200, byteLength: 0,
			kind: 'text', body: '', truncated: false,
		};
		for (const key of [
			'type', 'boxId', 'requestId', 'requestedUrl', 'url', 'contentType',
			'status', 'byteLength', 'kind', 'body', 'truncated',
		]) {
			const inherited = inheritField(text, key);
			expect(isUrlContentHostMessageType(inherited)).toBe(true);
			expect(parseUrlContentHostMessage(inherited)).toMatchObject({ ok: false });
		}

		const image = {
			...text, requestId: 'request-image', contentType: 'image/png',
			kind: 'image', dataUri: 'data:image/png;base64,',
		};
		delete (image as Partial<typeof image>).body;
		delete (image as Partial<typeof image>).truncated;
		expect(parseUrlContentHostMessage(inheritField(image, 'dataUri'))).toMatchObject({ ok: false });

		const error = {
			type: 'urlError', boxId: 'url-section', requestId: 'request-error',
			requestedUrl: '', error: 'Invalid URL.',
		};
		expect(parseUrlContentHostMessage(error)).toMatchObject({ ok: true });
		for (const key of ['type', 'boxId', 'requestId', 'requestedUrl', 'error']) {
			expect(parseUrlContentHostMessage(inheritField(error, key))).toMatchObject({ ok: false });
		}
	});

	it('rejects non-enumerable and accessor required fields without invoking accessors', () => {
		const request = {
			type: 'fetchUrl', boxId: 'url-section', url: 'https://example.com/data.csv', requestId: 'request-1',
		};
		const nonEnumerable = { ...request };
		Object.defineProperty(nonEnumerable, 'boxId', { value: 'url-section', enumerable: false });
		expect(parseUrlContentWebviewMessage(nonEnumerable)).toMatchObject({ ok: false });

		let getterCalls = 0;
		const accessor = { ...request };
		Object.defineProperty(accessor, 'url', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});
		expect(() => parseUrlContentWebviewMessage(accessor)).not.toThrow();
		expect(parseUrlContentWebviewMessage(accessor)).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);

		const typeAccessor = { ...request };
		Object.defineProperty(typeAccessor, 'type', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});
		expect(isUrlContentWebviewMessageType(typeAccessor)).toBe(true);
		expect(parseUrlContentWebviewMessage(typeAccessor)).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);
	});

	it('fails closed without throwing on descriptor traps and revoked proxies', () => {
		const request = {
			type: 'fetchUrl', boxId: 'url-section', url: 'https://example.com/data.csv', requestId: 'request-1',
		};
		const descriptorTrap = new Proxy(request, {
			getOwnPropertyDescriptor() {
				throw new Error('descriptor trap');
			},
		});
		expect(isUrlContentWebviewMessageType(descriptorTrap)).toBe(true);
		expect(() => parseUrlContentWebviewMessage(descriptorTrap)).not.toThrow();
		expect(parseUrlContentWebviewMessage(descriptorTrap)).toMatchObject({ ok: false });

		const revocable = Proxy.revocable(request, {});
		revocable.revoke();
		expect(() => isUrlContentWebviewMessageType(revocable.proxy)).not.toThrow();
		expect(() => parseUrlContentWebviewMessage(revocable.proxy)).not.toThrow();
		expect(isUrlContentWebviewMessageType(revocable.proxy)).toBe(true);
		expect(parseUrlContentWebviewMessage(revocable.proxy)).toMatchObject({ ok: false });
	});

	it('atomically snapshots the discriminator and claims callable envelopes', () => {
		const request = {
			type: 'fetchUrl', boxId: 'url-section', url: 'https://example.com/data.csv', requestId: 'request-1',
		} as const;
		let typeInspections = 0;
		const requestProxy = new Proxy(request, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
		});

		const admission = admitUrlContentWebviewMessage(requestProxy);
		expect(admission).toEqual({ recognized: true, parsed: { ok: true, value: request } });
		expect(typeInspections).toBe(1);

		const callable = Object.assign(() => undefined, request);
		const callableAdmission = admitUrlContentWebviewMessage(callable);
		expect(callableAdmission).toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isUrlContentWebviewMessageType(callable)).toBe(true);

		const revokedCallable = Proxy.revocable(Object.assign(() => undefined, request), {});
		revokedCallable.revoke();
		expect(() => admitUrlContentWebviewMessage(revokedCallable.proxy)).not.toThrow();
		expect(admitUrlContentWebviewMessage(revokedCallable.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });

		const hostCallable = Object.assign(() => undefined, {
			type: 'urlError', boxId: 'url-section', requestId: 'request-1',
			requestedUrl: '', error: 'Invalid URL.',
		});
		expect(admitUrlContentHostMessage(hostCallable))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('bounds cyclic and unbounded proxy prototype inspection', () => {
		const target = {};
		let cyclicProxy: object;
		cyclicProxy = new Proxy(target, {
			getPrototypeOf: () => cyclicProxy,
		});
		let unboundedPrototypeReads = 0;
		const createUnboundedProxy = (): object => new Proxy({}, {
			getPrototypeOf() {
				unboundedPrototypeReads++;
				return createUnboundedProxy();
			},
		});

		expect(isUrlContentWebviewMessageType(cyclicProxy)).toBe(true);
		expect(parseUrlContentWebviewMessage(cyclicProxy)).toMatchObject({ ok: false });
		expect(isUrlContentHostMessageType(createUnboundedProxy())).toBe(true);
		expect(unboundedPrototypeReads).toBe(16);
	});

	it('snapshots valid proxy envelopes without invoking property reads', () => {
		let propertyReads = 0;
		const request = {
			type: 'fetchUrl', boxId: 'url-section', url: 'https://example.com/data.csv', requestId: 'request-1',
		};
		const requestProxy = new Proxy(request, {
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});
		const delivery = {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-1',
			requestedUrl: 'https://example.com/data.csv', url: 'https://example.com/data.csv',
			contentType: 'text/csv', status: 200, byteLength: 10,
			kind: 'csv', body: 'Name\nalpha', truncated: false,
		};
		const deliveryProxy = new Proxy(delivery, {
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});

		expect(parseUrlContentWebviewMessage(requestProxy)).toEqual({ ok: true, value: request });
		expect(parseUrlContentHostMessage(deliveryProxy)).toEqual({ ok: true, value: delivery });
		expect(propertyReads).toBe(0);
	});

	it('claims and rejects malformed recognized requests', () => {
		const valid = {
			type: 'fetchUrl', boxId: 'url-section', url: 'https://example.com/data.csv', requestId: 'request-1',
		} as const;
		for (const request of [
			Object.assign([], valid),
			{ ...valid, boxId: 42 },
			{ ...valid, boxId: '   ' },
			{ ...valid, url: null },
			{ ...valid, requestId: [] },
			{ ...valid, requestId: '' },
		]) {
			expect(isUrlContentWebviewMessageType(request)).toBe(true);
			expect(parseUrlContentWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('claims and rejects malformed identities, kinds, and numeric metadata', () => {
		const valid = {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-1',
			requestedUrl: 'https://example.com/data.csv', url: 'https://example.com/data.csv',
			contentType: 'text/csv', status: 200, byteLength: 10,
			kind: 'csv', body: 'Name\nalpha', truncated: false,
		} as const;
		for (const delivery of [
			Object.assign([], valid),
			{ ...valid, boxId: '' },
			{ ...valid, requestId: 1 },
			{ ...valid, requestedUrl: null },
			{ ...valid, url: [] },
			{ ...valid, contentType: 42 },
			{ ...valid, kind: ['csv'] },
			{ ...valid, kind: 'binary' },
			{ ...valid, status: 199 },
			{ ...valid, status: 300 },
			{ ...valid, status: -1 },
			{ ...valid, status: 200.5 },
			{ ...valid, status: Number.NaN },
			{ ...valid, status: Number.POSITIVE_INFINITY },
			{ ...valid, byteLength: -1 },
			{ ...valid, byteLength: 1.5 },
		]) {
			expect(isUrlContentHostMessageType(delivery)).toBe(true);
			expect(parseUrlContentHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('requires exclusive image and text success branches', () => {
		const image = {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-image',
			requestedUrl: 'https://example.com/image', url: 'https://example.com/image.png',
			contentType: 'image/png', status: 200, byteLength: 4,
			kind: 'image', dataUri: 'data:image/png;base64,iVBORw==',
		} as const;
		const text = {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-text',
			requestedUrl: 'https://example.com/text', url: 'https://example.com/text',
			contentType: 'text/plain', status: 200, byteLength: 0,
			kind: 'text', body: '', truncated: false,
		} as const;
		for (const delivery of [
			{ ...image, dataUri: 42 },
			{ ...image, dataUri: '' },
			{ ...image, contentType: '' },
			{ ...image, body: undefined },
			{ ...image, truncated: false },
			{ ...text, body: undefined },
			{ ...text, truncated: 'no' },
			{ ...text, dataUri: undefined },
			{ ...text, error: undefined },
		]) {
			expect(parseUrlContentHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('requires canonical errors without success fields', () => {
		const error = {
			type: 'urlError', boxId: 'url-section', requestId: 'request-error',
			requestedUrl: '', error: 'Invalid URL.',
		} as const;
		for (const delivery of [
			{ ...error, error: 42 },
			{ ...error, error: '' },
			{ ...error, error: '   ' },
			{ ...error, kind: undefined },
			{ ...error, body: '' },
			{ ...error, dataUri: '' },
			{ ...error, status: 0 },
		]) {
			expect(parseUrlContentHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('allows missing text content type but requires exact nonblank success URLs', () => {
		const text = {
			type: 'urlContent', boxId: 'url-section', requestId: 'request-text',
			requestedUrl: 'https://example.com/text', url: 'https://example.com/text',
			contentType: '', status: 204, byteLength: 0,
			kind: 'text', body: '', truncated: false,
		} as const;
		expect(parseUrlContentHostMessage(text)).toEqual({ ok: true, value: text });
		expect(parseUrlContentHostMessage({ ...text, requestedUrl: '' })).toMatchObject({ ok: false });
		expect(parseUrlContentHostMessage({ ...text, url: '   ' })).toMatchObject({ ok: false });
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isUrlContentWebviewMessageType({ type: 'resolveResourceUri' })).toBe(false);
		expect(isUrlContentHostMessageType({ type: 'pythonResult' })).toBe(false);
		expect(parseUrlContentWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseUrlContentWebviewMessage({ type: 'urlContent' })).toMatchObject({ ok: false });
		expect(parseUrlContentHostMessage([])).toMatchObject({ ok: false });
		expect(parseUrlContentHostMessage({ type: 'fetchUrl' })).toMatchObject({ ok: false });
	});
});