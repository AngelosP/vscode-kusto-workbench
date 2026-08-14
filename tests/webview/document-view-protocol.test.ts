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
	htmlSections: [],
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

	it('accepts a non-empty publish correlation only on a document command', () => {
		const valid = parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'publish-command',
			publishRequestId: 'publish-request-1', sourceGeneration: 3,
			publishApplicationPhase: 'apply',
			expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'html_1', expectedSectionRevision: 0,
				patch: { pbiPublishInfo: {
					workspaceId: 'workspace', semanticModelId: 'model', reportId: 'report',
					reportName: 'Report', reportUrl: 'https://app.powerbi.com/report',
				} },
			},
		});
		expect(valid.ok).toBe(true);
		expect(parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'publish-command-phase-only',
			publishApplicationPhase: 'apply', sourceGeneration: 3, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0,
				patch: { text: 'after' },
			},
		}).ok).toBe(false);
		expect(parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'publish-command-extra-field',
			publishRequestId: 'publish-request-1', publishApplicationPhase: 'apply',
			sourceGeneration: 3, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'html_1', expectedSectionRevision: 0,
				patch: { pbiPublishInfo: {}, code: '<main>wrong</main>' },
			},
		}).ok).toBe(false);
		expect(parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'publish-command-restore',
			publishRequestId: 'publish-request-1', publishApplicationPhase: 'compensate',
			sourceGeneration: 3, expectedDocumentRevision: 1,
			command: {
				type: 'patch', sectionId: 'html_1', expectedSectionRevision: 1,
				patch: { pbiPublishInfo: {
					workspaceId: 'old-workspace', semanticModelId: 'old-model', reportId: 'old-report',
					reportName: 'Old report', reportUrl: 'https://app.powerbi.com/old',
				} },
			},
		}).ok).toBe(true);
		expect(parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'publish-command-bad-restore',
			publishRequestId: 'publish-request-1', publishApplicationPhase: 'compensate',
			sourceGeneration: 3, expectedDocumentRevision: 1,
			command: {
				type: 'patch', sectionId: 'html_1', expectedSectionRevision: 1,
				patch: { pbiPublishInfo: 'old-report' },
			},
		}).ok).toBe(false);
		expect(parseDocumentViewWebviewMessage({
			...envelope,
			type: 'markdownDocumentCommand', commandId: 'publish-command-empty',
			publishRequestId: '', sourceGeneration: 3, expectedDocumentRevision: 0,
			command: {
				type: 'patch', sectionId: 'markdown_1', expectedSectionRevision: 0,
				patch: { text: 'after' },
			},
		}).ok).toBe(false);
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

	it('validates HTML configuration and nested publish metadata', () => {
		const htmlSection = {
			id: 'dashboard-any-id', type: 'html', name: 'Dashboard', code: '<main>dashboard</main>',
			mode: 'preview', expanded: false, editorHeightPx: 320, previewHeightPx: 640,
			previewHeightUserSet: true, dataSourceIds: ['query_fact'],
			pbiPublishInfo: {
				workspaceId: 'workspace', semanticModelId: 'model', reportId: 'report',
				reportName: 'Report', reportUrl: 'https://app.powerbi.com/report', dataMode: 'import',
			},
			powerBiUpgradeNotice: {
				dismissedForSection: true, dismissedForVersion: 1,
				dismissedForSignature: 'signature', dismissedAt: '2026-08-04T00:00:00.000Z',
			},
		} as const;
		const valid = parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-html', sourceGeneration: 5,
			forceReload: false, documentUri: 'file:///tmp/html.kqlx', state: { sections: [htmlSection] },
			documentRevision: 2, sectionRevisions: { 'dashboard-any-id': 1 }, markdownSectionRevisions: {},
		});
		expect(valid.ok).toBe(true);

		const malformed = parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-malformed-html', sourceGeneration: 5,
			forceReload: false, documentUri: 'file:///tmp/html.kqlx',
			state: { sections: [{ ...htmlSection, pbiPublishInfo: { workspaceId: 'workspace' } }] },
			documentRevision: 2, sectionRevisions: { 'dashboard-any-id': 1 }, markdownSectionRevisions: {},
		});
		expect(malformed.ok).toBe(false);
		if (!malformed.ok) expect(malformed.error).toContain('semanticModelId');
	});

	it('carries hidden development-note state through the existing document-view channel', () => {
		const developmentNotes = {
			id: 'devnotes_owner', type: 'devnotes', entries: [{
				id: 'note_1', created: '2026-08-14T10:00:00.000Z', updated: '2026-08-14T10:05:00.000Z',
				category: 'decision', relatedSectionIds: ['query_1'], content: 'Keep this', source: 'future-agent',
			}],
		} as const;
		const documentData = parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-devnotes', sourceGeneration: 6,
			forceReload: false, documentUri: 'file:///tmp/devnotes.kqlx',
			state: { sections: [developmentNotes, { id: 'future_1', type: 'future-section' }] },
			documentRevision: 0, sectionRevisions: { devnotes_owner: 0 }, markdownSectionRevisions: {},
		});
		expect(documentData.ok).toBe(true);

		const commandResult = parseDocumentViewHostMessage({
			...envelope,
			type: 'markdownDocumentCommandResult', commandId: 'devnotes-command', ok: true,
			sourceGeneration: 6, documentRevision: 1, sectionRevision: 1,
			projection: {
				documentRevision: 1, sectionRevisions: { devnotes_owner: 1 }, markdownSectionRevisions: {},
				developmentNoteSections: [developmentNotes], markdownSections: [], urlSections: [],
				orderedSectionIds: ['devnotes_owner', 'future_1'],
			},
		});
		expect(commandResult.ok).toBe(true);

		const malformed = parseDocumentViewHostMessage({
			...envelope,
			type: 'documentData', ok: true, reloadRequestId: 'reload-devnotes-bad', sourceGeneration: 6,
			forceReload: false, documentUri: 'file:///tmp/devnotes.kqlx',
			state: { sections: [{ ...developmentNotes, entries: [{ id: 'incomplete' }] }] },
			documentRevision: 0, sectionRevisions: { devnotes_owner: 0 }, markdownSectionRevisions: {},
		});
		expect(malformed.ok).toBe(false);
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