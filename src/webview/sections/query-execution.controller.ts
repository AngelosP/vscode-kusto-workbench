// Query execution, result handling, comparison, optimization — ReactiveController pattern.
// Extracted from modules/queryBoxes-execution.ts into a Lit ReactiveController
// that attaches to kw-query-section elements.
import type { ReactiveController, ReactiveControllerHost } from 'lit';
import { postMessageToHost } from '../shared/webview-messages';
import {
	normalizeCellForComparison as __kustoNormalizeCellForComparison,
	rowKeyForComparison as __kustoRowKeyForComparison,
	normalizeColumnNameForComparison as __kustoNormalizeColumnNameForComparison,
	getNormalizedColumnNameList as __kustoGetNormalizedColumnNameList,
	doColumnHeaderNamesMatch as __kustoDoColumnHeaderNamesMatch,
	getColumnDifferences as __kustoGetColumnDifferences,
	doColumnOrderMatch as __kustoDoColumnOrderMatch,
	doRowOrderMatch as __kustoDoRowOrderMatch,
	buildColumnIndexMapForNames as __kustoBuildColumnIndexMapForNames,
	buildNameBasedColumnMapping as __kustoBuildNameBasedColumnMapping,
	rowKeyForComparisonWithColumnMapping as __kustoRowKeyForComparisonWithColumnMapping,
	rowKeyForComparisonIgnoringColumnOrder as __kustoRowKeyForComparisonIgnoringColumnOrder,
	areResultsEquivalentWithDetails as __kustoAreResultsEquivalentWithDetails,
	areResultsEquivalent as __kustoAreResultsEquivalent,
	doResultHeadersMatch as __kustoDoResultHeadersMatch,
	formatElapsed,
	isValidConnectionIdForRun as __kustoIsValidConnectionIdForRun_pure,
	getRunModeLabelText,
} from '../shared/comparisonUtils';
import { escapeHtml } from '../core/utils';
import { pState } from '../shared/persistence-state';
import { __kustoClearStoredQueryResult, createSectionWithCapabilities, schedulePersist } from '../core/persistence';
import {
	__kustoGetConnectionId, __kustoGetDatabase, __kustoGetQuerySectionElement,
	__kustoGetSqlSectionElement,
	__kustoSetSectionName, __kustoGetSectionName, __kustoPickNextAvailableSectionLetterName,
	toggleCacheControls, removeQueryBox,
	__kustoGetCurrentClusterUrlForBox, __kustoGetCurrentDatabaseForBox, __kustoFindFavorite,
	__kustoLog,
} from '../core/section-factory';
import { getRunMode, setRunMode, closeRunMenu, functionRunDialogOpenByBoxId } from './kw-query-toolbar';
import { bindResultArtifactConsumer, clearResultsState, getCurrentResultArtifact, getResultArtifact, getResultArtifactByProducerExecution, retireResultsStateForRerun, unbindResultArtifactConsumer } from '../core/results-state';
import {
	optimizationMetadataByBoxId, queryEditors, pendingFavoriteSelectionByBoxId,
	queryExecutionTimers, clearKustoEditorSchema, queryBoxes, favoritesModeByBoxId,
} from '../core/state';
import { __kustoParseFunction, __kustoParseParamList } from '../monaco/prettify';
import { findKustoFunctionDefinitionAtOffset, getSingleKustoCodeFenceBodyRange, hasKustoFunctionDefinition, normalizeKustoText } from '../../shared/kustoFunctionDefinitions.js';
import { comparisonSourceArtifactConsumerId } from '../../shared/resultArtifact.js';
import type { FunctionParam } from '../components/kw-function-params-dialog';
import { hasKustoOptimizeRequestIdentity, kustoExecutionRequestIdentityEquals, kustoOptimizeRequestIdentityEquals, type KustoComparisonRunIdentity, type KustoExecutionProducer, type KustoExecutionRequestIdentity, type KustoOptimizeRequestIdentity } from '../../shared/kustoExecution.js';
import { synchronizeKustoSectionTarget } from '../core/query-section-accessors.js';
import '../components/kw-function-params-dialog';

export const lastRunCacheEnabledByBoxId: Record<string, boolean> = {};

type ComparisonExecutionOptions =
	| Readonly<{ role: 'source'; comparisonBoxId: string }>
	| Readonly<{ role: 'comparison'; comparisonRun: KustoComparisonRunIdentity }>;

const _win = window;

// ── Host interface (avoids circular import with kw-query-section.ts) ──────────

export interface ExecutionSectionHost extends ReactiveControllerHost, HTMLElement {
	boxId: string;
	getConnectionId(): string;
	getDatabase(): string;
	getSchemaLifecycleIdentity(): { sectionInstanceId: string; targetGeneration: number } | undefined;
}

// ── ReactiveController ────────────────────────────────────────────────────────

/**
 * Manages query execution, results visibility, comparison summary, optimization
 * prompt, and run-mode concerns for a single `<kw-query-section>` element.
 */
export class QueryExecutionController implements ReactiveController {
	host: ExecutionSectionHost;
	private activeExecution: KustoExecutionRequestIdentity | undefined;
	private readonly retiredExecutions: KustoExecutionRequestIdentity[] = [];
	private activeOptimizeRequest: KustoOptimizeRequestIdentity | undefined;
	private cancelling = false;

	constructor(host: ExecutionSectionHost) {
		this.host = host;
		host.addController(this);
	}

	hostConnected(): void {
		// Lifecycle hook — no setup needed at connection time.
	}

	hostDisconnected(): void {
		// Reorder disconnect/reconnect is not disposal. The exact execution owner
		// and elapsed timer remain valid until an explicit terminal or removal.
	}

