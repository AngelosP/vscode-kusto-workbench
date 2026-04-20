// Monaco theme detection & sync — extracted from monaco.ts (Phase 6 decomposition).
// Handles dark/light theme detection, custom KQL token themes, and MutationObserver-based auto-switch.

export function parseCssColorToRgb(value: any) {
	const v = String(value || '').trim();
	if (!v) {
		return null;
	}
	// rgb()/rgba()
	let m = v.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([0-9.]+)\s*)?\)/i);
	if (m) {
		return { r: parseInt(m[1], 10), g: parseInt(m[2], 10), b: parseInt(m[3], 10) };
	}
	// #RGB, #RRGGBB, #RRGGBBAA
	m = v.match(/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i);
	if (m) {
		const hex = m[1];
		if (hex.length === 3) {
			const r = parseInt(hex[0] + hex[0], 16);
			const g = parseInt(hex[1] + hex[1], 16);
			const b = parseInt(hex[2] + hex[2], 16);
			return { r, g, b };
		}
		const r = parseInt(hex.slice(0, 2), 16);
		const g = parseInt(hex.slice(2, 4), 16);
		const b = parseInt(hex.slice(4, 6), 16);
		return { r, g, b };
	}
	return null;
}

export function isDarkTheme() {
	// VS Code webviews typically toggle these classes on theme changes.
	try {
		const cls = document && document.body && document.body.classList;
		if (cls) {
			if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) {
				return false;
			}
			if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) {
				return true;
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	let bg = '';
	try {
		bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
	} catch {
		bg = '';
	}
	const rgb = parseCssColorToRgb(bg);
	if (!rgb) {
		// Fall back to dark if we can't determine; better than flashing light.
		return true;
	}
	const luminance = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
	return luminance < 0.5;
}

let monacoThemeObserverStarted = false;
let lastAppliedIsDarkTheme: any = null;

// Track whether we've defined our custom themes
let customThemesDefined = false;

// KQL syntax highlighting token rules - using lowercase token names as emitted by the Kusto tokenizer
// These match the rules from @kusto/monaco-kusto's kusto-dark and kusto-light themes
const kqlDarkTokenRules = [
	{ token: '', foreground: 'DCDCDC' },
	{ token: 'plainText', foreground: 'DCDCDC' },
	{ token: 'comment', foreground: '608B4E' },
	{ token: 'punctuation', foreground: 'DCDCDC' },
	{ token: 'directive', foreground: 'FAFAD2' },
	{ token: 'literal', foreground: 'DCDCDC' },
	{ token: 'stringLiteral', foreground: 'D69D85' },
	{ token: 'type', foreground: '569CD6' },
	{ token: 'column', foreground: 'DB7093' },
	{ token: 'table', foreground: 'D7BA7D' },
	{ token: 'database', foreground: 'D7BA7D' },
	{ token: 'function', foreground: '569CD6' },
	{ token: 'parameter', foreground: '92CAF4' },
	{ token: 'variable', foreground: '92CAF4' },
	{ token: 'identifier', foreground: 'DCDCDC' },
	{ token: 'clientParameter', foreground: '2B91AF' },
	{ token: 'queryParameter', foreground: '2B91AF' },
	{ token: 'scalarParameter', foreground: '569CD6' },
	{ token: 'mathOperator', foreground: 'DCDCDC' },
	{ token: 'queryOperator', foreground: '4EC9B0' },
	{ token: 'command', foreground: '569CD6' },
	{ token: 'keyword', foreground: '569CD6' },
	{ token: 'materializedView', foreground: 'D7BA7D' },
	{ token: 'schemaMember', foreground: 'DCDCDC' },
	{ token: 'signatureParameter', foreground: 'DCDCDC' },
	{ token: 'option', foreground: 'DCDCDC' },
];

const kqlLightTokenRules = [
	{ token: '', foreground: '000000' },
	{ token: 'plainText', foreground: '000000' },
	{ token: 'comment', foreground: '008000' },
	{ token: 'punctuation', foreground: '000000' },
	{ token: 'directive', foreground: '9400D3' },
	{ token: 'literal', foreground: '000000' },
	{ token: 'stringLiteral', foreground: 'B22222' },
	{ token: 'type', foreground: '0000FF' },
	{ token: 'column', foreground: 'C71585' },
	{ token: 'table', foreground: '9932CC' },
	{ token: 'database', foreground: '9932CC' },
	{ token: 'function', foreground: '0000FF' },
	{ token: 'parameter', foreground: '191970' },
	{ token: 'variable', foreground: '191970' },
	{ token: 'identifier', foreground: '000000' },
	{ token: 'clientParameter', foreground: '2B91AF' },
	{ token: 'queryParameter', foreground: '2B91AF' },
	{ token: 'scalarParameter', foreground: '0000FF' },
	{ token: 'mathOperator', foreground: '000000' },
	{ token: 'queryOperator', foreground: 'CE3600' },
	{ token: 'command', foreground: '0000FF' },
	{ token: 'keyword', foreground: '0000FF' },
	{ token: 'materializedView', foreground: '9932CC' },
	{ token: 'schemaMember', foreground: '000000' },
	{ token: 'signatureParameter', foreground: '000000' },
	{ token: 'option', foreground: '000000' },
];

export function getVSCodeEditorBackground() {
	try {
		const bg = getComputedStyle(document.body).getPropertyValue('--vscode-editor-background').trim();
		if (bg) return bg;
	} catch (e) { console.error('[kusto]', e); }
	return null;
}

export function defineCustomThemes(monaco: any) {
	if (!monaco || !monaco.editor || typeof monaco.editor.defineTheme !== 'function') return;
	
	// Get VS Code's editor background color
	const bgColor = getVSCodeEditorBackground();
	
	try {
		// Define dark theme with KQL syntax rules + VS Code background
		const darkColors: any = { 'editorSuggestWidget.selectedBackground': '#004E8C' };
		if (bgColor) darkColors['editor.background'] = bgColor;
		
		monaco.editor.defineTheme('kusto-workbench-dark', {
			base: 'vs-dark',
			inherit: true,
			rules: kqlDarkTokenRules,
			colors: darkColors
		});
		
		// Define light theme with KQL syntax rules + VS Code background
		const lightColors: any = {};
		if (bgColor) lightColors['editor.background'] = bgColor;
		
		monaco.editor.defineTheme('kusto-workbench-light', {
			base: 'vs',
			inherit: true,
			rules: kqlLightTokenRules,
			colors: lightColors
		});
		
		customThemesDefined = true;
	} catch {
		customThemesDefined = false;
	}
}

/**
 * Return the Monaco theme name that `applyMonacoTheme` would set right now.
 * Useful for passing to `monaco.editor.create({ theme })` so a new editor
 * starts with the correct colours on the very first frame.
 */
export function getCurrentMonacoThemeName(): string {
	const dark = isDarkTheme();
	if (customThemesDefined) {
		return dark ? 'kusto-workbench-dark' : 'kusto-workbench-light';
	}
	return dark ? 'vs-dark' : 'vs';
}

export function applyMonacoTheme(monaco: any) {
	if (!monaco || !monaco.editor || typeof monaco.editor.setTheme !== 'function') {
		return;
	}
	let dark = true;
	try {
		dark = isDarkTheme();
	} catch {
		dark = true;
	}
	
	// Re-define themes to pick up any VS Code background color changes
	customThemesDefined = false;
	defineCustomThemes(monaco);
	
	lastAppliedIsDarkTheme = dark;
	try {
		if (customThemesDefined) {
			// Use our custom themes with KQL syntax highlighting + VS Code background
			monaco.editor.setTheme(dark ? 'kusto-workbench-dark' : 'kusto-workbench-light');
		} else {
			// Fall back to original kusto themes if custom theme definition failed
			monaco.editor.setTheme(dark ? 'kusto-dark' : 'kusto-light');
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function startMonacoThemeObserver(monaco: any) {
	if (monacoThemeObserverStarted) {
		return;
	}
	monacoThemeObserverStarted = true;

	// Apply once now (safe even if ensureMonaco already set theme).
	applyMonacoTheme(monaco);

	let pending = false;
	const schedule = () => {
		if (pending) {
			return;
		}
		pending = true;
		setTimeout(() => {
			pending = false;
			applyMonacoTheme(monaco);
		}, 0);
	};

	try {
		const observer = new MutationObserver(() => schedule());
		if (document && document.body) {
			observer.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document && document.documentElement) {
			observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	} catch (e) { console.error('[kusto]', e); }
}

