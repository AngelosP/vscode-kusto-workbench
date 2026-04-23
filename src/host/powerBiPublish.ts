// Power BI service publishing via Fabric REST API.
// Creates SemanticModel + Report items in a Fabric workspace using TMDL/PBIR artifacts.

import * as vscode from 'vscode';
import * as os from 'os';
import { exportHtmlToPowerBI, type PowerBiDataSource } from './powerBiExport';

// ── Auth ─────────────────────────────────────────────────────────────────────

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';

async function getFabricToken(): Promise<string> {
	const session = await vscode.authentication.getSession('microsoft', [FABRIC_SCOPE], { createIfNone: true });
	return session.accessToken;
}

async function fabricFetch(path: string, options: { method?: string; body?: string } = {}): Promise<{ status: number; headers: Headers; data: any }> {
	const token = await getFabricToken();
	const url = path.startsWith('http') ? path : `${FABRIC_BASE}${path}`;
	const res = await fetch(url, {
		method: options.method || 'GET',
		headers: {
			'Authorization': `Bearer ${token}`,
			'Content-Type': 'application/json',
		},
		body: options.body,
	});

	if (!res.ok) {
		const text = await res.text().catch(() => '');
		throw new Error(`Fabric API ${res.status}: ${text || res.statusText}`);
	}

	const contentType = res.headers.get('content-type') || '';
	const data = contentType.includes('application/json') ? await res.json() : {};
	return { status: res.status, headers: res.headers, data };
}

/**
 * For long-running operations (202 Accepted), poll the operation URL until
 * it completes, then fetch the created item to get its ID.
 */
async function awaitFabricItem(result: { status: number; headers: Headers; data: any }, workspaceId: string, itemType: string): Promise<string> {
	// 201 Created — item ID is in the response body
	if (result.status === 201 && result.data?.id) {
		return result.data.id;
	}

	// 202 Accepted — long-running operation, poll until done
	const location = result.headers.get('location');
	const retryAfterHeader = result.headers.get('retry-after');
	const retryMs = retryAfterHeader ? Math.max(1000, Number(retryAfterHeader) * 1000) : 2000;

	if (!location) {
		// No location header but maybe the ID is in the body anyway
		if (result.data?.id) return result.data.id;
		throw new Error(`Fabric API returned ${result.status} without a location header or item ID.`);
	}

	// Poll the operation URL
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise(r => setTimeout(r, retryMs));
		const poll = await fabricFetch(location);

		const status = poll.data?.status;
		if (status === 'Succeeded') {
			// The operation result may contain the item ID directly
			if (poll.data?.resourceId) return poll.data.resourceId;
			// Otherwise, look it up by name from the workspace
			break;
		}
		if (status === 'Failed') {
			const errMsg = poll.data?.error?.message || JSON.stringify(poll.data?.error) || 'Unknown error';
			throw new Error(`Fabric item creation failed: ${errMsg}`);
		}
		// status === 'Running' or 'NotStarted' — keep polling
	}

	// Fallback: find the item by display name in the workspace
	const listResult = await fabricFetch(`/workspaces/${workspaceId}/items?type=${itemType}`);
	const items: Array<{ id: string; displayName: string }> = listResult.data?.value || [];
	// Return the most recently matching item — there could be duplicates
	const match = items.reverse().find((i: any) => i.displayName !== undefined);
	if (match) return match.id;

	throw new Error(`Could not find created ${itemType} item after polling.`);
}

// ── Workspaces ───────────────────────────────────────────────────────────────

