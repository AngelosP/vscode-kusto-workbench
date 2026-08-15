import { describe, expect, it } from 'vitest';

import {
	admitToolStateSnapshotHostMessage,
	admitToolStateSnapshotHostMessageFromEnvelope,
	admitToolStateSnapshotWebviewMessage,
	admitToolStateSnapshotWebviewMessageFromEnvelope,
	createRequestToolStateMessage,
	createToolStateResponseMessage,
	parseToolStateSnapshotHostMessage,
	parseToolStateSnapshotWebviewMessage,
} from '../../src/shared/toolStateSnapshotProtocol.js';
import { captureRuntimeMessageEnvelope } from '../../src/shared/runtimeMessageEnvelope.js';

function canonicalSections() {
	return [
		{
			type: 'query',
			id: 'query-1',
			connectionId: 'connection-1',
			database: 'Samples',
			lifecycle: { sectionInstanceId: 'instance-1', targetGeneration: 3 },
			columns: ['State', 'Count'],
			optional: undefined,
		},
		{
			type: 'sql',
			id: 'sql-1',
			connectionId: 'sql-connection-1',
			database: 'SqlDatabase',
			ownerToken: 'owner-1',
		},
	];
}

describe('tool-state snapshot protocol', () => {
	it('constructs exact default and schema-refresh requests', () => {
		expect(createRequestToolStateMessage('state-1')).toEqual({
			ok: true,
			value: { type: 'requestToolState', requestId: 'state-1' },
		});
		expect(createRequestToolStateMessage('state-2', 'schema-refresh', ' connection-1 ')).toEqual({
			ok: true,
			value: {
				type: 'requestToolState',
				requestId: 'state-2',
				purpose: 'schema-refresh',
				targetConnectionId: ' connection-1 ',
			},
		});
		expect(createRequestToolStateMessage('   ')).toMatchObject({ ok: false });
	});

	it('captures dense Kusto and SQL section snapshots without normalizing values', () => {
		const sections = canonicalSections();
		const parsed = createToolStateResponseMessage(' state-1 ', sections, '');

		expect(parsed).toEqual({
			ok: true,
			value: { type: 'toolStateResponse', requestId: ' state-1 ', sections, error: '' },
		});
		if (!parsed.ok) throw new Error(parsed.error);
		expect(parsed.value.sections).not.toBe(sections);
		expect(parsed.value.sections[0]).not.toBe(sections[0]);
		expect(parsed.value.sections[0].lifecycle).not.toBe(sections[0].lifecycle);
		expect(parsed.value.sections[0].columns).not.toBe(sections[0].columns);
	});

	it('requires exact request fields, purpose, and nonblank correlation identity', () => {
		for (const malformed of [
			{ type: 'requestToolState', requestId: '' },
			{ type: 'requestToolState', requestId: [] },
			{ type: 'requestToolState', requestId: 'state-1', purpose: 'manual' },
			{ type: 'requestToolState', requestId: 'state-1', targetConnectionId: 42 },
			{ type: 'requestToolState', requestId: 'state-1', extra: true },
		]) {
			expect(parseToolStateSnapshotHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('requires a dense canonical section array with typed outer section identity', () => {
		const sparse = new Array(1);
		const inherited = new Array(1);
		Object.setPrototypeOf(inherited, Object.assign(Object.create(Array.prototype), {
			0: { type: 'query', id: 'forged' },
		}));
		let iteratorCalls = 0;
		const operational = [{ type: 'query', id: 'query-1' }];
		operational[Symbol.iterator] = function* () {
			iteratorCalls++;
			yield { type: 'query', id: 'forged' };
		};

		for (const sections of [
			{},
			sparse,
			inherited,
			operational,
			[null],
			[{}],
			[{ type: 42 }],
			[{ type: 'query', id: 42 }],
		]) {
			expect(parseToolStateSnapshotWebviewMessage({
				type: 'toolStateResponse', requestId: 'state-1', sections,
			})).toMatchObject({ ok: false });
		}
		expect(iteratorCalls).toBe(0);
	});

	it('rejects nested accessors, custom prototypes, cycles, and non-finite values trap-free', () => {
		let getterCalls = 0;
		const accessorSection = { type: 'query', id: 'query-1' };
		Object.defineProperty(accessorSection, 'database', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'forged';
			},
		});
		const customNested = Object.assign(Object.create({ inherited: true }), { enabled: true });
		const cyclicSection: Record<string, unknown> = { type: 'query', id: 'query-cycle' };
		cyclicSection.self = cyclicSection;

		for (const section of [
			accessorSection,
			{ type: 'query', id: 'query-2', settings: customNested },
			cyclicSection,
			{ type: 'query', id: 'query-3', height: Number.NaN },
		]) {
			expect(parseToolStateSnapshotWebviewMessage({
				type: 'toolStateResponse', requestId: 'state-1', sections: [section],
			})).toMatchObject({ ok: false });
		}
		expect(getterCalls).toBe(0);
	});

	it('claims malformed recognized descriptors without invoking getters', () => {
		let requestGetterCalls = 0;
		const request = { type: 'requestToolState' };
		Object.defineProperty(request, 'requestId', {
			enumerable: true,
			get() {
				requestGetterCalls++;
				return 'state-1';
			},
		});
		let sectionsGetterCalls = 0;
		const response = { type: 'toolStateResponse', requestId: 'state-1' };
		Object.defineProperty(response, 'sections', {
			enumerable: true,
			get() {
				sectionsGetterCalls++;
				return canonicalSections();
			},
		});

		expect(admitToolStateSnapshotHostMessage(request))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitToolStateSnapshotWebviewMessage(response))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(requestGetterCalls).toBe(0);
		expect(sectionsGetterCalls).toBe(0);
	});

	it('retains original prototype authority across captured envelopes', () => {
		const request = Object.assign(Object.create({ inherited: true }), {
			type: 'requestToolState', requestId: 'state-1',
		});
		const response = Object.assign(Object.create({ inherited: true }), {
			type: 'toolStateResponse', requestId: 'state-1', sections: canonicalSections(),
		});
		const requestEnvelope = captureRuntimeMessageEnvelope(request);
		const responseEnvelope = captureRuntimeMessageEnvelope(response);
		if (!requestEnvelope.ok || !responseEnvelope.ok) throw new Error('Expected captured envelopes.');

		expect(admitToolStateSnapshotHostMessageFromEnvelope(requestEnvelope.descriptorSnapshot))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitToolStateSnapshotWebviewMessageFromEnvelope(responseEnvelope.descriptorSnapshot))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('fails closed on descriptor traps, revoked proxies, arrays, and extra response fields', () => {
		const canonical = {
			type: 'toolStateResponse' as const,
			requestId: 'state-1',
			sections: canonicalSections(),
		};
		const descriptorTrap = new Proxy(canonical, {
			ownKeys() {
				throw new Error('ownKeys trap');
			},
		});
		const revoked = Proxy.revocable(canonical, {});
		revoked.revoke();

		expect(() => admitToolStateSnapshotWebviewMessage(descriptorTrap)).not.toThrow();
		expect(admitToolStateSnapshotWebviewMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(() => admitToolStateSnapshotWebviewMessage(revoked.proxy)).not.toThrow();
		expect(admitToolStateSnapshotWebviewMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitToolStateSnapshotWebviewMessage(Object.assign([], canonical)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(parseToolStateSnapshotWebviewMessage({ ...canonical, extra: true }))
			.toMatchObject({ ok: false });
	});

	it('does not claim unrelated traffic', () => {
		expect(admitToolStateSnapshotHostMessage({ type: 'documentData' })).toEqual({ recognized: false });
		expect(admitToolStateSnapshotWebviewMessage({ type: 'toolResponse' })).toEqual({ recognized: false });
	});
});