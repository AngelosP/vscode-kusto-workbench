// Power BI service publishing via Fabric REST API.
// Creates SemanticModel + Report items in a Fabric workspace using TMDL/PBIR artifacts.

import * as vscode from 'vscode';
import {
	defaultPowerBiArtifactIdSource,
	normalizePowerBiDataMode,
	validatePowerBiHtmlBindings,
	type PowerBiArtifactIdSource,
	type PowerBiDataMode,
	type PowerBiDataSource,
} from './powerBiExport';
import {
	compilePowerBiProjectArtifacts,
	powerBiProjectArtifactsToFabricParts,
	type FabricDefinitionPart,
	type PowerBiProjectArtifactManifest,
} from './powerBiProjectArtifacts';
import { getWorkbenchLogger } from './workbenchLogger';

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

type FabricAuthContext = Readonly<{
	accessToken: string;
	account: vscode.AuthenticationSessionAccountInformation;
}>;

async function getFabricAuthContext(
	expectedAccount?: vscode.AuthenticationSessionAccountInformation,
): Promise<FabricAuthContext> {
	const session = expectedAccount
		? await vscode.authentication.getSession('microsoft', [FABRIC_SCOPE], { silent: true, account: expectedAccount })
		: await vscode.authentication.getSession('microsoft', [FABRIC_SCOPE], { createIfNone: true });
	if (!session || (expectedAccount && session.account.id !== expectedAccount.id)) {
		throw new Error('The Microsoft account used to start Power BI publishing is no longer available.');
	}
	return { accessToken: session.accessToken, account: session.account };
}

export type FirstExternalCommitAdmission = <T>(
	context: Readonly<{ accountId: string }>,
	dispatch: () => Promise<T>,
) => Promise<T>;

type ExternalCommitGate = {
	check(): void;
	isCommitted(): boolean;
	dispatch<T>(operation: (auth: FabricAuthContext) => Promise<T>): Promise<T>;
};

async function fabricFetch(
	path: string,
	options: {
		method?: string;
		body?: string;
		signal?: AbortSignal;
		auth?: FabricAuthContext;
		commitGate?: ExternalCommitGate;
	} = {},
): Promise<{ status: number; headers: Headers; data: any }> {
	const dispatch = async (auth: FabricAuthContext): Promise<Response> => {
		throwIfAborted(options.signal);
		const url = path.startsWith('http') ? path : `${FABRIC_BASE}${path}`;
		return fetch(url, {
			method: options.method || 'GET',
			headers: {
				'Authorization': `Bearer ${auth.accessToken}`,
				'Content-Type': 'application/json',
			},
			body: options.body,
			signal: options.signal,
		});
	};
	const res = options.commitGate
		? await options.commitGate.dispatch(dispatch)
		: await dispatch(options.auth ?? await getFabricAuthContext());

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
async function awaitFabricItem(
	result: { status: number; headers: Headers; data: any },
	workspaceId: string,
	itemType: string,
	stagingDisplayName: string,
	commitGate: ExternalCommitGate,
): Promise<string> {
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
		const poll = await fabricFetch(location, { commitGate });

		const status = poll.data?.status;
		if (status === 'Succeeded') {
			// The operation result may contain the item ID directly
			if (poll.data?.resourceId) return poll.data.resourceId;
			const recoveredId = await findFabricItemByExactName(
				workspaceId, itemType, stagingDisplayName, commitGate,
			);
			if (recoveredId) return recoveredId;
			throw new Error(`Fabric ${itemType} creation succeeded without an exact resource ID.`);
		}
		if (status === 'Failed') {
			const errMsg = poll.data?.error?.message || JSON.stringify(poll.data?.error) || 'Unknown error';
			throw new Error(`Fabric item creation failed: ${errMsg}`);
		}
		// status === 'Running' or 'NotStarted' — keep polling
	}

	const recoveredId = await findFabricItemByExactName(
		workspaceId, itemType, stagingDisplayName, commitGate,
	);
	if (recoveredId) return recoveredId;
	throw new Error(`Fabric ${itemType} creation completed without an exact resource ID.`);
}

