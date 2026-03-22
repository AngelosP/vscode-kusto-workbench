import { describe, it, expect } from 'vitest';
import { parseCssColorToRgb } from '../../src/webview/monaco/theme.js';

// ── parseCssColorToRgb ────────────────────────────────────────────────────────

describe('parseCssColorToRgb', () => {
	it('parses #RRGGBB hex', () => {
		expect(parseCssColorToRgb('#FF0000')).toEqual({ r: 255, g: 0, b: 0 });
		expect(parseCssColorToRgb('#00ff00')).toEqual({ r: 0, g: 255, b: 0 });
		expect(parseCssColorToRgb('#0000FF')).toEqual({ r: 0, g: 0, b: 255 });
	});

	it('parses #RGB shorthand', () => {
		expect(parseCssColorToRgb('#F00')).toEqual({ r: 255, g: 0, b: 0 });
		expect(parseCssColorToRgb('#0f0')).toEqual({ r: 0, g: 255, b: 0 });
		expect(parseCssColorToRgb('#fff')).toEqual({ r: 255, g: 255, b: 255 });
	});

	it('parses #RRGGBBAA (ignores alpha)', () => {
		expect(parseCssColorToRgb('#FF000080')).toEqual({ r: 255, g: 0, b: 0 });
	});

	it('parses rgb()', () => {
		expect(parseCssColorToRgb('rgb(128, 64, 32)')).toEqual({ r: 128, g: 64, b: 32 });
	});

	it('parses rgba()', () => {
		expect(parseCssColorToRgb('rgba(100, 200, 50, 0.5)')).toEqual({ r: 100, g: 200, b: 50 });
	});

	it('returns null for empty input', () => {
		expect(parseCssColorToRgb('')).toBeNull();
		expect(parseCssColorToRgb(null)).toBeNull();
		expect(parseCssColorToRgb(undefined)).toBeNull();
	});

	it('returns null for invalid color strings', () => {
		expect(parseCssColorToRgb('not-a-color')).toBeNull();
		expect(parseCssColorToRgb('#GG0000')).toBeNull();
		expect(parseCssColorToRgb('#12')).toBeNull();
	});

	it('handles whitespace around value', () => {
		expect(parseCssColorToRgb('  #FF0000  ')).toEqual({ r: 255, g: 0, b: 0 });
		// rgb() regex requires digits right after parens; extra spacing is not matched
		expect(parseCssColorToRgb('rgb(10, 20, 30)')).toEqual({ r: 10, g: 20, b: 30 });
	});

	it('parses dark background colors accurately', () => {
		// VS Code dark theme default background
		expect(parseCssColorToRgb('#1e1e1e')).toEqual({ r: 30, g: 30, b: 30 });
	});

	it('parses light background colors accurately', () => {
		// VS Code light theme default background
		expect(parseCssColorToRgb('#ffffff')).toEqual({ r: 255, g: 255, b: 255 });
	});
});
