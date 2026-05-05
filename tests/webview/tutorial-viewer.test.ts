import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';
import '../../src/webview/tutorials/kw-tutorial-viewer.js';
import type { KwTutorialViewer } from '../../src/webview/tutorials/kw-tutorial-viewer.js';
import { TUTORIAL_CONNECTION_REQUIRED_MESSAGE, type TutorialViewerSnapshot } from '../../src/shared/tutorials/tutorialCatalog.js';

let container: HTMLDivElement;
let postedMessages: unknown[];

function installMocks(): void {
	postedMessages = [];
	(globalThis as any).acquireVsCodeApi = () => ({ postMessage: (message: unknown) => postedMessages.push(message) });
	(window as any).marked = { parse: (markdown: string) => markdown.replace(/^# (.+)$/m, '<h1>$1</h1>') };
	(window as any).DOMPurify = { sanitize: (value: string) => value };
}

function snapshot(overrides: Partial<TutorialViewerSnapshot> = {}): TutorialViewerSnapshot {
	const base: TutorialViewerSnapshot = {
		catalog: {
			schemaVersion: 1,
			generatedAt: '2026-05-01T00:00:00.000Z',
			categories: [{ id: 'agent', title: 'Agent workflow', sortOrder: 1 }],
			content: [
				{
					id: 'agent-start',
					displayName: 'Agent start',
					categoryId: 'agent',
					minExtensionVersion: '0.0.0',
					compatible: true,
					unseen: true,
				},
				{
					id: 'agent-next',
					displayName: 'Agent next',
					categoryId: 'agent',
					minExtensionVersion: '0.0.0',
					compatible: true,
					unseen: true,
				},
			],
		},
		preferences: [{ categoryId: 'agent', subscribed: false, channel: 'off', notificationCadence: 'daily', unseenCount: 1 }],
		status: { source: 'cache', stale: false, errors: [], warnings: [] },
		tutorialsEnabled: true,
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
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'tutorialContent', content: { tutorialId, markdown, source: 'cache', errors: [] } } }));
	await settle(viewer);
}

