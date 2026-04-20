/**
 * Unified icon registry — the single source of truth for every icon in the app.
 *
 * Icons can come from any source (SVG, VS Code codicons, future icon packs).
 * Consumers import `ICONS.xxx` and never care about the underlying source.
 *
 * To add a new icon:
 *   1. If a suitable codicon exists → `codicon('name')` (preferred)
 *   2. Otherwise → `svg(html\`<svg ...>...</svg>\`)` (custom SVG fallback)
 *   3. If using a codicon not yet in codicon-styles.ts → add its char code there too
 *
 * To change an icon's source: update its entry here. All consumers update automatically.
 */
import { html, type TemplateResult, type CSSResultGroup } from 'lit';
import { codiconSheet } from './codicon-styles.js';

// ── Source helpers ─────────────────────────────────────────────────────────────
// These document *where* an icon comes from. Future sources (phosphor, fluent, …)
// get their own helper here.

/** Render a VS Code codicon glyph. Requires `iconRegistryStyles` in the component's `static styles`. */
const codicon = (name: string): TemplateResult =>
	html`<span class="codicon codicon-${name}" aria-hidden="true"></span>`;

/** Identity wrapper — documents that the icon is a custom inline SVG. */
const svg = (t: TemplateResult): TemplateResult => t;

// ── Unified ICONS object ──────────────────────────────────────────────────────

