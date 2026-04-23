import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styles } from './kw-schema-info.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import {
	setupClickOutsideDismiss,
	setupScrollDismiss,
	pushDismissable,
	removeDismissable,
} from './popup-dismiss.js';

// ─── Types ────────────────────────────────────────────────────────────────────

/** Schema info display state. */
export interface SchemaInfoState {
	status: 'not-loaded' | 'loading' | 'loaded' | 'cached' | 'error';
	statusText?: string;
	tables?: number;
	cols?: number;
	funcs?: number;
	cached?: boolean;
	errorMessage?: string;
}

// ─── SVG Icons ────────────────────────────────────────────────────────────────

const schemaInfoIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 1C4.13 1 1 4.13 1 8s3.13 7 7 7 7-3.13 7-7-3.13-7-7-7zm0 12.5c-3.04 0-5.5-2.46-5.5-5.5S4.96 2.5 8 2.5s5.5 2.46 5.5 5.5-2.46 5.5-5.5 5.5zM7.25 5h1.5v1.5h-1.5V5zm0 2.5h1.5v4h-1.5v-4z"/></svg>`;

const refreshIconSvg = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3.5 8a4.5 4.5 0 0 1 7.8-3.1"/><polyline points="11.3 2.7 11.3 5.4 8.6 5.4"/><path d="M12.5 8a4.5 4.5 0 0 1-7.8 3.1"/><polyline points="4.7 13.3 4.7 10.6 7.4 10.6"/></svg>`;

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-schema-info>` — Schema info button with popover showing schema status,
 * table/column/function counts, and a refresh action.
 *
 * @fires schema-refresh     Dispatched when the user clicks "Refresh Schema".
 * @fires see-cached-values  Dispatched when the user clicks the "Cached" link.
 */
@customElement('kw-schema-info')
export class KwSchemaInfo extends LitElement {

	static override styles = [scrollbarSheet, styles];

	// ── Reactive state ────────────────────────────────────────────────────────

	@state() private _info: SchemaInfoState = { status: 'not-loaded' };
	@state() private _open = false;

	// ── Dismiss cleanup handles ───────────────────────────────────────────────
	private _cleanupClickOutside: (() => void) | null = null;
	private _cleanupScroll: (() => void) | null = null;
	private _dismissCallback = (): void => { this.close(); };

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		this._teardownDismiss();
	}

	// ── Render ────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		const si = this._info;
		const btnClass = [
			'schema-info-btn',
			si.status === 'loading' ? 'is-loading' : '',
			si.status === 'loaded' || si.status === 'cached' ? 'has-schema' : '',
			si.status === 'cached' ? 'is-cached' : '',
			si.status === 'error' ? 'is-error' : '',
			this._open ? 'is-open' : '',
		].filter(Boolean).join(' ');

		return html`
			<button type="button" class="${btnClass}"
				title="Schema info" aria-label="Schema info"
				aria-haspopup="true" aria-expanded="${this._open ? 'true' : 'false'}"
				@click=${this._toggle}
				@mousedown=${(e: Event) => e.stopPropagation()}>
				${schemaInfoIconSvg}
			</button>
			${this._open ? this._renderPopover() : nothing}
		`;
	}

	private _renderPopover(): TemplateResult {
		const si = this._info;
		const statusText = si.statusText
			|| (si.status === 'not-loaded' ? 'Not loaded'
				: si.status === 'loading' ? 'Loading...'
				: si.status === 'loaded' ? 'Loaded'
				: si.status === 'cached' ? 'Cached'
				: si.status === 'error' ? (si.errorMessage || 'Error')
				: 'Unknown');
		const statusClass = si.status === 'error' ? 'schema-info-status is-error' : 'schema-info-status';

		return html`
			<div class="schema-info-popover" role="tooltip"
				@mousedown=${(e: Event) => e.stopPropagation()}>
				<div class="schema-info-popover-content">
					<div class="schema-info-row">
						<span class="schema-info-label">Status:</span>
						<span class="${statusClass}">${statusText}</span>
					</div>
					${(si.status === 'loaded' || si.status === 'cached') && si.tables !== undefined ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Tables:</span>
							<span class="schema-info-value">${si.tables}</span>
						</div>
					` : nothing}
					${(si.status === 'loaded' || si.status === 'cached') && si.cols !== undefined ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Columns:</span>
							<span class="schema-info-value">${si.cols}</span>
						</div>
					` : nothing}
					${(si.status === 'loaded' || si.status === 'cached') && si.funcs !== undefined ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Functions:</span>
							<span class="schema-info-value">${si.funcs}</span>
						</div>
					` : nothing}
					${si.cached ? html`
						<div class="schema-info-row">
							<span class="schema-info-label">Source:</span>
							<a href="#" class="schema-info-cached-link"
								@click=${(e: Event) => { e.preventDefault(); e.stopPropagation(); this._onSeeCachedValues(); }}>Cached</a>
						</div>
					` : nothing}
					<div class="schema-info-actions">
						<button type="button" class="schema-info-refresh-btn"
							@click=${(e: Event) => { e.stopPropagation(); this._onSchemaRefresh(); }}>
							${refreshIconSvg}
							<span>Refresh Schema</span>
						</button>
					</div>
				</div>
			</div>
		`;
	}

	override updated(changedProps: Map<string, unknown>): void {
		super.updated(changedProps);
		if (changedProps.has('_open')) {
			if (this._open) {
				this._positionPopover();
				this._setupDismiss();
				pushDismissable(this._dismissCallback);
			} else {
				this._teardownDismiss();
				removeDismissable(this._dismissCallback);
			}
		} else if (this._open) {
			// Re-position if info changed while open
			this._positionPopover();
		}
	}

	// ── Positioning ───────────────────────────────────────────────────────────

	private _positionPopover(): void {
		const root = this.shadowRoot;
		if (!root) return;
		const popover = root.querySelector('.schema-info-popover') as HTMLElement | null;
		const btn = root.querySelector('.schema-info-btn') as HTMLElement | null;
		if (!popover || !btn) return;
		const rect = btn.getBoundingClientRect();
		popover.style.top = (rect.bottom + 4) + 'px';
		popover.style.left = 'auto';
		requestAnimationFrame(() => {
			const pr = popover.getBoundingClientRect();
			const left = rect.right - pr.width;
			popover.style.left = Math.max(4, left) + 'px';
			const vh = window.innerHeight || 0;
			if (vh > 0 && pr.bottom > vh) {
				popover.style.top = Math.max(0, rect.top - pr.height - 4) + 'px';
			}
		});
	}

	// ── Dismiss logic ─────────────────────────────────────────────────────────

	private _setupDismiss(): void {
		this._cleanupClickOutside = setupClickOutsideDismiss(this, () => this.close());
		this._cleanupScroll = setupScrollDismiss(() => this.close(), 20);
	}

	private _teardownDismiss(): void {
		this._cleanupClickOutside?.();
		this._cleanupClickOutside = null;
		this._cleanupScroll?.();
		this._cleanupScroll = null;
	}

	// ── Event handlers ────────────────────────────────────────────────────────

	private _toggle(e: Event): void {
		e.stopPropagation();
		this._open = !this._open;
	}

	private _onSchemaRefresh(): void {
		this.dispatchEvent(new CustomEvent('schema-refresh', {
			bubbles: true, composed: true,
		}));
	}

	private _onSeeCachedValues(): void {
		this.dispatchEvent(new CustomEvent('see-cached-values', {
			bubbles: true, composed: true,
		}));
	}

	// ── Public API ────────────────────────────────────────────────────────────

	/** Update schema info state. Merges with existing state. */
	public setInfo(info: Partial<SchemaInfoState>): void {
		this._info = { ...this._info, ...info };
	}

	/** Close the popover programmatically. */
	public close(): void {
		this._open = false;
	}
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-schema-info': KwSchemaInfo;
	}
}
