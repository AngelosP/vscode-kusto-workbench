import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { postMessageToHost } = vi.hoisted(() => ({ postMessageToHost: vi.fn() }));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({ postMessageToHost }));

import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	adoptHostOwnedMarkdownDocument,
	handleHostOwnedMarkdownCommandResult,
	requestHostOwnedMarkdownPatch,
	requestHostOwnedMarkdownRemove,
	requestHostOwnedPythonPatch,
	requestHostOwnedPythonRemove,
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