// @vitest-environment node
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const template = readFileSync(fileURLToPath(new URL('../../src/webview/queryEditor.html', import.meta.url)), 'utf8');
const marker = template.indexOf('// Monaco web workers run from blob:');
const bootstrap = template.slice(template.indexOf('(function () {', marker), template.indexOf('</script>', marker))
	.replaceAll('{{monacoVsUri}}', 'https://resources.test/dist/monaco/vs')
	.replaceAll('{{cacheBuster}}', 'test-build');
const baseUrl = 'https://resources.test/dist/monaco/';
const workerMain = 'vs/base/worker/workerMain.js';
const kustoModule = 'vs/language/kusto/kustoWorker.js';

function createHarness(config: { largeSource?: boolean; failFetch?: boolean; failPost?: boolean; failConstruct?: boolean; failImport?: boolean } = {}) {
	const scripts = new Map<string, string>([
		[workerMain, `
			self.onmessage = function (event) {
				if (event.data.moduleUrl) importScripts(event.data.moduleUrl);
				self.postMessage({ request: event.data.request, runs: self.moduleRuns, text: self.moduleText });
			};
		`],
		[kustoModule, `
			importScripts('${baseUrl}vs/language/kusto/schema-d1f6d06d.js?v=1#fragment');
			self.moduleRuns = (self.moduleRuns || 0) + 1;
			${config.largeSource ? '// ' + 'x'.repeat(600_000) : ''}
		`],
		['vs/language/kusto/schema-d1f6d06d.js', 'self.moduleText = "quotes \\" and unicode \\u2603";'],
	]);
	const blobs: string[] = [];
	const revoked: string[] = [];
	const timers: Array<() => void> = [];
	const workers: TestWorker[] = [];
	const nativeImport = vi.fn<(...urls: string[]) => void>();
	class TestBlob {
		readonly text!: string;
		constructor(parts: string[]) {
			Object.defineProperty(this, 'text', { value: parts.join('') });
			Object.freeze(this);
		}
	}
	const objectUrls = {
		createObjectURL: (blob: TestBlob) => {
			blobs.push(blob.text);
			return `blob:${blobs.length - 1}`;
		},
		revokeObjectURL: (url: string) => revoked.push(url),
	};
	function cloneMessage(value: unknown): unknown {
		if (value instanceof TestBlob) return value;
		if (Array.isArray(value)) return value.map(cloneMessage);
		if (value && typeof value === 'object') {
			return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneMessage(item)]));
		}
		return value;
	}
	class TestWorker {
		readonly sent: unknown[] = [];
		readonly replies: unknown[] = [];
		readonly evaluatedSources: string[] = [];
		readonly terminate = vi.fn();
		readonly scope: Record<string, unknown>;
		constructor(readonly url: string, readonly options: { name: string }) {
			if (config.failConstruct) throw new Error('Worker creation failed');
			workers.push(this);
			class WorkerURL extends URL {}
			Object.assign(WorkerURL, objectUrls);
			this.scope = {
				console,
				URL: WorkerURL,
				Blob: TestBlob,
				importScripts: (...urls: string[]) => {
					for (const scriptUrl of urls) {
						if (!scriptUrl.startsWith('blob:')) {
							nativeImport(scriptUrl);
							continue;
						}
						if (revoked.includes(scriptUrl)) throw new Error('Worker imported a revoked blob');
						if (config.failImport) throw new Error('Worker import failed');
						const source = blobs[Number(scriptUrl.slice('blob:'.length))];
						this.evaluatedSources.push(source);
						runInContext(source, context);
					}
				},
				postMessage: (message: unknown) => this.replies.push(structuredClone(message)),
			};
			this.scope.self = this.scope;
			const context = createContext(this.scope);
			this.scope.eval = (source: string) => {
				this.evaluatedSources.push(source);
				return runInContext(source, context);
			};
			runInContext(blobs[Number(url.slice('blob:'.length))], context);
		}
		postMessage(message: unknown): void {
			if (config.failPost) throw new Error('Worker post failed');
			const data = cloneMessage(message);
			this.sent.push(data);
			queueMicrotask(() => {
				const handler = this.scope.onmessage;
				if (typeof handler === 'function') handler({ data });
			});
		}
	}
	const fetch = vi.fn(async (url: string) => ({
		ok: !config.failFetch,
		status: config.failFetch ? 503 : 200,
		text: async () => scripts.get(url.slice(baseUrl.length).split('?')[0]) ?? '',
	}));
	const window: {
		MonacoEnvironment?: {
			getWorker(id: string, label: string): Promise<TestWorker>;
			getWorkerUrl(): string;
		};
	} = {};
	runInNewContext(bootstrap, {
		window,
		console,
		fetch,
		Worker: TestWorker,
		Blob: TestBlob,
		URL: objectUrls,
		setTimeout: vi.fn((callback: () => void) => timers.push(callback)),
	});
	if (!window.MonacoEnvironment) throw new Error('Monaco worker factory was not installed');
	return {
		environment: window.MonacoEnvironment, fetch, blobs, workers, nativeImport, revoked, timers,
		scriptText: (value: unknown) => {
			if (!(value instanceof TestBlob)) throw new Error('Worker script must be a browser-owned Blob, not copied text');
			return value.text;
		},
	};
}

