import { describe, it, expect, vi } from 'vitest';
import { KwHtmlSection } from '../../src/webview/sections/kw-html-section';
import {
	clearResultsState,
	displayResultForBox,
	getBoundResultArtifact,
	getCurrentResultArtifact,
	getResultsState,
	setResultsBatchState,
	setResultsState,
} from '../../src/webview/core/results-state';
import { createPrimaryResultArtifactIdentity, htmlDashboardFactArtifactConsumerId, toPersistedResultArtifact } from '../../src/shared/resultArtifact';
import { admitKustoPublicationHostMessage } from '../../src/shared/kustoPublicationProtocol';
import type { KwPublishPbiDialog } from '../../src/webview/components/kw-publish-pbi-dialog';
import { pState } from '../../src/webview/shared/persistence-state';

type BridgeSection = KwHtmlSection & { _buildDataBridgeScript(): string; refreshDataBridge(): void };
type ScalarBindingRuntime = { bind(bindingId: string, value: unknown): void; bindHtml(bindingId: string, html: string): void };
type HeightSection = KwHtmlSection & {
	_mode: 'code' | 'preview';
	_userResizedPreview: boolean;
	_lastPreviewContentHeight: number;
	_lastPreviewFitHeight: number;
	_lastPreviewScrollHeight: number;
	_lastPreviewViewportHeight: number;
	_lastPreviewViewportBoundHeight: number;
	_savedPreviewHeightPx?: number;
	_captureCurrentHeight(): void;
	_updatePreview(): void;
	_applyPreviewFitHeight(contentH: number): void;
	_resetAutoPreviewHeightForFreshFit(): void;
	_measurePreviewHeight(): number | undefined;
	_getPowerBiMeasurementWidth(): number;
	_requestFreshPreviewHeight(): Promise<number | undefined>;
	_measureCurrentHtmlHeight(code: string): Promise<number | undefined>;
	_retireDashboardWorkflows(): void;
	_handleIframeMessage(e: MessageEvent): void;
	_collectDataSourcesForPBI(): Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>;
	_openPublishDialog(
		htmlCode: string,
		dataSources: Array<{ name: string; sectionId: string; clusterUrl: string; database: string; query: string; columns: Array<{ name: string; type: string }> }>,
		previewHeight: number | undefined,
		suggestedName: string,
	): void;
	_publishToPowerBI(): Promise<void>;
};

function makeProvenanceHtml(dimensions: object[]): string {
	return `<script type="application/kw-provenance">${JSON.stringify({
		version: 1,
		model: {
			fact: { sectionId: 'query_slicer_fact', sectionName: 'Fact Events' },
			dimensions,
		},
		bindings: {},
	})}</script><main>Dashboard content</main>`;
}

function makeFactHtml(sectionId: string, resultIndex?: number): string {
	return `<script type="application/kw-provenance">${JSON.stringify({
		version: 1,
		model: { fact: { sectionId, sectionName: 'Fact Events', ...(resultIndex === undefined ? {} : { resultIndex }) } },
		bindings: {},
	})}</script><main>Dashboard content</main>`;
}

// ── _toDateStr — same logic as the inline slicer JS in kw-html-section.ts ────
// Extracts YYYY-MM-DD from any date-like string. This is used by the between-mode
// slicer to normalize cell values before comparing with <input type="date"> values.
function _toDateStr(val: unknown): string {
	const s = String(val || '');
	if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
	const d = new Date(s);
	if (isNaN(d.getTime())) return '';
	const y = d.getFullYear(), m = d.getMonth() + 1, dy = d.getDate();
	return y + '-' + (m < 10 ? '0' : '') + m + '-' + (dy < 10 ? '0' : '') + dy;
}

