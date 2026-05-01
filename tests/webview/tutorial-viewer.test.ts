import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/tutorials/kw-tutorial-viewer.js';
import type { KwTutorialViewer } from '../../src/webview/tutorials/kw-tutorial-viewer.js';
import type { TutorialViewerSnapshot } from '../../src/shared/tutorials/tutorialCatalog.js';

let container: HTMLDivElement;
let postedMessages: unknown[];

function installMocks(): void {
	postedMessages = [];
	(globalThis as any).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => postedMessages.push(message) });
	(window as any).marked = { parse: (markdown: string) => `<p>${markdown}</p>` };
	(window as any).DOMPurify = { sanitize: (value: string) => value };
}

function snapshot(overrides: Partial<TutorialViewerSnapshot> = {}): TutorialViewerSnapshot {
	const base: TutorialViewerSnapshot = {
		catalog: {
			schemaVersion: 1,
			generatedAt: '2026-05-01T00:00:00.000Z',
			categories: [{ id: 'agent', title: 'Agent workflow', sortOrder: 1 }],
			tutorials: [
				{
					id: 'agent-start',
					title: 'Agent start',
					summary: 'Build a chart with the agent',
					categoryId: 'agent',
					minExtensionVersion: '0.0.0',
					updateToken: 'agent-start-v1',
					tags: ['chart'],
					actions: [],
					compatible: true,
				},
				{
					id: 'agent-next',
					title: 'Agent next',
					summary: 'Refine the report',
					categoryId: 'agent',
					minExtensionVersion: '0.0.0',
					updateToken: 'agent-next-v1',
					tags: ['agent'],
					actions: [],
					compatible: true,
				},
			],
		},
		preferences: [{ categoryId: 'agent', subscribed: false, channel: 'off', unseenCount: 1 }],
		status: { source: 'builtIn', stale: false, errors: [], warnings: [] },
		preferredMode: 'standard',
	};
	return { ...base, ...overrides };
}

function createViewer(): KwTutorialViewer {
	render(html`<kw-tutorial-viewer></kw-tutorial-viewer>`, container);
	return container.querySelector('kw-tutorial-viewer')!;
}

async function sendSnapshot(viewer: KwTutorialViewer, nextSnapshot: TutorialViewerSnapshot = snapshot()): Promise<void> {
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: nextSnapshot } }));
	await settle(viewer);
}

async function settle(viewer: KwTutorialViewer): Promise<void> {
	await viewer.updateComplete;
	await new Promise(resolve => queueMicrotask(resolve));
	await viewer.updateComplete;
}

async function sendTutorialContent(viewer: KwTutorialViewer, tutorialId: string, markdown: string): Promise<void> {
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'tutorialContent', content: { tutorialId, markdown, source: 'builtIn', errors: [] } } }));
	await settle(viewer);
}

beforeEach(() => {
	installMocks();
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	delete (globalThis as any).acquireVsCodeApi;
	delete (window as any).marked;
	delete (window as any).DOMPurify;
});