async function findFabricItemByExactName(
	workspaceId: string,
	itemType: string,
	displayName: string,
	commitGate: ExternalCommitGate,
): Promise<string | undefined> {
	const basePath = `/workspaces/${workspaceId}/items?type=${encodeURIComponent(itemType)}`;
	let path: string | undefined = basePath;
	const exactIds = new Set<string>();
	for (let page = 0; path && page < 100; page++) {
		const result = await fabricFetch(path, { commitGate });
		for (const item of Array.isArray(result.data?.value) ? result.data.value : []) {
			if (!item || typeof item !== 'object'
				|| (item as { displayName?: unknown }).displayName !== displayName
				|| typeof (item as { id?: unknown }).id !== 'string') continue;
			exactIds.add((item as { id: string }).id);
		}
		if (exactIds.size > 1) {
			throw new Error(`Fabric returned multiple ${itemType} items for exact staging name "${displayName}".`);
		}
		path = getFabricItemsContinuationPath(result.data, result.headers, basePath);
	}
	if (path) throw new Error(`Fabric ${itemType} exact-name recovery exceeded the pagination limit.`);
	return [...exactIds][0];
}

function getFabricItemsContinuationPath(
	data: unknown,
	headers: Headers,
	basePath: string,
): string | undefined {
	const record = data && typeof data === 'object' ? data as Record<string, unknown> : {};
	const continuationUri = String(record.continuationUri || record.continuationUrl || '').trim();
	if (continuationUri) return continuationUri;
	const continuationToken = String(
		record.continuationToken || headers.get('x-ms-continuation-token') || '',
	).trim();
	if (!continuationToken) return undefined;
	return `${basePath}${basePath.includes('?') ? '&' : '?'}continuationToken=${encodeURIComponent(continuationToken)}`;
}

function selectExactFabricItemId(
	items: readonly unknown[],
	displayName: string,
	itemType: string,
): string | undefined {
	const matches = items.filter(
		(item: unknown): item is { id: string; displayName: string } => !!item
			&& typeof item === 'object'
			&& typeof (item as { id?: unknown }).id === 'string'
			&& (item as { displayName?: unknown }).displayName === displayName,
	);
	if (matches.length > 1) {
		throw new Error(`Fabric returned multiple ${itemType} items for exact staging name "${displayName}".`);
	}
	return matches[0]?.id;
}

// ── Workspaces ───────────────────────────────────────────────────────────────

export async function listFabricWorkspaces(signal?: AbortSignal): Promise<Array<{ id: string; name: string; isPersonal: boolean }>> {
	const result = await fabricFetch('/workspaces', { signal });
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
	/** Cancels local preparation before the first mutating Fabric request is dispatched. */
	signal?: AbortSignal;
	/** Final policy admission held through the first mutating Fabric request. */
	firstCommitAdmission?: FirstExternalCommitAdmission;
}

export interface PublishResult {
	reportUrl: string;
	scheduleConfigured: boolean;
	initialRefreshTriggered?: boolean;
	dataMode: PowerBiDataMode;
	semanticModelId: string;
	reportId: string;
	createdNewItems: boolean;
	cleanupCreatedItems?: () => Promise<boolean>;
}

interface PreparedPowerBiPublishArtifacts {
	readonly dataMode: PowerBiDataMode;
	readonly manifest: PowerBiProjectArtifactManifest;
	readonly modelParts: FabricDefinitionPart[];
}

