import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/components/kw-copilot-chat.js';
import '../../src/webview/components/kw-data-table.js';
import '../../src/webview/sections/kw-query-section.js';
import type { KwQuerySection } from '../../src/webview/sections/kw-query-section.js';
import type { KwDropdown } from '../../src/webview/components/kw-dropdown.js';
import {
	beginKustoPreparation,
	databaseRequestTokenByBoxId,
	disposeKustoPreparation,
	getKustoPreparationState,
	getPendingSchemaWorkerUpdate,
	getSchemaEnhancementReadyState,
	getSchemaWorkerReadyState,
	clearSchemaWorkerReadyState,
	isSchemaWorkerApplyRequired,
	lastSchemaRequestAtByBoxId,
	optimizationMetadataByBoxId,
	queryBoxes,
	queryEditors,
	schemaByConnDb,
	schemaMetaByConnDb,
	setConnections as setStateConnections,
	setPendingSchemaWorkerUpdate,
	setSchemaEnhancementReadyState,
	setSchemaWorkerReadyState,
	schemaFetchInFlightByBoxId,
	getKustoSchemaMetadata,
	setKustoSchemaMetadata,
	markSchemaEnhancementPending,
	markSchemaWorkerApplyFailed,
	markSchemaWorkerReady,
	updateKustoPreparation,
} from '../../src/webview/core/state.js';
import { getKustoEditorSchema, setKustoEditorSchema } from '../../src/webview/core/schema-catalogs.js';
import { kustoEditorSchemaCoordinator } from '../../src/webview/core/kusto-editor-schema-runtime.js';
import {
	invalidateLinkedComparisonSchemaForSource,
	updateConnectionSelects,
} from '../../src/webview/sections/query-connection.controller.js';
import { applyKustoLeaveNoTracePolicy, markKustoLeaveNoTracePolicyPending } from '../../src/webview/core/persistence.js';
import { schemaRequestTokenByBoxId } from '../../src/webview/core/kusto-schema-request-state.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	bindResultArtifactConsumer,
	clearResultsState,
	displayResultBatchForBox,
	displayResultForBox,
	getCurrentResultArtifact,
	getBoundResultArtifact,
	getResultsState,
	getSelectedResultIndex,
	setResultsState,
} from '../../src/webview/core/results-state.js';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';
import { APPLIED_KUSTO_COPILOT_DONE_EVENT } from '../../src/webview/core/kusto-copilot-output-runtime.js';
import { getKustoSchemaIdentityKey } from '../../src/shared/kustoAuth.js';
import { createKustoResultBatch } from '../../src/shared/kustoResultBatch.js';
import { comparisonSourceArtifactConsumerId, createUnverifiedLegacyResultArtifactPublication, toPersistedResultArtifact } from '../../src/shared/resultArtifact.js';

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: vi.fn(),
}));

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	vi.useRealTimers();
	render(nothing, container);
	container.remove();
	delete pState.manualQueryEditorHeightPxByBoxId.test1;
	disposeKustoPreparation('test1');
	delete databaseRequestTokenByBoxId.test1;
	delete optimizationMetadataByBoxId.test1;
	delete schemaFetchInFlightByBoxId.comparison_1;
	delete lastSchemaRequestAtByBoxId.comparison_1;
	delete schemaRequestTokenByBoxId.comparison_1;
	delete databaseRequestTokenByBoxId.comparison_1;
	delete pState.queryResultJsonByBoxId.test1;
	delete pState.resultArtifactByBoxId.test1;
	delete pState.kustoResultOwnerByBoxId.test1;
	delete pState.resultsVisibleByBoxId.test1;
	clearResultsState('test1');
	delete queryEditors.test1;
	disposeKustoPreparation('comparison_1');
	kustoEditorSchemaCoordinator.clear();
	vi.mocked(postMessageToHost).mockClear();
});

function createSection(boxId = 'test1'): KwQuerySection {
	render(html`<kw-query-section box-id=${boxId}></kw-query-section>`, container);
	return container.querySelector('kw-query-section')! as KwQuerySection;
}

it('writes exact Copilot KQL without changing quoted literal whitespace', () => {
	const section = createSection();
	const range = { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 };
	const executeEdits = vi.fn();
	queryEditors.test1 = {
		getModel: () => ({ getFullModelRange: () => range }),
		executeEdits,
		focus: vi.fn(),
	} as any;
	const query = 'print Value=1 | extend Label = "A  B", Other = Value';

	section.setCopilotQueryText(query);

	expect(executeEdits).toHaveBeenCalledWith('copilot', [{ range, text: query }]);
});

it('continues selector reconciliation after one section throws', () => {
	render(html`
		<kw-query-section box-id="selector_first"></kw-query-section>
		<kw-query-section box-id="selector_second"></kw-query-section>
	`, container);
	const first = container.querySelector('[box-id="selector_first"]') as KwQuerySection;
	const second = container.querySelector('[box-id="selector_second"]') as KwQuerySection;
	first.id = 'selector_first';
	second.id = 'selector_second';
	const firstSetConnections = vi.fn(() => { throw new Error('selector failure'); });
	const secondSetConnections = vi.fn();
	first.setConnections = firstSetConnections;
	second.setConnections = secondSetConnections;
	queryBoxes.push('selector_first', 'selector_second');

	try {
		expect(() => updateConnectionSelects()).not.toThrow();
		expect(firstSetConnections).toHaveBeenCalledOnce();
		expect(secondSetConnections).toHaveBeenCalledOnce();
	} finally {
		for (const id of ['selector_first', 'selector_second']) {
			const index = queryBoxes.indexOf(id);
			if (index >= 0) queryBoxes.splice(index, 1);
		}
	}
});

function getRefreshButton(el: KwQuerySection): HTMLButtonElement | null {
	return el.shadowRoot!.querySelector('.refresh-btn-wrap button') as HTMLButtonElement | null;
}

function getDatabaseDropdown(el: KwQuerySection): KwDropdown | null {
	return el.shadowRoot!.querySelector('.select-wrapper.half-width:nth-child(2) kw-dropdown') as KwDropdown | null;
}

function hasSpinner(el: KwQuerySection): boolean {
	return el.shadowRoot!.querySelector('.query-spinner') !== null;
}

