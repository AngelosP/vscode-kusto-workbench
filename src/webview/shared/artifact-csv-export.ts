import {
	csvSaveArtifactConsumerId,
	csvTableArtifactConsumerId,
	RESULT_ARTIFACT_CSV_RESET_EVENT,
	RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT,
} from '../../shared/resultArtifact.js';
import {
	bindResultArtifactConsumer,
	getBoundResultArtifact,
	unbindResultArtifactConsumer,
} from '../core/results-state.js';
import { postMessageToHost } from './webview-messages.js';

export type ArtifactCsvExportRequest = Readonly<{
	sourceBoxId: string;
	artifactId: string;
	tableToken: string;
	csv: string;
	suggestedFileName?: string;
}>;

type ActiveCsvTable = Readonly<{ artifactId: string; tableToken: string }>;
type PendingCsvExport = Readonly<ArtifactCsvExportRequest & { requestId: string; timer: number }>;
export type ArtifactResultTableRegistration = Readonly<{ tableToken: string; exportToCsv: boolean }>;

export const ARTIFACT_CSV_TABLE_RELEASED_EVENT = 'kusto-workbench-artifact-csv-table-released';
const MAX_PENDING_CSV_EXPORTS = 8;
const activeTableBySource = new Map<string, ActiveCsvTable>();
const pendingExportByRequestId = new Map<string, PendingCsvExport>();

