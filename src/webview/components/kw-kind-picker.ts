import { LitElement, html, type TemplateResult } from 'lit';
import { customElement, property } from 'lit/decorators.js';
import { styles } from './kw-kind-picker.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { ICONS, iconRegistryStyles } from '../shared/icon-registry.js';

/**
 * Reusable Kusto / SQL kind picker — segmented pill control.
 *
 * Usage:
 * ```html
 * <kw-kind-picker
 *   .activeKind=${'kusto'}
 *   .kustoCount=${3}
 *   .sqlCount=${2}
 *   @kind-changed=${(e) => handleKindChange(e.detail.kind)}
 * ></kw-kind-picker>
 * ```
 */
@customElement('kw-kind-picker')
export class KwKindPicker extends LitElement {

	@property({ type: String }) activeKind: 'kusto' | 'sql' = 'kusto';
	@property({ type: Number }) kustoCount = 0;
	@property({ type: Number }) sqlCount = 0;

	protected render(): TemplateResult {
		const kind = this.activeKind;
		return html`
			<div class="type-selector">
				<button class="type-selector-btn ${kind === 'kusto' ? 'active' : ''}" title="Kusto" @click=${() => this._pick('kusto')}>
					${ICONS.kustoCluster} <span class="type-label">Kusto</span> <span class="type-count">${this.kustoCount}</span>
				</button>
				<button class="type-selector-btn ${kind === 'sql' ? 'active' : ''}" title="SQL" @click=${() => this._pick('sql')}>
					${ICONS.sqlServer} <span class="type-label">SQL</span> <span class="type-count">${this.sqlCount}</span>
				</button>
			</div>
		`;
	}

	private _pick(kind: 'kusto' | 'sql'): void {
		if (kind === this.activeKind) return;
		this.activeKind = kind;
		this.dispatchEvent(new CustomEvent('kind-changed', { detail: { kind }, bubbles: true, composed: true }));
	}

	static styles = [scrollbarSheet, iconRegistryStyles, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-kind-picker': KwKindPicker;
	}
}
