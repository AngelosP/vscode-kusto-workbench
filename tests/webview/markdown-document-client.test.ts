import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as ts from 'typescript';

const { postMessageToHost } = vi.hoisted(() => ({ postMessageToHost: vi.fn() }));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({ postMessageToHost }));

import { parseDocumentViewHostMessage } from '../../src/shared/documentViewProtocol.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	acknowledgeHostOwnedDocumentOrder,
	adoptHostOwnedMarkdownDocument,
	getHostOwnedDevelopmentNoteSections,
	getOptimisticHostOwnedDevelopmentNoteSections,
	getHostOwnedDocumentSectionStatus,
	handleHostOwnedMarkdownCommandResult,
	requestHostOwnedChartAdd,
	requestHostOwnedChartPatch,
	requestHostOwnedChartRemove,
	requestHostOwnedDevelopmentNoteAdd,
	requestHostOwnedDevelopmentNotePatch,
	requestHostOwnedHtmlAdd,
	requestHostOwnedHtmlPatch,
	requestHostOwnedHtmlPublishInfoPatch,
	requestHostOwnedHtmlRemove,
	requestHostOwnedMarkdownAdd,
	requestHostOwnedMarkdownPatch,
	requestHostOwnedMarkdownRemove,
	requestHostOwnedPythonAdd,
	requestHostOwnedPythonPatch,
	requestHostOwnedPythonRemove,
	requestHostOwnedTransformationAdd,
	requestHostOwnedTransformationPatch,
	requestHostOwnedTransformationRemove,
	requestHostOwnedUrlAdd,
	requestHostOwnedUrlPatch,
	requestHostOwnedUrlRemove,
	resetHostOwnedMarkdownDocument,
	waitForHostOwnedMarkdownCommands,
} from '../../src/webview/core/markdown-document-client.js';

async function waitForPostedMessage(count: number): Promise<any> {
	for (let attempt = 0; attempt < 20 && postMessageToHost.mock.calls.length < count; attempt++) await Promise.resolve();
	return postMessageToHost.mock.calls[count - 1]?.[0];
}