function domRect(left: number, top: number, width: number, height: number): DOMRect {
	return {
		x: left,
		y: top,
		left,
		top,
		width,
		height,
		right: left + width,
		bottom: top + height,
		toJSON: () => ({ x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }),
	} as DOMRect;
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
	it('requests a snapshot and renders the Browse all header, filters, and content list', async () => {
		const viewer = createViewer();
		await viewer.updateComplete;
		expect(postedMessages).toContainEqual({ type: 'requestSnapshot' });
		await sendSnapshot(viewer, snapshot({ status: { source: 'remote', stale: false, lastUpdated: '2026-05-02T00:00:00.000Z', errors: [], warnings: [] } }));
		const text = viewer.shadowRoot!.textContent ?? '';
		expect(text).toContain('Did you know?');
		expect(text).not.toContain('Kusto Workbench');
		expect(text).not.toContain('Catalog:');
		expect(text).not.toContain('Updated');
		expect(text).not.toContain('#chart');
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-viewer-mode-standard"]')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('[aria-label="Did you know? content"]')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('.status-info')).toBeNull();
		const refresh = viewer.shadowRoot!.querySelector('.standard-refresh') as HTMLButtonElement;
		expect(refresh.title).toContain('Refresh catalog');
		expect(refresh.title).toContain('Catalog: remote');
		expect(refresh.title).toContain('Updated');
		const categorySelect = viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-select"]') as HTMLElement & { selectedId: string; items: Array<{ label: string }> };
		expect(categorySelect).toBeTruthy();
		expect(categorySelect.selectedId).toBe('all');
		expect(categorySelect.items.map(item => item.label)).toEqual(['All', 'Agent workflow']);
		const showSeen = viewer.shadowRoot!.querySelector('[data-testid="tutorial-show-seen-toggle"] input') as HTMLInputElement;
		expect(showSeen.checked).toBe(true);
		const standardClose = viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-dismiss"]') as HTMLButtonElement;
		expect(standardClose).toBeTruthy();
		expect(standardClose.closest('.standard-frame')).toBeTruthy();
		expect(standardClose.closest('.toolbar-actions')).toBeTruthy();
		expect(Array.from(viewer.shadowRoot!.querySelectorAll<HTMLButtonElement>('.toolbar-actions button')).map(button => button.classList.contains('standard-refresh') ? 'refresh' : button.dataset.testid)).toEqual(['refresh', 'tutorial-standard-dismiss']);
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-mute"]')).toBeTruthy();
		const standardNav = viewer.shadowRoot!.querySelector('.standard-nav')!;
		expect(standardNav.textContent).toContain('1 of 2');
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-prev"]') as HTMLButtonElement).disabled).toBe(true);
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-start' });
		expect(postedMessages).not.toContainEqual({ type: 'openTutorial', tutorialId: 'agent-start', markSeen: true });
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-next"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next', markSeen: true, markSeenTutorialIds: ['agent-start'] });
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.standard-nav')!.textContent).toContain('2 of 2');
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-prev"]') as HTMLButtonElement).disabled).toBe(false);
		const compactButton = viewer.shadowRoot!.querySelector('[data-testid="tutorial-mode-compact"]') as HTMLButtonElement;
		expect(compactButton.closest('.standard-footer')).toBeTruthy();
		expect(compactButton.textContent).toContain('Compact');
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-got-it"]')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('.tutorial-item')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('.detail-header')).toBeNull();
		const tutorialList = viewer.shadowRoot!.querySelector('[data-testid="tutorial-list"]') as HTMLElement;
		expect(tutorialList.getAttribute('data-overlay-scroll')).toBe('x:hidden y:scroll visibility:visible autoHide:never');
		expect(tutorialList.getAttribute('tabindex')).toBe('0');
	});

	it('toggles standard tutorial read state without opening the row', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		let toggles = Array.from(viewer.shadowRoot!.querySelectorAll<HTMLButtonElement>('[data-testid="tutorial-read-toggle"]'));
		expect(toggles).toHaveLength(2);
		expect(toggles[0].getAttribute('aria-label')).toBe('Mark as read');
		expect(toggles[0].classList.contains('unread')).toBe(true);

		postedMessages = [];
		toggles[0].click();
		expect(postedMessages).toEqual([{ type: 'setTutorialSeen', tutorialId: 'agent-start', seen: true }]);
		expect(postedMessages.some((message: any) => message.type === 'openTutorial')).toBe(false);

		postedMessages = [];
		(viewer.shadowRoot!.querySelector('[data-tutorial-id="agent-start"]') as HTMLButtonElement).click();
		expect(postedMessages).toEqual([{ type: 'setTutorialSeen', tutorialId: 'agent-start', seen: true }]);

		const readSnapshot = snapshot({
			catalog: {
				...snapshot().catalog,
				content: snapshot().catalog.content.map(tutorial => tutorial.id === 'agent-start' ? { ...tutorial, unseen: false } : tutorial),
			},
		});
		await sendSnapshot(viewer, readSnapshot);
		toggles = Array.from(viewer.shadowRoot!.querySelectorAll<HTMLButtonElement>('[data-testid="tutorial-read-toggle"]'));
		expect(toggles[0].getAttribute('aria-label')).toBe('Mark as unread');
		expect(toggles[0].classList.contains('read')).toBe(true);

		postedMessages = [];
		toggles[0].click();
		expect(postedMessages).toEqual([{ type: 'setTutorialSeen', tutorialId: 'agent-start', seen: false }]);

		postedMessages = [];
		(viewer.shadowRoot!.querySelector('[data-tutorial-id="agent-next"]') as HTMLButtonElement).click();
		expect(postedMessages).toEqual([{ type: 'openTutorial', tutorialId: 'agent-next', markSeen: true }]);
	});

	it('renders a connection-required state when no remote catalog or cache is available', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer, snapshot({
			catalog: { schemaVersion: 1, generatedAt: '2026-05-01T00:00:00.000Z', categories: [], content: [] },
			preferences: [],
			status: { source: 'unavailable', stale: false, errors: [TUTORIAL_CONNECTION_REQUIRED_MESSAGE], warnings: [] },
		}));
		expect(viewer.shadowRoot!.textContent).toContain(TUTORIAL_CONNECTION_REQUIRED_MESSAGE);
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-viewer-mode-unavailable"]')).toBeTruthy();
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-item"]')).toBeNull();
		(viewer.shadowRoot!.querySelector('.action-btn') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'refreshCatalog' });
	});

	it('opens compact mode without subtitle metadata and strips duplicate markdown headings', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer, snapshot({ preferredMode: 'compact' }));
		await sendTutorialContent(viewer, 'agent-start', '# Agent start\n\nOpen the Kusto Workbench agent.');
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-viewer-mode-compact"]')).toBeTruthy();
		expect(viewer.shadowRoot!.textContent).toContain('Did you know?');
		expect(viewer.shadowRoot!.textContent).toContain('Agent start');
		expect(viewer.shadowRoot!.querySelector('.compact-summary')).toBeNull();
		expect(viewer.shadowRoot!.querySelector('.compact-meta')).toBeNull();
		expect(viewer.shadowRoot!.querySelector('.compact-markdown h1')).toBeNull();
		expect(viewer.shadowRoot!.querySelector('.compact-markdown')!.textContent).toContain('Open the Kusto Workbench agent.');
	});

	it('keeps the clicked compact navigation button under the pointer after navigation changes layout', async () => {
		const viewer = createViewer();
		let nextButtonTop = 300;
		const rectSpy = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
			if (this instanceof HTMLElement && this.classList.contains('compact-frame')) {
				return domRect(230, 100, 540, 360);
			}
			if (this instanceof HTMLElement && this.dataset.testid === 'tutorial-next') {
				return domRect(430, nextButtonTop, 38, 34);
			}
			if (this instanceof HTMLElement && this.dataset.testid === 'tutorial-prev') {
				return domRect(384, nextButtonTop, 38, 34);
			}
			return domRect(0, 0, 10, 10);
		});
		try {
			await sendSnapshot(viewer, snapshot({ preferredMode: 'compact' }));
			await sendTutorialContent(viewer, 'agent-start', '# Agent start\n\nOpen the Kusto Workbench agent.');
			const nextButton = viewer.shadowRoot!.querySelector('[data-testid="tutorial-next"]') as HTMLButtonElement;
			nextButton.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true, clientX: 450, clientY: 314 }));
			nextButtonTop = 340;
			await settle(viewer);

			const frame = viewer.shadowRoot!.querySelector('.compact-frame') as HTMLElement;
			expect(frame.style.getPropertyValue('--kw-compact-offset-y')).toBe('-40px');
			expect(frame.style.getPropertyValue('--kw-compact-offset-x')).toBe('0px');
			expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next', markSeen: true });
		} finally {
			rectSpy.mockRestore();
		}
	});

	it('keeps compact navigation on a session-stable unread queue across categories', async () => {
		const base = snapshot();
		const unreadSnapshot: TutorialViewerSnapshot = {
			...base,
			preferredMode: 'compact',
			selectedCategoryId: 'agent',
			catalog: {
				...base.catalog,
				categories: [
					{ id: 'agent', title: 'Agent workflow', sortOrder: 1 },
					{ id: 'charts', title: 'Charts', sortOrder: 2 },
				],
				content: [
					{ ...base.catalog.content[0], unseen: true },
					{ ...base.catalog.content[1], unseen: false },
					{
						id: 'chart-start',
						displayName: 'Chart start',
						categoryId: 'charts',
						minExtensionVersion: '0.0.0',
						compatible: true,
						unseen: true,
					},
				],
			},
		};
		const viewer = createViewer();
		await sendSnapshot(viewer, unreadSnapshot);
		expect(viewer.shadowRoot!.textContent).toContain('Agent start');
		expect(viewer.shadowRoot!.textContent).toContain('1 of 2');
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-show-seen-toggle"]')).toBeNull();
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-next"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'chart-start', markSeen: true });

		await sendSnapshot(viewer, {
			...unreadSnapshot,
			selectedCategoryId: 'charts',
			selectedTutorialId: 'chart-start',
			catalog: {
				...unreadSnapshot.catalog,
				content: unreadSnapshot.catalog.content.map(tutorial => ({ ...tutorial, unseen: false })),
			},
		});
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).toContain('2 of 2');
		expect(viewer.shadowRoot!.textContent).not.toContain('Nothing to show right now');

		await sendSnapshot(viewer, {
			...unreadSnapshot,
			selectedCategoryId: 'charts',
			selectedTutorialId: 'chart-start',
			catalog: {
				...unreadSnapshot.catalog,
				content: [
					...unreadSnapshot.catalog.content.map(tutorial => ({ ...tutorial, unseen: false })),
					{
						id: 'late-tip',
						displayName: 'Late tip',
						categoryId: 'charts',
						minExtensionVersion: '0.0.0',
						compatible: true,
						unseen: true,
					},
				],
			},
		});
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).toContain('2 of 3');
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-next"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'late-tip', markSeen: true });

		await sendSnapshot(viewer, {
			...unreadSnapshot,
			selectedCategoryId: 'charts',
			selectedTutorialId: 'late-tip',
			catalog: {
				...unreadSnapshot.catalog,
				content: [
					...unreadSnapshot.catalog.content.map(tutorial => ({ ...tutorial, unseen: false })),
					{
						id: 'late-tip',
						displayName: 'Late tip',
						categoryId: 'charts',
						minExtensionVersion: '0.0.0',
						compatible: true,
						unseen: false,
					},
				],
			},
		});
		expect(viewer.shadowRoot!.textContent).toContain('Late tip');
		expect(viewer.shadowRoot!.textContent).toContain('3 of 3');

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-mode-standard"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const categorySelect = viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-select"]') as HTMLElement & { selectedId: string };
		expect(categorySelect.selectedId).toBe('all');
		expect(viewer.shadowRoot!.textContent).toContain('Agent start');
		expect(viewer.shadowRoot!.textContent).toContain('Agent next');
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).toContain('Late tip');
		expect(viewer.shadowRoot!.querySelector('.standard-nav')!.textContent).toContain('4 of 4');
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-mode-compact"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		expect(viewer.shadowRoot!.textContent).toContain('Nothing to show right now');
		expect(viewer.shadowRoot!.querySelector('.compact-content .empty')!.textContent).toBe("There is nothing new to show you. In compact mode only content that you have not seen before is displayed. If you want to see everything, please use 'Browse all'");
		expect(viewer.shadowRoot!.querySelector('.compact-content .compact-empty-message')).toBeTruthy();
		expect(viewer.shadowRoot!.textContent).not.toContain('0 of 0');
		expect(viewer.shadowRoot!.querySelector('.compact-nav')).toBeNull();
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-show-seen-toggle"]')).toBeNull();
		const emptyFooterButtons = Array.from(viewer.shadowRoot!.querySelectorAll<HTMLButtonElement>('.compact-footer button')).map(button => button.dataset.testid);
		expect(emptyFooterButtons.slice(-2)).toEqual(['tutorial-mode-standard', 'tutorial-compact-got-it']);
	});

	it('applies recently muted and unmuted categories to compact navigation on next or previous', async () => {
		const base = snapshot();
		const multiCategorySnapshot: TutorialViewerSnapshot = {
			...base,
			preferredMode: 'compact',
			selectedCategoryId: 'agent',
			catalog: {
				...base.catalog,
				categories: [
					{ id: 'agent', title: 'Agent workflow', sortOrder: 1 },
					{ id: 'charts', title: 'Charts', sortOrder: 2 },
				],
				content: [
					{ ...base.catalog.content[0], unseen: true },
					{ ...base.catalog.content[1], unseen: true },
					{
						id: 'chart-start',
						displayName: 'Chart start',
						categoryId: 'charts',
						minExtensionVersion: '0.0.0',
						compatible: true,
						unseen: true,
					},
				],
			},
			preferences: [
				{ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 2 },
				{ categoryId: 'charts', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 1 },
			],
		};
		const viewer = createViewer();
		await sendSnapshot(viewer, multiCategorySnapshot);
		expect(viewer.shadowRoot!.textContent).toContain('Agent start');
		expect(viewer.shadowRoot!.textContent).toContain('1 of 3');

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-categories"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const agentMute = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]') as HTMLButtonElement;
		agentMute.click();
		expect(postedMessages).toContainEqual({ type: 'setCategoryMuted', categoryId: 'agent', muted: true });
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeTruthy();
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'chart-start' });
		expect(postedMessages).not.toContainEqual({ type: 'openTutorial', tutorialId: 'chart-start', markSeen: true });
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).toContain('1 of 1');

		const mutedAgent = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]') as HTMLButtonElement;
		expect(mutedAgent.getAttribute('aria-checked')).toBe('true');
		mutedAgent.click();
		expect(postedMessages).toContainEqual({ type: 'setCategoryMuted', categoryId: 'agent', muted: false });
		await settle(viewer);
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
		expect(viewer.shadowRoot!.textContent).toContain('1 of 3');

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-next"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-start', markSeen: true });
	});

	it('offers compact navigation, browse, and mute menu controls', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer, snapshot({
			preferredMode: 'compact',
			preferences: [{ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 1 }],
		}));
		const footer = viewer.shadowRoot!.querySelector('.compact-footer')!;
		expect(footer.querySelector('[data-testid="tutorial-compact-channel"]')).toBeNull();
		expect(footer.querySelector('[data-testid="tutorial-prev"]')).toBeTruthy();
		expect(footer.querySelector('[data-testid="tutorial-next"]')).toBeTruthy();
		expect(footer.querySelector('[data-testid="tutorial-compact-show-seen-toggle"]')).toBeNull();
		expect(footer.querySelector('[data-testid="tutorial-compact-mute"]')).toBeTruthy();
		expect(footer.querySelector('[data-testid="tutorial-mode-standard"]')).toBeTruthy();
		expect(footer.querySelector('[data-testid="tutorial-compact-got-it"]')).toBeTruthy();

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const daily = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-cadence-daily"]') as HTMLButtonElement;
		const weekly = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-cadence-weekly"]') as HTMLButtonElement;
		const monthly = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-cadence-monthly"]') as HTMLButtonElement;
		expect(daily.textContent).toContain('Notify max once a day');
		expect(daily.getAttribute('aria-checked')).toBe('true');
		expect(weekly.textContent).toContain('Notify max once a week');
		expect(weekly.getAttribute('aria-checked')).toBe('false');
		expect(monthly.textContent).toContain('Notify max once a month');
		expect(monthly.getAttribute('aria-checked')).toBe('false');
		weekly.click();
		expect(postedMessages).toContainEqual({ type: 'setNotificationCadence', categoryId: 'agent', notificationCadence: 'weekly' });

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const popup = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-popup-channel"]') as HTMLButtonElement;
		const notification = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-notification-channel"]') as HTMLButtonElement;
		expect(popup.textContent).toContain('Pop up this dialog');
		expect(popup.getAttribute('aria-checked')).toBe('true');
		expect(notification.textContent).toContain('Pop up VS Code notification');
		expect(notification.getAttribute('aria-checked')).toBe('false');
		expect(viewer.shadowRoot!.querySelector('.mute-menu-divider')).toBeTruthy();
		notification.click();
		expect(postedMessages).toContainEqual({ type: 'setNotificationChannel', categoryId: 'agent', channel: 'vscodeNotification' });

		await sendSnapshot(viewer, snapshot({
			preferredMode: 'compact',
			preferences: [{ categoryId: 'agent', subscribed: true, channel: 'vscodeNotification', notificationCadence: 'weekly', unseenCount: 1 }],
		}));
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-popup-channel"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-notification-channel"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
		const muteCategories = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-categories"]') as HTMLButtonElement;
		expect(muteCategories.textContent).toContain('Mute');
		expect(muteCategories.getAttribute('aria-haspopup')).toBe('menu');
		muteCategories.click();
		await viewer.updateComplete;
		const muteCategory = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]') as HTMLButtonElement;
		expect(muteCategory.textContent).toContain('Agent workflow');
		expect(muteCategory.getAttribute('aria-checked')).toBe('false');
		muteCategory.click();
		expect(postedMessages).toContainEqual({ type: 'setCategoryMuted', categoryId: 'agent', muted: true });
		await viewer.updateComplete;
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeTruthy();
		const mutedCategory = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]') as HTMLButtonElement;
		expect(mutedCategory.textContent).toContain('Agent workflow');
		expect(mutedCategory.getAttribute('aria-checked')).toBe('true');
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-popup-channel"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-notification-channel"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
		mutedCategory.click();
		expect(postedMessages).toContainEqual({ type: 'setCategoryMuted', categoryId: 'agent', muted: false });
		await viewer.updateComplete;
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('false');
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;

		await sendSnapshot(viewer, snapshot({
			preferredMode: 'compact',
			preferences: [{ categoryId: 'agent', subscribed: false, channel: 'off', notificationCadence: 'weekly', muted: true, unseenCount: 1 }],
		}));
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const muteAll = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-all"]') as HTMLButtonElement;
		expect(muteAll.textContent).toContain('(turn this feature off)');
		muteAll.click();
		expect(postedMessages).toContainEqual({ type: 'setTutorialsEnabled', enabled: false, dismissAfterUpdate: true });

		await sendSnapshot(viewer, snapshot({
			preferredMode: 'compact',
			tutorialsEnabled: false,
			preferences: [{ categoryId: 'agent', subscribed: false, channel: 'off', notificationCadence: 'weekly', muted: true, unseenCount: 1 }],
		}));
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const unmuteAll = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-unmute-all"]') as HTMLButtonElement;
		const enabledMenuItems = Array.from(viewer.shadowRoot!.querySelectorAll<HTMLButtonElement>('.mute-menu button')).filter(button => !button.disabled);
		expect(enabledMenuItems.map(button => button.dataset.testid)).toEqual(['tutorial-compact-unmute-all']);
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-cadence-daily"]') as HTMLButtonElement).disabled).toBe(true);
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-categories"]') as HTMLButtonElement).disabled).toBe(true);
		const disabledPopup = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-popup-channel"]') as HTMLButtonElement;
		const disabledNotification = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-notification-channel"]') as HTMLButtonElement;
		expect(disabledPopup.disabled).toBe(true);
		expect(disabledPopup.getAttribute('aria-checked')).toBe('true');
		expect(disabledNotification.disabled).toBe(true);
		expect(disabledNotification.getAttribute('aria-checked')).toBe('false');
		expect(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-agent"]')).toBeNull();
		expect(unmuteAll.textContent).toContain('Unmute everything');
		expect(unmuteAll.textContent).toContain('(turn this feature on)');
		unmuteAll.click();
		expect(postedMessages).toContainEqual({ type: 'setTutorialsEnabled', enabled: true });

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-dismiss"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'dismiss' });
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-got-it"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'dismiss' });
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-mode-standard"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'setPreferredMode', mode: 'standard' });
		await viewer.updateComplete;
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-got-it"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'dismiss' });
	});

	it('dismisses the mute menu on outside click, Escape, and mouse leave', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer, snapshot({
			preferredMode: 'compact',
			preferences: [{ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 1 }],
		}));
		const muteButton = () => viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute"]') as HTMLButtonElement;

		muteButton().click();
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeTruthy();
		window.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, composed: true }));
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeNull();

		muteButton().click();
		await settle(viewer);
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-categories"]') as HTMLButtonElement).click();
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-flyout')).toBeTruthy();
		window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, composed: true, cancelable: true }));
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeNull();
		expect(viewer.shadowRoot!.querySelector('.mute-flyout')).toBeNull();

		muteButton().click();
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeTruthy();
		(viewer.shadowRoot!.querySelector('.mute-wrap') as HTMLElement).dispatchEvent(new MouseEvent('mouseleave', { bubbles: false, composed: true }));
		await new Promise(resolve => setTimeout(resolve, 280));
		await settle(viewer);
		expect(viewer.shadowRoot!.querySelector('.mute-menu')).toBeNull();
	});

	it('searches tutorial display names', async () => {
		const viewer = createViewer();
		await sendSnapshot(viewer);
		const search = viewer.shadowRoot!.querySelector('kw-search-bar') as HTMLElement & { matchCount: number; currentMatch: number; mode: string };
		search.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'agent' } }));
		await settle(viewer);
		expect(search.matchCount).toBe(2);
		expect(search.currentMatch).toBe(0);
		expect(viewer.shadowRoot!.querySelectorAll('.search-hit')).toHaveLength(2);
		expect(viewer.shadowRoot!.querySelectorAll('.search-hit.current')).toHaveLength(1);

		search.dispatchEvent(new CustomEvent('search-next'));
		await settle(viewer);
		expect(search.currentMatch).toBe(1);
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next' });
		expect(postedMessages).not.toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next', markSeen: true });

		search.dispatchEvent(new CustomEvent('search-prev'));
		await settle(viewer);
		expect(search.currentMatch).toBe(0);

		search.dispatchEvent(new CustomEvent('search-mode-change', { detail: { mode: 'regex' } }));
		await settle(viewer);
		expect(search.mode).toBe('regex');
		search.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'Agent (start|next)' } }));
		await settle(viewer);
		expect(search.matchCount).toBe(2);

		search.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'missing' } }));
		await settle(viewer);
		expect(viewer.shadowRoot!.textContent).toContain('No content matches');
	});

	it('searches tutorial content text in standard mode', async () => {
		const base = snapshot();
		const viewer = createViewer();
		await sendSnapshot(viewer, {
			...base,
			catalog: {
				...base.catalog,
				content: [
					{ ...base.catalog.content[0], contentText: 'Power BI export packages reports for sharing.' },
					{ ...base.catalog.content[1], contentText: 'Transformation sections can work over cached rows without running the source query again.' },
				],
			},
		});
		const search = viewer.shadowRoot!.querySelector('kw-search-bar') as HTMLElement & { matchCount: number; currentMatch: number };

		search.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'transformation cached' } }));
		await settle(viewer);

		expect(search.matchCount).toBe(2);
		expect(search.currentMatch).toBe(0);
		expect(viewer.shadowRoot!.textContent).toContain('Agent next');
		expect(viewer.shadowRoot!.textContent).not.toContain('Agent start');
		expect(viewer.shadowRoot!.querySelector('.item-summary')!.textContent).toContain('cached rows');
		expect(viewer.shadowRoot!.querySelectorAll('.search-hit')).toHaveLength(2);
		expect(postedMessages).toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next' });
		expect(postedMessages).not.toContainEqual({ type: 'openTutorial', tutorialId: 'agent-next', markSeen: true });

		search.dispatchEvent(new CustomEvent('search-input', { detail: { query: 'next cached' } }));
		await settle(viewer);
		expect(search.matchCount).toBe(2);
		expect(viewer.shadowRoot!.textContent).toContain('Agent next');
		expect(viewer.shadowRoot!.textContent).not.toContain('Agent start');
		expect(viewer.shadowRoot!.querySelectorAll('.search-hit')).toHaveLength(2);
	});

	it('uses the Browse all category dropdown and shared mute menu values', async () => {
		const viewer = createViewer();
		const base = snapshot();
		await sendSnapshot(viewer, {
			...base,
			catalog: {
				...base.catalog,
				categories: [
					{ id: 'agent', title: 'Agent workflow', sortOrder: 1 },
					{ id: 'charts', title: 'Charts', sortOrder: 2 },
				],
				content: [
					...base.catalog.content.map(tutorial => tutorial.id === 'agent-next' ? { ...tutorial, unseen: false } : tutorial),
					{
						id: 'chart-start',
						displayName: 'Chart start',
						categoryId: 'charts',
						minExtensionVersion: '0.0.0',
						compatible: true,
						unseen: true,
					},
				],
			},
			preferences: [
				{ categoryId: 'agent', subscribed: true, channel: 'nextFileOpenPopup', notificationCadence: 'daily', unseenCount: 1 },
				{ categoryId: 'charts', subscribed: true, channel: 'vscodeNotification', notificationCadence: 'weekly', unseenCount: 1 },
			],
		});

		const categorySelect = viewer.shadowRoot!.querySelector('[data-testid="tutorial-category-select"]') as HTMLElement & { selectedId: string };
		expect(categorySelect.selectedId).toBe('all');
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).toContain('Agent next');
		const showSeen = viewer.shadowRoot!.querySelector('[data-testid="tutorial-show-seen-toggle"] input') as HTMLInputElement;
		showSeen.checked = false;
		showSeen.dispatchEvent(new Event('change', { bubbles: true }));
		await settle(viewer);
		expect(viewer.shadowRoot!.textContent).not.toContain('Agent next');
		expect(viewer.shadowRoot!.querySelector('.standard-nav')!.textContent).toContain('1 of 2');
		showSeen.checked = true;
		showSeen.dispatchEvent(new Event('change', { bubbles: true }));
		await settle(viewer);
		expect(viewer.shadowRoot!.textContent).toContain('Agent next');
		categorySelect.dispatchEvent(new CustomEvent('dropdown-select', { detail: { id: 'charts' }, bubbles: true, composed: true }));
		await viewer.updateComplete;
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).not.toContain('Agent start');

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-categories"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		const chartMute = viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-charts"]') as HTMLButtonElement;
		chartMute.click();
		expect(postedMessages).toContainEqual({ type: 'setCategoryMuted', categoryId: 'charts', muted: true });
		await settle(viewer);
		expect(viewer.shadowRoot!.textContent).not.toContain('Chart start');
		expect(viewer.shadowRoot!.textContent).toContain('Based on the current settings, there is no content to show at the moment.');
		expect(viewer.shadowRoot!.querySelector('.standard-nav')!.textContent).toContain('0 of 0');
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-mute-category-charts"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'setCategoryMuted', categoryId: 'charts', muted: false });
		await settle(viewer);
		expect(viewer.shadowRoot!.textContent).toContain('Chart start');
		expect(viewer.shadowRoot!.querySelector('.standard-nav')!.textContent).toContain('1 of 1');

		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-cadence-weekly"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
		expect((viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-notification-channel"]') as HTMLButtonElement).getAttribute('aria-checked')).toBe('true');
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-cadence-monthly"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'setNotificationCadence', categoryId: 'charts', notificationCadence: 'monthly' });

		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-standard-mute"]') as HTMLButtonElement).click();
		await viewer.updateComplete;
		(viewer.shadowRoot!.querySelector('[data-testid="tutorial-compact-popup-channel"]') as HTMLButtonElement).click();
		expect(postedMessages).toContainEqual({ type: 'setNotificationChannel', categoryId: 'charts', channel: 'nextFileOpenPopup' });
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