function preparePowerBiPublishArtifacts(
	input: PublishInput,
	idSource: PowerBiArtifactIdSource = defaultPowerBiArtifactIdSource,
): PreparedPowerBiPublishArtifacts {
	const portableDashboard = validatePowerBiHtmlBindings(input.htmlCode, input.dataSources);
	const hasExistingIds = !!(input.semanticModelId && input.reportId);
	const dataMode = normalizePowerBiDataMode(input.dataMode, hasExistingIds ? 'directQuery' : 'import');
	const projectName = input.reportName.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 50) || 'KustoHtmlDashboard';
	const manifest = compilePowerBiProjectArtifacts({
		htmlCode: input.htmlCode,
		sectionName: input.reportName,
		projectName,
		dataSources: input.dataSources,
		dataMode,
		previewHeight: input.pageHeight,
	}, portableDashboard, idSource);
	return {
		dataMode,
		manifest,
		modelParts: powerBiProjectArtifactsToFabricParts(manifest, manifest.semanticModelFolder),
	};
}

export function preparePowerBiPublishArtifactsForTest(
	input: PublishInput,
	idSource: PowerBiArtifactIdSource = defaultPowerBiArtifactIdSource,
): PreparedPowerBiPublishArtifacts & {
	readonly reportParts: FabricDefinitionPart[];
} {
	const prepared = preparePowerBiPublishArtifacts(input, idSource);
	return {
		...prepared,
		reportParts: powerBiProjectArtifactsToFabricParts(prepared.manifest, prepared.manifest.reportFolder),
	};
}

/**
 * Poll a long-running Fabric operation until it completes.
 * Unlike {@link awaitFabricItem}, this does NOT fall back to listing items — the caller already knows the item ID.
 */
