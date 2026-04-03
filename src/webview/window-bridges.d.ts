/**
 * Type declarations for all window bridge functions and state variables
 * exposed by webview modules (src/webview/core/*.ts, src/webview/sections/*.ts).
 *
 * The webview is bundled as a single IIFE by esbuild, so ES module imports
 * aren't available at runtime. Modules expose functions and state on `window`
 * as the inter-module communication layer. This file makes those bridges
 * type-safe.
 *
 * Organized by source module. Functions marked optional (?) since module
 * load order isn't guaranteed. State from state.ts is non-optional (loads first).
 */

declare global {

	// =================================================================
	// Shared interfaces (used across multiple Window bridge declarations)
	// =================================================================

	/** A column entry in a query result — may be a plain name or a structured header. */
	type KustoResultsColumn = string | { name: string; columnName?: string; type?: string };

	/** UI-augmented results state created by displayResultForBox and consumed by the results table, charts, export, etc. */
	interface KustoResultsState {
		boxId: string;
		columns: KustoResultsColumn[];
		rows: any[][];
		metadata?: Record<string, any>;
		selectedCell: { row: number; col: number } | null;
		cellSelectionAnchor: { row: number; col: number } | null;
		cellSelectionRange: { rowMin: number; rowMax: number; colMin: number; colMax: number; displayRowMin: number; displayRowMax: number } | null;
		selectedRows: Set<number>;
		searchMatches: { row: number; col: number }[];
		currentSearchIndex: number;
		sortSpec: { colIndex: number; dir: string }[];
		columnFilters: Record<string, any>;
		filteredRowIndices: number[] | null;
		displayRowIndices: number[] | null;
		rowIndexToDisplayIndex: number[] | null;
		/** Internal runtime fields (__kustoVirtual, __kustoVisualVersion, etc.) */
		[key: string]: any;
	}

	/** Connection descriptor passed from the extension host. */
	interface KustoConnectionInfo {
		id: string;
		name?: string;
		clusterUrl: string;
		database?: string;
	}

	/** Favorite (pinned cluster + database pair). */
	interface KustoFavoriteInfo {
		clusterUrl: string;
		database: string;
		name?: string;
		label?: string;
	}

	/** Per-box schema index (mirrors DatabaseSchemaIndex from the host). */
	interface KustoSchemaInfo {
		tables: string[];
		columnTypesByTable: Record<string, Record<string, string>>;
		tableDocStrings?: Record<string, string>;
		tableFolders?: Record<string, string>;
		columnDocStrings?: Record<string, string>;
		functions?: any[];
		rawSchemaJson?: unknown;
	}

	interface Window {
		// =====================================================================
		// state.ts (non-prefixed state variables — always defined after init)
		// =====================================================================
		connections: KustoConnectionInfo[];
		queryBoxes: any[];
		lastConnectionId: string | null;
		lastDatabase: string | null;
		cachedDatabases: Record<string, string[]>;
		kustoFavorites: KustoFavoriteInfo[];
		leaveNoTraceClusters: string[];
		favoritesModeByBoxId: Record<string, boolean>;
		pendingFavoriteSelectionByBoxId: Record<string, { clusterUrl: string; database: string }>;
		queryEditors: Record<string, any>;
		queryEditorResizeObservers: Record<string, any>;
		queryEditorVisibilityObservers: Record<string, any>;
		queryEditorVisibilityMutationObservers: Record<string, any>;
		queryEditorBoxByModelUri: Record<string, string>;
		activeQueryEditorBoxId: string | null;
		schemaByBoxId: Record<string, KustoSchemaInfo>;
		schemaFetchInFlightByBoxId: Record<string, boolean>;
		lastSchemaRequestAtByBoxId: Record<string, number>;
		monacoReadyPromise: Promise<void> | null;
		qualifyTablesInFlightByBoxId: Record<string, any>;
		schemaByConnDb: Record<string, KustoSchemaInfo>;
		schemaRequestResolversByBoxId: Record<string, any>;
		databasesRequestResolversByBoxId: Record<string, any>;
		missingClusterDetectTimersByBoxId: Record<string, any>;
		lastQueryTextByBoxId: Record<string, string>;
		missingClusterUrlsByBoxId: Record<string, string[]>;
		optimizationMetadataByBoxId: Record<string, any>;
		suggestedDatabaseByClusterKeyByBoxId: Record<string, any>;
		activeMonacoEditor: any;
		queryExecutionTimers: Record<string, any>;
		runModesByBoxId: Record<string, string>;
		caretDocsEnabled: boolean;
		caretDocOverlaysByBoxId: Record<string, any>;
		autoTriggerAutocompleteEnabled: boolean;
		copilotInlineCompletionsEnabled: boolean;
		copilotInlineCompletionRequests: Record<string, any>;
		__kustoHandleInlineCompletionResult?: (requestId: string, completions: any[]) => void;

		// =====================================================================
		// vscodeApi.js — VS Code API
		// =====================================================================
		vscode?: { postMessage(message: any): void; getState(): any; setState(state: any): void };

		// =====================================================================
		// queryEditor.html — config object injected by extension host
		// =====================================================================
		__kustoQueryEditorConfig?: {
			monacoVsUri?: string;
			monacoLoaderUri?: string;
			cacheBuster?: string;
			copilotLogoUri?: string;
			echartsUrl?: string;
			toastUiEditorUrl?: string;
			toastUiCssUrls?: string[];
		};
		MonacoEnvironment?: Record<string, any>;

		// =====================================================================
		// columnAnalysis.ts
		// =====================================================================
		__kustoActiveColumnMenu: { menu: HTMLElement | null; button: Element | null } | null;
		__kustoColumnMenuAutoCloseWired: boolean;

		showDistinctCountPicker: (colIdx: number, boxId: string) => void;
		calculateDistinctCount: (groupByColIdx: number, boxId: string) => void;
		closeColumnAnalysis: (event?: Event | null) => void;

		// =====================================================================
		// core/dropdown.ts (legacy)
		// =====================================================================
		__kustoDropdown: Record<string, any>;

		// =====================================================================
		// diffView.ts
		// =====================================================================
		__kustoDiffView: {
			buildModelFromResultsStates?: (stateA: KustoResultsState, stateB: KustoResultsState, labels?: any) => any;
			render?: (container: HTMLElement, model: any, options?: any) => void;
		};
		openDiffViewModal: (args: any) => void;
		closeDiffView: () => void;

		// =====================================================================
		// schema functions (relocated to queryBoxes.ts)
		// =====================================================================
		__kustoRequestSchema: (connectionId: string, database: string, forceRefresh?: boolean) => Promise<KustoSchemaInfo>;

		// =====================================================================
		// persistence.ts
		// =====================================================================
		schedulePersist: (reason?: string, immediate?: boolean) => void;
		handleDocumentDataMessage: (message: any) => void;
		__kustoOnQueryResult: (boxId: string, result: any) => void;
		__kustoRequestAddSection: (kind: string) => void;
		__kustoSetCompatibilityMode: (enabled: boolean) => void;
		__kustoApplyDocumentCapabilities: () => void;
		__kustoGetWrapperHeightPx: (boxId: string, suffix: string) => number | undefined;

		// =====================================================================
		// queryBoxes.ts
		// =====================================================================
		addQueryBox: (options?: any) => string;
		__kustoLog: (_boxId?: string, _event?: string, _message?: string, _data?: any, _level?: string) => void;
		fullyQualifyTablesInEditor: (boxId: string) => Promise<void>;
		__kustoIndexToAlphaName: (index: number) => string;
		__kustoGetUsedSectionNamesUpper: () => Set<string>;
		__kustoAutoSizeResults: (boxId: string) => void;
		__kustoUpdateQueryVisibilityToggleButton: (boxId: string) => void;
		__kustoApplyQueryBoxVisibility: (boxId: string) => void;
		toggleCachePill: (boxId: string) => void;
		toggleCachePopup: (boxId: string) => void;
		__kustoComparisonSummaryVisibleByBoxId?: Record<string, boolean>;

		// =====================================================================
		// queryBoxes.ts (connection/favorites — absorbed from queryBoxes-connection.ts)
		// =====================================================================
		__kustoGetConnectionId: (boxId: string) => string;
		__kustoGetDatabase: (boxId: string) => string;
		__kustoGetCurrentClusterUrlForBox: (boxId: string) => string;
		__kustoGetCurrentDatabaseForBox: (boxId: string) => string;
		__kustoGetQuerySectionElement: (boxId: string) => any;
		__kustoGetSectionName: (boxId: string) => string;
		__kustoSetSectionName: (boxId: string, name: string) => void;
		__kustoPickNextAvailableSectionLetterName: (excludeBoxId?: string) => string;
		__kustoUpdateRunEnabledForBox: (boxId: string) => void;
		__kustoSetAutoEnterFavoritesForBox: (boxId: string, clusterUrl: string, database: string) => void;
		__kustoSetFavoritesModeForBox: (boxId: string, enabled: boolean) => void;
		__kustoUpdateFavoritesUiForBox: (boxId: string) => void;
		__kustoUpdateFavoritesUiForAllBoxes: () => void;
		__kustoTryAutoEnterFavoritesModeForAllBoxes: () => void;
		__kustoFindFavorite: (clusterUrl: string, database: string) => KustoFavoriteInfo | null;
		__kustoMarkNewBoxForFavoritesAutoEnter: (boxId: string) => void;
		__kustoTryAutoEnterFavoritesModeForNewBox: (boxId: string) => void;
		__kustoIsRunSelectionReady: (boxId: string) => boolean;
		updateConnectionSelects: () => void;
		setConnectionId: (boxId: string, id: string) => void;
		setConnections: (boxId: string, connections: KustoConnectionInfo[], options?: any) => void;
		setDatabase: (boxId: string, database: string) => void;
		setDatabases: (boxId: string, databases: string[]) => void;
		setDatabasesLoading: (boxId: string, loading: boolean) => void;
		setDesiredClusterUrl: (boxId: string, url: string) => void;
		setDesiredDatabase: (boxId: string, database: string) => void;
		setRefreshLoading: (boxId: string, loading: boolean) => void;
		setFavorites: (boxId: string, favorites: KustoFavoriteInfo[]) => void;
		setFavoritesMode: (boxId: string, enabled: boolean) => void;
		addMissingClusterConnections: (boxId: string) => void;
		__kustoFavoriteKey: (clusterUrl: string, database: string) => string;
		__kustoGetFavoritesSorted: () => KustoFavoriteInfo[];
		__kustoTryAutoEnterFavoritesModeForBox: (boxId: string) => void;
		__kustoFindConnectionIdForClusterUrl: (clusterUrl: string) => string;
		__kustoTryApplyPendingFavoriteSelectionForBox: (boxId: string) => boolean;
		__kustoApplyFavoritesMode: (boxId: string, enabled: boolean) => void;

		// =====================================================================
		// sections/kw-query-toolbar.ts
		// =====================================================================
		initToolbarOverflow: (boxId: string) => void;
		setRunMode: (boxId: string, mode: string) => void;
		closeAllRunMenus: () => void;
		__kustoSetOptimizeInProgress: (boxId: string, inProgress: boolean, statusText: string) => void;
		__kustoUpdateOptimizeStatus: (boxId: string, statusText: string) => void;
		__kustoHideOptimizePromptForBox: (boxId: string) => void;
		__kustoSetLinkedOptimizationMode: (sourceBoxId: string, comparisonBoxId: string, active: boolean) => void;
		__kustoApplyOptimizeQueryOptions: (boxId: string, models: any[], selectedModelId: string, promptText: string) => void;
		updateCaretDocsToggleButtons: () => void;
		updateAutoTriggerAutocompleteToggleButtons: () => void;
		toggleAutoTriggerAutocompleteEnabled: () => void;
		updateCopilotInlineCompletionsToggleButtons: () => void;
		toggleCopilotInlineCompletionsEnabled: () => void;
		toggleCaretDocsEnabled: () => void;
		onQueryEditorToolbarAction: (boxId: string, action: string) => void;
		__kustoShareCopyToClipboard: () => void;
		__kustoApplyRunModeFromMenu: (boxId: string, mode: string) => void;
		getRunModeLabelText: (mode: string) => string;
		closeRunMenu: (boxId: string) => void;
		toggleRunMenu: (boxId: string) => void;

		// =====================================================================
		// queryBoxes-execution.ts
		// =====================================================================
		executeQuery: (boxId: string, mode?: string) => void;
		optimizeQueryWithCopilot: (boxId: string, query?: string, options?: any) => Promise<string>;
		displayResult: (result: any) => void;
		displayResultForBox: (result: any, boxId: string, options?: any) => void;
		displayError: (error: any) => void;
		displayCancelled: () => void;
		setQueryExecuting: (boxId: string, executing: boolean) => void;
		__kustoApplyComparisonSummaryVisibility: (boxId: string) => void;
		__kustoUpdateComparisonSummaryToggleButton: (boxId: string) => void;
		__kustoUpdateQueryResultsToggleButton?: (boxId: string) => void;
		__kustoApplyChartBoxVisibility?: (boxId: string, visible?: boolean) => void;
		__kustoApplyChartMode?: (boxId: string, mode?: string) => void;
		__kustoClampResultsWrapperHeight?: (boxId: string) => void;
		__kustoQueryExpandedByBoxId?: Record<string, boolean>;
		displayComparisonSummary: (sourceBoxId: string, comparisonBoxId: string) => void;
		toggleQueryResultsVisibility: (boxId: string) => void;
		toggleComparisonSummaryVisibility: (boxId: string) => void;
		__kustoOnResultsVisibilityToggled?: (boxId: string) => void;
		cancelQuery: (boxId: string) => void;
		formatElapsed: (ms: number) => string;
		acceptOptimizations: (comparisonBoxId: string) => void;
		__kustoLockCacheForBenchmark: (boxId: string) => void;
		__kustoNormalizeCellForComparison: (cell: any) => any;
		__kustoGetNormalizedColumnNameList: (state: KustoResultsState) => string[];
		__kustoDoColumnHeaderNamesMatch: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => boolean;
		__kustoGetColumnDifferences: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => { onlyInA: string[]; onlyInB: string[] };
		__kustoDoColumnOrderMatch: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => boolean;
		__kustoDoRowOrderMatch: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => boolean;
		__kustoBuildColumnIndexMapForNames: (state: KustoResultsState) => Map<string, number[]>;
		__kustoAreResultsEquivalentWithDetails: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => any;
		__kustoAreResultsEquivalent: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => boolean;
		__kustoDoResultHeadersMatch: (sourceState: KustoResultsState, comparisonState: KustoResultsState) => boolean;
		__kustoUpdateAcceptOptimizationsButton: (comparisonBoxId: string, enabled: boolean, tooltip: string) => void;
		__kustoIsValidConnectionIdForRun: (connectionId: string) => boolean;
		__kustoGetEffectiveSelectionOwnerIdForRun: (boxId: string) => string;
		__kustoHasValidFavoriteSelection: (ownerBoxId: string) => boolean;
		__kustoClearSchemaSummaryIfNoSelection: (boxId: string) => void;
		__kustoUpdateRunEnabledForAllBoxes: () => void;
		__kustoEnsureCacheBackupMap: () => Record<string, any>;
		__kustoBackupCacheSettings: (boxId: string) => void;
		__kustoRestoreCacheSettings: (boxId: string) => void;
		__kustoEnsureRunModeBackupMap: () => Record<string, any>;
		__kustoBackupRunMode: (boxId: string) => void;
		__kustoRestoreRunMode: (boxId: string) => void;
		__kustoEnsureOptimizePrepByBoxId: () => Record<string, any>;
		__kustoShowOptimizePromptLoading: (boxId: string) => void;
		__kustoCancelOptimizeQuery: (boxId: string) => void;
		__kustoRunOptimizeQueryWithOverrides: (boxId: string) => void;
		__kustoCacheBackupByBoxId?: Record<string, any>;
		__kustoRunModeBackupByBoxId?: Record<string, any>;
		__kustoOptimizePrepByBoxId?: Record<string, any>;

		// =====================================================================
		// resultsTable.ts
		// =====================================================================

		__kustoGetRawCellValueForChart: (cell: any) => any;
		__kustoNormalizeResultsColumnName: (col: KustoResultsColumn) => string;
		__kustoNormalizeColumnNameForComparison: (name: string) => string;
		__kustoBuildNameBasedColumnMapping: (state: KustoResultsState, names: string[]) => any;
		__kustoTryParseDateMs: (v: any) => number | null;
		__kustoApplyResultsVisibility: (boxId: string) => void;
		__kustoEnsureDisplayRowIndexMaps: (state: KustoResultsState) => void;
		__kustoSetSplitCaretsVisible: (boxId: string, filtered: boolean) => void;
		__kustoGetSaveIconSvg: () => string;
		__kustoGetScrollToColumnIconSvg: () => string;
		__kustoIsFilterSpecActive: (spec: any) => boolean;
		__kustoEnsureColumnFiltersMap: (state: KustoResultsState) => Record<string, any>;
		__kustoEnsureDragSelectionHandlers: (boxId: string) => void;
		__kustoFocusTableContainer: (container: HTMLElement | null, boxId: string) => void;
		__kustoUpdateSplitButtonState: (boxId: string) => void;

		__kustoCopyClientActivityId: (boxId: string) => void;
		__kustoEnsureResultsCopyKeyHandlerInstalled: () => void;
		__kustoGetSelectAllIconSvg: (size?: number) => string;
		__kustoGetDeselectAllIconSvg: (size?: number) => string;
		__kustoGetCloseIconSvg: (size?: number) => string;
		__kustoNormalizeSortSpec: (spec: any, columnCount: number) => any[];
		__kustoGetCellSortValue: (cell: any) => any;
		__kustoCompareSortValues: (a: any, b: any) => number;
		__kustoComputeSortedRowIndices: (rows: any[][], sortSpec: any[], baseIndices: number[]) => number[];
		__kustoFormatNumberForDisplay: (val: any) => string;
		__kustoFormatDateForDisplay: (dateStr: any) => string | null;
		__kustoIsNullOrEmpty: (val: any) => boolean;
		__kustoInferColumnType: (state: KustoResultsState, colIndex: number, rowIndicesForInference: number[]) => string;
		__kustoGetRowIndicesExcludingColumnFilter: (state: KustoResultsState, excludeColIndex: number) => number[];
		__kustoNormalizeStringForFilter: (val: any) => string;
		__kustoRowMatchesNullPolicy: (raw: any, spec: any) => boolean;
		__kustoRowMatchesColumnFilter: (state: KustoResultsState, rowIdx: number, colIndex: number, spec: any) => any;
		__kustoComputeUniqueValueKeys: (state: KustoResultsState, colIndex: number, rowIndices: number[]) => any;
		__kustoNormalizeDraftFilter: (state: KustoResultsState, colIndex: number, draft: any) => any;
		__kustoGetRulesCombineEnabledFromDom: (boxId: string) => boolean;
		__kustoSetRulesCombineEnabled: (boxId: string, enabled: boolean) => void;
		__kustoToggleRulesCombine: (boxId: string) => void;
		__kustoGetRulesJoinOpFromDom: (boxId: string) => string;
		__kustoSetRulesJoinOp: (boxId: string, joinOp: string) => void;
		__kustoApplyFiltersAndRerender: (boxId: string) => void;
		closeColumnFilterDialogOnBackdrop: (event: Event) => void;
		__kustoEnsureFilterGlobalCloseHandler: () => void;
		openColumnFilter: (event: Event, colIndex: number, boxId: string) => void;
		__kustoEnsureFilterPopoverSearchControl: (boxId: string, colIdx: number) => void;

		__kustoFilterSearchValues: (boxId: string, colIdx: number) => void;
		__kustoFilterSetAllValues: (boxId: string, colIdx: number, checked: boolean) => void;
		__kustoGetValuesAllowedFromSpec: (spec: any) => any[] | null;
		__kustoGetRulesSpecFromExisting: (existing: any, dataType: string) => any;
		__kustoRenderRulesListHtml: (boxId: string, colIdx: number, dataType: string, existing: any) => string;
		__kustoGetRuleOpsForType: (dataType: string) => any[];
		__kustoRenderRuleRowInputsHtml: (boxId: string, dataType: string, rule: any) => string;
		__kustoCaptureRulesFromDom: (boxId: string) => any[];
		__kustoSetRuleJoin: (boxId: string, colIdx: number, ruleIdx: number, joinOp: string) => void;
		__kustoOnRuleRowOpChanged: (boxId: string, colIdx: number, ruleIdx: number) => void;
		__kustoDeleteRuleRow: (boxId: string, colIdx: number, ruleIdx: number) => void;
		__kustoRenderRulesEditorHtml: (boxId: string, colIdx: number, dataType: string, existing: any) => string;
		__kustoToDateTimeLocalValue: (isoOrRaw: any) => string;
		__kustoFromDateTimeLocalValue: (v: any) => string;
		__kustoSetFilterMode: (boxId: string, colIdx: number, mode: string) => void;
		__kustoOnFilterOpChanged: (boxId: string, colIdx: number) => void;
		__kustoFilterToggleAllValues: (boxId: string, colIdx: number) => void;
		applyColumnFilter: (boxId: string, colIdx: number) => void;
		clearColumnFilter: (boxId: string, colIdx: number) => void;
		__kustoSetSortSpecAndRerender: (boxId: string, nextSpec: any) => void;
		__kustoGetSortRuleIndex: (state: KustoResultsState, colIndex: number) => number;
		handleHeaderSortClick: (event: Event, colIndex: number, boxId: string) => void;
		sortColumnAscending: (colIndex: number, boxId: string) => void;
		sortColumnDescending: (colIndex: number, boxId: string) => void;
		toggleSortDialog: (boxId: string) => void;
		closeSortDialogOnBackdrop: (event: Event, boxId: string) => void;

		__kustoAddSortRuleInline: (boxId: string) => void;
		__kustoWireSortDialogDnD: (boxId: string) => void;
		__kustoMoveSortRule: (boxId: string, fromIdx: number, toIdx: number) => void;
		addSortRule: (boxId: string) => void;
		clearSort: (boxId: string) => void;
		updateSortRuleColumn: (ruleIndex: number, value: string, boxId: string) => void;
		updateSortRuleDirection: (ruleIndex: number, value: string, boxId: string) => void;
		moveSortRuleUp: (ruleIndex: number, boxId: string) => void;
		moveSortRuleDown: (ruleIndex: number, boxId: string) => void;
		removeSortRule: (ruleIndex: number, boxId: string) => void;
		__kustoTryGetDomEventFromInlineHandler: (explicitEvent: any) => any;
		toggleRowSelection: (row: number, boxId: string) => void;
		__kustoUpdateResultsToolsDropdownState: (boxId: string) => void;
		__kustoResultsToolsDropdownAction: (boxId: string, action: string) => void;
		__kustoToggleResultsToolsDropdown: (boxId: string) => void;
		__kustoCloseResultsToolsDropdown: (boxId: string) => void;
		__kustoCloseAllResultsToolsDropdowns: () => void;

		toggleColumnTool: (boxId: string) => void;
		highlightCurrentSearchMatch: (boxId: string) => void;
		handleTableKeydown: (event: KeyboardEvent, boxId: string) => void;
		updateAutocompleteSelection: (items: any) => void;
		scrollToColumn: (colIndex: number, boxId: string) => void;

		// =====================================================================
		// resultsTable-render.ts
		// =====================================================================
		__kustoResolveVirtualScrollElement: (containerEl: any) => any;
		__kustoResolveScrollSourceForEvent: (ev: any, containerEl: any) => any;
		__kustoGetVirtualScrollMetrics: (scrollEl: HTMLElement, containerEl: HTMLElement) => { scrollTop: number; clientH: number };

		__kustoEnsureResultsSearchControls: (boxId: string) => void;
		__kustoRenderActivityIdInlineHtml: (boxId: string, clientActivityId: string) => string;
		__kustoRenderErrorUxHtml: (boxId: string, model: any, clientActivityId: string) => string;

		// =====================================================================
		// resultsTable-export.ts
		// =====================================================================
		__kustoGetResultsVisibilityIconSvg: () => string;
		__kustoGetFilterIconSvg: (size?: number) => string;
		__kustoEscapeJsStringLiteral: (s: string) => string;
		__kustoEscapeForHtmlAttribute: (s: string) => string;
		__kustoEscapeForHtml: (s: string) => string;
		__kustoSplitMenuEl: HTMLElement | null;
		__kustoContextMenuEl: HTMLElement | null;

		__kustoGetAllResultsAsCsv: (boxId: string) => string;
		__kustoGetResultsAsCsv: (boxId: string, mode: string) => string;
		__kustoMakeSafeCsvFileNameFromLabel: (label: string) => string;

		saveVisibleResultsToCsvFile: (boxId: string, sectionLabel: string) => void;
		__kustoOnSaveSecondary: (boxId: string, sectionLabel: string) => void;
		__kustoHideSplitMenu: () => void;
		__kustoShowSplitMenu: (anchorEl: HTMLElement, label: string, onClick: () => void) => void;
		__kustoShowSplitMenuItems: (anchorEl: HTMLElement, items: any[]) => void;
		__kustoOnSaveMenu: (boxId: string, sectionLabel: string, anchor: HTMLElement) => void;
		__kustoRemoveDragSelectionHandlers: (boxId: string) => void;
		copyVisibleResultsToClipboard: (boxId: string) => void;
		copyAllResultsToClipboard: (boxId: string) => void;
		__kustoCopyResultsToClipboard: (boxId: string, mode: string) => void;
		__kustoOnCopySecondary: (boxId: string) => void;
		__kustoOnCopyMenu: (boxId: string, anchor: HTMLElement) => void;
		__kustoHideContextMenu: () => void;
		handleTableContextMenu: (event: MouseEvent, boxId: string) => void;
		__kustoCopyTextToClipboard: (text: string) => void;
		__kustoGetDisplayRowsInRange: (state: KustoResultsState, displayRowMin: number, displayRowMax: number) => any[];
		__kustoCellToClipboardString: (cell: any) => string;
		__kustoCellToCsvString: (cell: any) => string;

		// =====================================================================
		// monaco.ts
		// =====================================================================
		__kustoFunctionDocs: Record<string, any>;
		__kustoSetMonacoKustoSchema: (rawSchemaJson: any, clusterUrl: string, database: string, setAsContext?: boolean, modelUri?: string, forceRefresh?: boolean) => Promise<void>;
		__kustoUpdateSchemaForFocusedBox: (boxId: string, enableMarkers?: boolean) => Promise<void>;
		__kustoApplyCrossClusterSchema: (clusterName: string, clusterUrl: string, database: string, rawSchemaJson: any) => Promise<void>;
		__kustoTriggerRevalidation: (boxId: string) => void;
		__kustoGetStatementBlocksFromModel: (model: any) => any[];
		__kustoExtractStatementTextAtCursor: (editor: any) => string | null;
		__kustoAutoFindInQueryEditor: (boxId: string, term: string) => Promise<boolean>;
		__kustoClearAutoFindInQueryEditor: (boxId: string) => void;
		__kustoTriggerAutocompleteForBoxId: (boxId: string) => void;
		__kustoSingleLineQueryForBoxId: (boxId: string) => void;
		__kustoPrettifyQueryForBoxId: (boxId: string) => void;
		__kustoPrettifyKustoText: (text: string) => string;
		__kustoCopySingleLineQueryForBoxId: (boxId: string) => Promise<void>;
		__kustoCopyOrCutMonacoEditor: (editor: any, isCut: boolean) => Promise<boolean>;
		__kustoRefreshActiveCaretDocs: () => void;
		__kustoOnQueryValueChanged: (boxId: string, queryText: string) => void;
		__kustoPreloadMonaco: boolean;
		__kustoGetSelectionOwnerBoxId: (boxId: string) => string;
		ensureMonaco: () => Promise<any>;
		initQueryEditor: (boxId: string, container?: HTMLElement) => Promise<void>;
		__kustoGetColumnsByTable?: (boxId?: string) => Record<string, string[]>;
		__kustoAutoTriggerAutocompleteEnabledUserSet: boolean;
		__kustoCaretDocsEnabledUserSet: boolean;
		__kustoCopilotInlineCompletionsEnabledUserSet: boolean;
		__kustoSuggestDebug: (mode?: string) => void;
		__kustoDiagLog: (...args: any[]) => void;
		__kustoControlCommandEntries: any;
		__kustoFunctionEntries: any;
		__kustoEditors: Record<string, any>;

		// =====================================================================
		// monaco-suggest.ts
		// =====================================================================
		__kustoSuggestWidgetScrollDismissInstalled: boolean;
		__kustoSuggestWidgetViewportListenersInstalled: boolean;
		__kustoClampAllSuggestWidgets: () => void;

		// =====================================================================
		// monaco-writable.ts
		// =====================================================================
		__kustoNormalizeTextareasWritable: (root?: any) => void;
		__kustoEnsureAllEditorsWritableSoon: () => void;

		// =====================================================================
		// monaco-resize.ts
		// =====================================================================



		// =====================================================================
		// main.ts
		// =====================================================================
		markdownBoxes: any[];
		pythonBoxes: any[];
		urlBoxes: any[];
		addMarkdownBox: (options?: any) => string;
		addChartBox: (options?: any) => string;
		addTransformationBox: (options?: any) => string;
		addUrlBox: (options?: any) => string;
		addPythonBox: (options?: any) => string;
		addHtmlBox: (options?: any) => string;
		onPythonResult: (message: any) => void;
		onPythonError: (message: any) => void;
		__kustoGetFocusedMonacoEditor: () => any | null;
		__kustoGetSelectionOrCurrentLineRange: (editor: any) => any;
		__kustoCopyOrCutFocusedMonaco: (eventOrIsCut?: any, isCut?: any) => Promise<boolean>;
		__kustoCopyOrCutMonacoEditorImpl: (editor: any, eventOrNull?: any, isCut?: any) => Promise<boolean>;
		__kustoToggleAddSectionDropdown: (event?: any) => void;
		__kustoAddSectionFromDropdown: (sectionType: string) => void;
		__kustoUpdateAddSectionDropdownVisibility: () => void;
		__kustoWheelPassthroughInstalled?: boolean;
		closeColumnFilterPopover?: () => void;
		closeSortDialog?: (boxId?: string) => void;
		__kustoCloseShareModal?: () => void;
		__kustoEnterFavoritesModeForBox?: (boxId: string) => void;
		__kustoOnConfirmRemoveFavoriteResult?: (message: any) => void;
		__kustoMaybeDefaultFirstBoxToFavoritesMode?: () => void;
		__kustoOnConnectionsUpdated?: () => void;
		__kustoPendingChartConfig?: Record<string, any>;
		__kustoPendingTransformationConfig?: Record<string, any>;
		__kustoDevNotesEnabled?: boolean;
		__kustoRequestKqlTableReferences?: (args: any) => Promise<any>;

		// =====================================================================
		// Copilot chat — thin bridges (logic in kw-query-section.ts)
		// =====================================================================
		__kustoToggleCopilotChatForBox: (boxId: string) => void;
		addCopilotQueryBox: (options?: any) => string;

		// =====================================================================
		// extraBoxes.ts
		// =====================================================================
		__kustoPythonBoxes: any[];
		__kustoUrlBoxes: any[];
		__kustoHtmlBoxes: any[];
		__kustoMarkdownEditors: Record<string, any>;
		markdownEditors: Record<string, any>;
		pythonEditors: Record<string, any>;
		__kustoPythonEditors: Record<string, any>;
		chartStateByBoxId: Record<string, any>;
		transformationStateByBoxId: Record<string, any>;
		__kustoConfigureChartFromTool: (boxId: string, config: any) => any;
		__kustoConfigureChart: (boxId: string, config: any) => any;
		__kustoCellToChartString: (cell: any) => string;
		__kustoCellToChartNumber: (cell: any) => number | null;
		__kustoCellToChartTimeMs: (cell: any) => number | null;
		__kustoInferTimeXAxisFromRows: (rows: any[], xIndex: number) => boolean;
		__kustoSetSelectOptions: (selectEl: HTMLElement | null, values: string[], selectedValue: string, labelMap?: Record<string, string>) => void;
		__kustoPickFirstNonEmpty: (arr: any[]) => any;
		__kustoToggleSectionModeDropdown: (boxId: string) => void;
		__kustoCloseSectionModeDropdown: (boxId: string) => void;
		__kustoUpdateSectionModeResponsive: (boxId: string) => void;
		__kustoCleanupSectionModeResizeObserver: (boxId: string) => void;
		removePythonBox: (boxId: string) => void;
		removeUrlBox: (boxId: string) => void;
		removeHtmlBox: (boxId: string) => void;
		__kustoRefreshDependentExtraBoxes?: (boxId: string) => void;

		// =====================================================================
		// extraBoxes-chart.ts
		// =====================================================================
		__kustoChartBoxes: any[];
		removeChartBox: (boxId: string) => void;
		__kustoGetChartState: (boxId: string) => any;

		// =====================================================================
		// extraBoxes-markdown.ts (thin bridge module)
		// =====================================================================
		__kustoMarkdownBoxes: any[];
		removeMarkdownBox: (boxId: string) => void;
		getToastUiPlugins: (ToastEditor: any) => any[];
		__kustoSetMarkdownMode: (boxId: string, mode: string) => void;
		__kustoApplyMarkdownEditorMode: (boxId: string) => void;
		__kustoMaximizeMarkdownBox: (boxId: string) => void;
		__kustoRevealTextRangeFromHost?: (message: any) => void;


		// =====================================================================
		// extraBoxes-transformation.ts
		// =====================================================================
		__kustoTransformationBoxes: any[];
		__kustoNotifyResultsUpdated: (boxId: string) => void;
		__kustoConfigureTransformation: (boxId: string, config: any) => any;
		__kustoRenderTransformation: (boxId: string) => void;

		// =====================================================================
		// extraBoxes-markdown.ts (state — lazy-initialized)
		// =====================================================================
		__kustoMarkdownModeByBoxId?: Record<string, string>;
		__kustoMarkdownExpandedByBoxId?: Record<string, boolean>;

		// =====================================================================
		// main.ts (additional)
		// =====================================================================
		__kustoResolveResourceUri?: (args: any) => Promise<string | null>;

		// =====================================================================
		// sections/kw-chart-section.ts
		// =====================================================================
		__kustoUpdateChartBuilderUI: (boxId: any) => void;

		// =====================================================================
		// sections/kw-markdown-section.ts
		// =====================================================================
		__kustoApplyToastUiThemeAll: () => void;

		// =====================================================================
		// sections/kw-transformation-section.ts
		// =====================================================================
		__kustoUpdateTransformationBuilderUI: (boxId: any) => void;
		__kustoGetTransformationState: (boxId: any) => any;

		// =====================================================================
		// Browser APIs not in lib.dom.d.ts
		// =====================================================================
		find?: (...args: any[]) => boolean;

		// =====================================================================
		// Third-party globals (set by external scripts)
		// =====================================================================
		echarts?: any;
		marked?: any;
		toastui?: any;
		DOMPurify?: any;

		// =====================================================================
		// Late-bound / optional bridges (added by various modules at runtime)
		// =====================================================================
		setQueryBoxes?: (ids: string[]) => void;
		__kustoRefreshAllDataSourceDropdowns?: () => void;
	}
}

export {};
