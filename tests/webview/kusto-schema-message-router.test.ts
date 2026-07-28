import { describe, expect, it } from 'vitest';

import { KustoEditorSchemaCoordinator } from '../../src/webview/core/kusto-editor-schema-coordinator.js';
import {
	admitKustoDatabaseDelivery,
	admitKustoSchemaDelivery,
} from '../../src/webview/core/kusto-schema-message-router.js';

describe('Kusto schema message admission', () => {
	it('rejects a delivery from an old same-ID section incarnation', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const oldLease = coordinator.openSection('query_1', 'instance-old')!;
		const oldIdentity = coordinator.setTarget(oldLease, 'c1', 'DbA')!;
		coordinator.beginSchemaRequest(oldLease, 'schema-old');
		coordinator.closeSection(oldLease);
		const newLease = coordinator.openSection('query_1', 'instance-new')!;
		coordinator.setTarget(newLease, 'c1', 'DbA');
		coordinator.beginSchemaRequest(newLease, 'schema-new');

		expect(admitKustoSchemaDelivery({
			type: 'schemaData', boxId: 'query_1', connectionId: 'c1', database: 'DbA',
			requestToken: 'schema-old', ...oldIdentity,
		}, coordinator)).toBe('rejected');
	});

	it('admits only the exact current database and schema request streams', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const databaseIdentity = coordinator.setTarget(lease, 'c1')!;
		coordinator.beginDatabaseRequest(lease, 'database-1');
		expect(admitKustoDatabaseDelivery({
			type: 'databasesData', boxId: 'query_1', connectionId: 'c1', requestToken: 'database-1',
			...databaseIdentity,
		}, coordinator)).toBe('editor');

		const schemaIdentity = coordinator.setTarget(lease, 'c1', 'DbA')!;
		coordinator.beginSchemaRequest(lease, 'schema-1');
		expect(admitKustoSchemaDelivery({
			type: 'schemaData', boxId: 'query_1', connectionId: 'c1', database: 'DbA',
			requestToken: 'schema-1', ...schemaIdentity,
		}, coordinator)).toBe('editor');
		expect(admitKustoDatabaseDelivery({
			type: 'databasesData', boxId: 'query_1', connectionId: 'c1', requestToken: 'database-1',
			...databaseIdentity,
		}, coordinator)).toBe('rejected');
	});

	it('admits a live database casing variant for the same Kusto target', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const identity = coordinator.setTarget(lease, 'c1', 'samples')!;
		coordinator.beginSchemaRequest(lease, 'schema-1');

		expect(admitKustoSchemaDelivery({
			type: 'schemaData', boxId: 'query_1', connectionId: 'c1', database: 'Samples',
			requestToken: 'schema-1', ...identity,
		}, coordinator)).toBe('editor');
	});

	it('admits a logical schema response for the exact physically stamped target generation', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		const lease = coordinator.openSection('query_1', 'instance-1')!;
		const staleIdentity = coordinator.setTarget(lease, 'c1', 'DbA')!;
		const identity = coordinator.setTarget(lease, 'c1', 'DbA', {
			connectionRevision: 4,
			connectionIdentityKey: 'cluster|',
		})!;
		coordinator.beginSchemaRequest(lease, 'schema-stamped');

		expect(admitKustoSchemaDelivery({
			type: 'schemaData', boxId: 'query_1', connectionId: 'c1', database: 'DbA',
			requestToken: 'schema-stamped', ...identity,
		}, coordinator)).toBe('editor');
		expect(admitKustoSchemaDelivery({
			type: 'schemaData', boxId: 'query_1', connectionId: 'c1', database: 'DbA',
			requestToken: 'schema-stamped', ...staleIdentity,
		}, coordinator)).toBe('rejected');
	});

	it('routes synthetic requests before editor admission', () => {
		const coordinator = new KustoEditorSchemaCoordinator();
		expect(admitKustoSchemaDelivery({
			type: 'schemaData', boxId: '__schema_req__1', connectionId: 'c1', database: 'DbA',
		}, coordinator, true)).toBe('synthetic');
		expect(admitKustoDatabaseDelivery({
			type: 'databasesData', boxId: '__kusto_dbreq__1', connectionId: 'c1',
		}, coordinator, true)).toBe('synthetic');
	});
});