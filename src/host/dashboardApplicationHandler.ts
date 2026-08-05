import * as vscode from 'vscode';
import * as os from 'os';
import * as path from 'path';

import type { ConnectionManager } from './connectionManager';
import { openKustoWorkbenchAgentChat } from './copilotChatOpenUtils';
import type {
	CancelDashboardWorkflowMessage,
	CheckPbiItemExistsMessage,
	ExportDashboardMessage,
	GetPbiWorkspacesMessage,
	PublishToPowerBIAckMessage,
	PublishToPowerBIMessage,
	RequestHtmlDashboardUpgradeWithCopilotMessage,
	ShowPowerBiPartialPublishWarningMessage,
	ShowPowerBiPublishHelpMessage,
	ShowPowerBiUnsupportedVisualHelpMessage,
	IncomingWebviewMessage,
} from './queryEditorTypes';
import {
	exportHtmlToPowerBI,
	findUnsupportedPowerBiBindings,
	normalizePowerBiDataMode,
	type PowerBiDataMode,
} from './powerBiExport';
import {
	checkFabricItemExists,
	listFabricWorkspaces,
	publishToPowerBIService,
} from './powerBiPublish';
import type { WorkbenchLogger } from './workbenchLogger';
import { kustoClusterKey } from '../shared/kustoClusterUrls';
import type { PbiPublishInfo } from '../shared/htmlSectionDefinition';
import type { MarkdownDocumentProjection } from '../shared/markdownDocumentAggregate';

const GITHUB_ISSUES_URL = 'https://github.com/AngelosP/vscode-kusto-workbench/issues';

export type DashboardApplicationMessage =
	| ShowPowerBiPublishHelpMessage
	| ShowPowerBiPartialPublishWarningMessage
	| ShowPowerBiUnsupportedVisualHelpMessage
	| CancelDashboardWorkflowMessage
	| PublishToPowerBIAckMessage
	| ExportDashboardMessage
	| RequestHtmlDashboardUpgradeWithCopilotMessage
	| GetPbiWorkspacesMessage
	| PublishToPowerBIMessage
	| CheckPbiItemExistsMessage;

type PendingPowerBiPublishApplication = {
	cleanup?: () => Promise<boolean>;
	timer: ReturnType<typeof setTimeout>;
	boxId: string;
	publishInfo: Readonly<PbiPublishInfo>;
	applicationState: 'idle' | 'apply-in-flight' | 'applied' | 'compensate-in-flight' | 'compensated' | 'rejected';
	cleanupRequested: boolean;
	previousPublishInfo?: Readonly<PbiPublishInfo>;
	appliedDocumentRevision?: number;
	appliedSectionRevision?: number;
	finalizationInProgress: boolean;
};

type PowerBiPublishCleanupAdmission = (
	publishInfo: Readonly<PbiPublishInfo>,
	cleanup: () => Promise<boolean>,
	waitForPendingDocumentApplications: boolean,
) => Promise<boolean>;

export interface DashboardApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	beginPowerBiPublishDocumentApplication(
		requestIdInput: unknown,
		phaseInput: unknown,
		commandInput: unknown,
		expectedDocumentRevisionInput: unknown,
		currentProjection: MarkdownDocumentProjection,
	): boolean;
	settlePowerBiPublishDocumentApplication(
		requestIdInput: unknown,
		phaseInput: unknown,
		commandResultInput: unknown,
	): Promise<void>;
	setPowerBiPublishCleanupAdmission(admission: PowerBiPublishCleanupAdmission): void;
	dispose(): void;
}

export type DashboardApplicationHandlerOptions = {
	postMessage: (message: unknown) => Thenable<boolean>;
	isDisposed: () => boolean;
	output: WorkbenchLogger;
	connectionManager: ConnectionManager;
};

export class HostDashboardApplicationHandler implements DashboardApplicationHandler {
	private readonly dashboardWorkflowAbortControllers = new Map<string, AbortController>();
	private readonly pendingPowerBiPublishAcks = new Map<string, PendingPowerBiPublishApplication>();
	private powerBiPublishCleanupAdmission?: PowerBiPublishCleanupAdmission;

