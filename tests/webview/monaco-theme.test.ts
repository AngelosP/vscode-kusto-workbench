import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { parseCssColorToRgb, isDarkTheme, defineCustomThemes, applyMonacoTheme } from '../../src/webview/monaco/theme.js';

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

// ── isDarkTheme ───────────────────────────────────────────────────────────────

describe('isDarkTheme', () => {
	afterEach(() => {
		// Clean up body classes
		document.body.classList.remove('vscode-dark', 'vscode-light', 'vscode-high-contrast', 'vscode-high-contrast-light');
	});

	it('returns false when body has vscode-light class', () => {
		document.body.classList.add('vscode-light');
		expect(isDarkTheme()).toBe(false);
	});

	it('returns false when body has vscode-high-contrast-light class', () => {
		document.body.classList.add('vscode-high-contrast-light');
		expect(isDarkTheme()).toBe(false);
	});

	it('returns true when body has vscode-dark class', () => {
		document.body.classList.add('vscode-dark');
		expect(isDarkTheme()).toBe(true);
	});

	it('returns true when body has vscode-high-contrast class', () => {
		document.body.classList.add('vscode-high-contrast');
		expect(isDarkTheme()).toBe(true);
	});

	it('falls back to luminance check when no theme class is set', () => {
		// No vscode-* classes set — getComputedStyle returns empty, so falls back to dark
		expect(isDarkTheme()).toBe(true);
	});
});

// ── defineCustomThemes ────────────────────────────────────────────────────────

describe('defineCustomThemes', () => {
	let definedThemes: Record<string, any>;

	beforeEach(() => {
		definedThemes = {};
	});

	function makeMockMonaco() {
		return {
			editor: {
				defineTheme: vi.fn((name: string, theme: any) => {
					definedThemes[name] = theme;
				}),
			},
		};
	}

	it('defines dark and light themes', () => {
		const monaco = makeMockMonaco();
		defineCustomThemes(monaco);
		expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(2);
		expect(definedThemes['kusto-workbench-dark']).toBeTruthy();
		expect(definedThemes['kusto-workbench-light']).toBeTruthy();
	});

	it('dark theme inherits from vs-dark', () => {
		defineCustomThemes(makeMockMonaco());
		expect(definedThemes['kusto-workbench-dark'].base).toBe('vs-dark');
		expect(definedThemes['kusto-workbench-dark'].inherit).toBe(true);
	});

	it('light theme inherits from vs', () => {
		defineCustomThemes(makeMockMonaco());
		expect(definedThemes['kusto-workbench-light'].base).toBe('vs');
		expect(definedThemes['kusto-workbench-light'].inherit).toBe(true);
	});

	it('includes token rules for KQL syntax', () => {
		defineCustomThemes(makeMockMonaco());
		const darkRules = definedThemes['kusto-workbench-dark'].rules;
		expect(Array.isArray(darkRules)).toBe(true);
		expect(darkRules.length).toBeGreaterThan(10);
		const tokenNames = darkRules.map((r: any) => r.token);
		expect(tokenNames).toContain('comment');
		expect(tokenNames).toContain('keyword');
		expect(tokenNames).toContain('queryOperator');
		expect(tokenNames).toContain('column');
		expect(tokenNames).toContain('table');
	});

	it('does nothing when monaco is null', () => {
		expect(() => defineCustomThemes(null)).not.toThrow();
	});

	it('does nothing when monaco.editor is missing', () => {
		expect(() => defineCustomThemes({})).not.toThrow();
	});

	it('does nothing when defineTheme is not a function', () => {
		expect(() => defineCustomThemes({ editor: {} })).not.toThrow();
	});

	it('handles defineTheme throwing an error', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		const monaco = {
			editor: {
				defineTheme: vi.fn(() => { throw new Error('mock'); }),
			},
		};
		// Should not throw
		expect(() => defineCustomThemes(monaco)).not.toThrow();
	});
});

// ── applyMonacoTheme ──────────────────────────────────────────────────────────

describe('applyMonacoTheme', () => {
	let applyMonacoTheme: any;

	beforeEach(async () => {
		vi.restoreAllMocks();
		// Re-import to reset module state (customThemesDefined etc.)
		const mod = await import('../../src/webview/monaco/theme.js');
		applyMonacoTheme = mod.applyMonacoTheme;
	});

	it('calls setTheme with dark custom theme when body has dark class', () => {
		// Mock isDarkTheme to return true via body classList
		document.body.className = 'vscode-dark';
		const monaco = {
			editor: {
				defineTheme: vi.fn(),
				setTheme: vi.fn(),
			},
		};
		applyMonacoTheme(monaco);
		expect(monaco.editor.setTheme).toHaveBeenCalledWith('kusto-workbench-dark');
	});

	it('calls setTheme with light custom theme when body has light class', () => {
		document.body.className = 'vscode-light';
		const monaco = {
			editor: {
				defineTheme: vi.fn(),
				setTheme: vi.fn(),
			},
		};
		applyMonacoTheme(monaco);
		expect(monaco.editor.setTheme).toHaveBeenCalledWith('kusto-workbench-light');
	});

	it('does nothing when monaco is null', () => {
		expect(() => applyMonacoTheme(null)).not.toThrow();
	});

	it('does nothing when setTheme is not a function', () => {
		expect(() => applyMonacoTheme({ editor: {} })).not.toThrow();
	});

	it('falls back to kusto-dark when defineTheme fails', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		document.body.className = 'vscode-dark';
		const monaco = {
			editor: {
				defineTheme: vi.fn(() => { throw new Error('fail'); }),
				setTheme: vi.fn(),
			},
		};
		applyMonacoTheme(monaco);
		expect(monaco.editor.setTheme).toHaveBeenCalledWith('kusto-dark');
	});

	it('re-defines themes on each call', () => {
		document.body.className = 'vscode-dark';
		const monaco = {
			editor: {
				defineTheme: vi.fn(),
				setTheme: vi.fn(),
			},
		};
		applyMonacoTheme(monaco);
		applyMonacoTheme(monaco);
		// defineTheme called 2 times per call (dark+light), so 4 total
		expect(monaco.editor.defineTheme).toHaveBeenCalledTimes(4);
	});
});
