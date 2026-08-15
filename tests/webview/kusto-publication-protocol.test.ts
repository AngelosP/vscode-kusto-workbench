import { describe, expect, it } from 'vitest';

import {
	admitKustoPublicationHostMessage,
	admitKustoPublicationWebviewMessage,
	isKustoPublicationHostMessageType,
	parseKustoPublicationHostMessage,
	parseKustoPublicationWebviewMessage,
} from '../../src/shared/kustoPublicationProtocol.js';

function stage(payload: Record<string, unknown> = { type: 'snapshot', nested: { marker: 'exact' } }) {
	return {
		type: 'kustoPublicationStage' as const,
		publicationId: ' publication-current ',
		publicationDeadline: 1_234.5,
		payload,
	};
}

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

describe('Kusto publication protocol', () => {
	it('captures all four canonical messages without normalizing exact values', () => {
		const nested = { marker: 'exact' };
		const payload = { type: 'snapshot', nested };
		const messages = [
			stage(payload),
			{ type: 'kustoPublicationAck', publicationId: ' publication-current ', phase: 'staged', accepted: false },
			{ type: 'kustoPublicationCommit', publicationId: ' publication-current ' },
			{ type: 'kustoPublicationRevoke', publicationId: ' publication-current ' },
		] as const;

		const parsedStage = parseKustoPublicationHostMessage(messages[0]);
		expect(parsedStage).toEqual({ ok: true, value: messages[0] });
		if (parsedStage.ok) {
			expect(parsedStage.value).not.toBe(messages[0]);
			if (parsedStage.value.type === 'kustoPublicationStage') {
				expect(parsedStage.value.payload).not.toBe(payload);
				expect(parsedStage.value.payload.nested).toBe(nested);
				expect(Object.isFrozen(parsedStage.value.payload)).toBe(true);
			}
		}
		expect(parseKustoPublicationWebviewMessage(messages[1])).toEqual({ ok: true, value: messages[1] });
		expect(parseKustoPublicationHostMessage(messages[2])).toEqual({ ok: true, value: messages[2] });
		expect(parseKustoPublicationHostMessage(messages[3])).toEqual({ ok: true, value: messages[3] });
	});

	it('requires exact scalar fields and canonical message fields', () => {
		for (const malformed of [
			{ ...stage(), publicationId: ['publication-current'] },
			{ ...stage(), publicationId: '' },
			{ ...stage(), publicationDeadline: '1234' },
			{ ...stage(), publicationDeadline: Number.POSITIVE_INFINITY },
			{ ...stage(), extra: true },
		]) {
			expect(parseKustoPublicationHostMessage(malformed)).toMatchObject({ ok: false });
		}
		for (const malformed of [
			{ type: 'kustoPublicationAck', publicationId: ['publication-current'], phase: 'staged', accepted: true },
			{ type: 'kustoPublicationAck', publicationId: 'publication-current', phase: ['staged'], accepted: true },
			{ type: 'kustoPublicationAck', publicationId: 'publication-current', phase: 'committed', accepted: true },
			{ type: 'kustoPublicationAck', publicationId: 'publication-current', phase: 'applied', accepted: 1 },
		]) {
			expect(parseKustoPublicationWebviewMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('claims inherited, non-enumerable, accessor, array, and callable recognized traffic without getters', () => {
		for (const key of ['type', 'publicationId', 'publicationDeadline', 'payload']) {
			const inherited = inheritField(stage(), key);
			expect(isKustoPublicationHostMessageType(inherited)).toBe(true);
			expect(parseKustoPublicationHostMessage(inherited)).toMatchObject({ ok: false });
		}
		const nonEnumerable = stage();
		Object.defineProperty(nonEnumerable, 'publicationId', { value: 'publication-current', enumerable: false });
		expect(parseKustoPublicationHostMessage(nonEnumerable)).toMatchObject({ ok: false });

		let getterCalls = 0;
		const accessor = {
			type: 'kustoPublicationAck', publicationId: 'publication-current', phase: 'applied',
		};
		Object.defineProperty(accessor, 'accepted', {
			enumerable: true,
			get() { getterCalls += 1; return true; },
		});
		expect(admitKustoPublicationWebviewMessage(accessor))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(getterCalls).toBe(0);
		expect(admitKustoPublicationHostMessage(Object.assign(() => undefined, stage())))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitKustoPublicationHostMessage(Object.assign([], stage())))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('captures opaque payload descriptors and rejects unsafe payload records', () => {
		let getterCalls = 0;
		const accessorPayload = { type: 'snapshot' };
		Object.defineProperty(accessorPayload, 'forged', {
			enumerable: true,
			get() { getterCalls += 1; return true; },
		});
		const nonEnumerablePayload = { type: 'snapshot' };
		Object.defineProperty(nonEnumerablePayload, 'hidden', { value: true, enumerable: false });
		const symbolPayload = { type: 'snapshot', [Symbol('hidden')]: true };
		const customPayload = Object.assign(Object.create({ inherited: true }), { type: 'snapshot' });
		const cyclicPayload: Record<string, unknown> = { type: 'snapshot' };
		cyclicPayload.self = cyclicPayload;

		for (const payload of [accessorPayload, nonEnumerablePayload, symbolPayload, customPayload, cyclicPayload]) {
			expect(parseKustoPublicationHostMessage(stage(payload))).toMatchObject({ ok: false });
		}
		expect(getterCalls).toBe(0);
	});

	it('rejects a shape-varying envelope aliased as its own payload after one snapshot', () => {
		let ownKeysCalls = 0;
		const target: Record<string, unknown> = {
			type: 'kustoPublicationStage',
			publicationId: 'publication-self-payload',
			publicationDeadline: 1_234.5,
			kind: 'snapshot',
		};
		let selfPayload!: Record<string, unknown>;
		selfPayload = new Proxy(target, {
			ownKeys() {
				ownKeysCalls++;
				return ownKeysCalls === 1
					? ['type', 'publicationId', 'publicationDeadline', 'payload']
					: ['kind'];
			},
			getOwnPropertyDescriptor(candidate, key) {
				if (key === 'payload') {
					return { configurable: true, enumerable: true, writable: true, value: selfPayload };
				}
				return Reflect.getOwnPropertyDescriptor(candidate, key);
			},
		});

		expect(admitKustoPublicationHostMessage(selfPayload))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(ownKeysCalls).toBe(1);

		let wrappedOwnKeysCalls = 0;
		let shapeVaryingStage!: Record<string, unknown>;
		let wrappedPayload!: Record<string, unknown>;
		shapeVaryingStage = new Proxy(target, {
			ownKeys() {
				wrappedOwnKeysCalls++;
				return wrappedOwnKeysCalls === 1
					? ['type', 'publicationId', 'publicationDeadline', 'payload']
					: ['kind'];
			},
			getOwnPropertyDescriptor(candidate, key) {
				if (key === 'payload') {
					return { configurable: true, enumerable: true, writable: true, value: wrappedPayload };
				}
				return Reflect.getOwnPropertyDescriptor(candidate, key);
			},
		});
		wrappedPayload = new Proxy(shapeVaryingStage, {});
		expect(admitKustoPublicationHostMessage(shapeVaryingStage))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(wrappedOwnKeysCalls).toBe(1);
	});

	it('atomically captures a valid proxy without property reads', () => {
		const message = stage();
		let typeInspections = 0;
		let propertyReads = 0;
		const proxy = new Proxy(message, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get() {
				propertyReads += 1;
				throw new Error('property read');
			},
		});

		expect(admitKustoPublicationHostMessage(proxy)).toEqual({
			recognized: true,
			parsed: { ok: true, value: message },
		});
		expect(typeInspections).toBe(1);
		expect(propertyReads).toBe(0);
	});

	it('fails closed on descriptor traps, revoked proxies, and cyclic or unbounded prototypes', () => {
		const descriptorTrap = new Proxy(stage(), {
			ownKeys() { throw new Error('descriptor trap'); },
		});
		const revoked = Proxy.revocable(stage(), {});
		revoked.revoke();
		let cyclicProxy: object;
		cyclicProxy = new Proxy(stage(), { getPrototypeOf: () => cyclicProxy });
		let unboundedPrototypeReads = 0;
		const createUnboundedProxy = (): object => new Proxy({}, {
			getPrototypeOf() {
				unboundedPrototypeReads += 1;
				return createUnboundedProxy();
			},
		});

		expect(() => admitKustoPublicationHostMessage(descriptorTrap)).not.toThrow();
		expect(admitKustoPublicationHostMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitKustoPublicationHostMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitKustoPublicationHostMessage(cyclicProxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isKustoPublicationHostMessageType(createUnboundedProxy())).toBe(true);
		expect(unboundedPrototypeReads).toBe(16);
	});

	it('does not claim unrelated typed traffic', () => {
		expect(admitKustoPublicationHostMessage({ type: 'connectionsData' })).toEqual({ recognized: false });
		expect(admitKustoPublicationWebviewMessage({ type: 'executeQuery' })).toEqual({ recognized: false });
	});
});