	constructor(private readonly options: DashboardApplicationHandlerOptions) {}

	private postMessage(message: unknown): Thenable<boolean> {
		return this.options.postMessage(message);
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		switch (message.type) {
			case 'showPowerBiPublishHelp':
				return this.showPowerBiPublishHelp(message);
			case 'showPowerBiPartialPublishWarning':
				return this.showPowerBiPartialPublishWarning(message);
			case 'showPowerBiUnsupportedVisualHelp':
				return this.showPowerBiUnsupportedVisualHelp(message);
			case 'cancelDashboardWorkflow':
				this.cancelWorkflow(message.requestId);
				return Promise.resolve();
			case 'publishToPowerBIAck':
				return this.acceptPowerBiPublishAck(message.requestId, message.accepted === true);
			case 'exportDashboard':
				return this.exportDashboard(message);
			case 'requestHtmlDashboardUpgradeWithCopilot':
				return this.requestHtmlDashboardUpgradeWithCopilot(message);
			case 'getPbiWorkspaces':
				return this.getPbiWorkspaces(message);
			case 'publishToPowerBI':
				return this.publishToPowerBI(message);
			case 'checkPbiItemExists':
				return this.checkPbiItemExists(message);
			default:
				return undefined;
		}
	}

	dispose(): void {
		for (const controller of this.dashboardWorkflowAbortControllers.values()) controller.abort();
		this.dashboardWorkflowAbortControllers.clear();
		for (const requestId of [...this.pendingPowerBiPublishAcks.keys()]) {
			void this.acceptPowerBiPublishAck(requestId, false);
		}
	}

	private beginWorkflow(requestIdInput: unknown): AbortController | undefined {
		const requestId = String(requestIdInput || '').trim();
		if (!requestId || this.options.isDisposed()) return undefined;
		this.cancelWorkflow(requestId);
		const controller = new AbortController();
		this.dashboardWorkflowAbortControllers.set(requestId, controller);
		return controller;
	}

	private isWorkflowCurrent(requestId: string, controller: AbortController): boolean {
		return !this.options.isDisposed() && !controller.signal.aborted
			&& this.dashboardWorkflowAbortControllers.get(requestId) === controller;
	}

	private finishWorkflow(requestId: string, controller: AbortController): void {
		if (this.dashboardWorkflowAbortControllers.get(requestId) === controller) {
			this.dashboardWorkflowAbortControllers.delete(requestId);
		}
	}

	private cancelWorkflow(requestIdInput: unknown): void {
		const requestId = String(requestIdInput || '').trim();
		if (!requestId) return;
		const controller = this.dashboardWorkflowAbortControllers.get(requestId);
		if (!controller) return;
		this.dashboardWorkflowAbortControllers.delete(requestId);
		controller.abort();
	}

