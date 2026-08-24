import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { __kustoAreEquivalentMonacoMarkers, __kustoAutocompleteSchemaTargetIdentityMatches, __kustoCommitWorkerMutation, __kustoComputeWebviewFocus, __kustoDetectStringPrefix, __kustoDiagnosticContextMatches, __kustoDiagnosticReadinessMatches, __kustoDisableMonacoKustoWorkerHover, __kustoFindLatestLetAssignmentEnd, __kustoGetColumnCompletionPipelineContext, __kustoGetColumnsByTable, __kustoIsPrimaryDiagnosticSchemaFresh, __kustoIsSupplementalDiagnosticStateReady, __kustoIsSupplementalNetworkRequestActive, __kustoIsTrueWindowFocusEvent, __kustoMergeFocusMarkerIntent, __kustoPlanDiagnosticPublication, __kustoPlanPreparationDiagnostics, __kustoPlanSupplementalBrokerRetirement, __kustoPlanSupplementalExpiration, __kustoShouldApplySupplementalRefresh, __kustoShouldJoinSupplementalBroker, __kustoShouldPublishDiagnostics, __kustoShouldReplayFocusedDiagnostics, __kustoTrackSupplementalReferences, KustoDiagnosticMarkerOwnership, KustoDiagnosticRevalidationCoordinator, KustoDiagnosticValidationRetryPolicy } from '../../src/webview/monaco/monaco.js';
import { __kustoNormalizeCollapsedMonacoMarkers } from '../../src/webview/monaco/marker-ranges.js';
import { getKustoSchemaIdentityKey } from '../../src/shared/kustoAuth.js';
import { KustoSupplementalSchemaCoordinator, supplementalStateIdentity } from '../../src/webview/shared/kusto-supplemental-schema-coordinator.js';

function makeMonacoModel(text: string) {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
	};
}

describe('__kustoCommitWorkerMutation', () => {
	it('advances completion generation only for a successful worker commit', () => {
		(window as any).__kustoSchemaCompletionGeneration = 0;
		const commit = vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(false);
		const transaction = { commit } as any;

		expect(__kustoCommitWorkerMutation(transaction, { destructive: true })).toBe(true);
		expect((window as any).__kustoSchemaCompletionGeneration).toBe(1);
		expect(__kustoCommitWorkerMutation(transaction)).toBe(false);
		expect((window as any).__kustoSchemaCompletionGeneration).toBe(1);
	});
});

// ── __kustoGetColumnsByTable ──────────────────────────────────────────────────

describe('__kustoGetColumnsByTable', () => {
	it('derives columns from columnTypesByTable', () => {
		const schema = {
			columnTypesByTable: {
				MyTable: { Name: 'string', Age: 'int', Timestamp: 'datetime' },
			},
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(result).toBeTruthy();
		expect(result.MyTable).toEqual(['Age', 'Name', 'Timestamp']); // sorted
	});

	it('returns null for null schema', () => {
		expect(__kustoGetColumnsByTable(null)).toBeNull();
	});

	it('returns null for non-object schema', () => {
		expect(__kustoGetColumnsByTable('not an object')).toBeNull();
	});

	it('prefers legacy columnsByTable when present', () => {
		const schema = {
			columnsByTable: { T: ['x', 'y'] },
			columnTypesByTable: { T: { a: 'string', b: 'int' } },
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(result).toEqual({ T: ['x', 'y'] });
	});

	it('handles empty columnTypesByTable', () => {
		const schema = { columnTypesByTable: {} };
		const result = __kustoGetColumnsByTable(schema);
		expect(result).toEqual({});
	});

	it('handles multiple tables', () => {
		const schema = {
			columnTypesByTable: {
				T1: { a: 'string', b: 'int' },
				T2: { x: 'real', y: 'datetime' },
			},
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(Object.keys(result)).toHaveLength(2);
		expect(result.T1).toEqual(['a', 'b']);
		expect(result.T2).toEqual(['x', 'y']);
	});

	it('returns null when no columnTypesByTable and no columnsByTable', () => {
		expect(__kustoGetColumnsByTable({})).toBeNull();
		expect(__kustoGetColumnsByTable({ tables: ['T'] })).toBeNull();
	});

	it('skips non-object table entries', () => {
		const schema = {
			columnTypesByTable: {
				T1: { a: 'string' },
				T2: null,
				T3: 'invalid',
			},
		};
		const result = __kustoGetColumnsByTable(schema);
		expect(result.T1).toEqual(['a']);
		expect(result).not.toHaveProperty('T2');
		expect(result).not.toHaveProperty('T3');
	});
});

describe('__kustoGetColumnCompletionPipelineContext', () => {
	it('finds the current let pipeline source inside a function body', () => {
		const beforeCursor = `.create-or-alter function F(startTime:datetime) {
let RemoteTools = dynamic(["tool"]);
let submcpinvoked=cluster('aoaiagents1.westus').database('prod').Log
| where TI`;

		expect(__kustoGetColumnCompletionPipelineContext(beforeCursor)).toEqual({
			operator: 'where',
			operatorTail: ' TI',
			sourceStage: "cluster('aoaiagents1.westus').database('prod').Log",
			priorStages: [],
		});
	});

	it('preserves prior pipeline stages for ordinary queries', () => {
		expect(__kustoGetColumnCompletionPipelineContext('Events\n| extend Alias = Name\n| project Al')).toEqual({
			operator: 'project',
			operatorTail: ' Al',
			sourceStage: 'Events',
			priorStages: ['extend Alias = Name'],
		});
	});

	it('ignores fake let assignments inside strings and comments', () => {
		const prefix = [
			"let source = cluster('remote').database('Db').Events",
			'| extend Quoted = "let fake =", Single = \'it\\\'s let other =\', Verbatim = @\'C:\\temp\\let verbatim = value\', Hidden = h@\'C:\\temp\\let hidden = value\', Triple = ```let triple = value```',
			'// let commented = Ignored',
			'/* let blocked = Ignored */',
			'| where ',
		].join('\n');
		const assignmentEnd = __kustoFindLatestLetAssignmentEnd(prefix);

		expect(prefix.slice(assignmentEnd).trimStart()).toMatch(/^cluster\('remote'\)/);
		expect(__kustoGetColumnCompletionPipelineContext(prefix)).toMatchObject({
			operator: 'where',
			operatorTail: ' ',
			sourceStage: "cluster('remote').database('Db').Events",
		});
	});

	it('detects ordinary, hidden, verbatim, and hidden-verbatim string prefixes', () => {
		expect(__kustoDetectStringPrefix("'value'", 0)).toEqual({ quote: "'", length: 1, verbatim: false });
		expect(__kustoDetectStringPrefix('h"value"', 0)).toEqual({ quote: '"', length: 2, verbatim: false });
		expect(__kustoDetectStringPrefix("@'C:\\temp\\'", 0)).toEqual({ quote: "'", length: 2, verbatim: true });
		expect(__kustoDetectStringPrefix('H@"C:\\temp\\"', 0)).toEqual({ quote: '"', length: 3, verbatim: true });
	});
});

describe('__kustoTrackSupplementalReferences', () => {
	it('tracks every parsed reference so diagnostics own reference seventeen and beyond', () => {
		const references = Array.from({ length: 17 }, (_, index) => `remote-${index + 1}`);

		expect(__kustoTrackSupplementalReferences(references)).toEqual(references);
	});

	it('bounds active network fetches after complete reference ownership is established', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const syncIndex = source.indexOf('const refs = __kustoTrackSupplementalReferences(', source.indexOf('function __kustoSyncSupplementalReferencesForBox'));
		const coordinatorIndex = source.indexOf('__kustoSupplementalCoordinator.syncReferences({', syncIndex);
		const requestIndex = source.indexOf('__kustoRequestCrossClusterSchema = function', coordinatorIndex);
		const activeFetchIndex = source.indexOf('activeFetchCount >= CROSS_CLUSTER_SCHEMA_MAX_ACTIVE_FETCHES', requestIndex);

		expect(syncIndex).toBeGreaterThan(-1);
		expect(coordinatorIndex).toBeGreaterThan(syncIndex);
		expect(activeFetchIndex).toBeGreaterThan(requestIndex);
	});

	it('joins autocomplete to a pending physical broker before creating another token', () => {
		expect(__kustoShouldJoinSupplementalBroker({ status: 'pending', requestToken: 'background' })).toBe(true);
		expect(__kustoShouldJoinSupplementalBroker({ status: 'loaded', refreshState: 'pending', requestToken: 'stale-refresh' })).toBe(true);
		expect(__kustoShouldJoinSupplementalBroker({ status: 'loaded', refreshState: 'failed', requestToken: 'stale-refresh' })).toBe(false);

		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const requestIndex = source.indexOf('__kustoRequestCrossClusterSchema = function');
		const pendingIndex = source.indexOf('if (__kustoShouldJoinSupplementalBroker(existing))', requestIndex);
		const joinIndex = source.indexOf("__kustoTraceCrossCluster('request-joined-existing'", pendingIndex);
		const returnIndex = source.indexOf('return;', joinIndex);
		const tokenIndex = source.indexOf("const requestToken = 'crosscluster_'", returnIndex);
		const escalationIndex = source.indexOf("__kustoTraceCrossCluster('request-escalated'", pendingIndex);

		expect(pendingIndex).toBeGreaterThan(requestIndex);
		expect(joinIndex).toBeGreaterThan(pendingIndex);
		expect(returnIndex).toBeGreaterThan(joinIndex);
		expect(tokenIndex).toBeGreaterThan(returnIndex);
		expect(escalationIndex === -1 || escalationIndex > tokenIndex).toBe(true);
	});

	it('enrolls failed same-key models and broadcasts accepted non-stale revisions', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const requestIndex = source.indexOf('__kustoRequestCrossClusterSchema = function');
		const joinIndex = source.indexOf('if (__kustoShouldJoinSupplementalBroker(existing))', requestIndex);
		const joinedFailedIndex = source.indexOf('includeFailed: true', joinIndex);
		const createIndex = source.indexOf("const requestToken = 'crosscluster_'", joinedFailedIndex);
		const createdFailedIndex = source.indexOf('includeFailed: true', createIndex);
		const handlerIndex = source.indexOf('export function __kustoHandleCrossClusterSchemaData');
		const broadcastIndex = source.indexOf('__kustoSupplementalCoordinator.markSchemaRefreshed(key)', handlerIndex);

		expect(joinedFailedIndex).toBeGreaterThan(joinIndex);
		expect(createdFailedIndex).toBeGreaterThan(createIndex);
		expect(broadcastIndex).toBeGreaterThan(handlerIndex);
		expect(__kustoShouldApplySupplementalRefresh(undefined, 'fresh')).toBe(true);
		expect(__kustoShouldApplySupplementalRefresh(undefined, 'client-cache')).toBe(true);
		expect(__kustoShouldApplySupplementalRefresh(undefined, 'disk-cache-stale')).toBe(false);
	});

	it('recovers failed siblings after a shared worker application succeeds', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const successIndex = source.indexOf('if (appliedCount > 0 && requestedUri && appliedToRequestedModel)');
		const loadedIndex = source.indexOf('__kustoSupplementalCoordinator.markLoaded({ modelUri: requestedUri', successIndex);
		const sharedIndex = source.indexOf('__kustoSupplementalCoordinator.adoptSharedApplication(key, requestedUri)', loadedIndex);
		const refilterIndex = source.indexOf('__kustoRefilterCurrentSupplementalMarkers(adopted.modelUri)', sharedIndex);
		const revalidateIndex = source.indexOf("__kustoRevalidateSupplementalModel(adopted.modelUri, 'supplemental-shared-loaded')", refilterIndex);

		expect(loadedIndex).toBeGreaterThan(successIndex);
		expect(sharedIndex).toBeGreaterThan(loadedIndex);
		expect(refilterIndex).toBeGreaterThan(sharedIndex);
		expect(revalidateIndex).toBeGreaterThan(refilterIndex);
	});

	it('rearms failed references from edit, focus, and connection recovery before pumping', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const helperIndex = source.indexOf('function __kustoRearmFailedSupplementalReferences(');
		const refilterIndex = source.indexOf('__kustoRefilterCurrentSupplementalMarkers(modelUri)', helperIndex);
		const editIndex = source.indexOf("__kustoRearmFailedSupplementalReferences(modelUri, 'edit')", helperIndex);
		const focusIndex = source.indexOf("__kustoRearmFailedSupplementalReferences(modelUri, 'focus')", editIndex);
		const connectionIndex = source.indexOf("__kustoRearmFailedSupplementalReferences(modelUri, 'connection-recovery')", helperIndex);

		expect(refilterIndex).toBeGreaterThan(helperIndex);
		expect(editIndex).toBeGreaterThan(helperIndex);
		expect(focusIndex).toBeGreaterThan(editIndex);
		expect(connectionIndex).toBeGreaterThan(helperIndex);
	});

	it('admits a retry key only after finding its synchronized coordinator state', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const contextBranch = source.slice(
			source.indexOf("recordAutocompleteTrace(traceId, 'schema-prepare-context'"),
			source.indexOf("recordAutocompleteTrace(traceId, 'schema-prepare-keys'"),
		);
		const stateLookup = contextBranch.lastIndexOf('const state = synchronizedStates.find');
		const untrackedGuard = contextBranch.indexOf('if (!state) continue;', stateLookup);
		const keyAdmission = contextBranch.indexOf('keys.push(key);', stateLookup);

		expect(stateLookup).toBeGreaterThan(-1);
		expect(untrackedGuard).toBeGreaterThan(stateLookup);
		expect(keyAdmission).toBeGreaterThan(untrackedGuard);
	});
});

