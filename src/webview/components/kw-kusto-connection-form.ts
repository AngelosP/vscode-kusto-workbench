import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import { styles } from './kw-kusto-connection-form.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { ICONS } from '../shared/icon-registry.js';

// ── Event detail types ────────────────────────────────────────────────────────

export interface KustoConnectionFormSubmitDetail {
	name: string;
	clusterUrl: string;
	database?: string;
}

// ── Component ─────────────────────────────────────────────────────────────────

@customElement('kw-kusto-connection-form')
export class KwKustoConnectionForm extends LitElement {
	static override styles = [scrollbarSheet, styles];

	@property() mode: 'add' | 'edit' = 'add';
	@property() name = '';
	@property() clusterUrl = '';
	@property() database = '';
	@property({ type: Boolean }) showTestButton = false;
	@property() testResult = '';

	// Internal form values — initialized from properties on first render
	@state() private _name = '';
	@state() private _clusterUrl = '';
	@state() private _database = '';
	@state() private _initialized = false;

	override willUpdate(changed: Map<string | number | symbol, unknown>): void {
		// Sync external properties into internal state when they change from outside
		if (!this._initialized || changed.has('name') || changed.has('clusterUrl') || changed.has('database') || changed.has('mode')) {
			this._name = this.name;
			this._clusterUrl = this.clusterUrl;
			this._database = this.database;
			this._initialized = true;
		}
	}

	override firstUpdated(): void {
		// Auto-focus the first input
		const firstInput = this.shadowRoot?.querySelector('input') as HTMLInputElement | null;
		if (firstInput) {
			requestAnimationFrame(() => firstInput.focus());
		}
	}

	override render(): TemplateResult {
		return html`
			<div @keydown=${this._onKeydown}>
				<div class="form-group">
					<label>Connection Name${this.mode === 'add' ? '' : ' *'}</label>
					<input type="text" .value=${this._name}
						@input=${(e: Event) => this._name = (e.target as HTMLInputElement).value}
						placeholder=${this.mode === 'add' ? '(optional — defaults to cluster URL)' : 'My Cluster'} />
				</div>
				<div class="form-group">
					<label>Cluster URL *</label>
					<input type="text" .value=${this._clusterUrl}
						@input=${(e: Event) => this._clusterUrl = (e.target as HTMLInputElement).value}
						placeholder="https://mycluster.kusto.windows.net" />
				</div>
				<div class="form-group">
					<label>Default Database</label>
					<input type="text" .value=${this._database}
						@input=${(e: Event) => this._database = (e.target as HTMLInputElement).value}
						placeholder="(optional)" />
				</div>
				${this.showTestButton ? html`
					<button class="btn" @click=${this._onTest}>Test Connection</button>
					${this.testResult === 'loading'
						? html`<div class="test-result">${ICONS.spinner} Testing connection...</div>`
						: this.testResult
							? html`<div class="test-result">${this.testResult}</div>`
							: nothing}
				` : nothing}
			</div>
		`;
	}

	// ── Actions ───────────────────────────────────────────────────────────────

	submit(): void {
		const clusterUrl = this._clusterUrl.trim();
		if (!clusterUrl) return;
		const name = this._name.trim() || clusterUrl;
		const database = this._database.trim() || undefined;
		this.dispatchEvent(new CustomEvent<KustoConnectionFormSubmitDetail>('connection-form-submit', {
			detail: { name, clusterUrl, database },
			bubbles: true, composed: true,
		}));
	}

	cancel(): void {
		this.dispatchEvent(new CustomEvent('connection-form-cancel', {
			bubbles: true, composed: true,
		}));
	}

	private _onTest(): void {
		this.dispatchEvent(new CustomEvent('connection-form-test', {
			bubbles: true, composed: true,
		}));
	}

	private _onKeydown = (e: KeyboardEvent): void => {
		if (e.key === 'Enter') {
			e.preventDefault();
			e.stopPropagation();
			this.submit();
		}
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			this.cancel();
		}
	};
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-kusto-connection-form': KwKustoConnectionForm;
	}
}