	private async showPowerBiPublishHelp(message: ShowPowerBiPublishHelpMessage): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const workflow = this.beginWorkflow(requestId);
		if (!workflow) return;
		const sectionId = String(message.sectionId || '').trim();
		const sectionName = String(message.sectionName || '').trim();
		const sectionLabel = sectionName || sectionId || 'this HTML section';
		const fixAction = 'Fix it using Kusto Workbench';
		try {
			const selection = await vscode.window.showWarningMessage(
				`Power BI publish needs query-backed data bindings for ${sectionLabel}. Ask Kusto Workbench to add or fix the provenance block, connect it to query results, and then try publishing again.`,
				fixAction,
			);
			if (!sectionId || !this.isWorkflowCurrent(requestId, workflow)) return;
			this.postMessage({
				type: 'powerBiPublishHelpResult', requestId, boxId: sectionId,
				action: selection === fixAction ? 'fixWithKustoWorkbench' : 'dismissed',
			});
		} finally {
			this.finishWorkflow(requestId, workflow);
		}
	}

	private async showPowerBiPartialPublishWarning(message: ShowPowerBiPartialPublishWarningMessage): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const workflow = this.beginWorkflow(requestId);
		if (!workflow) return;
		const sectionId = String(message.sectionId || '').trim();
		const sectionName = String(message.sectionName || '').trim();
		const sectionLabel = sectionName || sectionId || 'this HTML section';
		const publishAnywayAction = 'Publish anyway';
		const fixAction = 'Fix with Kusto Workbench';
		try {
			const selection = await vscode.window.showWarningMessage(
				`Power BI can publish ${sectionLabel}, but Kusto Workbench found visuals or interactions that Power BI export cannot fully reproduce. Publish anyway to continue with the exportable parts, or ask Kusto Workbench to make the section 100% compatible with Power BI exporting first.`,
				publishAnywayAction,
				fixAction,
			);
			if (!this.isWorkflowCurrent(requestId, workflow)) return;

			const postResult = (action: 'publishAnyway' | 'fixWithKustoWorkbench' | 'dismissed'): void => {
				if (!sectionId || !requestId) return;
				this.postMessage({
					type: 'powerBiPartialPublishWarningResult',
					boxId: sectionId,
					requestId,
					action,
				});
			};

			if (selection === publishAnywayAction) {
				postResult('publishAnyway');
				return;
			}

			if (selection === fixAction) {
				postResult('fixWithKustoWorkbench');
				return;
			}

			postResult('dismissed');
		} finally {
			this.finishWorkflow(requestId, workflow);
		}
	}

	private async showPowerBiUnsupportedVisualHelp(message: ShowPowerBiUnsupportedVisualHelpMessage): Promise<void> {
		const requestId = String(message.requestId || '').trim();
		const workflow = this.beginWorkflow(requestId);
		if (!workflow) return;
		const openIssuesAction = 'Ask for it';
		const text = String(message.message || '').trim() || 'Power BI export does not support this chart type yet.';
		try {
			const selection = await vscode.window.showInformationMessage(text, openIssuesAction);
			if (selection === openIssuesAction && this.isWorkflowCurrent(requestId, workflow)) {
				await vscode.env.openExternal(vscode.Uri.parse(GITHUB_ISSUES_URL));
			}
		} finally {
			this.finishWorkflow(requestId, workflow);
		}
	}

	private async requestHtmlDashboardUpgradeWithCopilot(
		message: RequestHtmlDashboardUpgradeWithCopilotMessage,
	): Promise<void> {
		const sectionId = String(message.sectionId || '').trim();
		if (!sectionId) return;
		const prompt = this.buildHtmlDashboardUpgradePrompt(message);
		const opened = await openKustoWorkbenchAgentChat({ query: prompt, submit: true });
		if (!opened) {
			void vscode.window.showWarningMessage('Kusto Workbench could not start the Power BI upgrade chat automatically. Open the Kusto Workbench agent and ask it to make this HTML section exportable to Power BI.');
		}
	}

	private buildHtmlDashboardUpgradePrompt(message: RequestHtmlDashboardUpgradeWithCopilotMessage): string {
		const sectionId = String(message.sectionId || '').trim();
		const sectionName = String(message.sectionName || '').trim();
		const targetVersion = Number.isFinite(message.targetVersion) ? message.targetVersion : 1;
		const reasons = Array.isArray(message.reasons)
			? message.reasons.map(reason => String(reason || '').trim()).filter(reason => reason.length > 0)
			: [];
		const sectionLabel = sectionName ? `${sectionName} (${sectionId})` : sectionId;
		const reasonText = reasons.length > 0
			? reasons.map(reason => `- ${reason}`).join('\n')
			: '- The section is behind the current Power BI export contract.';

		return [
			`Upgrade HTML section ${sectionLabel} to the latest Kusto Workbench HTML dashboard Power BI export contract (version ${targetVersion}).`,
			'',
			'Make the dashboard 100% compatible with Power BI exporting before publishing.',
			'Preserve the dashboard look, layout, interactivity, and data semantics unless the Power BI export contract requires a change.',
			'Use provenance bindings and KustoWorkbench.renderChart, KustoWorkbench.renderTable, or KustoWorkbench.renderRepeatedTable where appropriate so the dashboard exports cleanly to Power BI.',
			'Do not make unrelated notebook changes.',
			'',
			'Issues detected:',
			reasonText,
			'',
			'After updating the section, validate the dashboard and fix any remaining export issues.',
		].join('\n');
	}

	private async exportDashboard(message: ExportDashboardMessage): Promise<void> {
		const workflow = this.beginWorkflow(message.requestId);
		if (!workflow) return;
		try {
			const htmlContent = String(message.html || '');
			if (!htmlContent.trim()) {
				vscode.window.showInformationMessage('No HTML content to export.');
				return;
			}

			const baseName = String(message.suggestedFileName || '').trim() || 'dashboard';
			const fileName = baseName.toLowerCase().endsWith('.html') || baseName.toLowerCase().endsWith('.htm')
				? baseName
				: baseName + '.html';
			const baseDir = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
			const defaultUri = vscode.Uri.joinPath(baseDir, fileName);

			const picked = await vscode.window.showSaveDialog({
				defaultUri,
				filters: {
					'HTML Files': ['html', 'htm'],
					'Power BI Project': ['pbip'],
				},
			});

			if (!picked || workflow.signal.aborted) return;

			const lower = picked.fsPath.toLowerCase();
			if (lower.endsWith('.pbip')) {
				if (!message.dataSources || message.dataSources.length === 0) {
					vscode.window.showWarningMessage('No data bindings found. Add a provenance block with data source references before exporting to Power BI.');
					return;
				}

				const unsupportedBindings = findUnsupportedPowerBiBindings(htmlContent);
				if (unsupportedBindings.length > 0) {
					vscode.window.showWarningMessage(`Power BI export supports scalar, table, repeatedTable, pivot, bar, pie, and line bindings. Unsupported bindings: ${unsupportedBindings.join(', ')}.`);
					return;
				}

				const projectName = path.basename(picked.fsPath).replace(/\.pbip$/i, '');
				const folderUri = vscode.Uri.file(path.dirname(picked.fsPath));
				const sectionName = message.dataSources[0]?.name || 'KustoHtmlDashboard';

				await exportHtmlToPowerBI(
					{ htmlCode: htmlContent, sectionName, projectName, dataSources: message.dataSources, dataMode: 'import', previewHeight: message.previewHeight },
					folderUri,
					{ signal: workflow.signal },
				);
				if (!this.isWorkflowCurrent(message.requestId, workflow)) return;

				const action = await vscode.window.showInformationMessage(
					`Power BI project exported to ${folderUri.fsPath}. Open the .pbip file in Power BI Desktop.`,
					'Open Folder',
					'Upload to Power BI',
				);
				if (!this.isWorkflowCurrent(message.requestId, workflow)) return;
				if (action === 'Open Folder') {
					await vscode.commands.executeCommand('revealFileInOS', folderUri);
				} else if (action === 'Upload to Power BI'
					&& this.isWorkflowCurrent(message.requestId, workflow)) {
					this.postMessage({
						type: 'openPublishPbiDialog',
						requestId: message.requestId,
						boxId: message.boxId,
						htmlCode: htmlContent,
						dataSources: message.dataSources,
						previewHeight: message.previewHeight,
						suggestedName: projectName,
					});
				}
			} else {
				let targetUri = picked;
				if (!lower.endsWith('.html') && !lower.endsWith('.htm')) {
					targetUri = vscode.Uri.file(picked.fsPath + '.html');
				}

				await vscode.workspace.fs.writeFile(targetUri, Buffer.from(htmlContent, 'utf8'));
				if (this.isWorkflowCurrent(message.requestId, workflow)) {
					vscode.window.showInformationMessage(`Saved HTML to ${targetUri.fsPath}`);
				}
			}
		} catch (error) {
			if (workflow.signal.aborted) return;
			this.options.output.error('[kusto] Dashboard export error:', error instanceof Error ? error : String(error));
			vscode.window.showErrorMessage('Failed to export dashboard: ' + (error instanceof Error ? error.message : String(error)));
		} finally {
			this.finishWorkflow(message.requestId, workflow);
		}
	}

	private async getPbiWorkspaces(message: GetPbiWorkspacesMessage): Promise<void> {
		const workflow = this.beginWorkflow(message.requestId);
		if (!workflow) return;
		try {
			const workspaces = await listFabricWorkspaces(workflow.signal);
			if (!this.isWorkflowCurrent(message.requestId, workflow)) return;
			this.postMessage({
				type: 'pbiWorkspacesResult', requestId: message.requestId,
				boxId: message.boxId, ok: true, workspaces,
			});
		} catch (error) {
			if (!this.isWorkflowCurrent(message.requestId, workflow)) return;
			const messageText = error instanceof Error ? error.message : String(error);
			this.options.output.error('[kusto] Power BI workspaces error:', error instanceof Error ? error : String(error));
			this.postMessage({
				type: 'pbiWorkspacesResult', requestId: message.requestId,
				boxId: message.boxId, ok: false, error: messageText,
			});
		} finally {
			this.finishWorkflow(message.requestId, workflow);
		}
	}

	private async publishToPowerBI(message: PublishToPowerBIMessage): Promise<void> {
		const workflow = this.beginWorkflow(message.requestId);
		if (!workflow) return;
		try {
			const unsupportedBindings = findUnsupportedPowerBiBindings(message.htmlCode);
			if (unsupportedBindings.length > 0) {
				const messageText = `Power BI publish supports scalar, table, repeatedTable, pivot, bar, pie, and line bindings. Unsupported bindings: ${unsupportedBindings.join(', ')}.`;
				vscode.window.showWarningMessage(messageText);
				this.postMessage({
					type: 'publishToPowerBIResult', requestId: message.requestId,
					boxId: message.boxId, ok: false, error: messageText,
				});
				return;
			}

			const hasExistingIds = !!(message.semanticModelId && message.reportId);
			const dataMode: PowerBiDataMode = normalizePowerBiDataMode(
				message.dataMode,
				hasExistingIds ? 'directQuery' : 'import',
			);
			if (dataMode === 'import' && message.dataSources.some(
				dataSource => this.options.connectionManager.isLeaveNoTrace(dataSource.clusterUrl),
			)) {
				const messageText = 'Import mode cannot be used with Leave No Trace clusters because it stores query results in Power BI. Select DirectQuery to keep data in Kusto.';
				vscode.window.showWarningMessage(messageText);
				this.postMessage({
					type: 'publishToPowerBIResult', requestId: message.requestId,
					boxId: message.boxId, ok: false, error: messageText,
				});
				return;
			}

			const result = await publishToPowerBIService({
				workspaceId: message.workspaceId,
				reportName: message.reportName,
				pageWidth: message.pageWidth,
				pageHeight: message.pageHeight,
				htmlCode: message.htmlCode,
				dataSources: message.dataSources,
				dataMode,
				semanticModelId: message.semanticModelId,
				reportId: message.reportId,
				existingReportName: message.existingReportName,
				isPersonalWorkspace: message.isPersonalWorkspace,
				signal: workflow.signal,
				firstCommitAdmission: async (_context, dispatch) => this.options.connectionManager.runWithLeaveNoTraceSnapshotLock(
					async policy => {
						const protectedClusters = new Set(policy.clusterKeys);
						if (dataMode === 'import' && (policy.globallyBlocked || message.dataSources.some(
							dataSource => protectedClusters.has(kustoClusterKey(dataSource.clusterUrl)),
						))) {
							throw new Error('Import mode was canceled because a source cluster is now Leave No Trace.');
						}
						return dispatch();
					},
				),
			});
			if (!this.isWorkflowCurrent(message.requestId, workflow)) {
				if (result.createdNewItems && result.cleanupCreatedItems) {
					const cleaned = await result.cleanupCreatedItems();
					if (!cleaned && !this.options.isDisposed()) {
						void vscode.window.showWarningMessage(
							'Power BI finished publishing after the dashboard changed, and Kusto Workbench could not fully clean up the retired items. Review the target workspace before publishing again.',
						);
					}
				} else if (!this.options.isDisposed()) {
					void vscode.window.showInformationMessage(
						`Power BI finished updating ${message.reportName}, but the dashboard changed before completion. The current section was not linked to that update.`,
					);
				}
				return;
			}
			const timer = setTimeout(() => {
				void this.acceptPowerBiPublishAck(message.requestId, false);
			}, 15_000);
			const publishInfo: PbiPublishInfo = {
				workspaceId: message.workspaceId,
				semanticModelId: result.semanticModelId,
				reportId: result.reportId,
				reportName: message.reportName,
				reportUrl: result.reportUrl,
				dataMode: result.dataMode,
			};
			if (message.workspaceName !== undefined) publishInfo.workspaceName = message.workspaceName;
			this.pendingPowerBiPublishAcks.set(message.requestId, {
				cleanup: result.createdNewItems ? result.cleanupCreatedItems : undefined,
				timer,
				boxId: message.boxId,
				publishInfo: Object.freeze(publishInfo),
				applicationState: 'idle',
				cleanupRequested: false,
				finalizationInProgress: false,
			});
			const delivered = await this.postMessage({
				type: 'publishToPowerBIResult', requestId: message.requestId, boxId: message.boxId, ok: true,
				reportUrl: result.reportUrl, scheduleConfigured: result.scheduleConfigured,
				initialRefreshTriggered: result.initialRefreshTriggered, dataMode: result.dataMode,
				semanticModelId: result.semanticModelId, reportId: result.reportId,
				workspaceId: message.workspaceId, reportName: message.reportName,
				workspaceName: message.workspaceName,
			});
			if (!delivered) {
				await this.acceptPowerBiPublishAck(message.requestId, false);
				return;
			}
		} catch (error) {
			if (!this.isWorkflowCurrent(message.requestId, workflow)) return;
			const messageText = error instanceof Error ? error.message : String(error);
			this.options.output.error('[kusto] Power BI publish error:', error instanceof Error ? error : String(error));
			this.postMessage({
				type: 'publishToPowerBIResult', requestId: message.requestId,
				boxId: message.boxId, ok: false, error: messageText,
			});
		} finally {
			this.finishWorkflow(message.requestId, workflow);
		}
	}

	private async checkPbiItemExists(message: CheckPbiItemExistsMessage): Promise<void> {
		const workflow = this.beginWorkflow(message.requestId);
		if (!workflow) return;
		try {
			const exists = await checkFabricItemExists(message.workspaceId, message.reportId, workflow.signal);
			if (!this.isWorkflowCurrent(message.requestId, workflow)) return;
			this.postMessage({
				type: 'pbiItemExistsResult', requestId: message.requestId, boxId: message.boxId, exists,
			});
		} catch (error) {
			if (!this.isWorkflowCurrent(message.requestId, workflow)) return;
			this.options.output.warn('[kusto] PBI item existence check failed:', error);
			this.postMessage({
				type: 'pbiItemExistsResult', requestId: message.requestId, boxId: message.boxId, exists: false,
			});
		} finally {
			this.finishWorkflow(message.requestId, workflow);
		}
	}

	private async acceptPowerBiPublishAck(requestIdInput: unknown, accepted: boolean): Promise<void> {
		const requestId = String(requestIdInput || '').trim();
		const pending = this.pendingPowerBiPublishAcks.get(requestId);
		if (!pending) return;
		if (accepted) {
			await this.finalizePowerBiPublishApplication(requestId, pending, false, true);
			return;
		}
		pending.cleanupRequested = true;
		if (pending.applicationState === 'apply-in-flight'
			|| pending.applicationState === 'compensate-in-flight') return;
		if (pending.applicationState === 'applied') {
			if (this.options.isDisposed()) {
				await this.finalizePowerBiPublishApplication(requestId, pending, false, true);
				return;
			}
			this.rearmPowerBiPublishApplication(requestId, pending);
			return;
		}
		const cleanup = pending.applicationState === 'idle'
			|| pending.applicationState === 'rejected'
			|| pending.applicationState === 'compensated';
		await this.finalizePowerBiPublishApplication(requestId, pending, cleanup, true);
	}

	beginPowerBiPublishDocumentApplication(
		requestIdInput: unknown,
		phaseInput: unknown,
		commandInput: unknown,
		expectedDocumentRevisionInput: unknown,
		currentProjection: MarkdownDocumentProjection,
	): boolean {
		const requestId = String(requestIdInput || '').trim();
		if (phaseInput !== 'apply' && phaseInput !== 'compensate') return false;
		const phase = phaseInput;
		const pending = this.pendingPowerBiPublishAcks.get(requestId);
		if (!pending) return false;
		if (!commandInput || typeof commandInput !== 'object' || Array.isArray(commandInput)) return false;
		const command = commandInput as Record<string, unknown>;
		if (command.type !== 'patch' || String(command.sectionId || '').trim() !== pending.boxId
			|| !command.patch || typeof command.patch !== 'object' || Array.isArray(command.patch)) return false;
		const patch = command.patch as Record<string, unknown>;
		if (Object.keys(patch).length !== 1 || !Object.prototype.hasOwnProperty.call(patch, 'pbiPublishInfo')) return false;
		if (!currentProjection || !Array.isArray(currentProjection.htmlSections)
			|| !currentProjection.sectionRevisions) return false;
		const expectedDocumentRevision = Number(expectedDocumentRevisionInput);
		const expectedSectionRevision = Number(command.expectedSectionRevision);
		const currentSection = currentProjection.htmlSections.find(section => section.id === pending.boxId);
		if (!currentSection
			|| expectedDocumentRevision !== currentProjection.documentRevision
			|| expectedSectionRevision !== currentProjection.sectionRevisions[pending.boxId]) return false;
		if (phase === 'apply') {
			const publishInfo = patch.pbiPublishInfo;
			if (!publishInfo || typeof publishInfo !== 'object' || Array.isArray(publishInfo)) return false;
			if (!this.powerBiPublishInfoEquals(publishInfo as PbiPublishInfo, pending.publishInfo)) return false;
		} else {
			const restoreInfo = patch.pbiPublishInfo;
			if (pending.previousPublishInfo
				? !restoreInfo || typeof restoreInfo !== 'object' || Array.isArray(restoreInfo)
					|| !this.powerBiPublishInfoEquals(restoreInfo as PbiPublishInfo, pending.previousPublishInfo)
				: restoreInfo !== null) return false;
		}
		if (phase === 'apply' && pending.applicationState !== 'idle') return false;
		if (phase === 'compensate' && (pending.applicationState !== 'applied'
			|| pending.appliedDocumentRevision !== expectedDocumentRevision
			|| pending.appliedSectionRevision !== expectedSectionRevision
			|| !this.powerBiPublishInfoEquals(currentSection.pbiPublishInfo, pending.publishInfo))) return false;
		if (phase === 'apply') {
			pending.previousPublishInfo = currentSection.pbiPublishInfo
				? Object.freeze({ ...currentSection.pbiPublishInfo })
				: undefined;
		}
		pending.applicationState = phase === 'apply' ? 'apply-in-flight' : 'compensate-in-flight';
		return true;
	}

	async settlePowerBiPublishDocumentApplication(
		requestIdInput: unknown,
		phaseInput: unknown,
		commandResultInput: unknown,
	): Promise<void> {
		const requestId = String(requestIdInput || '').trim();
		if (phaseInput !== 'apply' && phaseInput !== 'compensate') return;
		const phase = phaseInput;
		const pending = this.pendingPowerBiPublishAcks.get(requestId);
		if (!pending) return;
		if (phase === 'apply' && pending.applicationState !== 'apply-in-flight') return;
		if (phase === 'compensate' && pending.applicationState !== 'compensate-in-flight') return;
		const commandResult = commandResultInput && typeof commandResultInput === 'object'
			? commandResultInput as Record<string, unknown> : undefined;
		const projection = commandResult?.projection as MarkdownDocumentProjection | undefined;
		const section = projection?.htmlSections?.find(candidate => candidate.id === pending.boxId);
		const committed = commandResult?.ok === true && !!projection
			&& Number(commandResult.documentRevision) === projection.documentRevision
			&& (phase === 'apply'
				? !!section && this.powerBiPublishInfoEquals(section.pbiPublishInfo, pending.publishInfo)
					&& Number(commandResult.sectionRevision) === projection.sectionRevisions[pending.boxId]
				: !!section && (pending.previousPublishInfo
					? this.powerBiPublishInfoEquals(section.pbiPublishInfo, pending.previousPublishInfo)
					: section.pbiPublishInfo === undefined));
		pending.applicationState = phase === 'apply'
			? committed ? 'applied' : 'rejected'
			: committed ? 'compensated' : 'applied';
		if (phase === 'apply' && committed) {
			pending.appliedDocumentRevision = projection!.documentRevision;
			pending.appliedSectionRevision = projection!.sectionRevisions[pending.boxId];
		}
		if (pending.finalizationInProgress || !pending.cleanupRequested) return;
		if (pending.applicationState === 'applied') {
			if (this.options.isDisposed()) {
				await this.finalizePowerBiPublishApplication(requestId, pending, false, false);
			} else {
				this.rearmPowerBiPublishApplication(requestId, pending);
			}
			return;
		}
		const cleanup = pending.applicationState === 'rejected'
			|| pending.applicationState === 'compensated';
		await this.finalizePowerBiPublishApplication(requestId, pending, cleanup, false);
	}

	setPowerBiPublishCleanupAdmission(admission: PowerBiPublishCleanupAdmission): void {
		this.powerBiPublishCleanupAdmission = admission;
	}

	private async finalizePowerBiPublishApplication(
		requestId: string,
		pending: PendingPowerBiPublishApplication,
		cleanupWithoutAdmission: boolean,
		waitForPendingDocumentApplications: boolean,
	): Promise<void> {
		if (this.pendingPowerBiPublishAcks.get(requestId) !== pending
			|| pending.finalizationInProgress) return;
		pending.finalizationInProgress = true;
		clearTimeout(pending.timer);
		try {
			if (pending.cleanup) {
				if (this.powerBiPublishCleanupAdmission) {
					const finalized = await this.powerBiPublishCleanupAdmission(
						pending.publishInfo, pending.cleanup, waitForPendingDocumentApplications,
					);
					if (!finalized) {
						this.options.output.warn('[kusto] Power BI cleanup could not be authorized; retaining published items.');
					}
				} else if (cleanupWithoutAdmission) {
					await pending.cleanup();
				}
			}
		} catch (error) {
			this.options.output.warn('[kusto] Power BI cleanup admission failed; retaining published items.', error);
		} finally {
			this.finishPowerBiPublishApplication(requestId, pending);
		}
	}

	private powerBiPublishInfoEquals(left: PbiPublishInfo | undefined, right: Readonly<PbiPublishInfo>): boolean {
		if (!left) return false;
		const leftRecord = left as unknown as Record<string, unknown>;
		const rightRecord = right as unknown as Record<string, unknown>;
		const leftKeys = Object.keys(leftRecord).filter(key => leftRecord[key] !== undefined).sort();
		const rightKeys = Object.keys(rightRecord).filter(key => rightRecord[key] !== undefined).sort();
		return leftKeys.length === rightKeys.length
			&& leftKeys.every((key, index) => key === rightKeys[index])
			&& left.workspaceId === right.workspaceId
			&& left.workspaceName === right.workspaceName
			&& left.semanticModelId === right.semanticModelId
			&& left.reportId === right.reportId
			&& left.reportName === right.reportName
			&& left.reportUrl === right.reportUrl
			&& left.dataMode === right.dataMode;
	}

	private finishPowerBiPublishApplication(
		requestId: string,
		pending: PendingPowerBiPublishApplication,
	): void {
		if (this.pendingPowerBiPublishAcks.get(requestId) !== pending) return;
		this.pendingPowerBiPublishAcks.delete(requestId);
		clearTimeout(pending.timer);
	}

	private rearmPowerBiPublishApplication(
		requestId: string,
		pending: PendingPowerBiPublishApplication,
	): void {
		clearTimeout(pending.timer);
		pending.timer = setTimeout(() => {
			const current = this.pendingPowerBiPublishAcks.get(requestId);
			if (current !== pending) return;
			void this.finalizePowerBiPublishApplication(requestId, pending, false, true);
		}, 5_000);
	}
}
