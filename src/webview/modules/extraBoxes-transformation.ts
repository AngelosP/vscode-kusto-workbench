// Transformation box creation — thin shim around Lit kw-transformation-section.
// All config UI, computation, and rendering is handled by the Lit component.
// This module retains: factory (addTransformationBox), removal, state init,
// configure-from-tool, and guard stubs for callers that still reference the
// legacy __kustoUpdateTransformationBuilderUI / __kustoRenderTransformation.
import { schedulePersist } from './persistence';
import { __kustoCleanupSectionModeResizeObserver } from './extraBoxes';

// Access shared transformation state from window (set by extraBoxes.ts).
window.transformationStateByBoxId = window.transformationStateByBoxId || {};
let transformationStateByBoxId = window.transformationStateByBoxId;
window.__kustoTransformationBoxes = window.__kustoTransformationBoxes || [];
let transformationBoxes: any[] = window.__kustoTransformationBoxes;

export function __kustoConfigureTransformationFromTool(boxId: any, config: any) {
	try {
		const id = String(boxId || '');
		if (!id) return false;
		if (!config || typeof config !== 'object') return false;

		// Lit element: delegate to its configure() method.
		const el = document.getElementById(id) as any;
		if (el && typeof el.configure === 'function') {
			return el.configure(config);
		}
		return false;
	} catch (err: any) {
		console.error('[Kusto] Error configuring transformation:', err);
		return false;
	}
}

// Expose for tool calls from main.js
try { window.__kustoConfigureTransformation = __kustoConfigureTransformationFromTool; } catch (e) { console.error('[kusto]', e); }


// ================================
// State management
// ================================

export function __kustoGetTransformationState(boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return { mode: 'edit', expanded: true };
		if (!transformationStateByBoxId || typeof transformationStateByBoxId !== 'object') {
			transformationStateByBoxId = {};
		}
		if (!transformationStateByBoxId[id] || typeof transformationStateByBoxId[id] !== 'object') {
			transformationStateByBoxId[id] = {
				mode: 'edit',
				expanded: true,
				dataSourceId: '',
				transformationType: 'derive',
				deriveColumns: [{ name: '', expression: '' }],
				deriveColumnName: '',
				deriveExpression: '',
				distinctColumn: '',
				groupByColumns: [],
				aggregations: [{ function: 'count', column: '' }],
				pivotRowKeyColumn: '',
				pivotColumnKeyColumn: '',
				pivotValueColumn: '',
				pivotAggregation: 'sum',
				pivotMaxColumns: 100
			};
		}
		// Back-compat migration: if we have a legacy single derive field but no deriveColumns.
		try {
			const st = transformationStateByBoxId[id];
			if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
				const n = (typeof st.deriveColumnName === 'string') ? st.deriveColumnName : '';
				const e = (typeof st.deriveExpression === 'string') ? st.deriveExpression : '';
				st.deriveColumns = [{ name: n || '', expression: e || '' }];
			}
		} catch (e) { console.error('[kusto]', e); }
		return transformationStateByBoxId[id];
	} catch {
		return { mode: 'edit', expanded: true };
	}
}

// ================================
// Guard stubs — kept so callers (extraBoxes.ts, kw-transformation-section.ts)
// can still call these; they delegate to the Lit component and return.
// ================================

export function __kustoUpdateTransformationBuilderUI(boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	// Lit elements handle their own UI.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') return;
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoRenderTransformation(boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	// Delegate to Lit component's refresh() method.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') {
			el.refresh();
			return;
		}
	} catch (e) { console.error('[kusto]', e); }
}

// ================================
// Section CRUD
// ================================

