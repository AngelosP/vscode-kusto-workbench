import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	postMessageToHost: vi.fn(),
	getConnectionId: vi.fn(() => 'connection-a'),
	getDatabase: vi.fn(() => 'DatabaseA'),
	getSectionName: vi.fn(() => 'Section A'),
	getSqlSectionElement: vi.fn(() => null),
	queryEditors: {} as Record<string, any>,
	sqlBoxes: [] as string[],
	optimizationMetadataByBoxId: {} as Record<string, any>,
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: testState.postMessageToHost,
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetConnectionId: testState.getConnectionId,
	__kustoGetDatabase: testState.getDatabase,
	__kustoGetSectionName: testState.getSectionName,
	__kustoGetSqlSectionElement: testState.getSqlSectionElement,
	__kustoNotifyResultsUpdated: vi.fn(),
	closeAllFavoritesDropdowns: vi.fn(),
	fullyQualifyTablesInEditor: vi.fn(),
	sqlBoxes: testState.sqlBoxes,
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	executeQuery: vi.fn(),
	__kustoIsRunSelectionReady: vi.fn(() => true),
	__kustoSetResultsVisible: vi.fn(),
	setQueryExecuting: vi.fn(),
}));

vi.mock('../../src/webview/core/dropdown.js', () => ({ closeAllMenus: vi.fn() }));
vi.mock('../../src/webview/core/persistence.js', () => ({ schedulePersist: vi.fn() }));
vi.mock('../../src/webview/core/page-scroll-dismiss.js', () => ({ registerPageScrollDismissable: vi.fn() }));
vi.mock('../../src/webview/monaco/prettify.js', () => ({ __kustoHasFunctionDefinition: vi.fn(() => false) }));
vi.mock('../../src/webview/shared/comparisonUtils.js', () => ({ getRunModeLabelText: vi.fn(() => 'Run Query') }));
vi.mock('../../src/webview/core/editing-preferences.js', () => ({
	applyCaretDocsPresentation: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
	updateCaretDocsToggleButtons: vi.fn(),
	updateCopilotInlineCompletionsToggleButtons: vi.fn(),
}));
vi.mock('../../src/webview/shared/icon-registry.js', () => new Proxy({}, { get: () => '' }));
vi.mock('../../src/webview/core/state.js', () => ({
	activeQueryEditorBoxId: '',
	qualifyTablesInFlightByBoxId: {},
	runModesByBoxId: {},
	optimizationMetadataByBoxId: testState.optimizationMetadataByBoxId,
	caretDocsEnabled: true,
	setCaretDocsEnabled: vi.fn(),
	autoTriggerAutocompleteEnabled: true,
	setAutoTriggerAutocompleteEnabled: vi.fn(),
	copilotInlineCompletionsEnabled: true,
	setCopilotInlineCompletionsEnabled: vi.fn(),
	setActiveQueryEditorBoxId: vi.fn(),
	queryBoxes: [],
	queryEditors: testState.queryEditors,
	connections: [],
}));
vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: { resultsVisibleByBoxId: {}, lastExecutedBox: '' },
}));

import {
	clearResultsState,
	getBoundResultArtifact,
	setResultsState,
} from '../../src/webview/core/results-state.js';
import { shareClipboardArtifactConsumerId } from '../../src/shared/resultArtifact.js';
import {
	__kustoCloseShareModal,
	__kustoCloseShareModalForOwner,
	__kustoOpenShareModal,
	__kustoShareCopyToClipboard,
} from '../../src/webview/sections/kw-query-toolbar.js';

function installShareModal(): void {
	document.body.innerHTML = `
		<div id="shareModal">
			<h3 id="shareModal_title"></h3>
			<label id="shareModal_label_title"><input id="shareModal_chk_title" type="checkbox"></label>
			<span id="shareModal_link_subtitle"></span>
			<label id="shareModal_label_query"><input id="shareModal_chk_query" type="checkbox"></label>
			<label id="shareModal_label_results"><input id="shareModal_chk_results" type="checkbox"></label>
			<span id="shareModal_results_subtitle"></span>
			<span id="shareModal_rowLimitGroup"><input id="shareModal_rowLimit" type="number"></span>
			<span id="shareModal_rowLimitTotal"></span>
		</div>`;
}

function publish(boxId: string, executionId: string, value: string, allowed = true): void {
	setResultsState(boxId, {
		columns: [{ name: 'Value', type: 'string' }],
		rows: [[value], [`${value}-2`]],
		metadata: {},
	}, {
		producer: {
			engine: 'kusto', boxId, executionId,
			query: `print Value="${value}"`, connectionId: `connection-${value}`, database: `Database${value}`,
		},
		policy: { shareToClipboard: allowed },
	});
}

