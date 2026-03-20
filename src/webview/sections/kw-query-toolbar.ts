/**
 * `<kw-query-toolbar>` — Light-DOM Lit element for the query editor toolbar.
 *
 * Renders the toolbar buttons (undo, redo, prettify, tools, search, replace,
 * toggle buttons, export, link) with reactive state and @click bindings,
 * replacing the legacy innerHTML + onclick="window.__kustoXxx()" pattern.
 *
 * Uses **light DOM** (no shadow root) so existing CSS from queryEditor.css
 * applies unchanged, and document.getElementById() works for external callers.
 */
import { LitElement, html, nothing } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { classMap } from 'lit/directives/class-map.js';
import {
	onQueryEditorToolbarAction,
	toggleCaretDocsEnabled,
	toggleAutoTriggerAutocompleteEnabled,
	toggleCopilotInlineCompletionsEnabled,
	closeRunMenu as closeRunMenuFn,
} from '../modules/queryBoxes-toolbar.js';
import { closeAllFavoritesDropdowns } from '../modules/queryBoxes.js';

// ─── SVG icon templates (raw strings, rendered via unsafeHTML-free innerHTML) ──

const undoIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>';

const redoIconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>';

const prettifyIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 3h12v2H2V3zm0 4h8v2H2V7zm0 4h12v2H2v-2z"/></svg>';

const searchIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M6.5 2a4.5 4.5 0 1 0 2.67 8.13l3.02 3.02a.75.75 0 0 0 1.06-1.06l-3.02-3.02A4.5 4.5 0 0 0 6.5 2zm0 1.5a3 3 0 1 1 0 6 3 3 0 0 1 0-6z"/></svg>';

const replaceIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" d="M2.5 4.5h8V3l3 2.5-3 2.5V6.5h-8v-2zM13.5 11.5h-8V13l-3-2.5 3-2.5v1.5h8v2z"/></svg>';

const autocompleteIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 4.5h10"/><path d="M3 7.5h6"/><path d="M3 10.5h4"/><path d="M10.2 9.2l2.3 2.3"/><path d="M12.5 9.2v2.3h-2.3"/></svg>';

const ghostIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M8 1C5.2 1 3 3.2 3 6v6c0 .3.1.6.4.8.2.2.5.2.8.1l1.3-.7 1.3.7c.3.2.7.2 1 0L8 12.2l.2.7c.3.2.7.2 1 0l1.3-.7 1.3.7c.3.1.6.1.8-.1.3-.2.4-.5.4-.8V6c0-2.8-2.2-5-5-5zm-2 6.5c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1zm4 0c-.6 0-1-.4-1-1s.4-1 1-1 1 .4 1 1-.4 1-1 1z"/></svg>';

const caretDocsIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 3.5h10v9H3v-9z"/><path d="M3 6h10"/><path d="M5 8.2h6"/><path d="M5 10.4h4.2"/></svg>';

const powerBIIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><rect x="2" y="10" width="3" height="4"/><rect x="6" y="6" width="3" height="8"/><rect x="10" y="3" width="3" height="11"/></svg>';

const toolsIconSvg = '<span class="codicon codicon-tools" aria-hidden="true"></span>';

const caretSvg = '<svg width="8" height="8" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 2.5L4 5.5L6.5 2.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// Tools menu sub-item icons
const toolsDoubleToSingleIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 3h4v4H3V3zm6 6h4v4H9V9z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>';
const toolsSingleToDoubleIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M3 9h4v4H3V9zm6-6h4v4H9V3z"/><path d="M7.5 7.5l1 1-1 1-1-1 1-1z"/></svg>';
const toolsQualifyTablesIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M2 2h12v3H2V2zm0 4h12v3H2V6zm0 4h7v3H2v-3zm8 0h4v3h-4v-3z"/></svg>';
const toolsSingleLineIconSvg = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M2 8h12"/></svg>';

// Overflow checkmark
const checkmarkSvg = '<svg class="qe-overflow-checkmark" viewBox="0 0 16 16" width="14" height="14" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M13.78 4.22a.75.75 0 0 1 0 1.06l-7.25 7.25a.75.75 0 0 1-1.06 0L2.22 9.28a.75.75 0 1 1 1.06-1.06L6 10.94l6.72-6.72a.75.75 0 0 1 1.06 0z"/></svg>';
const submenuArrowSvg = '<svg class="qe-overflow-submenu-arrow" viewBox="0 0 8 8" width="8" height="8" xmlns="http://www.w3.org/2000/svg"><path d="M2.5 1.5L5.5 4L2.5 6.5" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>';

// ─── Toolbar button descriptor ────────────────────────────────────────────────

