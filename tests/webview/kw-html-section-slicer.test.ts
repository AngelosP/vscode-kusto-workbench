import { describe, it, expect } from 'vitest';
import { KwHtmlSection } from '../../src/webview/sections/kw-html-section';
import { setResultsState } from '../../src/webview/core/results-state';

type BridgeSection = KwHtmlSection & { _buildDataBridgeScript(): string };
type HeightSection = KwHtmlSection & {
	_mode: 'code' | 'preview';
	_userResizedPreview: boolean;
	_lastPreviewContentHeight: number;
	_lastPreviewFitHeight: number;
	_lastPreviewScrollHeight: number;
	_lastPreviewViewportHeight: number;
	_lastPreviewViewportBoundHeight: number;
	_savedPreviewHeightPx?: number;
	_captureCurrentHeight(): void;
	_updatePreview(): void;
	_applyPreviewFitHeight(contentH: number): void;
	_resetAutoPreviewHeightForFreshFit(): void;
	_measurePreviewHeight(): number | undefined;
	_getPowerBiMeasurementWidth(): number;
	_requestFreshPreviewHeight(): Promise<number | undefined>;
	_measureCurrentHtmlHeight(code: string): Promise<number | undefined>;
	_handleIframeMessage(e: MessageEvent): void;
	_collectDataSourcesForPBI(): Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
	_openPublishDialog(
		htmlCode: string,
		dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>,
		previewHeight: number | undefined,
		suggestedName: string,
	): void;
	_publishToPowerBI(): Promise<void>;
};

function makeProvenanceHtml(dimensions: object[]): string {
	return `<script type="application/kw-provenance">${JSON.stringify({
		version: 1,
		model: {
			fact: { sectionId: 'query_slicer_fact', sectionName: 'Fact Events' },
			dimensions,
		},
		bindings: {},
	})}</script><main>Dashboard content</main>`;
}

// ── _toDateStr — same logic as the inline slicer JS in kw-html-section.ts ────
// Extracts YYYY-MM-DD from any date-like string. This is used by the between-mode
// slicer to normalize cell values before comparing with <input type="date"> values.
function _toDateStr(val: unknown): string {
	const s = String(val || '');
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
	const d = new Date(s);
	if (isNaN(d.getTime())) return '';
	const y = d.getFullYear(), m = d.getMonth() + 1, dy = d.getDate();
	return y + '-' + (m < 10 ? '0' : '') + m + '-' + (dy < 10 ? '0' : '') + dy;
}

