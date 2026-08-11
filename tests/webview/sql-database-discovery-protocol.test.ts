import { describe, expect, it } from 'vitest';

import {
	isSqlDatabaseDiscoveryHostMessageType,
	isSqlDatabaseDiscoveryWebviewMessageType,
	parseSqlDatabaseDiscoveryHostMessage,
	parseSqlDatabaseDiscoveryWebviewMessage,
} from '../../src/shared/sqlDatabaseDiscoveryProtocol.js';

describe('SQL database discovery protocol', () => {
	it('accepts both request types without normalizing identity or blank strings', () => {
		const requests = [
			{
				type: 'getSqlDatabases', sqlConnectionId: '', boxId: '',
				sectionInstanceId: '', targetGeneration: 0,
			},
			{
				type: 'refreshSqlDatabases', sqlConnectionId: ' connection ', boxId: ' box ',
				sectionInstanceId: ' instance ', targetGeneration: 7,
			},
		] as const;

		for (const request of requests) {
			expect(isSqlDatabaseDiscoveryWebviewMessageType(request)).toBe(true);
			const parsed = parseSqlDatabaseDiscoveryWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) expect(parsed.value).toBe(request);
		}
	});

	it('accepts all deliveries and preserves dense empty arrays and object identity', () => {
		const deliveries = [
			{
				type: 'sqlDatabasesLoading', requestId: '', targetGeneration: 0,
				boxId: '', sectionInstanceId: '', sqlConnectionId: '',
			},
			{
				type: 'sqlDatabasesData', requestId: 'request', targetGeneration: 4,
				boxId: 'box', sectionInstanceId: 'instance', sqlConnectionId: 'connection',
				databases: [],
			},
			{
				type: 'sqlDatabasesError', requestId: ' request ', targetGeneration: 9,
				boxId: ' box ', sectionInstanceId: ' instance ', sqlConnectionId: ' connection ',
				error: '',
			},
		] as const;

		for (const delivery of deliveries) {
			expect(isSqlDatabaseDiscoveryHostMessageType(delivery)).toBe(true);
			const parsed = parseSqlDatabaseDiscoveryHostMessage(delivery);
			expect(parsed).toEqual({ ok: true, value: delivery });
			if (parsed.ok) expect(parsed.value).toBe(delivery);
		}
	});

	it('rejects malformed recognized requests while preserving the discriminator claim', () => {
		const arrayRequest = Object.assign([], {
			type: 'getSqlDatabases', sqlConnectionId: 'connection', boxId: 'box',
			sectionInstanceId: 'instance', targetGeneration: 1,
		});
		for (const request of [
			arrayRequest,
			{ type: 'getSqlDatabases', sqlConnectionId: 1, boxId: 'box', sectionInstanceId: 'instance', targetGeneration: 1 },
			{ type: 'refreshSqlDatabases', sqlConnectionId: 'connection', boxId: false, sectionInstanceId: 'instance', targetGeneration: 1 },
			{ type: 'getSqlDatabases', sqlConnectionId: 'connection', boxId: 'box', sectionInstanceId: 2, targetGeneration: 1 },
			{ type: 'refreshSqlDatabases', sqlConnectionId: 'connection', boxId: 'box', sectionInstanceId: 'instance', targetGeneration: -1 },
			{ type: 'getSqlDatabases', sqlConnectionId: 'connection', boxId: 'box', sectionInstanceId: 'instance', targetGeneration: 1.5 },
		]) {
			expect(isSqlDatabaseDiscoveryWebviewMessageType(request)).toBe(true);
			expect(parseSqlDatabaseDiscoveryWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('rejects malformed recognized deliveries including sparse and non-string database arrays', () => {
		const identity = {
			requestId: 'request', targetGeneration: 4, boxId: 'box',
			sectionInstanceId: 'instance', sqlConnectionId: 'connection',
		};
		const arrayDelivery = Object.assign([], {
			type: 'sqlDatabasesLoading', ...identity,
		});
		const sparseDatabases = new Array<string>(1);
		const inheritedDatabases = new Array<string>(1);
		const inheritedDatabasePrototype = Object.create(Array.prototype) as string[];
		inheritedDatabasePrototype[0] = 'InheritedDb';
		Object.setPrototypeOf(inheritedDatabases, inheritedDatabasePrototype);
		for (const delivery of [
			arrayDelivery,
			{ type: 'sqlDatabasesLoading', ...identity, requestId: 1 },
			{ type: 'sqlDatabasesLoading', ...identity, targetGeneration: Number.MAX_SAFE_INTEGER + 1 },
			{ type: 'sqlDatabasesLoading', ...identity, boxId: null },
			{ type: 'sqlDatabasesLoading', ...identity, sectionInstanceId: undefined },
			{ type: 'sqlDatabasesLoading', ...identity, sqlConnectionId: false },
			{ type: 'sqlDatabasesData', ...identity, databases: sparseDatabases },
			{ type: 'sqlDatabasesData', ...identity, databases: inheritedDatabases },
			{ type: 'sqlDatabasesData', ...identity, databases: 'DbA' },
			{ type: 'sqlDatabasesData', ...identity, databases: ['DbA', 2] },
			{ type: 'sqlDatabasesError', ...identity, error: new Error('boom') },
		]) {
			expect(isSqlDatabaseDiscoveryHostMessageType(delivery)).toBe(true);
			expect(parseSqlDatabaseDiscoveryHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isSqlDatabaseDiscoveryWebviewMessageType({ type: 'getSqlConnections' })).toBe(false);
		expect(isSqlDatabaseDiscoveryHostMessageType({ type: 'sqlConnectionsData' })).toBe(false);
		expect(parseSqlDatabaseDiscoveryWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseSqlDatabaseDiscoveryWebviewMessage({ type: 'sqlDatabasesData' })).toMatchObject({ ok: false });
		expect(parseSqlDatabaseDiscoveryHostMessage([])).toMatchObject({ ok: false });
		expect(parseSqlDatabaseDiscoveryHostMessage({ type: 'getSqlDatabases' })).toMatchObject({ ok: false });
	});
});