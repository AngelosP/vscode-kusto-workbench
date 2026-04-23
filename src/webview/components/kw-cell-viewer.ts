import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-cell-viewer.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { customElement, property, state } from 'lit/decorators.js';
import { buildSearchRegex, navigateMatch, type SearchMode } from './search-utils.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';
import './kw-search-bar.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function escapeHtml(s: unknown): string {
	let str = s !== null && s !== undefined ? String(s) : '';
	str = str.replace(/&/g, '&amp;');
	str = str.replace(/</g, '&lt;');
	str = str.replace(/>/g, '&gt;');
	str = str.replace(/"/g, '&quot;');
	str = str.replace(/'/g, '&#39;');
	return str;
}

/** Highlight search matches in plain text, returning HTML with <span> wrappers. */
function highlightPlainText(text: string, regex: RegExp, maxMatches = 5000): { html: string; count: number } {
	regex.lastIndex = 0;
	let result = '';
	let lastIndex = 0;
	let count = 0;
	let m: RegExpExecArray | null;
	while ((m = regex.exec(text)) !== null) {
		if (!m[0]) { regex.lastIndex++; continue; }
		if (m.index > lastIndex) result += escapeHtml(text.slice(lastIndex, m.index));
		result += '<span class="cell-highlight" data-match-index="' + count + '">' + escapeHtml(m[0]) + '</span>';
		lastIndex = m.index + m[0].length;
		count++;
		if (count >= maxMatches) break;
	}
	if (lastIndex < text.length) result += escapeHtml(text.slice(lastIndex));
	return { html: result, count };
}

// ─── Copy-to-clipboard helper ─────────────────────────────────────────────────

function writeTextToClipboard(text: string, vscodePostMessage?: (msg: unknown) => void): void {
	if (vscodePostMessage) {
		vscodePostMessage({ type: 'copyToClipboard', text });
		return;
	}
	try {
		if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
			void navigator.clipboard.writeText(text);
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ─── Component ────────────────────────────────────────────────────────────────

@customElement('kw-cell-viewer')
export class KwCellViewer extends LitElement {

	@property({ type: Boolean }) open = false;

	/** Optional: used for clipboard via extension postMessage */
	copyCallback?: (msg: unknown) => void;

	@state() private _title = '';
	@state() private _rawValue = '';
	@state() private _searchQuery = '';
	@state() private _searchMode: SearchMode = 'wildcard';
	@state() private _currentMatchIndex = 0;
	private _matchCount = 0;

	// ── Public API ────────────────────────────────────────────────────────────

	private _dismissCb = (): void => { this.hide(); };

	show(columnName: string, rawValue: string, options?: { searchQuery?: string; searchMode?: SearchMode }): void {
		this._title = columnName;
		this._rawValue = rawValue;
		this._searchQuery = options?.searchQuery ?? '';
		this._searchMode = options?.searchMode ?? 'wildcard';
		this._currentMatchIndex = 0;
		this._matchCount = 0;
		this.open = true;
		pushDismissable(this._dismissCb);
	}

	hide(): void {
		this.open = false;
		this._rawValue = '';
		removeDismissable(this._dismissCb);
	}

	get matchCount(): number { return this._matchCount; }

	// ── Render ────────────────────────────────────────────────────────────────

	protected render(): TemplateResult | typeof nothing {
		if (!this.open) return nothing;

		const { regex, error: searchError } = buildSearchRegex(this._searchQuery, this._searchMode);
		let contentHtml: string;
		let matchCount = 0;

		if (regex && !searchError && this._searchQuery.trim()) {
			const result = highlightPlainText(this._rawValue, regex);
			contentHtml = result.html;
			matchCount = result.count;
		} else {
			contentHtml = escapeHtml(this._rawValue);
		}
		this._matchCount = matchCount;

		return html`
			<div class="modal-backdrop" @click=${this.hide}>
				<div class="modal-content" @click=${(e: Event) => e.stopPropagation()}>
					<div class="modal-header">
						<h3>Cell viewer for <strong>${this._title}</strong></h3>
						<div class="search-area">
							${this._renderSearchControl(matchCount, searchError)}
						</div>
						<div class="actions">
							<button class="tool-btn" type="button" title="Copy to clipboard" aria-label="Copy to clipboard"
								@click=${this._copyContent}>
								<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">
									<rect x="5" y="5" width="9" height="9" rx="2" /><path d="M3 11V4c0-1.1.9-2 2-2h7" />
								</svg>
							</button>
						</div>
						<button class="close-btn" type="button" title="Close" aria-label="Close" @click=${this.hide}>
							<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg">
								<path d="M4 4l8 8" /><path d="M12 4L4 12" />
							</svg>
						</button>
					</div>
					<div class="modal-body">
						<div class="cell-value" .innerHTML=${contentHtml}></div>
					</div>
				</div>
			</div>
		`;
	}

	protected updated(): void {
		if (this.open && this._matchCount > 0) {
			this._applyCurrentMatchHighlight();
		}
	}

	// ── Search ────────────────────────────────────────────────────────────────

	private _renderSearchControl(matchCount: number, searchError: string | null): TemplateResult {
		return html`
			<kw-search-bar
				.query=${this._searchQuery}
				.mode=${this._searchMode}
				.matchCount=${matchCount}
				.currentMatch=${this._currentMatchIndex}
				.showClose=${false}
				.showStatus=${true}
				@search-input=${(e: CustomEvent) => { this._searchQuery = e.detail.query; this._currentMatchIndex = 0; }}
				@search-mode-change=${(e: CustomEvent) => { this._searchMode = e.detail.mode; this._currentMatchIndex = 0; }}
				@search-next=${this._navigateNextMatch}
				@search-prev=${this._navigatePrevMatch}
			></kw-search-bar>
			${searchError ? html`<span class="search-results">${searchError}</span>` : nothing}
		`;
	}

	private _navigateNextMatch(): void {
		if (this._matchCount < 2) return;
		this._currentMatchIndex = navigateMatch(this._currentMatchIndex, this._matchCount, 'next');
		this._applyCurrentMatchHighlight();
	}

	private _navigatePrevMatch(): void {
		if (this._matchCount < 2) return;
		this._currentMatchIndex = navigateMatch(this._currentMatchIndex, this._matchCount, 'prev');
		this._applyCurrentMatchHighlight();
	}

	private _applyCurrentMatchHighlight(): void {
		const root = this.shadowRoot;
		if (!root) return;
		const highlights = root.querySelectorAll('.cell-highlight');
		for (const el of highlights) el.classList.remove('cell-highlight-current');
		const target = highlights[this._currentMatchIndex];
		if (!target) return;
		target.classList.add('cell-highlight-current');
		try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* ignore */ }
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	private _copyContent(): void {
		// If there's a text selection within the content, copy that; otherwise copy all.
		let textToCopy = '';
		try {
			const sel = window.getSelection?.();
			const valueEl = this.shadowRoot?.querySelector('.cell-value');
			if (sel && !sel.isCollapsed && valueEl && sel.anchorNode && sel.focusNode) {
				const root = this.shadowRoot;
				if (root && root.contains(sel.anchorNode) && root.contains(sel.focusNode)) {
					textToCopy = sel.toString();
				}
			}
		} catch { /* ignore */ }
		if (!textToCopy) textToCopy = this._rawValue;
		writeTextToClipboard(textToCopy, this.copyCallback);
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static styles = [scrollbarSheet, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-cell-viewer': KwCellViewer;
	}
}
