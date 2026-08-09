import type { KqlxFileV1, KqlxStateV1 } from '../../src/host/kqlxFormat';
import {
	BROWSER_VIEWER_READ_ONLY_CAPABILITIES,
	type BrowserViewerProjection,
} from '../../src/shared/browserViewerProjection';
import type { BrowserFileLoadSnapshot, LoadedBrowserFile } from './browser-file-load';
import { browserCanonicalSectionKind, parseBrowserViewerDocument } from './viewer-document';

export { BROWSER_VIEWER_READ_ONLY_CAPABILITIES } from '../../src/shared/browserViewerProjection';
export type { BrowserViewerCapabilities, BrowserViewerProjection } from '../../src/shared/browserViewerProjection';

type DeepReadonly<T> = T extends (...args: never[]) => unknown
	? T
	: T extends readonly (infer Item)[]
		? readonly DeepReadonly<Item>[]
		: T extends object
			? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
			: T;

export type BrowserViewerAdoptionResult =
	| Readonly<{ ok: true; projection: BrowserViewerProjection }>
	| Readonly<{ ok: false; reason: 'stale' | 'duplicate' }>
	| Readonly<{ ok: false; reason: 'invalid'; title: string; error: string }>;

export type BrowserViewerRootOptions = Readonly<{
	isCurrent?: (snapshot: BrowserFileLoadSnapshot) => boolean;
	present: (projection: BrowserViewerProjection) => void;
}>;

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): DeepReadonly<T> {
	if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value as DeepReadonly<T>;
	for (const child of Object.values(value)) deepFreeze(child);
	return Object.freeze(value) as DeepReadonly<T>;
}

function createPresentationState(state: KqlxStateV1): DeepReadonly<KqlxStateV1> {
	const presentationState = cloneJson(state);
	for (const section of presentationState.sections) {
		const record = section as unknown as Record<string, unknown>;
		switch (browserCanonicalSectionKind(record.type)) {
			case 'query':
			case 'sql':
				record.expanded = false;
				break;
			case 'markdown':
			case 'chart':
				record.mode = 'preview';
				break;
		}
	}
	return deepFreeze(presentationState);
}

export class BrowserViewerRoot {
	private adoptedGeneration: number | undefined;

	constructor(private readonly options: BrowserViewerRootOptions) {}

	adopt(loaded: LoadedBrowserFile): BrowserViewerAdoptionResult {
		const { snapshot } = loaded;
		if (!Number.isSafeInteger(snapshot.generation) || snapshot.generation <= 0) {
			return { ok: false, reason: 'stale' };
		}
		if (this.options.isCurrent && !this.options.isCurrent(snapshot)) {
			return { ok: false, reason: 'stale' };
		}
		if (this.adoptedGeneration !== undefined) {
			return snapshot.generation === this.adoptedGeneration
				? { ok: false, reason: 'duplicate' }
				: { ok: false, reason: 'stale' };
		}

		const parsed = parseBrowserViewerDocument({
			filename: snapshot.file.filename,
			content: loaded.content,
			companionState: loaded.companionState,
			rawContentUrl: snapshot.file.rawContentUrl,
			sidecarUrl: snapshot.file.sidecarUrl,
		});
		if (!parsed.ok) {
			return { ok: false, reason: 'invalid', title: parsed.title, error: parsed.error };
		}
		if (this.options.isCurrent && !this.options.isCurrent(snapshot)) {
			return { ok: false, reason: 'stale' };
		}

		const document = deepFreeze(cloneJson(parsed.file));
		const projection: BrowserViewerProjection = deepFreeze({
			type: 'browser-viewer-projection' as const,
			source: {
				generation: snapshot.generation,
				filename: snapshot.file.filename,
				rawContentUrl: snapshot.file.rawContentUrl,
				...(snapshot.file.sidecarUrl ? { sidecarUrl: snapshot.file.sidecarUrl } : {}),
				pageUrl: snapshot.file.pageUrl,
				sourceLabel: snapshot.file.sourceLabel,
			},
			capabilities: BROWSER_VIEWER_READ_ONLY_CAPABILITIES,
			document,
			presentationState: createPresentationState(parsed.file.state),
		});
		this.adoptedGeneration = snapshot.generation;
		this.options.present(projection);
		return { ok: true, projection };
	}
}