// ── __kustoDisableMonacoKustoWorkerHover ─────────────────────────────────────

describe('__kustoDisableMonacoKustoWorkerHover', () => {
	it('disables only the monaco-kusto worker hover setting', () => {
		let applied: any = null;
		const settings = {
			includeControlCommands: true,
			newlineAfterPipe: true,
			enableHover: true,
			formatter: { indentationSize: 4, pipeOperatorStyle: 'Smart' },
			completionOptions: { includeExtendedSyntax: false },
		};
		const monacoApi = {
			languages: {
				kusto: {
					kustoDefaults: {
						languageSettings: settings,
						setLanguageSettings(next: any) {
							applied = next;
						},
					},
				},
			},
		};

		expect(__kustoDisableMonacoKustoWorkerHover(monacoApi)).toBe(true);
		expect(applied).toEqual({ ...settings, enableHover: false });
		expect(applied.formatter).toBe(settings.formatter);
		expect(applied.completionOptions).toBe(settings.completionOptions);
	});

	it('does not replace missing language settings with a partial object', () => {
		let called = false;
		const monacoApi = {
			languages: {
				kusto: {
					kustoDefaults: {
						languageSettings: null,
						setLanguageSettings() {
							called = true;
						},
					},
				},
			},
		};

		expect(__kustoDisableMonacoKustoWorkerHover(monacoApi)).toBe(false);
		expect(called).toBe(false);
	});

	it('is called before local Kusto hover registration during Monaco bootstrap', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const contributionLoadIndex = source.indexOf("['vs/language/kusto/monaco.contribution']");
		const disableCallIndex = source.indexOf('__kustoDisableMonacoKustoWorkerHover(monaco)', contributionLoadIndex);
		const localHoverIndex = source.indexOf("monaco.languages.registerHoverProvider('kusto'", contributionLoadIndex);

		expect(contributionLoadIndex).toBeGreaterThan(-1);
		expect(disableCallIndex).toBeGreaterThan(contributionLoadIndex);
		expect(localHoverIndex).toBeGreaterThan(disableCallIndex);
		expect(source).toContain('hover: { enabled: true, above: true, sticky: false }');
	});

	it('keeps the focused Kusto editor caret solid so hover widgets do not flicker on blink ticks', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const editorCreateIndex = source.indexOf('const editor = monaco.editor.create(container, {');
		const editorCreateEndIndex = source.indexOf('\n\t\t});', editorCreateIndex);
		const editorCreateBlock = source.slice(editorCreateIndex, editorCreateEndIndex);

		expect(editorCreateIndex).toBeGreaterThan(-1);
		expect(editorCreateEndIndex).toBeGreaterThan(editorCreateIndex);
		expect(editorCreateBlock).toContain("language: 'kusto'");
		expect(editorCreateBlock).toContain("cursorBlinking: 'solid'");
	});
});

