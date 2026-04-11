import { LitElement, html, type TemplateResult } from 'lit';
import { styles } from './kw-function-params-dialog.styles.js';
import { customElement, state } from 'lit/decorators.js';
import { pushDismissable, removeDismissable } from './dismiss-stack.js';

export interface FunctionParam {
	name: string;
	type: string;
	defaultValue?: string;
}

const ICON_CLOSE = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`;

@customElement('kw-function-params-dialog')
export class KwFunctionParamsDialog extends LitElement {
	@state() private _functionName = '';
	@state() private _params: FunctionParam[] = [];
	@state() private _values: string[] = [];
	@state() private _visible = false;

	private _dismiss = () => this._cancel();

	show(functionName: string, params: FunctionParam[], initialValues?: string[]): void {
		this._functionName = functionName;
		this._params = params;
		this._values = params.map((p, i) => initialValues?.[i] ?? p.defaultValue ?? '');
		this._visible = true;
		pushDismissable(this._dismiss);
		this.updateComplete.then(() => {
			const first = this.shadowRoot?.querySelector<HTMLInputElement>('.fpd-input');
			if (first) first.focus();
		});
	}

	hide(): void {
		this._visible = false;
		removeDismissable(this._dismiss);
	}

	private _cancel(): void {
		this.dispatchEvent(new CustomEvent('function-cancel', { bubbles: true, composed: true }));
		this.hide();
	}

	private _run(): void {
		this.dispatchEvent(new CustomEvent('function-run', {
			detail: { values: [...this._values] },
			bubbles: true, composed: true,
		}));
		this.hide();
	}

	private _onInput(idx: number, e: Event): void {
		const input = e.target as HTMLInputElement;
		const next = [...this._values];
		next[idx] = input.value;
		this._values = next;
	}

	private _onKeydown(e: KeyboardEvent): void {
		if (e.key === 'Enter') {
			e.preventDefault();
			this._run();
		}
	}

	protected override render(): TemplateResult | typeof import('lit').nothing {
		if (!this._visible) return html``;
		return html`<div class="sd-bg" @click=${this._cancel}><div class="sd" @click=${(e: Event) => e.stopPropagation()}>
			<div class="sd-h">
				<strong>${this._functionName}(…)</strong>
				<button class="nb sd-x" title="Close" @click=${this._cancel}>${ICON_CLOSE}</button>
			</div>
			<div class="sd-b">
				${this._params.map((p, i) => html`<div class="fpd-row">
					<div class="fpd-label">
						<span class="fpd-name">${p.name}</span>
						${p.type ? html`<span class="fpd-type">${p.type}</span>` : html``}
						${p.defaultValue !== undefined ? html`<span class="fpd-default">default: ${p.defaultValue}</span>` : html``}
					</div>
					<input class="fpd-input"
						type="text"
						.value=${this._values[i] ?? ''}
						placeholder=${p.type || 'value'}
						@input=${(e: Event) => this._onInput(i, e)}
						@keydown=${(e: KeyboardEvent) => this._onKeydown(e)}>
				</div>`)}
			</div>
			<div class="sd-f">
				<button class="sd-btn" @click=${this._cancel}>Cancel</button>
				<button class="sd-btn sd-btn-primary" @click=${this._run}>Run</button>
			</div>
		</div></div>`;
	}

	static override styles = styles;
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-function-params-dialog': KwFunctionParamsDialog;
	}
}
