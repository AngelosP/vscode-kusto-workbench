import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => {
	const queryBoxes: string[] = [];
	const chartBoxes: string[] = [];
	const transformationBoxes: string[] = [];
	const markdownBoxes: string[] = [];
	const pythonBoxes: string[] = [];
	const urlBoxes: string[] = [];
	const queryEditors: Record<string, { getValue: () => string; layout?: () => void }> = {};
	const markdownEditors: Record<string, { getValue: () => string }> = {};

	const addQueryBox = vi.fn(() => {
		const id = `query_restored_${addQueryBox.mock.calls.length + 1}`;
		queryBoxes.push(id);
		queryEditors[id] = { getValue: () => '' };
		return id;
	});

	const addMarkdownBox = vi.fn(() => {
		const id = `markdown_restored_${addMarkdownBox.mock.calls.length + 1}`;
		markdownBoxes.push(id);
		markdownEditors[id] = { getValue: () => '' };
		return id;
	});

	return {
		queryBoxes,
		chartBoxes,
		transformationBoxes,
		markdownBoxes,
		pythonBoxes,
		urlBoxes,
		queryEditors,
		markdownEditors,
		addQueryBox,
		addMarkdownBox,
	};
});

vi.mock('../../src/webview/shared/persistence-utils.js', () => ({
	normalizeClusterUrl: vi.fn((url: unknown) => String(url || '').trim().toLowerCase()),
	isLeaveNoTraceCluster: vi.fn(() => false),
	byteLengthUtf8: vi.fn((v: unknown) => String(v ?? '').length),
	trySerializeQueryResult: vi.fn(() => ({ json: null })),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: vi.fn(),
}));

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: {
		compatibilityMode: false,
		compatibilitySingleKind: 'query',
		allowedSectionKinds: ['query', 'chart', 'transformation', 'markdown', 'python', 'url'],
		defaultSectionKind: 'query',
		upgradeRequestType: 'requestUpgradeToKqlx',
		documentKind: 'kqlx',
		documentUri: '',
		compatibilityTooltip: '',
		restoreInProgress: false,
		queryEditorPendingAdds: { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 },
		pendingQueryTextByBoxId: {} as Record<string, string>,
		pendingMarkdownTextByBoxId: {} as Record<string, string>,
		pendingWrapperHeightPxByBoxId: {} as Record<string, number>,
		manualQueryEditorHeightPxByBoxId: {} as Record<string, number>,
		resultsVisibleByBoxId: {} as Record<string, boolean>,
		queryResultJsonByBoxId: {} as Record<string, string>,
		lastExecutedBox: '',
		copilotChatFirstTimeDismissed: false,
		isSessionFile: false,
		devNotesSections: [],
	}
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	displayResult: vi.fn(),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	addQueryBox: testState.addQueryBox,
	removeQueryBox: vi.fn((id: string) => {
		const idx = testState.queryBoxes.indexOf(id);
		if (idx >= 0) testState.queryBoxes.splice(idx, 1);
	}),
	updateConnectionSelects: vi.fn(),
	toggleCacheControls: vi.fn(),
	__kustoGetQuerySectionElement: vi.fn(() => null),
	__kustoSetSectionName: vi.fn(),
	__kustoGetConnectionId: vi.fn(() => ''),
	__kustoGetDatabase: vi.fn(() => ''),
	__kustoSetAutoEnterFavoritesForBox: vi.fn(),
	__kustoTryAutoEnterFavoritesModeForAllBoxes: vi.fn(),
	__kustoClampResultsWrapperHeight: vi.fn(),
	addPythonBox: vi.fn(() => {
		const id = `python_restored_${testState.pythonBoxes.length + 1}`;
		testState.pythonBoxes.push(id);
		return id;
	}),
	addUrlBox: vi.fn(() => {
		const id = `url_restored_${testState.urlBoxes.length + 1}`;
		testState.urlBoxes.push(id);
		return id;
	}),
	removePythonBox: vi.fn(),
	removeUrlBox: vi.fn(),
	pythonBoxes: testState.pythonBoxes,
	urlBoxes: testState.urlBoxes,
}));

vi.mock('../../src/webview/core/state.js', () => ({
	connections: [],
	queryBoxes: testState.queryBoxes,
	queryEditors: testState.queryEditors,
	favoritesModeByBoxId: {},
	leaveNoTraceClusters: [],
	caretDocsEnabled: true,
	autoTriggerAutocompleteEnabled: true,
	setCaretDocsEnabled: vi.fn(),
	setAutoTriggerAutocompleteEnabled: vi.fn(),
}));

vi.mock('../../src/webview/sections/kw-chart-section.js', () => ({
	addChartBox: vi.fn(),
	removeChartBox: vi.fn(),
	chartBoxes: testState.chartBoxes,
}));

