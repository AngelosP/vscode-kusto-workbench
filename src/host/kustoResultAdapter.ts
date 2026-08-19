import { formatCellValue } from './kustoClientUtils.js';
import {
	createKustoResultBatch,
	type KustoResultBatchParseResult,
	type KustoResultBatchV1,
	type KustoResultSetInput,
} from '../shared/kustoResultBatch.js';

export type KustoQueryResponseMetadata = Readonly<{
	cluster: string;
	database: string;
	executionTime: string;
	clientActivityId?: string;
	serverStats?: Readonly<Record<string, unknown>>;
}>;

function resultSetServerStats(
	serverStats: Readonly<Record<string, unknown>> | undefined,
	resultIndex: number,
): Readonly<Record<string, unknown>> | undefined {
	if (!serverStats) return undefined;
	const datasetStatistics = Array.isArray(serverStats.datasetStatistics)
		? serverStats.datasetStatistics
		: [];
	const selected = datasetStatistics[resultIndex];
	return selected && typeof selected === 'object' && !Array.isArray(selected)
		? { ...serverStats, ...selected }
		: serverStats;
}

function adaptTable(
	table: unknown,
	resultIndex: number,
	metadata: KustoQueryResponseMetadata,
): KustoResultSetInput {
	const candidate = table && typeof table === 'object' ? table as Record<string, any> : {};
	const sourceColumns = Array.isArray(candidate.columns) ? candidate.columns : [];
	const columns = sourceColumns.map((column: any) => {
		const name = column?.name || column?.type || 'Unknown';
		const type = typeof column?.type === 'string' ? column.type : '';
		return type ? { name: String(name), type } : String(name);
	});
	const rows: unknown[][] = [];
	if (typeof candidate.rows === 'function') {
		for (const row of candidate.rows()) {
			const values: unknown[] = [];
			if (Array.isArray(row)) {
				values.push(...row);
			} else {
				const rowRecord = row && typeof row === 'object' ? row as Record<string | number, unknown> : {};
				for (const column of sourceColumns) {
					values.push(rowRecord[column?.name] ?? rowRecord[column?.ordinal]);
				}
			}
			rows.push(values.map(cell => formatCellValue(cell)));
		}
	}
	const serverStats = resultSetServerStats(metadata.serverStats, resultIndex);
	return {
		columns,
		rows,
		metadata: {
			...metadata,
			...(serverStats ? { serverStats } : {}),
			...(typeof candidate.name === 'string' && candidate.name ? { resultName: candidate.name } : {}),
			...(Number.isSafeInteger(candidate.id) ? { resultId: candidate.id } : {}),
			...(typeof candidate.kind === 'string' && candidate.kind ? { resultKind: candidate.kind } : {}),
		},
	};
}

export function adaptKustoQueryResponse(
	response: unknown,
	metadata: KustoQueryResponseMetadata,
): KustoResultBatchParseResult<KustoResultBatchV1> {
	const candidate = response && typeof response === 'object' ? response as Record<string, unknown> : {};
	const primaryResults = Array.isArray(candidate.primaryResults) ? candidate.primaryResults : [];
	return createKustoResultBatch(
		primaryResults.map((table, resultIndex) => adaptTable(table, resultIndex, metadata)),
		metadata,
	);
}