async function awaitFabricOperation(
	operationUrl: string,
	retryMs: number,
	commitGate: ExternalCommitGate,
): Promise<void> {
	for (let attempt = 0; attempt < 30; attempt++) {
		await new Promise(r => setTimeout(r, retryMs));
		const poll = await fabricFetch(operationUrl, { commitGate });
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
	commitGate?: ExternalCommitGate,
): Promise<void> {
	const body: any = { definition: { parts } };
	if (format) body.definition.format = format;

	if (!commitGate) throw new Error('Fabric update requires an external commit gate.');
	const url = `${FABRIC_BASE}/workspaces/${workspaceId}/items/${itemId}/updateDefinition`;
	const res = await commitGate.dispatch(auth => fetch(url, {
		method: 'POST',
		headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify(body),
	}));

	if (res.status === 200) return; // Immediate success

	if (res.status === 202) {
		// Long-running operation — poll until done
		const location = res.headers.get('location');
		const retryAfterHeader = res.headers.get('retry-after');
		const retryMs = retryAfterHeader ? Math.max(1000, Number(retryAfterHeader) * 1000) : 2000;
		if (location) {
			await awaitFabricOperation(location, retryMs, commitGate);
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
async function renameFabricItem(
	workspaceId: string,
	itemId: string,
	newDisplayName: string,
	commitGate?: ExternalCommitGate,
): Promise<void> {
	if (!commitGate) throw new Error('Fabric rename requires an external commit gate.');
	const url = `${FABRIC_BASE}/workspaces/${workspaceId}/items/${itemId}`;
	const res = await commitGate.dispatch(auth => fetch(url, {
		method: 'PATCH',
		headers: { 'Authorization': `Bearer ${auth.accessToken}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ displayName: newDisplayName }),
	}));

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
export async function checkFabricItemExists(
	workspaceId: string,
	itemId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		await fabricFetch(`/workspaces/${workspaceId}/items/${itemId}`, { signal });
		return true;
	} catch (e) {
		if (e instanceof FabricApiError && e.status === 404) return false;
		throw e;
	}
}

async function fabricItemExistsWithAuth(
	workspaceId: string,
	itemId: string,
	auth: FabricAuthContext,
	signal?: AbortSignal,
): Promise<boolean> {
	try {
		await fabricFetch(`/workspaces/${workspaceId}/items/${itemId}`, { auth, signal });
		return true;
	} catch (error) {
		if (error instanceof FabricApiError && error.status === 404) return false;
		throw error;
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
	const { dataMode, manifest, modelParts } = preparePowerBiPublishArtifacts(input);

	try {
		throwIfAborted(input.signal);
		const initialAuth = await getFabricAuthContext();
		throwIfAborted(input.signal);
		const commitGate = createExternalCommitGate(
			input.signal,
			initialAuth,
			input.firstCommitAdmission,
		);
		let updateExistingItems = false;
		if (input.semanticModelId && input.reportId) {
			const [semanticModelExists, reportExists] = await Promise.all([
				fabricItemExistsWithAuth(input.workspaceId, input.semanticModelId, initialAuth, input.signal),
				fabricItemExistsWithAuth(input.workspaceId, input.reportId, initialAuth, input.signal),
			]);
			updateExistingItems = semanticModelExists && reportExists;
			if (!updateExistingItems) {
				getWorkbenchLogger().warn('[kusto] Existing Power BI publish target is incomplete; creating a new report/model pair without mutating the surviving item.');
			}
		}

		// ── Update path ──────────────────────────────────────────────────────
		if (updateExistingItems && input.semanticModelId && input.reportId) {
			commitGate.check();
			if (input.existingReportName && input.reportName !== input.existingReportName) {
				await renameFabricItem(input.workspaceId, input.semanticModelId, input.reportName, commitGate);
				await renameFabricItem(input.workspaceId, input.reportId, input.reportName, commitGate);
			}
			await updateFabricItemDefinition(input.workspaceId, input.semanticModelId, modelParts, 'TMDL', commitGate);
			const reportParts = powerBiProjectArtifactsToFabricParts(manifest, manifest.reportFolder);
			patchPbirForService(reportParts, input.semanticModelId);
			await updateFabricItemDefinition(input.workspaceId, input.reportId, reportParts, undefined, commitGate);

			const reportUrl = `https://app.powerbi.com/groups/${input.workspaceId}/reports/${input.reportId}`;
			const scheduleConfigured = await configureRefreshSchedule(
				input.workspaceId, input.semanticModelId, input.isPersonalWorkspace, initialAuth.account,
			);
			const initialRefreshTriggered = dataMode === 'import'
				? await triggerSemanticModelRefresh(
					input.workspaceId, input.semanticModelId, input.isPersonalWorkspace, initialAuth.account,
				)
				: undefined;
			return {
				reportUrl, scheduleConfigured, initialRefreshTriggered, dataMode,
				semanticModelId: input.semanticModelId, reportId: input.reportId,
				createdNewItems: false,
			};
		}

		// ── Create path (first publish or 404 fallback) ─────────────────────
		commitGate.check();
		const stagingId = createPublishTransactionId();
		const semanticModelStagingName = `kw-${stagingId}-model`;
		const reportStagingName = `kw-${stagingId}-report`;
		let semanticModelId = '';
		let reportId = '';
		let semanticModelCreationDispatched = false;
		let reportCreationDispatched = false;
		try {
			const smBody = {
				displayName: semanticModelStagingName,
				type: 'SemanticModel',
				definition: { format: 'TMDL', parts: modelParts },
			};
			semanticModelCreationDispatched = true;
			const smResult = await fabricFetch(`/workspaces/${input.workspaceId}/items`, {
				method: 'POST', body: JSON.stringify(smBody), commitGate,
			});
			semanticModelId = await awaitFabricItem(
				smResult, input.workspaceId, 'SemanticModel', semanticModelStagingName, commitGate,
			);

			const reportParts = powerBiProjectArtifactsToFabricParts(manifest, manifest.reportFolder);
			patchPbirForService(reportParts, semanticModelId);
			const reportBody = {
				displayName: reportStagingName,
				type: 'Report',
				definition: { parts: reportParts },
			};
			reportCreationDispatched = true;
			const reportResult = await fabricFetch(`/workspaces/${input.workspaceId}/items`, {
				method: 'POST', body: JSON.stringify(reportBody), commitGate,
			});
			reportId = await awaitFabricItem(
				reportResult, input.workspaceId, 'Report', reportStagingName, commitGate,
			);

			await renameFabricItem(input.workspaceId, semanticModelId, input.reportName, commitGate);
			await renameFabricItem(input.workspaceId, reportId, input.reportName, commitGate);

			const reportUrl = `https://app.powerbi.com/groups/${input.workspaceId}/reports/${reportId}`;
			const scheduleConfigured = await configureRefreshSchedule(
				input.workspaceId, semanticModelId, input.isPersonalWorkspace, initialAuth.account,
			);
			const initialRefreshTriggered = dataMode === 'import'
				? await triggerSemanticModelRefresh(
					input.workspaceId, semanticModelId, input.isPersonalWorkspace, initialAuth.account,
				)
				: undefined;
			return {
				reportUrl, scheduleConfigured, initialRefreshTriggered, dataMode,
				semanticModelId, reportId, createdNewItems: true,
				cleanupCreatedItems: () => cleanupCreatedPowerBiItems(
					initialAuth, input.workspaceId, semanticModelId, reportId,
				),
			};
		} catch (error) {
			if (commitGate.isCommitted()) {
				if (!semanticModelId && semanticModelCreationDispatched) {
					semanticModelId = await findFabricItemByExactName(
						input.workspaceId, 'SemanticModel', semanticModelStagingName, commitGate,
					).catch(() => undefined) ?? '';
				}
				if (!reportId && reportCreationDispatched) {
					reportId = await findFabricItemByExactName(
						input.workspaceId, 'Report', reportStagingName, commitGate,
					).catch(() => undefined) ?? '';
				}
			}
			if (semanticModelId || reportId) {
				const cleaned = await cleanupCreatedPowerBiItems(
					initialAuth, input.workspaceId, semanticModelId, reportId,
					reportCreationDispatched,
				);
				if (!cleaned) {
					throw new Error('Power BI publish failed and created items could not be cleaned up safely.', { cause: error });
				}
			}
			throw error;
		}
	} finally {
		// Project artifacts remain in memory; publish has no staging directory to clean up.
	}
}

function createPublishTransactionId(): string {
	return globalThis.crypto?.randomUUID?.()
		?? `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

async function cleanupCreatedPowerBiItems(
	auth: FabricAuthContext,
	workspaceId: string,
	semanticModelId: string,
	reportId: string,
	reportMayExist = !!reportId,
): Promise<boolean> {
	if (reportMayExist && !reportId) {
		getWorkbenchLogger().warn('[kusto] A retired Power BI report may exist but its exact ID could not be recovered; the semantic model was retained to preserve dependency integrity.');
		return false;
	}
	if (reportId) {
		try {
			await fabricFetch(`/workspaces/${workspaceId}/items/${reportId}`, { method: 'DELETE', auth });
		} catch (error) {
			getWorkbenchLogger().warn(`[kusto] Failed to clean up retired Power BI report ${reportId}; its semantic model was retained to preserve dependency integrity:`, error);
			return false;
		}
	}
	if (semanticModelId) {
		try {
			await fabricFetch(`/workspaces/${workspaceId}/items/${semanticModelId}`, { method: 'DELETE', auth });
		} catch (error) {
			getWorkbenchLogger().warn(`[kusto] Failed to clean up retired Power BI semantic model ${semanticModelId}:`, error);
			return false;
		}
	}
	return true;
}

function createExternalCommitGate(
	signal: AbortSignal | undefined,
	initialAuth: FabricAuthContext,
	firstCommitAdmission?: FirstExternalCommitAdmission,
	refreshAuth: (account: vscode.AuthenticationSessionAccountInformation) => Promise<FabricAuthContext>
		= account => getFabricAuthContext(account),
): ExternalCommitGate {
	let committed = false;
	let committedAuth = initialAuth;
	return {
		check(): void {
			if (!committed) throwIfAborted(signal);
		},
		isCommitted(): boolean {
			return committed;
		},
		async dispatch<T>(operation: (auth: FabricAuthContext) => Promise<T>): Promise<T> {
			if (committed) return operation(committedAuth);
			throwIfAborted(signal);
			const currentAuth = await refreshAuth(initialAuth.account);
			throwIfAborted(signal);
			const dispatch = async (): Promise<T> => {
				throwIfAborted(signal);
				committed = true;
				committedAuth = currentAuth;
				return operation(currentAuth);
			};
			return firstCommitAdmission
				? firstCommitAdmission({ accountId: currentAuth.account.id }, dispatch)
				: dispatch();
		},
	};
}

export function createExternalCommitGateForTest(signal: AbortSignal | undefined): {
	check(): void;
	dispatch<T>(operation: () => Promise<T>): Promise<T>;
} {
	const auth: FabricAuthContext = {
		accessToken: 'test-token',
		account: { id: 'test-account', label: 'Test account' },
	};
	const gate = createExternalCommitGate(signal, auth, undefined, async () => auth);
	return {
		check: () => gate.check(),
		dispatch: operation => gate.dispatch(() => operation()),
	};
}

export function selectExactFabricItemIdForTest(
	items: readonly unknown[],
	displayName: string,
	itemType: string,
): string | undefined {
	return selectExactFabricItemId(items, displayName, itemType);
}

export function canDeleteCreatedSemanticModelForTest(
	reportMayExist: boolean,
	reportId: string,
): boolean {
	return !reportMayExist || !!String(reportId || '').trim();
}

export function getFabricItemsContinuationPathForTest(
	data: unknown,
	headers: Headers,
	basePath: string,
): string | undefined {
	return getFabricItemsContinuationPath(data, headers, basePath);
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

type PowerBiAuthSession = Pick<vscode.AuthenticationSession, 'accessToken' | 'account'>;

async function getPowerBiSessionForAccount(
	account: vscode.AuthenticationSessionAccountInformation,
	acquireSession: (account: vscode.AuthenticationSessionAccountInformation) => Thenable<PowerBiAuthSession | undefined>
		= expectedAccount => vscode.authentication.getSession('microsoft', [PBI_SCOPE], {
			silent: true,
			account: expectedAccount,
		}),
): Promise<PowerBiAuthSession | undefined> {
	const session = await acquireSession(account);
	return session?.account.id === account.id ? session : undefined;
}

export function getPowerBiSessionForAccountForTest(
	account: vscode.AuthenticationSessionAccountInformation,
	acquireSession: (account: vscode.AuthenticationSessionAccountInformation) => Promise<PowerBiAuthSession | undefined>,
): Promise<PowerBiAuthSession | undefined> {
	return getPowerBiSessionForAccount(account, acquireSession);
}

async function configureRefreshSchedule(
	workspaceId: string,
	datasetId: string,
	isPersonalWorkspace: boolean | undefined,
	account: vscode.AuthenticationSessionAccountInformation,
): Promise<boolean> {
	try {
		const session = await getPowerBiSessionForAccount(account);
		if (!session) {
			getWorkbenchLogger().warn('[kusto] No Power BI auth session available for refresh schedule');
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
		getWorkbenchLogger().warn(`[kusto] Refresh schedule API ${res.status}: ${text}`);
		return false;
	} catch (e) {
		getWorkbenchLogger().warn('[kusto] Failed to configure refresh schedule:', e);
		return false;
	}
}

async function triggerSemanticModelRefresh(
	workspaceId: string,
	datasetId: string,
	isPersonalWorkspace: boolean | undefined,
	account: vscode.AuthenticationSessionAccountInformation,
): Promise<boolean> {
	try {
		const session = await getPowerBiSessionForAccount(account);
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
		getWorkbenchLogger().warn(`[kusto] Initial semantic model refresh API ${res.status}: ${text}`);
		return false;
	} catch (e) {
		getWorkbenchLogger().warn('[kusto] Failed to trigger initial semantic model refresh:', e);
		return false;
	}
}

function throwIfAborted(signal: AbortSignal | undefined): void {
	if (!signal?.aborted) return;
	const error = new Error('Power BI publish canceled before external commit.');
	error.name = 'AbortError';
	throw error;
}
