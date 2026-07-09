import { beforeEach, describe, expect, it } from 'vitest';
import {
	isSchemaWorkerReady,
	markSchemaWorkerApplyFailed,
	markSchemaWorkerReady,
	schemaWorkerReadyByBoxId,
	waitForSchemaWorkerReady,
} from '../../src/webview/core/state';

describe('schema worker readiness state', () => {
	beforeEach(() => {
		for (const key of Object.keys(schemaWorkerReadyByBoxId)) {
			delete schemaWorkerReadyByBoxId[key];
		}
	});

	it('matches schema readiness by model URI when provided', () => {
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/old');

		expect(isSchemaWorkerReady('query_1', 'cluster|db')).toBe(true);
		expect(isSchemaWorkerReady('query_1', 'cluster|db', 'inmemory://model/old')).toBe(true);
		expect(isSchemaWorkerReady('query_1', 'cluster|db', 'inmemory://model/new')).toBe(false);
	});

	it('waits for the matching model URI instead of resolving from stale ready state', async () => {
		const waiting = waitForSchemaWorkerReady('query_1', 'cluster|db', 1000, 'inmemory://model/new');
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/old');
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/new');

		await expect(waiting).resolves.toBe(true);
	});

	it('does not resolve a model-specific waiter from a stale failure on another model', async () => {
		const waiting = waitForSchemaWorkerReady('query_1', 'cluster|db', 1000, 'inmemory://model/new');
		markSchemaWorkerApplyFailed('query_1', 'cluster|db', 'inmemory://model/old');
		markSchemaWorkerReady('query_1', 'cluster|db', 'sig-1', 'inmemory://model/new');

		await expect(waiting).resolves.toBe(true);
	});
});
