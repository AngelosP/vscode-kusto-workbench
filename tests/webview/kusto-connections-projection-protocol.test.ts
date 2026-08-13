import { describe, expect, it } from 'vitest';

import {
	admitKustoConnectionsProjectionHostMessage,
	admitKustoConnectionsProjectionWebviewMessage,
	captureKustoConnectionsProjectionHostMessage,
	captureKustoConnectionsProjectionWebviewMessage,
	isKustoConnectionsProjectionHostMessageType,
	isKustoConnectionsProjectionWebviewMessageType,
	parseKustoConnectionsProjectionHostMessage,
	parseKustoConnectionsProjectionWebviewMessage,
} from '../../src/shared/kustoConnectionsProjectionProtocol.js';

function canonicalSnapshot() {
	return {
		type: 'connectionsData' as const,
		connectionsRevision: 21,
		connections: [{
			id: ' kusto-1 ', name: ' Kusto One ', clusterUrl: ' https://cluster.kusto.windows.net ',
			database: '', authorityId: ' organizations ', accountPartition: ' partition ',
			connectionRevision: 0, connectionIdentityKey: ' cluster|organizations ',
		}],
		accounts: [{ id: ' account-a ', label: ' Account A ', lastUsedAt: -1 }],
		lastConnectionId: ' kusto-1 ',
		lastDatabase: '',
		cachedDatabases: { ' kusto-1 ': ['DbA', ''] },
		favorites: [{
			name: ' Favorite ', connectionId: ' kusto-1 ',
			clusterUrl: ' https://cluster.kusto.windows.net ', database: ' DbA ',
		}],
		caretDocsEnabled: false,
		caretDocsEnabledUserSet: true,
		autoTriggerAutocompleteEnabled: true,
		autoTriggerAutocompleteEnabledUserSet: false,
		copilotInlineCompletionsEnabled: false,
		copilotInlineCompletionsEnabledUserSet: true,
		editingPreferencesRevision: 0,
		copilotChatFirstTimeDismissed: false,
		policyRequestId: ' policy-request ',
		leaveNoTraceClusters: [],
		leaveNoTraceGloballyBlocked: false,
		leaveNoTraceRevisions: { cluster: 0 },
		devNotesEnabled: true,
	};
}

