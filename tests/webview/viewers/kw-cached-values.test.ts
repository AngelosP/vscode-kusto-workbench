import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { html, nothing, render } from 'lit';
import { groupSqlDatabasesByConnection, type KwCachedValues } from '../../../src/webview/viewers/cached-values/kw-cached-values.js';

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

function snapshot(accountPartition = 'partition-a', revision = 1) {
	return {
		revision,
		timestamp: Date.now(),
		activeKind: 'kusto',
		auth: { sessions: [], knownAccounts: [], clusterAccountMap: {} },
		connections: [{
			id: 'c1',
			name: 'Cluster',
			clusterUrl: 'https://cluster.kusto.windows.net',
			accountPreference: { mode: 'automatic' },
			accountPartition,
			hasTokenOverride: false,
		}],
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
	it('ignores a SQL snapshot delivered after a newer revision', async () => {
		const el = createElement() as KwCachedValues & Record<string, any>;
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'snapshot', snapshot: { ...snapshot('partition-a', 2), sqlLeaveNoTrace: ['sql1'], sqlCachedDatabases: {} },
		} }));
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'snapshot', snapshot: { ...snapshot('partition-a', 1), sqlLeaveNoTrace: [], sqlCachedDatabases: { sql1: ['StaleDb'] } },
		} }));
		await el.updateComplete;

		expect(el._snapshot.sqlLeaveNoTrace).toEqual(['sql1']);
		expect(el._snapshot.sqlCachedDatabases).toEqual({});
	});

	it('closes affected SQL schema requests and object viewers when the principal changes', async () => {
		const el = createElement() as KwCachedValues & Record<string, any>;
		await el.updateComplete;
		const hide = vi.fn();
		Object.defineProperty(el, '_objectViewer', { configurable: true, value: { hide } });
		el._sqlSchemaRequestOwner = { requestId: 'schema-1', connectionId: 'sql1' };
		el._schemaRequestInFlight = true;
		el._sqlSchemaRefreshDb = 'Db';
		el._sqlObjectViewerConnectionId = 'sql1';

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'sqlPrincipalChanged', connectionIds: ['sql1'] } }));

		expect(el._sqlSchemaRequestOwner).toBeUndefined();
		expect(el._schemaRequestInFlight).toBe(false);
		expect(el._sqlSchemaRefreshDb).toBe('');
		expect(el._sqlObjectViewerConnectionId).toBe('');
		expect(hide).toHaveBeenCalledOnce();
	});

	it('closes affected SQL object state when the saved target changes', async () => {
		const el = createElement() as KwCachedValues & Record<string, any>;
		await el.updateComplete;
		const hide = vi.fn();
		Object.defineProperty(el, '_objectViewer', { configurable: true, value: { hide } });
		el._sqlSchemaRequestOwner = { requestId: 'schema-1', connectionId: 'sql1' };
		el._sqlObjectViewerConnectionId = 'sql1';

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'sqlOwnerChanged', connectionIds: ['sql1'] } }));

		expect(el._sqlSchemaRequestOwner).toBeUndefined();
		expect(el._sqlObjectViewerConnectionId).toBe('');
		expect(hide).toHaveBeenCalledOnce();
	});
	it('keeps duplicate SQL server endpoints partitioned by connection owner', () => {
		const grouped = groupSqlDatabasesByConnection({
			'connection-a': ['DbA'],
			'connection-b': ['DbB'],
		}, [
			{ id: 'connection-a', name: 'Admin', serverUrl: 'shared.example' },
			{ id: 'connection-b', name: 'Reporting', serverUrl: 'shared.example' },
		]);

		expect(grouped.connectionOrder).toEqual(['connection-a', 'connection-b']);
		expect(grouped.byConnection['connection-a'].databases).toEqual(['DbA']);
		expect(grouped.byConnection['connection-b'].databases).toEqual(['DbB']);
	});
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

	it('drops a late Kusto schema response after the connection identity changes', async () => {
		const el = createElement();
		await el.updateComplete;
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot('partition-a', 10) } }));
		await el.updateComplete;

		(el as any)._viewSchema('c1', 'db1');
		const request = postedMessages.find((message: any) => message?.type === 'schema.get') as any;
		expect(request).toEqual(expect.objectContaining({ connectionId: 'c1', database: 'db1', requestId: expect.any(String) }));

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot('partition-b', 11) } }));
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'schemaResult', requestId: request.requestId, connectionId: 'c1', accountPartition: 'partition-a', database: 'db1', ok: true,
			json: JSON.stringify({ schema: { tables: ['SecretA'] } }),
		} }));
		await el.updateComplete;
		await Promise.resolve();

		expect((el as any)._schemaRequestInFlight).toBe(false);
		expect((el as any)._objectViewerOwner).toBeUndefined();
		expect((el as any)._objectViewer?.open).not.toBe(true);
	});
});