describe('Kusto autocomplete schema retry', () => {
	it('keeps a retry current across canonical-equivalent database and cluster normalization', () => {
		const makeTarget = (clusterUrl: string, database: string) => ({
			sectionInstanceId: 'section-1',
			targetGeneration: 4,
			context: {
				connectionId: 'connection-1',
				accountPartition: 'partition-1',
				clusterUrl,
				database,
				schemaKey: getKustoSchemaIdentityKey('connection-1', 'partition-1', clusterUrl, database),
			},
		});
		const expected = makeTarget('https://aoaiagents1.westus', 'prod');

		expect(__kustoAutocompleteSchemaTargetIdentityMatches(
			expected,
			makeTarget('https://AOAIAGENTS1.WESTUS.kusto.windows.net/', 'Prod'),
		)).toBe(true);
		expect(__kustoAutocompleteSchemaTargetIdentityMatches(expected, makeTarget('https://aoaiagents1.westus', 'other'))).toBe(false);
	});

	it('installs the retry trigger before schema preparation can block the first request', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const triggerStart = source.indexOf('const __kustoTriggerAutocomplete = async (ed: any) => {');
		const requestClaimIndex = source.indexOf('request = boxId && schemaTarget ? __kustoAutocompleteRetryCoordinator.begin({', triggerStart);
		const retryTriggerIndex = source.indexOf('__kustoTriggerAutocompleteInternal = __kustoTriggerAutocomplete;', triggerStart);
		const schemaPreparationIndex = source.indexOf('const schemaState = await __kustoPrepareSchemaForAutocomplete(ed, traceId, request);', triggerStart);

		expect(triggerStart).toBeGreaterThan(-1);
		expect(requestClaimIndex).toBeGreaterThan(triggerStart);
		expect(retryTriggerIndex).toBeGreaterThan(triggerStart);
		expect(schemaPreparationIndex).toBeGreaterThan(requestClaimIndex);
		expect(schemaPreparationIndex).toBeGreaterThan(retryTriggerIndex);
	});

	it('binds every request to section lifecycle and concrete context when present', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const triggerStart = source.indexOf('const __kustoTriggerAutocomplete = async (ed: any) => {');
		const targetCapture = source.indexOf('__kustoCaptureAutocompleteSchemaTarget(boxId)', triggerStart);
		const requestBegin = source.indexOf('__kustoAutocompleteRetryCoordinator.begin({', triggerStart);
		const targetMatch = source.indexOf('__kustoAutocompleteSchemaTargetMatches(boxId, schemaTarget)', requestBegin);
		const lifecycleSubscription = source.indexOf('kustoEditorSchemaCoordinator.subscribeLifecycle', requestBegin);

		expect(targetCapture).toBeGreaterThan(triggerStart);
		expect(requestBegin).toBeGreaterThan(targetCapture);
		expect(targetMatch).toBeGreaterThan(requestBegin);
		expect(lifecycleSubscription).toBeGreaterThan(requestBegin);
		expect(source.slice(targetCapture, requestBegin + 80)).toContain('boxId && schemaTarget');
		expect(source).toContain("...(context ? { context: Object.freeze({ ...context }) } : {})");
		expect(source).toContain('!!current.context === !!expected.context');
	});

	it('queues a supplemental retry before showing cold no-context fallback', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const noContextStart = source.indexOf("recordAutocompleteTrace(traceId, 'schema-prepare-no-context'");
		const contextStart = source.indexOf("recordAutocompleteTrace(traceId, 'schema-prepare-context'", noContextStart);
		const noContextBranch = source.slice(noContextStart, contextStart);
		const quickWaitIndex = noContextBranch.indexOf("'schema-prepare-no-context-cross-cluster-wait'");
		const escalationIndex = noContextBranch.indexOf('__kustoSupplementalCoordinator.escalateToAutocomplete');
		const primaryReadyIndex = noContextBranch.indexOf('__kustoSupplementalCoordinator.setPrimaryReady(modelUri, true)');
		const retryIndex = noContextBranch.indexOf('__kustoQueueAutocompleteRetryForSupplementalSchemas(request, ed, boxId, modelUri, missingKeys)');
		const blockedIndex = noContextBranch.indexOf("return 'blocked'", retryIndex);
		const readyIndex = noContextBranch.indexOf("return 'ready'", retryIndex);

		expect(noContextStart).toBeGreaterThan(-1);
		expect(contextStart).toBeGreaterThan(noContextStart);
		expect(quickWaitIndex).toBeGreaterThan(-1);
		expect(escalationIndex).toBeGreaterThan(-1);
		expect(primaryReadyIndex).toBeGreaterThan(escalationIndex);
		expect(retryIndex).toBeGreaterThan(quickWaitIndex);
		expect(blockedIndex).toBe(-1);
		expect(readyIndex).toBeGreaterThan(retryIndex);
	});
});

// ── __kustoAreEquivalentMonacoMarkers ───────────────────────────────────────

