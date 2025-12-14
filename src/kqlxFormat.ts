export type KqlxVersion = 1;

export type KqlxSectionV1 =
	| {
			type: 'query';
			name?: string;
			connectionId?: string;
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
		}
	| {
			type: 'markdown';
			title?: string;
			text?: string;
			tab?: 'edit' | 'preview';
			editorHeightPx?: number;
		}
	| {
			type: 'python';
			code?: string;
			output?: string;
			editorHeightPx?: number;
		}
	| {
			type: 'url';
			url?: string;
			expanded?: boolean;
		}
	| {
			type: string;
			[key: string]: unknown;
		};

export interface KqlxStateV1 {
	caretDocsEnabled?: boolean;
	sections: KqlxSectionV1[];
}

export interface KqlxFileV1 {
	kind: 'kqlx';
	version: 1;
	state: KqlxStateV1;
}

export type KqlxParseResult =	| { ok: true; file: KqlxFileV1 }
	| { ok: false; error: string };

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

export function createEmptyKqlxFile(): KqlxFileV1 {
	return {
		kind: 'kqlx',
		version: 1,
		state: {
			sections: []
		}
	};
}

export function parseKqlxText(text: string): KqlxParseResult {
	const raw = String(text ?? '').trim();
	if (!raw) {
		return { ok: true, file: createEmptyKqlxFile() };
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

	const kind = parsed.kind;
	const version = parsed.version;
	if (kind !== 'kqlx') {
		return { ok: false, error: 'Invalid .kqlx: missing or invalid "kind".' };
	}
	if (version !== 1) {
		return { ok: false, error: `Unsupported .kqlx version: ${String(version)}` };
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
			kind: 'kqlx',
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
