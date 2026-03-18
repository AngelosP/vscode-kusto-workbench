/**
 * Shared codicon stylesheet for shadow DOM components.
 *
 * The codicon font is loaded via Monaco's editor.main.css in the light DOM.
 * `@font-face` rules are global and work across shadow DOM boundaries, so the
 * font itself is available. However, the `.codicon-*::before` content rules
 * (which map icon names to Unicode characters) are generated dynamically by
 * Monaco at runtime and live in the light DOM — shadow DOM doesn't inherit them.
 *
 * This module provides a `CSSStyleSheet` with the base `.codicon` class and
 * hardcoded `::before` content rules for every icon our components use.
 * Character codes are sourced from Monaco's `codiconsLibrary.js`.
 *
 * Usage:
 *   import { codiconSheet } from '../shared/codicon-styles.js';
 *   static styles = [codiconSheet, myStyles];
 */

/**
 * Codicon character codes used by our Lit components.
 * Source: node_modules/monaco-editor/esm/vs/base/common/codiconsLibrary.js
 *
 * To add a new icon: look up its `register('name', 0xNNNN)` call in
 * codiconsLibrary.js and add it here.
 */
const CODICON_CHARS: Record<string, number> = {
	'clear-all': 0xeabf,
	'close': 0xea76,
	'tools': 0xeb6d,
	'eye': 0xea70,
	'trash': 0xea81,
	'insert': 0xec11,
	'link-external': 0xeb14,
	'book': 0xeaa4,
	'notebook': 0xebaf,
	'code': 0xeac4,
	'comment': 0xea6b,
	'arrow-up': 0xeaa1,
	'debug-stop': 0xead7,
	'settings-gear': 0xeb51,
};

function buildCss(): string {
	const base = `
.codicon[class*='codicon-'] {
	font: normal normal normal 16px/1 codicon;
	display: inline-block;
	text-decoration: none;
	text-rendering: auto;
	text-align: center;
	text-transform: none;
	-webkit-font-smoothing: antialiased;
	-moz-osx-font-smoothing: grayscale;
	user-select: none;
	-webkit-user-select: none;
}
`;
	const iconRules = Object.entries(CODICON_CHARS)
		.map(([name, code]) => `.codicon-${name}::before { content: "\\${code.toString(16)}"; }`)
		.join('\n');

	return base + '\n' + iconRules;
}

/**
 * A `CSSStyleSheet` containing the base `.codicon` class and `::before` content
 * rules for all icons used by our Lit components — ready to be adopted by any
 * shadow root.
 *
 * IMPORTANT: Must be a real `CSSStyleSheet` instance — Lit's `adoptStyles`
 * checks `instanceof CSSStyleSheet` and a Proxy wrapper would fail that check.
 */
const sheet = new CSSStyleSheet();
sheet.replaceSync(buildCss());
export const codiconSheet: CSSStyleSheet = sheet;
