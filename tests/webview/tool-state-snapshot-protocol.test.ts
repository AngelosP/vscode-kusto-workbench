import { describe, expect, it, vi } from 'vitest';

import {
	admitToolStateSnapshotHostMessage,
	admitToolStateSnapshotHostMessageFromEnvelope,
	admitToolStateSnapshotWebviewMessage,
	admitToolStateSnapshotWebviewMessageFromEnvelope,
	captureExpectedKustoTarget,
	captureToolStateSections,
	createRequestToolStateMessage,
	createToolStateResponseMessage,
	parseToolStateSnapshotHostMessage,
	parseToolStateSnapshotWebviewMessage,
	type ToolStateResponseMessage,
} from '../../src/shared/toolStateSnapshotProtocol.js';
import { captureRuntimeMessageEnvelope, isRuntimeProxy } from '../../src/shared/runtimeMessageEnvelope.js';

function canonicalSections() {
	return [
		{
			type: 'query',
			id: 'query-1',
			connectionId: 'connection-1',
			clusterUrl: 'https://cluster.kusto.windows.net',
			database: 'Samples',
			sectionInstanceId: 'instance-1',
			targetGeneration: 3,
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
		const captured = captureToolStateSections(sections);
		expect(captured).toEqual({ ok: true, value: parsed.value.sections });
		if (!captured.ok) throw new Error(captured.error);
		expect(Object.isFrozen(captured.value)).toBe(true);
		expect(Object.isFrozen(captured.value[0])).toBe(true);
		expect(Object.isFrozen(captured.value[0].lifecycle)).toBe(true);
		expect(Object.isFrozen(captured.value[0].columns)).toBe(true);
	});

	it('keeps runtime target metadata optional for legacy persistence snapshots but validates supplied fields', () => {
		const legacy = { type: 'query', id: 'query-1', query: '', future: { retained: [false, null, 0] } };
		expect(captureToolStateSections([legacy])).toEqual({ ok: true, value: [legacy] });
		for (const key of ['sectionInstanceId', 'connectionId', 'clusterUrl', 'database']) {
			expect(captureToolStateSections([{ ...legacy, [key]: undefined }])).toMatchObject({ ok: true });
			for (const value of [null, 1, false, {}, []]) {
				expect(captureToolStateSections([{ ...legacy, [key]: value }])).toMatchObject({ ok: false });
			}
		}
		for (const targetGeneration of [undefined, 0, 7, Number.MAX_SAFE_INTEGER]) {
			expect(captureToolStateSections([{ ...legacy, targetGeneration }])).toMatchObject({ ok: true });
		}
		for (const targetGeneration of [null, '7', -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(captureToolStateSections([{ ...legacy, targetGeneration }])).toMatchObject({ ok: false });
		}
	});

	it('captures only a complete immutable expected Kusto target without normalizing exact values', () => {
		const input = {
			sectionId: 'query-1', sectionInstanceId: 'instance-1', targetGeneration: 7,
			connectionId: 'connection-1', clusterUrl: 'https://CLUSTER.kusto.windows.net/', database: ' Samples ',
		};
		const captured = captureExpectedKustoTarget(input);
		expect(captured).toEqual({ ok: true, value: input });
		if (!captured.ok) throw new Error(captured.error);
		expect(Object.isFrozen(captured.value)).toBe(true);
		input.database = 'ChangedAfterCapture';
		expect(captured.value.database).toBe(' Samples ');
		for (const key of ['sectionId', 'sectionInstanceId', 'connectionId', 'clusterUrl', 'database']) {
			for (const value of [undefined, '', ' ', 1, false, {}, []]) {
				expect(captureExpectedKustoTarget({ ...input, [key]: value })).toMatchObject({ ok: false });
			}
		}
		for (const targetGeneration of [undefined, null, '7', -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
			expect(captureExpectedKustoTarget({ ...input, targetGeneration })).toMatchObject({ ok: false });
		}
		expect(captureExpectedKustoTarget({ ...input, query: 'print injected=1' })).toMatchObject({ ok: false });
		expect(captureExpectedKustoTarget({ ...input, targetGeneration: 0 })).toMatchObject({ ok: true });
	});

	it('rejects accessor, inherited, and non-enumerable expected target fields without invoking getters', () => {
		const input = {
			sectionId: 'query-1', sectionInstanceId: 'instance-1', targetGeneration: 7,
			connectionId: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net', database: 'Samples',
		};
		const getDatabase = vi.fn(() => 'Forged');
		for (const candidate of [
			Object.defineProperty({ ...input }, 'database', { enumerable: true, get: getDatabase }),
			Object.defineProperty({ ...input }, 'targetGeneration', { enumerable: false, value: 7 }),
			Object.create(input),
		]) expect(captureExpectedKustoTarget(candidate)).toMatchObject({ ok: false });
		expect(getDatabase).not.toHaveBeenCalled();
	});

	it('keeps the exact 16 Mi-character snapshot limit including object keys', () => {
		const payload = 'x'.repeat(16 * 1024 * 1024 - 'typequerypayload'.length);
		expect(captureToolStateSections([{ type: 'query', payload }])).toMatchObject({ ok: true });
		expect(captureToolStateSections([{ type: 'query', payload: `${payload}x` }])).toEqual({
			ok: false, error: 'Tool state exceeds the snapshot string limit.',
		});
		expect(captureToolStateSections([{ type: 'query', payload, extra: null }])).toEqual({
			ok: false, error: 'Tool state exceeds the snapshot string limit.',
		});
	});

	it('keeps the exact 250,000-value snapshot limit', () => {
		const payload = Array.from({ length: 25 }, (_value, index) =>
			new Array(index === 24 ? 9_995 : 9_999).fill(null),
		);
		expect(captureToolStateSections([{ type: 'query', payload }])).toMatchObject({ ok: true });
		payload[24].push(null);
		expect(captureToolStateSections([{ type: 'query', payload }])).toEqual({
			ok: false, error: 'Tool state exceeds the snapshot value limit.',
		});
	});

	it('keeps the exact depth-64 snapshot limit', () => {
		let payload: Record<string, unknown> = { leaf: true };
		for (let index = 0; index < 62; index++) payload = { child: payload };
		expect(captureToolStateSections([{ type: 'query', payload }])).toMatchObject({ ok: true });
		const overflow = captureToolStateSections([{ type: 'query', payload: { child: payload } }]);
		expect(overflow.ok).toBe(false);
		if (overflow.ok) throw new Error('Expected the snapshot depth limit.');
		expect(overflow.error).toMatch(/exceeds the snapshot depth limit\.$/);
	});

	it.each(['array', 'object'])('keeps the exact 10,000-entry %s limit', (kind) => {
		const payload = kind === 'array'
			? new Array(10_000).fill(null)
			: Object.fromEntries(Array.from({ length: 10_000 }, (_value, index) => [String(index), null]));
		expect(captureToolStateSections([{ type: 'query', payload }])).toMatchObject({ ok: true });
		if (Array.isArray(payload)) payload.push(null);
		else Object.defineProperty(payload, 'overflow', { value: null, enumerable: true });
		expect(captureToolStateSections([{ type: 'query', payload }])).toEqual({
			ok: false,
			error: kind === 'array'
				? 'sections[0].payload exceeds the array entry limit.'
				: 'sections[0].payload exceeds the object field limit.',
		});
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

	describe.runIf(isRuntimeProxy(new Proxy({}, {})))('Node top-level proxy admission', () => {
		it.each(['host', 'webview'].flatMap(direction => ['direct', 'captured'].map(path => ({ direction, path }))))(
			'rejects a top-level proxy through $direction $path admission before nested reflection', ({ direction, path }) => {
				const sections = canonicalSections();
				const proxy = new Proxy(direction === 'host'
					? { type: 'requestToolState', requestId: 'proxy-state' }
					: { type: 'toolStateResponse', requestId: 'proxy-state', sections }, {});
				const captured = captureRuntimeMessageEnvelope(proxy);
				if (!captured.ok) throw new Error(captured.error);
				const inspect = vi.spyOn(Object, 'getOwnPropertyDescriptors');
				try {
					const admission = direction === 'host'
						? path === 'direct' ? admitToolStateSnapshotHostMessage(proxy) : admitToolStateSnapshotHostMessageFromEnvelope(captured.descriptorSnapshot)
						: path === 'direct' ? admitToolStateSnapshotWebviewMessage(proxy) : admitToolStateSnapshotWebviewMessageFromEnvelope(captured.descriptorSnapshot);
					expect(admission).toMatchObject({ recognized: true, parsed: { ok: false } });
					expect(inspect).not.toHaveBeenCalledWith(sections);
					expect(inspect).not.toHaveBeenCalledWith(sections[0]);
				} finally {
					inspect.mockRestore();
				}
			},
		);

		it.each(['direct', 'captured'])('keeps the pending consumer and exact timer live after a top-level proxy through %s admission', async (path) => {
			vi.useFakeTimers();
			const requestId = 'proxy-pending';
			let resolvePromise!: (value: ToolStateResponseMessage) => void;
			const completion = new Promise<ToolStateResponseMessage>(resolve => { resolvePromise = resolve; });
			const timeout = vi.fn();
			const waiter = { resolve: vi.fn(resolvePromise), timer: setTimeout(timeout, 5_000) };
			const pending = new Map([[requestId, waiter]]);
			const reconcile = vi.fn();
			const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
			const consume = (input: unknown) => {
				const captured = path === 'captured' ? captureRuntimeMessageEnvelope(input) : undefined;
				if (captured && !captured.ok) throw new Error(captured.error);
				const admission = captured?.ok
					? admitToolStateSnapshotWebviewMessageFromEnvelope(captured.descriptorSnapshot)
					: admitToolStateSnapshotWebviewMessage(input);
				if (!admission.recognized || !admission.parsed.ok) return;
				const current = pending.get(admission.parsed.value.requestId);
				if (!current) return;
				pending.delete(admission.parsed.value.requestId);
				clearTimeout(current.timer);
				reconcile(admission.parsed.value.sections);
				current.resolve(admission.parsed.value);
			};
			try {
				const response = { type: 'toolStateResponse', requestId, sections: canonicalSections() };
				consume(new Proxy(response, {}));
				await Promise.resolve();
				expect(pending.get(requestId)).toBe(waiter);
				expect(clearTimer).not.toHaveBeenCalled();
				expect(waiter.resolve).not.toHaveBeenCalled();
				expect(reconcile).not.toHaveBeenCalled();
				expect(vi.getTimerCount()).toBe(1);
				vi.advanceTimersByTime(4_999);
				expect(timeout).not.toHaveBeenCalled();
				consume(response);
				expect(await completion).toEqual(response);
				consume(response);
				vi.advanceTimersByTime(1);
				expect(pending.size).toBe(0);
				expect(waiter.resolve).toHaveBeenCalledOnce();
				expect(reconcile).toHaveBeenCalledExactlyOnceWith(response.sections);
				expect(clearTimer).toHaveBeenCalledExactlyOnceWith(waiter.timer);
				expect(timeout).not.toHaveBeenCalled();
			} finally {
				clearTimer.mockRestore();
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		});
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