import { describe, expect, it } from 'vitest';
import { canUseKustoDatabaseContextFastPath, KustoSchemaContextIntentTracker } from '../../src/webview/shared/schema-context-intent.js';

describe('KustoSchemaContextIntentTracker', () => {
	it('allows only the newest focused context intent to mutate context', () => {
		const tracker = new KustoSchemaContextIntentTracker();
		const first = tracker.claim({ boxId: 'query_1', schemaKey: 'cluster-a|db', modelUri: 'model-1' });
		const second = tracker.claim({ boxId: 'query_2', schemaKey: 'cluster-b|db', modelUri: 'model-2' });

		expect(tracker.isCurrent(first)).toBe(false);
		expect(tracker.isCurrent(second)).toBe(true);
		tracker.clear();
		expect(tracker.isCurrent(second)).toBe(false);
	});
});

describe('canUseKustoDatabaseContextFastPath', () => {
	it('rejects a same-name database from a different worker cluster', () => {
		expect(canUseKustoDatabaseContextFastPath({
			targetClusterUrl: 'https://cluster-b.kusto.windows.net',
			trackedClusterUrl: 'https://cluster-a.kusto.windows.net',
			workerClusterUrl: 'https://cluster-a.kusto.windows.net',
		})).toBe(false);
	});

	it('accepts normalized aliases for the same worker cluster', () => {
		expect(canUseKustoDatabaseContextFastPath({
			targetClusterUrl: 'https://cluster-a.kusto.windows.net',
			trackedClusterUrl: 'https://cluster-a',
			workerClusterUrl: 'https://cluster-a.kusto.windows.net/',
		})).toBe(true);
	});
});