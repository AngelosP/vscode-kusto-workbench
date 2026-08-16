import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildSync } from 'esbuild';
import { describe, expect, it, vi } from 'vitest';
import { BrowserFileLoadCoordinator, type LoadedBrowserFile } from '../../browser-ext/src/browser-file-load';
import { isBrowserViewerProjection } from '../../src/shared/browserViewerProjection';
import {
	BROWSER_VIEWER_READ_ONLY_CAPABILITIES,
	BrowserViewerRoot,
	type BrowserViewerProjection,
} from '../../browser-ext/src/browser-viewer-root';
import type { BrowserCompanionState } from '../../browser-ext/src/companion-state';
import type { DetectedFile } from '../../browser-ext/src/providers/types';

function detectedFile(filename: string): DetectedFile {
	return {
		filename,
		rawContentUrl: `https://example.test/work/${filename}`,
		sidecarUrl: filename.endsWith('.kql')
			? `https://example.test/work/${filename}.json`
			: undefined,
		pageUrl: `https://example.test/repo/${filename}`,
		sourceLabel: 'Test Source',
	};
}

function loadedFile(
	coordinator: BrowserFileLoadCoordinator,
	file: DetectedFile,
	content: string,
	companionState: BrowserCompanionState = { status: 'missing' },
): LoadedBrowserFile {
	return {
		snapshot: coordinator.capture(file),
		content,
		companionState,
	};
}

function expectDeeplyFrozen(value: unknown, seen = new Set<unknown>()): void {
	if (!value || typeof value !== 'object' || seen.has(value)) return;
	seen.add(value);
	expect(Object.isFrozen(value)).toBe(true);
	for (const child of Object.values(value)) expectDeeplyFrozen(child, seen);
}

