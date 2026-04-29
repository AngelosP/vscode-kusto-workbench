import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { html, nothing, render } from 'lit';

const testState = vi.hoisted(() => ({
	postMessageToHost: vi.fn(),
}));

vi.mock('../../src/webview/shared/webview-messages.js', () => ({
	postMessageToHost: testState.postMessageToHost,
}));

import '../../src/webview/components/kw-publish-pbi-dialog.js';
import type { KwPublishPbiDialog } from '../../src/webview/components/kw-publish-pbi-dialog.js';

type PostedMessage = { type: string; [key: string]: unknown };

const boxId = 'html_1';
const dataSources = [
	{
		name: 'Fact Events',
		sectionId: 'query_1',
		clusterUrl: 'https://cluster.example',
		database: 'db',
		query: 'FactEvents',
		columns: [{ name: 'Day', type: 'datetime' }],
	},
];
const htmlCode = '<main data-kw-bind="total"></main>';
const workspaces = [
	{ id: 'workspace-1', name: 'Analytics', isPersonal: false },
	{ id: 'workspace-2', name: 'Other', isPersonal: false },
];
const storedPublishInfo = {
	workspaceId: 'workspace-1',
	workspaceName: 'Analytics',
	semanticModelId: 'model-1',
	reportId: 'report-1',
	reportName: 'Ops Dashboard',
	reportUrl: 'https://app.powerbi.com/groups/workspace-1/reports/report-1',
};
type StoredPublishInfo = typeof storedPublishInfo & { dataMode?: 'import' | 'directQuery' };

let container: HTMLDivElement;
let currentDialog: KwPublishPbiDialog | undefined;

function createDialog(): KwPublishPbiDialog {
	render(html`<kw-publish-pbi-dialog></kw-publish-pbi-dialog>`, container);
	const dialog = container.querySelector('kw-publish-pbi-dialog');
	if (!dialog) throw new Error('kw-publish-pbi-dialog was not rendered');
	currentDialog = dialog;
	return dialog;
}

async function waitForUpdate(dialog: KwPublishPbiDialog): Promise<void> {
	await dialog.updateComplete;
	await dialog.updateComplete;
}

async function showDialog(dialog: KwPublishPbiDialog, pbiPublishInfo?: StoredPublishInfo): Promise<void> {
	dialog.show(dataSources, htmlCode, 'Ops Dashboard', 720, boxId, pbiPublishInfo);
	await waitForUpdate(dialog);
}

async function sendWorkspaces(dialog: KwPublishPbiDialog): Promise<void> {
	dialog.handleHostMessage({ type: 'pbiWorkspacesResult', boxId, ok: true, workspaces });
	await waitForUpdate(dialog);
}

async function sendExists(dialog: KwPublishPbiDialog, exists: boolean): Promise<void> {
	dialog.handleHostMessage({ type: 'pbiItemExistsResult', boxId, exists });
	await waitForUpdate(dialog);
}

async function sendPublishSuccess(
	dialog: KwPublishPbiDialog,
	overrides: Partial<PostedMessage> = {},
): Promise<void> {
	dialog.handleHostMessage({
		type: 'publishToPowerBIResult',
		boxId,
		ok: true,
		reportUrl: 'https://app.powerbi.com/groups/workspace-1/reports/report-new',
		scheduleConfigured: true,
		initialRefreshTriggered: true,
		dataMode: 'import',
		semanticModelId: 'model-new',
		reportId: 'report-new',
		workspaceId: 'workspace-1',
		workspaceName: 'Analytics',
		reportName: 'Ops Dashboard',
		...overrides,
	});
	await waitForUpdate(dialog);
}

function primaryButton(dialog: KwPublishPbiDialog): HTMLButtonElement {
	const button = dialog.shadowRoot?.querySelector('.sd-f .sd-btn-primary');
	if (!button) throw new Error('Primary footer button was not rendered');
	return button as HTMLButtonElement;
}

function buttonText(button: HTMLButtonElement): string {
	return (button.textContent || '').replace(/\s+/g, ' ').trim();
}

function postedMessages(type: string): PostedMessage[] {
	return testState.postMessageToHost.mock.calls
		.map(call => call[0] as PostedMessage)
		.filter(message => message.type === type);
}

function lastPublishMessage(): PostedMessage {
	const messages = postedMessages('publishToPowerBI');
	if (messages.length === 0) throw new Error('No publishToPowerBI message was posted');
	return messages[messages.length - 1];
}

beforeEach(() => {
	container = document.createElement('div');
	document.body.appendChild(container);
	localStorage.clear();
	testState.postMessageToHost.mockClear();
});