export const ICONS = {

	// ── General (from icons.ts) ───────────────────────────────────────────────

	kustoCluster: svg(html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M5 3.5h6"/><path d="M4 6h8"/><path d="M3.5 8.5h9"/><path d="M4 11h8"/><path d="M5 13.5h6"/></svg>`),
	database: codicon('database'),
	sqlServer: svg(html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="2" width="12" height="4" rx="1"/><rect x="2" y="10" width="12" height="4" rx="1"/><line x1="8" y1="6" x2="8" y2="10"/><circle cx="5" cy="4" r="0.5" fill="currentColor" stroke="none"/><circle cx="5" cy="12" r="0.5" fill="currentColor" stroke="none"/></svg>`),
	table: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M14 2H2v12h12V2zm-1 1v3H9V3h4zM3 3h5v3H3V3zm0 4h5v3H3V7zm0 4h5v2H3v-2zm6 2v-2h4v2H9zm4-3H9V7h4v3z"/></svg>`),
	function: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 2a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM3 5V3h2v2H3zm7.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM11 5V3h2v2h-2zM2.5 10a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM3 13v-2h2v2H3zm7.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm.5 3v-2h2v2h-2zM8 5.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm-3 3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm3 0a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/></svg>`),
	folder: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M14.5 3H7.71l-.85-.85A.5.5 0 0 0 6.5 2h-5a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h13a.5.5 0 0 0 .5-.5v-10a.5.5 0 0 0-.5-.5zm-.5 10H2V3h4.29l.85.85a.5.5 0 0 0 .36.15H14v9z"/></svg>`),
	chevron: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M6 4l4 4-4 4V4z"/></svg>`),
	star: svg(html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.2" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5l2.09 4.26 4.71.69-3.4 3.32.8 4.68L8 12.26l-4.2 2.19.8-4.68-3.4-3.32 4.71-.69L8 1.5z"/></svg>`),
	starFilled: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1.5l2.09 4.26 4.71.69-3.4 3.32.8 4.68L8 12.26l-4.2 2.19.8-4.68-3.4-3.32 4.71-.69L8 1.5z"/></svg>`),
	edit: codicon('edit'),
	delete: codicon('trash'),
	copy: codicon('copy'),
	refresh: codicon('refresh'),
	add: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M14 7v1H8v6H7V8H1V7h6V1h1v6h6z"/></svg>`),
	close: codicon('close'),
	shield: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" stroke="currentColor" stroke-width="1" xmlns="http://www.w3.org/2000/svg"><path d="M8 0.5l-6 2v4c0 3.5 2.5 6.5 6 8 3.5-1.5 6-4.5 6-8v-4l-6-2z"/></svg>`),
	newFile: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M9.5 1H3.5A1.5 1.5 0 0 0 2 2.5v11A1.5 1.5 0 0 0 3.5 15h9a1.5 1.5 0 0 0 1.5-1.5V5.5L9.5 1zM3 2.5a.5.5 0 0 1 .5-.5H9v3.5a.5.5 0 0 0 .5.5H13v7.5a.5.5 0 0 1-.5.5h-9a.5.5 0 0 1-.5-.5v-11zM10 2.7L12.3 5H10V2.7z"/><path d="M8.5 8a.5.5 0 0 0-1 0v1.5H6a.5.5 0 0 0 0 1h1.5V12a.5.5 0 0 0 1 0v-1.5H10a.5.5 0 0 0 0-1H8.5V8z"/></svg>`),
	spinner: svg(html`<svg class="spin" viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1a7 7 0 1 0 7 7h-1A6 6 0 1 1 8 2V1z"/></svg>`),
	sidebar: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M0 2.5A1.5 1.5 0 0 1 1.5 1h13A1.5 1.5 0 0 1 16 2.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 0 13.5v-11zM1.5 2a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5H5V2H1.5zM6 2v12h8.5a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5H6z"/></svg>`),
	importIcon: svg(html`<svg viewBox="0 0 16 16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1a.5.5 0 0 1 .5.5v8.793l2.146-2.147a.5.5 0 0 1 .708.708l-3 3a.5.5 0 0 1-.708 0l-3-3a.5.5 0 1 1 .708-.708L7.5 10.293V1.5A.5.5 0 0 1 8 1zM2 13.5a.5.5 0 0 1 .5-.5h11a.5.5 0 0 1 0 1h-11a.5.5 0 0 1-.5-.5z"/></svg>`),
	save: codicon('save'),

	// ── Toolbar icons (from toolbar-icons.ts) ─────────────────────────────────

	toolbarUndo: svg(html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>`),
	toolbarRedo: svg(html`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>`),
	toolbarComment: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="3.5" y="1" width="2.4" height="14" rx="0.3" transform="rotate(20 4.7 8)"/><rect x="9.5" y="1" width="2.4" height="14" rx="0.3" transform="rotate(20 10.7 8)"/></svg>`),
	toolbarCommentSql: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="7" width="5" height="2" rx="0.3"/><rect x="9" y="7" width="5" height="2" rx="0.3"/></svg>`),
	toolbarCommentHtml: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 8l4-5h2L4.5 8 8 13H6z"/><rect x="10" y="3" width="2.2" height="7" rx="0.3"/><rect x="10.4" y="11.5" width="1.5" height="1.5" rx="0.75"/></svg>`),
	toolbarPrettify: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>`),
	toolbarSearch: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M6.5 2a4.5 4.5 0 1 0 2.67 8.13l3.02 3.02a.75.75 0 0 0 1.06-1.06l-3.02-3.02A4.5 4.5 0 0 0 6.5 2zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>`),
	toolbarReplace: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M2.5 4.5h8V3l3 2.5-3 2.5V6.5h-8v-2zM13.5 11.5h-8V13l-3-2.5 3-2.5v1.5h8v2z"/></svg>`),
	toolbarIndent: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M7 4h7M7 8h7M7 12h7"/><path d="M2 5l3 3-3 3"/></svg>`),
	toolbarOutdent: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M7 4h7M7 8h7M7 12h7"/><path d="M5 5l-3 3 3 3"/></svg>`),
	toolbarWordWrap: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M2 4h12M2 8h9a2.5 2.5 0 0 1 0 5H8"/><path d="M9.5 11.5L8 13l1.5 1.5"/></svg>`),
	toolbarAutocomplete: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5h10"/><path d="M3 7.5h6"/><path d="M3 10.5h4"/><path d="M10.2 9.2l2.3 2.3"/><path d="M12.5 9.2v2.3h-2.3"/></svg>`),
	toolbarGhost: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1C5.2 1 3 3.2 3 6v6c0 .3.1.6.4.8.2.2.5.2.8.1l1.3-.7 1.3.7c.3.2.7.2 1 0L8 12.2l.2.7c.3.2.7.2 1 0l1.3-.7 1.3.7c.3.1.6.1.8-.1.3-.2.4-.5.4-.8V6c0-2.8-2.2-5-5-5zm-2 6.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm4 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/></svg>`),
	toolbarCaretDocs: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 3.5h10v9H3v-9z"/><path d="M3 6h10"/><path d="M5 8.2h6"/><path d="M5 10.4h4.2"/></svg>`),
	toolbarPowerBI: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="10" width="3" height="4"/><rect x="6" y="6" width="3" height="8"/><rect x="10" y="3" width="3" height="11"/></svg>`),
	toolbarDoubleToSingle: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>`),
	toolbarSingleToDouble: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>`),
	toolbarQualifyTables: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/></svg>`),
	toolbarSingleLine: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M2 8h12"/></svg>`),
	toolbarInlineFunction: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M5 2C3.5 2 3 3 3 4v2.5C3 7.5 2 8 2 8s1 .5 1 1.5V12c0 1 .5 2 2 2"/><path d="M11 2c1.5 0 2 1 2 2v2.5c0 1 1 1.5 1 1.5s-1 .5-1 1.5V12c0 1-.5 2-2 2"/></svg>`),
	toolbarRename: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M10.5 2.5l3 3-8 8H2.5v-3l8-8z"/><path d="M8.5 4.5l3 3"/></svg>`),
	toolbarExport: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M8 2v8M5 7l3 3 3-3"/><path d="M3 11v2h10v-2"/></svg>`),
	toolbarRun: svg(html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M4.5 2.5v11l9-5.5z"/></svg>`),
	toolbarTools: codicon('tools'),
	toolbarLink: codicon('link'),

	// ── Section icons (from section-icons.ts) ─────────────────────────────────

	sectionQuery: svg(html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3.5h6"/><path d="M4 6h8"/><path d="M3.5 8.5h9"/><path d="M4 11h8"/><path d="M5 13.5h6"/></svg>`),
	sectionMarkdown: svg(html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3v10h12V3H2zm1 1h10v8H3V4zm1.5 1.5v5h2V7.75L8 9.5l1.5-1.75V10.5h2v-5h-2L8 7.75 6.5 5.5h-2zm5.5 0v3h-1.5L10.5 11l2-2.5H11v-3h-1z"/></svg>`),
	sectionChart: svg(html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1 14h14V2h-1v11H2V5H1v9zm3-9v7h2V5H4zm3 3v4h2V8H7zm3-2v6h2V6h-2z"/></svg>`),
	sectionPython: svg(html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M7.5 1C5.57 1 4 2.12 4 3.5V5h4v1H3.5C2.12 6 1 7.07 1 8.5v2C1 11.88 2.12 13 3.5 13H5v-1.5C5 10.12 6.12 9 7.5 9h3C11.33 9 12 8.33 12 7.5v-4C12 2.12 10.43 1 8.5 1h-1zM6 3.25a.75.75 0 1 1 1.5 0 .75.75 0 0 1-1.5 0zM8.5 15c1.93 0 3.5-1.12 3.5-2.5V11H8v-1h4.5c1.38 0 2.5-1.07 2.5-2.5v-2C15 4.12 13.88 3 12.5 3H11v1.5C11 5.88 9.88 7 8.5 7h-3C4.67 7 4 7.67 4 8.5v4C4 13.88 5.57 15 7.5 15h1zm2.5-2.25a.75.75 0 1 1-1.5 0 .75.75 0 0 1 1.5 0z"/></svg>`),
	sectionUrl: svg(html`<svg viewBox="-1 -1 18 18" fill="currentColor"><path d="M7.775 3.275a.75.75 0 0 0 1.06 1.06l1.25-1.25a2 2 0 1 1 2.83 2.83l-2.5 2.5a2 2 0 0 1-2.83 0 .75.75 0 0 0-1.06 1.06 3.5 3.5 0 0 0 4.95 0l2.5-2.5a3.5 3.5 0 0 0-4.95-4.95l-1.25 1.25zm.45 9.45a.75.75 0 0 0-1.06-1.06l-1.25 1.25a2 2 0 0 1-2.83-2.83l2.5-2.5a2 2 0 0 1 2.83 0 .75.75 0 0 0 1.06-1.06 3.5 3.5 0 0 0-4.95 0l-2.5 2.5a3.5 3.5 0 0 0 4.95 4.95l1.25-1.25z"/></svg>`),
	sectionTransformation: svg(html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M1.5 1a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM2 4V2h2v2H2zm9.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM12 4V2h2v2h-2zM1.5 11a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zM2 14v-2h2v2H2zm9.5-3a.5.5 0 0 0-.5.5v3a.5.5 0 0 0 .5.5h3a.5.5 0 0 0 .5-.5v-3a.5.5 0 0 0-.5-.5h-3zm.5 3v-2h2v2h-2zM8 5.5a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5zm-3 3a.5.5 0 0 1 .5-.5h2a.5.5 0 0 1 0 1h-2a.5.5 0 0 1-.5-.5z"/></svg>`),
	sectionHtml: svg(html`<svg viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M5.616 4.928a.5.5 0 0 1-.044.706L2.72 8l2.852 2.366a.5.5 0 0 1-.662.75l-3.25-2.696a.5.5 0 0 1 0-.75l3.25-2.748a.5.5 0 0 1 .706.006zm4.768 0a.5.5 0 0 1 .706-.006l3.25 2.748a.5.5 0 0 1 0 .75l-3.25 2.696a.5.5 0 1 1-.662-.75L13.28 8l-2.852-2.366a.5.5 0 0 1-.044-.706zM9.288 2.553a.5.5 0 0 1 .159.689l-4 6.5a.5.5 0 1 1-.848-.53l4-6.5a.5.5 0 0 1 .689-.159z"/></svg>`),
	sectionSql: svg(html`<svg viewBox="0 0 16 16" fill="currentColor"><path d="M3 3.5C3 2.12 5.24 1 8 1s5 1.12 5 2.5V5c0 1.38-2.24 2.5-5 2.5S3 6.38 3 5V3.5zM8 2C5.79 2 4 2.67 4 3.5S5.79 5 8 5s4-.67 4-1.5S10.21 2 8 2zM3 7v2.5C3 10.88 5.24 12 8 12s5-1.12 5-2.5V7c-.84.88-2.74 1.5-5 1.5S3.84 7.88 3 7zm0 4.5V13c0 1.38 2.24 2.5 5 2.5s5-1.12 5-2.5v-1.5c-.84.88-2.74 1.5-5 1.5S3.84 12.38 3 11.5z"/></svg>`),

	// ── Codicon-only (previously raw spans in templates) ──────────────────────

	clearAll: codicon('clear-all'),
	tools: codicon('tools'),
	eye: codicon('eye'),
	trash: codicon('trash'),
	insert: codicon('insert'),
	linkExternal: codicon('link-external'),
	book: codicon('book'),
	notebook: codicon('notebook'),
	code: codicon('code'),
	comment: codicon('comment'),
	arrowUp: codicon('arrow-up'),
	arrowLeft: codicon('arrow-left'),
	debugStop: codicon('debug-stop'),
	discard: codicon('discard'),
	gitCompare: codicon('git-compare'),
	settingsGear: codicon('settings-gear'),

} as const;

// ── Section icons record (backward-compatible) ───────────────────────────────

/** Union of all section type identifiers used across the extension. */
export type SectionType = 'query' | 'markdown' | 'chart' | 'python' | 'url' | 'transformation' | 'html' | 'sql';

/** Small inline SVG icons for each section type — keyed by `SectionType`. */
export const sectionIcons: Record<SectionType, TemplateResult> = {
	query: ICONS.sectionQuery,
	markdown: ICONS.sectionMarkdown,
	chart: ICONS.sectionChart,
	python: ICONS.sectionPython,
	url: ICONS.sectionUrl,
	transformation: ICONS.sectionTransformation,
	html: ICONS.sectionHtml,
	sql: ICONS.sectionSql,
};

// ── Backward-compatible toolbar named exports ─────────────────────────────────

export const undoIcon = ICONS.toolbarUndo;
export const redoIcon = ICONS.toolbarRedo;
export const commentIcon = ICONS.toolbarComment;
export const prettifyIcon = ICONS.toolbarPrettify;
export const searchIcon = ICONS.toolbarSearch;
export const replaceIcon = ICONS.toolbarReplace;
export const indentIcon = ICONS.toolbarIndent;
export const outdentIcon = ICONS.toolbarOutdent;
export const commentSqlIcon = ICONS.toolbarCommentSql;
export const commentHtmlIcon = ICONS.toolbarCommentHtml;
export const wordWrapIcon = ICONS.toolbarWordWrap;
export const autocompleteIcon = ICONS.toolbarAutocomplete;
export const ghostIcon = ICONS.toolbarGhost;
export const caretDocsIcon = ICONS.toolbarCaretDocs;
export const powerBIIcon = ICONS.toolbarPowerBI;
export const toolsDoubleToSingleIcon = ICONS.toolbarDoubleToSingle;
export const toolsSingleToDoubleIcon = ICONS.toolbarSingleToDouble;
export const toolsQualifyTablesIcon = ICONS.toolbarQualifyTables;
export const toolsSingleLineIcon = ICONS.toolbarSingleLine;
export const toolsInlineFunctionIcon = ICONS.toolbarInlineFunction;
export const toolsRenameIcon = ICONS.toolbarRename;
export const exportIcon = ICONS.toolbarExport;
export const runIcon = ICONS.toolbarRun;
export const toolsCodiconIcon = ICONS.toolbarTools;
export const linkCodiconIcon = ICONS.toolbarLink;

// ── Styles ────────────────────────────────────────────────────────────────────

/**
 * CSS styles required for codicon-based icons to render in shadow DOM.
 * Adopt in `static styles` of any shadow DOM component that uses registry icons.
 * Future icon sources that need CSS can be added to this array.
 */
export const iconRegistryStyles: CSSResultGroup = [codiconSheet];
