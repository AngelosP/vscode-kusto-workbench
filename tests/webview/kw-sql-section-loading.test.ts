import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/sections/kw-sql-section.js';
import type { KwSqlSection } from '../../src/webview/sections/kw-sql-section.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	bindResultArtifactConsumer,
	displayResultForBox,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	getResultsState,
	setResultsState,
	unbindResultArtifactConsumer,
} from '../../src/webview/core/results-state.js';
import { __kustoOnQueryResult } from '../../src/webview/core/persistence.js';
import { setRunMode } from '../../src/webview/sections/kw-query-toolbar.js';
import { setConnections, setSqlConnections } from '../../src/webview/core/state.js';
import { getKustoCopilotInsertOwner, getSqlCopilotInsertOwner } from '../../src/webview/sections/copilot-chat-manager.controller.js';
import { sqlConnectionTargetSignature } from '../../src/shared/sqlConnectionIdentity.js';
import {
	clearSqlSectionSessionsForTest,
	routeSqlSectionMessage,
} from '../../src/webview/core/sql-section-message-router.js';

let container: HTMLDivElement;

beforeEach(() => {
	clearSqlSectionSessionsForTest();
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	clearSqlSectionSessionsForTest();
	delete pState.queryResultJsonByBoxId.sql_test1;
	setSqlConnections([]);
	setConnections([]);
	render(nothing, container);
	container.remove();
});

function createSection(boxId = 'sql_test1'): KwSqlSection {
	render(html`<kw-sql-section box-id=${boxId}></kw-sql-section>`, container);
	return container.querySelector('kw-sql-section')! as KwSqlSection;
}

