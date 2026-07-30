import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	tryStoreQueryResult: vi.fn(),
	setResultsVisible: vi.fn(),
	setQueryExecuting: vi.fn(),
	notifyResultsUpdated: vi.fn(),
}));

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: {
		resultsVisibleByBoxId: {},
		lastExecutedBox: '',
	}
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	__kustoTryStoreQueryResult: mocks.tryStoreQueryResult,
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	__kustoSetResultsVisible: mocks.setResultsVisible,
	setQueryExecuting: mocks.setQueryExecuting,
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoNotifyResultsUpdated: mocks.notifyResultsUpdated,
}));

import {
	displayResultForBox,
	getRawCellValue,
	getResultsState,
	getResultsStateRevision,
	getCurrentResultArtifact,
	getResultArtifact,
	bindResultArtifactConsumer,
	getBoundResultArtifact,
	rebindResultArtifactConsumer,
	retireResultsStateForRerun,
	unbindResultArtifactConsumer,
	clearResultsState,
	setResultsState,
	resetCurrentResult,
	currentResult,
	ensureResultsShownForTool,
} from '../../src/webview/core/results-state.js';
import {
	htmlDashboardFactArtifactConsumerId,
	RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT,
} from '../../src/shared/resultArtifact.js';

describe('results-state displayResultForBox', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		resetCurrentResult();
		vi.clearAllMocks();
	});

	it('renders and updates shared result state without owning persistence', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
			setResultArtifactForCsvExport: ReturnType<typeof vi.fn>;
		};
		section.id = 'query_1';
		section.displayResult = vi.fn();
		section.setResultArtifactForCsvExport = vi.fn();
		document.body.appendChild(section);

		const result = {
			columns: [
				{ name: 'Name', type: 'string' },
				{ name: 'Value', type: 'long' },
			],
			rows: [
				['alpha', 1],
				['beta', 2],
			],
			metadata: { executionTime: '00:00:00.123' },
		};

		displayResultForBox(result, 'query_1', { label: 'Results', showExecutionTime: true });

		expect(section.displayResult).toHaveBeenCalledWith(result, { label: 'Results', showExecutionTime: true });
		expect(section.setResultArtifactForCsvExport).toHaveBeenCalledWith(
			expect.stringMatching(/^result:query_1:/),
		);
		expect(mocks.notifyResultsUpdated).toHaveBeenCalledWith('query_1');
		expect(mocks.tryStoreQueryResult).not.toHaveBeenCalled();

		const state = getResultsState('query_1') as any;
		expect(state).toMatchObject({
			boxId: 'query_1',
			columns: result.columns,
			rows: result.rows,
			metadata: result.metadata,
			displayRowIndices: [0, 1],
			rowIndexToDisplayIndex: [0, 1],
		});
		expect(state.selectedRows).toBeInstanceOf(Set);
		expect(getResultsStateRevision('query_1')).toBeGreaterThan(0);
	});

	it('normalizes ragged rows before section presentation and shared state', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
		};
		section.id = 'query_ragged';
		section.displayResult = vi.fn();
		document.body.appendChild(section);

		displayResultForBox({
			columns: ['A', 'B'], rows: [[1, 2, 'hidden'], [3]], metadata: {},
		}, section.id, { label: 'Results' });

		expect(section.displayResult).toHaveBeenCalledWith(expect.objectContaining({
			rows: [[1, 2], [3, undefined]],
		}), { label: 'Results' });
		expect(getResultsState(section.id)?.rows).toEqual([[1, 2], [3, undefined]]);
	});

	it('does not admit a late result when the owning section rejects it', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
		};
		section.id = 'sql_protected';
		section.displayResult = vi.fn(() => false);
		document.body.appendChild(section);

		const accepted = displayResultForBox(
			{ columns: [{ name: 'Secret' }], rows: [['late-secret']], metadata: {} },
			'sql_protected',
			{ label: 'Results' },
		);

		expect(accepted).toBe(false);
		expect(getResultsState('sql_protected')).toBeNull();
		expect(currentResult).toBeNull();
	});

	it('fails closed when immutable artifact publication is exhausted', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
			clearResults: ReturnType<typeof vi.fn>;
		};
		section.id = 'query_exhausted';
		section.displayResult = vi.fn();
		section.clearResults = vi.fn();
		document.body.appendChild(section);
		// Seed an exhausted revision through the public store restore path.
		setResultsState(section.id, { columns: ['Value'], rows: [['old']], metadata: {} }, {
			persistedIdentity: {
				artifactId: `result:${section.id}:${Number.MAX_SAFE_INTEGER - 1}`,
				sourceBoxId: section.id, revision: Number.MAX_SAFE_INTEGER - 1, createdAt: 1,
			},
		});
		setResultsState(section.id, { columns: ['Value'], rows: [['ceiling']], metadata: {} });
		mocks.notifyResultsUpdated.mockClear();

		const accepted = displayResultForBox(
			{ columns: ['Value'], rows: [['must-not-render']], metadata: {} },
			section.id, { label: 'Results' },
		);

		expect(accepted).toBe(false);
		expect(section.clearResults).toHaveBeenCalled();
		expect(getResultsState(section.id)).toBeNull();
		expect(getCurrentResultArtifact(section.id)).toBeNull();
		expect(mocks.notifyResultsUpdated).toHaveBeenCalledTimes(1);
		expect(mocks.notifyResultsUpdated).toHaveBeenCalledWith(section.id);
	});

	it('clears rendered rows when artifact snapshotting throws', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
			clearResults: ReturnType<typeof vi.fn>;
		};
		section.id = 'query_snapshot_failure';
		section.displayResult = vi.fn();
		section.clearResults = vi.fn();
		document.body.appendChild(section);
		const hostileCell = new Proxy({}, {
			ownKeys: () => { throw new Error('snapshot failed'); },
		});

		const accepted = displayResultForBox(
			{ columns: ['Value'], rows: [[hostileCell]], metadata: {} },
			section.id, { label: 'Results' },
		);

		expect(accepted).toBe(false);
		expect(section.displayResult).toHaveBeenCalled();
		expect(section.clearResults).toHaveBeenCalled();
		expect(getResultsState(section.id)).toBeNull();
		expect(getCurrentResultArtifact(section.id)).toBeNull();
	});

	it('snapshots result data and exact publication metadata immutably', () => {
		const section = document.createElement('div') as HTMLDivElement & {
			displayResult: ReturnType<typeof vi.fn>;
		};
		section.id = 'query_provenance';
		section.displayResult = vi.fn();
		document.body.appendChild(section);
		const result = {
			columns: [{ name: 'Value', type: 'long' }],
			rows: [[1]],
			metadata: { executionTime: '00:00:00.001' },
		};
		const dispatch = {
			dispatchAttempt: 1,
			connectionRevision: 4,
			leaveNoTraceRevision: 7,
			connectionIdentityKey: 'cluster|authority',
			clusterEndpoint: 'https://cluster.kusto.windows.net',
			accountPartition: 'partition-a',
			authSessionGeneration: 3,
			clientActivityId: 'activity-1',
		};

		displayResultForBox(result, section.id, {
			label: 'Results',
			artifactPublication: {
				producer: {
					engine: 'kusto', boxId: section.id, executionId: 'execution-1',
					sectionInstanceId: 'instance-1', targetGeneration: 2, reservationSequence: 5,
					connectionId: 'connection-1', database: 'Samples', producer: 'manual', dispatch,
				},
				policy: {
					accountPartition: dispatch.accountPartition,
					authSessionGeneration: dispatch.authSessionGeneration,
					leaveNoTraceRevision: dispatch.leaveNoTraceRevision,
				},
			},
		});

		const artifact = getCurrentResultArtifact(section.id)!;
		result.rows[0][0] = 99;
		dispatch.accountPartition = 'partition-mutated';
		expect(artifact.rows).toEqual([[1]]);
		expect(artifact.producer).toEqual(expect.objectContaining({
			executionId: 'execution-1', reservationSequence: 5,
			dispatch: expect.objectContaining({ accountPartition: 'partition-a' }),
		}));
		expect(artifact.policy).toEqual(expect.objectContaining({
			accountPartition: 'partition-a', authSessionGeneration: 3, leaveNoTraceRevision: 7,
		}));
		expect(Object.isFrozen(artifact)).toBe(true);
		expect(Object.isFrozen(artifact.rows)).toBe(true);
		expect(Object.isFrozen(artifact.rows[0])).toBe(true);
	});

	it('does not recreate shared result state when the owning section no longer exists', () => {
		setResultsState('removed_sql_comparison', { columns: [], rows: [['old']] });

		const accepted = displayResultForBox(
			{ columns: [{ name: 'Secret' }], rows: [['late-secret']], metadata: {} },
			'removed_sql_comparison',
			{ label: 'Results' },
		);

		expect(accepted).toBe(false);
		expect(getResultsState('removed_sql_comparison')).toBeNull();
	});

	it('increments a revision whenever shared result state is replaced', () => {
		const id = 'query_revision_test';
		expect(getResultsStateRevision(id)).toBe(0);
		setResultsState(id, { columns: [], rows: [] });
		const firstRevision = getResultsStateRevision(id);
		setResultsState(id, { columns: [], rows: [['next']] });
		expect(getResultsStateRevision(id)).toBe(firstRevision + 1);
	});

	it('retires mutable/current state for rerun while preserving only bound artifacts', () => {
		const id = 'sql_rerun_artifact';
		setResultsState(id, { columns: ['Value'], rows: [['a']], metadata: {} }, {
			producer: { engine: 'sql', boxId: id, executionId: 'execution-a' },
		});
		const artifactA = getCurrentResultArtifact(id)!;
		bindResultArtifactConsumer('share:clipboard:result', id, artifactA.artifactId);

		retireResultsStateForRerun(id);

		expect(getResultsState(id)).toBeNull();
		expect(getCurrentResultArtifact(id)).toBeNull();
		expect(getBoundResultArtifact('share:clipboard:result', id)).toBe(artifactA);
		unbindResultArtifactConsumer('share:clipboard:result');
		expect(getBoundResultArtifact('share:clipboard:result', id)).toBeNull();
	});

	it('keeps a derived consumer on its immutable revision until explicit rebind', () => {
		const sourceBoxId = 'query_artifact_source';
		const consumerId = 'chart_artifact_consumer';
		setResultsState(sourceBoxId, {
			columns: [{ name: 'Value', type: 'long' }],
			rows: [[1]],
			metadata: { executionId: 'execution-a' },
		});
		const artifactA = getCurrentResultArtifact(sourceBoxId)!;
		expect(bindResultArtifactConsumer(consumerId, sourceBoxId)).toBe(artifactA.artifactId);

		setResultsState(sourceBoxId, {
			columns: [{ name: 'Value', type: 'long' }],
			rows: [[2]],
			metadata: { executionId: 'execution-b' },
		});
		const artifactB = getCurrentResultArtifact(sourceBoxId)!;

		expect(artifactB.artifactId).not.toBe(artifactA.artifactId);
		expect(getBoundResultArtifact(consumerId, sourceBoxId)).toBe(artifactA);
		expect(getResultArtifact(artifactA.artifactId)?.rows).toEqual([[1]]);
		expect(getResultArtifact(artifactB.artifactId)?.rows).toEqual([[2]]);

		expect(rebindResultArtifactConsumer(consumerId, sourceBoxId)).toBe(artifactB.artifactId);
		expect(getBoundResultArtifact(consumerId, sourceBoxId)).toBe(artifactB);
	});

	it('synchronously revokes bound revisions when the source is cleared', () => {
		const sourceBoxId = 'query_artifact_revoked';
		const consumerId = 'chart_artifact_revoked';
		setResultsState(sourceBoxId, { columns: [], rows: [['secret']] });
		const artifact = getCurrentResultArtifact(sourceBoxId)!;
		bindResultArtifactConsumer(consumerId, sourceBoxId);

		clearResultsState(sourceBoxId);

		expect(getCurrentResultArtifact(sourceBoxId)).toBeNull();
		expect(getBoundResultArtifact(consumerId, sourceBoxId)).toBeNull();
		expect(getResultArtifact(artifact.artifactId)).toBeNull();
	});

	it('synchronously reports revoked HTML bridge consumers before deferred refresh', () => {
		const sourceBoxId = 'query_html_revoked';
		const htmlBoxId = 'html_revoked';
		const consumerId = htmlDashboardFactArtifactConsumerId(htmlBoxId);
		setResultsState(sourceBoxId, { columns: [], rows: [['secret']] });
		bindResultArtifactConsumer(consumerId, sourceBoxId);
		const events: unknown[] = [];
		const listener = (event: Event) => events.push((event as CustomEvent).detail);
		window.addEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, listener);

		try {
			clearResultsState(sourceBoxId);
		} finally {
			window.removeEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, listener);
		}

		expect(events).toEqual([{ sourceBoxId, consumerIds: [consumerId] }]);
	});

	it('reports every HTML bridge consumer revoked from the same source', () => {
		const sourceBoxId = 'query_html_multi_revoke';
		const consumerIds = [
			htmlDashboardFactArtifactConsumerId('html_first'),
			htmlDashboardFactArtifactConsumerId('html_second'),
		];
		setResultsState(sourceBoxId, { columns: [], rows: [['secret']] });
		for (const consumerId of consumerIds) bindResultArtifactConsumer(consumerId, sourceBoxId);
		const events: any[] = [];
		const listener = (event: Event) => events.push((event as CustomEvent).detail);
		window.addEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, listener);

		try {
			clearResultsState(sourceBoxId);
		} finally {
			window.removeEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, listener);
		}

		expect(events).toHaveLength(1);
		expect(events[0].sourceBoxId).toBe(sourceBoxId);
		expect(new Set(events[0].consumerIds)).toEqual(new Set(consumerIds));
	});

	it('synchronously revokes transitive derived artifacts and their consumers', () => {
		const sourceBoxId = 'query_lineage_source';
		const derivedBoxId = 'transformation_lineage_output';
		const chartId = 'chart_lineage_consumer';
		setResultsState(sourceBoxId, { columns: ['Value'], rows: [[1]] });
		const sourceArtifact = getCurrentResultArtifact(sourceBoxId)!;
		setResultsState(derivedBoxId, { columns: ['Value'], rows: [[1]] }, {
			producer: { engine: 'transformation', boxId: derivedBoxId, producer: 'derive' },
			lineage: [{ sourceArtifactId: sourceArtifact.artifactId, role: 'primary' }],
		});
		const derivedArtifact = getCurrentResultArtifact(derivedBoxId)!;
		bindResultArtifactConsumer(chartId, derivedBoxId);
		setResultsState(sourceBoxId, { columns: ['Value'], rows: [[2]] });
		expect(getResultArtifact(sourceArtifact.artifactId)).toBe(sourceArtifact);

		clearResultsState(sourceBoxId);

		expect(getResultsState(derivedBoxId)).toBeNull();
		expect(getCurrentResultArtifact(derivedBoxId)).toBeNull();
		expect(getBoundResultArtifact(chartId, derivedBoxId)).toBeNull();
		expect(getResultArtifact(derivedArtifact.artifactId)).toBeNull();
		expect(mocks.notifyResultsUpdated).toHaveBeenCalledWith(derivedBoxId);
	});

	it('preserves a retargeted current derived revision when only its old lineage is revoked', () => {
		const sourceAId = 'query_retarget_source_a';
		const sourceBId = 'query_retarget_source_b';
		const derivedBoxId = 'transformation_retargeted';
		const oldConsumerId = 'chart_pinned_old_derived';
		setResultsState(sourceAId, { columns: ['Value'], rows: [['a']] });
		const sourceA = getCurrentResultArtifact(sourceAId)!;
		setResultsState(derivedBoxId, { columns: ['Value'], rows: [['from-a']] }, {
			lineage: [{ sourceArtifactId: sourceA.artifactId, role: 'primary' }],
		});
		const derivedA = getCurrentResultArtifact(derivedBoxId)!;
		bindResultArtifactConsumer(oldConsumerId, derivedBoxId);
		setResultsState(sourceBId, { columns: ['Value'], rows: [['b']] });
		const sourceB = getCurrentResultArtifact(sourceBId)!;
		setResultsState(derivedBoxId, { columns: ['Value'], rows: [['from-b']] }, {
			lineage: [{ sourceArtifactId: sourceB.artifactId, role: 'primary' }],
		});
		const derivedB = getCurrentResultArtifact(derivedBoxId)!;

		clearResultsState(sourceAId);

		expect(getResultArtifact(derivedA.artifactId)).toBeNull();
		expect(getBoundResultArtifact(oldConsumerId, derivedBoxId)).toBeNull();
		expect(getCurrentResultArtifact(derivedBoxId)).toBe(derivedB);
		expect(getResultsState(derivedBoxId)?.rows).toEqual([['from-b']]);
		expect(mocks.notifyResultsUpdated).toHaveBeenCalledWith(derivedBoxId);
	});
});