function clipboardMessages(): any[] {
	return testState.postMessageToHost.mock.calls
		.map(([message]) => message)
		.filter(message => message.type === 'shareToClipboard');
}

describe('query share modal result artifacts', () => {
	beforeEach(() => {
		installShareModal();
		testState.postMessageToHost.mockClear();
		testState.getConnectionId.mockReturnValue('connection-a');
		testState.getDatabase.mockReturnValue('DatabaseA');
		testState.getSectionName.mockReturnValue('Section A');
		testState.getSqlSectionElement.mockReturnValue(null);
		testState.sqlBoxes.splice(0, testState.sqlBoxes.length);
		for (const key of Object.keys(testState.queryEditors)) delete testState.queryEditors[key];
		for (const key of Object.keys(testState.optimizationMetadataByBoxId)) delete testState.optimizationMetadataByBoxId[key];
	});

	it('pins artifact A and its query target snapshot until close, then reopening binds B', () => {
		const boxId = 'query_share_pin';
		let query = 'print Value="A"';
		testState.queryEditors[boxId] = { getValue: () => query };
		publish(boxId, 'execution-a', 'artifact-a');
		query = 'print Value="edited-before-open"';
		testState.getConnectionId.mockReturnValue('connection-edited');
		testState.getDatabase.mockReturnValue('DatabaseEdited');

		__kustoOpenShareModal(boxId);
		const artifactA = getBoundResultArtifact(shareClipboardArtifactConsumerId(), boxId);
		expect(artifactA?.producer?.executionId).toBe('execution-a');

		query = 'print Value="B"';
		testState.getConnectionId.mockReturnValue('connection-b');
		testState.getDatabase.mockReturnValue('DatabaseB');
		testState.getSectionName.mockReturnValue('Section B');
		publish(boxId, 'execution-b', 'artifact-b');
		(document.getElementById('shareModal_rowLimit') as HTMLInputElement).value = '1';
		__kustoShareCopyToClipboard();

		expect(clipboardMessages()).toEqual([expect.objectContaining({
			boxId,
			sectionName: 'Section A',
			queryText: 'print Value="artifact-a"',
			connectionId: 'connection-artifact-a',
			database: 'Databaseartifact-a',
			columns: ['Value'],
			rowsData: [['artifact-a']],
			totalRows: 2,
		})]);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), boxId)).toBeNull();

		testState.postMessageToHost.mockClear();
		__kustoOpenShareModal(boxId);
		__kustoShareCopyToClipboard();
		expect(clipboardMessages()[0]).toMatchObject({
			sectionName: 'Section B', queryText: 'print Value="artifact-b"',
			connectionId: 'connection-artifact-b', database: 'Databaseartifact-b',
			rowsData: [['artifact-b'], ['artifact-b-2']], totalRows: 2,
		});
	});

	it('fails closed for denied or revoked rows and releases the binding on close', () => {
		const deniedId = 'query_share_denied';
		testState.queryEditors[deniedId] = { getValue: () => 'print denied=1' };
		publish(deniedId, 'execution-denied', 'must-not-copy', false);
		__kustoOpenShareModal(deniedId);

		const resultsCheck = document.getElementById('shareModal_chk_results') as HTMLInputElement;
		expect(resultsCheck.checked).toBe(false);
		expect(resultsCheck.disabled).toBe(true);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), deniedId)).toBeNull();
		(document.getElementById('shareModal_chk_title') as HTMLInputElement).checked = false;
		(document.getElementById('shareModal_chk_query') as HTMLInputElement).checked = false;
		resultsCheck.disabled = false;
		resultsCheck.checked = true;
		__kustoShareCopyToClipboard();
		expect(clipboardMessages()).toEqual([]);
		expect(testState.postMessageToHost).toHaveBeenCalledWith({
			type: 'showInfo', message: 'Results are no longer available to share.',
		});

		const allowedId = 'query_share_revoked';
		testState.queryEditors[allowedId] = { getValue: () => 'print allowed=1' };
		publish(allowedId, 'execution-allowed', 'allowed');
		__kustoOpenShareModal(allowedId);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), allowedId)).not.toBeNull();
		clearResultsState(allowedId);
		expect(resultsCheck.checked).toBe(false);
		expect(resultsCheck.disabled).toBe(true);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), allowedId)).toBeNull();

		publish(allowedId, 'execution-next', 'next');
		__kustoOpenShareModal(allowedId);
		__kustoCloseShareModal();
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), allowedId)).toBeNull();
	});

	it('uses the same artifact-bound opening path for SQL sections', () => {
		const boxId = 'sql_share_pin';
		const sqlSection = {
			getName: () => 'SQL Section',
			getQuery: () => 'select 1 as Value',
			getConnectionId: () => 'sql-connection',
			getDatabase: () => 'SqlDb',
		};
		testState.sqlBoxes.push(boxId);
		testState.getSqlSectionElement.mockReturnValue(sqlSection);
		setResultsState(boxId, { columns: ['Value'], rows: [[1]], metadata: {} }, {
			producer: {
				engine: 'sql', boxId, executionId: 'sql-execution', query: 'select 1 as Value',
				connectionId: 'sql-connection', database: 'SqlDb',
			},
			policy: { shareToClipboard: true },
		});

		__kustoOpenShareModal(boxId);
		expect((document.getElementById('shareModal_chk_title') as HTMLInputElement).disabled).toBe(false);
		expect(document.getElementById('shareModal_label_title')?.classList.contains('share-modal-option-disabled')).toBe(false);
		expect(document.getElementById('shareModal_link_subtitle')?.textContent).toBe('Includes the section title');
		__kustoShareCopyToClipboard();

		expect(clipboardMessages()[0]).toMatchObject({
			engine: 'sql', boxId, sectionName: 'SQL Section', queryText: 'select 1 as Value',
			connectionId: 'sql-connection', database: 'SqlDb', rowsData: [['1']],
		});
	});

	it('disables result sharing when exact query or target provenance is absent', () => {
		const boxId = 'query_share_incomplete_provenance';
		testState.queryEditors[boxId] = { getValue: () => 'print mutable=1' };
		setResultsState(boxId, { columns: ['Value'], rows: [['row']], metadata: {} }, {
			producer: { engine: 'kusto', boxId, executionId: 'execution-incomplete' },
			policy: { shareToClipboard: true },
		});

		__kustoOpenShareModal(boxId);

		const resultsCheck = document.getElementById('shareModal_chk_results') as HTMLInputElement;
		expect(resultsCheck.checked).toBe(false);
		expect(resultsCheck.disabled).toBe(true);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), boxId)).toBeNull();
	});

	it('uses SQL formatting and source ownership for a derived comparison section', () => {
		const sourceId = 'sql_share_source';
		const comparisonId = 'query_share_sql_comparison';
		const sqlSection = {
			getName: () => 'SQL Source', getQuery: () => 'SELECT 1',
			getConnectionId: () => 'sql-connection', getDatabase: () => 'SqlDb',
		};
		testState.sqlBoxes.push(sourceId);
		testState.getSqlSectionElement.mockImplementation((id: string) => id === sourceId ? sqlSection : null);
		testState.optimizationMetadataByBoxId[comparisonId] = { isComparison: true, sourceBoxId: sourceId };
		testState.queryEditors[comparisonId] = { getValue: () => 'SELECT 2 AS Value' };
		setResultsState(comparisonId, { columns: ['Value'], rows: [[2]], metadata: {} }, {
			producer: {
				engine: 'sql', boxId: comparisonId, executionId: 'sql-comparison', query: 'SELECT 2 AS Value',
				connectionId: 'sql-connection', database: 'SqlDb', producer: 'comparison',
			},
			policy: { shareToClipboard: true },
		});

		__kustoOpenShareModal(comparisonId);
		expect(document.getElementById('shareModal_link_subtitle')?.textContent).toBe('Includes the section title');
		__kustoShareCopyToClipboard();

		expect(clipboardMessages()[0]).toMatchObject({
			engine: 'sql', boxId: comparisonId, queryText: 'SELECT 2 AS Value',
			connectionId: 'sql-connection', database: 'SqlDb', rowsData: [['2']],
		});
	});

	it('closes only for the active owner and permits a clean same-ID recreation', () => {
		const boxId = 'query_share_recreated';
		testState.queryEditors[boxId] = { getValue: () => 'print Value="old"' };
		publish(boxId, 'execution-old', 'old');
		__kustoOpenShareModal(boxId);

		__kustoCloseShareModalForOwner('query_other');
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), boxId)?.producer?.executionId).toBe('execution-old');
		__kustoCloseShareModalForOwner(boxId);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), boxId)).toBeNull();
		expect(document.getElementById('shareModal')?.classList.contains('visible')).toBe(false);

		publish(boxId, 'execution-new', 'new');
		__kustoOpenShareModal(boxId);
		expect(getBoundResultArtifact(shareClipboardArtifactConsumerId(), boxId)?.producer?.executionId).toBe('execution-new');
	});
});