describe('Kusto connections projection protocol', () => {
	it('accepts the exact request object and captures its policy identity', () => {
		const request = { type: 'getConnections' as const, policyRequestId: ' policy-request ' };
		expect(isKustoConnectionsProjectionWebviewMessageType(request)).toBe(true);
		expect(parseKustoConnectionsProjectionWebviewMessage(request)).toEqual({ ok: true, value: request });
		expect(admitKustoConnectionsProjectionWebviewMessage(request)).toEqual({
			recognized: true, parsed: { ok: true, value: request },
		});
		const parsed = parseKustoConnectionsProjectionWebviewMessage(request);
		if (parsed.ok) expect(parsed.value).toBe(request);
		const captured = captureKustoConnectionsProjectionWebviewMessage(request);
		expect(captured).toEqual({ ok: true, value: request });
		if (captured.ok) expect(captured.value).not.toBe(request);
	});

	it('accepts a complete canonical snapshot without cloning ordinary values', () => {
		const snapshot = canonicalSnapshot();
		expect(isKustoConnectionsProjectionHostMessageType(snapshot)).toBe(true);
		const parsed = parseKustoConnectionsProjectionHostMessage(snapshot);
		expect(parsed).toEqual({ ok: true, value: snapshot });
		if (parsed.ok) {
			expect(parsed.value).toBe(snapshot);
			expect(parsed.value.connections).toBe(snapshot.connections);
			expect(parsed.value.accounts).toBe(snapshot.accounts);
			expect(parsed.value.cachedDatabases).toBe(snapshot.cachedDatabases);
			expect(parsed.value.favorites).toBe(snapshot.favorites);
			expect(parsed.value.leaveNoTraceRevisions).toBe(snapshot.leaveNoTraceRevisions);
		}
	});

	it('descriptor-captures complete plain application values', () => {
		const snapshot = canonicalSnapshot();
		const captured = captureKustoConnectionsProjectionHostMessage(snapshot);
		expect(captured).toEqual({ ok: true, value: snapshot });
		if (!captured.ok) return;
		expect(captured.value).not.toBe(snapshot);
		expect(captured.value.connections).not.toBe(snapshot.connections);
		expect(captured.value.accounts).not.toBe(snapshot.accounts);
		expect(captured.value.cachedDatabases).not.toBe(snapshot.cachedDatabases);
		expect(captured.value.favorites).not.toBe(snapshot.favorites);
		expect(captured.value.leaveNoTraceClusters).not.toBe(snapshot.leaveNoTraceClusters);
		expect(captured.value.leaveNoTraceRevisions).not.toBe(snapshot.leaveNoTraceRevisions);

		snapshot.connections[0].name = 'mutated';
		snapshot.cachedDatabases[' kusto-1 '][0] = 'mutated';
		expect(captured.value.connections[0].name).toBe(' Kusto One ');
		expect(captured.value.cachedDatabases[' kusto-1 ']).toEqual(['DbA', '']);
	});

	it('preserves dense empty canonical collections, null selections, and revision zero', () => {
		const snapshot = {
			...canonicalSnapshot(),
			connectionsRevision: 0,
			connections: [],
			accounts: [],
			lastConnectionId: null,
			lastDatabase: null,
			cachedDatabases: {},
			favorites: [],
			leaveNoTraceClusters: [],
			leaveNoTraceRevisions: {},
		};
		const parsed = parseKustoConnectionsProjectionHostMessage(snapshot);
		expect(parsed).toEqual({ ok: true, value: snapshot });
		if (parsed.ok) expect(parsed.value).toBe(snapshot);
		expect(captureKustoConnectionsProjectionHostMessage(snapshot)).toMatchObject({ ok: true });
	});

	it('accepts intentionally supported unrevisioned legacy snapshots', () => {
		const minimal = {
			type: 'connectionsData' as const,
			connections: [{ id: 'kusto-legacy', clusterUrl: 'https://legacy.kusto.windows.net' }],
		};
		const populated = {
			type: 'connectionsData' as const,
			connectionsRevision: undefined,
			connections: [{
				id: 'kusto-legacy', clusterUrl: 'https://legacy.kusto.windows.net',
				name: 'Legacy', database: undefined, connectionRevision: 2,
			}],
			accounts: [], lastConnectionId: null, lastDatabase: '', cachedDatabases: {},
			favorites: [], leaveNoTraceClusters: [], leaveNoTraceGloballyBlocked: false,
			leaveNoTraceRevisions: {},
		};
		for (const snapshot of [minimal, populated]) {
			const parsed = parseKustoConnectionsProjectionHostMessage(snapshot);
			expect(parsed).toEqual({ ok: true, value: snapshot });
			if (parsed.ok) expect(parsed.value).toBe(snapshot);
			expect(captureKustoConnectionsProjectionHostMessage(snapshot)).toMatchObject({ ok: true });
		}
	});

	it('rejects the malformed max-revision snapshot as one atomic delivery', () => {
		const malformed = {
			...canonicalSnapshot(),
			connectionsRevision: Number.MAX_SAFE_INTEGER,
			connections: {},
		};
		expect(admitKustoConnectionsProjectionHostMessage(malformed)).toMatchObject({
			recognized: true, parsed: { ok: false },
		});
	});

	it('requires every revisioned field and canonical connection shape', () => {
		const snapshot = canonicalSnapshot();
		for (const malformed of [
			{ ...snapshot, accounts: undefined },
			{ ...snapshot, lastConnectionId: undefined },
			{ ...snapshot, lastConnectionId: 42 },
			{ ...snapshot, lastDatabase: undefined },
			{ ...snapshot, lastDatabase: false },
			{ ...snapshot, cachedDatabases: undefined },
			{ ...snapshot, favorites: undefined },
			{ ...snapshot, caretDocsEnabled: undefined },
			{ ...snapshot, editingPreferencesRevision: undefined },
			{ ...snapshot, leaveNoTraceClusters: undefined },
			{ ...snapshot, leaveNoTraceGloballyBlocked: undefined },
			{ ...snapshot, leaveNoTraceRevisions: undefined },
			{ ...snapshot, devNotesEnabled: undefined },
			{ ...snapshot, connections: [{ id: 'kusto-1', clusterUrl: 'https://cluster' }] },
		]) {
			expect(parseKustoConnectionsProjectionHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('final-parses a captured request whose descriptor changes between reads', () => {
		let policyDescriptorReads = 0;
		const request = new Proxy({
			type: 'getConnections',
			policyRequestId: 'policy-stable',
		}, {
			getOwnPropertyDescriptor(target, key) {
				const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
				if (key !== 'policyRequestId' || !descriptor) return descriptor;
				policyDescriptorReads++;
				return {
					...descriptor,
					value: policyDescriptorReads === 1 ? 'policy-stable' : 42,
				};
			},
		});

		expect(captureKustoConnectionsProjectionWebviewMessage(request)).toMatchObject({ ok: false });
		expect(policyDescriptorReads).toBe(2);
	});

	it('rejects malformed scalar and nested collection fields', () => {
		const snapshot = canonicalSnapshot();
		const sparseConnections = new Array(1);
		const sparseDatabases = new Array(1);
		const inheritedDatabases = new Array<string>(1);
		const inheritedPrototype = Object.create(Array.prototype) as string[];
		inheritedPrototype[0] = 'InheritedDb';
		Object.setPrototypeOf(inheritedDatabases, inheritedPrototype);
		for (const malformed of [
			{ ...snapshot, connectionsRevision: Number.MAX_SAFE_INTEGER + 1 },
			{ ...snapshot, connections: sparseConnections },
			{ ...snapshot, connections: [{ ...snapshot.connections[0], connectionRevision: 1.5 }] },
			{ ...snapshot, accounts: [{ id: 'account', label: 'Account', lastUsedAt: Number.NaN }] },
			{ ...snapshot, cachedDatabases: [] },
			{ ...snapshot, cachedDatabases: { 'kusto-1': sparseDatabases } },
			{ ...snapshot, cachedDatabases: { 'kusto-1': inheritedDatabases } },
			{ ...snapshot, cachedDatabases: { 'kusto-1': ['Db', 42] } },
			{ ...snapshot, favorites: [{ name: 'Favorite', connectionId: 'kusto-1' }] },
			{ ...snapshot, leaveNoTraceClusters: ['cluster', 42] },
			{ ...snapshot, leaveNoTraceRevisions: { cluster: -1 } },
		]) {
			expect(parseKustoConnectionsProjectionHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('rejects malformed known envelopes without invoking accessors', () => {
		let getterCalls = 0;
		const accessorRequest = {};
		Object.defineProperty(accessorRequest, 'type', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'getConnections';
			},
		});
		const inheritedRequest = Object.create({ type: 'getConnections' });
		const arrayRequest = Object.assign([], { type: 'getConnections' });
		for (const request of [accessorRequest, inheritedRequest, arrayRequest]) {
			expect(admitKustoConnectionsProjectionWebviewMessage(request)).toMatchObject({
				recognized: true, parsed: { ok: false },
			});
		}
		expect(getterCalls).toBe(0);
	});

	it('rejects descriptors and proxies without reading their values', () => {
		let getterCalls = 0;
		const snapshot = canonicalSnapshot();
		const accessorSnapshot = { ...snapshot } as Record<string, unknown>;
		Object.defineProperty(accessorSnapshot, 'connections', {
			enumerable: true,
			get() {
				getterCalls++;
				return snapshot.connections;
			},
		});
		expect(parseKustoConnectionsProjectionHostMessage(accessorSnapshot)).toMatchObject({ ok: false });

		let propertyReads = 0;
		const trappedConnections = new Proxy(snapshot.connections, {
			get() {
				propertyReads++;
				throw new Error('property read');
			},
			getOwnPropertyDescriptor() {
				throw new Error('descriptor read');
			},
		});
		expect(parseKustoConnectionsProjectionHostMessage({
			...snapshot,
			connections: trappedConnections,
		})).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);
		expect(propertyReads).toBe(0);
	});

	it('rejects operational array overrides without invoking them', () => {
		let iteratorCalls = 0;
		const snapshot = canonicalSnapshot();
		Object.defineProperty(snapshot.connections, Symbol.iterator, {
			configurable: true,
			value() {
				iteratorCalls++;
				throw new Error('iterator invoked');
			},
		});
		expect(parseKustoConnectionsProjectionHostMessage(snapshot)).toMatchObject({ ok: false });
		expect(captureKustoConnectionsProjectionHostMessage(snapshot)).toMatchObject({ ok: false });
		expect(iteratorCalls).toBe(0);
	});

	it('captures prototype-sensitive record keys as ordinary own data', () => {
		const snapshot = canonicalSnapshot();
		const cachedDatabases = Object.create(null) as Record<string, string[]>;
		const leaveNoTraceRevisions = Object.create(null) as Record<string, number>;
		for (const key of ['__proto__', 'constructor']) {
			Object.defineProperty(cachedDatabases, key, {
				value: [`${key}-db`], enumerable: true, configurable: true, writable: true,
			});
			Object.defineProperty(leaveNoTraceRevisions, key, {
				value: 1, enumerable: true, configurable: true, writable: true,
			});
		}
		const captured = captureKustoConnectionsProjectionHostMessage({
			...snapshot, cachedDatabases, leaveNoTraceRevisions,
		});
		expect(captured).toMatchObject({ ok: true });
		if (!captured.ok) return;
		expect(Object.getPrototypeOf(captured.value.cachedDatabases)).toBeNull();
		expect(Object.getPrototypeOf(captured.value.leaveNoTraceRevisions)).toBeNull();
		expect(captured.value.cachedDatabases.__proto__).toEqual(['__proto__-db']);
		expect(captured.value.leaveNoTraceRevisions.constructor).toBe(1);
	});

	it('does not claim unrelated traffic', () => {
		expect(isKustoConnectionsProjectionWebviewMessageType({ type: 'getSqlConnections' })).toBe(false);
		expect(isKustoConnectionsProjectionHostMessageType({ type: 'sqlConnectionsData' })).toBe(false);
		expect(admitKustoConnectionsProjectionWebviewMessage(null)).toEqual({ recognized: false });
		expect(parseKustoConnectionsProjectionWebviewMessage({ type: 'connectionsData' }))
			.toMatchObject({ ok: false });
		expect(parseKustoConnectionsProjectionHostMessage({ type: 'getConnections' }))
			.toMatchObject({ ok: false });
	});
});