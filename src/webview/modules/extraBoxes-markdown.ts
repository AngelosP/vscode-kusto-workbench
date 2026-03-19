// Markdown box creation — thin bridge module.
// Phase B1: Core logic moved to kw-markdown-section.ts (Lit component).
// This file retains: addMarkdownBox, removeMarkdownBox, reveal bridges,
// and window bridge assignments for external callers (main.ts, persistence.ts).

import type { KwMarkdownSection } from '../sections/kw-markdown-section.js';

const _win = window;

// Access shared state from window.
window.__kustoMarkdownBoxes = window.__kustoMarkdownBoxes || [];
let markdownBoxes: any[] = window.__kustoMarkdownBoxes;
window.__kustoMarkdownEditors = window.__kustoMarkdownEditors || {};
const markdownEditors = window.__kustoMarkdownEditors;

// Pending reveal payloads — queued before the editor is ready.
window.__kustoPendingMarkdownRevealByBoxId = window.__kustoPendingMarkdownRevealByBoxId || {};

// ── Reveal logic ────────────────────────────────────────────────────────────

// Called by main.ts when the extension host asks us to reveal a text range.
// For .md compatibility mode, there is exactly one markdown section.
try {
if (typeof window.__kustoRevealTextRangeFromHost !== 'function') {
window.__kustoRevealTextRangeFromHost = (message: any) => {
try {
const kind = String(window.__kustoDocumentKind || '');
if (kind !== 'md') return;

const start = message?.start;
const end = message?.end;
const sl = start && typeof start.line === 'number' ? start.line : 0;
const sc = start && typeof start.character === 'number' ? start.character : 0;
const el = end && typeof end.line === 'number' ? end.line : sl;
const ec = end && typeof end.character === 'number' ? end.character : sc;
const matchText = typeof message?.matchText === 'string' ? String(message.matchText) : '';
const startOffset = typeof message?.startOffset === 'number' ? message.startOffset : undefined;
const endOffset = typeof message?.endOffset === 'number' ? message.endOffset : undefined;

const boxId = markdownBoxes?.length ? String(markdownBoxes[0] || '') : '';
if (!boxId) return;

const payload = { startLine: sl, startChar: sc, endLine: el, endChar: ec, matchText, startOffset, endOffset };

// Delegate to the Lit component's revealRange.
const litEl = document.getElementById(boxId) as KwMarkdownSection | null;
if (litEl && typeof litEl.revealRange === 'function') {
try {
(_win.vscode as any)?.postMessage?.({
type: 'debugMdSearchReveal',
phase: 'markdownReveal(apply)',
detail: `${String(window.__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText.length}`
});
} catch (e) { console.error('[kusto]', e); }
litEl.revealRange(payload);
} else {
// Editor not ready — queue for later.
try {
(_win.vscode as any)?.postMessage?.({
type: 'debugMdSearchReveal',
phase: 'markdownReveal(queued)',
detail: `${String(window.__kustoDocumentUri || '')} boxId=${boxId} ${sl}:${sc}-${el}:${ec} matchLen=${matchText.length}`
});
} catch (e) { console.error('[kusto]', e); }
window.__kustoPendingMarkdownRevealByBoxId = window.__kustoPendingMarkdownRevealByBoxId || {};
window.__kustoPendingMarkdownRevealByBoxId![boxId] = payload;
}
} catch (e) { console.error('[kusto]', e); }
};
}
} catch (e) { console.error('[kusto]', e); }

// ── addMarkdownBox ──────────────────────────────────────────────────────────

export function addMarkdownBox(options: any) {
const id = (options && options.id) ? String(options.id) : ('markdown_' + Date.now());
markdownBoxes.push(id);

// Allow restore to set an initial mode before the editor initializes.
try {
const rawMode = options && typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
window.__kustoMarkdownModeByBoxId = window.__kustoMarkdownModeByBoxId || {};
window.__kustoMarkdownModeByBoxId[id] = rawMode;
}
} catch (e) { console.error('[kusto]', e); }