	beginKustoOptimizeRequest(): KustoOptimizeRequestIdentity | undefined {
		const lifecycle = this.host.getSchemaLifecycleIdentity();
		if (!lifecycle) return undefined;
		this.retireKustoOptimizeRequest();
		this.activeOptimizeRequest = Object.freeze({
			boxId: this.host.boxId,
			...lifecycle,
			optimizeRequestId: `kusto-optimize-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
		});
		return this.activeOptimizeRequest;
	}

	getActiveKustoOptimizeRequest(): KustoOptimizeRequestIdentity | undefined {
		return this.activeOptimizeRequest;
	}

	admitKustoOptimizeMessage(identity: unknown): boolean {
		if (!this.activeOptimizeRequest || !hasKustoOptimizeRequestIdentity(identity)
			|| !kustoOptimizeRequestIdentityEquals(this.activeOptimizeRequest, identity)) return false;
		const lifecycle = this.host.getSchemaLifecycleIdentity();
		return !!lifecycle
			&& lifecycle.sectionInstanceId === this.activeOptimizeRequest.sectionInstanceId
			&& lifecycle.targetGeneration === this.activeOptimizeRequest.targetGeneration;
	}

	completeKustoOptimizeRequest(identity: unknown): boolean {
		if (!this.admitKustoOptimizeMessage(identity)) return false;
		this.activeOptimizeRequest = undefined;
		return true;
	}

	retireKustoOptimizeRequest(): KustoOptimizeRequestIdentity | undefined {
		const owner = this.activeOptimizeRequest;
		if (!owner) return undefined;
		this.activeOptimizeRequest = undefined;
		try { postMessageToHost({ type: 'cancelOptimizeQuery', ...owner }); } catch (e) { console.error('[kusto]', e); }
		try { this.hideOptimizePrompt(); } catch (e) { console.error('[kusto]', e); }
		return owner;
	}

	// ── Results visibility ────────────────────────────────────────────────────

	setResultsVisible(visible: any): void {
		const boxId = this.host.boxId;
		try { pState.resultsVisibleByBoxId[boxId] = !!visible; } catch (e) { console.error('[kusto]', e); }
		try { this.updateResultsToggleButton(); } catch (e) { console.error('[kusto]', e); }
		try { this.applyResultsVisibility(); } catch (e) { console.error('[kusto]', e); }
	}

	updateResultsToggleButton(): void {
		const boxId = this.host.boxId;
		const btn = document.getElementById(boxId + '_results_toggle') as any;
		if (!btn) return;
		let visible = true;
		try { visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
		btn.classList.toggle('is-active', visible);
		btn.setAttribute('aria-selected', visible ? 'true' : 'false');
		btn.title = visible ? 'Hide results' : 'Show results';
		btn.setAttribute('aria-label', visible ? 'Hide results' : 'Show results');
	}

	updateComparisonSummaryToggleButton(): void {
		const boxId = this.host.boxId;
		const btn = document.getElementById(boxId + '_summary_toggle') as any;
		if (!btn) return;
		let visible = true;
		try { visible = !(_win.__kustoComparisonSummaryVisibleByBoxId && _win.__kustoComparisonSummaryVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
		btn.classList.toggle('is-active', visible);
		btn.setAttribute('aria-selected', visible ? 'true' : 'false');
		btn.title = visible ? 'Hide comparison summary' : 'Show comparison summary';
		btn.setAttribute('aria-label', visible ? 'Hide comparison summary' : 'Show comparison summary');
	}

	applyResultsVisibility(): void {
		const boxId = this.host.boxId;
		const wrapper = document.getElementById(boxId + '_results_wrapper') as any;
		if (!wrapper) {
			let visible = true;
			try { visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
			try {
				const body = document.getElementById(boxId + '_results_body') as any;
				if (body) body.style.display = visible ? '' : 'none';
			} catch (e) { console.error('[kusto]', e); }
			try {
				const resultsDiv = document.getElementById(boxId + '_results') as any;
				if (resultsDiv && resultsDiv.classList) resultsDiv.classList.toggle('is-results-hidden', !visible);
			} catch (e) { console.error('[kusto]', e); }
			return;
		}
		let visible = true;
		try { visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
		const resultsDiv = document.getElementById(boxId + '_results') as any;
		const hasContent = !!(resultsDiv && String(resultsDiv.innerHTML || '').trim());
		let hasTable = false;
		try { hasTable = !!(resultsDiv && resultsDiv.querySelector && (resultsDiv.querySelector('.table-container') || resultsDiv.querySelector('kw-data-table'))); } catch (e) { console.error('[kusto]', e); }

		if (resultsDiv && resultsDiv.querySelector && resultsDiv.querySelector('kw-data-table')) {
			const dt = resultsDiv.querySelector('kw-data-table') as any;
			let vis = true;
			try { vis = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
			if (dt && typeof dt.setBodyVisible === 'function') dt.setBodyVisible(vis, { emit: false });
			return;
		}

		wrapper.style.display = hasContent ? 'flex' : 'none';
		if (hasContent) {
			const body = document.getElementById(boxId + '_results_body') as any;
			if (body) body.style.display = visible ? '' : 'none';
			const resizer = document.getElementById(boxId + '_results_resizer') as any;
			if (resizer) resizer.style.display = (visible && hasTable) ? '' : 'none';
			try {
				if (!visible) {
					if (wrapper.style.height && wrapper.style.height !== 'auto') {
						wrapper.dataset.kustoPreviousHeight = wrapper.style.height;
					}
					wrapper.style.height = 'auto';
					wrapper.style.minHeight = '0';
				} else if (!hasTable) {
					try {
						if (wrapper.style.height && wrapper.style.height !== 'auto') {
							wrapper.dataset.kustoPrevSuccessHeight = wrapper.style.height;
						}
					} catch (e) { console.error('[kusto]', e); }
					wrapper.style.height = 'auto';
					wrapper.style.minHeight = '0';
				} else {
					wrapper.style.minHeight = '120px';
					if (!wrapper.style.height || wrapper.style.height === 'auto') {
						if (wrapper.dataset.kustoPreviousHeight) {
							wrapper.style.height = wrapper.dataset.kustoPreviousHeight;
						} else if (wrapper.dataset.kustoPrevSuccessHeight) {
							wrapper.style.height = wrapper.dataset.kustoPrevSuccessHeight;
						} else {
							wrapper.style.height = '240px';
						}
					}
					try {
						const m = String(wrapper.style.height || '').trim().match(/^([0-9]+)px$/i);
						if (m) {
							const px = parseInt(m[1], 10);
							if (isFinite(px)) {
								const clamped = Math.max(120, Math.min(900, px));
								if (clamped !== px) wrapper.style.height = clamped + 'px';
							}
						}
					} catch (e) { console.error('[kusto]', e); }
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	}

	applyComparisonSummaryVisibility(): void {
		const boxId = this.host.boxId;
		const box = document.getElementById(boxId) as any;
		if (!box) return;
		const banner = box.querySelector('.comparison-summary-banner');
		if (!banner) return;
		try {
			if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].isComparison) {
				banner.style.display = '';
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		let visible = true;
		try { visible = !(_win.__kustoComparisonSummaryVisibleByBoxId && _win.__kustoComparisonSummaryVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
		banner.style.display = visible ? '' : 'none';
	}

	// ── Execution state ───────────────────────────────────────────────────────

	beginQueryExecution(
		executionId: string,
		producer: KustoExecutionProducer = 'manual',
		copilotRequestId?: string,
		expectedPredecessorExecutionId?: string,
		comparisonRun?: KustoComparisonRunIdentity,
	): boolean {
		const id = String(executionId || '').trim();
		const lifecycle = this.host.getSchemaLifecycleIdentity();
		const connectionId = String(this.host.getConnectionId() || '').trim();
		const database = String(this.host.getDatabase() || '').trim();
		if (!id || !lifecycle || !connectionId || !database) return false;
		if (expectedPredecessorExecutionId !== undefined && this.activeExecution
			&& this.activeExecution.executionId !== expectedPredecessorExecutionId) return false;
		if (this.activeExecution) this.rememberRetired(this.activeExecution);
		this.activeExecution = Object.freeze({
			engine: 'kusto',
			boxId: this.host.boxId,
			executionId: id,
			sectionInstanceId: lifecycle.sectionInstanceId,
			targetGeneration: lifecycle.targetGeneration,
			connectionId,
			database,
			producer,
			...(copilotRequestId ? { copilotRequestId } : {}),
			...(comparisonRun ? { comparisonRun } : {}),
		});
		this.cancelling = false;
		this.setQueryExecuting(true);
		return true;
	}

	setExternalQueryExecuting(executing: boolean, executionId: string): boolean {
		const id = String(executionId || '').trim();
		if (!id) return false;
		if (executing) {
			if (this.activeExecution && this.activeExecution.executionId !== id) return false;
			return this.activeExecution ? true : this.beginQueryExecution(id, 'copilot');
		}
		if (this.activeExecution?.executionId !== id) return false;
		this.activeExecution = undefined;
		this.cancelling = false;
		this.setQueryExecuting(false);
		return true;
	}

	getActiveExecutionId(): string {
		return this.activeExecution?.executionId ?? '';
	}

	getActiveExecution(): KustoExecutionRequestIdentity | undefined {
		return this.activeExecution;
	}

	admitQueryTerminal(identity: KustoExecutionRequestIdentity): 'active' | 'retired' | 'rejected' {
		if (this.activeExecution && this.executionMatches(this.activeExecution, identity)) return 'active';
		const retiredIndex = this.retiredExecutions.findIndex(owner => this.executionMatches(owner, identity));
		if (retiredIndex < 0) return 'rejected';
		this.retiredExecutions.splice(retiredIndex, 1);
		return 'retired';
	}

	acceptsQueryTerminal(executionId: string): boolean {
		return !!this.activeExecution && this.activeExecution.executionId === String(executionId || '').trim();
	}

	completeQueryExecution(executionId: string): boolean {
		if (!this.acceptsQueryTerminal(executionId)) return false;
		this.activeExecution = undefined;
		this.cancelling = false;
		return true;
	}

	requestCancelActiveQueryExecution(): KustoExecutionRequestIdentity | undefined {
		if (!this.activeExecution || this.cancelling) return undefined;
		this.cancelling = true;
		return this.activeExecution;
	}

	cancelActiveQueryExecution(): string | undefined {
		return this.requestCancelActiveQueryExecution()?.executionId;
	}

	retireActiveQueryExecution(): KustoExecutionRequestIdentity | undefined {
		const active = this.activeExecution;
		if (!active) return undefined;
		this.rememberRetired(active);
		this.activeExecution = undefined;
		this.cancelling = false;
		this.setQueryExecuting(false);
		return active;
	}

	private rememberRetired(owner: KustoExecutionRequestIdentity): void {
		if (this.retiredExecutions.some(candidate => this.executionMatches(candidate, owner))) return;
		this.retiredExecutions.push(owner);
	}

	private executionMatches(left: KustoExecutionRequestIdentity, right: KustoExecutionRequestIdentity): boolean {
		return kustoExecutionRequestIdentityEquals(left, right);
	}

	setQueryExecuting(executing: any): void {
		const boxId = this.host.boxId;
		// Sync test-observable state on the host element.
		if (typeof (this.host as any)._testExecuting !== 'undefined') {
			(this.host as any)._testExecuting = !!executing;
		}
		const runBtn = document.getElementById(boxId + '_run_btn') as any;
		const runToggle = document.getElementById(boxId + '_run_toggle') as any;
		const status = document.getElementById(boxId + '_exec_status') as any;
		const elapsed = document.getElementById(boxId + '_exec_elapsed') as any;
		const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;

		if (queryExecutionTimers[boxId]) {
			clearInterval(queryExecutionTimers[boxId]);
			delete queryExecutionTimers[boxId];
		}

		if (executing) {
			if (runBtn) runBtn.disabled = true;
			if (runToggle) runToggle.disabled = true;
			if (cancelBtn) {
				cancelBtn.disabled = false;
				cancelBtn.style.display = 'flex';
			}
			closeRunMenu(boxId);
			if (status) status.style.display = 'inline-flex';
			if (elapsed) elapsed.textContent = '0:00';
			try {
				const resultsDiv = document.getElementById(boxId + '_results') as any;
				if (resultsDiv && resultsDiv.innerHTML.trim()) resultsDiv.classList.add('is-stale');
			} catch (e) { console.error('[kusto]', e); }
			const start = performance.now();
			queryExecutionTimers[boxId] = setInterval(() => {
				if (elapsed) elapsed.textContent = formatElapsed(performance.now() - start);
			}, 1000);
			return;
		}

		try {
			if (typeof _win.__kustoUpdateRunEnabledForBox === 'function') {
				_win.__kustoUpdateRunEnabledForBox(boxId);
			} else {
				if (runBtn) runBtn.disabled = false;
				if (runToggle) runToggle.disabled = false;
			}
		} catch {
			if (runBtn) runBtn.disabled = false;
			if (runToggle) runToggle.disabled = false;
		}
		if (cancelBtn) {
			cancelBtn.disabled = true;
			cancelBtn.style.display = 'none';
		}
		if (status) status.style.display = 'none';
		try {
			const resultsDiv = document.getElementById(boxId + '_results') as any;
			if (resultsDiv) resultsDiv.classList.remove('is-stale');
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Cache & run mode backup/restore ───────────────────────────────────────

	lockCacheForBenchmark(): void {
		const boxId = this.host.boxId;
		const msg = 'When doing performance benchmarks we cannot use query plan caching.';
		try {
			const checkbox = document.getElementById(boxId + '_cache_enabled') as any;
			const valueInput = document.getElementById(boxId + '_cache_value') as any;
			const unitSelect = document.getElementById(boxId + '_cache_unit') as any;
			if (checkbox) {
				checkbox.checked = false;
				checkbox.disabled = true;
				checkbox.title = msg;
				try {
					const label = checkbox.closest('label');
					if (label) label.title = msg;
				} catch (e) { console.error('[kusto]', e); }
			}
			if (valueInput) { valueInput.disabled = true; valueInput.title = msg; }
			if (unitSelect) { unitSelect.disabled = true; unitSelect.title = msg; }
			try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
	}

	// ── Optimize prompt ───────────────────────────────────────────────────────

	hideOptimizePrompt(): void {
		const boxId = this.host.boxId;
		const host = document.getElementById(boxId + '_optimize_config') as any;
		if (host) {
			host.style.display = 'none';
			host.innerHTML = '';
		}
		try {
			const pending = __kustoEnsureOptimizePrepByBoxId();
			delete pending[boxId];
		} catch (e) { console.error('[kusto]', e); }
		try {
			const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
			if (optimizeBtn) {
				if (optimizeBtn.dataset && optimizeBtn.dataset.originalContent) {
					optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
					delete optimizeBtn.dataset.originalContent;
				}
			}
		} catch (e) { console.error('[kusto]', e); }
		try { this.setOptimizeInProgress(false, ''); } catch (e) { console.error('[kusto]', e); }
		try { restoreKustoOptimizeButtonAvailability(boxId); } catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof _win.__kustoUpdateRunEnabledForBox === 'function') _win.__kustoUpdateRunEnabledForBox(boxId);
		} catch (e) { console.error('[kusto]', e); }
	}

	setOptimizeInProgress(inProgress: any, statusText: any): void {
		const boxId = this.host.boxId;
		try {
			const statusEl = document.getElementById(boxId + '_optimize_status') as any;
			const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
			const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
			if (!statusEl || !cancelBtn) return;
			const on = !!inProgress;
			try {
				if (optimizeBtn && optimizeBtn.dataset) {
					if (on) {
						optimizeBtn.dataset.kustoOptimizeInProgress = '1';
						optimizeBtn.disabled = true;
					} else {
						delete optimizeBtn.dataset.kustoOptimizeInProgress;
					}
				}
			} catch (e) { console.error('[kusto]', e); }
			statusEl.style.display = on ? '' : 'none';
			cancelBtn.style.display = on ? '' : 'none';
			if (on) {
				statusEl.textContent = String(statusText || 'Optimizing…');
				cancelBtn.disabled = false;
				try {
					const text = String(statusText || '');
					const shouldStartSpinner = /waiting\s+for\s+copilot\s+response/i.test(text);
					const spinnerAlreadyOn = !!(optimizeBtn && optimizeBtn.dataset && optimizeBtn.dataset.kustoOptimizeSpinnerActive === '1');
					if (optimizeBtn && (shouldStartSpinner || spinnerAlreadyOn)) {
						if (!optimizeBtn.dataset.originalContent) optimizeBtn.dataset.originalContent = optimizeBtn.innerHTML;
						optimizeBtn.dataset.kustoOptimizeSpinnerActive = '1';
						optimizeBtn.innerHTML = '<span class="query-spinner" aria-hidden="true"></span>';
					}
				} catch (e) { console.error('[kusto]', e); }
			} else {
				statusEl.textContent = '';
				cancelBtn.disabled = false;
				try {
					if (optimizeBtn && optimizeBtn.dataset) {
						delete optimizeBtn.dataset.kustoOptimizeSpinnerActive;
						if (optimizeBtn.dataset.originalContent) {
							optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent;
							delete optimizeBtn.dataset.originalContent;
						}
					}
				} catch (e) { console.error('[kusto]', e); }
			}
		} catch (e) { console.error('[kusto]', e); }
	}

	updateOptimizeStatus(statusText: any): void {
		const boxId = this.host.boxId;
		try {
			const statusEl = document.getElementById(boxId + '_optimize_status') as any;
			if (!statusEl) return;
			statusEl.textContent = String(statusText || '');
		} catch (e) { console.error('[kusto]', e); }
	}

	applyOptimizeQueryOptions(models: any, selectedModelId: any, promptText: any): void {
		const boxId = this.host.boxId;
		const host = document.getElementById(boxId + '_optimize_config') as any;
		if (!host) return;
		const safeModels = Array.isArray(models) ? models : [];
		host.style.display = 'block';
		host.innerHTML =
			'<div class="optimize-config-inner">' +
			'<div class="optimize-config-row">' +
			'<label class="optimize-config-label" for="' + boxId + '_optimize_model">Model</label>' +
			'<select class="optimize-config-select" id="' + boxId + '_optimize_model"></select>' +
			'</div>' +
			'<div class="optimize-config-row">' +
			'<label class="optimize-config-label" for="' + boxId + '_optimize_prompt">Prompt</label>' +
			'<textarea class="optimize-config-textarea" id="' + boxId + '_optimize_prompt" spellcheck="false"></textarea>' +
			'</div>' +
			'<div class="optimize-config-actions">' +
			'<button type="button" class="optimize-config-run-btn" onclick="__kustoRunOptimizeQueryWithOverrides(\'' + boxId + '\')">Optimize</button>' +
			'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoCancelOptimizeQuery(\'' + boxId + '\')">Cancel</button>' +
			'</div>' +
			'</div>';
		const selectEl = document.getElementById(boxId + '_optimize_model') as any;
		if (selectEl) {
			selectEl.innerHTML = '';
			for (const m of safeModels) {
				if (!m || !m.id) continue;
				const opt = document.createElement('option');
				opt.value = String(m.id);
				const label = String(m.label || m.id);
				const id = String(m.id);
				opt.textContent = (label && label !== id) ? label + ' (' + id + ')' : id;
				opt.setAttribute('data-short-label', label);
				selectEl.appendChild(opt);
			}
			const preferredModelId = __kustoGetLastOptimizeModelId();
			let preferredExists = false;
			if (preferredModelId) {
				for (let i = 0; i < selectEl.options.length; i++) {
					if (selectEl.options[i].value === preferredModelId) { preferredExists = true; break; }
				}
			}
			if (preferredExists) selectEl.value = preferredModelId;
			else if (selectedModelId) selectEl.value = String(selectedModelId);
			if (!selectEl.value && selectEl.options && selectEl.options.length > 0) selectEl.selectedIndex = 0;
		}
		const promptEl = document.getElementById(boxId + '_optimize_prompt') as any;
		if (promptEl) promptEl.value = String(promptText || '');
	}

	// ── Run readiness ─────────────────────────────────────────────────────────

	isRunSelectionReady(): boolean {
		const boxId = this.host.boxId;
		if (!boxId) return false;
		const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(boxId);
		try {
			const pending1 = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[boxId]);
			const pending2 = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[ownerId]);
			if (pending1 || pending2) return false;
		} catch (e) { console.error('[kusto]', e); }
		const connectionId = __kustoGetConnectionId(ownerId);
		const database = __kustoGetDatabase(ownerId);
		if (!__kustoIsValidConnectionIdForRun_pure(connectionId)) return false;
		if (!database) return false;
		return true;
	}

	updateRunEnabled(): void {
		const boxId = this.host.boxId;
		if (!boxId) return;
		const runBtn = document.getElementById(boxId + '_run_btn') as any;
		const runToggle = document.getElementById(boxId + '_run_toggle') as any;
		const disabledTooltip = 'Select a cluster and database first (or select a favorite)';
		try {
			if (queryExecutionTimers && queryExecutionTimers[boxId]) {
				if (runBtn) runBtn.disabled = true;
				if (runToggle) runToggle.disabled = true;
				return;
			}
		} catch (e) { console.error('[kusto]', e); }
		try { __kustoClearSchemaSummaryIfNoSelection(boxId); } catch (e) { console.error('[kusto]', e); }
		const enabled = this.isRunSelectionReady();
		if (runBtn) {
			runBtn.disabled = !enabled;
			try {
				const modeLabel = getRunModeLabelText(getRunMode(boxId));
				runBtn.title = enabled ? modeLabel : (modeLabel + '\n' + disabledTooltip);
				runBtn.setAttribute('aria-label', enabled ? modeLabel : disabledTooltip);
			} catch (e) { console.error('[kusto]', e); }
		}
		if (runToggle) runToggle.disabled = false;
	}
}

export function restoreKustoOptimizeButtonAvailability(boxIdValue: unknown): void {
	const boxId = String(boxIdValue || '').trim();
	const button = document.getElementById(boxId + '_optimize_btn') as HTMLButtonElement | null;
	if (!button || button.dataset.kustoOptimizeInProgress === '1') return;
	button.disabled = button.dataset.kustoCopilotAvailable !== '1';
	button.setAttribute('aria-disabled', String(button.disabled));
}

// ── Module-level helpers ──────────────────────────────────────────────────────

function __kustoEnsureOptimizePrepByBoxId() {
	try {
		if (!_win.__kustoOptimizePrepByBoxId || typeof _win.__kustoOptimizePrepByBoxId !== 'object') {
			_win.__kustoOptimizePrepByBoxId = {};
		}
		return _win.__kustoOptimizePrepByBoxId;
	} catch { return {}; }
}

function __kustoEnsureCacheBackupMap() {
	if (!_win.__kustoCacheBackupByBoxId || typeof _win.__kustoCacheBackupByBoxId !== 'object') {
		_win.__kustoCacheBackupByBoxId = {};
	}
	return _win.__kustoCacheBackupByBoxId;
}

function __kustoBackupCacheSettings(boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureCacheBackupMap();
	if (map[boxId]) return;
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		map[boxId] = {
			enabled: enabledEl ? !!enabledEl.checked : true,
			value: valueEl ? (parseInt(valueEl.value) || 1) : 1,
			unit: unitEl ? String(unitEl.value || 'days') : 'days'
		};
	} catch (e) { console.error('[kusto]', e); }
}

function __kustoRestoreCacheSettings(boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureCacheBackupMap();
	const backup = map[boxId];
	if (!backup) {
		try {
			const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
			const valueEl = document.getElementById(boxId + '_cache_value') as any;
			const unitEl = document.getElementById(boxId + '_cache_unit') as any;
			if (enabledEl) { enabledEl.disabled = false; enabledEl.title = ''; }
			if (valueEl) { valueEl.disabled = false; valueEl.title = ''; }
			if (unitEl) { unitEl.disabled = false; unitEl.title = ''; }
			try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
		} catch (e) { console.error('[kusto]', e); }
		return;
	}
	try {
		const enabledEl = document.getElementById(boxId + '_cache_enabled') as any;
		const valueEl = document.getElementById(boxId + '_cache_value') as any;
		const unitEl = document.getElementById(boxId + '_cache_unit') as any;
		if (enabledEl) {
			enabledEl.checked = !!backup.enabled;
			enabledEl.disabled = false;
			enabledEl.title = '';
			try { const label = enabledEl.closest('label'); if (label) label.title = ''; } catch (e) { console.error('[kusto]', e); }
		}
		if (valueEl) { valueEl.value = String(backup.value || 1); valueEl.disabled = false; valueEl.title = ''; }
		if (unitEl) { unitEl.value = String(backup.unit || 'days'); unitEl.disabled = false; unitEl.title = ''; }
		try { toggleCacheControls(boxId); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
	try { delete map[boxId]; } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function __kustoEnsureRunModeBackupMap() {
	if (!_win.__kustoRunModeBackupByBoxId || typeof _win.__kustoRunModeBackupByBoxId !== 'object') {
		_win.__kustoRunModeBackupByBoxId = {};
	}
	return _win.__kustoRunModeBackupByBoxId;
}

function __kustoBackupRunMode(boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	if (map[boxId] && typeof map[boxId].mode === 'string') return;
	try { map[boxId] = { mode: String(getRunMode(boxId) || 'take100') }; } catch { map[boxId] = { mode: 'take100' }; }
}

function __kustoRestoreRunMode(boxId: any) {
	if (!boxId) return;
	const map = __kustoEnsureRunModeBackupMap();
	const backup = map[boxId];
	if (!backup || typeof backup.mode !== 'string') return;
	try { setRunMode(boxId, String(backup.mode || 'take100')); } catch (e) { console.error('[kusto]', e); }
	try { delete map[boxId]; } catch (e) { console.error('[kusto]', e); }
}

function __kustoGetEffectiveSelectionOwnerIdForRun(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return '';
	try {
		if (typeof _win.__kustoGetSelectionOwnerBoxId === 'function') {
			return String(_win.__kustoGetSelectionOwnerBoxId(id) || id).trim();
		}
	} catch (e) { console.error('[kusto]', e); }
	return id;
}

function __kustoHasValidFavoriteSelection(ownerBoxId: any) {
	try {
		const id = String(ownerBoxId || '').trim();
		if (!id) return false;
		const connectionId = String(__kustoGetConnectionId(id) || '').trim();
		const db = String(__kustoGetCurrentDatabaseForBox(id) || '').trim();
		if (!connectionId || !db) return false;
		return !!__kustoFindFavorite(connectionId, db);
	} catch { return false; }
}

function __kustoClearSchemaSummaryIfNoSelection(boxId: any) {
	const id = String(boxId || '').trim();
	if (!id) return;
	const ownerId = __kustoGetEffectiveSelectionOwnerIdForRun(id);
	const connectionId = __kustoGetConnectionId(ownerId);
	const database = __kustoGetDatabase(ownerId);
	const hasValidCluster = __kustoIsValidConnectionIdForRun_pure(connectionId);
	const shouldClear = ((!hasValidCluster || !database) && !__kustoHasValidFavoriteSelection(ownerId));
	try {
		const btn = document.getElementById(id + '_schema_refresh') as any;
		if (btn) btn.style.display = shouldClear ? 'none' : '';
	} catch (e) { console.error('[kusto]', e); }
	if (shouldClear) {
		try { clearKustoEditorSchema(id); } catch (e) { console.error('[kusto]', e); }
		try {
			const kwEl = __kustoGetQuerySectionElement(id);
			if (kwEl && typeof kwEl.setSchemaInfo === 'function') {
				kwEl.setSchemaInfo({ status: 'not-loaded', statusText: 'Not loaded', cached: false, tables: undefined, cols: undefined, funcs: undefined, errorMessage: undefined });
			}
		} catch (e) { console.error('[kusto]', e); }
	}
}

function __kustoUpdateAcceptOptimizationsButton(comparisonBoxId: any, enabled: any, tooltip: any) {
	const btn = document.getElementById(comparisonBoxId + '_accept_btn') as any;
	if (!btn) return;
	btn.disabled = !enabled;
	btn.title = tooltip || (enabled ? 'Accept Optimizations' : 'Accept Optimizations is enabled when the optimized query has results.');
	btn.setAttribute('aria-disabled', enabled ? 'false' : 'true');
}

const __kustoOptimizeModelStorageKey = 'kusto.optimize.lastModelId';

export function __kustoGetLastOptimizeModelId() {
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
		if (state && state.lastOptimizeModelId) return String(state.lastOptimizeModelId);
	} catch (e) { console.error('[kusto]', e); }
	try { return String(localStorage.getItem(__kustoOptimizeModelStorageKey) || ''); } catch (e) { console.error('[kusto]', e); }
	return '';
}

export function __kustoSetLastOptimizeModelId(modelId: any) {
	const id = String(modelId || '');
	try {
		const state = (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.getState) ? (_win.vscode.getState() || {}) : {};
		state.lastOptimizeModelId = id;
		if (typeof _win.vscode !== 'undefined' && _win.vscode && _win.vscode.setState) _win.vscode.setState(state);
	} catch (e) { console.error('[kusto]', e); }
	try { if (id) localStorage.setItem(__kustoOptimizeModelStorageKey, id); } catch (e) { console.error('[kusto]', e); }
}

// ── Facade functions — match old API, delegate to controller where applicable ─

export function __kustoSetResultsVisible(boxId: any, visible: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.setResultsVisible(visible); return; }
	// Fallback: direct DOM update for non-controller boxes.
	try { pState.resultsVisibleByBoxId[boxId] = !!visible; } catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyResultsVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
}

export function __kustoUpdateQueryResultsToggleButton(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.updateResultsToggleButton(); return; }
	// Inline fallback for non-controller boxes.
	const btn = document.getElementById(boxId + '_results_toggle') as any;
	if (!btn) return;
	let visible = true;
	try { visible = !(pState.resultsVisibleByBoxId && pState.resultsVisibleByBoxId[boxId] === false); } catch (e) { console.error('[kusto]', e); }
	btn.classList.toggle('is-active', visible);
	btn.setAttribute('aria-selected', visible ? 'true' : 'false');
	btn.title = visible ? 'Hide results' : 'Show results';
	btn.setAttribute('aria-label', visible ? 'Hide results' : 'Show results');
}

export function __kustoUpdateComparisonSummaryToggleButton(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.updateComparisonSummaryToggleButton(); return; }
}

export function __kustoApplyResultsVisibility(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.applyResultsVisibility(); return; }
}

export function __kustoApplyComparisonSummaryVisibility(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.applyComparisonSummaryVisibility(); return; }
}

export function setQueryExecuting(boxId: any, executing: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.setQueryExecuting(executing); return; }
	// Inline fallback for non-controller boxes (e.g. during creation).
	if (queryExecutionTimers[boxId]) { clearInterval(queryExecutionTimers[boxId]); delete queryExecutionTimers[boxId]; }
}

export function __kustoSetLinkedOptimizationMode(sourceBoxId: any, comparisonBoxId: any, active: any) {
	const ids = [String(sourceBoxId || '').trim(), String(comparisonBoxId || '').trim()].filter(Boolean);
	for (const id of ids) {
		const el = document.getElementById(id) as any;
		if (!el) continue;
		if (active) {
			try { __kustoBackupCacheSettings(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoBackupRunMode(id); } catch (e) { console.error('[kusto]', e); }
			try { setRunMode(id, 'plain'); } catch (e) { console.error('[kusto]', e); }
			el.classList.add('has-linked-optimization');
		} else {
			el.classList.remove('has-linked-optimization');
			try { __kustoRestoreCacheSettings(id); } catch (e) { console.error('[kusto]', e); }
			try { __kustoRestoreRunMode(id); } catch (e) { console.error('[kusto]', e); }
		}
	}
}

export function __kustoIsRunSelectionReady(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) return el.executionCtrl.isRunSelectionReady();
	return false;
}

export function __kustoHideOptimizePromptForBox(boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.hideOptimizePrompt(); return; }
}

export function __kustoSetOptimizeInProgress(boxId: any, inProgress: any, statusText: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.setOptimizeInProgress(inProgress, statusText); return; }
}

export function __kustoUpdateOptimizeStatus(boxId: any, statusText: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.updateOptimizeStatus(statusText); return; }
}

export function __kustoApplyOptimizeQueryOptions(boxId: any, models: any, selectedModelId: any, promptText: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.applyOptimizeQueryOptions(models, selectedModelId, promptText); return; }
}

// ── Toggle functions ──────────────────────────────────────────────────────────

function toggleQueryResultsVisibility(boxId: any) {
	try {
		if (!pState.resultsVisibleByBoxId || typeof pState.resultsVisibleByBoxId !== 'object') pState.resultsVisibleByBoxId = {};
		const current = !(pState.resultsVisibleByBoxId[boxId] === false);
		pState.resultsVisibleByBoxId[boxId] = !current;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateQueryResultsToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyResultsVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof _win.__kustoOnResultsVisibilityToggled === 'function') _win.__kustoOnResultsVisibilityToggled(boxId);
	} catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

function toggleComparisonSummaryVisibility(boxId: any) {
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].isComparison) return;
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (!_win.__kustoComparisonSummaryVisibleByBoxId || typeof _win.__kustoComparisonSummaryVisibleByBoxId !== 'object') _win.__kustoComparisonSummaryVisibleByBoxId = {};
		const current = !(_win.__kustoComparisonSummaryVisibleByBoxId[boxId] === false);
		_win.__kustoComparisonSummaryVisibleByBoxId[boxId] = !current;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoUpdateComparisonSummaryToggleButton(boxId); } catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyComparisonSummaryVisibility(boxId); } catch (e) { console.error('[kusto]', e); }
	try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
}

// ── Comparison & optimization — cross-box standalone functions ────────────────

export function acceptOptimizations(comparisonBoxId: any) {
	try {
		const meta = (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) ? optimizationMetadataByBoxId[comparisonBoxId] : null;
		const sourceBoxId = meta && meta.sourceBoxId ? meta.sourceBoxId : '';
		const currentQuery = queryEditors[comparisonBoxId] && typeof queryEditors[comparisonBoxId].getValue === 'function'
			? queryEditors[comparisonBoxId].getValue()
			: (meta && typeof meta.optimizedQuery === 'string' ? meta.optimizedQuery : '');
		if (!sourceBoxId || !currentQuery) return;
		if (queryEditors[sourceBoxId] && typeof queryEditors[sourceBoxId].setValue === 'function') {
			const beforeSignature = _win.__kustoGetSectionSerializedSignature?.(sourceBoxId);
			queryEditors[sourceBoxId].setValue(currentQuery);
			_win.__kustoMarkSectionAgentTouched?.(sourceBoxId, beforeSignature);
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		}
		try { __kustoSetLinkedOptimizationMode(sourceBoxId, comparisonBoxId, false); } catch (e) { console.error('[kusto]', e); }
		try { removeQueryBox(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
		try {
			if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
				delete optimizationMetadataByBoxId[comparisonBoxId];
				if (optimizationMetadataByBoxId[sourceBoxId]) delete optimizationMetadataByBoxId[sourceBoxId];
			}
		} catch (e) { console.error('[kusto]', e); }
		try { postMessageToHost({ type: 'showInfo', message: 'Optimizations accepted: source query updated.' }); } catch (e) { console.error('[kusto]', e); }
	} catch (e) { console.error('[kusto]', e); }
}

export function displayComparisonSummary(sourceBoxId: any, comparisonBoxId: any) {
	const comparisonArtifact = getCurrentResultArtifact(comparisonBoxId);
	const comparisonSourceArtifactId = comparisonArtifact?.lineage.find(input => (
		input.role === 'comparison-source'
	))?.sourceArtifactId;
	const exactSourceArtifact = comparisonSourceArtifactId
		? getResultArtifact(comparisonSourceArtifactId)
		: null;
	const sourceState = exactSourceArtifact;
	const comparisonState = comparisonArtifact;
	if (!sourceState || !comparisonState) return;

	const getBoxLabel = (boxId: any) => {
		try { const name = __kustoGetSectionName(boxId); return name || String(boxId || '').trim() || 'Dataset'; } catch { return String(boxId || '').trim() || 'Dataset'; }
	};
	const sourceLabel = getBoxLabel(sourceBoxId);
	const comparisonLabel = getBoxLabel(comparisonBoxId);
	const pluralRows = (n: any) => (Number(n) === 1 ? 'row' : 'rows');
	const sourceRows = sourceState.rows ? sourceState.rows.length : 0;
	const comparisonRows = comparisonState.rows ? comparisonState.rows.length : 0;
	const sourceCols = sourceState.columns ? sourceState.columns.length : 0;
	const comparisonCols = comparisonState.columns ? comparisonState.columns.length : 0;
	const sourceExecTime = String(sourceState.metadata?.executionTime || '');
	const comparisonExecTime = String(comparisonState.metadata?.executionTime || '');
	const sourceExecTimeHtml = escapeHtml(sourceExecTime);
	const comparisonExecTimeHtml = escapeHtml(comparisonExecTime);
	const parseExecTime = (timeStr: any) => {
		if (!timeStr) return null;
		const match = timeStr.match(/([\d.]+)\s*(ms|s)/);
		if (!match) return null;
		const value = parseFloat(match[1]);
		const unit = match[2];
		return unit === 's' ? value * 1000 : value;
	};
	const sourceMs = parseExecTime(sourceExecTime);
	const comparisonMs = parseExecTime(comparisonExecTime);
	let perfMessage = '';
	if (sourceMs !== null && comparisonMs !== null && sourceMs > 0) {
		const diff = sourceMs - comparisonMs;
		const percentChange = ((diff / sourceMs) * 100).toFixed(1);
		if (diff > 0) perfMessage = `<span style="color: #89d185;">\u2713 ${percentChange}% faster (${sourceExecTimeHtml} \u2192 ${comparisonExecTimeHtml})</span>`;
		else if (diff < 0) perfMessage = `<span style="color: #f48771;">\u26a0 ${Math.abs(Number(percentChange))}% slower (${sourceExecTimeHtml} \u2192 ${comparisonExecTimeHtml})</span>`;
		else perfMessage = `<span style="color: #cccccc;">\u2248 Same performance (${sourceExecTimeHtml})</span>`;
	} else if (sourceExecTime && comparisonExecTime) {
		perfMessage = `<span style="color: #cccccc;">${sourceExecTimeHtml} \u2192 ${comparisonExecTimeHtml}</span>`;
	}

	const sourceStats = sourceState.metadata?.serverStats && typeof sourceState.metadata.serverStats === 'object'
		? sourceState.metadata.serverStats as Record<string, any>
		: null;
	const comparisonStats = comparisonState.metadata?.serverStats && typeof comparisonState.metadata.serverStats === 'object'
		? comparisonState.metadata.serverStats as Record<string, any>
		: null;
	const formatDelta = (sourceVal: any, comparisonVal: any, opts: any) => {
		const emoji = opts.emoji || '';
		const label = opts.label || '';
		const fmt = opts.formatter || ((v: any) => String(v));
		const lowerIsBetter = opts.lowerIsBetter !== false;
		// eslint-disable-next-line eqeqeq
		if (sourceVal == null || comparisonVal == null || !isFinite(sourceVal) || !isFinite(comparisonVal)) return null;
		const sFormatted = fmt(sourceVal);
		const cFormatted = fmt(comparisonVal);
		if (sourceVal === 0 && comparisonVal === 0) return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		const diff = sourceVal - comparisonVal;
		if (diff === 0) return `<div class="comparison-metric">${emoji} ${label}: <span style="color: #cccccc;">${sFormatted} \u2192 ${cFormatted} (no change)</span></div>`;
		const base = sourceVal !== 0 ? sourceVal : 1;
		const pct = Math.abs((diff / base) * 100).toFixed(1);
		const improved = lowerIsBetter ? (diff > 0) : (diff < 0);
		const verb = lowerIsBetter ? (improved ? 'less' : 'more') : (improved ? 'more' : 'less');
		const color = improved ? '#89d185' : '#f48771';
		const icon = improved ? '\u2713' : '\u26a0';
		return `<div class="comparison-metric">${emoji} ${label}: <span style="color: ${color};">${icon} ${pct}% ${verb} (${sFormatted} \u2192 ${cFormatted})</span></div>`;
	};
	const fmtCpuMs = (ms: any) => ms < 1000 ? ms.toFixed(1) + 'ms' : (ms / 1000).toFixed(3) + 's';
	const fmtBytes = (bytes: any) => {
		// eslint-disable-next-line eqeqeq
		if (bytes == null || !isFinite(bytes)) return '?';
		if (bytes < 1024) return bytes + ' B';
		if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
		if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
		return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
	};
	const fmtNum = (n: any) => {
		// eslint-disable-next-line eqeqeq
		if (n == null) return '?';
		return Number(n).toLocaleString();
	};
	let cpuMessage = null;
	let memoryMessage = null;
	let extentsMessage = null;
	let cacheMessage = null;
	if (sourceStats && comparisonStats) {
		cpuMessage = formatDelta(sourceStats.cpuTimeMs, comparisonStats.cpuTimeMs, { emoji: '\u2699\uFE0F', label: 'Server CPU', formatter: fmtCpuMs, lowerIsBetter: true });
		memoryMessage = formatDelta(sourceStats.peakMemoryPerNode, comparisonStats.peakMemoryPerNode, { emoji: '\uD83E\uDDE0', label: 'Peak memory', formatter: fmtBytes, lowerIsBetter: true });
		extentsMessage = formatDelta(sourceStats.extentsScanned, comparisonStats.extentsScanned, { emoji: '\uD83D\uDD0D', label: 'Extents scanned', formatter: fmtNum, lowerIsBetter: true });
		const cacheRate = (stats: any) => {
			const mh = typeof stats.memoryCacheHits === 'number' ? stats.memoryCacheHits : 0;
			const mm = typeof stats.memoryCacheMisses === 'number' ? stats.memoryCacheMisses : 0;
			const dh = typeof stats.diskCacheHits === 'number' ? stats.diskCacheHits : 0;
			const dm = typeof stats.diskCacheMisses === 'number' ? stats.diskCacheMisses : 0;
			const hits = mh + dh;
			const total = hits + mm + dm;
			return total > 0 ? (hits / total) * 100 : null;
		};
		const sourceRate = cacheRate(sourceStats);
		const comparisonRate = cacheRate(comparisonStats);
		const fmtRate = (r: any) => r.toFixed(1) + '%';
		cacheMessage = formatDelta(sourceRate, comparisonRate, { emoji: '\uD83C\uDFAF', label: 'Cache hit rate', formatter: fmtRate, lowerIsBetter: false });
	}
	const columnHeaderNamesMatch = __kustoDoColumnHeaderNamesMatch(sourceState, comparisonState);
	let rowsMatch = false;
	let commonCount = 0;
	let onlyACount = 0;
	let onlyBCount = 0;
	let countsLabel = '';
	try {
		const dv = (_win && _win.__kustoDiffView) ? _win.__kustoDiffView : null;
		if (dv && typeof dv.buildModelFromResultsStates === 'function') {
			const model = dv.buildModelFromResultsStates(sourceState as any, comparisonState as any, { aLabel: sourceLabel, bLabel: comparisonLabel });
			const p = (model && model.partitions && typeof model.partitions === 'object') ? model.partitions : null;
			commonCount = Array.isArray(p && p.common) ? p.common.length : 0;
			onlyACount = Array.isArray(p && p.onlyA) ? p.onlyA.length : 0;
			onlyBCount = Array.isArray(p && p.onlyB) ? p.onlyB.length : 0;
			countsLabel =
				' (' + String(commonCount) + ' matching ' + pluralRows(commonCount) +
				', ' + String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + escapeHtml(sourceLabel) +
				', ' + String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + escapeHtml(comparisonLabel) + ')';
			rowsMatch = (onlyACount === 0 && onlyBCount === 0);
		}
	} catch (e) { console.error('[kusto]', e); }
	const dataMatches = columnHeaderNamesMatch && rowsMatch;
	const rowOrderMatches = __kustoDoRowOrderMatch(sourceState, comparisonState);
	const columnOrderMatches = __kustoDoColumnOrderMatch(sourceState, comparisonState);
	const warningNeeded = dataMatches && !(rowOrderMatches && columnOrderMatches);
	const yesNo = (v: any) => (v ? 'yes' : 'no');
	const warningTitle = 'Order of rows matches: ' + yesNo(rowOrderMatches) + '\nOrder of columns matches: ' + yesNo(columnOrderMatches) + '\nNames of column headers match: ' + yesNo(columnHeaderNamesMatch);
	let dataMessage = '';
	let diffOpenArgs: { aBoxId: string; bBoxId: string; aArtifactId: string; bArtifactId: string } | null = null;
	if (dataMatches) {
		dataMessage = '<span class="comparison-data-match">\u2713 Data matches</span>' +
			(warningNeeded ? '<span class="comparison-warning-icon" title="' + warningTitle.replace(/"/g, '&quot;') + '">\u26a0</span>' : '');
	} else {
		const columnDiff = __kustoGetColumnDifferences(sourceState, comparisonState);
		const hasColumnDiff = columnDiff.onlyInA.length > 0 || columnDiff.onlyInB.length > 0;
		const hasRowDiff = onlyACount > 0 || onlyBCount > 0;
		let diffLabel = '';
		let diffTitle = 'View diff';
		if (hasColumnDiff && !hasRowDiff) {
			const parts: string[] = [];
			if (columnDiff.onlyInA.length > 0) parts.push(String(columnDiff.onlyInA.length) + ' missing ' + (columnDiff.onlyInA.length === 1 ? 'column' : 'columns') + ' in ' + escapeHtml(comparisonLabel));
			if (columnDiff.onlyInB.length > 0) parts.push(String(columnDiff.onlyInB.length) + ' extra ' + (columnDiff.onlyInB.length === 1 ? 'column' : 'columns') + ' in ' + escapeHtml(comparisonLabel));
			diffLabel = ' (' + parts.join(', ') + ')';
			const titleParts = ['View diff'];
			if (columnDiff.onlyInA.length > 0) titleParts.push('Missing in ' + comparisonLabel + ': ' + columnDiff.onlyInA.join(', '));
			if (columnDiff.onlyInB.length > 0) titleParts.push('Extra in ' + comparisonLabel + ': ' + columnDiff.onlyInB.join(', '));
			diffTitle = titleParts.join('\n');
		} else if (hasRowDiff && !hasColumnDiff) {
			diffLabel = ' (' + String(commonCount) + ' matching ' + pluralRows(commonCount) + ', ' + String(onlyACount) + ' unmatched ' + pluralRows(onlyACount) + ' in ' + escapeHtml(sourceLabel) + ', ' + String(onlyBCount) + ' unmatched ' + pluralRows(onlyBCount) + ' in ' + escapeHtml(comparisonLabel) + ')';
			diffTitle = 'View diff\nUnmatched rows: ' + String(onlyACount) + ' in ' + sourceLabel + ', ' + String(onlyBCount) + ' in ' + comparisonLabel;
		} else if (hasColumnDiff && hasRowDiff) {
			const colParts: string[] = [];
			if (columnDiff.onlyInA.length > 0) colParts.push(String(columnDiff.onlyInA.length) + ' missing');
			if (columnDiff.onlyInB.length > 0) colParts.push(String(columnDiff.onlyInB.length) + ' extra');
			diffLabel = ' (' + colParts.join('/') + ' columns, ' + String(onlyACount + onlyBCount) + ' unmatched ' + pluralRows(onlyACount + onlyBCount) + ')';
			diffTitle = 'View diff\nColumn differences and row differences detected.';
		}
		diffOpenArgs = {
			aBoxId: String(sourceBoxId || ''),
			bBoxId: String(comparisonBoxId || ''),
			aArtifactId: String(exactSourceArtifact.artifactId || ''),
			bArtifactId: String(comparisonArtifact.artifactId || ''),
		};
		dataMessage =
			'<span class="comparison-data-diff-icon" aria-hidden="true">\u26a0</span> ' +
			'<a href="#" class="comparison-data-diff comparison-diff-link" ' +
			'title="' + escapeHtml(diffTitle) + '">Data differs' + diffLabel + '</a>';
	}
	const comparisonBox = document.getElementById(comparisonBoxId) as HTMLElement | null;
	if (!comparisonBox) return;
	let banner = comparisonBox.querySelector<HTMLElement>('.comparison-summary-banner');
	if (!banner) {
		banner = document.createElement('div');
		banner.className = 'comparison-summary-banner';
		const editorWrapper = comparisonBox.querySelector('.query-editor-wrapper');
		if (editorWrapper && editorWrapper.parentNode) editorWrapper.parentNode.insertBefore(banner, editorWrapper);
	}
	banner.innerHTML = `
		<div class="comparison-summary-content">
			<strong>How do the two queries compare?</strong>
			<div class="comparison-metrics">
				<div class="comparison-metric">\u26a1 Execution speed: ${perfMessage}</div>
				${cpuMessage || ''}
				${memoryMessage || ''}
				${extentsMessage || ''}
				${cacheMessage || ''}
				<div class="comparison-metric">\ud83d\udccb Data returned: ${dataMessage}</div>
			</div>
		</div>
	`;
	const diffLink = banner.querySelector<HTMLAnchorElement>('.comparison-diff-link');
	if (diffLink && diffOpenArgs) {
		const exactArgs = diffOpenArgs;
		diffLink.addEventListener('click', (event: MouseEvent) => {
			event.preventDefault();
			try { _win.openDiffViewModal?.(exactArgs); } catch (e) { console.error('[kusto]', e); }
		});
	}
	try {
		const acceptTooltip = dataMatches
			? (warningNeeded ? 'Data matches, but row/column ordering or header details differ. Accept optimizations with caution.' : 'Results match. Accept optimizations.')
			: 'Results differ. Accept optimizations is enabled — review the diff before accepting.';
		__kustoUpdateAcceptOptimizationsButton(comparisonBoxId, true, acceptTooltip);
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoApplyComparisonSummaryVisibility(comparisonBoxId); } catch (e) { console.error('[kusto]', e); }
}

// ── Optimize prompt flow ──────────────────────────────────────────────────────

function __kustoShowOptimizePromptLoading(boxId: any) {
	const host = document.getElementById(boxId + '_optimize_config') as any;
	if (!host) return;
	host.style.display = 'block';
	host.innerHTML =
		'<div class="optimize-config-inner">' +
		'<div class="optimize-config-loading">Loading optimization options…</div>' +
		'<div class="optimize-config-actions">' +
		'<button type="button" class="optimize-config-cancel-btn" onclick="__kustoCancelOptimizeQuery(\'' + boxId + '\')">Cancel</button>' +
		'</div>' +
		'</div>';
}

export function prepareKustoOptimizeQuery(boxIdValue: unknown): boolean {
	const boxId = String(boxIdValue || '').trim();
	const editor = queryEditors[boxId];
	const query = String(editor?.getValue?.() || '').trim();
	const connectionId = String(__kustoGetConnectionId(boxId) || '').trim();
	const database = String(__kustoGetDatabase(boxId) || '').trim();
	const section = __kustoGetQuerySectionElement(boxId);
	if (!boxId || !query || !connectionId || !database || !section) {
		try { postMessageToHost({ type: 'showInfo', message: !query ? 'No query to optimize' : 'Select a cluster and database before optimizing.' }); } catch (e) { console.error('[kusto]', e); }
		return false;
	}
	const owner = section.beginKustoOptimizeRequest?.();
	if (!owner) return false;
	const pending = __kustoEnsureOptimizePrepByBoxId();
	pending[boxId] = {
		query,
		connectionId,
		database,
		queryName: __kustoGetSectionName(boxId),
		owner,
	};
	__kustoShowOptimizePromptLoading(boxId);
	postMessageToHost({ type: 'prepareOptimizeQuery', query, ...owner });
	return true;
}

function __kustoRunOptimizeQueryWithOverrides(boxId: any) {
	const pending = __kustoEnsureOptimizePrepByBoxId();
	const req = pending[boxId];
	if (!req) {
		try { postMessageToHost({ type: 'showInfo', message: 'Optimization request is no longer available. Please try again.' }); } catch (e) { console.error('[kusto]', e); }
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}
	try {
		let sourceName = __kustoGetSectionName(boxId);
		if (!sourceName) {
			sourceName = __kustoPickNextAvailableSectionLetterName(boxId);
			__kustoSetSectionName(boxId, sourceName);
			try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
		}
		if (sourceName) req.queryName = sourceName;
	} catch (e) { console.error('[kusto]', e); }
	const modelId = (document.getElementById(boxId + '_optimize_model') as any || {}).value || '';
	const promptText = (document.getElementById(boxId + '_optimize_prompt') as any || {}).value || '';
	const section = __kustoGetQuerySectionElement(boxId);
	const owner = req.owner;
	if (!owner || section?.admitKustoOptimizeMessage?.(owner) !== true) {
		try { postMessageToHost({ type: 'showInfo', message: 'The query target changed. Try optimization again.' }); } catch (e) { console.error('[kusto]', e); }
		__kustoHideOptimizePromptForBox(boxId);
		return;
	}
	try { __kustoSetLastOptimizeModelId(modelId); } catch (e) { console.error('[kusto]', e); }
	try {
		const host = document.getElementById(boxId + '_optimize_config') as any;
		if (host) { host.style.display = 'none'; host.innerHTML = ''; }
	} catch (e) { console.error('[kusto]', e); }
	const optimizeBtn = document.getElementById(boxId + '_optimize_btn') as any;
	if (optimizeBtn) {
		optimizeBtn.disabled = true;
		const originalContent = optimizeBtn.innerHTML;
		optimizeBtn.dataset.originalContent = originalContent;
	}
	try { __kustoSetOptimizeInProgress(boxId, true, 'Starting optimization…'); } catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({
			type: 'optimizeQuery',
			query: String(req.query || ''),
			connectionId: String(req.connectionId || ''),
			database: String(req.database || ''),
			boxId,
			queryName: String(req.queryName || ''),
			modelId: String(modelId || ''),
			promptText: String(promptText || ''),
			...owner,
		});
		delete pending[boxId];
	} catch (err: any) {
		console.error('Error sending optimization request:', err);
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to start query optimization' }); } catch (e) { console.error('[kusto]', e); }
		if (optimizeBtn) {
			if (optimizeBtn.dataset.originalContent) { optimizeBtn.innerHTML = optimizeBtn.dataset.originalContent; delete optimizeBtn.dataset.originalContent; }
		}
		__kustoHideOptimizePromptForBox(boxId);
	}
}

function __kustoCancelOptimizeQuery(boxId: any) {
	try {
		__kustoUpdateOptimizeStatus(boxId, 'Canceling…');
		const cancelBtn = document.getElementById(boxId + '_optimize_cancel') as any;
		if (cancelBtn) cancelBtn.disabled = true;
	} catch (e) { console.error('[kusto]', e); }
	try { __kustoGetQuerySectionElement(boxId)?.retireKustoOptimizeRequest?.(); } catch (e) { console.error('[kusto]', e); }
}

// ── optimizeQueryWithCopilot — cross-box, creates/reuses comparison sections ──

export async function optimizeQueryWithCopilot(boxId: any, comparisonQueryOverride: any, options?: any) {
	const editor = queryEditors[boxId];
	if (!editor) return '';
	const model = editor.getModel();
	if (!model) return '';
	const shouldExecute = !(options && options.skipExecute === true);
	const shouldMarkAgentTouched = !!(options && options.agentTouched === true);
	const sourceBeforeSignature = shouldMarkAgentTouched ? _win.__kustoGetSectionSerializedSignature?.(boxId) : undefined;
	const isManualCompareOnly = !shouldExecute;
	if (isManualCompareOnly) {
		try { __kustoHideOptimizePromptForBox(boxId); } catch (e) { console.error('[kusto]', e); }
		try { __kustoSetOptimizeInProgress(boxId, false, ''); } catch (e) { console.error('[kusto]', e); }
	}
	try { __kustoSetResultsVisible(boxId, false); } catch (e) { console.error('[kusto]', e); }
	const query = model.getValue() || '';
	if (!query.trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'No query to compare' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	const overrideText = (typeof comparisonQueryOverride === 'string') ? String(comparisonQueryOverride || '') : '';
	// eslint-disable-next-line eqeqeq
	if (comparisonQueryOverride != null && !overrideText.trim()) {
		try { postMessageToHost({ type: 'showInfo', message: 'No comparison query provided' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	// eslint-disable-next-line eqeqeq
	const isCompareButtonScenario = isManualCompareOnly && (comparisonQueryOverride == null);
	// eslint-disable-next-line eqeqeq
	const isOptimizeScenario = ((comparisonQueryOverride != null) && !!overrideText.trim()) || isCompareButtonScenario;
	let sourceNameForOptimize = '';
	let desiredOptimizedName = '';
	if (isOptimizeScenario) {
		try {
			sourceNameForOptimize = __kustoGetSectionName(boxId);
			const hadExistingName = !!sourceNameForOptimize;
			if (!sourceNameForOptimize) {
				sourceNameForOptimize = __kustoPickNextAvailableSectionLetterName(boxId);
				__kustoSetSectionName(boxId, sourceNameForOptimize);
				try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
			}
			if (hadExistingName && sourceNameForOptimize) desiredOptimizedName = sourceNameForOptimize + ' (optimized)';
		} catch (e) { console.error('[kusto]', e); }
	}
	const connectionId = __kustoGetConnectionId(boxId);
	const database = __kustoGetDatabase(boxId);
	if (!connectionId) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	if (!database) {
		try { postMessageToHost({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	// Reuse existing comparison box if present.
	try {
		const existingComparisonBoxId = (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId && optimizationMetadataByBoxId[boxId])
			? optimizationMetadataByBoxId[boxId].comparisonBoxId : '';
		if (existingComparisonBoxId) {
			const comparisonBoxEl = document.getElementById(existingComparisonBoxId) as any;
			const comparisonEditor = queryEditors && queryEditors[existingComparisonBoxId];
			if (comparisonBoxEl && comparisonEditor && typeof comparisonEditor.setValue === 'function') {
				const sourceElement = document.getElementById(String(boxId || ''));
				const sqlDerivedComparison = String(sourceElement?.tagName || '').toLowerCase() === 'kw-sql-section';
				if (!sqlDerivedComparison && !synchronizeKustoSectionTarget(boxId, existingComparisonBoxId)) {
					try { postMessageToHost({ type: 'showInfo', message: 'Comparison target is still updating. Try again in a moment.' }); } catch (e) { console.error('[kusto]', e); }
					return '';
				}
				const beforeSignature = _win.__kustoGetSectionSerializedSignature?.(existingComparisonBoxId);
				let nextComparisonQuery = overrideText.trim() ? overrideText : query;
				try { if (typeof _win.__kustoPrettifyKustoText === 'function') nextComparisonQuery = _win.__kustoPrettifyKustoText(nextComparisonQuery); } catch (e) { console.error('[kusto]', e); }
				const previousComparisonQuery = String(comparisonEditor.getValue?.() || '');
				if (previousComparisonQuery !== nextComparisonQuery) {
					try { __kustoClearStoredQueryResult(existingComparisonBoxId); } catch (e) { console.error('[kusto]', e); }
					try { retireResultsStateForRerun(existingComparisonBoxId); } catch (e) { console.error('[kusto]', e); }
					try { comparisonBoxEl.clearResults?.(); } catch (e) { console.error('[kusto]', e); }
				}
				try { comparisonEditor.setValue(nextComparisonQuery); } catch (e) { console.error('[kusto]', e); }
				try {
					if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
						optimizationMetadataByBoxId[existingComparisonBoxId] = optimizationMetadataByBoxId[existingComparisonBoxId] || {};
						optimizationMetadataByBoxId[existingComparisonBoxId].sourceBoxId = boxId;
						optimizationMetadataByBoxId[existingComparisonBoxId].isComparison = true;
						optimizationMetadataByBoxId[existingComparisonBoxId].originalQuery = queryEditors[boxId] ? queryEditors[boxId].getValue() : query;
						optimizationMetadataByBoxId[existingComparisonBoxId].optimizedQuery = nextComparisonQuery;
						optimizationMetadataByBoxId[boxId] = optimizationMetadataByBoxId[boxId] || {};
						optimizationMetadataByBoxId[boxId].comparisonBoxId = existingComparisonBoxId;
					}
				} catch (e) { console.error('[kusto]', e); }
				try { if (typeof __kustoSetLinkedOptimizationMode === 'function') __kustoSetLinkedOptimizationMode(boxId, existingComparisonBoxId, true); } catch (e) { console.error('[kusto]', e); }
				try {
					if (desiredOptimizedName) {
						__kustoSetSectionName(existingComparisonBoxId, desiredOptimizedName);
						try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
					} else {
						const currentName = __kustoGetSectionName(existingComparisonBoxId);
						let shouldReplace = !currentName;
						if (!shouldReplace) {
							const upper = currentName.toUpperCase();
							if (upper.endsWith(' (COMPARISON)') || upper.endsWith(' (OPTIMIZED)')) shouldReplace = true;
						}
						if (shouldReplace) {
							__kustoSetSectionName(existingComparisonBoxId, __kustoPickNextAvailableSectionLetterName(existingComparisonBoxId));
							try { schedulePersist(); } catch (e) { console.error('[kusto]', e); }
						}
					}
				} catch (e) { console.error('[kusto]', e); }
				try {
					__kustoSetResultsVisible(boxId, false);
					__kustoSetResultsVisible(existingComparisonBoxId, false);
				} catch (e) { console.error('[kusto]', e); }
				if (shouldMarkAgentTouched) {
					_win.__kustoMarkSectionAgentTouched?.(boxId, sourceBeforeSignature);
					_win.__kustoMarkSectionAgentTouched?.(existingComparisonBoxId, beforeSignature);
				}
				if (shouldExecute) {
					try {
						await executeKustoComparisonPair(String(boxId), String(existingComparisonBoxId));
					} catch (e) { console.error('[kusto]', e); }
				}
				return existingComparisonBoxId;
			}
			try {
				unbindResultArtifactConsumer(comparisonSourceArtifactConsumerId(existingComparisonBoxId));
				if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
					delete optimizationMetadataByBoxId[boxId];
					delete optimizationMetadataByBoxId[existingComparisonBoxId];
				}
			} catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
	let queryName = sourceNameForOptimize || __kustoGetSectionName(boxId);
	let comparisonQuery = overrideText.trim() ? overrideText : query;
	try { if (typeof _win.__kustoPrettifyKustoText === 'function') comparisonQuery = _win.__kustoPrettifyKustoText(comparisonQuery); } catch (e) { console.error('[kusto]', e); }
	let comparisonBoxId = '';
	try {
		const creation = createSectionWithCapabilities('query', {
			id: 'query_cmp_' + Date.now(), initialQuery: comparisonQuery, isComparison: true,
			comparisonSourceBoxId: boxId, defaultResultsVisible: false,
		});
		if (!creation.ok) throw new Error(creation.error);
		comparisonBoxId = creation.sectionId;
	} catch (err: any) {
		console.error('Error creating comparison box:', err);
		try { postMessageToHost({ type: 'showInfo', message: 'Failed to create comparison section' }); } catch (e) { console.error('[kusto]', e); }
		return '';
	}
	try { __kustoSetResultsVisible(boxId, false); __kustoSetResultsVisible(comparisonBoxId, false); } catch (e) { console.error('[kusto]', e); }
	try { __kustoSetLinkedOptimizationMode(boxId, comparisonBoxId, true); } catch (e) { console.error('[kusto]', e); }
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			optimizationMetadataByBoxId[comparisonBoxId] = { sourceBoxId: boxId, isComparison: true, originalQuery: queryEditors[boxId] ? queryEditors[boxId].getValue() : query, optimizedQuery: comparisonQuery };
			optimizationMetadataByBoxId[boxId] = { comparisonBoxId };
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		const sourceBox = document.getElementById(boxId) as any;
		const comparisonBox = document.getElementById(comparisonBoxId) as any;
		if (sourceBox && comparisonBox && sourceBox.parentNode) sourceBox.parentNode.insertBefore(comparisonBox, sourceBox.nextSibling);
	} catch (e) { console.error('[kusto]', e); }
	try {
		const compKwEl = __kustoGetQuerySectionElement(comparisonBoxId);
		if (compKwEl) {
			if (typeof compKwEl.setConnectionId === 'function') compKwEl.setConnectionId(connectionId);
			if (typeof compKwEl.setDesiredDatabase === 'function') compKwEl.setDesiredDatabase(database);
			compKwEl.dispatchEvent(new CustomEvent('connection-changed', { detail: { boxId: comparisonBoxId, connectionId }, bubbles: true, composed: true }));
			if (typeof compKwEl.setDatabase === 'function') compKwEl.setDatabase(database);
			if (typeof compKwEl.setSchemaLifecycleTarget === 'function') compKwEl.setSchemaLifecycleTarget(connectionId, database);
			// Carry over favorites mode from source section.
			const srcKwEl = __kustoGetQuerySectionElement(boxId);
			if (srcKwEl && typeof srcKwEl.isFavoritesMode === 'function' && srcKwEl.isFavoritesMode()) {
				if (typeof compKwEl.setFavoritesMode === 'function') compKwEl.setFavoritesMode(true);
				if (typeof favoritesModeByBoxId === 'object') favoritesModeByBoxId[comparisonBoxId] = true;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (desiredOptimizedName) __kustoSetSectionName(comparisonBoxId, desiredOptimizedName);
		else {
			const existing = __kustoGetSectionName(comparisonBoxId);
			if (!existing) __kustoSetSectionName(comparisonBoxId, __kustoPickNextAvailableSectionLetterName(comparisonBoxId));
		}
	} catch (e) { console.error('[kusto]', e); }
	if (shouldMarkAgentTouched) {
		_win.__kustoMarkSectionAgentTouched?.(boxId, sourceBeforeSignature);
		_win.__kustoMarkSectionAgentTouched?.(comparisonBoxId);
	}
	if (shouldExecute) {
		try {
			await executeKustoComparisonPair(String(boxId), String(comparisonBoxId));
		} catch (e) { console.error('[kusto]', e); }
	}
	return comparisonBoxId;
}

// ── executeQuery — cross-box (comparison rerun logic), standalone ──────────────

function createKustoExecutionId(): string {
	return `kusto-run-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`;
}

const ADMITTED_KUSTO_TERMINAL_EVENT = 'kusto-workbench-query-terminal';

export async function executeKustoComparisonPair(sourceBoxId: string, comparisonBoxId: string): Promise<boolean> {
	let sourceExecutionId = '';
	const sourceSucceeded = new Promise<boolean>(resolve => {
		const terminalHandler = (event: Event) => {
			const terminal = (event as CustomEvent).detail;
			if (!sourceExecutionId || terminal?.boxId !== sourceBoxId || terminal?.executionId !== sourceExecutionId) return;
			window.removeEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, terminalHandler as EventListener);
			resolve(terminal.type === 'queryResult');
		};
		window.addEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, terminalHandler as EventListener);
		sourceExecutionId = executeQuery(sourceBoxId, undefined, 'comparison', {
			role: 'source', comparisonBoxId,
		}) || '';
		if (!sourceExecutionId) {
			window.removeEventListener(ADMITTED_KUSTO_TERMINAL_EVENT, terminalHandler as EventListener);
			resolve(false);
		}
	});
	if (!await sourceSucceeded) return false;
	const comparisonExecutionId = executeQuery(comparisonBoxId, undefined, 'comparison', {
		role: 'comparison',
		comparisonRun: { sourceBoxId, sourceExecutionId, comparisonBoxId },
	});
	if (!comparisonExecutionId) {
		unbindResultArtifactConsumer(comparisonSourceArtifactConsumerId(comparisonBoxId));
		return false;
	}
	return true;
}

export function executeQuery(
	boxId: any,
	mode?: any,
	producer: KustoExecutionProducer = 'manual',
	comparisonOptions?: ComparisonExecutionOptions,
): string | undefined {
	const effectiveMode = mode || getRunMode(boxId);
	// Run Function mode — divert to the dedicated async handler.
	if (effectiveMode === 'runFunction') {
		executeRunFunction(String(boxId || '').trim());
		return undefined;
	}
	try { if (typeof _win.__kustoClearAutoFindInQueryEditor === 'function') _win.__kustoClearAutoFindInQueryEditor(boxId); } catch (e) { console.error('[kusto]', e); }
	const __kustoExtractStatementAtCursor = (editor: any) => {
		try { if (typeof _win.__kustoExtractStatementTextAtCursor === 'function') return _win.__kustoExtractStatementTextAtCursor(editor); } catch (e) { console.error('[kusto]', e); }
		try {
			if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') return null;
			const model = editor.getModel();
			const pos = editor.getPosition();
			if (!model || !pos || typeof model.getLineCount !== 'function') return null;
			const cursorLine = pos.lineNumber;
			if (typeof cursorLine !== 'number' || !isFinite(cursorLine) || cursorLine < 1) return null;
			const lineCount = model.getLineCount();
			if (!lineCount || cursorLine > lineCount) return null;
			const blocks: { startLine: number; endLine: number }[] = [];
			let inBlock = false;
			let startLine = 1;
			let inTripleBacktick = false;
			for (let ln = 1; ln <= lineCount; ln++) {
				let lineText = '';
				try { lineText = model.getLineContent(ln); } catch { lineText = ''; }
				let tripleCount = 0;
				for (let ci = 0; ci < lineText.length - 2; ci++) {
					if (lineText[ci] === '`' && lineText[ci + 1] === '`' && lineText[ci + 2] === '`') { tripleCount++; ci += 2; }
				}
				if (tripleCount % 2 === 1) inTripleBacktick = !inTripleBacktick;
				if (inTripleBacktick) { if (!inBlock) { startLine = ln; inBlock = true; } continue; }
				const isBlank = !String(lineText || '').trim();
				if (isBlank) { if (inBlock) { blocks.push({ startLine, endLine: ln - 1 }); inBlock = false; } continue; }
				if (!inBlock) { startLine = ln; inBlock = true; }
			}
			if (inBlock) blocks.push({ startLine, endLine: lineCount });
			const block = blocks.find((b: any) => cursorLine >= b.startLine && cursorLine <= b.endLine);
			if (!block) return null;
			const endCol = (typeof model.getLineMaxColumn === 'function') ? model.getLineMaxColumn(block.endLine) : 1;
			const range = { startLineNumber: block.startLine, startColumn: 1, endLineNumber: block.endLine, endColumn: endCol };
			let text = '';
			try { text = (typeof model.getValueInRange === 'function') ? model.getValueInRange(range) : ''; } catch { text = ''; }
			return String(text || '').trim() || null;
		} catch { return null; }
	};
	const editor = queryEditors[boxId] ? queryEditors[boxId] : null;
	let query = editor ? editor.getValue() : '';
	let usedSelection = false;
	try {
		if (editor && typeof editor.getSelection === 'function' && typeof editor.getModel === 'function') {
			const sel = editor.getSelection();
			if (sel && !sel.isEmpty()) {
				const model = editor.getModel();
				if (model && typeof model.getValueInRange === 'function') {
					const selectedText = model.getValueInRange(sel);
					if (selectedText && selectedText.trim()) { query = selectedText; usedSelection = true; }
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (editor && !usedSelection) {
			const model = editor.getModel && editor.getModel();
			const blocks = (model && typeof _win.__kustoGetStatementBlocksFromModel === 'function') ? _win.__kustoGetStatementBlocksFromModel(model) : [];
			const hasMultipleStatements = blocks && blocks.length > 1;
			if (hasMultipleStatements) {
				const statement = __kustoExtractStatementAtCursor(editor);
				if (statement) query = statement;
				else {
					try { postMessageToHost({ type: 'showInfo', message: 'Place the cursor inside a query statement (not on a separator) to run that statement.' }); } catch (e) { console.error('[kusto]', e); }
					return undefined;
				}
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	let connectionId = __kustoGetConnectionId(boxId);
	let database = __kustoGetDatabase(boxId);
	let cacheEnabled = (document.getElementById(boxId + '_cache_enabled') as any).checked;
	const cacheValue = parseInt((document.getElementById(boxId + '_cache_value') as any).value) || 1;
	const cacheUnit = (document.getElementById(boxId + '_cache_unit') as any).value;
	let sourceBoxIdForComparison = '';
	let isComparisonBox = false;
	let isKustoComparisonBox = false;
	try {
		if (typeof optimizationMetadataByBoxId === 'object' && optimizationMetadataByBoxId) {
			const meta = optimizationMetadataByBoxId[boxId];
			if (meta && meta.isComparison && meta.sourceBoxId) {
				const sourceBoxId = meta.sourceBoxId;
				isComparisonBox = true;
				sourceBoxIdForComparison = String(sourceBoxId || '');
				isKustoComparisonBox = !__kustoGetSqlSectionElement(sourceBoxIdForComparison);
				if (!synchronizeKustoSectionTarget(sourceBoxId, boxId)) {
					try { postMessageToHost({ type: 'showInfo', message: 'Comparison target is still updating. Try again in a moment.' }); } catch (e) { console.error('[kusto]', e); }
					return undefined;
				}
				connectionId = __kustoGetConnectionId(boxId);
				database = __kustoGetDatabase(boxId);
				const srcConnId = __kustoGetConnectionId(sourceBoxId);
				const srcDb = __kustoGetDatabase(sourceBoxId);
				if (connectionId !== srcConnId || database.toLowerCase() !== srcDb.toLowerCase()) {
					try { postMessageToHost({ type: 'showInfo', message: 'Comparison target is still updating. Try again in a moment.' }); } catch (e) { console.error('[kusto]', e); }
					return undefined;
				}
			}
			const hasLinkedOptimization = !!(meta && meta.isComparison) || !!(optimizationMetadataByBoxId[boxId] && optimizationMetadataByBoxId[boxId].comparisonBoxId);
			if (hasLinkedOptimization) cacheEnabled = false;
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		if (isKustoComparisonBox && sourceBoxIdForComparison) {
			const sourceLastRunUsedCaching = !!(lastRunCacheEnabledByBoxId[sourceBoxIdForComparison]);
			if (sourceLastRunUsedCaching && !comparisonOptions) {
				try { clearResultsState(sourceBoxIdForComparison); } catch (e) { console.error('[kusto]', e); }
				try { __kustoLog(boxId, 'run.compare.rerunSourceNoCache', 'Rerunning source query with caching disabled', { sourceBoxId: sourceBoxIdForComparison }); } catch (e) { console.error('[kusto]', e); }
				void executeKustoComparisonPair(sourceBoxIdForComparison, String(boxId)).catch(e => console.error('[kusto]', e));
				return undefined;
			}
		}
	} catch (e) { console.error('[kusto]', e); }
	try {
		const pending = !!(pendingFavoriteSelectionByBoxId && pendingFavoriteSelectionByBoxId[boxId]);
		const dbEl = document.getElementById(boxId + '_database') as any;
		const desiredPending = !!(dbEl && dbEl.dataset && dbEl.dataset.desired);
		const dbDisabled = !!(dbEl && dbEl.disabled);
		if (pending || desiredPending || dbDisabled) {
			__kustoLog(boxId, 'run.blocked', 'Blocked run because selection is still updating', { pending, desiredPending, dbDisabled, connectionId, database }, 'warn');
			try { postMessageToHost({ type: 'showInfo', message: 'Waiting for the selected favorite to finish applying (loading databases/schema). Try Run again in a moment.' }); } catch (e) { console.error('[kusto]', e); }
			return undefined;
		}
	} catch (e) { console.error('[kusto]', e); }
	if (!query.trim()) return undefined;
	if (!connectionId) { try { postMessageToHost({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); } return undefined; }
	if (!database) { try { postMessageToHost({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); } return undefined; }
	__kustoLog(boxId, 'run.start', 'Executing query', { connectionId, database, queryMode: effectiveMode });
	try { delete pState.queryResultJsonByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
	try { delete pState.resultArtifactByBoxId[boxId]; } catch (e) { console.error('[kusto]', e); }
	const executionId = createKustoExecutionId();
	let effectiveProducer = producer;
	let comparisonRun: KustoComparisonRunIdentity | undefined;
	if (comparisonOptions?.role === 'source') {
		effectiveProducer = 'comparison';
		comparisonRun = {
			sourceBoxId: String(boxId),
			sourceExecutionId: executionId,
			comparisonBoxId: String(comparisonOptions.comparisonBoxId || ''),
		};
	} else if (comparisonOptions?.role === 'comparison') {
		effectiveProducer = 'comparison';
		comparisonRun = comparisonOptions.comparisonRun;
	} else if (isKustoComparisonBox && sourceBoxIdForComparison) {
		const sourceArtifact = getCurrentResultArtifact(sourceBoxIdForComparison);
		const sourceExecutionId = String(sourceArtifact?.producer?.executionId || '').trim();
		if (!sourceExecutionId) {
			try { postMessageToHost({ type: 'showInfo', message: 'Run the source query before running its comparison.' }); } catch (e) { console.error('[kusto]', e); }
			return undefined;
		}
		effectiveProducer = 'comparison';
		comparisonRun = {
			sourceBoxId: sourceBoxIdForComparison,
			sourceExecutionId,
			comparisonBoxId: String(boxId),
		};
	}
	const section = __kustoGetQuerySectionElement(String(boxId || ''));
	const lifecycle = section?.getSchemaLifecycleIdentity?.();
	const comparisonConsumerId = comparisonRun && String(boxId) === comparisonRun.comparisonBoxId
		? comparisonSourceArtifactConsumerId(comparisonRun.comparisonBoxId)
		: '';
	if (comparisonConsumerId) {
		const sourceArtifact = getResultArtifactByProducerExecution(
			comparisonRun!.sourceBoxId, comparisonRun!.sourceExecutionId,
		);
		if (!sourceArtifact || bindResultArtifactConsumer(
			comparisonConsumerId, comparisonRun!.sourceBoxId, sourceArtifact.artifactId,
		) !== sourceArtifact.artifactId) return undefined;
	}
	if (!lifecycle) {
		if (comparisonConsumerId) unbindResultArtifactConsumer(comparisonConsumerId);
		return undefined;
	}
	if (typeof section?.beginQueryExecution !== 'function'
		|| section.beginQueryExecution(executionId, effectiveProducer, undefined, undefined, comparisonRun) !== true) {
		if (comparisonConsumerId) unbindResultArtifactConsumer(comparisonConsumerId);
		return undefined;
	}
	closeRunMenu(boxId);
	try { lastRunCacheEnabledByBoxId[boxId] = !!cacheEnabled; } catch (e) { console.error('[kusto]', e); }
	pState.lastExecutedBox = boxId;
	postMessageToHost({
		type: 'executeQuery', query, queryMode: effectiveMode, connectionId, database, boxId, executionId,
		sectionInstanceId: lifecycle.sectionInstanceId, targetGeneration: lifecycle.targetGeneration,
		producer: effectiveProducer, ...(comparisonRun ? { comparisonRun } : {}), cacheEnabled, cacheValue, cacheUnit,
	});
	return executionId;
}

// ── executeQueryDirect — execute an arbitrary query string for a given box ─────

export function executeQueryDirect(boxId: string, query: string): string | undefined {
	const id = String(boxId || '').trim();
	if (!id || !query.trim()) return undefined;
	const connectionId = __kustoGetConnectionId(id);
	const database = __kustoGetDatabase(id);
	if (!connectionId) { try { postMessageToHost({ type: 'showInfo', message: 'Please select a cluster connection' }); } catch (e) { console.error('[kusto]', e); } return undefined; }
	if (!database) { try { postMessageToHost({ type: 'showInfo', message: 'Please select a database' }); } catch (e) { console.error('[kusto]', e); } return undefined; }
	__kustoLog(id, 'run.start', 'Executing inline function query', { connectionId, database, queryMode: 'plain' });
	try { delete pState.queryResultJsonByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	try { delete pState.resultArtifactByBoxId[id]; } catch (e) { console.error('[kusto]', e); }
	const executionId = createKustoExecutionId();
	const section = __kustoGetQuerySectionElement(id);
	const lifecycle = section?.getSchemaLifecycleIdentity?.();
	if (!lifecycle) return undefined;
	if (typeof section?.beginQueryExecution !== 'function'
		|| section.beginQueryExecution(executionId) !== true) return undefined;
	closeRunMenu(id);
	pState.lastExecutedBox = id;
	postMessageToHost({
		type: 'executeQuery', query, queryMode: 'plain', connectionId, database, boxId: id, executionId,
		sectionInstanceId: lifecycle.sectionInstanceId, targetGeneration: lifecycle.targetGeneration,
		producer: 'manual', cacheEnabled: false, cacheValue: 1, cacheUnit: 'h',
	});
	return executionId;
}

// ── executeRunFunction — parse function def, collect params, assemble, run ─────

const lastParamValuesByBoxId: Record<string, string[]> = {};

function showFunctionParamsDialog(functionName: string, params: FunctionParam[], boxId: string): Promise<string[] | null> {
	return new Promise(resolve => {
		const dialog = document.createElement('kw-function-params-dialog') as import('../components/kw-function-params-dialog').KwFunctionParamsDialog;
		document.body.appendChild(dialog);
		dialog.show(functionName, params, lastParamValuesByBoxId[boxId]);
		dialog.addEventListener('function-run', ((e: CustomEvent) => { resolve(e.detail.values); dialog.remove(); }) as EventListener);
		dialog.addEventListener('function-cancel', () => { resolve(null); dialog.remove(); });
	});
}

function getSelectedEditorText(editor: any): string | null {
	try {
		if (!editor || typeof editor.getSelection !== 'function' || typeof editor.getModel !== 'function') return null;
		const selection = editor.getSelection();
		if (!selection || typeof selection.isEmpty !== 'function' || selection.isEmpty()) return null;
		const model = editor.getModel();
		if (!model || typeof model.getValueInRange !== 'function') return null;
		const selected = String(model.getValueInRange(selection) || '').trim();
		return selected || null;
	} catch {
		return null;
	}
}

function getOffsetForEditorPosition(editor: any, text: string): number | null {
	try {
		if (!editor || typeof editor.getModel !== 'function' || typeof editor.getPosition !== 'function') return null;
		const model = editor.getModel();
		const position = editor.getPosition();
		if (!model || !position) return null;
		if (typeof model.getOffsetAt === 'function') {
			const rawOffset = Math.max(0, Number(model.getOffsetAt(position)) || 0);
			return normalizeKustoText(String(text || '').slice(0, rawOffset)).length;
		}
		const lineNumber = Math.max(1, Number(position.lineNumber) || 1);
		const column = Math.max(1, Number(position.column) || 1);
		const lines = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
		let offset = 0;
		for (let i = 0; i < Math.min(lineNumber - 1, lines.length); i++) offset += lines[i].length + 1;
		return offset + column - 1;
	} catch {
		return null;
	}
}

function getRunFunctionText(editor: any, fullText: string): string {
	const selectedText = getSelectedEditorText(editor);
	if (selectedText) return selectedText;

	const offset = getOffsetForEditorPosition(editor, fullText);
	if (offset !== null) {
		const normalizedText = normalizeKustoText(fullText);
		const fenced = getSingleKustoCodeFenceBodyRange(normalizedText);
		if (fenced && offset >= fenced.start && offset <= fenced.end) {
			const definition = findKustoFunctionDefinitionAtOffset(fenced.text, offset - fenced.start);
			if (definition) return fenced.text.slice(definition.start, definition.end).trim();
		} else {
			const definition = findKustoFunctionDefinitionAtOffset(normalizedText, offset);
			if (definition) return normalizedText.slice(definition.start, definition.end).trim();
		}
		if (hasKustoFunctionDefinition(fullText)) return '';
	}

	try {
		const model = editor?.getModel && editor.getModel();
		const blocks = (model && typeof _win.__kustoGetStatementBlocksFromModel === 'function')
			? _win.__kustoGetStatementBlocksFromModel(model)
			: [];
		if (blocks && blocks.length > 1 && typeof _win.__kustoExtractStatementTextAtCursor === 'function') {
			const stmt = _win.__kustoExtractStatementTextAtCursor(editor);
			if (stmt) return String(stmt).trim();
		}
	} catch (e) { console.error('[kusto]', e); }

	return fullText;
}

export async function executeRunFunction(boxId: string): Promise<void> {
	const id = boxId.trim();
	if (!id) return;
	// Guard against re-entrance while the dialog is open.
	if (functionRunDialogOpenByBoxId[id]) return;

	try { if (typeof _win.__kustoClearAutoFindInQueryEditor === 'function') _win.__kustoClearAutoFindInQueryEditor(id); } catch (e) { console.error('[kusto]', e); }

	const editor = queryEditors[id] ?? null;
	if (!editor) return;
	const fullText = editor.getValue ? String(editor.getValue() || '') : '';
	const text = getRunFunctionText(editor, fullText);

	const parsed = __kustoParseFunction(text);
	if (!parsed) {
		try { postMessageToHost({ type: 'showInfo', message: 'No function definition found in this section.' }); } catch (e) { console.error('[kusto]', e); }
		return;
	}

	const rawParams = parsed.rawParams.trim();
	// No parameters — execute immediately without dialog.
	if (!rawParams) {
		const query = `let ${parsed.name} = () {${parsed.body}};\n${parsed.name}()`;
		executeQueryDirect(id, query);
		return;
	}

	// Parse parameter list and show dialog.
	const paramList = __kustoParseParamList(rawParams);
	if (!paramList.length) {
		const query = `let ${parsed.name} = (${rawParams}) {${parsed.body}};\n${parsed.name}()`;
		executeQueryDirect(id, query);
		return;
	}

	functionRunDialogOpenByBoxId[id] = true;
	try {
		const values = await showFunctionParamsDialog(parsed.name, paramList, id);
		if (!values) return; // cancelled
		lastParamValuesByBoxId[id] = [...values];
		// Auto-wrap tabular arguments in () if user didn't already.
		const args = values.map((v, i) => {
			const isTabular = paramList[i]?.type?.startsWith('(');
			const trimmed = v.trim();
			if (isTabular && trimmed && !trimmed.startsWith('(')) return `(${trimmed})`;
			return v;
		});
		const argsStr = args.join(', ');
		const query = `let ${parsed.name} = (${rawParams}) {${parsed.body}};\n${parsed.name}(${argsStr})`;
		executeQueryDirect(id, query);
	} catch (e) {
		console.error('[kusto]', e);
	} finally {
		functionRunDialogOpenByBoxId[id] = false;
	}
}

// ── Window bridges (module-scope, assigned at load time) ──────────────────────

_win.cancelQuery = function cancelQuery(boxId: any) {
	const section = __kustoGetQuerySectionElement(String(boxId || ''));
	const owner = typeof section?.requestCancelActiveQueryExecution === 'function'
		? section.requestCancelActiveQueryExecution()
		: undefined;
	if (!owner) return;
	try {
		const cancelBtn = document.getElementById(boxId + '_cancel_btn') as any;
		if (cancelBtn) cancelBtn.disabled = true;
	} catch (e) { console.error('[kusto]', e); }
	try {
		postMessageToHost({
			type: 'cancelQuery', boxId, executionId: owner.executionId,
			sectionInstanceId: owner.sectionInstanceId,
			targetGeneration: owner.targetGeneration,
		});
	} catch (e) { console.error('[kusto]', e); }
};

_win.executeQuery = executeQuery;

_win.__kustoUpdateRunEnabledForBox = function (boxId: any) {
	const el = __kustoGetQuerySectionElement(boxId);
	if (el?.executionCtrl) { el.executionCtrl.updateRunEnabled(); return; }
};

_win.__kustoUpdateRunEnabledForAllBoxes = function () {
	try {
		for (const id of (queryBoxes || [])) {
			try { _win.__kustoUpdateRunEnabledForBox(id); } catch (e) { console.error('[kusto]', e); }
		}
	} catch (e) { console.error('[kusto]', e); }
};

_win.__kustoHideOptimizePromptForBox = __kustoHideOptimizePromptForBox;
_win.__kustoRunOptimizeQueryWithOverrides = __kustoRunOptimizeQueryWithOverrides;
_win.__kustoCancelOptimizeQuery = __kustoCancelOptimizeQuery;
_win.toggleQueryResultsVisibility = toggleQueryResultsVisibility;
_win.toggleComparisonSummaryVisibility = toggleComparisonSummaryVisibility;
