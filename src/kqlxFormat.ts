export type KqlxVersion = 1;

export type KqlxSectionV1 =
	| {
			id?: string;
			type: 'query';
			name?: string;
			expanded?: boolean;
			resultsVisible?: boolean;
			// Persist the actual cluster URL so sessions are portable across machines.
			clusterUrl?: string;
			database?: string;
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
			clusterUrl?: string;
			database?: string;
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
			code?: string;
			output?: string;
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
			chartType?: 'line' | 'area' | 'bar' | 'scatter' | 'pie';
			xColumn?: string;
			yColumns?: string[];
			yColumn?: string;
			labelColumn?: string;
			valueColumn?: string;
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
			transformationType?: 'derive' | 'summarize' | 'pivot';
			// Summarize transformation: group by columns + aggregations
			groupByColumns?: string[];
			aggregations?: Array<{ column?: string; function: 'sum' | 'avg' | 'count' | 'min' | 'max' | 'distinct' }>;
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
		}
	| {
			type: string;
			[key: string]: unknown;
		};

export interface KqlxStateV1 {
	caretDocsEnabled?: boolean;
	sections: KqlxSectionV1[];
}

export type KqlxFileKind = 'kqlx' | 'mdx';

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
	const caretDocsEnabled =	(typeof (state as any).caretDocsEnabled === 'boolean') ? (state as any).caretDocsEnabled : undefined;

	return {
		ok: true,
		file: {
			kind: kind as KqlxFileKind,
			version: 1,
			state: {
				caretDocsEnabled,
				sections
			}
		}
	};
}

export function stringifyKqlxFile(file: KqlxFileV1): string {
	return JSON.stringify(file, null, 2) + '\n';
}
