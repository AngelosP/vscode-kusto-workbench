import { describe, expect, it, vi } from 'vitest';
import { BrowserFileLoadCoordinator } from '../../browser-ext/src/browser-file-load';
import type { DetectedFile } from '../../browser-ext/src/providers/types';

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>(settle => { resolve = settle; });
	return { promise, resolve };
}

const file = (name: string): DetectedFile => ({
	filename: `${name}.kql`,
	rawContentUrl: `https://dev.azure.test/items?path=%2F${name}.kql`,
	sidecarUrl: `https://dev.azure.test/items?path=%2F${name}.kql.json`,
	pageUrl: `https://dev.azure.test/repo?path=%2F${name}.kql`,
	sourceLabel: 'Azure DevOps',
});

describe('BrowserFileLoadCoordinator', () => {
	it('aborts file A while its companion is pending and returns only file B identity and bytes', async () => {
		const coordinator = new BrowserFileLoadCoordinator();
		const companionA = deferred<string>();
		const fetchText = vi.fn((url: string) => {
			if (url.includes('A.kql.json')) return companionA.promise;
			if (url.includes('A.kql')) return Promise.resolve('QUERY_A');
			if (url.includes('B.kql.json')) return Promise.resolve('{"file":"B"}');
			if (url.includes('B.kql')) return Promise.resolve('QUERY_B');
			return Promise.reject(new Error(`Unexpected URL: ${url}`));
		});

		const snapshotA = coordinator.capture(file('A'));
		const loadA = coordinator.load(snapshotA, fetchText);
		await vi.waitFor(() => expect(fetchText).toHaveBeenCalledWith(expect.stringContaining('A.kql.json')));

		const snapshotB = coordinator.capture(file('B'));
		const loadB = coordinator.load(snapshotB, fetchText);
		companionA.resolve('{"file":"A"}');

		await expect(loadA).resolves.toBeUndefined();
		await expect(loadB).resolves.toEqual({
			snapshot: snapshotB,
			content: 'QUERY_B',
			companionState: { status: 'loaded', content: '{"file":"B"}' },
		});
		expect(snapshotA.file.filename).toBe('A.kql');
		expect(snapshotB.file.filename).toBe('B.kql');
	});

	it('invalidates a pending primary fetch during navigation cleanup', async () => {
		const coordinator = new BrowserFileLoadCoordinator();
		const primary = deferred<string>();
		const snapshot = coordinator.capture(file('A'));
		const loading = coordinator.load(snapshot, () => primary.promise);

		coordinator.invalidate();
		primary.resolve('STALE_QUERY_A');

		await expect(loading).resolves.toBeUndefined();
	});
});
