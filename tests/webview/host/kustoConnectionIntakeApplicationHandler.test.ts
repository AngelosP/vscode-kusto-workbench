import * as os from 'os';
import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	HostKustoConnectionIntakeApplicationHandler,
	type KustoConnectionIntakeApplicationHandlerOptions,
} from '../../../src/host/kustoConnectionIntakeApplicationHandler';
import type { KustoConnection } from '../../../src/host/connectionManager';

const liveHandlers = new Set<HostKustoConnectionIntakeApplicationHandler>();

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHarness(existing: KustoConnection[] = []) {
	const connections = [...existing];
	const addConnection = vi.fn(async (connection: Omit<KustoConnection, 'id'>) => {
		const added = { id: `added-${connections.length + 1}`, ...connection };
		connections.push(added);
		return added;
	});
	const getConnections = vi.fn(() => [...connections]);
	const postMessage = vi.fn(() => Promise.resolve(true));
	const refreshConnections = vi.fn(async () => undefined);
	const options: KustoConnectionIntakeApplicationHandlerOptions = {
		connectionManager: { getConnections, addConnection },
		postMessage,
		refreshConnections,
	};
	const handler = new HostKustoConnectionIntakeApplicationHandler(options);
	liveHandlers.add(handler);
	return { handler, connections, addConnection, getConnections, postMessage, refreshConnections };
}

describe('HostKustoConnectionIntakeApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it('declines unrelated Kusto and SQL traffic synchronously', () => {
		const { handler, addConnection, postMessage, refreshConnections } = createHarness();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(addConnection).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(refreshConnections).not.toHaveBeenCalled();
	});

	it('normalizes, names, de-duplicates, and adds discovered clusters sequentially before one refresh', async () => {
		const firstAddition = deferred<KustoConnection>();
		const order: string[] = [];
		const { handler, addConnection, refreshConnections } = createHarness([{
			id: 'existing', name: 'Existing', clusterUrl: 'https://existing.kusto.windows.net',
		}]);
		addConnection.mockImplementation(async connection => {
			order.push(`add:${connection.clusterUrl}`);
			if (addConnection.mock.calls.length === 1) return firstAddition.promise;
			return { id: 'second', ...connection };
		});
		refreshConnections.mockImplementation(async () => { order.push('refresh'); });

		const request = handler.handleMessage({
			type: 'addConnectionsForClusters',
			clusterUrls: [
				'',
				'https://',
				'existing',
				' First.Kusto.Windows.Net ',
				'https://first.kusto.windows.net',
				'http://second.kusto.windows.net/path',
			],
		})!;
		await vi.waitFor(() => expect(addConnection).toHaveBeenCalledOnce());
		expect(refreshConnections).not.toHaveBeenCalled();
		expect(addConnection).toHaveBeenNthCalledWith(1, {
			name: 'first.kusto.windows.net',
			clusterUrl: 'https://First.Kusto.Windows.Net',
			database: undefined,
		});

		firstAddition.resolve({
			id: 'first', name: 'first.kusto.windows.net', clusterUrl: 'https://First.Kusto.Windows.Net',
		});
		await request;

		expect(addConnection).toHaveBeenCalledTimes(2);
		expect(addConnection).toHaveBeenNthCalledWith(2, {
			name: 'second.kusto.windows.net',
			clusterUrl: 'http://second.kusto.windows.net/path',
			database: undefined,
		});
		expect(order).toEqual([
			'add:https://First.Kusto.Windows.Net',
			'add:http://second.kusto.windows.net/path',
			'refresh',
		]);
	});

	it('refreshes once after empty or fully duplicate cluster intake', async () => {
		const { handler, addConnection, refreshConnections } = createHarness([{
			id: 'existing', name: 'Existing', clusterUrl: 'https://existing.kusto.windows.net',
		}]);

		await handler.handleMessage({ type: 'addConnectionsForClusters', clusterUrls: [] });
		await handler.handleMessage({
			type: 'addConnectionsForClusters', clusterUrls: ['existing.kusto.windows.net'],
		});

		expect(addConnection).not.toHaveBeenCalled();
		expect(refreshConnections).toHaveBeenCalledTimes(2);
	});

	it('propagates discovered-cluster mutation rejection without refreshing', async () => {
		const failure = new Error('connection persistence failed');
		const { handler, addConnection, refreshConnections } = createHarness();
		addConnection.mockRejectedValueOnce(failure);

		await expect(handler.handleMessage({
			type: 'addConnectionsForClusters', clusterUrls: ['new-cluster'],
		})).rejects.toBe(failure);

		expect(refreshConnections).not.toHaveBeenCalled();
	});

	it('imports by normalized cluster-plus-authority identity, skips failures, and refreshes after notification', async () => {
		const order: string[] = [];
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
			.mockImplementation((message: string) => {
				order.push(`notify:${message}`);
				return Promise.resolve(undefined) as any;
			});
		const { handler, addConnection, refreshConnections } = createHarness([
			{
				id: 'existing-organizations', name: 'Existing',
				clusterUrl: 'https://same.kusto.windows.net/', authorityId: 'organizations',
			},
			{
				id: 'historical', name: 'Historical',
				clusterUrl: 'https://historical.kusto.windows.net', authorityId: 'not a tenant',
			},
		]);
		addConnection.mockImplementation(async connection => {
			order.push(`add:${connection.name}`);
			if (connection.name === 'Fails') throw new Error('skip this addition');
			return { id: `added-${connection.name}`, ...connection };
		});
		refreshConnections.mockImplementation(async () => { order.push('refresh'); });

		await handler.handleMessage({
			type: 'importConnectionsFromXml',
			connections: [
				{ name: 'Duplicate', clusterUrl: 'same.kusto.windows.net', authorityId: 'organizations' },
				{ name: 'Malformed', clusterUrl: 'bad.kusto.windows.net', authorityId: 'not a tenant' },
				{ name: 'Fails', clusterUrl: 'fails.kusto.windows.net', authorityId: 'tenant.onmicrosoft.com' },
				{ name: 'First', clusterUrl: ' first.kusto.windows.net/ ', database: ' Samples ', authorityId: 'tenant.onmicrosoft.com' },
				{ name: 'First duplicate', clusterUrl: 'https://first.kusto.windows.net', database: 'Other', authorityId: 'TENANT.ONMICROSOFT.COM' },
				{ name: 'Same other tenant', clusterUrl: 'same.kusto.windows.net', authorityId: 'other.onmicrosoft.com' },
				{ name: '', clusterUrl: 'unnamed.kusto.windows.net' },
			],
		});

		expect(addConnection.mock.calls.map(call => call[0])).toEqual([
			{
				name: 'Fails', clusterUrl: 'https://fails.kusto.windows.net', database: undefined,
				authorityId: 'tenant.onmicrosoft.com',
			},
			{
				name: 'First', clusterUrl: 'https://first.kusto.windows.net', database: 'Samples',
				authorityId: 'tenant.onmicrosoft.com',
			},
			{
				name: 'Same other tenant', clusterUrl: 'https://same.kusto.windows.net', database: undefined,
				authorityId: 'other.onmicrosoft.com',
			},
			{
				name: 'https://unnamed.kusto.windows.net', clusterUrl: 'https://unnamed.kusto.windows.net',
				database: undefined, authorityId: undefined,
			},
		]);
		expect(showInformationMessage).toHaveBeenCalledWith('Imported 3 Kusto connections.');
		expect(order).toEqual([
			'add:Fails',
			'add:First',
			'add:Same other tenant',
			'add:https://unnamed.kusto.windows.net',
			'notify:Imported 3 Kusto connections.',
			'refresh',
		]);
	});

	it('preserves empty-import no-op notification behavior and still refreshes', async () => {
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage');
		const { handler, addConnection, refreshConnections } = createHarness();

		await handler.handleMessage({ type: 'importConnectionsFromXml', connections: [] });

		expect(addConnection).not.toHaveBeenCalled();
		expect(showInformationMessage).not.toHaveBeenCalled();
		expect(refreshConnections).toHaveBeenCalledOnce();
	});

	it('waits for each XML addition before starting the next and refreshes only after all settle', async () => {
		const firstAddition = deferred<KustoConnection>();
		vi.spyOn(vscode.window, 'showInformationMessage').mockResolvedValue(undefined as any);
		const { handler, addConnection, refreshConnections } = createHarness();
		addConnection
			.mockReturnValueOnce(firstAddition.promise)
			.mockResolvedValueOnce({
				id: 'second', name: 'Second', clusterUrl: 'https://second.kusto.windows.net',
			});

		const request = handler.handleMessage({
			type: 'importConnectionsFromXml',
			connections: [
				{ name: 'First', clusterUrl: 'first.kusto.windows.net' },
				{ name: 'Second', clusterUrl: 'second.kusto.windows.net' },
			],
		})!;
		await vi.waitFor(() => expect(addConnection).toHaveBeenCalledOnce());
		expect(refreshConnections).not.toHaveBeenCalled();

		firstAddition.resolve({ id: 'first', name: 'First', clusterUrl: 'https://first.kusto.windows.net' });
		await request;

		expect(addConnection).toHaveBeenCalledTimes(2);
		expect(addConnection.mock.calls.map(call => call[0].name)).toEqual(['First', 'Second']);
		expect(refreshConnections).toHaveBeenCalledOnce();
	});

	it('does not await the exact singular import notification before refreshing and settling', async () => {
		const neverSettlingNotification = new Promise<never>(() => undefined);
		const showInformationMessage = vi.spyOn(vscode.window, 'showInformationMessage')
			.mockReturnValue(neverSettlingNotification as any);
		const { handler, refreshConnections } = createHarness();

		await handler.handleMessage({
			type: 'importConnectionsFromXml',
			connections: [{ name: 'Only', clusterUrl: 'only.kusto.windows.net' }],
		});

		expect(showInformationMessage).toHaveBeenCalledWith('Imported 1 Kusto connection.');
		expect(refreshConnections).toHaveBeenCalledOnce();
	});

	it('reports the exact no-new-connections notification before refreshing', async () => {
		const order: string[] = [];
		vi.spyOn(vscode.window, 'showInformationMessage').mockImplementation((message: string) => {
			order.push(`notify:${message}`);
			return Promise.resolve(undefined) as any;
		});
		const { handler, refreshConnections } = createHarness([{
			id: 'existing', name: 'Existing', clusterUrl: 'https://same.kusto.windows.net',
		}]);
		refreshConnections.mockImplementation(async () => { order.push('refresh'); });

		await handler.handleMessage({
			type: 'importConnectionsFromXml',
			connections: [{ name: 'Duplicate', clusterUrl: 'same.kusto.windows.net' }],
		});

		expect(order).toEqual([
			'notify:No new connections were imported (they may already exist).',
			'refresh',
		]);
	});

	it('uses the LOCALAPPDATA Kusto.Explorer picker default and publishes exact UTF-8 text identity without refresh', async () => {
		vi.stubEnv('LOCALAPPDATA', '  C:\\Users\\test\\AppData\\Local  ');
		const pickedUri = vscode.Uri.file('C:\\Users\\test\\AppData\\Local\\Kusto.Explorer\\connections-東京.xml');
		const showOpenDialog = vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([pickedUri] as any);
		const bytes = new TextEncoder().encode('<Connection Name="José">東京</Connection>');
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile').mockResolvedValue(bytes);
		const { handler, postMessage, refreshConnections } = createHarness();

		await handler.handleMessage({ type: 'promptImportConnectionsXml', boxId: 'query-picker' });

		expect(showOpenDialog).toHaveBeenCalledWith({
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: expect.objectContaining({
				fsPath: path.join('C:\\Users\\test\\AppData\\Local', 'Kusto.Explorer'),
			}),
			openLabel: 'Import',
			filters: {
				'XML files': ['xml'],
				'All files': ['*'],
			},
		});
		expect(readFile).toHaveBeenCalledWith(pickedUri);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'importConnectionsXmlText',
			boxId: 'query-picker',
			text: '<Connection Name="José">東京</Connection>',
			fileName: 'connections-東京.xml',
		});
		expect(refreshConnections).not.toHaveBeenCalled();
	});

	it('uses the home fallback picker default and treats cancellation as a response-free no-op', async () => {
		vi.stubEnv('LOCALAPPDATA', '   ');
		const showOpenDialog = vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue(undefined);
		const readFile = vi.spyOn(vscode.workspace.fs, 'readFile');
		const { handler, postMessage, refreshConnections } = createHarness();

		await handler.handleMessage({ type: 'promptImportConnectionsXml' });

		expect(showOpenDialog).toHaveBeenCalledWith(expect.objectContaining({
			defaultUri: expect.objectContaining({
				fsPath: path.join(os.homedir(), 'AppData', 'Local', 'Kusto.Explorer'),
			}),
		}));
		expect(readFile).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(refreshConnections).not.toHaveBeenCalled();
	});

	it.each([
		{ failure: new Error('read failed'), expected: 'read failed' },
		{ failure: 'string failure', expected: 'string failure' },
	])('publishes the exact picker/read error object for $expected', async ({ failure, expected }) => {
		const pickedUri = vscode.Uri.file('C:\\temp\\connections.xml');
		vi.spyOn(vscode.window, 'showOpenDialog').mockResolvedValue([pickedUri] as any);
		vi.spyOn(vscode.workspace.fs, 'readFile').mockRejectedValue(failure);
		const { handler, postMessage, refreshConnections } = createHarness();

		await handler.handleMessage({ type: 'promptImportConnectionsXml', boxId: 'query-error' });

		expect(postMessage).toHaveBeenCalledWith({
			type: 'importConnectionsXmlError', boxId: 'query-error', error: expected,
		});
		expect(refreshConnections).not.toHaveBeenCalled();
	});

	it('lets accepted mutation and refresh settle across disposal, then suppresses later related requests idempotently', async () => {
		const addition = deferred<KustoConnection>();
		const refresh = deferred<void>();
		const { handler, addConnection, refreshConnections, postMessage } = createHarness();
		addConnection.mockReturnValueOnce(addition.promise);
		refreshConnections.mockReturnValueOnce(refresh.promise);
		const accepted = handler.handleMessage({
			type: 'addConnectionsForClusters', clusterUrls: ['accepted.kusto.windows.net'],
		})!;
		await vi.waitFor(() => expect(addConnection).toHaveBeenCalledOnce());

		handler.dispose();
		handler.dispose();
		addition.resolve({ id: 'accepted', name: 'Accepted', clusterUrl: 'https://accepted.kusto.windows.net' });
		await vi.waitFor(() => expect(refreshConnections).toHaveBeenCalledOnce());
		let settled = false;
		void accepted.then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		refresh.resolve();
		await accepted;
		expect(settled).toBe(true);

		await handler.handleMessage({ type: 'addConnectionsForClusters', clusterUrls: ['later'] });
		await handler.handleMessage({ type: 'promptImportConnectionsXml', boxId: 'later' });
		await handler.handleMessage({ type: 'importConnectionsFromXml', connections: [] });

		expect(addConnection).toHaveBeenCalledOnce();
		expect(refreshConnections).toHaveBeenCalledOnce();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('preserves an accepted mutation rejection across disposal without refreshing', async () => {
		const addition = deferred<KustoConnection>();
		const { handler, addConnection, refreshConnections } = createHarness();
		addConnection.mockReturnValueOnce(addition.promise);
		const request = handler.handleMessage({
			type: 'addConnectionsForClusters', clusterUrls: ['accepted-failure.kusto.windows.net'],
		})!;
		const failure = new Error('accepted mutation failed');
		const rejection = expect(request).rejects.toBe(failure);
		await vi.waitFor(() => expect(addConnection).toHaveBeenCalledOnce());

		handler.dispose();
		addition.reject(failure);

		await rejection;
		expect(refreshConnections).not.toHaveBeenCalled();
	});
});