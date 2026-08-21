import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KwDataTable } from '../../src/webview/components/kw-data-table.js';
import '../../src/webview/components/kw-object-viewer.js';
import '../../src/webview/components/kw-unique-values-dialog.js';

const overlayMocks = vi.hoisted(() => {
	const instances: any[] = [];

	function setClientSize(el: HTMLElement, width: number, height: number): void {
		Object.defineProperty(el, 'clientWidth', { configurable: true, value: width });
		Object.defineProperty(el, 'clientHeight', { configurable: true, value: height });
	}

	const OverlayScrollbars = vi.fn((host: HTMLElement) => {
		const viewport = document.createElement('div');
		viewport.className = 'os-viewport';
		setClientSize(viewport, 320, 180);
		const instance: any = {
			host,
			viewport,
			destroyed: false,
			destroy: vi.fn(() => { instance.destroyed = true; }),
			update: vi.fn(),
			elements: vi.fn(() => ({ viewport })),
		};
		instances.push(instance);
		return instance;
	}) as any;
	OverlayScrollbars.valid = vi.fn((instance: any) => !!instance && !instance.destroyed);

	return { OverlayScrollbars, instances };
});

const virtualMocks = vi.hoisted(() => {
	const instances: MockVirtualizer[] = [];
	const elementScroll = vi.fn();
	const observeElementRect = vi.fn();
	const observeElementOffset = vi.fn();

	function buildItems(count: number, size: number) {
		const visibleCount = Math.min(Math.max(count, 0), 3);
		return Array.from({ length: visibleCount }, (_, index) => ({
			index,
			start: index * size,
			size,
		}));
	}

	class MockVirtualizer {
		options: any;
		items: Array<{ index: number; start: number; size: number }>;
		totalSize: number;
		cleanup = vi.fn();
		setOptions = vi.fn((options: any) => {
			this.options = options;
			const estimate = Number(options.estimateSize?.() ?? 0);
			const count = Number(options.count ?? 0);
			this.items = buildItems(count, estimate);
			this.totalSize = count * estimate;
		});
		measure = vi.fn();
		scrollToIndex = vi.fn();
		getVirtualItems = vi.fn(() => this.items);
		getTotalSize = vi.fn(() => this.totalSize);
		_didMount = vi.fn(() => this.cleanup);
		_willUpdate = vi.fn();

		constructor(options: any) {
			this.options = options;
			const estimate = Number(options.estimateSize?.() ?? 0);
			const count = Number(options.count ?? 0);
			this.items = buildItems(count, estimate);
			this.totalSize = count * estimate;
			instances.push(this);
		}
	}

	return { MockVirtualizer, elementScroll, observeElementRect, observeElementOffset, instances };
});

vi.mock('overlayscrollbars', () => ({
	OverlayScrollbars: overlayMocks.OverlayScrollbars,
}));

vi.mock('@tanstack/virtual-core', () => ({
	Virtualizer: virtualMocks.MockVirtualizer,
	elementScroll: virtualMocks.elementScroll,
	observeElementRect: virtualMocks.observeElementRect,
	observeElementOffset: virtualMocks.observeElementOffset,
}));

import '../../src/webview/components/kw-data-table.js';

class MockResizeObserver {
	observe = vi.fn();
	disconnect = vi.fn();
}

let originalResizeObserver: typeof ResizeObserver | undefined;
let rafCallbacks: Map<number, FrameRequestCallback>;
let rafId: number;

function flushRaf(): void {
	const entries = Array.from(rafCallbacks.entries());
	rafCallbacks.clear();
	for (const [id, callback] of entries) {
		callback(id);
	}
}

async function settleTable(table: KwDataTable): Promise<void> {
	await table.updateComplete;
	flushRaf();
	await table.updateComplete;
}

function renderedCellText(table: KwDataTable): string[] {
	return Array.from(table.shadowRoot?.querySelectorAll('#dt-body tbody tr td:not(.rn)') ?? [])
		.map(cell => cell.textContent?.trim() ?? '');
}

beforeEach(() => {
	overlayMocks.instances.length = 0;
	overlayMocks.OverlayScrollbars.mockClear();
	overlayMocks.OverlayScrollbars.valid.mockClear();
	virtualMocks.instances.length = 0;
	virtualMocks.elementScroll.mockClear();
	virtualMocks.observeElementRect.mockClear();
	virtualMocks.observeElementOffset.mockClear();
	originalResizeObserver = globalThis.ResizeObserver;
	(globalThis as any).ResizeObserver = MockResizeObserver;
	rafCallbacks = new Map();
	rafId = 0;
	vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback: FrameRequestCallback) => {
		const id = ++rafId;
		rafCallbacks.set(id, callback);
		return id;
	});
	vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id: number) => {
		rafCallbacks.delete(id);
	});
});