describe('__kustoAreEquivalentMonacoMarkers', () => {
	it('treats repeated empty marker writes as equivalent', () => {
		expect(__kustoAreEquivalentMonacoMarkers([], [])).toBe(true);
	});

	it('ignores Monaco-owned metadata when comparing stored and incoming markers', () => {
		const current = [{
			owner: 'kusto',
			resource: { toString: () => 'inmemory://model.kusto' },
			severity: 8,
			message: 'Unknown column Foo',
			source: 'Kusto',
			code: { value: 'KS204', target: { toString: () => 'https://example.test/KS204' } },
			startLineNumber: 2,
			startColumn: 7,
			endLineNumber: 2,
			endColumn: 10,
			tags: [1],
			relatedInformation: [{
				resource: { toString: () => 'inmemory://model.kusto' },
				message: 'Related detail',
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 5,
			}],
		}];
		const next = [{
			severity: 8,
			message: 'Unknown column Foo',
			source: 'Kusto',
			code: { value: 'KS204', target: { toString: () => 'https://example.test/KS204' } },
			startLineNumber: 2,
			startColumn: 7,
			endLineNumber: 2,
			endColumn: 10,
			tags: [1],
			relatedInformation: [{
				resource: { toString: () => 'inmemory://model.kusto' },
				message: 'Related detail',
				startLineNumber: 1,
				startColumn: 1,
				endLineNumber: 1,
				endColumn: 5,
			}],
		}];

		expect(__kustoAreEquivalentMonacoMarkers(current, next)).toBe(true);
	});

	it('treats marker order changes as equivalent while preserving duplicates', () => {
		const markerA = { severity: 4, message: 'A', startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 2 };
		const markerB = { severity: 8, message: 'B', startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 2 };

		expect(__kustoAreEquivalentMonacoMarkers([markerA, markerB], [markerB, markerA])).toBe(true);
		expect(__kustoAreEquivalentMonacoMarkers([markerA, markerA], [markerA, markerB])).toBe(false);
	});

	it('detects real diagnostic changes', () => {
		const base = { severity: 8, message: 'Unknown column Foo', startLineNumber: 2, startColumn: 7, endLineNumber: 2, endColumn: 10 };

		expect(__kustoAreEquivalentMonacoMarkers([base], [{ ...base, message: 'Unknown column Bar' }])).toBe(false);
		expect(__kustoAreEquivalentMonacoMarkers([base], [{ ...base, startColumn: 8 }])).toBe(false);
		expect(__kustoAreEquivalentMonacoMarkers([base], [])).toBe(false);
	});

	it('fails open for non-array inputs', () => {
		expect(__kustoAreEquivalentMonacoMarkers([], null)).toBe(false);
		expect(__kustoAreEquivalentMonacoMarkers(null, [])).toBe(false);
	});

	it('routes untagged ordinary Kusto marker payloads through exact revalidation', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const interceptorIndex = source.indexOf("monaco.editor.setModelMarkers = function(model: any, owner: any, markers: any)");
		const planIndex = source.indexOf("__kustoPlanDiagnosticPublication('ordinary', canPublishKustoMarkers(model))", interceptorIndex);
		const refreshIndex = source.indexOf("__kustoScheduleSupplementalRevalidation(uri, 'ordinary-marker-refresh', 0)", planIndex);
		const stopIndex = source.indexOf('return;', refreshIndex);
		const nonKustoForwardIndex = source.indexOf('return originalSetModelMarkers.call(this, model, owner, markers)', stopIndex);

		expect(interceptorIndex).toBeGreaterThan(-1);
		expect(planIndex).toBeGreaterThan(interceptorIndex);
		expect(refreshIndex).toBeGreaterThan(planIndex);
		expect(stopIndex).toBeGreaterThan(refreshIndex);
		expect(nonKustoForwardIndex).toBeGreaterThan(stopIndex);
	});

	it('clears markers immediately after confirming a real Monaco widget blur', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const blurHandlerIndex = source.indexOf('editor.onDidBlurEditorWidget(() => {');
		const deferredCheckIndex = source.indexOf('setTimeout(() => {', blurHandlerIndex);
		const confirmedBlurIndex = source.indexOf('if (!stillFocused) {', deferredCheckIndex);
		const disableIndex = source.indexOf('__kustoDisableMarkersForModel(model.uri)', confirmedBlurIndex);
		const releaseOwnerIndex = source.indexOf('setActiveQueryEditorBoxId(null)', disableIndex);

		expect(blurHandlerIndex).toBeGreaterThan(-1);
		expect(deferredCheckIndex).toBeGreaterThan(blurHandlerIndex);
		expect(confirmedBlurIndex).toBeGreaterThan(deferredCheckIndex);
		expect(disableIndex).toBeGreaterThan(confirmedBlurIndex);
		expect(releaseOwnerIndex).toBeGreaterThan(disableIndex);
		expect(source).not.toContain('__kustoScheduleDisableMarkersForModel');
	});

	it('revokes every marker owner on webview blur and gates restoration through exact revalidation', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const helperIndex = source.indexOf('function __kustoApplyWebviewFocusState(focused: boolean)');
		const disableIndex = source.indexOf('__kustoDisableMarkersForModel(modelUri)', helperIndex);
		const focusScheduleIndex = source.indexOf('setTimeout(() => {', disableIndex);
		const revalidateIndex = source.indexOf('__kustoTriggerRevalidation?.(boxId)', focusScheduleIndex);
		const installIndex = source.indexOf('function __kustoInstallWebviewFocusListeners()', revalidateIndex);
		const blurIndex = source.indexOf("window.addEventListener('blur'", installIndex);
		const blurGuardIndex = source.indexOf('if (!__kustoIsTrueWindowFocusEvent(event.target, window)) return;', blurIndex);
		const blurStateIndex = source.indexOf('__kustoWindowHasFocus = __kustoReadDocumentHasFocus()', blurGuardIndex);
		const blurRefreshIndex = source.indexOf('__kustoRefreshWebviewFocusState()', blurStateIndex);
		const focusIndex = source.indexOf("window.addEventListener('focus'", blurRefreshIndex);
		const focusGuardIndex = source.indexOf('if (!__kustoIsTrueWindowFocusEvent(event.target, window)) return;', focusIndex);
		const focusStateIndex = source.indexOf('__kustoWindowHasFocus = __kustoReadDocumentHasFocus()', focusGuardIndex);
		const focusRefreshIndex = source.indexOf('__kustoRefreshWebviewFocusState()', focusStateIndex);

		expect(helperIndex).toBeGreaterThan(-1);
		expect(disableIndex).toBeGreaterThan(helperIndex);
		expect(focusScheduleIndex).toBeGreaterThan(disableIndex);
		expect(revalidateIndex).toBeGreaterThan(focusScheduleIndex);
		expect(installIndex).toBeGreaterThan(revalidateIndex);
		expect(blurIndex).toBeGreaterThan(installIndex);
		expect(blurGuardIndex).toBeGreaterThan(blurIndex);
		expect(blurStateIndex).toBeGreaterThan(blurGuardIndex);
		expect(blurRefreshIndex).toBeGreaterThan(blurStateIndex);
		expect(focusIndex).toBeGreaterThan(blurRefreshIndex);
		expect(focusGuardIndex).toBeGreaterThan(focusIndex);
		expect(focusStateIndex).toBeGreaterThan(focusGuardIndex);
		expect(focusRefreshIndex).toBeGreaterThan(focusStateIndex);
	});

	it('ignores descendant blur when cancelling an autocomplete retry', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const helperIndex = source.indexOf('function __kustoSubscribeAutocompleteRetryCancellation');
		const blurHandlerIndex = source.indexOf('const cancelOnWindowBlur = (event: FocusEvent) => {', helperIndex);
		const guardIndex = source.indexOf('if (!__kustoIsTrueWindowFocusEvent(event.target, window)) return;', blurHandlerIndex);
		const deferredIndex = source.indexOf('cancelIfUnfocused();', guardIndex);
		const webviewGateIndex = source.indexOf('if (!focused && !__kustoWebviewHasFocus) listener();', helperIndex);

		expect(blurHandlerIndex).toBeGreaterThan(helperIndex);
		expect(guardIndex).toBeGreaterThan(blurHandlerIndex);
		expect(deferredIndex).toBeGreaterThan(guardIndex);
		expect(webviewGateIndex).toBeGreaterThan(helperIndex);
	});

	it('routes ordinary and exact Kusto marker publication through the focus and readiness gate', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const gateIndex = source.indexOf('const canPublishKustoMarkers = (model: any): boolean =>');
		const exactPublisherIndex = source.indexOf('__kustoPublishExactKustoMarkers = (model: any, markers: any[]) =>', gateIndex);
		const exactGateIndex = source.indexOf("__kustoPlanDiagnosticPublication('exact', canPublishKustoMarkers(model))", exactPublisherIndex);
		const exactPublishIndex = source.indexOf("publication === 'publish' ? markers : []", exactGateIndex);
		const interceptorIndex = source.indexOf('monaco.editor.setModelMarkers = function(model: any, owner: any, markers: any)', exactPublishIndex);
		const ordinaryGateIndex = source.indexOf("__kustoPlanDiagnosticPublication('ordinary', canPublishKustoMarkers(model))", interceptorIndex);

		expect(gateIndex).toBeGreaterThan(-1);
		expect(exactPublisherIndex).toBeGreaterThan(gateIndex);
		expect(exactGateIndex).toBeGreaterThan(exactPublisherIndex);
		expect(exactPublishIndex).toBeGreaterThan(exactGateIndex);
		expect(interceptorIndex).toBeGreaterThan(exactPublishIndex);
		expect(ordinaryGateIndex).toBeGreaterThan(interceptorIndex);
	});

	it('enables and revalidates focused diagnostics only after exact worker readiness', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const updaterIndex = source.indexOf('__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true)');
		const readinessGateIndex = source.indexOf('isSchemaWorkerReady(boxId, expectedSchemaKey, focusedModelUri!)', updaterIndex);
		const enableIndex = source.indexOf('__kustoEnableMarkersForBox!(boxId)', readinessGateIndex);
		const revalidateIndex = source.indexOf('void __kustoRevalidateSupplementalModel(focusedModelUri!, reason)', enableIndex);

		expect(updaterIndex).toBeGreaterThan(-1);
		expect(readinessGateIndex).toBeGreaterThan(updaterIndex);
		expect(enableIndex).toBeGreaterThan(readinessGateIndex);
		expect(revalidateIndex).toBeGreaterThan(enableIndex);
	});

	it('retains the strongest marker intent across concurrent focus updates', () => {
		expect(__kustoMergeFocusMarkerIntent(undefined, false)).toBe(false);
		expect(__kustoMergeFocusMarkerIntent(false, true)).toBe(true);
		expect(__kustoMergeFocusMarkerIntent(true, false)).toBe(true);

		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const updaterIndex = source.indexOf('__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true)');
		const pendingIndex = source.indexOf('__kustoMergeFocusMarkerIntent(__kustoFocusUpdateRerunByBoxId[rerunKey], enableMarkers)', updaterIndex);
		const consumeIndex = source.indexOf('const rerunEnableMarkers = __kustoFocusUpdateRerunByBoxId[rerunKey]', pendingIndex);
		const rerunIndex = source.indexOf('__kustoUpdateSchemaForFocusedBox?.(boxId, rerunEnableMarkers)', consumeIndex);

		expect(pendingIndex).toBeGreaterThan(updaterIndex);
		expect(consumeIndex).toBeGreaterThan(pendingIndex);
		expect(rerunIndex).toBeGreaterThan(consumeIndex);
	});

	it('repumps fresh supplemental work after a stale apply releases its key lock', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const applyIndex = source.indexOf('function __kustoScheduleCrossClusterSchemaApply');
		const settleIndex = source.indexOf("}).then(lease => {", applyIndex);
		const catchIndex = source.indexOf('}).catch((e: any) => {', settleIndex);
		const settleBlock = source.slice(settleIndex, catchIndex);
		const finishIndex = settleBlock.lastIndexOf('finishJob();');
		const pumpIndex = settleBlock.indexOf('__kustoScheduleSupplementalPump(0);', finishIndex);
		const catchEndIndex = source.indexOf('\n\t\t});', catchIndex);
		const catchBlock = source.slice(catchIndex, catchEndIndex);
		const catchFinishIndex = catchBlock.indexOf('finishJob();');
		const catchPumpIndex = catchBlock.indexOf('__kustoScheduleSupplementalPump(0);', catchFinishIndex);

		expect(settleIndex).toBeGreaterThan(applyIndex);
		expect(finishIndex).toBeGreaterThan(-1);
		expect(pumpIndex).toBeGreaterThan(finishIndex);
		expect(catchIndex).toBeGreaterThan(settleIndex);
		expect(catchFinishIndex).toBeGreaterThan(-1);
		expect(catchPumpIndex).toBeGreaterThan(catchFinishIndex);
	});

	it('clears the previous editor markers before switching active diagnostic ownership', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const activateIndex = source.indexOf('const activateEditorFocus = () => {');
		const previousIndex = source.indexOf('const previousBoxId = activeQueryEditorBoxId', activateIndex);
		const disableIndex = source.indexOf('__kustoDisableMarkersForModel(previousModel.uri)', previousIndex);
		const setActiveIndex = source.indexOf('setActiveQueryEditorBoxId(boxId)', disableIndex);

		expect(activateIndex).toBeGreaterThan(-1);
		expect(previousIndex).toBeGreaterThan(activateIndex);
		expect(disableIndex).toBeGreaterThan(previousIndex);
		expect(setActiveIndex).toBeGreaterThan(disableIndex);
	});

	it('re-enters focused diagnostic publication after asynchronous preparation becomes ready', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const subscriptionIndex = source.indexOf('subscribeKustoPreparation(String(boxId), (preparation) => {');
		const readyIndex = source.indexOf("if (preparation.status === 'ready')", subscriptionIndex);
		const replayGateIndex = source.indexOf('__kustoShouldReplayFocusedDiagnostics({', readyIndex);
		const scheduleIndex = source.indexOf('setTimeout(() => {', replayGateIndex);
		const updateIndex = source.indexOf('__kustoTriggerRevalidation?.(boxId)', scheduleIndex);

		expect(subscriptionIndex).toBeGreaterThan(-1);
		expect(readyIndex).toBeGreaterThan(subscriptionIndex);
		expect(replayGateIndex).toBeGreaterThan(readyIndex);
		expect(scheduleIndex).toBeGreaterThan(replayGateIndex);
		expect(updateIndex).toBeGreaterThan(scheduleIndex);
	});

	it('revokes marker ownership whenever preparation is not ready', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const subscriptionIndex = source.indexOf('subscribeKustoPreparation(String(boxId), (preparation) => {');
		const notReadyTraceIndex = source.indexOf("__kustoTraceCrossCluster('preparation.primary-not-ready'", subscriptionIndex);
		const disableIndex = source.indexOf('__kustoDisableMarkersForModel(modelUri)', notReadyTraceIndex);

		expect(subscriptionIndex).toBeGreaterThan(-1);
		expect(notReadyTraceIndex).toBeGreaterThan(subscriptionIndex);
		expect(disableIndex).toBeGreaterThan(notReadyTraceIndex);
	});

	it('clears stale markers while retaining focus ownership on a ready signature mismatch', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const subscriptionIndex = source.indexOf('subscribeKustoPreparation(String(boxId), (preparation) => {');
		const mismatchIndex = source.indexOf("diagnosticPlan === 'clear-retain-focus'", subscriptionIndex);
		const clearIndex = source.indexOf('__kustoClearMarkersForModel(modelUri)', mismatchIndex);
		const disableIndex = source.indexOf('__kustoDisableMarkersForModel(modelUri)', mismatchIndex);
		const readyIndex = source.indexOf("__kustoTraceCrossCluster('preparation.primary-ready'", mismatchIndex);

		expect(mismatchIndex).toBeGreaterThan(subscriptionIndex);
		expect(clearIndex).toBeGreaterThan(mismatchIndex);
		expect(readyIndex).toBeGreaterThan(clearIndex);
		expect(disableIndex).toBeGreaterThan(readyIndex);
	});

	it('explicitly revalidates only after exact worker readiness', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const triggerIndex = source.indexOf('__kustoTriggerRevalidation = function(boxId: any)');
		const readinessIndex = source.indexOf('__kustoIsSupplementalPrimaryReady(modelUri)', triggerIndex);
		const enableIndex = source.indexOf('__kustoEnableMarkersForModel(modelUri)', readinessIndex);
		const exactValidationIndex = source.indexOf("__kustoRevalidateSupplementalModel(modelUri, 'explicit-worker-ready')", enableIndex);

		expect(triggerIndex).toBeGreaterThan(-1);
		expect(readinessIndex).toBeGreaterThan(triggerIndex);
		expect(enableIndex).toBeGreaterThan(readinessIndex);
		expect(exactValidationIndex).toBeGreaterThan(enableIndex);
	});

	it('commits pending worker readiness before requesting exact revalidation', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const flushIndex = source.indexOf('async function __kustoFlushPendingSchemaWorkerUpdateForBox');
		const readyIndex = source.indexOf('markSchemaWorkerReady(boxId, pending.schemaKey, pending.schemaSignature, modelUri, preparationToken)', flushIndex);
		const triggerIndex = source.indexOf('__kustoTriggerRevalidation(boxId)', readyIndex);

		expect(flushIndex).toBeGreaterThan(-1);
		expect(readyIndex).toBeGreaterThan(flushIndex);
		expect(triggerIndex).toBeGreaterThan(readyIndex);
	});

	it('requires the exact worker signature on the focused schema fast path', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const updaterIndex = source.indexOf('__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true)');
		const workerIndex = source.indexOf('const workerReadyState = getSchemaWorkerReadyState(String(boxId))', updaterIndex);
		const signatureIndex = source.indexOf('workerReadyState.schemaSignature === schemaSignature', workerIndex);
		const fastPathIndex = source.indexOf('if (!workerApplyRequired && baseWorkerReady && workerContextMatches)', signatureIndex);

		expect(updaterIndex).toBeGreaterThan(-1);
		expect(workerIndex).toBeGreaterThan(updaterIndex);
		expect(signatureIndex).toBeGreaterThan(workerIndex);
		expect(fastPathIndex).toBeGreaterThan(signatureIndex);
	});

	it('rebuilds incomplete preparation ownership before the focused worker fast path', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const updaterIndex = source.indexOf('__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true)');
		const targetMatchIndex = source.indexOf('const preparationTargetMatches = preparationState.target.connectionId === connectionId', updaterIndex);
		const restartIndex = source.indexOf('preparationToken = beginKustoPreparation(boxId, {', targetMatchIndex);
		const workerIndex = source.indexOf('const workerReadyState = getSchemaWorkerReadyState(String(boxId))', restartIndex);

		expect(targetMatchIndex).toBeGreaterThan(updaterIndex);
		expect(restartIndex).toBeGreaterThan(targetMatchIndex);
		expect(workerIndex).toBeGreaterThan(restartIndex);
	});

	it('requires a committed model context instead of accepting global context alone on focus', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const updaterIndex = source.indexOf('__kustoUpdateSchemaForFocusedBox = async function (boxId: any, enableMarkers = true)');
		const contextCheckIndex = source.indexOf('__kustoCommittedDiagnosticContextMatches(focusedModelUri, schemaKey)', updaterIndex);
		const switchIndex = source.indexOf('__kustoQueueDatabaseContextSwitch(', contextCheckIndex);

		expect(updaterIndex).toBeGreaterThan(-1);
		expect(contextCheckIndex).toBeGreaterThan(updaterIndex);
		expect(switchIndex).toBeGreaterThan(contextCheckIndex);
	});

	it('stamps same-database context adoption for the target identity and visibility generation', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const setterIndex = source.indexOf('__kustoSetDatabaseInContext = async function');
		const noOpIndex = source.indexOf('currentContext.database?.toLowerCase() === database?.toLowerCase()', setterIndex);
		const stampIndex = source.indexOf('const committedContext = {', noOpIndex);
		const schemaKeyIndex = source.indexOf('schemaKey: targetSchemaKey', stampIndex);
		const generationIndex = source.indexOf('visibilityGeneration: __kustoSchemaClearGeneration', schemaKeyIndex);
		const modelStampIndex = source.indexOf('__kustoMonacoDatabaseInContextByModel[modelKey] = committedContext', generationIndex);
		const globalStampIndex = source.indexOf('__kustoSchemaTracker.databaseInContext = committedContext', modelStampIndex);
		const returnIndex = source.indexOf('return true;', globalStampIndex);

		expect(setterIndex).toBeGreaterThan(-1);
		expect(noOpIndex).toBeGreaterThan(setterIndex);
		expect(stampIndex).toBeGreaterThan(noOpIndex);
		expect(schemaKeyIndex).toBeGreaterThan(stampIndex);
		expect(generationIndex).toBeGreaterThan(schemaKeyIndex);
		expect(modelStampIndex).toBeGreaterThan(generationIndex);
		expect(globalStampIndex).toBeGreaterThan(modelStampIndex);
		expect(returnIndex).toBeGreaterThan(globalStampIndex);
	});

	it('revokes on worker readiness loss and revalidates on an exact ready commit', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const subscriptionIndex = source.indexOf('subscribeSchemaWorkerReadyState(String(boxId), (worker) => {');
		const exactGateIndex = source.indexOf('const exactReady =', subscriptionIndex);
		const disableIndex = source.indexOf('__kustoDisableMarkersForModel(modelUri)', exactGateIndex);
		const enableIndex = source.indexOf('__kustoEnableMarkersForModel(modelUri)', disableIndex);
		const revalidateIndex = source.indexOf("__kustoRevalidateSupplementalModel(modelUri, 'worker-readiness-committed')", enableIndex);

		expect(subscriptionIndex).toBeGreaterThan(-1);
		expect(exactGateIndex).toBeGreaterThan(subscriptionIndex);
		expect(disableIndex).toBeGreaterThan(exactGateIndex);
		expect(enableIndex).toBeGreaterThan(disableIndex);
		expect(revalidateIndex).toBeGreaterThan(enableIndex);
	});
});

