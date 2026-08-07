import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	HostSqlFavoritesApplicationHandler,
	type SqlFavoritesApplicationHandlerOptions,
} from '../../../src/host/sqlFavoritesApplicationHandler';
import { STORAGE_KEYS, type IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

const liveHandlers = new Set<HostSqlFavoritesApplicationHandler>();

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createHarness(
	initialRaw: unknown = [],
	overrides: Partial<SqlFavoritesApplicationHandlerOptions> = {},
) {
	let stored = initialRaw;
	const getConnection = vi.fn(() => ({
		id: 'sql_sales',
		name: 'Sales SQL',
		dialect: 'mssql',
		serverUrl: 'sales.database.windows.net',
		authType: 'aad',
	}));
	const globalStateGet = vi.fn((_key: string) => stored);
	const globalStateUpdate = vi.fn(async (_key: string, value: unknown) => {
		stored = value;
	});
	const postMessage = vi.fn(async () => true);
	const warn = vi.fn();
	const options: SqlFavoritesApplicationHandlerOptions = {
		connectionManager: { getConnection },
		globalState: { get: globalStateGet, update: globalStateUpdate },
		postMessage,
		output: { warn },
		...overrides,
	};
	const handler = new HostSqlFavoritesApplicationHandler(options);
	liveHandlers.add(handler);
	return {
		handler,
		getConnection,
		globalStateGet,
		globalStateUpdate,
		postMessage,
		warn,
		getStored: () => stored,
		setStored: (value: unknown) => { stored = value; },
	};
}

describe('HostSqlFavoritesApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.restoreAllMocks();
	});

	it('declines unrelated traffic synchronously', () => {
		const harness = createHarness();

		expect(harness.handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
		expect(harness.globalStateGet).not.toHaveBeenCalled();
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('returns only sanitized current SQL favorites', () => {
		const harness = createHarness([
			{ name: '  Sales  ', connectionId: ' sql_sales ', database: ' SalesDb ' },
			{ name: '', connectionId: 'sql_sales', database: 'Ignored' },
			{ name: 'Missing database', connectionId: 'sql_sales' },
			null,
			'bad',
		]);

		expect(harness.handler.getFavorites()).toEqual([
			{ name: 'Sales', connectionId: 'sql_sales', database: 'SalesDb' },
		]);
		expect(harness.globalStateGet).toHaveBeenCalledWith(STORAGE_KEYS.sqlFavorites);
	});

	it.each([
		{ type: 'requestAddSqlFavorite', connectionId: '   ', database: 'SalesDb' },
		{ type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: '   ' },
		{ type: 'removeSqlFavorite', connectionId: '   ', database: 'SalesDb' },
		{ type: 'removeSqlFavorite', connectionId: 'sql_sales', database: '   ' },
	] as IncomingWebviewMessage[])('keeps blank $type input response-free and side-effect-free', async message => {
		const harness = createHarness();
		const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Ignored');

		await harness.handler.handleMessage(message);

		expect(showInputBox).not.toHaveBeenCalled();
		expect(harness.getConnection).not.toHaveBeenCalled();
		expect(harness.globalStateGet).not.toHaveBeenCalled();
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: 'connection name',
			connection: { name: 'Named SQL', serverUrl: 'named.database.windows.net' },
			defaultName: undefined,
			expected: 'Named SQL.SalesDb',
		},
		{
			label: 'server URL',
			connection: { name: '', serverUrl: 'server.database.windows.net' },
			defaultName: undefined,
			expected: 'server.database.windows.net.SalesDb',
		},
		{
			label: 'connection ID',
			connection: undefined,
			defaultName: undefined,
			expected: 'sql_sales.SalesDb',
		},
		{
			label: 'explicit default',
			connection: { name: 'Ignored', serverUrl: 'ignored.database.windows.net' },
			defaultName: '  Friendly default  ',
			expected: 'Friendly default',
		},
	])('uses the exact prompt options and $label fallback', async ({ connection, defaultName, expected }) => {
		const harness = createHarness();
		harness.getConnection.mockReturnValue(connection as ReturnType<typeof harness.getConnection>);
		const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);

		await harness.handler.handleMessage({
			type: 'requestAddSqlFavorite',
			connectionId: ' sql_sales ',
			database: ' SalesDb ',
			defaultName,
			boxId: 'sql-box',
		});

		expect(harness.getConnection).toHaveBeenCalledWith('sql_sales');
		expect(showInputBox).toHaveBeenCalledWith({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this server + database',
			value: expected,
			ignoreFocusOut: true,
		});
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it.each([undefined, '   '])('treats a %s prompt result as cancellation', async picked => {
		const harness = createHarness();
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(picked);

		await harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb', boxId: 'sql-box',
		});

		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('replaces every case-insensitive match in place with submitted spelling and publishes the add box', async () => {
		const firstMatch = { name: 'Old one', connectionId: 'sql_sales', database: 'SalesDb' };
		const other = { name: 'Other', connectionId: 'sql_other', database: 'Warehouse' };
		const duplicate = { name: 'Old two', connectionId: 'sql_sales', database: 'salesdb' };
		const order: string[] = [];
		const harness = createHarness([firstMatch, other, duplicate]);
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('  Renamed favorite  ');
		harness.globalStateUpdate.mockImplementation(async (_key, value) => {
			order.push('storage');
			harness.setStored(value);
		});
		harness.postMessage.mockImplementation(async () => {
			order.push('publication');
			return true;
		});

		await harness.handler.handleMessage({
			type: 'requestAddSqlFavorite',
			connectionId: ' sql_sales ',
			database: ' sAlEsDb ',
			boxId: 'originating-box',
		});

		const expected = [
			{ name: 'Renamed favorite', connectionId: 'sql_sales', database: 'sAlEsDb' },
			other,
			{ name: 'Renamed favorite', connectionId: 'sql_sales', database: 'sAlEsDb' },
		];
		expect(harness.globalStateUpdate).toHaveBeenCalledWith(STORAGE_KEYS.sqlFavorites, expected);
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'sqlFavoritesData', favorites: expected, boxId: 'originating-box',
		});
		expect(order).toEqual(['storage', 'publication']);
	});

	it('appends a missing favorite after the sanitized current list', async () => {
		const existing = { name: 'Existing', connectionId: 'sql_other', database: 'Warehouse' };
		const harness = createHarness([null, existing]);
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('  Sales  ');

		await harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: ' sql_sales ', database: ' SalesDb ',
		});

		const expected = [existing, { name: 'Sales', connectionId: 'sql_sales', database: 'SalesDb' }];
		expect(harness.globalStateUpdate).toHaveBeenCalledWith(STORAGE_KEYS.sqlFavorites, expected);
		expect(harness.postMessage).toHaveBeenCalledWith({ type: 'sqlFavoritesData', favorites: expected });
	});

	it('removes case-insensitively, persists unchanged removals, and never publishes the removal box', async () => {
		const keep = { name: 'Keep', connectionId: 'sql_other', database: 'Warehouse' };
		const harness = createHarness([
			{ name: 'One', connectionId: 'sql_sales', database: 'SalesDb' },
			keep,
			{ name: 'Two', connectionId: 'sql_sales', database: 'salesdb' },
		]);

		await harness.handler.handleMessage({
			type: 'removeSqlFavorite', connectionId: ' sql_sales ', database: ' SALESDB ', boxId: 'ignored-box',
		});

		expect(harness.globalStateUpdate).toHaveBeenNthCalledWith(1, STORAGE_KEYS.sqlFavorites, [keep]);
		expect(harness.postMessage).toHaveBeenNthCalledWith(1, { type: 'sqlFavoritesData', favorites: [keep] });

		await harness.handler.handleMessage({
			type: 'removeSqlFavorite', connectionId: 'sql_missing', database: 'MissingDb', boxId: 'ignored-again',
		});

		expect(harness.globalStateUpdate).toHaveBeenNthCalledWith(2, STORAGE_KEYS.sqlFavorites, [keep]);
		expect(harness.postMessage).toHaveBeenNthCalledWith(2, { type: 'sqlFavoritesData', favorites: [keep] });
	});

	it('propagates the exact storage rejection without publishing or logging', async () => {
		const failure = new Error('favorite storage failed');
		const update = vi.fn(() => Promise.reject(failure));
		const harness = createHarness([], { globalState: { get: vi.fn(() => []), update } });
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Sales');

		await expect(harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
		})).rejects.toBe(failure);
		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(harness.warn).not.toHaveBeenCalled();
	});

	it('awaits publication and contains its rejection with the exact warning', async () => {
		const publication = deferred<boolean>();
		const failure = new Error('favorite publication failed');
		const postMessage = vi.fn(() => publication.promise);
		const harness = createHarness([], { postMessage });
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Sales');
		let settled = false;
		const request = harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
		})!;
		void request.then(() => { settled = true; });
		await vi.waitFor(() => expect(postMessage).toHaveBeenCalledOnce());
		expect(settled).toBe(false);

		publication.reject(failure);
		await expect(request).resolves.toBeUndefined();
		expect(settled).toBe(true);
		expect(harness.warn).toHaveBeenCalledWith(
			'[favorites] Failed to send sqlFavoritesData: favorite publication failed',
		);
	});

	it('contains logging failure after a rejected publication', async () => {
		const warn = vi.fn(() => { throw new Error('logger failed'); });
		const postMessage = vi.fn(() => Promise.reject('transport failed'));
		const harness = createHarness([], { postMessage, output: { warn } });
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Sales');

		await expect(harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
		})).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalledWith(
			'[favorites] Failed to send sqlFavoritesData: transport failed',
		);
	});

	it('lets accepted success settle across idempotent disposal and suppresses later requests', async () => {
		const storage = deferred<void>();
		const harness = createHarness();
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Sales');
		harness.globalStateUpdate.mockImplementation((_key, value) => {
			harness.setStored(value);
			return storage.promise;
		});
		const accepted = harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb', boxId: 'accepted-box',
		})!;
		await vi.waitFor(() => expect(harness.globalStateUpdate).toHaveBeenCalledOnce());

		harness.handler.dispose();
		harness.handler.dispose();
		const laterAdd = harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'LaterDb',
		});
		const laterRemove = harness.handler.handleMessage({
			type: 'removeSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
		});
		storage.resolve();

		await expect(accepted).resolves.toBeUndefined();
		await expect(laterAdd).resolves.toBeUndefined();
		await expect(laterRemove).resolves.toBeUndefined();
		expect(harness.globalStateUpdate).toHaveBeenCalledOnce();
		expect(harness.postMessage).toHaveBeenCalledOnce();
	});

	it('preserves an accepted storage rejection across disposal', async () => {
		const storage = deferred<void>();
		const failure = new Error('accepted storage failure');
		const harness = createHarness([], {
			globalState: { get: vi.fn(() => []), update: vi.fn(() => storage.promise) },
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Sales');
		const accepted = harness.handler.handleMessage({
			type: 'requestAddSqlFavorite', connectionId: 'sql_sales', database: 'SalesDb',
		})!;
		await Promise.resolve();

		harness.handler.dispose();
		storage.reject(failure);

		await expect(accepted).rejects.toBe(failure);
		expect(harness.postMessage).not.toHaveBeenCalled();
	});
});
