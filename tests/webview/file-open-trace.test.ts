import { beforeEach, describe, expect, it, vi } from 'vitest';

const { postMessageToHost } = vi.hoisted(() => ({ postMessageToHost: vi.fn() }));
vi.mock('../../src/webview/shared/webview-messages.js', () => ({ postMessageToHost }));

import { traceFileOpen } from '../../src/webview/core/file-open-trace';

describe('file-open trace privacy', () => {
	beforeEach(() => postMessageToHost.mockClear());

	it('hashes identifiers and removes schemas, queries, aliases, and backend errors', () => {
		traceFileOpen('monaco.schema.enhance.error', {
			boxId: 'SENTINEL_BOX',
			modelKey: 'file:///SENTINEL_PATH/query.kql',
			schemaKey: 'SENTINEL_CLUSTER|SENTINEL_DATABASE',
			clusterUrl: 'https://SENTINEL_CLUSTER.kusto.windows.net',
			database: 'SENTINEL_DATABASE',
			queryText: 'SENTINEL_QUERY',
			rawSchemaJson: { SENTINEL_SCHEMA: true },
			aliases: ['SENTINEL_ALIAS'],
			error: 'SENTINEL_BACKEND_ERROR',
			status: 'failed',
			columnCount: 2,
		});

		const message = postMessageToHost.mock.calls[0][0];
		const text = JSON.stringify(message);
		for (const sentinel of ['SENTINEL_BOX', 'SENTINEL_PATH', 'SENTINEL_CLUSTER', 'SENTINEL_DATABASE', 'SENTINEL_QUERY', 'SENTINEL_SCHEMA', 'SENTINEL_ALIAS', 'SENTINEL_BACKEND_ERROR']) {
			expect(text).not.toContain(sentinel);
		}
		expect(message).toMatchObject({
			type: 'fileOpenTrace',
			event: 'monaco.schema.enhance.error',
			detail: {
				status: 'failed',
				columnCount: 2,
				boxIdId: expect.stringMatching(/^[a-f0-9]{8}$/),
				modelKeyId: expect.stringMatching(/^[a-f0-9]{8}$/),
				schemaKeyId: expect.stringMatching(/^[a-f0-9]{8}$/),
			},
		});
	});
});
