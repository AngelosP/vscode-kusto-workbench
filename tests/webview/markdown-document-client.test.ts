import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { postMessageToHost } = vi.hoisted(() => ({ postMessageToHost: vi.fn() }));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({ postMessageToHost }));

import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	acknowledgeHostOwnedDocumentOrder,
	adoptHostOwnedMarkdownDocument,
	getHostOwnedDevelopmentNoteSections,
	getOptimisticHostOwnedDevelopmentNoteSections,
	handleHostOwnedMarkdownCommandResult,
	requestHostOwnedChartPatch,
	requestHostOwnedChartRemove,
	requestHostOwnedDevelopmentNoteAdd,
	requestHostOwnedDevelopmentNotePatch,
	requestHostOwnedHtmlPatch,
	requestHostOwnedHtmlPublishInfoPatch,
	requestHostOwnedHtmlRemove,
	requestHostOwnedMarkdownPatch,
	requestHostOwnedMarkdownRemove,
	requestHostOwnedPythonPatch,
	requestHostOwnedPythonRemove,
	requestHostOwnedTransformationPatch,
	requestHostOwnedTransformationRemove,
	requestHostOwnedUrlPatch,
	requestHostOwnedUrlRemove,
	resetHostOwnedMarkdownDocument,
	waitForHostOwnedMarkdownCommands,
} from '../../src/webview/core/markdown-document-client.js';

async function waitForPostedMessage(count: number): Promise<any> {
	for (let attempt = 0; attempt < 20 && postMessageToHost.mock.calls.length < count; attempt++) await Promise.resolve();
	return postMessageToHost.mock.calls[count - 1]?.[0];
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
			dataSourceId: 'query_2', chartType: 'line', xColumn: 'Day', yColumns: ['Cost'],
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
					chartType: 'line', xColumn: 'Day', yColumns: ['Cost'],
					xAxisSettings: { customLabel: 'Date' }, chartTitle: 'Host chart',
				},
			},
		});
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: chartPatch.commandId, ok: true,
			sourceGeneration: 14,
			projection: {
				documentRevision: 1,
				sectionRevisions: { markdown_1: 0, chart_1: 1 },
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
		const chartRemove = await waitForPostedMessage(2);
		expect(chartRemove).toMatchObject({
			expectedDocumentRevision: 1,
			command: { type: 'remove', sectionId: 'chart_1', expectedSectionRevision: 1 },
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
			expanded: false, editorHeightPx: 460, dataSourceId: 'query_left',
			transformationType: 'join', joinRightDataSourceId: 'query_right',
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
					dataSourceId: 'query_left', transformationType: 'join',
					joinRightDataSourceId: 'query_right', joinKind: 'fullouter',
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