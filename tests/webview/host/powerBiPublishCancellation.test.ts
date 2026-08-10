import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import * as vscode from 'vscode';

import {
	canDeleteCreatedSemanticModelForTest,
	createExternalCommitGateForTest,
	getFabricItemsContinuationPathForTest,
	getPowerBiSessionForAccountForTest,
	preparePowerBiPublishArtifactsForTest,
	publishToPowerBIService,
	selectExactFabricItemIdForTest,
} from '../../../src/host/powerBiPublish';
import {
	validatePowerBiHtmlBindings,
	type PowerBiArtifactIdSource,
	type PowerBiDataSource,
} from '../../../src/host/powerBiExport';
import { compilePowerBiProjectArtifacts } from '../../../src/host/powerBiProjectArtifacts';
import { PortableDashboardAdmissionError } from '../../../src/shared/portableDashboardCompiler';

describe('Power BI publish cancellation', () => {
	function deterministicIdSource(): PowerBiArtifactIdSource {
		let uuidSequence = 0;
		let relationshipSequence = 0;
		let hexSequence = 0;
		let tokenSequence = 0;
		return {
			nextUuid: () => `00000000-0000-4000-8000-${String(++uuidSequence).padStart(12, '0')}`,
			nextRelationshipId: () => `10000000-0000-4000-8000-${String(++relationshipSequence).padStart(12, '0')}`,
			nextHex: length => (++hexSequence).toString(16).padStart(length, '0').slice(-length),
			nextToken: () => `token${++tokenSequence}`,
		};
	}

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

	it('prepares valid publish parts without filesystem mutation', () => {
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const deletePath = vi.spyOn(vscode.workspace.fs, 'delete');
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><span data-kw-bind="total">0</span>`;

		const prepared = preparePowerBiPublishArtifactsForTest({
			workspaceId: 'workspace-1',
			reportName: 'Manifest parity',
			pageWidth: 1280,
			pageHeight: 720,
			htmlCode,
			dataSources: [{
				name: 'Fact Events', sectionId: 'query_fact',
				clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
				columns: [{ name: 'ExistingMetric', type: 'long' }],
			}],
		});

		expect(prepared.modelParts.length).toBeGreaterThan(0);
		expect(prepared.reportParts.length).toBeGreaterThan(0);
		expect(createDirectory).not.toHaveBeenCalled();
		expect(writeFile).not.toHaveBeenCalled();
		expect(deletePath).not.toHaveBeenCalled();
		createDirectory.mockRestore();
		writeFile.mockRestore();
		deletePath.mockRestore();
	});

	it('prepares the same sorted bytes as local project compilation', () => {
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><span data-kw-bind="total">0</span>`;
		const dataSources: PowerBiDataSource[] = [{
			name: 'Fact Events', sectionId: 'query_fact',
			clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
			columns: [{ name: 'ExistingMetric', type: 'long' }],
		}];
		const publishInput = {
			workspaceId: 'workspace-1',
			reportName: 'Manifest parity',
			pageWidth: 1280,
			pageHeight: 720,
			htmlCode,
			dataSources,
		};
		const prepared = preparePowerBiPublishArtifactsForTest(publishInput, deterministicIdSource());
		const localManifest = compilePowerBiProjectArtifacts({
			htmlCode,
			sectionName: publishInput.reportName,
			projectName: 'Manifest_parity',
			dataSources,
			dataMode: 'import',
			previewHeight: publishInput.pageHeight,
		}, validatePowerBiHtmlBindings(htmlCode, dataSources), deterministicIdSource());

		expect(prepared.manifest.artifacts.map(artifact => ({
			path: artifact.path,
			bytes: Buffer.from(artifact.bytes).toString('base64'),
		}))).toEqual(localManifest.artifacts.map(artifact => ({
			path: artifact.path,
			bytes: Buffer.from(artifact.bytes).toString('base64'),
		})));
	});

	it('keeps publish source free of temporary filesystem staging', () => {
		const source = readFileSync(resolve(process.cwd(), 'src/host/powerBiPublish.ts'), 'utf8');

		expect(source).toContain('compilePowerBiProjectArtifacts');
		expect(source).toContain('powerBiProjectArtifactsToFabricParts');
		expect(source).not.toContain('workspace.fs');
		expect(source).not.toContain('os.tmpdir');
		expect(source).not.toContain('collectDefinitionParts');
		expect(source).not.toContain('exportHtmlToPowerBI');
	});

	it('publishes sorted manifest parts without local filesystem staging', async () => {
		const createDirectory = vi.spyOn(vscode.workspace.fs, 'createDirectory');
		const writeFile = vi.spyOn(vscode.workspace.fs, 'writeFile');
		const deletePath = vi.spyOn(vscode.workspace.fs, 'delete');
		const account = { id: 'fabric-account', label: 'Fabric account' };
		const getSession = vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({
			id: 'fabric-session',
			accessToken: 'fabric-token',
			account,
			scopes: [],
		});
		const requests: Array<{ url: string; method: string; body?: unknown }> = [];
		const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (resource, init) => {
			const url = String(resource);
			const method = init?.method || 'GET';
			const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
			requests.push({ url, method, body });
			if (url === 'https://api.fabric.microsoft.com/v1/workspaces/workspace-1/items' && method === 'POST') {
				const itemType = (body as { type?: string } | undefined)?.type;
				return new Response(JSON.stringify({ id: itemType === 'SemanticModel' ? 'model-id' : 'report-id' }), {
					status: 201,
					headers: { 'content-type': 'application/json' },
				});
			}
			if (url.startsWith('https://api.fabric.microsoft.com/v1/workspaces/workspace-1/items/') && method === 'PATCH') {
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/refreshSchedule') && method === 'PATCH') {
				return new Response('', { status: 200 });
			}
			if (url.endsWith('/refreshes') && method === 'POST') {
				return new Response('', { status: 202 });
			}
			throw new Error(`Unexpected request: ${method} ${url}`);
		});
		const htmlCode = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><span data-kw-bind="total">0</span>`;

		try {
			const result = await publishToPowerBIService({
				workspaceId: 'workspace-1',
				reportName: 'Manifest publish',
				pageWidth: 1280,
				pageHeight: 720,
				htmlCode,
				dataSources: [{
					name: 'Fact Events', sectionId: 'query_fact',
					clusterUrl: 'https://cluster.kusto.windows.net', database: 'db', query: 'FactEvents',
					columns: [{ name: 'ExistingMetric', type: 'long' }],
				}],
			});

			expect(result).toMatchObject({
				semanticModelId: 'model-id',
				reportId: 'report-id',
				createdNewItems: true,
				dataMode: 'import',
				scheduleConfigured: true,
				initialRefreshTriggered: true,
			});
			const createBodies = requests
				.filter(request => request.url.endsWith('/items') && request.method === 'POST')
				.map(request => request.body as { type: string; definition: { parts: Array<{ path: string; payload: string }> } });
			expect(createBodies.map(body => body.type)).toEqual(['SemanticModel', 'Report']);
			for (const body of createBodies) {
				const paths = body.definition.parts.map(part => part.path);
				expect(paths).toEqual([...paths].sort());
				expect(paths).not.toContain('.platform');
			}
			const reportDefinition = createBodies[1].definition.parts.find(part => part.path === 'definition.pbir');
			const reportDefinitionJson = JSON.parse(Buffer.from(reportDefinition!.payload, 'base64').toString('utf8'));
			expect(reportDefinitionJson.datasetReference.byConnection.connectionString)
				.toContain('Initial Catalog=model-id');
			expect(reportDefinitionJson.datasetReference.byConnection.connectionString)
				.toContain('semanticModelId=model-id');
			expect(createDirectory).not.toHaveBeenCalled();
			expect(writeFile).not.toHaveBeenCalled();
			expect(deletePath).not.toHaveBeenCalled();
		} finally {
			fetchMock.mockRestore();
			getSession.mockRestore();
			createDirectory.mockRestore();
			writeFile.mockRestore();
			deletePath.mockRestore();
		}
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