// ── Slicer filter logic (mirrors the inline applyFilters in _buildSlicerBlock) ─
function slicerBetweenFilter(
	cellValues: unknown[],
	minV: string,
	maxV: string,
): unknown[] {
	return cellValues.filter(cell => {
		const v = _toDateStr(cell);
		if (minV && v < minV) return false;
		if (maxV && v > maxV) return false;
		return true;
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('_toDateStr — slicer date normalization', () => {
	it('handles Date.toString() verbose format', () => {
		// This is the format stored in cell.full by formatCellValue
		const verbose = new Date('2024-06-15T12:00:00Z').toString();
		const result = _toDateStr(verbose);
		// Should produce YYYY-MM-DD in local time (same day as displayed by toString)
		expect(result).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		// Verify it matches the local date from the same Date object
		const d = new Date('2024-06-15T12:00:00Z');
		const expected = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
		expect(result).toBe(expected);
	});

	it('handles ISO date strings (YYYY-MM-DDT...)', () => {
		expect(_toDateStr('2024-01-15T10:30:00Z')).toBe('2024-01-15');
		expect(_toDateStr('2024-12-31T23:59:59.999Z')).toBe('2024-12-31');
	});

	it('handles display format (YYYY-MM-DD HH:MM:SS)', () => {
		expect(_toDateStr('2024-01-15 10:30:00')).toBe('2024-01-15');
	});

	it('handles plain date (YYYY-MM-DD)', () => {
		expect(_toDateStr('2024-01-15')).toBe('2024-01-15');
	});

	it('returns empty string for non-date values', () => {
		expect(_toDateStr('not a date')).toBe('');
		expect(_toDateStr('')).toBe('');
		expect(_toDateStr(null)).toBe('');
		expect(_toDateStr(undefined)).toBe('');
	});
});

describe('slicer between filter — date range', () => {
	// Simulate real data: cell values are Date.toString() strings
	// (as they appear after getRawCellValue extracts cell.full)
	const jan15 = new Date('2024-01-15T00:00:00Z').toString();
	const feb10 = new Date('2024-02-10T00:00:00Z').toString();
	const mar20 = new Date('2024-03-20T00:00:00Z').toString();
	const cells = [jan15, feb10, mar20];

	it('filters by min date only', () => {
		const result = slicerBetweenFilter(cells, '2024-02-01', '');
		// Only feb10 and mar20 should pass (their local date is >= 2024-02-01)
		expect(result).toHaveLength(2);
		expect(result).toContain(feb10);
		expect(result).toContain(mar20);
	});

	it('filters by max date only', () => {
		const result = slicerBetweenFilter(cells, '', '2024-02-15');
		// Only jan15 and feb10 should pass
		expect(result).toHaveLength(2);
		expect(result).toContain(jan15);
		expect(result).toContain(feb10);
	});

	it('filters by both min and max', () => {
		const result = slicerBetweenFilter(cells, '2024-02-01', '2024-02-28');
		// Only feb10 should pass
		expect(result).toHaveLength(1);
		expect(result).toContain(feb10);
	});

	it('empty range returns all rows', () => {
		const result = slicerBetweenFilter(cells, '', '');
		expect(result).toHaveLength(3);
	});

	it('works with ISO string cell values', () => {
		const isoCells = ['2024-01-15T00:00:00Z', '2024-02-10T12:00:00Z', '2024-03-20T00:00:00Z'];
		const result = slicerBetweenFilter(isoCells, '2024-02-01', '2024-02-28');
		expect(result).toHaveLength(1);
		expect(result[0]).toBe('2024-02-10T12:00:00Z');
	});
});

describe('generated slicer layout', () => {
	it('escapes dashboard body padding without requiring source changes', () => {
		setResultsState('query_slicer_fact', {
			columns: [{ name: 'Client', type: 'string' }],
			rows: [['VS Code'], ['Visual Studio']],
		}, {
			policy: { exposeToActiveContent: true },
		});

		const section = new KwHtmlSection();
		section.boxId = 'html_slicer_layout_test';
		section.setCode(makeProvenanceHtml([{ column: 'Client', label: 'Client' }]).replace(
			'<main>Dashboard content</main>',
			'<style>body { padding: 24px; }</style><main>Dashboard content</main>',
		));

		const bridgeHtml = (section as BridgeSection)._buildDataBridgeScript();
		const slicerTag = bridgeHtml.match(/<div id="kw-slicers"[^>]*>/)?.[0] || '';

		expect(bridgeHtml).toContain('<style id="kw-preview-slicer-reset">html,body{margin:0!important;}</style>');
		expect(bridgeHtml).toContain('function fitSlicerToPreviewEdges()');
		expect(bridgeHtml).toContain("slicerEl.style.marginTop=pt?('-'+pt+'px'):'0';");
		expect(bridgeHtml).toContain("slicerEl.style.width='calc(100% + '+(pl+pr)+'px)';");
		expect(slicerTag).toBeTruthy();
		expect(slicerTag).toContain('box-sizing:border-box');
		expect(slicerTag).toContain('margin-bottom:20px');
	});
});

describe('HTML dashboard artifact bridge ownership', () => {
	it('binds live preview to the explicit secondary fact result', () => {
		const sourceId = 'query_html_multi_fact';
		setResultsBatchState(sourceId, [
			{ columns: ['Value'], rows: [['first']], metadata: {} },
			{ columns: ['Value'], rows: [['second']], metadata: {} },
		], { policy: { exposeToActiveContent: true } });
		const section = new KwHtmlSection() as BridgeSection;
		section.boxId = 'html_multi_fact';
		section.setCode(makeFactHtml(sourceId, 1));

		const bridge = section._buildDataBridgeScript();

		expect(bridge).toContain('"rows":[["second"]]');
		expect(bridge).not.toContain('"rows":[["first"]]');
		expect(getBoundResultArtifact(
			htmlDashboardFactArtifactConsumerId(section.boxId), sourceId,
		)?.resultIndex).toBe(1);
		clearResultsState(sourceId);
	});

	it('rejects a secondary fact before opening Power BI publish UI', async () => {
		const sourceId = 'query_html_secondary_publish';
		setResultsBatchState(sourceId, [
			{ columns: ['Value'], rows: [[1]], metadata: {} },
			{ columns: ['Value'], rows: [[2]], metadata: {} },
		], { policy: { exposeToActiveContent: true } });
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.id = 'html_secondary_publish';
		section.boxId = section.id;
		section.setCode(makeFactHtml(sourceId, 1));
		const openPublishDialog = vi.fn();
		section._openPublishDialog = openPublishDialog;
		document.body.appendChild(section);
		await section.updateComplete;

		await section._publishToPowerBI();

		expect(openPublishDialog).not.toHaveBeenCalled();
		section.remove();
		clearResultsState(sourceId);
	});

	it('uses the Power BI missing-column diagnostic during preview preflight', () => {
		pState.htmlPowerBiCompatibilityCheckEnabled = true;
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.boxId = 'html_missing_scalar_column';
		section.setCode(`<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: {
				'total-actions': { display: { type: 'scalar', agg: 'SUM', column: 'MissingMetric' } },
			},
		})}</script><main><span data-kw-bind="total-actions"></span></main>`);
		section._collectDataSourcesForPBI = () => [{
			name: 'Fact Events',
			sectionId: 'query_fact',
			clusterUrl: 'https://cluster.example',
			database: 'db',
			query: 'FactEvents',
			columns: [{ name: 'ExistingMetric', type: 'long' }],
		}];

		expect(section.evaluatePowerBiCompatibilityNotice()?.diagnostics).toEqual([{
			code: 'missing-column',
			severity: 'error',
			message: 'total-actions (column: missing column MissingMetric)',
			bindingKey: 'total-actions',
			role: 'column',
			columnName: 'MissingMetric',
		}]);
	});

	it('does not expose a schema-rejected portable binding to the preview renderer', () => {
		const sourceId = 'query_preview_missing_scalar_column';
		setResultsState(sourceId, {
			columns: [{ name: 'ExistingMetric', type: 'long' }],
			rows: [[42]],
		}, {
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection() as unknown as BridgeSection;
		section.boxId = 'html_preview_missing_scalar_column';
		section.setCode(`<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: sourceId, sectionName: 'Fact Events' } },
			bindings: {
				'total-actions': { display: { type: 'scalar', agg: 'SUM', column: 'MissingMetric' } },
			},
		})}</script><main><span data-kw-bind="total-actions"></span></main>`);

		const bridge = section._buildDataBridgeScript();
		document.body.innerHTML = '<span data-kw-bind="total-actions">unchanged</span><div data-kw-bind="preview-only"></div>';
		const script = bridge.match(/<script>([\s\S]*?)<\/script>/i)?.[1];
		expect(script).toBeTruthy();
		new Function(script!).call(window);
		const runtime = (window as Window & typeof globalThis & { KustoWorkbench: ScalarBindingRuntime }).KustoWorkbench;
		runtime.bind('total-actions', 99);
		runtime.bindHtml('preview-only', '<strong>preview</strong>');

		expect(bridge).toContain('"bindings":{}');
		expect(bridge).not.toContain('MissingMetric');
		expect(document.querySelector('[data-kw-bind="total-actions"]')?.textContent).toBe('unchanged');
		expect(document.querySelector('[data-kw-bind="preview-only"]')?.innerHTML).toBe('<strong>preview</strong>');
		clearResultsState(sourceId);
	});

	it('cancels hidden iframe measurement when the dashboard workflow retires', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.id = 'html_measurement_cancel';
		section.boxId = section.id;
		document.body.appendChild(section);
		await section.updateComplete;

		const measurement = section._measureCurrentHtmlHeight('<main style="height:1200px">Measure</main>');
		expect(section.shadowRoot?.querySelector('iframe[style*="-10000px"]')).toBeTruthy();
		section._retireDashboardWorkflows();

		await expect(measurement).resolves.toBeUndefined();
		expect(section.shadowRoot?.querySelector('iframe[style*="-10000px"]')).toBeNull();
		section.remove();
		await Promise.resolve();
	});

	it('retires an open publish dialog when HTML code changes', async () => {
		const section = new KwHtmlSection();
		section.id = 'html_publish_code_retire';
		section.boxId = section.id;
		section.setCode('<main>before</main>');
		document.body.appendChild(section);
		await section.updateComplete;
		const dialog = section.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
		const hide = vi.spyOn(dialog, 'hide');
		(section as any)._openPublishDialog('<main>before</main>', [], 720, 'Before');
		dialog._publishRequestId = 'publish-before-code-change';
		hide.mockClear();

		section.setCode('<main>after</main>');

		expect(hide).toHaveBeenCalledOnce();
		expect(dialog.acceptsHostMessage({
			type: 'publishToPowerBIResult', requestId: 'publish-before-code-change',
		})).toBe(false);
		section.remove();
		await Promise.resolve();
	});

	it('retires an open publish dialog when its fact artifact is revoked', async () => {
		const sourceId = 'query_html_publish_revoke';
		setResultsState(sourceId, { columns: ['Value'], rows: [['before']] }, {
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection();
		section.id = 'html_publish_artifact_retire';
		section.boxId = section.id;
		document.body.appendChild(section);
		section.setCode(makeFactHtml(sourceId));
		await section.updateComplete;
		const dialog = section.shadowRoot?.querySelector<any>('kw-publish-pbi-dialog');
		const hide = vi.spyOn(dialog, 'hide');
		(section as any)._openPublishDialog(makeFactHtml(sourceId), [], 720, 'Before');
		dialog._publishRequestId = 'publish-before-artifact-revoke';
		hide.mockClear();

		clearResultsState(sourceId);

		expect(hide).toHaveBeenCalledOnce();
		expect(dialog.acceptsHostMessage({
			type: 'publishToPowerBIResult', requestId: 'publish-before-artifact-revoke',
		})).toBe(false);
		section.remove();
		await Promise.resolve();
	});

	it('preserves saved query rows, HTML binding and the pre-submit Publish dialog across auth retirement', async () => {
		const { KwQuerySection } = await import('../../src/webview/sections/kw-query-section');
		const { startMainWebviewMessageDispatcher } = await import('../../src/webview/core/message-handler');
		const sourceId = 'query_html_publish_auth';
		const connectionId = 'connection_html_publish_auth';
		const query = 'FactEvents | project Value';
		const savedResult = { columns: [{ name: 'Value', type: 'long' }], rows: [[7], [11]], metadata: {} };
		const savedJson = JSON.stringify(savedResult);
		const querySection = new KwQuerySection();
		querySection.id = sourceId;
		querySection.boxId = sourceId;
		const section = new KwHtmlSection();
		section.id = 'html_publish_auth';
		section.boxId = section.id;
		const runtimeWindow = window as Window & typeof globalThis & {
			__e2eCaptureHostMessage?: (message: unknown) => unknown;
		};
		const previousCapture = runtimeWindow.__e2eCaptureHostMessage;
		const previousRuntimeActive = pState.documentRuntimeActive;
		const messages: Array<Record<string, unknown>> = [];
		const dispatch = (data: Record<string, unknown>) => window.dispatchEvent(new MessageEvent('message', { data }));
		runtimeWindow.__e2eCaptureHostMessage = message => {
			const outbound = message as Record<string, unknown>;
			messages.push(outbound);
			if (outbound.type === 'getPbiWorkspaces') queueMicrotask(() => dispatch({
				type: 'pbiWorkspacesResult', requestId: outbound.requestId, boxId: section.boxId,
				ok: true, workspaces: [{ id: 'workspace-local', name: 'Local workspace' }],
			}));
			return false;
		};
		const measure = vi.spyOn(section as unknown as HeightSection, '_measureCurrentHtmlHeight').mockResolvedValue(720);
		const terminalAdmission = vi.spyOn(querySection, 'admitQueryTerminal');
		try {
			pState.documentRuntimeActive = true;
			await startMainWebviewMessageDispatcher();
			document.body.append(querySection, section);
			querySection.setConnections([{ id: connectionId, clusterUrl: 'https://cluster.kusto.windows.net' }]);
			querySection.setConnectionId(connectionId);
			querySection.setDatabases(['Samples'], 'Samples');
			querySection.setSchemaLifecycleTarget(connectionId, 'Samples');
			await querySection.updateComplete;
			displayResultForBox(savedResult, sourceId, {
				artifactPublication: {
					producer: { engine: 'kusto', boxId: sourceId, executionId: 'saved-execution', connectionId, database: 'Samples', query },
					policy: { exposeToActiveContent: true },
				},
			});
			pState.queryResultJsonByBoxId[sourceId] = savedJson;
			const savedState = getResultsState(sourceId);
			const savedArtifact = getCurrentResultArtifact(sourceId)!;
			const savedArtifactMetadata = toPersistedResultArtifact(savedArtifact)!;
			pState.resultArtifactByBoxId[sourceId] = savedArtifactMetadata;
			const table = querySection.querySelector('kw-data-table');
			expect(table).not.toBeNull();
			expect(savedState?.rows).toEqual([[7], [11]]);
			section.setCode(`<script type="application/kw-provenance">${JSON.stringify({
				version: 1,
				model: { fact: { sectionId: sourceId, sectionName: 'Fact Events' } },
				bindings: { total: { display: { type: 'scalar', agg: 'SUM', column: 'Value' } } },
			})}</script><main><span data-kw-bind="total"></span></main>`);
			section.setMode('preview');
			await section.updateComplete;
			const iframe = section.shadowRoot!.querySelector<HTMLIFrameElement>('#preview-iframe')!;
			await vi.waitFor(() => expect(iframe.srcdoc).toContain('"rows":[[7],[11]]'));
			const srcdoc = iframe.srcdoc;
			expect(querySection.beginQueryExecution('pending-before-auth')).toBe(true);
			const execution = querySection.getActiveExecution()!;
			expect(querySection.acceptsQueryTerminal(execution.executionId)).toBe(true);

			section.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Publish to Power BI service"]')!.click();
			const dialog = section.shadowRoot!.querySelector<KwPublishPbiDialog>('kw-publish-pbi-dialog')!;
			await vi.waitFor(() => expect(dialog.shadowRoot?.querySelector('.sd-f .sd-btn-primary')?.textContent).toContain('Publish'));
			const panel = dialog.shadowRoot!.querySelector('.sd')!;
			expect(messages.filter(message => message.type === 'getPbiWorkspaces')).toHaveLength(1);
			expect(messages.some(message => message.type === 'publishToPowerBI')).toBe(false);
			const assertSavedDashboard = () => {
				expect(getResultsState(sourceId)).toBe(savedState);
				expect(getResultsState(sourceId)?.rows).toEqual([[7], [11]]);
				expect(getCurrentResultArtifact(sourceId)).toBe(savedArtifact);
				expect(getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId)).toBe(savedArtifact);
				expect(pState.queryResultJsonByBoxId[sourceId]).toBe(savedJson);
				expect(pState.resultArtifactByBoxId[sourceId]).toBe(savedArtifactMetadata);
				expect(querySection.querySelector('kw-data-table')).toBe(table);
				expect(section.shadowRoot!.querySelector('#preview-iframe')).toBe(iframe);
				expect(iframe.srcdoc).toBe(srcdoc);
				expect(dialog.shadowRoot!.querySelector('.sd')).toBe(panel);
				expect(messages.some(message => message.type === 'publishToPowerBI')).toBe(false);
			};
			assertSavedDashboard();

			dispatch({ type: 'kustoAuthIdentityChanged', connectionIds: [connectionId], reason: 'sessions-changed' });
			await querySection.updateComplete;
			await section.updateComplete;
			await dialog.updateComplete;
			expect(querySection.getSchemaLifecycleIdentity()!.targetGeneration).toBeGreaterThan(execution.targetGeneration);
			expect(querySection.getActiveExecution()).toBeUndefined();
			expect(querySection.acceptsQueryTerminal(execution.executionId)).toBe(false);
			expect(messages).toContainEqual({
				type: 'cancelQuery', boxId: sourceId, executionId: execution.executionId,
				sectionInstanceId: execution.sectionInstanceId, targetGeneration: execution.targetGeneration,
			});
			assertSavedDashboard();

			const dispatchIdentity = {
				dispatchAttempt: 1, connectionRevision: 0, leaveNoTraceRevision: 0,
				connectionIdentityKey: 'cluster|authority', clusterEndpoint: 'https://cluster.kusto.windows.net',
				accountPartition: 'partition-before-auth', authSessionGeneration: 0, clientActivityId: 'late-query',
			};
			const producer = {
				engine: 'kusto' as const, ...execution, producer: 'manual' as const, reservationSequence: 2,
				connectionId, database: 'Samples', query, dispatch: dispatchIdentity,
			};
			const stage = {
				type: 'kustoPublicationStage', publicationId: 'html-auth-stale-result',
				publicationDeadline: Date.now() + 5_000,
				payload: {
					type: 'queryResult', ...producer,
					result: { ...savedResult, rows: [[70], [110]] },
					resultArtifactAssignment: {
						version: 1,
						...createPrimaryResultArtifactIdentity(sourceId, savedArtifact.revision + 1, savedArtifact.createdAt + 1),
						producer,
						policy: {
							accountPartition: dispatchIdentity.accountPartition, authSessionGeneration: 0,
							leaveNoTraceRevision: 0, connectionRevision: 0, connectionIdentityKey: dispatchIdentity.connectionIdentityKey,
							exposeToActiveContent: true, sendToModel: true, shareToClipboard: true, exportToCsv: true,
						},
					},
				},
			};
			expect(admitKustoPublicationHostMessage(stage)).toMatchObject({ recognized: true, parsed: { ok: true } });
			dispatch(stage);
			expect(messages).toContainEqual({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'staged', accepted: true,
			});
			dispatch({ type: 'kustoPublicationCommit', publicationId: stage.publicationId });
			await vi.waitFor(() => expect(messages).toContainEqual({
				type: 'kustoPublicationAck', publicationId: stage.publicationId, phase: 'applied', accepted: false,
			}));
			expect(terminalAdmission).toHaveReturnedWith('retired');
			await section.updateComplete;
			await dialog.updateComplete;
			assertSavedDashboard();
		} finally {
			measure.mockRestore();
			terminalAdmission.mockRestore();
			section.remove();
			querySection.remove();
			await Promise.resolve();
			clearResultsState(sourceId);
			delete pState.queryResultJsonByBoxId[sourceId];
			delete pState.resultArtifactByBoxId[sourceId];
			delete pState.resultsVisibleByBoxId[sourceId];
			delete pState.pendingHtmlCodeByBoxId[section.boxId];
			pState.documentRuntimeActive = previousRuntimeActive;
			if (previousCapture) runtimeWindow.__e2eCaptureHostMessage = previousCapture;
			else delete runtimeWindow.__e2eCaptureHostMessage;
		}
	});

	it('does not let a removed instance repopulate a cleared pending-code slot before replacement', async () => {
		const section = new KwHtmlSection();
		section.id = 'html_retired_pending_code';
		section.boxId = section.id;
		document.body.appendChild(section);
		section.setCode('<main>before removal</main>');
		section.remove();
		delete pState.pendingHtmlCodeByBoxId[section.boxId];

		section.setCode('<main>stale after removal</main>');

		expect(pState.pendingHtmlCodeByBoxId[section.boxId]).toBeUndefined();
		await Promise.resolve();
	});

	it('retains explicit dataSourceIds in metadata-free serialization', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_legacy_data_sources';
		section.setDataSourceIds(['query_1', 'transformation_1']);

		expect(section.serialize().dataSourceIds).toEqual(['query_1', 'transformation_1']);
	});

	it('drops a publish workflow whose measurement resolves after same-ID replacement', async () => {
		const oldSection = new KwHtmlSection() as unknown as HeightSection;
		oldSection.id = 'html_publish_workflow_owner';
		oldSection.boxId = oldSection.id;
		oldSection.setCode(`<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><main><span data-kw-bind="total">0</span></main>`);
		document.body.appendChild(oldSection);
		let resolveMeasurement!: (height: number | undefined) => void;
		oldSection._collectDataSourcesForPBI = () => [{
			name: 'Fact Events', sectionId: 'query_fact', clusterUrl: 'https://cluster.example',
			database: 'db', query: 'FactEvents', columns: [{ name: 'Day', type: 'datetime' }],
		}];
		oldSection._measureCurrentHtmlHeight = () => new Promise(resolve => { resolveMeasurement = resolve; });
		const openPublishDialog = vi.fn();
		oldSection._openPublishDialog = openPublishDialog;

		const publishing = oldSection._publishToPowerBI();
		oldSection.remove();
		const replacement = new KwHtmlSection();
		replacement.id = oldSection.id;
		replacement.boxId = oldSection.boxId;
		document.body.appendChild(replacement);
		resolveMeasurement(720);
		await publishing;

		expect(openPublishDialog).not.toHaveBeenCalled();
		replacement.remove();
		await Promise.resolve();
	});

	it('rejects an export-upload dialog response owned by a predecessor section', async () => {
		const replacement = new KwHtmlSection() as unknown as HeightSection;
		replacement.id = 'html_export_workflow_owner';
		replacement.boxId = replacement.id;
		document.body.appendChild(replacement);
		const openPublishDialog = vi.fn();
		replacement._openPublishDialog = openPublishDialog;

		replacement._handleIframeMessage({
			data: {
				type: 'openPublishPbiDialog', requestId: 'predecessor-export-request',
				boxId: replacement.boxId, htmlCode: '<main>stale</main>', dataSources: [],
				previewHeight: 720, suggestedName: 'Stale dashboard',
			},
			source: null,
		} as unknown as MessageEvent);

		expect(openPublishDialog).not.toHaveBeenCalled();
		replacement.remove();
		await Promise.resolve();
	});

	it('keeps the exact editor, iframe, and fact binding for an equal host projection', async () => {
		const sourceId = 'query_html_equal_projection';
		setResultsState(sourceId, { columns: ['Value'], rows: [['revision-a']] }, {
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection();
		section.id = 'html_equal_projection';
		section.boxId = section.id;
		document.body.appendChild(section);
		section.setCode(makeFactHtml(sourceId));
		section.setMode('preview');
		await section.updateComplete;
		const iframe = section.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
		await vi.waitFor(() => expect(iframe?.srcdoc).toContain('revision-a'));
		const editor = {
			getValue: () => makeFactHtml(sourceId),
			setValue: vi.fn(), getModel: () => ({ getValue: () => makeFactHtml(sourceId) }),
			getContentHeight: () => 200, getDomNode: () => null, layout: vi.fn(), dispose: vi.fn(), focus: vi.fn(),
			onDidFocusEditorText: () => ({ dispose() {} }), onDidFocusEditorWidget: () => ({ dispose() {} }),
			onDidChangeModelContent: () => ({ dispose() {} }), onDidContentSizeChange: () => ({ dispose() {} }),
			updateOptions: vi.fn(), addCommand: vi.fn(),
		};
		(section as any)._editor = editor;
		const previewSpy = vi.spyOn(section as any, '_updatePreview');
		const bindingBefore = getBoundResultArtifact(
			htmlDashboardFactArtifactConsumerId(section.boxId), sourceId,
		);

		section.applyHostDocumentState(section.createDocumentState());
		await Promise.resolve();

		expect((section as any)._editor).toBe(editor);
		expect(editor.setValue).not.toHaveBeenCalled();
		expect(section.shadowRoot?.getElementById('preview-iframe')).toBe(iframe);
		expect(previewSpy).not.toHaveBeenCalled();
		expect(getBoundResultArtifact(
			htmlDashboardFactArtifactConsumerId(section.boxId), sourceId,
		)?.artifactId).toBe(bindingBefore?.artifactId);
		section.remove();
		await Promise.resolve();
		clearResultsState(sourceId);
	});

	it('prevents a detached same-ID instance from rebinding a replacement fact source', async () => {
		for (const [sourceId, value] of [
			['query_html_stale_a', 'source-a'], ['query_html_stale_b', 'source-b'],
		] as const) {
			setResultsState(sourceId, { columns: ['Value'], rows: [[value]] }, {
				policy: { exposeToActiveContent: true },
			});
		}
		const oldSection = new KwHtmlSection();
		oldSection.id = 'html_same_id_owner';
		oldSection.boxId = oldSection.id;
		document.body.appendChild(oldSection);
		oldSection.setCode(makeFactHtml('query_html_stale_a'));
		oldSection.remove();

		const replacement = new KwHtmlSection();
		replacement.id = oldSection.id;
		replacement.boxId = oldSection.boxId;
		document.body.appendChild(replacement);
		replacement.setCode(makeFactHtml('query_html_stale_b'));
		await Promise.resolve();
		const replacementCode = replacement.getCode();
		oldSection.setCode('<main>stale detached code</main>');

		expect(replacement.getCode()).toBe(replacementCode);
		expect(replacement.createDocumentState().code).toBe(replacementCode);
		expect(getBoundResultArtifact(
			htmlDashboardFactArtifactConsumerId(replacement.boxId), 'query_html_stale_b',
		)?.rows).toEqual([['source-b']]);
		expect(getBoundResultArtifact(
			htmlDashboardFactArtifactConsumerId(replacement.boxId), 'query_html_stale_a',
		)).toBeNull();
		replacement.remove();
		await Promise.resolve();
		clearResultsState('query_html_stale_a');
		clearResultsState('query_html_stale_b');
	});

	it('pins source A until explicit refresh rebinds to B', () => {
		const sourceId = 'query_html_artifact_source';
		setResultsState(sourceId, { columns: ['Value'], rows: [['revision-a']] }, {
			policy: { exposeToActiveContent: true } as any,
		});
		const sourceA = getCurrentResultArtifact(sourceId)!;
		const section = new KwHtmlSection() as BridgeSection;
		section.boxId = 'html_artifact_consumer';
		section.setCode(makeFactHtml(sourceId));

		expect(section._buildDataBridgeScript()).toContain('revision-a');

		setResultsState(sourceId, { columns: ['Value'], rows: [['revision-b']] }, {
			policy: { exposeToActiveContent: true } as any,
		});
		const sourceB = getCurrentResultArtifact(sourceId)!;
		expect(sourceB.artifactId).not.toBe(sourceA.artifactId);
		expect(section._buildDataBridgeScript()).toContain('revision-a');
		expect(section._buildDataBridgeScript()).not.toContain('revision-b');

		section.refreshDataBridge();

		expect(section._buildDataBridgeScript()).toContain('revision-b');
	});

	it('exports an opaque-ID Kusto fact source to Power BI from exact artifact provenance', () => {
		const sourceId = 'custom-query';
		const query = document.createElement('kw-query-section') as any;
		query.id = sourceId;
		query.getClusterUrl = () => 'https://cluster.kusto.windows.net';
		query.getConnectionId = () => 'connection-1';
		query.getDatabase = () => 'Samples';
		query.getName = () => 'Opaque fact';
		document.body.appendChild(query);
		setResultsState(sourceId, {
			columns: [{ name: 'Value', type: 'long' }], rows: [[1]], metadata: {},
		}, {
			producer: {
				engine: 'kusto', boxId: sourceId, connectionId: 'connection-1',
				database: 'Samples', query: 'print Value=1',
			},
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection();
		section.boxId = 'html_opaque_fact';
		section.setCode(makeFactHtml(sourceId));

		const context = section.getDashboardExportContext();

		expect(context.dataSources).toEqual([expect.objectContaining({
			sectionId: sourceId, name: 'Fact Events', query: 'print Value=1', database: 'Samples',
		})]);
		query.remove();
		clearResultsState(sourceId);
	});

	it.each(['profile-connection', ''])('validates already-saved dashboard rows when the current connection differs (%s) without granting Power BI readiness', currentConnectionId => {
		const sourceId = 'saved_dashboard_fact';
		const query = document.createElement('kw-query-section') as any;
		query.id = sourceId;
		query.getClusterUrl = vi.fn(() => currentConnectionId ? 'https://cluster.kusto.windows.net' : '');
		query.getConnectionId = vi.fn(() => currentConnectionId);
		query.getDatabase = vi.fn(() => currentConnectionId ? 'SavedDb' : '');
		document.body.appendChild(query);
		const savedColumns = [{ name: 'Value', type: 'long' }];
		setResultsState(sourceId, { columns: savedColumns, rows: [[7], [11]], metadata: {} }, {
			persistedIdentity: createPrimaryResultArtifactIdentity(sourceId, 3, 1234),
			producer: { engine: 'kusto', boxId: sourceId, connectionId: 'saved-connection', database: 'SavedDb', query: 'SavedFact', producer: 'restored' },
			policy: { exposeToActiveContent: true },
		});
		const artifact = getCurrentResultArtifact(sourceId)!;
		const descriptorBefore = toPersistedResultArtifact(artifact);
		const section = new KwHtmlSection() as BridgeSection;
		section.boxId = 'html_saved_dashboard_validation';
		section.setCode(makeFactHtml(sourceId));
		try {
			expect(section._buildDataBridgeScript()).toContain('"rows":[[7],[11]]');
			expect(getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId)).toBe(artifact);
			expect(section.getDashboardExportContext().dataSources).toEqual([]);
			query.getClusterUrl.mockClear();
			query.getConnectionId.mockClear();
			query.getDatabase.mockClear();
			const context = section.getDashboardValidationContext();
			expect(context.dataSources).toEqual([{ sectionId: sourceId, columns: savedColumns }]);
			expect(context.factColumns).toEqual(savedColumns);
			expect(query.getClusterUrl).not.toHaveBeenCalled();
			expect(query.getConnectionId).not.toHaveBeenCalled();
			expect(query.getDatabase).not.toHaveBeenCalled();
			setResultsState(sourceId, { columns: savedColumns, rows: [[70], [110]], metadata: {} }, {
				producer: artifact.producer, policy: artifact.policy,
			});
			expect(getCurrentResultArtifact(sourceId)?.artifactId).not.toBe(artifact.artifactId);
			expect(section.getDashboardValidationContext().dataSources).toEqual(context.dataSources);
			expect(section._buildDataBridgeScript()).toContain('"rows":[[7],[11]]');
			expect(getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId)).toBe(artifact);
			expect(toPersistedResultArtifact(artifact)).toEqual(descriptorBefore);
			expect(artifact.policy?.sendToModel).not.toBe(true);
			expect(artifact.policy?.shareToClipboard).not.toBe(true);
			expect(artifact.policy?.exportToCsv).not.toBe(true);
		} finally {
			query.remove();
			clearResultsState(sourceId);
		}
	});

	it.each(['zero-row', 'secondary'])('validates the saved %s fact without current connection metadata', kind => {
		const sourceId = `saved_dashboard_${kind}`;
		const query = document.createElement('kw-query-section');
		query.id = sourceId;
		document.body.appendChild(query);
		const savedColumns = [{ name: 'Value', type: 'long' }];
		const resultIndex = kind === 'secondary' ? 1 : 0;
		setResultsBatchState(sourceId, kind === 'secondary' ? [
			{ columns: [{ name: 'PrimaryOnly', type: 'string' }], rows: [['primary']], metadata: {} },
			{ columns: savedColumns, rows: [[17]], metadata: {} },
		] : [{ columns: savedColumns, rows: [], metadata: {} }], {
			persistedIdentity: createPrimaryResultArtifactIdentity(sourceId, 3, 1234),
			producer: { engine: 'kusto', boxId: sourceId, connectionId: 'saved-connection', database: 'SavedDb', query: 'SavedFact', producer: 'restored' },
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection() as BridgeSection;
		section.boxId = `html_${sourceId}`;
		section.setCode(makeFactHtml(sourceId, resultIndex));
		try {
			const artifact = getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId)!;
			const descriptorBefore = toPersistedResultArtifact(artifact);
			expect(section.getDashboardValidationContext().dataSources).toEqual([{
				sectionId: sourceId, ...(resultIndex ? { resultIndex } : {}), columns: savedColumns,
			}]);
			expect(artifact.resultIndex).toBe(resultIndex);
			expect(section._buildDataBridgeScript()).toContain(kind === 'secondary' ? '"rows":[[17]]' : '"rows":[]');
			expect(getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId)).toBe(artifact);
			expect(toPersistedResultArtifact(artifact)).toEqual(descriptorBefore);
		} finally {
			query.remove();
			clearResultsState(sourceId);
		}
	});

	it.each([
		'missing permission', 'denied permission', 'missing artifact', 'missing result',
		'missing columns', 'non-Kusto producer', 'missing query section',
	])('rejects local dashboard validation for %s without granting or replacing saved data', condition => {
		const sourceId = `saved_dashboard_denied_${condition.replaceAll(' ', '_')}`;
		const query = document.createElement('kw-query-section');
		query.id = sourceId;
		if (condition !== 'missing query section') document.body.appendChild(query);
		if (condition !== 'missing artifact') setResultsState(sourceId, {
			columns: condition === 'missing columns' ? [] : [{ name: 'Value', type: 'long' }],
			rows: [[7]], metadata: {},
		}, {
			persistedIdentity: createPrimaryResultArtifactIdentity(sourceId, 3, 1234),
			producer: { engine: condition === 'non-Kusto producer' ? 'sql' : 'kusto', boxId: sourceId, connectionId: 'saved-connection', database: 'SavedDb', query: 'SavedFact', producer: 'restored' },
			policy: condition === 'missing permission' ? undefined : { exposeToActiveContent: condition !== 'denied permission' },
		});
		const section = new KwHtmlSection();
		section.boxId = `html_${sourceId}`;
		section.setCode(makeFactHtml(sourceId, condition === 'missing result' ? 1 : 0));
		const artifactBefore = getCurrentResultArtifact(sourceId);
		const bindingBefore = getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId);
		try {
			expect(section.getDashboardValidationContext().dataSources).toEqual([]);
			expect(section.getDashboardValidationContext().factColumns).toEqual([]);
			expect(getCurrentResultArtifact(sourceId)).toBe(artifactBefore);
			expect(getBoundResultArtifact(htmlDashboardFactArtifactConsumerId(section.boxId), sourceId)).toBe(bindingBefore);
		} finally {
			query.remove();
			clearResultsState(sourceId);
		}
	});

	it('fails closed when the bound artifact lacks active-content exposure permission', () => {
		const sourceId = 'query_html_artifact_denied';
		setResultsState(sourceId, { columns: ['Secret'], rows: [['classified']] });
		const section = new KwHtmlSection() as BridgeSection;
		section.boxId = 'html_artifact_denied';
		section.setCode(makeFactHtml(sourceId));

		expect(section._buildDataBridgeScript()).toBe('');
	});

	it('synchronously blanks and hides an active preview when its bound artifact is revoked', async () => {
		const sourceId = 'query_html_artifact_live_revoke';
		setResultsState(sourceId, { columns: ['Secret'], rows: [['visible-before-revoke']] }, {
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection();
		section.boxId = 'html_artifact_live_revoke';
		section.setCode(makeFactHtml(sourceId));
		section.setMode('preview');
		document.body.appendChild(section);
		await section.updateComplete;
		const iframe = section.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
		await vi.waitFor(() => expect(iframe?.srcdoc).toContain('visible-before-revoke'));

		clearResultsState(sourceId);

		expect(iframe?.style.visibility).toBe('hidden');
		expect(iframe?.srcdoc).toBe('');
		section.remove();
	});

	it('fails closed when the source is revoked while the section is disconnected for reorder', async () => {
		const sourceId = 'query_html_artifact_reorder_revoke';
		setResultsState(sourceId, { columns: ['Secret'], rows: [['stale-during-reorder']] }, {
			policy: { exposeToActiveContent: true },
		});
		const section = new KwHtmlSection();
		section.boxId = 'html_artifact_reorder_revoke';
		section.setCode(makeFactHtml(sourceId));
		section.setMode('preview');
		document.body.appendChild(section);
		await section.updateComplete;
		const iframe = section.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
		await vi.waitFor(() => expect(iframe?.srcdoc).toContain('stale-during-reorder'));

		section.remove();
		clearResultsState(sourceId);
		document.body.appendChild(section);
		await section.updateComplete;

		expect(section._buildDataBridgeScript()).toBe('');
		section.remove();
	});

	it('synchronously blanks old data when provenance switches fact sources', async () => {
		for (const [sourceId, value] of [['query_html_source_a', 'source-a'], ['query_html_source_b', 'source-b']] as const) {
			setResultsState(sourceId, { columns: ['Value'], rows: [[value]] }, {
				policy: { exposeToActiveContent: true },
			});
		}
		const section = new KwHtmlSection();
		section.boxId = 'html_artifact_source_switch';
		section.setCode(makeFactHtml('query_html_source_a'));
		section.setMode('preview');
		document.body.appendChild(section);
		await section.updateComplete;
		const iframe = section.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
		await vi.waitFor(() => expect(iframe?.srcdoc).toContain('source-a'));

		section.setCode(makeFactHtml('query_html_source_b'));

		expect(iframe?.style.visibility).toBe('hidden');
		expect(iframe?.srcdoc).toBe('');
		await vi.waitFor(() => expect(iframe?.srcdoc).toContain('source-b'));
		section.remove();
	});
});

describe('HTML preview height reporting', () => {
	it('uses iframe content height for export even when the visible preview wrapper is shorter', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section._lastPreviewContentHeight = 920;
		section._savedPreviewHeightPx = 620;

		expect(section._measurePreviewHeight()).toBe(920);
	});

	it('requests a fresh iframe height before export or publish uses the cached value', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const contentWindow = { postMessage: (_message: unknown, _targetOrigin: string) => undefined };
		let requestedMessage: unknown;
		contentWindow.postMessage = (message: unknown) => { requestedMessage = message; };

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-iframe'
					? { contentWindow }
					: null,
			},
		});

		const pending = section._requestFreshPreviewHeight();
		expect(requestedMessage).toEqual({ type: 'kw-html-request-height' });

		section._handleIframeMessage({
			data: { type: 'kw-html-preview-height', h: 955 },
			source: contentWindow,
		} as unknown as MessageEvent);

		await expect(pending).resolves.toBe(955);
		expect(section._measurePreviewHeight()).toBe(955);
	});

	it('opens the publish dialog with a fresh measurement of the current HTML code', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const currentHtml = `<script type="application/kw-provenance">${JSON.stringify({
			version: 1,
			model: { fact: { sectionId: 'query_fact', sectionName: 'Fact Events' } },
			bindings: { total: { display: { type: 'scalar', agg: 'COUNT' } } },
		})}</script><main style="height:1234px"><span data-kw-bind="total">0</span>Current dashboard</main>`;
		let measuredCode = '';
		let openedPreviewHeight: number | undefined;

		section.setCode(currentHtml);
		section._collectDataSourcesForPBI = () => [{
			name: 'Fact Events',
			sectionId: 'query_fact',
			clusterUrl: 'https://cluster.example',
			database: 'db',
			query: 'FactEvents',
			columns: [{ name: 'Day', type: 'datetime' }],
		}];
		section._measureCurrentHtmlHeight = async (code: string) => {
			measuredCode = code;
			return 1234;
		};
		section._openPublishDialog = (_htmlCode, _dataSources, previewHeight) => {
			openedPreviewHeight = previewHeight;
		};

		await section._publishToPowerBI();

		expect(measuredCode).toBe(currentHtml);
		expect(openedPreviewHeight).toBe(1234);
	});

	it('measures export height at the generated Power BI HTML visual width', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;

		expect(section._getPowerBiMeasurementWidth()).toBe(1450);
	});

	it('keeps robust body and rendered-element measurements in the injected iframe script', () => {
		const script = (KwHtmlSection as unknown as { _heightReportScript: string })._heightReportScript;

		expect(script).toContain('kw-preview-base-reset');
		expect(script).toContain(':where(html,body){margin:0;}');
		expect(script).toContain('body.scrollHeight');
		expect(script).toContain('rawScrollHeight()');
		expect(script).toContain('metrics:{viewportHeight:viewportHeight(),scrollHeight:rawScrollHeight(),viewportBoundHeight:viewportBoundHeight()}');
		expect(script).toContain('declaresViewportBlockSize(el)');
		expect(script).toContain('styleUsesViewportBlockSize');
		expect(script).toContain('primary>0?primary');
		expect(script).toContain('scrollOverflowHeight()');
		expect(script).toContain('maxElementBottom()');
		expect(script).toContain('fallbackElementBottom()');
		expect(script).toContain('primary||fallbackElementBottom()');
		expect(script).toContain('clampToOverflowAncestors(el,bottom)');
		expect(script).toContain('clampsOverflow(style)');
		expect(script).toContain('isInFixedSubtree(el)');
		expect(script).toContain('isViewportFill(rect)');
		expect(script).not.toContain('de?de.clientHeight:0');
		expect(script).not.toContain('body?body.clientHeight:0');
		expect(script).toContain('ro.observe(document.body)');
		expect(script).toContain('new MutationObserver(schedule)');
	});

	it('returns initial HTML code before Monaco initializes', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_initial_code_test';
		section.initialCode = '<main>Restored dashboard</main>';

		expect(section.getCode()).toBe('<main>Restored dashboard</main>');
	});

	it('renders restored initial HTML when the section starts expanded in preview mode', async () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_restored_preview_test';
		section.setAttribute('initial-code', '<main>Restored dashboard</main>');
		section.setMode('preview');

		document.body.appendChild(section);
		try {
			await section.updateComplete;
			await Promise.resolve();

			const iframe = section.shadowRoot?.getElementById('preview-iframe') as HTMLIFrameElement | null;
			expect(iframe?.srcdoc).toContain('<main>Restored dashboard</main>');
		} finally {
			section.remove();
		}
	});

	it('keeps tool-set HTML code before Monaco initializes', () => {
		const section = new KwHtmlSection();
		section.boxId = 'html_pending_code_test';
		section.initialCode = '<main>Old dashboard</main>';

		section.setCode('<main>New dashboard</main>');

		expect(section.getCode()).toBe('<main>New dashboard</main>');
		expect(section.initialCode).toBe('<main>New dashboard</main>');
	});

	it('does not treat persisted previewHeightPx as a current-session manual resize', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.previewHeightPx = 1028;

		section.firstUpdated(new Map() as never);

		expect(section._savedPreviewHeightPx).toBe(1028);
		expect(section._userResizedPreview).toBe(false);
		expect(section.serialize().previewHeightPx).toBeUndefined();
	});

	it('restores and reserializes explicitly user-set preview heights', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.previewHeightPx = 1028;
		section.previewHeightUserSet = true;

		section.firstUpdated(new Map() as never);

		expect(section._savedPreviewHeightPx).toBe(1028);
		expect(section._userResizedPreview).toBe(true);
		expect(section.serialize().previewHeightPx).toBe(1028);
		expect(section.serialize().previewHeightUserSet).toBe(true);
	});

	it('stores iframe scroll metrics from preview height reports', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const contentWindow = {};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-iframe'
					? { contentWindow }
					: null,
			},
		});

		section._handleIframeMessage({
			data: { type: 'kw-html-preview-height', h: 955, metrics: { scrollHeight: 956.2, viewportHeight: 948.4 } },
			source: contentWindow,
		} as unknown as MessageEvent);

		expect(section._lastPreviewContentHeight).toBe(955);
		expect(section._lastPreviewScrollHeight).toBe(957);
		expect(section._lastPreviewViewportHeight).toBe(949);
	});

	it('adds a small buffer when auto-fitting preview height to avoid iframe scrollbar flicker', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = { style: { height: '', maxHeight: '' } };

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._applyPreviewFitHeight(640);

		expect(wrapper.style.height).toBe('648px');
		expect(wrapper.style.maxHeight).toBe('648px');
		expect(section._lastPreviewFitHeight).toBe(648);
	});

	it('does not grow auto-fit preview height when the report is bound to the current iframe viewport', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 640;
		section._applyPreviewFitHeight(640);

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('does not grow auto-fit preview height for viewport-unit layouts with padding', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 688;
		section._lastPreviewViewportBoundHeight = 688;
		section._applyPreviewFitHeight(688);

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('does not grow auto-fit preview height for offset viewport-unit layouts', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 736;
		section._lastPreviewViewportBoundHeight = 736;
		section._applyPreviewFitHeight(736);

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('still grows auto-fit preview height for real content slightly taller than the iframe viewport', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = {
			clientHeight: 640,
			style: { height: '', maxHeight: '' },
			getBoundingClientRect: () => ({ height: 640 }),
		};

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewViewportHeight = 640;
		section._lastPreviewScrollHeight = 656;
		section._applyPreviewFitHeight(656);

		expect(wrapper.style.height).toBe('664px');
		expect(wrapper.style.maxHeight).toBe('664px');
		expect(section._lastPreviewFitHeight).toBe(664);
	});

	it('resets stale auto-fit wrapper height before reloading preview srcdoc', async () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section.boxId = 'html_reload_reset_test';
		section.initialCode = '<main>Dashboard content</main>';
		const wrapper = { style: { height: '1800px', maxHeight: '1800px' } };
		const iframe = { srcdoc: '' };

		Object.defineProperty(section, 'updateComplete', { value: Promise.resolve(), configurable: true });
		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => {
					if (id === 'preview-wrapper') return wrapper;
					if (id === 'preview-iframe') return iframe;
					return null;
				},
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewFitHeight = 1800;
		section._updatePreview();
		await Promise.resolve();

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
		expect(iframe.srcdoc).toContain('<main>Dashboard content</main>');
	});

	it('resets non-user-resized preview wrappers before a fresh fit request', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		const wrapper = { style: { height: '1800px', maxHeight: '1800px' } };

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper' ? wrapper : null,
			},
			configurable: true,
		});

		section._userResizedPreview = false;
		section._lastPreviewFitHeight = 1800;
		section._resetAutoPreviewHeightForFreshFit();

		expect(wrapper.style.height).toBe('');
		expect(wrapper.style.maxHeight).toBe('');
		expect(section._lastPreviewFitHeight).toBe(0);
	});

	it('does not treat auto preview height snapshots as user-resized heights', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section._mode = 'preview';
		section._userResizedPreview = false;
		section._savedPreviewHeightPx = undefined;

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper'
					? { getBoundingClientRect: () => ({ height: 640 }) }
					: null,
			},
			configurable: true,
		});

		section._captureCurrentHeight();

		expect(section._userResizedPreview).toBe(false);
		expect(section._savedPreviewHeightPx).toBeUndefined();
	});

	it('preserves preview height snapshots that came from a real user resize', () => {
		const section = new KwHtmlSection() as unknown as HeightSection;
		section._mode = 'preview';
		section._userResizedPreview = true;
		section._savedPreviewHeightPx = undefined;

		Object.defineProperty(section, 'shadowRoot', {
			value: {
				getElementById: (id: string) => id === 'preview-wrapper'
					? { getBoundingClientRect: () => ({ height: 640 }) }
					: null,
			},
			configurable: true,
		});

		section._captureCurrentHeight();

		expect(section._userResizedPreview).toBe(true);
		expect(section._savedPreviewHeightPx).toBe(640);
	});
});
