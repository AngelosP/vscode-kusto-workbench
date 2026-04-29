// Power BI service publishing via Fabric REST API.
// Creates SemanticModel + Report items in a Fabric workspace using TMDL/PBIR artifacts.

import * as vscode from 'vscode';
import * as os from 'os';
import { exportHtmlToPowerBI, normalizePowerBiDataMode, type PowerBiDataMode, type PowerBiDataSource } from './powerBiExport';

// ── Auth ─────────────────────────────────────────────────────────────────────

const FABRIC_SCOPE = 'https://api.fabric.microsoft.com/.default';
const FABRIC_BASE = 'https://api.fabric.microsoft.com/v1';

/** Typed Fabric API error with HTTP status for targeted catch logic. */
export class FabricApiError extends Error {
	constructor(public readonly status: number, message: string) {
		super(message);
		this.name = 'FabricApiError';
	}
}

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
		throw new FabricApiError(res.status, `Fabric API ${res.status}: ${text || res.statusText}`);
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

export async function listFabricWorkspaces(): Promise<Array<{ id: string; name: string; isPersonal: boolean }>> {
	const result = await fabricFetch('/workspaces');
	const items: Array<{ id: string; displayName: string; type?: string }> = result.data?.value || [];
	return items.map(w => ({ id: w.id, name: w.displayName, isPersonal: w.type === 'Personal' }));
}

// ── Publish ──────────────────────────────────────────────────────────────────

export interface PublishInput {
	workspaceId: string;
	reportName: string;
	pageWidth: number;
	pageHeight: number;
	htmlCode: string;
	dataSources: PowerBiDataSource[];
	/** Storage mode for generated Kusto data-source tables. */
	dataMode?: PowerBiDataMode;
	/** When present, update the existing SemanticModel instead of creating a new one. */
	semanticModelId?: string;
	/** When present, update the existing Report instead of creating a new one. */
	reportId?: string;
	/** The original report name — used to detect renames during update. */
	existingReportName?: string;
	/** True when the target workspace is a personal workspace ("My workspace"). */
	isPersonalWorkspace?: boolean;
}

export interface PublishResult {
	reportUrl: string;
	scheduleConfigured: boolean;
	initialRefreshTriggered?: boolean;
	dataMode: PowerBiDataMode;
	semanticModelId: string;
	reportId: string;
}

/**
 * Poll a long-running Fabric operation until it completes.
 * Unlike {@link awaitFabricItem}, this does NOT fall back to listing items — the caller already knows the item ID.
 */
async function awaitFabricOperation(operationUrl: string, retryMs: number): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise(r => setTimeout(r, retryMs));
		const poll = await fabricFetch(operationUrl);
		const status = poll.data?.status;
		if (status === 'Succeeded') return;
		if (status === 'Failed') {
			const errMsg = poll.data?.error?.message || JSON.stringify(poll.data?.error) || 'Unknown error';
			throw new Error(`Fabric operation failed: ${errMsg}`);
		}
	}
	throw new Error('Fabric operation timed out after polling.');
}

/**
 * Update the definition of an existing Fabric item (SemanticModel or Report).
 * Uses POST /workspaces/{wid}/items/{id}/updateDefinition — returns 200 or 202 (long-running).
 */
async function updateFabricItemDefinition(
	workspaceId: string,
	itemId: string,
	parts: Array<{ path: string; payload: string; payloadType: string }>,
	format?: string,
): Promise<void> {
	const body: any = { definition: { parts } };
	if (format) body.definition.format = format;

	const token = await getFabricToken();
	const url = `${FABRIC_BASE}/workspaces/${workspaceId}/items/${itemId}/updateDefinition`;
	const res = await fetch(url, {
		method: 'POST',
		headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	});

	if (res.status === 200) return; // Immediate success

	if (res.status === 202) {
		// Long-running operation — poll until done
		const location = res.headers.get('location');
		const retryAfterHeader = res.headers.get('retry-after');
		const retryMs = retryAfterHeader ? Math.max(1000, Number(retryAfterHeader) * 1000) : 2000;
		if (location) {
			await awaitFabricOperation(location, retryMs);
			return;
		}
		// No location but 202 — treat as success
		return;
	}

	const text = await res.text().catch(() => '');
	throw new FabricApiError(res.status, `Fabric API ${res.status}: ${text || res.statusText}`);
}

/**
 * Rename an existing Fabric item (display name only, no definition change).
 * Uses PATCH /workspaces/{wid}/items/{id}.
 */
async function renameFabricItem(workspaceId: string, itemId: string, newDisplayName: string): Promise<void> {
	const token = await getFabricToken();
	const url = `${FABRIC_BASE}/workspaces/${workspaceId}/items/${itemId}`;
	const res = await fetch(url, {
		method: 'PATCH',
		headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ displayName: newDisplayName }),
	});

	if (res.ok) return;

	const text = await res.text().catch(() => '');
	if (res.status === 409) {
		throw new Error(`An item named "${newDisplayName}" already exists in this workspace. Pick a different name and try again — nothing was changed.`);
	}
	throw new FabricApiError(res.status, `Fabric API ${res.status}: ${text || res.statusText}`);
}