describe('Monaco worker bootstrap memory', () => {
	it('keeps the first message small instead of cloning vendor text into the worker heap', async () => {
		const harness = createHarness({ largeSource: true });

		const worker = await harness.environment.getWorker('worker-1', 'kusto');

		expect(JSON.stringify(worker.sent[0]).length).toBeLessThan(8 * 1024);
	});

	it('keeps the bootstrap small instead of embedding fetched vendor source as JavaScript literals', async () => {
		const harness = createHarness({ largeSource: true });

		const worker = await harness.environment.getWorker('worker-1', 'kusto');

		expect(harness.blobs[Number(worker.url.slice('blob:'.length))].length).toBeLessThan(8 * 1024);
	});

	it('releases fulfilled source-text fetches after handing scripts to a worker', async () => {
		const harness = createHarness();
		await harness.environment.getWorker('worker-1', 'kusto');
		const fetchedOnce = harness.fetch.mock.calls.length;
		expect(fetchedOnce).toBe(8);

		await harness.environment.getWorker('worker-2', 'kusto');

		expect(harness.fetch).toHaveBeenCalledTimes(fetchedOnce * 2);
		expect(harness.workers).toHaveLength(2);
	});

	it('shares in-flight source acquisition across overlapping workers', async () => {
		const harness = createHarness();

		const first = harness.environment.getWorker('worker-1', 'kusto');
		const second = harness.environment.getWorker('worker-2', 'kusto');
		await Promise.all([first, second]);

		expect(harness.fetch).toHaveBeenCalledTimes(8);
		expect(harness.workers).toHaveLength(2);
		expect(harness.workers[0]).not.toBe(harness.workers[1]);
	});

	it('imports annotated Blob resources without transferring or rebuilding their source text', async () => {
		const harness = createHarness();
		const worker = await harness.environment.getWorker('worker-1', 'kusto');
		const packet = worker.sent[0];
		if (!packet || typeof packet !== 'object' || !('scripts' in packet)
			|| !packet.scripts || typeof packet.scripts !== 'object' || !(kustoModule in packet.scripts)) {
			throw new Error('Worker bootstrap did not transfer its script map');
		}
		const source = harness.scriptText(packet.scripts[kustoModule]);
		expect(source).toContain(`\n//# sourceURL=${baseUrl}${kustoModule}`);

		worker.postMessage({ moduleUrl: `${baseUrl}${kustoModule}`, request: 'annotated-source' });
		await Promise.resolve();

		expect(worker.evaluatedSources).toContain(source);
	});

	it('revokes import URLs immediately while preserving repeated imports after bootstrap URL cleanup', async () => {
		const harness = createHarness();
		const worker = await harness.environment.getWorker('worker-1', 'kusto');
		for (const timer of harness.timers) timer();

		worker.postMessage({ moduleUrl: `${baseUrl}${kustoModule}`, request: 'after-cleanup' });
		await Promise.resolve();
		worker.postMessage({ moduleUrl: `${baseUrl}${kustoModule}`, request: 'repeat-after-cleanup' });
		await Promise.resolve();

		expect(worker.replies).toEqual([
			{ request: 'after-cleanup', runs: 1, text: 'quotes " and unicode \u2603' },
			{ request: 'repeat-after-cleanup', runs: 2, text: 'quotes " and unicode \u2603' },
		]);
		expect(new Set(harness.revoked).size).toBe(harness.blobs.length);
		expect(harness.revoked).toHaveLength(harness.blobs.length);
		expect(worker.terminate).not.toHaveBeenCalled();
	});

	it('revokes a temporary import URL even when native loading throws', async () => {
		const options = { failImport: false };
		const harness = createHarness(options);
		const worker = await harness.environment.getWorker('worker-1', 'kusto');
		options.failImport = true;
		const importScripts = worker.scope.importScripts;
		if (typeof importScripts !== 'function') throw new Error('Worker import hook was not installed');
		const before = harness.blobs.length;

		expect(() => importScripts(`${baseUrl}${kustoModule}`)).toThrow('Worker import failed');

		expect(harness.blobs.length).toBe(before + 1);
		expect(harness.revoked).toContain(`blob:${before}`);
	});

	it('preserves initial messages, global scripts, repeated imports and source text', async () => {
		const harness = createHarness();
		const worker = await harness.environment.getWorker('worker-1', 'kusto');

		worker.postMessage({ moduleUrl: `${baseUrl}${kustoModule}?version=2#source`, request: 'first' });
		await Promise.resolve();
		worker.postMessage({ moduleUrl: `${baseUrl}${kustoModule}`, request: 'second' });
		await Promise.resolve();

		expect(worker.replies).toEqual([
			{ request: 'first', runs: 1, text: 'quotes " and unicode \u2603' },
			{ request: 'second', runs: 2, text: 'quotes " and unicode \u2603' },
		]);
		expect(harness.nativeImport).not.toHaveBeenCalled();
		expect(worker.options.name).toBe('kusto');
		expect(worker.terminate).not.toHaveBeenCalled();
	});

	it('preserves native imports outside the supplied module set', async () => {
		const harness = createHarness();
		const worker = await harness.environment.getWorker('worker-1', 'kusto');
		const moduleUrl = 'https://resources.test/extra.js?version=1#source';

		worker.postMessage({ moduleUrl, request: 'native-import' });
		await Promise.resolve();

		expect(harness.nativeImport).toHaveBeenCalledExactlyOnceWith(moduleUrl);
	});

	it.each([['kql', 8], ['html', 2], ['razor', 2], ['editorWorkerService', 1]] as const)(
		'loads only the required %s worker sources',
		async (label, sourceCount) => {
			const harness = createHarness();

			await harness.environment.getWorker('worker-1', label);

			expect(harness.fetch).toHaveBeenCalledTimes(sourceCount);
			expect(harness.workers[0].options.name).toBe(label);
			expect(harness.environment.getWorkerUrl()).toBe(`${baseUrl}${workerMain}`);
		},
	);

	it('propagates acquisition failures without creating a worker', async () => {
		const harness = createHarness({ failFetch: true });

		await expect(harness.environment.getWorker('worker-1', 'kusto')).rejects.toThrow('HTTP 503');

		expect(harness.workers).toHaveLength(0);
		expect(harness.blobs).toHaveLength(0);
	});

	it('releases failed acquisitions so a later worker can retry', async () => {
		const options = { failFetch: true };
		const harness = createHarness(options);
		await expect(harness.environment.getWorker('worker-1', 'kusto')).rejects.toThrow('HTTP 503');

		options.failFetch = false;
		await harness.environment.getWorker('worker-2', 'kusto');

		expect(harness.fetch).toHaveBeenCalledTimes(16);
		expect(harness.workers).toHaveLength(1);
	});

	it('retires the new worker and blob when script handoff fails', async () => {
		const harness = createHarness({ failPost: true });

		await expect(harness.environment.getWorker('worker-1', 'kusto')).rejects.toThrow('Worker post failed');

		expect(harness.workers).toHaveLength(1);
		expect(harness.workers[0].terminate).toHaveBeenCalledOnce();
		expect(harness.revoked).toEqual(['blob:0']);
	});

	it('revokes the bootstrap URL if worker construction fails', async () => {
		const harness = createHarness({ failConstruct: true });

		await expect(harness.environment.getWorker('worker-1', 'kusto')).rejects.toThrow('Worker creation failed');

		expect(harness.workers).toHaveLength(0);
		expect(harness.revoked).toEqual(['blob:0']);
	});
});
