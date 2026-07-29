import { beforeEach, describe, expect, it, vi } from 'vitest';

const testState = vi.hoisted(() => ({
	postMessageToHost: vi.fn(),
	getConnectionId: vi.fn(() => 'conn-1'),
	getDatabase: vi.fn(() => 'Samples'),
	getRunMode: vi.fn(() => 'runFunction'),
	sectionLifecycle: { sectionInstanceId: 'instance-query_1', targetGeneration: 7 },
	claimedExecutions: [] as Array<Record<string, unknown>>,
	getSchemaLifecycleIdentity: vi.fn(() => ({ sectionInstanceId: 'instance-query_1', targetGeneration: 7 })),
	beginQueryExecution: vi.fn(),
	getQuerySectionElement: vi.fn(),
	getSqlSectionElement: vi.fn(),
	getResultsState: vi.fn(() => null),
	getCurrentResultArtifact: vi.fn(() => null),
	getResultArtifact: vi.fn(() => null),
	getResultArtifactByProducerExecution: vi.fn(() => null),
	bindResultArtifactConsumer: vi.fn(),
	unbindResultArtifactConsumer: vi.fn(),
	queryEditors: {} as Record<string, any>,
	queryExecutionTimers: {} as Record<string, any>,
	pendingFavoriteSelectionByBoxId: {} as Record<string, any>,
	optimizationMetadataByBoxId: {} as Record<string, any>,
	schemaByBoxId: {} as Record<string, any>,
	queryBoxes: [] as string[],
	favoritesModeByBoxId: {} as Record<string, any>,
	pState: {
		lastExecutedBox: '',
		resultsVisibleByBoxId: {},
		queryResultJsonByBoxId: {} as Record<string, string>,
		resultArtifactByBoxId: {},
	},
}));

const dialogState = vi.hoisted(() => {
	class TestFunctionParamsDialog extends HTMLElement {
		show(_functionName: string, _params: unknown[]): void {
			setTimeout(() => {
				this.dispatchEvent(new CustomEvent('function-run', {
					detail: { values: ['5'] },
					bubbles: true,
					composed: true,
				}));
			}, 0);
		}
	}
	return { TestFunctionParamsDialog };
});

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: testState.postMessageToHost,
}));

vi.mock('../../src/webview/shared/persistence-state.js', () => ({
	pState: testState.pState,
}));

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/core/results-state.js', () => ({
	clearResultsState: vi.fn(),
	getResultsState: testState.getResultsState,
	getCurrentResultArtifact: testState.getCurrentResultArtifact,
	getResultArtifact: testState.getResultArtifact,
	getResultArtifactByProducerExecution: testState.getResultArtifactByProducerExecution,
	bindResultArtifactConsumer: testState.bindResultArtifactConsumer,
	unbindResultArtifactConsumer: testState.unbindResultArtifactConsumer,
}));

vi.mock('../../src/webview/core/utils.js', () => ({
	escapeHtml: vi.fn((value: unknown) => String(value ?? '')),
}));

vi.mock('../../src/webview/core/query-section-accessors.js', () => ({
	synchronizeKustoSectionTarget: vi.fn(() => true),
}));

vi.mock('../../src/webview/core/state.js', () => ({
	queryEditors: testState.queryEditors,
	queryExecutionTimers: testState.queryExecutionTimers,
	pendingFavoriteSelectionByBoxId: testState.pendingFavoriteSelectionByBoxId,
	optimizationMetadataByBoxId: testState.optimizationMetadataByBoxId,
	schemaByBoxId: testState.schemaByBoxId,
	clearKustoEditorSchema: (boxId: string) => { delete testState.schemaByBoxId[boxId]; },
	queryBoxes: testState.queryBoxes,
	favoritesModeByBoxId: testState.favoritesModeByBoxId,
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetConnectionId: testState.getConnectionId,
	__kustoGetDatabase: testState.getDatabase,
	__kustoGetQuerySectionElement: testState.getQuerySectionElement,
	__kustoGetSqlSectionElement: testState.getSqlSectionElement,
	__kustoSetSectionName: vi.fn(),
	__kustoGetSectionName: vi.fn(() => ''),
	__kustoPickNextAvailableSectionLetterName: vi.fn(() => 'A'),
	addQueryBox: vi.fn(() => 'query_cmp_1'),
	toggleCacheControls: vi.fn(),
	removeQueryBox: vi.fn(),
	__kustoGetCurrentClusterUrlForBox: vi.fn(() => 'https://example.kusto.windows.net'),
	__kustoGetCurrentDatabaseForBox: vi.fn(() => 'Samples'),
	__kustoFindFavorite: vi.fn(() => null),
	__kustoLog: vi.fn(),
}));

