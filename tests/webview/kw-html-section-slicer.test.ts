import { describe, it, expect } from 'vitest';
import { KwHtmlSection } from '../../src/webview/sections/kw-html-section';
import { setResultsState } from '../../src/webview/core/results-state';

type BridgeSection = KwHtmlSection & { _buildDataBridgeScript(): string };

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
		expect(slicerTag).not.toContain('margin-bottom');
	});
});
