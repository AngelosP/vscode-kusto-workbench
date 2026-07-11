import { describe, expect, it, vi } from 'vitest';

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';

function createProviderHarness(): QueryEditorProvider & Record<string, any> {
	const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
	provider.connection = { sendDatabases: vi.fn(async () => undefined) };
	return provider;
}

describe('QueryEditorProvider database discovery routing', () => {
	it('keeps passive database discovery non-interactive', async () => {
		const provider = createProviderHarness();

		await provider.handleWebviewMessage({
			type: 'getDatabases',
			connectionId: 'connection-1',
			boxId: 'query-1',
			requestToken: 'request-1',
			requiredDatabase: 'SavedDb',
		});

		expect(provider.connection.sendDatabases).toHaveBeenCalledWith('connection-1', 'query-1', {
			mode: 'passive',
			requestToken: 'request-1',
			requiredDatabase: 'SavedDb',
		});
	});

	it('routes an explicit refresh as interactive', async () => {
		const provider = createProviderHarness();

		await provider.handleWebviewMessage({
			type: 'refreshDatabases',
			connectionId: 'connection-1',
			boxId: 'query-1',
			requestToken: 'request-2',
			requiredDatabase: 'SavedDb',
		});

		expect(provider.connection.sendDatabases).toHaveBeenCalledWith('connection-1', 'query-1', {
			mode: 'interactive-refresh',
			requestToken: 'request-2',
			requiredDatabase: 'SavedDb',
		});
	});
});