// ── getRawCellValue ───────────────────────────────────────────────────────────

describe('getRawCellValue', () => {
	it('returns null for null', () => {
		expect(getRawCellValue(null)).toBeNull();
	});

	it('returns null for undefined', () => {
		expect(getRawCellValue(undefined)).toBeNull();
	});

	it('returns primitive string as-is', () => {
		expect(getRawCellValue('hello')).toBe('hello');
	});

	it('returns primitive number as-is', () => {
		expect(getRawCellValue(42)).toBe(42);
	});

	it('returns primitive boolean as-is', () => {
		expect(getRawCellValue(true)).toBe(true);
	});

	it('returns empty string as-is', () => {
		expect(getRawCellValue('')).toBe('');
	});

	it('returns 0 as-is', () => {
		expect(getRawCellValue(0)).toBe(0);
	});

	it('unwraps object with "full" property', () => {
		expect(getRawCellValue({ full: 'the-value' })).toBe('the-value');
	});

	it('unwraps object with "display" property', () => {
		expect(getRawCellValue({ display: 'shown' })).toBe('shown');
	});

	it('prefers "full" over "display"', () => {
		expect(getRawCellValue({ full: 'a', display: 'b' })).toBe('a');
	});

	it('unwraps nested "full" values recursively', () => {
		expect(getRawCellValue({ full: { full: 'deep' } })).toBe('deep');
	});

	it('unwraps nested "display" values recursively', () => {
		expect(getRawCellValue({ display: { display: 'deep' } })).toBe('deep');
	});

	it('returns object without full/display as-is', () => {
		const obj = { foo: 'bar' };
		expect(getRawCellValue(obj)).toBe(obj);
	});

	it('handles full=null — falls back to display', () => {
		expect(getRawCellValue({ full: null, display: 'fallback' })).toBe('fallback');
	});

	it('handles full=undefined — falls back to display', () => {
		expect(getRawCellValue({ full: undefined, display: 'fallback' })).toBe('fallback');
	});

	it('handles display=null — returns object', () => {
		const obj = { display: null };
		expect(getRawCellValue(obj)).toBe(obj);
	});

	it('handles full=0 (falsy but valid)', () => {
		expect(getRawCellValue({ full: 0 })).toBe(0);
	});

	it('handles display=0 (falsy but valid)', () => {
		// full is not present, display is 0 — falsy but not null/undefined
		expect(getRawCellValue({ display: 0 })).toBe(0);
	});

	it('handles full="" (empty string, valid)', () => {
		expect(getRawCellValue({ full: '' })).toBe('');
	});
});

