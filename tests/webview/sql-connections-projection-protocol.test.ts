import { describe, expect, it } from 'vitest';

import {
	admitSqlConnectionsProjectionHostMessage,
	admitSqlConnectionsProjectionWebviewMessage,
	captureSqlConnectionsProjectionHostMessage,
	captureSqlConnectionsProjectionWebviewMessage,
	isSqlConnectionsProjectionHostMessageType,
	isSqlConnectionsProjectionWebviewMessageType,
	parseSqlConnectionsProjectionHostMessage,
	parseSqlConnectionsProjectionWebviewMessage,
} from '../../src/shared/sqlConnectionsProjectionProtocol.js';

function canonicalSnapshot() {
	return {
		type: 'sqlConnectionsData' as const,
		revision: 21,
		sqlStateVersions: { policy: 7, connections: 8, principals: 9 },
		connections: [{
			id: ' sql-1 ', name: ' SQL One ', dialect: 'mssql', serverUrl: ' server.example ',
			port: 1433, database: '', authType: 'aad', username: '', credentialRevision: 0,
			principalFingerprint: ' principal ', revocationGeneration: 0,
		}],
		lastConnectionId: ' sql-1 ',
		lastDatabase: '',
		cachedDatabases: { ' sql-1 ': ['DbA', ''] },
		sqlFavorites: [{ name: ' Favorite ', connectionId: ' sql-1 ', database: ' DbA ' }],
		sqlLeaveNoTrace: [],
	};
}