describe('kw-tutorial-viewer', () => {
	it('requests a snapshot and renders categories with labels', async () => {
		const viewer = createViewer();
		await viewer.updateComplete;
		expect(postedMessages).toContainEqual({ type: 'requestSnapshot' });
		await sendSnapshot(viewer);
		expect(viewer.shadowRoot!.textContent).toContain('Agent workflow');
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-viewer-mode-standard"]')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('[aria-label="Tutorials"]')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('.tutorial-item')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('[data-overlay-scroll]')).toBeTruthy();
	});

	it('opens focused mode and navigates within the current category', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer, snapshot({ preferredMode: 'focused' }));
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-viewer-mode-focused"]')).toBeTruthy();
		expect(viewer.shadowRoot!.textContent).toContain('Agent start');
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-next"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next' });
	});

	it('searches tutorial summaries', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		const search = viewer.shadowRoot!.querySelector('kw-search-bar')!;
		search.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'missing' } }));
		await viewer.updateComplete;
		expect(viewer.shadowRoot!.textContent).toContain('No tutorials match');
	});

	it('posts subscription and channel changes', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-mode-focused"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		expect(postedMessages).toContainEqual({ type: 'setPreferredMode', mode: 'focused' });
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-mode-standard"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-subscribe"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'setCategorySubscription', categoryId: 'agent', subscribed: true });
		await sendSnapshot(viewer, snapshot({ preferences: [{ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', unseenCount: 1 }] }));
		const bell = viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-subscribe"]') as HTMLButtonElement;
		expect(bell.getAttribute('aria-label')).toBe('Unsubscribe from Agent workflow category updates');
		const channel = viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-channel"]') as HTMLButtonElement;
		expect(channel.textContent).toContain('pop-up');
		expect(channel.title).toContain('automatically fire up the tutorial UI');
		expect(channel.getAttribute('aria-label')).toContain('Agent workflow updates');
		channel.click();
		expect(postedMessages).toContainEqual({ type: 'setNotificationChannel', categoryId: 'agent', channel: 'vscodeNotification' });
		bell.click();
		expect(postedMessages).toContainEqual({ type: 'setCategorySubscription', categoryId: 'agent', subscribed: false });
		await sendSnapshot(viewer, snapshot({ preferences: [{ categoryId: 'agent', subscribed: false, channel: 'off', unseenCount: 1 }] }));
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-channel"]')).toBeNull();
	});

	it('switches focused content when the host reopens a different category', async () => {
		const base = snapshot();
		const multiCategorySnapshot: TutorialViewerSnapshot = {
			...base,
			preferredMode: 'focused',
			catalog: {
				...base.catalog,
				categories: [
					{ id: 'agent', title: 'Agent workflow', sortOrder: 1 },
					{ id: 'charts', title: 'Charts', sortOrder: 2 },
				],
				tutorials: [
					...base.catalog.tutorials,
					{
						id: 'chart-start',
						title: 'Chart start',
						summary: 'Build a chart from results',
						categoryId: 'charts',
						minExtensionVersion: '0.0.0',
						updateToken: 'chart-start-v1',
						tags: ['chart'],
						actions: [],
						compatible: true,
					},
				],
			},
			preferences: [
				{ categoryId: 'agent', subscribed: false, channel: 'off', unseenCount: 1 },
				{ categoryId: 'charts', subscribed: false, channel: 'off', unseenCount: 1 },
			],
			selectedCategoryId: 'agent',
			selectedTutorialId: 'agent-start',
		};
		const viewer = createViewer();
		await sendSnapshot(viewer, multiCategorySnapshot);
		expect(viewer.shadowRoot!.textContent).toContain('Agent start');
		await sendSnapshot(viewer, { ...multiCategorySnapshot, selectedCategoryId: 'charts', selectedTutorialId: undefined });
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		await sendSnapshot(viewer, multiCategorySnapshot);
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).not.toContain('Agent start');
	});

	it('ignores stale tutorial content responses', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		await sendTutorialContent(viewer, 'agent-start', 'first tutorial');
		expect(viewer.shadowRoot!.textContent).toContain('first tutorial');
		(viewer.shadowRoot!.querySelector('[data-tutorial-id="agent-next"]') as HTMLButtonElement).click();
		await settle(viewer);
		await sendTutorialContent(viewer, 'agent-start', 'stale tutorial');
		expect(viewer.shadowRoot!.textContent).not.toContain('stale tutorial');
		await sendTutorialContent(viewer, 'agent-next', 'fresh tutorial');
		expect(viewer.shadowRoot!.textContent).toContain('fresh tutorial');
	});

	it('sanitizes command links, remote images, and direct webview resource images from markdown', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		(window as any).marked = { parse: () => '<a href="command:kusto.openQueryEditor">bad</a><img src="https://example.com/a.png"><img src="vscode-resource:/secret.png"><img src="https://file+.vscode-resource.vscode-cdn.net/cached.png"><p>safe</p>' };
		await sendTutorialContent(viewer, 'agent-start', 'ignored');
		expect(viewer.shadowRoot!.innerHTML).not.toContain('command:kusto.openQueryEditor');
		expect(viewer.shadowRoot!.innerHTML).not.toContain('https://example.com/a.png');
		expect(viewer.shadowRoot!.innerHTML).not.toContain('vscode-resource:/secret.png');
		expect(viewer.shadowRoot!.innerHTML).toContain('https://file+.vscode-resource.vscode-cdn.net/cached.png');
		expect(viewer.shadowRoot!.textContent).toContain('safe');
	});

	it('escapes markdown when DOMPurify is unavailable', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		delete (window as any).DOMPurify;
		(window as any).marked = { parse: () => '<img src="https://file+.vscode-resource.vscode-cdn.net/cached.png"><strong>parsed</strong>' };
		await sendTutorialContent(viewer, 'agent-start', '<img src="x" onerror="alert(1)">\nplain');
		expect(viewer.shadowRoot!.querySelector('.markdown img')).toBeNull();
		expect(viewer.shadowRoot!.textContent).toContain('<img src="x" onerror="alert(1)">');
		expect(viewer.shadowRoot!.textContent).toContain('plain');
	});
});