/**
 * Check whether a Fabric item still exists in a workspace.
 * Returns true if found, false if 404.
 */
export async function checkFabricItemExists(workspaceId: string, itemId: string): Promise<boolean> {
	try {
		await fabricFetch(`/workspaces/${workspaceId}/items/${itemId}`);
		return true;
	} catch (e) {
		if (e instanceof FabricApiError && e.status === 404) return false;
		throw e;
	}
}

/**
 * Publish an HTML dashboard to a Fabric / Power BI workspace.
 *
 * Flow:
 * - If `semanticModelId` and `reportId` are provided, update existing items (with optional rename).
 *   On 404, falls back to the create path.
 * - Otherwise, create new SemanticModel + Report items.
 * - Returns the report URL and the item IDs for persistence.
 */
export async function publishToPowerBIService(input: PublishInput): Promise<PublishResult> {
	// Generate artifacts using a temp folder — reuses the battle-tested exportHtmlToPowerBI().
	// We write to a temp dir, read the files back, then clean up.
	const tempUri = vscode.Uri.joinPath(vscode.Uri.file(os.tmpdir()), `kw-pbi-publish-${Date.now()}`);
	const hasExistingIds = !!(input.semanticModelId && input.reportId);
	const dataMode = normalizePowerBiDataMode(input.dataMode, hasExistingIds ? 'directQuery' : 'import');

	try {
		await exportHtmlToPowerBI(
			{
				htmlCode: input.htmlCode,
				sectionName: input.reportName,
				projectName: input.reportName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || 'KustoHtmlDashboard',
				dataSources: input.dataSources,
				dataMode,
				previewHeight: input.pageHeight,
			},
			tempUri,
		);

		// Read back the generated files
		const projectName = input.reportName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || 'KustoHtmlDashboard';
		const reportFolder = `${projectName}.Report`;
		const modelFolder = `${projectName}.SemanticModel`;
		const modelParts = await collectDefinitionParts(tempUri, modelFolder);

		// ── Update path ──────────────────────────────────────────────────────
		if (input.semanticModelId && input.reportId) {
			try {
				// Rename items if the user changed the report name
				if (input.existingReportName && input.reportName !== input.existingReportName) {
					await renameFabricItem(input.workspaceId, input.semanticModelId, input.reportName);
					await renameFabricItem(input.workspaceId, input.reportId, input.reportName);
				}

				// Update SemanticModel definition
				await updateFabricItemDefinition(input.workspaceId, input.semanticModelId, modelParts, 'TMDL');

				// Collect Report parts and patch definition.pbir with existing SemanticModel ID
				const reportParts = await collectDefinitionParts(tempUri, reportFolder);
				patchPbirForService(reportParts, input.semanticModelId);

				// Update Report definition
				await updateFabricItemDefinition(input.workspaceId, input.reportId, reportParts);

				const reportUrl = `https://app.powerbi.com/groups/${input.workspaceId}/reports/${input.reportId}`;
				const scheduleConfigured = await configureRefreshSchedule(input.workspaceId, input.semanticModelId, input.isPersonalWorkspace);
				const initialRefreshTriggered = dataMode === 'import'
					? await triggerSemanticModelRefresh(input.workspaceId, input.semanticModelId, input.isPersonalWorkspace)
					: undefined;
				return { reportUrl, scheduleConfigured, initialRefreshTriggered, dataMode, semanticModelId: input.semanticModelId, reportId: input.reportId };
			} catch (e) {
				// 404 → items were deleted externally, fall through to create path
				if (e instanceof FabricApiError && e.status === 404) {
					console.warn('[kusto] Existing Power BI items not found (404), creating new items.');
				} else {
					throw e; // Rename conflicts (409) and other errors bubble up
				}
			}
		}

		// ── Create path (first publish or 404 fallback) ─────────────────────
		const smBody = {
			displayName: input.reportName,
			type: 'SemanticModel',
			definition: { format: 'TMDL', parts: modelParts },
		};
		const smResult = await fabricFetch(`/workspaces/${input.workspaceId}/items`, {
			method: 'POST',
			body: JSON.stringify(smBody),
		});
		const semanticModelId = await awaitFabricItem(smResult, input.workspaceId, 'SemanticModel');

		// Collect Report parts and patch definition.pbir
		const reportParts = await collectDefinitionParts(tempUri, reportFolder);
		patchPbirForService(reportParts, semanticModelId);

		const reportBody = {
			displayName: input.reportName,
			type: 'Report',
			definition: { parts: reportParts },
		};
		const reportResult = await fabricFetch(`/workspaces/${input.workspaceId}/items`, {
			method: 'POST',
			body: JSON.stringify(reportBody),
		});
		const reportId = await awaitFabricItem(reportResult, input.workspaceId, 'Report');

		const reportUrl = `https://app.powerbi.com/groups/${input.workspaceId}/reports/${reportId}`;
		const scheduleConfigured = await configureRefreshSchedule(input.workspaceId, semanticModelId, input.isPersonalWorkspace);
		const initialRefreshTriggered = dataMode === 'import'
			? await triggerSemanticModelRefresh(input.workspaceId, semanticModelId, input.isPersonalWorkspace)
			: undefined;
		return { reportUrl, scheduleConfigured, initialRefreshTriggered, dataMode, semanticModelId, reportId };
	} finally {
		// Clean up temp directory
		try { await vscode.workspace.fs.delete(tempUri, { recursive: true }); } catch { /* best effort */ }
	}
}

