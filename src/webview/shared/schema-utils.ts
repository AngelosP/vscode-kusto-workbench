// Pure schema utility functions.
// No DOM access, no window globals. Extracted from schema.ts.

export interface SchemaInfoData {
	status: 'not-loaded' | 'loading' | 'loaded' | 'cached' | 'error';
	statusText: string;
	tables?: number;
	cols?: number;
	funcs?: number;
	cached: boolean;
	errorMessage?: string;
}

export function shouldStartKustoSchemaPrewarm(args: {
	schemaFetchInFlight: boolean;
	authoritativeRequestToken?: string;
	preparationStatus?: string;
	diagnosticsTrusted?: boolean;
}): boolean {
	const token = String(args.authoritativeRequestToken || '');
	return args.diagnosticsTrusted !== false
		&& !args.schemaFetchInFlight
		&& (!token || token.startsWith('schema_prewarm_'))
		&& args.preparationStatus !== 'preparing';
}

export function shouldForceKustoFocusedSchemaApply(args: {
	workerApplyRequired: boolean;
	enhancementFailed: boolean;
	baseWorkerReady: boolean;
	enhancementReady: boolean;
	enhancementPending: boolean;
}): boolean {
	return args.workerApplyRequired
		|| args.enhancementFailed
		|| (args.baseWorkerReady && !args.enhancementReady && !args.enhancementPending);
}

export function shouldScheduleKustoSupplementalSchemaEnhancement(args: {
	primarySchemaKey?: string | null;
	supplementalSchemaKey: string;
}): boolean {
	const primarySchemaKey = String(args.primarySchemaKey || '');
	const supplementalSchemaKey = String(args.supplementalSchemaKey || '');
	return !!supplementalSchemaKey && (!primarySchemaKey || primarySchemaKey !== supplementalSchemaKey);
}

/**
 * Build a schema info object from display text, error flag, and optional metadata.
 * Pure function — no DOM or window access.
 */
export function buildSchemaInfo(text: string, isError: boolean, meta?: Record<string, unknown>): SchemaInfoData {
	const hasText = !!text;
	if (hasText && meta) {
		const tablesCount = Number(meta.tablesCount);
		const columnsCount = Number(meta.columnsCount);
		const functionsCount = Number(meta.functionsCount);
		const fromCache = !!meta.fromCache;
		return {
			status: isError ? 'error' : (fromCache ? 'cached' : 'loaded'),
			statusText: isError ? (String(meta.errorMessage || 'Error')) : (fromCache ? 'Cached' : 'Loaded'),
			tables: tablesCount >= 0 ? tablesCount : 0,
			cols: columnsCount >= 0 ? columnsCount : 0,
			funcs: functionsCount >= 0 ? functionsCount : 0,
			cached: fromCache,
			errorMessage: isError ? String(text || 'Error') : undefined,
		};
	}
	if (hasText) {
		return {
			status: isError ? 'error' : 'loaded',
			statusText: isError ? 'Error' : text,
			tables: undefined,
			cols: undefined,
			funcs: undefined,
			cached: false,
			errorMessage: isError ? String(text || 'Error') : undefined,
		};
	}
	return {
		status: 'not-loaded',
		statusText: 'Not loaded',
		tables: undefined,
		cols: undefined,
		funcs: undefined,
		cached: false,
	};
}
