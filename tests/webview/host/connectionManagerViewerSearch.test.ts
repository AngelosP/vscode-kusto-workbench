import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { ConnectionManagerViewerV2 } from '../../../src/host/connectionManagerViewer';

function createViewerHarness(): ConnectionManagerViewerV2 & Record<string, any> {
	return Object.create(ConnectionManagerViewerV2.prototype) as ConnectionManagerViewerV2 & Record<string, any>;
}

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

describe('ConnectionManagerViewerV2 schema search mapping', () => {
	it('includes Kusto column docstrings in cached schema search result snippets', () => {
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' }]),
		};

		const results = viewer._mapKustoSchemaMatches([
			{
				clusterUrl: 'https://mycluster.kusto.windows.net',
				database: 'AlphaDb',
				kind: 'columnDocString',
				name: 'alphaCol',
				table: 'AlphaRoot',
				type: 'long',
				docString: 'Primary event count for the current window',
			},
		], { tables: true }, { tables: true });

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				matchContext: 'alphaCol: long - Primary event count for the current window',
			}),
		]);
	});

	it('searches Kusto column docstrings in freshly loaded schemas', () => {
		const viewer = createViewerHarness();
		const results = viewer._searchSingleKustoSchema(
			{
				tables: ['AlphaRoot'],
				columnTypesByTable: { AlphaRoot: { alphaCol: 'long' } },
				columnDocStrings: { 'AlphaRoot.alphaCol': 'Primary event count for the current window' },
			},
			'https://mycluster.kusto.windows.net',
			'AlphaDb',
			{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' },
			/event count/i,
			{ tables: true },
			{ tables: true },
		);

		expect(results).toEqual([
			expect.objectContaining({
				category: 'column',
				name: 'alphaCol',
				parentName: 'AlphaRoot',
				matchContext: 'alphaCol: long - Primary event count for the current window',
			}),
		]);
	});
});

describe('ConnectionManagerViewerV2 database refresh', () => {
	it('keeps the previous cached list when live discovery returns zero databases', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.connectionManager = {
			getConnections: vi.fn(() => [{ id: 'c1', name: 'MyCluster', clusterUrl: 'https://mycluster.kusto.windows.net' }]),
		};
		viewer.kustoClient = {
			getDatabases: vi.fn(async () => []),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.panel = { webview: { postMessage } };
		viewer.getCachedDatabases = vi.fn(() => ({ c1: ['CachedDb'] }));
		viewer.traceDatabaseList = vi.fn();
		const warning = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue(undefined as any);

		await viewer.onMessage({ type: 'cluster.refreshDatabases', connectionId: 'c1' });

		expect(postMessage).toHaveBeenNthCalledWith(1, { type: 'loadingDatabases', connectionId: 'c1' });
		expect(postMessage).toHaveBeenNthCalledWith(2, {
			type: 'databasesLoaded',
			connectionId: 'c1',
			databases: ['CachedDb'],
			warning: true,
		});
		expect(warning).toHaveBeenCalledWith("Couldn't refresh the database list (received 0 databases). Keeping the previous cached list.");
	});
});

describe('ConnectionManagerViewerV2 new KQLX files', () => {
	it('serializes the exact connection authority and hint for same-cluster connections', async () => {
		const viewer = createViewerHarness();
		const targetUri = vscode.Uri.file('C:/work/GuestDb.kqlx');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile').mockResolvedValue(undefined);
		vi.spyOn(vscode.window, 'showSaveDialog').mockResolvedValue(targetUri as any);
		vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({
			getText: () => new TextDecoder().decode(writeFile.mock.calls.at(-1)?.[1] ?? new Uint8Array()),
			lineCount: 1,
			save: vi.fn(async () => true),
		} as any);
		viewer.connectionManager = {
			getConnections: vi.fn(() => [
				{ id: 'home', name: 'Home', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'home.onmicrosoft.com' },
				{ id: 'guest', name: 'Guest', clusterUrl: 'shared', authorityId: 'resource.onmicrosoft.com' },
			]),
		};

		await viewer.onMessage({
			type: 'database.openInNewFile',
			connectionId: 'guest',
			clusterUrl: 'https://shared.kusto.windows.net',
			database: 'GuestDb',
		});

		expect(writeFile).toHaveBeenCalledOnce();
		const content = new TextDecoder().decode(writeFile.mock.calls[0][1]);
		const file = JSON.parse(content);
		expect(file.state.sections[0]).toMatchObject({
			type: 'query',
			clusterUrl: 'shared',
			authorityId: 'resource.onmicrosoft.com',
			connectionIdHint: 'guest',
			database: 'GuestDb',
		});
	});
});

