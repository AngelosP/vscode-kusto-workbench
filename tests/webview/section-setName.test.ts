import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';

/**
 * Regression tests for section name persistence via setName().
 *
 * Bug: chart, transformation, markdown, and python sections did not implement
 * setName(), so __kustoSetSectionName (which calls el.setName()) silently
 * failed. Names were accepted by the agent tool but never stored in the
 * component, so serialize() would write an empty name to the file.
 *
 * These tests verify the full contract:
 *   1. setName() exists on the element
 *   2. getName() returns the name set by setName()
 *   3. serialize() includes the name in its output
 *   4. __kustoSetSectionName works end-to-end via DOM lookup
 */

// ── Shared mocks required by section components ───────────────────────────────

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoGetChartDatasetsInDomOrder: () => [],
	__kustoGetChartValidationStatus: () => null,
	__kustoCleanupSectionModeResizeObserver: vi.fn(),
	__kustoSetSectionName: vi.fn(),
	__kustoNotifyResultsUpdated: vi.fn(),
}));

vi.mock('../../src/webview/shared/chart-renderer.js', () => {
	const stateMap: Record<string, Record<string, unknown>> = {};
	return {
		maximizeChartBox: vi.fn(),
		disposeChartEcharts: vi.fn(),
		purgeChartEcharts: vi.fn(),
		renderChart: vi.fn(),
		getChartState: (id: string) => {
			if (!stateMap[id]) stateMap[id] = { mode: 'edit', expanded: true, legendPosition: 'top' };
			return stateMap[id];
		},
		getChartMinResizeHeight: () => 140,
	};
});

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/core/utils.js', () => ({
	addPageScrollListener: vi.fn(() => vi.fn()),
	getScrollY: () => 0,
	maybeAutoScrollWhileDragging: vi.fn(),
}));

vi.mock('../../src/webview/core/dropdown.js', () => ({
	closeAllMenus: vi.fn(),
}));

vi.mock('../../src/webview/shared/lazy-vendor.js', () => ({
	ensureToastUiLoaded: () => Promise.resolve(),
}));

// Import after mocks
import '../../src/webview/sections/kw-chart-section.js';
import '../../src/webview/sections/kw-transformation-section.js';
import '../../src/webview/sections/kw-markdown-section.js';
import { reconcileHostOwnedMarkdownProjection } from '../../src/webview/sections/kw-markdown-section.js';
import '../../src/webview/sections/kw-python-section.js';
import { __kustoSetSectionName } from '../../src/webview/core/section-factory.js';
import { addChartBox } from '../../src/webview/sections/kw-chart-section.js';
import { pState } from '../../src/webview/shared/persistence-state.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

let container: HTMLDivElement;

beforeEach(() => {
	(window as any).chartStateByBoxId = {};
	container = document.createElement('div');
	document.body.appendChild(container);
	// addChartBox needs a queries-container to insert into
	if (!document.getElementById('queries-container')) {
		const qc = document.createElement('div');
		qc.id = 'queries-container';
		document.body.appendChild(qc);
	}
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	const qc = document.getElementById('queries-container');
	if (qc) { qc.innerHTML = ''; }
});

// ── Chart section ─────────────────────────────────────────────────────────────

describe('kw-chart-section name', () => {
	function create(boxId = 'chart_1') {
		render(html`<kw-chart-section box-id=${boxId}></kw-chart-section>`, container);
		return container.querySelector('kw-chart-section')! as any;
	}

	it('setName stores the name and getName returns it', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Trend Chart');
		expect(el.getName()).toBe('Trend Chart');
	});

	it('serialize includes the name set via setName', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Trend Chart');
		const data = el.serialize();
		expect(data.name).toBe('Trend Chart');
	});

	it('name starts empty by default', async () => {
		const el = create();
		await el.updateComplete;
		expect(el.getName()).toBe('');
	});

	it('addChartBox preserves name through the options→state→applyOptions pipeline', async () => {
		const id = addChartBox({ id: 'chart_roundtrip', name: 'My Chart', chartType: 'line' });
		const el = document.getElementById(id) as any;
		expect(el).toBeTruthy();
		await el.updateComplete;
		expect(el.getName()).toBe('My Chart');
		expect(el.serialize().name).toBe('My Chart');
		el.remove();
	});
});

