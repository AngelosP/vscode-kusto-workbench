import { describe, expect, it } from 'vitest';

import {
	isKustoDatabaseDiscoveryHostMessageType,
	isKustoDatabaseDiscoveryWebviewMessageType,
	parseKustoDatabaseDiscoveryHostMessage,
	parseKustoDatabaseDiscoveryWebviewMessage,
} from '../../src/shared/kustoDatabaseDiscoveryProtocol.js';

describe('Kusto database discovery protocol', () => {
	it('accepts both request types without normalizing identity or blank fields', () => {
		const requests = [
			{ type: 'getDatabases', connectionId: '', boxId: '', requestToken: undefined },
			{
				type: 'refreshDatabases', connectionId: ' connection ', boxId: ' box ',
				requestToken: ' token ', requiredDatabase: '', sectionInstanceId: ' instance ', targetGeneration: 7,
			},
		] as const;

		for (const request of requests) {
			expect(isKustoDatabaseDiscoveryWebviewMessageType(request)).toBe(true);
			const parsed = parseKustoDatabaseDiscoveryWebviewMessage(request);
			expect(parsed).toEqual({ ok: true, value: request });
			if (parsed.ok) expect(parsed.value).toBe(request);
		}
	});

	it('accepts data and error deliveries with legacy, partial, and full identity', () => {
		const deliveries = [
			{ type: 'databasesData', databases: [], boxId: '', connectionId: '' },
			{
				type: 'databasesData', databases: ['DbA'], boxId: 'box', connectionId: 'connection',
				accountPartition: '', requestToken: 'token', authoritative: false, fallback: true,
				sectionInstanceId: 'instance', targetGeneration: 9,
			},
			{ type: 'databasesError', boxId: 'legacy-box', connectionId: '', error: '', targetGeneration: 3 },
		] as const;

		for (const delivery of deliveries) {
			expect(isKustoDatabaseDiscoveryHostMessageType(delivery)).toBe(true);
			const parsed = parseKustoDatabaseDiscoveryHostMessage(delivery);
			expect(parsed).toEqual({ ok: true, value: delivery });
			if (parsed.ok) expect(parsed.value).toBe(delivery);
		}
	});

	it('rejects malformed recognized request fields while preserving the discriminator claim', () => {
		const arrayRequest = Object.assign([], {
			type: 'getDatabases', connectionId: 'connection', boxId: 'box',
		});
		for (const request of [
			arrayRequest,
			{ type: 'getDatabases', connectionId: 1, boxId: 'box' },
			{ type: 'refreshDatabases', connectionId: '', boxId: 'box', requestToken: 2 },
			{ type: 'getDatabases', connectionId: '', boxId: 'box', requiredDatabase: false },
			{ type: 'refreshDatabases', connectionId: '', boxId: 'box', sectionInstanceId: 3 },
			{ type: 'getDatabases', connectionId: '', boxId: 'box', targetGeneration: -1 },
		]) {
			expect(isKustoDatabaseDiscoveryWebviewMessageType(request)).toBe(true);
			expect(parseKustoDatabaseDiscoveryWebviewMessage(request)).toMatchObject({ ok: false });
		}
	});

	it('rejects malformed recognized delivery fields while preserving the discriminator claim', () => {
		const arrayDelivery = Object.assign([], {
			type: 'databasesData', databases: ['DbA'], boxId: 'box', connectionId: 'connection',
		});
		const sparseDatabases = new Array<string>(1);
		for (const delivery of [
			arrayDelivery,
			{ type: 'databasesData', databases: sparseDatabases, boxId: 'box', connectionId: 'connection' },
			{ type: 'databasesData', databases: 'DbA', boxId: 'box', connectionId: 'connection' },
			{ type: 'databasesData', databases: ['DbA', 2], boxId: 'box', connectionId: 'connection' },
			{ type: 'databasesData', databases: [], boxId: 'box', connectionId: 'connection', authoritative: 'yes' },
			{ type: 'databasesData', databases: [], boxId: 'box', connectionId: 'connection', fallback: 1 },
			{ type: 'databasesData', databases: [], boxId: 'box', connectionId: 'connection', accountPartition: false },
			{ type: 'databasesError', boxId: 'box', connectionId: 'connection', error: new Error('boom') },
			{ type: 'databasesError', boxId: 'box', connectionId: 'connection', error: 'boom', targetGeneration: 1.5 },
		]) {
			expect(isKustoDatabaseDiscoveryHostMessageType(delivery)).toBe(true);
			expect(parseKustoDatabaseDiscoveryHostMessage(delivery)).toMatchObject({ ok: false });
		}
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isKustoDatabaseDiscoveryWebviewMessageType({ type: 'getConnections' })).toBe(false);
		expect(isKustoDatabaseDiscoveryHostMessageType({ type: 'connectionsData' })).toBe(false);
		expect(parseKustoDatabaseDiscoveryWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parseKustoDatabaseDiscoveryWebviewMessage({ type: 'databasesData' })).toMatchObject({ ok: false });
		expect(parseKustoDatabaseDiscoveryHostMessage([])).toMatchObject({ ok: false });
		expect(parseKustoDatabaseDiscoveryHostMessage({ type: 'getDatabases' })).toMatchObject({ ok: false });
	});
});
