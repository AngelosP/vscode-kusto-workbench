import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { styles } from './kw-sort-dialog.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { OverlayScrollbarsController } from './overlay-scrollbars.controller.js';
import { customElement, property, state } from 'lit/decorators.js';
import type { SortingState } from '@tanstack/table-core';
import type { DataTableColumn } from './kw-data-table.js';

const ICON_CLOSE = html`<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M4.646 4.646a.5.5 0 0 1 .708 0L8 7.293l2.646-2.647a.5.5 0 0 1 .708.708L8.707 8l2.647 2.646a.5.5 0 0 1-.708.708L8 8.707l-2.646 2.647a.5.5 0 0 1-.708-.708L7.293 8 4.646 5.354a.5.5 0 0 1 0-.708z"/></svg>`;

@customElement('kw-sort-dialog')
export class KwSortDialog extends LitElement {
	private _osCtrl = new OverlayScrollbarsController(this);

	@property({ type: Array, attribute: false }) columns: DataTableColumn[] = [];
	@property({ type: Array, attribute: false }) sorting: SortingState = [];

	@state() private _draft: SortingState = [];

	protected override firstUpdated(): void {
		this._draft = [...this.sorting];
	}

	protected override willUpdate(changed: import('lit').PropertyValues): void {
		if (changed.has('sorting') && !changed.has('_draft')) {
			this._draft = [...this.sorting];
		}
	}

	private _close(): void {
		this.dispatchEvent(new CustomEvent('sort-close', { bubbles: true, composed: true }));
	}

	private _apply(): void {
		// Auto-add any pending "Add sort" row selection
		this._addInline();
		this.dispatchEvent(new CustomEvent('sort-change', {
			detail: { sorting: [...this._draft] },
			bubbles: true, composed: true,
		}));
	}

	private _clear(): void {
		this.dispatchEvent(new CustomEvent('sort-change', {
			detail: { sorting: [] },
			bubbles: true, composed: true,
		}));
	}

	private _rm(idx: number): void {
		this._draft = this._draft.filter((_, i) => i !== idx);
	}

	private _updCol(idx: number, id: string): void {
		const n = [...this._draft];
		n[idx] = { ...n[idx], id };
		this._draft = n;
	}

	private _updDir(idx: number, dir: string): void {
		const n = [...this._draft];
		n[idx] = { ...n[idx], desc: dir === 'desc' };
		this._draft = n;
	}

	private _addInline(): void {
		const colSel = this.shadowRoot?.querySelector('#sr-add-col') as HTMLSelectElement | null;
		const dirSel = this.shadowRoot?.querySelector('#sr-add-dir') as HTMLSelectElement | null;
		if (!colSel || !dirSel) return;
		const colIdx = colSel.value;
		if (!colIdx) return;
		const desc = dirSel.value === 'desc';
		const next = this._draft.filter(s => s.id !== colIdx);
		next.push({ id: colIdx, desc });
		this._draft = next;
	}

	protected override render(): TemplateResult {
		const unusedCols = this.columns.map((c, i) => ({ name: c.name, idx: i }))
			.filter(c => !this._draft.some(s => s.id === String(c.idx)));

		return html`<div class="sd-bg" @click=${this._close}><div class="sd" @click=${(e: Event) => e.stopPropagation()}>
			<div class="sd-h">
				<strong>Sort</strong>
				<button class="nb sd-x" title="Close" @click=${this._close}>${ICON_CLOSE}</button>
			</div>
			<div class="sd-b" data-overlay-scroll="x:hidden">
				${this._draft.length === 0 ? html`<div class="sd-e">No sort applied.</div>` : nothing}
				${this._draft.map((rule, idx) => html`<div class="sr">
					<span class="sr-ord">${idx + 1}</span>
					<button class="sr-rm" title="Remove" @click=${() => this._rm(idx)}>${ICON_CLOSE}</button>
					<select class="sr-col" .value=${rule.id} @change=${(e: Event) => this._updCol(idx, (e.target as HTMLSelectElement).value)}>
						${this.columns.map((c, i) => html`<option value="${i}" ?selected=${rule.id === String(i)}>${c.name}</option>`)}
					</select>
					<select class="sr-dir" .value=${rule.desc ? 'desc' : 'asc'} @change=${(e: Event) => this._updDir(idx, (e.target as HTMLSelectElement).value)}>
						<option value="asc">Ascending</option><option value="desc">Descending</option>
					</select>
				</div>`)}
				<div class="sr-add">
					<span class="sr-add-label">Add sort</span>
					<select class="sr-col" id="sr-add-col">
						<option value="" selected>Select a column…</option>
						${unusedCols.map(c => html`<option value="${c.idx}">${c.name}</option>`)}
					</select>
					<select class="sr-dir" id="sr-add-dir"><option value="asc" selected>Ascending</option><option value="desc">Descending</option></select>
					<button class="sr-add-btn" title="Add" @click=${() => this._addInline()}>+</button>
				</div>
			</div>
			<div class="sd-f">
				<button class="sd-btn sd-btn-danger" @click=${this._clear}>Remove Sort</button>
				<button class="sd-btn" @click=${() => this._apply()}>Apply</button>
			</div>
		</div></div>`;
	}

	static override styles = [...osStyles, scrollbarSheet, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-sort-dialog': KwSortDialog;
	}
}
