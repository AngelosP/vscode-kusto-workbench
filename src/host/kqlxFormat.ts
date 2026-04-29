export type KqlxVersion = 1;

/** Power BI publish metadata stored per HTML section after first publish. */
export interface PbiPublishInfo {
	workspaceId: string;
	workspaceName?: string;
	semanticModelId: string;
	reportId: string;
	reportName: string;
	reportUrl: string;
	dataMode?: 'import' | 'directQuery';
}

export type KqlxSectionV1 =
	| {
			id?: string;
			type: 'query';
			name?: string;
			expanded?: boolean;
			resultsVisible?: boolean;
			// UI state: when true, show the Favorites dropdown instead of cluster/database pickers.
			favoritesMode?: boolean;
			// Persist the actual cluster URL so sessions are portable across machines.
			clusterUrl?: string;
			database?: string;
			/**
			 * Optional link to an external plain-text query file (e.g. sibling .kql/.csl).
			 * When present, the query text is stored in that file instead of inline in the .kqlx.
			 * Typically used for the first query section to enable "sidecar" metadata.
			 */
			linkedQueryPath?: string;
			query?: string;
			// Optional persisted query result for this box.
			// Stored as JSON text to keep comparisons stable and cap size.
			// Only present when <= 200KB.
			resultJson?: string;
			runMode?: string;
			cacheEnabled?: boolean;
			cacheValue?: number;
			cacheUnit?: string;
			editorHeightPx?: number;
			resultsHeightPx?: number;
			// Copilot chat is now a per-query-box toggle.
			copilotChatVisible?: boolean;
			copilotChatWidthPx?: number;
		}
	| {
			id?: string;
			type: 'copilotQuery';
			name?: string;
			expanded?: boolean;
			resultsVisible?: boolean;
			favoritesMode?: boolean;
			clusterUrl?: string;
			database?: string;
			linkedQueryPath?: string;
			query?: string;
			resultJson?: string;
			runMode?: string;
			cacheEnabled?: boolean;
			cacheValue?: number;
			cacheUnit?: string;
			editorHeightPx?: number;
			resultsHeightPx?: number;
			// Back-compat: older files may have this type, but current webview treats it as a normal query.
			copilotChatVisible?: boolean;
			copilotChatWidthPx?: number;
		}
	| {
			id?: string;
			type: 'markdown';
			title?: string;
			text?: string;
			// Back-compat with older webview builds.
			tab?: 'edit' | 'preview';
			// Newer markdown UI state.
			expanded?: boolean;
			mode?: 'preview' | 'markdown' | 'wysiwyg';
			editorHeightPx?: number;
		}
	| {
			id?: string;
			type: 'python';
			name?: string;
			code?: string;
			output?: string;
			expanded?: boolean;
			editorHeightPx?: number;
		}
	| {
			id?: string;
			type: 'url';
			name?: string;
			url?: string;
			expanded?: boolean;
			outputHeightPx?: number;
		}
	| {
			id?: string;
			type: 'chart';
			name?: string;
			mode?: 'edit' | 'preview';
			expanded?: boolean;
			editorHeightPx?: number;
			// Chart builder configuration (optional; webview-specific).
			dataSourceId?: string;
			chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | 'sankey' | 'heatmap';
			xColumn?: string;
			yColumns?: string[];
			yColumn?: string;
			tooltipColumns?: string[];
			legendColumn?: string;
			legendPosition?: 'left' | 'right' | 'top' | 'bottom';
			stackMode?: 'normal' | 'stacked' | 'stacked100';
			labelColumn?: string;
			valueColumn?: string;
			sourceColumn?: string;
			targetColumn?: string;
			orient?: 'LR' | 'RL' | 'TB' | 'BT';
			sankeyLeftMargin?: number;
			showDataLabels?: boolean;
			sortColumn?: string;
			sortDirection?: 'asc' | 'desc' | '';
			// X-axis customization settings
			xAxisSettings?: {
				sortDirection?: 'asc' | 'desc' | '';
				scaleType?: 'category' | 'continuous' | '';
				labelDensity?: number;
				showAxisLabel?: boolean;
				customLabel?: string;
				titleGap?: number;
			};
			// Y-axis customization settings
			yAxisSettings?: {
				showAxisLabel?: boolean;
				customLabel?: string;
				min?: string;
				max?: string;
				seriesColors?: Record<string, string>;
				titleGap?: number;
				sortDirection?: 'asc' | 'desc' | '';
			};
			// Legend customization settings
			legendSettings?: {
				position?: 'left' | 'right' | 'top' | 'bottom';
				stackMode?: 'normal' | 'stacked' | 'stacked100';
				gap?: number;
				sortMode?: '' | 'alpha-asc' | 'alpha-desc' | 'value-asc' | 'value-desc';
				topN?: number;
				title?: string;
				showEndLabels?: boolean;
			};
			// Heatmap-specific settings
			heatmapSettings?: {
				visualMapPosition?: 'right' | 'left' | 'bottom' | 'top';
				visualMapGap?: number;
				showCellLabels?: boolean;
				cellLabelMode?: 'all' | 'lowest' | 'highest' | 'both';
				cellLabelN?: number;
			};
			// Chart title / subtitle
			chartTitle?: string;
			chartSubtitle?: string;
			chartTitleAlign?: 'left' | 'center' | 'right';
		}
	| {
			id?: string;
			type: 'transformation';
			name?: string;
			mode?: 'edit' | 'preview';
			expanded?: boolean;
			editorHeightPx?: number;
			// Transformation configuration.
			dataSourceId?: string;
			transformationType?: 'derive' | 'summarize' | 'distinct' | 'pivot' | 'join';
			// Distinct transformation: select a single column and return unique values.
			distinctColumn?: string;
			// Summarize transformation: group by columns + aggregations
			groupByColumns?: string[];
			aggregations?: Array<{ name?: string; column?: string; function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'distinct' }>;
			// Calculated columns (derive): multiple columns, applied in order.
			deriveColumns?: Array<{ name: string; expression: string }>;
			// Back-compat for older files: single calculated column.
			deriveColumnName?: string;
			deriveExpression?: string;
			// Pivot transformation: row key + column key + values
			pivotRowKeyColumn?: string;
			pivotColumnKeyColumn?: string;
			pivotValueColumn?: string;
			pivotAggregation?: 'sum' | 'avg' | 'count' | 'first';
			pivotMaxColumns?: number;
			// Join transformation: join two data sources on key columns
			joinRightDataSourceId?: string;
			joinKind?: 'inner' | 'leftouter' | 'rightouter' | 'fullouter' | 'leftanti' | 'rightanti' | 'leftsemi' | 'rightsemi';
			joinKeys?: Array<{ left: string; right: string }>;
			joinOmitDuplicateColumns?: boolean;
		}
	| {
			id?: string;
			type: 'html';
			name?: string;
			/** HTML + JS source code. */
			code?: string;
			mode?: 'code' | 'preview';
			expanded?: boolean;
			editorHeightPx?: number;
			previewHeightPx?: number;
			/** IDs of query/transformation sections this HTML section reads data from. */
			dataSourceIds?: string[];
			/** Power BI publish metadata — present after first successful publish. */
			pbiPublishInfo?: PbiPublishInfo;
		}
	| {
			id?: string;
			type: 'sql';
			name?: string;
			query?: string;
			serverUrl?: string;
			database?: string;
			expanded?: boolean;
			resultsVisible?: boolean;
			favoritesMode?: boolean;
			resultJson?: string;
			runMode?: string;
			editorHeightPx?: number;
			resultsHeightPx?: number;
			copilotChatVisible?: boolean;
			copilotChatWidthPx?: number;
		}
	| {
			id?: string;
			type: 'devnotes';
			entries?: DevNoteEntry[];
		}
	| {
			type: string;
			[key: string]: unknown;
		};