// ── getResultsState / setResultsState ─────────────────────────────────────────

describe('getResultsState', () => {
	it('returns null for unknown boxId', () => {
		expect(getResultsState('nonexistent-box-id-xyz')).toBeNull();
	});

	it('returns null for empty/falsy boxId', () => {
		expect(getResultsState('')).toBeNull();
		expect(getResultsState(null)).toBeNull();
		expect(getResultsState(undefined)).toBeNull();
	});
});

describe('setResultsState', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
		vi.spyOn(console, 'error').mockImplementation(() => {});
	});

	it('stores and retrieves state by boxId', () => {
		const state = { columns: [], rows: [] };
		setResultsState('test-box-set', state);
		expect(getResultsState('test-box-set')).toBe(state);
	});

	it('does not store when boxId is falsy', () => {
		setResultsState('', { data: 1 });
		expect(getResultsState('')).toBeNull();
	});

	it('does not store when boxId is null', () => {
		setResultsState(null, { data: 1 });
		expect(getResultsState(null)).toBeNull();
	});
});

// ── resetCurrentResult ────────────────────────────────────────────────────────

describe('resetCurrentResult', () => {
	it('resets currentResult to null', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		setResultsState('reset-test-box', { test: true });
		resetCurrentResult();
		// After import, currentResult is a module-level let — we re-import to check
		// The function sets the module-level var to null
		expect(currentResult).toBeNull();
	});
});