const helperPath = resolve(process.cwd(), 'src/webview/core/test-helpers.ts');
const helperSource = ts.createSourceFile(helperPath, readFileSync(helperPath, 'utf8'), ts.ScriptTarget.Latest, true);
const helperNames = [
	'TEST_SECTION_SELECTOR', 'clickTestSectionClose', 'e2eDelay', 'e2eClearSectionsStable',
	'e2eDocumentCommandAcceptance',
	'e2eDocumentCommandCapture', 'e2eBeginDocumentCommandCapture', 'e2eWaitForDocumentCommands',
	'__testRemoveAllSections', 'E2E_LAYOUT_RESULT_SECTION_ID', 'E2E_LAYOUT_SPECS', 'e2eLayoutSpec',
	'e2eLayoutDelay', 'e2eLayoutWaitFor', 'e2eLayoutGeneratedLines', 'e2eLayoutAddSection',
	'e2eLayoutHtmlPreviewCode', 'e2eLayoutSampleResult', 'e2eLayoutCreateStressNotebook',
];
const helperCode = ts.transpileModule(helperNames.map(name => {
	const statement = helperSource.statements.find(candidate =>
		(ts.isFunctionDeclaration(candidate) && candidate.name?.text === name)
		|| (ts.isVariableStatement(candidate) && candidate.declarationList.declarations.some(declaration =>
			ts.isIdentifier(declaration.name) && declaration.name.text === name))
		|| (ts.isExpressionStatement(candidate) && ts.isBinaryExpression(candidate.expression)
			&& ts.isPropertyAccessExpression(candidate.expression.left)
			&& candidate.expression.left.expression.getText(helperSource) === '_win'
			&& candidate.expression.left.name.text === name));
	if (!statement) throw new Error(`E2E helper declaration not found: ${name}`);
	return statement.getText(helperSource);
}).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;

function loadDocumentHelpers() {
	const originalProperties = new Map([
		'__e2eCaptureHostMessage', '__testRemoveAllSections', 'addQueryBox', 'addSqlBox', 'addChartBox', 'addMarkdownBox',
		'addTransformationBox', 'addUrlBox', 'addHtmlBox', 'addPythonBox',
	].map(name => [name, Object.getOwnPropertyDescriptor(window, name)]));
	let suppressed = false;
	const suppressPersistence = vi.fn((value: boolean) => { suppressed = value; });
	const adoptClean = vi.fn();
	const seedResult = vi.fn();
	const helpers = new Function(
		'pState', '_win', 'isPersistenceSuppressedForTest', 'suppressPersistenceForTest',
		'adoptCurrentStateAsCleanForTest', 'waitForHostOwnedMarkdownCommands', 'e2eSeedQueryResult',
		`${helperCode}\nreturn {
			clearSections: e2eClearSectionsStable,
			beginCapture: e2eBeginDocumentCommandCapture,
			waitForCommands: e2eWaitForDocumentCommands,
			createStressNotebook: e2eLayoutCreateStressNotebook,
			capture: () => e2eDocumentCommandCapture,
		};`,
	)(pState, window, () => suppressed, suppressPersistence, adoptClean, waitForHostOwnedMarkdownCommands, seedResult) as {
		clearSections(timeoutMs?: number, quietMs?: number): Promise<string>;
		beginCapture(): string;
		waitForCommands(minimumCount?: number, timeoutMs?: number): Promise<unknown>;
		createStressNotebook(requireChartReady?: boolean): Promise<string>;
		capture(): { onMessage: (event: MessageEvent) => void; commands: unknown[]; results: unknown[] } | undefined;
	};
	return {
		...helpers, suppressPersistence, adoptClean, seedResult,
		dispose: () => {
			const capture = helpers.capture();
			if (capture) window.removeEventListener('message', capture.onMessage);
			for (const [name, descriptor] of originalProperties) {
				if (descriptor) Object.defineProperty(window, name, descriptor);
				else Reflect.deleteProperty(window, name);
			}
		},
	};
}

function observeHelper<Result>(promise: Promise<Result>) {
	const settled = vi.fn();
	const result = promise.then(value => ({ value }), error => ({ error })).then(outcome => {
		settled(outcome);
		return outcome;
	});
	return { result, settled };
}

function deliverDocumentResult(message: unknown) {
	const admission = handleHostOwnedMarkdownCommandResult(message);
	window.dispatchEvent(new MessageEvent('message', { data: message }));
	return admission;
}

describe('host-owned Markdown command client', () => {
	beforeEach(() => {
		postMessageToHost.mockReset();
		resetHostOwnedMarkdownDocument();
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.restoreInProgress = false;
		pState.documentRuntimeActive = true;
		pState.applyingHostMarkdownProjection = false;
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 7,
			sectionRevisions: { markdown_1: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [{ id: 'markdown_1', type: 'markdown', text: 'before', expanded: true, mode: 'wysiwyg' }],
		});
	});

	afterEach(() => resetHostOwnedMarkdownDocument());

	it('keeps actual E2E cleanup pending beyond DOM removal before recreating the same section ID', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
		const applyCount = pState.documentDataApplyCount;
		pState.documentDataApplyCount = 1;
		const runtimeWindow = window as unknown as { __e2eCaptureHostMessage?: (message: unknown) => unknown };
		const previousCapture = runtimeWindow.__e2eCaptureHostMessage;
		postMessageToHost.mockImplementation(message => runtimeWindow.__e2eCaptureHostMessage?.(message));
		const helpers = loadDocumentHelpers();
		const section = document.createElement('kw-markdown-section');
		section.id = 'markdown_1';
		const shell = document.createElement('kw-section-shell');
		section.attachShadow({ mode: 'open' }).append(shell);
		const close = document.createElement('button');
		close.className = 'close-btn';
		shell.attachShadow({ mode: 'open' }).append(close);
		close.addEventListener('click', () => {
			requestHostOwnedMarkdownRemove(section.id);
			section.remove();
		});
		document.body.append(section);
		let settled = false;
		const cleanup = helpers.clearSections(2_000).then(
			value => { settled = true; return { value }; },
			error => { settled = true; return { error }; },
		);
		const recreated = document.createElement('kw-markdown-section');
		try {
			const remove = await waitForPostedMessage(1);
			expect(remove).toMatchObject({ command: { type: 'remove', sectionId: 'markdown_1' } });
			expect(section.isConnected).toBe(false);
			let barrierSettled = false;
			const barrier = waitForHostOwnedMarkdownCommands().then(accepted => {
				barrierSettled = true;
				return accepted;
			});
			await vi.advanceTimersByTimeAsync(1_000);
			expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('present');
			expect(barrierSettled).toBe(false);
			expect(settled, 'DOM emptiness must not complete cleanup before the host remove is admitted').toBe(false);
			expect(helpers.adoptClean).not.toHaveBeenCalled();

			const result = {
				type: 'markdownDocumentCommandResult', commandId: remove.commandId, ok: true, sourceGeneration: 7,
				projection: {
					documentRevision: 1, sectionRevisions: {}, markdownSectionRevisions: {},
					markdownSections: [], urlSections: [], orderedSectionIds: [],
				},
			};
			expect(handleHostOwnedMarkdownCommandResult(result)).toMatchObject({ handled: true, accepted: true });
			window.dispatchEvent(new MessageEvent('message', { data: result }));
			await vi.advanceTimersByTimeAsync(900);
			await expect(barrier).resolves.toBe(true);
			expect(await cleanup).toEqual({ value: expect.stringContaining('removed 1 sections') });
			expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('absent');
			expect(helpers.adoptClean).toHaveBeenCalledOnce();
			expect(helpers.suppressPersistence.mock.calls).toEqual([[true], [false]]);

			const replacement = { id: 'markdown_1', type: 'markdown' as const, text: 'recreated' };
			expect(requestHostOwnedMarkdownAdd(replacement)).toBe(true);
			recreated.id = replacement.id;
			recreated.textContent = replacement.text;
			document.body.append(recreated);
			const add = await waitForPostedMessage(2);
			expect(add).toMatchObject({ expectedDocumentRevision: 1, command: { type: 'add', section: replacement } });
			expect(handleHostOwnedMarkdownCommandResult({
				type: 'markdownDocumentCommandResult', commandId: add.commandId, ok: true, sourceGeneration: 7,
				projection: {
					documentRevision: 2, sectionRevisions: { markdown_1: 1 }, markdownSectionRevisions: { markdown_1: 1 },
					markdownSections: [replacement], urlSections: [], orderedSectionIds: ['markdown_1'],
				},
			})).toMatchObject({ handled: true, accepted: true });
			await expect(waitForHostOwnedMarkdownCommands()).resolves.toBe(true);
			expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('present');
			expect(pState.hostOwnedMarkdownSections.markdown_1.text).toBe('recreated');
			expect(document.getElementById('markdown_1')).toBe(recreated);
		} finally {
			resetHostOwnedMarkdownDocument();
			await vi.advanceTimersByTimeAsync(2_100);
			await cleanup;
			section.remove();
			recreated.remove();
			pState.documentDataApplyCount = applyCount;
			if (previousCapture) runtimeWindow.__e2eCaptureHostMessage = previousCapture;
			else delete runtimeWindow.__e2eCaptureHostMessage;
			helpers.dispose();
			vi.useRealTimers();
		}
	});

	describe('actual E2E document helpers', () => {
		let helpers: ReturnType<typeof loadDocumentHelpers>;
		let container: HTMLElement;
		let applyCount: number;
		const emptyProjection = {
			documentRevision: 1, sectionRevisions: {}, markdownSectionRevisions: {},
			markdownSections: [], urlSections: [], orderedSectionIds: [],
		};

		beforeEach(() => {
			vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
			applyCount = pState.documentDataApplyCount;
			pState.documentDataApplyCount = 1;
			helpers = loadDocumentHelpers();
			postMessageToHost.mockImplementation(message => {
				const capture = Reflect.get(window, '__e2eCaptureHostMessage');
				return typeof capture === 'function' ? capture(message) : undefined;
			});
			container = document.createElement('div');
			document.body.append(container);
		});

		afterEach(async () => {
			resetHostOwnedMarkdownDocument();
			await vi.advanceTimersByTimeAsync(11_000);
			helpers.dispose();
			container.remove();
			pState.documentDataApplyCount = applyCount;
			vi.useRealTimers();
		});

		function seedSection(id = 'markdown_1') {
			const state = { id, type: 'markdown' as const, text: 'before', expanded: true, mode: 'wysiwyg' as const };
			expect(adoptHostOwnedMarkdownDocument({
				documentRevision: 0, sourceGeneration: 7,
				sectionRevisions: { [id]: 0 }, markdownSectionRevisions: { [id]: 0 },
			}, { sections: [state] })).toBe(true);
			const section = document.createElement('kw-markdown-section');
			section.id = id;
			const shell = document.createElement('kw-section-shell');
			section.attachShadow({ mode: 'open' }).append(shell);
			const close = document.createElement('button');
			close.className = 'close-btn';
			shell.attachShadow({ mode: 'open' }).append(close);
			close.addEventListener('click', () => {
				requestHostOwnedMarkdownRemove(id);
				section.remove();
			});
			container.append(section);
			return {
				documentRevision: 0, sectionRevisions: { [id]: 0 }, markdownSectionRevisions: { [id]: 0 },
				markdownSections: [state], urlSections: [], orderedSectionIds: [id],
			};
		}

		function prepareLayoutFactories() {
			expect(adoptHostOwnedMarkdownDocument({
				documentRevision: 0, sourceGeneration: 7, sectionRevisions: {}, markdownSectionRevisions: {},
			}, { sections: [] })).toBe(true);
			const previousCapture = vi.fn();
			Reflect.set(window, '__e2eCaptureHostMessage', previousCapture);
			for (const [name, tag] of [['addQueryBox', 'kw-query-section'], ['addSqlBox', 'kw-sql-section']]) {
				Reflect.set(window, name, (options: { id: string }) => {
					const section = document.createElement(tag);
					section.id = options.id;
					container.append(section);
					expect(acknowledgeHostOwnedDocumentOrder(Array.from(container.children, child => child.id))).toBe(true);
					return section.id;
				});
			}
			const factoryCalls = vi.fn();
			const factories: [string, string, (options: { id: string }) => boolean][] = [
				['addChartBox', 'chart', options => requestHostOwnedChartAdd({ ...options, type: 'chart' })],
				['addMarkdownBox', 'markdown', options => requestHostOwnedMarkdownAdd({ ...options, type: 'markdown' })],
				['addTransformationBox', 'transformation', options => requestHostOwnedTransformationAdd({ ...options, type: 'transformation' })],
				['addUrlBox', 'url', options => requestHostOwnedUrlAdd({ ...options, type: 'url' })],
				['addHtmlBox', 'html', options => requestHostOwnedHtmlAdd({ ...options, type: 'html' })],
				['addPythonBox', 'python', options => requestHostOwnedPythonAdd({ ...options, type: 'python' })],
			];
			for (const [name, kind, request] of factories) {
				Reflect.set(window, name, (options: { id: string }) => {
					factoryCalls(kind, options);
					const section = document.createElement(`kw-${kind}-section`);
					section.id = options.id;
					container.append(section);
					expect(request(options)).toBe(true);
					return section.id;
				});
			}
			return { previousCapture, factoryCalls };
		}

		function layoutCommands() {
			return postMessageToHost.mock.calls.map(([message]) => message)
				.filter(message => message.type === 'markdownDocumentCommand');
		}

		function layoutAddResult(commandIndex: number, ok = true, projectedCount = commandIndex + 1) {
			const commands = layoutCommands();
			const sections = commands.slice(0, projectedCount).map(command => command.command.section);
			const markdownSections = sections.filter(section => section.type === 'markdown');
			return {
				type: 'markdownDocumentCommandResult', commandId: commands[commandIndex].commandId,
				ok, sourceGeneration: 7,
				projection: {
					documentRevision: projectedCount,
					sectionRevisions: Object.fromEntries(sections.map(section => [section.id, 1])),
					markdownSectionRevisions: Object.fromEntries(markdownSections.map(section => [section.id, 1])),
					markdownSections,
					chartSections: sections.filter(section => section.type === 'chart'),
					transformationSections: sections.filter(section => section.type === 'transformation'),
					urlSections: sections.filter(section => section.type === 'url'),
					htmlSections: sections.filter(section => section.type === 'html'),
					pythonSections: sections.filter(section => section.type === 'python'),
					orderedSectionIds: ['e2e_layout_query', 'e2e_layout_sql', ...sections.map(section => section.id)],
				},
			};
		}

		it('rejects cleanup after a rejected removal even when the client reconciles an unblocked projection', async () => {
			const projection = seedSection();
			const recreate = vi.fn();
			const cleanup = observeHelper(helpers.clearSections(2_000).then(recreate));
			const remove = await waitForPostedMessage(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(recreate).not.toHaveBeenCalled();
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: false, sourceGeneration: 7, projection,
			})).toMatchObject({ handled: true, accepted: false });
			await vi.advanceTimersByTimeAsync(0);
			await expect(cleanup.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/rejected/i) } });
			expect(recreate).not.toHaveBeenCalled();
			expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('present');
			expect(helpers.adoptClean).not.toHaveBeenCalled();
			expect(helpers.suppressPersistence.mock.calls).toEqual([[true], [false]]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([false, true])('completes cleanup only for accepted hidden-note commands between quiet polls (accepted=%s)', async accepted => {
			seedSection();
			const cleanup = observeHelper(helpers.clearSections(2_000));
			const remove = await waitForPostedMessage(1);
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: true, sourceGeneration: 7, projection: emptyProjection,
			})).toMatchObject({ handled: true, accepted: true });
			await vi.advanceTimersByTimeAsync(150);
			expect(cleanup.settled).not.toHaveBeenCalled();
			expect(container.children).toHaveLength(0);
			const noteSection = { id: 'devnotes_between_polls', type: 'devnotes' as const, entries: [] };
			const noteSettlement = requestHostOwnedDevelopmentNoteAdd(noteSection);
			const note = await waitForPostedMessage(2);
			expect(note).toMatchObject({ expectedDocumentRevision: 1, command: { type: 'add' } });
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: note.commandId,
				ok: accepted, sourceGeneration: 7, documentRevision: accepted ? 2 : 1,
				...(!accepted ? { error: { code: 'stale-document-revision', message: 'rejected between cleanup polls' } } : {}),
				projection: accepted ? {
					...emptyProjection, documentRevision: 2, sectionRevisions: { [noteSection.id]: 1 },
					developmentNoteSections: [noteSection], orderedSectionIds: [noteSection.id],
				} : emptyProjection,
			})).toMatchObject({ handled: true, accepted });
			await expect(noteSettlement).resolves.toBe(accepted);
			await expect(waitForHostOwnedMarkdownCommands()).resolves.toBe(true);
			await vi.advanceTimersByTimeAsync(800);
			if (accepted) {
				await expect(cleanup.result).resolves.toEqual({ value: expect.stringContaining('removed 1 sections') });
				expect(helpers.adoptClean).toHaveBeenCalledOnce();
			} else {
				await expect(cleanup.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/rejected/i) } });
				expect(helpers.adoptClean).not.toHaveBeenCalled();
			}
			expect(helpers.suppressPersistence.mock.calls).toEqual([[true], [false]]);
			expect(postMessageToHost).toHaveBeenCalledTimes(2);
			expect(getHostOwnedDevelopmentNoteSections()).toEqual(accepted ? [noteSection] : []);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('waits for actual client work even when transport does not reach the capture hook', async () => {
			seedSection();
			postMessageToHost.mockImplementationOnce(() => undefined);
			const cleanup = observeHelper(helpers.clearSections(2_000));
			const remove = await waitForPostedMessage(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(cleanup.settled).not.toHaveBeenCalled();
			expect(helpers.adoptClean).not.toHaveBeenCalled();
			expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('present');
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: true, sourceGeneration: 7, projection: emptyProjection,
			})).toMatchObject({ handled: true, accepted: true });
			await vi.advanceTimersByTimeAsync(900);
			await expect(cleanup.result).resolves.toEqual({ value: expect.stringContaining('removed 1 sections') });
			expect(helpers.adoptClean).toHaveBeenCalledOnce();
			expect(helpers.suppressPersistence.mock.calls).toEqual([[true], [false]]);
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([false, true])('bounds cleanup at its deadline and preserves prior suppression=%s', async alreadySuppressed => {
			seedSection();
			if (alreadySuppressed) helpers.suppressPersistence(true);
			helpers.suppressPersistence.mockClear();
			const cleanup = observeHelper(helpers.clearSections(1_200, 100));
			const remove = await waitForPostedMessage(1);
			await vi.advanceTimersByTimeAsync(1_199);
			expect(cleanup.settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(cleanup.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/timed out/i) } });
			expect(helpers.suppressPersistence.mock.calls).toEqual(alreadySuppressed ? [] : [[true], [false]]);
			expect(helpers.adoptClean).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(1);
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: true, sourceGeneration: 7, projection: emptyProjection,
			})).toMatchObject({ handled: true, accepted: true });
			await vi.advanceTimersByTimeAsync(1_000);
			expect(cleanup.settled).toHaveBeenCalledOnce();
			expect(helpers.adoptClean).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		});

		it('rejects captured raw success when the actual client rejects its projection', async () => {
			const projection = seedSection();
			helpers.beginCapture();
			requestHostOwnedMarkdownRemove('markdown_1');
			const remove = await waitForPostedMessage(1);
			const waiting = observeHelper(helpers.waitForCommands(1, 800));
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: true, sourceGeneration: 7, projection,
			})).toEqual({ handled: true, accepted: false });
			await vi.advanceTimersByTimeAsync(400);
			await expect(waiting.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/rejected/i) } });
			expect(postMessageToHost).toHaveBeenCalledWith({ type: 'requestDocument' });
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBeUndefined();
			expect(vi.getTimerCount()).toBe(0);
		});

		it('rejects capture retired before waiting despite a canonical late success from its old source', async () => {
			const previousSessionId = pState.documentViewSessionId;
			const envelope = { protocolVersion: 1, channel: 'document-view', viewSessionId: 'capture-view' };
			pState.documentViewSessionId = envelope.viewSessionId;
			postMessageToHost.mockImplementation(message => {
				const capture = Reflect.get(window, '__e2eCaptureHostMessage');
				return typeof capture === 'function' ? capture({ ...message, ...envelope }) : undefined;
			});
			try {
				helpers.beginCapture();
				expect(requestHostOwnedMarkdownRemove('markdown_1')).toBe(true);
				const remove = await waitForPostedMessage(1);
				expect(remove).toMatchObject({ sourceGeneration: 7, expectedDocumentRevision: 0 });
				expect(adoptHostOwnedMarkdownDocument({
					documentRevision: 0, sourceGeneration: 8,
					sectionRevisions: { markdown_1: 0 }, markdownSectionRevisions: { markdown_1: 0 },
				}, { sections: [{ id: 'markdown_1', type: 'markdown', text: 'replacement source' }] })).toBe(true);
				const waiting = observeHelper(helpers.waitForCommands(1, 1_000));
				const lateSuccess = {
					...envelope, type: 'markdownDocumentCommandResult', commandId: remove.commandId,
					ok: true, sourceGeneration: 7, documentRevision: 1, projection: emptyProjection,
				};
				expect(parseDocumentViewHostMessage(lateSuccess).ok).toBe(true);
				expect(deliverDocumentResult(lateSuccess)).toEqual({ handled: false, accepted: false });
				await vi.advanceTimersByTimeAsync(300);
				await expect(waiting.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/rejected|retired/i) } });
				expect(pState.markdownSourceGeneration).toBe(8);
				expect(pState.markdownDocumentRevision).toBe(0);
				expect(pState.hostOwnedMarkdownSections.markdown_1.text).toBe('replacement source');
				expect(helpers.capture()).toBeUndefined();
				expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBeUndefined();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				pState.documentViewSessionId = previousSessionId;
			}
		});

		it.each([false, true])('keeps a completed capture fenced to its starting view session (retired=%s)', async retired => {
			const previousSessionId = pState.documentViewSessionId;
			const envelope = { protocolVersion: 1, channel: 'document-view', viewSessionId: 'completed-view' };
			pState.documentViewSessionId = envelope.viewSessionId;
			postMessageToHost.mockImplementation(message => {
				const capture = Reflect.get(window, '__e2eCaptureHostMessage');
				return typeof capture === 'function' ? capture({ ...message, ...envelope }) : undefined;
			});
			try {
				helpers.beginCapture();
				expect(requestHostOwnedMarkdownRemove('markdown_1')).toBe(true);
				const remove = await waitForPostedMessage(1);
				const result = {
					...envelope, type: 'markdownDocumentCommandResult', commandId: remove.commandId,
					ok: true, sourceGeneration: 7, documentRevision: 1, projection: emptyProjection,
				};
				expect(parseDocumentViewHostMessage(result).ok).toBe(true);
				expect(deliverDocumentResult(result)).toMatchObject({ handled: true, accepted: true });
				if (retired) pState.documentViewSessionId = 'replacement-view';
				const waiting = observeHelper(helpers.waitForCommands(1, 1_000));
				await vi.advanceTimersByTimeAsync(300);
				if (retired) {
					await expect(waiting.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/rejected|retired/i) } });
				} else {
					await expect(waiting.result).resolves.toMatchObject({ value: {
						commandIds: [remove.commandId], results: [{ commandId: remove.commandId, ok: true }],
					} });
				}
				expect(pState.markdownSourceGeneration).toBe(7);
				expect(pState.markdownDocumentRevision).toBe(1);
				expect(helpers.capture()).toBeUndefined();
				expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBeUndefined();
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				pState.documentViewSessionId = previousSessionId;
			}
		});

		it('requires client admission and reports only exact captured commands despite stale and duplicate replies', async () => {
			const previousCapture = vi.fn();
			const envelope = { protocolVersion: 1, channel: 'document-view', viewSessionId: 'current-view' };
			Reflect.set(window, '__e2eCaptureHostMessage', previousCapture);
			postMessageToHost.mockImplementation(message => {
				const capture = Reflect.get(window, '__e2eCaptureHostMessage');
				return typeof capture === 'function' ? capture({ ...message, ...envelope }) : undefined;
			});
			helpers.beginCapture();
			requestHostOwnedMarkdownRemove('markdown_1');
			const remove = await waitForPostedMessage(1);
			const waiting = observeHelper(helpers.waitForCommands(1, 1_000));
			const result = {
				...envelope,
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: true, sourceGeneration: 7, projection: emptyProjection,
			};
			expect(deliverDocumentResult({ ...result, commandId: 'stale-rejection', ok: false }).handled).toBe(false);
			expect(deliverDocumentResult({ ...result, commandId: 'unrelated-success' }).handled).toBe(false);
			for (const staleIdentity of [
				{ viewSessionId: 'retired-view' }, { channel: 'unrelated' }, { protocolVersion: 0 }, { sourceGeneration: 6 },
			]) {
				window.dispatchEvent(new MessageEvent('message', { data: { ...result, ...staleIdentity, ok: false } }));
			}
			window.dispatchEvent(new MessageEvent('message', { data: result }));
			await vi.advanceTimersByTimeAsync(400);
			expect(waiting.settled, 'a raw reply cannot substitute for client admission').not.toHaveBeenCalled();
			expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('present');
			expect(deliverDocumentResult(result)).toMatchObject({ handled: true, accepted: true });
			expect(deliverDocumentResult(result).handled).toBe(false);
			await vi.advanceTimersByTimeAsync(300);
			await expect(waiting.result).resolves.toEqual({ value: {
				commandIds: [remove.commandId],
				commands: [{ commandId: remove.commandId, type: 'remove', sectionId: 'markdown_1', sectionType: '' }],
				results: [{ commandId: remove.commandId, ok: true, orderedSectionIds: [], markdownSectionIds: [], htmlSectionIds: [] }],
			} });
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(previousCapture).toHaveBeenCalledWith({ ...remove, ...envelope });
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([false, true])('enforces a cleanup deadline between polling ticks with restoreInProgress=%s', async restoring => {
			pState.restoreInProgress = restoring;
			const cleanup = observeHelper(helpers.clearSections(125));
			try {
				await vi.advanceTimersByTimeAsync(124);
				expect(cleanup.settled).not.toHaveBeenCalled();
				await vi.advanceTimersByTimeAsync(1);
				expect(cleanup.settled).toHaveBeenCalledOnce();
				await expect(cleanup.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/timed out/i) } });
				expect(helpers.adoptClean).not.toHaveBeenCalled();
				expect(helpers.suppressPersistence.mock.calls).toEqual([[true], [false]]);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				pState.restoreInProgress = false;
			}
		});

		it('times out a pending client barrier and detaches capture before a late valid result', async () => {
			helpers.beginCapture();
			requestHostOwnedMarkdownRemove('markdown_1');
			const remove = await waitForPostedMessage(1);
			const capture = helpers.capture()!;
			const waiting = observeHelper(helpers.waitForCommands(1, 400));
			await vi.advanceTimersByTimeAsync(399);
			expect(waiting.settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(waiting.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/timed out/i) } });
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBeUndefined();
			expect(vi.getTimerCount()).toBe(1);
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: true, sourceGeneration: 7, projection: emptyProjection,
			})).toMatchObject({ handled: true, accepted: true });
			await vi.advanceTimersByTimeAsync(300);
			expect(capture.results).toEqual([]);
			expect(waiting.settled).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([true, false])('gates the actual layout factory on cleanup admission=%s', async accepted => {
			const projection = seedSection('e2e_layout_markdown');
			const factoryStop = new Error('layout factory boundary reached');
			const addQuery = vi.fn(() => { throw factoryStop; });
			Reflect.set(window, 'addQueryBox', addQuery);
			const layout = observeHelper(helpers.createStressNotebook(false));
			const remove = await waitForPostedMessage(1);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(addQuery, 'layout recreation must not start while the old owner remains').not.toHaveBeenCalled();
			expect(getHostOwnedDocumentSectionStatus('e2e_layout_markdown')).toBe('present');
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: remove.commandId,
				ok: accepted, sourceGeneration: 7, projection: accepted ? emptyProjection : projection,
			})).toMatchObject({ handled: true, accepted });
			await vi.advanceTimersByTimeAsync(900);
			if (accepted) {
				await expect(layout.result).resolves.toEqual({ error: factoryStop });
				expect(addQuery).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'e2e_layout_query' }));
				expect(getHostOwnedDocumentSectionStatus('e2e_layout_markdown')).toBe('absent');
			} else {
				await expect(layout.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/rejected/i) } });
				expect(addQuery).not.toHaveBeenCalled();
			}
			expect(helpers.capture()).toBeUndefined();
		});

		it('waits for the first host Add acceptance before calling the second layout factory', async () => {
			adoptHostOwnedMarkdownDocument({
				documentRevision: 0, sourceGeneration: 7, sectionRevisions: {}, markdownSectionRevisions: {},
			}, { sections: [] });
			const previousCapture = vi.fn();
			Reflect.set(window, '__e2eCaptureHostMessage', previousCapture);
			for (const [name, tag] of [['addQueryBox', 'kw-query-section'], ['addSqlBox', 'kw-sql-section']]) {
				Reflect.set(window, name, (options: { id: string }) => {
					const section = document.createElement(tag);
					section.id = options.id;
					container.append(section);
					return section.id;
				});
			}
			Reflect.set(window, 'addChartBox', (options: { id: string }) => {
				expect(requestHostOwnedChartAdd({ ...options, type: 'chart' })).toBe(true);
				return options.id;
			});
			const factoryStop = new Error('second layout factory reached');
			const addMarkdown = vi.fn(() => { throw factoryStop; });
			Reflect.set(window, 'addMarkdownBox', addMarkdown);
			const layout = observeHelper(helpers.createStressNotebook(false));
			await vi.advanceTimersByTimeAsync(900);
			const add = await waitForPostedMessage(1);
			expect(add).toMatchObject({ command: { type: 'add', section: { id: 'e2e_layout_chart', type: 'chart' } } });
			await vi.advanceTimersByTimeAsync(999);
			expect(addMarkdown, 'the second factory must not run before response 1 is accepted').not.toHaveBeenCalled();
			expect(layout.settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			expect(deliverDocumentResult({
				type: 'markdownDocumentCommandResult', commandId: add.commandId, ok: true, sourceGeneration: 7,
				projection: {
					...emptyProjection, chartSections: [add.command.section],
					sectionRevisions: { e2e_layout_chart: 1 }, orderedSectionIds: ['e2e_layout_chart'],
				},
			})).toMatchObject({ handled: true, accepted: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(addMarkdown).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 'e2e_layout_markdown' }));
			await expect(layout.result).resolves.toEqual({ error: factoryStop });
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('retains all six accepted layout Adds across a serial one-second host queue', async () => {
			const { previousCapture, factoryCalls } = prepareLayoutFactories();
			const transport = postMessageToHost.getMockImplementation()!;
			const admissions: ReturnType<typeof deliverDocumentResult>[] = [];
			let hostAvailableAt = performance.now();
			postMessageToHost.mockImplementation(message => {
				const captured = transport(message);
				if (message.type === 'markdownDocumentCommand') {
					const commandIndex = layoutCommands().length - 1;
					hostAvailableAt = Math.max(hostAvailableAt, performance.now()) + 1_000;
					setTimeout(() => admissions.push(deliverDocumentResult(layoutAddResult(commandIndex))), hostAvailableAt - performance.now());
				}
				return captured;
			});
			const resultBoundary = new Error('layout result seeding boundary reached');
			helpers.seedResult.mockRejectedValue(resultBoundary);
			const layout = observeHelper(helpers.createStressNotebook(false));
			await vi.advanceTimersByTimeAsync(900);
			const capture = helpers.capture()!;
			for (let commandIndex = 0; commandIndex < 6; commandIndex++) {
				expect(factoryCalls).toHaveBeenCalledTimes(commandIndex + 1);
				await vi.advanceTimersByTimeAsync(1_000);
				expect(admissions).toHaveLength(commandIndex + 1);
				expect(admissions[commandIndex]).toMatchObject({ handled: true, accepted: true });
			}
			await vi.advanceTimersByTimeAsync(249);
			expect(helpers.seedResult).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(layout.result).resolves.toEqual({ error: resultBoundary });
			const commands = layoutCommands();
			expect(commands).toHaveLength(6);
			expect(commands.map(command => command.expectedDocumentRevision)).toEqual([0, 1, 2, 3, 4, 5]);
			expect(factoryCalls.mock.calls.map(([kind]) => kind)).toEqual(['chart', 'markdown', 'transformation', 'url', 'html', 'python']);
			expect(capture.commands).toEqual(JSON.parse(JSON.stringify(commands)));
			expect(capture.results).toEqual(JSON.parse(JSON.stringify(commands.map((_command, index) => layoutAddResult(index)))));
			expect(Array.from(container.children, section => section.id)).toEqual([
				'e2e_layout_query', 'e2e_layout_sql', 'e2e_layout_chart', 'e2e_layout_markdown',
				'e2e_layout_transformation', 'e2e_layout_url', 'e2e_layout_html', 'e2e_layout_python',
			]);
			expect(helpers.seedResult).toHaveBeenCalledOnce();
			await expect(waitForHostOwnedMarkdownCommands()).resolves.toBe(true);
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([false, true])('stops layout factories when the second Add is not accepted despite raw ok=%s', async ok => {
			const { previousCapture, factoryCalls } = prepareLayoutFactories();
			const layout = observeHelper(helpers.createStressNotebook(false));
			await vi.advanceTimersByTimeAsync(900);
			expect(deliverDocumentResult(layoutAddResult(0))).toMatchObject({ handled: true, accepted: true });
			await vi.advanceTimersByTimeAsync(0);
			expect(factoryCalls).toHaveBeenCalledTimes(2);
			expect(deliverDocumentResult(layoutAddResult(1, ok, 1))).toMatchObject({ handled: true, accepted: false });
			await vi.advanceTimersByTimeAsync(0);
			await expect(layout.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/did not accept.*e2e_layout_markdown/) } });
			await expect(waitForHostOwnedMarkdownCommands()).resolves.toBe(!ok);
			expect(factoryCalls).toHaveBeenCalledTimes(2);
			expect(helpers.seedResult).not.toHaveBeenCalled();
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(vi.getTimerCount()).toBe(0);
		});

		it('keeps the layout Add client timeout fatal at exactly five seconds', async () => {
			const { previousCapture, factoryCalls } = prepareLayoutFactories();
			const layout = observeHelper(helpers.createStressNotebook(false));
			await vi.advanceTimersByTimeAsync(900);
			const capture = helpers.capture()!;
			await vi.advanceTimersByTimeAsync(4_999);
			expect(layout.settled).not.toHaveBeenCalled();
			expect(factoryCalls).toHaveBeenCalledTimes(1);
			await vi.advanceTimersByTimeAsync(1);
			await expect(layout.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/did not accept.*e2e_layout_chart/) } });
			expect(deliverDocumentResult(layoutAddResult(0))).toEqual({ handled: false, accepted: false });
			expect(capture.results).toEqual([]);
			expect(factoryCalls).toHaveBeenCalledTimes(1);
			expect(helpers.seedResult).not.toHaveBeenCalled();
			expect(layout.settled).toHaveBeenCalledOnce();
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(vi.getTimerCount()).toBe(0);
		});

		it.each([
			{ phase: 'pending Add', delay: 4_500, acceptedCount: 4, factoryCount: 5 },
			{ phase: 'final verification', delay: 3_300, acceptedCount: 6, factoryCount: 6 },
		])('shares the twenty-second layout deadline through $phase', async ({ delay, acceptedCount, factoryCount }) => {
			const { previousCapture, factoryCalls } = prepareLayoutFactories();
			const layout = observeHelper(helpers.createStressNotebook(false));
			await vi.advanceTimersByTimeAsync(900);
			const deadline = performance.now() + 20_000;
			const capture = helpers.capture()!;
			for (let commandIndex = 0; commandIndex < acceptedCount; commandIndex++) {
				await vi.advanceTimersByTimeAsync(delay);
				expect(deliverDocumentResult(layoutAddResult(commandIndex))).toMatchObject({ handled: true, accepted: true });
				await vi.advanceTimersByTimeAsync(0);
			}
			await vi.advanceTimersByTimeAsync(deadline - performance.now() - 1);
			expect(layout.settled).not.toHaveBeenCalled();
			await vi.advanceTimersByTimeAsync(1);
			await expect(layout.result).resolves.toMatchObject({ error: { message: expect.stringMatching(/timed out/i) } });
			expect(factoryCalls).toHaveBeenCalledTimes(factoryCount);
			expect(helpers.capture()).toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(vi.getTimerCount()).toBe(factoryCount - acceptedCount);
			if (factoryCount > acceptedCount) {
				expect(deliverDocumentResult(layoutAddResult(acceptedCount))).toMatchObject({ handled: true, accepted: true });
			}
			await vi.advanceTimersByTimeAsync(300);
			expect(capture.results).toHaveLength(acceptedCount);
			expect(factoryCalls).toHaveBeenCalledTimes(factoryCount);
			expect(helpers.seedResult).not.toHaveBeenCalled();
			expect(layout.settled).toHaveBeenCalledOnce();
			expect(vi.getTimerCount()).toBe(0);
		});

		it('cleans layout-owned capture when a section factory throws before the command wait', async () => {
			adoptHostOwnedMarkdownDocument({
				documentRevision: 0, sourceGeneration: 7, sectionRevisions: {}, markdownSectionRevisions: {},
			}, { sections: [] });
			const previousCapture = vi.fn();
			Reflect.set(window, '__e2eCaptureHostMessage', previousCapture);
			for (const [name, tag] of [['addQueryBox', 'kw-query-section'], ['addSqlBox', 'kw-sql-section']]) {
				Reflect.set(window, name, (options: { id: string }) => {
					const section = document.createElement(tag);
					section.id = options.id;
					container.append(section);
					return section.id;
				});
			}
			const factoryFailure = new Error('chart factory failed');
			Reflect.set(window, 'addChartBox', () => { throw factoryFailure; });
			const layout = observeHelper(helpers.createStressNotebook(false));
			await vi.advanceTimersByTimeAsync(900);
			await expect(layout.result).resolves.toEqual({ error: factoryFailure });
			expect(helpers.capture(), 'layout must release capture even before waitForCommands is reached').toBeUndefined();
			expect(Reflect.get(window, '__e2eCaptureHostMessage')).toBe(previousCapture);
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	it('reports section presence from the authoritative projection', () => {
		expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('present');
		expect(getHostOwnedDocumentSectionStatus('markdown_missing')).toBe('absent');
	});

	it('reports section authority as unknown while a failed command forces reload', async () => {
		expect(requestHostOwnedMarkdownPatch({
			id: 'markdown_1', type: 'markdown', text: 'after', expanded: true, mode: 'wysiwyg', tab: 'edit',
		})).toBe(true);
		const patch = await waitForPostedMessage(1);

		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: patch.commandId, ok: false,
			sourceGeneration: 7,
		});

		expect(getHostOwnedDocumentSectionStatus('markdown_1')).toBe('unknown');
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'requestDocument' });
	});

	it('sequences commands from acknowledged document and section revisions', async () => {
		expect(requestHostOwnedMarkdownPatch({
			id: 'markdown_1', type: 'markdown', text: 'after', expanded: true, mode: 'wysiwyg', tab: 'edit',
		})).toBe(true);
		const patch = await waitForPostedMessage(1);
		expect(patch).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 7, expectedDocumentRevision: 0,
			command: { type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0 },
		});
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: patch.commandId, ok: true,
			sourceGeneration: 7,
			projection: {
				documentRevision: 1, sectionRevisions: { markdown_1: 1 },
				markdownSectionRevisions: { markdown_1: 1 },
				markdownSections: [{
					id: 'markdown_1', type: 'markdown', title: '', text: 'after', expanded: true,
					mode: 'wysiwyg', tab: 'edit',
				}],
				urlSections: [],
				orderedSectionIds: ['markdown_1'],
			},
		});

		expect(requestHostOwnedMarkdownRemove('markdown_1')).toBe(true);
		const remove = await waitForPostedMessage(2);
		expect(remove).toMatchObject({
			type: 'markdownDocumentCommand', expectedDocumentRevision: 1,
			command: { type: 'remove', sectionId: 'markdown_1', expectedSectionRevision: 1 },
		});
	});

	it('adopts the authoritative projection from a rejected stale command', async () => {
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'stale', expanded: true, mode: 'wysiwyg' });
		const patch = await waitForPostedMessage(1);
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: patch.commandId, ok: false,
			sourceGeneration: 7,
			projection: {
				documentRevision: 4, sectionRevisions: { markdown_1: 3 },
				markdownSectionRevisions: { markdown_1: 3 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'authoritative' }],
				urlSections: [],
				orderedSectionIds: ['markdown_1'],
			},
		});
		expect(handled).toMatchObject({ handled: true, accepted: false });
		expect(pState.markdownDocumentRevision).toBe(4);
		expect(pState.markdownSectionRevisions).toEqual({ markdown_1: 3 });
		expect(pState.hostOwnedMarkdownSections.markdown_1.text).toBe('authoritative');
	});

	it('posts burst edits immediately with predicted revisions', async () => {
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'one', expanded: true, mode: 'wysiwyg' });
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'two', expanded: true, mode: 'wysiwyg' });
		const first = await waitForPostedMessage(1);
		const second = await waitForPostedMessage(2);
		expect(first).toMatchObject({
			sourceGeneration: 7, expectedDocumentRevision: 0,
			command: { type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0 },
		});
		expect(second).toMatchObject({
			sourceGeneration: 7, expectedDocumentRevision: 1,
			command: { type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 1 },
		});
	});

	it('sequences hidden development-note add and patch through the optimistic projection', async () => {
		const first = {
			id: 'note_first', created: '2026-08-14T10:00:00.000Z', updated: '2026-08-14T10:00:00.000Z',
			category: 'usage-note', content: 'first', source: 'agent',
		};
		const replacement = {
			...first, id: 'note_replacement', updated: '2026-08-14T10:01:00.000Z', content: 'replacement',
		};
		const addSettlement = requestHostOwnedDevelopmentNoteAdd({
			id: 'devnotes_owner', type: 'devnotes', entries: [first],
		}, 'markdown_1');
		const patchSettlement = requestHostOwnedDevelopmentNotePatch({
			id: 'devnotes_owner', type: 'devnotes', entries: [replacement],
		});

		const add = await waitForPostedMessage(1);
		const patch = await waitForPostedMessage(2);
		expect(add).toMatchObject({
			expectedDocumentRevision: 0,
			command: { type: 'add', afterSectionId: 'markdown_1', section: { id: 'devnotes_owner' } },
		});
		expect(patch).toMatchObject({
			expectedDocumentRevision: 1,
			command: {
				type: 'patch', sectionId: 'devnotes_owner', expectedSectionRevision: 1,
				patch: { entries: [replacement] },
			},
		});
		expect(getHostOwnedDevelopmentNoteSections()).toEqual([]);
		expect(getOptimisticHostOwnedDevelopmentNoteSections()).toEqual([{
			id: 'devnotes_owner', type: 'devnotes', entries: [replacement],
		}]);

		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: add.commandId, ok: true, sourceGeneration: 7,
			projection: {
				documentRevision: 1, sectionRevisions: { markdown_1: 0, devnotes_owner: 1 },
				markdownSectionRevisions: { markdown_1: 0 },
				developmentNoteSections: [{ id: 'devnotes_owner', type: 'devnotes', entries: [first] }],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before', expanded: true, mode: 'wysiwyg' }],
				urlSections: [], orderedSectionIds: ['markdown_1', 'devnotes_owner'],
			},
		});
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: patch.commandId, ok: true, sourceGeneration: 7,
			projection: {
				documentRevision: 2, sectionRevisions: { markdown_1: 0, devnotes_owner: 2 },
				markdownSectionRevisions: { markdown_1: 0 },
				developmentNoteSections: [{ id: 'devnotes_owner', type: 'devnotes', entries: [replacement] }],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before', expanded: true, mode: 'wysiwyg' }],
				urlSections: [], orderedSectionIds: ['markdown_1', 'devnotes_owner'],
			},
		});
		await expect(addSettlement).resolves.toBe(true);
		await expect(patchSettlement).resolves.toBe(true);
	});

	it('settles an overlapping committed note independently from a later rejected note', async () => {
		const first = {
			id: 'note_first', created: '2026-08-14T10:00:00.000Z', updated: '2026-08-14T10:00:00.000Z',
			category: 'usage-note', content: 'first', source: 'agent',
		};
		const second = {
			...first, id: 'note_second', updated: '2026-08-14T10:01:00.000Z', content: 'second',
		};
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0, sourceGeneration: 20,
			sectionRevisions: { devnotes_owner: 0 }, markdownSectionRevisions: {},
		}, { sections: [{ id: 'devnotes_owner', type: 'devnotes', entries: [] }] });
		postMessageToHost.mockClear();

		const firstSettlement = requestHostOwnedDevelopmentNotePatch({
			id: 'devnotes_owner', type: 'devnotes', entries: [first],
		});
		const secondSettlement = requestHostOwnedDevelopmentNotePatch({
			id: 'devnotes_owner', type: 'devnotes', entries: [first, second],
		});
		const firstCommand = await waitForPostedMessage(1);
		const secondCommand = await waitForPostedMessage(2);

		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: firstCommand.commandId,
			ok: true, sourceGeneration: 20,
			projection: {
				documentRevision: 1, sectionRevisions: { devnotes_owner: 1 }, markdownSectionRevisions: {},
				developmentNoteSections: [{ id: 'devnotes_owner', type: 'devnotes', entries: [first] }],
				markdownSections: [], urlSections: [], orderedSectionIds: ['devnotes_owner'],
			},
		});
		const rejected = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: secondCommand.commandId,
			ok: false, sourceGeneration: 20, documentRevision: 1,
			error: { code: 'stale-document-revision', message: 'rejected later command' },
			projection: {
				documentRevision: 1, sectionRevisions: { devnotes_owner: 1 }, markdownSectionRevisions: {},
				developmentNoteSections: [{ id: 'devnotes_owner', type: 'devnotes', entries: [first] }],
				markdownSections: [], urlSections: [], orderedSectionIds: ['devnotes_owner'],
			},
		});

		await expect(firstSettlement).resolves.toBe(true);
		await expect(secondSettlement).resolves.toBe(false);
		expect(rejected).toMatchObject({ handled: true, accepted: false });
		expect(getHostOwnedDevelopmentNoteSections()[0].entries).toEqual([first]);
	});

	it('holds the Save barrier until every burst command settles', async () => {
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'one', expanded: true, mode: 'wysiwyg' });
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'two', expanded: true, mode: 'wysiwyg' });
		const first = await waitForPostedMessage(1);
		const second = await waitForPostedMessage(2);
		let barrierSettled = false;
		const barrier = waitForHostOwnedMarkdownCommands().then(accepted => {
			barrierSettled = true;
			return accepted;
		});
		await Promise.resolve();
		expect(barrierSettled).toBe(false);
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: first.commandId, ok: true, sourceGeneration: 7,
			projection: {
				documentRevision: 1, sectionRevisions: { markdown_1: 1 },
				markdownSectionRevisions: { markdown_1: 1 },
				markdownSections: [{
					id: 'markdown_1', type: 'markdown', title: '', text: 'one', tab: 'edit', expanded: true,
					mode: 'wysiwyg',
				}],
				urlSections: [],
				orderedSectionIds: ['markdown_1'],
			},
		});
		await Promise.resolve();
		expect(barrierSettled).toBe(false);
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: second.commandId, ok: true, sourceGeneration: 7,
			projection: {
				documentRevision: 2, sectionRevisions: { markdown_1: 2 },
				markdownSectionRevisions: { markdown_1: 2 },
				markdownSections: [{
					id: 'markdown_1', type: 'markdown', title: '', text: 'two', tab: 'edit', expanded: true,
					mode: 'wysiwyg',
				}],
				urlSections: [],
				orderedSectionIds: ['markdown_1'],
			},
		});
		await expect(barrier).resolves.toBe(true);
	});

	it('cancels queued snapshots on reload and ignores their late results', async () => {
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'queued', expanded: true, mode: 'wysiwyg' });
		const command = await waitForPostedMessage(1);
		adoptHostOwnedMarkdownDocument({
			documentRevision: 4, sourceGeneration: 8, sectionRevisions: { markdown_1: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [{ id: 'markdown_1', type: 'markdown', text: 'reloaded' }],
		});
		const late = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true, sourceGeneration: 7,
			projection: {
				documentRevision: 1, markdownSectionRevisions: { markdown_1: 1 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'queued' }],
				orderedSectionIds: ['markdown_1'],
			},
		});
		expect(late.handled).toBe(false);
		expect(pState.markdownSourceGeneration).toBe(8);
		expect(pState.markdownDocumentRevision).toBe(4);
		expect(pState.hostOwnedMarkdownSections.markdown_1.text).toBe('reloaded');
	});

	it('sequences URL and Markdown changes through one document revision ledger', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 9,
			sectionRevisions: { markdown_1: 0, url_1: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{ id: 'url_1', type: 'url', name: 'Before', url: 'https://example.com/before.png', expanded: true },
			],
		});
		postMessageToHost.mockClear();

		expect(requestHostOwnedUrlPatch({
			id: 'url_1', type: 'url', name: 'After', url: 'https://example.com/after.png', expanded: false,
			outputHeightPx: 420, imageSizeMode: 'natural', imageAlign: 'center', imageOverflow: 'scroll',
		})).toBe(true);
		const urlPatch = await waitForPostedMessage(1);
		expect(urlPatch).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 9, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'url_1', expectedSectionRevision: 0,
				patch: { outputHeightPx: 420, imageSizeMode: 'natural', imageAlign: 'center', imageOverflow: 'scroll' },
			},
		});
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: urlPatch.commandId, ok: true,
			sourceGeneration: 9,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, url_1: 1 },
				markdownSectionRevisions: { markdown_1: 0 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				urlSections: [{
					id: 'url_1', type: 'url', name: 'After', url: 'https://example.com/after.png', expanded: false,
					outputHeightPx: 420, imageSizeMode: 'natural', imageAlign: 'center', imageOverflow: 'scroll',
				}],
				orderedSectionIds: ['markdown_1', 'url_1'],
			},
		});

		expect(requestHostOwnedMarkdownPatch({
			id: 'markdown_1', type: 'markdown', text: 'after URL', expanded: true, mode: 'wysiwyg', tab: 'edit',
		})).toBe(true);
		const markdownPatch = await waitForPostedMessage(2);
		expect(markdownPatch).toMatchObject({
			sourceGeneration: 9, expectedDocumentRevision: 1,
			command: { type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0 },
		});

		expect(requestHostOwnedUrlRemove('url_1')).toBe(true);
		const urlRemove = await waitForPostedMessage(3);
		expect(urlRemove).toMatchObject({
			sourceGeneration: 9, expectedDocumentRevision: 2,
			command: { type: 'remove', sectionId: 'url_1', expectedSectionRevision: 1 },
		});
	});

	it('sequences Python, URL, and Markdown through one full-projection ledger', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 12,
			sectionRevisions: { markdown_1: 0, python_1: 0, url_1: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{
					id: 'python_1', type: 'python', name: 'Before', code: 'print("before")',
					output: 'before output', expanded: true, editorHeightPx: 180,
				},
				{ id: 'url_1', type: 'url', url: 'https://example.com/before.png', expanded: true },
			],
		});
		postMessageToHost.mockClear();

		expect(requestHostOwnedPythonPatch({
			id: 'python_1', type: 'python', name: 'After', code: 'print("after")',
			output: 'after output', expanded: false, editorHeightPx: 360,
		})).toBe(true);
		const pythonPatch = await waitForPostedMessage(1);
		expect(pythonPatch).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 12, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'python_1', expectedSectionRevision: 0,
				patch: {
					name: 'After', code: 'print("after")', output: 'after output',
					expanded: false, editorHeightPx: 360,
				},
			},
		});
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: pythonPatch.commandId, ok: true,
			sourceGeneration: 12,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, python_1: 1, url_1: 0 },
				markdownSectionRevisions: { markdown_1: 0 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				pythonSections: [{
					id: 'python_1', type: 'python', name: 'After', code: 'print("after")',
					output: 'after output', expanded: false, editorHeightPx: 360,
				}],
				urlSections: [{ id: 'url_1', type: 'url', url: 'https://example.com/before.png', expanded: true }],
				orderedSectionIds: ['markdown_1', 'python_1', 'url_1'],
			},
		});

		expect(requestHostOwnedUrlPatch({
			id: 'url_1', type: 'url', url: 'https://example.com/after.png', expanded: true,
		})).toBe(true);
		const urlPatch = await waitForPostedMessage(2);
		expect(urlPatch).toMatchObject({
			expectedDocumentRevision: 1,
			command: { type: 'patch', sectionId: 'url_1', expectedSectionRevision: 0 },
		});

		expect(requestHostOwnedPythonRemove('python_1')).toBe(true);
		const pythonRemove = await waitForPostedMessage(3);
		expect(pythonRemove).toMatchObject({
			expectedDocumentRevision: 2,
			command: { type: 'remove', sectionId: 'python_1', expectedSectionRevision: 1 },
		});
	});

	it('sequences Chart configuration through the same full-projection ledger', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 14,
			sectionRevisions: { markdown_1: 0, chart_1: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{
					id: 'chart_1', type: 'chart', name: 'Before', dataSourceId: 'query_1',
					chartType: 'bar', xColumn: 'Category', yColumns: ['Revenue'], expanded: true,
				},
			],
		});
		postMessageToHost.mockClear();

		const afterState = {
			id: 'chart_1', type: 'chart', name: 'After', mode: 'preview', expanded: false,
			dataSourceId: 'query_2', dataSourceResultIndex: 1, chartType: 'line', xColumn: 'Day', yColumns: ['Cost'],
			xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Host chart',
		} as const;
		expect(requestHostOwnedChartPatch(afterState)).toBe(true);
		const chartPatch = await waitForPostedMessage(1);
		expect(requestHostOwnedChartPatch(afterState)).toBe(true);
		await Promise.resolve();
		expect(postMessageToHost).toHaveBeenCalledTimes(1);
		expect(chartPatch).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 14, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'chart_1', expectedSectionRevision: 0,
				patch: {
					name: 'After', mode: 'preview', expanded: false, dataSourceId: 'query_2',
					dataSourceResultIndex: 1, chartType: 'line', xColumn: 'Day', yColumns: ['Cost'],
					xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Host chart',
				},
			},
		});
		const defaultResultState = { ...afterState } as typeof afterState & { dataSourceResultIndex?: number };
		delete defaultResultState.dataSourceResultIndex;
		expect(requestHostOwnedChartPatch(defaultResultState)).toBe(true);
		const chartDefaultPatch = await waitForPostedMessage(2);
		expect(chartDefaultPatch).toMatchObject({
			expectedDocumentRevision: 1,
			command: { type: 'patch', sectionId: 'chart_1', expectedSectionRevision: 1 },
		});
		expect(chartDefaultPatch.command.patch).toMatchObject({ dataSourceResultIndex: null });

		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: chartPatch.commandId, ok: true,
			sourceGeneration: 14,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, chart_1: 1 },
				markdownSectionRevisions: { markdown_1: 0 },
				chartSections: [{
					id: 'chart_1', type: 'chart', name: 'After', mode: 'preview', expanded: false,
					dataSourceId: 'query_2', dataSourceResultIndex: 1,
					chartType: 'line', xColumn: 'Day', yColumns: ['Cost'],
					xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Host chart',
				}],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				pythonSections: [],
				urlSections: [],
				orderedSectionIds: ['markdown_1', 'chart_1'],
			},
		});

		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: chartDefaultPatch.commandId, ok: true,
			sourceGeneration: 14,
			projection: {
				documentRevision: 2,
				sectionRevisions: { markdown_1: 0, chart_1: 2 },
				markdownSectionRevisions: { markdown_1: 0 },
				chartSections: [{
					id: 'chart_1', type: 'chart', name: 'After', mode: 'preview', expanded: false,
					dataSourceId: 'query_2', chartType: 'line', xColumn: 'Day', yColumns: ['Cost'],
					xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Host chart',
				}],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				pythonSections: [],
				urlSections: [],
				orderedSectionIds: ['markdown_1', 'chart_1'],
			},
		});

		expect(requestHostOwnedChartRemove('chart_1')).toBe(true);
		const finalChartRemove = await waitForPostedMessage(3);
		expect(finalChartRemove).toMatchObject({
			expectedDocumentRevision: 2,
			command: { type: 'remove', sectionId: 'chart_1', expectedSectionRevision: 2 },
		});
	});

	it('sequences Transformation configuration through the same full-projection ledger', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 16,
			sectionRevisions: { markdown_1: 0, 'transform-any-id': 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{
					id: 'transform-any-id', type: 'transformation', name: 'Before', mode: 'edit',
					expanded: true, editorHeightPx: 300, dataSourceId: 'query_left',
					transformationType: 'join', joinRightDataSourceId: 'query_right',
					joinKind: 'inner', joinKeys: [{ left: 'CustomerId', right: 'CustomerId' }],
					joinOmitDuplicateColumns: false,
				},
			],
		});
		postMessageToHost.mockClear();

		const afterState = {
			id: 'transform-any-id', type: 'transformation', name: 'After', mode: 'preview',
			expanded: false, editorHeightPx: 460, dataSourceId: 'query_left', dataSourceResultIndex: 1,
			transformationType: 'join', joinRightDataSourceId: 'query_right', joinRightDataSourceResultIndex: 2,
			joinKind: 'fullouter', joinKeys: [{ left: 'CustomerId', right: 'AccountId' }],
			joinOmitDuplicateColumns: true,
		} as const;
		expect(requestHostOwnedTransformationPatch(afterState)).toBe(true);
		const patch = await waitForPostedMessage(1);
		expect(requestHostOwnedTransformationPatch(afterState)).toBe(true);
		await Promise.resolve();
		expect(postMessageToHost).toHaveBeenCalledTimes(1);
		expect(patch).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 16, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'transform-any-id', expectedSectionRevision: 0,
				patch: {
					name: 'After', mode: 'preview', expanded: false, editorHeightPx: 460,
					dataSourceId: 'query_left', dataSourceResultIndex: 1, transformationType: 'join',
					joinRightDataSourceId: 'query_right', joinRightDataSourceResultIndex: 2,
					joinKind: 'fullouter',
					joinKeys: [{ left: 'CustomerId', right: 'AccountId' }],
					joinOmitDuplicateColumns: true,
				},
			},
		});
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: patch.commandId, ok: true,
			sourceGeneration: 16,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, 'transform-any-id': 1 },
				markdownSectionRevisions: { markdown_1: 0 },
				chartSections: [],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				pythonSections: [],
				transformationSections: [afterState],
				urlSections: [],
				orderedSectionIds: ['markdown_1', 'transform-any-id'],
			},
		});
		expect(handled).toMatchObject({ handled: true, accepted: true });
		expect(pState.hostOwnedTransformationSections['transform-any-id']).toEqual(afterState);

		expect(requestHostOwnedTransformationRemove('transform-any-id')).toBe(true);
		const remove = await waitForPostedMessage(2);
		expect(remove).toMatchObject({
			expectedDocumentRevision: 1,
			command: { type: 'remove', sectionId: 'transform-any-id', expectedSectionRevision: 1 },
		});
	});

	it('sequences HTML configuration through the same full-projection ledger', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 18,
			sectionRevisions: { markdown_1: 0, 'dashboard-any-id': 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{
					id: 'dashboard-any-id', type: 'html', name: 'Before', code: '<main>before</main>',
					mode: 'code', expanded: true, dataSourceIds: ['query_before'],
				},
			],
		});
		postMessageToHost.mockClear();

		const afterState = {
			id: 'dashboard-any-id', type: 'html', name: 'After', code: '<main>after</main>',
			mode: 'preview', expanded: false, editorHeightPx: 420, previewHeightPx: 640,
			previewHeightUserSet: true, dataSourceIds: ['query_after'],
			pbiPublishInfo: {
				workspaceId: 'workspace', semanticModelId: 'model', reportId: 'report',
				reportName: 'Report', reportUrl: 'https://app.powerbi.com/report', dataMode: 'import',
			},
			powerBiUpgradeNotice: {
				dismissedForSection: true, dismissedForVersion: 1,
				dismissedForSignature: 'signature', dismissedAt: '2026-08-04T00:00:00.000Z',
			},
		} as const;
		expect(requestHostOwnedHtmlPatch(afterState)).toBe(true);
		const patch = await waitForPostedMessage(1);
		expect(requestHostOwnedHtmlPatch(afterState)).toBe(true);
		await Promise.resolve();
		expect(postMessageToHost).toHaveBeenCalledTimes(1);
		expect(patch).toMatchObject({
			type: 'markdownDocumentCommand', sourceGeneration: 18, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'dashboard-any-id', expectedSectionRevision: 0,
				patch: {
					name: 'After', code: '<main>after</main>', mode: 'preview', expanded: false,
					editorHeightPx: 420, previewHeightPx: 640, previewHeightUserSet: true,
					dataSourceIds: ['query_after'],
				},
			},
		});
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: patch.commandId, ok: true,
			sourceGeneration: 18,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, 'dashboard-any-id': 1 },
				markdownSectionRevisions: { markdown_1: 0 },
				chartSections: [], htmlSections: [afterState],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				pythonSections: [], transformationSections: [], urlSections: [],
				orderedSectionIds: ['markdown_1', 'dashboard-any-id'],
			},
		});
		expect(handled).toMatchObject({ handled: true, accepted: true });
		expect(pState.hostOwnedHtmlSections['dashboard-any-id']).toEqual(afterState);

		expect(requestHostOwnedHtmlRemove('dashboard-any-id')).toBe(true);
		const remove = await waitForPostedMessage(2);
		expect(remove).toMatchObject({
			expectedDocumentRevision: 1,
			command: { type: 'remove', sectionId: 'dashboard-any-id', expectedSectionRevision: 1 },
		});
	});

	it('carries publish correlation only on the exact HTML metadata patch', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0, sourceGeneration: 19,
			sectionRevisions: { 'dashboard-publish': 0 }, markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'dashboard-publish', type: 'html', code: '<main></main>' }],
		});
		postMessageToHost.mockClear();
		const state = {
			id: 'dashboard-publish', type: 'html', code: '<main></main>',
			pbiPublishInfo: {
				workspaceId: 'workspace', semanticModelId: 'model', reportId: 'report',
				reportName: 'Report', reportUrl: 'https://app.powerbi.com/report',
			},
		} as const;

		expect(requestHostOwnedHtmlPublishInfoPatch(
			state.id, state.pbiPublishInfo, 'publish-request-1', 'apply',
		)).toBe(true);
		const command = await waitForPostedMessage(1);

		expect(command).toMatchObject({
			type: 'markdownDocumentCommand', publishRequestId: 'publish-request-1',
			publishApplicationPhase: 'apply',
			command: {
				type: 'patch', sectionId: 'dashboard-publish',
				patch: { pbiPublishInfo: state.pbiPublishInfo },
			},
		});
	});

	it('rebases an in-flight Transformation terminal to acknowledged section order', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 17,
			sectionRevisions: { markdown_1: 0, transform_reorder: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{
					id: 'transform_reorder', type: 'transformation', name: 'Before',
					dataSourceId: 'query_1', transformationType: 'select',
				},
				{ id: 'future_reorder', type: 'future-section', payload: { keep: true } },
				{ id: 'query_1', type: 'query', query: 'print Value=1' },
			],
		});
		postMessageToHost.mockClear();
		const after = {
			id: 'transform_reorder', type: 'transformation', name: 'After',
			dataSourceId: 'query_1', transformationType: 'select',
		} as const;
		expect(requestHostOwnedTransformationPatch(after)).toBe(true);
		const command = await waitForPostedMessage(1);

		expect(acknowledgeHostOwnedDocumentOrder([
			'transform_reorder', 'future_reorder', 'query_1', 'markdown_1',
		])).toBe(true);
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true,
			sourceGeneration: 17,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, transform_reorder: 1 },
				markdownSectionRevisions: { markdown_1: 0 },
				chartSections: [],
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				pythonSections: [], transformationSections: [after], urlSections: [],
				orderedSectionIds: ['transform_reorder', 'future_reorder', 'query_1', 'markdown_1'],
			},
		});

		expect(handled).toMatchObject({ handled: true, accepted: true });
		expect(postMessageToHost).not.toHaveBeenCalledWith({ type: 'requestDocument' });
	});

	it('accepts a Chart terminal that omits an undefined validation field', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 15,
			sectionRevisions: { chart_1: 0 },
			markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'chart_1', type: 'chart', chartType: 'bar' }],
		});
		postMessageToHost.mockClear();
		expect(requestHostOwnedChartPatch({
			id: 'chart_1', type: 'chart', chartType: 'line',
			validation: { valid: false, availableColumns: undefined, issues: ['No data'] },
		})).toBe(true);
		const command = await waitForPostedMessage(1);

		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true,
			sourceGeneration: 15,
			projection: {
				documentRevision: 1,
				sectionRevisions: { chart_1: 1 },
				markdownSectionRevisions: {},
				chartSections: [{
					id: 'chart_1', type: 'chart', chartType: 'line',
					validation: { valid: false, issues: ['No data'] },
				}],
				markdownSections: [], pythonSections: [], urlSections: [],
				orderedSectionIds: ['chart_1'],
			},
		});

		expect(handled).toMatchObject({ handled: true, accepted: true });
		expect(postMessageToHost).not.toHaveBeenCalledWith({ type: 'requestDocument' });
	});

	it('rejects incomplete URL revision metadata without activating host ownership', () => {
		const adopted = adoptHostOwnedMarkdownDocument({
			documentRevision: 1,
			sourceGeneration: 10,
			sectionRevisions: {},
			markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'url_1', type: 'url', url: 'https://example.com/data.csv', expanded: true }],
		});

		expect(adopted).toBe(false);
		expect(pState.hostOwnedMarkdownActive).toBe(false);
		expect(pState.hostOwnedUrlSections).toEqual({});
	});

	it('rejects incomplete Python revision metadata without activating host ownership', () => {
		const adopted = adoptHostOwnedMarkdownDocument({
			documentRevision: 1,
			sourceGeneration: 13,
			sectionRevisions: {},
			markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'python_1', type: 'python', code: 'print(1)' }],
		});

		expect(adopted).toBe(false);
		expect(pState.hostOwnedMarkdownActive).toBe(false);
		expect(pState.hostOwnedPythonSections).toEqual({});
	});

	it('rejects a successful command result that omits the commanded URL transition', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 10,
			sectionRevisions: { markdown_1: 0, url_1: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{ id: 'url_1', type: 'url', url: 'https://example.com/before.png', expanded: true },
			],
		});
		postMessageToHost.mockClear();
		requestHostOwnedUrlPatch({
			id: 'url_1', type: 'url', url: 'https://example.com/after.png', expanded: true,
		});
		const command = await waitForPostedMessage(1);
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true,
			sourceGeneration: 10,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0 },
				markdownSectionRevisions: { markdown_1: 0 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				urlSections: [],
				orderedSectionIds: ['markdown_1'],
			},
		});

		expect(handled).toEqual({ handled: true, accepted: false });
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'requestDocument' });
		expect(pState.hostOwnedUrlSections.url_1.url).toBe('https://example.com/before.png');
	});

	it('rejects a successful command result with unrelated owned-order drift', async () => {
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 11,
			sectionRevisions: { markdown_1: 0, url_1: 0, url_2: 0 },
			markdownSectionRevisions: { markdown_1: 0 },
		}, {
			sections: [
				{ id: 'markdown_1', type: 'markdown', text: 'before' },
				{ id: 'query_1', type: 'query', query: 'print 1' },
				{ id: 'url_1', type: 'url', url: 'https://example.com/one.png', expanded: true },
				{ id: 'url_2', type: 'url', url: 'https://example.com/two.png', expanded: true },
			],
		});
		postMessageToHost.mockClear();
		requestHostOwnedUrlPatch({
			id: 'url_1', type: 'url', url: 'https://example.com/after.png', expanded: true,
		});
		const command = await waitForPostedMessage(1);
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true,
			sourceGeneration: 11,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, url_1: 1, url_2: 0 },
				markdownSectionRevisions: { markdown_1: 0 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'before' }],
				urlSections: [
					{ id: 'url_2', type: 'url', url: 'https://example.com/two.png', expanded: true },
					{ id: 'url_1', type: 'url', name: '', url: 'https://example.com/after.png', expanded: true },
				],
				orderedSectionIds: ['url_2', 'query_1', 'markdown_1', 'url_1'],
			},
		});

		expect(handled).toEqual({ handled: true, accepted: false });
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'requestDocument' });
		expect(pState.hostOwnedUrlSections.url_2.url).toBe('https://example.com/two.png');
	});

	it('settles pending commands and reloads after a malformed command projection', async () => {
		requestHostOwnedMarkdownPatch({
			id: 'markdown_1', type: 'markdown', text: 'pending', expanded: true, mode: 'wysiwyg', tab: 'edit',
		});
		const command = await waitForPostedMessage(1);
		const barrier = waitForHostOwnedMarkdownCommands();
		const handled = handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: command.commandId, ok: true,
			sourceGeneration: 7,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 1, url_missing: 0 },
				markdownSectionRevisions: { markdown_1: 1 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'pending' }],
				urlSections: 'malformed',
				orderedSectionIds: ['markdown_1'],
			},
		});

		expect(handled).toEqual({ handled: true, accepted: false });
		await expect(barrier).resolves.toBe(false);
		expect(postMessageToHost).toHaveBeenCalledWith({ type: 'requestDocument' });
		expect(pState.hostOwnedMarkdownSections.markdown_1.text).toBe('before');
	});
});