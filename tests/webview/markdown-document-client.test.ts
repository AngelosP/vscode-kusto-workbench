import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { postMessageToHost } = vi.hoisted(() => ({ postMessageToHost: vi.fn() }));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({ postMessageToHost }));

import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	adoptHostOwnedMarkdownDocument,
	handleHostOwnedMarkdownCommandResult,
	requestHostOwnedMarkdownPatch,
	requestHostOwnedMarkdownRemove,
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
				documentRevision: 1, markdownSectionRevisions: { markdown_1: 1 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'after', expanded: true, mode: 'wysiwyg', tab: 'edit' }],
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
				documentRevision: 4, markdownSectionRevisions: { markdown_1: 3 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'authoritative' }],
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
				documentRevision: 1, markdownSectionRevisions: { markdown_1: 1 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'one' }],
				orderedSectionIds: ['markdown_1'],
			},
		});
		await Promise.resolve();
		expect(barrierSettled).toBe(false);
		handleHostOwnedMarkdownCommandResult({
			type: 'markdownDocumentCommandResult', commandId: second.commandId, ok: true, sourceGeneration: 7,
			projection: {
				documentRevision: 2, markdownSectionRevisions: { markdown_1: 2 },
				markdownSections: [{ id: 'markdown_1', type: 'markdown', text: 'two' }],
				orderedSectionIds: ['markdown_1'],
			},
		});
		await expect(barrier).resolves.toBe(true);
	});

	it('cancels queued snapshots on reload and ignores their late results', async () => {
		requestHostOwnedMarkdownPatch({ id: 'markdown_1', type: 'markdown', text: 'queued', expanded: true, mode: 'wysiwyg' });
		const command = await waitForPostedMessage(1);
		adoptHostOwnedMarkdownDocument({
			documentRevision: 4, sourceGeneration: 8, markdownSectionRevisions: { markdown_1: 0 },
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
});