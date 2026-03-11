import { LitElement, html, css, nothing, type PropertyValues, type TemplateResult } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ChartType = 'line' | 'area' | 'bar' | 'scatter' | 'pie' | 'funnel' | '';
export type ChartMode = 'edit' | 'preview';
export type LegendPosition = 'top' | 'right' | 'bottom' | 'left';
export type SortDirection = 'asc' | 'desc' | '';
export type ScaleType = 'category' | 'continuous' | '';
export type LabelMode = 'auto' | 'all' | 'top5' | 'top10' | 'topPercent';

export interface XAxisSettings {
	sortDirection: SortDirection;
	scaleType: ScaleType;
	labelDensity: number;
	showAxisLabel: boolean;
	customLabel: string;
	titleGap: number;
}

export interface YAxisSettings {
	showAxisLabel: boolean;
	customLabel: string;
	min: string;
	max: string;
	seriesColors: Record<string, string>;
	titleGap: number;
}

/** Serialized shape for .kqlx persistence — must match KqlxSectionV1 chart variant. */
export interface ChartSectionData {
	id: string;
	type: 'chart';
	name: string;
	mode: ChartMode;
	expanded: boolean;
	dataSourceId?: string;
	chartType?: string;
	xColumn?: string;
	yColumn?: string;
	yColumns?: string[];
	tooltipColumns?: string[];
	legendColumn?: string;
	legendPosition?: string;
	labelColumn?: string;
	valueColumn?: string;
	showDataLabels?: boolean;
	labelMode?: string;
	labelDensity?: number;
	sortColumn?: string;
	sortDirection?: string;
	xAxisSettings?: Partial<XAxisSettings>;
	yAxisSettings?: Partial<YAxisSettings>;
	editorHeightPx?: number;
	validation?: unknown;
}

/** Data source entry from queries-container. */
interface DatasetEntry {
	id: string;
	label: string;
	columns: string[];
	rows: unknown[][];
}

// ─── Default axis settings ────────────────────────────────────────────────────

function defaultXAxisSettings(): XAxisSettings {
	return {
		sortDirection: '',
		scaleType: '',
		labelDensity: 100,
		showAxisLabel: true,
		customLabel: '',
		titleGap: 30,
	};
}

function defaultYAxisSettings(): YAxisSettings {
	return {
		showAxisLabel: true,
		customLabel: '',
		min: '',
		max: '',
		seriesColors: {},
		titleGap: 45,
	};
}

// ─── SVG icon constants ───────────────────────────────────────────────────────

const CHART_TYPE_ICONS: Record<string, string> = {
	line: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="4,24 10,16 16,20 22,8 28,12"/></svg>',
	area: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.3" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4,24 L10,16 L16,20 L22,8 L28,12 L28,28 L4,28 Z"/></svg>',
	bar: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><rect x="4" y="16" width="5" height="12" rx="1"/><rect x="11" y="10" width="5" height="18" rx="1"/><rect x="18" y="14" width="5" height="14" rx="1"/><rect x="25" y="6" width="5" height="22" rx="1"/></svg>',
	scatter: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor"><circle cx="8" cy="20" r="2.5"/><circle cx="14" cy="12" r="2.5"/><circle cx="20" cy="18" r="2.5"/><circle cx="26" cy="8" r="2.5"/><circle cx="11" cy="24" r="2.5"/><circle cx="23" cy="22" r="2.5"/></svg>',
	pie: '<svg viewBox="0 0 32 32" width="32" height="32" fill="none" stroke="currentColor" stroke-width="2"><circle cx="16" cy="16" r="12" fill="currentColor" fill-opacity="0.2"/><path d="M16,16 L16,4 A12,12 0 0,1 27.2,20.8 Z" fill="currentColor" fill-opacity="0.5"/><path d="M16,16 L27.2,20.8 A12,12 0 0,1 8,25.6 Z" fill="currentColor" fill-opacity="0.7"/></svg>',
	funnel: '<svg viewBox="0 0 32 32" width="32" height="32" fill="currentColor" fill-opacity="0.7"><path d="M4,4 L28,4 L28,7 L4,7 Z"/><path d="M6,9 L26,9 L26,12 L6,12 Z" fill-opacity="0.6"/><path d="M8,14 L24,14 L24,17 L8,17 Z" fill-opacity="0.5"/><path d="M10,19 L22,19 L22,22 L10,22 Z" fill-opacity="0.4"/><path d="M12,24 L20,24 L20,27 L12,27 Z" fill-opacity="0.3"/></svg>',
};

const CHART_TYPE_LABELS: Record<string, string> = {
	line: 'Line', area: 'Area', bar: 'Bar', scatter: 'Scatter', pie: 'Pie', funnel: 'Funnel',
};

const CHART_TYPES_ORDERED: ChartType[] = ['area', 'bar', 'funnel', 'line', 'pie', 'scatter'];

const LEGEND_POSITION_ICONS: Record<LegendPosition, string> = {
	top: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="5" width="10" height="8" rx="1"/><path d="M3 3h10"/></svg>',
	bottom: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="10" height="8" rx="1"/><path d="M3 13h10"/></svg>',
	left: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="5" y="3" width="8" height="10" rx="1"/><path d="M3 3v10"/></svg>',
	right: '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><rect x="3" y="3" width="8" height="10" rx="1"/><path d="M13 3v10"/></svg>',
};

const LEGEND_CYCLE: LegendPosition[] = ['top', 'right', 'bottom', 'left'];

const SVG_CLOSE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" xmlns="http://www.w3.org/2000/svg"><path d="M4 4l8 8"/><path d="M12 4L4 12"/></svg>';
const SVG_EYE = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M1.5 8c1.8-3.1 4-4.7 6.5-4.7S12.7 4.9 14.5 8c-1.8 3.1-4 4.7-6.5 4.7S3.3 11.1 1.5 8z"/><circle cx="8" cy="8" r="2.1"/></svg>';
const SVG_FIT = '<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" xmlns="http://www.w3.org/2000/svg"><path d="M3 6V3h3"/><path d="M13 10v3h-3"/><path d="M3 3l4 4"/><path d="M13 13l-4-4"/></svg>';
const SVG_CARET = '<svg width="12" height="12" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg"><path fill-rule="evenodd" clip-rule="evenodd" d="M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z" fill="currentColor"/></svg>';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function esc(s: unknown): string {
	return String(s ?? '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&#39;');
}