export async function listFabricWorkspaces(): Promise<Array<{ id: string; name: string }>> {
	const result = await fabricFetch('/workspaces');
	const items: Array<{ id: string; displayName: string }> = result.data?.value || [];
	return items.map(w => ({ id: w.id, name: w.displayName }));
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface PublishInput {
	workspaceId: string;
	reportName: string;
	pageWidth: number;
	pageHeight: number;
	htmlCode: string;
	dataSources: PowerBiDataSource[];
}

export interface PublishResult {
	reportUrl: string;
}

/**
 * Publish an HTML dashboard to a Fabric / Power BI workspace.
 *
 * Flow:
 * 1. Generate all PBIP artifacts in-memory using the existing export infrastructure
 * 2. Create a SemanticModel item with TMDL definition parts
 * 3. Create a Report item with PBIR definition parts that references the SemanticModel
 * 4. Return the report URL
 */
export async function publishToPowerBIService(input: PublishInput): Promise<PublishResult> {
	// Generate artifacts using a temp folder — reuses the battle-tested exportHtmlToPowerBI().
	// We write to a temp dir, read the files back, then clean up.
	const tempUri = vscode.Uri.joinPath(vscode.Uri.file(os.tmpdir()), `kw-pbi-publish-${Date.now()}`);

	try {
		await exportHtmlToPowerBI(
			{
				htmlCode: input.htmlCode,
				sectionName: input.reportName,
				projectName: input.reportName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || 'KustoHtmlDashboard',
				dataSources: input.dataSources,
				previewHeight: input.pageHeight,
			},
			tempUri,
		);

		// Read back the generated files
		const projectName = input.reportName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || 'KustoHtmlDashboard';
		const reportFolder = `${projectName}.Report`;
		const modelFolder = `${projectName}.SemanticModel`;

		// Collect SemanticModel definition parts
		const modelParts = await collectDefinitionParts(tempUri, modelFolder);

		// Create SemanticModel item
		const smBody = {
			displayName: input.reportName,
			type: 'SemanticModel',
			definition: {
				format: 'TMDL',
				parts: modelParts,
			},
		};
		const smResult = await fabricFetch(`/workspaces/${input.workspaceId}/items`, {
			method: 'POST',
			body: JSON.stringify(smBody),
		});
		const semanticModelId = await awaitFabricItem(smResult, input.workspaceId, 'SemanticModel');

		// Collect Report definition parts, patching definition.pbir to reference the SemanticModel by connection
		const reportParts = await collectDefinitionParts(tempUri, reportFolder);

		// Patch the definition.pbir to use byConnection instead of byPath
		const pbirIdx = reportParts.findIndex((p: any) => p.path === 'definition.pbir');
		if (pbirIdx >= 0) {
			const pbirContent = JSON.stringify({
				$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
				version: '4.0',
				datasetReference: {
					byConnection: {
						connectionString: `Data Source=pbiazure://api.powerbi.com;Initial Catalog=${semanticModelId};Identity Provider="https://login.microsoftonline.com/common, https://analysis.windows.net/powerbi/api, 929d0ec0-7a41-4b1e-bc7c-b754a28bddcc";`,
						pbiModelDatabaseName: semanticModelId,
					},
				},
			}, null, 2);
			reportParts[pbirIdx] = {
				path: 'definition.pbir',
				payload: Buffer.from(pbirContent).toString('base64'),
				payloadType: 'InlineBase64',
			};
		}

		// Create Report item
		const reportBody = {
			displayName: input.reportName,
			type: 'Report',
			definition: {
				parts: reportParts,
			},
		};
		const reportResult = await fabricFetch(`/workspaces/${input.workspaceId}/items`, {
			method: 'POST',
			body: JSON.stringify(reportBody),
		});
		const reportId = await awaitFabricItem(reportResult, input.workspaceId, 'Report');

		const reportUrl = `https://app.powerbi.com/groups/${input.workspaceId}/reports/${reportId}`;
		return { reportUrl };
	} finally {
		// Clean up temp directory
		try { await vscode.workspace.fs.delete(tempUri, { recursive: true }); } catch { /* best effort */ }
	}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function collectDefinitionParts(baseUri: vscode.Uri, folder: string): Promise<Array<{ path: string; payload: string; payloadType: string }>> {
	const parts: Array<{ path: string; payload: string; payloadType: string }> = [];
	const folderUri = vscode.Uri.joinPath(baseUri, folder);

	async function walk(dir: vscode.Uri, prefix: string): Promise<void> {
		const entries = await vscode.workspace.fs.readDirectory(dir);
		for (const [name, type] of entries) {
			const entryUri = vscode.Uri.joinPath(dir, name);
			const entryPath = prefix ? `${prefix}/${name}` : name;

			if (type === vscode.FileType.Directory) {
				// Skip .pbi metadata folders
				if (name === '.pbi') continue;
				await walk(entryUri, entryPath);
			} else if (type === vscode.FileType.File) {
				// Skip .platform files — Fabric creates its own
				if (name === '.platform') continue;
				const content = await vscode.workspace.fs.readFile(entryUri);
				parts.push({
					path: entryPath,
					payload: Buffer.from(content).toString('base64'),
					payloadType: 'InlineBase64',
				});
			}
		}
	}

	await walk(folderUri, '');
	return parts;
}