describe('__kustoDiagnosticReadinessMatches', () => {
	const ready = {
		modelUri: 'inmemory://model/1',
		contextSchemaKey: 'cluster|db',
		preparationStatus: 'ready',
		preparationSchemaKey: 'cluster|db',
		preparationSchemaSignature: 'sig-2',
		preparationModelUri: 'inmemory://model/1',
		workerStatus: 'ready',
		workerSchemaKey: 'cluster|db',
		workerSchemaSignature: 'sig-2',
		workerModelUri: 'inmemory://model/1',
	};

	it('requires the exact ready preparation and worker identity', () => {
		expect(__kustoDiagnosticReadinessMatches(ready)).toBe(true);
	});

	it.each([
		['preparation pending', { preparationStatus: 'preparing' }],
		['old worker signature', { workerSchemaSignature: 'sig-1' }],
		['wrong worker model', { workerModelUri: 'inmemory://model/old' }],
		['wrong preparation schema', { preparationSchemaKey: 'cluster|other' }],
	] as const)('rejects %s', (_label, override) => {
		expect(__kustoDiagnosticReadinessMatches({ ...ready, ...override })).toBe(false);
	});
});

describe('__kustoDiagnosticContextMatches', () => {
	const committed = {
		documentVisible: true,
		expectedSchemaKey: 'cluster|db',
		globalContextSchemaKey: 'cluster|db',
		modelContextSchemaKey: 'cluster|db',
		visibilityGeneration: 4,
		modelContextVisibilityGeneration: 4,
	};

	it('requires the actual global and model context from the current visibility generation', () => {
		expect(__kustoDiagnosticContextMatches(committed)).toBe(true);
	});

	it.each([
		['hidden document', { documentVisible: false }],
		['wrong global context', { globalContextSchemaKey: 'cluster|other' }],
		['wrong model context', { modelContextSchemaKey: 'cluster|other' }],
		['stale visibility generation', { modelContextVisibilityGeneration: 3 }],
	] as const)('rejects %s', (_label, override) => {
		expect(__kustoDiagnosticContextMatches({ ...committed, ...override })).toBe(false);
	});

	it('rechecks readiness after the physical hidden-worker clear settles', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const visibilityIndex = source.indexOf("document.addEventListener('visibilitychange'");
		const clearIndex = source.indexOf("kind: 'visibility-clear'", visibilityIndex);
		const finallyIndex = source.indexOf('finally {', clearIndex);
		const revokeIndex = source.indexOf('__kustoForgetAllSchemaWorkerReady(false)', finallyIndex);

		expect(visibilityIndex).toBeGreaterThan(-1);
		expect(clearIndex).toBeGreaterThan(visibilityIndex);
		expect(finallyIndex).toBeGreaterThan(clearIndex);
		expect(revokeIndex).toBeGreaterThan(finallyIndex);
	});
});

