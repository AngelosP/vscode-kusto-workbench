// Transformation box creation, expression engine, pivot, derive, summarize.
// Extracted from extraBoxes.ts (Phase 6 decomposition).

const _win = window;

// Access shared transformation state from window (set by extraBoxes.ts).
// Initialize on window if not already present, so load order doesn't matter.
window.transformationStateByBoxId = window.transformationStateByBoxId || {};
let transformationStateByBoxId = window.transformationStateByBoxId;
window.__kustoTransformationBoxes = window.__kustoTransformationBoxes || [];
let transformationBoxes: any[] = window.__kustoTransformationBoxes;
export function __kustoConfigureTransformationFromTool( boxId: any, config: any) {
	try {
		const id = String(boxId || '');
		if (!id) return false;
		if (!config || typeof config !== 'object') return false;

		// Lit element: delegate to its configure() method.
		try {
			const el = document.getElementById(id) as any;
			if (el && typeof el.configure === 'function') {
				return el.configure(config);
			}
		} catch (e) { console.error('[kusto]', e); }
		
		// Ensure state object exists
		const st = __kustoGetTransformationState(id);
		if (!st) return false;
		
		// Apply configuration properties
		if (typeof config.dataSourceId === 'string') {
			st.dataSourceId = config.dataSourceId;
		}
		if (typeof config.transformationType === 'string') {
			st.transformationType = config.transformationType;
		}
		
		// Derive columns
		if (Array.isArray(config.deriveColumns)) {
			st.deriveColumns = config.deriveColumns.map((c: any) => ({
				name: String(c.name || ''),
				expression: String(c.expression || '')
			}));
		}
		
		// Distinct
		if (typeof config.distinctColumn === 'string') {
			st.distinctColumn = config.distinctColumn;
		}
		
		// Summarize
		if (Array.isArray(config.groupByColumns)) {
			st.groupByColumns = config.groupByColumns.map((c: any) => String(c));
		}
		if (Array.isArray(config.aggregations)) {
			st.aggregations = config.aggregations.map((a: any) => ({
				function: String(a.function || 'count'),
				column: String(a.column || ''),
				alias: a.alias ? String(a.alias) : undefined
			}));
		}
		
		// Pivot
		if (typeof config.pivotRowKeyColumn === 'string') {
			st.pivotRowKeyColumn = config.pivotRowKeyColumn;
		}
		if (typeof config.pivotColumnKeyColumn === 'string') {
			st.pivotColumnKeyColumn = config.pivotColumnKeyColumn;
		}
		if (typeof config.pivotValueColumn === 'string') {
			st.pivotValueColumn = config.pivotValueColumn;
		}
		if (typeof config.pivotAggregation === 'string') {
			st.pivotAggregation = config.pivotAggregation;
		}
		if (typeof config.pivotMaxColumns === 'number') {
			st.pivotMaxColumns = config.pivotMaxColumns;
		}
		
		// Update the UI to reflect new state
		try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		
		// Re-render the transformation
		try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
		
		// Persist changes
		try { if (typeof _win.schedulePersist === 'function') _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		
		return true;
	} catch (err: any) {
		console.error('[Kusto] Error configuring transformation:', err);
		return false;
	}
}

// Expose for tool calls from main.js
try { window.__kustoConfigureTransformation = __kustoConfigureTransformationFromTool; } catch (e) { console.error('[kusto]', e); }


// ================================
// Transformations section
// ================================

export const __kustoTransformationTypeIcons = {
	derive: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 24h20"/><path d="M10 24V8h12v16"/><path d="M12 12h8"/><path d="M12 16h8"/><path d="M12 20h8"/></svg>',
	summarize: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 10h20"/><path d="M6 16h14"/><path d="M6 22h10"/><path d="M24 22v-8"/><path d="M21 17l3-3 3 3"/></svg>',
	distinct: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 10h12"/><path d="M10 16h12"/><path d="M10 22h12"/><circle cx="8" cy="10" r="1.8"/><circle cx="8" cy="16" r="1.8"/><circle cx="8" cy="22" r="1.8"/></svg>',
	pivot: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="20" height="20" rx="2"/><path d="M6 14h20"/><path d="M14 6v20"/><path d="M18 10h6"/><path d="M18 18h6"/></svg>'
};

export const __kustoTransformMiniPlusIconSvg =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
	'<path d="M8 3.2v9.6"/>' +
	'<path d="M3.2 8h9.6"/>' +
	'</svg>';

export const __kustoTransformMiniTrashIconSvg =
	'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg">' +
	'<path d="M3 5h10"/>' +
	'<path d="M6 5V3.8c0-.4.3-.8.8-.8h2.4c.4 0 .8.3.8.8V5"/>' +
	'<path d="M5.2 5l.6 8.2c0 .5.4.8.8.8h3c.5 0 .8-.4.8-.8l.6-8.2"/>' +
	'<path d="M7 7.4v4.6"/>' +
	'<path d="M9 7.4v4.6"/>' +
	'</svg>';

// Rich tooltip content for calculated column expression help
export const __kustoTransformExpressionHelpHtml =
	'<div class="kusto-transform-expr-help-tooltip">' +
		'<div class="kusto-transform-expr-help-header">' +
			'<span class="kusto-transform-expr-help-title">Expression Syntax</span>' +
		'</div>' +
		'<div class="kusto-transform-expr-help-grid">' +
			// Left column
			'<div class="kusto-transform-expr-help-col">' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">References</span>' +
					'<span class="kusto-transform-expr-help-item"><code data-ex="[ColumnName]">[Col]</code> or <code data-ex="ColumnName">Col</code></span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Operators</span>' +
					'<span class="kusto-transform-expr-help-ops">' +
						'<code data-ex="[Price] + [Tax]">+</code>' +
						'<code data-ex="[Total] - [Discount]">-</code>' +
						'<code data-ex="[Qty] * [UnitPrice]">*</code>' +
						'<code data-ex="[Amount] / 100">/</code>' +
						'<code data-ex="([A] + [B]) * [C]">( )</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Math</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="round([Price], 2)">round</code>' +
						'<code data-ex="floor([Value])">floor</code>' +
						'<code data-ex="ceiling([Score])">ceiling</code>' +
						'<code data-ex="abs([Delta])">abs</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">String</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="len([Name])">len</code>' +
						'<code data-ex="trim([Text])">trim</code>' +
						'<code data-ex="toupper([Code])">toupper</code>' +
						'<code data-ex="tolower([Email])">tolower</code>' +
						'<code data-ex="substring([Str], 0, 5)">substring</code>' +
						'<code data-ex="replace([Path], &apos;/&apos;, &apos;-&apos;)">replace</code>' +
						'<code data-ex="indexof([Text], &apos;@&apos;)">indexof</code>' +
					'</span>' +
				'</div>' +
			'</div>' +
			// Right column
			'<div class="kusto-transform-expr-help-col">' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Date</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="now()">now</code>' +
						'<code data-ex="datetime(&apos;2024-01-15&apos;)">datetime</code>' +
						'<code data-ex="format_datetime([Date], &apos;yyyy-MM-dd&apos;)">format_datetime</code>' +
						'<code data-ex="getyear([Date])">getyear</code>' +
						'<code data-ex="getmonth([Date])">getmonth</code>' +
						'<code data-ex="getday([Date])">getday</code>' +
						'<code data-ex="dayofweek([Date])">dayofweek</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Truncate</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="startofday([Timestamp])">startofday</code>' +
						'<code data-ex="startofweek([Date])">startofweek</code>' +
						'<code data-ex="startofmonth([Date])">startofmonth</code>' +
						'<code data-ex="startofyear([Date])">startofyear</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Date Math</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="datetime_add(&apos;day&apos;, 7, [Date])">datetime_add</code>' +
						'<code data-ex="datetime_diff(&apos;day&apos;, [End], [Start])">datetime_diff</code>' +
					'</span>' +
				'</div>' +
				'<div class="kusto-transform-expr-help-group">' +
					'<span class="kusto-transform-expr-help-label">Convert</span>' +
					'<span class="kusto-transform-expr-help-funcs">' +
						'<code data-ex="tostring([Id])">tostring</code>' +
						'<code data-ex="tonumber([Str])">tonumber</code>' +
						'<code data-ex="coalesce([Value], 0)">coalesce</code>' +
					'</span>' +
				'</div>' +
			'</div>' +
		'</div>' +
		'<div class="kusto-transform-expr-help-examples">' +
			'<span class="kusto-transform-expr-help-example-text">[Price] * 1.1</span>' +
			'<button class="kusto-transform-expr-help-inject-btn" title="Insert into expression">' +
				'<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">' +
					'<path d="M2 4v8M14 4v8"/>' +
					'<path d="M5 8h6M8 5l3 3-3 3"/>' +
				'</svg>' +
			'</button>' +
		'</div>' +
	'</div>';

export const __kustoTransformationTypeLabels = {
	derive: 'Calc. Column',
	summarize: 'Summarize',
	distinct: 'Distinct',
	pivot: 'Pivot'
};

// Tooltip state and functions for expression help
export let __kustoExprHelpTooltipEl: any = null;
export let __kustoExprHelpTooltipTimer: any = null;
export let __kustoExprHelpActiveTextarea: any = null;

export function __kustoShowExpressionHelpTooltip( textareaEl: any, event: any) {
	// Clear any pending hide timer
	if (__kustoExprHelpTooltipTimer) {
		clearTimeout(__kustoExprHelpTooltipTimer);
		__kustoExprHelpTooltipTimer = null;
	}

	// Store reference to the textarea for injection
	__kustoExprHelpActiveTextarea = textareaEl;

	// Create tooltip element if it doesn't exist
	if (!__kustoExprHelpTooltipEl) {
		__kustoExprHelpTooltipEl = document.createElement('div');
		__kustoExprHelpTooltipEl.className = 'kusto-transform-expr-help-tooltip-container';
		__kustoExprHelpTooltipEl.innerHTML = __kustoTransformExpressionHelpHtml;
		document.body.appendChild(__kustoExprHelpTooltipEl);

		// Keep tooltip open when hovering over it
		__kustoExprHelpTooltipEl.addEventListener('mouseenter', function() {
			if (__kustoExprHelpTooltipTimer) {
				clearTimeout(__kustoExprHelpTooltipTimer);
				__kustoExprHelpTooltipTimer = null;
			}
		});
		__kustoExprHelpTooltipEl.addEventListener('mouseleave', function() {
			__kustoHideExpressionHelpTooltip();
		});

		// Click handler for function pills to update example
		__kustoExprHelpTooltipEl.addEventListener('click', function(e: any) {
			// Handle inject button click
			const injectBtn = (e.target as any).closest('.kusto-transform-expr-help-inject-btn');
			if (injectBtn) {
				const exampleEl = __kustoExprHelpTooltipEl.querySelector('.kusto-transform-expr-help-example-text');
				if (exampleEl && __kustoExprHelpActiveTextarea) {
					const text = exampleEl.textContent;
					const textarea = __kustoExprHelpActiveTextarea;
					const start = textarea.selectionStart;
					const end = textarea.selectionEnd;
					const before = textarea.value.substring(0, start);
					const after = textarea.value.substring(end);
					textarea.value = before + text + after;
					// Position cursor after inserted text
					const newPos = start + text.length;
					textarea.setSelectionRange(newPos, newPos);
					// Trigger input event so the change is registered
					textarea.dispatchEvent(new Event('input', { bubbles: true }));
					// Focus the textarea and hide tooltip
					textarea.focus();
					__kustoHideExpressionHelpTooltipImmediate();
				}
				return;
			}

			// Handle function pill click
			const code = (e.target as any).closest('code[data-ex]');
			if (code) {
				const example = code.getAttribute('data-ex');
				const exampleEl = __kustoExprHelpTooltipEl.querySelector('.kusto-transform-expr-help-example-text');
				if (exampleEl && example) {
					exampleEl.textContent = example;
					// Brief highlight animation
					exampleEl.classList.remove('kusto-transform-expr-help-example-flash');
					void exampleEl.offsetWidth; // Force reflow
					exampleEl.classList.add('kusto-transform-expr-help-example-flash');
				}
			}
		});
	}

	// Position the tooltip - NEVER cover the textarea
	// Priority: 1) Below if enough space, 2) Above if enough space, 3) Constrain height to fit
	const rect = textareaEl.getBoundingClientRect();
	const tooltipWidth = 340;
	const gap = 6; // space between textarea and tooltip
	const minTooltipHeight = 150; // minimum usable height before it gets too cramped
	const edgePadding = 10; // padding from viewport edges

	// First, make tooltip visible but off-screen to measure its natural height
	__kustoExprHelpTooltipEl.style.left = '-9999px';
	__kustoExprHelpTooltipEl.style.top = '-9999px';
	__kustoExprHelpTooltipEl.style.maxHeight = '';
	__kustoExprHelpTooltipEl.style.overflowY = '';
	__kustoExprHelpTooltipEl.classList.add('is-visible');
	const tooltipNaturalHeight = __kustoExprHelpTooltipEl.offsetHeight;

	// Calculate horizontal position
	let left = rect.left;
	if (left + tooltipWidth > window.innerWidth - edgePadding) {
		left = window.innerWidth - tooltipWidth - edgePadding;
	}
	if (left < edgePadding) left = edgePadding;

	// Calculate available space above and below the textarea
	const spaceBelow = window.innerHeight - rect.bottom - gap - edgePadding;
	const spaceAbove = rect.top - gap - edgePadding;

	let top;
	let constrainedHeight = null;

	if (spaceBelow >= tooltipNaturalHeight) {
		// Plenty of space below - use it at natural height
		top = rect.bottom + gap;
	} else if (spaceAbove >= tooltipNaturalHeight) {
		// Plenty of space above - use it at natural height
		top = rect.top - gap - tooltipNaturalHeight;
	} else if (spaceBelow >= spaceAbove && spaceBelow >= minTooltipHeight) {
		// More space below, constrain height to fit
		top = rect.bottom + gap;
		constrainedHeight = spaceBelow;
	} else if (spaceAbove >= minTooltipHeight) {
		// More space above (or below is too small), constrain height to fit
		constrainedHeight = spaceAbove;
		top = rect.top - gap - constrainedHeight;
	} else {
		// Extreme case: neither direction has minimum space
		// Pick the larger one and use what we can
		if (spaceBelow >= spaceAbove) {
			top = rect.bottom + gap;
			constrainedHeight = Math.max(spaceBelow, 100);
		} else {
			constrainedHeight = Math.max(spaceAbove, 100);
			top = rect.top - gap - constrainedHeight;
		}
	}

	// Apply final positioning and height constraint
	__kustoExprHelpTooltipEl.style.left = left + 'px';
	__kustoExprHelpTooltipEl.style.top = top + 'px';
	if (constrainedHeight !== null) {
		__kustoExprHelpTooltipEl.style.maxHeight = constrainedHeight + 'px';
		__kustoExprHelpTooltipEl.style.overflowY = 'auto';
	} else {
		__kustoExprHelpTooltipEl.style.maxHeight = '';
		__kustoExprHelpTooltipEl.style.overflowY = '';
	}
	// Tooltip is already visible from measurement step
}

export function __kustoHideExpressionHelpTooltip() {
	// Delay hiding slightly so user can move mouse to tooltip
	if (__kustoExprHelpTooltipTimer) {
		clearTimeout(__kustoExprHelpTooltipTimer);
	}
	__kustoExprHelpTooltipTimer = setTimeout(function() {
		if (__kustoExprHelpTooltipEl) {
			__kustoExprHelpTooltipEl.classList.remove('is-visible');
		}
		__kustoExprHelpTooltipTimer = null;
	}, 150);
}

export function __kustoHideExpressionHelpTooltipImmediate() {
	// Hide immediately when user clicks/focuses on input
	if (__kustoExprHelpTooltipTimer) {
		clearTimeout(__kustoExprHelpTooltipTimer);
		__kustoExprHelpTooltipTimer = null;
	}
	if (__kustoExprHelpTooltipEl) {
		__kustoExprHelpTooltipEl.classList.remove('is-visible');
	}
}

export function __kustoGetTransformationState( boxId: any) {
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
				// Calculated columns (derive)
				deriveColumns: [{ name: '', expression: '' }],
				// Back-compat: older code paths may still set single-field derive.
				deriveColumnName: '',
				deriveExpression: '',
				// Distinct
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

/**
 * Computes the minimum resize height for a Transformation section wrapper.
 * Accounts for: controls panel height (in Edit mode) + results area min-height.
 * @param {string} boxId - The transformation box ID
 * @returns {number} Minimum height in pixels
 */
export function __kustoGetTransformationMinResizeHeight( boxId: any) {
	const RESULTS_MIN_HEIGHT = 80; // Minimum height for results table
	const CONTROLS_MARGIN_BOTTOM = 20; // CSS margin-bottom on .kusto-chart-controls
	const FALLBACK_MIN = 80;
	try {
		const id = String(boxId || '');
		if (!id) return FALLBACK_MIN;
		const st = __kustoGetTransformationState(id);
		const isEditMode = st.mode === 'edit';
		
		// In preview mode, we only need space for the results area
		if (!isEditMode) {
			return RESULTS_MIN_HEIGHT;
		}
		
		// In edit mode, account for the controls panel height
		const controlsEl = document.getElementById(id + '_tf_controls') as any;
		const controlsH = controlsEl && controlsEl.getBoundingClientRect
			? Math.ceil(controlsEl.getBoundingClientRect().height || 0)
			: 0;
		
		// Min = controls height + margin-bottom (not captured by getBoundingClientRect) + results min-height
		return Math.max(FALLBACK_MIN, controlsH + CONTROLS_MARGIN_BOTTOM + RESULTS_MIN_HEIGHT);
	} catch {
		return FALLBACK_MIN;
	}
}

export function __kustoUpdateTransformationModeButtons( boxId: any) {
	try {
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		const editBtn = document.getElementById(boxId + '_tf_mode_edit') as any;
		const prevBtn = document.getElementById(boxId + '_tf_mode_preview') as any;
		if (editBtn) {
			editBtn.classList.toggle('is-active', mode === 'edit');
			editBtn.setAttribute('aria-selected', mode === 'edit' ? 'true' : 'false');
		}
		if (prevBtn) {
			prevBtn.classList.toggle('is-active', mode === 'preview');
			prevBtn.setAttribute('aria-selected', mode === 'preview' ? 'true' : 'false');
		}
		// Update dropdown text
		const dropdownText = document.getElementById(boxId + '_tf_mode_dropdown_text') as any;
		if (dropdownText) {
			dropdownText.textContent = mode === 'preview' ? 'Preview' : 'Edit';
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoApplyTransformationMode( boxId: any) {
	try {
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		const mode = st && st.mode ? String(st.mode) : 'edit';
		try {
			const boxEl = document.getElementById(boxId) as any;
			if (boxEl) {
				boxEl.classList.toggle('is-preview', mode === 'preview');
				boxEl.classList.toggle('is-edit', mode === 'edit');
			}
		} catch (e) { console.error('[kusto]', e); }
		const controlsHost = document.getElementById(boxId + '_tf_controls') as any;
		if (controlsHost) controlsHost.style.display = (mode === 'edit') ? '' : 'none';
		__kustoUpdateTransformationModeButtons(boxId);
		try { __kustoRenderTransformation(boxId); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetTransformationMode( boxId: any, mode: any) {
	const id = String(boxId || '');
	const m = String(mode || '').toLowerCase();
	if (!id) return;
	if (m !== 'edit' && m !== 'preview') return;
	const st = __kustoGetTransformationState(id);
	st.mode = m;
	try { __kustoApplyTransformationMode(id); } catch (e) { console.error('[kusto]', e); }
	try {
		if (m === 'preview') {
			const w = document.getElementById(id + '_tf_wrapper') as any;
			if (w) {
				w.dataset.kustoAutoFitActive = 'true';
				w.dataset.kustoAutoFitAllowShrink = 'true';
				// Force layout so measurements reflect the new mode.
				try {
					const resultsWrapper = document.getElementById(id + '_results_wrapper') as any;
					if (resultsWrapper) void resultsWrapper.offsetHeight;
					const controlsHost = document.getElementById(id + '_tf_controls') as any;
					if (controlsHost) void controlsHost.offsetHeight;
				} catch (e) { console.error('[kusto]', e); }
				try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoUpdateTransformationVisibilityToggleButton( boxId: any) {
	try {
		const btn = document.getElementById(boxId + '_tf_toggle') as any;
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		if (!btn) return;
		const expanded = !!(st ? st.expanded : true);
		btn.classList.toggle('is-active', expanded);
		btn.setAttribute('aria-selected', expanded ? 'true' : 'false');
		btn.title = expanded ? 'Hide' : 'Show';
		btn.setAttribute('aria-label', expanded ? 'Hide' : 'Show');
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoApplyTransformationBoxVisibility( boxId: any) {
	try {
		const st = transformationStateByBoxId && transformationStateByBoxId[boxId] ? transformationStateByBoxId[boxId] : null;
		const expanded = !!(st ? st.expanded : true);
		const wrapper = document.getElementById(boxId + '_tf_wrapper') as any;
		if (wrapper) {
			wrapper.style.display = expanded ? '' : 'none';
		}
		// Hide/show Edit and Preview buttons, the divider, and max button when minimized
		const editBtn = document.getElementById(boxId + '_tf_mode_edit') as any;
		const previewBtn = document.getElementById(boxId + '_tf_mode_preview') as any;
		const divider = document.getElementById(boxId + '_tf_mode_divider') as any;
		const maxBtn = document.getElementById(boxId + '_tf_max') as any;
		if (editBtn) editBtn.style.display = expanded ? '' : 'none';
		if (previewBtn) previewBtn.style.display = expanded ? '' : 'none';
		if (divider) divider.style.display = expanded ? '' : 'none';
		if (maxBtn) maxBtn.style.display = expanded ? '' : 'none';
		__kustoUpdateTransformationVisibilityToggleButton(boxId);
		if (expanded) {
			try { __kustoRenderTransformation(boxId); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function toggleTransformationBoxVisibility( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	st.expanded = !st.expanded;
	try { __kustoApplyTransformationBoxVisibility(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoMaximizeTransformationBox( boxId: any) {
	try {
		const wrapper = document.getElementById(boxId + '_tf_wrapper') as any;
		if (!wrapper) return;
		const desired = __kustoComputeTransformationFitHeightPx(boxId);
		if (!desired) return;
		wrapper.style.height = desired + 'px';
		try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
		try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch (e) { console.error('[kusto]', e); }
		try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoComputeTransformationFitHeightPx( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return null;
		const activeHost = document.getElementById(id + '_tf_editor') as any;
		if (!activeHost) return null;
		let desired = 0;
		try {
			// The transformation editor is a flex layout; scrollHeight tends to match current height.
			// Measure controls + results content (like query boxes) so Fit-to-contents doesn't leave gaps.
			const resultsWrapper = document.getElementById(id + '_results_wrapper') as any;
			const resultsEl = document.getElementById(id + '_results') as any;
			let resultsWrapperMargins = 0;
			let resultsWrapperBoxExtra = 0;
			try {
				if (resultsWrapper && window.getComputedStyle) {
					const rsw = window.getComputedStyle(resultsWrapper);
					const mt = parseFloat(rsw.marginTop || '0') || 0;
					const mb = parseFloat(rsw.marginBottom || '0') || 0;
					resultsWrapperMargins = mt + mb;
					resultsWrapperBoxExtra += (parseFloat(rsw.paddingTop || '0') || 0) + (parseFloat(rsw.paddingBottom || '0') || 0);
					resultsWrapperBoxExtra += (parseFloat(rsw.borderTopWidth || '0') || 0) + (parseFloat(rsw.borderBottomWidth || '0') || 0);
				}
			} catch (e) { console.error('[kusto]', e); }

			const addVisibleRectHeight = (el: any) => {
				try {
					if (!el) return 0;
					try {
						const cs = getComputedStyle(el);
						if (cs && cs.display === 'none') return 0;
						const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
						let margin = 0;
						try {
							margin += parseFloat(cs.marginTop || '0') || 0;
							margin += parseFloat(cs.marginBottom || '0') || 0;
						} catch (e) { console.error('[kusto]', e); }
						return Math.max(0, Math.ceil(h + margin));
					} catch (e) { console.error('[kusto]', e); }
					const h = (el.getBoundingClientRect ? (el.getBoundingClientRect().height || 0) : 0);
					return Math.max(0, Math.ceil(h));
				} catch {
					return 0;
				}
			};

			const controlsH = (() => {
				try {
					let h = 0;
					const stopEl = (resultsWrapper && resultsWrapper.parentElement === activeHost) ? resultsWrapper : null;
					for (const child of Array.from(activeHost.children || []) as any[]) {
						if (stopEl && child === stopEl) break;
						h += addVisibleRectHeight(child);
					}
					try {
						const cse = getComputedStyle(activeHost);
						h += (parseFloat(cse.paddingTop || '0') || 0) + (parseFloat(cse.paddingBottom || '0') || 0);
						h += (parseFloat(cse.borderTopWidth || '0') || 0) + (parseFloat(cse.borderBottomWidth || '0') || 0);
					} catch (e) { console.error('[kusto]', e); }
					return Math.max(0, Math.ceil(h));
				} catch {
					return 0;
				}
			})();

			let resultsContentH = 0;
			let hasTable = false;
			let tableSlackPx = 0;
			try {
				if (resultsEl) {
					try {
						const csr = getComputedStyle(resultsEl);
						resultsContentH += (parseFloat(csr.paddingTop || '0') || 0) + (parseFloat(csr.paddingBottom || '0') || 0);
						resultsContentH += (parseFloat(csr.borderTopWidth || '0') || 0) + (parseFloat(csr.borderBottomWidth || '0') || 0);
					} catch (e) { console.error('[kusto]', e); }

					const headerEl = resultsEl.querySelector ? resultsEl.querySelector('.results-header') : null;
					resultsContentH += addVisibleRectHeight(headerEl);

					const bodyEl = resultsEl.querySelector ? resultsEl.querySelector('.results-body') : null;
					if (bodyEl) {
						try {
							const csb = getComputedStyle(bodyEl);
							resultsContentH += (parseFloat(csb.paddingTop || '0') || 0) + (parseFloat(csb.paddingBottom || '0') || 0);
							resultsContentH += (parseFloat(csb.borderTopWidth || '0') || 0) + (parseFloat(csb.borderBottomWidth || '0') || 0);
						} catch (e) { console.error('[kusto]', e); }

						const dataSearch = bodyEl.querySelector ? bodyEl.querySelector('.data-search') : null;
						const colSearch = bodyEl.querySelector ? bodyEl.querySelector('.column-search') : null;
						resultsContentH += addVisibleRectHeight(dataSearch);
						resultsContentH += addVisibleRectHeight(colSearch);

						const tableContainer = bodyEl.querySelector ? bodyEl.querySelector('.table-container') : null;
						if (tableContainer) {
							hasTable = true;
							let tableH = 0;
							try {
								const tableEl = tableContainer.querySelector ? tableContainer.querySelector('table') : null;
								if (tableEl) {
									// When the table only has a single data row, the rendered height can end up
									// ~1-2px taller than our measured heights (borders/collapsed border rounding).
									// Add a tiny slack to avoid clipping / a 1px scrollbar.
									try {
										let rowCount = 0;
										const tbody = (tableEl.tBodies && tableEl.tBodies.length) ? tableEl.tBodies[0] : null;
										if (tbody && tbody.rows) {
											rowCount = tbody.rows.length;
										} else if (tableEl.querySelectorAll) {
											rowCount = tableEl.querySelectorAll('tbody tr').length;
										}
										if (rowCount <= 1) {
											tableSlackPx = Math.max(tableSlackPx, 2);
										}
									} catch (e) { console.error('[kusto]', e); }

									const oh = (typeof tableEl.offsetHeight === 'number') ? tableEl.offsetHeight : 0;
									if (oh && Number.isFinite(oh)) tableH = Math.max(tableH, oh);
									const rh = (tableEl.getBoundingClientRect ? (tableEl.getBoundingClientRect().height || 0) : 0);
									if (rh && Number.isFinite(rh)) tableH = Math.max(tableH, rh);
								}
							} catch (e) { console.error('[kusto]', e); }
							if (!tableH) {
								try {
									const sh = (typeof tableContainer.scrollHeight === 'number') ? tableContainer.scrollHeight : 0;
									if (sh && Number.isFinite(sh)) tableH = Math.max(tableH, sh);
								} catch (e) { console.error('[kusto]', e); }
							}
							if (!tableH) {
								tableH = addVisibleRectHeight(tableContainer);
							}
							resultsContentH += Math.max(0, Math.ceil(tableH));
						} else {
							try {
								for (const child of Array.from(bodyEl.children || []) as any[]) {
									resultsContentH += addVisibleRectHeight(child);
								}
							} catch (e) { console.error('[kusto]', e); }
						}
					} else {
						try {
							for (const child of Array.from(resultsEl.children || []) as any[]) {
								resultsContentH += addVisibleRectHeight(child);
							}
						} catch (e) { console.error('[kusto]', e); }
					}
				}
			} catch (e) { console.error('[kusto]', e); }

			const extraPad = hasTable ? 38 : 18;
			desired = Math.ceil(Math.max(0, controlsH) + resultsWrapperMargins + resultsWrapperBoxExtra + Math.max(0, resultsContentH) + extraPad + tableSlackPx);
		} catch (e) { console.error('[kusto]', e); }
		if (!desired || !Number.isFinite(desired)) {
			desired = Math.ceil(activeHost.scrollHeight + 19);
		}
		desired = Math.max(80, Math.min(900, desired));
		return desired;
	} catch {
		return null;
	}
}

export function __kustoMaybeAutoFitTransformationBox( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const wrapper = document.getElementById(id + '_tf_wrapper') as any;
		if (!wrapper) return;
		const desired = __kustoComputeTransformationFitHeightPx(id);
		if (!desired) return;
		const current = wrapper.getBoundingClientRect().height;
		const active = String(wrapper.dataset.kustoAutoFitActive || '') === 'true';
		const allowShrink = String(wrapper.dataset.kustoAutoFitAllowShrink || '') === 'true';
		// If the user has the section at least "fit" size, keep auto-fit active.
		if (!active && current >= desired - 2) {
			try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch (e) { console.error('[kusto]', e); }
		}
		const nowActive = String(wrapper.dataset.kustoAutoFitActive || '') === 'true';
		if (!nowActive) return;
		// Default is grow-only to avoid jitter while editing; allowShrink is a one-shot override.
		if (desired > current + 2 || (allowShrink && desired < current - 2)) {
			wrapper.style.height = desired + 'px';
			try { wrapper.dataset.kustoUserResized = 'true'; } catch (e) { console.error('[kusto]', e); }
			try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		}
		if (allowShrink) {
			try { delete wrapper.dataset.kustoAutoFitAllowShrink; } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function removeTransformationBox( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try { _win.__kustoCleanupSectionModeResizeObserver(id); } catch (e) { console.error('[kusto]', e); }
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
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetTransformationType( boxId: any, type: any) {
	const id = String(boxId || '');
	const t = String(type || '').toLowerCase();
	if (!id) return;
	if (!(t in __kustoTransformationTypeLabels)) return;
	const st = __kustoGetTransformationState(id);
	st.transformationType = t;
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	// Changing transformation types can significantly change the controls height.
	// If the section is in auto-fit mode (Fit to contents), re-measure after the DOM updates.
	try {
		const runFit = () => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (!w) return;
				const active = String(w.dataset.kustoAutoFitActive || '') === 'true';
				const userResized = String(w.dataset.kustoUserResized || '') === 'true';
				// If auto-fit is active, allow a one-shot shrink/grow. If the user hasn't resized,
				// keep it fitting as the UI changes.
				if (active || !userResized) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
					// Force layout so measurements reflect the new type's control visibility.
					try {
						const resultsWrapper = document.getElementById(id + '_results_wrapper') as any;
						if (resultsWrapper) void resultsWrapper.offsetHeight;
						const controlsHost = document.getElementById(id + '_tf_controls') as any;
						if (controlsHost) void controlsHost.offsetHeight;
					} catch (e) { console.error('[kusto]', e); }
					try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		};
		setTimeout(runFit, 0);
		setTimeout(runFit, 80);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnTransformationDataSourceChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	try {
		const sel = document.getElementById(id + '_tf_ds') as any;
		const st = __kustoGetTransformationState(id);
		st.dataSourceId = sel ? String(sel.value || '') : '';
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoSetCheckboxDropdownText( btnTextEl: any, selectedValues: any) {
	try {
		if (!btnTextEl) return;
		const vals = Array.isArray(selectedValues) ? selectedValues.filter((v: any) => v) : [];
		if (!vals.length) {
			btnTextEl.textContent = '(none)';
			try { btnTextEl.title = '(none)'; } catch (e) { console.error('[kusto]', e); }
			return;
		}

		const all = vals.map((v: any) => String(v)).filter((v: any) => v).join(', ');
		btnTextEl.textContent = all;
		try { btnTextEl.title = all; } catch (e) { console.error('[kusto]', e); }

		// If it doesn't fit, include as many values as will fit and add an ellipsis.
		try {
			const fits = () => {
				try {
					const cw = btnTextEl.clientWidth || 0;
					const sw = btnTextEl.scrollWidth || 0;
					return cw <= 0 || sw <= cw + 1;
				} catch {
					return true;
				}
			};

			if (fits()) return;

			let shown = '';
			for (let i = 0; i < vals.length; i++) {
				const next = String(vals[i] || '');
				if (!next) continue;
				const candidateBase = shown ? (shown + ', ' + next) : next;
				const hasMore = i < vals.length - 1;
				const candidate = hasMore ? (candidateBase + '…') : candidateBase;
				btnTextEl.textContent = candidate;
				if (fits()) {
					shown = candidateBase;
					continue;
				}
				// If adding this one doesn't fit, revert and keep current.
				btnTextEl.textContent = shown ? (shown + '…') : (next + '…');
				break;
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoBuildCheckboxMenuHtml( boxId: any, options: any, selectedSet: any) {
	let html = '';
	for (const opt of options) {
		const v = String(opt || '');
		if (!v) continue;
		const checked = selectedSet && selectedSet.has(v);
		const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(v) : v;
		const js = String(v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
		html +=
			'<div class="kusto-checkbox-item" role="option" aria-selected="' + (checked ? 'true' : 'false') + '" onclick="try{__kustoToggleGroupByColumn(\'' + String(boxId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + '\',\'' + js + '\')}catch{}">' +
			'<input type="checkbox" ' + (checked ? 'checked' : '') + ' tabindex="-1" />' +
			'<span>' + esc + '</span>' +
			'</div>';
	}
	if (!html) {
		html = '<div class="kusto-checkbox-item" style="opacity:0.7">(no columns)</div>';
	}
	return html;
}

export function __kustoToggleGroupByColumn( boxId: any, columnName: any) {
	const id = String(boxId || '');
	const col = String(columnName || '');
	if (!id || !col) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [];
	const set = new Set(st.groupByColumns.map((c: any) => String(c)));
	if (set.has(col)) set.delete(col); else set.add(col);
	st.groupByColumns = Array.from(set);
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoUpdateTransformationBuilderUI( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;

	// Lit elements handle their own UI — skip legacy DOM updates.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') return;
	} catch (e) { console.error('[kusto]', e); }

	const st = __kustoGetTransformationState(id);

	// Type picker
	try {
		const picker = document.getElementById(id + '_tf_type_picker') as any;
		if (picker) {
			const btns = picker.querySelectorAll('button[data-type]');
			for (const b of btns) {
				try {
					const t = String(b.getAttribute('data-type') || '');
					b.classList.toggle('is-active', t && t === String(st.transformationType || ''));
				} catch (e) { console.error('[kusto]', e); }
			}
		}
	} catch (e) { console.error('[kusto]', e); }

	// Data source dropdown
	const datasets = _win.__kustoGetChartDatasetsInDomOrder();
	const dsSelect = document.getElementById(id + '_tf_ds') as any;
	try {
		if (dsSelect) {
			const labelMap: any = {};
			// Filter out the current transformation's own ID to prevent circular dependency.
			const values = datasets
				.filter((d: any) => String(d.id) !== id)
				.map((d: any) => {
					labelMap[d.id] = d.label;
					return d.id;
				});
			_win.__kustoSetSelectOptions(dsSelect, values, String(st.dataSourceId || ''), labelMap);
			try {
				const txt = document.getElementById(id + '_tf_ds_text') as any;
				if (txt) {
					const selected = String(dsSelect.value || '');
					txt.textContent = (selected && labelMap[selected]) ? labelMap[selected] : (selected || '(select)');
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }

	// Config sections
	try {
		const deriveHost = document.getElementById(id + '_tf_cfg_derive') as any;
		const sumHost = document.getElementById(id + '_tf_cfg_summarize') as any;
		const distinctHost = document.getElementById(id + '_tf_cfg_distinct') as any;
		const pivotHost = document.getElementById(id + '_tf_cfg_pivot') as any;
		if (deriveHost) deriveHost.style.display = (st.transformationType === 'derive') ? '' : 'none';
		if (sumHost) sumHost.style.display = (st.transformationType === 'summarize') ? '' : 'none';
		if (distinctHost) distinctHost.style.display = (st.transformationType === 'distinct') ? '' : 'none';
		if (pivotHost) pivotHost.style.display = (st.transformationType === 'pivot') ? '' : 'none';
	} catch (e) { console.error('[kusto]', e); }

	// Column-dependent controls
	const ds = datasets.find((d: any) => String(d.id) === String(st.dataSourceId || ''));
	const colNames = ds ? (ds.columns || []).map(_win.__kustoNormalizeResultsColumnName).filter((c: any) => c) : [];

	// Derive
	try {
		const host = document.getElementById(id + '_tf_derive_rows') as any;
		if (host) {
			// Ensure deriveColumns exists
			if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
				st.deriveColumns = [{ name: '', expression: '' }];
			}
			let html = '';
			for (let i = 0; i < st.deriveColumns.length; i++) {
				const row = st.deriveColumns[i] || {};
				const name = String(row.name || '');
				const expr = String(row.expression || '');
				const escName = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(name) : name;
				const escExpr = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(expr) : expr;
				const nameInputId = id + '_tf_derive_name_' + i;
				const exprInputId = id + '_tf_derive_expr_' + i;
				html +=
					'<div class="kusto-transform-derive-row" data-kusto-no-editor-focus="true" ondragover="try{__kustoOnDeriveDragOver(\'' + id + '\',' + i + ', event)}catch{}" ondrop="try{__kustoOnDeriveDrop(\'' + id + '\',' + i + ', event)}catch{}">' +
						'<input id="' + nameInputId + '" type="text" class="kusto-transform-input kusto-transform-derive-name" value="' + escName + '" placeholder="Column name" aria-label="New column name" oninput="try{__kustoOnCalculatedColumnChanged(\'' + id + '\',' + i + ',\'name\', this.value)}catch{}" />' +
						'<span class="kusto-transform-derive-eq" aria-hidden="true">=</span>' +
						'<textarea id="' + exprInputId + '" class="kusto-transform-textarea kusto-transform-derive-expr" rows="1" placeholder="Expression (e.g. [Amount] * 1.2)" aria-label="Expression" oninput="try{__kustoOnCalculatedColumnChanged(\'' + id + '\',' + i + ',\'expression\', this.value)}catch{}" onmouseenter="__kustoShowExpressionHelpTooltip(this, event)" onmouseleave="__kustoHideExpressionHelpTooltip()" onfocus="__kustoHideExpressionHelpTooltipImmediate()">' + escExpr + '</textarea>' +
						'<div class="kusto-transform-derive-row-actions" data-kusto-no-editor-focus="true">' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoAddCalculatedColumn(\'' + id + '\',' + i + ')}catch{}" title="Add column" aria-label="Add column">' + __kustoTransformMiniPlusIconSvg + '</button>' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoRemoveCalculatedColumn(\'' + id + '\',' + i + ')}catch{}" ' + (st.deriveColumns.length <= 1 ? 'disabled' : '') + ' title="Remove column" aria-label="Remove column">' + __kustoTransformMiniTrashIconSvg + '</button>' +
							'<button type="button" class="section-drag-handle kusto-transform-derive-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder column" ondragstart="try{__kustoOnDeriveDragStart(\'' + id + '\',' + i + ', event)}catch{}" ondragend="try{__kustoOnDeriveDragEnd(\'' + id + '\', event)}catch{}"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
						'</div>' +
					'</div>';
			}
			host.innerHTML = html;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Summarize: group-by rows (multiple columns with add/remove)
	try {
		const host = document.getElementById(id + '_tf_groupby_rows') as any;
		if (host) {
			if (!Array.isArray(st.groupByColumns) || st.groupByColumns.length === 0) {
				st.groupByColumns = [''];
			}
			const groupByCols = Array.isArray(st.groupByColumns) ? st.groupByColumns : [''];
			let html = '';
			for (let i = 0; i < groupByCols.length; i++) {
				const col = String(groupByCols[i] || '');
				const selectId = id + '_tf_groupby_col_' + i;
				html +=
					'<div class="kusto-transform-groupby-row" data-kusto-no-editor-focus="true" ondragover="try{__kustoOnGroupByDragOver(\'' + id + '\',' + i + ', event)}catch{}" ondrop="try{__kustoOnGroupByDrop(\'' + id + '\',' + i + ', event)}catch{}">' +
						'<select id="' + selectId + '" class="kusto-transform-select kusto-transform-groupby-select" onchange="try{__kustoOnGroupByColumnChanged(\'' + id + '\',' + i + ', this.value)}catch{}">' +
							'<option value=""' + (col ? '' : ' selected') + '>(select column)</option>';
				for (const c of colNames) {
					const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(c) : c;
					html += '<option value="' + esc + '"' + (c === col ? ' selected' : '') + '>' + esc + '</option>';
				}
				html +=
						'</select>' +
						'<div class="kusto-transform-groupby-row-actions" data-kusto-no-editor-focus="true">' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoAddGroupByColumn(\'' + id + '\',' + i + ')}catch{}" title="Add group-by column" aria-label="Add group-by column">' + __kustoTransformMiniPlusIconSvg + '</button>' +
							'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoRemoveGroupByColumn(\'' + id + '\',' + i + ')}catch{}" ' + (groupByCols.length <= 1 ? 'disabled' : '') + ' title="Remove group-by column" aria-label="Remove group-by column">' + __kustoTransformMiniTrashIconSvg + '</button>' +
							'<button type="button" class="section-drag-handle kusto-transform-groupby-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder group-by column" ondragstart="try{__kustoOnGroupByDragStart(\'' + id + '\',' + i + ', event)}catch{}" ondragend="try{__kustoOnGroupByDragEnd(\'' + id + '\', event)}catch{}"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
						'</div>' +
					'</div>';
			}
			host.innerHTML = html;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Summarize: aggregations list
	try {
		const host = document.getElementById(id + '_tf_aggs') as any;
		if (host) {
			if (!Array.isArray(st.aggregations) || st.aggregations.length === 0) {
				st.aggregations = [{ name: '', function: 'count', column: '' }];
			}
			const aggs = Array.isArray(st.aggregations) ? st.aggregations : [];
			let html = '';
			for (let i = 0; i < aggs.length; i++) {
				const a = aggs[i] || {};
				const nm = String(a.name || '');
				const fn = String(a.function || 'count');
				const col = String(a.column || '');
				const escName = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(nm) : nm;
				const fnSelectId = id + '_tf_agg_fn_' + i;
				const colSelectId = id + '_tf_agg_col_' + i;
				const nameInputId = id + '_tf_agg_name_' + i;
				html +=
					'<div class="kusto-transform-agg-row" data-kusto-no-editor-focus="true" ondragover="try{__kustoOnAggDragOver(\'' + id + '\',' + i + ', event)}catch{}" ondrop="try{__kustoOnAggDrop(\'' + id + '\',' + i + ', event)}catch{}">' +
					'<input id="' + nameInputId + '" type="text" class="kusto-transform-input kusto-transform-agg-name" value="' + escName + '" placeholder="Column name" aria-label="Output column name" oninput="try{__kustoOnTransformationAggChanged(\'' + id + '\',' + i + ', null, null, this.value)}catch{}" />' +
					'<span class="kusto-transform-agg-eq" aria-hidden="true">=</span>' +
					'<select id="' + fnSelectId + '" class="kusto-transform-select" onchange="try{__kustoOnTransformationAggChanged(\'' + id + '\',' + i + ', this.value, null)}catch{}">' +
						'<option value="count" ' + (fn === 'count' ? 'selected' : '') + '>count</option>' +
						'<option value="sum" ' + (fn === 'sum' ? 'selected' : '') + '>sum</option>' +
						'<option value="avg" ' + (fn === 'avg' ? 'selected' : '') + '>avg</option>' +
						'<option value="min" ' + (fn === 'min' ? 'selected' : '') + '>min</option>' +
						'<option value="max" ' + (fn === 'max' ? 'selected' : '') + '>max</option>' +
						'<option value="distinct" ' + (fn === 'distinct' ? 'selected' : '') + '>distinct</option>' +
					'</select>' +
					'<select id="' + colSelectId + '" class="kusto-transform-select" onchange="try{__kustoOnTransformationAggChanged(\'' + id + '\',' + i + ', null, this.value, null)}catch{}" ' + (fn === 'count' ? 'disabled' : '') + '>';
				html += '<option value=""' + (col ? '' : ' selected') + '>(select)</option>';
				for (const c of colNames) {
					const esc = (typeof _win.escapeHtml === 'function') ? _win.escapeHtml(c) : c;
					html += '<option value="' + esc + '"' + (c === col ? ' selected' : '') + '>' + esc + '</option>';
				}
				html +=
					'</select>' +
					'<div class="kusto-transform-agg-row-actions" data-kusto-no-editor-focus="true">' +
						'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoAddTransformationAgg(\'' + id + '\',' + i + ')}catch{}" title="Add aggregation" aria-label="Add aggregation">' + __kustoTransformMiniPlusIconSvg + '</button>' +
						'<button type="button" class="unified-btn-secondary unified-btn-icon-only kusto-transform-mini-btn" onclick="try{__kustoRemoveTransformationAgg(\'' + id + '\',' + i + ')}catch{}" ' + (aggs.length <= 1 ? 'disabled' : '') + ' title="Remove aggregation" aria-label="Remove aggregation">' + __kustoTransformMiniTrashIconSvg + '</button>' +
						'<button type="button" class="section-drag-handle kusto-transform-agg-drag-handle" draggable="true" title="Drag to reorder" aria-label="Reorder aggregation" ondragstart="try{__kustoOnAggDragStart(\'' + id + '\',' + i + ', event)}catch{}" ondragend="try{__kustoOnAggDragEnd(\'' + id + '\', event)}catch{}"><span class="section-drag-handle-glyph" aria-hidden="true">⋮</span></button>' +
					'</div>' +
					'</div>';
			}
			host.innerHTML = html;
		}
	} catch (e) { console.error('[kusto]', e); }

	// Pivot selects
	try {
		const rowSel = document.getElementById(id + '_tf_pivot_row') as any;
		const colSel = document.getElementById(id + '_tf_pivot_col') as any;
		const valSel = document.getElementById(id + '_tf_pivot_val') as any;
		if (rowSel) _win.__kustoSetSelectOptions(rowSel, colNames, String(st.pivotRowKeyColumn || ''), null);
		if (colSel) _win.__kustoSetSelectOptions(colSel, colNames, String(st.pivotColumnKeyColumn || ''), null);
		if (valSel) _win.__kustoSetSelectOptions(valSel, colNames, String(st.pivotValueColumn || ''), null);
		const aggSel = document.getElementById(id + '_tf_pivot_agg') as any;
		if (aggSel && typeof st.pivotAggregation === 'string') aggSel.value = st.pivotAggregation;
		// Sync dropdown button text for custom dropdowns
		try {
			const rowTxt = document.getElementById(id + '_tf_pivot_row_text') as any;
			if (rowTxt && rowSel) rowTxt.textContent = String(rowSel.value || '') || '(select)';
			const colTxt = document.getElementById(id + '_tf_pivot_col_text') as any;
			if (colTxt && colSel) colTxt.textContent = String(colSel.value || '') || '(select)';
			const valTxt = document.getElementById(id + '_tf_pivot_val_text') as any;
			if (valTxt && valSel) valTxt.textContent = String(valSel.value || '') || '(select)';
			const aggTxt = document.getElementById(id + '_tf_pivot_agg_text') as any;
			if (aggTxt && aggSel) aggTxt.textContent = String(aggSel.value || '') || 'sum';
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }

	// Distinct select
	try {
		const sel = document.getElementById(id + '_tf_distinct_col') as any;
		if (sel) {
			_win.__kustoSetSelectOptions(sel, colNames, String(st.distinctColumn || ''), null);
			try {
				const txt = document.getElementById(id + '_tf_distinct_col_text') as any;
				if (txt) {
					const selected = String(sel.value || '');
					txt.textContent = selected || '(select)';
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }

	// If the section is already fit-sized, keep content visible as UI grows.
	try {
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnTransformationDistinctChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	try {
		st.distinctColumn = String(((document.getElementById(id + '_tf_distinct_col') as any || {}).value || ''));
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	// When the distinct column changes, the results can vary significantly in content and width.
	// Allow the section to shrink/grow to fit the new contents.
	try {
		const runFit = () => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (!w) return;
				const userResized = String(w.dataset.kustoUserResized || '') === 'true';
				if (!userResized) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		};
		setTimeout(runFit, 0);
		setTimeout(runFit, 80);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnTransformationAggChanged( boxId: any, index: any, newFn: any, newCol: any, newName: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.aggregations)) st.aggregations = [];
	if (!st.aggregations[i]) st.aggregations[i] = { name: '', function: 'count', column: '' };
	const nameOnlyChange = (typeof newName === 'string') && (typeof newFn !== 'string') && (typeof newCol !== 'string');
	if (typeof newFn === 'string') st.aggregations[i].function = String(newFn);
	if (typeof newCol === 'string') st.aggregations[i].column = String(newCol);
	if (typeof newName === 'string') st.aggregations[i].name = String(newName);
	// If count: clear column
	try {
		if (String(st.aggregations[i].function || '') === 'count') {
			st.aggregations[i].column = '';
		}
	} catch (e) { console.error('[kusto]', e); }
	// IMPORTANT: Editing the aggregation name is a keystroke-heavy interaction.
	// Avoid rebuilding the summarize UI on every keypress (it steals focus).
	if (!nameOnlyChange) {
		try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
		try {
			setTimeout(() => {
				try {
					const w = document.getElementById(id + '_tf_wrapper') as any;
					if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
						w.dataset.kustoAutoFitActive = 'true';
					}
				} catch (e) { console.error('[kusto]', e); }
				try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
			}, 0);
		} catch (e) { console.error('[kusto]', e); }
	}
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoAddTransformationAgg( boxId: any) {
	const id = String(boxId || '');
	const insertAfterIndex = arguments.length >= 2 ? Number(arguments[1]) : NaN;
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.aggregations) || st.aggregations.length === 0) st.aggregations = [{ name: '', function: 'count', column: '' }];
	let insertedIndex = st.aggregations.length;
	if (Number.isFinite(insertAfterIndex) && insertAfterIndex >= 0 && insertAfterIndex < st.aggregations.length) {
		insertedIndex = Math.floor(insertAfterIndex) + 1;
		st.aggregations.splice(insertedIndex, 0, { name: '', function: 'count', column: '' });
	} else {
		st.aggregations.push({ name: '', function: 'count', column: '' });
		insertedIndex = st.aggregations.length - 1;
	}
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try {
		setTimeout(() => {
			try {
				const el = document.getElementById(id + '_tf_agg_name_' + insertedIndex) as any;
				if (el && typeof el.focus === 'function') el.focus();
			} catch (e) { console.error('[kusto]', e); }
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoRemoveTransformationAgg( boxId: any, index: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.aggregations)) st.aggregations = [];
	if (st.aggregations.length <= 1) return;
	st.aggregations.splice(i, 1);
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try {
		// When removing aggregations, shrink-to-fit (one-shot) if auto-fit is enabled.
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 80);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// Group-by column handlers for Summarize
export function __kustoOnGroupByColumnChanged( boxId: any, index: any, value: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [''];
	if (i >= 0 && i < st.groupByColumns.length) {
		st.groupByColumns[i] = String(value || '');
	}
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoAddGroupByColumn( boxId: any, insertAfterIndex: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns) || st.groupByColumns.length === 0) st.groupByColumns = [''];
	let insertedIndex = st.groupByColumns.length;
	if (Number.isFinite(insertAfterIndex) && insertAfterIndex >= 0 && insertAfterIndex < st.groupByColumns.length) {
		insertedIndex = Math.floor(insertAfterIndex) + 1;
		st.groupByColumns.splice(insertedIndex, 0, '');
	} else {
		st.groupByColumns.push('');
		insertedIndex = st.groupByColumns.length - 1;
	}
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try {
		setTimeout(() => {
			try {
				const el = document.getElementById(id + '_tf_groupby_col_' + insertedIndex) as any;
				if (el && typeof el.focus === 'function') el.focus();
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoRemoveGroupByColumn( boxId: any, index: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [''];
	if (st.groupByColumns.length <= 1) return;
	st.groupByColumns.splice(i, 1);
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try {
		setTimeout(() => {
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// Group-by drag and drop handlers
export function __kustoOnGroupByDragStart( boxId: any, index: any, event: any) {
	try {
		const id = String(boxId || '');
		const i = Number(index);
		if (!id || !Number.isFinite(i)) return;
		window.__kustoGroupByDragState = { boxId: id, fromIndex: Math.floor(i), overIndex: null, insertAfter: false };
		try {
			const e = event;
			if (e && e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				try { e.dataTransfer.setData('text/plain', 'kusto-groupby'); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const host = document.getElementById(id + '_tf_groupby_rows') as any;
			if (host) host.classList.add('is-dragging');
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoClearGroupByDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoClearGroupByDropIndicators( boxId: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_groupby_rows') as any;
		if (host) {
			host.querySelectorAll('.kusto-transform-groupby-row').forEach((r: any) => {
				r.classList.remove('is-drop-target', 'is-drop-before', 'is-drop-after');
			});
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnGroupByDragOver( boxId: any, index: any, event: any) {
	try {
		const e = event;
		const state = window.__kustoGroupByDragState;
		if (!state || state.boxId !== boxId) return;
		if (e && typeof e.preventDefault === 'function') e.preventDefault();
		const id = String(boxId || '');
		const i = Number(index);
		if (!Number.isFinite(i)) return;
		__kustoClearGroupByDropIndicators(id);
		const row = (e.target as any).closest('.kusto-transform-groupby-row');
		if (!row) return;
		const rect = row.getBoundingClientRect();
		const midY = rect.top + rect.height / 2;
		const insertAfter = e.clientY > midY;
		state.overIndex = Math.floor(i);
		state.insertAfter = insertAfter;
		row.classList.add('is-drop-target');
		row.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnGroupByDragEnd( boxId: any, event: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_groupby_rows') as any;
		if (host) host.classList.remove('is-dragging');
		__kustoClearGroupByDropIndicators(id);
		window.__kustoGroupByDragState = null;
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnGroupByDrop( boxId: any, index: any, event: any) {
	try {
		const e = event;
		if (e && typeof e.preventDefault === 'function') e.preventDefault();
		const state = window.__kustoGroupByDragState;
		if (!state || state.boxId !== boxId) return;
		const id = String(boxId || '');
		const fromIdx = state.fromIndex;
		let toIdx = state.overIndex;
		const insertAfter = state.insertAfter;
		if (!Number.isFinite(fromIdx) || !Number.isFinite(toIdx)) return;
		if (insertAfter) toIdx++;
		if (fromIdx < toIdx) toIdx--;
		if (fromIdx === toIdx) {
			__kustoOnGroupByDragEnd(id, e);
			return;
		}
		const st = __kustoGetTransformationState(id);
		if (!Array.isArray(st.groupByColumns)) st.groupByColumns = [''];
		const arr = st.groupByColumns;
		const item = arr.splice(fromIdx, 1)[0];
		arr.splice(toIdx, 0, item);
		__kustoOnGroupByDragEnd(id, e);
		try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
		try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnAggDragStart( boxId: any, index: any, event: any) {
	try {
		const id = String(boxId || '');
		const i = Number(index);
		if (!id || !Number.isFinite(i)) return;
		window.__kustoAggDragState = { boxId: id, fromIndex: Math.floor(i), overIndex: null, insertAfter: false };
		try {
			const e = event;
			if (e && e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				try { e.dataTransfer.setData('text/plain', 'kusto-agg'); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const host = document.getElementById(id + '_tf_aggs') as any;
			if (host) host.classList.add('is-dragging');
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoClearAggDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoClearAggDropIndicators( boxId: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_aggs') as any;
		if (!host) return;
		const rows = host.querySelectorAll('.kusto-transform-agg-row');
		for (const r of rows) {
			try {
				r.classList.remove('is-drop-target');
				r.classList.remove('is-drop-before');
				r.classList.remove('is-drop-after');
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnAggDragOver( boxId: any, overIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const idx = Number(overIndex);
		const e = event;
		if (!id || !Number.isFinite(idx) || !e) return;
		try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (e) { console.error('[kusto]', e); }
		const drag = window.__kustoAggDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		let insertAfter = false;
		try {
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.getBoundingClientRect) {
				const rect = rowEl.getBoundingClientRect();
				const y = e.clientY;
				insertAfter = y >= (rect.top + rect.height / 2);
			}
		} catch (e) { console.error('[kusto]', e); }
		drag.overIndex = Math.floor(idx);
		drag.insertAfter = !!insertAfter;
		try {
			__kustoClearAggDropIndicators(id);
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.classList) {
				rowEl.classList.add('is-drop-target');
				rowEl.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnAggDrop( boxId: any, toIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const to = Number(toIndex);
		if (!id || !Number.isFinite(to)) return;
		try { event && event.preventDefault && event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		const drag = window.__kustoAggDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		const from = Number(drag.fromIndex);
		if (!Number.isFinite(from)) return;
		const st = __kustoGetTransformationState(id);
		if (!Array.isArray(st.aggregations) || st.aggregations.length < 2) return;
		const fromIdx = Math.max(0, Math.min(st.aggregations.length - 1, Math.floor(from)));
		const overIdx = Number.isFinite(drag.overIndex) ? Math.floor(drag.overIndex) : Math.floor(to);
		const insertAfter = !!drag.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(st.aggregations.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			try { __kustoClearAggDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		const moved = st.aggregations.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? (insertion - 1) : insertion;
		st.aggregations.splice(toInsert, 0, moved);
		try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
		try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		try { __kustoClearAggDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnAggDragEnd( boxId: any, event: any) {
	try {
		const id = String(boxId || '');
		window.__kustoAggDragState = null;
		try {
			const host = document.getElementById(id + '_tf_aggs') as any;
			if (host) host.classList.remove('is-dragging');
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoClearAggDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
		try { event && event.preventDefault && event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnCalculatedColumnChanged( boxId: any, index: any, field: any, value: any) {
	const id = String(boxId || '');
	const i = Number(index);
	const f = String(field || '');
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
		st.deriveColumns = [{ name: '', expression: '' }];
	}
	if (!st.deriveColumns[i]) st.deriveColumns[i] = { name: '', expression: '' };
	if (f === 'name') st.deriveColumns[i].name = String(value || '');
	if (f === 'expression') st.deriveColumns[i].expression = String(value || '');
	// Keep legacy single-field properties in sync for safety.
	try {
		if (i === 0) {
			st.deriveColumnName = String(st.deriveColumns[0].name || '');
			st.deriveExpression = String(st.deriveColumns[0].expression || '');
		}
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try {
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoAddCalculatedColumn( boxId: any) {
	const id = String(boxId || '');
	const insertAfterIndex = arguments.length >= 2 ? Number(arguments[1]) : NaN;
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length === 0) {
		st.deriveColumns = [{ name: '', expression: '' }];
	}
	let insertedIndex = st.deriveColumns.length;
	if (Number.isFinite(insertAfterIndex) && insertAfterIndex >= 0 && insertAfterIndex < st.deriveColumns.length) {
		insertedIndex = Math.floor(insertAfterIndex) + 1;
		st.deriveColumns.splice(insertedIndex, 0, { name: '', expression: '' });
	} else {
		st.deriveColumns.push({ name: '', expression: '' });
		insertedIndex = st.deriveColumns.length - 1;
	}
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try {
		setTimeout(() => {
			try {
				const el = document.getElementById(id + '_tf_derive_name_' + insertedIndex) as any;
				if (el && typeof el.focus === 'function') el.focus();
			} catch (e) { console.error('[kusto]', e); }
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w && !(w.dataset && w.dataset.kustoUserResized === 'true')) {
					w.dataset.kustoAutoFitActive = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoRemoveCalculatedColumn( boxId: any, index: any) {
	const id = String(boxId || '');
	const i = Number(index);
	if (!id || !Number.isFinite(i)) return;
	const st = __kustoGetTransformationState(id);
	if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length <= 1) return;
	st.deriveColumns.splice(i, 1);
	try {
		// Keep legacy single-field properties in sync.
		const first = st.deriveColumns[0] || { name: '', expression: '' };
		st.deriveColumnName = String(first.name || '');
		st.deriveExpression = String(first.expression || '');
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	try {
		// When removing columns, shrink-to-fit (one-shot) if auto-fit is enabled.
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 0);
		setTimeout(() => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (w) {
					w.dataset.kustoAutoFitActive = 'true';
					w.dataset.kustoAutoFitAllowShrink = 'true';
				}
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); }
		}, 80);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnDeriveDragStart( boxId: any, index: any, event: any) {
	try {
		const id = String(boxId || '');
		const i = Number(index);
		if (!id || !Number.isFinite(i)) return;
		window.__kustoDeriveDragState = { boxId: id, fromIndex: Math.floor(i), overIndex: null, insertAfter: false };
		try {
			const e = event;
			if (e && e.dataTransfer) {
				e.dataTransfer.effectAllowed = 'move';
				try { e.dataTransfer.setData('text/plain', 'kusto-derive'); } catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
		try {
			const host = document.getElementById(id + '_tf_derive_rows') as any;
			if (host) host.classList.add('is-dragging');
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoClearDeriveDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoClearDeriveDropIndicators( boxId: any) {
	try {
		const id = String(boxId || '');
		const host = document.getElementById(id + '_tf_derive_rows') as any;
		if (!host) return;
		const rows = host.querySelectorAll('.kusto-transform-derive-row');
		for (const r of rows) {
			try {
				r.classList.remove('is-drop-target');
				r.classList.remove('is-drop-before');
				r.classList.remove('is-drop-after');
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnDeriveDragOver( boxId: any, overIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const idx = Number(overIndex);
		const e = event;
		if (!id || !Number.isFinite(idx) || !e) return;
		try { e.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		try { if (e.dataTransfer) e.dataTransfer.dropEffect = 'move'; } catch (e) { console.error('[kusto]', e); }
		const drag = window.__kustoDeriveDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		let insertAfter = false;
		try {
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.getBoundingClientRect) {
				const rect = rowEl.getBoundingClientRect();
				const y = e.clientY;
				insertAfter = y >= (rect.top + rect.height / 2);
			}
		} catch (e) { console.error('[kusto]', e); }
		drag.overIndex = Math.floor(idx);
		drag.insertAfter = !!insertAfter;
		try {
			__kustoClearDeriveDropIndicators(id);
			const rowEl = e.currentTarget;
			if (rowEl && rowEl.classList) {
				rowEl.classList.add('is-drop-target');
				rowEl.classList.add(insertAfter ? 'is-drop-after' : 'is-drop-before');
			}
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnDeriveDrop( boxId: any, toIndex: any, event: any) {
	try {
		const id = String(boxId || '');
		const to = Number(toIndex);
		if (!id || !Number.isFinite(to)) return;
		try { event && event.preventDefault && event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
		const drag = window.__kustoDeriveDragState;
		if (!drag || String(drag.boxId || '') !== id) return;
		const from = Number(drag.fromIndex);
		if (!Number.isFinite(from)) return;
		const st = __kustoGetTransformationState(id);
		if (!Array.isArray(st.deriveColumns) || st.deriveColumns.length < 2) return;
		const fromIdx = Math.max(0, Math.min(st.deriveColumns.length - 1, Math.floor(from)));
		const overIdx = Number.isFinite(drag.overIndex) ? Math.floor(drag.overIndex) : Math.floor(to);
		const insertAfter = !!drag.insertAfter;
		let insertion = overIdx + (insertAfter ? 1 : 0);
		insertion = Math.max(0, Math.min(st.deriveColumns.length, insertion));
		if (insertion === fromIdx || insertion === fromIdx + 1) {
			try { __kustoClearDeriveDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
			return;
		}
		const moved = st.deriveColumns.splice(fromIdx, 1)[0];
		const toInsert = fromIdx < insertion ? (insertion - 1) : insertion;
		st.deriveColumns.splice(toInsert, 0, moved);
		try {
			const first = st.deriveColumns[0] || { name: '', expression: '' };
			st.deriveColumnName = String(first.name || '');
			st.deriveExpression = String(first.expression || '');
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoUpdateTransformationBuilderUI(id); } catch (e) { console.error('[kusto]', e); }
		try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
		try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		try { __kustoClearDeriveDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnDeriveDragEnd( boxId: any, event: any) {
	try {
		const id = String(boxId || '');
		window.__kustoDeriveDragState = null;
		try {
			const host = document.getElementById(id + '_tf_derive_rows') as any;
			if (host) host.classList.remove('is-dragging');
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoClearDeriveDropIndicators(id); } catch (e) { console.error('[kusto]', e); }
		try { event && event.preventDefault && event.preventDefault(); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoOnTransformationPivotChanged( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;
	const st = __kustoGetTransformationState(id);
	try {
		const rowSel = document.getElementById(id + '_tf_pivot_row') as any;
		const colSel = document.getElementById(id + '_tf_pivot_col') as any;
		const valSel = document.getElementById(id + '_tf_pivot_val') as any;
		const aggSel = document.getElementById(id + '_tf_pivot_agg') as any;
		st.pivotRowKeyColumn = String((rowSel || {}).value || '');
		st.pivotColumnKeyColumn = String((colSel || {}).value || '');
		st.pivotValueColumn = String((valSel || {}).value || '');
		st.pivotAggregation = String((aggSel || {}).value || 'sum');
		// Keep max columns at 100 internally (UI removed)
		st.pivotMaxColumns = 100;
		// Sync dropdown button text for custom dropdowns
		try {
			const rowTxt = document.getElementById(id + '_tf_pivot_row_text') as any;
			if (rowTxt) rowTxt.textContent = st.pivotRowKeyColumn || '(select)';
			const colTxt = document.getElementById(id + '_tf_pivot_col_text') as any;
			if (colTxt) colTxt.textContent = st.pivotColumnKeyColumn || '(select)';
			const valTxt = document.getElementById(id + '_tf_pivot_val_text') as any;
			if (valTxt) valTxt.textContent = st.pivotValueColumn || '(select)';
			const aggTxt = document.getElementById(id + '_tf_pivot_agg_text') as any;
			if (aggTxt) aggTxt.textContent = st.pivotAggregation || 'sum';
		} catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoRenderTransformation(id); } catch (e) { console.error('[kusto]', e); }
	// When pivot settings change, the results can vary significantly in content and width.
	// Allow the section to shrink/grow to fit the new contents.
	try {
		const runFit = () => {
			try {
				const w = document.getElementById(id + '_tf_wrapper') as any;
				if (!w) return;
				w.dataset.kustoAutoFitActive = 'true';
				w.dataset.kustoAutoFitAllowShrink = 'true';
				__kustoMaybeAutoFitTransformationBox(id);
				w.dataset.kustoAutoFitAllowShrink = '';
			} catch (e) { console.error('[kusto]', e); }
		};
		setTimeout(runFit, 0);
	} catch (e) { console.error('[kusto]', e); }
	try { _win.schedulePersist && _win.schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoTryParseFiniteNumber( v: any) {
	try {
		if (typeof _win.__kustoTryParseNumber === 'function') {
			const n = _win.__kustoTryParseNumber(v);
			return (typeof n === 'number' && Number.isFinite(n)) ? n : null;
		}
		const n = (typeof v === 'number') ? v : Number(v);
		return Number.isFinite(n) ? n : null;
	} catch {
		return null;
	}
}

export function __kustoTryParseDate( v: any) {
	try {
		if (v === null || v === undefined) return null;
		if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
		const d = new Date(v);
		return isNaN(d.getTime()) ? null : d;
	} catch {
		return null;
	}
}

export function __kustoFormatDate( d: any, fmt: any) {
	try {
		if (!d || !(d instanceof Date)) return null;
		const pad = (n: any, len?: any) => String(n).padStart(len || 2, '0');
		return (fmt as any)
			.replace(/yyyy/g, d.getFullYear())
			.replace(/yy/g, String(d.getFullYear()).slice(-2))
			.replace(/MM/g, pad(d.getMonth() + 1))
			.replace(/M/g, d.getMonth() + 1)
			.replace(/dd/g, pad(d.getDate()))
			.replace(/d/g, d.getDate())
			.replace(/HH/g, pad(d.getHours()))
			.replace(/H/g, d.getHours())
			.replace(/hh/g, pad(d.getHours() % 12 || 12))
			.replace(/h/g, d.getHours() % 12 || 12)
			.replace(/mm/g, pad(d.getMinutes()))
			.replace(/m/g, d.getMinutes())
			.replace(/ss/g, pad(d.getSeconds()))
			.replace(/s/g, d.getSeconds());
	} catch {
		return null;
	}
}

export function __kustoGetRawCellValueForTransform( cell: any) {
	try { return _win.__kustoGetRawCellValueForChart(cell); } catch (e) { console.error('[kusto]', e); }
	try {
		if (cell && typeof cell === 'object') {
			if ('full' in cell) return cell.full;
			if ('display' in cell) return cell.display;
		}
	} catch (e) { console.error('[kusto]', e); }
	return cell;
}

// --- Expression engine (safe, minimal) for Derive ---

export function __kustoTokenizeExpr( text: any) {
	const s = String(text || '');
	const tokens = [];
	let i = 0;
	const isWs = (ch: any) => ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
	const isDigit = (ch: any) => ch >= '0' && ch <= '9';
	const isIdentStart = (ch: any) => (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' ;
	const isIdent = (ch: any) => isIdentStart(ch) || isDigit(ch);
	while (i < s.length) {
		const ch = s[i];
		if (isWs(ch)) { i++; continue; }
		if (ch === '(' || ch === ')' || ch === ',' || ch === '+' || ch === '-' || ch === '*' || ch === '/') {
			tokens.push({ t: 'op', v: ch });
			i++;
			continue;
		}
		if (ch === '[') {
			let j = i + 1;
			let name = '';
			while (j < s.length && s[j] !== ']') {
				name += s[j];
				j++;
			}
			if (j >= s.length) throw new Error('Unclosed [column] reference');
			tokens.push({ t: 'col', v: name.trim() });
			i = j + 1;
			continue;
		}
		if (ch === '"' || ch === "'") {
			const quote = ch;
			let j = i + 1;
			let out = '';
			while (j < s.length) {
				const c = s[j];
				if (c === '\\' && j + 1 < s.length) {
					out += s[j + 1];
					j += 2;
					continue;
				}
				if (c === quote) break;
				out += c;
				j++;
			}
			if (j >= s.length) throw new Error('Unclosed string literal');
			tokens.push({ t: 'str', v: out });
			i = j + 1;
			continue;
		}
		if (isDigit(ch) || (ch === '.' && i + 1 < s.length && isDigit(s[i + 1]))) {
			let j = i;
			let num = '';
			while (j < s.length) {
				const c = s[j];
				if (isDigit(c) || c === '.') {
					num += c;
					j++;
					continue;
				}
				break;
			}
			const n = Number(num);
			if (!Number.isFinite(n)) throw new Error('Invalid number: ' + num);
			tokens.push({ t: 'num', v: n });
			i = j;
			continue;
		}
		if (isIdentStart(ch)) {
			let j = i;
			let id = '';
			while (j < s.length && isIdent(s[j])) {
				id += s[j];
				j++;
			}
			tokens.push({ t: 'id', v: id });
			i = j;
			continue;
		}
		throw new Error('Unexpected character: ' + ch);
	}
	return tokens;
}

export function __kustoParseExprToRpn( tokens: any) {
	const output: any[] = [];
	const stack: any[] = [];
	const prec: any = { 'u-': 4, '*': 3, '/': 3, '+': 2, '-': 2 };
	const rightAssoc: any = { 'u-': true };
	const isOp = (v: any) => v === '+' || v === '-' || v === '*' || v === '/' || v === 'u-';
	let prev = null;
	for (let i = 0; i < tokens.length; i++) {
		const tok = tokens[i];
		if (tok.t === 'num' || tok.t === 'str' || tok.t === 'col') {
			output.push(tok);
			prev = tok;
			continue;
		}
		if (tok.t === 'id') {
			// Function call if next token is '('
			const next = tokens[i + 1];
			if (next && next.t === 'op' && next.v === '(') {
				stack.push({ t: 'fn', v: tok.v });
				prev = tok;
				continue;
			}
			// Otherwise treat as column reference (identifier)
			output.push({ t: 'col', v: tok.v });
			prev = tok;
			continue;
		}
		if (tok.t === 'op') {
			if (tok.v === ',') {
				while (stack.length && !(stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v === '(')) {
					output.push(stack.pop());
				}
				continue;
			}
			if (tok.v === '(') {
				stack.push(tok);
				prev = tok;
				continue;
			}
			if (tok.v === ')') {
				while (stack.length && !(stack[stack.length - 1].t === 'op' && stack[stack.length - 1].v === '(')) {
					output.push(stack.pop());
				}
				if (!stack.length) throw new Error('Mismatched )');
				stack.pop(); // pop '('
				// Pop function if present
				if (stack.length && stack[stack.length - 1].t === 'fn') {
					output.push(stack.pop());
				}
				prev = tok;
				continue;
			}
			// operator
			let op = tok.v;
			if (op === '-') {
				const prevIsValue = prev && (prev.t === 'num' || prev.t === 'str' || prev.t === 'col' || (prev.t === 'op' && prev.v === ')'));
				if (!prevIsValue) op = 'u-';
			}
			if (!isOp(op)) throw new Error('Unsupported operator: ' + op);
			while (stack.length) {
				const top = stack[stack.length - 1];
				if (top.t !== 'op' || !isOp(top.v)) break;
				const p1 = prec[op] || 0;
				const p2 = prec[top.v] || 0;
				if ((rightAssoc[op] && p1 < p2) || (!rightAssoc[op] && p1 <= p2)) {
					output.push(stack.pop());
					continue;
				}
				break;
			}
			stack.push({ t: 'op', v: op });
			prev = tok;
			continue;
		}
		throw new Error('Unexpected token');
	}
	while (stack.length) {
		const top = stack.pop();
		if (top.t === 'op' && (top.v === '(' || top.v === ')')) throw new Error('Mismatched parentheses');
		output.push(top);
	}
	return output;
}

export function __kustoEvalRpn( rpn: any, env: any) {
	const stack = [];
	const getCol = (name: any) => {
		const key = String(name || '');
		if (!key) return null;
		// prefer exact
		if (env && Object.prototype.hasOwnProperty.call(env, key)) return env[key];
		const lower = key.toLowerCase();
		if (env && Object.prototype.hasOwnProperty.call(env, lower)) return env[lower];
		return null;
	};
	const callFn = (fnName: any, args: any) => {
		const f = String(fnName || '').toLowerCase();
		if (f === 'coalesce') {
			for (const a of args) {
				if (a !== null && a !== undefined && String(a) !== '') return a;
			}
			return null;
		}
		if (f === 'tostring') {
			return (args.length ? String(args[0] ?? '') : '');
		}
		if (f === 'tonumber') {
			return __kustoTryParseFiniteNumber(args.length ? args[0] : null);
		}
		if (f === 'len') {
			return String(args.length ? args[0] ?? '' : '').length;
		}
		if (f === 'round') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			if (val === null) return null;
			const digits = args.length > 1 ? __kustoTryParseFiniteNumber(args[1]) : 0;
			if (digits === null || digits < 0 || !Number.isInteger(digits)) {
				// Invalid digits - default to 0 decimal places
				return Math.round(val);
			}
			const factor = Math.pow(10, digits);
			return Math.round(val * factor) / factor;
		}
		if (f === 'floor') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.floor(val);
		}
		if (f === 'ceiling' || f === 'ceil') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.ceil(val);
		}
		if (f === 'abs') {
			const val = __kustoTryParseFiniteNumber(args.length ? args[0] : null);
			return val === null ? null : Math.abs(val);
		}
		// String functions
		if (f === 'trim') {
			return String(args.length ? args[0] ?? '' : '').trim();
		}
		if (f === 'toupper' || f === 'upper') {
			return String(args.length ? args[0] ?? '' : '').toUpperCase();
		}
		if (f === 'tolower' || f === 'lower') {
			return String(args.length ? args[0] ?? '' : '').toLowerCase();
		}
		if (f === 'substring') {
			const text = String(args.length ? args[0] ?? '' : '');
			const start = args.length > 1 ? __kustoTryParseFiniteNumber(args[1]) : 0;
			const len = args.length > 2 ? __kustoTryParseFiniteNumber(args[2]) : undefined;
			if (start === null) return null;
			if (len !== undefined && len !== null) {
				return text.substring(start, start + len);
			}
			return text.substring(start);
		}
		if (f === 'replace') {
			const text = String(args.length ? args[0] ?? '' : '');
			const oldStr = String(args.length > 1 ? args[1] ?? '' : '');
			const newStr = String(args.length > 2 ? args[2] ?? '' : '');
			return text.split(oldStr).join(newStr);
		}
		if (f === 'indexof') {
			const text = String(args.length ? args[0] ?? '' : '');
			const search = String(args.length > 1 ? args[1] ?? '' : '');
			return text.indexOf(search);
		}
		// Date functions
		if (f === 'now') {
			return new Date();
		}
		if (f === 'datetime') {
			const val = args.length ? args[0] : null;
			if (val === null || val === undefined) return null;
			if (val instanceof Date) return val;
			const d = new Date(val);
			return isNaN(d.getTime()) ? null : d;
		}
		if (f === 'getyear') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? d.getFullYear() : null;
		}
		if (f === 'getmonth') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? (d.getMonth() + 1) : null;
		}
		if (f === 'getday') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? d.getDate() : null;
		}
		if (f === 'dayofweek') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			return d ? d.getDay() : null;
		}
		if (f === 'format_datetime') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			const fmt = String(args.length > 1 ? args[1] ?? '' : 'yyyy-MM-dd');
			return __kustoFormatDate(d, fmt);
		}
		if (f === 'datetime_add') {
			const unit = String(args.length ? args[0] ?? '' : '').toLowerCase();
			const amount = args.length > 1 ? __kustoTryParseFiniteNumber(args[1]) : 0;
			const d = __kustoTryParseDate(args.length > 2 ? args[2] : null);
			if (!d || amount === null) return null;
			const result = new Date(d.getTime());
			if (unit === 'year') result.setFullYear(result.getFullYear() + amount);
			else if (unit === 'month') result.setMonth(result.getMonth() + amount);
			else if (unit === 'day') result.setDate(result.getDate() + amount);
			else if (unit === 'hour') result.setHours(result.getHours() + amount);
			else if (unit === 'minute') result.setMinutes(result.getMinutes() + amount);
			else if (unit === 'second') result.setSeconds(result.getSeconds() + amount);
			else return null;
			return result;
		}
		if (f === 'datetime_diff') {
			const unit = String(args.length ? args[0] ?? '' : '').toLowerCase();
			const d1 = __kustoTryParseDate(args.length > 1 ? args[1] : null);
			const d2 = __kustoTryParseDate(args.length > 2 ? args[2] : null);
			if (!d1 || !d2) return null;
			const diffMs = d1.getTime() - d2.getTime();
			if (unit === 'year') return Math.floor(diffMs / (365.25 * 24 * 60 * 60 * 1000));
			if (unit === 'month') return Math.floor(diffMs / (30.44 * 24 * 60 * 60 * 1000));
			if (unit === 'day') return Math.floor(diffMs / (24 * 60 * 60 * 1000));
			if (unit === 'hour') return Math.floor(diffMs / (60 * 60 * 1000));
			if (unit === 'minute') return Math.floor(diffMs / (60 * 1000));
			if (unit === 'second') return Math.floor(diffMs / 1000);
			return null;
		}
		if (f === 'startofday') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
		}
		if (f === 'startofweek') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			const result = new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
			result.setDate(result.getDate() - result.getDay()); // Subtract days to get to Sunday
			return result;
		}
		if (f === 'startofmonth') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), d.getMonth(), 1, 0, 0, 0, 0);
		}
		if (f === 'startofyear') {
			const d = __kustoTryParseDate(args.length ? args[0] : null);
			if (!d) return null;
			return new Date(d.getFullYear(), 0, 1, 0, 0, 0, 0);
		}
		throw new Error('Unknown function: ' + fnName);
	};
	for (const tok of rpn) {
		if (tok.t === 'num' || tok.t === 'str') {
			stack.push(tok.v);
			continue;
		}
		if (tok.t === 'col') {
			stack.push(getCol(tok.v));
			continue;
		}
		if (tok.t === 'op') {
			if (tok.v === 'u-') {
				const a = stack.pop();
				const n = __kustoTryParseFiniteNumber(a);
				stack.push((n === null) ? null : (-n));
				continue;
			}
			const b = stack.pop();
			const a = stack.pop();
			if (tok.v === '+') {
				// number add if both numeric; else concat
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				if (an !== null && bn !== null) stack.push(an + bn);
				else stack.push(String(a ?? '') + String(b ?? ''));
				continue;
			}
			if (tok.v === '-') {
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				stack.push((an === null || bn === null) ? null : (an - bn));
				continue;
			}
			if (tok.v === '*') {
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				stack.push((an === null || bn === null) ? null : (an * bn));
				continue;
			}
			if (tok.v === '/') {
				const an = __kustoTryParseFiniteNumber(a);
				const bn = __kustoTryParseFiniteNumber(b);
				stack.push((an === null || bn === null || bn === 0) ? null : (an / bn));
				continue;
			}
			throw new Error('Unsupported operator: ' + tok.v);
		}
		if (tok.t === 'fn') {
			// Heuristic: pop up to N args if they were pushed since last '(' isn't tracked.
			// To keep this safe/simple, we define the arity for each supported function.
			const name = String(tok.v || '');
			const lower = name.toLowerCase();
			const fnArgCounts: any = {
				'len': 1,
				'tostring': 1,
				'tonumber': 1,
				'round': 2,
				'floor': 1,
				'ceiling': 1,
				'ceil': 1,
				'abs': 1,
				// String functions
				'trim': 1,
				'toupper': 1,
				'upper': 1,
				'tolower': 1,
				'lower': 1,
				'substring': 3,
				'replace': 3,
				'indexof': 2,
				// Date functions
				'now': 0,
				'datetime': 1,
				'getyear': 1,
				'getmonth': 1,
				'getday': 1,
				'dayofweek': 1,
				'startofday': 1,
				'startofweek': 1,
				'startofmonth': 1,
				'startofyear': 1,
				'format_datetime': 2,
				'datetime_add': 3,
				'datetime_diff': 3
			};
			const argc = fnArgCounts[lower] ?? 1;
			const args = [];
			for (let k = 0; k < argc; k++) args.unshift(stack.pop());
			stack.push(callFn(name, args));
			continue;
		}
		throw new Error('Unexpected token in eval');
	}
	return stack.length ? stack[stack.length - 1] : null;
}

export function __kustoRenderTransformationError( boxId: any, message: any) {
	try {
		const resultsDiv = document.getElementById(boxId + '_results') as any;
		const wrapper = document.getElementById(boxId + '_results_wrapper') as any;
		if (wrapper) wrapper.style.display = '';
		if (resultsDiv) {
			resultsDiv.innerHTML = '<div class="error-message" style="white-space:pre-wrap">' + ((typeof _win.escapeHtml === 'function') ? _win.escapeHtml(String(message || '')) : String(message || '')) + '</div>';
		}
	} catch (e) { console.error('[kusto]', e); }
}

export function __kustoRenderTransformation( boxId: any) {
	const id = String(boxId || '');
	if (!id) return;

	// If this is a Lit element, delegate to its refresh() method.
	try {
		const el = document.getElementById(id) as any;
		if (el && typeof el.refresh === 'function') {
			el.refresh();
			return;
		}
	} catch (e) { console.error('[kusto]', e); }

	const st = __kustoGetTransformationState(id);
	if (st && st.expanded === false) return;

	const datasets = _win.__kustoGetChartDatasetsInDomOrder();
	const ds = datasets.find((d: any) => String(d.id) === String(st.dataSourceId || ''));
	if (!ds) {
		__kustoRenderTransformationError(id, 'Select a data source (a query, CSV URL, or transformation section with results).');
		return;
	}

	const cols = Array.isArray(ds.columns) ? ds.columns : [];
	const colNames = cols.map(_win.__kustoNormalizeResultsColumnName).filter((c: any) => c);
	const colIndex: any = {};
	for (let i = 0; i < colNames.length; i++) {
		colIndex[String(colNames[i]).toLowerCase()] = i;
		colIndex[String(colNames[i])] = i;
	}
	const rows = Array.isArray(ds.rows) ? ds.rows : [];

	try {
		const type = String(st.transformationType || 'derive');
		if (type === 'derive') {
			let deriveColumns = Array.isArray(st.deriveColumns) ? st.deriveColumns : [];
			// Back-compat: if deriveColumns missing, derive from legacy fields.
			if (!deriveColumns.length) {
				const legacyName = String(st.deriveColumnName || '').trim();
				const legacyExpr = String(st.deriveExpression || '').trim();
				if (legacyName || legacyExpr) {
					deriveColumns = [{ name: legacyName || 'derived', expression: legacyExpr || '' }];
				}
			}

			// Build valid calculated columns only (don't break preview while editing).
			const parsed = [];
			for (const d of deriveColumns) {
				const n = String((d && d.name) || '').trim();
				const e = String((d && d.expression) || '').trim();
				if (!n && !e) continue;
				if (!e) continue;
				const name = n || 'derived';
				try {
					const rpn = __kustoParseExprToRpn(__kustoTokenizeExpr(e));
					parsed.push({ name, rpn });
				} catch {
					// Skip invalid expression while user is editing.
					continue;
				}
			}

			// If nothing is valid yet, still show the base dataset.
			if (!parsed.length) {
				const outRowsBase = [];
				for (const r of rows) {
					const row = Array.isArray(r) ? r : [];
					outRowsBase.push(row.map(__kustoGetRawCellValueForTransform));
				}
				_win.displayResultForBox({ columns: colNames.slice(), rows: outRowsBase, metadata: { transformationType: 'derive' } }, id, { label: 'Transformations', showExecutionTime: false });
				try {
					const wrapper = document.getElementById(id + '_results_wrapper') as any;
					if (wrapper) wrapper.style.display = '';
				} catch (e) { console.error('[kusto]', e); }
				try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch (e) { console.error('[kusto]', e); }
				try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); } }, 0); } catch (e) { console.error('[kusto]', e); }
				return;
			}

			const outCols = colNames.concat(parsed.map((p: any) => String(p.name || '').trim() || 'derived'));
			const outRows: any[] = [];

			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const baseRawRow = row.map(__kustoGetRawCellValueForTransform);
				const env: any = {};
				// Seed env with original columns
				for (let i = 0; i < colNames.length; i++) {
					const name = colNames[i];
					const raw = baseRawRow[i];
					env[name] = raw;
					env[String(name).toLowerCase()] = raw;
				}
				const derivedValues = [];
				for (const p of parsed) {
					let v = null;
					try {
						v = __kustoEvalRpn(p.rpn, env);
					} catch {
						v = null;
					}
					derivedValues.push(v);
					// Make derived columns available to subsequent expressions
					const dn = String(p.name || '').trim();
					if (dn) {
						env[dn] = v;
						env[dn.toLowerCase()] = v;
					}
				}
				outRows.push(baseRawRow.concat(derivedValues));
			}

			_win.displayResultForBox({ columns: outCols, rows: outRows, metadata: { transformationType: 'derive' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch (e) { console.error('[kusto]', e); }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); } }, 0); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		if (type === 'summarize') {
			const groupBy = Array.isArray(st.groupByColumns) ? st.groupByColumns.map((c: any) => String(c)).filter((c: any) => c) : [];
			const aggs = Array.isArray(st.aggregations) ? st.aggregations : [];
			if (!aggs.length) {
				__kustoRenderTransformationError(id, 'Add one or more aggregations.');
				return;
			}
			const groups = new Map();
			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const gvals = groupBy.map((c: any) => {
					const idx = colIndex[String(c)] ?? colIndex[String(c).toLowerCase()];
					return __kustoGetRawCellValueForTransform(row[idx]);
				});
				const key = JSON.stringify(gvals);
				let g = groups.get(key);
				if (!g) {
					g = { gvals, acc: [] };
					for (const a of aggs) {
						g.acc.push({ fn: String((a && a.function) || 'count'), col: String((a && a.column) || ''), count: 0, sum: 0, numCount: 0, min: null, max: null, distinct: new Set() });
					}
					groups.set(key, g);
				}
				for (let i = 0; i < g.acc.length; i++) {
					const a = g.acc[i];
					const fn = String(a.fn || 'count');
					if (fn === 'count') {
						a.count++;
						continue;
					}
					const idx = colIndex[String(a.col)] ?? colIndex[String(a.col).toLowerCase()];
					const raw = __kustoGetRawCellValueForTransform(row[idx]);
					if (fn === 'distinct') {
						a.distinct.add(String(raw));
						continue;
					}
					if (fn === 'sum' || fn === 'avg') {
						const n = __kustoTryParseFiniteNumber(raw);
						if (n !== null) {
							a.sum += n;
							a.numCount++;
						}
						continue;
					}
					if (fn === 'min' || fn === 'max') {
						const n = __kustoTryParseFiniteNumber(raw);
						const v = (n !== null) ? n : (raw === null || raw === undefined ? null : String(raw));
						if (v === null) continue;
						if (fn === 'min') {
							if (a.min === null || v < a.min) a.min = v;
						} else {
							if (a.max === null || v > a.max) a.max = v;
						}
						continue;
					}
				}
			}
			const outCols = [];
			for (const c of groupBy) outCols.push(String(c));
			for (const a of aggs) {
				const fn = String((a && a.function) || 'count');
				const col = String((a && a.column) || '');
				const custom = String((a && a.name) || '').trim();
				const fallback = (fn === 'count') ? 'count()' : (fn + '(' + col + ')');
				outCols.push(String(custom || fallback));
			}
			const outRows: any[] = [];
			for (const g of groups.values()) {
				const rowOut: any[] = [].concat(g.gvals);
				for (const a of g.acc) {
					const fn = String(a.fn || 'count');
					if (fn === 'count') rowOut.push(a.count);
					else if (fn === 'sum') rowOut.push(a.sum);
					else if (fn === 'avg') rowOut.push(a.numCount ? (a.sum / a.numCount) : null);
					else if (fn === 'min') rowOut.push(a.min);
					else if (fn === 'max') rowOut.push(a.max);
					else if (fn === 'distinct') rowOut.push(a.distinct.size);
					else rowOut.push(null);
				}
				outRows.push(rowOut);
			}
			_win.displayResultForBox({ columns: outCols, rows: outRows, metadata: { transformationType: 'summarize' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch (e) { console.error('[kusto]', e); }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); } }, 0); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		if (type === 'pivot') {
			const rowKey = String(st.pivotRowKeyColumn || '');
			const colKey = String(st.pivotColumnKeyColumn || '');
			const valKey = String(st.pivotValueColumn || '');
			const agg = String(st.pivotAggregation || 'sum');
			const maxCols = (typeof st.pivotMaxColumns === 'number' && Number.isFinite(st.pivotMaxColumns)) ? Math.max(1, Math.min(500, Math.floor(st.pivotMaxColumns))) : 100;
			if (!rowKey || !colKey) {
				__kustoRenderTransformationError(id, 'Pick Row key and Column key.');
				return;
			}
			if (agg !== 'count' && !valKey) {
				__kustoRenderTransformationError(id, 'Pick a Value column (or switch aggregation to count).');
				return;
			}
			const rowIdx = colIndex[rowKey] ?? colIndex[rowKey.toLowerCase()];
			const colIdx = colIndex[colKey] ?? colIndex[colKey.toLowerCase()];
			const valIdx = colIndex[valKey] ?? colIndex[valKey.toLowerCase()];
			const pivotCols = [];
			const pivotColSet = new Set();
			const table = new Map(); // rowKeyVal -> Map(colKeyVal -> acc)
			const rowOrder = [];
			const rowSeen = new Set();
			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const rk = __kustoGetRawCellValueForTransform(row[rowIdx]);
				const ck = __kustoGetRawCellValueForTransform(row[colIdx]);
				const ckStr = String(ck ?? '');
				if (!pivotColSet.has(ckStr)) {
					pivotColSet.add(ckStr);
					pivotCols.push(ckStr);
					if (pivotCols.length > maxCols) {
						__kustoRenderTransformationError(id, 'Pivot would create too many columns (' + pivotCols.length + '+). Increase Max columns or choose a different column key.');
						return;
					}
				}
				const rkStr = String(rk ?? '');
				if (!rowSeen.has(rkStr)) {
					rowSeen.add(rkStr);
					rowOrder.push(rkStr);
				}
				let rowMap = table.get(rkStr);
				if (!rowMap) {
					rowMap = new Map();
					table.set(rkStr, rowMap);
				}
				let acc = rowMap.get(ckStr);
				if (!acc) {
					acc = { count: 0, sum: 0, numCount: 0, first: null };
					rowMap.set(ckStr, acc);
				}
				acc.count++;
				if (agg === 'count') continue;
				const raw = __kustoGetRawCellValueForTransform(row[valIdx]);
				if (agg === 'first') {
					if (acc.first === null) acc.first = raw;
					continue;
				}
				const n = __kustoTryParseFiniteNumber(raw);
				if (n !== null) {
					acc.sum += n;
					acc.numCount++;
				}
			}
			const outCols = [String(rowKey)].concat(pivotCols.map((c: any) => String(c)));
			const outRows: any[] = [];
			for (const rk of rowOrder) {
				const rm = table.get(rk) || new Map();
				const out: any[] = [rk];
				for (const ck of pivotCols) {
					const acc = rm.get(ck);
					if (!acc) { out.push(null); continue; }
					if (agg === 'count') out.push(acc.count);
					else if (agg === 'first') out.push(acc.first);
					else if (agg === 'avg') out.push(acc.numCount ? (acc.sum / acc.numCount) : null);
					else out.push(acc.sum);
				}
				outRows.push(out);
			}
			_win.displayResultForBox({ columns: outCols, rows: outRows, metadata: { transformationType: 'pivot' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch (e) { console.error('[kusto]', e); }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); } }, 0); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		if (type === 'distinct') {
			const col = String(st.distinctColumn || '');
			if (!col) {
				__kustoRenderTransformationError(id, 'Pick a column.');
				return;
			}
			const idx = colIndex[String(col)] ?? colIndex[String(col).toLowerCase()];
			if (typeof idx !== 'number' || !Number.isFinite(idx)) {
				__kustoRenderTransformationError(id, 'Pick a valid column.');
				return;
			}
			const seen = new Set();
			const outRows: any[] = [];
			const makeKey = (v: any) => {
				try {
					if (v === null) return 'null';
					if (typeof v === 'undefined') return 'undefined';
					const t = typeof v;
					if (t === 'number' || t === 'boolean' || t === 'bigint') return t[0] + ':' + String(v);
					if (t === 'string') return 's:' + v;
					return 'o:' + JSON.stringify(v);
				} catch {
					return 'o:' + String(v);
				}
			};
			for (const r of rows) {
				const row = Array.isArray(r) ? r : [];
				const raw = __kustoGetRawCellValueForTransform(row[idx]);
				const key = makeKey(raw);
				if (seen.has(key)) continue;
				seen.add(key);
				outRows.push([raw]);
			}
			_win.displayResultForBox({ columns: [col], rows: outRows, metadata: { transformationType: 'distinct' } }, id, { label: 'Transformations', showExecutionTime: false });
			try {
				const wrapper = document.getElementById(id + '_results_wrapper') as any;
				if (wrapper) wrapper.style.display = '';
			} catch (e) { console.error('[kusto]', e); }
			try { __kustoEnsureTransformationAutoExpandWhenResultsAppear(id); } catch (e) { console.error('[kusto]', e); }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); } }, 0); } catch (e) { console.error('[kusto]', e); }
			return;
		}

		__kustoRenderTransformationError(id, 'Unknown transformation type.');
	} catch (e: any) {
		__kustoRenderTransformationError(id, (e && e.message) ? e.message : String(e || 'Failed to compute transformation.'));
	}
}

export function __kustoEnsureTransformationAutoExpandWhenResultsAppear( boxId: any) {
	try {
		const id = String(boxId || '');
		if (!id) return;
		const wrapper = document.getElementById(id + '_tf_wrapper') as any;
		if (!wrapper) return;
		// If the user hasn't manually resized this section, mirror query-box behavior:
		// when results appear, expand to fit so they're visible.
		const userResized = !!(wrapper.dataset && wrapper.dataset.kustoUserResized === 'true');
		if (userResized) return;
		try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

// Hook into the shared results visibility toggle so Transformations shrink/grow like query boxes.
try {
	const prev = (typeof window.__kustoOnResultsVisibilityToggled === 'function') ? window.__kustoOnResultsVisibilityToggled : null;
	window.__kustoOnResultsVisibilityToggled = (boxId: any) => {
		try { if (prev) prev(boxId); } catch (e) { console.error('[kusto]', e); }
		try {
			const id = String(boxId || '');
			if (!id) return;
			// Only handle Transformations boxes.
			if (!transformationStateByBoxId || !transformationStateByBoxId[id]) return;
			const wrapper = document.getElementById(id + '_tf_wrapper') as any;
			if (!wrapper) return;
			let visible = true;
			try {
				visible = !(window.__kustoResultsVisibleByBoxId && window.__kustoResultsVisibleByBoxId[id] === false);
			} catch (e) { console.error('[kusto]', e); }
			if (!visible) {
				// Mirror query-box collapse: hug content when results hidden.
				try { wrapper.dataset.kustoAutoFitActive = 'false'; } catch (e) { console.error('[kusto]', e); }
				try {
					if (wrapper.style && typeof wrapper.style.height === 'string' && wrapper.style.height && wrapper.style.height !== 'auto') {
						wrapper.dataset.kustoPrevHeight = wrapper.style.height;
					}
				} catch (e) { console.error('[kusto]', e); }
				try { wrapper.style.height = 'auto'; } catch (e) { console.error('[kusto]', e); }
				return;
			}
			// Showing results again: restore previous height if any; otherwise auto-expand.
			try {
				const prevH = (wrapper.dataset && wrapper.dataset.kustoPrevHeight) ? String(wrapper.dataset.kustoPrevHeight) : '';
				if (prevH && prevH !== 'auto') {
					wrapper.style.height = prevH;
				}
			} catch (e) { console.error('[kusto]', e); }
			try { wrapper.dataset.kustoAutoFitActive = 'true'; } catch (e) { console.error('[kusto]', e); }
			try { setTimeout(() => { try { __kustoMaybeAutoFitTransformationBox(id); } catch (e) { console.error('[kusto]', e); } }, 0); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	};
} catch (e) { console.error('[kusto]', e); }

export function addTransformationBox( options: any) {
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
	// Keep legacy fields in sync (used by older persistence/safety nets)
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

	const container = document.getElementById('queries-container') as any;
	if (!container) {
		return;
	}

	// ── Create Lit element as primary ──
	const litEl = document.createElement('kw-transformation-section');
	litEl.id = id;
	litEl.setAttribute('box-id', id);

	// Apply options to the Lit element
	if (typeof litEl.applyOptions === 'function') {
		litEl.applyOptions(options || {});
	}

	// Listen for section-remove event
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
// ── Window bridges ──────────────────────────────────────────────────────────
window.__kustoGetTransformationState = __kustoGetTransformationState;
window.__kustoGetTransformationMinResizeHeight = __kustoGetTransformationMinResizeHeight;
window.__kustoUpdateTransformationModeButtons = __kustoUpdateTransformationModeButtons;
window.__kustoApplyTransformationMode = __kustoApplyTransformationMode;
window.__kustoSetTransformationMode = __kustoSetTransformationMode;
window.__kustoUpdateTransformationVisibilityToggleButton = __kustoUpdateTransformationVisibilityToggleButton;
window.__kustoApplyTransformationBoxVisibility = __kustoApplyTransformationBoxVisibility;
window.toggleTransformationBoxVisibility = toggleTransformationBoxVisibility;
window.__kustoMaximizeTransformationBox = __kustoMaximizeTransformationBox;
window.__kustoComputeTransformationFitHeightPx = __kustoComputeTransformationFitHeightPx;
window.__kustoMaybeAutoFitTransformationBox = __kustoMaybeAutoFitTransformationBox;
window.removeTransformationBox = removeTransformationBox;
window.__kustoSetTransformationType = __kustoSetTransformationType;
window.__kustoOnTransformationDataSourceChanged = __kustoOnTransformationDataSourceChanged;
window.__kustoSetCheckboxDropdownText = __kustoSetCheckboxDropdownText;
window.__kustoBuildCheckboxMenuHtml = __kustoBuildCheckboxMenuHtml;
window.__kustoToggleGroupByColumn = __kustoToggleGroupByColumn;
window.__kustoUpdateTransformationBuilderUI = __kustoUpdateTransformationBuilderUI;
window.__kustoOnTransformationDistinctChanged = __kustoOnTransformationDistinctChanged;
window.__kustoOnTransformationAggChanged = __kustoOnTransformationAggChanged;
window.__kustoAddTransformationAgg = __kustoAddTransformationAgg;
window.__kustoRemoveTransformationAgg = __kustoRemoveTransformationAgg;
window.__kustoOnGroupByColumnChanged = __kustoOnGroupByColumnChanged;
window.__kustoAddGroupByColumn = __kustoAddGroupByColumn;
window.__kustoRemoveGroupByColumn = __kustoRemoveGroupByColumn;
window.__kustoOnGroupByDragStart = __kustoOnGroupByDragStart;
window.__kustoClearGroupByDropIndicators = __kustoClearGroupByDropIndicators;
window.__kustoOnGroupByDragOver = __kustoOnGroupByDragOver;
window.__kustoOnGroupByDragEnd = __kustoOnGroupByDragEnd;
window.__kustoOnGroupByDrop = __kustoOnGroupByDrop;
window.__kustoOnAggDragStart = __kustoOnAggDragStart;
window.__kustoClearAggDropIndicators = __kustoClearAggDropIndicators;
window.__kustoOnAggDragOver = __kustoOnAggDragOver;
window.__kustoOnAggDrop = __kustoOnAggDrop;
window.__kustoOnAggDragEnd = __kustoOnAggDragEnd;
window.__kustoOnCalculatedColumnChanged = __kustoOnCalculatedColumnChanged;
window.__kustoAddCalculatedColumn = __kustoAddCalculatedColumn;
window.__kustoRemoveCalculatedColumn = __kustoRemoveCalculatedColumn;
window.__kustoOnDeriveDragStart = __kustoOnDeriveDragStart;
window.__kustoClearDeriveDropIndicators = __kustoClearDeriveDropIndicators;
window.__kustoOnDeriveDragOver = __kustoOnDeriveDragOver;
window.__kustoOnDeriveDrop = __kustoOnDeriveDrop;
window.__kustoOnDeriveDragEnd = __kustoOnDeriveDragEnd;
window.__kustoOnTransformationPivotChanged = __kustoOnTransformationPivotChanged;
window.__kustoTryParseFiniteNumber = __kustoTryParseFiniteNumber;
window.__kustoTryParseDate = __kustoTryParseDate;
window.__kustoFormatDate = __kustoFormatDate;
window.__kustoGetRawCellValueForTransform = __kustoGetRawCellValueForTransform;
window.__kustoTokenizeExpr = __kustoTokenizeExpr;
window.__kustoParseExprToRpn = __kustoParseExprToRpn;
window.__kustoEvalRpn = __kustoEvalRpn;
window.__kustoRenderTransformationError = __kustoRenderTransformationError;
window.__kustoRenderTransformation = __kustoRenderTransformation;
window.__kustoEnsureTransformationAutoExpandWhenResultsAppear = __kustoEnsureTransformationAutoExpandWhenResultsAppear;
window.addTransformationBox = addTransformationBox;
window.__kustoConfigureTransformationFromTool = __kustoConfigureTransformationFromTool;
window.__kustoShowExpressionHelpTooltip = __kustoShowExpressionHelpTooltip;
window.__kustoHideExpressionHelpTooltip = __kustoHideExpressionHelpTooltip;
window.__kustoHideExpressionHelpTooltipImmediate = __kustoHideExpressionHelpTooltipImmediate;



