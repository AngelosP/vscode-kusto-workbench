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

	capture(file: DetectedFile): BrowserFileLoadSnapshot {
		return {
			generation: ++this.generation,
			file: Object.freeze({ ...file }),
		};
	}

	invalidate(): void {
		this.generation++;
	}

	isCurrent(snapshot: BrowserFileLoadSnapshot): boolean {
		return snapshot.generation === this.generation;
	}

	async load(
		snapshot: BrowserFileLoadSnapshot,
		fetchText: (url: string) => Promise<string>,
	): Promise<LoadedBrowserFile | undefined> {
		const content = await fetchText(snapshot.file.rawContentUrl);
		if (!this.isCurrent(snapshot)) return undefined;
		const companionState = await loadBrowserCompanion(snapshot.file.sidecarUrl, fetchText);
		if (!this.isCurrent(snapshot)) return undefined;
		return { snapshot, content, companionState };
	}
}