describe('__kustoComputeWebviewFocus', () => {
	it('requires both OS window focus and document visibility', () => {
		expect(__kustoComputeWebviewFocus(true, true)).toBe(true);
		expect(__kustoComputeWebviewFocus(false, true)).toBe(false);
		expect(__kustoComputeWebviewFocus(true, false)).toBe(false);
		expect(__kustoComputeWebviewFocus(false, false)).toBe(false);
	});

	it('accepts only focus events targeting the window itself', () => {
		const windowTarget = {};
		expect(__kustoIsTrueWindowFocusEvent(windowTarget, windowTarget)).toBe(true);
		expect(__kustoIsTrueWindowFocusEvent({}, windowTarget)).toBe(false);
		expect(__kustoIsTrueWindowFocusEvent(null, windowTarget)).toBe(false);
	});

	it('installs fail-closed focus listeners before query editor initialization', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const initialWindowIndex = source.indexOf('let __kustoWindowHasFocus = false');
		const initialVisibilityIndex = source.indexOf('let __kustoDocumentVisible = false', initialWindowIndex);
		const installIndex = source.indexOf('__kustoInstallWebviewFocusListeners();', initialVisibilityIndex);
		const editorInitIndex = source.indexOf('function initQueryEditor(boxId: any)');

		expect(initialWindowIndex).toBeGreaterThan(-1);
		expect(initialVisibilityIndex).toBeGreaterThan(initialWindowIndex);
		expect(installIndex).toBeGreaterThan(initialVisibilityIndex);
		expect(editorInitIndex).toBeGreaterThan(installIndex);
	});
});

describe('__kustoPlanPreparationDiagnostics', () => {
	it('retains focused ownership but clears markers for a ready signature mismatch', () => {
		expect(__kustoPlanPreparationDiagnostics('ready', false)).toBe('clear-retain-focus');
	});

	it('disables ownership for every non-ready preparation state', () => {
		for (const status of ['idle', 'preparing', 'deferred', 'error']) {
			expect(__kustoPlanPreparationDiagnostics(status, false)).toBe('clear-disable');
		}
	});

	it('admits diagnostics only for exact ready state', () => {
		expect(__kustoPlanPreparationDiagnostics('ready', true)).toBe('ready');
	});
});

describe('KustoDiagnosticMarkerOwnership', () => {
	it('clears an old-signature marker while retaining focused publication ownership', () => {
		const markers = new Map([['model', ['old schema error']]]);
		const ownership = new KustoDiagnosticMarkerOwnership(modelUri => markers.set(modelUri, []));
		ownership.enable('model');

		ownership.clear('model');

		expect(markers.get('model')).toEqual([]);
		expect(ownership.isEnabled('model')).toBe(true);
	});

	it('clears markers and revokes publication ownership on non-ready state or blur', () => {
		const markers = new Map([['model', ['visible error']]]);
		const ownership = new KustoDiagnosticMarkerOwnership(modelUri => markers.set(modelUri, []));
		ownership.enable('model');

		ownership.disable('model');

		expect(markers.get('model')).toEqual([]);
		expect(ownership.isEnabled('model')).toBe(false);
	});
});

describe('KustoDiagnosticRevalidationCoordinator', () => {
	it('runs one validation at a time and performs one rerun with the latest reason', async () => {
		const coordinator = new KustoDiagnosticRevalidationCoordinator();
		let finishFirst!: (value: boolean) => void;
		const reasons: string[] = [];
		const run = vi.fn((reason: string) => {
			reasons.push(reason);
			if (reasons.length === 1) return new Promise<boolean>(resolve => { finishFirst = resolve; });
			return Promise.resolve(true);
		});

		const first = coordinator.request('model', 'first', run, () => true);
		const second = coordinator.request('model', 'second', run, () => true);
		const latest = coordinator.request('model', 'latest', run, () => true);

		expect(second).toBe(first);
		expect(latest).toBe(first);
		expect(reasons).toEqual(['first']);
		finishFirst(true);
		await first;
		await Promise.resolve();

		expect(reasons).toEqual(['first', 'latest']);
	});

	it('drops a queued rerun when its model is disposed', async () => {
		const coordinator = new KustoDiagnosticRevalidationCoordinator();
		let finishFirst!: (value: boolean) => void;
		const run = vi.fn(() => new Promise<boolean>(resolve => { finishFirst = resolve; }));
		const first = coordinator.request('model', 'first', run, () => true);
		coordinator.request('model', 'queued', run, () => true);

		coordinator.dispose('model');
		finishFirst(true);
		await first;
		await Promise.resolve();

		expect(run).toHaveBeenCalledOnce();
	});
});