interface ToolbarItem {
	type: 'button' | 'separator' | 'tools' | 'toggle';
	action?: string;
	label?: string;
	title?: string;
	overflowLabel?: string;
	iconSvg?: string;
	idSuffix?: string;
	toggleKey?: string;
	/** Extra CSS classes */
	extraClasses?: string;
	/** Whether button is initially disabled */
	disabled?: boolean;
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-query-toolbar')
export class KwQueryToolbar extends LitElement {

	@property({ type: String, attribute: 'box-id' })
	boxId = '';

	// ── Toggle button reactive state ──────────────────────────────────────────
	@state() private _caretDocsActive = false;
	@state() private _autoCompleteActive = false;
	@state() private _copilotInlineActive = false;
	@state() private _copilotChatActive = false;
	@state() private _copilotChatEnabled = false;

	// ── Copilot logo URI ──────────────────────────────────────────────────────
	private _copilotLogoUri = '';

	// ── Toolbar menu state ────────────────────────────────────────────────────
	@state() private _toolsMenuOpen = false;
	@state() private _toolsBusy = false;

	// ── Overflow state ────────────────────────────────────────────────────────
	@state() private _overflowStartIndex = -1; // -1 = no overflow
	@state() private _overflowMenuOpen = false;
	// Track which overflow submenu items are expanded (accordion)
	@state() private _overflowToolsExpanded = false;

	// ── ResizeObservers ───────────────────────────────────────────────────────
	private _toolbarResizeObserver: ResizeObserver | null = null;

	// ── Bound handlers for cleanup ────────────────────────────────────────────
	private _closeToolsOnOutside = this._onOutsideClickCloseTools.bind(this);
	private _closeOverflowOnOutside = this._onOutsideClickCloseOverflow.bind(this);
	private _onScrollDismiss = this._handleScrollDismiss.bind(this);
	private _onWheelDismiss = this._handleWheelDismiss.bind(this);
	// Scroll position when a menu was last opened (for 20px threshold dismiss)
	private _scrollAtMenuOpen = 0;

	// ── Static items list (describes the toolbar button order) ─────────────────
	private get _items(): ToolbarItem[] {
		return [
			{ type: 'button', action: 'undo', title: 'Undo (Ctrl+Z)', label: 'Undo', overflowLabel: 'Undo', iconSvg: undoIconSvg, extraClasses: 'qe-undo-btn' },
			{ type: 'button', action: 'redo', title: 'Redo (Ctrl+Y)', label: 'Redo', overflowLabel: 'Redo', iconSvg: redoIconSvg, extraClasses: 'qe-redo-btn' },
			{ type: 'separator' },
			{ type: 'button', action: 'prettify', title: 'Prettify query\nApplies Kusto-aware formatting rules (summarize/where/function headers)', label: 'Prettify query', overflowLabel: 'Prettify query', iconSvg: prettifyIconSvg },
			{ type: 'tools' },
			{ type: 'separator' },
			{ type: 'button', action: 'search', title: 'Search\nFind in the current query', label: 'Search', overflowLabel: 'Search', iconSvg: searchIconSvg },
			{ type: 'button', action: 'replace', title: 'Search and replace\nFind and replace in the current query', label: 'Search and replace', overflowLabel: 'Search and replace', iconSvg: replaceIconSvg },
			{ type: 'separator' },
			{ type: 'toggle', toggleKey: 'autoComplete', action: 'autoAutocomplete', idSuffix: '_auto_autocomplete_toggle', title: 'Automatically trigger schema-based completions dropdown as you type\nShortcut for manual trigger: CTRL + SPACE', label: 'Auto-completions as you type', overflowLabel: 'Auto-completions as you type', iconSvg: autocompleteIconSvg, extraClasses: 'qe-auto-autocomplete-toggle' },
			{ type: 'toggle', toggleKey: 'copilotInline', action: 'copilotInline', idSuffix: '_copilot_inline_toggle', title: 'Automatically trigger Copilot inline completions (ghost text) as you type\nShortcut for manual trigger: SHIFT + SPACE', label: 'Copilot inline suggestions', overflowLabel: 'Copilot inline suggestions', iconSvg: ghostIconSvg, extraClasses: 'qe-copilot-inline-toggle' },
			{ type: 'toggle', toggleKey: 'caretDocs', action: 'caretDocs', idSuffix: '_caret_docs_toggle', title: 'Smart documentation\nShows Kusto documentation based on cursor placement (not on mouse hover; on actual cursor placement inside the editor)', label: 'Smart documentation', overflowLabel: 'Smart documentation', iconSvg: caretDocsIconSvg },
			{ type: 'toggle', toggleKey: 'copilotChat', action: 'copilotChat', idSuffix: '_copilot_chat_toggle', title: 'Copilot chat\nGenerate and run a query with GitHub Copilot', label: 'Toggle Copilot chat', overflowLabel: 'Copilot chat', iconSvg: '', extraClasses: 'kusto-copilot-chat-toggle', disabled: true },
			{ type: 'separator' },
			{ type: 'button', action: 'exportPowerBI', title: 'Export to Power BI\nCopies a Power Query (M) snippet to your clipboard for pasting into Power BI', label: 'Export to Power BI', overflowLabel: 'Export to Power BI', iconSvg: powerBIIconSvg },
			{ type: 'button', action: 'copyAdeLink', title: 'Share query as link (Azure Data Explorer)\nCopies a shareable URL to your clipboard containing the cluster, database and active query', label: 'Share query as link (Azure Data Explorer)', overflowLabel: 'Share query as link', iconSvg: '<span class="codicon codicon-link" aria-hidden="true"></span>' },
		];
	}