describe('kw-sql-section loading states', () => {
	it('correlates CSV save events to the exact admitted result artifact', async () => {
		const el = createSection();
		el.id = el.boxId;
		await el.updateComplete;
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			expect(displayResultForBox(
				{ columns: ['Value'], rows: [['a']], metadata: {} },
				el.boxId,
				{
					label: 'Results',
					artifactPublication: {
						producer: { engine: 'sql', boxId: el.boxId, executionId: 'execution-a' },
						policy: { exportToCsv: true },
					},
				},
			)).toBe(true);
			const artifactA = getCurrentResultArtifact(el.boxId)!;
			const tableA = document.querySelector('kw-data-table')!;
			expect((tableA as any).options.showSave).toBe(true);
			tableA.dispatchEvent(new CustomEvent('save', {
				detail: { csv: 'Value\na', suggestedFileName: 'Results.csv' },
			}));
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'requestArtifactCsvSave', boxId: el.boxId, artifactId: artifactA.artifactId,
				suggestedFileName: 'Results.csv',
			}));
			expect(displayResultForBox(
				{ columns: ['Value'], rows: [['b']], metadata: {} },
				el.boxId,
				{
					label: 'Results',
					artifactPublication: {
						producer: { engine: 'sql', boxId: el.boxId, executionId: 'execution-b' },
						policy: { exportToCsv: true },
					},
				},
			)).toBe(true);
			postMessage.mockClear();
			tableA.dispatchEvent(new CustomEvent('save', {
				detail: { csv: 'Value\na', suggestedFileName: 'Results.csv' },
			}));
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'requestArtifactCsvSave' }));
			expect(postMessage).toHaveBeenCalledWith({
				type: 'showInfo', message: 'Results are not permitted for CSV export.',
			});

			postMessage.mockClear();
			expect(displayResultForBox(
				{ columns: ['Secret'], rows: [['denied']], metadata: {} },
				el.boxId,
				{
					label: 'Results',
					artifactPublication: {
						producer: { engine: 'sql', boxId: el.boxId, executionId: 'execution-denied' },
						policy: { exportToCsv: false },
					},
				},
			)).toBe(true);
			const tableDenied = document.querySelector('kw-data-table')!;
			expect((tableDenied as any).options.showSave).toBe(false);
			tableDenied.dispatchEvent(new CustomEvent('save', {
				detail: { csv: 'Secret\ndenied', suggestedFileName: 'Results.csv' },
			}));
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'requestArtifactCsvSave' }));
			expect(postMessage).toHaveBeenCalledWith({
				type: 'showInfo', message: 'Results are not permitted for CSV export.',
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('does not let detached same-ID cleanup hide Save on the replacement SQL table', async () => {
		const oldSection = document.createElement('kw-sql-section') as KwSqlSection;
		oldSection.boxId = 'sql_test1';
		oldSection.id = 'sql_test1';
		container.appendChild(oldSection);
		expect(displayResultForBox(
			{ columns: ['Value'], rows: [['old']], metadata: {} }, 'sql_test1', {
				artifactPublication: {
					producer: { engine: 'sql', boxId: 'sql_test1', executionId: 'old' },
					policy: { exportToCsv: true },
				},
			},
		)).toBe(true);
		oldSection.remove();

		const replacement = document.createElement('kw-sql-section') as KwSqlSection;
		replacement.boxId = 'sql_test1';
		replacement.id = 'sql_test1';
		container.appendChild(replacement);
		expect(displayResultForBox(
			{ columns: ['Value'], rows: [['new']], metadata: {} }, 'sql_test1', {
				artifactPublication: {
					producer: { engine: 'sql', boxId: 'sql_test1', executionId: 'new' },
					policy: { exportToCsv: true },
				},
			},
		)).toBe(true);
		await Promise.resolve();
		await replacement.updateComplete;

		const table = replacement.querySelector('kw-data-table') as any;
		expect(table?.rows).toEqual([['new']]);
		expect(table?.options.showSave).toBe(true);
		expect(table?.resultArtifactId).toBe(getCurrentResultArtifact('sql_test1')?.artifactId);
	});

	it('copies the exact SQL connection owner when Copilot inserts a section', () => {
		const reporting = {
			id: 'sql-reporting', name: 'Reporting', dialect: 'mssql', serverUrl: 'shared.example', port: 1444,
			database: 'Warehouse', authType: 'sql-login', username: 'ReportUser',
		};
		setSqlConnections([
			{ ...reporting, id: 'sql-admin', port: 1433, username: 'AdminUser' },
			reporting,
		]);

		expect(getSqlCopilotInsertOwner('sql-reporting')).toEqual({
			connectionIdHint: 'sql-reporting',
			targetSignature: sqlConnectionTargetSignature(reporting),
		});
	});

	it('copies the exact authority-aware Kusto connection owner when Copilot inserts a section', () => {
		setConnections([
			{ id: 'home', name: 'Home', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'common' },
			{ id: 'guest', name: 'Guest', clusterUrl: 'https://shared.kusto.windows.net', authorityId: 'organizations' },
		]);

		expect(getKustoCopilotInsertOwner('guest')).toEqual({
			connectionIdHint: 'guest', authorityId: 'organizations',
		});
	});

	it('marks target events to suppress metadata refresh during captured-owner tool execution', () => {
		const el = createSection();
		const connection = {
			id: 'sql-tool', name: 'Tool SQL', dialect: 'mssql', serverUrl: 'tool.example',
			database: 'Db', authType: 'sql-login', username: 'ToolUser',
		};
		const expectedOwner = {
			connectionId: connection.id,
			database: 'Db',
			targetSignature: JSON.stringify({
				dialect: 'mssql', serverUrl: 'tool.example', port: '', database: 'Db',
				authType: 'sql-login', username: 'ToolUser',
			}),
			principalFingerprint: 'principal-tool',
			revocationGeneration: 0,
		};
		const connectionEvents: any[] = [];
		const databaseEvents: any[] = [];
		el.addEventListener('sql-connection-changed', event => connectionEvents.push((event as CustomEvent).detail));
		el.addEventListener('sql-database-changed', event => databaseEvents.push((event as CustomEvent).detail));

		el.configureToolTarget(connection, 'Db', expectedOwner);

		expect(connectionEvents).toContainEqual(expect.objectContaining({ suppressMetadataRefresh: true }));
		expect(databaseEvents).toContainEqual(expect.objectContaining({ suppressMetadataRefresh: true }));
	});

	it('does not emit target changes or discard the ready owner for same-target tool configuration', () => {
		const el = createSection();
		const connection = {
			id: 'sql-tool', name: 'Tool SQL', dialect: 'mssql', serverUrl: 'tool.example',
			database: 'Db', authType: 'sql-login', username: 'ToolUser',
		};
		const expectedOwner = {
			connectionId: connection.id, database: 'Db',
			targetSignature: sqlConnectionTargetSignature(connection),
			principalFingerprint: 'principal-tool', revocationGeneration: 0,
		};
		el.configureToolTarget(connection, 'Db', expectedOwner);
		el.setStsReady(true, 'owner-token');
		const connectionChanged = vi.fn();
		const databaseChanged = vi.fn();
		el.addEventListener('sql-connection-changed', connectionChanged);
		el.addEventListener('sql-database-changed', databaseChanged);

		el.configureToolTarget(connection, 'Db', expectedOwner);

		expect(connectionChanged).not.toHaveBeenCalled();
		expect(databaseChanged).not.toHaveBeenCalled();
		expect(el.getCopilotOwnerToken()).toBe('owner-token');
	});

	it('preserves a bound result artifact across a real SQL rerun and error', async () => {
		const el = createSection();
		const connection = {
			id: 'sql-rerun', name: 'Rerun SQL', dialect: 'mssql', serverUrl: 'rerun.example',
			database: 'Db', authType: 'sql-login', username: 'User',
		};
		el.configureToolTarget(connection, 'Db', {
			connectionId: connection.id, database: 'Db', targetSignature: sqlConnectionTargetSignature(connection),
			principalFingerprint: 'principal-rerun', revocationGeneration: 0,
		});
		el.setStsReady(true, 'owner-token');
		el.setQuery('SELECT 2 AS Value');
		await el.updateComplete;
		setResultsState(el.boxId, { columns: ['Value'], rows: [[1]], metadata: {} }, {
			producer: {
				engine: 'sql', boxId: el.boxId, executionId: 'execution-a', query: 'SELECT 1 AS Value',
				connectionId: connection.id, database: 'Db',
			},
			policy: { shareToClipboard: true },
		});
		const artifactA = getCurrentResultArtifact(el.boxId)!;
		pState.queryResultJsonByBoxId[el.boxId] = JSON.stringify({ columns: ['Value'], rows: [[1]], metadata: {} });
		expect(el.serialize().resultArtifact).toMatchObject({
			artifactId: artifactA.artifactId,
			producer: expect.objectContaining({
				query: 'SELECT 1 AS Value', connectionId: connection.id, database: 'Db',
			}),
			policy: expect.objectContaining({ shareToClipboard: true }),
		});
		bindResultArtifactConsumer('share:clipboard:result', el.boxId, artifactA.artifactId);

		expect((el as any)._runQuery()).toBe(true);
		expect(getCurrentResultArtifact(el.boxId)).toBeNull();
		expect(getBoundResultArtifact('share:clipboard:result', el.boxId)).toBe(artifactA);
		el.displayError('rerun failed', undefined, (el as any)._activeQueryExecutionId);
		expect(getBoundResultArtifact('share:clipboard:result', el.boxId)).toBe(artifactA);

		unbindResultArtifactConsumer('share:clipboard:result');
	});

	it('preserves a bound result artifact across an external Copilot rerun and cancellation', () => {
		const el = createSection();
		setResultsState(el.boxId, { columns: ['Value'], rows: [[1]], metadata: {} }, {
			producer: {
				engine: 'sql', boxId: el.boxId, executionId: 'execution-a', query: 'SELECT 1',
				connectionId: 'sql-a', database: 'Db',
			},
			policy: { shareToClipboard: true },
		});
		const artifactA = getCurrentResultArtifact(el.boxId)!;
		bindResultArtifactConsumer('share:clipboard:result', el.boxId, artifactA.artifactId);

		expect(el.setExternalQueryExecuting(true, 'copilot-b')).toBe(true);
		expect(getCurrentResultArtifact(el.boxId)).toBeNull();
		expect(getBoundResultArtifact('share:clipboard:result', el.boxId)).toBe(artifactA);
		expect(el.setExternalQueryExecuting(false, 'copilot-b')).toBe(true);
		expect(getBoundResultArtifact('share:clipboard:result', el.boxId)).toBe(artifactA);

		unbindResultArtifactConsumer('share:clipboard:result');
	});

	it('preserves restored server intent until a matching SQL connection is available', async () => {
		const el = createSection();
		const connectionEvents: CustomEvent[] = [];
		el.addEventListener('sql-connection-changed', event => connectionEvents.push(event as CustomEvent));

		el.setDesiredServerUrl('tcp:saved.database.windows.net,1433');
		el.setDesiredDatabase('SavedDb');
		el.setConnections([
			{ id: 'existing', name: 'Existing', serverUrl: 'tcp:existing.database.windows.net,1433', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'existing' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('');
		expect(el.getSqlConnectionId()).toBe('');
		expect(el.getServerUrl()).toBe('');
		expect(connectionEvents).toHaveLength(0);

		el.setConnections([
			{ id: 'existing', name: 'Existing', serverUrl: 'tcp:existing.database.windows.net,1433', dialect: 'mssql', authType: 'aad' },
			{ id: 'saved', name: 'Saved', serverUrl: 'tcp:saved.database.windows.net,1433', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'existing' });
		await el.updateComplete;

		expect(el.getConnectionId()).toBe('saved');
		expect(el.getSqlConnectionId()).toBe('saved');
		expect(el.getServerUrl()).toBe('tcp:saved.database.windows.net,1433');
		expect(connectionEvents).toHaveLength(1);
		expect(connectionEvents[0].detail).toMatchObject({
			boxId: 'sql_test1',
			connectionId: 'saved',
			serverUrl: 'tcp:saved.database.windows.net,1433',
			database: 'SavedDb',
		});
	});

	it('restores the exact owner when multiple connections share a server', async () => {
		const el = createSection();
		const target = {
			id: 'reporting', name: 'Reporting', serverUrl: 'shared.example', port: 1444,
			dialect: 'mssql', authType: 'sql-login', username: 'ReportUser', database: 'master',
		};
		el.setDesiredServerUrl('shared.example');
		el.setDesiredConnectionOwner('reporting', JSON.stringify({
			dialect: 'mssql', serverUrl: 'shared.example', port: 1444, database: 'master',
			authType: 'sql-login', username: 'ReportUser',
		}));

		el.setConnections([
			{ id: 'admin', name: 'Admin', serverUrl: 'shared.example', port: 1433, dialect: 'mssql', authType: 'sql-login', username: 'AdminUser', database: 'master' },
			target,
		]);

		expect(el.getConnectionId()).toBe('reporting');
		expect(el.serialize()).toMatchObject({
			connectionIdHint: 'reporting',
			targetSignature: sqlConnectionTargetSignature(target),
		});
	});

	it('rewrites an unresolved legacy owner as an opaque target signature', () => {
		const el = createSection();
		el.setDesiredConnectionOwner('missing-reporting', JSON.stringify({
			dialect: 'mssql', serverUrl: 'shared.example', port: 1444, database: 'master',
			authType: 'sql-login', username: 'ReportUser',
		}));

		const serialized = el.serialize();

		expect(serialized).toMatchObject({
			connectionIdHint: 'missing-reporting',
			targetSignature: expect.stringMatching(/^v2:[0-9a-f]{64}$/),
		});
		expect(JSON.stringify(serialized)).not.toContain('ReportUser');
	});

	it('adopts an exact cold persisted target without emitting a destructive owner change', () => {
		const el = createSection();
		const connection = {
			id: 'reporting', name: 'Reporting', serverUrl: 'shared.example', port: 1444,
			dialect: 'mssql', authType: 'sql-login', username: 'ReportUser', database: 'master',
		};
		const ownerChanges: CustomEvent[] = [];
		el.addEventListener('sql-target-owner-changed', event => ownerChanges.push(event as CustomEvent));
		el.setDesiredServerUrl(connection.serverUrl);
		el.setDesiredConnectionOwner(connection.id, sqlConnectionTargetSignature(connection));
		el.setDesiredDatabase('master');
		pState.queryResultJsonByBoxId.sql_test1 = '{"rows":[["persisted"]]}';

		el.setConnections([connection]);
		el.setDatabases(['master']);

		expect(el.getConnectionId()).toBe(connection.id);
		expect(el.getDatabase()).toBe('master');
		expect(ownerChanges).toHaveLength(0);
		expect(pState.queryResultJsonByBoxId.sql_test1).toBe('{"rows":[["persisted"]]}');
	});

	it('re-adopts a host-invalidated same-ID connection after its target changes', () => {
		const el = createSection();
		const original = {
			id: 'reporting', name: 'Reporting', serverUrl: 'old.example', dialect: 'mssql',
			authType: 'sql-login', username: 'ReportUser', database: 'Warehouse', credentialRevision: 1,
		};
		el.setDesiredConnectionOwner(original.id, sqlConnectionTargetSignature(original));
		el.setDesiredDatabase('Warehouse');
		el.setConnections([original]);
		el.setDatabases(['Warehouse']);
		const changes: CustomEvent[] = [];
		el.addEventListener('sql-connection-changed', event => changes.push(event as CustomEvent));

		el.invalidateOwner();
		const updated = { ...original, serverUrl: 'new.example', credentialRevision: 2 };
		el.setConnections([updated]);

		expect(el.getConnectionId()).toBe(updated.id);
		expect(changes.at(-1)?.detail).toMatchObject({
			connectionId: updated.id, preserveTargetGeneration: true,
		});
		expect(el.serialize().targetSignature).toBe(sqlConnectionTargetSignature(updated));
		expect(el.serialize().targetSignature).not.toContain('ReportUser');
	});

	it('retains the first database and retirement intent across repeated owner invalidation', () => {
		const el = createSection();
		const original = {
			id: 'reporting', name: 'Reporting', serverUrl: 'old.example', dialect: 'mssql',
			authType: 'sql-login', username: 'ReportUser', database: 'Warehouse', credentialRevision: 1,
		};
		el.setDesiredConnectionOwner(original.id, sqlConnectionTargetSignature(original));
		el.setDesiredDatabase('Warehouse');
		el.setConnections([original]);
		el.setDatabases(['Warehouse']);
		const connectionChanges: CustomEvent[] = [];
		el.addEventListener('sql-connection-changed', event => connectionChanges.push(event as CustomEvent));

		el.invalidateOwner(false);
		el.invalidateOwner(true);
		el.setConnections([original]);
		el.setDatabases(['Warehouse']);

		expect(connectionChanges.at(-1)?.detail).not.toHaveProperty('preserveTargetGeneration');
		expect(el.getDatabase()).toBe('Warehouse');
	});

	it.each(['favorite', 'manual', 'tool'] as const)(
		'keeps an explicit %s target after host owner invalidation',
		selection => {
			const el = createSection();
			const original = {
				id: 'original', name: 'Original', serverUrl: 'original.example', dialect: 'mssql',
				authType: 'sql-login', username: 'OriginalUser', database: 'OldDb',
			};
			const selected = {
				id: 'selected', name: 'Selected', serverUrl: 'selected.example', dialect: 'mssql',
				authType: 'sql-login', username: 'SelectedUser', database: 'NewDb',
			};
			el.setDesiredConnectionOwner(original.id, sqlConnectionTargetSignature(original));
			el.setDesiredDatabase('OldDb');
			el.setConnections([original, selected]);
			el.setDatabases(['OldDb']);
			el.invalidateOwner();

			if (selection === 'favorite') {
				el.setFavorites([{ name: 'Selected favorite', connectionId: selected.id, database: 'NewDb' }]);
				(el as any)._onFavoriteSelected(new CustomEvent('selected', { detail: { id: '0' } }));
				el.setDatabases(['NewDb']);
			} else if (selection === 'manual') {
				el.setSqlConnectionId(selected.id);
				el.setDatabase('NewDb');
			} else {
				el.configureToolTarget(selected, 'NewDb');
			}

			el.setConnections([original, selected]);

			expect(el.getSqlConnectionId()).toBe(selected.id);
			expect(el.getDatabase()).toBe('NewDb');
			expect(el.serialize()).toMatchObject({
				connectionIdHint: selected.id,
				targetSignature: sqlConnectionTargetSignature(selected),
			});
		},
	);

	it.each([
		['retired recreation', true, 8],
		['live owner rotation', false, 7],
	] as const)('uses the correct generation for %s re-adoption', (_label, retired, expectedGeneration) => {
		const el = createSection();
		const original = {
			id: 'reporting', name: 'Reporting', serverUrl: 'old.example', dialect: 'mssql',
			authType: 'sql-login', username: 'ReportUser', database: 'Warehouse', credentialRevision: 1,
		};
		el.setDesiredConnectionOwner(original.id, sqlConnectionTargetSignature(original));
		el.setDesiredDatabase('Warehouse');
		el.setConnections([original]);
		el.setDatabases(['Warehouse']);
		el.sqlSession.adoptHostGeneration(6);
		const outbound: Record<string, unknown>[] = [];
		el.sqlSession.configureLifecycleEffects({
			isRestoreInProgress: () => false,
			clearSchema: () => undefined,
			setSchemaStatus: () => undefined,
			setDatabases: (databases, desiredDatabase) => el.setDatabases(databases, desiredDatabase),
			setDatabasesLoading: loading => el.setDatabasesLoading(loading),
			setRefreshLoading: loading => el.setRefreshLoading(loading),
			getConnectionId: () => el.getSqlConnectionId(),
			getDatabase: () => el.getDatabase(),
			postMessage: message => outbound.push(message),
			persist: () => undefined,
		});
		el.addEventListener('sql-connection-changed', event => {
			el.sqlSession.handleConnectionChanged((event as CustomEvent).detail || {});
		});
		el.addEventListener('sql-database-changed', event => {
			el.sqlSession.handleDatabaseChanged((event as CustomEvent).detail || {});
		});
		const effects = {
			getSection: () => el,
			clearSchema: vi.fn(),
			setSchema: vi.fn(),
			updateDatabases: vi.fn(),
			reportDatabasesError: vi.fn(),
			handleStsResponse: vi.fn(),
			handleStsDiagnostics: vi.fn(),
			clearPolicyBox: vi.fn(),
		};

		expect(routeSqlSectionMessage({
			type: 'sqlConnectionOwnerChanged', boxId: 'sql_test1', sectionInstanceId: el.sqlSession.instanceId,
			connectionId: original.id, targetGeneration: 7, ...(retired ? { retired: true } : {}),
		}, effects)).toBe('handled');
		const recreated = retired ? original : { ...original, serverUrl: 'new.example', credentialRevision: 2 };
		el.setConnections([recreated]);
		el.setDatabases(['Warehouse']);

		expect(el.sqlSession.targetGeneration).toBe(expectedGeneration);
		expect(outbound).toContainEqual(expect.objectContaining({
			type: 'getSqlDatabases', sqlConnectionId: original.id, targetGeneration: expectedGeneration,
		}));
		expect(outbound).toContainEqual(expect.objectContaining({
			type: 'prefetchSqlSchema', sqlConnectionId: original.id, database: 'Warehouse',
			targetGeneration: expectedGeneration,
		}));
	});

	it('keeps an explicit dropdown owner selected while cold restore is still loading', () => {
		const el = createSection();
		const persisted = {
			id: 'persisted', name: 'Persisted', serverUrl: 'persisted.example', dialect: 'mssql',
			authType: 'sql-login', username: 'PersistedUser', database: 'PersistedDb',
		};
		const selected = {
			id: 'selected', name: 'Selected', serverUrl: 'selected.example', dialect: 'mssql',
			authType: 'sql-login', username: 'SelectedUser', database: 'SelectedDb',
		};
		el.setDesiredConnectionOwner(persisted.id, sqlConnectionTargetSignature(persisted));
		el.setDesiredDatabase('PersistedDb');
		el.setConnections([persisted, selected]);

		(el as any)._onServerSelected(new CustomEvent('selected', { detail: { id: selected.id } }));
		(el as any)._onDatabaseSelected(new CustomEvent('selected', { detail: { id: 'SelectedDb' } }));
		el.setConnections([persisted, selected]);

		expect(el.getConnectionId()).toBe(selected.id);
		expect(el.getDatabase()).toBe('SelectedDb');
		expect(el.serialize()).toMatchObject({
			connectionIdHint: selected.id,
			targetSignature: sqlConnectionTargetSignature(selected),
			database: 'SelectedDb',
		});
	});

	it('serializes the opaque principal fingerprint only with persisted SQL results', () => {
		const el = createSection();
		const connection = {
			id: 'sql-a', name: 'SQL', serverUrl: 'sql.example', dialect: 'mssql', authType: 'aad',
			principalFingerprint: 'principal-a',
		};
		el.setConnections([connection], { lastConnectionId: connection.id });
		expect(el.serialize()).not.toHaveProperty('principalFingerprint');

		pState.queryResultJsonByBoxId.sql_test1 = '{"rows":[[1]]}';

		expect(el.serialize()).toMatchObject({
			resultJson: '{"rows":[[1]]}',
			principalFingerprint: 'principal-a',
		});
	});

	it('applies the canonical cached databases for the resolved connection', () => {
		const el = createSection();
		const connection = {
			id: 'sql-a', name: 'SQL', serverUrl: 'sql.example', dialect: 'mssql', authType: 'aad',
		};

		el.setConnections([connection], {
			lastConnectionId: connection.id,
			lastDatabase: 'Warehouse',
			cachedDatabases: {
				'sql-a': ['master', 'Warehouse'],
				'sql-b': ['Other'],
			},
		});

		expect(el.getConnectionId()).toBe('sql-a');
		expect(el.getDatabase()).toBe('Warehouse');
		expect((el as any)._databases).toEqual(['master', 'Warehouse']);
		expect((el as any)._databasesLoading).toBe(false);
	});

	it('does not retarget a restored database that is omitted from a stale cache', async () => {
		const el = createSection();
		const connection = {
			id: 'sql-a', name: 'SQL', serverUrl: 'sql.example', dialect: 'mssql', authType: 'aad',
		};
		el.setDesiredConnectionOwner(connection.id, sqlConnectionTargetSignature(connection));
		el.setDesiredDatabase('Warehouse');
		el.setConnections([connection]);
		el.setDatabases(['Warehouse']);
		const refreshes: CustomEvent[] = [];
		const databaseChanges: CustomEvent[] = [];
		el.addEventListener('sql-refresh-databases', event => refreshes.push(event as CustomEvent));
		el.addEventListener('sql-database-changed', event => databaseChanges.push(event as CustomEvent));

		el.setConnections([connection], {
			lastConnectionId: connection.id,
			lastDatabase: 'master',
			cachedDatabases: { 'sql-a': ['master'] },
		});
		await Promise.resolve();

		expect(el.getDatabase()).toBe('Warehouse');
		expect((el as any)._databases).toEqual(['master']);
		expect(refreshes).toHaveLength(1);
		expect(refreshes[0].detail).toMatchObject({ connectionId: connection.id });

		el.setDatabases(['master'], 'master');

		expect(el.getDatabase()).toBe('');
		expect(databaseChanges.at(-1)?.detail).toMatchObject({ database: '' });
	});

	it('retires a desired database that is absent from the first live list', () => {
		const el = createSection();
		const connection = {
			id: 'sql-a', name: 'SQL', serverUrl: 'sql.example', dialect: 'mssql', authType: 'aad',
		};
		el.setDesiredConnectionOwner(connection.id, sqlConnectionTargetSignature(connection));
		el.setDesiredDatabase('MissingDb');
		el.setConnections([connection]);
		const databaseChanges: CustomEvent[] = [];
		el.addEventListener('sql-database-changed', event => databaseChanges.push(event as CustomEvent));

		el.setDatabases(['master']);

		expect(el.getDatabase()).toBe('');
		expect(databaseChanges).toHaveLength(1);
		expect(databaseChanges[0].detail).toMatchObject({ boxId: 'sql_test1', database: '' });
	});

	it.each([
		{ persistedPort: '', currentPort: 1433 },
		{ persistedPort: 1433, currentPort: undefined },
	])('restores a revision-zero legacy owner across equivalent default-port metadata', ({ persistedPort, currentPort }) => {
		const el = createSection();
		el.setDesiredServerUrl('shared.example');
		el.setDesiredConnectionOwner('reporting', JSON.stringify({
			dialect: 'mssql', serverUrl: 'shared.example', port: persistedPort, database: 'master',
			authType: 'sql-login', username: 'ReportUser',
		}));

		el.setConnections([{
			id: 'reporting', name: 'Reporting', serverUrl: 'shared.example',
			...(currentPort ? { port: currentPort } : {}),
			dialect: 'mssql', authType: 'sql-login', username: 'ReportUser', database: 'master',
		}]);

		expect(el.getConnectionId()).toBe('reporting');
	});

	it('does not restore a legacy owner after its credentials rotate', () => {
		const el = createSection();
		el.setDesiredServerUrl('shared.example');
		el.setDesiredConnectionOwner('reporting', JSON.stringify({
			dialect: 'mssql', serverUrl: 'shared.example', port: 1444, database: 'master',
			authType: 'sql-login', username: 'ReportUser',
		}));

		el.setConnections([{
			id: 'reporting', name: 'Reporting', serverUrl: 'shared.example', port: 1444,
			dialect: 'mssql', authType: 'sql-login', username: 'ReportUser', database: 'master', credentialRevision: 1,
		}]);

		expect(el.getConnectionId()).toBe('');
	});

	it('does not bind ambiguous legacy server-only state', async () => {
		const el = createSection();
		el.setDesiredServerUrl('shared.example');

		el.setConnections([
			{ id: 'first', name: 'First', serverUrl: 'shared.example', port: 1433, dialect: 'mssql', authType: 'aad' },
			{ id: 'second', name: 'Second', serverUrl: 'shared.example', port: 1444, dialect: 'mssql', authType: 'aad' },
		]);

		expect(el.getConnectionId()).toBe('');
		expect(el.getSqlConnectionId()).toBe('');
	});

	it('clears live and persisted results when the selected connection becomes Leave No Trace', async () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sensitive', name: 'Sensitive', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sensitive' });
		el.setDatabase('Db');
		pState.queryResultJsonByBoxId.sql_test1 = '{"rows":[["secret"]]}';
		setResultsState('sql_test1', { boxId: 'sql_test1', columns: ['Value'], rows: [['secret']], metadata: {} });

		expect(el.serialize().resultJson).toContain('secret');
		expect(getResultsState('sql_test1')).not.toBeNull();

		el.setLeaveNoTraceConnectionIds(['sensitive']);

		expect(pState.queryResultJsonByBoxId.sql_test1).toBeUndefined();
		expect(getResultsState('sql_test1')).toBeNull();
		expect(el.serialize()).not.toHaveProperty('resultJson');
		expect(el.getConnectionId()).toBe('sensitive');
		expect(el.getDatabase()).toBe('Db');
		expect(el.serialize()).toMatchObject({ connectionIdHint: 'sensitive', database: 'Db' });

		__kustoOnQueryResult('sql_test1', { columns: ['Value'], rows: [['late-secret']], metadata: {} });
		expect(pState.queryResultJsonByBoxId.sql_test1).toBeUndefined();
		el.setExecutionOwner('protected-owner');
		expect((document.getElementById('sql_test1_sql_run_btn') as HTMLButtonElement).disabled).toBe(false);
		expect(el.displayResult({ columns: [{ name: 'Value', type: 'string' }], rows: [['visible-secret']], metadata: {} })).toBe(true);
		expect((el as any)._hasResults).toBe(true);
		expect(el.serialize()).not.toHaveProperty('resultJson');
		expect(el.dataset.testHasError).toBe('false');

		el.setLeaveNoTraceConnectionIds([]);
		expect(el.dataset.testHasError).toBe('false');
	});

	it('clears shared and persisted rows when an accepted SQL run fails', () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		pState.queryResultJsonByBoxId.sql_test1 = '{"rows":[["stale"]]}';
		setResultsState('sql_test1', { boxId: 'sql_test1', columns: ['Value'], rows: [['stale']], metadata: {} });

		el.displayError('Query failed.', undefined, 'execution-1');

		expect(pState.queryResultJsonByBoxId.sql_test1).toBeUndefined();
		expect(getResultsState('sql_test1')).toBeNull();
		expect(el.getConnectionId()).toBe('sql-a');
		expect(el.getDatabase()).toBe('Db');
		expect(el.dataset.testHasError).toBe('true');
	});

	it('clears schema readiness when the selected connection becomes Leave No Trace', async () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sensitive', name: 'Sensitive', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sensitive' });
		el.setSchemaInfo({ status: 'cached', statusText: 'Cached', tables: 3, cols: 8, cached: true });
		el.setStsReady(true);
		expect(el.dataset.testSchemaReady).toBe('true');
		expect(el.dataset.testStsReady).toBe('true');

		el.setLeaveNoTraceConnectionIds(['sensitive']);
		el.clearSchemaForLeaveNoTrace();

		expect(el.dataset.testSchemaStatus).toBe('not-loaded');
		expect(el.dataset.testSchemaReady).toBe('false');
		expect(el.dataset.testStsReady).toBe('false');
	});

	it('clears private database options and selection when the principal owner changes', async () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sql-a' });
		el.setDatabases(['SecretDb', 'OtherDb'], 'sql-a');
		el.setDatabase('SecretDb');
		expect(el.dataset.testHasDatabases).toBe('true');

		el.invalidateOwner();

		expect(el.getConnectionId()).toBe('');
		expect(el.getDatabase()).toBe('');
		expect(el.dataset.testHasDatabases).toBe('false');
		expect(el.serialize()).not.toHaveProperty('database');
	});

	it('preserves an active owner when the first canonical AAD fingerprint is published', () => {
		const el = createSection();
		const connection = {
			id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad',
		};
		el.setConnections([connection], { lastConnectionId: connection.id });
		el.setDatabase('Db');
		el.setQuery('SELECT 1 AS Value');
		el.setStsReady(true, 'owner-token');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			expect((el as any)._runQuery()).toBe(true);
			const executionId = postMessage.mock.calls[0][0].executionId;
			postMessage.mockClear();

			el.setConnections([{ ...connection, principalFingerprint: 'principal-a' }]);

			expect(el.getDatabase()).toBe('Db');
			expect(el.getCopilotOwnerToken()).toBe('owner-token');
			expect(el.acceptsQueryTerminal(executionId)).toBe(true);
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cancelSqlQuery' }));
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it.each(['principal', 'revocation'] as const)('clears retained rows before adopting a new %s owner snapshot', change => {
		const el = createSection();
		const original = {
			id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad',
			principalFingerprint: 'principal-a', revocationGeneration: 0,
		};
		el.setConnections([original], { lastConnectionId: original.id });
		pState.queryResultJsonByBoxId.sql_test1 = '{"rows":[["owner-a"]]}';
		const ownerChanges: CustomEvent[] = [];
		el.addEventListener('sql-target-owner-changed', event => ownerChanges.push(event as CustomEvent));
		const connectionChanges: CustomEvent[] = [];
		el.addEventListener('sql-connection-changed', event => connectionChanges.push(event as CustomEvent));
		el.invalidateOwner();

		el.setConnections([{
			...original,
			...(change === 'principal' ? { principalFingerprint: 'principal-b' } : { revocationGeneration: 1 }),
		}]);

		expect(pState.queryResultJsonByBoxId.sql_test1).toBeUndefined();
		expect(el.serialize()).not.toHaveProperty('resultJson');
		expect(el.serialize()).not.toHaveProperty('principalFingerprint');
		expect(ownerChanges.length).toBeGreaterThanOrEqual(1);
		expect(connectionChanges.at(-1)?.detail).toMatchObject({ preserveTargetGeneration: true });
	});

	it('clears results and Copilot context when the database target changes', async () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sql-a' });
		el.setDatabase('DbA');
		pState.queryResultJsonByBoxId.sql_test1 = '{"rows":[["secret-a"]]}';
		setResultsState('sql_test1', { boxId: 'sql_test1', columns: ['Value'], rows: [['secret-a']], metadata: {} });
		const cancel = vi.spyOn(el, 'copilotWriteQueryCancel');
		const clearConversation = vi.spyOn(el, 'copilotClearConversation');
		const ownerChanges: CustomEvent[] = [];
		el.addEventListener('sql-target-owner-changed', event => ownerChanges.push(event as CustomEvent));

		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		(el as any)._executing = true;
		el.setDatabase('DbB');

		expect(pState.queryResultJsonByBoxId.sql_test1).toBeUndefined();
		expect(getResultsState('sql_test1')).toBeNull();
		expect(el.serialize()).not.toHaveProperty('resultJson');
		expect(cancel).toHaveBeenCalled();
		expect(clearConversation).toHaveBeenCalled();
		expect(ownerChanges).toHaveLength(1);
		expect(ownerChanges[0].detail).toEqual({ boxId: 'sql_test1' });
		expect(postMessage).toHaveBeenCalledWith({
			type: 'cancelSqlQuery', boxId: 'sql_test1', sectionInstanceId: el.sqlSession.instanceId,
		});
		window.vscode = previousVsCode;
	});

	it('runs a tool query through the real execution path and waits for terminal results', async () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('SELECT 1 AS Value');
		const expectedOwner = {
			connectionId: 'sql-a', database: 'Db', targetSignature: 'target-a',
			principalFingerprint: 'principal-a', revocationGeneration: 0,
		};
		el.setToolExpectedOwner(expectedOwner);
		setRunMode('sql_test1', 'plain');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;

		try {
			const run = el.runForTool('tool-execution-1');
			let settled = false;
			void run.finally(() => { settled = true; }).catch(() => undefined);
			await Promise.resolve();
			el.setStsReady(true, 'owner-token');
			await Promise.resolve();

			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'executeSqlQuery', boxId: 'sql_test1', sqlConnectionId: 'sql-a', database: 'Db', queryMode: 'plain', ownerToken: 'owner-token',
				executionId: 'tool-execution-1',
				toolExecution: true,
				expectedOwner,
			}));
			expect(settled).toBe(false);

			el.displayResult({ columns: [], rows: [[1], [2]], metadata: {} }, { executionId: 'tool-execution-1' });
			await expect(run).resolves.toEqual({
				rowCount: 2,
				executionId: 'tool-execution-1',
				owner: { connectionId: 'sql-a', database: 'Db', ownerToken: 'owner-token', generation: 0 },
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('emits a manual SQL run ID without claiming tool ownership', () => {
		const el = createSection();
		el.setConnections([
			{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' },
		], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		const exactQuery = '  SELECT 1 AS Value\n\n';
		el.setQuery(exactQuery);
		el.setStsReady(true, 'owner-token');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			expect((el as any)._runQuery()).toBe(true);
			const payload = postMessage.mock.calls[0][0];
			expect(payload).toMatchObject({
				type: 'executeSqlQuery', boxId: 'sql_test1', sqlConnectionId: 'sql-a', database: 'Db', ownerToken: 'owner-token',
			});
			expect(payload.query).toBe(exactQuery);
			expect(payload.executionId).toMatch(/^sql-run-/);
			expect(payload.toolExecution).toBeUndefined();
			expect(payload.expectedOwner).toBeUndefined();
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('does not settle a pending tool run from an unrelated same-owner result', async () => {
		const el = createSection();
		el.setConnections([{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' }], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('SELECT tool_query');
		el.setStsReady(true, 'owner-token');
		const previousVsCode = window.vscode;
		window.vscode = { postMessage: vi.fn() } as any;
		try {
			const run = el.runForTool('tool-execution');
			let settled = false;
			void run.finally(() => { settled = true; }).catch(() => undefined);
			await Promise.resolve();

			el.displayResult({ columns: [], rows: [['other']], metadata: {} }, { executionId: 'copilot-execution' });
			el.cancelToolRun('older-tool-execution');
			await Promise.resolve();
			expect(settled).toBe(false);
			expect((window.vscode.postMessage as any)).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'cancelSqlQuery' }));

			el.displayResult({ columns: [], rows: [['tool']], metadata: {} }, { executionId: 'tool-execution' });
			await expect(run).resolves.toMatchObject({ rowCount: 1, executionId: 'tool-execution', owner: { ownerToken: 'owner-token' } });
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('keeps a newer SQL execution active when older Copilot cleanup arrives', () => {
		const el = createSection();
		(el as any)._activeQueryExecutionId = 'manual-b';
		(el as any)._executing = true;

		expect(el.setExternalQueryExecuting(false, 'copilot-c')).toBe(false);
		expect((el as any)._activeQueryExecutionId).toBe('manual-b');
		expect((el as any)._executing).toBe(true);
	});

	it('preserves owner and active execution across a synchronous DOM reorder', async () => {
		const el = createSection();
		el.setStsReady(true, 'owner-token');
		expect(el.setExternalQueryExecuting(true, 'execution-a')).toBe(true);
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			container.removeChild(el);
			container.appendChild(el);
			await Promise.resolve();

			expect(el.getCopilotOwnerToken()).toBe('owner-token');
			expect(el.acceptsQueryTerminal('execution-a')).toBe(true);
			expect((el as any)._executing).toBe(true);
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'stsDidClose' }));
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('rejects an older SQL terminal after a newer execution has completed', () => {
		const el = createSection();
		expect(el.setExternalQueryExecuting(true, 'execution-a')).toBe(true);
		expect(el.acceptsQueryTerminal('execution-a')).toBe(true);
		el.displayResult({ columns: [], rows: [['a']], metadata: {} }, { executionId: 'execution-a' });

		expect(el.setExternalQueryExecuting(true, 'execution-b')).toBe(true);
		expect(el.acceptsQueryTerminal('execution-b')).toBe(true);
		el.displayResult({ columns: [], rows: [['b']], metadata: {} }, { executionId: 'execution-b' });

		expect(el.acceptsQueryTerminal('execution-a')).toBe(false);
		expect(el.acceptsQueryTerminal('execution-b')).toBe(false);
		expect(el.acceptsQueryTerminal()).toBe(false);
	});

	it('rejects a pending tool query when the user cancels it', async () => {
		const el = createSection();
		el.setConnections([{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' }], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('WAITFOR DELAY');
		el.setStsReady(true, 'owner-token');

		const run = el.runForTool('tool-cancel');
		el.cancelToolRun();

		await expect(run).rejects.toThrow('cancelled');
	});

	it('rejects a pending tool query when Leave No Trace becomes enabled', async () => {
		const el = createSection();
		el.setConnections([{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' }], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('WAITFOR DELAY');
		el.setStsReady(true, 'owner-token');

		const run = el.runForTool('tool-lnt');
		el.setLeaveNoTraceConnectionIds(['sql-a']);

		await expect(run).rejects.toThrow('Leave No Trace');
	});

	it('rejects a pending tool query when STS connection readiness fails', async () => {
		const el = createSection();
		el.setConnections([{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' }], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('SELECT 1');

		const run = el.runForTool('tool-error');
		el.notifyStsConnectionError('Login failed');

		await expect(run).rejects.toThrow('Login failed');
	});

	it('reconnects after an STS error and bounds readiness even when query timeout is disabled', async () => {
		vi.useFakeTimers();
		const el = createSection();
		el.setConnections([{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' }], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('SELECT 1');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		(el as any)._openStsDocumentIfNeeded = vi.fn(() => true);

		try {
			el.notifyStsConnectionError('Initial failure');
			const run = el.runForTool('tool-timeout');
			const completion = expect(run).rejects.toThrow('did not become ready');
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'stsConnect', boxId: 'sql_test1' }));
			await vi.advanceTimersByTimeAsync(30_000);
			await completion;
		} finally {
			window.vscode = previousVsCode;
			vi.useRealTimers();
		}
	});

	it('cancels the exact active transport and clears UI when the terminal watchdog expires', async () => {
		vi.useFakeTimers();
		const el = createSection();
		el.setConnections([{ id: 'sql-a', name: 'SQL', serverUrl: 'sql.example.test', dialect: 'mssql', authType: 'aad' }], { lastConnectionId: 'sql-a' });
		el.setDatabase('Db');
		el.setQuery('WAITFOR DELAY');
		el.setStsReady(true, 'owner-token');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const run = el.sqlSession.beginToolRun('tool-timeout', 25, 50);
			(el as any)._startPendingToolRunIfReady();
			const completion = expect(run).rejects.toThrow('terminal response');
			await vi.advanceTimersByTimeAsync(50);
			await completion;

			expect(postMessage).toHaveBeenCalledWith({
				type: 'cancelSqlQuery', boxId: 'sql_test1', sectionInstanceId: el.sqlSession.instanceId,
				executionId: 'tool-timeout',
			});
			expect(el.acceptsQueryTerminal('tool-timeout')).toBe(false);
			expect((el as any)._executing).toBe(false);
		} finally {
			window.vscode = previousVsCode;
			vi.useRealTimers();
		}
	});

	it('releases staged tool ownership when execution fails before admission', async () => {
		const el = createSection();
		el.setToolExpectedOwner({
			connectionId: 'sql-a', database: 'Db', targetSignature: 'target-a',
			principalFingerprint: 'principal-a', revocationGeneration: 0,
		});

		await expect(el.runForTool('tool-preflight')).rejects.toThrow('Select a SQL connection');
		expect(el.sqlSession.toolExpectedOwner).toBeUndefined();
	});
});