describe('KustoDiagnosticValidationRetryPolicy', () => {
	it('bounds retries for one identity and resets the budget for a new identity', () => {
		const policy = new KustoDiagnosticValidationRetryPolicy();

		expect(policy.nextDelay('model', 'identity-1', true)).toBe(100);
		expect(policy.nextDelay('model', 'identity-1', true)).toBe(300);
		expect(policy.nextDelay('model', 'identity-1', true)).toBe(700);
		expect(policy.nextDelay('model', 'identity-1', true)).toBeUndefined();
		expect(policy.nextDelay('model', 'identity-2', true)).toBe(100);
	});

	it('cancels and resets retries when focus or exact readiness is lost', () => {
		const policy = new KustoDiagnosticValidationRetryPolicy();
		expect(policy.nextDelay('model', 'identity', true)).toBe(100);

		expect(policy.nextDelay('model', 'identity', false)).toBeUndefined();
		expect(policy.nextDelay('model', 'identity', true)).toBe(100);
	});

	it('restarts an exhausted retry budget after an edit reset', () => {
		const policy = new KustoDiagnosticValidationRetryPolicy();
		for (const expected of [100, 300, 700]) {
			expect(policy.nextDelay('model', 'schema|version:1', true)).toBe(expected);
		}
		expect(policy.nextDelay('model', 'schema|version:1', true)).toBeUndefined();

		policy.reset('model');

		expect(policy.nextDelay('model', 'schema|version:2', true)).toBe(100);
	});

	it('wires validation failures to bounded scheduled retries', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const validationIndex = source.indexOf('async function __kustoRunSupplementalModelValidation');
		const catchIndex = source.indexOf("__kustoTraceCrossCluster('revalidation.error'", validationIndex);
		const policyIndex = source.indexOf('__kustoDiagnosticValidationRetryPolicy.nextDelay(', catchIndex);
		const scheduleIndex = source.indexOf("__kustoScheduleSupplementalRevalidation(modelUri, 'validation-error-retry', retryDelay)", policyIndex);

		expect(validationIndex).toBeGreaterThan(-1);
		expect(catchIndex).toBeGreaterThan(validationIndex);
		expect(policyIndex).toBeGreaterThan(catchIndex);
		expect(scheduleIndex).toBeGreaterThan(policyIndex);
	});

	it('resets delayed retries and schedules exact validation for focused-ready edited content', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const changeIndex = source.indexOf('editor.onDidChangeModelContent((e: any) => {');
		const cancelIndex = source.indexOf('delete __kustoSupplementalRevalidationTimeoutByModel[modelUri]', changeIndex);
		const resetIndex = source.indexOf('__kustoDiagnosticValidationRetryPolicy.reset(modelUri)', cancelIndex);
		const clearIndex = source.indexOf('__kustoClearMarkersForModel(modelUri)', resetIndex);
		const readinessIndex = source.indexOf('__kustoIsSupplementalPrimaryReady(modelUri)', clearIndex);
		const scheduleIndex = source.indexOf("__kustoScheduleSupplementalRevalidation(modelUri, 'content-changed', 0)", readinessIndex);

		expect(changeIndex).toBeGreaterThan(-1);
		expect(cancelIndex).toBeGreaterThan(changeIndex);
		expect(resetIndex).toBeGreaterThan(cancelIndex);
		expect(clearIndex).toBeGreaterThan(resetIndex);
		expect(readinessIndex).toBeGreaterThan(clearIndex);
		expect(scheduleIndex).toBeGreaterThan(readinessIndex);
	});
});

describe('__kustoPlanDiagnosticPublication', () => {
	it('publishes only exact diagnostics after the gate passes', () => {
		expect(__kustoPlanDiagnosticPublication('exact', true)).toBe('publish');
		expect(__kustoPlanDiagnosticPublication('ordinary', true)).toBe('revalidate');
	});

	it('actively clears both publication paths when the gate fails', () => {
		expect(__kustoPlanDiagnosticPublication('exact', false)).toBe('clear');
		expect(__kustoPlanDiagnosticPublication('ordinary', false)).toBe('clear');
	});
});

describe('__kustoShouldReplayFocusedDiagnostics', () => {
	const ready = {
		focused: true,
		isActiveBox: true,
		readinessIdentity: '[1,2,"schema","model"]',
		lastReplayedIdentity: '',
	};

	it('accepts a ready identity once and rejects its equivalent replay', () => {
		expect(__kustoShouldReplayFocusedDiagnostics(ready)).toBe(true);
		expect(__kustoShouldReplayFocusedDiagnostics({
			...ready,
			lastReplayedIdentity: ready.readinessIdentity,
		})).toBe(false);
	});

	it.each([
		['unfocused editor', { focused: false }],
		['inactive box', { isActiveBox: false }],
		['missing readiness identity', { readinessIdentity: '' }],
	] as const)('rejects %s', (_label, override) => {
		expect(__kustoShouldReplayFocusedDiagnostics({ ...ready, ...override })).toBe(false);
	});
});

describe('__kustoShouldPublishDiagnostics', () => {
	const ready = {
		boxId: 'query_1', modelUri: 'inmemory://query_1.kusto', activeBoxId: 'query_1',
		webviewFocused: true,
		diagnosticsTrusted: true, markersEnabled: true, editorOwnsModel: true,
		editorFocused: true, schemaKey: 'connection|account|cluster|database', workerReady: true,
		schemaFresh: true, supplementalReady: true,
	};

	it('allows diagnostics only for the focused exact-schema model', () => {
		expect(__kustoShouldPublishDiagnostics(ready)).toBe(true);
	});

	it.each([
		['blurred webview', { webviewFocused: false }],
		['unfocused section', { activeBoxId: 'query_2' }],
		['unfocused editor', { editorFocused: false }],
		['untrusted target', { diagnosticsTrusted: false }],
		['markers not enabled', { markersEnabled: false }],
		['replaced model', { editorOwnsModel: false }],
		['schema context missing', { schemaKey: '' }],
		['schema worker pending', { workerReady: false }],
		['primary refresh pending', { schemaFresh: false }],
		['supplemental schema pending', { supplementalReady: false }],
	] as const)('suppresses diagnostics for %s', (_label, override) => {
		expect(__kustoShouldPublishDiagnostics({ ...ready, ...override })).toBe(false);
	});
});