afterEach(() => {
	currentDialog?.hide();
	render(nothing, container);
	container.remove();
	currentDialog = undefined;
	localStorage.clear();
	vi.restoreAllMocks();
});

describe('kw-publish-pbi-dialog', () => {
	it('defaults first-time publishes to Import and posts the selected data mode', async () => {
		localStorage.setItem('kw.publishPbi.lastWorkspaceId', 'workspace-1');
		localStorage.setItem('kw.publishPbi.lastWorkspaceName', 'Analytics');
		const dialog = createDialog();
		await showDialog(dialog);
		await sendWorkspaces(dialog);

		expect(dialog.shadowRoot?.textContent).toContain('Copies query results into the semantic model during refresh for faster report interactions.');
		expect(dialog.shadowRoot?.textContent).toContain('Keeps data in Kusto and queries the source when report visuals run.');

		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		expect(lastPublishMessage()).toMatchObject({ dataMode: 'import' });
	});

	it('posts DirectQuery when the user selects DirectQuery', async () => {
		localStorage.setItem('kw.publishPbi.lastWorkspaceId', 'workspace-1');
		localStorage.setItem('kw.publishPbi.lastWorkspaceName', 'Analytics');
		const dialog = createDialog();
		await showDialog(dialog);
		await sendWorkspaces(dialog);

		const directQueryButton = Array.from(dialog.shadowRoot?.querySelectorAll('.ppd-toggle-btn') || [])
			.find(button => (button.textContent || '').trim() === 'DirectQuery') as HTMLButtonElement | undefined;
		expect(directQueryButton).toBeTruthy();
		directQueryButton!.click();
		await waitForUpdate(dialog);

		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		expect(lastPublishMessage()).toMatchObject({ dataMode: 'directQuery' });
	});

	it('labels an existing stored report publish action as Re-publish and posts update IDs', async () => {
		const dialog = createDialog();
		await showDialog(dialog, storedPublishInfo);
		await sendWorkspaces(dialog);
		await sendExists(dialog, true);

		expect(buttonText(primaryButton(dialog))).toBe('Re-publish');

		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		const publish = lastPublishMessage();
		expect(publish).toMatchObject({
			type: 'publishToPowerBI',
			boxId,
			workspaceId: 'workspace-1',
			reportName: 'Ops Dashboard',
			semanticModelId: 'model-1',
			reportId: 'report-1',
			existingReportName: 'Ops Dashboard',
			dataMode: 'directQuery',
		});
	});

	it('uses stored Import mode for existing reports that were published with Import', async () => {
		const dialog = createDialog();
		await showDialog(dialog, { ...storedPublishInfo, dataMode: 'import' });
		await sendWorkspaces(dialog);
		await sendExists(dialog, true);

		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		expect(lastPublishMessage()).toMatchObject({ dataMode: 'import' });
	});

	it('defaults legacy stored reports to Import when publishing to a different workspace', async () => {
		const dialog = createDialog();
		await showDialog(dialog, storedPublishInfo);
		await sendWorkspaces(dialog);
		await sendExists(dialog, true);

		const workspaceInput = dialog.shadowRoot?.querySelector('.ppd-combo .ppd-input') as HTMLInputElement | null;
		expect(workspaceInput).toBeTruthy();
		workspaceInput!.value = '';
		workspaceInput!.dispatchEvent(new Event('input', { bubbles: true }));
		await waitForUpdate(dialog);

		const otherWorkspace = Array.from(dialog.shadowRoot?.querySelectorAll('.ppd-combo-item') || [])
			.find(item => (item.textContent || '').trim() === 'Other') as HTMLElement | undefined;
		expect(otherWorkspace).toBeTruthy();
		otherWorkspace!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
		await waitForUpdate(dialog);

		expect(buttonText(primaryButton(dialog))).toBe('Publish');
		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		const publish = lastPublishMessage();
		expect(publish).toMatchObject({ workspaceId: 'workspace-2', dataMode: 'import' });
		expect(publish).not.toHaveProperty('semanticModelId');
		expect(publish).not.toHaveProperty('reportId');
	});

	it('disables publishing while a stored report existence check is pending', async () => {
		const dialog = createDialog();
		await showDialog(dialog, storedPublishInfo);
		await sendWorkspaces(dialog);

		const primary = primaryButton(dialog);
		expect(buttonText(primary)).toBe('Re-publish');
		expect(primary.disabled).toBe(true);

		testState.postMessageToHost.mockClear();
		primary.click();
		expect(postedMessages('publishToPowerBI')).toHaveLength(0);
	});

	it('keeps stored publish IDs in Re-publish mode when existence check reports missing', async () => {
		const dialog = createDialog();
		await showDialog(dialog, storedPublishInfo);
		await sendWorkspaces(dialog);
		await sendExists(dialog, false);

		expect(buttonText(primaryButton(dialog))).toBe('Re-publish');

		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		expect(lastPublishMessage()).toMatchObject({
			semanticModelId: 'model-1',
			reportId: 'report-1',
			existingReportName: 'Ops Dashboard',
			dataMode: 'directQuery',
		});
	});

	it('turns a first successful publish into an immediate Re-publish action', async () => {
		localStorage.setItem('kw.publishPbi.lastWorkspaceId', 'workspace-1');
		localStorage.setItem('kw.publishPbi.lastWorkspaceName', 'Analytics');
		const dialog = createDialog();
		await showDialog(dialog);
		await sendWorkspaces(dialog);

		expect(buttonText(primaryButton(dialog))).toBe('Publish');
		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();
		expect(lastPublishMessage()).not.toHaveProperty('reportId');

		await sendPublishSuccess(dialog);

		expect(buttonText(primaryButton(dialog))).toBe('Re-publish');
		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();

		expect(lastPublishMessage()).toMatchObject({
			semanticModelId: 'model-new',
			reportId: 'report-new',
			existingReportName: 'Ops Dashboard',
			dataMode: 'import',
		});
	});

	it('ignores stale existence results after a publish success updated local metadata', async () => {
		localStorage.setItem('kw.publishPbi.lastWorkspaceId', 'workspace-1');
		localStorage.setItem('kw.publishPbi.lastWorkspaceName', 'Analytics');
		const dialog = createDialog();
		await showDialog(dialog);
		await sendWorkspaces(dialog);
		primaryButton(dialog).click();
		await sendPublishSuccess(dialog);

		await sendExists(dialog, false);

		expect(buttonText(primaryButton(dialog))).toBe('Re-publish');
		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();
		expect(lastPublishMessage()).toMatchObject({ reportId: 'report-new', semanticModelId: 'model-new' });
	});

	it('keeps publish-as-new success copy but makes the next action Re-publish', async () => {
		const dialog = createDialog();
		await showDialog(dialog, storedPublishInfo);
		await sendWorkspaces(dialog);
		await sendExists(dialog, true);

		const publishAsNew = Array.from(dialog.shadowRoot?.querySelectorAll('.ppd-toggle-btn') || [])
			.find(button => (button.textContent || '').includes('Publish as new')) as HTMLButtonElement | undefined;
		expect(publishAsNew).toBeTruthy();
		publishAsNew!.click();
		await waitForUpdate(dialog);

		expect(buttonText(primaryButton(dialog))).toBe('Publish');
		testState.postMessageToHost.mockClear();
		primaryButton(dialog).click();
		expect(lastPublishMessage()).toMatchObject({ dataMode: 'import' });
		expect(lastPublishMessage()).not.toHaveProperty('reportId');

		await sendPublishSuccess(dialog);

		expect(dialog.shadowRoot?.querySelector('.ppd-success-text')?.textContent).toBe('Published Successfully');
		expect(buttonText(primaryButton(dialog))).toBe('Re-publish');
	});

	it('renders success information with refresh schedule, initial refresh, and links', async () => {
		localStorage.setItem('kw.publishPbi.lastWorkspaceId', 'workspace-1');
		localStorage.setItem('kw.publishPbi.lastWorkspaceName', 'Analytics');
		const dialog = createDialog();
		await showDialog(dialog);
		await sendWorkspaces(dialog);
		primaryButton(dialog).click();
		await sendPublishSuccess(dialog);

		const rows = dialog.shadowRoot?.querySelectorAll('.ppd-status-success > .ppd-success-row') || [];
		expect(rows).toHaveLength(4);
		expect(rows[0].textContent).toContain('Published Successfully');
		expect(rows[1].textContent).toContain('Refresh schedule');
		expect(rows[1].textContent).toContain('Daily at 1:00 AM UTC');
		expect(rows[2].textContent).toContain('Initial refresh');
		expect(rows[2].textContent).toContain('Started');

		const links = Array.from(dialog.shadowRoot?.querySelectorAll('.ppd-success-link') || []) as HTMLAnchorElement[];
		expect(links.map(link => link.textContent)).toEqual(['View report', 'Semantic model settings']);
		expect(links[0].getAttribute('href')).toBe('https://app.powerbi.com/groups/workspace-1/reports/report-new');
		expect(links[1].getAttribute('href')).toBe('https://app.powerbi.com/groups/workspace-1/settings/datasets/model-new');
		expect(links.every(link => link.getAttribute('target') === '_blank')).toBe(true);
		expect(links.every(link => link.getAttribute('rel') === 'noopener noreferrer')).toBe(true);
	});
});