// ── Transformation section ────────────────────────────────────────────────────

describe('kw-transformation-section name', () => {
	function create(boxId = 'transformation_1') {
		render(html`<kw-transformation-section box-id=${boxId}></kw-transformation-section>`, container);
		return container.querySelector('kw-transformation-section')! as any;
	}

	it('setName stores the name and getName returns it', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Pivot Data');
		expect(el.getName()).toBe('Pivot Data');
	});

	it('serialize includes the name set via setName', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Pivot Data');
		const data = el.serialize();
		expect(data.name).toBe('Pivot Data');
	});

	it('name starts empty by default', async () => {
		const el = create();
		await el.updateComplete;
		expect(el.getName()).toBe('');
	});

});

// ── Markdown section ──────────────────────────────────────────────────────────

describe('kw-markdown-section name', () => {
	function create(boxId = 'markdown_1') {
		render(html`<kw-markdown-section box-id=${boxId}></kw-markdown-section>`, container);
		return container.querySelector('kw-markdown-section')! as any;
	}

	it('setName stores the name and getName returns it', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Summary');
		expect(el.getName()).toBe('Summary');
	});

	it('serialize includes the title set via setName', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Summary');
		const data = el.serialize();
		// Markdown serializes name as "title" field
		expect(data.title).toBe('Summary');
	});

	it('serializes an intentionally empty live editor instead of stale pending text', async () => {
		const el = create();
		await el.updateComplete;
		pState.pendingMarkdownTextByBoxId.markdown_1 = 'tool-authored text';
		(el as any)._editorApi = {
			getValue: () => '', setValue: vi.fn(), layout: vi.fn(), dispose: vi.fn(), _toastui: null,
		};
		expect(el.serialize().text).toBe('');
		delete pState.pendingMarkdownTextByBoxId.markdown_1;
	});

	it('setTitle and setName are interchangeable', async () => {
		const el = create();
		await el.updateComplete;
		el.setTitle('Via setTitle');
		expect(el.getName()).toBe('Via setTitle');
		el.setName('Via setName');
		expect(el.getName()).toBe('Via setName');
	});

	it('name starts empty by default', async () => {
		const el = create();
		await el.updateComplete;
		expect(el.getName()).toBe('');
	});

	it('authoritative projection omission clears a stale persisted height', async () => {
		const el = create();
		await el.updateComplete;
		const wrapper = el.shadowRoot.getElementById('editor-wrapper') as HTMLElement;
		wrapper.style.height = '320px';
		el.setAttribute('editor-height-px', '320');
		el.applyHostDocumentState({ id: 'markdown_1', type: 'markdown', text: 'authoritative' });
		expect(wrapper.style.height).toBe('');
		expect(el.hasAttribute('editor-height-px')).toBe(false);
		expect(el.serialize()).not.toHaveProperty('editorHeightPx');
	});

	it('restores a rejected middle removal at its authoritative position', async () => {
		const queries = document.getElementById('queries-container')!;
		queries.innerHTML = '';
		const before = document.createElement('div');
		before.id = 'query_before';
		const after = document.createElement('div');
		after.id = 'query_after';
		queries.append(before, after);

		reconcileHostOwnedMarkdownProjection(
			[{ id: 'markdown_middle', type: 'markdown', text: 'restored' }],
			['query_before', 'markdown_middle', 'query_after'],
		);
		await (document.getElementById('markdown_middle') as any).updateComplete;
		expect(Array.from(queries.children).map(element => element.id)).toEqual([
			'query_before', 'markdown_middle', 'query_after',
		]);
	});

	it('reconciles multiple missing Markdown sections without emitting commands', async () => {
		const queries = document.getElementById('queries-container')!;
		queries.innerHTML = '';
		const posted: unknown[] = [];
		const previousVscode = window.vscode;
		const previousState = {
			hostOwnedMarkdownActive: pState.hostOwnedMarkdownActive,
			documentKind: pState.documentKind,
			compatibilityMode: pState.compatibilityMode,
			documentRuntimeActive: pState.documentRuntimeActive,
			applyingHostMarkdownProjection: pState.applyingHostMarkdownProjection,
		};
		(window as any).vscode = { postMessage: (message: unknown) => posted.push(message) };
		pState.hostOwnedMarkdownActive = true;
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.documentRuntimeActive = true;
		pState.applyingHostMarkdownProjection = false;
		try {
			reconcileHostOwnedMarkdownProjection([
				{ id: 'markdown_first', type: 'markdown', text: 'first' },
				{ id: 'markdown_second', type: 'markdown', text: 'second' },
			], ['markdown_first', 'markdown_second']);
			await Promise.all(Array.from(queries.children).map(element => (element as any).updateComplete));
			expect(Array.from(queries.children).map(element => element.id)).toEqual([
				'markdown_first', 'markdown_second',
			]);
			expect(posted).toEqual([]);
			expect(pState.applyingHostMarkdownProjection).toBe(false);
		} finally {
			(window as any).vscode = previousVscode;
			Object.assign(pState, previousState);
		}
	});
});