// ── Slicer filter logic (mirrors the inline applyFilters in _buildSlicerBlock) ─
function slicerBetweenFilter(
	cellValues: unknown[],
	minV: string,
	maxV: string,
): unknown[] {
	return cellValues.filter(cell => {
		const v = _toDateStr(cell);
		if (minV && v < minV) return false;
		if (maxV && v > maxV) return false;
		return true;
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('_toDateStr — slicer date normalization', () => {
	it('handles Date.toString() verbose format', () => {
		// This is the format stored in cell.full by formatCellValue
		const verbose = new Date('2024-06-15T12:00:00Z').toString();
		const result = _toDateStr(verbose);
		// Should produce YYYY-MM-DD in local time (same day as displayed by toString)
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// Verify it matches the local date from the same Date object
		const d = new Date('2024-06-15T12:00:00Z');
		const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		expect(result).toBe(expected);
	});

	it('handles ISO date strings (YYYY-MM-DDT...)', () => {
		expect(_toDateStr('2024-01-15T10:30:00Z')).toBe('2024-01-15');
		expect(_toDateStr('2024-12-31T23:59:59.999Z')).toBe('2024-12-31');
	});

	it('handles display format (YYYY-MM-DD HH:MM:SS)', () => {
		expect(_toDateStr('2024-01-15 10:30:00')).toBe('2024-01-15');
	});

	it('handles plain date (YYYY-MM-DD)', () => {
		expect(_toDateStr('2024-01-15')).toBe('2024-01-15');
	});

	it('returns empty string for non-date values', () => {
		expect(_toDateStr('not a date')).toBe('');
		expect(_toDateStr('')).toBe('');
		expect(_toDateStr(null)).toBe('');
		expect(_toDateStr(undefined)).toBe('');
	});
});

describe('slicer between filter — date range', () => {
	// Simulate real data: cell values are Date.toString() strings
	// (as they appear after getRawCellValue extracts cell.full)
	const jan15 = new Date('2024-01-15T00:00:00Z').toString();
	const feb10 = new Date('2024-02-10T00:00:00Z').toString();
	const mar20 = new Date('2024-03-20T00:00:00Z').toString();
	const cells = [jan15, feb10, mar20];

	it('filters by min date only', () => {
		const result = slicerBetweenFilter(cells, '2024-02-01', '');
		// Only feb10 and mar20 should pass (their local date is >= 2024-02-01)
		expect(result).toHaveLength(2);
		expect(result).toContain(feb10);
		expect(result).toContain(mar20);
	});

	it('filters by max date only', () => {
		const result = slicerBetweenFilter(cells, '', '2024-02-15');
		// Only jan15 and feb10 should pass
		expect(result).toHaveLength(2);
		expect(result).toContain(jan15);
		expect(result).toContain(feb10);
	});

	it('filters by both min and max', () => {
		const result = slicerBetweenFilter(cells, '2024-02-01', '2024-02-28');
		// Only feb10 should pass
		expect(result).toHaveLength(1);
		expect(result).toContain(feb10);
	});

	it('empty range returns all rows', () => {
		const result = slicerBetweenFilter(cells, '', '');
		expect(result).toHaveLength(3);
	});

	it('works with ISO string cell values', () => {
		const isoCells = ['2024-01-15T00:00:00Z', '2024-02-10T12:00:00Z', '2024-03-20T00:00:00Z'];
		const result = slicerBetweenFilter(isoCells, '2024-02-01', '2024-02-28');
		expect(result).toHaveLength(1);
		expect(result[0]).toBe('2024-02-10T12:00:00Z');
	});
});

describe('generated slicer layout', () => {
	it('escapes dashboard body padding without requiring source changes', () => {
		setResultsState('query_slicer_fact', {
			columns: [{ name: 'Client', type: 'string' }],
			rows: [['VS Code'], ['Visual Studio']],
		});

		const section = new KwHtmlSection();
		section.boxId = 'html_slicer_layout_test';
		section.setCode(makeProvenanceHtml([{ column: 'Client', label: 'Client' }]).replace(
			'<main>Dashboard content</main>',
			'<style>body { padding: 24px; }</style><main>Dashboard content</main>',
		));

		const bridgeHtml = (section as BridgeSection)._buildDataBridgeScript();
		const slicerTag = bridgeHtml.match(/<div id="kw-slicers"[^>]*>/)?.[0] || '';

		expect(bridgeHtml).toContain('<style id="kw-preview-slicer-reset">html,body{margin:0!important;}</style>');
		expect(bridgeHtml).toContain('function fitSlicerToPreviewEdges()');
		expect(bridgeHtml).toContain("slicerEl.style.marginTop=pt?('-'+pt+'px'):'0';");
		expect(bridgeHtml).toContain("slicerEl.style.width='calc(100% + '+(pl+pr)+'px)';");
		expect(slicerTag).toBeTruthy();
		expect(slicerTag).toContain('box-sizing:border-box');
		expect(slicerTag).toContain('margin-bottom:20px');
	});
});

describe('HTML preview height reporting', () => {
	it('uses iframe content height for export even when the visible preview wrapper is shorter', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section._lastPreviewContentHeight = 920;
		section._savedPreviewHeightPx = 620;

		expect(section._measurePreviewHeight()).toBe(920);
	});

	it('requests a fresh iframe height before export or publish uses the cached value', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const contentWindow = { postMessage: (_message: unknown, _targetOrigin: string) => undefined };
		let requestedMessage: unknown;
		contentWindow.postMessage = (message: unknown) => { requestedMessage = message; };

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-iframe'
					? { contentWindow }
					: null,
			},
		});

		const pending = section._requestFreshPreviewHeight();
		expect(requestedMessage).toEqual({ type: 'kw-html-request-height' });

		section._handleIframeMessage({
			data: { type: 'kw-html-preview-height', h: 955 },
			source: contentWindow,
		} as unknown as MessageEvent);

		await expect(pending).resolves.toBe(955);
		expect(section._measurePreviewHeight()).toBe(955);
	});

	it('opens the publish dialog with a fresh measurement of the current HTML code', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const currentHtml = '<main style="height:1234px">Current dashboard</main>';
		let measuredCode = '';
		let openedPreviewHeight: number | undefined;

		section.setCode(currentHtml);
		section._collectDataSourcesForPBI = () => [{
			name: 'Fact Events',
			sectionId: 'query_fact',
			clusterUrl: 'https://cluster.example',
			database: 'db',
			query: 'FactEvents',
			columns: [{ name: 'Day', type: 'datetime' }],
		}];
		section._measureCurrentHtmlHeight = async (code: string) => {
			measuredCode = code;
			return 1234;
		};
		section._openPublishDialog = (_htmlCode, _dataSources, previewHeight) => {
			openedPreviewHeight = previewHeight;
		};

		await section._publishToPowerBI();

		expect(measuredCode).toBe(currentHtml);
		expect(openedPreviewHeight).toBe(1234);
	});

	it('measures export height at the generated Power BI HTML visual width', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;

		expect(section._getPowerBiMeasurementWidth()).toBe(1450);
	});

	it('keeps robust body and rendered-element measurements in the injected iframe script', () => {
		const script = (KwHtmlSection as unknown as { _heightReportScript: string })._heightReportScript;

		expect(script).toContain('kw-preview-base-reset');
		expect(script).toContain(':where(html,body){margin:0;}');
		expect(script).toContain('body.scrollHeight');
		expect(script).toContain('rawScrollHeight()');
		expect(script).toContain('metrics:{viewportHeight:viewportHeight(),scrollHeight:rawScrollHeight(),viewportBoundHeight:viewportBoundHeight()}');
		expect(script).toContain('declaresViewportBlockSize(el)');
		expect(script).toContain('styleUsesViewportBlockSize');
		expect(script).toContain('primary>0?primary');
		expect(script).toContain('scrollOverflowHeight()');
		expect(script).toContain('maxElementBottom()');
		expect(script).toContain('fallbackElementBottom()');
		expect(script).toContain('primary||fallbackElementBottom()');
		expect(script).toContain('clampToOverflowAncestors(el,bottom)');
		expect(script).toContain('clampsOverflow(style)');
		expect(script).toContain('isInFixedSubtree(el)');
		expect(script).toContain('isViewportFill(rect)');
		expect(script).not.toContain('de?de.clientHeight:0');
		expect(script).not.toContain('body?body.clientHeight:0');
		expect(script).toContain('ro.observe(document.body)');
		expect(script).toContain('new MutationObserver(schedule)');
	});

	it('returns initial HTML code before Monaco initializes', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_initial_code_test';
		section.initialCode = '<main>Restored dashboard</main>';

		expect(section.getCode()).toBe('<main>Restored dashboard</main>');
	});

	it('keeps tool-set HTML code before Monaco initializes', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_pending_code_test';
		section.initialCode = '<main>Old dashboard</main>';

		section.setCode('<main>New dashboard</main>');

		expect(section.getCode()).toBe('<main>New dashboard</main>');
		expect(section.initialCode).toBe('<main>New dashboard</main>');
	});

	it('does not treat persisted previewHeightPx as a current-session manual resize', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.previewHeightPx = 1028;

		section.firstUpdated(new Map() as never);

		expect(section._savedPreviewHeightPx).toBe(1028);
		expect(section._userResizedPreview).toBe(false);
		expect(section.serialize().previewHeightPx).toBeUndefined();
	});

	it('restores and reserializes explicitly user-set preview heights', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.previewHeightPx = 1028;
		section.previewHeightUserSet = true;

		section.firstUpdated(new Map() as never);

		expect(section._savedPreviewHeightPx).toBe(1028);
		expect(section._userResizedPreview).toBe(true);
		expect(section.serialize().previewHeightPx).toBe(1028);
		expect(section.serialize().previewHeightUserSet).toBe(true);
	});

	it('stores iframe scroll metrics from preview height reports', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const contentWindow = {};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-iframe'
					? { contentWindow }
					: null,
			},
		});

		section._handleIframeMessage({
			data: { type: 'kw-html-preview-height', h: 955, metrics: { scrollHeight: 956.2, viewportHeight: 948.4 } },
			source: contentWindow,
		} as unknown as MessageEvent);

		expect(section._lastPreviewContentHeight).toBe(955);
		expect(section._lastPreviewScrollHeight).toBe(957);
		expect(section._lastPreviewViewportHeight).toBe(949);
	});

	it('adds a small buffer when auto-fitting preview height to avoid iframe scrollbar flicker', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = { style: { height: '', maxHeight: '' } };

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._applyPreviewFitHeight(640);

		expect(wrapper.style.height).toBe('648px');
		expect(wrapper.style.maxHeight).toBe('648px');
		expect(section._lastPreviewFitHeight).toBe(648);
	});

	it('does not grow auto-fit preview height when the report is bound to the current iframe viewport', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 640;
		section._applyPreviewFitHeight(640);

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('does not grow auto-fit preview height for viewport-unit layouts with padding', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 688;
		section._lastPreviewViewportBoundHeight = 688;
		section._applyPreviewFitHeight(688);

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('does not grow auto-fit preview height for offset viewport-unit layouts', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 736;
		section._lastPreviewViewportBoundHeight = 736;
		section._applyPreviewFitHeight(736);

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('still grows auto-fit preview height for real content slightly taller than the iframe viewport', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 656;
		section._applyPreviewFitHeight(656);

		expect(wrapper.style.height).toBe('664px');
		expect(wrapper.style.maxHeight).toBe('664px');
		expect(section._lastPreviewFitHeight).toBe(664);
	});

	it('resets stale auto-fit wrapper height before reloading preview srcdoc', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.boxId = 'html_reload_reset_test';
		section.initialCode = '<main>Dashboard content</main>';
		const wrapper = { style: { height: '1800px', maxHeight: '1800px' } };
		const iframe = { srcdoc: '' };

		Object.defineProperty(section, 'updateComplete', { value: Promise.resolve(), configurable: true });
		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => {
					if (id === 'preview-wrapper') return wrapper;
					if (id === 'preview-iframe') return iframe;
					return null;
				},
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewFitHeight = 1800;
		section._updatePreview();
		await Promise.resolve();

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
		expect(iframe.srcdoc).toContain('<main>Dashboard content</main>');
	});

	it('resets non-user-resized preview wrappers before a fresh fit request', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = { style: { height: '1800px', maxHeight: '1800px' } };

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewFitHeight = 1800;
		section._resetAutoPreviewHeightForFreshFit();

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('does not treat auto preview height snapshots as user-resized heights', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section._mode = 'preview';
		section._userResizedPreview = false;
		section._savedPreviewHeightPx = undefined;

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper'
					? { getBoundingClientRect: () => ({ height: 640 }) }
					: null,
			},
			configurable: true,
		});

		section._captureCurrentHeight();

		expect(section._userResizedPreview).toBe(false);
		expect(section._savedPreviewHeightPx).toBeUndefined();
	});

	it('preserves preview height snapshots that came from a real user resize', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section._mode = 'preview';
		section._userResizedPreview = true;
		section._savedPreviewHeightPx = undefined;

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper'
					? { getBoundingClientRect: () => ({ height: 640 }) }
					: null,
			},
			configurable: true,
		});

		section._captureCurrentHeight();

		expect(section._userResizedPreview).toBe(true);
		expect(section._savedPreviewHeightPx).toBe(640);
	});
});