vi.mock('../../src/webview/sections/kw-query-toolbar.js', () => ({
	getRunMode: testState.getRunMode,
	setRunMode: vi.fn(),
	closeRunMenu: vi.fn(),
	functionRunDialogOpenByBoxId: {},
}));

vi.mock('../../src/webview/components/kw-function-params-dialog.js', () => ({
	KwFunctionParamsDialog: dialogState.TestFunctionParamsDialog,
}));

vi.mock('../../src/webview/components/kw-function-params-dialog', () => ({
	KwFunctionParamsDialog: dialogState.TestFunctionParamsDialog,
}));

import { displayComparisonSummary, executeKustoComparisonPair, executeQuery, executeRunFunction, lastRunCacheEnabledByBoxId, QueryExecutionController } from '../../src/webview/sections/query-execution.controller.js';

beforeAll(() => {
	if (!customElements.get('kw-function-params-dialog')) {
		customElements.define('kw-function-params-dialog', dialogState.TestFunctionParamsDialog);
	}
});

function makeEditor(text: string, lineNumber?: number, column?: number, selection?: any): any {
	const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
	const lineStarts = lines.reduce<number[]>((starts, line, index) => {
		starts.push(index === 0 ? 0 : starts[index - 1] + lines[index - 1].length + 1);
		return starts;
	}, []);
	const model = {
		getValue: () => text,
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
		getLineMaxColumn: (lineNumber: number) => (lines[lineNumber - 1] ?? '').length + 1,
		getValueInRange: (range: any) => {
			const startLine = Math.max(1, Number(range?.startLineNumber) || 1);
			const endLine = Math.max(startLine, Number(range?.endLineNumber) || startLine);
			const startColumn = Math.max(1, Number(range?.startColumn) || 1);
			const endColumn = Math.max(1, Number(range?.endColumn) || 1);
			if (startLine === endLine) {
				return (lines[startLine - 1] ?? '').slice(startColumn - 1, endColumn - 1);
			}
			const selectedLines = lines.slice(startLine - 1, endLine);
			if (selectedLines.length === 0) return '';
			selectedLines[0] = selectedLines[0].slice(startColumn - 1);
			selectedLines[selectedLines.length - 1] = selectedLines[selectedLines.length - 1].slice(0, endColumn - 1);
			return selectedLines.join('\n');
		},
		getOffsetAt: (position: any) => {
			const lineNumber = Math.max(1, Math.min(lines.length, Number(position?.lineNumber) || 1));
			const column = Math.max(1, Number(position?.column) || 1);
			return lineStarts[lineNumber - 1] + column - 1;
		},
		getPositionAt: (offsetRaw: number) => {
			const offset = Math.max(0, Number(offsetRaw) || 0);
			let lineIndex = 0;
			for (let i = 0; i < lineStarts.length; i++) {
				if (lineStarts[i] <= offset) lineIndex = i;
				else break;
			}
			return { lineNumber: lineIndex + 1, column: offset - lineStarts[lineIndex] + 1 };
		},
	};
	return {
		getValue: () => text,
		getModel: () => model,
		getPosition: () => ({ lineNumber: lineNumber ?? lines.length, column: column ?? 1 }),
		getSelection: () => selection ?? { isEmpty: () => true },
	};
}

