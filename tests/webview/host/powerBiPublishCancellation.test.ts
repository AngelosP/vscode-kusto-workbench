import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';

import {
	canDeleteCreatedSemanticModelForTest,
	createExternalCommitGateForTest,
	createPowerBiPublishTempUriForTest,
	getFabricItemsContinuationPathForTest,
	getPowerBiSessionForAccountForTest,
	publishToPowerBIService,
	selectExactFabricItemIdForTest,
} from '../../../src/host/powerBiPublish';
import { PortableDashboardAdmissionError } from '../../../src/shared/portableDashboardCompiler';

describe('Power BI publish cancellation', () => {
	it('rejects cancellation that lands before the first external commit admission', async () => {
		const controller = new AbortController();
		const gate = createExternalCommitGateForTest(controller.signal);
		controller.abort();

		await expect(gate.dispatch(async () => 'never')).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }));
	});

	it('does not reinterpret an admitted immutable external snapshot after cancellation', async () => {
		const controller = new AbortController();
		const gate = createExternalCommitGateForTest(controller.signal);
		await expect(gate.dispatch(async () => 'committed')).resolves.toBe('committed');
		controller.abort();

		await expect(gate.dispatch(async () => 'settled')).resolves.toBe('settled');
	});

	it('allocates collision-proof temporary roots for concurrent publish preparation', () => {
		const first = createPowerBiPublishTempUriForTest().toString();
		const second = createPowerBiPublishTempUriForTest().toString();

		expect(first).not.toBe(second);
		expect(first).toContain('kw-pbi-publish-');
		expect(second).toContain('kw-pbi-publish-');
	});

	it('rejects publish preparation with typed diagnostics before filesystem or Fabric effects', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {
				'total-actions': { display: { type: 'scalar', agg: 'SUM', column: 'MissingMetric' } },
			},
		})}</script><span data-kw-bind="total-actions"></span>`;
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const deletePath = vi.spyOn(vscode.workspace.fs, 'delete');
		const getSession = vi.spyOn(vscode.authentication, 'getSession');
		const fabricFetch = vi.spyOn(globalThis, 'fetch');

		let error: unknown;
		try {
			await publishToPowerBIService({
				workspaceId: 'workspace-1',
				reportName: 'Missing column',
				pageWidth: 1280,
				pageHeight: 720,
				htmlCode,
				dataSources: [{
					name: 'Fact Events',
					sectionId: 'query_fact',
					clusterUrl: 'https://cluster.kusto.windows.net',
					database: 'db',
					query: 'FactEvents',
					columns: [{ name: 'ExistingMetric', type: 'long' }],
				}],
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(PortableDashboardAdmissionError);
		expect((error as PortableDashboardAdmissionError).diagnostics).toEqual([{
			code: 'missing-column',
			severity: 'error',
			message: 'total-actions (column: missing column MissingMetric)',
			bindingKey: 'total-actions',
			role: 'column',
			columnName: 'MissingMetric',
		}]);
		expect(createDirectory).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		expect(deletePath).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
		expect(fabricFetch).not.toHaveBeenCalled();
		createDirectory.mockRestore();
		writeFile.mockRestore();
		deletePath.mockRestore();
		getSession.mockRestore();
		fabricFetch.mockRestore();
	});

	it('rejects a target written only inside textarea text before filesystem or Fabric effects', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {
				total: { display: { type: 'scalar', agg: 'COUNT' } },
			},
		})}</script><textarea><span data-kw-bind="total"></span></textarea>`;
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const deletePath = vi.spyOn(vscode.workspace.fs, 'delete');
		const getSession = vi.spyOn(vscode.authentication, 'getSession');
		const fabricFetch = vi.spyOn(globalThis, 'fetch');

		let error: unknown;
		try {
			await publishToPowerBIService({
				workspaceId: 'workspace-1',
				reportName: 'Textarea target',
				pageWidth: 1280,
				pageHeight: 720,
				htmlCode,
				dataSources: [{
					name: 'Fact Events',
					sectionId: 'query_fact',
					clusterUrl: 'https://cluster.kusto.windows.net',
					database: 'db',
					query: 'FactEvents',
					columns: [{ name: 'ExistingMetric', type: 'long' }],
				}],
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(PortableDashboardAdmissionError);
		expect((error as PortableDashboardAdmissionError).diagnostics).toEqual([{
			code: 'missing-target',
			severity: 'error',
			message: 'total (missing data-kw-bind target)',
			bindingKey: 'total',
		}]);
		expect(createDirectory).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		expect(deletePath).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
		expect(fabricFetch).not.toHaveBeenCalled();
		createDirectory.mockRestore();
		writeFile.mockRestore();
		deletePath.mockRestore();
		getSession.mockRestore();
		fabricFetch.mockRestore();
	});

	it('rejects browser-generated duplicate targets before filesystem or Fabric effects', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><b data-kw-bind="total">one<div>two</b>three</div>`;
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const getSession = vi.spyOn(vscode.authentication, 'getSession');
		const fabricFetch = vi.spyOn(globalThis, 'fetch');

		let error: unknown;
		try {
			await publishToPowerBIService({
				workspaceId: 'workspace-1', reportName: 'Generated duplicate',
				pageWidth: 1280, pageHeight: 720, htmlCode,
				dataSources: [{
					name: 'Fact Events', sectionId: 'query_fact',
					clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
					columns: [{ name: 'ExistingMetric', type: 'long' }],
				}],
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(PortableDashboardAdmissionError);
		expect((error as PortableDashboardAdmissionError).diagnostics[0]).toMatchObject({
			code: 'duplicate-target', bindingKey: 'total',
		});
		expect(writeFile).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
		expect(fabricFetch).not.toHaveBeenCalled();
		writeFile.mockRestore();
		getSession.mockRestore();
		fabricFetch.mockRestore();
	});

	it('rejects prefixed foster-parented content before filesystem or Fabric effects', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {
				rows: { display: { type: 'table', groupBy: ['ExistingMetric'], columns: [{ name: 'ExistingMetric' }] } },
			},
		})}</script>prefix<table data-kw-bind="rows">FOSTER_MARKER</table>`;
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const getSession = vi.spyOn(vscode.authentication, 'getSession');
		const fabricFetch = vi.spyOn(globalThis, 'fetch');
		let error: unknown;
		try {
			await publishToPowerBIService({
				workspaceId: 'workspace-1', reportName: 'Foster content',
				pageWidth: 1280, pageHeight: 720, htmlCode,
				dataSources: [{
					name: 'Fact Events', sectionId: 'query_fact',
					clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
					columns: [{ name: 'ExistingMetric', type: 'long' }],
				}],
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PortableDashboardAdmissionError);
		expect((error as PortableDashboardAdmissionError).diagnostics[0]).toMatchObject({
			code: 'invalid-target', bindingKey: 'rows',
		});
		expect(writeFile).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
		expect(fabricFetch).not.toHaveBeenCalled();
		writeFile.mockRestore();
		getSession.mockRestore();
		fabricFetch.mockRestore();
	});

	it('rejects target replacement that changes parser state outside the target before effects', async () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><table><form id="owner"><tr><td>`
			+ '<div data-kw-bind="total"><select><style></select></form></div>'
			+ '</td></tr></table><input id="outside" type="submit">';
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const getSession = vi.spyOn(vscode.authentication, 'getSession');
		const fabricFetch = vi.spyOn(globalThis, 'fetch');
		let error: unknown;
		try {
			await publishToPowerBIService({
				workspaceId: 'workspace-1', reportName: 'Parser state change',
				pageWidth: 1280, pageHeight: 720, htmlCode,
				dataSources: [{
					name: 'Fact Events', sectionId: 'query_fact',
					clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
					columns: [{ name: 'ExistingMetric', type: 'long' }],
				}],
			});
		} catch (caught) {
			error = caught;
		}
		expect(error).toBeInstanceOf(PortableDashboardAdmissionError);
		expect((error as PortableDashboardAdmissionError).diagnostics[0]).toMatchObject({
			code: 'invalid-target', bindingKey: 'total',
		});
		expect(writeFile).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
		expect(fabricFetch).not.toHaveBeenCalled();
		writeFile.mockRestore();
		getSession.mockRestore();
		fabricFetch.mockRestore();
	});

	it('rejects publish without provenance before filesystem or Fabric effects', async () => {
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const deletePath = vi.spyOn(vscode.workspace.fs, 'delete');
		const getSession = vi.spyOn(vscode.authentication, 'getSession');
		const fabricFetch = vi.spyOn(globalThis, 'fetch');

		let error: unknown;
		try {
			await publishToPowerBIService({
				workspaceId: 'workspace-1',
				reportName: 'Missing provenance',
				pageWidth: 1280,
				pageHeight: 720,
				htmlCode: '<main>Preview-only dashboard</main>',
				dataSources: [],
			});
		} catch (caught) {
			error = caught;
		}

		expect(error).toBeInstanceOf(PortableDashboardAdmissionError);
		expect((error as PortableDashboardAdmissionError).diagnostics).toEqual([{
			code: 'missing-provenance',
			severity: 'error',
			message: 'Missing application/kw-provenance block. Ask Kusto Workbench to make this dashboard exportable to Power BI.',
		}]);
		expect(createDirectory).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		expect(deletePath).not.toHaveBeenCalled();
		expect(getSession).not.toHaveBeenCalled();
		expect(fabricFetch).not.toHaveBeenCalled();
		createDirectory.mockRestore();
		writeFile.mockRestore();
		deletePath.mockRestore();
		getSession.mockRestore();
		fabricFetch.mockRestore();
	});

	it('recovers only an exact unique staging-name match', () => {
		const items = [
			{ id: 'unrelated', displayName: 'Dashboard' },
			{ id: 'exact', displayName: 'kw-transaction-report' },
		];

		expect(selectExactFabricItemIdForTest(items, 'kw-transaction-report', 'Report')).toBe('exact');
		expect(selectExactFabricItemIdForTest(items, 'missing', 'Report')).toBeUndefined();
		expect(() => selectExactFabricItemIdForTest([
			...items,
			{ id: 'duplicate', displayName: 'kw-transaction-report' },
		], 'kw-transaction-report', 'Report')).toThrow(/multiple Report items/);
	});

	it('retains a model when a dispatched report may exist but its ID is unresolved', () => {
		expect(canDeleteCreatedSemanticModelForTest(true, '')).toBe(false);
		expect(canDeleteCreatedSemanticModelForTest(true, 'report-id')).toBe(true);
		expect(canDeleteCreatedSemanticModelForTest(false, '')).toBe(true);
	});

	it('continues exact staging recovery through URI, body-token, and header-token pagination', () => {
		const basePath = '/workspaces/w/items?type=Report';
		expect(getFabricItemsContinuationPathForTest(
			{ continuationUri: 'https://api.fabric.microsoft.com/next' }, new Headers(), basePath,
		)).toBe('https://api.fabric.microsoft.com/next');
		expect(getFabricItemsContinuationPathForTest(
			{ continuationToken: 'body token' }, new Headers(), basePath,
		)).toBe(`${basePath}&continuationToken=body%20token`);
		expect(getFabricItemsContinuationPathForTest(
			{}, new Headers({ 'x-ms-continuation-token': 'header token' }), basePath,
		)).toBe(`${basePath}&continuationToken=header%20token`);
	});

	it('pins Power BI refresh authentication to the captured Fabric account', async () => {
		const account = { id: 'fabric-account', label: 'Fabric account' };
		const acquireSession = vi.fn(async (requestedAccount: typeof account) => ({
			accessToken: 'pbi-token', account: requestedAccount,
		}));

		await expect(getPowerBiSessionForAccountForTest(account, acquireSession)).resolves.toEqual({
			accessToken: 'pbi-token', account,
		});
		expect(acquireSession).toHaveBeenCalledWith(account);
		await expect(getPowerBiSessionForAccountForTest(account, async () => ({
			accessToken: 'other-token', account: { id: 'other-account', label: 'Other account' },
		}))).resolves.toBeUndefined();
	});
});