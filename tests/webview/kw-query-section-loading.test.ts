import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/components/kw-dropdown.js';
import '../../src/webview/components/kw-copilot-chat.js';
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
	clearResultsState,
	displayResultBatchForBox,
	displayResultForBox,
	getCurrentResultArtifact,
	getResultsState,
	getSelectedResultIndex,
	setResultsState,
} from '../../src/webview/core/results-state.js';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';
import { APPLIED_KUSTO_COPILOT_DONE_EVENT } from '../../src/webview/core/kusto-copilot-output-runtime.js';
import { getKustoSchemaIdentityKey } from '../../src/shared/kustoAuth.js';
import { createKustoResultBatch } from '../../src/shared/kustoResultBatch.js';

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

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('kw-query-section loading states', () => {
	it('renders Run All as a distinct non-mode split-menu action', async () => {
		const el = createSection();
		await el.updateComplete;

		const item = el.querySelector(`#${el.boxId}_run_menu_all`) as HTMLElement | null;
		expect(item?.textContent?.trim()).toBe('Run All');
		expect(item?.dataset.runAction).toBe('all');
		expect(item?.hasAttribute('data-run-mode')).toBe(false);
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

	it('switches restored result tabs locally in the read-only browser viewer', async () => {
		(window as any).__kustoReadOnlyMode = true;
		try {
			const el = createSection();
			el.id = el.boxId;
			await el.updateComplete;
			const batch = createKustoResultBatch([
				{ columns: ['Value'], rows: [['first']], metadata: {} },
				{ columns: ['Value'], rows: [['second']], metadata: {} },
			]);
			expect(batch.ok).toBe(true);
			if (!batch.ok) return;
			expect(displayResultBatchForBox(batch.value, el.boxId, {
				artifactPublication: { policy: { exportToCsv: true } },
			})).toBe(true);
			vi.mocked(postMessageToHost).mockClear();

			el.querySelector('kw-data-table')!.dispatchEvent(new CustomEvent('result-set-change', {
				detail: { resultIndex: 1 },
			}));

			expect(getSelectedResultIndex(el.boxId)).toBe(1);
			expect((el.querySelector('kw-data-table') as any).rows).toEqual([['second']]);
			expect(postMessageToHost).not.toHaveBeenCalledWith(expect.objectContaining({
				type: 'selectKustoResult',
			}));
		} finally {
			delete (window as any).__kustoReadOnlyMode;
		}
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

	it('clears rows, persisted output, comparison summary, and Copilot state when its target retires', () => {
		const el = createSection();
		el.displayResult({ columns: ['value'], rows: [['old-target']], metadata: {} });
		setResultsState('test1', { boxId: 'test1', columns: ['value'], rows: [['old-target']] });
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

		expect(getResultsState('test1')).toBeNull();
		expect(pState.queryResultJsonByBoxId.test1).toBeUndefined();
		expect(pState.resultArtifactByBoxId.test1).toBeUndefined();
		expect(el.querySelector('.comparison-summary-banner')).toBeNull();
		expect(postMessageToHost).not.toHaveBeenCalledWith(
			expect.objectContaining({ type: 'clearComparisonSummary' }),
		);
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'cancelCopilotWriteQuery', boxId: 'test1', flavor: 'kusto', ...copilotOwner });
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'clearCopilotConversation', flavor: 'kusto', ...copilotOwner });
		expect(retiredOutputs).toContainEqual({
			type: 'copilotWriteQueryDone', ...copilotOwner, ok: false, message: 'Canceled.', retired: true,
		});
	});

	it('clears ordinary target-bound state before advancing to another database', () => {
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
		expect(getResultsState('test1')).toBeNull();
		expect(pState.queryResultJsonByBoxId.test1).toBeUndefined();
		expect(postMessageToHost).toHaveBeenCalledWith({
			type: 'cancelQuery', boxId: 'test1', executionId: oldExecution.executionId,
			sectionInstanceId: oldExecution.sectionInstanceId,
			targetGeneration: oldExecution.targetGeneration,
		});
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
