import { LitElement, html, nothing, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';
import type { ColumnFiltersState } from '@tanstack/table-core';
import type { CellValue, DataTableColumn } from './kw-data-table.js';
import { styles } from './kw-filter-dialog.styles.js';
import { scrollbarSheet } from '../shared/scrollbar-styles.js';
import { osStyles } from '../shared/os-styles.js';
import { OverlayScrollbarsController } from './overlay-scrollbars.controller.js';

// ── Filter types (exported — used by kw-data-table for filterFn) ──────────────

export interface ValuesFilterSpec { kind: 'values'; allowedValues: string[]; }
export type RuleDataType = 'string' | 'number' | 'date' | 'json';
export type RuleJoin = 'and' | 'or';
export type RuleUnit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months' | 'years';
export interface RuleFilterRule {
	op: string; join?: RuleJoin; a?: string; b?: string;
	n?: string; unit?: RuleUnit; text?: string; threshold?: string;
}
export interface RulesFilterSpec { kind: 'rules'; dataType: RuleDataType; combineOp?: RuleJoin; rules: RuleFilterRule[]; }
export interface CompoundFilterSpec { kind: 'compound'; values?: ValuesFilterSpec; rules?: RulesFilterSpec; }
export type ColumnFilterSpec = ValuesFilterSpec | RulesFilterSpec | CompoundFilterSpec;

export const NULL_EMPTY_KEY = '__KW_NULL_EMPTY__';

// ── Pure filter utility functions (exported) ──────────────────────────────────

export function isNullOrEmptyForFilter(raw: unknown): boolean {
	if (raw === null || raw === undefined) return true;
	if (typeof raw === 'string') return raw.trim() === '';
	return false;
}

export function filterValueKey(raw: unknown): string {
	if (isNullOrEmptyForFilter(raw)) return NULL_EMPTY_KEY;
	try { return String(raw); } catch { return ''; }
}

export function tryParseNumber(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
	const s = String(raw).trim();
	if (s === '') return null;
	const n = Number(s);
	return Number.isFinite(n) ? n : null;
}

export function tryParseDateMs(raw: unknown): number | null {
	if (raw === null || raw === undefined) return null;
	if (typeof raw === 'number' || typeof raw === 'boolean') return null;
	if (raw instanceof Date) {
		const t = raw.getTime();
		return Number.isFinite(t) ? t : null;
	}
	const t = Date.parse(String(raw));
	return Number.isFinite(t) ? t : null;
}

export function durationToMs(n: number, unit: RuleUnit): number {
	switch (unit) {
		case 'minutes': return n * 60_000;
		case 'hours': return n * 3_600_000;
		case 'days': return n * 86_400_000;
		case 'weeks': return n * 7 * 86_400_000;
		case 'months': return n * 30 * 86_400_000;
		case 'years': return n * 365 * 86_400_000;
		default: return n * 86_400_000;
	}
}

export function rowMatchesRules(cell: CellValue, spec: RulesFilterSpec): boolean {
	const rules = Array.isArray(spec.rules) ? spec.rules.filter(r => String(r?.op ?? '').trim()) : [];
	if (!rules.length) return true;

	const raw = (typeof cell === 'object' && cell !== null && 'full' in cell) ? cell.full : cell;
	const isEmpty = isNullOrEmptyForFilter(raw);
	const fallbackJoin: RuleJoin = spec.combineOp === 'or' ? 'or' : 'and';

	const matchOne = (rule: RuleFilterRule): boolean | null => {
		const op = String(rule.op || '');
		if (!op) return null;
		if (op === 'isEmpty') return isEmpty;
		if (op === 'isNotEmpty') return !isEmpty;
		if (isEmpty) return false;

		if (spec.dataType === 'number') {
			const n = tryParseNumber(raw);
			if (n === null) return false;
			const a = tryParseNumber(rule.a);
			const b = tryParseNumber(rule.b);
			if (op === 'lt') return a !== null ? n < a : true;
			if (op === 'gt') return a !== null ? n > a : true;
			if (op === 'between') {
				if (a === null || b === null) return true;
				return n >= Math.min(a, b) && n <= Math.max(a, b);
			}
			if (op === 'top' || op === 'bottom') {
				const thr = tryParseNumber(rule.threshold);
				if (thr === null) return true;
				return op === 'top' ? n >= thr : n <= thr;
			}
			return true;
		}

		if (spec.dataType === 'date') {
			const ms = tryParseDateMs(raw);
			if (ms === null) return false;
			const a = tryParseDateMs(rule.a);
			const b = tryParseDateMs(rule.b);
			if (op === 'before') return a !== null ? ms < a : true;
			if (op === 'after') return a !== null ? ms > a : true;
			if (op === 'between') {
				if (a === null || b === null) return true;
				return ms >= Math.min(a, b) && ms <= Math.max(a, b);
			}
			if (op === 'last') {
				const thr = tryParseDateMs(rule.threshold);
				return thr !== null ? ms >= thr : true;
			}
			return true;
		}

		if (spec.dataType === 'json') {
			let hay = '';
			try { hay = typeof raw === 'object' ? JSON.stringify(raw) : String(raw); } catch { hay = String(raw); }
			const needle = String(rule.text ?? '').trim().toLowerCase();
			if (!needle) return null;
			const contains = hay.toLowerCase().includes(needle);
			if (op === 'contains') return contains;
			if (op === 'notContains') return !contains;
			return true;
		}

		const s = String(raw).toLowerCase();
		const needle = String(rule.text ?? '').trim().toLowerCase();
		if (!needle) return null;
		if (op === 'startsWith') return s.startsWith(needle);
		if (op === 'notStartsWith') return !s.startsWith(needle);
		if (op === 'endsWith') return s.endsWith(needle);
		if (op === 'notEndsWith') return !s.endsWith(needle);
		if (op === 'contains') return s.includes(needle);
		if (op === 'notContains') return !s.includes(needle);
		return true;
	};

	let any = false;
	let acc = false;
	let prev: RuleFilterRule | null = null;
	for (const rule of rules) {
		const m = matchOne(rule);
		if (m === null) continue;
		if (!any) { acc = !!m; any = true; prev = rule; continue; }
		const join: RuleJoin = prev?.join === 'or' ? 'or' : fallbackJoin;
		acc = join === 'or' ? (acc || !!m) : (acc && !!m);
		prev = rule;
	}
	return any ? acc : true;
}

/** Evaluate a single cell against a filter spec. Exported for use as TanStack Table filterFn. */
export function rowMatchesFilterSpec(cell: CellValue, spec: ColumnFilterSpec | null): boolean {
	if (!spec) return true;
	if (spec.kind === 'values') {
		const raw = (typeof cell === 'object' && cell !== null && 'full' in cell) ? cell.full : cell;
		const key = filterValueKey(raw);
		return spec.allowedValues.includes(key);
	}
	if (spec.kind === 'rules') return rowMatchesRules(cell, spec);
	if (spec.kind === 'compound') {
		const valuesOk = spec.values ? rowMatchesFilterSpec(cell, spec.values) : true;
		if (!valuesOk) return false;
		return spec.rules ? rowMatchesFilterSpec(cell, spec.rules) : true;
	}
	return true;
}

/** Get the filter spec for a specific column from the TanStack columnFilters state. */
export function getFilterSpecForColumn(colIndex: number, columnFilters: ColumnFiltersState): ColumnFilterSpec | null {
	const id = String(colIndex);
	const found = columnFilters.find(f => f.id === id);
	if (!found || !found.value || typeof found.value !== 'object') return null;
	const v = found.value as ColumnFilterSpec;
	if (!v || typeof v !== 'object' || !('kind' in v)) return null;
	return v;
}

/** Check whether a column has an active filter. */
export function isColumnFiltered(colIndex: number, columnFilters: ColumnFiltersState): boolean {
	return !!getFilterSpecForColumn(colIndex, columnFilters);
}

function matchesOtherColumnFilters(row: CellValue[], excludeCol: number, columnFilters: ColumnFiltersState): boolean {
	for (const f of columnFilters) {
		const ci = parseInt(f.id, 10);
		if (!Number.isFinite(ci) || ci < 0 || ci === excludeCol) continue;
		const spec = f.value as ColumnFilterSpec | null;
		if (!rowMatchesFilterSpec(row[ci], spec)) return false;
	}
	return true;
}

function getOpsForType(type: RuleDataType): Array<{ v: string; t: string }> {
	const base = [
		{ v: 'isEmpty', t: 'Null or empty' },
		{ v: 'isNotEmpty', t: 'Not null or empty' },
	];
	if (type === 'number') {return base.concat([
		{ v: 'lt', t: 'Less than' }, { v: 'gt', t: 'Greater than' },
		{ v: 'between', t: 'Between' }, { v: 'top', t: 'Top...' }, { v: 'bottom', t: 'Last...' },
	]);}
	if (type === 'date') {return base.concat([
		{ v: 'before', t: 'Before' }, { v: 'after', t: 'After' },
		{ v: 'between', t: 'Between' }, { v: 'last', t: 'Last...' },
	]);}
	if (type === 'json') {return base.concat([
		{ v: 'contains', t: 'Contains' }, { v: 'notContains', t: 'Does not contain' },
	]);}
	return base.concat([
		{ v: 'startsWith', t: 'Starts with' }, { v: 'notStartsWith', t: 'Does not start with' },
		{ v: 'endsWith', t: 'Ends with' }, { v: 'notEndsWith', t: 'Does not end with' },
		{ v: 'contains', t: 'Contains' }, { v: 'notContains', t: 'Does not contain' },
	]);
}

function inferRuleDataType(colIndex: number, rows: CellValue[][], columnFilters: ColumnFiltersState): RuleDataType {
	let numHits = 0, dateHits = 0, objHits = 0, sample = 0;
	for (const row of rows) {
		if (!row || !matchesOtherColumnFilters(row, colIndex, columnFilters)) continue;
		const cell = row[colIndex];
		const raw = (typeof cell === 'object' && cell !== null && 'full' in cell) ? cell.full : cell;
		if (raw === null || raw === undefined || String(raw).trim() === '') continue;
		sample++;
		if (typeof raw === 'object') objHits++;
		if (tryParseNumber(raw) !== null) numHits++;
		if (tryParseDateMs(raw) !== null) dateHits++;
		if (sample >= 100) break;
	}
	if (objHits > 0) return 'json';
	if (numHits > 0 && numHits >= Math.max(2, Math.floor(sample * 0.6))) return 'number';
	if (dateHits > 0 && dateHits >= Math.max(2, Math.floor(sample * 0.6))) return 'date';
	return 'string';
}

// ── Icons ─────────────────────────────────────────────────────────────────────

const ICON_CLOSE = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>`;
const ICON_PLUS = html`<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M8 3.5v9"/><path d="M3.5 8h9"/></svg>`;

// ── Component ─────────────────────────────────────────────────────────────────

@customElement('kw-filter-dialog')
export class KwFilterDialog extends LitElement {
	private _osCtrl = new OverlayScrollbarsController(this);

	@property({ type: Array, attribute: false }) columns: DataTableColumn[] = [];
	@property({ type: Array, attribute: false }) rows: CellValue[][] = [];
	@property({ type: Number, attribute: false }) colIndex: number | null = null;
	@property({ attribute: false }) columnFilters: ColumnFiltersState = [];

	@state() private _mode: 'values' | 'rules' = 'values';
	@state() private _searchQuery = '';
	@state() private _draftAllowedValues: string[] = [];
	@state() private _draftRules: RuleFilterRule[] = [];
	@state() private _rulesDataType: RuleDataType = 'string';
	@state() private _rulesCombine = false;

	protected override firstUpdated(): void {
		this._initDraft();
	}

	private _initDraft(): void {
		if (this.colIndex === null) return;
		this._searchQuery = '';
		const choices = this._computeFilterChoices();
		const existing = getFilterSpecForColumn(this.colIndex, this.columnFilters);
		const existingValues = existing?.kind === 'values'
			? existing
			: (existing?.kind === 'compound' ? existing.values : null);
		const existingRules = existing?.kind === 'rules'
			? existing
			: (existing?.kind === 'compound' ? existing.rules : null);
		this._draftAllowedValues = existingValues ? [...existingValues.allowedValues] : choices.map(c => c.key);
		this._rulesDataType = existingRules?.dataType ?? inferRuleDataType(this.colIndex, this.rows, this.columnFilters);
		this._draftRules = existingRules?.rules?.length
			? existingRules.rules.map(r => ({ ...r, join: r.join === 'or' ? 'or' : 'and', unit: (r.unit as RuleUnit) || 'days' }))
			: [];
		this._rulesCombine = existing?.kind === 'compound';
		this._mode = existingRules ? 'rules' : 'values';
	}

	private _computeFilterChoices(): Array<{ key: string; label: string; count: number }> {
		const colIndex = this.colIndex!;
		const counts = new Map<string, number>();
		for (const row of this.rows) {
			if (!row || !matchesOtherColumnFilters(row, colIndex, this.columnFilters)) continue;
			const raw = (typeof row[colIndex] === 'object' && row[colIndex] !== null && 'full' in (row[colIndex] as object))
				? (row[colIndex] as { full?: unknown }).full
				: row[colIndex];
			const key = filterValueKey(raw);
			counts.set(key, (counts.get(key) ?? 0) + 1);
		}
		const keys = Array.from(counts.keys());
		keys.sort((a, b) => {
			const ca = counts.get(a) ?? 0, cb = counts.get(b) ?? 0;
			if (cb !== ca) return cb - ca;
			if (a === NULL_EMPTY_KEY) return -1;
			if (b === NULL_EMPTY_KEY) return 1;
			return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
		});
		return keys.map(key => ({ key, label: key === NULL_EMPTY_KEY ? 'Null or empty' : key, count: counts.get(key) ?? 0 }));
	}

	private _normalizeRulesForApply(): RuleFilterRule[] {
		const colIndex = this.colIndex!;
		const rules = this._draftRules
			.filter(r => String(r.op || '').trim())
			.map(r => ({
				op: String(r.op || ''), join: r.join === 'or' ? 'or' : 'and',
				a: String(r.a ?? ''), b: String(r.b ?? ''),
				n: String(r.n ?? ''), unit: (r.unit as RuleUnit) || 'days',
				text: String(r.text ?? ''),
			}) as RuleFilterRule);
		if (!rules.length) return rules;

		if (this._rulesDataType === 'number') {
			const values: number[] = [];
			for (const row of this.rows) {
				if (!row || !matchesOtherColumnFilters(row, colIndex, this.columnFilters)) continue;
				const cell = row[colIndex];
				const raw = (typeof cell === 'object' && cell !== null && 'full' in cell) ? cell.full : cell;
				const n = tryParseNumber(raw);
				if (n !== null) values.push(n);
			}
			values.sort((a, b) => a - b);
			for (const r of rules) {
				if (r.op !== 'top' && r.op !== 'bottom') continue;
				const n = parseInt(String(r.n || ''), 10);
				if (!Number.isFinite(n) || n <= 0 || !values.length) continue;
				if (r.op === 'top') r.threshold = String(values[Math.max(0, values.length - n)]);
				else r.threshold = String(values[Math.min(values.length - 1, Math.max(0, n - 1))]);
			}
		}

		if (this._rulesDataType === 'date') {
			const now = Date.now();
			for (const r of rules) {
				if (r.op !== 'last') continue;
				const n = parseInt(String(r.n || ''), 10);
				if (!Number.isFinite(n) || n <= 0) continue;
				r.threshold = new Date(now - durationToMs(n, (r.unit as RuleUnit) || 'days')).toISOString();
			}
		}

		return rules;
	}

	private _apply(): void {
		if (this.colIndex === null) return;
		const existing = getFilterSpecForColumn(this.colIndex, this.columnFilters);
		let filterSpec: ColumnFilterSpec | null = null;

		if (this._mode === 'values') {
			const choices = this._computeFilterChoices();
			const allKeys = choices.map(c => c.key);
			const selected = this._draftAllowedValues.filter(v => allKeys.includes(v));
			const isNoop = selected.length === allKeys.length && allKeys.every(v => selected.includes(v));
			if (!isNoop) {
				const valuesSpec: ValuesFilterSpec = { kind: 'values', allowedValues: selected };
				const existingRules = existing?.kind === 'rules' ? existing : (existing?.kind === 'compound' ? existing.rules : null);
				filterSpec = existingRules ? { kind: 'compound', values: valuesSpec, rules: existingRules } : valuesSpec;
			}
		} else {
			const rules = this._normalizeRulesForApply();
			if (rules.length > 0) {
				const rulesSpec: RulesFilterSpec = { kind: 'rules', dataType: this._rulesDataType, combineOp: 'and', rules };
				if (this._rulesCombine) {
					const existingValues = existing?.kind === 'values' ? existing : (existing?.kind === 'compound' ? existing.values : null);
					filterSpec = existingValues ? { kind: 'compound', values: existingValues, rules: rulesSpec } : rulesSpec;
				} else {
					filterSpec = rulesSpec;
				}
			}
		}

		this.dispatchEvent(new CustomEvent('filter-apply', {
			detail: { colIndex: this.colIndex, filterSpec },
			bubbles: true, composed: true,
		}));
	}

	private _removeFilter(): void {
		this.dispatchEvent(new CustomEvent('filter-apply', {
			detail: { colIndex: this.colIndex, filterSpec: null },
			bubbles: true, composed: true,
		}));
	}

	private _close(): void {
		this.dispatchEvent(new CustomEvent('filter-close', { bubbles: true, composed: true }));
	}

	private _setMode(mode: 'values' | 'rules'): void {
		this._mode = mode;
		if (mode === 'rules' && !this._draftRules.length) {
			this._draftRules = [{ op: '', join: 'and', unit: 'days' }];
		}
	}

	private _toggleChoice(key: string, checked: boolean): void {
		const set = new Set(this._draftAllowedValues);
		if (checked) set.add(key); else set.delete(key);
		this._draftAllowedValues = Array.from(set);
	}

	private _setAllVisible(checked: boolean): void {
		if (this.colIndex === null) return;
		const q = this._searchQuery.trim().toLowerCase();
		const choices = this._computeFilterChoices().filter(c => !q || c.label.toLowerCase().includes(q));
		const set = new Set(this._draftAllowedValues);
		for (const c of choices) { if (checked) set.add(c.key); else set.delete(c.key); }
		this._draftAllowedValues = Array.from(set);
	}

	private _addRule = (): void => {
		this._draftRules = [...this._draftRules, { op: '', join: 'and', unit: 'days' }];
	};

	private _removeRule = (idx: number): void => {
		this._draftRules = this._draftRules.filter((_, i) => i !== idx);
	};

	private _updateRule = (idx: number, patch: Partial<RuleFilterRule>): void => {
		const next = [...this._draftRules];
		next[idx] = { ...(next[idx] ?? { op: '', join: 'and', unit: 'days' }), ...patch };
		this._draftRules = next;
	};

	// ── Render ────────────────────────────────────────────────────────────────

	protected override render(): TemplateResult {
		if (this.colIndex === null) return html``;
		const colName = this.columns[this.colIndex]?.name ?? `Column ${this.colIndex + 1}`;
		const q = this._searchQuery.trim().toLowerCase();
		const choices = this._computeFilterChoices();
		const filtered = choices.filter(c => !q || c.label.toLowerCase().includes(q));
		const selectedSet = new Set(this._draftAllowedValues);
		const ops = getOpsForType(this._rulesDataType);
		const opLabelByValue = new Map<string, string>([
			...getOpsForType('string').map(o => [o.v, o.t] as const),
			...getOpsForType('number').map(o => [o.v, o.t] as const),
			...getOpsForType('date').map(o => [o.v, o.t] as const),
			...getOpsForType('json').map(o => [o.v, o.t] as const),
		]);
		const activeRules = this._draftRules.filter(r => String(r.op || '').trim()).length;

		return html`<div class="sd-bg" @click=${this._close}><div class="sd fd" @click=${(e: Event) => e.stopPropagation()}>
			<div class="sd-h">
				<strong>Filter applied to the column '${colName}'</strong>
				<button type="button" class="nb sd-x" title="Close" aria-label="Close" @click=${this._close}>${ICON_CLOSE}</button>
			</div>
			<div class="fd-modes">
				<button class="fd-mode ${this._mode === 'values' ? 'active' : ''}" @click=${() => this._setMode('values')}>Values</button>
				<button class="fd-mode ${this._mode === 'rules' ? 'active' : ''}" @click=${() => this._setMode('rules')}>Rules${activeRules > 0 ? ` (${activeRules})` : ''}</button>
				${this._mode === 'rules' ? html`<label class="fd-combine"><input class="fd-combine-cb" type="checkbox" .checked=${this._rulesCombine} @change=${(e: Event) => { this._rulesCombine = (e.target as HTMLInputElement).checked; }} /><span>Apply these rules on top of value filters</span></label>` : nothing}
			</div>
			<div class="sd-b" data-overlay-scroll="x:hidden">
				${this._mode === 'values' ? html`
					<div class="fd-tools">
						<div class="sc fd-search">
							<svg class="sc-icon" viewBox="0 0 16 16" width="14" height="14" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M10.5 6.5a4 4 0 1 1-8 0 4 4 0 0 1 8 0zm-.82 4.12a5 5 0 1 1 .707-.707l3.536 3.536-.707.707-3.536-3.536z"/></svg>
							<input type="text" class="sinp" placeholder="Search values..." autocomplete="off" spellcheck="false" .value=${this._searchQuery}
								@input=${(e: Event) => { this._searchQuery = (e.target as HTMLInputElement).value; }} />
						</div>
						<div class="fd-actions">
							<button class="sd-btn" @click=${() => this._setAllVisible(true)}>Select all</button>
							<button class="sd-btn" @click=${() => this._setAllVisible(false)}>Deselect all</button>
						</div>
					</div>
					<div class="fd-list" role="group" aria-label="Values">
						${filtered.length === 0 ? html`<div class="fd-empty">No values match</div>` : filtered.map(item => html`
							<label class="fd-item">
								<input type="checkbox" .checked=${selectedSet.has(item.key)} @change=${(e: Event) => this._toggleChoice(item.key, (e.target as HTMLInputElement).checked)} />
								<span class="fd-item-text">${item.label}</span>
								<span class="fd-item-count">${item.count}</span>
							</label>
						`)}
					</div>
				` : html`
					<div class="fr-head">
						<div class="fr-type-group">
							<span class="fr-type-label">Type</span>
							<select class="sr-col fr-type-select" .value=${this._rulesDataType} @change=${(e: Event) => { this._rulesDataType = (e.target as HTMLSelectElement).value as RuleDataType; }}>
								<option value="string">String</option>
								<option value="number">Number</option>
								<option value="date">Date</option>
								<option value="json">Json</option>
							</select>
						</div>
					</div>
					<div class="fr-list">
						${this._draftRules.length === 0 ? html`<div class="fd-empty">No rules yet</div>` : this._draftRules.map((rule, idx) => html`
							<div class="fr-row">
								<select class="sr-col fr-rule-op" @change=${(e: Event) => this._updateRule(idx, { op: (e.target as HTMLSelectElement).value })}>
									<option value="" ?selected=${!rule.op}>Select...</option>
									${rule.op && !ops.some(o => o.v === rule.op) ? html`<option value="${rule.op}" selected>${opLabelByValue.get(rule.op) ?? rule.op}</option>` : nothing}
									${ops.map(op => html`<option value="${op.v}" ?selected=${rule.op === op.v}>${op.t}</option>`)}
								</select>
								${this._rulesDataType === 'number' ? html`
									${rule.op === 'between' || rule.op === 'lt' || rule.op === 'gt' ? html`<input class="sr-col" type="number" placeholder="A" .value=${rule.a ?? ''} @input=${(e: Event) => this._updateRule(idx, { a: (e.target as HTMLInputElement).value })} />` : nothing}
									${rule.op === 'between' ? html`<input class="sr-col" type="number" placeholder="B" .value=${rule.b ?? ''} @input=${(e: Event) => this._updateRule(idx, { b: (e.target as HTMLInputElement).value })} />` : nothing}
									${rule.op === 'top' || rule.op === 'bottom' ? html`<input class="sr-col" type="number" min="1" placeholder="N" .value=${rule.n ?? ''} @input=${(e: Event) => this._updateRule(idx, { n: (e.target as HTMLInputElement).value })} />` : nothing}
								` : nothing}
								${this._rulesDataType === 'date' ? html`
									${rule.op === 'between' || rule.op === 'before' || rule.op === 'after' ? html`<input class="sr-col" type="datetime-local" .value=${rule.a ?? ''} @input=${(e: Event) => this._updateRule(idx, { a: (e.target as HTMLInputElement).value })} />` : nothing}
									${rule.op === 'between' ? html`<input class="sr-col" type="datetime-local" .value=${rule.b ?? ''} @input=${(e: Event) => this._updateRule(idx, { b: (e.target as HTMLInputElement).value })} />` : nothing}
									${rule.op === 'last' ? html`<input class="sr-col" type="number" min="1" placeholder="N" .value=${rule.n ?? ''} @input=${(e: Event) => this._updateRule(idx, { n: (e.target as HTMLInputElement).value })} />
									<select class="sr-dir" .value=${rule.unit ?? 'days'} @change=${(e: Event) => this._updateRule(idx, { unit: (e.target as HTMLSelectElement).value as RuleUnit })}><option value="minutes">minutes</option><option value="hours">hours</option><option value="days">days</option><option value="weeks">weeks</option><option value="months">months</option><option value="years">years</option></select>` : nothing}
								` : nothing}
								${this._rulesDataType === 'string' || this._rulesDataType === 'json' ? html`
									${(() => { const lo = String(rule.op || '').toLowerCase(); return lo.includes('contains') || lo.includes('startswith') || lo.includes('endswith'); })() ? html`<input class="sr-col" type="text" placeholder="Value..." .value=${rule.text ?? ''} @input=${(e: Event) => this._updateRule(idx, { text: (e.target as HTMLInputElement).value })} />` : nothing}
								` : nothing}
								${idx < this._draftRules.length - 1 ? html`<select class="sr-dir fr-join-select" .value=${rule.join ?? 'and'} @change=${(e: Event) => this._updateRule(idx, { join: (e.target as HTMLSelectElement).value as RuleJoin })}><option value="and">And</option><option value="or">Or</option></select>` : nothing}
								${idx === this._draftRules.length - 1 ? html`<button type="button" class="fr-add-inline" title="Add rule" aria-label="Add rule" @click=${this._addRule}>${ICON_PLUS}</button>` : nothing}
								<button
									class="sr-rm sr-rm-delete ${(this._draftRules.length === 1 && idx === 0) ? 'is-hidden' : ''}"
									title="Delete rule" aria-label="Delete rule"
									@click=${() => this._removeRule(idx)}
									?disabled=${this._draftRules.length <= 1}
								>${ICON_CLOSE}</button>
							</div>
						`)}
					</div>
				`}
			</div>
			<div class="sd-f">
				<button class="sd-btn sd-btn-danger" @click=${this._removeFilter}>Remove Filter</button>
				<button class="sd-btn" @click=${() => this._apply()}>Apply</button>
			</div>
		</div></div>`;
	}

	static override styles = [...osStyles, scrollbarSheet, styles];
}

declare global {
	interface HTMLElementTagNameMap {
		'kw-filter-dialog': KwFilterDialog;
	}
}
