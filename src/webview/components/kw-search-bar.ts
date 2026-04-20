import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-search-bar.styles.js';
import { customElement, property } from 'lit/decorators.js';
import type { SearchMode } from './search-utils.js';

/**
 * Pure-UI search bar: search icon + text input + mode toggle + prev/next nav + status + optional close button.
 * All search logic (debounce, regex, match finding) is owned by the consumer.
 */
@customElement('kw-search-bar')
export class KwSearchBar extends LitElement {
	static override styles = styles;

	@property() query = '';
	@property() mode: SearchMode = 'wildcard';
	@property({ type: Number }) matchCount = 0;
	@property({ type: Number }) currentMatch = 0;
	@property({ type: Boolean }) showClose = false;
	@property({ type: Boolean }) showStatus = true;

	override focus(): void {
		const inp = this.shadowRoot?.querySelector('input') as HTMLInputElement | null;
		if (inp) { inp.focus(); inp.select(); }
	}

	private _onInput(e: Event): void {
		const query = (e.target as HTMLInputElement).value;
		this.dispatchEvent(new CustomEvent('search-input', { detail: { query }, bubbles: true, composed: true }));
	}

	private _onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			this.dispatchEvent(new CustomEvent(e.shiftKey ? 'search-prev' : 'search-next', { bubbles: true, composed: true }));
		}
	}

	private _toggleMode(): void {
		const mode: SearchMode = this.mode === 'regex' ? 'wildcard' : 'regex';
		this.dispatchEvent(new CustomEvent('search-mode-change', { detail: { mode }, bubbles: true, composed: true }));
	}

	private _prev(): void {
		this.dispatchEvent(new CustomEvent('search-prev', { bubbles: true, composed: true }));
	}

	private _next(): void {
		this.dispatchEvent(new CustomEvent('search-next', { bubbles: true, composed: true }));
	}

	private _close(): void {
		this.dispatchEvent(new CustomEvent('search-close', { bubbles: true, composed: true }));
	}

	private _renderStatus(): TemplateResult | typeof nothing {
		if (!this.showStatus || !this.query.trim()) return nothing;
		const text = this.matchCount > 0
			? `(${this.currentMatch + 1}/${this.matchCount})`
			: 'No matches';
		return html`<span class="search-status">${text}</span>`;
	}

	override render(): TemplateResult {
		const isRegex = this.mode === 'regex';
		const navDisabled = this.matchCount < 1;

		return html`<div class="search-bar">
			<div class="search-control">
				<span class="search-icon" aria-hidden="true">
					<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>
				</span>
				<input type="text" class="search-input" placeholder="Search..." autocomplete="off" spellcheck="false"
					.value=${this.query}
					@input=${this._onInput}
					@keydown=${this._onKeydown} />
				${this._renderStatus()}
				<button type="button" class="mode-toggle"
					title="${isRegex ? 'Regex mode (click to switch to Wildcard)' : 'Wildcard mode (click to switch to Regex)'}"
					aria-label="${isRegex ? 'Regex mode' : 'Wildcard mode'}"
					@click=${this._toggleMode}>
					${isRegex
						? html`<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><text x="1" y="12" font-size="10" font-weight="bold" font-family="monospace">.*</text></svg>`
						: html`<svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><text x="3" y="12" font-size="11" font-weight="bold" font-family="monospace">*</text></svg>`
					}
				</button>
				<span class="nav-divider" aria-hidden="true"></span>
				<button type="button" class="nav-btn" title="Previous match (Shift+Enter)" aria-label="Previous match"
					?disabled=${navDisabled}
					@click=${this._prev}>
					<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 5.5L3.5 10l.707.707L8 6.914l3.793 3.793.707-.707L8 5.5z"/></svg>
				</button>
				<button type="button" class="nav-btn" title="Next match (Enter)" aria-label="Next match"
					?disabled=${navDisabled}
					@click=${this._next}>
					<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 10.5l4.5-4.5-.707-.707L8 9.086 4.207 5.293 3.5 6 8 10.5z"/></svg>
				</button>
			</div>
			${this.showClose ? html`<button type="button" class="close-btn" title="Close" aria-label="Close search" @click=${this._close}>
				<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>
			</button>` : nothing}
		</div>`;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-search-bar': KwSearchBar;
	}
}