// Ensure initial markdown text is available before TOAST UI initializes.
try {
const initialText = options && typeof options.text === 'string' ? options.text : undefined;
if (typeof initialText === 'string') {
window.__kustoPendingMarkdownTextByBoxId = window.__kustoPendingMarkdownTextByBoxId || {};
window.__kustoPendingMarkdownTextByBoxId[id] = initialText;
}
} catch (e) { console.error('[kusto]', e); }

const container = document.getElementById('queries-container');
if (!container) return id;

const litEl = document.createElement('kw-markdown-section') as KwMarkdownSection;
litEl.id = id;
litEl.setAttribute('box-id', id);

// For plain .md files, enable full-page mode (no section chrome).
try {
if (String(window.__kustoDocumentKind || '') === 'md' || (options && options.mdAutoExpand)) {
litEl.setAttribute('plain-md', '');
}
} catch (e) { console.error('[kusto]', e); }

// Pass initial text if available.
const pendingText = window.__kustoPendingMarkdownTextByBoxId?.[id];
if (typeof pendingText === 'string') {
litEl.setAttribute('initial-text', pendingText);
}

// Create light-DOM containers that TOAST UI will render into (via <slot>).
const editorDiv = document.createElement('div');
editorDiv.className = 'kusto-markdown-editor';
editorDiv.id = id + '_md_editor';
editorDiv.slot = 'editor';
litEl.appendChild(editorDiv);

const viewerDiv = document.createElement('div');
viewerDiv.className = 'markdown-viewer';
viewerDiv.id = id + '_md_viewer';
viewerDiv.slot = 'viewer';
viewerDiv.style.display = 'none';
litEl.appendChild(viewerDiv);

// Handle remove event from the Lit component.
litEl.addEventListener('section-remove', function (e: any) {
try { removeMarkdownBox(e.detail.boxId); } catch (e) { console.error('[kusto]', e); }
});

container.appendChild(litEl);

// Apply persisted height.
try {
const h = options && typeof options.editorHeightPx === 'number' ? options.editorHeightPx : undefined;
const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
if (!isPlainMd && typeof h === 'number' && Number.isFinite(h) && h > 0) {
litEl.setAttribute('editor-height-px', String(h));
}
} catch (e) { console.error('[kusto]', e); }

// Apply persisted mode.
try {
const rawMode = options && typeof options.mode !== 'undefined' ? String(options.mode || '').toLowerCase() : '';
if (rawMode === 'preview' || rawMode === 'markdown' || rawMode === 'wysiwyg') {
if (typeof litEl.setMarkdownMode === 'function') {
litEl.setMarkdownMode(rawMode as any);
}
}
} catch (e) { console.error('[kusto]', e); }

// Apply persisted title.
try {
if (options && typeof options.title === 'string' && options.title) {
litEl.setTitle(options.title);
}
} catch (e) { console.error('[kusto]', e); }

// Apply persisted expanded state.
try {
if (options && typeof options.expanded === 'boolean') {
litEl.setExpanded(options.expanded);
}
} catch (e) { console.error('[kusto]', e); }

try { _win.schedulePersist?.(); } catch (e) { console.error('[kusto]', e); }
try {
const isPlainMd = String(window.__kustoDocumentKind || '') === 'md';
if (!isPlainMd) {
const controls = document.querySelector('.add-controls');
if (controls && typeof controls.scrollIntoView === 'function') {
controls.scrollIntoView({ block: 'end' });
}
}
} catch (e) { console.error('[kusto]', e); }
return id;
}

// ── removeMarkdownBox ───────────────────────────────────────────────────────

export function removeMarkdownBox(boxId: any) {
if (markdownEditors[boxId]) {
try { markdownEditors[boxId].dispose(); } catch (e) { console.error('[kusto]', e); }
delete markdownEditors[boxId];
}
markdownBoxes = markdownBoxes.filter((id: any) => id !== boxId);
window.__kustoMarkdownBoxes = markdownBoxes;
const box = document.getElementById(boxId);
if (box?.parentNode) box.parentNode.removeChild(box);
try { _win.schedulePersist?.(); } catch (e) { console.error('[kusto]', e); }
try {
if (window.__kustoMarkdownModeByBoxId && typeof window.__kustoMarkdownModeByBoxId === 'object') {
delete window.__kustoMarkdownModeByBoxId[boxId];
}
} catch (e) { console.error('[kusto]', e); }
}