function nextId(prefix: string): string {
	return `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

export function registerArtifactResultTable(
	sourceBoxId: unknown,
	artifactId: unknown,
): ArtifactResultTableRegistration | undefined {
	const source = String(sourceBoxId || '').trim();
	const artifact = String(artifactId || '').trim();
	const consumerId = csvTableArtifactConsumerId(source);
	releaseArtifactCsvTable(source);
	const bound = source && artifact && bindResultArtifactConsumer(consumerId, source, artifact) === artifact;
	const resultArtifact = bound ? getBoundResultArtifact(consumerId, source) : null;
	if (!resultArtifact) {
		unbindResultArtifactConsumer(consumerId);
		return undefined;
	}
	const tableToken = nextId('csv-table');
	activeTableBySource.set(source, { artifactId: artifact, tableToken });
	return { tableToken, exportToCsv: resultArtifact.policy?.exportToCsv === true };
}

export function registerArtifactCsvTable(sourceBoxId: unknown, artifactId: unknown): string | undefined {
	const registration = registerArtifactResultTable(sourceBoxId, artifactId);
	return registration?.exportToCsv ? registration.tableToken : undefined;
}

export function releaseArtifactCsvTable(sourceBoxId: unknown, tableToken?: unknown): void {
	const source = String(sourceBoxId || '').trim();
	if (!source) return;
	const active = activeTableBySource.get(source);
	if (tableToken !== undefined && active?.tableToken !== String(tableToken || '').trim()) return;
	activeTableBySource.delete(source);
	unbindResultArtifactConsumer(csvTableArtifactConsumerId(source));
	for (const [requestId, pending] of [...pendingExportByRequestId]) {
		if (pending.sourceBoxId !== source) continue;
		pendingExportByRequestId.delete(requestId);
		window.clearTimeout(pending.timer);
		postMessageToHost({ type: 'cancelArtifactCsvSaveIntent', requestId });
	}
	if (active) {
		window.dispatchEvent(new CustomEvent(ARTIFACT_CSV_TABLE_RELEASED_EVENT, {
			detail: { sourceBoxId: source, tableToken: active.tableToken },
		}));
	}
}

export function releaseAllArtifactCsvTables(): void {
	for (const [sourceBoxId, active] of [...activeTableBySource]) {
		releaseArtifactCsvTable(sourceBoxId, active.tableToken);
	}
}

function activeTableMatches(request: Pick<ArtifactCsvExportRequest, 'sourceBoxId' | 'artifactId' | 'tableToken'>): boolean {
	const source = String(request.sourceBoxId || '').trim();
	const artifactId = String(request.artifactId || '').trim();
	const tableToken = String(request.tableToken || '').trim();
	const active = activeTableBySource.get(source);
	const bound = getBoundResultArtifact(csvTableArtifactConsumerId(source), source);
	return !!active && active.artifactId === artifactId && active.tableToken === tableToken
		&& bound?.artifactId === artifactId && bound.policy?.exportToCsv === true;
}

export function isArtifactResultTableLive(
	sourceBoxId: unknown,
	artifactId: unknown,
	tableToken: unknown,
): boolean {
	const source = String(sourceBoxId || '').trim();
	const artifact = String(artifactId || '').trim();
	const token = String(tableToken || '').trim();
	const active = activeTableBySource.get(source);
	const bound = getBoundResultArtifact(csvTableArtifactConsumerId(source), source);
	return !!active && !!artifact && !!token
		&& active.artifactId === artifact && active.tableToken === token
		&& bound?.artifactId === artifact;
}

export function saveArtifactCsv(request: ArtifactCsvExportRequest): boolean {
	const sourceBoxId = String(request.sourceBoxId || '').trim();
	const artifactId = String(request.artifactId || '').trim();
	if (!activeTableMatches(request)) {
		postMessageToHost({ type: 'showInfo', message: 'Results are not permitted for CSV export.' });
		return false;
	}
	if ([...pendingExportByRequestId.values()].some(pending => (
		pending.sourceBoxId === sourceBoxId && pending.tableToken === request.tableToken
	))) {
		postMessageToHost({ type: 'showInfo', message: 'A CSV export is already in progress for these results.' });
		return false;
	}
	if (pendingExportByRequestId.size >= MAX_PENDING_CSV_EXPORTS) {
		postMessageToHost({ type: 'showInfo', message: 'Too many CSV exports are already in progress.' });
		return false;
	}
	const requestId = nextId('csv-save');
	const timer = window.setTimeout(() => {
		if (!pendingExportByRequestId.delete(requestId)) return;
		postMessageToHost({ type: 'cancelArtifactCsvSaveIntent', requestId });
	}, 10 * 60_000);
	pendingExportByRequestId.set(requestId, {
		...request, sourceBoxId, artifactId, requestId, timer,
	});
	postMessageToHost({
		type: 'requestArtifactCsvSave', requestId, boxId: sourceBoxId, artifactId,
		suggestedFileName: request.suggestedFileName,
	});
	return true;
}

function takePending(requestId: unknown): PendingCsvExport | undefined {
	const id = String(requestId || '').trim();
	const pending = pendingExportByRequestId.get(id);
	if (!pending) return undefined;
	pendingExportByRequestId.delete(id);
	window.clearTimeout(pending.timer);
	return pending;
}

export function provideArtifactCsvSaveData(message: {
	requestId?: unknown; exportId?: unknown; boxId?: unknown; artifactId?: unknown;
}): void {
	const pending = takePending(message.exportId);
	if (!pending) return;
	const matches = pending.sourceBoxId === String(message.boxId || '').trim()
		&& pending.artifactId === String(message.artifactId || '').trim()
		&& activeTableMatches(pending);
	const consumerId = csvSaveArtifactConsumerId(pending.sourceBoxId);
	try {
		const bound = matches && bindResultArtifactConsumer(
			consumerId, pending.sourceBoxId, pending.artifactId,
		) === pending.artifactId;
		const artifact = bound ? getBoundResultArtifact(consumerId, pending.sourceBoxId) : null;
		const accepted = !!artifact && artifact.policy?.exportToCsv === true;
		postMessageToHost({
			type: 'artifactCsvSaveData', requestId: String(message.requestId || '').trim(),
			boxId: pending.sourceBoxId, artifactId: pending.artifactId, accepted,
			...(accepted ? { csv: String(pending.csv || '') } : {}),
		});
	} finally {
		unbindResultArtifactConsumer(consumerId);
	}
}

export function cancelArtifactCsvSave(requestId: unknown): void {
	takePending(requestId);
}

if (typeof window !== 'undefined') {
	window.addEventListener(RESULT_ARTIFACT_CSV_RESET_EVENT, () => releaseAllArtifactCsvTables());
	window.addEventListener(RESULT_ARTIFACT_CONSUMERS_REVOKED_EVENT, (event: Event) => {
		const detail = (event as CustomEvent).detail || {};
		const consumerIds = Array.isArray(detail.consumerIds) ? detail.consumerIds : [];
		for (const [sourceBoxId, active] of [...activeTableBySource]) {
			if (consumerIds.includes(csvTableArtifactConsumerId(sourceBoxId))) {
				releaseArtifactCsvTable(sourceBoxId, active.tableToken);
			}
		}
	});
}
