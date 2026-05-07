import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { html, nothing, render } from 'lit';
import type { KwCachedValues } from '../../../src/webview/viewers/cached-values/kw-cached-values.js';

const overlayMocks = vi.hoisted(() => {
	const instances: any[] = [];
	const OverlayScrollbars = vi.fn((targetOrOptions: HTMLElement | { target: HTMLElement }, options: unknown) => {
		const host = targetOrOptions instanceof HTMLElement ? targetOrOptions : targetOrOptions.target;
		const viewport = document.createElement('div');
		const instance: any = {
			host,
			options,
			viewport,
			destroyed: false,
			update: vi.fn(),
			destroy: vi.fn(() => { instance.destroyed = true; }),
			elements: vi.fn(() => ({ viewport })),
		};
		instances.push(instance);
		return instance;
	}) as any;

	return { OverlayScrollbars, instances };
});

vi.mock('overlayscrollbars', () => ({
	OverlayScrollbars: overlayMocks.OverlayScrollbars,
}));

import '../../../src/webview/viewers/cached-values/kw-cached-values.js';

let container: HTMLDivElement;
let postedMessages: unknown[];
let acquireVsCodeApiMock: ReturnType<typeof vi.fn>;

function installVsCodeMock(): void {
	const api = {
		postMessage(msg: unknown) { postedMessages.push(msg); },
		getState() { return undefined; },
		setState() { /* no-op */ },
	};
	acquireVsCodeApiMock = vi.fn(() => api);
	(globalThis as any).acquireVsCodeApi = acquireVsCodeApiMock;
}

function createElement(): KwCachedValues {
	render(html`<kw-cached-values></kw-cached-values>`, container);
	return container.querySelector('kw-cached-values')!;
}

function snapshot() {
	return {
		timestamp: Date.now(),
		activeKind: 'kusto',
		auth: { sessions: [], knownAccounts: [], clusterAccountMap: {} },
		connections: [{ id: 'c1', name: 'Cluster', clusterUrl: 'https://cluster.kusto.windows.net' }],
		cachedDatabases: {
			'cluster.kusto.windows.net': Array.from({ length: 40 }, (_, index) => `db${index + 1}`),
		},
		sqlAuth: { sessions: [] },
		sqlConnections: [],
		sqlCachedDatabases: {},
		sqlServerAccountMap: {},
		cachedSchemaKeys: [],
	};
}

beforeEach(() => {
	postedMessages = [];
	overlayMocks.instances.length = 0;
	overlayMocks.OverlayScrollbars.mockClear();
	installVsCodeMock();
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	delete (globalThis as any).acquireVsCodeApi;
	delete (globalThis as any).vscode;
});

describe('kw-cached-values scrollbars', () => {
	it('renders page content as a normal full-width block', async () => {
		const el = createElement();
		await el.updateComplete;

		const viewerContent = el.shadowRoot!.querySelector('.viewerContent') as HTMLElement | null;
		expect(viewerContent).not.toBeNull();
		expect(el.shadowRoot!.querySelector('.viewerScroll')).toBeNull();
		expect(overlayMocks.instances.length).toBe(0);
	});

	it('reuses the same VS Code API when the element is reconnected by page scrollbar setup', async () => {
		const el = createElement();
		await el.updateComplete;

		const wrapper = document.createElement('div');
		container.appendChild(wrapper);
		wrapper.appendChild(el);
		await el.updateComplete;

		expect(acquireVsCodeApiMock).toHaveBeenCalledTimes(1);
	});

	it('initializes overlay scrollbars for database panes after the snapshot renders', async () => {
		const el = createElement();
		await el.updateComplete;

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot() } }));
		await el.updateComplete;

		const panes = Array.from(el.shadowRoot!.querySelectorAll<HTMLElement>('.scrollPane[data-overlay-scroll="x:hidden"]'));
		expect(panes.length).toBeGreaterThanOrEqual(2);
		for (const pane of panes) {
			expect(overlayMocks.instances.some(instance => instance.host === pane)).toBe(true);
		}
	});

	it('keeps wheel events inside scrollable cached-value sections', async () => {
		const el = createElement();
		await el.updateComplete;

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: {
			...snapshot(),
			auth: {
				sessions: [{ account: { id: 'account-1', label: 'Account 1' }, scopes: [], effectiveToken: 'token' }],
				knownAccounts: [{ id: 'account-1', label: 'Account 1' }],
				clusterAccountMap: Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`https://cluster${index}.kusto.windows.net`, 'account-1'])),
			},
		} } }));
		await el.updateComplete;

		const section = el.shadowRoot!.querySelector('section:nth-of-type(2)') as HTMLElement;
		const select = section.querySelector('select') as HTMLSelectElement;
		Object.defineProperty(section, 'clientHeight', { configurable: true, value: 100 });
		Object.defineProperty(section, 'scrollHeight', { configurable: true, value: 300 });
		const documentWheel = vi.fn();
		document.addEventListener('wheel', documentWheel);

		try {
			select.dispatchEvent(new WheelEvent('wheel', { bubbles: true, composed: true, deltaY: 40 }));
			expect(documentWheel).not.toHaveBeenCalled();
		} finally {
			document.removeEventListener('wheel', documentWheel);
		}
	});
});