export interface DevNoteEntry {
	id: string;
	/** ISO 8601 timestamp */
	created: string;
	/** ISO 8601 timestamp, updated when content changes */
	updated: string;
	category: 'correction' | 'clarification' | 'schema-hint' | 'usage-note' | 'gotcha';
	relatedSectionIds?: string[];
	content: string;
	source: 'user' | 'copilot' | 'agent';
}

export interface KqlxStateV1 {
	caretDocsEnabled?: boolean;
	sections: KqlxSectionV1[];
}

export type KqlxFileKind = 'kqlx' | 'mdx' | 'sqlx';

export interface KqlxFileV1 {
	kind: KqlxFileKind;
	version: 1;
	state: KqlxStateV1;
}

export type KqlxParseResult =	| { ok: true; file: KqlxFileV1 }
	| { ok: false; error: string };

export type ParseKqlxTextOptions = {
	/**
	 * Which `kind` values are accepted for this document.
	 * If omitted, defaults to ['kqlx'] for backward-compatible strictness.
	 */
	allowedKinds?: readonly KqlxFileKind[];
	/**
	 * When the document is empty, which kind should be assumed.
	 * If omitted, defaults to 'kqlx'.
	 */
	defaultKind?: KqlxFileKind;
};

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createEmptyKqlxFile(): KqlxFileV1 {
	return createEmptyKqlxOrMdxFile('kqlx');
}

export function createEmptyKqlxOrMdxFile(kind: KqlxFileKind): KqlxFileV1 {
	return {
		kind,
		version: 1,
		state: {
			sections: []
		}
	};
}


export function parseKqlxText(text: string, options?: ParseKqlxTextOptions): KqlxParseResult {
	const raw = String(text ?? '').trim();
	if (!raw) {
		const defaultKind: KqlxFileKind = options?.defaultKind ?? 'kqlx';
		return { ok: true, file: createEmptyKqlxOrMdxFile(defaultKind) };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (e) {
		return { ok: false, error: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}` };
	}

	if (!isObject(parsed)) {
		return { ok: false, error: 'Invalid .kqlx: root must be a JSON object.' };
	}

	const allowedKinds: readonly KqlxFileKind[] =
		Array.isArray(options?.allowedKinds) && options?.allowedKinds.length > 0
			? options!.allowedKinds
			: ['kqlx'];

	const kind = parsed.kind;
	const version = parsed.version;
	if (typeof kind !== 'string' || !allowedKinds.includes(kind as any)) {
		return { ok: false, error: 'Invalid session file: missing or invalid "kind".' };
	}
	if (version !== 1) {
		return { ok: false, error: `Unsupported session file version: ${String(version)}` };
	}

	const state = (parsed as any).state;
	if (!isObject(state)) {
		return { ok: false, error: 'Invalid .kqlx: missing or invalid "state".' };
	}

	const sectionsRaw = (state as any).sections;
	const sections = Array.isArray(sectionsRaw) ? (sectionsRaw as KqlxSectionV1[]) : [];

	const parsedState: KqlxStateV1 = { sections };
	if (typeof (state as any).caretDocsEnabled === 'boolean') {
		parsedState.caretDocsEnabled = (state as any).caretDocsEnabled;
	}

	return {
		ok: true,
		file: {
			kind: kind as KqlxFileKind,
			version: 1,
			state: parsedState
		}
	};
}

export function stringifyKqlxFile(file: KqlxFileV1): string {
	return JSON.stringify(file, null, 2) + '\n';
}