	// ── Light DOM ─────────────────────────────────────────────────────────────
	override createRenderRoot(): HTMLElement | DocumentFragment {
		return this;
	}

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		// Resolve copilot logo URI once.
		try {
			this._copilotLogoUri = ((window as any).__kustoQueryEditorConfig && (window as any).__kustoQueryEditorConfig.copilotLogoUri)
				? String((window as any).__kustoQueryEditorConfig.copilotLogoUri)
				: '';
		} catch { /* ignore */ }
	}

	override firstUpdated(): void {
		// Set up toolbar overflow detection.
		this._initOverflowDetection();
		// Run button responsive behavior is handled by initToolbarOverflow() in
		// queryBoxes-toolbar.ts (called from monaco.ts after editor initialization).
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		if (this._toolbarResizeObserver) {
			this._toolbarResizeObserver.disconnect();
			this._toolbarResizeObserver = null;
		}
		this._removeMenuDismissListeners();
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render() {
		const id = this.boxId;
		const items = this._items;
		let btnIndex = 0; // counter of real buttons (not separators)
		return html`
			<div class="query-editor-toolbar" role="toolbar" aria-label="Editor tools" id="${id}_toolbar">
				<div class="qe-toolbar-items">
					${items.map((item, _i) => {
						if (item.type === 'separator') {
							const inOverflow = this._overflowStartIndex >= 0 && btnIndex >= this._overflowStartIndex;
							return html`<span class=${classMap({ 'query-editor-toolbar-sep': true, 'qe-in-overflow': inOverflow })} aria-hidden="true"></span>`;
						}
						const idx = btnIndex++;
						const inOverflow = this._overflowStartIndex >= 0 && idx >= this._overflowStartIndex;
						if (item.type === 'tools') {
							return this._renderToolsDropdown(inOverflow);
						}
						if (item.type === 'toggle') {
							return this._renderToggleButton(item, inOverflow);
						}
						return this._renderActionButton(item, idx, inOverflow);
					})}
				</div>
				${this._renderOverflowButton()}
			</div>
		`;
	}

	// ── Sub-renderers ─────────────────────────────────────────────────────────

	private _renderActionButton(item: ToolbarItem, _idx: number, inOverflow: boolean) {
		const id = this.boxId;
		const classes = {
			'unified-btn-secondary': true,
			'query-editor-toolbar-btn': true,
			'qe-in-overflow': inOverflow,
			...(item.extraClasses ? { [item.extraClasses]: true } : {}),
		};
		return html`
			<button type="button"
				class=${classMap(classes)}
				data-qe-overflow-action=${item.action || ''}
				data-qe-overflow-label=${item.overflowLabel || ''}
				title=${item.title || ''}
				aria-label=${item.label || ''}
				@click=${() => this._handleAction(item.action!)}
			><span class="qe-icon" aria-hidden="true" .innerHTML=${item.iconSvg || ''}></span></button>
		`;
	}

	private _renderToggleButton(item: ToolbarItem, inOverflow: boolean) {
		const id = this.boxId;
		const isActive = this._getToggleState(item.toggleKey!);
		const isDisabled = item.toggleKey === 'copilotChat' && !this._copilotChatEnabled;
		const isCopilotChat = item.toggleKey === 'copilotChat';
		const classes = {
			'unified-btn-secondary': true,
			'query-editor-toolbar-btn': true,
			'query-editor-toolbar-toggle': true,
			'is-active': isActive,
			'qe-in-overflow': inOverflow,
			...(item.extraClasses ? { [item.extraClasses]: true } : {}),
		};
		let iconHtml = item.iconSvg || '';
		if (isCopilotChat) {
			iconHtml = this._copilotLogoUri
				? '<img class="copilot-logo" src="' + this._copilotLogoUri + '" alt="" aria-hidden="true" />'
				: '<svg class="copilot-logo-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="10" height="9" rx="2" /><path d="M6 12v1" /><path d="M10 12v1" /><circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" /><circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" /><path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" /></svg>';
		}
		return html`
			<button type="button"
				id=${item.idSuffix ? id + item.idSuffix : ''}
				class=${classMap(classes)}
				data-qe-overflow-action=${item.action || ''}
				data-qe-overflow-label=${item.overflowLabel || ''}
				title=${item.title || ''}
				aria-label=${item.label || ''}
				aria-pressed=${isActive ? 'true' : 'false'}
				?disabled=${isDisabled}
				?aria-disabled=${isDisabled}
				@click=${() => this._handleToggle(item.toggleKey!)}
			><span class="qe-icon" aria-hidden="true" .innerHTML=${iconHtml}></span></button>
		`;
	}

	private _renderToolsDropdown(inOverflow: boolean) {
		const id = this.boxId;
		const wrapperClasses = {
			'qe-toolbar-menu-wrapper': true,
			'qe-in-overflow': inOverflow,
		};
		const btnClasses = {
			'unified-btn-secondary': true,
			'query-editor-toolbar-btn': true,
			'qe-toolbar-dropdown-btn': true,
			'is-active': this._toolsMenuOpen,
			'is-busy': this._toolsBusy,
		};
		return html`
			<span class=${classMap(wrapperClasses)} id="${id}_tools_wrapper">
				<button type="button"
					class=${classMap(btnClasses)}
					id="${id}_tools_btn"
					title="Tools"
					aria-label="Tools"
					aria-haspopup="listbox"
					aria-expanded=${this._toolsMenuOpen ? 'true' : 'false'}
					@click=${this._onToolsClick}
				>
					<span class="qe-icon qe-tools-icon" aria-hidden="true"
						style=${this._toolsBusy ? 'display:none;' : ''}
						.innerHTML=${toolsIconSvg}></span>
					<span class="qe-toolbar-caret" aria-hidden="true"
						style=${this._toolsBusy ? 'display:none;' : ''}
						.innerHTML=${caretSvg}></span>
					<span class="schema-spinner qe-tools-spinner" aria-hidden="true"
						style=${this._toolsBusy ? '' : 'display:none;'}></span>
				</button>
				${this._toolsMenuOpen ? this._renderToolsMenu() : html`<div class="kusto-dropdown-menu qe-toolbar-dropdown-menu" id="${id}_tools_menu" role="listbox" tabindex="-1" style="display:none;"></div>`}
			</span>
		`;
	}

	private _renderToolsMenu() {
		const id = this.boxId;
		const toolsItems = [
			{ action: 'doubleToSingle', label: 'Replace " with \'', iconSvg: toolsDoubleToSingleIconSvg },
			{ action: 'singleToDouble', label: 'Replace \' with "', iconSvg: toolsSingleToDoubleIconSvg },
			{ action: 'qualifyTables', label: 'Fully qualify tables', iconSvg: toolsQualifyTablesIconSvg },
			{ action: 'singleLine', label: 'Copy query as single line', iconSvg: toolsSingleLineIconSvg },
		];
		return html`
			<div class="kusto-dropdown-menu qe-toolbar-dropdown-menu" id="${id}_tools_menu" role="listbox" tabindex="-1"
				style="display:block; width:max-content; min-width:0;"
				@mousedown=${(e: Event) => e.stopPropagation()}
				@click=${(e: Event) => e.stopPropagation()}>
				${toolsItems.map(ti => html`
					<div class="kusto-dropdown-item" role="option" tabindex="-1"
						@click=${() => this._onToolsItemClick(ti.action)}>
						<div class="kusto-dropdown-item-main">
							<span class="qe-icon" aria-hidden="true" .innerHTML=${ti.iconSvg}></span>
							<span class="qe-toolbar-menu-label">${ti.label}</span>
						</div>
					</div>
				`)}
			</div>
		`;
	}

	private _renderOverflowButton() {
		const id = this.boxId;
		const isVisible = this._overflowStartIndex >= 0;
		if (!isVisible) return nothing;

		return html`
			<span class="qe-toolbar-overflow-wrapper is-visible" id="${id}_toolbar_overflow_wrapper">
				<button type="button"
					class=${classMap({ 'qe-toolbar-overflow-btn': true, 'is-active': this._overflowMenuOpen })}
					id="${id}_toolbar_overflow_btn"
					title="More actions"
					aria-label="More actions"
					aria-haspopup="true"
					aria-expanded=${this._overflowMenuOpen ? 'true' : 'false'}
					@click=${this._onOverflowClick}
				><span aria-hidden="true">···</span></button>
				${this._overflowMenuOpen ? this._renderOverflowMenu() : nothing}
			</span>
		`;
	}

	private _renderOverflowMenu() {
		const id = this.boxId;
		const items = this._items;
		const overflowIdx = this._overflowStartIndex;
		if (overflowIdx < 0) return nothing;

		// Collect button items that are in overflow
		let btnIndex = 0;
		const hiddenItems: ToolbarItem[] = [];
		for (const item of items) {
			if (item.type === 'separator') continue;
			if (btnIndex >= overflowIdx) hiddenItems.push(item);
			btnIndex++;
		}
		if (!hiddenItems.length) return nothing;

		const hasAnyToggle = hiddenItems.some(i => i.type === 'toggle');
		const emptyPlaceholder = hasAnyToggle ? html`<span class="qe-overflow-checkmark-placeholder" style="width:14px;height:14px;display:inline-block;"></span>` : nothing;

		// Build overflow items with separators between groups
		const overflowEntries: unknown[] = [];
		let lastGroup = '';
		let btnIdx2 = 0;
		for (const item of items) {
			if (item.type === 'separator') {
				if (lastGroup) lastGroup = 'sep'; // mark that a separator was seen
				continue;
			}
			if (btnIdx2 < overflowIdx) { btnIdx2++; continue; }
			btnIdx2++;
			// Add separator before new group (if there was a sep marker)
			if (lastGroup === 'sep' && overflowEntries.length > 0) {
				overflowEntries.push(html`<div class="qe-toolbar-overflow-sep"></div>`);
			}
			lastGroup = 'item';

			if (item.type === 'tools') {
				overflowEntries.push(this._renderOverflowToolsSubmenu(hasAnyToggle));
				continue;
			}

			const isToggle = item.type === 'toggle';
			const isActive = isToggle && this._getToggleState(item.toggleKey!);
			const isDisabled = isToggle && item.toggleKey === 'copilotChat' && !this._copilotChatEnabled;
			const isCopilotChat = item.toggleKey === 'copilotChat';
			let iconSvg = item.iconSvg || '';
			if (isCopilotChat) {
				iconSvg = this._copilotLogoUri
					? '<img class="copilot-logo" src="' + this._copilotLogoUri + '" alt="" aria-hidden="true" />'
					: '<svg class="copilot-logo-svg" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect x="3" y="3" width="10" height="9" rx="2" /><path d="M6 12v1" /><path d="M10 12v1" /><circle cx="6.5" cy="7" r=".8" fill="currentColor" stroke="none" /><circle cx="9.5" cy="7" r=".8" fill="currentColor" stroke="none" /><path d="M6.2 9.2c.6.5 1.2.8 1.8.8s1.2-.3 1.8-.8" /></svg>';
			}

			overflowEntries.push(html`
				<div class=${classMap({ 'qe-toolbar-overflow-item': true, 'qe-overflow-item-active': isActive })}
					role="menuitem" tabindex="-1"
					style=${isDisabled ? 'opacity:0.5;cursor:default;' : ''}
					aria-disabled=${isDisabled ? 'true' : 'false'}
					@click=${() => !isDisabled && this._onOverflowItemClick(item)}>
					${hasAnyToggle ? (isToggle && isActive ? html`<span .innerHTML=${checkmarkSvg}></span>` : emptyPlaceholder) : nothing}
					<span class="qe-icon" aria-hidden="true" .innerHTML=${iconSvg}></span>
					<span class="qe-toolbar-overflow-label">${item.overflowLabel || item.label || ''}</span>
				</div>
			`);
		}

		return html`
			<div class="qe-toolbar-overflow-menu kusto-dropdown-menu" id="${id}_toolbar_overflow_menu"
				role="menu" tabindex="-1"
				@mousedown=${(e: Event) => e.stopPropagation()}
				@click=${(e: Event) => e.stopPropagation()}>
				${overflowEntries}
			</div>
		`;
	}

	private _renderOverflowToolsSubmenu(hasAnyToggle: boolean) {
		const emptyPlaceholder = hasAnyToggle ? html`<span class="qe-overflow-checkmark-placeholder" style="width:14px;height:14px;display:inline-block;"></span>` : nothing;
		const subItems = [
			{ action: 'doubleToSingle', label: 'Replace " with \'', iconSvg: toolsDoubleToSingleIconSvg },
			{ action: 'singleToDouble', label: 'Replace \' with "', iconSvg: toolsSingleToDoubleIconSvg },
			{ action: 'qualifyTables', label: 'Fully qualify tables', iconSvg: toolsQualifyTablesIconSvg },
			{ action: 'singleLine', label: 'Copy query as single line', iconSvg: toolsSingleLineIconSvg },
		];
		return html`
			<div class="qe-toolbar-overflow-item qe-overflow-has-submenu" role="menuitem" tabindex="-1"
				aria-expanded=${this._overflowToolsExpanded ? 'true' : 'false'}
				@click=${this._onOverflowToolsToggle}>
				${emptyPlaceholder}
				<span class="qe-icon" aria-hidden="true" .innerHTML=${toolsIconSvg}></span>
				<span class="qe-toolbar-overflow-label">Tools</span>
				<span .innerHTML=${submenuArrowSvg}></span>
			</div>
			<div class=${classMap({ 'qe-toolbar-overflow-submenu-items': true, 'is-expanded': this._overflowToolsExpanded })}>
				${subItems.map(si => html`
					<div class="qe-toolbar-overflow-item qe-overflow-submenu-item" role="menuitem" tabindex="-1"
						@click=${() => this._onOverflowSubItemClick(si.action)}>
						<span class="qe-icon" aria-hidden="true" .innerHTML=${si.iconSvg}></span>
						<span class="qe-toolbar-overflow-label">${si.label}</span>
					</div>
				`)}
			</div>
		`;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _handleAction(action: string): void {
		onQueryEditorToolbarAction(this.boxId, action);
	}

	private _handleToggle(toggleKey: string): void {
		if (toggleKey === 'caretDocs') toggleCaretDocsEnabled();
		else if (toggleKey === 'autoComplete') toggleAutoTriggerAutocompleteEnabled();
		else if (toggleKey === 'copilotInline') toggleCopilotInlineCompletionsEnabled();
		else if (toggleKey === 'copilotChat') {
			// Delegate to the kw-query-section element's toggleCopilotChat() method.
			try {
				const kwEl = document.getElementById(this.boxId) as any;
				if (kwEl && typeof kwEl.toggleCopilotChat === 'function') kwEl.toggleCopilotChat();
			} catch (e) { console.error('[kusto]', e); }
		}
	}

	private _onToolsClick(e: Event): void {
		e.stopPropagation();
		const wasOpen = this._toolsMenuOpen;
		// Close other menus first.
		try { closeRunMenuFn(this.boxId); } catch (e) { console.error('[kusto]', e); }
		try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
		this._closeOverflow();
		this._toolsMenuOpen = !wasOpen;
		if (this._toolsMenuOpen) {
			// Position the menu after render.
			this.updateComplete.then(() => this._positionToolsMenu());
			this._addMenuDismissListeners();
		} else {
			this._removeMenuDismissListeners();
		}
	}

	private _onToolsItemClick(action: string): void {
		this._closeTools();
		onQueryEditorToolbarAction(this.boxId, action);
	}

	private _onOverflowClick(e: Event): void {
		e.stopPropagation();
		const wasOpen = this._overflowMenuOpen;
		// Close other menus first.
		try { closeRunMenuFn(this.boxId); } catch (e) { console.error('[kusto]', e); }
		try { closeAllFavoritesDropdowns(); } catch (e) { console.error('[kusto]', e); }
		this._closeTools();
		this._overflowMenuOpen = !wasOpen;
		this._overflowToolsExpanded = false;
		if (this._overflowMenuOpen) {
			this.updateComplete.then(() => this._positionOverflowMenu());
			this._addMenuDismissListeners();
		} else {
			this._removeMenuDismissListeners();
		}
	}

	private _onOverflowItemClick(item: ToolbarItem): void {
		this._closeOverflow();
		if (item.type === 'toggle') {
			this._handleToggle(item.toggleKey!);
		} else {
			this._handleAction(item.action!);
		}
	}

	private _onOverflowToolsToggle(e: Event): void {
		e.stopPropagation();
		this._overflowToolsExpanded = !this._overflowToolsExpanded;
	}

	private _onOverflowSubItemClick(action: string): void {
		this._closeOverflow();
		onQueryEditorToolbarAction(this.boxId, action);
	}

	// ── Close helpers ─────────────────────────────────────────────────────────

	private _closeTools(): void {
		if (!this._toolsMenuOpen) return;
		this._toolsMenuOpen = false;
		this._removeMenuDismissListeners();
	}

	private _closeOverflow(): void {
		if (!this._overflowMenuOpen) return;
		this._overflowMenuOpen = false;
		this._overflowToolsExpanded = false;
		this._removeMenuDismissListeners();
	}

	/** Close all menus (called externally or on scroll). */
	public closeAllMenus(): void {
		this._closeTools();
		this._closeOverflow();
	}

	private _addMenuDismissListeners(): void {
		this._scrollAtMenuOpen = document.documentElement.scrollTop || document.body.scrollTop || 0;
		setTimeout(() => {
			document.addEventListener('mousedown', this._closeToolsOnOutside);
			document.addEventListener('mousedown', this._closeOverflowOnOutside);
			document.addEventListener('scroll', this._onScrollDismiss, true);
			document.addEventListener('wheel', this._onWheelDismiss, { passive: true } as any);
		}, 0);
	}

	private _removeMenuDismissListeners(): void {
		document.removeEventListener('mousedown', this._closeToolsOnOutside);
		document.removeEventListener('mousedown', this._closeOverflowOnOutside);
		document.removeEventListener('scroll', this._onScrollDismiss, true);
		document.removeEventListener('wheel', this._onWheelDismiss);
	}

	private _handleScrollDismiss(): void {
		if (!this._toolsMenuOpen && !this._overflowMenuOpen) return;
		const scrollY = document.documentElement.scrollTop || document.body.scrollTop || 0;
		if (Math.abs(scrollY - this._scrollAtMenuOpen) > 20) {
			this.closeAllMenus();
		}
	}

	private _handleWheelDismiss(): void {
		this.closeAllMenus();
	}

	private _onOutsideClickCloseTools(e: MouseEvent): void {
		const path = e.composedPath();
		const wrapper = this.querySelector('#' + CSS.escape(this.boxId + '_tools_wrapper'));
		if (wrapper && path.includes(wrapper)) return;
		this._closeTools();
	}

	private _onOutsideClickCloseOverflow(e: MouseEvent): void {
		const path = e.composedPath();
		const wrapper = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar_overflow_wrapper'));
		if (wrapper && path.includes(wrapper)) return;
		this._closeOverflow();
	}

	// ── Positioning ───────────────────────────────────────────────────────────

	private _positionToolsMenu(): void {
		const btn = this.querySelector('#' + CSS.escape(this.boxId + '_tools_btn')) as HTMLElement | null;
		const menu = this.querySelector('#' + CSS.escape(this.boxId + '_tools_menu')) as HTMLElement | null;
		if (!btn || !menu) return;
		const rect = btn.getBoundingClientRect();
		menu.style.position = 'fixed';
		menu.style.top = rect.bottom + 'px';
		menu.style.left = rect.left + 'px';
		menu.style.zIndex = '10000';
	}

	private _positionOverflowMenu(): void {
		const btn = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar_overflow_btn')) as HTMLElement | null;
		const menu = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar_overflow_menu')) as HTMLElement | null;
		if (!btn || !menu) return;
		const btnRect = btn.getBoundingClientRect();
		const viewportWidth = window.innerWidth || document.documentElement.clientWidth || 0;
		menu.style.position = 'fixed';
		menu.style.top = btnRect.bottom + 'px';
		menu.style.zIndex = '10000';
		// Right-align if it would overflow the viewport.
		let left = btnRect.left;
		requestAnimationFrame(() => {
			const menuRect = menu.getBoundingClientRect();
			if (left + menuRect.width > viewportWidth - 8) left = btnRect.right - menuRect.width;
			if (left < 8) left = 8;
			menu.style.left = left + 'px';
		});
	}

	// ── Overflow detection ────────────────────────────────────────────────────

	// Cached natural widths of each toolbar child (measured once on first render when all are visible).
	private _cachedItemWidths: number[] | null = null;

	private _initOverflowDetection(): void {
		// Observe the toolbar itself AND the query-editor-wrapper (whose width
		// changes when the Copilot chat panel opens/closes or the window resizes).
		const toolbar = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar'));
		if (!toolbar) return;
		if (this._toolbarResizeObserver) {
			this._toolbarResizeObserver.disconnect();
		}
		const scheduleOverflow = () => {
			this._computeOverflow();
		};
		this._toolbarResizeObserver = new ResizeObserver(scheduleOverflow);
		this._toolbarResizeObserver.observe(toolbar);
		// Also observe the query-editor-wrapper to catch width changes from
		// the Copilot chat panel opening/closing — the toolbar itself doesn't
		// resize, its parent does.
		const wrapper = toolbar.closest('.query-editor-wrapper');
		if (wrapper) this._toolbarResizeObserver.observe(wrapper);
		// Cache natural widths before any overflow is applied.
		requestAnimationFrame(() => {
			this._cacheItemWidths();
			this._computeOverflow();
		});
	}

	/** Measure and cache the natural width of each toolbar item (before overflow hides any). */
	private _cacheItemWidths(): void {
		if (this._cachedItemWidths) return; // Already cached.
		const toolbar = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar')) as HTMLElement | null;
		const itemsContainer = toolbar?.querySelector('.qe-toolbar-items') as HTMLElement | null;
		if (!itemsContainer) return;
		const items = Array.from(itemsContainer.children) as HTMLElement[];
		if (!items.length) return;
		// Only cache if no items are currently hidden (all widths > 0).
		const widths = items.map(item => item.offsetWidth);
		if (widths.some(w => w === 0)) return; // Some items hidden, can't cache yet.
		this._cachedItemWidths = widths;
	}

	private _computeOverflow(): void {
		const toolbar = this.querySelector('#' + CSS.escape(this.boxId + '_toolbar')) as HTMLElement | null;
		const itemsContainer = toolbar?.querySelector('.qe-toolbar-items') as HTMLElement | null;
		if (!toolbar || !itemsContainer) return;

		const items = Array.from(itemsContainer.children) as HTMLElement[];
		if (!items.length) return;

		// Re-cache if item count changed (e.g., Lit re-rendered more/fewer buttons).
		if (this._cachedItemWidths && this._cachedItemWidths.length !== items.length) {
			this._cachedItemWidths = null;
		}

		// Try to cache widths if we don't have them yet.
		if (!this._cachedItemWidths) {
			this._cacheItemWidths();
		}

		const toolbarStyle = getComputedStyle(toolbar);
		const paddingLeft = parseFloat(toolbarStyle.paddingLeft) || 0;
		const paddingRight = parseFloat(toolbarStyle.paddingRight) || 0;
		const gap = parseFloat(getComputedStyle(itemsContainer).gap) || 4;
		const overflowBtnWidth = 36;
		const availableWidth = toolbar.clientWidth - paddingLeft - paddingRight - overflowBtnWidth - gap;

		const prevOverflow = this._overflowStartIndex;
		let totalWidth = 0;
		let newOverflowStart = -1;

		// Track which DOM child index corresponds to which "button index"
		// (button index = non-separator items; matches the btnIndex counter in render()).
		let btnIdx = 0;

		for (let i = 0; i < items.length; i++) {
			const item = items[i];
			const isSep = item.classList.contains('query-editor-toolbar-sep');
			// Use cached width if available; otherwise use live measurement.
			const rawWidth = this._cachedItemWidths ? this._cachedItemWidths[i] : item.offsetWidth;
			const itemWidth = rawWidth + (i > 0 ? gap : 0);
			totalWidth += itemWidth;

			if (totalWidth > availableWidth && newOverflowStart === -1) {
				// The overflow starts at this item. But if this is a non-separator,
				// try to back up to the previous separator for a clean visual break.
				newOverflowStart = btnIdx;
				// Walk backwards to find a separator to use as the break point.
				for (let j = i - 1; j >= 0; j--) {
					if (items[j].classList.contains('query-editor-toolbar-sep')) {
						// Count non-separator items before this separator.
						newOverflowStart = this._countButtonsBefore(items, j);
						break;
					}
				}
				break; // No need to continue.
			}

			if (!isSep) btnIdx++;
		}

		if (newOverflowStart !== prevOverflow) {
			this._overflowStartIndex = newOverflowStart;
		}
	}

	/** Count how many non-separator items appear before index `upTo`. */
	private _countButtonsBefore(items: HTMLElement[], upTo: number): number {
		let count = 0;
		for (let i = 0; i < upTo; i++) {
			if (!items[i].classList.contains('query-editor-toolbar-sep')) count++;
		}
		return count;
	}

	// ── Public API (called by legacy code) ────────────────────────────────────

	/** Update toggle button states (called by updateCaretDocsToggleButtons etc.). */
	public setCaretDocsActive(active: boolean): void { this._caretDocsActive = active; }
	public setAutoCompleteActive(active: boolean): void { this._autoCompleteActive = active; }
	public setCopilotInlineActive(active: boolean): void { this._copilotInlineActive = active; }
	public setCopilotChatActive(active: boolean): void { this._copilotChatActive = active; }
	public setCopilotChatEnabled(enabled: boolean): void { this._copilotChatEnabled = enabled; }

	/** Set the tools button busy state (e.g. during qualify-tables). */
	public setToolsBusy(busy: boolean): void { this._toolsBusy = busy; }

	// ── Private helpers ───────────────────────────────────────────────────────

	private _getToggleState(key: string): boolean {
		switch (key) {
			case 'caretDocs': return this._caretDocsActive;
			case 'autoComplete': return this._autoCompleteActive;
			case 'copilotInline': return this._copilotInlineActive;
			case 'copilotChat': return this._copilotChatActive;
			default: return false;
		}
	}
}