function normalizeLegendPosition(pos: unknown): LegendPosition {
	const p = String(pos || '').toLowerCase();
	return (p === 'top' || p === 'right' || p === 'bottom' || p === 'left') ? p : 'top';
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<kw-chart-section>` — Lit web component for a Chart section in the
 * Kusto Workbench notebook. Renders chart configuration UI in shadow DOM
 * and delegates ECharts rendering to light DOM via <slot>.
 */
@customElement('kw-chart-section')
export class KwChartSection extends LitElement {

	// ── Public properties ─────────────────────────────────────────────────────

	@property({ type: String, reflect: true, attribute: 'box-id' })
	boxId = '';

	@property({ type: Number, attribute: 'editor-height-px' })
	editorHeightPx: number | undefined = undefined;

	// ── Internal state ────────────────────────────────────────────────────────

	@state() private _name = '';
	@state() private _mode: ChartMode = 'edit';
	@state() private _expanded = true;
	@state() private _chartType: ChartType = '';
	@state() private _dataSourceId = '';
	@state() private _xColumn = '';
	@state() private _yColumns: string[] = [];
	@state() private _legendColumn = '';
	@state() private _legendPosition: LegendPosition = 'top';
	@state() private _labelColumn = '';
	@state() private _valueColumn = '';
	@state() private _showDataLabels = false;
	@state() private _labelMode: LabelMode = 'auto';
	@state() private _labelDensity = 50;
	@state() private _tooltipColumns: string[] = [];
	@state() private _sortColumn = '';
	@state() private _sortDirection: SortDirection = '';
	@state() private _xAxisSettings: XAxisSettings = defaultXAxisSettings();
	@state() private _yAxisSettings: YAxisSettings = defaultYAxisSettings();

	// Datasets available for selection
	@state() private _datasets: DatasetEntry[] = [];

	// UI sub-state
	@state() private _modeDropdownOpen = false;
	@state() private _openDropdownId = '';
	@state() private _openAxisPopup: '' | 'x' | 'y' | 'labels' = '';
	@state() private _axisPopupPos = { top: 0, left: 0 };

	private _userResized = false;
	private _closeDropdownBound = this._closeDropdownOnClickOutside.bind(this);
	private _closeAxisPopupBound = this._closeAxisPopupOnClickOutside.bind(this);
	private _closeAllPopupsOnScrollBound = this._closeAllPopupsOnScroll.bind(this);
	private _themeObserver: MutationObserver | null = null;
	private _lastThemeDark: boolean | null = null;

	// ── Lifecycle ─────────────────────────────────────────────────────────────

	override connectedCallback(): void {
		super.connectedCallback();
		this._syncGlobalChartState();
		this._setupThemeObserver();
		// Close fixed-position popups/dropdowns when the page scrolls so they
		// don't float detached from their anchor buttons.
		window.addEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true, passive: true });
		// Register public API for tool configuration
		(this as any).__kustoLitChart = true;
	}

	override disconnectedCallback(): void {
		super.disconnectedCallback();
		document.removeEventListener('mousedown', this._closeDropdownBound);
		document.removeEventListener('mousedown', this._closeAxisPopupBound);
		window.removeEventListener('scroll', this._closeAllPopupsOnScrollBound, { capture: true });
		this._themeObserver?.disconnect();
		this._themeObserver = null;
	}

	override firstUpdated(_changedProperties: PropertyValues): void {
		super.firstUpdated(_changedProperties);

		// Apply persisted height to the light-DOM wrapper
		if (this.editorHeightPx && this.editorHeightPx > 0) {
			const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
			if (wrapper) {
				const clamped = Math.round(this.editorHeightPx);
				wrapper.style.height = clamped + 'px';
				wrapper.dataset.kustoUserResized = 'true';
			}
		}

		this._refreshDatasets();
		this._updateHostClasses();
		this._applyModeToDom();
		this._writeToGlobalChartState();
		this._renderChart();
	}

	override updated(changed: PropertyValues): void {
		super.updated(changed);

		if (changed.has('_expanded')) {
			this._updateHostClasses();
		}

		// Re-render chart when key properties change
		const chartTriggers = [
			'_chartType', '_dataSourceId', '_xColumn', '_yColumns', '_legendColumn',
			'_legendPosition', '_labelColumn', '_valueColumn', '_showDataLabels',
			'_labelMode', '_labelDensity', '_tooltipColumns', '_sortColumn',
			'_sortDirection', '_xAxisSettings', '_yAxisSettings',
		];
		if (chartTriggers.some(k => changed.has(k))) {
			this._writeToGlobalChartState();
			this._renderChart();
		}
	}

	// ── Styles ────────────────────────────────────────────────────────────────

	static override styles = css`
		*, *::before, *::after { box-sizing: border-box; }

		:host {
			display: block;
			border: 1px solid var(--vscode-input-border, var(--vscode-widget-border, var(--vscode-panel-border, rgba(128,128,128,0.25))));
			border-radius: 0;
			margin-bottom: 16px;
			background: var(--vscode-editor-background);
			box-shadow: 0 2px 10px var(--vscode-widget-shadow);
			padding-bottom: 0;
			--kusto-chart-label-width: 54px;
		}
		:host(.is-collapsed) {
			margin-bottom: 26px;
		}
		:host(.is-collapsed) .chart-wrapper {
			display: none !important;
		}
		:host(.is-collapsed) .md-max-btn,
		:host(.is-collapsed) .mode-btn,
		:host(.is-collapsed) .mode-dropdown,
		:host(.is-collapsed) .md-tabs-divider {
			display: none !important;
		}

		.section-root {
			padding: 12px;
			padding-bottom: 0;
		}

		/* ── Header ──────────────────────────────────────────────────────── */

		.section-header {
			display: flex;
			gap: 8px;
			align-items: center;
			justify-content: space-between;
			margin-bottom: 8px;
		}

		.query-name-group {
			display: inline-flex;
			align-items: center;
			gap: 0;
			min-width: 0;
			flex: 0 1 auto;
		}

		.section-drag-handle {
			opacity: 1;
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-descriptionForeground);
			border-radius: 4px;
			margin: 0;
			width: 12px;
			height: 24px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			cursor: grab;
			flex: 0 0 auto;
		}
		.section-drag-handle:hover {
			background: var(--vscode-list-hoverBackground);
			border-color: var(--vscode-input-border);
			color: var(--vscode-foreground);
		}
		.section-drag-handle:active { cursor: grabbing; }
		.section-drag-handle-glyph {
			font-size: 14px;
			line-height: 1;
			letter-spacing: -1px;
		}

		.query-name {
			font-size: 12px;
			color: var(--vscode-foreground);
			background: transparent;
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 2px 6px;
			outline: none;
			min-width: 0;
			flex: 0 1 auto;
			font-family: inherit;
		}
		.query-name::placeholder { color: var(--vscode-input-placeholderForeground); }
		.query-name:hover { border-color: var(--vscode-input-border); }
		.query-name:focus { border-color: var(--vscode-focusBorder); }

		.section-actions {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			flex: 0 0 auto;
		}

		.md-tabs {
			display: inline-flex;
			gap: 2px;
			align-items: center;
			border: none;
			border-radius: 0;
			overflow: visible;
			margin: 0;
			background: transparent;
		}

		.unified-btn-secondary {
			background: transparent;
			color: var(--vscode-foreground);
			border: 1px solid transparent;
			border-radius: 4px;
			padding: 4px 8px;
			font-size: 12px;
			cursor: pointer;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			gap: 4px;
			white-space: nowrap;
			line-height: 1.4;
		}
		.unified-btn-secondary:hover:not(:disabled) {
			background: var(--vscode-list-hoverBackground);
		}

		.unified-btn-icon-only {
			width: 28px;
			height: 28px;
			min-width: 28px;
			padding: 0;
		}
		.unified-btn-icon-only svg { display: block; }

		.md-tab {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			padding: 0;
			width: 28px;
			height: 28px;
			border-radius: 4px;
			display: inline-flex;
			align-items: center;
			justify-content: center;
			line-height: 0;
			outline: none;
		}
		.md-tab svg { display: block; }
		.md-tab:hover { background: var(--vscode-list-hoverBackground); }
		.md-tab.md-max-btn { margin-right: 6px; }
		.md-tab.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
		}

		.md-mode-btn {
			font-size: 12px;
			width: auto;
			padding: 4px 8px;
			border: 1px solid transparent;
		}
		.md-mode-btn.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
		}

		.mode-dropdown {
			position: relative;
		}
		.mode-dropdown-btn {
			font-size: 12px;
			width: auto;
			padding: 4px 8px;
			gap: 2px;
		}
		.mode-dropdown-btn .caret {
			display: inline-flex;
		}
		.mode-dropdown-menu {
			position: absolute;
			top: 100%;
			right: 0;
			z-index: 100;
			min-width: 100px;
			background: var(--vscode-menu-background, var(--vscode-editor-background));
			color: var(--vscode-menu-foreground, var(--vscode-foreground));
			border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
			border-radius: 4px;
			padding: 4px 0;
			box-shadow: 0 4px 12px rgba(0,0,0,.35);
			font-size: 12px;
		}
		.mode-dropdown-item {
			padding: 4px 12px;
			cursor: pointer;
			white-space: nowrap;
		}
		.mode-dropdown-item:hover { background: var(--vscode-list-hoverBackground); }

		.md-tabs-divider {
			width: 1px;
			height: 16px;
			background: var(--vscode-input-border, rgba(128,128,128,0.3));
			margin: 0 2px;
		}

		.close-btn {
			background: transparent;
			border: 1px solid transparent;
			color: var(--vscode-foreground);
			border-radius: 4px;
			cursor: pointer;
		}
		.close-btn:hover { background: var(--vscode-list-hoverBackground); }

		/* ── Chart wrapper ───────────────────────────────────────────────── */

		.chart-wrapper {
			border: none;
			overflow: visible;
			height: auto;
			min-height: 0;
		}

		.chart-edit-mode {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 0;
			background: transparent;
			color: var(--vscode-foreground);
			overflow: visible;
		}

		.chart-preview-mode {
			display: flex;
			flex-direction: column;
			height: 100%;
			min-height: 0;
			background: transparent;
			color: var(--vscode-foreground);
			overflow: visible;
		}

		.chart-builder {
			display: flex;
			flex-direction: column;
			gap: 0;
			padding: 0;
			min-height: 0;
			height: auto;
			background: transparent;
			color: var(--vscode-foreground);
			overflow: visible;
		}

		/* ── Controls panel ──────────────────────────────────────────────── */

		.chart-controls {
			display: flex;
			flex-direction: column;
			gap: 0;
			overflow: visible;
			flex-shrink: 0;
			background: var(--vscode-editor-background);
			position: relative;
			left: -12px;
			width: calc(100% + 24px);
			padding: 16px 16px 0 16px;
			margin-bottom: 20px;
		}
		.chart-controls::before {
			content: '';
			position: absolute;
			inset: 0;
			pointer-events: none;
			background: rgba(0, 0, 0, 0.035);
		}
		:host-context(body.vscode-dark) .chart-controls::before,
		:host-context(body.vscode-high-contrast) .chart-controls::before {
			background: rgba(255, 255, 255, 0.04);
		}

		.chart-controls-scroll {
			overflow-x: auto;
			overflow-y: visible;
			padding-bottom: 16px;
			scrollbar-width: thin;
			scrollbar-color: var(--vscode-scrollbarSlider-background) transparent;
			/* Needs position:relative so it paints ABOVE the ::before overlay
			   (which is position:absolute). Without this, the overlay sits on top
			   of non-positioned children, tinting dropdown backgrounds. */
			position: relative;
		}
		.chart-controls-scroll::-webkit-scrollbar { height: 8px; background: transparent; }
		.chart-controls-scroll::-webkit-scrollbar-track { background: transparent; }
		.chart-controls-scroll::-webkit-scrollbar-thumb { background: var(--vscode-scrollbarSlider-background); }
		.chart-controls-scroll::-webkit-scrollbar-thumb:hover { background: var(--vscode-scrollbarSlider-hoverBackground); }

		.chart-controls-scroll-content {
			min-width: 480px;
			display: flex;
			flex-direction: column;
			gap: 14px;
		}

		/* ── Chart type picker ────────────────────────────────────────── */

		.chart-row {
			display: flex;
			align-items: center;
			gap: 10px;
			flex-wrap: nowrap;
		}

		.chart-row > label {
			flex: 0 0 var(--kusto-chart-label-width);
			min-width: var(--kusto-chart-label-width);
			font-size: 12px;
			white-space: nowrap;
		}

		.chart-type-picker {
			display: inline-flex;
			gap: 4px;
			flex-wrap: wrap;
		}

		.chart-type-btn {
			display: inline-flex;
			flex-direction: column;
			align-items: center;
			gap: 2px;
			padding: 4px 8px;
			border: 1px solid transparent;
			border-radius: 4px;
			background: transparent;
			color: var(--vscode-foreground);
			cursor: pointer;
			font-size: 10px;
			line-height: 1.2;
			min-width: 48px;
			white-space: nowrap;
		}
		.chart-type-btn svg {
			width: 24px;
			height: 24px;
		}
		.chart-type-btn:hover { background: var(--vscode-toolbar-hoverBackground); }
		.chart-type-btn.is-active {
			background: var(--vscode-toolbar-activeBackground, var(--vscode-actionBar-toggledBackground, rgba(128, 128, 128, 0.25)));
			color: var(--vscode-foreground);
			border-color: transparent;
		}

		/* ── Data source & column selects ─────────────────────────────── */

		.chart-select {
			flex: 1 1 auto;
			min-width: 140px;
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 0;
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			font-family: inherit;
			outline: none;
			height: 28px;
			appearance: none;
			-webkit-appearance: none;
			cursor: pointer;
			/* Separate properties — combined shorthand with CSS var breaks on <select> in Chromium */
			background-color: var(--vscode-dropdown-background);
			background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 4px center;
			background-size: 16px 16px;
		}
		.chart-select:focus { border-color: var(--vscode-focusBorder); }

		/* ── Dropdown button (for Y, Tooltip multi-selects) ────────────── */

		.dropdown-btn {
			width: 100%;
			min-width: 0;
			color: var(--vscode-dropdown-foreground);
			border: 1px solid var(--vscode-dropdown-border);
			border-radius: 0;
			padding: 4px 24px 4px 8px;
			font-size: 12px;
			font-family: inherit;
			outline: none;
			height: 28px;
			cursor: pointer;
			text-align: left;
			position: relative;
			white-space: nowrap;
			overflow: hidden;
			text-overflow: ellipsis;
			background-color: var(--vscode-dropdown-background);
			background-image: url("data:image/svg+xml,%3Csvg width='16' height='16' viewBox='0 0 16 16' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath fill-rule='evenodd' clip-rule='evenodd' d='M7.976 10.072l4.357-4.357.62.618L8.284 11h-.618L3 6.333l.619-.618 4.357 4.357z' fill='%23858585'/%3E%3C/svg%3E");
			background-repeat: no-repeat;
			background-position: right 4px center;
			background-size: 16px 16px;
		}
		.dropdown-btn:hover { border-color: var(--vscode-focusBorder); }

		.dropdown-wrapper {
			position: relative;
			flex: 1 1 auto;
			min-width: 0;
		}

		.dropdown-menu {
			position: fixed;
			z-index: 10000;
			min-width: 180px;
			background: var(--vscode-menu-background, var(--vscode-editor-background));
			color: var(--vscode-menu-foreground, var(--vscode-foreground));
			border: 1px solid var(--vscode-menu-border, var(--vscode-panel-border));
			border-radius: 0;
			padding: 4px 0;
			box-shadow: 0 4px 12px rgba(0,0,0,.35);
			max-height: 200px;
			overflow-y: auto;
			scrollbar-width: thin;
		}

		.dropdown-item {
			display: flex;
			align-items: center;
			gap: 6px;
			padding: 4px 8px;
			cursor: pointer;
			font-size: 12px;
			white-space: nowrap;
		}
		.dropdown-item:hover { background: var(--vscode-list-hoverBackground); }

		.dropdown-item input[type="checkbox"] {
			width: 14px;
			height: 14px;
			margin: 0;
			cursor: pointer;
		}

		/* ── Column mapping grids ─────────────────────────────────────── */

		.chart-mapping {
			margin-top: 0;
		}

		.chart-mapping-grid {
			display: grid;
			grid-template-columns: minmax(140px, 1fr) minmax(140px, 1fr) minmax(140px, 1fr);
			column-gap: 24px;
			row-gap: 14px;
			align-items: center;
		}

		.chart-field-group {
			display: flex;
			align-items: center;
			gap: 10px;
			width: 100%;
			min-width: 0;
		}

		.chart-field-group > label {
			flex: 0 0 var(--kusto-chart-label-width);
			min-width: var(--kusto-chart-label-width);
			font-size: 12px;
			white-space: nowrap;
		}

		.chart-field-group .chart-select {
			flex: 1 1 auto;
			min-width: 0;
		}

		/* ── Legend inline ────────────────────────────────────────────── */

		.chart-legend-inline {
			display: flex;
			align-items: center;
			gap: 6px;
			width: 100%;
			min-width: 0;
		}
		.chart-legend-inline .chart-select {
			flex: 1 1 auto;
			min-width: 0;
		}
		.chart-legend-pos-btn {
			flex-shrink: 0;
			width: 30px;
			height: 30px;
			padding: 0;
			display: inline-flex;
			align-items: center;
			justify-content: center;
		}

		/* ── Labels toggle ────────────────────────────────────────────── */

		.chart-labels-toggle {
			display: inline-flex;
			align-items: center;
			gap: 10px;
			cursor: pointer;
			user-select: none;
			width: 100%;
		}
		.chart-labels-toggle-text {
			flex: 0 0 var(--kusto-chart-label-width);
			min-width: var(--kusto-chart-label-width);
			font-size: 12px;
			white-space: nowrap;
			opacity: 0.85;
			color: var(--vscode-foreground);
		}
		.chart-labels-toggle-track {
			position: relative;
			width: 36px;
			height: 20px;
			background: var(--vscode-input-background);
			border: 1px solid var(--vscode-input-border, var(--vscode-contrastBorder, transparent));
			border-radius: 10px;
			transition: background 0.15s ease, border-color 0.15s ease;
		}
		.chart-labels-toggle-thumb {
			position: absolute;
			top: 2px;
			left: 2px;
			width: 14px;
			height: 14px;
			background: var(--vscode-foreground);
			border-radius: 50%;
			transition: transform 0.15s ease, background 0.15s ease;
			opacity: 0.6;
		}
		.chart-labels-toggle.is-active .chart-labels-toggle-track {
			background: var(--vscode-button-background);
			border-color: var(--vscode-button-background);
		}
		.chart-labels-toggle.is-active .chart-labels-toggle-thumb {
			transform: translateX(16px);
			background: var(--vscode-button-foreground);
			opacity: 1;
		}
		.chart-labels-toggle:hover .chart-labels-toggle-track {
			border-color: var(--vscode-focusBorder);
		}

		.chart-grid-spacer { display: block; }

		/* ── Clickable axis labels ─────────────────────────────────── */

		.axis-label-clickable {
			cursor: pointer;
			text-decoration: none;
			transition: text-decoration 0.1s ease;
		}
		.axis-label-clickable:hover {
			text-decoration: underline;
			color: var(--vscode-textLink-foreground, var(--vscode-foreground));
		}
		.axis-label-clickable.has-settings::after {
			content: '';
			display: inline-block;
			width: 5px;
			height: 5px;
			background: var(--vscode-focusBorder, #007fd4);
			border-radius: 50%;
			margin-left: 4px;
			vertical-align: middle;
		}

		/* ── Axis settings popup ───────────────────────────────────── */

		.axis-popup {
			position: fixed;
			z-index: 10000;
			min-width: 280px;
			max-width: 360px;
			background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
			border: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
			border-radius: 0;
			box-shadow: 0 4px 16px rgba(0,0,0,0.25);
			padding: 0;
			display: flex;
			flex-direction: column;
		}
		.axis-popup::before {
			content: '';
			position: absolute;
			top: -6px;
			left: 12px;
			width: 10px;
			height: 10px;
			background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
			border-left: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
			border-top: 1px solid var(--vscode-editorWidget-border, var(--vscode-contrastBorder, rgba(128,128,128,0.35)));
			transform: rotate(45deg);
		}
		.axis-popup-header {
			display: flex;
			align-items: center;
			justify-content: space-between;
			padding: 10px 12px;
			border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
			font-weight: 600;
			font-size: 12px;
		}
		.axis-popup-close {
			background: transparent;
			border: none;
			padding: 2px;
			cursor: pointer;
			color: var(--vscode-foreground);
			opacity: 0.7;
			display: flex;
			align-items: center;
			border-radius: 0;
		}
		.axis-popup-close:hover { opacity: 1; background: var(--vscode-toolbar-hoverBackground); }
		.axis-popup-content {
			padding: 12px;
			display: flex;
			flex-direction: column;
			gap: 14px;
		}
		.axis-popup-footer {
			padding: 8px 12px;
			border-top: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,0.15));
		}
		.axis-popup-row {
			display: flex;
			flex-direction: column;
			gap: 6px;
		}
		.axis-popup-row > label {
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
		}
		.axis-popup-row > input[type="text"] {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 0;
			padding: 3px 8px;
			font-size: 12px;
			font-family: var(--vscode-font-family);
			width: 100%;
			outline: none;
		}
		.axis-popup-row > input[type="text"]:focus { border-color: var(--vscode-focusBorder); }
		.axis-popup-row > input[type="text"]::placeholder { color: var(--vscode-input-placeholderForeground); }
		.axis-popup-row > select {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
			border-radius: 0;
			padding: 3px 8px;
			font-size: 12px;
			outline: none;
			width: 100%;
		}
		.axis-popup-row > select:focus { border-color: var(--vscode-focusBorder); }
		.axis-popup-checkbox {
			display: flex;
			align-items: center;
			gap: 8px;
		}
		.axis-popup-checkbox > input[type="checkbox"] {
			width: 16px;
			height: 16px;
			cursor: pointer;
		}
		.axis-popup-slider-row {
			display: flex;
			flex-direction: column;
			gap: 4px;
		}
		.axis-popup-slider-header {
			display: flex;
			justify-content: space-between;
			font-size: 11px;
			opacity: 0.85;
		}
		.axis-popup-slider {
			width: 100%;
			cursor: pointer;
		}
		.axis-popup-minmax {
			display: flex;
			gap: 8px;
		}
		.axis-popup-minmax-field {
			flex: 1;
			display: flex;
			flex-direction: column;
			gap: 4px;
		}
		.axis-popup-minmax-field > label {
			font-size: 11px;
			opacity: 0.85;
		}
		.axis-popup-minmax-field > input {
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border, transparent);
			border-radius: 0;
			padding: 3px 8px;
			font-size: 12px;
			width: 100%;
			outline: none;
		}
		.axis-popup-minmax-field > input:focus { border-color: var(--vscode-focusBorder); }
		.axis-popup-minmax-field > input::placeholder { color: var(--vscode-input-placeholderForeground); }
		.axis-popup-reset {
			background: transparent;
			border: 1px solid var(--vscode-input-border);
			color: var(--vscode-foreground);
			border-radius: 0;
			padding: 4px 12px;
			font-size: 11px;
			cursor: pointer;
			width: 100%;
		}
		.axis-popup-reset:hover { background: var(--vscode-list-hoverBackground); }

		.axis-popup-colors-header {
			font-size: 11px;
			font-weight: 500;
			opacity: 0.85;
			margin-bottom: 4px;
		}
		.axis-popup-color-row {
			display: flex;
			align-items: center;
			gap: 8px;
			margin-bottom: 4px;
		}
		.axis-popup-color-row input[type="color"] {
			width: 28px;
			height: 22px;
			padding: 0;
			border: none;
			border-radius: 3px;
			cursor: pointer;
			background: transparent;
		}
		.axis-popup-color-label {
			font-size: 12px;
			flex: 1;
			overflow: hidden;
			text-overflow: ellipsis;
			white-space: nowrap;
		}

		/* ── Canvas slot ──────────────────────────────────────────────── */

		::slotted(.query-editor-wrapper) {
			border: none;
			overflow: visible;
			height: auto;
			min-height: 0;
		}
	`;

	// ── Render ─────────────────────────────────────────────────────────────────

	override render(): TemplateResult {
		const isXY = this._chartType === 'line' || this._chartType === 'area' || this._chartType === 'bar' || this._chartType === 'scatter';
		const isPieOrFunnel = this._chartType === 'pie' || this._chartType === 'funnel';
		const supportsLegend = this._chartType === 'line' || this._chartType === 'area' || this._chartType === 'bar';
		const isFunnel = this._chartType === 'funnel';
		const colNames = this._getColumnNames();
		const multiYSelected = this._yColumns.length > 1;

		return html`
			<div class="section-root">
				<!-- Header -->
				<div class="section-header">
					<div class="query-name-group">
						<button type="button" class="section-drag-handle" draggable="true"
							title="Drag to reorder" aria-label="Reorder section"
							@dragstart=${this._onDragStart}>
							<span class="section-drag-handle-glyph" aria-hidden="true">⋮</span>
						</button>
						<input type="text" class="query-name"
							placeholder="Chart name (optional)"
							.value=${this._name}
							@input=${this._onNameInput} />
					</div>
					<div class="section-actions">
						<div class="md-tabs" role="tablist" aria-label="Chart tools">
							<button class="unified-btn-secondary md-tab md-mode-btn mode-btn ${this._mode === 'edit' ? 'is-active' : ''}"
								type="button" role="tab" aria-selected=${this._mode === 'edit' ? 'true' : 'false'}
								@click=${() => this._setMode('edit')} title="Edit">Edit</button>
							<button class="unified-btn-secondary md-tab md-mode-btn mode-btn ${this._mode === 'preview' ? 'is-active' : ''}"
								type="button" role="tab" aria-selected=${this._mode === 'preview' ? 'true' : 'false'}
								@click=${() => this._setMode('preview')} title="Preview">Preview</button>
							<span class="md-tabs-divider" aria-hidden="true"></span>
							<button class="unified-btn-secondary md-tab md-max-btn"
								type="button" @click=${this._onFitToContents}
								title="Fit to contents" aria-label="Fit to contents">
								<span .innerHTML=${SVG_FIT}></span>
							</button>
							<button class="unified-btn-secondary md-tab ${this._expanded ? 'is-active' : ''}"
								type="button" role="tab"
								aria-selected=${this._expanded ? 'true' : 'false'}
								@click=${this._toggleVisibility}
								title=${this._expanded ? 'Hide' : 'Show'} aria-label=${this._expanded ? 'Hide' : 'Show'}>
								<span .innerHTML=${SVG_EYE}></span>
							</button>
						</div>
						<button class="unified-btn-secondary unified-btn-icon-only close-btn"
							type="button" @click=${this._requestRemove}
							title="Remove" aria-label="Remove">
							<span .innerHTML=${SVG_CLOSE}></span>
						</button>
					</div>
				</div>

				<!-- Chart content: wrapper + canvases + resizer in light DOM -->
				<div class="chart-wrapper" id="chart-wrapper">
					<!-- Edit mode -->
					<div class="chart-edit-mode" id="chart-edit"
						style=${this._mode === 'edit' ? '' : 'display:none'}>
						<div class="chart-builder">
							<div class="chart-controls">
								<div class="chart-controls-scroll">
									<div class="chart-controls-scroll-content">
										<!-- Chart type row -->
										<div class="chart-row">
											<label>Type</label>
											<div class="chart-type-picker">
												${CHART_TYPES_ORDERED.map(t => html`
													<button type="button"
														class="chart-type-btn ${this._chartType === t ? 'is-active' : ''}"
														@click=${() => this._selectChartType(t)}
														title="${CHART_TYPE_LABELS[t]} Chart"
														aria-label="${CHART_TYPE_LABELS[t]} Chart"
														aria-pressed=${this._chartType === t ? 'true' : 'false'}>
														<span .innerHTML=${CHART_TYPE_ICONS[t]}></span>
														<span>${CHART_TYPE_LABELS[t]}</span>
													</button>
												`)}
											</div>
										</div>

										<!-- Data source row -->
										<div class="chart-row">
											<label>Data</label>
											<select class="chart-select" @change=${this._onDataSourceChanged}
												@focus=${this._refreshDatasets}>
												<option value="">(select)</option>
												${this._datasets.map(ds => html`
													<option value=${ds.id} ?selected=${this._dataSourceId === ds.id}>${ds.label}</option>
												`)}
											</select>
										</div>

										<!-- XY mapping (line/area/bar/scatter) -->
										${isXY ? this._renderXYMapping(colNames, supportsLegend, multiYSelected) : nothing}

										<!-- Pie/Funnel mapping -->
										${isPieOrFunnel ? this._renderPieMapping(colNames, isFunnel) : nothing}
									</div>
								</div>
							</div>
						</div>
					</div>

					<!-- Light-DOM wrapper/canvases/resizer via slot -->
					<slot name="chart-content"></slot>
				</div>
			</div>
		`;
	}

	// ── Sub-templates ──────────────────────────────────────────────────────────

	/** Render a checkbox-style dropdown button (Y columns, Tooltip columns). */
	private _renderCheckboxDropdown(
		dropdownId: string,
		options: string[],
		selected: string[],
		emptyLabel: string,
	): TemplateResult {
		const isOpen = this._openDropdownId === dropdownId;
		const btnText = selected.length ? selected.join(', ') : emptyLabel;

		return html`
			<div class="dropdown-wrapper">
				<button type="button" class="dropdown-btn"
					@click=${(e: Event) => { e.stopPropagation(); this._toggleDropdown(dropdownId, e.currentTarget as HTMLElement); }}
					aria-haspopup="listbox" aria-expanded=${isOpen ? 'true' : 'false'}>
					${btnText}
				</button>
				${isOpen ? html`
					<div class="dropdown-menu" role="listbox" @mousedown=${(e: Event) => e.stopPropagation()}>
						${options.map(c => html`
							<label class="dropdown-item" @click=${(e: Event) => e.stopPropagation()} @mousedown=${(e: Event) => e.stopPropagation()}>
								<input type="checkbox" .checked=${selected.includes(c)}
									@change=${(e: Event) => this._onCheckboxDropdownChange(dropdownId, c, (e.target as HTMLInputElement).checked)} />
								<span>${c}</span>
							</label>
						`)}
						${!options.length ? html`<div class="dropdown-item" style="opacity:0.5">No columns available</div>` : nothing}
					</div>
				` : nothing}
			</div>
		`;
	}

	private _renderXYMapping(colNames: string[], supportsLegend: boolean, multiYSelected: boolean): TemplateResult {
		const xOptions = ['', ...colNames];

		return html`
			<div class="chart-mapping">
				<div class="chart-mapping-grid">
					<!-- X column -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomXSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => this._toggleAxisPopup('x', e)}
							title="Click to configure X-axis settings">X</label>
						<select class="chart-select" @change=${this._onXColumnChanged}>
							${xOptions.map(c => html`
								<option value=${c} ?selected=${this._xColumn === c}>${c || '(none)'}</option>
							`)}
						</select>
					</span>

					<!-- Y columns -->
					<span class="chart-field-group">
						<label class="axis-label-clickable ${this._hasCustomYSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => this._toggleAxisPopup('y', e)}
							title="Click to configure Y-axis settings">Y</label>
						${this._renderCheckboxDropdown('y', colNames.filter(c => c !== this._xColumn), this._yColumns, 'Select...')}
					</span>

					<!-- Legend (line/area/bar only) -->
					${supportsLegend ? html`
						<span class="chart-field-group">
							<label>Legend</label>
							<div class="chart-legend-inline">
								<select class="chart-select" @change=${this._onLegendColumnChanged}
									?disabled=${multiYSelected}>
									<option value="" ?selected=${!this._legendColumn}>(none)</option>
									${colNames.filter(c => c !== this._xColumn).map(c => html`
										<option value=${c} ?selected=${this._legendColumn === c}>${c}</option>
									`)}
								</select>
								${this._legendColumn && !multiYSelected ? html`
									<button type="button" class="unified-btn-secondary unified-btn-icon-only chart-legend-pos-btn"
										@click=${this._cycleLegendPosition}
										title="Legend position: ${this._legendPosition.charAt(0).toUpperCase() + this._legendPosition.slice(1)}">
										<span .innerHTML=${LEGEND_POSITION_ICONS[this._legendPosition]}></span>
									</button>
								` : nothing}
							</div>
						</span>
					` : nothing}

					<!-- Tooltip -->
					<span class="chart-field-group">
						<label>Tooltip</label>
						${this._renderCheckboxDropdown('tooltip', colNames, this._tooltipColumns, '(none)')}
					</span>

					<!-- Labels toggle -->
					<div class="chart-labels-toggle ${this._showDataLabels ? 'is-active' : ''}"
						@click=${this._toggleDataLabels}
						role="switch" aria-checked=${this._showDataLabels ? 'true' : 'false'}
						tabindex="0" title="Toggle data labels">
						<span class="chart-labels-toggle-text">Labels</span>
						<span class="chart-labels-toggle-track">
							<span class="chart-labels-toggle-thumb"></span>
						</span>
					</div>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._openAxisPopup === 'x' ? this._renderXAxisPopup() : nothing}
			${this._openAxisPopup === 'y' ? this._renderYAxisPopup() : nothing}
		`;
	}

	private _renderPieMapping(colNames: string[], isFunnel: boolean): TemplateResult {
		return html`
			<div class="chart-mapping">
				<div class="chart-mapping-grid">
					<!-- Label column -->
					<span class="chart-field-group">
						<label>Label</label>
						<select class="chart-select" @change=${this._onLabelColumnChanged}>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._labelColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Value column -->
					<span class="chart-field-group">
						<label>Value</label>
						<select class="chart-select" @change=${this._onValueColumnChanged}>
							${colNames.map(c => html`
								<option value=${c} ?selected=${this._valueColumn === c}>${c}</option>
							`)}
						</select>
					</span>

					<!-- Tooltip -->
					<span class="chart-field-group">
						<label>Tooltip</label>
						${this._renderCheckboxDropdown('tooltip-pie', colNames, this._tooltipColumns, '(none)')}
					</span>

					<!-- Funnel sort -->
					${isFunnel ? html`
						<span class="chart-field-group">
							<label>Sort</label>
							<select class="chart-select" @change=${this._onSortColumnChanged}>
								<option value="" ?selected=${!this._sortColumn}>(none)</option>
								${colNames.map(c => html`
									<option value=${c} ?selected=${this._sortColumn === c}>${c}</option>
								`)}
							</select>
						</span>
					` : nothing}

					<!-- Labels toggle (pie/funnel) -->
					<div class="chart-labels-toggle ${this._showDataLabels ? 'is-active' : ''}"
						@click=${this._toggleDataLabels}
						role="switch" aria-checked=${this._showDataLabels ? 'true' : 'false'}
						tabindex="0" title="Toggle data labels">
						<span class="chart-labels-toggle-text axis-label-clickable ${this._hasCustomLabelSettings() ? 'has-settings' : ''}"
							@click=${(e: Event) => { e.stopPropagation(); this._toggleAxisPopup('labels', e); }}
							title="Click to configure label settings">Labels</span>
						<span class="chart-labels-toggle-track">
							<span class="chart-labels-toggle-thumb"></span>
						</span>
					</div>

					<span class="chart-grid-spacer" aria-hidden="true"></span>
				</div>
			</div>

			${this._openAxisPopup === 'labels' ? this._renderLabelSettingsPopup() : nothing}
		`;
	}

	// ── Axis settings popup templates ─────────────────────────────────────────

	private _renderXAxisPopup(): TemplateResult {
		const s = this._xAxisSettings;
		const densityLabel = s.labelDensity >= 100 ? 'All' : s.labelDensity + '%';
		return html`
			<div class="axis-popup" style="top:${this._axisPopupPos.top}px; left:${this._axisPopupPos.left}px;"
				@click=${(e: Event) => e.stopPropagation()} @mousedown=${(e: Event) => e.stopPropagation()}>
				<div class="axis-popup-header">
					<span>X-Axis Settings</span>
					<button class="axis-popup-close" @click=${() => this._closeAxisPopup()}
						title="Close"><span .innerHTML=${SVG_CLOSE}></span></button>
				</div>
				<div class="axis-popup-content">
					<div class="axis-popup-checkbox">
						<input type="checkbox" .checked=${s.showAxisLabel !== false}
							@change=${(e: Event) => this._onAxisSetting('x', 'showAxisLabel', (e.target as HTMLInputElement).checked)}>
						<label>Show axis title</label>
					</div>
					${s.showAxisLabel !== false ? html`
						<div class="axis-popup-row">
							<input type="text" .value=${s.customLabel || ''} placeholder="Column name"
								@input=${(e: Event) => this._onAxisSetting('x', 'customLabel', (e.target as HTMLInputElement).value)}>
						</div>
						<div class="axis-popup-slider-row">
							<div class="axis-popup-slider-header"><label>Title Gap</label><span>${s.titleGap}</span></div>
							<input type="range" class="axis-popup-slider" min="10" max="200" .value=${String(s.titleGap)}
								@input=${(e: Event) => this._onAxisSetting('x', 'titleGap', parseInt((e.target as HTMLInputElement).value, 10))}>
						</div>
					` : nothing}
					<div class="axis-popup-row">
						<label>Sort Direction</label>
						<select @change=${(e: Event) => this._onAxisSetting('x', 'sortDirection', (e.target as HTMLSelectElement).value)}>
							<option value="" ?selected=${!s.sortDirection}>Auto (default)</option>
							<option value="asc" ?selected=${s.sortDirection === 'asc'}>Ascending</option>
							<option value="desc" ?selected=${s.sortDirection === 'desc'}>Descending</option>
						</select>
					</div>
					<div class="axis-popup-row">
						<label>Scale Type</label>
						<select @change=${(e: Event) => this._onAxisSetting('x', 'scaleType', (e.target as HTMLSelectElement).value)}>
							<option value="" ?selected=${!s.scaleType}>Auto (default)</option>
							<option value="category" ?selected=${s.scaleType === 'category'}>Categorical</option>
							<option value="continuous" ?selected=${s.scaleType === 'continuous'}>Continuous</option>
						</select>
					</div>
					<div class="axis-popup-slider-row">
						<div class="axis-popup-slider-header"><label>Label Density</label><span>${densityLabel}</span></div>
						<input type="range" class="axis-popup-slider" min="1" max="100" .value=${String(Math.max(1, s.labelDensity))}
							@input=${(e: Event) => this._onAxisSetting('x', 'labelDensity', parseInt((e.target as HTMLInputElement).value, 10))}>
					</div>
				</div>
				<div class="axis-popup-footer">
					<button class="axis-popup-reset" @click=${() => this._resetAxisSettings('x')}>Reset to defaults</button>
				</div>
			</div>
		`;
	}

	private _renderYAxisPopup(): TemplateResult {
		const s = this._yAxisSettings;
		const defColors = ['#5470c6','#91cc75','#fac858','#ee6666','#73c0de','#3ba272','#fc8452','#9a60b4','#ea7ccc','#48b8d0'];
		return html`
			<div class="axis-popup" style="top:${this._axisPopupPos.top}px; left:${this._axisPopupPos.left}px;"
				@click=${(e: Event) => e.stopPropagation()} @mousedown=${(e: Event) => e.stopPropagation()}>
				<div class="axis-popup-header">
					<span>Y-Axis Settings</span>
					<button class="axis-popup-close" @click=${() => this._closeAxisPopup()}
						title="Close"><span .innerHTML=${SVG_CLOSE}></span></button>
				</div>
				<div class="axis-popup-content">
					<div class="axis-popup-checkbox">
						<input type="checkbox" .checked=${s.showAxisLabel !== false}
							@change=${(e: Event) => this._onAxisSetting('y', 'showAxisLabel', (e.target as HTMLInputElement).checked)}>
						<label>Show axis title</label>
					</div>
					${s.showAxisLabel !== false ? html`
						<div class="axis-popup-row">
							<input type="text" .value=${s.customLabel || ''} placeholder="Column name"
								@input=${(e: Event) => this._onAxisSetting('y', 'customLabel', (e.target as HTMLInputElement).value)}>
						</div>
						<div class="axis-popup-slider-row">
							<div class="axis-popup-slider-header"><label>Title Gap</label><span>${s.titleGap}</span></div>
							<input type="range" class="axis-popup-slider" min="10" max="200" .value=${String(s.titleGap)}
								@input=${(e: Event) => this._onAxisSetting('y', 'titleGap', parseInt((e.target as HTMLInputElement).value, 10))}>
						</div>
					` : nothing}
					<div class="axis-popup-minmax">
						<div class="axis-popup-minmax-field">
							<label>Min</label>
							<input type="text" inputmode="decimal" .value=${s.min || ''} placeholder="Auto"
								@change=${(e: Event) => this._onAxisSetting('y', 'min', (e.target as HTMLInputElement).value)}>
						</div>
						<div class="axis-popup-minmax-field">
							<label>Max</label>
							<input type="text" inputmode="decimal" .value=${s.max || ''} placeholder="Auto"
								@change=${(e: Event) => this._onAxisSetting('y', 'max', (e.target as HTMLInputElement).value)}>
						</div>
					</div>
					${this._yColumns.length > 0 ? html`
						<div>
							<div class="axis-popup-colors-header">Series Colors</div>
							${this._yColumns.map((col, i) => {
								const custom = s.seriesColors?.[col] || '';
								const def = defColors[i % defColors.length];
								return html`
									<div class="axis-popup-color-row">
										<input type="color" .value=${custom || def}
											@change=${(e: Event) => this._onSeriesColorChanged(col, (e.target as HTMLInputElement).value, def)}>
										<span class="axis-popup-color-label" title=${col}>${col}</span>
									</div>
								`;
							})}
						</div>
					` : nothing}
				</div>
				<div class="axis-popup-footer">
					<button class="axis-popup-reset" @click=${() => this._resetAxisSettings('y')}>Reset to defaults</button>
				</div>
			</div>
		`;
	}

	private _renderLabelSettingsPopup(): TemplateResult {
		return html`
			<div class="axis-popup" style="top:${this._axisPopupPos.top}px; left:${this._axisPopupPos.left}px;"
				@click=${(e: Event) => e.stopPropagation()} @mousedown=${(e: Event) => e.stopPropagation()}>
				<div class="axis-popup-header">
					<span>Label Settings</span>
					<button class="axis-popup-close" @click=${() => this._closeAxisPopup()}
						title="Close"><span .innerHTML=${SVG_CLOSE}></span></button>
				</div>
				<div class="axis-popup-content">
					<div class="axis-popup-row">
						<label>Display Mode</label>
						<select @change=${(e: Event) => { this._labelMode = (e.target as HTMLSelectElement).value as LabelMode; this._schedulePersist(); }}>
							<option value="auto" ?selected=${this._labelMode === 'auto'}>Auto (smart)</option>
							<option value="all" ?selected=${this._labelMode === 'all'}>All slices</option>
							<option value="top5" ?selected=${this._labelMode === 'top5'}>Top 5 only</option>
							<option value="top10" ?selected=${this._labelMode === 'top10'}>Top 10 only</option>
							<option value="topPercent" ?selected=${this._labelMode === 'topPercent'}>\u22655% only</option>
						</select>
					</div>
					${this._labelMode === 'auto' ? html`
						<div class="axis-popup-slider-row">
							<div class="axis-popup-slider-header"><label>Density</label><span>${this._labelDensity}%</span></div>
							<input type="range" class="axis-popup-slider" min="0" max="100" .value=${String(this._labelDensity)}
								@input=${(e: Event) => { this._labelDensity = parseInt((e.target as HTMLInputElement).value, 10); this._schedulePersist(); }}>
						</div>
					` : nothing}
				</div>
			</div>
		`;
	}

	// ── Event handlers ─────────────────────────────────────────────────────────

	private _onNameInput(e: Event): void {
		this._name = (e.target as HTMLInputElement).value;
		this._schedulePersist();
	}

	private _onDragStart(e: DragEvent): void {
		if (e.dataTransfer) {
			e.dataTransfer.setData('text/plain', this.boxId);
			e.dataTransfer.effectAllowed = 'move';
		}
		this.dispatchEvent(new CustomEvent('section-drag-start', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true,
		}));
	}

	private _toggleDropdown(id: string, btnEl?: HTMLElement): void {
		if (this._openDropdownId === id) {
			this._openDropdownId = '';
			document.removeEventListener('mousedown', this._closeDropdownBound);
		} else {
			this._openDropdownId = id;
			// After Lit re-renders the menu, position it using the button's bounding rect
			if (btnEl) {
				this.updateComplete.then(() => {
					const menu = this.shadowRoot?.querySelector('.dropdown-menu') as HTMLElement | null;
					if (menu) {
						const rect = btnEl.getBoundingClientRect();
						menu.style.top = rect.bottom + 'px';
						menu.style.left = rect.left + 'px';
						menu.style.width = rect.width + 'px';
					}
				});
			}
			// Defer so the current click doesn't immediately close it
			setTimeout(() => document.addEventListener('mousedown', this._closeDropdownBound), 0);
		}
	}

	private _closeDropdownOnClickOutside(): void {
		this._openDropdownId = '';
		document.removeEventListener('mousedown', this._closeDropdownBound);
	}

	/** Close all fixed-position dropdowns and axis popups (e.g. on scroll). */
	private _closeAllPopupsOnScroll(): void {
		if (this._openDropdownId) {
			this._openDropdownId = '';
			document.removeEventListener('mousedown', this._closeDropdownBound);
		}
		if (this._openAxisPopup) {
			this._closeAxisPopup();
		}
		if (this._modeDropdownOpen) {
			this._modeDropdownOpen = false;
		}
	}

	private _onCheckboxDropdownChange(dropdownId: string, value: string, checked: boolean): void {
		if (dropdownId === 'y') {
			const next = checked
				? [...this._yColumns, value]
				: this._yColumns.filter(c => c !== value);
			this._yColumns = next;
			if (next.length > 1) this._legendColumn = '';
			this._schedulePersist();
		} else if (dropdownId === 'tooltip' || dropdownId === 'tooltip-pie') {
			const next = checked
				? [...this._tooltipColumns, value]
				: this._tooltipColumns.filter(c => c !== value);
			this._tooltipColumns = next;
			this._schedulePersist();
		}
	}

	private _hasCanvasContent(): boolean {
		return !!this._dataSourceId && !!this._chartType;
	}

	private _getCanvasPlaceholderText(): string {
		if (!this._dataSourceId) return 'Select a data source (a query, CSV URL, or transformation section with results).';
		if (!this._chartType) return 'Select a chart type.';
		return '';
	}

	private _setMode(mode: ChartMode): void {
		this._mode = mode;
		this._modeDropdownOpen = false;
		// Toggle the light-DOM edit/preview containers
		this._applyModeToDom();
		this._writeToGlobalChartState();
		this._renderChart();
		this._schedulePersist();
	}

	private _toggleVisibility(): void {
		this._expanded = !this._expanded;
		this._updateHostClasses();
		// Show/hide the light-DOM wrapper
		const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
		if (wrapper) wrapper.style.display = this._expanded ? '' : 'none';
		if (this._expanded) {
			this._applyModeToDom();
			this._renderChart();
		}
		this._writeToGlobalChartState();
		this._schedulePersist();
	}

	/** Toggle light-DOM edit/preview containers based on current mode. */
	private _applyModeToDom(): void {
		const editHost = document.getElementById(this.boxId + '_chart_edit');
		const prevHost = document.getElementById(this.boxId + '_chart_preview');
		if (editHost) editHost.style.display = this._mode === 'edit' ? '' : 'none';
		if (prevHost) prevHost.style.display = this._mode === 'preview' ? 'flex' : 'none';
	}

	private _onFitToContents(): void {
		try {
			const fn = (window as any).__kustoMaximizeChartBox;
			if (typeof fn === 'function') fn(this.boxId);
		} catch { /* ignore */ }
	}

	private _requestRemove(): void {
		this.dispatchEvent(new CustomEvent('section-remove', {
			detail: { boxId: this.boxId },
			bubbles: true,
			composed: true,
		}));
	}

	private _selectChartType(t: ChartType): void {
		this._chartType = t;
		this._schedulePersist();
	}

	private _onDataSourceChanged(e: Event): void {
		this._dataSourceId = (e.target as HTMLSelectElement).value;
		this._refreshDatasets();
		this._schedulePersist();
	}

	private _onXColumnChanged(e: Event): void {
		this._xColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onLegendColumnChanged(e: Event): void {
		this._legendColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _cycleLegendPosition(): void {
		const idx = LEGEND_CYCLE.indexOf(this._legendPosition);
		this._legendPosition = LEGEND_CYCLE[(idx + 1) % LEGEND_CYCLE.length];
		this._schedulePersist();
	}

	private _toggleDataLabels(): void {
		this._showDataLabels = !this._showDataLabels;
		this._schedulePersist();
	}

	private _onLabelColumnChanged(e: Event): void {
		this._labelColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onValueColumnChanged(e: Event): void {
		this._valueColumn = (e.target as HTMLSelectElement).value;
		this._schedulePersist();
	}

	private _onSortColumnChanged(e: Event): void {
		this._sortColumn = (e.target as HTMLSelectElement).value;
		if (!this._sortColumn) {
			this._sortDirection = '';
		} else if (!this._sortDirection) {
			this._sortDirection = 'desc';
		}
		this._schedulePersist();
	}

	// ── Axis settings handlers ────────────────────────────────────────────────

	private _toggleAxisPopup(axis: 'x' | 'y' | 'labels', e: Event): void {
		// Always clean up the previous listener first
		document.removeEventListener('mousedown', this._closeAxisPopupBound);

		if (this._openAxisPopup === axis) {
			this._openAxisPopup = '';
			return;
		}

		const el = e.target as HTMLElement;
		const rect = el.getBoundingClientRect();

		// Measure actual text width to center the arrow on the text, not the padded element
		const labelText = el.textContent || '';
		const computedStyle = window.getComputedStyle(el);
		const canvas = document.createElement('canvas');
		const ctx = canvas.getContext('2d');
		let textWidth = rect.width;
		if (ctx) {
			ctx.font = computedStyle.fontSize + ' ' + computedStyle.fontFamily;
			textWidth = ctx.measureText(labelText).width;
		}

		// Position: arrow tip at center of text, popup left offset so arrow (at CSS left:12px + 5px) points there
		const arrowTipOffset = 17; // 12px CSS left + 5px for arrow center
		const textCenter = rect.left + (textWidth / 2);
		this._axisPopupPos = { top: rect.bottom + 8, left: textCenter - arrowTipOffset };
		this._openAxisPopup = axis;

		// Defer so the current click doesn't immediately close it
		setTimeout(() => document.addEventListener('mousedown', this._closeAxisPopupBound), 0);
	}

	/** Stable bound handler for closing axis popups on outside click. */
	private _closeAxisPopupOnClickOutside(ev: Event): void {
		const popup = this.shadowRoot?.querySelector('.axis-popup');
		if (popup?.contains(ev.target as Node)) return;
		this._closeAxisPopup();
	}

	/** Close the axis popup and clean up the document listener. */
	private _closeAxisPopup(): void {
		this._openAxisPopup = '';
		document.removeEventListener('mousedown', this._closeAxisPopupBound);
	}

	private _onAxisSetting(axis: 'x' | 'y', key: string, value: unknown): void {
		if (axis === 'x') {
			this._xAxisSettings = { ...this._xAxisSettings, [key]: value };
		} else {
			this._yAxisSettings = { ...this._yAxisSettings, [key]: value };
		}
		this._schedulePersist();
	}

	private _onSeriesColorChanged(col: string, newColor: string, defaultColor: string): void {
		const colors = { ...(this._yAxisSettings.seriesColors || {}) };
		if (newColor.toLowerCase() === defaultColor.toLowerCase()) {
			delete colors[col];
		} else {
			colors[col] = newColor;
		}
		this._yAxisSettings = { ...this._yAxisSettings, seriesColors: colors };
		this._schedulePersist();
	}

	private _resetAxisSettings(axis: 'x' | 'y'): void {
		if (axis === 'x') {
			this._xAxisSettings = defaultXAxisSettings();
		} else {
			this._yAxisSettings = defaultYAxisSettings();
		}
		this._schedulePersist();
	}

	private _hasCustomXSettings(): boolean {
		const s = this._xAxisSettings;
		const d = defaultXAxisSettings();
		return !!(s.sortDirection !== d.sortDirection || s.scaleType !== d.scaleType ||
			s.labelDensity !== d.labelDensity || s.showAxisLabel === false ||
			s.customLabel || s.titleGap !== d.titleGap);
	}

	private _hasCustomYSettings(): boolean {
		const s = this._yAxisSettings;
		const d = defaultYAxisSettings();
		return !!(s.showAxisLabel === false || s.customLabel || s.min || s.max ||
			s.titleGap !== d.titleGap || (s.seriesColors && Object.keys(s.seriesColors).length > 0));
	}

	private _hasCustomLabelSettings(): boolean {
		return this._labelMode !== 'auto' || this._labelDensity !== 50;
	}

	// ── Theme observer ────────────────────────────────────────────────────────

	private _setupThemeObserver(): void {
		this._lastThemeDark = this._isDarkTheme();
		this._themeObserver = new MutationObserver(() => {
			const isDark = this._isDarkTheme();
			if (this._lastThemeDark !== isDark) {
				this._lastThemeDark = isDark;
				try { (window as any).__kustoDisposeChartEcharts?.(this.boxId); } catch { /* ignore */ }
				this._renderChart();
			}
		});
		if (document.body) {
			this._themeObserver.observe(document.body, { attributes: true, attributeFilter: ['class', 'style'] });
		}
		if (document.documentElement) {
			this._themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'style'] });
		}
	}

	private _isDarkTheme(): boolean {
		const cls = document.body?.classList;
		if (cls?.contains('vscode-dark') || cls?.contains('vscode-high-contrast')) return true;
		if (cls?.contains('vscode-light') || cls?.contains('vscode-high-contrast-light')) return false;
		return true;
	}

	// ── Tool configuration (public API) ───────────────────────────────────────

	/** Configure chart programmatically (used by LLM tools). */
	public configure(config: Record<string, unknown>): boolean {
		try {
			if (typeof config.dataSourceId === 'string') this._dataSourceId = config.dataSourceId;
			if (typeof config.chartType === 'string') this._chartType = config.chartType as ChartType;
			if (typeof config.xColumn === 'string') this._xColumn = config.xColumn;
			if (Array.isArray(config.yColumns)) this._yColumns = (config.yColumns as string[]).filter(c => c);
			else if (typeof config.yColumn === 'string') this._yColumns = [config.yColumn as string];
			if (typeof config.labelColumn === 'string') this._labelColumn = config.labelColumn;
			if (typeof config.valueColumn === 'string') this._valueColumn = config.valueColumn;
			if (typeof config.legendColumn === 'string') this._legendColumn = config.legendColumn;
			if (Array.isArray(config.tooltipColumns)) this._tooltipColumns = (config.tooltipColumns as string[]).filter(c => c);
			if (typeof config.showDataLabels === 'boolean') this._showDataLabels = config.showDataLabels;
			if (typeof config.legendPosition === 'string') this._legendPosition = normalizeLegendPosition(config.legendPosition);
			if (typeof config.sortColumn === 'string') this._sortColumn = config.sortColumn;
			if (typeof config.sortDirection === 'string') this._sortDirection = config.sortDirection as SortDirection;
			this._refreshDatasets();
			this._schedulePersist();
			return true;
		} catch { return false; }
	}

	// ── Global state bridge ────────────────────────────────────────────────────

	/**
	 * Read initial state from the global chartStateByBoxId, if present.
	 * This is how persisted state flows into the Lit component from addChartBox.
	 */
	private _syncGlobalChartState(): void {
		const win = window as any;
		if (!this.boxId) return;
		const global = win.chartStateByBoxId;
		if (!global || typeof global !== 'object') return;
		const st = global[this.boxId];
		if (!st || typeof st !== 'object') return;

		if (typeof st.mode === 'string') this._mode = st.mode as ChartMode;
		if (typeof st.expanded === 'boolean') this._expanded = st.expanded;
		if (typeof st.chartType === 'string') this._chartType = st.chartType as ChartType;
		if (typeof st.dataSourceId === 'string') this._dataSourceId = st.dataSourceId;
		if (typeof st.xColumn === 'string') this._xColumn = st.xColumn;
		if (Array.isArray(st.yColumns)) this._yColumns = st.yColumns.filter((c: unknown) => c);
		else if (typeof st.yColumn === 'string' && st.yColumn) this._yColumns = [st.yColumn];
		if (typeof st.legendColumn === 'string') this._legendColumn = st.legendColumn;
		if (typeof st.legendPosition === 'string') this._legendPosition = normalizeLegendPosition(st.legendPosition);
		if (typeof st.labelColumn === 'string') this._labelColumn = st.labelColumn;
		if (typeof st.valueColumn === 'string') this._valueColumn = st.valueColumn;
		if (typeof st.showDataLabels === 'boolean') this._showDataLabels = st.showDataLabels;
		if (typeof st.labelMode === 'string') this._labelMode = st.labelMode as LabelMode;
		if (typeof st.labelDensity === 'number') this._labelDensity = st.labelDensity;
		if (Array.isArray(st.tooltipColumns)) this._tooltipColumns = st.tooltipColumns.filter((c: unknown) => c);
		if (typeof st.sortColumn === 'string') this._sortColumn = st.sortColumn;
		if (typeof st.sortDirection === 'string') this._sortDirection = st.sortDirection as SortDirection;
		if (st.xAxisSettings && typeof st.xAxisSettings === 'object') {
			this._xAxisSettings = { ...defaultXAxisSettings(), ...st.xAxisSettings };
		}
		if (st.yAxisSettings && typeof st.yAxisSettings === 'object') {
			this._yAxisSettings = { ...defaultYAxisSettings(), ...st.yAxisSettings };
		}
	}

	/**
	 * Write current Lit state back to the global chartStateByBoxId so that
	 * the existing __kustoRenderChart and persistence.js can read from it.
	 */
	private _writeToGlobalChartState(): void {
		const win = window as any;
		if (!this.boxId) return;
		if (!win.chartStateByBoxId) win.chartStateByBoxId = {};
		const st = win.chartStateByBoxId[this.boxId] || {};

		st.mode = this._mode;
		st.expanded = this._expanded;
		st.chartType = this._chartType;
		st.dataSourceId = this._dataSourceId;
		st.xColumn = this._xColumn;
		st.yColumn = this._yColumns.length ? this._yColumns[0] : '';
		st.yColumns = [...this._yColumns];
		st.legendColumn = this._legendColumn;
		st.legendPosition = this._legendPosition;
		st.labelColumn = this._labelColumn;
		st.valueColumn = this._valueColumn;
		st.showDataLabels = this._showDataLabels;
		st.labelMode = this._labelMode;
		st.labelDensity = this._labelDensity;
		st.tooltipColumns = [...this._tooltipColumns];
		st.sortColumn = this._sortColumn;
		st.sortDirection = this._sortDirection;
		st.xAxisSettings = { ...this._xAxisSettings };
		st.yAxisSettings = { ...this._yAxisSettings };

		win.chartStateByBoxId[this.boxId] = st;
	}

	// ── Data helpers ───────────────────────────────────────────────────────────

	/**
	 * Refresh the list of available data sources from the DOM.
	 * Delegates to the existing global function if available.
	 */
	private _refreshDatasets(): void {
		try {
			const fn = (window as any).__kustoGetChartDatasetsInDomOrder;
			if (typeof fn === 'function') {
				this._datasets = fn() || [];
			}
		} catch { /* ignore */ }
	}

	/** Get column names from the currently selected dataset. */
	private _getColumnNames(): string[] {
		const ds = this._datasets.find(d => d.id === this._dataSourceId);
		if (!ds || !Array.isArray(ds.columns)) return [];
		return ds.columns.map(c => {
			if (typeof c === 'string') return c;
			if (c && typeof c === 'object') {
				return (c as any).name || (c as any).columnName || '';
			}
			return '';
		}).filter(Boolean);
	}

	// ── Chart rendering (delegates to existing global) ────────────────────────

	/**
	 * Delegate chart rendering to the existing __kustoRenderChart function.
	 * The chart canvas lives in light DOM via <slot>, so the legacy code can
	 * directly access and render into it.
	 */
	private _renderChart(): void {
		if (!this._expanded) return;
		this._refreshDatasets();
		try {
			const fn = (window as any).__kustoRenderChart;
			if (typeof fn === 'function') {
				fn(this.boxId);
			}
		} catch { /* ignore */ }
	}

	// ── Host class management ─────────────────────────────────────────────────

	private _updateHostClasses(): void {
		this.classList.toggle('is-collapsed', !this._expanded);
	}

	// ── Persistence ───────────────────────────────────────────────────────────

	private _schedulePersist(): void {
		try {
			const sp = (window as any).schedulePersist;
			if (typeof sp === 'function') sp();
		} catch { /* ignore */ }
	}

	/**
	 * Serialize to the .kqlx JSON format.
	 * Output is identical to the original persistence.js chart section shape.
	 */
	public serialize(): ChartSectionData {
		const data: ChartSectionData = {
			id: this.boxId,
			type: 'chart',
			name: this._name,
			mode: this._mode,
			expanded: this._expanded,
		};

		if (this._dataSourceId) data.dataSourceId = this._dataSourceId;
		if (this._chartType) data.chartType = this._chartType;
		if (this._xColumn) data.xColumn = this._xColumn;
		// Include yColumn for backward compatibility
		if (this._yColumns.length) {
			data.yColumn = this._yColumns[0];
			data.yColumns = [...this._yColumns];
		}
		if (this._tooltipColumns.length) data.tooltipColumns = [...this._tooltipColumns];
		if (this._legendColumn) data.legendColumn = this._legendColumn;
		if (this._legendPosition !== 'top') data.legendPosition = this._legendPosition;
		if (this._labelColumn) data.labelColumn = this._labelColumn;
		if (this._valueColumn) data.valueColumn = this._valueColumn;
		if (this._showDataLabels) data.showDataLabels = true;
		if (this._labelMode !== 'auto') data.labelMode = this._labelMode;
		if (this._labelDensity !== 50) data.labelDensity = this._labelDensity;
		if (this._sortColumn) data.sortColumn = this._sortColumn;
		if (this._sortDirection) data.sortDirection = this._sortDirection;

		// Axis settings — only include if they differ from defaults
		const xDef = defaultXAxisSettings();
		const xSet = this._xAxisSettings;
		if (xSet.sortDirection !== xDef.sortDirection || xSet.scaleType !== xDef.scaleType ||
			xSet.labelDensity !== xDef.labelDensity || xSet.showAxisLabel !== xDef.showAxisLabel ||
			xSet.customLabel !== xDef.customLabel || xSet.titleGap !== xDef.titleGap) {
			data.xAxisSettings = { ...xSet };
		}

		const yDef = defaultYAxisSettings();
		const ySet = this._yAxisSettings;
		if (ySet.showAxisLabel !== yDef.showAxisLabel || ySet.customLabel !== yDef.customLabel ||
			ySet.min !== yDef.min || ySet.max !== yDef.max || ySet.titleGap !== yDef.titleGap ||
			(ySet.seriesColors && Object.keys(ySet.seriesColors).length > 0)) {
			data.yAxisSettings = { ...ySet };
		}

		// Wrapper height
		const heightPx = this._getWrapperHeightPx();
		if (heightPx !== undefined) {
			data.editorHeightPx = heightPx;
		}

		// Validation status
		try {
			const fn = (window as any).__kustoGetChartValidationStatus;
			if (typeof fn === 'function') {
				const vs = fn(this.boxId);
				if (vs) data.validation = vs;
			}
		} catch { /* ignore */ }

		return data;
	}

	/** Set initial state from options passed by addChartBox. */
	public applyOptions(options: Record<string, unknown>): void {
		if (typeof options.name === 'string') this._name = options.name;
		if (typeof options.mode === 'string') this._mode = options.mode as ChartMode;
		if (typeof options.expanded === 'boolean') this._expanded = options.expanded;
		if (typeof options.chartType === 'string') this._chartType = options.chartType as ChartType;
		if (typeof options.dataSourceId === 'string') this._dataSourceId = options.dataSourceId;
		if (typeof options.xColumn === 'string') this._xColumn = options.xColumn;
		if (Array.isArray(options.yColumns)) this._yColumns = (options.yColumns as string[]).filter(c => c);
		else if (typeof options.yColumn === 'string' && options.yColumn) this._yColumns = [options.yColumn as string];
		if (typeof options.legendColumn === 'string') this._legendColumn = options.legendColumn;
		if (typeof options.legendPosition === 'string') this._legendPosition = normalizeLegendPosition(options.legendPosition);
		if (typeof options.labelColumn === 'string') this._labelColumn = options.labelColumn;
		if (typeof options.valueColumn === 'string') this._valueColumn = options.valueColumn;
		if (typeof options.showDataLabels === 'boolean') this._showDataLabels = options.showDataLabels;
		if (typeof options.labelMode === 'string') this._labelMode = options.labelMode as LabelMode;
		if (typeof options.labelDensity === 'number') this._labelDensity = options.labelDensity;
		if (Array.isArray(options.tooltipColumns)) this._tooltipColumns = (options.tooltipColumns as string[]).filter(c => c);
		if (typeof options.sortColumn === 'string') this._sortColumn = options.sortColumn;
		if (typeof options.sortDirection === 'string') this._sortDirection = options.sortDirection as SortDirection;
		if (options.xAxisSettings && typeof options.xAxisSettings === 'object') {
			this._xAxisSettings = { ...defaultXAxisSettings(), ...this._xAxisSettings, ...(options.xAxisSettings as Partial<XAxisSettings>) };
		}
		if (options.yAxisSettings && typeof options.yAxisSettings === 'object') {
			this._yAxisSettings = { ...defaultYAxisSettings(), ...this._yAxisSettings, ...(options.yAxisSettings as Partial<YAxisSettings>) };
		}
	}

	// ── Private helpers ───────────────────────────────────────────────────────

	private _getWrapperHeightPx(): number | undefined {
		// Wrapper is in light DOM, accessible via document.getElementById
		const wrapper = document.getElementById(this.boxId + '_chart_wrapper');
		if (!wrapper) return undefined;
		if (!wrapper.dataset.kustoUserResized) return undefined;
		const h = wrapper.style.height?.trim();
		if (!h || h === 'auto') return undefined;
		const m = h.match(/^(\d+)px$/i);
		return m ? parseInt(m[1], 10) : undefined;
	}
}

// Declare the custom element type for TypeScript
declare global {
	interface HTMLElementTagNameMap {
		'kw-chart-section': KwChartSection;
	}
}