describe('SQL connections projection protocol', () => {
	it('accepts the exact request object', () => {
		const request = { type: 'getSqlConnections' as const };
		expect(isSqlConnectionsProjectionWebviewMessageType(request)).toBe(true);
		expect(parseSqlConnectionsProjectionWebviewMessage(request)).toEqual({ ok: true, value: request });
		expect(admitSqlConnectionsProjectionWebviewMessage(request)).toEqual({
			recognized: true, parsed: { ok: true, value: request },
		});
		const parsed = parseSqlConnectionsProjectionWebviewMessage(request);
		if (parsed.ok) expect(parsed.value).toBe(request);
		const captured = captureSqlConnectionsProjectionWebviewMessage(request);
		expect(captured).toEqual({ ok: true, value: request });
		if (captured.ok) expect(captured.value).not.toBe(request);
	});

	it('accepts a complete canonical snapshot without cloning nested values', () => {
		const snapshot = canonicalSnapshot();
		expect(isSqlConnectionsProjectionHostMessageType(snapshot)).toBe(true);
		const parsed = parseSqlConnectionsProjectionHostMessage(snapshot);
		expect(parsed).toEqual({ ok: true, value: snapshot });
		if (parsed.ok) {
			expect(parsed.value).toBe(snapshot);
			expect(parsed.value.connections).toBe(snapshot.connections);
			expect(parsed.value.cachedDatabases).toBe(snapshot.cachedDatabases);
			expect(parsed.value.sqlFavorites).toBe(snapshot.sqlFavorites);
			expect(parsed.value.sqlLeaveNoTrace).toBe(snapshot.sqlLeaveNoTrace);
		}
		const captured = captureSqlConnectionsProjectionHostMessage(snapshot);
		expect(captured).toEqual({ ok: true, value: snapshot });
		if (captured.ok) {
			expect(captured.value).not.toBe(snapshot);
			expect(captured.value.connections).not.toBe(snapshot.connections);
			expect(captured.value.cachedDatabases).not.toBe(snapshot.cachedDatabases);
		}
	});

	it('preserves dense empty canonical collections and revision zero', () => {
		const snapshot = {
			...canonicalSnapshot(), revision: 0, connections: [], cachedDatabases: {},
			sqlFavorites: [], sqlLeaveNoTrace: [],
		};
		const parsed = parseSqlConnectionsProjectionHostMessage(snapshot);
		expect(parsed).toEqual({ ok: true, value: snapshot });
		if (parsed.ok) expect(parsed.value).toBe(snapshot);
	});

	it('preserves finite legacy-compatible SQL port values', () => {
		for (const port of [0, 1433.5, -1]) {
			const snapshot = canonicalSnapshot();
			snapshot.connections[0].port = port;
			const parsed = parseSqlConnectionsProjectionHostMessage(snapshot);
			expect(parsed).toEqual({ ok: true, value: snapshot });
			if (parsed.ok) expect(parsed.value).toBe(snapshot);
		}
	});

	it('accepts intentionally supported unrevisioned legacy snapshots', () => {
		const minimal = {
			type: 'sqlConnectionsData' as const,
			connections: [{ id: 'sql-legacy', serverUrl: 'legacy.example' }],
		};
		const populated = {
			type: 'sqlConnectionsData' as const,
			connections: [{
				id: 'sql-legacy', serverUrl: 'legacy.example', name: 'Legacy', dialect: 'mssql',
				authType: 'aad', database: undefined,
			}],
			lastConnectionId: 'sql-legacy', lastDatabase: '', cachedDatabases: {},
			sqlFavorites: [], sqlLeaveNoTrace: [],
		};
		for (const snapshot of [minimal, populated]) {
			const parsed = parseSqlConnectionsProjectionHostMessage(snapshot);
			expect(parsed).toEqual({ ok: true, value: snapshot });
			if (parsed.ok) expect(parsed.value).toBe(snapshot);
		}
	});

	it('rejects the malformed max-revision snapshot as one atomic delivery', () => {
		const malformed = {
			...canonicalSnapshot(),
			revision: Number.MAX_SAFE_INTEGER,
			connections: {},
			cachedDatabases: {},
			sqlFavorites: [],
			sqlLeaveNoTrace: [],
		};
		expect(admitSqlConnectionsProjectionHostMessage(malformed)).toMatchObject({
			recognized: true, parsed: { ok: false },
		});
	});

	it('requires every revisioned snapshot field and canonical connection shape', () => {
		const snapshot = canonicalSnapshot();
		for (const malformed of [
			{ ...snapshot, sqlStateVersions: undefined },
			{ ...snapshot, lastConnectionId: undefined },
			{ ...snapshot, lastDatabase: undefined },
			{ ...snapshot, cachedDatabases: undefined },
			{ ...snapshot, sqlFavorites: undefined },
			{ ...snapshot, sqlLeaveNoTrace: undefined },
			{ ...snapshot, connections: [{ id: 'sql-1', serverUrl: 'server.example' }] },
		]) {
			expect(parseSqlConnectionsProjectionHostMessage(malformed)).toMatchObject({ ok: false });
		}
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
			{ ...snapshot, revision: Number.MAX_SAFE_INTEGER + 1 },
			{ ...snapshot, sqlStateVersions: { policy: 1, connections: -1, principals: 1 } },
			{ ...snapshot, connections: sparseConnections },
			{ ...snapshot, connections: [{ ...snapshot.connections[0], port: Number.POSITIVE_INFINITY }] },
			{ ...snapshot, connections: [{ ...snapshot.connections[0], credentialRevision: 1.5 }] },
			{ ...snapshot, cachedDatabases: [] },
			{ ...snapshot, cachedDatabases: { 'sql-1': sparseDatabases } },
			{ ...snapshot, cachedDatabases: { 'sql-1': inheritedDatabases } },
			{ ...snapshot, cachedDatabases: { 'sql-1': ['Db', 42] } },
			{ ...snapshot, sqlFavorites: [{ name: 'Favorite', connectionId: 'sql-1' }] },
			{ ...snapshot, sqlLeaveNoTrace: ['sql-1', 42] },
		]) {
			expect(parseSqlConnectionsProjectionHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('rejects malformed known envelopes without invoking accessors', () => {
		let getterCalls = 0;
		const accessorRequest = {};
		Object.defineProperty(accessorRequest, 'type', {
			enumerable: true,
			get() {
				getterCalls++;
				return 'getSqlConnections';
			},
		});
		const inheritedRequest = Object.create({ type: 'getSqlConnections' });
		const arrayRequest = Object.assign([], { type: 'getSqlConnections' });
		for (const request of [accessorRequest, inheritedRequest, arrayRequest]) {
			expect(admitSqlConnectionsProjectionWebviewMessage(request)).toMatchObject({
				recognized: true, parsed: { ok: false },
			});
		}
		expect(getterCalls).toBe(0);
	});

	it('rejects arrays whose descriptors cannot be inspected without reading properties', () => {
		let propertyReads = 0;
		const snapshot = canonicalSnapshot();
		const trappedConnections = new Proxy(snapshot.connections, {
			get() {
				propertyReads++;
				throw new Error('property read');
			},
			getOwnPropertyDescriptor() {
				throw new Error('descriptor read');
			},
		});

		expect(parseSqlConnectionsProjectionHostMessage({
			...snapshot,
			connections: trappedConnections,
		})).toMatchObject({ ok: false });
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

		expect(parseSqlConnectionsProjectionHostMessage(snapshot)).toMatchObject({ ok: false });
		expect(captureSqlConnectionsProjectionHostMessage(snapshot)).toMatchObject({ ok: false });
		expect(iteratorCalls).toBe(0);
	});

	it('does not claim unrelated traffic', () => {
		expect(isSqlConnectionsProjectionWebviewMessageType({ type: 'getConnections' })).toBe(false);
		expect(isSqlConnectionsProjectionHostMessageType({ type: 'connectionsData' })).toBe(false);
		expect(admitSqlConnectionsProjectionWebviewMessage(null)).toEqual({ recognized: false });
		expect(parseSqlConnectionsProjectionWebviewMessage({ type: 'sqlConnectionsData' }))
			.toMatchObject({ ok: false });
		expect(parseSqlConnectionsProjectionHostMessage({ type: 'getSqlConnections' }))
			.toMatchObject({ ok: false });
	});
});