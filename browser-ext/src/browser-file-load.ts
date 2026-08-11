import { loadBrowserCompanion, type BrowserCompanionState } from './companion-state';
import type { DetectedFile } from './providers/types';

export type BrowserFileLoadSnapshot = Readonly<{
	generation: number;
	file: Readonly<DetectedFile>;
}>;

export type LoadedBrowserFile = Readonly<{
	snapshot: BrowserFileLoadSnapshot;
	content: string;
	companionState: BrowserCompanionState;
}>;

export class BrowserFileLoadCoordinator {
	private generation = 0;
	private activeRequest: Readonly<{ generation: number; controller: AbortController }> | undefined;

	capture(file: DetectedFile): BrowserFileLoadSnapshot {
		this.abortActiveRequest();
		return {
			generation: ++this.generation,
			file: Object.freeze({ ...file }),
		};
	}

	invalidate(): void {
		this.generation++;
		this.abortActiveRequest();
	}

	isCurrent(snapshot: BrowserFileLoadSnapshot): boolean {
		return snapshot.generation === this.generation;
	}

	async load(
		snapshot: BrowserFileLoadSnapshot,
		fetchText: (url: string, signal: AbortSignal) => Promise<string>,
	): Promise<LoadedBrowserFile | undefined> {
		if (!this.isCurrent(snapshot)) return undefined;
		this.abortActiveRequest();
		const controller = new AbortController();
		this.activeRequest = { generation: snapshot.generation, controller };
		try {
			const content = await fetchText(snapshot.file.rawContentUrl, controller.signal);
			if (!this.isCurrent(snapshot)) return undefined;
			const companionState = await loadBrowserCompanion(snapshot.file.sidecarUrl, fetchText, controller.signal);
			if (!this.isCurrent(snapshot)) return undefined;
			return { snapshot, content, companionState };
		} catch (error) {
			if (controller.signal.aborted || !this.isCurrent(snapshot)) return undefined;
			throw error;
		} finally {
			if (this.activeRequest?.generation === snapshot.generation) this.activeRequest = undefined;
		}
	}

	private abortActiveRequest(): void {
		this.activeRequest?.controller.abort();
		this.activeRequest = undefined;
	}
}