/** Patch the definition.pbir in report parts to use byConnection referencing a SemanticModel ID. */
function patchPbirForService(reportParts: Array<{ path: string; payload: string; payloadType: string }>, semanticModelId: string): void {
	const pbirIdx = reportParts.findIndex(p => p.path === 'definition.pbir');
	if (pbirIdx < 0) return;
	const pbirContent = JSON.stringify({
		$schema: 'https://developer.microsoft.com/json-schemas/fabric/item/report/definitionProperties/2.0.0/schema.json',
		version: '4.0',
		datasetReference: {
			byConnection: {
				connectionString: `Data Source=pbiazure://api.powerbi.com;Initial Catalog=${semanticModelId};Identity Provider="https://login.microsoftonline.com/common, https://analysis.windows.net/powerbi/api, 929d0ec0-7a41-4b1e-bc7c-b754a28bddcc";semanticModelId=${semanticModelId}`,
			},
		},
	}, null, 2);
	reportParts[pbirIdx] = {
		path: 'definition.pbir',
		payload: Buffer.from(pbirContent).toString('base64'),
		payloadType: 'InlineBase64',
	};
}

// ── Refresh schedule (Power BI REST API) ───────────────────────────────────────

const PBI_API_BASE = 'https://api.powerbi.com/v1.0/myorg';
const PBI_SCOPE = 'https://analysis.windows.net/powerbi/api/.default';

async function configureRefreshSchedule(workspaceId: string, datasetId: string, isPersonalWorkspace?: boolean): Promise<boolean> {
	try {
		const session = await vscode.authentication.getSession('microsoft', [PBI_SCOPE], { createIfNone: false });
		if (!session) {
			console.warn('[kusto] No Power BI auth session available for refresh schedule');
			return false;
		}

		const headers = {
			'Authorization': `Bearer ${session.accessToken}`,
			'Content-Type': 'application/json',
		};
		const body = JSON.stringify({
			value: {
				enabled: true,
				days: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
				times: ['01:00'],
				localTimeZoneId: 'UTC',
				notifyOption: 'MailOnFailure',
			},
		});

		// Personal workspaces don't support the /groups/{id}/ API path.
		const url = isPersonalWorkspace
			? `${PBI_API_BASE}/datasets/${datasetId}/refreshSchedule`
			: `${PBI_API_BASE}/groups/${workspaceId}/datasets/${datasetId}/refreshSchedule`;
		const res = await fetch(url, { method: 'PATCH', headers, body });

		if (res.ok) return true;

		const text = await res.text().catch(() => '');
		console.warn(`[kusto] Refresh schedule API ${res.status}: ${text}`);
		return false;
	} catch (e) {
		console.warn('[kusto] Failed to configure refresh schedule:', e);
		return false;
	}
}

async function triggerSemanticModelRefresh(workspaceId: string, datasetId: string, isPersonalWorkspace?: boolean): Promise<boolean> {
	try {
		const session = await vscode.authentication.getSession('microsoft', [PBI_SCOPE], { createIfNone: true });
		if (!session) return false;

		const headers = {
			'Authorization': `Bearer ${session.accessToken}`,
			'Content-Type': 'application/json',
		};
		const url = isPersonalWorkspace
			? `${PBI_API_BASE}/datasets/${datasetId}/refreshes`
			: `${PBI_API_BASE}/groups/${workspaceId}/datasets/${datasetId}/refreshes`;
		const res = await fetch(url, {
			method: 'POST',
			headers,
			body: JSON.stringify({ notifyOption: 'MailOnFailure' }),
		});

		if (res.ok) return true;

		const text = await res.text().catch(() => '');
		console.warn(`[kusto] Initial semantic model refresh API ${res.status}: ${text}`);
		return false;
	} catch (e) {
		console.warn('[kusto] Failed to trigger initial semantic model refresh:', e);
		return false;
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