// ── Thin bridge delegates to Lit component ──────────────────────────────────

function _getLitEl(boxId: any): KwMarkdownSection | null {
const el = document.getElementById(String(boxId || ''));
return (el && typeof (el as any).fitToContents === 'function') ? el as unknown as KwMarkdownSection : null;
}

function __kustoMaximizeMarkdownBox(boxId: any) {
const el = _getLitEl(boxId);
if (el) {
const fit = () => { try { el.fitToContents(); } catch (e) { console.error('[kusto]', e); } };
fit(); setTimeout(fit, 50); setTimeout(fit, 150); setTimeout(fit, 350);
}
}

function __kustoSetMarkdownMode(boxId: any, mode: any) {
const el = _getLitEl(boxId);
if (el) el.setMarkdownMode(mode);
}

function __kustoApplyMarkdownEditorMode(boxId: any) {
const el = _getLitEl(boxId);
if (el) el.applyEditorMode();
}

function __kustoGetMarkdownMode(boxId: any) {
try {
const map = window.__kustoMarkdownModeByBoxId;
const v = map && boxId ? String(map[boxId] || '') : '';
if (v === 'preview' || v === 'markdown' || v === 'wysiwyg') return v;
} catch (e) { console.error('[kusto]', e); }
return 'wysiwyg';
}

// Theme functions — delegate to the Lit component's static methods.
function __kustoApplyToastUiThemeAll() {
try {
const Cls = customElements.get('kw-markdown-section') as typeof KwMarkdownSection | undefined;
if (Cls && typeof Cls.applyThemeAll === 'function') Cls.applyThemeAll();
} catch (e) { console.error('[kusto]', e); }
}

function isLikelyDarkTheme(): boolean {
try {
const cls = document?.body?.classList;
if (cls) {
if (cls.contains('vscode-light') || cls.contains('vscode-high-contrast-light')) return false;
if (cls.contains('vscode-dark') || cls.contains('vscode-high-contrast')) return true;
}
} catch (e) { console.error('[kusto]', e); }
try {
const bg = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim();
if (!bg) return false;
let r: number, g: number, b: number;
if (bg.startsWith('#')) {
const hex = bg.slice(1);
if (hex.length === 3) { r = parseInt(hex[0]+hex[0],16); g = parseInt(hex[1]+hex[1],16); b = parseInt(hex[2]+hex[2],16); }
else if (hex.length >= 6) { r = parseInt(hex.slice(0,2),16); g = parseInt(hex.slice(2,4),16); b = parseInt(hex.slice(4,6),16); }
else return false;
} else {
const m = bg.match(/rgba?\((\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
if (!m) return false;
r = parseInt(m[1],10); g = parseInt(m[2],10); b = parseInt(m[3],10);
}
return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 128;
} catch { return false; }
}

function getToastUiPlugins(ToastEditor: any): any[] {
try {
const colorSyntax = ToastEditor?.plugin?.colorSyntax;
if (typeof colorSyntax === 'function') return [[colorSyntax, {}]];
} catch (e) { console.error('[kusto]', e); }
return [];
}

// ── Window bridges ──────────────────────────────────────────────────────────
window.__kustoMaximizeMarkdownBox = __kustoMaximizeMarkdownBox;
window.__kustoSetMarkdownMode = __kustoSetMarkdownMode;
window.__kustoApplyMarkdownEditorMode = __kustoApplyMarkdownEditorMode;
window.__kustoGetMarkdownMode = __kustoGetMarkdownMode;
window.__kustoApplyToastUiThemeAll = __kustoApplyToastUiThemeAll;
window.isLikelyDarkTheme = isLikelyDarkTheme;
window.getToastUiPlugins = getToastUiPlugins;
window.addMarkdownBox = addMarkdownBox;
window.removeMarkdownBox = removeMarkdownBox;
