// Lightweight entry point for the md-only webview.
// Imports md-persistence FIRST to set window.schedulePersist before the
// markdown section component loads and potentially calls it.
import './md-persistence.js';

import { sashSheet } from '../shared/sash-styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osThemeSheet } from '../shared/os-theme-styles.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sashSheet, scrollbarSheet, osThemeSheet];

// Register the <kw-markdown-section> custom element.
import '../sections/kw-markdown-section.js';

// Request document from host — triggers persistenceMode + documentData messages.
if (window.vscode) {
	try { window.vscode.postMessage({ type: 'requestDocument' }); } catch (e) { console.error('[kusto]', e); }
}