export function removeTransformationBox(boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try { __kustoCleanupSectionModeResizeObserver(id); } catch (e) { console.error('[kusto]', e); }
	try {
		const el = document.getElementById(id) as any;
		if (el && el.parentElement) {
			el.parentElement.removeChild(el);
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		transformationBoxes = Array.isArray(transformationBoxes) ? transformationBoxes.filter((x: any) => x !== id) : [];
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (transformationStateByBoxId && typeof transformationStateByBoxId === 'object') {
			delete transformationStateByBoxId[id];
		}
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function addTransformationBox(options: any) {
	const id = (options && options.id) ? String(options.id) : ('transformation_' + Date.now());
	transformationBoxes.push(id);
	const st = __kustoGetTransformationState(id);
	st.mode = (options && typeof options.mode === 'string' && String(options.mode).toLowerCase() === 'preview') ? 'preview' : 'edit';
	st.expanded = (options && typeof options.expanded === 'boolean') ? !!options.expanded : true;
	st.dataSourceId = (options && typeof options.dataSourceId === 'string') ? String(options.dataSourceId) : (st.dataSourceId || '');
	st.transformationType = (options && typeof options.transformationType === 'string') ? String(options.transformationType) : (st.transformationType || 'derive');
	st.distinctColumn = (options && typeof options.distinctColumn === 'string') ? String(options.distinctColumn) : (st.distinctColumn || '');
	st.deriveColumns = (options && Array.isArray(options.deriveColumns)) ? options.deriveColumns : (Array.isArray(st.deriveColumns) ? st.deriveColumns : [{ name: '', expression: '' }]);
	// Back-compat: if options provides legacy single derive, merge it if deriveColumns not provided.
	try {
		if ((!options || !Array.isArray(options.deriveColumns)) && options && (typeof options.deriveColumnName === 'string' || typeof options.deriveExpression === 'string')) {
			const n = (typeof options.deriveColumnName === 'string') ? String(options.deriveColumnName) : '';
			const e = (typeof options.deriveExpression === 'string') ? String(options.deriveExpression) : '';
			st.deriveColumns = [{ name: n, expression: e }];
		}
	} catch (e) { console.error('[kusto]', e); }
	// Keep legacy fields in sync
	try {
		const first = Array.isArray(st.deriveColumns) && st.deriveColumns.length ? st.deriveColumns[0] : { name: '', expression: '' };
		st.deriveColumnName = String((first && first.name) || '');
		st.deriveExpression = String((first && first.expression) || '');
	} catch (e) { console.error('[kusto]', e); }
	st.groupByColumns = (options && Array.isArray(options.groupByColumns)) ? options.groupByColumns.filter((c: any) => c) : (Array.isArray(st.groupByColumns) ? st.groupByColumns : []);
	st.aggregations = (options && Array.isArray(options.aggregations)) ? options.aggregations : (Array.isArray(st.aggregations) ? st.aggregations : [{ function: 'count', column: '' }]);
	st.pivotRowKeyColumn = (options && typeof options.pivotRowKeyColumn === 'string') ? String(options.pivotRowKeyColumn) : (st.pivotRowKeyColumn || '');
	st.pivotColumnKeyColumn = (options && typeof options.pivotColumnKeyColumn === 'string') ? String(options.pivotColumnKeyColumn) : (st.pivotColumnKeyColumn || '');
	st.pivotValueColumn = (options && typeof options.pivotValueColumn === 'string') ? String(options.pivotValueColumn) : (st.pivotValueColumn || '');
	st.pivotAggregation = (options && typeof options.pivotAggregation === 'string') ? String(options.pivotAggregation) : (st.pivotAggregation || 'sum');
	st.pivotMaxColumns = (options && typeof options.pivotMaxColumns === 'number' && Number.isFinite(options.pivotMaxColumns)) ? options.pivotMaxColumns : (typeof st.pivotMaxColumns === 'number' ? st.pivotMaxColumns : 100);

	const container = document.getElementById('queries-container');
	if (!container) return;

	const litEl = document.createElement('kw-transformation-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	if (typeof litEl.applyOptions === 'function') {
		litEl.applyOptions(options || {});
	}

	litEl.addEventListener('section-remove', (e: any) => {
		try {
			const detail = e && e.detail ? e.detail : {};
			const removeId = detail.boxId || id;
			removeTransformationBox(removeId);
		} catch (e) { console.error('[kusto]', e); }
	});

	container.insertAdjacentElement('beforeend', litEl);
	return id;
}

// ── Window bridges (kept for callers that still use window.xxx) ──
window.__kustoRenderTransformation = __kustoRenderTransformation;
window.addTransformationBox = addTransformationBox;
