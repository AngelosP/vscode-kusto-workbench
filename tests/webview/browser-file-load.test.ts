import { describe, expect, it, vi } from 'vitest';
import { BrowserFileLoadCoordinator } from '../../browser-ext/src/browser-file-load';
import { readBrowserTextBody } from '../../browser-ext/src/browser-text-fetch';
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
		await vi.waitFor(() => expect(fetchText.mock.calls.some(([url]) => url.includes('A.kql.json'))).toBe(true));
		const requestASignal = fetchText.mock.calls.find(([url]) => url.includes('A.kql.json'))?.[1] as AbortSignal;
		expect(requestASignal.aborted).toBe(false);

		const snapshotB = coordinator.capture(file('B'));
		expect(requestASignal.aborted).toBe(true);
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
		const snapshot = coordinator.capture(file('A'));
		let capturedSignal: AbortSignal | undefined;
		const loading = coordinator.load(snapshot, (_url, signal) => new Promise<string>((_resolve, reject) => {
			capturedSignal = signal;
			signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
		}));
		await vi.waitFor(() => expect(capturedSignal).toBeDefined());

		coordinator.invalidate();

		await expect(loading).resolves.toBeUndefined();
		expect(capturedSignal?.aborted).toBe(true);
	});

	it('rejects a streaming response once it exceeds the browser file size limit', async () => {
		const body = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new Uint8Array(16 * 1024 * 1024));
				controller.enqueue(new Uint8Array([1]));
				controller.close();
			},
		});

		await expect(readBrowserTextBody(new Response(body))).rejects.toThrow('16777216-byte size limit');
	});
});