describe('BrowserViewerRoot', () => {
	it('adopts one native KQLX payload as an immutable read-only projection without mutating codec state', () => {
		const coordinator = new BrowserFileLoadCoordinator();
		const presented: BrowserViewerProjection[] = [];
		const present = vi.fn((projection: BrowserViewerProjection) => presented.push(projection));
		const root = new BrowserViewerRoot({
			isCurrent: snapshot => coordinator.isCurrent(snapshot),
			present,
		});
		const loaded = loadedFile(coordinator, detectedFile('native.kqlx'), JSON.stringify({
			kind: 'kqlx',
			version: 1,
			futureRoot: { preserved: true },
			state: {
				futureState: { preserved: true },
				sections: [
					{
						id: 'query_native', type: 'query', query: 'print native = 1', expanded: true,
						futureSection: { preserved: true },
					},
					{ id: 'markdown_native', type: 'markdown', text: '# Native', mode: 'markdown' },
					{ id: 'future_native', type: 'future-section', payload: { preserved: true } },
				],
			},
		}));

		const adoption = root.adopt(loaded);

		expect(adoption).toMatchObject({ ok: true });
		expect(present).toHaveBeenCalledOnce();
		expect(presented).toHaveLength(1);
		const projection = presented[0];
		expect(projection.capabilities).toEqual(BROWSER_VIEWER_READ_ONLY_CAPABILITIES);
		expect(projection.capabilities).toEqual({
			readDocument: true,
			editDocument: false,
			persistDocument: false,
			authenticate: false,
			executeKusto: false,
			executeSql: false,
			useCopilot: false,
			downloadDerivedFile: true,
		});
		expect(projection.capabilities).not.toHaveProperty('activeContentPolicy');
		expect(isBrowserViewerProjection(projection)).toBe(true);
		expect(isBrowserViewerProjection({
			...projection,
			capabilities: { ...projection.capabilities, activeContentPolicy: 'deferred' },
		})).toBe(false);
		expect(projection.source).toMatchObject({
			generation: loaded.snapshot.generation,
			filename: 'native.kqlx',
			pageUrl: 'https://example.test/repo/native.kqlx',
		});
		expect(projection.document).toMatchObject({
			kind: 'kqlx',
			futureRoot: { preserved: true },
			state: {
				futureState: { preserved: true },
				sections: [
					{ id: 'query_native', expanded: true, futureSection: { preserved: true } },
					{ id: 'markdown_native', mode: 'markdown' },
					{ id: 'future_native', payload: { preserved: true } },
				],
			},
		});
		expect(projection.presentationState).toMatchObject({
			futureState: { preserved: true },
			sections: [
				{ id: 'query_native', expanded: false, futureSection: { preserved: true } },
				{ id: 'markdown_native', mode: 'preview' },
				{ id: 'future_native', payload: { preserved: true } },
			],
		});
		expect(projection.presentationState).not.toBe(projection.document.state);
		expectDeeplyFrozen(projection);

		expect(root.adopt(loaded)).toEqual({ ok: false, reason: 'duplicate' });
		expect(present).toHaveBeenCalledOnce();
	});

	it('hydrates a KQL companion losslessly and presents only the current coordinator generation', () => {
		const coordinator = new BrowserFileLoadCoordinator();
		const presented: BrowserViewerProjection[] = [];
		const root = new BrowserViewerRoot({
			isCurrent: snapshot => coordinator.isCurrent(snapshot),
			present: projection => presented.push(projection),
		});
		const companion = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			futureRoot: { companion: true },
			state: {
				futureState: { companion: true },
				sections: [
					{
						id: 'query_companion', type: 'query', linkedQueryPath: 'current.kql',
						expanded: true, futureSection: { companion: true },
					},
					{ id: 'future_companion', type: 'future-section', payload: { companion: true } },
				],
			},
		});
		const stale = loadedFile(
			coordinator,
			detectedFile('stale.kql'),
			'print stale = 1',
			{ status: 'missing' },
		);
		const current = loadedFile(
			coordinator,
			detectedFile('current.kql'),
			'print current = 2',
			{ status: 'loaded', content: companion },
		);

		expect(root.adopt(stale)).toEqual({ ok: false, reason: 'stale' });
		expect(presented).toHaveLength(0);
		expect(root.adopt(current)).toMatchObject({ ok: true });
		expect(presented).toHaveLength(1);
		expect(presented[0].document).toMatchObject({
			kind: 'kqlx',
			futureRoot: { companion: true },
			state: {
				futureState: { companion: true },
				sections: [
					{
						id: 'query_companion', query: 'print current = 2', expanded: true,
						futureSection: { companion: true },
					},
					{ id: 'future_companion', payload: { companion: true } },
				],
			},
		});
		expect((presented[0].document.state.sections[0] as Record<string, unknown>).linkedQueryPath).toBeUndefined();
		expect(presented[0].presentationState).toMatchObject({
			futureState: { companion: true },
			sections: [
				{ id: 'query_companion', query: 'print current = 2', expanded: false },
				{ id: 'future_companion', payload: { companion: true } },
			],
		});
		expectDeeplyFrozen(presented[0]);
	});

	it('acknowledges an invalid document as terminal without presenting it', () => {
		const coordinator = new BrowserFileLoadCoordinator();
		const acknowledge = vi.fn()
			.mockImplementationOnce(() => { throw new Error('parent unavailable'); });
		const present = vi.fn();
		const root = new BrowserViewerRoot({
			isCurrent: snapshot => coordinator.isCurrent(snapshot),
			present,
			acknowledge,
		});
		const loaded = loadedFile(coordinator, detectedFile('invalid.kqlx'), '{ invalid json');

		expect(root.adopt(loaded)).toMatchObject({ ok: false, reason: 'invalid' });
		expect(present).not.toHaveBeenCalled();
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(acknowledge).toHaveBeenCalledWith(loaded.snapshot.generation);
		expect(root.adopt(loaded)).toEqual({ ok: false, reason: 'duplicate' });
		expect(acknowledge).toHaveBeenCalledTimes(2);
	});

	it('keeps the browser boot adapter free of synthetic host startup replay and timer-based read-only patches', () => {
		const source = readFileSync(resolve(process.cwd(), 'browser-ext/viewer-boot.js'), 'utf8');

		expect(source).toContain('BrowserViewerRoot');
		for (const messageType of ['persistenceMode', 'connectionsData', 'copilotAvailability', 'documentData']) {
			expect(source).not.toContain(`type: '${messageType}'`);
		}
		expect(source).not.toContain('makeEditorsReadOnly');
		expect(source).not.toContain('__kustoPersistenceEnabled');
		expect(source).not.toContain('schedulePersist =');
		const presentationSource = readFileSync(
			resolve(process.cwd(), 'src/webview/core/browser-viewer-presentation.ts'),
			'utf8',
		);
		expect(presentationSource).not.toContain('adoptedGeneration');
	});

	it('keeps the first valid generation bound across rejection and presentation failure', () => {
		const presented: BrowserViewerProjection[] = [];
		const acknowledge = vi.fn();
		let throwPresentation = false;
		const root = new BrowserViewerRoot({
			present: projection => {
				presented.push(projection);
				if (throwPresentation) throw new Error('presentation failed');
			},
			acknowledge,
		});
		const coordinator = new BrowserFileLoadCoordinator();
		const generation7 = loadedFile(coordinator, detectedFile('generation-7.kqlx'), JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [{ id: 'query_7', type: 'query', query: 'print value=7' }] },
		}));
		const generation8 = loadedFile(coordinator, detectedFile('generation-8.kqlx'), JSON.stringify({
			kind: 'kqlx', version: 1,
			state: { sections: [{ id: 'query_8', type: 'query', query: 'print value=8' }] },
		}));

		expect(root.adopt(generation7)).toMatchObject({ ok: true });
		expect(root.settlePresentation(generation7.snapshot.generation, false)).toBe('rejected');
		expect(root.adopt(generation8)).toEqual({ ok: false, reason: 'stale' });

		throwPresentation = true;
		expect(() => root.adopt(generation7)).toThrow('presentation failed');
		expect(root.adopt(generation8)).toEqual({ ok: false, reason: 'stale' });

		throwPresentation = false;
		expect(root.adopt(generation7)).toMatchObject({ ok: true });
		expect(root.settlePresentation(generation7.snapshot.generation, true)).toBe('adopted');
		expect(acknowledge).toHaveBeenCalledOnce();
		expect(acknowledge).toHaveBeenCalledWith(generation7.snapshot.generation);
		expect(root.adopt(generation7)).toEqual({ ok: false, reason: 'duplicate' });
		expect(acknowledge).toHaveBeenCalledTimes(2);
		expect(presented.map(projection => projection.source.generation)).toEqual([
			generation7.snapshot.generation,
			generation7.snapshot.generation,
			generation7.snapshot.generation,
		]);
	});

	it('retries a failed presentation before acknowledging the accepted generation', () => {
		document.body.innerHTML = `
			<div id="viewer-banner" style="display:none">
				<span class="viewer-banner-filename"></span>
				<a class="viewer-banner-source-link"></a>
			</div>
			<div id="viewer-loading"><span class="viewer-loading-message"></span></div>
			<div id="viewer-error" style="display:none">
				<span class="viewer-error-title"></span><span class="viewer-error-detail"></span>
			</div>
			<div id="queries-container"></div>
		`;
		document.documentElement.dataset.kustoBrowserPresentationReady = 'true';
		const posted: unknown[] = [];
		const postMessage = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
			posted.push(message);
		});
		let presentationAttempts = 0;
		const handleProjection = (event: Event) => {
			const projection = (event as CustomEvent).detail as BrowserViewerProjection;
			presentationAttempts++;
			window.dispatchEvent(new CustomEvent('kusto-workbench-browser-projection-applied', {
				detail: { generation: projection.source.generation, applied: presentationAttempts > 1 },
			}));
		};
		window.addEventListener('kusto-workbench-browser-projection', handleProjection);
		const bundle = buildSync({
			entryPoints: [resolve(process.cwd(), 'browser-ext/viewer-boot.js')],
			bundle: true,
			write: false,
			platform: 'browser',
			format: 'iife',
			target: 'es2022',
		}).outputFiles[0].text;
		new Function(bundle)();
		const payload = {
			type: 'kusto-workbench-load-file',
			loadGeneration: 7,
			filename: 'accepted.kqlx',
			content: JSON.stringify({
				kind: 'kqlx', version: 1,
				state: { sections: [{ id: 'query_accepted', type: 'query', query: 'print accepted=1' }] },
			}),
			companionState: { status: 'missing' },
			rawContentUrl: 'https://example.test/accepted.kqlx',
			pageUrl: 'https://example.test/repo/accepted.kqlx',
			sourceLabel: 'Test Source',
			standalone: true,
		};

		window.dispatchEvent(new MessageEvent('message', {
			data: { ...payload, loadGeneration: '7' },
		}));
		expect(presentationAttempts).toBe(0);
		expect(posted.filter(message =>
			(message as { type?: string })?.type === 'kusto-workbench-load-file-ack')).toHaveLength(0);

		let rejectFirstCanonicalPresentation = true;
		window.addEventListener('kusto-workbench-browser-projection-applied', event => {
			if (!rejectFirstCanonicalPresentation) return;
			rejectFirstCanonicalPresentation = false;
			event.stopImmediatePropagation();
			window.dispatchEvent(new CustomEvent('kusto-workbench-browser-projection-applied', {
				detail: { generation: '7', applied: true },
			}));
		}, { once: true, capture: true });
		window.dispatchEvent(new MessageEvent('message', { data: payload }));
		expect(presentationAttempts).toBe(1);
		expect(posted.filter(message =>
			(message as { type?: string })?.type === 'kusto-workbench-load-file-ack')).toHaveLength(0);

		window.dispatchEvent(new CustomEvent('kusto-workbench-browser-projection-applied', {
			detail: { generation: 7, applied: false },
		}));
		window.dispatchEvent(new MessageEvent('message', { data: payload }));
		expect(presentationAttempts).toBe(2);
		expect(document.getElementById('viewer-loading')?.style.display).toBe('none');
		expect(document.querySelector('.viewer-banner-filename')?.textContent).toBe('accepted.kqlx');
		expect(posted.filter(message =>
			(message as { type?: string })?.type === 'kusto-workbench-load-file-ack')).toEqual([
			{ type: 'kusto-workbench-load-file-ack', loadGeneration: 7 },
		]);

		window.dispatchEvent(new MessageEvent('message', { data: payload }));
		window.dispatchEvent(new MessageEvent('message', {
			data: { ...payload, loadGeneration: 8, filename: 'stale.kqlx' },
		}));

		expect(presentationAttempts).toBe(2);
		expect(document.getElementById('viewer-loading')?.style.display).toBe('none');
		expect(document.querySelector('.viewer-banner-filename')?.textContent).toBe('accepted.kqlx');
		expect(posted.filter(message =>
			(message as { type?: string })?.type === 'kusto-workbench-load-file-ack')).toEqual([
			{ type: 'kusto-workbench-load-file-ack', loadGeneration: 7 },
			{ type: 'kusto-workbench-load-file-ack', loadGeneration: 7 },
		]);
		window.removeEventListener('kusto-workbench-browser-projection', handleProjection);
		postMessage.mockRestore();
	});
});