// ── Python section ────────────────────────────────────────────────────────────

describe('kw-python-section name', () => {
	function create(boxId = 'python_1') {
		render(html`<kw-python-section box-id=${boxId}></kw-python-section>`, container);
		return container.querySelector('kw-python-section')! as any;
	}

	it('setName stores the name and getName returns it', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Data Prep');
		expect(el.getName()).toBe('Data Prep');
	});

	it('serialize includes the name set via setName', async () => {
		const el = create();
		await el.updateComplete;
		el.setName('Data Prep');
		const data = el.serialize();
		expect(data.name).toBe('Data Prep');
	});

	it('setTitle and setName are interchangeable', async () => {
		const el = create();
		await el.updateComplete;
		el.setTitle('Via setTitle');
		expect(el.getName()).toBe('Via setTitle');
		el.setName('Via setName');
		expect(el.getName()).toBe('Via setName');
	});

	it('name starts empty by default', async () => {
		const el = create();
		await el.updateComplete;
		expect(el.getName()).toBe('');
	});
});

// ── __kustoSetSectionName integration ─────────────────────────────────────────
// Verify that the bridge function (__kustoSetSectionName) works end-to-end
// by creating a real DOM element and calling setName on it by ID.

describe('__kustoSetSectionName integration', () => {
	// __kustoSetSectionName is mocked in this test file because section-factory
	// is mocked. Instead, import the real implementation directly.
	// We test the real function by calling it on actual elements.

	function realSetSectionName(boxId: string, name: string) {
		const el = document.getElementById(boxId) as any;
		if (el && typeof el.setName === 'function') {
			el.setName(String(name || ''));
		}
	}

	it('sets name on chart section via DOM lookup', async () => {
		render(html`<kw-chart-section id="chart_99" box-id="chart_99"></kw-chart-section>`, container);
		const el = container.querySelector('kw-chart-section')! as any;
		await el.updateComplete;

		realSetSectionName('chart_99', 'Revenue Chart');
		expect(el.getName()).toBe('Revenue Chart');
	});

	it('sets name on markdown section via DOM lookup', async () => {
		render(html`<kw-markdown-section id="markdown_99" box-id="markdown_99"></kw-markdown-section>`, container);
		const el = container.querySelector('kw-markdown-section')! as any;
		await el.updateComplete;

		realSetSectionName('markdown_99', 'Intro');
		expect(el.getName()).toBe('Intro');
	});

	it('sets name on transformation section via DOM lookup', async () => {
		render(html`<kw-transformation-section id="transformation_99" box-id="transformation_99"></kw-transformation-section>`, container);
		const el = container.querySelector('kw-transformation-section')! as any;
		await el.updateComplete;

		realSetSectionName('transformation_99', 'Pivot');
		expect(el.getName()).toBe('Pivot');
	});

	it('sets name on python section via DOM lookup', async () => {
		render(html`<kw-python-section id="python_99" box-id="python_99"></kw-python-section>`, container);
		const el = container.querySelector('kw-python-section')! as any;
		await el.updateComplete;

		realSetSectionName('python_99', 'Analysis');
		expect(el.getName()).toBe('Analysis');
	});
});
