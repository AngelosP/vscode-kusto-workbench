import { describe, expect, it } from 'vitest';

import {
	admitCopilotInlineCompletionHostMessage,
	admitCopilotInlineCompletionWebviewMessage,
	isCopilotInlineCompletionHostMessageType,
	isCopilotInlineCompletionWebviewMessageType,
	parseCopilotInlineCompletionHostMessage,
	parseCopilotInlineCompletionWebviewMessage,
} from '../../src/shared/copilotInlineCompletionProtocol.js';

function canonicalRequest() {
	return {
		type: 'requestCopilotInlineCompletion' as const,
		requestId: ' inline-1 ',
		boxId: ' query-1 ',
		textBefore: 'StormEvents\n| ',
		textAfter: '\n| take 10',
		flavor: 'kusto' as const,
		ownerToken: ' owner-1 ',
	};
}

function canonicalResult() {
	return {
		type: 'copilotInlineCompletionResult' as const,
		requestId: ' inline-1 ',
		boxId: ' query-1 ',
		ownerToken: ' owner-1 ',
		completions: [{ insertText: '| where State == "WA"' }, { insertText: '' }],
		error: '',
	};
}

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

describe('Copilot inline-completion protocol', () => {
	it('snapshots requests and results without normalizing exact values', () => {
		const request = canonicalRequest();
		const result = canonicalResult();
		const parsedRequest = parseCopilotInlineCompletionWebviewMessage(request);
		const parsedResult = parseCopilotInlineCompletionHostMessage(result);

		expect(parsedRequest).toEqual({ ok: true, value: request });
		expect(parsedResult).toEqual({ ok: true, value: result });
		if (parsedRequest.ok) expect(parsedRequest.value).not.toBe(request);
		if (parsedResult.ok) {
			expect(parsedResult.value).not.toBe(result);
			expect(parsedResult.value.completions).not.toBe(result.completions);
			expect(parsedResult.value.completions[0]).not.toBe(result.completions[0]);
		}
	});

	it('accepts omitted optional fields, empty text, and dense empty completions', () => {
		const request = Object.assign(Object.create(null), {
			type: 'requestCopilotInlineCompletion', requestId: '', boxId: '', textBefore: '', textAfter: '',
		});
		const result = Object.assign(Object.create(null), {
			type: 'copilotInlineCompletionResult', requestId: '', boxId: '', completions: [],
		});

		expect(parseCopilotInlineCompletionWebviewMessage(request)).toEqual({
			ok: true,
			value: { type: 'requestCopilotInlineCompletion', requestId: '', boxId: '', textBefore: '', textAfter: '' },
		});
		expect(parseCopilotInlineCompletionHostMessage(result)).toEqual({
			ok: true,
			value: { type: 'copilotInlineCompletionResult', requestId: '', boxId: '', completions: [] },
		});
	});

	it('requires exact request and result scalar types', () => {
		const request = canonicalRequest();
		for (const malformed of [
			{ ...request, requestId: 1 },
			{ ...request, boxId: [] },
			{ ...request, textBefore: null },
			{ ...request, textAfter: {} },
			{ ...request, flavor: 'python' },
			{ ...request, flavor: ['kusto'] },
			{ ...request, ownerToken: ['owner-1'] },
		]) {
			expect(parseCopilotInlineCompletionWebviewMessage(malformed)).toMatchObject({ ok: false });
		}

		const result = canonicalResult();
		for (const malformed of [
			{ ...result, requestId: {} },
			{ ...result, boxId: false },
			{ ...result, ownerToken: ['owner-1'] },
			{ ...result, error: 42 },
		]) {
			expect(parseCopilotInlineCompletionHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('requires dense canonical completion arrays and own string insertText fields', () => {
		const result = canonicalResult();
		const sparse = new Array(1);
		const inherited = new Array(1);
		Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {
			0: { insertText: 'forged' },
		}));
		let iteratorCalls = 0;
		const operational = [{ insertText: 'canonical' }];
		operational[Symbol.iterator] = function* () {
			iteratorCalls++;
			yield { insertText: 'forged' };
		};
		let getterCalls = 0;
		const accessorCompletion = {};
		Object.defineProperty(accessorCompletion, 'insertText', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'forged';
			},
		});

		for (const completions of [
			{}, sparse, inherited, operational, [null], [{ insertText: 42 }],
			[inheritField({ insertText: 'forged' }, 'insertText')], [accessorCompletion],
		]) {
			expect(parseCopilotInlineCompletionHostMessage({ ...result, completions }))
				.toMatchObject({ ok: false });
		}
		expect(iteratorCalls).toBe(0);
		expect(getterCalls).toBe(0);
	});

	it('claims inherited, non-enumerable, accessor, and callable recognized traffic', () => {
		const request = canonicalRequest();
		for (const key of ['type', 'requestId', 'boxId', 'textBefore', 'textAfter', 'flavor', 'ownerToken']) {
			const inherited = inheritField(request, key);
			expect(isCopilotInlineCompletionWebviewMessageType(inherited)).toBe(true);
			expect(parseCopilotInlineCompletionWebviewMessage(inherited)).toMatchObject({ ok: false });
		}

		const result = canonicalResult();
		for (const key of ['ownerToken', 'error']) {
			expect(parseCopilotInlineCompletionHostMessage(inheritField(result, key)))
				.toMatchObject({ ok: false });
		}
		const nonEnumerable = { ...result };
		Object.defineProperty(nonEnumerable, 'completions', { value: result.completions, enumerable: false });
		expect(parseCopilotInlineCompletionHostMessage(nonEnumerable)).toMatchObject({ ok: false });

		let getterCalls = 0;
		const accessor = { type: 'copilotInlineCompletionResult', requestId: 'inline-1', boxId: 'query-1' };
		Object.defineProperty(accessor, 'completions', {
			enumerable: true,
			get() {
				getterCalls++;
				return [];
			},
		});
		expect(admitCopilotInlineCompletionHostMessage(accessor))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(getterCalls).toBe(0);
		expect(admitCopilotInlineCompletionWebviewMessage(Object.assign(() => undefined, request)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitCopilotInlineCompletionHostMessage(Object.assign(() => undefined, result)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('atomically snapshots valid proxies without property reads', () => {
		const request = canonicalRequest();
		let typeInspections = 0;
		let propertyReads = 0;
		const proxy = new Proxy(request, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});

		expect(admitCopilotInlineCompletionWebviewMessage(proxy)).toEqual({
			recognized: true,
			parsed: { ok: true, value: request },
		});
		expect(typeInspections).toBe(1);
		expect(propertyReads).toBe(0);
	});

	it('rejects cyclic, trapped, and custom completion-record prototypes', () => {
		const result = canonicalResult();
		let cyclicCompletion: object;
		cyclicCompletion = new Proxy({ insertText: 'forged' }, {
			getPrototypeOf: () => cyclicCompletion,
		});
		const trappedCompletion = new Proxy({ insertText: 'forged' }, {
			getPrototypeOf() {
				throw new Error('prototype trap');
			},
		});
		const customPrototypeCompletion = Object.assign(Object.create({ extra: true }), {
			insertText: 'forged',
		});

		for (const completion of [cyclicCompletion, trappedCompletion, customPrototypeCompletion]) {
			expect(parseCopilotInlineCompletionHostMessage({ ...result, completions: [completion] }))
				.toMatchObject({ ok: false });
		}
	});

	it('fails closed on descriptor traps, revoked proxies, and bounded prototype inspection', () => {
		const result = canonicalResult();
		const descriptorTrap = new Proxy(result, {
			getOwnPropertyDescriptor() {
				throw new Error('descriptor trap');
			},
		});
		const revoked = Proxy.revocable(result, {});
		revoked.revoke();
		let cyclicProxy: object;
		cyclicProxy = new Proxy({}, { getPrototypeOf: () => cyclicProxy });
		let unboundedPrototypeReads = 0;
		const createUnboundedProxy = (): object => new Proxy({}, {
			getPrototypeOf() {
				unboundedPrototypeReads++;
				return createUnboundedProxy();
			},
		});

		expect(() => admitCopilotInlineCompletionHostMessage(descriptorTrap)).not.toThrow();
		expect(admitCopilotInlineCompletionHostMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(() => admitCopilotInlineCompletionHostMessage(revoked.proxy)).not.toThrow();
		expect(admitCopilotInlineCompletionHostMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitCopilotInlineCompletionHostMessage(cyclicProxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isCopilotInlineCompletionHostMessageType(createUnboundedProxy())).toBe(true);
		expect(unboundedPrototypeReads).toBe(16);
	});

	it('rejects cyclic, trapped, and custom top-level prototypes with recognized own types', () => {
		const request = canonicalRequest();
		let cyclicRequest: object;
		cyclicRequest = new Proxy(request, { getPrototypeOf: () => cyclicRequest });
		const trappedResult = new Proxy(canonicalResult(), {
			getPrototypeOf() {
				throw new Error('prototype trap');
			},
		});
		const customPrototypeResult = Object.assign(Object.create({ extra: true }), canonicalResult());

		expect(admitCopilotInlineCompletionWebviewMessage(cyclicRequest))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitCopilotInlineCompletionHostMessage(trappedResult))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitCopilotInlineCompletionHostMessage(customPrototypeResult))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('does not claim unrelated traffic and rejects unknown parser input', () => {
		expect(admitCopilotInlineCompletionWebviewMessage({ type: 'fetchUrl' })).toEqual({ recognized: false });
		expect(admitCopilotInlineCompletionHostMessage({ type: 'urlContent' })).toEqual({ recognized: false });
		expect(parseCopilotInlineCompletionWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseCopilotInlineCompletionHostMessage({ type: 'requestCopilotInlineCompletion' }))
			.toMatchObject({ ok: false });
	});
});