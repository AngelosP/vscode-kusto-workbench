import { describe, expect, it } from 'vitest';

import {
	admitQuerySharingHostMessage,
	admitQuerySharingWebviewMessage,
	isQuerySharingHostMessageType,
	isQuerySharingWebviewMessageType,
	parseQuerySharingHostMessage,
	parseQuerySharingWebviewMessage,
} from '../../src/shared/querySharingProtocol.js';

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

function canonicalShare() {
	return {
		type: 'shareToClipboard' as const,
		engine: 'kusto' as const,
		boxId: ' query-1 ',
		includeTitle: true,
		includeQuery: false,
		includeResults: true,
		sectionName: '',
		queryText: ' StormEvents | take 10 ',
		connectionId: ' connection-1 ',
		database: ' Samples ',
		columns: ['State', 'Count'],
		rowsData: [['WA', '10'], ['', '0']],
		totalRows: 25,
	};
}

describe('query sharing protocol', () => {
	it('snapshots both requests and the delivery without normalizing exact values', () => {
		const copy = {
			type: 'copyAdeLink' as const,
			query: '', connectionId: '', database: '', boxId: '',
		};
		const share = canonicalShare();
		const delivery = {
			type: 'shareContentReady' as const,
			html: '', text: '',
		};

		const parsedCopy = parseQuerySharingWebviewMessage(copy);
		const parsedShare = parseQuerySharingWebviewMessage(share);
		const parsedDelivery = parseQuerySharingHostMessage(delivery);
		expect(parsedCopy).toEqual({ ok: true, value: copy });
		expect(parsedShare).toEqual({ ok: true, value: share });
		expect(parsedDelivery).toEqual({ ok: true, value: delivery });
		if (parsedCopy.ok) expect(parsedCopy.value).not.toBe(copy);
		if (parsedShare.ok && parsedShare.value.type === 'shareToClipboard') {
			expect(parsedShare.value).not.toBe(share);
			expect(parsedShare.value.columns).not.toBe(share.columns);
			expect(parsedShare.value.rowsData).not.toBe(share.rowsData);
			expect(parsedShare.value.rowsData[0]).not.toBe(share.rowsData[0]);
		}
		if (parsedDelivery.ok) expect(parsedDelivery.value).not.toBe(delivery);
	});

	it('accepts null-prototype records and dense empty result containers', () => {
		const request = Object.assign(Object.create(null), {
			...canonicalShare(), columns: [], rowsData: [], totalRows: 0,
		});
		const delivery = Object.assign(Object.create(null), {
			type: 'shareContentReady', html: '<b>Title</b>', text: 'Title',
		});

		expect(parseQuerySharingWebviewMessage(request)).toEqual({
			ok: true,
			value: { ...request, columns: [], rowsData: [] },
		});
		expect(parseQuerySharingHostMessage(delivery)).toEqual({
			ok: true,
			value: { type: 'shareContentReady', html: '<b>Title</b>', text: 'Title' },
		});
	});

	it('claims and rejects inherited, non-enumerable, and accessor fields without invoking getters', () => {
		const copy = {
			type: 'copyAdeLink', query: 'print 1', connectionId: 'connection-1',
			database: 'Samples', boxId: 'query-1',
		};
		for (const key of ['type', 'query', 'connectionId', 'database', 'boxId']) {
			const inherited = inheritField(copy, key);
			expect(isQuerySharingWebviewMessageType(inherited)).toBe(true);
			expect(parseQuerySharingWebviewMessage(inherited)).toMatchObject({ ok: false });
		}

		const nonEnumerable = canonicalShare();
		Object.defineProperty(nonEnumerable, 'columns', { value: nonEnumerable.columns, enumerable: false });
		expect(parseQuerySharingWebviewMessage(nonEnumerable)).toMatchObject({ ok: false });

		let getterCalls = 0;
		const accessorDelivery = { type: 'shareContentReady', text: 'forged' };
		Object.defineProperty(accessorDelivery, 'html', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});
		expect(admitQuerySharingHostMessage(accessorDelivery))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(getterCalls).toBe(0);
	});

	it('requires exact scalar types and non-negative safe total rows', () => {
		const share = canonicalShare();
		for (const malformed of [
			{ ...share, engine: 'python' },
			{ ...share, engine: ['kusto'] },
			{ ...share, boxId: 1 },
			{ ...share, includeTitle: 1 },
			{ ...share, includeQuery: 'yes' },
			{ ...share, includeResults: null },
			{ ...share, sectionName: [] },
			{ ...share, queryText: {} },
			{ ...share, connectionId: false },
			{ ...share, database: 2 },
			{ ...share, totalRows: -1 },
			{ ...share, totalRows: 1.5 },
			{ ...share, totalRows: Number.NaN },
			{ ...share, totalRows: Number.POSITIVE_INFINITY },
		]) {
			expect(parseQuerySharingWebviewMessage(malformed)).toMatchObject({ ok: false });
		}

		for (const malformed of [
			{ type: 'shareContentReady', html: ['forged'], text: 'text' },
			{ type: 'shareContentReady', html: '<b>Title</b>', text: { forged: true } },
		]) {
			expect(parseQuerySharingHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('requires dense string columns and rows without executing array accessors or iterators', () => {
		const share = canonicalShare();
		const sparseColumns = new Array<string>(1);
		const inheritedColumns = new Array<string>(1);
		Object.setPrototypeOf(inheritedColumns, Object.assign(Object.create(Array.prototype), { 0: 'State' }));
		const sparseRow = new Array<string>(1);
		let getterCalls = 0;
		const accessorRow = ['safe'];
		Object.defineProperty(accessorRow, '0', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'forged';
			},
		});
		let iteratorCalls = 0;
		const iteratorColumns = ['State'];
		iteratorColumns[Symbol.iterator] = function* () {
			iteratorCalls++;
			yield 'forged';
		};
		const iteratorRows = [['WA']];
		iteratorRows[Symbol.iterator] = function* () {
			iteratorCalls++;
			yield ['forged'];
		};
		const iteratorRow = ['WA'];
		iteratorRow[Symbol.iterator] = function* () {
			iteratorCalls++;
			yield 'forged';
		};
		let inheritedDescriptorGetterCalls = 0;
		let inheritedDescriptorResult: unknown;
		Object.defineProperty(Object.prototype, '0', {
			configurable: true,
			get() {
				inheritedDescriptorGetterCalls++;
				return { value: 'forged', enumerable: true };
			},
		});
		try {
			inheritedDescriptorResult = parseQuerySharingWebviewMessage({
				...share, columns: sparseColumns,
			});
		} finally {
			delete (Object.prototype as Record<string, unknown>)['0'];
		}

		for (const malformed of [
			{ ...share, columns: ['State', 42] },
			{ ...share, columns: sparseColumns },
			{ ...share, columns: inheritedColumns },
			{ ...share, columns: iteratorColumns },
			{ ...share, rowsData: [['WA', 10]] },
			{ ...share, rowsData: [sparseRow] },
			{ ...share, rowsData: [accessorRow] },
			{ ...share, rowsData: iteratorRows },
			{ ...share, rowsData: [iteratorRow] },
		]) {
			expect(parseQuerySharingWebviewMessage(malformed)).toMatchObject({ ok: false });
		}
		expect(inheritedDescriptorResult).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);
		expect(iteratorCalls).toBe(0);
		expect(inheritedDescriptorGetterCalls).toBe(0);
	});

	it('atomically snapshots valid proxies without property reads and claims callables', () => {
		const share = canonicalShare();
		let typeInspections = 0;
		let propertyReads = 0;
		const proxy = new Proxy(share, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});

		expect(admitQuerySharingWebviewMessage(proxy)).toEqual({
			recognized: true,
			parsed: { ok: true, value: share },
		});
		expect(typeInspections).toBe(1);
		expect(propertyReads).toBe(0);
		expect(admitQuerySharingWebviewMessage(Object.assign(() => undefined, share)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitQuerySharingHostMessage(Object.assign(() => undefined, {
			type: 'shareContentReady', html: 'html', text: 'text',
		}))).toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('fails closed on descriptor traps, revoked proxies, and bounded prototype inspection', () => {
		const share = canonicalShare();
		const descriptorTrap = new Proxy(share, {
			getOwnPropertyDescriptor() {
				throw new Error('descriptor trap');
			},
		});
		const revoked = Proxy.revocable(share, {});
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

		expect(() => admitQuerySharingWebviewMessage(descriptorTrap)).not.toThrow();
		expect(admitQuerySharingWebviewMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(() => admitQuerySharingWebviewMessage(revoked.proxy)).not.toThrow();
		expect(admitQuerySharingWebviewMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitQuerySharingWebviewMessage(cyclicProxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isQuerySharingHostMessageType(createUnboundedProxy())).toBe(true);
		expect(unboundedPrototypeReads).toBe(16);
	});

	it('does not claim unrelated traffic and rejects unknown parser input', () => {
		expect(admitQuerySharingWebviewMessage({ type: 'fetchUrl' })).toEqual({ recognized: false });
		expect(admitQuerySharingHostMessage({ type: 'urlContent' })).toEqual({ recognized: false });
		expect(parseQuerySharingWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseQuerySharingHostMessage({ type: 'copyAdeLink' })).toMatchObject({ ok: false });
	});
});