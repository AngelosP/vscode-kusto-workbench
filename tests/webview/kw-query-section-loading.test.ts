import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/sections/kw-query-section.js';
import type { KwQuerySection } from '../../src/webview/sections/kw-query-section.js';
import type { KwDropdown } from '../../src/webview/components/kw-dropdown.js';
import {
	beginKustoPreparation,
	databaseRequestTokenByBoxId,
	disposeKustoPreparation,
	getKustoPreparationState,
	isSchemaWorkerApplyRequired,
	lastSchemaRequestAtByBoxId,
	optimizationMetadataByBoxId,
	pendingSchemaWorkerUpdateByBoxId,
	schemaEnhancementReadyByBoxId,
	schemaByBoxId,
	schemaFetchInFlightByBoxId,
	schemaMetaByBoxId,
	markSchemaEnhancementPending,
	markSchemaWorkerApplyFailed,
	markSchemaWorkerReady,
	schemaWorkerReadyByBoxId,
	updateKustoPreparation,
} from '../../src/webview/core/state.js';
import { invalidateLinkedComparisonSchemaForSource } from '../../src/webview/sections/query-connection.controller.js';
import { schemaRequestTokenByBoxId } from '../../src/webview/core/section-factory.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import { getResultsState, setResultsState } from '../../src/webview/core/results-state.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	disposeKustoPreparation('test1');
	delete databaseRequestTokenByBoxId.test1;
	delete optimizationMetadataByBoxId.test1;
	delete schemaByBoxId.comparison_1;
	delete schemaMetaByBoxId.comparison_1;
	delete pendingSchemaWorkerUpdateByBoxId.comparison_1;
	delete schemaFetchInFlightByBoxId.comparison_1;
	delete lastSchemaRequestAtByBoxId.comparison_1;
	delete schemaRequestTokenByBoxId.comparison_1;
	delete databaseRequestTokenByBoxId.comparison_1;
	delete schemaWorkerReadyByBoxId.comparison_1;
	delete schemaEnhancementReadyByBoxId.comparison_1;
	delete pState.queryResultJsonByBoxId.test1;
	disposeKustoPreparation('comparison_1');
});

function createSection(boxId = 'test1'): KwQuerySection {
	render(html`<kw-query-section box-id=${boxId}></kw-query-section>`, container);
	return container.querySelector('kw-query-section')! as KwQuerySection;
}

function getRefreshButton(el: KwQuerySection): HTMLButtonElement | null {
	return el.shadowRoot!.querySelector('.refresh-btn-wrap button') as HTMLButtonElement | null;
}

function getDatabaseDropdown(el: KwQuerySection): KwDropdown | null {
	return el.shadowRoot!.querySelector('.select-wrapper.half-width:nth-child(2) kw-dropdown') as KwDropdown | null;
}

function hasSpinner(el: KwQuerySection): boolean {
	return el.shadowRoot!.querySelector('.query-spinner') !== null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-query-section loading states', () => {
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

		expect(schemaEnhancementReadyByBoxId.test1?.status).toBe('pending');
		expect(el.dataset.testPreparationState).toBe('ready');
		expect(el.dataset.testPreparationBlockers).toBe('');
		expect(el.getAttribute('aria-busy')).toBe('false');
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
		optimizationMetadataByBoxId.test1 = { comparisonBoxId: 'comparison_1' };
		schemaByBoxId.comparison_1 = { rawSchemaJson: { Databases: { OldDb: {} } } };
		schemaMetaByBoxId.comparison_1 = { schemaSignature: 'old' };
		pendingSchemaWorkerUpdateByBoxId.comparison_1 = {
			rawSchemaJson: {}, clusterUrl: 'https://old.kusto.windows.net', database: 'OldDb', schemaKey: 'old|olddb',
		};
		schemaFetchInFlightByBoxId.comparison_1 = true;
		lastSchemaRequestAtByBoxId.comparison_1 = 123;
		schemaRequestTokenByBoxId.comparison_1 = 'schema_old';
		databaseRequestTokenByBoxId.comparison_1 = 'databases_old';
		schemaWorkerReadyByBoxId.comparison_1 = { status: 'ready', schemaKey: 'old|olddb', updatedAt: Date.now() };
		schemaEnhancementReadyByBoxId.comparison_1 = { status: 'ready', schemaKey: 'old|olddb', modelUri: 'model-old', updatedAt: Date.now() };
		beginKustoPreparation('comparison_1', { stage: 'ready', blockers: [], target: { schemaKey: 'old|olddb' } });

		invalidateLinkedComparisonSchemaForSource('test1');

		expect(schemaByBoxId.comparison_1).toBeUndefined();
		expect(schemaMetaByBoxId.comparison_1).toBeUndefined();
		expect(pendingSchemaWorkerUpdateByBoxId.comparison_1).toBeUndefined();
		expect(schemaFetchInFlightByBoxId.comparison_1).toBe(false);
		expect(lastSchemaRequestAtByBoxId.comparison_1).toBe(0);
		expect(schemaRequestTokenByBoxId.comparison_1).toBeUndefined();
		expect(databaseRequestTokenByBoxId.comparison_1).toBeUndefined();
		expect(schemaWorkerReadyByBoxId.comparison_1).toBeUndefined();
		expect(schemaEnhancementReadyByBoxId.comparison_1).toBeUndefined();
		expect(getKustoPreparationState('comparison_1').status).toBe('idle');
		expect(isSchemaWorkerApplyRequired('comparison_1')).toBe(true);
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

	it('clears the selected database and reloads when the same connection ID changes account partition', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-a' }]);
		el.setDatabases(['AccountADb'], 'AccountADb');
		el.displayResult({ columns: ['value'], rows: [['account-a']], metadata: {} });
		setResultsState('test1', { boxId: 'test1', columns: ['value'], rows: [['account-a']] });
		pState.queryResultJsonByBoxId.test1 = JSON.stringify({ columns: ['value'], rows: [['account-a']] });
		connectionEvents.length = 0;
		expect(el.getDatabase()).toBe('AccountADb');

		el.setConnections([{ id: 'c1', clusterUrl: 'https://cluster.kusto.windows.net', accountPartition: 'partition-b' }]);
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('c1');
		expect((el as any)._database).toBe('');
		expect(el.getDatabase()).toBe('AccountADb');
		expect(el.getDesiredDatabase()).toBe('AccountADb');
		expect((el as any)._testHasResults).toBe(false);
		expect(getResultsState('test1')).toBeNull();
		expect(pState.queryResultJsonByBoxId.test1).toBeUndefined();
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({ connectionId: 'c1', database: 'AccountADb' });

		el.setDatabases(['AccountADb', 'OtherDb']);
		expect(el.getDatabase()).toBe('AccountADb');
		expect(el.getDesiredDatabase()).toBe('');
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