describe('native restore schema auth boundary repro', () => {
	it.each(['automatic reconciliation', 'direct cache-only prewarm', 'explicit refresh'] as const)(
		'%s preserves its effective interactive permission', async route => {
			const {
				handleDocumentDataMessage, captureKustoLeaveNoTracePolicyRuntime, restoreKustoLeaveNoTracePolicyRuntime,
			} = await import('../../src/webview/core/persistence.js');
			const { drainBufferedHostMessages } = await import('../../src/webview/core/message-handler.js');
			const { KwQuerySection } = await import('../../src/webview/sections/kw-query-section.js');
			const { SchemaService } = await import('../../src/host/queryEditorSchema.js');
			const { HostKustoSchemaRequestApplicationHandler } = await import('../../src/host/kustoSchemaRequestApplicationHandler.js');
			const vscode = await import('vscode');
			const state = await import('../../src/webview/core/state.js');
			const boxId = 'schema_auth_restore';
			const connection = {
				id: 'synthetic-restore', name: 'Synthetic restore',
				clusterUrl: 'https://synthetic-restore.kusto.windows.net',
				authorityId: 'organizations', accountPartition: 'synthetic-partition',
				connectionRevision: 0,
			};
			const database = 'SyntheticDb';
			const cacheKey = getKustoSchemaIdentityKey(connection.id, connection.accountPartition, connection.clusterUrl, database);
			const originalPersistence = { ...pState };
			const originalPolicy = captureKustoLeaveNoTracePolicyRuntime();
			const originalVscode = window.vscode;
			const originalConnections = state.connections;
			const originalBuffered = window.__kustoBufferedHostMessages;
			const transport = vi.mocked(postMessageToHost);
			const originalTransport = transport.getMockImplementation();
			const restoreFlags: boolean[] = [];
			const setDesiredClusterUrl = KwQuerySection.prototype.setDesiredClusterUrl;
			vi.spyOn(KwQuerySection.prototype, 'setDesiredClusterUrl').mockImplementation(function (url) {
				if (this.boxId === boxId) restoreFlags.push(pState.restoreInProgress);
				setDesiredClusterUrl.call(this, url);
			});
			const interactiveAttempt = vi.fn();
			const responses: import('../../src/shared/kustoSchemaProtocol.js').KustoSchemaHostMessage[] = [];
			const getDatabaseSchema = vi.fn(async (
				...args: Parameters<import('../../src/host/kustoClient.js').KustoQueryClient['getDatabaseSchema']>
			) => {
				if (args[3]?.allowInteractive !== false) interactiveAttempt();
				return {
					schema: { tables: ['QueryT'], columnTypesByTable: { QueryT: { Simple: 'string' } } },
					fromCache: false, accountPartition: connection.accountPartition,
				};
			});
			const service = new SchemaService({
				context: {
					globalStorageUri: vscode.Uri.file('C:/synthetic-schema-cache'),
					globalState: { get: () => true, update: vi.fn() },
				},
				kustoClient: { getDatabaseSchema, getAccountPartition: () => connection.accountPartition },
				connectionManager: { getConnections: () => [connection] },
				findConnection: (connectionId: string) => connectionId === connection.id ? connection : undefined,
				postMessage: (message: typeof responses[number]) => responses.push(message),
				formatQueryExecutionErrorForUser: (error: unknown) => String(error),
				output: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
			} as unknown as ConstructorParameters<typeof SchemaService>[0]);
			const cacheRead = vi.spyOn(service as unknown as {
				getCachedSchemaFromDiskByCluster: () => Promise<undefined>;
			}, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
			const cacheWrite = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
			const hostHandler = new HostKustoSchemaRequestApplicationHandler({ schema: service });
			const prefetch = vi.spyOn(service, 'prefetchSchema');
			const consoleError = vi.spyOn(console, 'error');
			const deliverConnections = async () => {
				window.__kustoBufferedHostMessages = [{
					type: 'connectionsData', connectionsRevision: 0, connections: [connection], accounts: [],
					lastConnectionId: null, lastDatabase: null,
					cachedDatabases: { [connection.id]: [database] }, favorites: [],
					caretDocsEnabled: true, caretDocsEnabledUserSet: false,
					autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
					copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
					editingPreferencesRevision: 0, copilotChatFirstTimeDismissed: false, devNotesEnabled: false,
					leaveNoTraceClusters: [], leaveNoTraceGloballyBlocked: false, leaveNoTraceRevisions: {},
				}];
				await drainBufferedHostMessages();
				expect(state.connections).toEqual([connection]);
				expect(state.cachedDatabases[connection.id]).toEqual([database]);
			};
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
			try {
				container.id = 'queries-container';
				window.vscode = { postMessage: vi.fn(), getState: vi.fn(), setState: vi.fn() };
				setStateConnections([]);
				for (const key of Object.keys(state.cachedDatabases)) delete state.cachedDatabases[key];
				expect(Object.keys(schemaByConnDb)).toEqual([]);
				expect(getKustoEditorSchema(boxId)).toBeUndefined();
				transport.mockClear();
				const nativeSnapshot = {
					type: 'documentData', ok: true, forceReload: true,
					documentUri: `file:///synthetic-schema-${route.replaceAll(' ', '-')}.kqlx`,
					documentKind: 'kqlx', compatibilityMode: false,
					allowedSectionKinds: ['query'], defaultSectionKind: 'query',
					documentRevision: 0, sourceGeneration: 1, editRevision: 0,
					sectionRevisions: {}, markdownSectionRevisions: {},
					htmlPowerBiCompatibilityCheckEnabled: false,
					state: { sections: [{
						id: boxId, type: 'query', query: 'QueryT | project Simple', expanded: true,
						clusterUrl: connection.clusterUrl, authorityId: connection.authorityId, database,
					}] },
				};
				if (route !== 'automatic reconciliation') {
					expect(handleDocumentDataMessage({ ...nativeSnapshot, state: { sections: [] } })).toBe(true);
					expect(pState.documentRuntimeActive).toBe(true);
					await deliverConnections();
				}
				expect(handleDocumentDataMessage(nativeSnapshot)).toBe(true);
				const section = document.getElementById(boxId) as KwQuerySection;
				await section.updateComplete;
				expect(section.tagName).toBe('KW-QUERY-SECTION');
				expect(pState).toMatchObject({
					documentKind: 'kqlx', compatibilityMode: false, hostOwnedMarkdownActive: true,
					documentRuntimeActive: true, restoreInProgress: false,
				});
				expect(restoreFlags.length).toBeGreaterThan(0);
				expect(restoreFlags.every(flag => flag)).toBe(true);
				const beforeAutoPass = {
					connectionId: section.getConnectionId(), desiredDatabase: section.getDesiredDatabase(),
					connections: state.connections.length, restoreInProgress: pState.restoreInProgress,
					schemaRequests: transport.mock.calls.filter(([message]) => message.type === 'prefetchSchema').length,
				};
				expect(beforeAutoPass.schemaRequests).toBe(0);
				const focusBefore = document.activeElement;
				const editRevisionBefore = pState.documentEditRevision;
				if (route === 'automatic reconciliation') {
					expect(beforeAutoPass).toEqual({
						connectionId: '', desiredDatabase: database, connections: 0,
						restoreInProgress: false, schemaRequests: 0,
					});
					await deliverConnections();
				} else if (route === 'direct cache-only prewarm') {
					vi.spyOn(section, 'getClientRects').mockReturnValue([new DOMRect(0, 0, 500, 200)] as unknown as DOMRectList);
					await vi.advanceTimersByTimeAsync(80);
				} else {
					section.connectionCtrl.refreshSchema();
				}
				expect(pState.documentEditRevision, 'schema preparation must not author a document edit').toBe(editRevisionBefore);
				expect(document.activeElement).toBe(focusBefore);
				expect(transport.mock.calls.some(([message]) => message.type === 'backgroundWorkbenchUserInteraction')).toBe(false);
				const requests = transport.mock.calls.map(([message]) => message)
					.filter(message => message.type === 'prefetchSchema');
				expect(requests).toHaveLength(1);
				const request = requests[0];
				expect(request).toMatchObject({
					connectionId: connection.id, database, boxId,
					requestToken: expect.any(String), ...section.getSchemaLifecycleIdentity(),
					forceRefresh: route === 'explicit refresh',
				});
				expect(request.sectionInstanceId).toBeTruthy();
				expect(kustoEditorSchemaCoordinator.getSchemaRequestToken(boxId)).toBe(request.requestToken);
				const handling = hostHandler.handleMessage(request);
				expect(handling).toBeInstanceOf(Promise);
				await handling;
				expect(prefetch).toHaveBeenCalledOnce();
				expect(cacheRead).toHaveBeenCalledOnce();
				expect(consoleError).not.toHaveBeenCalled();
				console.info('[native-restore-schema-auth]', JSON.stringify({
					route, beforeAutoPass, request, hostOptions: prefetch.mock.calls[0][5],
					clientArgumentCounts: getDatabaseSchema.mock.calls.map(args => args.length),
					clientOptions: getDatabaseSchema.mock.calls.map(args => args[3] ?? null),
					interactiveAttempts: interactiveAttempt.mock.calls.length,
				}));
				if (route === 'direct cache-only prewarm') {
					expect(request).toMatchObject({ cacheOnly: true, silent: true, reason: 'document-restore' });
					expect(getDatabaseSchema).not.toHaveBeenCalled();
					expect(cacheWrite).not.toHaveBeenCalled();
				} else {
					expect(request.cacheOnly).not.toBe(true);
					expect(getDatabaseSchema).toHaveBeenCalledExactlyOnceWith(connection, database, route === 'explicit refresh', {
						allowInteractive: route === 'explicit refresh', source: 'primary-schema',
					});
					expect(cacheWrite).toHaveBeenCalledOnce();
					expect(responses).toEqual([expect.objectContaining({
						type: 'schemaData', boxId, requestToken: request.requestToken,
						schema: expect.objectContaining({ tables: ['QueryT'], rawSchemaJson: expect.any(Object) }),
					})]);
					window.__kustoBufferedHostMessages = responses;
					await drainBufferedHostMessages();
					expect(getKustoEditorSchema(boxId)?.tables).toEqual(['QueryT']);
					expect(schemaFetchInFlightByBoxId[boxId]).toBe(false);
				}
				expect(interactiveAttempt, 'automatic restore must not permit interactive authentication').toHaveBeenCalledTimes(
					route === 'explicit refresh' ? 1 : 0,
				);
			} finally {
				hostHandler.dispose();
				container.replaceChildren();
				queryBoxes.splice(queryBoxes.indexOf(boxId), queryBoxes.includes(boxId) ? 1 : 0);
				delete schemaFetchInFlightByBoxId[boxId];
				delete lastSchemaRequestAtByBoxId[boxId];
				delete schemaRequestTokenByBoxId[boxId];
				delete databaseRequestTokenByBoxId[boxId];
				delete state.cachedDatabases[connection.id];
				delete schemaByConnDb[cacheKey];
				delete schemaMetaByConnDb[cacheKey];
				Object.assign(pState, originalPersistence);
				restoreKustoLeaveNoTracePolicyRuntime(originalPolicy);
				setStateConnections(originalConnections);
				window.vscode = originalVscode;
				window.__kustoBufferedHostMessages = originalBuffered;
				transport.mockImplementation(originalTransport ?? (() => undefined));
				vi.restoreAllMocks();
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		},
	);
});

describe('primary schema selection intent', () => {
	const boxId = 'auth_origin_test';
	const database = 'ChosenDb';
	const connections = [
		{ id: 'auth-a', name: 'Origin A', clusterUrl: 'https://auth-a.kusto.windows.net', accountPartition: 'partition-a', connectionRevision: 1, connectionIdentityKey: 'owner-a' },
		{ id: 'auth-b', name: 'Origin B', clusterUrl: 'https://auth-b.kusto.windows.net', accountPartition: 'partition-b', connectionRevision: 1, connectionIdentityKey: 'owner-b' },
	];
	let section: KwQuerySection;
	let restore: () => void;
	let state: typeof import('../../src/webview/core/state.js');
	let drainMessages: typeof import('../../src/webview/core/message-handler.js')['drainBufferedHostMessages'];

	beforeEach(async () => {
		state = await import('../../src/webview/core/state.js');
		const { addQueryBox } = await import('../../src/webview/core/section-factory.js');
		({ drainBufferedHostMessages: drainMessages } = await import('../../src/webview/core/message-handler.js'));
		const savedPersistence = { ...pState };
		const savedConnections = state.connections;
		const savedLastDatabase = state.lastDatabase;
		const savedBuffered = window.__kustoBufferedHostMessages;
		restore = () => {
			section.disposeSchemaLifecycle();
			container.replaceChildren();
			const index = queryBoxes.indexOf(boxId);
			if (index >= 0) queryBoxes.splice(index, 1);
			for (const connection of connections) delete state.cachedDatabases[connection.id];
			delete state.schemaDiagnosticsTrustedByBoxId[boxId];
			delete databaseRequestTokenByBoxId[boxId];
			delete schemaRequestTokenByBoxId[boxId];
			delete schemaFetchInFlightByBoxId[boxId];
			delete lastSchemaRequestAtByBoxId[boxId];
			Object.assign(pState, savedPersistence);
			setStateConnections(savedConnections);
			state.setLastDatabase(savedLastDatabase);
			window.__kustoBufferedHostMessages = savedBuffered;
			vi.restoreAllMocks();
			vi.clearAllTimers();
		};
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		container.id = 'queries-container';
		pState.documentRuntimeActive = true;
		pState.restoreInProgress = true;
		setStateConnections(connections);
		state.setLastDatabase(null);
		addQueryBox({ id: boxId });
		section = document.getElementById(boxId) as KwQuerySection;
		section.setConnections(connections);
		section.setConnectionId('auth-a');
		section.setDatabase('PreviousDb');
		section.setSchemaLifecycleTarget('auth-a', 'PreviousDb');
		section.setDatabases(['PreviousDb', database]);
		section.setFavoritesMode(false);
		await section.updateComplete;
		pState.restoreInProgress = false;
		vi.mocked(postMessageToHost).mockClear();
	});

	afterEach(() => restore());

	function schemaRequests() {
		return vi.mocked(postMessageToHost).mock.calls.map(([message]) => message)
			.filter(message => message.type === 'prefetchSchema' && message.boxId === boxId);
	}

	function databaseRequest() {
		const requests = vi.mocked(postMessageToHost).mock.calls.map(([message]) => message)
			.filter(message => (message.type === 'getDatabases' || message.type === 'refreshDatabases') && message.boxId === boxId);
		expect(requests.length).toBeGreaterThan(0);
		return requests.at(-1)!;
	}

	async function selectItem(selector: string, id: string) {
		await section.updateComplete;
		const dropdown = section.shadowRoot!.querySelector<KwDropdown>(selector)!;
		expect(dropdown).toBeTruthy();
		await dropdown.updateComplete;
		dropdown.shadowRoot!.querySelector<HTMLButtonElement>('.kusto-dropdown-btn')!.click();
		await dropdown.updateComplete;
		const item = Array.from(dropdown.shadowRoot!.querySelectorAll<HTMLElement>('[data-dropdown-item-id]'))
			.find(candidate => candidate.dataset.dropdownItemId === id);
		expect(item, `rendered dropdown item ${id}`).toBeTruthy();
		item!.click();
		await section.updateComplete;
	}

	async function deliverDatabases(request: ReturnType<typeof databaseRequest>, databases: string[], accepted = true) {
		if (accepted) expect(kustoEditorSchemaCoordinator.isDatabaseRequestCurrent(boxId, {
			sectionInstanceId: request.sectionInstanceId!, targetGeneration: request.targetGeneration!,
		}, request.connectionId, request.requestToken!)).toBe(true);
		const apply = vi.spyOn(section.connectionCtrl, 'updateDatabaseSelect');
		window.__kustoBufferedHostMessages = [{
			type: 'databasesData', boxId, connectionId: request.connectionId,
			requestToken: request.requestToken, sectionInstanceId: request.sectionInstanceId,
			targetGeneration: request.targetGeneration, databases, authoritative: true,
		}];
		await drainMessages();
		expect(apply).toHaveBeenCalledTimes(accepted ? 1 : 0);
		apply.mockRestore();
		await section.updateComplete;
	}

	it.each(['desired', 'single', 'global-last'])('fetches and applies one noninteractive primary schema on an automatic %s cache miss', async selection => {
		const { SchemaService } = await import('../../src/host/queryEditorSchema.js');
		const { HostKustoSchemaRequestApplicationHandler } = await import('../../src/host/kustoSchemaRequestApplicationHandler.js');
		const vscode = await import('vscode');
		const connection = connections[1];
		const responses: import('../../src/shared/kustoSchemaProtocol.js').KustoSchemaHostMessage[] = [];
		const getDatabaseSchema = vi.fn(async () => ({
			schema: { tables: ['Fetched'], columnTypesByTable: { Fetched: { Value: 'long' } } },
			fromCache: false, accountPartition: connection.accountPartition,
		}));
		const service = new SchemaService({
			context: {
				globalStorageUri: vscode.Uri.file('C:/synthetic-primary-schema-cache'),
				globalState: { get: () => true, update: vi.fn() },
			},
			kustoClient: { getDatabaseSchema, getAccountPartition: () => connection.accountPartition },
			connectionManager: { getConnections: () => connections },
			findConnection: (id: string) => connections.find(candidate => candidate.id === id),
			postMessage: (message: typeof responses[number]) => responses.push(message),
			formatQueryExecutionErrorForUser: (error: unknown) => String(error),
			output: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() },
		} as unknown as ConstructorParameters<typeof SchemaService>[0]);
		vi.spyOn(service as unknown as { getCachedSchemaFromDiskByCluster: () => Promise<undefined> }, 'getCachedSchemaFromDiskByCluster').mockResolvedValue(undefined);
		const write = vi.spyOn(service, 'saveCachedSchemaToDisk').mockResolvedValue(undefined);
		const handler = new HostKustoSchemaRequestApplicationHandler({ schema: service });
		const cacheKey = getKustoSchemaIdentityKey(connection.id, connection.accountPartition, connection.clusterUrl, database);
		try {
			section.setDatabase('');
			section.setDesiredClusterUrl(connection.clusterUrl);
			if (selection === 'desired') section.setDesiredDatabase(database);
			if (selection === 'global-last') state.setLastDatabase(database);
			state.cachedDatabases[connection.id] = selection === 'global-last' ? ['AnotherDb', database] : [database];
			section.setConnections(connections);
			if (selection === 'global-last') await deliverDatabases(databaseRequest(), ['AnotherDb', database]);
			expect(schemaRequests()).toHaveLength(1);
			const request = schemaRequests()[0];
			expect(request).toMatchObject({ connectionId: connection.id, database, reason: 'automatic', forceRefresh: false });
			expect(request.cacheOnly).not.toBe(true);
			await handler.handleMessage(request);
			expect(getDatabaseSchema).toHaveBeenCalledExactlyOnceWith(connection, database, false, {
				allowInteractive: false, source: 'primary-schema',
			});
			expect(write).toHaveBeenCalledOnce();
			expect(responses).toEqual([expect.objectContaining({
				type: 'schemaData', boxId, requestToken: request.requestToken,
				schema: expect.objectContaining({ tables: ['Fetched'], rawSchemaJson: expect.any(Object) }),
			})]);
			window.__kustoBufferedHostMessages = responses;
			await drainMessages();
			expect(getKustoEditorSchema(boxId)?.tables).toEqual(['Fetched']);
			expect(schemaFetchInFlightByBoxId[boxId]).toBe(false);
		} finally {
			handler.dispose();
			delete schemaByConnDb[cacheKey];
			delete schemaMetaByConnDb[cacheKey];
		}
	});

	it.each([
		{ selection: 'cluster single', cached: true },
		{ selection: 'cluster single', cached: false },
		{ selection: 'cluster global-last', cached: true },
		{ selection: 'cluster global-last', cached: false },
		{ selection: 'favorite desired', cached: true },
		{ selection: 'favorite desired', cached: false },
	])('keeps $selection interactive through cached=$cached discovery without requesting the old target', async ({ selection, cached }) => {
		const databases = selection === 'cluster single' ? [database] : ['AnotherDb', database];
		if (cached) state.cachedDatabases['auth-b'] = databases;
		if (selection === 'cluster global-last') state.setLastDatabase(database);
		if (selection === 'favorite desired') {
			section.setFavorites([{ name: 'Chosen favorite', connectionId: 'auth-b', clusterUrl: connections[1].clusterUrl, database }]);
			section.setFavoritesMode(true);
			await selectItem('.kusto-favorites-combo kw-dropdown', '0');
		} else {
			await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		}
		await deliverDatabases(databaseRequest(), databases);
		expect(section.getConnectionId()).toBe('auth-b');
		expect(section.getDatabase()).toBe(database);
		expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: 'auth-b', database, forceRefresh: false })]);
		expect(schemaRequests()[0].reason).not.toBe('automatic');
	});

	it.each(['changed database', 'same database', 'same cluster'])(
		'keeps %s confirmation interactive and requests only the selected target', async selection => {
			const expectedDatabase = selection === 'changed database' ? database : 'PreviousDb';
			await selectItem(selection === 'same cluster' ? '[data-testid="cluster-dropdown"]' : '[data-testid="database-dropdown"]',
				selection === 'same cluster' ? 'auth-a' : expectedDatabase);
			expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: 'auth-a', database: expectedDatabase })]);
			expect(schemaRequests()[0].reason).not.toBe('automatic');
		},
	);

	it.each(['refresh', 'autocomplete'] as const)('supersedes a pending automatic schema request for explicit %s', async action => {
		section.connectionCtrl.onDatabaseChanged();
		const automatic = schemaRequests()[0];
		expect(automatic).toMatchObject({ reason: 'automatic' });
		if (action === 'refresh') {
			section.shadowRoot!.querySelector('kw-schema-info')!.dispatchEvent(new CustomEvent('schema-refresh', { bubbles: true, composed: true }));
		} else {
			section.connectionCtrl.ensureSchema(false);
		}
		const requests = schemaRequests();
		expect(requests).toHaveLength(2);
		expect(requests[1].reason).not.toBe('automatic');
		expect(requests[1].forceRefresh).toBe(action === 'refresh');
		expect(requests[1].requestToken).not.toBe(automatic.requestToken);
		expect(kustoEditorSchemaCoordinator.getSchemaRequestToken(boxId)).toBe(requests[1].requestToken);
		if (action === 'refresh') section.connectionCtrl.refreshSchema();
		else section.connectionCtrl.ensureSchema(false);
		expect(schemaRequests()).toHaveLength(2);
		window.__kustoBufferedHostMessages = [{
			type: 'schemaError', boxId, connectionId: automatic.connectionId, database: automatic.database,
			requestToken: automatic.requestToken, sectionInstanceId: automatic.sectionInstanceId,
			targetGeneration: automatic.targetGeneration, error: 'old automatic failure',
		}];
		await drainMessages();
		expect(schemaFetchInFlightByBoxId[boxId]).toBe(true);
		expect(kustoEditorSchemaCoordinator.getSchemaRequestToken(boxId)).toBe(requests[1].requestToken);
	});

	it.each([true, false])('keeps explicit tool selection interactive through cached=%s discovery', async cached => {
		if (cached) state.cachedDatabases['auth-b'] = [database];
		section.setConnectionId('auth-b');
		section.setDatabase('');
		section.setDesiredDatabase(database);
		section.dispatchEvent(new CustomEvent('connection-changed', {
			detail: { boxId, connectionId: 'auth-b', database, source: 'tool' }, bubbles: true, composed: true,
		}));
		await deliverDatabases(databaseRequest(), [database]);
		expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: 'auth-b', database })]);
		expect(schemaRequests()[0].reason).not.toBe('automatic');
	});

	it.each(['same target', 'changed database'])('checks the complete explicit tool target for %s', async selection => {
		const persistence = await import('../../src/webview/core/persistence.js');
		vi.spyOn(persistence, 'persistDocumentAndWaitForAck').mockResolvedValue(true);
		pState.documentMutationAllowed = true;
		const requestedDatabase = selection === 'same target' ? 'PreviousDb' : database;
		window.__kustoBufferedHostMessages = [{
			type: 'toolConfigureQuerySection', requestId: 'tool-schema-target',
			input: { sectionId: boxId, clusterUrl: connections[0].clusterUrl, connectionId: 'auth-a', database: requestedDatabase },
		}];
		await drainMessages();
		expect(vi.mocked(postMessageToHost)).toHaveBeenCalledWith(expect.objectContaining({
			type: 'toolResponse', requestId: 'tool-schema-target', result: { success: true, resultPreview: '' },
		}));
		expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: 'auth-a', database: requestedDatabase })]);
		expect(schemaRequests()[0].reason).not.toBe('automatic');
	});

	it('does not retire a newer explicit request created inside database-selection callbacks', async () => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const first = databaseRequest();
		let next: ReturnType<typeof databaseRequest> | undefined;
		section.addEventListener('database-changed', () => {
			section.setDesiredDatabase('LaterDb');
			const requestToken = 'database-callback-next';
			databaseRequestTokenByBoxId[boxId] = requestToken;
			next = { ...first, ...section.beginDatabaseLifecycleRequest(requestToken, true)!, requestToken };
		}, { once: true });
		await deliverDatabases(first, [database]);
		expect(next).toBeDefined();
		expect(databaseRequestTokenByBoxId[boxId]).toBe(next!.requestToken);
		await deliverDatabases(next!, [database, 'LaterDb']);
		expect(schemaRequests()).toHaveLength(2);
		expect(schemaRequests()[1]).toMatchObject({ connectionId: 'auth-b', database: 'LaterDb' });
		expect(schemaRequests().every(request => request.reason !== 'automatic')).toBe(true);
	});

	it.each(['data', 'error'] as const)('rejects late A-B-A %s without clearing the newer explicit intent', async terminal => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const old = databaseRequest();
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-a');
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const current = databaseRequest();
		expect(current.targetGeneration).toBeGreaterThan(old.targetGeneration!);
		if (terminal === 'data') {
			await deliverDatabases(old, ['StaleDb'], false);
		} else {
			window.__kustoBufferedHostMessages = [{
				type: 'databasesError', boxId, connectionId: old.connectionId, requestToken: old.requestToken,
				sectionInstanceId: old.sectionInstanceId, targetGeneration: old.targetGeneration, error: 'old failure',
			}];
			await drainMessages();
		}
		expect(databaseRequestTokenByBoxId[boxId]).toBe(current.requestToken);
		expect(schemaRequests()).toEqual([]);
		await deliverDatabases(current, [database]);
		expect(schemaRequests()).toHaveLength(1);
		expect(schemaRequests()[0]).toMatchObject({ connectionId: 'auth-b', database });
		expect(schemaRequests()[0].reason).not.toBe('automatic');
	});

	it('does not inherit explicit intent when automatic reconciliation returns to the same connection', async () => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const old = databaseRequest();
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-a');
		section.setDesiredClusterUrl(connections[1].clusterUrl);
		section.setConnections(connections);
		const current = databaseRequest();
		await deliverDatabases(old, ['StaleDb'], false);
		expect(databaseRequestTokenByBoxId[boxId]).toBe(current.requestToken);
		await deliverDatabases(current, [database]);
		expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: 'auth-b', database, reason: 'automatic' })]);
	});

	it('does not grant old intent to a changed pending database and consumes it before selection callbacks', async () => {
		section.setFavorites([{ name: 'Pending', connectionId: 'auth-b', clusterUrl: connections[1].clusterUrl, database }]);
		section.setFavoritesMode(true);
		await selectItem('.kusto-favorites-combo kw-dropdown', '0');
		const request = databaseRequest();
		section.setDesiredDatabase('ReplacementDb');
		await deliverDatabases(request, [database, 'ReplacementDb']);
		expect(schemaRequests()).toEqual([expect.objectContaining({ database: 'ReplacementDb', reason: 'automatic' })]);
		section.setDatabase('');
		section.setDatabases([database]);
		expect(schemaRequests()).toHaveLength(2);
		expect(schemaRequests()[1]).toMatchObject({ database, reason: 'automatic' });
	});

	it.each(['same value', 'changed then restored', 'cleared then restored'] as const)(
		'retires only changed pending database intent: %s', async transition => {
			section.setFavorites([{ name: 'Pending', connectionId: 'auth-b', clusterUrl: connections[1].clusterUrl, database }]);
			section.setFavoritesMode(true);
			await selectItem('.kusto-favorites-combo kw-dropdown', '0');
			const request = databaseRequest();
			expect(section.getDesiredDatabase()).toBe(database);
			if (transition === 'changed then restored') section.setDesiredDatabase('ReplacementDb');
			if (transition === 'cleared then restored') section.clearDesiredDatabase();
			section.setDesiredDatabase(database);
			expect(databaseRequest()).toEqual(request);
			expect(databaseRequestTokenByBoxId[boxId]).toBe(request.requestToken);
			await deliverDatabases(request, [database, 'ReplacementDb']);
			expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: 'auth-b', database })]);
			if (transition === 'same value') expect(schemaRequests()[0].reason).not.toBe('automatic');
			else expect(schemaRequests()[0].reason).toBe('automatic');
		},
	);

	it('retires explicit database intent on failure before an automatic retry', async () => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const failed = databaseRequest();
		window.__kustoBufferedHostMessages = [{
			type: 'databasesError', boxId, connectionId: failed.connectionId, requestToken: failed.requestToken,
			sectionInstanceId: failed.sectionInstanceId, targetGeneration: failed.targetGeneration, error: 'discovery failed',
		}];
		await drainMessages();
		expect(databaseRequestTokenByBoxId[boxId]).toBeUndefined();
		const retryToken = 'automatic-retry';
		databaseRequestTokenByBoxId[boxId] = retryToken;
		const retry = section.beginDatabaseLifecycleRequest(retryToken)!;
		await deliverDatabases({ ...failed, ...retry, requestToken: retryToken }, [database]);
		expect(schemaRequests()).toEqual([expect.objectContaining({ database, reason: 'automatic' })]);
	});

	it('preserves explicit discovery intent through a DOM reorder without disposing the section', async () => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const request = databaseRequest();
		section.remove();
		container.appendChild(section);
		await section.updateComplete;
		expect(section.getSchemaLifecycleIdentity()?.sectionInstanceId).toBe(request.sectionInstanceId);
		await deliverDatabases(request, [database]);
		expect(schemaRequests()).toHaveLength(1);
		expect(schemaRequests()[0].reason).not.toBe('automatic');
	});

	it('does not transfer explicit discovery intent to a recreated same-ID section', async () => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const old = databaseRequest();
		section.disposeSchemaLifecycle();
		section.remove();
		queryBoxes.splice(queryBoxes.indexOf(boxId), 1);
		pState.restoreInProgress = true;
		const { addQueryBox } = await import('../../src/webview/core/section-factory.js');
		addQueryBox({ id: boxId });
		section = document.getElementById(boxId) as KwQuerySection;
		await section.updateComplete;
		pState.restoreInProgress = false;
		section.setDesiredClusterUrl(connections[1].clusterUrl);
		section.setConnections(connections);
		const current = databaseRequest();
		expect(current.sectionInstanceId).not.toBe(old.sectionInstanceId);
		await deliverDatabases(old, ['StaleDb'], false);
		expect(databaseRequestTokenByBoxId[boxId]).toBe(current.requestToken);
		await deliverDatabases(current, [database]);
		expect(schemaRequests()).toEqual([expect.objectContaining({ database, reason: 'automatic' })]);
	});

	it.each(['account', 'physical generation'] as const)('does not reuse explicit discovery intent after a changed %s', async change => {
		await selectItem('[data-testid="cluster-dropdown"]', 'auth-b');
		const old = databaseRequest();
		const replacement = connections.map(connection => connection.id === 'auth-b' ? {
			...connection,
			...(change === 'account' ? { accountPartition: 'partition-new' } : { connectionRevision: 2, connectionIdentityKey: 'owner-new' }),
		} : connection);
		setStateConnections(replacement);
		section.setConnections(replacement);
		if (change === 'account') {
			await deliverDatabases(old, [database]);
		} else {
			await deliverDatabases(old, ['StaleDb'], false);
			section.setDatabases([database]);
		}
		expect(schemaRequests()).toEqual([expect.objectContaining({ database, reason: 'automatic' })]);
	});

	it.each(['unchanged protection', 'protection enabled', 'protected revision advanced', 'protection removed', 'protection ABA'] as const)(
		'fences pending discovery through real policy snapshots: %s', async change => {
			const { captureKustoLeaveNoTracePolicyRuntime, restoreKustoLeaveNoTracePolicyRuntime } = await import('../../src/webview/core/persistence.js');
			const savedPolicy = captureKustoLeaveNoTracePolicyRuntime();
			const connection = connections[1];
			const savedJson = '{"columns":["Saved"],"rows":[["synthetic-private-row"]],"metadata":{}}';
			const deliverPolicy = async (revision: number, protectedCluster: boolean) => {
				window.__kustoBufferedHostMessages = [{
					type: 'connectionsData', connectionsRevision: 0, connections, accounts: [],
					lastConnectionId: null, lastDatabase: null, cachedDatabases: {}, favorites: [],
					caretDocsEnabled: true, caretDocsEnabledUserSet: false,
					autoTriggerAutocompleteEnabled: true, autoTriggerAutocompleteEnabledUserSet: false,
					copilotInlineCompletionsEnabled: true, copilotInlineCompletionsEnabledUserSet: false,
					editingPreferencesRevision: 0, copilotChatFirstTimeDismissed: false, devNotesEnabled: false,
					leaveNoTraceClusters: protectedCluster ? [connection.clusterUrl] : [],
					leaveNoTraceGloballyBlocked: false, leaveNoTraceRevisions: { [connection.clusterUrl]: revision },
					policyRequestId: savedPolicy.requiredPolicyRequestId || undefined,
				}];
				await drainMessages();
				expect(state.connections).toEqual(connections);
				expect(Object.values(captureKustoLeaveNoTracePolicyRuntime().revocationGenerations)).toEqual([revision]);
			};
			try {
				await deliverPolicy(7, change !== 'protection enabled');
				await selectItem('[data-testid="cluster-dropdown"]', connection.id);
				const original = databaseRequest();
				const target = kustoEditorSchemaCoordinator.getTarget(boxId);
				pState.queryResultJsonByBoxId[boxId] = savedJson;
				setResultsState(boxId, { boxId, columns: ['Saved'], rows: [['synthetic-private-row']] });
				const savedArtifact = toPersistedResultArtifact(getCurrentResultArtifact(boxId));
				expect(savedArtifact).toBeDefined();
				pState.resultArtifactByBoxId[boxId] = savedArtifact!;
				await deliverPolicy(change === 'unchanged protection' ? 7 : 8, change !== 'protection removed' && change !== 'protection ABA');
				if (change === 'protection ABA') await deliverPolicy(9, true);
				expect(kustoEditorSchemaCoordinator.getTarget(boxId)).toEqual(target);
				expect(section.getSchemaLifecycleIdentity()).toEqual({
					sectionInstanceId: original.sectionInstanceId, targetGeneration: original.targetGeneration,
				});
				expect(databaseRequest()).toEqual(original);
				expect(databaseRequestTokenByBoxId[boxId]).toBe(original.requestToken);
				expect(pState.queryResultJsonByBoxId[boxId]).toBe(savedJson);
				expect(pState.resultArtifactByBoxId[boxId]).toEqual(savedArtifact);
				expect(toPersistedResultArtifact(getCurrentResultArtifact(boxId))).toEqual(savedArtifact);
				expect(getResultsState(boxId)).toMatchObject({ rows: [['synthetic-private-row']] });
				let next: ReturnType<typeof databaseRequest> | undefined;
				section.addEventListener('database-changed', () => {
					section.setDesiredDatabase('LaterDb');
					section.connectionCtrl.refreshDatabases();
					next = databaseRequest();
				}, { once: true });
				await deliverDatabases(original, [database]);
				expect(schemaRequests()).toEqual([expect.objectContaining({ connectionId: connection.id, database })]);
				if (change === 'unchanged protection') expect(schemaRequests()[0].reason).not.toBe('automatic');
				else expect(schemaRequests()[0].reason).toBe('automatic');
				expect(next?.type).toBe('refreshDatabases');
				expect(next!.requestToken).not.toBe(original.requestToken);
				window.__kustoBufferedHostMessages = [{
					type: 'databasesError', boxId, connectionId: original.connectionId, requestToken: original.requestToken,
					sectionInstanceId: original.sectionInstanceId, targetGeneration: original.targetGeneration, error: 'stale policy discovery',
				}];
				await drainMessages();
				expect(databaseRequestTokenByBoxId[boxId]).toBe(next!.requestToken);
				await deliverDatabases(next!, [database, 'LaterDb']);
				expect(schemaRequests()).toHaveLength(2);
				expect(schemaRequests()[1]).toMatchObject({ connectionId: connection.id, database: 'LaterDb' });
				expect(schemaRequests()[1].reason).not.toBe('automatic');
			} finally {
				restoreKustoLeaveNoTracePolicyRuntime(savedPolicy);
			}
		},
	);
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-query-section loading states', () => {
	it('renders Run All as a sticky split-menu mode', async () => {
		const el = createSection();
		await el.updateComplete;

		const item = el.querySelector(`#${el.boxId}_run_menu_all`) as HTMLElement | null;
		expect(item?.textContent?.trim()).toBe('Run All');
		expect(item?.dataset.runMode).toBe('runAll');
	});

	it('keeps the result picker available when the selected result set is empty', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;

		expect(el.displayResult({ columns: [], rows: [], metadata: {} }, {
			label: 'Results',
			resultSets: [
				{ resultIndex: 0, label: 'Result #1' },
				{ resultIndex: 1, label: 'Result #2' },
			],
			selectedResultIndex: 1,
			deferCsvRelease: true,
		})).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		expect(table).not.toBeNull();
		expect(table.options.selectedResultIndex).toBe(1);
		expect(table.options.resultSets).toHaveLength(2);
		expect(document.getElementById(el.boxId + '_results')?.textContent).not.toContain('No results');
	});

	it('applies result picker changes only after the exact host selection is accepted', async () => {
		const el = createSection();
		el.id = el.boxId;
		vi.spyOn(el, 'getSchemaLifecycleIdentity').mockReturnValue({
			sectionInstanceId: 'instance-results', targetGeneration: 3,
		});
		await el.updateComplete;
		const batch = createKustoResultBatch([
			{ columns: ['Value'], rows: [['first']], metadata: { resultName: 'First' } },
			{ columns: ['Value'], rows: [['second']], metadata: { resultName: 'Second' } },
			{ columns: ['Value'], rows: [['third']], metadata: { resultName: 'Third' } },
		]);
		expect(batch.ok).toBe(true);
		if (!batch.ok) return;
		expect(displayResultBatchForBox(batch.value, el.boxId, {
			label: 'Results', showExecutionTime: true,
			artifactPublication: {
				producer: { engine: 'kusto', boxId: el.boxId, executionId: 'execution-results' },
				policy: { exportToCsv: true },
			},
		})).toBe(true);
		const primaryArtifact = getCurrentResultArtifact(el.boxId, 0)!;
		const initialTable = el.querySelector('kw-data-table') as any;

		initialTable.dispatchEvent(new CustomEvent('result-set-change', { detail: { resultIndex: 1 } }));
		initialTable.dispatchEvent(new CustomEvent('result-set-change', { detail: { resultIndex: 2 } }));
		const requests = vi.mocked(postMessageToHost).mock.calls
			.map(([message]) => message as any)
			.filter(message => message.type === 'selectKustoResult');
		expect(requests).toHaveLength(2);
		expect(requests[1]).toMatchObject({
			boxId: el.boxId,
			sectionInstanceId: 'instance-results', targetGeneration: 3,
			primaryArtifactId: primaryArtifact.artifactId, resultIndex: 2,
		});

		el.applyResultSelectionResponse({
			type: 'kustoResultSelectionResult', requestId: requests[0].requestId,
			boxId: el.boxId, primaryArtifactId: primaryArtifact.artifactId,
			resultIndex: 1, accepted: true,
		});
		expect(getSelectedResultIndex(el.boxId)).toBe(0);
		el.applyResultSelectionResponse({
			type: 'kustoResultSelectionResult', requestId: requests[1].requestId,
			boxId: el.boxId, primaryArtifactId: primaryArtifact.artifactId,
			resultIndex: 2, accepted: false,
		});
		expect(getSelectedResultIndex(el.boxId)).toBe(0);

		initialTable.dispatchEvent(new CustomEvent('result-set-change', { detail: { resultIndex: 2 } }));
		const acceptedRequest = vi.mocked(postMessageToHost).mock.calls
			.map(([message]) => message as any)
			.filter(message => message.type === 'selectKustoResult').at(-1)!;
		el.applyResultSelectionResponse({
			type: 'kustoResultSelectionResult', requestId: acceptedRequest.requestId,
			boxId: el.boxId, primaryArtifactId: primaryArtifact.artifactId,
			resultIndex: 2, accepted: true,
		});

		expect(getSelectedResultIndex(el.boxId)).toBe(2);
		expect(getResultsState(el.boxId, 2)?.rows).toEqual([['third']]);
		const selectedTable = el.querySelector('kw-data-table') as any;
		expect(selectedTable.options.selectedResultIndex).toBe(2);
		expect(selectedTable.resultArtifactId).toBe(`${primaryArtifact.artifactId}:set:2`);
		expect(selectedTable.rows).toEqual([['third']]);
	});

	it('preserves complex preview state across accepted result tabs but not a fresh result table', async () => {
		const el = createSection();
		el.id = el.boxId;
		vi.spyOn(el, 'getSchemaLifecycleIdentity').mockReturnValue({
			sectionInstanceId: 'instance-complex-preview', targetGeneration: 4,
		});
		await el.updateComplete;
		const batch = createKustoResultBatch([
			{
				columns: [{ name: 'Details', type: 'dynamic' }],
				rows: [[{ display: '[object]', full: '{"set":"first","secret":"one"}', isObject: true }]],
				metadata: { resultName: 'First' },
			},
			{
				columns: [{ name: 'Details', type: 'dynamic' }],
				rows: [['{"set":"second","plain":true}']],
				metadata: { resultName: 'Second' },
			},
			{
				columns: [{ name: 'Details', type: 'dynamic' }],
				rows: [[{ display: '{...}', full: { set: 'third', secret: 'three' }, isObject: true }]],
				metadata: { resultName: 'Third' },
			},
		]);
		expect(batch.ok).toBe(true);
		if (!batch.ok) return;
		expect(displayResultBatchForBox(batch.value, el.boxId, {
			artifactPublication: {
				producer: { engine: 'kusto', boxId: el.boxId, executionId: 'execution-complex-preview' },
				policy: { exportToCsv: true },
			},
		})).toBe(true);
		let table = el.querySelector('kw-data-table') as any;
		await table.updateComplete;
		table.shadowRoot.querySelector('[data-testid="complex-preview-toggle"]').click();
		await table.updateComplete;
		const lengthInput = table.shadowRoot.querySelector('[data-testid="complex-preview-length"]') as HTMLInputElement;
		lengthInput.value = '9';
		lengthInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		await table.updateComplete;

		const selectAndAccept = (resultIndex: number) => {
			table.dispatchEvent(new CustomEvent('result-set-change', { detail: { resultIndex } }));
			const request = vi.mocked(postMessageToHost).mock.calls
				.map(([message]) => message as any)
				.filter(message => message.type === 'selectKustoResult').at(-1)!;
			el.applyResultSelectionResponse({
				type: 'kustoResultSelectionResult', requestId: request.requestId,
				boxId: el.boxId, primaryArtifactId: request.primaryArtifactId,
				resultIndex, accepted: true,
			});
			table = el.querySelector('kw-data-table') as any;
		};

		table.dispatchEvent(new CustomEvent('result-set-change', { detail: { resultIndex: 1 } }));
		const rejectedRequest = vi.mocked(postMessageToHost).mock.calls
			.map(([message]) => message as any)
			.filter(message => message.type === 'selectKustoResult').at(-1)!;
		el.applyResultSelectionResponse({
			type: 'kustoResultSelectionResult', requestId: rejectedRequest.requestId,
			boxId: el.boxId, primaryArtifactId: rejectedRequest.primaryArtifactId,
			resultIndex: 1, accepted: false,
		});
		expect(el.querySelector('kw-data-table')).toBe(table);
		expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 9 });

		selectAndAccept(1);
		expect(table.rows).toEqual([['{"set":"second","plain":true}']]);
		expect(table.shadowRoot.querySelector('[data-testid="complex-preview-toggle"]')).toBeNull();
		expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 9 });

		selectAndAccept(2);
		await table.updateComplete;
		expect(table.shadowRoot.querySelector('[data-testid="complex-preview-toggle"]')?.getAttribute('aria-pressed')).toBe('true');
		expect(table.shadowRoot.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')?.value).toBe('9');
		expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 9 });
		expect(table.canCopyRows()).toBe(true);
		expect(table.rows[0][0]).toEqual(expect.objectContaining({ isObject: true }));

		expect(el.displayResult({
			columns: [{ name: 'Details', type: 'dynamic' }],
			rows: [[{ display: '[object]', full: '{"fresh":true}', isObject: true }]],
			metadata: {},
		})).toBe(true);
		table = el.querySelector('kw-data-table') as any;
		await table.updateComplete;
		expect(table.shadowRoot.querySelector('[data-testid="complex-preview-toggle"]')?.getAttribute('aria-pressed')).toBe('false');
		expect(table.shadowRoot.querySelector('[data-testid="complex-preview-controls"]')).toBeNull();
	});

	it('switches restored result tabs locally in the read-only browser viewer', async () => {
		(window as any).__kustoReadOnlyMode = true;
		try {
			const el = createSection();
			el.id = el.boxId;
			await el.updateComplete;
			const batch = createKustoResultBatch([
				{
					columns: [{ name: 'Value', type: 'dynamic' }],
					rows: [[{ display: '[object]', full: '{"value":"first"}', isObject: true }]],
					metadata: {},
				},
				{
					columns: [{ name: 'Value', type: 'dynamic' }],
					rows: [[{ display: '[object]', full: '{"value":"second"}', isObject: true }]],
					metadata: {},
				},
			]);
			expect(batch.ok).toBe(true);
			if (!batch.ok) return;
			expect(displayResultBatchForBox(batch.value, el.boxId, {
				artifactPublication: { policy: { exportToCsv: true } },
			})).toBe(true);
			vi.mocked(postMessageToHost).mockClear();
			let table = el.querySelector('kw-data-table') as any;
			await table.updateComplete;
			table.shadowRoot.querySelector('[data-testid="complex-preview-toggle"]').click();
			await table.updateComplete;

			table.dispatchEvent(new CustomEvent('result-set-change', {
				detail: { resultIndex: 1 },
			}));

			expect(getSelectedResultIndex(el.boxId)).toBe(1);
			table = el.querySelector('kw-data-table') as any;
			expect(table.rows[0][0]).toEqual(expect.objectContaining({ full: '{"value":"second"}' }));
			expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 75 });
			expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
				type: 'selectKustoResult',
			}));
		} finally {
			delete (window as any).__kustoReadOnlyMode;
		}
	});

	it('switches unverified legacy result tabs locally without persisting authority', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;
		const resultJson = '{\r\n  "columns": ["Value"],\r\n  "rows": [["first"]],\r\n  "metadata": {"cluster": "legacy", "database": "Db"},\r\n  "additionalResults": {"version": 1, "sets": [{"resultIndex": 1, "columns": ["Value"], "rows": [["second"]], "metadata": {}}]}\r\n}';
		const batch = createKustoResultBatch([
			{ columns: ['Value'], rows: [['first']], metadata: {} },
			{ columns: ['Value'], rows: [['second']], metadata: {} },
		]);
		expect(batch.ok).toBe(true);
		if (!batch.ok) return;
		pState.queryResultJsonByBoxId[el.boxId] = resultJson;
		expect(displayResultBatchForBox(batch.value, el.boxId, {
			artifactPublication: createUnverifiedLegacyResultArtifactPublication({
				engine: 'kusto', boxId: el.boxId, query: 'print Value=1',
			}),
		})).toBe(true);
		vi.mocked(postMessageToHost).mockClear();
		const table = el.querySelector('kw-data-table') as any;

		table.dispatchEvent(new CustomEvent('result-set-change', {
			detail: { resultIndex: 1 },
		}));

		expect(getSelectedResultIndex(el.boxId)).toBe(1);
		expect((el.querySelector('kw-data-table') as any).rows).toEqual([['second']]);
		expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
			type: 'selectKustoResult',
		}));
		expect(pState.queryResultJsonByBoxId[el.boxId]).toBe(resultJson);
		expect(pState.resultArtifactByBoxId[el.boxId]).toBeUndefined();
		expect(pState.kustoResultOwnerByBoxId[el.boxId]).toBeUndefined();
		expect(el.serialize()).not.toHaveProperty('selectedResultIndex');
	});

	it('serializes only authored partial target fields over an inherited runtime target', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;
		el.setDesiredClusterUrl('https://source.kusto.windows.net');
		el.setDesiredConnectionIdentity('tenant-a.example.com', 'source-connection');
		el.setDesiredDatabase('Db');
		el.setPersistConnectionSelection(true, {
			authorityId: 'tenant-b.example.com',
		});

		const serialized = el.serialize();

		expect(serialized.authorityId).toBe('tenant-b.example.com');
		expect(serialized.clusterUrl).toBe('');
		expect(serialized.database).toBe('');
		expect(serialized.connectionIdHint).toBeUndefined();
	});

	it('focuses and restores the cluster trigger around the add-connection dialog', async () => {
		const el = createSection();
		await el.updateComplete;

		el.openAddConnectionModal();
		await el.updateComplete;
		const form = el.shadowRoot?.querySelector('kw-kusto-connection-form') as any;
		await form?.updateComplete;
		const clusterInput = form?.shadowRoot?.querySelector('[data-testid="kusto-conn-cluster-url"]');
		expect(form?.shadowRoot?.activeElement).toBe(clusterInput);

		clusterInput?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true }));
		await el.updateComplete;
		const dropdown = el.shadowRoot?.querySelector('kw-dropdown[data-testid="cluster-dropdown"]') as any;
		expect(el.shadowRoot?.querySelector('.add-connection-dialog')).toBeNull();
		expect(dropdown?.shadowRoot?.activeElement).toBe(dropdown?.shadowRoot?.querySelector('.kusto-dropdown-btn'));
	});

	it('correlates CSV save events to the exact admitted Kusto artifact', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;
		expect(displayResultForBox(
			{ columns: ['Value'], rows: [['a']], metadata: {} },
			el.boxId,
			{
				label: 'Results',
				artifactPublication: {
					producer: { engine: 'kusto', boxId: el.boxId, executionId: 'execution-a' },
					policy: { exportToCsv: true },
				},
			},
		)).toBe(true);
		const artifact = getCurrentResultArtifact(el.boxId)!;
		const table = document.querySelector('kw-data-table')!;
		expect((table as any).options.showSave).toBe(true);

		table.dispatchEvent(new CustomEvent('save', {
			detail: { csv: 'Value\na', suggestedFileName: 'Results.csv' },
		}));

		expect(postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'requestArtifactCsvSave', boxId: el.boxId, artifactId: artifact.artifactId,
			suggestedFileName: 'Results.csv',
		}));
	});

	it('registers a live governed table generation when CSV export is denied', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;
		expect(displayResultForBox(
			{ columns: ['Secret'], rows: [['local-copy']], metadata: {} }, el.boxId, {
				artifactPublication: {
					producer: { engine: 'kusto', boxId: el.boxId, executionId: 'copy-only' },
					policy: { exportToCsv: false },
				},
			},
		)).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		expect(table.options.showSave).toBe(false);
		expect(table.resultArtifactGoverned).toBe(true);
		expect(table.resultArtifactId).toBe(getCurrentResultArtifact(el.boxId)?.artifactId);
		expect(table.resultArtifactTableToken).toBeTruthy();
		expect(table.resultArtifactLiveCheck()).toBe(true);
	});

	it('auto-fits an initially hidden result table when it is revealed', async () => {
		vi.useFakeTimers();
		const el = createSection();
		el.id = el.boxId;
		pState.resultsVisibleByBoxId[el.boxId] = false;
		expect(el.displayResult({
			columns: [{ name: 'Value', type: 'int' }],
			rows: [[1], [2], [3], [4]],
			metadata: {},
		})).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		await table.updateComplete;
		const wrapper = document.getElementById(el.boxId + '_results_wrapper')!;
		const resizer = document.getElementById(el.boxId + '_results_resizer')!;
		table.getContentHeight = vi.fn(() => 180);
		expect(wrapper.style.height).toBe('48px');

		table.dispatchEvent(new CustomEvent('visibility-toggle', {
			detail: { visible: true }, bubbles: true, composed: true,
		}));

		expect(wrapper.style.height).toBe('200px');
		expect(resizer.style.display).toBe('');
		expect(wrapper.dataset.kustoUserResized).not.toBe('true');
		expect(el.serialize()).not.toHaveProperty('resultsHeightPx');

		table.dispatchEvent(new CustomEvent('visibility-toggle', {
			detail: { visible: false }, bubbles: true, composed: true,
		}));
		expect(wrapper.style.height).toBe('48px');
		vi.advanceTimersByTime(200);
		expect(wrapper.style.height).toBe('48px');
	});

	it('does not save an automatic editor height without a resize marker', async () => {
		const el = createSection();
		await el.updateComplete;
		const wrapper = el.querySelector('.query-editor-wrapper') as HTMLElement;
		wrapper.style.height = '180px';
		expect(el.serialize()).not.toHaveProperty('editorHeightPx');
		pState.manualQueryEditorHeightPxByBoxId[el.boxId] = 180;
		expect(el.serialize()).not.toHaveProperty('editorHeightPx');

		wrapper.dataset.kustoUserResized = 'true';
		expect(el.serialize().editorHeightPx).toBe(180);
	});

	it('auto-fits loaded query results without saving an unauthored height', async () => {
		vi.useFakeTimers();
		const el = createSection();
		el.id = el.boxId;
		expect(el.displayResult({
			columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {},
		})).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		await table.updateComplete;
		table.getContentHeight = vi.fn(() => 193);
		vi.advanceTimersByTime(200);
		const wrapper = document.getElementById(el.boxId + '_results_wrapper')!;
		expect(wrapper.style.height).toBe('213px');
		expect(el.serialize()).not.toHaveProperty('resultsHeightPx');
	});

	it('keeps a restored results height through delayed fit and initial table chrome', async () => {
		vi.useFakeTimers();
		const el = createSection();
		el.id = el.boxId;
		expect(el.displayResult({
			columns: [{ name: 'Value', type: 'int' }], rows: [[1]], metadata: {},
		})).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		await table.updateComplete;
		const wrapper = document.getElementById(el.boxId + '_results_wrapper')!;
		wrapper.style.height = '182px';
		wrapper.dataset.kustoUserResized = 'true';
		wrapper.dataset.kustoRestoredHeight = 'true';
		wrapper.dataset.kustoRestoredHeightPx = '182';
		table.getContentHeight = vi.fn(() => 193);
		vi.advanceTimersByTime(200);
		expect(wrapper.style.height).toBe('182px');
		table.dispatchEvent(new CustomEvent('chrome-height-change', { detail: { delta: 31 } }));
		expect(wrapper.style.height).toBe('182px');
		expect(el.serialize().resultsHeightPx).toBe(182);
	});

	it('does not let a detached reveal timer resize a same-ID replacement', async () => {
		vi.useFakeTimers();
		const el = createSection();
		el.id = el.boxId;
		pState.resultsVisibleByBoxId[el.boxId] = false;
		expect(el.displayResult({
			columns: [{ name: 'Value', type: 'int' }], rows: [[1], [2]], metadata: {},
		})).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		table.getContentHeight = vi.fn(() => 160);
		table.dispatchEvent(new CustomEvent('visibility-toggle', {
			detail: { visible: true }, bubbles: true, composed: true,
		}));

		el.remove();
		const replacement = document.createElement('div');
		replacement.id = 'test1';
		const replacementWrapper = document.createElement('div');
		replacementWrapper.id = 'test1_results_wrapper';
		replacementWrapper.style.display = 'flex';
		replacementWrapper.style.height = '333px';
		const replacementResults = document.createElement('div');
		replacementResults.id = 'test1_results';
		const replacementTable = document.createElement('kw-data-table') as any;
		replacementTable.getContentHeight = vi.fn(() => 80);
		replacementResults.appendChild(replacementTable);
		replacementWrapper.appendChild(replacementResults);
		replacement.appendChild(replacementWrapper);
		container.appendChild(replacement);

		vi.advanceTimersByTime(200);

		expect(replacementWrapper.style.height).toBe('333px');
	});

	it('does not let detached same-ID cleanup hide Save on the replacement table', async () => {
		const oldSection = document.createElement('kw-query-section') as KwQuerySection;
		oldSection.boxId = 'test1';
		oldSection.id = 'test1';
		container.appendChild(oldSection);
		expect(displayResultForBox(
			{ columns: ['Value'], rows: [['old']], metadata: {} }, 'test1', {
				artifactPublication: {
					producer: { engine: 'kusto', boxId: 'test1', executionId: 'old' },
					policy: { exportToCsv: true },
				},
			},
		)).toBe(true);
		oldSection.remove();

		const replacement = document.createElement('kw-query-section') as KwQuerySection;
		replacement.boxId = 'test1';
		replacement.id = 'test1';
		container.appendChild(replacement);
		expect(displayResultForBox(
			{ columns: ['Value'], rows: [['new']], metadata: {} }, 'test1', {
				artifactPublication: {
					producer: { engine: 'kusto', boxId: 'test1', executionId: 'new' },
					policy: { exportToCsv: true },
				},
			},
		)).toBe(true);
		await Promise.resolve();
		await replacement.updateComplete;

		const table = replacement.querySelector('kw-data-table') as any;
		expect(table?.rows).toEqual([['new']]);
		expect(table?.options.showSave).toBe(true);
		expect(table?.resultArtifactId).toBe(getCurrentResultArtifact('test1')?.artifactId);
	});

	it('hides Save and cancels pending CSV when the result artifact is revoked', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;
		expect(displayResultForBox(
			{ columns: ['Value'], rows: [['revoked']], metadata: {} }, el.boxId, {
				artifactPublication: {
					producer: { engine: 'kusto', boxId: el.boxId, executionId: 'revoked' },
					policy: { exportToCsv: true },
				},
			},
		)).toBe(true);
		const table = el.querySelector('kw-data-table') as any;
		table.dispatchEvent(new CustomEvent('save', {
			detail: { csv: 'Value\nrevoked', suggestedFileName: 'Results.csv' },
		}));
		const intent = vi.mocked(postMessageToHost).mock.calls
			.map(call => call[0] as any)
			.find(message => message.type === 'requestArtifactCsvSave');

		clearResultsState(el.boxId);
		await table.updateComplete;
		expect(table.options.showSave).toBe(false);
		expect(table.resultArtifactId).toBe('');
		expect(table.rows).toEqual([]);
		expect(table.columns).toEqual([]);
		expect(table.style.visibility).toBe('hidden');
		expect(document.getElementById(el.boxId + '_results_wrapper')?.style.display).toBe('none');
		expect(postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelArtifactCsvSaveIntent', requestId: intent.requestId,
		});
	});

	it('admits terminals only for the exact active Kusto execution', () => {
		const el = createSection();
		el.setConnectionId('connection-1');
		el.setDesiredDatabase('Samples');
		el.setDatabases(['Samples'], 'Samples');
		el.setSchemaLifecycleTarget('connection-1', 'Samples');

		expect(el.beginQueryExecution('execution-old')).toBe(true);
		expect(el.beginQueryExecution('execution-new')).toBe(true);
		expect(el.getActiveExecutionId()).toBe('execution-new');
		expect(el.acceptsQueryTerminal('execution-old')).toBe(false);
		expect(el.completeQueryExecution('execution-old')).toBe(false);
		expect(el.acceptsQueryTerminal('execution-new')).toBe(true);
		expect(el.completeQueryExecution('execution-new')).toBe(true);
		expect(el.getActiveExecutionId()).toBe('');
	});

	it('rejects a terminal whose target or producer differs from the active owner', () => {
		const el = createSection();
		el.setConnectionId('connection-1');
		el.setDesiredDatabase('Samples');
		el.setDatabases(['Samples'], 'Samples');
		el.setSchemaLifecycleTarget('connection-1', 'Samples');
		el.beginQueryExecution('execution-exact', 'manual');
		const active = el.getActiveExecution()!;

		expect(el.admitQueryTerminal({ ...active, database: 'Other' })).toBe('rejected');
		expect(el.admitQueryTerminal({ ...active, producer: 'tool' })).toBe('rejected');
		expect(el.admitQueryTerminal(active)).toBe('active');
	});

	it('keeps the exact active execution owned while cancellation is pending', () => {
		const el = createSection();
		el.setConnectionId('connection-1');
		el.setDesiredDatabase('Samples');
		el.setDatabases(['Samples'], 'Samples');
		el.setSchemaLifecycleTarget('connection-1', 'Samples');
		el.beginQueryExecution('execution-cancel');

		expect(el.cancelActiveQueryExecution()).toBe('execution-cancel');
		expect(el.getActiveExecutionId()).toBe('execution-cancel');
		expect(el.acceptsQueryTerminal('execution-cancel')).toBe(true);
		expect(el.cancelActiveQueryExecution()).toBeUndefined();
		expect(el.completeQueryExecution('execution-cancel')).toBe(true);
		expect(el.getActiveExecutionId()).toBe('');
	});

	it('admits each delayed retired terminal exactly once after many rapid replacements', () => {
		const el = createSection();
		el.setConnectionId('connection-1');
		el.setDesiredDatabase('Samples');
		el.setDatabases(['Samples'], 'Samples');
		el.setSchemaLifecycleTarget('connection-1', 'Samples');
		const owners: NonNullable<ReturnType<typeof el.getActiveExecution>>[] = [];

		for (let index = 0; index < 20; index++) {
			expect(el.beginQueryExecution(`execution-${index}`)).toBe(true);
			owners.push(el.getActiveExecution()!);
		}

		expect(el.admitQueryTerminal(owners[0])).toBe('retired');
		expect(el.admitQueryTerminal(owners[0])).toBe('rejected');
		expect(el.admitQueryTerminal(owners[19])).toBe('active');
	});

	it('reflects preparation state without replacing the toolbar or editor nodes', async () => {
		const el = createSection();
		await el.updateComplete;
		const toolbar = el.querySelector('kw-query-toolbar');
		const editor = el.querySelector('.query-editor');
		const token = beginKustoPreparation('test1', {
			stage: 'schema',
			blockers: ['schema', 'worker', 'enhancement'],
			target: { connectionId: 'c1', database: 'Samples' },
		})!;

		expect(el.dataset.preparationState).toBe('preparing');
		expect(el.dataset.testPreparationState).toBe('preparing');
		expect(el.dataset.testPreparationStage).toBe('schema');
		expect(el.dataset.testPreparationBlockers).toBe('schema,worker,enhancement');
		expect(el.getAttribute('aria-busy')).toBe('true');
		expect(el.querySelector('kw-query-toolbar')).toBe(toolbar);
		expect(el.querySelector('.query-editor')).toBe(editor);

		updateKustoPreparation(token, { removeBlockers: ['schema', 'worker', 'enhancement'] });

		expect(el.dataset.preparationState).toBe('ready');
		expect(el.dataset.testPreparationState).toBe('ready');
		expect(el.dataset.testPreparationBlockers).toBe('');
		expect(el.getAttribute('aria-busy')).toBe('false');
		expect(el.querySelector('kw-query-toolbar')).toBe(toolbar);
		expect(el.querySelector('.query-editor')).toBe(editor);
	});

	it('stops the progress state when the base worker is ready while enhancement remains pending', async () => {
		const el = createSection();
		await el.updateComplete;
		const token = beginKustoPreparation('test1', {
			stage: 'waiting-worker',
			blockers: ['worker', 'enhancement'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;

		markSchemaEnhancementPending('test1', 'cluster|db', 'sig-1', 'inmemory://model/1', token);
		markSchemaWorkerReady('test1', 'cluster|db', 'sig-1', 'inmemory://model/1', token);

		expect(getSchemaEnhancementReadyState('test1')?.status).toBe('pending');
		expect(el.dataset.testPreparationState).toBe('ready');
		expect(el.dataset.testPreparationBlockers).toBe('');
		expect(el.getAttribute('aria-busy')).toBe('false');
	});

	it('does not show progress while worker hydration waits for editor focus', async () => {
		const el = createSection();
		await el.updateComplete;
		const token = beginKustoPreparation('test1', {
			stage: 'waiting-worker',
			blockers: ['worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
			usableFallback: true,
		})!;

		updateKustoPreparation(token, {
			status: 'deferred',
			stage: 'waiting-focus',
			replaceBlockers: [],
		});

		expect(el.dataset.testPreparationState).toBe('deferred');
		expect(el.dataset.testPreparationStage).toBe('waiting-focus');
		expect(el.dataset.testPreparationBlockers).toBe('');
		expect(el.getAttribute('aria-busy')).toBe('false');
	});

	it('keeps progress visible when cached schema exists but the current worker is not ready', async () => {
		const el = createSection();
		await el.updateComplete;
		beginKustoPreparation('test1', {
			stage: 'waiting-worker',
			blockers: ['refresh', 'worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
			usableFallback: true,
		});

		expect(el.dataset.testPreparationState).toBe('preparing');
		expect(el.dataset.testPreparationBlockers).toBe('refresh,worker');
		expect(el.getAttribute('aria-busy')).toBe('true');
	});

	it('tracks exact worker readiness through ready, revoked, and recovered transitions', async () => {
		const el = createSection();
		await el.updateComplete;
		beginKustoPreparation('test1', {
			stage: 'refreshing',
			blockers: ['refresh', 'worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
			usableFallback: true,
		});

		expect(el.dataset.testPreparationState).toBe('preparing');
		expect(el.dataset.testPreparationBlockers).toBe('refresh,worker');
		expect(el.getAttribute('aria-busy')).toBe('true');

		setSchemaWorkerReadyState('test1', {
			status: 'ready', schemaKey: 'cluster|db', schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/1', updatedAt: Date.now(),
		});

		expect(el.getAttribute('aria-busy')).toBe('false');

		clearSchemaWorkerReadyState('test1');

		expect(el.getAttribute('aria-busy')).toBe('true');

		setSchemaWorkerReadyState('test1', {
			status: 'ready', schemaKey: 'cluster|db', schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/1', updatedAt: Date.now(),
		});

		expect(el.getAttribute('aria-busy')).toBe('false');
	});

	it.each([
		['schema key', 'other|db', 'sig-1', 'inmemory://model/1', true],
		['schema signature', 'cluster|db', 'sig-old', 'inmemory://model/1', true],
		['model URI', 'cluster|db', 'sig-1', 'inmemory://model/other', true],
		['fallback flag', 'cluster|db', 'sig-1', 'inmemory://model/1', false],
	] as const)('keeps progress visible when the ready worker mismatches by %s', async (
		_name, workerSchemaKey, workerSignature, workerModelUri, usableFallback,
	) => {
		const el = createSection();
		await el.updateComplete;
		setSchemaWorkerReadyState('test1', {
			status: 'ready', schemaKey: workerSchemaKey, schemaSignature: workerSignature,
			modelUri: workerModelUri, updatedAt: Date.now(),
		});
		beginKustoPreparation('test1', {
			stage: 'waiting-worker',
			blockers: ['refresh', 'worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
			usableFallback,
		});

		expect(el.getAttribute('aria-busy')).toBe('true');
	});

	it('resubscribes to worker readiness after disconnect and reconnect', async () => {
		const el = createSection();
		await el.updateComplete;
		beginKustoPreparation('test1', {
			stage: 'refreshing', blockers: ['refresh', 'worker'], usableFallback: true,
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		});
		setSchemaWorkerReadyState('test1', {
			status: 'ready', schemaKey: 'cluster|db', schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/1', updatedAt: Date.now(),
		});
		expect(el.getAttribute('aria-busy')).toBe('false');

		el.remove();
		clearSchemaWorkerReadyState('test1');
		expect(el.getAttribute('aria-busy')).toBe('false');

		container.appendChild(el);
		expect(el.getAttribute('aria-busy')).toBe('true');

		setSchemaWorkerReadyState('test1', {
			status: 'ready', schemaKey: 'cluster|db', schemaSignature: 'sig-1',
			modelUri: 'inmemory://model/1', updatedAt: Date.now(),
		});
		expect(el.getAttribute('aria-busy')).toBe('false');
	});

	it('settles shared cached schema adoption while worker hydration waits for focus', async () => {
		const connection = {
			id: 'c1',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a',
		};
		const schemaKey = getKustoSchemaIdentityKey('c1', 'partition-a', connection.clusterUrl, 'Db');
		setStateConnections([connection]);
		schemaByConnDb[schemaKey] = {
			tables: ['Events'],
			columnTypesByTable: {},
			rawSchemaJson: { Databases: { Db: {} } },
		};
		schemaMetaByConnDb[schemaKey] = { schemaSignature: 'sig-cache' };
		const el = createSection();
		el.id = 'test1';
		el.setConnections([connection]);
		el.setConnectionId('c1');
		el.setDatabases(['Db'], 'Db');
		await el.updateComplete;

		try {
			el.connectionCtrl.ensureSchema(false);

			expect(getKustoEditorSchema('test1')?.rawSchemaJson).toEqual({ Databases: { Db: {} } });
			expect(getKustoPreparationState('test1')).toMatchObject({
				status: 'deferred',
				stage: 'waiting-focus',
				blockers: [],
				usableFallback: true,
				target: { connectionId: 'c1', database: 'Db', schemaSignature: 'sig-cache' },
			});
			expect(el.getAttribute('aria-busy')).toBe('false');
			expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'prefetchSchema' }));
		} finally {
			delete schemaByConnDb[schemaKey];
			delete schemaMetaByConnDb[schemaKey];
			setStateConnections([]);
		}
	});

	it('revokes diagnostic readiness immediately when refreshing a usable schema', async () => {
		const connection = {
			id: 'c1',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a',
		};
		setStateConnections([connection]);
		const el = createSection();
		el.id = 'test1';
		el.setConnections([connection]);
		el.setConnectionId('c1');
		el.setDatabases(['Db'], 'Db');
		await el.updateComplete;
		el.setSchemaLifecycleTarget('c1', 'Db');
		setKustoEditorSchema('test1', { tables: ['Events'], rawSchemaJson: { Databases: { Db: {} } } });
		beginKustoPreparation('test1', {
			stage: 'ready',
			blockers: [],
			target: { connectionId: 'c1', database: 'Db' },
			usableFallback: true,
		});

		try {
			expect(el.getConnectionId()).toBe('c1');
			expect(el.getDatabase()).toBe('Db');
			expect(getKustoEditorSchema('test1')?.rawSchemaJson).toBeTruthy();
			expect(getKustoPreparationState('test1')).toMatchObject({ status: 'ready', target: { connectionId: 'c1', database: 'Db' } });
			el.connectionCtrl.ensureSchema(true);

			expect(getKustoPreparationState('test1')).toMatchObject({
				status: 'preparing',
				stage: 'refreshing',
				blockers: ['refresh'],
				usableFallback: true,
			});
			expect(schemaFetchInFlightByBoxId.test1).toBe(true);
			expect(postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({ type: 'prefetchSchema', forceRefresh: true }));
		} finally {
			setStateConnections([]);
		}
	});

	it('keeps stale cache-only prewarm busy until a concrete worker fallback is correlated', async () => {
		const connection = {
			id: 'c1',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a',
		};
		setStateConnections([connection]);
		const el = createSection();
		el.id = 'test1';
		el.setConnections([connection]);
		el.setConnectionId('c1');
		el.setDatabases(['Db'], 'Db');
		await el.updateComplete;
		el.setSchemaLifecycleTarget('c1', 'Db');
		setKustoEditorSchema('test1', { tables: ['Events'], rawSchemaJson: { Databases: { Db: {} } } });
		setKustoSchemaMetadata('test1', {
			schemaSignature: 'sig-stale', fromCache: true, cacheState: 'stale', isStale: true,
			refreshState: 'none', cacheOnly: true,
		});
		beginKustoPreparation('test1', {
			stage: 'ready', blockers: [],
			target: { connectionId: 'c1', database: 'Db', schemaSignature: 'sig-stale' },
			usableFallback: true,
		});
		schemaFetchInFlightByBoxId.test1 = false;
		lastSchemaRequestAtByBoxId.test1 = 0;
		delete schemaRequestTokenByBoxId.test1;
		vi.mocked(postMessageToHost).mockClear();

		try {
			el.connectionCtrl.ensureSchema(false);

			expect(getKustoPreparationState('test1')).toMatchObject({
				status: 'preparing', stage: 'refreshing', blockers: ['refresh'], usableFallback: true,
			});
			expect(el.dataset.testPreparationState).toBe('preparing');
			expect(el.dataset.testPreparationBlockers).toBe('refresh');
			expect(el.getAttribute('aria-busy')).toBe('true');
			expect(schemaFetchInFlightByBoxId.test1).toBe(true);
			expect(postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
				type: 'prefetchSchema', connectionId: 'c1', database: 'Db', boxId: 'test1',
				forceRefresh: false,
			}));
		} finally {
			setStateConnections([]);
		}
	});

	it('stops the progress state when worker preparation fails terminally', async () => {
		const el = createSection();
		await el.updateComplete;
		const token = beginKustoPreparation('test1', {
			stage: 'waiting-worker',
			blockers: ['worker'],
			target: { schemaKey: 'cluster|db', schemaSignature: 'sig-1', modelUri: 'inmemory://model/1' },
		})!;

		markSchemaWorkerApplyFailed('test1', 'cluster|db', 'inmemory://model/1', token);

		expect(el.dataset.testPreparationState).toBe('error');
		expect(el.dataset.testPreparationStage).toBe('error');
		expect(el.dataset.testPreparationBlockers).toBe('');
		expect(el.getAttribute('aria-busy')).toBe('false');
	});

	it('refresh button shows spinner when setRefreshLoading(true)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setRefreshLoading(true);
		await el.updateComplete;

		expect(hasSpinner(el)).toBe(true);
		const btn = getRefreshButton(el);
		expect(btn).not.toBeNull();
		expect(btn!.disabled).toBe(true);
	});

	it('refresh button stops spinner when setRefreshLoading(false)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setRefreshLoading(true);
		await el.updateComplete;
		expect(hasSpinner(el)).toBe(true);

		el.setRefreshLoading(false);
		await el.updateComplete;
		expect(hasSpinner(el)).toBe(false);
		const btn = getRefreshButton(el);
		expect(btn!.disabled).toBe(false);
	});

	it('database dropdown shows loading state when setDatabasesLoading(true)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setDatabasesLoading(true);
		await el.updateComplete;

		const dropdown = getDatabaseDropdown(el);
		expect(dropdown).not.toBeNull();
		expect(dropdown!.loading).toBe(true);
	});

	it('setDatabases() resets databasesLoading to false (success path)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		el.setDatabasesLoading(true);
		await el.updateComplete;

		el.setDatabases(['db1', 'db2']);
		await el.updateComplete;

		const dropdown = getDatabaseDropdown(el);
		expect(dropdown!.loading).toBe(false);
	});

	it('setDatabasesLoading(false) resets loading after error (error path)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		// Simulate: refreshDatabases sets both loading flags
		el.setRefreshLoading(true);
		el.setDatabasesLoading(true);
		await el.updateComplete;

		// Verify both are loading
		expect(hasSpinner(el)).toBe(true);
		const dropdown = getDatabaseDropdown(el);
		expect(dropdown!.loading).toBe(true);

		// Simulate: error path must reset both
		el.setRefreshLoading(false);
		el.setDatabasesLoading(false);
		await el.updateComplete;

		// Verify both loading states are cleared
		expect(hasSpinner(el)).toBe(false);
		expect(dropdown!.loading).toBe(false);
		const btn = getRefreshButton(el);
		expect(btn!.disabled).toBe(false);
	});

	it('loading states survive rapid toggle (no stale state)', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		await el.updateComplete;

		// Rapid: set loading, then immediately clear
		el.setRefreshLoading(true);
		el.setDatabasesLoading(true);
		el.setRefreshLoading(false);
		el.setDatabasesLoading(false);
		await el.updateComplete;

		expect(hasSpinner(el)).toBe(false);
		const dropdown = getDatabaseDropdown(el);
		expect(dropdown!.loading).toBe(false);
	});

	it('ignores stale database responses until the current request token completes', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		el.setDatabasesLoading(true);
		databaseRequestTokenByBoxId.test1 = 'databases_new';

		el.connectionCtrl.updateDatabaseSelect(['OldDb'], 'c1', 'databases_old');
		await el.updateComplete;
		expect(el.dataset.testDatabaseCount).toBe('0');
		expect(getDatabaseDropdown(el)!.loading).toBe(true);

		el.connectionCtrl.updateDatabaseSelect(['CurrentDb'], 'c1', 'databases_new');
		await el.updateComplete;
		expect(el.dataset.testDatabaseCount).toBe('1');
		expect(getDatabaseDropdown(el)!.loading).toBe(false);
		expect(databaseRequestTokenByBoxId.test1).toBeUndefined();

		el.connectionCtrl.updateDatabaseSelect(['ReplayedDb'], 'c1', 'databases_new');
		await el.updateComplete;
		expect(el.dataset.testDatabase).toBe('CurrentDb');
		expect(el.dataset.testDatabaseCount).toBe('1');
	});

	it('resolves a restored database using the server casing', async () => {
		const el = createSection();
		el.setDesiredDatabase('saveddb');

		el.setDatabases(['OtherDb', 'SavedDb']);
		await el.updateComplete;

		expect(el.getDesiredDatabase()).toBe('');
		expect(el.getDatabase()).toBe('SavedDb');
		expect(el.dataset.testDatabase).toBe('SavedDb');
	});

	it('keeps database preparation active when a cached list omits restored intent', async () => {
		const el = createSection();
		el.setDesiredDatabase('MissingDb');
		beginKustoPreparation('test1', { stage: 'databases', blockers: ['databases'], target: { connectionId: 'c1' } });

		el.setDatabases(['CachedDb']);
		await el.updateComplete;

		expect(el.getDatabase()).toBe('MissingDb');
		expect(el.getDesiredDatabase()).toBe('MissingDb');
		expect(getKustoPreparationState('test1')).toMatchObject({ status: 'preparing', stage: 'databases', blockers: ['databases'] });
	});

	it('ignores tokened database data after the owning request was disposed', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		delete databaseRequestTokenByBoxId.test1;

		el.connectionCtrl.updateDatabaseSelect(['LateDb'], 'c1', 'databases_removed');
		await el.updateComplete;

		expect(el.dataset.testDatabaseCount).toBe('0');
		expect(el.getDatabase()).toBe('');
	});

	it('ignores tokened database errors after the owning request was disposed', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		beginKustoPreparation('test1', { stage: 'databases', blockers: ['databases'], target: { connectionId: 'c1' } });
		delete databaseRequestTokenByBoxId.test1;

		el.connectionCtrl.onDatabasesError('late failure', 'c1', 'databases_removed');
		await el.updateComplete;

		expect(getKustoPreparationState('test1')).toMatchObject({ status: 'preparing', stage: 'databases', blockers: ['databases'] });
	});

	it('settles database preparation when a restored database is unavailable', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		el.setDesiredDatabase('MissingDb');
		beginKustoPreparation('test1', { stage: 'databases', blockers: ['databases'], target: { connectionId: 'c1' } });
		databaseRequestTokenByBoxId.test1 = 'databases_current';

		el.connectionCtrl.updateDatabaseSelect(['Db1', 'Db2'], 'c1', 'databases_current');
		await el.updateComplete;

		expect(getKustoPreparationState('test1')).toMatchObject({ status: 'error', stage: 'error', blockers: [] });
		expect(el.getAttribute('aria-busy')).toBe('false');
		expect(databaseRequestTokenByBoxId.test1).toBeUndefined();

		el.connectionCtrl.onDatabasesError('replayed failure', 'c1', 'databases_current');
		expect(getKustoPreparationState('test1')).toMatchObject({ status: 'error', error: 'Database "MissingDb" is not available.' });
	});

	it('settles database preparation when discovery fails for a restored database', async () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setConnectionId('c1');
		el.setDesiredDatabase('MissingDb');
		beginKustoPreparation('test1', { stage: 'databases', blockers: ['databases'], target: { connectionId: 'c1' } });
		databaseRequestTokenByBoxId.test1 = 'databases_current';

		el.connectionCtrl.onDatabasesError('boom', 'c1', 'databases_current');
		await el.updateComplete;

		expect(getKustoPreparationState('test1')).toMatchObject({ status: 'error', stage: 'error', blockers: [] });
		expect(el.getAttribute('aria-busy')).toBe('false');
	});

	it('clears linked comparison schema state when the source target changes', () => {
		const source = createSection();
		source.id = 'test1';
		source.setConnectionId('connection-new');
		source.setDatabase('NewDb');
		source.setSchemaLifecycleTarget('connection-new', 'NewDb');
		const comparison = document.createElement('kw-query-section') as KwQuerySection;
		comparison.setAttribute('box-id', 'comparison_1');
		comparison.id = 'comparison_1';
		container.appendChild(comparison);
		comparison.setConnectionId('connection-old');
		comparison.setDatabase('OldDb');
		comparison.setSchemaLifecycleTarget('connection-old', 'OldDb');
		comparison.beginQueryExecution('comparison-old-execution', 'comparison');
		const oldOwner = comparison.getActiveExecution()!;
		optimizationMetadataByBoxId.test1 = { comparisonBoxId: 'comparison_1' };
		setKustoEditorSchema('comparison_1', { tables: [], columnTypesByTable: {}, rawSchemaJson: { Databases: { OldDb: {} } } });
		setKustoSchemaMetadata('comparison_1', { schemaSignature: 'old' });
		setPendingSchemaWorkerUpdate('comparison_1', {
			rawSchemaJson: {}, clusterUrl: 'https://old.kusto.windows.net', database: 'OldDb', schemaKey: 'old|olddb',
		});
		schemaFetchInFlightByBoxId.comparison_1 = true;
		lastSchemaRequestAtByBoxId.comparison_1 = 123;
		schemaRequestTokenByBoxId.comparison_1 = 'schema_old';
		databaseRequestTokenByBoxId.comparison_1 = 'databases_old';
		setSchemaWorkerReadyState('comparison_1', { status: 'ready', schemaKey: 'old|olddb', updatedAt: Date.now() });
		setSchemaEnhancementReadyState('comparison_1', { status: 'ready', schemaKey: 'old|olddb', modelUri: 'model-old', updatedAt: Date.now() });
		beginKustoPreparation('comparison_1', { stage: 'ready', blockers: [], target: { schemaKey: 'old|olddb' } });

		invalidateLinkedComparisonSchemaForSource('test1');

		expect(comparison.getConnectionId()).toBe('connection-new');
		expect(comparison.getDatabase()).toBe('NewDb');
		expect(comparison.getSchemaLifecycleIdentity()).toMatchObject({ targetGeneration: 2 });
		expect(comparison.getActiveExecution()).toBeUndefined();
		expect(comparison.admitQueryTerminal(oldOwner)).toBe('retired');
		expect(postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelQuery', boxId: 'comparison_1', executionId: oldOwner.executionId,
			sectionInstanceId: oldOwner.sectionInstanceId,
			targetGeneration: oldOwner.targetGeneration,
		});
		expect(getKustoEditorSchema('comparison_1')).toBeUndefined();
		expect(getKustoSchemaMetadata('comparison_1')).toBeUndefined();
		expect(getPendingSchemaWorkerUpdate('comparison_1')).toBeUndefined();
		expect(schemaFetchInFlightByBoxId.comparison_1).toBe(false);
		expect(lastSchemaRequestAtByBoxId.comparison_1).toBe(0);
		expect(schemaRequestTokenByBoxId.comparison_1).toBeUndefined();
		expect(databaseRequestTokenByBoxId.comparison_1).toBeUndefined();
		expect(getSchemaWorkerReadyState('comparison_1')).toBeUndefined();
		expect(getSchemaEnhancementReadyState('comparison_1')).toBeUndefined();
		expect(getKustoPreparationState('comparison_1').status).toBe('idle');
		expect(isSchemaWorkerApplyRequired('comparison_1')).toBe(true);
	});

	it('preserves the same-target comparison Copilot owner during schema-only invalidation', () => {
		const source = createSection();
		source.setConnectionId('connection-1');
		source.setDatabase('Db');
		source.setSchemaLifecycleTarget('connection-1', 'Db');
		const comparison = document.createElement('kw-query-section') as KwQuerySection;
		comparison.setAttribute('box-id', 'comparison_1');
		comparison.id = 'comparison_1';
		container.appendChild(comparison);
		comparison.setConnectionId('connection-1');
		comparison.setDatabase('Db');
		comparison.setSchemaLifecycleTarget('connection-1', 'Db');
		const lifecycle = comparison.getSchemaLifecycleIdentity()!;
		const copilotOwner = { boxId: 'comparison_1', copilotRequestId: 'copilot-same-target', ...lifecycle };
		(comparison.copilotChatCtrl as any).activeKustoRequest = copilotOwner;
		(comparison.copilotChatCtrl as any).kustoConversationOwner = copilotOwner;
		optimizationMetadataByBoxId.test1 = { comparisonBoxId: 'comparison_1' };

		invalidateLinkedComparisonSchemaForSource('test1');

		expect(comparison.getSchemaLifecycleIdentity()).toEqual(lifecycle);
		expect(comparison.admitKustoCopilotMessage(copilotOwner, 'copilotWriteQueryStatus')).toBe(true);
	});

	it('selects the first configured connection when no desired current or last selection exists', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setConnections([
			{ id: 'c1', clusterUrl: 'https://first.kusto.windows.net' },
			{ id: 'c2', clusterUrl: 'https://second.kusto.windows.net' },
		]);
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('c1');
		expect(el.getClusterUrl()).toBe('https://first.kusto.windows.net');
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({
			boxId: 'test1',
			connectionId: 'c1',
			clusterUrl: 'https://first.kusto.windows.net',
		});
	});

	it('still prefers the last configured connection over the first fallback', async () => {
		const el = createSection();

		el.setConnections([
			{ id: 'c1', clusterUrl: 'https://first.kusto.windows.net' },
			{ id: 'c2', clusterUrl: 'https://second.kusto.windows.net' },
		], { lastConnectionId: 'c2' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('c2');
		expect(el.getClusterUrl()).toBe('https://second.kusto.windows.net');
	});

	it('preserves the active owner and rows when an account-establishing snapshot updates account metadata', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-a' }]);
		el.setDatabases(['AccountADb'], 'AccountADb');
		el.displayResult({ columns: ['value'], rows: [['account-a']], metadata: {} });
		setResultsState('test1', { boxId: 'test1', columns: ['value'], rows: [['account-a']] });
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['value'], rows: [['account-a']] });
		el.setSchemaLifecycleTarget('c1', 'AccountADb');
		el.beginQueryExecution('account-establishing', 'manual');
		const active = el.getActiveExecution();
		connectionEvents.length = 0;
		expect(el.getDatabase()).toBe('AccountADb');

		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-b' }]);
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('c1');
		expect(el.getDatabase()).toBe('AccountADb');
		expect(el.getActiveExecution()).toEqual(active);
		expect((el as any)._testHasResults).toBe(true);
		expect(getResultsState('test1')).toMatchObject({ rows: [['account-a']] });
		expect(pState.queryResultJsonByBoxId.test1).toBeDefined();
		expect(connectionEvents).toHaveLength(0);
	});

	it('serializes persisted rows with their immutable artifact descriptor', async () => {
		applyKustoLeaveNoTracePolicy([], false);
		const clusterUrl = 'https://cluster.kusto.windows.net';
		const el = createSection();
		el.id = 'test1';
		el.setDesiredClusterUrl(clusterUrl);
		el.setDesiredDatabase('Db');
		el.setConnections([{ id: 'c1', clusterUrl, accountPartition: 'partition-a' }]);
		el.setDatabases(['Db'], 'Db');
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		pState.kustoResultOwnerByBoxId.test1 = { accountPartition: 'partition-a', leaveNoTraceRevision: 0 };
		setResultsState('test1', {
			boxId: 'test1', columns: [{ name: 'Value' }], rows: [[1]], metadata: {},
		}, {
			producer: {
				engine: 'kusto', boxId: 'test1', executionId: 'execution-1',
				sectionInstanceId: 'instance-1', targetGeneration: 2, reservationSequence: 3,
				connectionId: 'c1', database: 'Db', producer: 'manual',
			},
			policy: { accountPartition: 'partition-a', leaveNoTraceRevision: 0 },
		});

		try {
			const serialized = el.serialize();

			expect(serialized.resultJson).toContain('"rows"');
			expect(serialized.resultArtifact).toMatchObject({
				version: 1,
				sourceBoxId: 'test1',
				revision: expect.any(Number),
				producer: expect.objectContaining({ executionId: 'execution-1', reservationSequence: 3 }),
				policy: expect.objectContaining({ accountPartition: 'partition-a', leaveNoTraceRevision: 0 }),
			});
			expect(serialized.resultArtifact!.revision).toBeGreaterThan(0);
		} finally {
			markKustoLeaveNoTracePolicyPending();
		}
	});

	it('republishes a restored target when its physical connection stamp arrives', async () => {
		const el = createSection();
		el.setConnections([{
			id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net',
		}]);
		el.setDatabases(['Db'], 'Db');
		el.setSchemaLifecycleTarget('c1', 'Db');
		el.displayResult({ columns: ['value'], rows: [['keep']], metadata: {} });
		setResultsState('test1', { boxId: 'test1', columns: ['value'], rows: [['keep']] });
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['value'], rows: [['keep']] });
		const before = kustoEditorSchemaCoordinator.getTarget('test1');
		const beforeIdentity = el.getSchemaLifecycleIdentity()!;
		const lifecycleEvents: any[] = [];
		const unsubscribe = kustoEditorSchemaCoordinator.subscribeLifecycle(event => lifecycleEvents.push(event));

		try {
			el.setConnections([{
				id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net',
				connectionRevision: 4, connectionIdentityKey: 'cluster|',
			}]);
		} finally {
			unsubscribe();
		}

		const after = kustoEditorSchemaCoordinator.getTarget('test1');
		expect(after).toMatchObject({
			connectionId: 'c1', database: 'Db', connectionRevision: 4, connectionIdentityKey: 'cluster|',
		});
		expect(before).toMatchObject({ connectionId: 'c1', database: 'Db' });
		expect(el.getSchemaLifecycleIdentity()!.targetGeneration).toBeGreaterThan(beforeIdentity.targetGeneration);
		expect(getResultsState('test1')).toMatchObject({ rows: [['keep']] });
		expect(pState.queryResultJsonByBoxId.test1).toBeDefined();
		expect(lifecycleEvents).toContainEqual(expect.objectContaining({
			type: 'target', owner: expect.objectContaining({ boxId: 'test1' }),
			target: expect.objectContaining({
				connectionId: 'c1', database: 'Db', connectionRevision: 4, connectionIdentityKey: 'cluster|',
			}),
		}));
	});

	it('preserves a stamped restored artifact when initial physical enrichment resolves to another owner', () => {
		const el = createSection();
		el.id = el.boxId;
		el.setConnections([{
			id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net',
		}]);
		el.setDatabases(['Db'], 'Db');
		el.setSchemaLifecycleTarget('c1', 'Db');
		displayResultForBox({ columns: ['marker'], rows: [['RESTORED']], metadata: {} }, 'test1', {
			artifactPublication: {
				producer: {
					engine: 'kusto', boxId: 'test1', executionId: 'restored-execution',
					connectionId: 'c1', database: 'Db',
				},
				policy: { connectionRevision: 4, connectionIdentityKey: 'cluster|tenant-a' },
			},
		});
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['marker'], rows: [['RESTORED']] });

		el.setConnections([{
			id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 5, connectionIdentityKey: 'cluster|tenant-b',
		}]);

		expect(getResultsState('test1')?.rows).toEqual([['RESTORED']]);
		expect(pState.queryResultJsonByBoxId.test1).toContain('RESTORED');
	});

	it('preserves committed output and artifact bindings while retiring target execution and Copilot state', () => {
		const el = createSection();
		el.displayResult({ columns: ['value'], rows: [['old-target']], metadata: {} });
		setResultsState('test1', { boxId: 'test1', columns: ['value'], rows: [['old-target']] });
		const resultTable = el.querySelector('kw-data-table');
		const savedResult = getResultsState('test1');
		const savedArtifact = getCurrentResultArtifact('test1')!;
		const consumerId = comparisonSourceArtifactConsumerId('test1');
		bindResultArtifactConsumer(consumerId, 'test1', savedArtifact.artifactId);
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['value'], rows: [['old-target']] });
		pState.resultArtifactByBoxId.test1 = {
			version: 1, artifactId: 'result:test1:1', sourceBoxId: 'test1', revision: 1, createdAt: 1,
		};
		optimizationMetadataByBoxId.test1 = { sourceBoxId: 'query_source', isComparison: true };
		const banner = document.createElement('div');
		banner.className = 'comparison-summary-banner';
		el.appendChild(banner);
		const copilotOwner = {
			boxId: 'test1', copilotRequestId: 'completed-request', sectionInstanceId: 'instance-test1', targetGeneration: 2,
		};
		(el.copilotChatCtrl as any).kustoConversationOwner = copilotOwner;
		const retiredOutputs: any[] = [];
		const onRetired = (event: Event) => retiredOutputs.push((event as CustomEvent).detail);
		window.addEventListener(APPLIED_KUSTO_COPILOT_DONE_EVENT, onRetired);

		try { el.clearTargetBoundState(); }
		finally { window.removeEventListener(APPLIED_KUSTO_COPILOT_DONE_EVENT, onRetired); }

		expect(getResultsState('test1')).toBe(savedResult);
		expect(getCurrentResultArtifact('test1')).toBe(savedArtifact);
		expect(getBoundResultArtifact(consumerId, 'test1')).toBe(savedArtifact);
		expect(pState.queryResultJsonByBoxId.test1).toContain('old-target');
		expect(pState.resultArtifactByBoxId.test1?.artifactId).toBe('result:test1:1');
		expect(el.querySelector('kw-data-table')).toBe(resultTable);
		expect(el.querySelector('.comparison-summary-banner')).toBe(banner);
		expect(postMessageToHost).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'clearComparisonSummary' }),
		);
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'cancelCopilotWriteQuery', boxId: 'test1', flavor: 'kusto', ...copilotOwner });
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'clearCopilotConversation', flavor: 'kusto', ...copilotOwner });
		expect(retiredOutputs).toContainEqual({
			type: 'copilotWriteQueryDone', ...copilotOwner, ok: false, message: 'Canceled.', retired: true,
		});
	});

	it('preserves ordinary results while retiring execution before advancing to another database', () => {
		const el = createSection();
		el.setConnectionId('connection-1');
		el.setDatabase('DbA');
		el.setSchemaLifecycleTarget('connection-1', 'DbA');
		el.displayResult({ columns: ['marker'], rows: [['DB_A']], metadata: {} });
		setResultsState('test1', { boxId: 'test1', columns: ['marker'], rows: [['DB_A']] });
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['marker'], rows: [['DB_A']] });
		el.beginQueryExecution('execution-db-a');
		const oldExecution = el.getActiveExecution()!;

		const next = el.setSchemaLifecycleTarget('connection-1', 'DbB');

		expect(next?.targetGeneration).toBeGreaterThan(oldExecution.targetGeneration);
		expect(el.getActiveExecution()).toBeUndefined();
		expect(el.acceptsQueryTerminal(oldExecution.executionId)).toBe(false);
		expect(getResultsState('test1')?.rows).toEqual([['DB_A']]);
		expect(pState.queryResultJsonByBoxId.test1).toContain('DB_A');
		expect(postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelQuery', boxId: 'test1', executionId: oldExecution.executionId,
			sectionInstanceId: oldExecution.sectionInstanceId,
			targetGeneration: oldExecution.targetGeneration,
		});
	});

	it('keeps restored rows when completing a pending database on the same connection', () => {
		const el = createSection();
		el.id = el.boxId;
		el.setConnections([{
			id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 4, connectionIdentityKey: 'cluster|',
		}]);
		el.setConnectionId('connection-1');
		const connectionOnly = el.setSchemaLifecycleTarget('connection-1');
		displayResultForBox({ columns: ['marker'], rows: [['RESTORED']], metadata: {} }, 'test1', {
			artifactPublication: {
				producer: {
					engine: 'kusto', boxId: 'test1', executionId: 'restored-execution',
					connectionId: 'connection-1', database: 'DbA',
				},
				policy: { connectionRevision: 4, connectionIdentityKey: 'cluster|' },
			},
		});
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['marker'], rows: [['RESTORED']] });

		const completed = el.setSchemaLifecycleTarget('connection-1', 'DbA');

		expect(completed?.targetGeneration).toBeGreaterThan(connectionOnly!.targetGeneration);
		expect(getResultsState('test1')?.rows).toEqual([['RESTORED']]);
		expect(pState.queryResultJsonByBoxId.test1).toContain('RESTORED');
		expect(el.querySelector('kw-data-table')).not.toBeNull();
	});

	it('preserves restored rows when a pending target completes with another database', () => {
		const el = createSection();
		el.id = el.boxId;
		el.setConnections([{
			id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 4, connectionIdentityKey: 'cluster|',
		}]);
		el.setConnectionId('connection-1');
		el.setSchemaLifecycleTarget('connection-1');
		displayResultForBox({ columns: ['marker'], rows: [['RESTORED']], metadata: {} }, 'test1', {
			artifactPublication: {
				producer: {
					engine: 'kusto', boxId: 'test1', executionId: 'restored-execution',
					connectionId: 'connection-1', database: 'DbA',
				},
				policy: { connectionRevision: 4, connectionIdentityKey: 'cluster|' },
			},
		});
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['marker'], rows: [['RESTORED']] });

		el.setSchemaLifecycleTarget('connection-1', 'OtherDb');

		expect(getResultsState('test1')?.rows).toEqual([['RESTORED']]);
		expect(pState.queryResultJsonByBoxId.test1).toContain('RESTORED');
	});

	it('preserves restored rows when pending database completion uses another physical owner', () => {
		const el = createSection();
		el.id = el.boxId;
		el.setConnections([{
			id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 4, connectionIdentityKey: 'cluster|tenant-a',
		}]);
		el.setConnectionId('connection-1');
		el.setSchemaLifecycleTarget('connection-1');
		displayResultForBox({ columns: ['marker'], rows: [['RESTORED']], metadata: {} }, 'test1', {
			artifactPublication: {
				producer: {
					engine: 'kusto', boxId: 'test1', executionId: 'restored-execution',
					connectionId: 'connection-1', database: 'DbA',
				},
				policy: { connectionRevision: 4, connectionIdentityKey: 'cluster|tenant-a' },
			},
		});
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['marker'], rows: [['RESTORED']] });
		el.setConnections([{
			id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 5, connectionIdentityKey: 'cluster|tenant-b',
		}]);

		expect(getResultsState('test1')?.rows).toEqual([['RESTORED']]);
		expect(pState.queryResultJsonByBoxId.test1).toContain('RESTORED');
	});

	it('preserves restored rows when a complete target changes physical owner', () => {
		const el = createSection();
		el.id = el.boxId;
		el.setConnections([{
			id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 4, connectionIdentityKey: 'cluster|tenant-a',
		}]);
		el.setConnectionId('connection-1');
		el.setSchemaLifecycleTarget('connection-1', 'DbA');
		displayResultForBox({ columns: ['marker'], rows: [['RESTORED']], metadata: {} }, 'test1', {
			artifactPublication: {
				producer: {
					engine: 'kusto', boxId: 'test1', executionId: 'restored-execution',
					connectionId: 'connection-1', database: 'DbA',
				},
				policy: { connectionRevision: 4, connectionIdentityKey: 'cluster|tenant-a' },
			},
		});
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['marker'], rows: [['RESTORED']] });

		el.setConnections([{
			id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net',
			connectionRevision: 5, connectionIdentityKey: 'cluster|tenant-b',
		}]);

		expect(getResultsState('test1')?.rows).toEqual([['RESTORED']]);
		expect(pState.queryResultJsonByBoxId.test1).toContain('RESTORED');
	});

	it('keeps a canceled Copilot owner admissible until its exact done terminal', () => {
		const el = createSection();
		const owner = {
			boxId: 'test1', copilotRequestId: 'cancel-request',
			sectionInstanceId: el.getSchemaLifecycleIdentity()!.sectionInstanceId,
			targetGeneration: el.getSchemaLifecycleIdentity()!.targetGeneration,
		};
		(el.copilotChatCtrl as any).activeKustoRequest = owner;
		(el.copilotChatCtrl as any).kustoConversationOwner = owner;

		expect(el.cancelKustoCopilotRequest(owner)).toBe(true);
		expect(el.getActiveKustoCopilotRequest()).toEqual(owner);
		expect(el.admitKustoCopilotMessage(owner, 'copilotExecutedQuery')).toBe(false);
		expect(el.admitKustoCopilotMessage(owner, 'copilotWriteQueryDone')).toBe(true);
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'cancelCopilotWriteQuery', flavor: 'kusto', ...owner });

		expect(el.completeKustoCopilotRequest(owner)).toBe(true);
		expect(el.getActiveKustoCopilotRequest()).toBeUndefined();
		expect(el.admitKustoCopilotConversationOwner(owner)).toBe(true);
	});

	it('emits an internal canceled terminal before host-driven Copilot owner retirement', () => {
		const el = createSection();
		const lifecycle = el.getSchemaLifecycleIdentity()!;
		const owner = { boxId: 'test1', copilotRequestId: 'host-invalidated', ...lifecycle };
		(el.copilotChatCtrl as any).activeKustoRequest = owner;
		(el.copilotChatCtrl as any).kustoConversationOwner = owner;
		const outputs: any[] = [];
		const listener = (event: Event) => outputs.push((event as CustomEvent).detail);
		window.addEventListener(APPLIED_KUSTO_COPILOT_DONE_EVENT, listener);

		try { expect(el.retireKustoCopilotConversationOwner(owner)).toBe(true); }
		finally { window.removeEventListener(APPLIED_KUSTO_COPILOT_DONE_EVENT, listener); }

		expect(outputs).toEqual([{
			type: 'copilotWriteQueryDone', ...owner, ok: false, message: 'Canceled.', retired: true,
		}]);
		expect(el.getActiveKustoCopilotRequest()).toBeUndefined();
	});

	it('opens embedded Copilot Chat and submits Optimize as an ordinary user request', async () => {
		const el = createSection();
		el.id = 'test1';
		el.setConnections([{ id: 'connection-1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setDatabases(['Samples'], 'Samples');
		el.setSchemaLifecycleTarget('connection-1', 'Samples');
		await el.updateComplete;
		queryEditors.test1 = { getValue: () => 'print value=1' } as any;
		const optimizeButton = document.getElementById('test1_optimize_btn') as HTMLButtonElement;
		optimizeButton.disabled = false;
		vi.mocked(postMessageToHost).mockClear();

		optimizeButton.click();

		expect(el.getCopilotChatVisible()).toBe(true);
		expect(el.getCopilotChatEl()!.getMessages()).toContainEqual(expect.objectContaining({
			kind: 'user', text: 'optimize the performance of this query',
		}));
		expect(postMessageToHost).toHaveBeenCalledWith(expect.objectContaining({
			type: 'startCopilotWriteQuery', flavor: 'kusto',
			request: 'optimize the performance of this query',
			currentQuery: 'print value=1', requireToolUse: undefined,
		}));
		expect(document.getElementById('test1_optimize_config')).toBeNull();
		expect(document.getElementById('test1_optimize_cancel')).toBeNull();
	});

	it('renders icon-first Compare and Optimize actions with accessible expanding labels', () => {
		createSection();
		const compareButton = document.getElementById('test1_compare_btn') as HTMLButtonElement;
		const optimizeButton = document.getElementById('test1_optimize_btn') as HTMLButtonElement;

		expect(compareButton.textContent?.trim()).toBe('Compare');
		expect(compareButton.querySelector('svg.compare-icon')).not.toBeNull();
		expect(compareButton.querySelector('.optimize-query-label')?.getAttribute('aria-hidden')).toBe('true');
		expect(compareButton.getAttribute('aria-label')).toBe('Compare queries');
		expect(optimizeButton.textContent?.trim()).toBe('Optimize');
		expect(optimizeButton.querySelector('svg.optimize-timer-icon')).not.toBeNull();
		expect(optimizeButton.querySelector('.optimize-query-label')?.getAttribute('aria-hidden')).toBe('true');
		expect(optimizeButton.getAttribute('aria-label')).toBe('Optimize query with GitHub Copilot');
	});

	it('clears the selected database when the same connection ID is repointed to another cluster', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('connection-changed', event => connectionEvents.push(event as CustomEvent));
		el.setConnections([{ id: 'c1', clusterUrl: 'https://old.kusto.windows.net', accountPartition: 'partition-a' }]);
		el.setDatabases(['Samples'], 'Samples');
		connectionEvents.length = 0;

		el.setConnections([{ id: 'c1', clusterUrl: 'https://new.kusto.windows.net', accountPartition: 'partition-a' }]);
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('c1');
		expect((el as any)._database).toBe('');
		expect(el.getDesiredDatabase()).toBe('Samples');
		expect(el.getClusterUrl()).toBe('https://new.kusto.windows.net');
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({ connectionId: 'c1', database: 'Samples' });
	});

	it('emits explicit selection intent when the user confirms the already selected target', () => {
		const el = createSection();
		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net' }]);
		el.setDatabases(['Samples'], 'Samples');
		const intents: CustomEvent[] = [];
		const targetChanges: CustomEvent[] = [];
		el.addEventListener('target-selection-intent', event => intents.push(event as CustomEvent));
		el.addEventListener('connection-changed', event => targetChanges.push(event as CustomEvent));
		el.addEventListener('database-changed', event => targetChanges.push(event as CustomEvent));

		(el as any)._onClusterSelected(new CustomEvent('selected', { detail: { id: 'c1' } }));
		(el as any)._onDatabaseSelected(new CustomEvent('selected', { detail: { id: 'Samples' } }));

		expect(intents.map(event => event.detail)).toEqual([
			{ boxId: 'test1', kind: 'connection', connectionId: 'c1', source: 'user' },
			{ boxId: 'test1', kind: 'database', database: 'Samples', source: 'user' },
		]);
		expect(targetChanges).toEqual([]);
	});

	it('preserves restored cluster intent until the saved cluster is auto-added', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setDesiredClusterUrl('https://saved.kusto.windows.net');
		el.setDesiredDatabase('SavedDb');
		el.setConnections([
			{ id: 'existing', clusterUrl: 'https://existing.kusto.windows.net' },
		], { lastConnectionId: 'existing' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('');
		expect(el.getClusterUrl()).toBe('https://saved.kusto.windows.net');
		expect(connectionEvents).toHaveLength(0);

		el.setConnections([
			{ id: 'existing', clusterUrl: 'https://existing.kusto.windows.net' },
			{ id: 'saved', clusterUrl: 'https://saved.kusto.windows.net' },
		], { lastConnectionId: 'existing' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('saved');
		expect(el.getClusterUrl()).toBe('https://saved.kusto.windows.net');
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({
			boxId: 'test1',
			connectionId: 'saved',
			clusterUrl: 'https://saved.kusto.windows.net',
			database: 'SavedDb',
		});
	});

	it('does not resolve restored cluster intent by short-name collision', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setDesiredClusterUrl('https://foo.region-a.kusto.windows.net');
		el.setDesiredDatabase('SavedDb');
		el.setConnections([
			{ id: 'wrong', clusterUrl: 'https://foo.region-b.kusto.windows.net' },
		], { lastConnectionId: 'wrong' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('');
		expect(el.getClusterUrl()).toBe('https://foo.region-a.kusto.windows.net');
		expect(connectionEvents).toHaveLength(0);

		el.setConnections([
			{ id: 'wrong', clusterUrl: 'https://foo.region-b.kusto.windows.net' },
			{ id: 'saved', clusterUrl: 'https://foo.region-a.kusto.windows.net' },
		], { lastConnectionId: 'wrong' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('saved');
		expect(el.getClusterUrl()).toBe('https://foo.region-a.kusto.windows.net');
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({
			boxId: 'test1',
			connectionId: 'saved',
			clusterUrl: 'https://foo.region-a.kusto.windows.net',
			database: 'SavedDb',
		});
	});
});