function getExecuteMessages(): Array<Record<string, unknown>> {
	return testState.postMessageToHost.mock.calls
		.map(call => call[0])
		.filter((message: any) => message?.type === 'executeQuery');
}

function getInfoMessages(): Array<Record<string, unknown>> {
	return testState.postMessageToHost.mock.calls
		.map(call => call[0])
		.filter((message: any) => message?.type === 'showInfo');
}

function appendExecutionControls(boxId: string): void {
	const cacheEnabled = document.createElement('input');
	cacheEnabled.id = `${boxId}_cache_enabled`;
	cacheEnabled.type = 'checkbox';
	document.body.appendChild(cacheEnabled);
	const cacheValue = document.createElement('input');
	cacheValue.id = `${boxId}_cache_value`;
	cacheValue.value = '1';
	document.body.appendChild(cacheValue);
	const cacheUnit = document.createElement('select');
	cacheUnit.id = `${boxId}_cache_unit`;
	const hours = document.createElement('option');
	hours.value = 'h';
	hours.textContent = 'Hours';
	cacheUnit.appendChild(hours);
	document.body.appendChild(cacheUnit);
}

describe('executeRunFunction', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		for (const key of Object.keys(testState.queryEditors)) delete testState.queryEditors[key];
		for (const key of Object.keys(testState.queryExecutionTimers)) delete testState.queryExecutionTimers[key];
		for (const key of Object.keys(testState.pendingFavoriteSelectionByBoxId)) delete testState.pendingFavoriteSelectionByBoxId[key];
		for (const key of Object.keys(testState.optimizationMetadataByBoxId)) delete testState.optimizationMetadataByBoxId[key];
		for (const key of Object.keys(testState.pState.queryResultJsonByBoxId)) delete testState.pState.queryResultJsonByBoxId[key];
		for (const key of Object.keys(lastRunCacheEnabledByBoxId)) delete lastRunCacheEnabledByBoxId[key];
		testState.claimedExecutions.length = 0;
		testState.postMessageToHost.mockClear();
		testState.getSchemaLifecycleIdentity.mockClear();
		testState.beginQueryExecution.mockReset();
		testState.beginQueryExecution.mockImplementation((executionId: string, producer = 'manual') => {
			testState.claimedExecutions.push({
				engine: 'kusto',
				boxId: 'query_1',
				executionId,
				sectionInstanceId: testState.sectionLifecycle.sectionInstanceId,
				targetGeneration: testState.sectionLifecycle.targetGeneration,
				connectionId: testState.getConnectionId(),
				database: testState.getDatabase(),
				producer,
			});
			return true;
		});
		testState.getQuerySectionElement.mockReset();
		testState.getQuerySectionElement.mockImplementation((boxId: string) => String(boxId) === 'query_1' ? {
			getSchemaLifecycleIdentity: testState.getSchemaLifecycleIdentity,
			beginQueryExecution: testState.beginQueryExecution,
		} : null);
		testState.getConnectionId.mockReturnValue('conn-1');
		testState.getDatabase.mockReturnValue('Samples');
		testState.getSqlSectionElement.mockReset();
		testState.getSqlSectionElement.mockReturnValue(null);
		testState.getRunMode.mockReturnValue('runFunction');
		testState.getResultsState.mockReset();
		testState.getResultsState.mockReturnValue(null);
		testState.getCurrentResultArtifact.mockReset();
		testState.getCurrentResultArtifact.mockReturnValue(null);
		testState.getResultArtifact.mockReset();
		testState.getResultArtifact.mockReturnValue(null);
		testState.getResultArtifactByProducerExecution.mockReset();
		testState.getResultArtifactByProducerExecution.mockReturnValue(null);
		testState.bindResultArtifactConsumer.mockReset();
		testState.unbindResultArtifactConsumer.mockReset();
		testState.pState.lastExecutedBox = '';
		delete (window as any).__kustoGetStatementBlocksFromModel;
		delete (window as any).__kustoExtractStatementTextAtCursor;
		delete (window as any).__kustoClearAutoFindInQueryEditor;
	});

	it('runs a no-parameter function definition after a leading comment', async () => {
		testState.queryEditors.query_1 = makeEditor('// helper function\n.create function CommentedFunction() { print x=1 }');

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			type: 'executeQuery',
			connectionId: 'conn-1',
			database: 'Samples',
			boxId: 'query_1',
			sectionInstanceId: 'instance-query_1',
			targetGeneration: 7,
			producer: 'manual',
			queryMode: 'plain',
			cacheEnabled: false,
			cacheValue: 1,
			cacheUnit: 'h',
		});
		expect(messages[0].executionId).toEqual(expect.stringMatching(/^kusto-run-/));
		expect(testState.claimedExecutions).toEqual([expect.objectContaining({
			boxId: 'query_1',
			executionId: messages[0].executionId,
			sectionInstanceId: 'instance-query_1',
			targetGeneration: 7,
			connectionId: 'conn-1',
			database: 'Samples',
			producer: 'manual',
		})]);
		expect(messages[0].query).toBe('let CommentedFunction = () { print x=1 };\nCommentedFunction()');
	});

	it('does not publish a Run Function query when the exact section owner rejects the claim', async () => {
		testState.queryEditors.query_1 = makeEditor('.create function RejectedFunction() { print x=1 }');
		testState.beginQueryExecution.mockReturnValue(false);

		await executeRunFunction('query_1');

		expect(testState.beginQueryExecution).toHaveBeenCalledOnce();
		expect(getExecuteMessages()).toHaveLength(0);
	});

	it('does not publish a normal query when the exact section owner rejects the claim', () => {
		testState.queryEditors.query_1 = makeEditor('print x=1');
		testState.beginQueryExecution.mockReturnValue(false);
		appendExecutionControls('query_1');

		const executionId = executeQuery('query_1', 'plain');

		expect(executionId).toBeUndefined();
		expect(testState.beginQueryExecution).toHaveBeenCalledOnce();
		expect(getExecuteMessages()).toHaveLength(0);
	});

	it('stamps a manual comparison source run with its generated execution identity', () => {
		testState.queryEditors.query_1 = makeEditor('print source=1');
		appendExecutionControls('query_1');

		const executionId = (executeQuery as any)('query_1', 'plain', 'comparison', {
			role: 'source', comparisonBoxId: 'query_cmp_1',
		});

		expect(getExecuteMessages()).toContainEqual(expect.objectContaining({
			boxId: 'query_1', executionId, producer: 'comparison',
			comparisonRun: {
				sourceBoxId: 'query_1', sourceExecutionId: executionId, comparisonBoxId: 'query_cmp_1',
			},
		}));
	});

	it('retains comparisonRun in the exact active owner used for terminal admission', () => {
		const host = {
			boxId: 'query_cmp_1', addController: vi.fn(), requestUpdate: vi.fn(),
			getConnectionId: () => 'conn-1', getDatabase: () => 'Samples',
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: 'instance-cmp', targetGeneration: 2 }),
		} as any;
		const controller = new QueryExecutionController(host);
		const comparisonRun = {
			sourceBoxId: 'query_1', sourceExecutionId: 'source-execution', comparisonBoxId: 'query_cmp_1',
		};

		expect(controller.beginQueryExecution(
			'comparison-execution', 'comparison', undefined, undefined, comparisonRun,
		)).toBe(true);
		expect(controller.getActiveExecution()).toEqual(expect.objectContaining({ comparisonRun }));
		expect(controller.admitQueryTerminal(controller.getActiveExecution()!)).toBe('active');
	});

	it('does not require Kusto comparisonRun for a SQL-owned comparison section', () => {
		testState.queryEditors.query_cmp_1 = makeEditor('SELECT 2');
		appendExecutionControls('query_cmp_1');
		testState.optimizationMetadataByBoxId.query_cmp_1 = { sourceBoxId: 'sql_source', isComparison: true };
		testState.getSqlSectionElement.mockImplementation((boxId: string) => boxId === 'sql_source' ? {} : null);
		testState.getQuerySectionElement.mockImplementation((boxId: string) => boxId === 'query_cmp_1' ? {
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: 'instance-cmp', targetGeneration: 7 }),
			beginQueryExecution: () => true,
		} : null);

		const executionId = executeQuery('query_cmp_1', 'plain');

		expect(executionId).toMatch(/^kusto-run-/);
		expect(getExecuteMessages()).toContainEqual(expect.objectContaining({
			boxId: 'query_cmp_1', producer: 'manual',
		}));
		expect(getExecuteMessages()[0]).not.toHaveProperty('comparisonRun');
	});

	it('starts the comparison only after the exact source terminal is admitted', async () => {
		testState.getRunMode.mockReturnValue('plain');
		testState.queryEditors.query_1 = makeEditor('print source=1');
		testState.queryEditors.query_cmp_1 = makeEditor('print optimized=1');
		appendExecutionControls('query_1');
		appendExecutionControls('query_cmp_1');
		testState.optimizationMetadataByBoxId.query_1 = { comparisonBoxId: 'query_cmp_1' };
		testState.optimizationMetadataByBoxId.query_cmp_1 = { sourceBoxId: 'query_1', isComparison: true };
		testState.getQuerySectionElement.mockImplementation((boxId: string) => ({
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: `instance-${boxId}`, targetGeneration: 7 }),
			beginQueryExecution: () => true,
		}));

		const pair = executeKustoComparisonPair('query_1', 'query_cmp_1');
		const sourceMessage = getExecuteMessages()[0] as any;
		expect(getExecuteMessages()).toHaveLength(1);
		expect(sourceMessage.comparisonRun.sourceExecutionId).toBe(sourceMessage.executionId);
		const sourceArtifact = {
			artifactId: 'result:query_1:1', sourceBoxId: 'query_1',
			producer: { executionId: sourceMessage.executionId },
		};
		testState.getResultArtifactByProducerExecution.mockReturnValue(sourceArtifact);
		testState.bindResultArtifactConsumer.mockReturnValue(sourceArtifact.artifactId);

		window.dispatchEvent(new CustomEvent('kusto-workbench-query-terminal', { detail: {
			type: 'queryResult', boxId: 'query_1', executionId: sourceMessage.executionId,
		} }));
		await expect(pair).resolves.toBe(true);

		const messages = getExecuteMessages() as any[];
		expect(messages).toHaveLength(2);
		expect(messages[1]).toEqual(expect.objectContaining({
			boxId: 'query_cmp_1', producer: 'comparison', comparisonRun: sourceMessage.comparisonRun,
		}));
	});

	it('releases the exact source pin when comparison dispatch cannot start', async () => {
		testState.getRunMode.mockReturnValue('plain');
		testState.queryEditors.query_1 = makeEditor('print source=1');
		testState.queryEditors.query_cmp_1 = makeEditor('');
		appendExecutionControls('query_1');
		appendExecutionControls('query_cmp_1');
		testState.getQuerySectionElement.mockImplementation((boxId: string) => ({
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: `instance-${boxId}`, targetGeneration: 7 }),
			beginQueryExecution: () => true,
		}));

		const pair = executeKustoComparisonPair('query_1', 'query_cmp_1');
		const sourceMessage = getExecuteMessages()[0] as any;
		const sourceArtifact = {
			artifactId: 'result:query_1:1', sourceBoxId: 'query_1',
			producer: { executionId: sourceMessage.executionId },
		};
		testState.getResultArtifactByProducerExecution.mockReturnValue(sourceArtifact);
		testState.bindResultArtifactConsumer.mockReturnValue(sourceArtifact.artifactId);
		window.dispatchEvent(new CustomEvent('kusto-workbench-query-terminal', { detail: {
			type: 'queryResult', boxId: 'query_1', executionId: sourceMessage.executionId,
		} }));

		await expect(pair).resolves.toBe(false);
		expect(testState.unbindResultArtifactConsumer).toHaveBeenCalledWith('comparison:query_cmp_1:source');
	});

	it('routes direct comparison Run through source-first pairing when source used cache', async () => {
		testState.getRunMode.mockReturnValue('plain');
		testState.queryEditors.query_1 = makeEditor('print source=1');
		testState.queryEditors.query_cmp_1 = makeEditor('print optimized=1');
		appendExecutionControls('query_1');
		appendExecutionControls('query_cmp_1');
		testState.optimizationMetadataByBoxId.query_1 = { comparisonBoxId: 'query_cmp_1' };
		testState.optimizationMetadataByBoxId.query_cmp_1 = { sourceBoxId: 'query_1', isComparison: true };
		lastRunCacheEnabledByBoxId.query_1 = true;
		testState.getQuerySectionElement.mockImplementation((boxId: string) => ({
			getSchemaLifecycleIdentity: () => ({ sectionInstanceId: `instance-${boxId}`, targetGeneration: 7 }),
			beginQueryExecution: () => true,
		}));

		expect(executeQuery('query_cmp_1', 'plain')).toBeUndefined();
		const sourceMessage = getExecuteMessages()[0] as any;
		expect(getExecuteMessages()).toHaveLength(1);
		expect(sourceMessage.boxId).toBe('query_1');
		expect(sourceMessage.comparisonRun.comparisonBoxId).toBe('query_cmp_1');
	});

	it('builds comparison summary from exact source lineage instead of newer mutable source state', () => {
		const sourceArtifactA = {
			artifactId: 'result:query_1:1', sourceBoxId: 'query_1', revision: 1,
			columns: ['Value'], rows: [['a']], metadata: {}, lineage: [],
		};
		const comparisonArtifact = {
			artifactId: 'result:query_cmp_1:1', sourceBoxId: 'query_cmp_1', revision: 1,
			columns: ['Value'], rows: [['a']], metadata: {},
			lineage: [{ sourceArtifactId: sourceArtifactA.artifactId, role: 'comparison-source' }],
		};
		testState.getCurrentResultArtifact.mockImplementation((boxId: string) => (
			boxId === 'query_cmp_1' ? comparisonArtifact : null
		));
		testState.getResultArtifact.mockImplementation((artifactId: string) => (
			artifactId === sourceArtifactA.artifactId ? sourceArtifactA : null
		));
		testState.getResultsState.mockImplementation((boxId: string) => (
			boxId === 'query_1'
				? { columns: ['Value'], rows: [['b']], metadata: {} }
				: { columns: ['Value'], rows: [['a']], metadata: {} }
		));
		const comparison = document.createElement('div');
		comparison.id = 'query_cmp_1';
		const wrapper = document.createElement('div');
		wrapper.className = 'query-editor-wrapper';
		comparison.appendChild(wrapper);
		document.body.appendChild(comparison);

		displayComparisonSummary('query_1', 'query_cmp_1');

		expect(testState.getResultArtifact).toHaveBeenCalledWith(sourceArtifactA.artifactId);
		expect(testState.getResultsState).not.toHaveBeenCalledWith('query_1');
		expect(comparison.querySelector('.comparison-summary-banner')).not.toBeNull();
	});

	it('runs a function definition after leading blank lines without shifting cursor offsets', async () => {
		testState.queryEditors.query_1 = makeEditor('\n\n.create function BlankLineFunction() { print x=1 }', 3, 20);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let BlankLineFunction = () { print x=1 };\nBlankLineFunction()');
	});

	it('runs a function definition inside a fenced Kusto block', async () => {
		const text = '```kusto\n.create function FencedFunction() { print x=1 }\n```';
		testState.queryEditors.query_1 = makeEditor(text, 2, 20);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let FencedFunction = () { print x=1 };\nFencedFunction()');
	});

	it('runs a create-or-alter function definition after a leading block comment', async () => {
		testState.queryEditors.query_1 = makeEditor('/* helper function */\n.create-or-alter function CommentedFunction() { print x=1 }');

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let CommentedFunction = () { print x=1 };\nCommentedFunction()');
	});

	it('runs an alter function definition after a leading line comment', async () => {
		testState.queryEditors.query_1 = makeEditor('// helper function\n.alter function CommentedFunction() { print x=1 }');

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let CommentedFunction = () { print x=1 };\nCommentedFunction()');
	});

	it('runs a create function with metadata as an inline function without the metadata clause', async () => {
		testState.queryEditors.query_1 = makeEditor('.create function with (folder="Helpers", docstring="Helper") MetadataFunction() { print x=1 }');

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let MetadataFunction = () { print x=1 };\nMetadataFunction()');
	});

	it('runs an ifnotexists function as an inline function without the ifnotexists keyword', async () => {
		testState.queryEditors.query_1 = makeEditor('.create function ifnotexists ExistingFunction() { print x=1 }');

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let ExistingFunction = () { print x=1 };\nExistingFunction()');
	});

	it.each([
		['line-commented fake', '// .create function Fake() { print fake=1 }\n.create function RealFunction() { print real=1 }', 2],
		['block-commented fake', '/* .create function Fake() { print fake=1 } */\n.create function RealFunction() { print real=1 }', 2],
		['multiline-block-commented fake', '/*\n.create function Fake() { print fake=1 }\n*/\n.create function RealFunction() { print real=1 }', 4],
	])('ignores a %s before running the real function', async (_label, text, cursorLine) => {
		testState.queryEditors.query_1 = makeEditor(text, cursorLine);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let RealFunction = () { print real=1 };\nRealFunction()');
	});

	it.each([
		['line-commented fake function', '// .create function Fake() { print fake=1 }'],
		['block-commented fake function', '/* .create-or-alter function Fake() { print fake=1 } */'],
		['multiline-block-commented fake function', '/*\n.alter function Fake() { print fake=1 }\n*/'],
	])('does not execute a %s', async (_label, text) => {
		testState.queryEditors.query_1 = makeEditor(text);

		await executeRunFunction('query_1');

		expect(getExecuteMessages()).toHaveLength(0);
		expect(getInfoMessages()).toContainEqual({ type: 'showInfo', message: 'No function definition found in this section.' });
	});

	it('runs a parameterized function definition after a leading comment', async () => {
		testState.queryEditors.query_1 = makeEditor('// helper function\n.create function CommentedFunction(threshold:long) { range x from 1 to 10 step 1 | where x > threshold }');

		await executeRunFunction('query_1');
		await new Promise(resolve => setTimeout(resolve, 0));

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let CommentedFunction = (threshold:long) { range x from 1 to 10 step 1 | where x > threshold };\nCommentedFunction(5)');
	});

	it('keeps quoted parameter defaults with commas and equals signs as one dialog value', async () => {
		testState.queryEditors.query_1 = makeEditor('.create function LabelFunction(label:string = "a,b=c") { print label }');

		await executeRunFunction('query_1');
		await new Promise(resolve => setTimeout(resolve, 0));

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let LabelFunction = (label:string = "a,b=c") { print label };\nLabelFunction(5)');
	});

	it('falls back to the cursor line for semicolon-separated functions when statement bridges do not split them', async () => {
		const text = '.create function FirstFunction() { print first=1 };\n.create function SecondFunction() { print second=2 }';
		testState.queryEditors.query_1 = makeEditor(text, 2);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 2 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () { print second=2 };\nSecondFunction()');
	});

	it('uses the full multiline function body when the cursor is inside a semicolon-separated function body', async () => {
		const text = '.create function FirstFunction() {\nprint first=1\n};\n.create function SecondFunction() {\nprint second=2\n| extend doubled = second * 2\n}';
		testState.queryEditors.query_1 = makeEditor(text, 5);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 7 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () {\nprint second=2\n| extend doubled = second * 2\n};\nSecondFunction()');
	});

	it('uses cursor offsets correctly with CRLF text', async () => {
		const text = '.create function FirstFunction() {\r\nprint first=1\r\n};\r\n.create function SecondFunction() {\r\nprint second=2\r\n}';
		testState.queryEditors.query_1 = makeEditor(text, 5);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 6 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () {\nprint second=2\n};\nSecondFunction()');
	});

	it('preserves internal semicolons when the cursor is inside the selected function body', async () => {
		const text = '.create function FirstFunction() {\nprint first=1\n};\n.create function SecondFunction() {\nlet cutoff = 5;\nrange x from 1 to 10 step 1\n| where x > cutoff\n}';
		testState.queryEditors.query_1 = makeEditor(text, 5);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 8 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () {\nlet cutoff = 5;\nrange x from 1 to 10 step 1\n| where x > cutoff\n};\nSecondFunction()');
	});

	it('uses a selected function definition even when the cursor is outside the selection', async () => {
		const text = '.create function FirstFunction() {\nprint first=1\n};\n.create function SecondFunction() {\nlet cutoff = 5;\nrange x from 1 to 10 step 1\n| where x > cutoff\n}';
		const selection = {
			startLineNumber: 4,
			startColumn: 1,
			endLineNumber: 8,
			endColumn: 2,
			isEmpty: () => false,
		};
		testState.queryEditors.query_1 = makeEditor(text, 8, 2, selection);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 8 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () {\nlet cutoff = 5;\nrange x from 1 to 10 step 1\n| where x > cutoff\n};\nSecondFunction()');
	});

	it('uses a selected function even when statement bridges point at another block', async () => {
		const text = '.create function FirstFunction() { print first=1 }\n\n.create function SecondFunction() { print second=2 }';
		const selection = {
			startLineNumber: 3,
			startColumn: 1,
			endLineNumber: 3,
			endColumn: '.create function SecondFunction() { print second=2 }'.length + 1,
			isEmpty: () => false,
		};
		testState.queryEditors.query_1 = makeEditor(text, 3, selection.endColumn, selection);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 1 }, { startLine: 3, endLine: 3 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => '.create function FirstFunction() { print first=1 }');

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () { print second=2 };\nSecondFunction()');
	});

	it('uses the cursor column for same-line semicolon-separated function definitions', async () => {
		const text = '.create function FirstFunction() { print first=1 }; .create function SecondFunction() { print second=2 }';
		testState.queryEditors.query_1 = makeEditor(text, 1, text.indexOf('SecondFunction') + 2);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 1 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let SecondFunction = () { print second=2 };\nSecondFunction()');
	});

	it('uses the cursor column for the first function in same-line semicolon-separated definitions', async () => {
		const text = '.create function FirstFunction() { print first=1 }; .create function SecondFunction() { print second=2 }';
		testState.queryEditors.query_1 = makeEditor(text, 1, text.indexOf('FirstFunction') + 2);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 1 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		const messages = getExecuteMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].query).toBe('let FirstFunction = () { print first=1 };\nFirstFunction()');
	});

	it('does not guess the first function when the cursor is outside function definitions', async () => {
		const text = '.create function FirstFunction() { print first=1 };\n.create function SecondFunction() { print second=2 };\nSecondFunction()';
		testState.queryEditors.query_1 = makeEditor(text, 3, 2);
		(window as any).__kustoGetStatementBlocksFromModel = vi.fn(() => [{ startLine: 1, endLine: 3 }]);
		(window as any).__kustoExtractStatementTextAtCursor = vi.fn(() => text);

		await executeRunFunction('query_1');

		expect(getExecuteMessages()).toHaveLength(0);
		expect(getInfoMessages()).toContainEqual({ type: 'showInfo', message: 'No function definition found in this section.' });
	});
});