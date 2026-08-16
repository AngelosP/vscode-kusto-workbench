import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
	getHostOwnedHtmlSection: vi.fn(),
	postMessageToHost: vi.fn(),
	requestHtmlPatch: vi.fn(),
	requestPublishInfoPatch: vi.fn(),
	waitForCommands: vi.fn(),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: mocks.postMessageToHost,
}));

vi.mock('../../src/webview/core/markdown-document-client.js', () => ({
	getHostOwnedHtmlSection: mocks.getHostOwnedHtmlSection,
	isHostOwnedHtmlDocument: () => true,
	requestHostOwnedHtmlPatch: mocks.requestHtmlPatch,
	requestHostOwnedHtmlPublishInfoPatch: mocks.requestPublishInfoPatch,
	waitForHostOwnedMarkdownCommands: mocks.waitForCommands,
}));

import { KwHtmlSection, type PbiPublishInfo } from '../../src/webview/sections/kw-html-section.js';

const previousPublishInfo: PbiPublishInfo = {
	workspaceId: 'workspace-old',
	workspaceName: 'Old workspace',
	semanticModelId: 'model-old',
	reportId: 'report-old',
	reportName: 'Old report',
	reportUrl: 'https://app.powerbi.com/old',
	dataMode: 'directQuery',
};

const nextPublishResult = {
	type: 'publishToPowerBIResult',
	requestId: 'publish-as-new',
	boxId: 'html_publish_restore',
	ok: true,
	workspaceId: 'workspace-new',
	workspaceName: 'New workspace',
	semanticModelId: 'model-new',
	reportId: 'report-new',
	reportName: 'New report',
	reportUrl: 'https://app.powerbi.com/new',
	scheduleConfigured: true,
	initialRefreshTriggered: false,
	dataMode: 'import',
};

describe('HTML Power BI publish compensation', () => {
	afterEach(() => {
		document.body.replaceChildren();
		mocks.postMessageToHost.mockReset();
		mocks.getHostOwnedHtmlSection.mockReset();
		mocks.requestHtmlPatch.mockReset();
		mocks.requestPublishInfoPatch.mockReset();
		mocks.waitForCommands.mockReset();
	});

	it('rejects a matching malformed result before metadata, document, acknowledgement, or dialog effects', async () => {
		const section = new KwHtmlSection();
		section.id = nextPublishResult.boxId;
		section.boxId = section.id;
		section.setPbiPublishInfo(previousPublishInfo);
		document.body.appendChild(section);
		await section.updateComplete;
		const dialog = section.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
		dialog._publishRequestId = nextPublishResult.requestId;
		const handleHostMessage = vi.spyOn(dialog, 'handleHostMessage');

		await (section as any)._handleIframeMessage({
			data: { ...nextPublishResult, scheduleConfigured: 'yes' },
			source: null,
		} as MessageEvent);

		expect(section.getPbiPublishInfo()).toEqual(previousPublishInfo);
		expect(dialog._publishRequestId).toBe(nextPublishResult.requestId);
		expect(mocks.requestHtmlPatch).not.toHaveBeenCalled();
		expect(mocks.requestPublishInfoPatch).not.toHaveBeenCalled();
		expect(mocks.waitForCommands).not.toHaveBeenCalled();
		expect(mocks.postMessageToHost).not.toHaveBeenCalled();
		expect(handleHostMessage).not.toHaveBeenCalled();
	});

	it('preserves the new tuple through a queued ordinary patch and failed compensation CAS', async () => {
		const section = new KwHtmlSection();
		section.id = nextPublishResult.boxId;
		section.boxId = section.id;
		section.setPbiPublishInfo(previousPublishInfo);
		document.body.appendChild(section);
		await section.updateComplete;
		const dialog = section.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
		dialog._publishRequestId = nextPublishResult.requestId;
		const authoritativeNew = {
			id: section.id,
			type: 'html',
			name: 'Renamed while applying',
			pbiPublishInfo: {
				workspaceId: nextPublishResult.workspaceId,
				workspaceName: nextPublishResult.workspaceName,
				semanticModelId: nextPublishResult.semanticModelId,
				reportId: nextPublishResult.reportId,
				reportName: nextPublishResult.reportName,
				reportUrl: nextPublishResult.reportUrl,
				dataMode: nextPublishResult.dataMode,
			},
		} as const;
		mocks.getHostOwnedHtmlSection.mockReturnValue(authoritativeNew);
		mocks.requestHtmlPatch.mockReturnValue(true);
		mocks.requestPublishInfoPatch
			.mockReturnValueOnce(true)
			.mockReturnValueOnce(false);
		mocks.waitForCommands.mockImplementationOnce(async () => {
			section.setName('Renamed while applying');
			section.commitDocumentState();
			(section as any)._dashboardWorkflowGeneration++;
			return true;
		});

		await (section as any)._handleIframeMessage({ data: nextPublishResult, source: null } as MessageEvent);

		expect(mocks.requestHtmlPatch).toHaveBeenCalledWith(expect.objectContaining({
			name: 'Renamed while applying',
			pbiPublishInfo: expect.objectContaining({ reportId: 'report-new', semanticModelId: 'model-new' }),
		}));
		expect(mocks.requestPublishInfoPatch).toHaveBeenNthCalledWith(
			2, section.boxId, previousPublishInfo, nextPublishResult.requestId, 'compensate',
		);
		expect(section.getPbiPublishInfo()).toEqual(authoritativeNew.pbiPublishInfo);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'publishToPowerBIAck', requestId: nextPublishResult.requestId, accepted: true,
		});
	});

	it('restores prior report metadata when publish-as-new retires after apply', async () => {
		const section = new KwHtmlSection();
		section.id = nextPublishResult.boxId;
		section.boxId = section.id;
		section.setPbiPublishInfo(previousPublishInfo);
		document.body.appendChild(section);
		await section.updateComplete;
		const dialog = section.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
		expect(dialog).toBeTruthy();
		dialog._publishRequestId = nextPublishResult.requestId;

		mocks.requestPublishInfoPatch.mockReturnValue(true);
		mocks.waitForCommands
			.mockImplementationOnce(async () => {
				(section as any)._dashboardWorkflowGeneration++;
				return true;
			})
			.mockResolvedValueOnce(true);

		await (section as any)._handleIframeMessage({
			data: nextPublishResult,
			source: null,
		} as MessageEvent);

		expect(mocks.requestPublishInfoPatch).toHaveBeenNthCalledWith(
			1,
			section.boxId,
			expect.objectContaining({ reportId: 'report-new', semanticModelId: 'model-new' }),
			nextPublishResult.requestId,
			'apply',
		);
		expect(mocks.requestPublishInfoPatch).toHaveBeenNthCalledWith(
			2,
			section.boxId,
			previousPublishInfo,
			nextPublishResult.requestId,
			'compensate',
		);
		expect(section.getPbiPublishInfo()).toEqual(previousPublishInfo);
		expect(mocks.postMessageToHost).toHaveBeenCalledWith({
			type: 'publishToPowerBIAck', requestId: nextPublishResult.requestId, accepted: false,
		});
	});
});