afterEach(() => {
	document.body.replaceChildren();
	if (originalResizeObserver) {
		globalThis.ResizeObserver = originalResizeObserver;
	} else {
		delete (globalThis as any).ResizeObserver;
	}
	vi.restoreAllMocks();
});

describe('kw-data-table visibility lifecycle', () => {
	it('hides and restores the Save button through showSave', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		table.options = { showSave: false };
		document.body.appendChild(table);
		await settleTable(table);
		expect(table.shadowRoot?.querySelector('[title="Save results to file"]')).toBeNull();

		table.options = { showSave: true };
		await table.updateComplete;
		expect(table.shadowRoot?.querySelector('[title="Save results to file"]')).toBeTruthy();
	});

	it('offers complex previews only when the exact View-link predicate is present', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Marked', type: 'dynamic' }, { name: 'Unmarked', type: 'dynamic' }];
		table.rows = [[
			{ display: '[object]', full: '{"marked":true}', isObject: true },
			{ display: '{...}', full: '{"unmarked":true}' },
		]];
		document.body.appendChild(table);
		await settleTable(table);

		const toggle = table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]');
		expect(toggle).toBeTruthy();
		expect(toggle?.querySelector('svg[data-icon="preview-pane"] rect')).toBeTruthy();
		expect(toggle?.querySelector('circle')).toBeNull();
		const toolbar = table.shadowRoot?.querySelector('.tb') as Element;
		expect(getComputedStyle(toolbar).justifyContent).toBe('flex-start');
		expect(getComputedStyle(toolbar.firstElementChild as Element).marginLeft).toBe('auto');
		expect(toggle?.getAttribute('aria-pressed')).toBe('false');
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-controls"]')).toBeNull();
		expect(table.shadowRoot?.querySelectorAll('.obj-link')).toHaveLength(1);
		expect(table.shadowRoot?.querySelectorAll('[data-testid="complex-value-preview"]')).toHaveLength(0);
		expect(renderedCellText(table)).toEqual(['View', '{...}']);
	});

	it('does not read complete complex values while previews remain off', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		let fullReads = 0;
		const cell = { display: '[object]', isObject: true } as Record<string, unknown>;
		Object.defineProperty(cell, 'full', {
			enumerable: true,
			get: () => {
				fullReads++;
				return '{"hidden":"until-enabled"}';
			},
		});
		table.columns = [{ name: 'Details', type: 'dynamic' }];
		table.rows = [[cell as any]];
		document.body.appendChild(table);
		await settleTable(table);

		fullReads = 0;
		table.requestUpdate();
		await settleTable(table);
		expect(fullReads).toBe(0);
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		expect(fullReads).toBeGreaterThan(0);
	});

	it('does not offer previews for JSON-looking or typed cells without View links', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'JsonText', type: 'json' }, { name: 'DynamicText', type: 'dynamic' }];
		table.rows = [['{"plain":true}', { display: '{...}', full: '{"wrapped":true}' }]];
		document.body.appendChild(table);
		await settleTable(table);

		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-toggle"]')).toBeNull();
		expect(table.shadowRoot?.querySelector('.obj-link')).toBeNull();
		expect(table.shadowRoot?.querySelector('[data-testid="complex-value-preview"]')).toBeNull();
	});

	it('configures a preview beside View while the viewer retains the complete value', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		const full = '{"requestId":"R-1001","secret":"beyond-preview"}';
		table.columns = [{ name: 'Details', type: 'dynamic' }];
		table.rows = [[{ display: '[object]', full, isObject: true }]];
		document.body.appendChild(table);
		await settleTable(table);

		const toggle = table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')!;
		toggle.click();
		await settleTable(table);
		expect(toggle.getAttribute('aria-pressed')).toBe('true');
		const controls = table.shadowRoot?.querySelector('[data-testid="complex-preview-controls"]') as Element;
		expect(getComputedStyle(controls).backgroundColor).toBe('transparent');
		expect(getComputedStyle(controls).paddingLeft).toBe('50px');
		expect(getComputedStyle(controls).paddingRight).toBe('50px');
		expect(controls.querySelector('.complex-preview-label')).toBeNull();
		expect(controls.textContent?.trim()).toBe('Max characters');
		const close = table.shadowRoot?.querySelector('[data-testid="complex-preview-close"]') as Element;
		expect(getComputedStyle(close).marginLeft).toBe('auto');
		const input = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;
		expect(input.value).toBe('75');

		input.value = '5';
		input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
		await settleTable(table);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-value-preview"]')?.textContent).toBe(full);

		table.shadowRoot?.querySelector<HTMLAnchorElement>('.obj-link')?.click();
		const viewer = table.shadowRoot?.querySelector('kw-object-viewer') as any;
		expect(viewer?.open).toBe(true);
		expect(viewer?.jsonText).toBe(full);
	});

	it('uses the configurable value to expand the existing complex-column cap', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Details', type: 'dynamic' }];
		table.rows = [[{ display: '[object]', full: `{"payload":"${'x'.repeat(1000)}"}`, isObject: true }]];
		document.body.appendChild(table);
		await settleTable(table);
		const widthBefore = (table as any)._columnWidths[0];

		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		const defaultComplexWidth = (table as any)._columnWidths[0];
		expect(defaultComplexWidth).toBe(577);
		expect((table as any)._columnWidths[0]).toBeGreaterThan(widthBefore);
		(table as any)._vScrollCtrl.viewportW = 1000;
		expect((table as any)._layoutColumns().widths[0]).toBe(defaultComplexWidth);
		const input = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;
		input.value = '150';
		input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		await settleTable(table);
		expect(input.value).toBe('150');
		expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 150 });
		expect((table as any)._columnWidths[0]).toBeGreaterThan(defaultComplexWidth);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-value-preview"]')?.textContent)
			.toBe(`{"payload":"${'x'.repeat(1000)}"}`);

		input.value = '25';
		input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		await settleTable(table);
		expect((table as any)._columnWidths[0]).toBeLessThan(defaultComplexWidth);
		expect(table.captureComplexPreviewState()).toEqual({ enabled: true, maxCharacters: 25 });

		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-close"]')?.click();
		await settleTable(table);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-controls"]')).toBeNull();
		expect(table.captureComplexPreviewState()).toEqual({ enabled: false, maxCharacters: 25 });
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		expect(table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')?.value).toBe('25');
	});

	it('caps plain and header content inside a genuinely expanded mixed column', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: `Mixed_${'h'.repeat(200)}` }];
		table.rows = [
			[{ display: '[object]', full: `{"complex":"${'x'.repeat(1000)}"}`, isObject: true }],
			['p'.repeat(1000)],
		];
		document.body.appendChild(table);
		await settleTable(table);
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		const input = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;
		input.value = '150';
		input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		await settleTable(table);

		expect((table as any)._columnWidths[0]).toBe(1102);
		expect(table.shadowRoot?.querySelector('.cell-text')?.textContent).toBe('p'.repeat(1000));
		expect(table.shadowRoot?.querySelector('.th-label')?.textContent).toBe(`Mixed_${'h'.repeat(200)}`);
		expect(getComputedStyle(table.shadowRoot?.querySelector('.cell-text') as Element).maxWidth).toBe('520px');
		expect(getComputedStyle(table.shadowRoot?.querySelector('.th-label') as Element).maxWidth).toBe('520px');

		input.value = '25';
		input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		await settleTable(table);
		expect((table as any)._columnWidths[0]).toBe(227);
	});

	it('recomputes widths once when a character-cap edit is committed', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Details' }];
		table.rows = [[{ display: '[object]', full: `{"payload":"${'x'.repeat(1000)}"}`, isObject: true }]];
		document.body.appendChild(table);
		await settleTable(table);
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		const internal = table as any;
		const recompute = vi.spyOn(internal, '_recomputeColumnWidths');
		const input = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;

		input.value = '150';
		input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
		expect(recompute).not.toHaveBeenCalled();
		input.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		input.dispatchEvent(new FocusEvent('blur', { bubbles: true, composed: true }));

		expect(recompute).toHaveBeenCalledTimes(1);
	});

	it('keeps search, copy, and CSV on their existing values while preview is enabled', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Details', type: 'dynamic' }];
		table.rows = [[{
			display: '[object]', full: '{"prefix":"shown","secret":"search-beyond-preview"}', isObject: true,
		}]];
		document.body.appendChild(table);
		await settleTable(table);
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		const input = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;
		input.value = '5';
		input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
		await settleTable(table);

		const internal = table as any;
		internal._searchCtrl.query = 'search-beyond-preview';
		internal._searchCtrl._execSearch();
		expect(internal._searchCtrl.matches).toEqual([{ row: 0, col: 0 }]);

		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
		try {
			internal._selectionCtrl.setSelectedCell({ row: 0, col: 0 });
			internal._selectionCtrl.copy();
			expect(writeText).toHaveBeenCalledWith('[object]');
		} finally {
			if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
			else delete (navigator as any).clipboard;
		}

		let saved: any;
		table.addEventListener('save', event => { saved = (event as CustomEvent).detail; });
		internal._save();
		expect(saved.csv).toBe('Details\n[object]');
	});

	it('highlights search matches inside enabled complex previews without changing their full text', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		const first = '{"flag":false,"name":"first"}';
		const second = '{"flag":false,"name":"second"}';
		table.columns = [{ name: 'Details', type: 'dynamic' }];
		table.rows = [
			[{ display: '[object]', full: first, isObject: true }],
			[{ display: '[object]', full: second, isObject: true }],
		];
		document.body.appendChild(table);
		await settleTable(table);
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);

		const search = (table as any)._searchCtrl;
		search.query = 'false';
		search._execSearch();
		await settleTable(table);

		const previews = Array.from(table.shadowRoot?.querySelectorAll<HTMLElement>('[data-testid="complex-value-preview"]') ?? []);
		expect(previews.map(preview => preview.textContent)).toEqual([first, second]);
		expect(previews[0].querySelector('mark.hl-cur')?.textContent).toBe('false');
		expect(previews[1].querySelector('mark.hl')?.textContent).toBe('false');

		search.nextMatch();
		await settleTable(table);
		expect(previews[0].querySelector('mark.hl')?.textContent).toBe('false');
		expect(previews[1].querySelector('mark.hl-cur')?.textContent).toBe('false');
	});

	it('retains preview state across hide/show and temporary loss of View cells', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Details', type: 'dynamic' }];
		table.rows = [[{ display: '[object]', full: '{"marked":"first"}', isObject: true }]];
		document.body.appendChild(table);
		await settleTable(table);
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		const input = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;
		input.value = '7';
		input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
		await settleTable(table);

		table.setBodyVisible(false);
		await table.updateComplete;
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-controls"]')).toBeNull();
		table.setBodyVisible(true);
		await settleTable(table);
		expect(table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')?.value).toBe('7');

		table.rows = [['{"unmarked":true}']];
		await settleTable(table);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-toggle"]')).toBeNull();
		table.rows = [[{ display: '[object]', full: '{"marked":"again"}', isObject: true }]];
		await settleTable(table);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-toggle"]')?.getAttribute('aria-pressed')).toBe('true');
		expect(table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')?.value).toBe('7');
	});

	it('revokes governed copy selection and closes its object viewer', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Value' }];
		table.rows = [[{ full: `{"secret":"${'x'.repeat(1000)}"}`, display: 'object', isObject: true } as any]];
		table.resultArtifactGoverned = true;
		table.resultArtifactSourceBoxId = 'query_copy';
		table.resultArtifactId = 'result:query_copy:1';
		table.resultArtifactTableToken = 'token-1';
		table.resultArtifactLiveCheck = () => true;
		document.body.appendChild(table);
		await settleTable(table);
		const internal = table as any;
		table.shadowRoot?.querySelector<HTMLButtonElement>('[data-testid="complex-preview-toggle"]')?.click();
		await settleTable(table);
		const capInput = table.shadowRoot?.querySelector<HTMLInputElement>('[data-testid="complex-preview-length"]')!;
		capInput.value = '150';
		capInput.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
		await settleTable(table);
		expect(internal._columnWidths[0]).toBe(1102);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-value-preview"]')).toBeTruthy();
		internal._selectionCtrl.setSelectedCell({ row: 0, col: 0 });
		internal._openObjectViewer(0, 0);
		const viewer = table.shadowRoot?.querySelector('kw-object-viewer') as any;
		expect(viewer?.open).toBe(true);

		const computeColumnWidths = vi.spyOn(internal, '_computeColumnWidths');
		table.revokeResultArtifactGeneration();
		await table.updateComplete;

		expect(computeColumnWidths).not.toHaveBeenCalled();
		expect(table.canCopyRows()).toBe(false);
		expect(internal._selectionCtrl.selectedCell).toBeNull();
		expect(viewer?.open).toBe(false);
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-controls"]')).toBeNull();
		expect(table.shadowRoot?.querySelector('[data-testid="complex-value-preview"]')).toBeNull();
		expect(table.shadowRoot?.querySelector('[data-testid="complex-preview-toggle"]')?.getAttribute('aria-pressed')).toBe('false');
		expect(internal._columnWidths[0]).toBeLessThanOrEqual(520);
	});

	it('keeps local copy available for a live governed table without Save', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Secret' }];
		table.rows = [['local-copy']];
		table.options = { showSave: false };
		table.resultArtifactGoverned = true;
		table.resultArtifactId = 'result:query_copy:1';
		table.resultArtifactTableToken = 'token-1';
		table.resultArtifactLiveCheck = () => true;
		document.body.appendChild(table);
		await settleTable(table);
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
		try {
			expect(table.shadowRoot?.querySelector('[title="Save results to file"]')).toBeNull();
			expect(table.canCopyRows()).toBe(true);
			(table as any)._selectionCtrl.setSelectedCell({ row: 0, col: 0 });
			(table as any)._selectionCtrl.copy();
			expect(writeText).toHaveBeenCalledWith('local-copy');
		} finally {
			if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
			else delete (navigator as any).clipboard;
		}
	});

	it('denies a stale object-viewer copy handler after generation revocation', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Value' }];
		table.rows = [[{ full: '{"secret":1}', display: 'object', isObject: true } as any]];
		table.resultArtifactGoverned = true;
		table.resultArtifactId = 'result:query_copy:1';
		table.resultArtifactTableToken = 'token-1';
		table.resultArtifactLiveCheck = () => true;
		document.body.appendChild(table);
		await settleTable(table);
		(table as any)._openObjectViewer(0, 0);
		const viewer = table.shadowRoot?.querySelector('kw-object-viewer') as any;
		const copyCallback = vi.fn();
		viewer.copyCallback = copyCallback;
		await viewer.updateComplete;
		const staleCopyButton = viewer.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Copy value to clipboard"]');
		expect(staleCopyButton).toBeTruthy();

		table.revokeResultArtifactGeneration();
		staleCopyButton?.click();

		expect(copyCallback).not.toHaveBeenCalled();
	});

	it('purges an open Unique Values dialog and denies its stale Copy handler on revocation', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Secret' }];
		table.rows = [['classified'], ['classified']];
		table.resultArtifactGoverned = true;
		table.resultArtifactId = 'result:query_copy:1';
		table.resultArtifactTableToken = 'token-1';
		table.resultArtifactLiveCheck = () => true;
		document.body.appendChild(table);
		await settleTable(table);
		(table as any)._openUniqueValues(0, 'unique-values');
		await table.updateComplete;
		const dialog = table.shadowRoot?.querySelector('kw-unique-values-dialog') as any;
		await dialog.updateComplete;
		const nestedTable = dialog.shadowRoot?.querySelector('kw-data-table') as any;
		await nestedTable.updateComplete;
		const copyButton = nestedTable.shadowRoot?.querySelector<HTMLButtonElement>('[title="Copy (Ctrl+C)"]');
		expect(copyButton).toBeTruthy();
		const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
		const writeText = vi.fn(() => Promise.resolve());
		Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
		try {
			(nestedTable as any)._selectionCtrl.setSelectedCell({ row: 0, col: 0 });
			table.revokeResultArtifactGeneration();
			copyButton?.click();

			expect(dialog.rows).toEqual([]);
			expect(dialog.columns).toEqual([]);
			expect(nestedTable.rows).toEqual([]);
			expect(nestedTable.columns).toEqual([]);
			expect(writeText).not.toHaveBeenCalled();
		} finally {
			if (clipboardDescriptor) Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
			else delete (navigator as any).clipboard;
		}
	});

	it('does not reopen Unique Values after generation revocation', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Secret' }];
		table.rows = [['classified']];
		table.resultArtifactGoverned = true;
		table.resultArtifactId = 'result:query_copy:1';
		table.resultArtifactTableToken = 'token-1';
		table.resultArtifactLiveCheck = () => true;
		document.body.appendChild(table);
		await settleTable(table);

		table.revokeResultArtifactGeneration();
		(table as any)._openUniqueValues(0, 'unique-values');
		await table.updateComplete;

		expect((table as any)._uniqueValuesOpen).toBe(false);
		expect(table.shadowRoot?.querySelector('kw-unique-values-dialog')).toBeNull();
		expect(table.canCopyRows()).toBe(false);
	});

	it('clears active selection when results are hidden', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Value' }];
		table.rows = [['visible']];
		document.body.appendChild(table);
		await settleTable(table);
		const internal = table as any;
		internal._selectionCtrl.setSelectedCell({ row: 0, col: 0 });

		table.setBodyVisible(false);

		expect(internal._selectionCtrl.selectedCell).toBeNull();
		expect(internal._selectionCtrl.selectionRange).toBeNull();
	});

	it('renders sort-dialog row order and the Clear Sort control', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }, { name: 'Score', type: 'long' }];
		table.rows = [['alpha', 1], ['bravo', 3], ['charlie', 2]];
		document.body.appendChild(table);
		await settleTable(table);

		(table as any)._onSortChange(new CustomEvent('sort-change', {
			detail: { sorting: [{ id: '1', desc: true }] },
		}));
		await settleTable(table);

		expect(renderedCellText(table)).toEqual(['bravo', '3', 'charlie', '2', 'alpha', '1']);
		expect(table.shadowRoot?.querySelector('[title="Clear sort"]')).toBeTruthy();
	});

	it('renders declared type glyphs beside labels without changing column behavior', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [
			{ name: 'Name', type: 'string' },
			{ name: 'Untyped' },
			{ name: 'Unknown', type: 'unknown' },
		];
		table.rows = [['bravo', 2, 'b'], ['alpha', 1, 'a']];
		document.body.appendChild(table);
		await settleTable(table);

		const glyphs = table.shadowRoot?.querySelectorAll<HTMLElement>('[data-testid="column-type-glyph"]');
		expect(glyphs).toHaveLength(1);
		const glyph = glyphs?.[0];
		expect(glyph?.textContent).toBe('s');
		expect(glyph?.title).toBe('Data type: string');
		expect(glyph?.getAttribute('role')).toBe('img');
		expect(glyph?.getAttribute('aria-label')).toBe('Data type: string');
		expect(Array.from(glyph?.parentElement?.children ?? []).map(element => element.className)).toEqual([
			'th-label', 'type-glyph',
		]);
		expect(table.shadowRoot?.querySelector('[aria-label="Column menu for Name"]')).toBeTruthy();

		glyph?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
		await settleTable(table);

		expect((table as any)._sorting).toEqual([{ id: '0', desc: false }]);
		expect(renderedCellText(table).slice(0, 3)).toEqual(['alpha', '1', 'a']);
		const sortedParts = Array.from(table.shadowRoot?.querySelector('th[data-column-index="0"] .thn')?.children ?? [])
			.map(element => element.className);
		expect(sortedParts).toEqual(['th-label', 'type-glyph', 'si2']);
	});

	it('recomputes glyphs and reserves only their fixed header width after column reassignment', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		const name = 'ModeratelyLongColumnName';
		table.columns = [{ name, type: 'string' }, { name }];
		table.rows = [];
		document.body.appendChild(table);
		await settleTable(table);

		const widths = (table as any)._columnWidths as number[];
		expect(widths[0] - widths[1]).toBe(14);
		expect(table.shadowRoot?.querySelector('[title="Data type: string"]')?.textContent).toBe('s');

		table.columns = [{ name, type: 'datetime' }, { name }];
		await settleTable(table);

		expect(table.shadowRoot?.querySelector('[title="Data type: datetime"]')?.textContent).toBe('d');
		expect(table.shadowRoot?.querySelector('[title="Data type: string"]')).toBeNull();
	});

	it('retains the datatype indicator cache across row-only updates', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Value', type: 'long' }];
		table.rows = [[1]];
		document.body.appendChild(table);
		await settleTable(table);
		const indicators = (table as any)._columnTypeIndicators;

		table.rows = [[2], [3]];
		await settleTable(table);

		expect((table as any)._columnTypeIndicators).toBe(indicators);
		expect(table.shadowRoot?.querySelector('[title="Data type: long"]')?.textContent).toBe('l');
	});

	it('keeps the glyph before sort and filter indicators', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Value', type: 'long' }];
		table.rows = [[2], [1]];
		document.body.appendChild(table);
		await settleTable(table);
		(table as any)._sorting = [{ id: '0', desc: false }];
		(table as any)._setColumnFilters([{ id: '0', value: { kind: 'values', allowedValues: ['1'] } }]);
		(table as any)._table.setOptions((previous: any) => ({
			...previous,
			state: { ...previous.state, sorting: (table as any)._sorting },
		}));
		table.requestUpdate();
		await table.updateComplete;

		const header = table.shadowRoot?.querySelector('th[data-column-index="0"]');
		expect(Array.from(header?.querySelector('.thn')?.children ?? []).map(element => element.className)).toEqual([
			'th-label', 'type-glyph', 'si2', 'filtered-link',
		]);
		expect(header?.querySelector('.cm-btn')).toBeTruthy();
	});

	it('preserves every column menu action and label in order', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Value', type: 'long' }, { name: 'Category', type: 'string' }];
		table.rows = [[2, 'b'], [1, 'a']];
		document.body.appendChild(table);
		await settleTable(table);
		(table as any)._sorting = [{ id: '0', desc: false }];
		(table as any)._table.setOptions((previous: any) => ({
			...previous,
			state: { ...previous.state, sorting: (table as any)._sorting },
		}));
		(table as any)._openColumnMenuAt(0, 100, 100);
		await table.updateComplete;

		const actions = Array.from(table.shadowRoot?.querySelectorAll<HTMLElement>('.cmi') ?? [])
			.map(item => [item.dataset.action, item.textContent?.trim()]);
		expect(actions).toEqual([
			['sort-ascending', 'Sort ascending'],
			['sort-descending', 'Sort descending'],
			['remove-sort', 'Remove sort'],
			['filter', 'Filter...'],
			['copy-column', 'Copy column values'],
			['unique-values', 'Show unique values'],
			['unique-count', 'Unique count by column'],
		]);
	});

	it('shows a type glyph only for the synthetic count in compact Unique Values tables', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Category', type: 'string' }];
		table.rows = [['a'], ['a'], ['b']];
		document.body.appendChild(table);
		await settleTable(table);
		(table as any)._openUniqueValues(0, 'unique-values');
		await table.updateComplete;

		const dialog = table.shadowRoot?.querySelector('kw-unique-values-dialog') as any;
		await dialog.updateComplete;
		const nestedTable = dialog.shadowRoot?.querySelector('kw-data-table') as KwDataTable;
		await settleTable(nestedTable);

		const nestedGlyphs = nestedTable.shadowRoot?.querySelectorAll<HTMLElement>('[data-testid="column-type-glyph"]');
		expect(nestedTable.options.compact).toBe(true);
		expect(nestedGlyphs).toHaveLength(1);
		expect(nestedGlyphs?.[0].textContent).toBe('l');
		expect(nestedGlyphs?.[0].closest('th')?.getAttribute('data-column-index')).toBe('1');
	});

	it('cancels deferred column-menu listeners when disconnected', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		document.body.appendChild(table);
		await settleTable(table);
		const addListener = vi.spyOn(document, 'addEventListener');

		(table as any)._openColumnMenuAt(0, 100, 100);
		table.remove();
		addListener.mockClear();
		flushRaf();

		expect(addListener).not.toHaveBeenCalledWith('mousedown', expect.any(Function));
		expect((table as any)._columnMenuListenerRaf).toBe(0);
	});

	it('focuses and restores the Sort toolbar button around its dialog', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		document.body.appendChild(table);
		await settleTable(table);
		const button = table.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Sort"]')!;

		button.click();
		await table.updateComplete;
		const dialog = table.shadowRoot?.querySelector('kw-sort-dialog') as any;
		await dialog.updateComplete;
		expect(dialog.shadowRoot?.querySelector('[role="dialog"]')).toBeTruthy();
		expect(dialog.shadowRoot?.activeElement).toBe(dialog.shadowRoot?.querySelector('[data-testid="sort-add-column"]'));

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await table.updateComplete;
		expect(table.shadowRoot?.activeElement).toBe(button);
	});

	it('focuses and restores a column menu button around its Filter dialog', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha'], ['bravo']];
		document.body.appendChild(table);
		await settleTable(table);
		const button = table.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Column menu for Name"]')!;

		(table as any)._openFilterDialog(0);
		await table.updateComplete;
		const dialog = table.shadowRoot?.querySelector('kw-filter-dialog') as any;
		await dialog.updateComplete;
		await Promise.resolve();
		expect(dialog.shadowRoot?.querySelector('[role="dialog"]')).toBeTruthy();
		expect(dialog.shadowRoot?.activeElement).toBe(dialog.shadowRoot?.querySelector('[data-testid="filter-values-search"]'));

		document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
		await table.updateComplete;
		expect(table.shadowRoot?.activeElement).toBe(button);
	});

	it('restores Sort focus when page scrolling dismisses the dialog', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		document.body.appendChild(table);
		await settleTable(table);
		const button = table.shadowRoot?.querySelector<HTMLButtonElement>('button[title="Sort"]')!;
		const focus = vi.spyOn(button, 'focus');
		button.click();
		await table.updateComplete;

		(table as any)._onDocumentScrollDismiss();
		await table.updateComplete;

		expect(table.shadowRoot?.querySelector('kw-sort-dialog')).toBeNull();
		expect(table.shadowRoot?.activeElement).toBe(button);
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it('restores column-menu focus when page scrolling dismisses Filter', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		document.body.appendChild(table);
		await settleTable(table);
		const button = table.shadowRoot?.querySelector<HTMLButtonElement>('button[aria-label="Column menu for Name"]')!;
		const focus = vi.spyOn(button, 'focus');
		(table as any)._openFilterDialog(0);
		await table.updateComplete;

		(table as any)._onDocumentScrollDismiss();
		await table.updateComplete;

		expect(table.shadowRoot?.querySelector('kw-filter-dialog')).toBeNull();
		expect(table.shadowRoot?.activeElement).toBe(button);
		expect((table as any)._filterDialogReturnFocus).toBeNull();
		expect(focus).toHaveBeenCalledWith({ preventScroll: true });
	});

	it('removes the column-menu document listener when page scrolling dismisses it', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		document.body.appendChild(table);
		await settleTable(table);
		(table as any)._openColumnMenuAt(0, 100, 100);
		flushRaf();
		const removeListener = vi.spyOn(document, 'removeEventListener');

		(table as any)._onDocumentScrollDismiss();

		expect((table as any)._columnMenuOpen).toBeNull();
		expect(removeListener).toHaveBeenCalledWith('mousedown', expect.any(Function));
	});

	it('exports the current filtered and sorted row projection', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }, { name: 'Score', type: 'long' }];
		table.rows = [['alpha', 1], ['bravo', 3], ['charlie', 2]];
		document.body.appendChild(table);
		await settleTable(table);

		const internal = table as any;
		internal._sorting = [{ id: '1', desc: true }];
		internal._columnFilters = [{
			id: '0', value: { kind: 'values', allowedValues: ['bravo', 'charlie'] },
		}];
		internal._table.setOptions((previous: any) => ({
			...previous,
			state: {
				...previous.state,
				sorting: internal._sorting,
				columnFilters: internal._columnFilters,
			},
		}));
		let saved: any;
		table.addEventListener('save', event => { saved = (event as CustomEvent).detail; });

		internal._save();

		expect(saved).toEqual({
			csv: 'Name,Score\nbravo,3\ncharlie,2',
			suggestedFileName: 'results.csv',
		});
	});

	it('exports only declared columns from ragged rows', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Visible' }, { name: 'Missing' }];
		table.rows = [['shown', 'value', 'hidden-secret'], ['short']];
		document.body.appendChild(table);
		await settleTable(table);
		let saved: any;
		table.addEventListener('save', event => { saved = (event as CustomEvent).detail; });

		(table as any)._save();

		expect(saved.csv).toBe('Visible,Missing\nshown,value\nshort,');
		expect(saved.csv).not.toContain('hidden-secret');
	});

	it('rebinds OverlayScrollbars and redraws virtualized rows after hide/show', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha'], ['bravo'], ['charlie'], ['delta']];
		table.options = { showVisibilityToggle: true };
		document.body.appendChild(table);

		await settleTable(table);
		const firstVscroll = table.shadowRoot?.querySelector('.vscroll');
		expect(firstVscroll).toBeTruthy();
		expect(overlayMocks.instances).toHaveLength(1);
		expect(overlayMocks.instances[0].host).toBe(firstVscroll);
		expect(renderedCellText(table)).toEqual(['alpha', 'bravo', 'charlie']);

		table.setBodyVisible(false);
		await table.updateComplete;

		expect(table.shadowRoot?.querySelector('.vscroll')).toBeNull();
		expect(overlayMocks.instances[0].destroy).toHaveBeenCalledTimes(1);

		table.setBodyVisible(true);
		await settleTable(table);

		const secondVscroll = table.shadowRoot?.querySelector('.vscroll');
		expect(secondVscroll).toBeTruthy();
		expect(secondVscroll).not.toBe(firstVscroll);
		expect(overlayMocks.instances).toHaveLength(2);
		expect(overlayMocks.instances[1].host).toBe(secondVscroll);
		expect(virtualMocks.instances.at(-1)?.options.getScrollElement()).toBe(overlayMocks.instances[1].viewport);
		expect(renderedCellText(table)).toEqual(['alpha', 'bravo', 'charlie']);
	});

	it('emits visibility-toggle only for actual user-visible changes', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha']];
		table.options = { showVisibilityToggle: true };
		document.body.appendChild(table);

		await settleTable(table);
		const listener = vi.fn();
		table.addEventListener('visibility-toggle', listener);

		table.setBodyVisible(true);
		table.setBodyVisible(false, { emit: false });
		table.setBodyVisible(false);
		table.setBodyVisible(true);

		expect(listener).toHaveBeenCalledTimes(1);
		expect(listener.mock.calls[0][0].detail).toEqual({ visible: true });
	});

	it('shows metadata tooltip only when hovering the result summary text', async () => {
		const table = document.createElement('kw-data-table') as KwDataTable;
		table.columns = [{ name: 'Name' }];
		table.rows = [['alpha'], ['bravo']];
		table.options = {
			label: 'Results',
			showVisibilityToggle: true,
			metadata: { clientActivityId: 'KW.execute_query;123', serverStats: { serverRowCount: 2 } },
		};
		document.body.appendChild(table);

		await settleTable(table);

		const summary = table.shadowRoot?.querySelector('.hinfo-anchor') as HTMLElement | null;
		const visibilityButton = table.shadowRoot?.querySelector('.vis-toggle') as HTMLElement | null;
		expect(summary).toBeTruthy();
		expect(visibilityButton).toBeTruthy();

		vi.useFakeTimers();
		try {
			visibilityButton!.dispatchEvent(new MouseEvent('mouseenter'));
			vi.advanceTimersByTime(600);
			await table.updateComplete;
			expect(table.shadowRoot?.querySelector('.mt-popup')).toBeNull();

			summary!.dispatchEvent(new MouseEvent('mouseenter'));
			vi.advanceTimersByTime(500);
			await table.updateComplete;
			expect(table.shadowRoot?.querySelector('.mt-popup')).toBeTruthy();
		} finally {
			vi.useRealTimers();
		}
	});
});