vi.mock('../../src/webview/sections/kw-transformation-section.js', () => ({
	addTransformationBox: vi.fn(),
	removeTransformationBox: vi.fn((id: string) => {
		const idx = testState.transformationBoxes.indexOf(id);
		if (idx >= 0) testState.transformationBoxes.splice(idx, 1);
	}),
	transformationBoxes: testState.transformationBoxes,
}));

vi.mock('../../src/webview/sections/kw-markdown-section.js', () => ({
	addMarkdownBox: testState.addMarkdownBox,
	removeMarkdownBox: vi.fn((id: string) => {
		const idx = testState.markdownBoxes.indexOf(id);
		if (idx >= 0) testState.markdownBoxes.splice(idx, 1);
	}),
	markdownBoxes: testState.markdownBoxes,
	markdownEditors: testState.markdownEditors,
}));



vi.mock('../../src/webview/sections/kw-query-toolbar.js', () => ({
	setRunMode: vi.fn(),
	updateCaretDocsToggleButtons: vi.fn(),
	updateAutoTriggerAutocompleteToggleButtons: vi.fn(),
}));

vi.mock('../../src/webview/sections/query-execution.controller.js', () => ({
	__kustoUpdateQueryResultsToggleButton: vi.fn(),
	__kustoApplyResultsVisibility: vi.fn(),
}));

vi.mock('../../src/webview/monaco/monaco.js', () => ({
	__kustoUpdateSchemaForFocusedBox: vi.fn(),
}));

import { pState } from '../../src/webview/shared/persistence-state.js';
import { getKqlxState, handleDocumentDataMessage } from '../../src/webview/core/persistence.js';

describe('persistence round-trip', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		testState.queryBoxes.splice(0, testState.queryBoxes.length);
		testState.chartBoxes.splice(0, testState.chartBoxes.length);
		testState.markdownBoxes.splice(0, testState.markdownBoxes.length);
		testState.pythonBoxes.splice(0, testState.pythonBoxes.length);
		testState.urlBoxes.splice(0, testState.urlBoxes.length);
		for (const k of Object.keys(testState.queryEditors)) delete testState.queryEditors[k];
		for (const k of Object.keys(testState.markdownEditors)) delete testState.markdownEditors[k];
		for (const k of Object.keys(pState.pendingQueryTextByBoxId)) delete pState.pendingQueryTextByBoxId[k];
		vi.clearAllMocks();
		pState.compatibilityMode = false;
		pState.documentKind = 'kqlx';
	});

	it('serializes section DOM via getKqlxState', () => {
		const container = document.createElement('div');
		container.id = 'queries-container';
		document.body.appendChild(container);

		const queryEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		queryEl.id = 'query_1';
		queryEl.serialize = () => ({ type: 'query', id: 'query_1', query: 'StormEvents | take 5' });

		const markdownEl = document.createElement('div') as unknown as HTMLElement & { serialize: () => unknown };
		markdownEl.id = 'markdown_1';
		markdownEl.serialize = () => ({ type: 'markdown', id: 'markdown_1', text: 'hello' });

		container.appendChild(queryEl);
		container.appendChild(markdownEl);

		const state = getKqlxState() as { sections: Array<{ type: string }> };
		expect(state.sections).toHaveLength(2);
		expect(state.sections.map((s) => s.type)).toEqual(['query', 'markdown']);
	});

	it('recreates sections from serialized state on handleDocumentDataMessage', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/a.kqlx',
			state: {
				sections: [
					{ type: 'query', id: 'query_saved_1', query: 'TableA | take 3' },
					{ type: 'markdown', id: 'markdown_saved_1', text: '# Notes' },
				],
			},
		});

		expect(testState.addQueryBox).toHaveBeenCalledTimes(1);
		expect(testState.addMarkdownBox).toHaveBeenCalledTimes(1);

		const restoredQueryId = String(testState.addQueryBox.mock.results[0]?.value || '');
		expect(restoredQueryId).toBeTruthy();
		expect(pState.pendingQueryTextByBoxId[restoredQueryId]).toBe('TableA | take 3');
	});

	it('ignores duplicate documentData for same document unless forced', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/once.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_1', query: 'A' }] },
		});
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			documentUri: 'file:///tmp/once.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_2', query: 'B' }] },
		});

		expect(testState.addQueryBox).toHaveBeenCalledTimes(1);
	});

	it('applies documentData when documentUri changes without forceReload', () => {
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			forceReload: true,
			documentUri: 'file:///tmp/doc-a.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_a', query: 'A' }] },
		});
		handleDocumentDataMessage({
			type: 'documentData',
			ok: true,
			documentUri: 'file:///tmp/doc-b.kqlx',
			state: { sections: [{ type: 'query', id: 'query_saved_b', query: 'B' }] },
		});

		expect(testState.addQueryBox).toHaveBeenCalledTimes(2);
	});
});