describe('ConnectionManagerViewerV2 mutation completion', () => {
	it('posts the final snapshot only after explicit account persistence settles', async () => {
		let settlePreference!: () => void;
		const preferenceGate = new Promise<void>(resolve => { settlePreference = resolve; });
		const events: string[] = [];
		const viewer = createViewerHarness();
		viewer.connectionManager = {
			addConnection: vi.fn(async () => ({ id: 'c1', name: 'Guest', clusterUrl: 'https://cluster.kusto.windows.net' })),
		};
		viewer.authPreferences = {
			getAccounts: vi.fn(async () => [{ id: 'account-1', label: 'Account one' }]),
			setExplicitAccount: vi.fn(async () => {
				await preferenceGate;
				events.push('preference');
			}),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => { events.push('snapshot'); });
		viewer.panel = { webview: { postMessage: vi.fn((message: { type: string }) => { events.push(message.type); }) } };

		const completion = viewer.onMessage({
			type: 'connection.add',
			name: 'Guest',
			clusterUrl: 'https://cluster.kusto.windows.net',
			authorityId: 'resource.onmicrosoft.com',
			accountId: 'account-1',
		});
		await Promise.resolve();
		expect(events).toEqual([]);

		settlePreference();
		await completion;
		expect(events).toEqual(['preference', 'snapshot', 'connectionMutationComplete']);
	});

	it.each(['add', 'edit', 'test'] as const)('returns terminal failure for malformed Authority during %s', async action => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		viewer.connectionManager = {
			getConnections: vi.fn(() => action === 'edit' ? [{ id: 'c1', name: 'Stored', clusterUrl: 'https://cluster.kusto.windows.net' }] : []),
			addConnection: vi.fn(),
			updateConnection: vi.fn(),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };
		viewer.traceDatabaseList = vi.fn();

		const authorityId = 'https://login.microsoftonline.com/tenant';
		if (action === 'add') await viewer.onMessage({ type: 'connection.add', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });
		if (action === 'edit') await viewer.onMessage({ type: 'connection.edit', id: 'c1', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });
		if (action === 'test') await viewer.onMessage({ type: 'connection.test', name: 'Bad', clusterUrl: 'https://cluster.kusto.windows.net', authorityId });

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: action === 'test' ? 'testConnectionResult' : 'connectionMutationComplete',
			success: false,
		}));
	});
});

describe('ConnectionManagerViewerV2 table preview identity', () => {
	it('completes a preview when first automatic sign-in establishes the account partition', async () => {
		const viewer = createViewerHarness();
		const postMessage = vi.fn();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let currentPartition: string | undefined;
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]) };
		viewer.kustoClient = {
			executeQueryWithIdentity: vi.fn(async () => {
				currentPartition = 'partition-first-sign-in';
				return {
					accountPartition: currentPartition,
					result: { columns: [{ name: 'value', type: 'string' }], rows: [['ready']], metadata: { executionTime: '0.1s' } },
				};
			}),
			getAccountPartition: vi.fn(() => currentPartition),
			isAuthenticationError: vi.fn(() => false),
		};
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);
		viewer.panel = { webview: { postMessage } };

		await viewer.onMessage({ type: 'table.preview', connectionId: 'c1', database: 'Db', tableName: 'Events' });

		expect(postMessage).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: 'tablePreviewLoading', connectionId: 'c1', database: 'Db', tableName: 'Events', requestId: expect.any(String) }));
		expect(postMessage).toHaveBeenNthCalledWith(2, expect.objectContaining({
			type: 'tablePreviewResult',
			connectionId: 'c1',
			accountPartition: 'partition-first-sign-in',
			success: true,
			rows: [['ready']],
		}));
	});
});

describe('ConnectionManagerViewerV2 persisted search ownership', () => {
	it('drops Kusto search results when reopening under a different principal fingerprint', () => {
		const viewer = createViewerHarness();
		viewer.context = { globalState: { get: vi.fn(() => ({
			query: 'SecretA', scope: 'cached', lastResults: [{ name: 'SecretA' }],
			kustoPrincipalFingerprint: 'conn-a|partition-a',
		})) } };
		viewer.getActiveKind = vi.fn(() => 'kusto');
		viewer.getKustoSearchPrincipalFingerprint = vi.fn(() => 'conn-a|partition-b');

		expect(viewer.getSearchState()).toEqual(expect.objectContaining({ lastResults: [], lastSearchTimestamp: 0 }));
	});
});

describe('ConnectionManagerViewerV2 favorite prompt ownership', () => {
	it.each(['add', 'rename'] as const)('does not commit an A favorite %s after rotation to B', async action => {
		const viewer = createViewerHarness();
		const connection = { id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' };
		let partition = 'partition-a';
		const picked = deferred<string | undefined>();
		vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(picked.promise as any);
		viewer.connectionManager = { getConnections: vi.fn(() => [connection]) };
		viewer.kustoClient = { getAccountPartition: vi.fn(() => partition) };
		viewer.getFavorites = vi.fn(() => action === 'rename' ? [{
			name: 'A favorite', connectionId: 'c1', clusterUrl: connection.clusterUrl, database: 'SecretA',
		}] : []);
		viewer.setFavorites = vi.fn(async () => undefined);
		viewer.sendSnapshotToWebview = vi.fn(async () => undefined);

		const prompt = action === 'add'
			? viewer.promptAddFavorite('c1', 'SecretA')
			: viewer.promptRenameFavorite('c1', 'SecretA');
		await Promise.resolve();
		partition = 'partition-b';
		picked.resolve('Changed favorite');
		await prompt;

		expect(viewer.setFavorites).not.toHaveBeenCalled();
	});
});