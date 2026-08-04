import { describe, expect, it } from 'vitest';

import {
	DOCUMENT_VIEW_CHANNEL,
	DOCUMENT_VIEW_PROTOCOL_VERSION,
	parseDocumentViewHostMessage,
	parseDocumentViewWebviewMessage,
	stampDocumentViewHostMessage,
	stampDocumentViewWebviewMessage,
} from '../../src/shared/documentViewProtocol.js';

const envelope = {
	protocolVersion: DOCUMENT_VIEW_PROTOCOL_VERSION,
	channel: DOCUMENT_VIEW_CHANNEL,
	viewSessionId: 'view-session-1',
} as const;

const markdownSection = {
	id: 'markdown_1', type: 'markdown', title: 'Notes', text: 'before', mode: 'markdown', expanded: true,
} as const;

const projection = {
	documentRevision: 1,
	sectionRevisions: { markdown_1: 1 },
	markdownSectionRevisions: { markdown_1: 1 },
	chartSections: [],
	markdownSections: [markdownSection],
	pythonSections: [],
	transformationSections: [],
	urlSections: [],
	orderedSectionIds: ['markdown_1'],
} as const;

describe('document-view protocol', () => {
	it('runtime-validates every host-to-webview message type', () => {
		const messages = [
			{
				...envelope,
				type: 'documentData', ok: true, reloadRequestId: 'reload-1', sourceGeneration: 3,
				forceReload: false, documentUri: 'file:///tmp/view.kqlx', state: { sections: [markdownSection] },
				documentRevision: 0, sectionRevisions: { markdown_1: 0 },
				markdownSectionRevisions: { markdown_1: 0 },
			},
			{
				...envelope,
				type: 'markdownDocumentCommandResult', commandId: 'command-1', ok: true,
				sourceGeneration: 3, documentRevision: 1, sectionRevision: 1, projection,
			},
			{
				...envelope,
				type: 'requestMarkdownCommandBarrier', requestId: 'barrier-1', sourceGeneration: 3,
			},
		] as const;

		for (const message of messages) {
			const parsed = parseDocumentViewHostMessage(message);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value.type).toBe(message.type);
		}
	});

	it('runtime-validates every webview-to-host message type', () => {
		const messages = [
			{
				...envelope,
				type: 'documentReloadResult', requestId: 'reload-1', applied: true,
				editRevision: 4, markdownCommandBarrierSupported: true,
			},
			{
				...envelope,
				type: 'markdownDocumentCommand', commandId: 'command-1', sourceGeneration: 3,
				expectedDocumentRevision: 0,
				command: {
					type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0,
					patch: { text: 'after' },
				},
			},
			{
				...envelope,
				type: 'markdownDocumentCommandBarrierResult', requestId: 'barrier-1',
				sourceGeneration: 3, documentRevision: 1, accepted: true,
			},
		] as const;

		for (const message of messages) {
			const parsed = parseDocumentViewWebviewMessage(message);
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.value.type).toBe(message.type);
		}
	});

	it('validates Transformation configuration and nested identities', () => {
		const transformation = {
			id: 'transform-any-id', type: 'transformation', name: 'Joined', mode: 'preview',
			expanded: false, editorHeightPx: 420, dataSourceId: 'query_left',
			transformationType: 'join', joinRightDataSourceId: 'query_right',
			joinKind: 'fullouter', joinKeys: [{ left: 'CustomerId', right: 'AccountId' }],
			joinOmitDuplicateColumns: true,
		} as const;
		const valid = parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-transformation',
			sourceGeneration: 4, forceReload: false, documentUri: 'file:///tmp/transformation.kqlx',
			state: { sections: [transformation] }, documentRevision: 2,
			sectionRevisions: { 'transform-any-id': 1 }, markdownSectionRevisions: {},
		});
		expect(valid.ok).toBe(true);

		const malformed = parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-malformed-transformation',
			sourceGeneration: 4, forceReload: false, documentUri: 'file:///tmp/transformation.kqlx',
			state: { sections: [{ ...transformation, joinKeys: [{ left: 'CustomerId' }] }] },
			documentRevision: 2, sectionRevisions: { 'transform-any-id': 1 }, markdownSectionRevisions: {},
		});
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error).toContain('joinKeys[0]');
	});

	it('rejects malformed envelopes and internally inconsistent payloads', () => {
		expect(parseDocumentViewHostMessage({
			...envelope,
			protocolVersion: 2,
			type: 'requestMarkdownCommandBarrier', requestId: 'barrier-1', sourceGeneration: 3,
		}).ok).toBe(false);
		expect(parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-1', sourceGeneration: 3,
			forceReload: false, documentUri: 'file:///tmp/view.kqlx', state: { sections: [markdownSection] },
			documentRevision: 0, sectionRevisions: {}, markdownSectionRevisions: { markdown_1: 0 },
		}).ok).toBe(false);
		expect(parseDocumentViewHostMessage({
			...envelope,
			type: 'markdownDocumentCommandResult', commandId: 'command-1', ok: true,
			sourceGeneration: 3, documentRevision: 2, projection,
		}).ok).toBe(false);
		expect(parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'command-1', sourceGeneration: 3,
			expectedDocumentRevision: 0,
			command: { type: 'patch', sectionId: '', expectedSectionRevision: 0, patch: {} },
		}).ok).toBe(false);
	});

	it('overwrites caller-supplied envelope fields with the host-created session', () => {
		const hostMessage = stampDocumentViewHostMessage('host-session', {
			...envelope,
			viewSessionId: 'forged-session',
			type: 'requestMarkdownCommandBarrier', requestId: 'barrier-1', sourceGeneration: 3,
		});
		expect(hostMessage.ok && hostMessage.value.viewSessionId).toBe('host-session');

		const webviewMessage = stampDocumentViewWebviewMessage('host-session', {
			type: 'documentReloadResult', requestId: 'reload-1', applied: true, editRevision: 0,
		});
		expect(webviewMessage.ok && webviewMessage.value.viewSessionId).toBe('host-session');
	});
});