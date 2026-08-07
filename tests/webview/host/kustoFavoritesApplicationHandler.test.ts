import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const listenerLogger = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../../../src/host/workbenchLogger', async importOriginal => ({
	...await importOriginal<typeof import('../../../src/host/workbenchLogger')>(),
	getWorkbenchLogger: () => ({ warn: listenerLogger.warn }),
}));

import type { KustoConnection } from '../../../src/host/connectionManager';
import {
	HostKustoFavoritesApplicationHandler,
	normalizeFavoriteClusterUrl,
	type KustoFavoritesApplicationHandlerOptions,
} from '../../../src/host/kustoFavoritesApplicationHandler';
import { STORAGE_KEYS, type IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

const liveHandlers = new Set<HostKustoFavoritesApplicationHandler>();
const listenerDisposables: vscode.Disposable[] = [];

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

type HarnessConfig = {
	initialRaw?: unknown;
	store?: Map<string, unknown>;
	connections?: KustoConnection[];
	getAccountPartition?: (connection: KustoConnection) => string | undefined;
	omitClientPartitionResolver?: boolean;
	preferredAccountId?: string;
	fallbackAccountPartition?: string;
	postMessage?: KustoFavoritesApplicationHandlerOptions['postMessage'];
	update?: (key: string, value: unknown, store: Map<string, unknown>) => PromiseLike<void>;
	warn?: (message: string) => void;
};

function createHarness(config: HarnessConfig = {}) {
	const store = config.store ?? new Map<string, unknown>();
	if (Object.prototype.hasOwnProperty.call(config, 'initialRaw')) {
		store.set(STORAGE_KEYS.favorites, config.initialRaw);
	}
	let connections = config.connections ?? [{
		id: 'kusto_sales',
		name: 'Sales Kusto',
		clusterUrl: 'https://Sales.Kusto.Windows.Net',
		authorityId: 'tenant-a',
	}];
	const getConnections = vi.fn(() => connections);
	const getAccountPartition = vi.fn(
		config.getAccountPartition ?? (() => 'partition-a'),
	);
	const getPreferredAccountId = vi.fn(() => config.preferredAccountId ?? 'account-a');
	const getFallbackAccountPartition = vi.fn(
		() => config.fallbackAccountPartition ?? 'fallback-partition',
	);
	const globalStateGet = vi.fn(<T>(key: string, fallback?: T): T | undefined => (
		store.has(key) ? store.get(key) as T : fallback
	));
	const globalStateUpdate = vi.fn(async (key: string, value: unknown) => {
		if (config.update) {
			await config.update(key, value, store);
			return;
		}
		store.set(key, value);
	});
	const context = {
		globalState: { get: globalStateGet, update: globalStateUpdate },
	} as unknown as vscode.ExtensionContext;
	const postMessage = vi.fn(config.postMessage ?? (async () => true));
	const warn = vi.fn(config.warn ?? (() => undefined));
	const options: KustoFavoritesApplicationHandlerOptions = {
		context,
		connectionManager: { getConnections },
		kustoClient: config.omitClientPartitionResolver ? {} : { getAccountPartition },
		authPreferences: {
			getPreferredAccountId,
			getAccountPartition: getFallbackAccountPartition,
		},
		postMessage,
		output: { warn },
	};
	const handler = new HostKustoFavoritesApplicationHandler(options);
	liveHandlers.add(handler);
	return {
		handler,
		context,
		store,
		getConnections,
		getAccountPartition,
		getPreferredAccountId,
		getFallbackAccountPartition,
		globalStateGet,
		globalStateUpdate,
		postMessage,
		warn,
		getStored: () => store.get(STORAGE_KEYS.favorites),
		setStored: (value: unknown) => { store.set(STORAGE_KEYS.favorites, value); },
		setConnections: (value: KustoConnection[]) => { connections = value; },
	};
}

function addMessage(overrides: Partial<Extract<IncomingWebviewMessage, { type: 'requestAddFavorite' }>> = {}) {
	return {
		type: 'requestAddFavorite',
		connectionId: 'kusto_sales',
		clusterUrl: 'Sales.Kusto.Windows.Net/',
		database: 'SalesDb',
		boxId: 'originating-box',
		...overrides,
	} satisfies IncomingWebviewMessage;
}

describe('HostKustoFavoritesApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		for (const disposable of listenerDisposables.splice(0)) disposable.dispose();
		listenerLogger.warn.mockReset();
		vi.restoreAllMocks();
	});

	it.each([
		['mycluster.kusto.windows.net', 'https://mycluster.kusto.windows.net'],
		['https://mycluster.kusto.windows.net/', 'https://mycluster.kusto.windows.net'],
		['  https://mycluster  ', 'https://mycluster'],
		['', ''],
		['https://mycluster///', 'https://mycluster'],
		['HTTPS://MyCluster.Kusto.Windows.Net/', 'HTTPS://MyCluster.Kusto.Windows.Net'],
	])('normalizes favorite cluster URL %s', (input, expected) => {
		expect(normalizeFavoriteClusterUrl(input)).toBe(expected);
	});

	it('declines unrelated traffic synchronously', () => {
		const harness = createHarness();

		expect(harness.handler.handleMessage({ type: 'getConnections' })).toBeUndefined();
		expect(harness.globalStateGet).not.toHaveBeenCalled();
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('returns an empty projection for missing storage without writing', () => {
		const harness = createHarness();

		expect(harness.handler.getFavorites()).toEqual([]);
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
	});

	it('repairs malformed non-array storage with a fire-and-forget write', () => {
		const migration = deferred<void>();
		const harness = createHarness({
			initialRaw: { malformed: true },
			update: (_key, value, store) => {
				store.set(STORAGE_KEYS.favorites, value);
				return migration.promise;
			},
		});

		expect(harness.handler.getFavorites()).toEqual([]);
		expect(harness.globalStateUpdate).toHaveBeenCalledWith(STORAGE_KEYS.favorites, []);
		migration.resolve();
	});

	it('migrates a uniquely resolved legacy favorite and strips its principal from the projection', () => {
		const migration = deferred<void>();
		const raw = [{
			name: 'Legacy',
			clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'LegacyDb',
		}];
		const harness = createHarness({
			initialRaw: raw,
			update: (_key, value, store) => {
				store.set(STORAGE_KEYS.favorites, value);
				return migration.promise;
			},
		});

		expect(harness.handler.getFavorites()).toEqual([{
			name: 'Legacy',
			connectionId: 'kusto_sales',
			clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'LegacyDb',
		}]);
		expect(harness.globalStateUpdate).toHaveBeenCalledWith(STORAGE_KEYS.favorites, [{
			name: 'Legacy',
			connectionId: 'kusto_sales',
			clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'LegacyDb',
			accountPartition: 'partition-a',
		}]);
		migration.resolve();
	});

	it('does not destructively rewrite storage when migration has unresolved entries', () => {
		const harness = createHarness({
			initialRaw: [{ name: 'Unknown', clusterUrl: 'https://unknown.kusto.windows.net', database: 'Db' }],
		});

		expect(harness.handler.getFavorites()).toEqual([]);
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
	});

	it.each([
		{
			label: 'add',
			message: addMessage({ database: 'NewDb' }),
			prepare: () => vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('New favorite'),
		},
		{
			label: 'remove',
			message: {
				type: 'removeFavorite', connectionId: 'kusto_sales',
				clusterUrl: 'https://Sales.Kusto.Windows.Net', database: 'VisibleDb',
			} satisfies IncomingWebviewMessage,
			prepare: () => undefined,
		},
	])('fails closed on $label when stored favorites include an unresolved entry', async ({ message, prepare }) => {
		const raw = [
			{
				name: 'Visible', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
				database: 'VisibleDb', accountPartition: 'partition-a',
			},
			{ name: 'Unresolved', clusterUrl: 'https://missing.kusto.windows.net', database: 'MissingDb' },
		];
		const harness = createHarness({ initialRaw: raw });
		prepare();

		await harness.handler.handleMessage(message);

		expect(harness.getStored()).toBe(raw);
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('filters hidden-principal favorites and uses auth-preference fallback without a client resolver', () => {
		const harness = createHarness({
			omitClientPartitionResolver: true,
			fallbackAccountPartition: 'partition-a',
			initialRaw: [
				{
					name: 'Visible', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
					database: 'VisibleDb', accountPartition: 'partition-a',
				},
				{
					name: 'Hidden', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
					database: 'HiddenDb', accountPartition: 'partition-b',
				},
			],
		});

		expect(harness.handler.getFavorites()).toEqual([{
			name: 'Visible', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net', database: 'VisibleDb',
		}]);
		expect(harness.getPreferredAccountId).toHaveBeenCalledWith('kusto_sales');
		expect(harness.getFallbackAccountPartition).toHaveBeenCalledWith('tenant-a', 'account-a');
		expect(harness.getAccountPartition).not.toHaveBeenCalled();
	});

	it('isolates a throwing partition resolver and fails closed for that connection', async () => {
		const connections = [
			{ id: 'kusto_sales', name: 'Sales', clusterUrl: 'https://Sales.Kusto.Windows.Net' },
			{ id: 'kusto_other', name: 'Other', clusterUrl: 'https://other.kusto.windows.net' },
		];
		const harness = createHarness({
			connections,
			getAccountPartition: connection => {
				if (connection.id === 'kusto_sales') throw new Error('malformed authority');
				return 'partition-other';
			},
			initialRaw: [
				{
					name: 'Hidden failed owner', connectionId: 'kusto_sales',
					clusterUrl: 'https://Sales.Kusto.Windows.Net', database: 'SalesDb',
					accountPartition: 'partition-sales',
				},
				{
					name: 'Visible other', connectionId: 'kusto_other',
					clusterUrl: 'https://other.kusto.windows.net', database: 'OtherDb',
					accountPartition: 'partition-other',
				},
			],
		});
		const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Ignored');

		expect(harness.handler.getFavorites()).toEqual([{
			name: 'Visible other', connectionId: 'kusto_other',
			clusterUrl: 'https://other.kusto.windows.net', database: 'OtherDb',
		}]);
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();

		await harness.handler.handleMessage(addMessage());
		expect(showInputBox).not.toHaveBeenCalled();
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it.each([
		addMessage({ connectionId: '   ' }),
		addMessage({ clusterUrl: '   ' }),
		addMessage({ database: '   ' }),
		{ type: 'removeFavorite', connectionId: '   ', clusterUrl: 'https://sales', database: 'SalesDb' },
		{ type: 'removeFavorite', connectionId: 'kusto_sales', clusterUrl: 'https://sales', database: '   ' },
		{
			type: 'confirmRemoveFavorite', requestId: '   ', connectionId: 'kusto_sales',
			clusterUrl: 'https://sales', database: 'SalesDb',
		},
	] as IncomingWebviewMessage[])('keeps blank $type input response-free and side-effect-free', async message => {
		const harness = createHarness();
		const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Ignored');
		const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Remove');

		await harness.handler.handleMessage(message);

		expect(showInputBox).not.toHaveBeenCalled();
		expect(showWarningMessage).not.toHaveBeenCalled();
		expect(harness.globalStateGet).not.toHaveBeenCalled();
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it.each([
		{ defaultName: '  Explicit favorite  ', expected: 'Explicit favorite' },
		{ defaultName: undefined, expected: 'sales.SalesDb' },
	])('uses the exact add prompt with $expected default', async ({ defaultName, expected }) => {
		const harness = createHarness();
		const showInputBox = vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(undefined);

		await harness.handler.handleMessage(addMessage({ defaultName }));

		expect(showInputBox).toHaveBeenCalledWith({
			title: 'Add to favorites',
			prompt: 'Enter a friendly name for this cluster + database',
			value: expected,
			ignoreFocusOut: true,
		});
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
	});

	it.each([undefined, '   '])('treats a %s add prompt result as cancellation', async picked => {
		const harness = createHarness();
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(picked);

		await harness.handler.handleMessage(addMessage());

		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('does not add when the connection disappears while the prompt is open', async () => {
		const picked = deferred<string | undefined>();
		const harness = createHarness();
		vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(picked.promise);
		const request = harness.handler.handleMessage(addMessage())!;
		await Promise.resolve();
		harness.setConnections([]);
		picked.resolve('Favorite');

		await request;
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('does not assign an A favorite to B when the principal changes while the prompt is open', async () => {
		let partition = 'partition-a';
		const picked = deferred<string | undefined>();
		const harness = createHarness({ getAccountPartition: () => partition });
		vi.spyOn(vscode.window, 'showInputBox').mockReturnValue(picked.promise);
		const request = harness.handler.handleMessage(addMessage())!;
		await Promise.resolve();
		partition = 'partition-b';
		picked.resolve('A favorite');

		await request;
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
	});

	it('revalidates the account partition immediately before persistence', async () => {
		let partitionRead = 0;
		const harness = createHarness({
			initialRaw: [],
			getAccountPartition: () => ++partitionRead < 4 ? 'partition-a' : 'partition-b',
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Favorite');

		await harness.handler.handleMessage(addMessage());

		expect(partitionRead).toBeGreaterThanOrEqual(4);
		expect(harness.globalStateUpdate).not.toHaveBeenCalled();
		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('replaces a case-insensitive active match in place and preserves hidden-principal favorites', async () => {
		const hidden = {
			name: 'Hidden B', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'SecretB', accountPartition: 'partition-b',
		};
		const active = {
			name: 'Old A', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'SalesDb', accountPartition: 'partition-a',
		};
		const other = {
			name: 'Other', connectionId: 'kusto_other', clusterUrl: 'https://other.kusto.windows.net',
			database: 'Warehouse', accountPartition: 'partition-other',
		};
		const harness = createHarness({
			connections: [
				{ id: 'kusto_sales', name: 'Sales', clusterUrl: 'https://Sales.Kusto.Windows.Net', authorityId: 'tenant-a' },
				{ id: 'kusto_other', name: 'Other', clusterUrl: 'https://other.kusto.windows.net', authorityId: 'tenant-other' },
			],
			getAccountPartition: connection => connection.id === 'kusto_sales' ? 'partition-a' : 'partition-other',
			initialRaw: [hidden, active, other],
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('  Renamed A  ');

		await harness.handler.handleMessage(addMessage({
			clusterUrl: ' https://Sales.Kusto.Windows.Net/// ',
			database: ' sAlEsDb ',
		}));

		expect(harness.globalStateUpdate).toHaveBeenNthCalledWith(1, STORAGE_KEYS.favorites, [
			hidden,
			{
				name: 'Renamed A', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
				database: 'sAlEsDb', accountPartition: 'partition-a',
			},
			other,
		]);
		expect(harness.getStored()).toEqual([
			hidden,
			{
				name: 'Renamed A', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
				database: 'sAlEsDb', accountPartition: 'partition-a',
			},
			other,
		]);
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'favoritesData',
			boxId: 'originating-box',
			favorites: [
				{
					name: 'Renamed A', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
					database: 'sAlEsDb',
				},
				{
					name: 'Other', connectionId: 'kusto_other', clusterUrl: 'https://other.kusto.windows.net', database: 'Warehouse',
				},
			],
		});
	});

	it('appends a missing active favorite with the captured account partition', async () => {
		const existing = {
			name: 'Existing', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'ExistingDb', accountPartition: 'partition-a',
		};
		const harness = createHarness({ initialRaw: [existing] });
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('New favorite');

		await harness.handler.handleMessage(addMessage({ database: 'NewDb' }));

		expect(harness.getStored()).toEqual([
			existing,
			{
				name: 'New favorite', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
				database: 'NewDb', accountPartition: 'partition-a',
			},
		]);
	});

	it('keeps differently cased connection IDs distinct while matching database names case-insensitively', async () => {
		const upperConnection = {
			id: 'KUSTO_SALES', name: 'Upper Sales', clusterUrl: 'https://upper.kusto.windows.net',
		};
		const existing = {
			name: 'Upper favorite', connectionId: 'KUSTO_SALES', clusterUrl: upperConnection.clusterUrl,
			database: 'SalesDb', accountPartition: 'partition-upper',
		};
		const harness = createHarness({
			connections: [
				{ id: 'kusto_sales', name: 'Sales', clusterUrl: 'https://Sales.Kusto.Windows.Net' },
				upperConnection,
			],
			getAccountPartition: connection => connection.id === 'KUSTO_SALES' ? 'partition-upper' : 'partition-a',
			initialRaw: [existing],
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Lower favorite');

		await harness.handler.handleMessage(addMessage({ database: 'salesdb' }));

		expect(harness.getStored()).toEqual([
			existing,
			{
				name: 'Lower favorite', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
				database: 'salesdb', accountPartition: 'partition-a',
			},
		]);
	});

	it('removes case-insensitively, persists unchanged removals, and never publishes a removal box', async () => {
		const hidden = {
			name: 'Hidden', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'SalesDb', accountPartition: 'partition-b',
		};
		const remove = {
			name: 'Remove', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'SalesDb', accountPartition: 'partition-a',
		};
		const keep = {
			name: 'Keep', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net',
			database: 'KeepDb', accountPartition: 'partition-a',
		};
		const harness = createHarness({ initialRaw: [hidden, remove, keep] });

		await harness.handler.handleMessage({
			type: 'removeFavorite', connectionId: ' kusto_sales ', clusterUrl: 'ignored',
			database: ' SALESDB ', boxId: 'ignored-box',
		});
		expect(harness.getStored()).toEqual([hidden, keep]);
		expect(harness.postMessage).toHaveBeenNthCalledWith(1, {
			type: 'favoritesData',
			favorites: [{
				name: 'Keep', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net', database: 'KeepDb',
			}],
		});

		await harness.handler.handleMessage({
			type: 'removeFavorite', connectionId: 'kusto_missing', clusterUrl: 'ignored',
			database: 'MissingDb', boxId: 'ignored-again',
		});
		expect(harness.globalStateUpdate).toHaveBeenCalledTimes(2);
		expect(harness.getStored()).toEqual([hidden, keep]);
		expect(harness.postMessage).toHaveBeenNthCalledWith(2, {
			type: 'favoritesData',
			favorites: [{
				name: 'Keep', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net', database: 'KeepDb',
			}],
		});
	});

	it('propagates the exact storage rejection before broadcasting', async () => {
		const failure = new Error('favorite storage failed');
		const harness = createHarness({
			initialRaw: [],
			update: () => Promise.reject(failure),
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Favorite');

		await expect(harness.handler.handleMessage(addMessage())).rejects.toBe(failure);
		expect(harness.postMessage).not.toHaveBeenCalled();
		expect(harness.warn).not.toHaveBeenCalled();
	});

	it('contains fire-and-forget publication failure with the exact warning', async () => {
		const harness = createHarness({
			initialRaw: [],
			postMessage: () => Promise.reject(new Error('transport failed')),
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Favorite');

		await expect(harness.handler.handleMessage(addMessage())).resolves.toBeUndefined();
		await vi.waitFor(() => expect(harness.warn).toHaveBeenCalledWith(
			'[favorites] Failed to broadcast favoritesData: transport failed',
		));
	});

	it('contains logger failure after a rejected publication', async () => {
		const harness = createHarness({
			initialRaw: [],
			postMessage: () => Promise.reject('transport failed'),
			warn: () => { throw new Error('logger failed'); },
		});
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Favorite');

		await expect(harness.handler.handleMessage(addMessage())).resolves.toBeUndefined();
		await vi.waitFor(() => expect(harness.warn).toHaveBeenCalledWith(
			'[favorites] Failed to broadcast favoritesData: transport failed',
		));
	});

	const openFileClasses = [
		{ id: 'kqlx', label: '.kqlx', supportsManySections: true },
		{ id: 'plain-kql', label: 'plain .kql', supportsManySections: false },
		{ id: 'plain-csl', label: 'plain .csl', supportsManySections: false },
		{ id: 'kql-sidecar', label: '.kql + .kql.json', supportsManySections: true },
		{ id: 'csl-sidecar', label: '.csl + .csl.json', supportsManySections: true },
	];
	const oneSectionProviderPermutations = openFileClasses.flatMap(source =>
		openFileClasses.map(target => ({
			shape: 'one-section open files', source, target, sourceSections: 1, targetSections: 1,
		})),
	);
	const manySectionProviderPermutations = openFileClasses
		.filter(fileClass => fileClass.supportsManySections)
		.flatMap(source => openFileClasses
			.filter(fileClass => fileClass.supportsManySections)
			.map(target => ({
				shape: 'many-section open files', source, target, sourceSections: 3, targetSections: 3,
			})),
		);

	it.each([...oneSectionProviderPermutations, ...manySectionProviderPermutations])(
		'notifies already-open $target.label target when $source.label source changes favorites ($shape, source sections=$sourceSections, target sections=$targetSections)',
		async ({ source, target, shape, sourceSections, targetSections }) => {
			const sharedStore = new Map<string, unknown>();
			const key = `${shape}-${source.id}-to-${target.id}-${sourceSections}-${targetSections}`;
			const favoriteName = `Cross File Favorite ${key}`;
			const clusterUrl = `cross-file-${source.id}-to-${target.id}-${sourceSections}-${targetSections}.kusto.windows.net`;
			const connectionId = `connection-${key}`;
			const database = `CrossDb${sourceSections}${targetSections}`;
			const connections = [{ id: connectionId, name: key, clusterUrl: `https://${clusterUrl}` }];
			const sourceHarness = createHarness({ store: sharedStore, connections });
			const targetHarness = createHarness({ store: sharedStore, connections });
			vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue(favoriteName);

			await sourceHarness.handler.handleMessage({
				type: 'requestAddFavorite', connectionId, clusterUrl, database, boxId: 'query_origin',
			});

			const favorite = { name: favoriteName, connectionId, clusterUrl: `https://${clusterUrl}`, database };
			expect(targetHarness.handler.getFavorites()).toEqual([favorite]);
			expect(sourceHarness.postMessage).toHaveBeenCalledWith({
				type: 'favoritesData', boxId: 'query_origin', favorites: [favorite],
			});
			expect(targetHarness.postMessage).toHaveBeenCalledWith({
				type: 'favoritesData', favorites: [favorite],
			});
		},
	);

	it('broadcasts only to live handlers sharing the same favorite storage', () => {
		const sharedStore = new Map<string, unknown>([[STORAGE_KEYS.favorites, []]]);
		const unrelatedStore = new Map<string, unknown>([[STORAGE_KEYS.favorites, []]]);
		const source = createHarness({ store: sharedStore });
		const shared = createHarness({ store: sharedStore });
		const unrelated = createHarness({ store: unrelatedStore });
		shared.handler.dispose();

		HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(source.context);

		expect(source.postMessage).toHaveBeenCalledOnce();
		expect(shared.postMessage).not.toHaveBeenCalled();
		expect(unrelated.postMessage).not.toHaveBeenCalled();
	});

	it('cleans a stale registered handler during broadcast', () => {
		const harness = createHarness({ initialRaw: [] });
		(harness.handler as unknown as { disposed: boolean }).disposed = true;

		HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(harness.context);
		(harness.handler as unknown as { disposed: boolean }).disposed = false;
		HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(harness.context);

		expect(harness.postMessage).not.toHaveBeenCalled();
	});

	it('notifies listeners and contains synchronous and asynchronous listener failures', async () => {
		const harness = createHarness({ initialRaw: [] });
		const successful = vi.fn();
		const syncFailure = new Error('sync listener failed');
		const asyncFailure = new Error('async listener failed');
		listenerDisposables.push(
			HostKustoFavoritesApplicationHandler.onKustoFavoritesChanged(successful),
			HostKustoFavoritesApplicationHandler.onKustoFavoritesChanged(() => { throw syncFailure; }),
			HostKustoFavoritesApplicationHandler.onKustoFavoritesChanged(() => Promise.reject(asyncFailure)),
		);

		HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(harness.context);

		expect(successful).toHaveBeenCalledWith(harness.context);
		await vi.waitFor(() => expect(listenerLogger.warn).toHaveBeenCalledTimes(2));
		expect(listenerLogger.warn).toHaveBeenCalledWith(
			'[favorites] Failed to notify Kusto favorites listener', syncFailure,
		);
		expect(listenerLogger.warn).toHaveBeenCalledWith(
			'[favorites] Failed to notify Kusto favorites listener', asyncFailure,
		);
	});

	it('contains listener logger failures', async () => {
		const harness = createHarness({ initialRaw: [] });
		listenerLogger.warn.mockImplementation(() => { throw new Error('logger failed'); });
		listenerDisposables.push(
			HostKustoFavoritesApplicationHandler.onKustoFavoritesChanged(() => { throw new Error('sync failed'); }),
			HostKustoFavoritesApplicationHandler.onKustoFavoritesChanged(() => Promise.reject(new Error('async failed'))),
		);

		expect(() => HostKustoFavoritesApplicationHandler.broadcastKustoFavoritesData(harness.context)).not.toThrow();
		await vi.waitFor(() => expect(listenerLogger.warn).toHaveBeenCalledTimes(2));
	});

	it.each([
		{
			label: ' Friendly ', clusterUrl: ' sales.kusto.windows.net/ ', database: ' SalesDb ',
			expectedText: 'Remove "Friendly" from favorites?',
		},
		{
			label: ' ', clusterUrl: ' sales.kusto.windows.net/ ', database: ' SalesDb ',
			expectedText: 'Remove "https://sales.kusto.windows.net (SalesDb)" from favorites?',
		},
		{
			label: ' ', clusterUrl: ' ', database: ' ',
			expectedText: 'Remove "this favorite" from favorites?',
		},
	])('uses exact confirmation copy for $expectedText', async ({ label, clusterUrl, database, expectedText }) => {
		const harness = createHarness();
		const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Remove');

		await harness.handler.handleMessage({
			type: 'confirmRemoveFavorite', requestId: ' request-1 ', label,
			connectionId: ' kusto_sales ', clusterUrl, database, boxId: 'box-1',
		});

		expect(showWarningMessage).toHaveBeenCalledWith(expectedText, { modal: true }, 'Remove');
		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'confirmRemoveFavoriteResult', requestId: 'request-1', ok: true,
			connectionId: 'kusto_sales', clusterUrl: normalizeFavoriteClusterUrl(clusterUrl),
			database: database.trim(), boxId: 'box-1',
		});
	});

	it.each([
		{ label: 'cancel', result: undefined, throws: false },
		{ label: 'different action', result: 'Keep', throws: false },
		{ label: 'native throw', result: undefined, throws: true },
	])('publishes ok false after $label', async ({ result, throws }) => {
		const harness = createHarness();
		const showWarningMessage = vi.spyOn(vscode.window, 'showWarningMessage');
		if (throws) showWarningMessage.mockRejectedValue(new Error('dialog failed'));
		else showWarningMessage.mockResolvedValue(result);

		await harness.handler.handleMessage({
			type: 'confirmRemoveFavorite', requestId: 'request-2', connectionId: 'kusto_sales',
			clusterUrl: 'https://sales', database: 'SalesDb',
		});

		expect(harness.postMessage).toHaveBeenCalledWith({
			type: 'confirmRemoveFavoriteResult', requestId: 'request-2', ok: false,
			connectionId: 'kusto_sales', clusterUrl: 'https://sales', database: 'SalesDb', boxId: undefined,
		});
	});

	it('invokes confirmation transport without awaiting its settlement', async () => {
		const transport = deferred<boolean>();
		const harness = createHarness({ postMessage: () => transport.promise });
		vi.spyOn(vscode.window, 'showWarningMessage').mockResolvedValue('Remove');
		let settled = false;
		const request = harness.handler.handleMessage({
			type: 'confirmRemoveFavorite', requestId: 'request-3', connectionId: 'kusto_sales',
			clusterUrl: 'https://sales', database: 'SalesDb',
		})!;
		void request.then(() => { settled = true; });

		await request;
		expect(settled).toBe(true);
		expect(harness.postMessage).toHaveBeenCalledOnce();
		transport.resolve(true);
	});

	it('lets accepted work settle across disposal, suppresses later traffic, and can reactivate idempotently', async () => {
		const storage = deferred<void>();
		const sharedStore = new Map<string, unknown>([[STORAGE_KEYS.favorites, []]]);
		const source = createHarness({
			store: sharedStore,
			update: (_key, value, store) => {
				store.set(STORAGE_KEYS.favorites, value);
				return storage.promise;
			},
		});
		const other = createHarness({ store: sharedStore });
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Accepted');
		const accepted = source.handler.handleMessage(addMessage())!;
		await vi.waitFor(() => expect(source.globalStateUpdate).toHaveBeenCalledOnce());

		source.handler.dispose();
		source.handler.dispose();
		const suppressed = source.handler.handleMessage({
			type: 'removeFavorite', connectionId: 'kusto_sales', clusterUrl: 'ignored', database: 'SalesDb',
		});
		storage.resolve();

		await expect(accepted).resolves.toBeUndefined();
		await expect(suppressed).resolves.toBeUndefined();
		expect(source.globalStateUpdate).toHaveBeenCalledOnce();
		expect(source.postMessage).not.toHaveBeenCalled();
		expect(other.postMessage).toHaveBeenCalledWith({
			type: 'favoritesData',
			favorites: [{
				name: 'Accepted', connectionId: 'kusto_sales', clusterUrl: 'https://Sales.Kusto.Windows.Net', database: 'SalesDb',
			}],
		});

		source.handler.activate();
		source.handler.activate();
		await source.handler.handleMessage({
			type: 'removeFavorite', connectionId: 'kusto_sales', clusterUrl: 'ignored', database: 'SalesDb',
		});
		expect(source.globalStateUpdate).toHaveBeenCalledTimes(2);
		expect(source.postMessage).toHaveBeenCalledWith({ type: 'favoritesData', favorites: [] });
	});

	it('preserves an accepted storage rejection across disposal', async () => {
		const storage = deferred<void>();
		const failure = new Error('accepted storage failure');
		const harness = createHarness({ initialRaw: [], update: () => storage.promise });
		vi.spyOn(vscode.window, 'showInputBox').mockResolvedValue('Favorite');
		const accepted = harness.handler.handleMessage(addMessage())!;
		await vi.waitFor(() => expect(harness.globalStateUpdate).toHaveBeenCalledOnce());

		harness.handler.dispose();
		storage.reject(failure);

		await expect(accepted).rejects.toBe(failure);
		expect(harness.postMessage).not.toHaveBeenCalled();
	});
});