describe('Kusto diagnostic freshness', () => {
	it('keeps stale primary cache usable but not diagnostic-ready until refresh reaches a terminal state', () => {
		expect(__kustoIsPrimaryDiagnosticSchemaFresh({ refreshState: 'scheduled', isStale: true }, false)).toBe(false);
		expect(__kustoIsPrimaryDiagnosticSchemaFresh({ refreshState: 'completed' }, false)).toBe(true);
		expect(__kustoIsPrimaryDiagnosticSchemaFresh({ refreshState: 'failed', isStale: true }, false)).toBe(true);
		expect(__kustoIsPrimaryDiagnosticSchemaFresh({ refreshState: 'completed' }, true)).toBe(false);
	});

	it('requires every supplemental schema or refresh to reach loaded or terminal failure', () => {
		const loaded = { status: 'loaded' } as const;
		expect(__kustoIsSupplementalDiagnosticStateReady(loaded, { status: 'loaded', deliverySource: 'disk-cache-fresh' })).toBe(true);
		expect(__kustoIsSupplementalDiagnosticStateReady(loaded, { status: 'loaded', deliverySource: 'disk-cache-stale', refreshState: 'pending' })).toBe(false);
		expect(__kustoIsSupplementalDiagnosticStateReady(loaded, { status: 'loaded', deliverySource: 'disk-cache-stale', refreshState: 'failed' })).toBe(true);
		expect(__kustoIsSupplementalDiagnosticStateReady({ status: 'failed' }, undefined)).toBe(true);
		expect(__kustoIsSupplementalDiagnosticStateReady({ status: 'fetching' }, { status: 'pending' })).toBe(false);
	});

	it('counts stale-cache refreshes as active network requests after fallback delivery', () => {
		expect(__kustoIsSupplementalNetworkRequestActive({ status: 'pending' })).toBe(true);
		expect(__kustoIsSupplementalNetworkRequestActive({ status: 'loaded', refreshState: 'pending' })).toBe(true);
		expect(__kustoIsSupplementalNetworkRequestActive({ status: 'loaded', refreshState: 'completed' })).toBe(false);
		expect(__kustoIsSupplementalNetworkRequestActive({ status: 'loaded', refreshState: 'failed' })).toBe(false);
	});

	it('terminalizes timed-out stale fallback and reapplies a late fresh response', () => {
		const coordinator = new KustoSupplementalSchemaCoordinator();
		const reference = { schemaKey: 'remote|telemetry', clusterName: 'remote', database: 'Telemetry' };
		const scheduled = coordinator.syncReferences({
			boxId: 'query_1', modelUri: 'model://1', modelVersion: 1,
			primarySchemaKey: 'primary|db', references: [reference], now: 10,
		}).added[0];
		coordinator.markFetching(supplementalStateIdentity(scheduled), {
			requestToken: 'stale-load', requestSource: 'background', deadlineAt: 20, now: 11,
		});
		coordinator.markFetchedByRequest('stale-load', 12);
		coordinator.setPrimaryReady('model://1', true, 13);
		const initialCandidate = coordinator.getApplyCandidates(reference.schemaKey)[0];
		coordinator.markApplying(supplementalStateIdentity(initialCandidate), 30, 14);
		coordinator.markLoaded(supplementalStateIdentity(initialCandidate), 15);
		const refresh = coordinator.refreshWithAutocomplete(supplementalStateIdentity(initialCandidate), 16)!;
		coordinator.markFetching(supplementalStateIdentity(refresh), {
			requestToken: 'refresh-token', requestSource: 'autocomplete', deadlineAt: 50,
			preserveFetchedAvailable: true, now: 17,
		});

		expect(coordinator.expire(50)[0]).toMatchObject({ status: 'loaded', fetchedAvailable: true });
		const retirement = __kustoPlanSupplementalBrokerRetirement({
			status: 'pending', deadlineAt: 50, hasLiveSubscriber: false, hasFallback: true, now: 50,
		});
		expect(retirement).toEqual({ action: 'retain-terminal-fallback', failureKind: 'fetch-timeout' });
		const broker = {
			status: 'loaded', refreshState: 'failed', requestToken: 'refresh-token',
			rawSchemaJson: { Databases: {} }, deliverySource: 'disk-cache-stale',
		} as const;
		expect(__kustoIsSupplementalDiagnosticStateReady(coordinator.getState('model://1', reference.schemaKey)!, broker)).toBe(true);
		expect(__kustoIsSupplementalNetworkRequestActive(broker)).toBe(false);
		expect(__kustoShouldApplySupplementalRefresh(broker, 'fresh')).toBe(true);
		expect(coordinator.markSchemaRefreshed(reference.schemaKey, undefined, 60)[0]).toMatchObject({
			status: 'fetched', fetchedAvailable: true,
		});

		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const handlerIndex = source.indexOf('export function __kustoHandleCrossClusterSchemaData');
		const detectIndex = source.indexOf('const refreshesRetainedFallback = __kustoShouldApplySupplementalRefresh', handlerIndex);
		const overwriteIndex = source.indexOf('broker.deliverySource = message.deliverySource', detectIndex);
		const refreshIndex = source.indexOf('__kustoSupplementalCoordinator.markSchemaRefreshed(key)', overwriteIndex);
		expect(detectIndex).toBeGreaterThan(handlerIndex);
		expect(overwriteIndex).toBeGreaterThan(detectIndex);
		expect(refreshIndex).toBeGreaterThan(overwriteIndex);
	});

	it('fences apply timeout behind worker recovery while other terminals revalidate immediately', () => {
		expect(__kustoPlanSupplementalExpiration('apply-timeout')).toBe('fence-recovery');
		expect(__kustoPlanSupplementalExpiration('fetch-timeout')).toBe('revalidate');
		expect(__kustoPlanSupplementalExpiration('fetch-failed')).toBe('revalidate');
	});

	it('orders apply-timeout marker recovery after detached worker recovery', () => {
		const source = readFileSync(join(process.cwd(), 'src/webview/monaco/monaco.ts'), 'utf8');
		const timeoutIndex = source.indexOf('onTimeout: () => {', source.indexOf('function __kustoScheduleCrossClusterSchemaApply'));
		const fenceIndex = source.indexOf('__kustoFenceSupplementalApplyRecovery(modelUri', timeoutIndex);
		const detachedIndex = source.indexOf('onDetachedSettled: async recoveryTransaction => {', fenceIndex);
		const recoverIndex = source.indexOf('await __kustoRecoverPrimarySchemaAfterDetachedMutation', detachedIndex);
		const revalidateIndex = source.indexOf("__kustoRevalidateSupplementalModel(modelUri, 'apply-timeout-recovered')", recoverIndex);

		expect(fenceIndex).toBeGreaterThan(timeoutIndex);
		expect(detachedIndex).toBeGreaterThan(fenceIndex);
		expect(recoverIndex).toBeGreaterThan(detachedIndex);
		expect(revalidateIndex).toBeGreaterThan(recoverIndex);
	});
});

// ── __kustoNormalizeCollapsedMonacoMarkers ─────────────────────────────────

describe('__kustoNormalizeCollapsedMonacoMarkers', () => {
	it('expands an EOF collapsed marker backward over the trailing operator', () => {
		const line = '| project It, ExpectedValue, ActualValue, Passed+';
		const model = makeMonacoModel(`print Passed = true\n${line}`);
		const eofColumn = line.length + 1;
		const marker = {
			severity: 8,
			message: 'Missing expression',
			code: 'KS006',
			startLineNumber: 2,
			startColumn: eofColumn,
			endLineNumber: 2,
			endColumn: eofColumn,
			source: 'Kusto',
		};
		const markers = [marker];

		const normalized = __kustoNormalizeCollapsedMonacoMarkers(model, markers);

		expect(normalized).not.toBe(markers);
		expect(normalized[0]).toMatchObject({
			severity: 8,
			message: 'Missing expression',
			code: 'KS006',
			source: 'Kusto',
			startLineNumber: 2,
			startColumn: eofColumn - 1,
			endLineNumber: 2,
			endColumn: eofColumn,
		});
		expect(marker.startColumn).toBe(eofColumn);
		expect(line[normalized[0].startColumn as number - 1]).toBe('+');
	});

	it('expands a token-start collapsed marker forward', () => {
		const marker = {
			message: 'Missing expression',
			startLineNumber: 1,
			startColumn: 7,
			endLineNumber: 1,
			endColumn: 7,
		};

		const normalized = __kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel('print value'), [marker]);

		expect(normalized[0]).toMatchObject({
			startLineNumber: 1,
			startColumn: 7,
			endLineNumber: 1,
			endColumn: 8,
		});
		expect(marker.endColumn).toBe(7);
	});

	it('expands a whitespace-gap collapsed marker to the nearest visible character', () => {
		const marker = {
			message: 'Missing expression',
			startLineNumber: 1,
			startColumn: 6,
			endLineNumber: 1,
			endColumn: 6,
		};

		const normalized = __kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel('abc     def'), [marker]);

		expect(normalized[0]).toMatchObject({
			startLineNumber: 1,
			startColumn: 3,
			endLineNumber: 1,
			endColumn: 4,
		});
	});

	it('keeps non-collapsed markers and empty marker arrays unchanged', () => {
		const model = makeMonacoModel('print value');
		const marker = {
			message: 'Already visible',
			startLineNumber: 1,
			startColumn: 1,
			endLineNumber: 1,
			endColumn: 6,
		};
		const markers = [marker];
		const empty: typeof markers = [];

		expect(__kustoNormalizeCollapsedMonacoMarkers(model, markers)).toBe(markers);
		expect(__kustoNormalizeCollapsedMonacoMarkers(model, empty)).toBe(empty);
	});

	it('leaves collapsed markers unchanged when the line has no visible character', () => {
		const marker = {
			message: 'Missing expression',
			startLineNumber: 1,
			startColumn: 2,
			endLineNumber: 1,
			endColumn: 2,
		};
		const markers = [marker];

		expect(__kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel('   '), markers)).toBe(markers);
	});
});
