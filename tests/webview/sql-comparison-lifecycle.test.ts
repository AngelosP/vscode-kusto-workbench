import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/webview/sections/kw-sql-section.js';
import {
	__kustoWithPinnedSectionRemovalBypass,
	addSqlBox,
	removeSqlBox,
	sqlBoxes,
} from '../../src/webview/core/section-factory.js';
import { optimizationMetadataByBoxId } from '../../src/webview/core/state.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	bindResultArtifactConsumer,
	clearResultsState,
	getBoundResultArtifact,
	setResultsState,
} from '../../src/webview/core/results-state.js';
import { comparisonSourceArtifactConsumerId } from '../../src/shared/resultArtifact.js';

describe('SQL comparison lifecycle', () => {
	beforeEach(() => {
		document.body.innerHTML = '<div id="queries-container"></div>';
		pState.firstSectionPinned = false;
		sqlBoxes.splice(0, sqlBoxes.length);
		for (const boxId of Object.keys(optimizationMetadataByBoxId)) delete optimizationMetadataByBoxId[boxId];
	});

	afterEach(() => {
		document.body.innerHTML = '';
		pState.firstSectionPinned = false;
		sqlBoxes.splice(0, sqlBoxes.length);
		for (const boxId of Object.keys(optimizationMetadataByBoxId)) delete optimizationMetadataByBoxId[boxId];
	});

	it('preserves comparison ownership when the comparison target is adopted', async () => {
		const comparisonId = addSqlBox({
			id: 'sql_comparison', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2',
		});
		const comparison = document.getElementById(comparisonId) as HTMLElement & {
			serialize: () => Record<string, unknown>;
			updateComplete?: Promise<unknown>;
		};
		await comparison.updateComplete;

		comparison.dispatchEvent(new CustomEvent('sql-target-owner-changed', {
			detail: { boxId: comparisonId }, bubbles: true, composed: true,
		}));

		expect(optimizationMetadataByBoxId.sql_source).toEqual({ comparisonBoxId: comparisonId });
		expect(optimizationMetadataByBoxId[comparisonId]).toEqual({
			sourceBoxId: 'sql_source', isComparison: true,
		});
		expect(comparison.serialize()).toMatchObject({
			id: comparisonId, type: 'sql', comparisonSourceBoxId: 'sql_source',
		});
	});

	it('preserves lineage during real initial target adoption and detaches on later retarget', async () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const comparisonId = addSqlBox({
				id: 'sql_comparison', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2',
			});
			const comparison = document.getElementById(comparisonId) as any;
			comparison.setConnections([{
				id: 'sql-a', name: 'SQL A', dialect: 'mssql', serverUrl: 'sql-a.example', authType: 'aad',
			}], { lastConnectionId: 'sql-a' });
			comparison.setDatabases(['Db']);

			expect(optimizationMetadataByBoxId.sql_source).toEqual({ comparisonBoxId: comparisonId });
			expect(optimizationMetadataByBoxId[comparisonId]).toEqual({
				sourceBoxId: 'sql_source', isComparison: true,
			});
			expect(comparison.serialize()).toMatchObject({ comparisonSourceBoxId: 'sql_source' });
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sqlComparisonRemoved' }));

			comparison.setDatabase('OtherDb');

			expect(optimizationMetadataByBoxId.sql_source).toBeUndefined();
			expect(optimizationMetadataByBoxId[comparisonId]).toBeUndefined();
			expect(comparison.serialize()).not.toHaveProperty('comparisonSourceBoxId');
			expect(postMessage).toHaveBeenCalledWith({
				type: 'sqlComparisonRemoved', boxId: comparisonId, sourceBoxId: 'sql_source',
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('preserves lineage through initial dropdown completion and detaches on later dropdown retarget', async () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const comparisonId = addSqlBox({
				id: 'sql_comparison', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2',
			});
			const comparison = document.getElementById(comparisonId) as any;
			comparison.setConnections([
				{ id: 'sql-a', name: 'SQL A', dialect: 'mssql', serverUrl: 'sql-a.example', authType: 'aad' },
				{ id: 'sql-b', name: 'SQL B', dialect: 'mssql', serverUrl: 'sql-b.example', authType: 'aad' },
			]);
			await comparison.updateComplete;
			const serverDropdown = comparison.shadowRoot?.querySelector('.select-wrapper[title="SQL Server"] kw-dropdown');
			serverDropdown?.dispatchEvent(new CustomEvent('dropdown-select', {
				detail: { id: 'sql-a' }, bubbles: true, composed: true,
			}));
			comparison.setDatabases(['Db', 'OtherDb']);
			await comparison.updateComplete;
			const databaseDropdown = comparison.shadowRoot?.querySelector('.select-wrapper[title="SQL Database"] kw-dropdown');
			databaseDropdown?.dispatchEvent(new CustomEvent('dropdown-select', {
				detail: { id: 'Db' }, bubbles: true, composed: true,
			}));

			expect(comparison.getConnectionId()).toBe('sql-a');
			expect(comparison.getDatabase()).toBe('Db');
			expect(comparison.serialize()).toMatchObject({ comparisonSourceBoxId: 'sql_source' });
			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'sqlComparisonRemoved' }));

			databaseDropdown?.dispatchEvent(new CustomEvent('dropdown-select', {
				detail: { id: 'OtherDb' }, bubbles: true, composed: true,
			}));

			expect(comparison.getDatabase()).toBe('OtherDb');
			expect(comparison.serialize()).not.toHaveProperty('comparisonSourceBoxId');
			expect(postMessage).toHaveBeenCalledWith({
				type: 'sqlComparisonRemoved', boxId: comparisonId, sourceBoxId: 'sql_source',
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('detaches comparison ownership when an established comparison target changes', async () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const comparisonId = addSqlBox({
				id: 'sql_comparison', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2',
			});
			const comparison = document.getElementById(comparisonId) as HTMLElement & {
				serialize: () => Record<string, unknown>;
			};
			comparison.setAttribute('data-sql-comparison-admission-request-id', 'pending-retarget');

			comparison.dispatchEvent(new CustomEvent('sql-target-owner-changed', {
				detail: { boxId: comparisonId, hadCompleteTarget: true }, bubbles: true, composed: true,
			}));

			expect(document.getElementById(comparisonId)).toBe(comparison);
			expect(optimizationMetadataByBoxId.sql_source).toBeUndefined();
			expect(optimizationMetadataByBoxId[comparisonId]).toBeUndefined();
			expect(comparison.hasAttribute('data-sql-comparison-admission-request-id')).toBe(false);
			expect(comparison.serialize()).not.toHaveProperty('comparisonSourceBoxId');
			expect(postMessage).toHaveBeenCalledWith({
				type: 'sqlComparisonRemoved', boxId: comparisonId, sourceBoxId: 'sql_source',
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('does not remove the pinned first SQL section through the UI cleanup path', () => {
		const primaryId = addSqlBox({ id: 'sql_primary' });
		addSqlBox({ id: 'sql_secondary' });
		pState.firstSectionPinned = true;

		removeSqlBox(primaryId);

		expect(document.getElementById(primaryId)).not.toBeNull();
		expect(sqlBoxes).toContain(primaryId);

		__kustoWithPinnedSectionRemovalBypass(() => removeSqlBox(primaryId));

		expect(document.getElementById(primaryId)).toBeNull();
		expect(sqlBoxes).not.toContain(primaryId);
	});

	it('rejects a duplicate SQL section identity before mutating lifecycle state', () => {
		addSqlBox({ id: 'sql_duplicate', query: 'SELECT 1' });
		const original = document.getElementById('sql_duplicate');

		expect(() => addSqlBox({
			id: 'sql_duplicate', comparisonSourceBoxId: 'sql_source', query: 'SELECT 2',
		})).toThrow('already in use');
		expect(document.getElementById('sql_duplicate')).toBe(original);
		expect(sqlBoxes.filter(id => id === 'sql_duplicate')).toHaveLength(1);
		expect(optimizationMetadataByBoxId.sql_duplicate).toBeUndefined();
	});

	it('freezes reused comparison serialization until admission finalizes', () => {
		const comparisonId = addSqlBox({
			id: 'sql_comparison', comparisonSourceBoxId: 'sql_source', query: 'SELECT old',
		});
		const comparison = document.getElementById(comparisonId) as any;
		const admitted = comparison.serialize();
		comparison.setComparisonPersistenceSnapshot(admitted);
		comparison.setQuery('SELECT proposed');

		expect(comparison.getQuery()).toBe('SELECT proposed');
		expect(comparison.serialize().query).toBe('SELECT old');

		comparison.setComparisonPersistenceSnapshot(undefined);
		expect(comparison.serialize().query).toBe('SELECT proposed');
	});

	it('fully retires an absent-DOM SQL comparison owner and source binding', () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const sourceArtifact = setResultsState('sql_source', {
				boxId: 'sql_source', columns: [{ name: 'Value' }], rows: [[1]], metadata: {},
			}, {
				producer: { engine: 'sql', boxId: 'sql_source', executionId: 'source-1' },
				policy: {
					exposeToActiveContent: true, sendToModel: true, shareToClipboard: true, exportToCsv: true,
				},
			});
			expect(sourceArtifact).toBeDefined();
			bindResultArtifactConsumer(
				comparisonSourceArtifactConsumerId('sql_stale'), 'sql_source', sourceArtifact!.artifactId,
			);
			optimizationMetadataByBoxId.sql_source = { comparisonBoxId: 'sql_stale' };
			optimizationMetadataByBoxId.sql_stale = { sourceBoxId: 'sql_source', isComparison: true };
			sqlBoxes.push('sql_stale');
			pState.queryResultJsonByBoxId.sql_stale = '{"rows":[[1]]}';
			pState.resultArtifactByBoxId.sql_stale = {} as any;

			removeSqlBox('sql_stale');

			expect(postMessage).toHaveBeenCalledWith({
				type: 'sqlComparisonRemoved', boxId: 'sql_stale', sourceBoxId: 'sql_source',
			});
			expect(optimizationMetadataByBoxId.sql_stale).toBeUndefined();
			expect(optimizationMetadataByBoxId.sql_source).toBeUndefined();
			expect(sqlBoxes).not.toContain('sql_stale');
			expect(pState.queryResultJsonByBoxId.sql_stale).toBeUndefined();
			expect(pState.resultArtifactByBoxId.sql_stale).toBeUndefined();
			expect(getBoundResultArtifact(
				comparisonSourceArtifactConsumerId('sql_stale'), 'sql_source',
			)).toBeNull();
		} finally {
			window.vscode = previousVsCode;
			clearResultsState('sql_source');
		}
	});

	it('routes source-driven absent-DOM comparison cleanup through SQL ownership', () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const sourceId = addSqlBox({ id: 'sql_source' });
			const comparisonId = addSqlBox({
				id: 'sql_comparison', comparisonSourceBoxId: sourceId, query: 'SELECT 2',
			});
			document.getElementById(comparisonId)?.remove();

			removeSqlBox(sourceId);

			expect(sqlBoxes).not.toContain(sourceId);
			expect(sqlBoxes).not.toContain(comparisonId);
			expect(optimizationMetadataByBoxId[sourceId]).toBeUndefined();
			expect(optimizationMetadataByBoxId[comparisonId]).toBeUndefined();
			expect(postMessage).toHaveBeenCalledWith({
				type: 'sqlComparisonRemoved', boxId: comparisonId, sourceBoxId: sourceId,
			});
	} finally {
			window.vscode = previousVsCode;
		}
	});
});