/**
 * Type declarations for all window bridge functions and state variables
 * exposed by webview modules (src/webview/modules/*.ts).
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
		suggestDebounceTimers: Record<string, any>;
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
		currentMonacoKustoSchemaKey: string | null;

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
			monacoWorkers?: Record<string, string>;
			cacheBuster?: string;
			copilotLogoUri?: string;
			monacoEditorWorkerUri?: string;
		};
		MonacoEnvironment?: Record<string, any>;

		// =====================================================================
		// utils.ts
		// =====================================================================
		escapeHtml: (str: string) => string;
		escapeRegex: (str: string) => string;
		__kustoGetScrollY: () => number;
		__kustoMaybeAutoScrollWhileDragging: (clientY: number, options?: any) => number;

		// =====================================================================
		// cellViewer.ts
		// =====================================================================
		__kustoCellViewerState: any;
		openCellViewer: (row: number, col: number, boxId: string) => void;
		closeCellViewer: () => void;
		handleCellDoubleClick: (event: Event, row: number, col: number, boxId: string) => void;
		copyCellViewerToClipboard: () => void;
		searchInCellViewer: (query: string) => void;
		cellViewerNavigateMatch: (delta: number) => void;
		cellViewerNextMatch: () => void;
		cellViewerPreviousMatch: () => void;
		handleCellViewerKeydown: (e: KeyboardEvent) => void;

		// =====================================================================
		// columnAnalysis.ts
		// =====================================================================
		__kustoActiveColumnMenu: { menu: HTMLElement | null; button: Element | null } | null;
		__kustoColumnMenuAutoCloseWired: boolean;

		showDistinctCountPicker: (colIdx: number, boxId: string) => void;
		calculateDistinctCount: (groupByColIdx: number, boxId: string) => void;
		closeColumnAnalysis: (event: Event | null) => void;

		// =====================================================================
		// objectViewer.ts
		// =====================================================================
		__kustoObjectViewerState: any;
		__kustoObjectViewerRawVisible: boolean;
		currentObjectViewerData: any;
		openObjectViewer: (row: number, col: number, boxId: string) => void;
		closeObjectViewer: () => void;
		copyObjectViewerRawToClipboard: () => void;
		toggleObjectViewerRaw: () => void;
		objectViewerNavigateBack: () => void;
		objectViewerNavigateToDepth: (depth: number) => void;
		objectViewerNavigateInto: (prop: string) => void;
		searchInObjectViewer: (query: string) => void;
		formatJson: (text: string) => string;
		syntaxHighlightJson: (json: string) => string;
		highlightSearchTerm: (html: string, term: string) => string;
		__kustoGetCopyIconSvg: (size?: number) => string;
		__kustoWriteTextToClipboard: (text: string) => void;
		__kustoParseMaybeJson: (text: string) => any;

		// =====================================================================
		// searchControl.ts
		// =====================================================================
		__kustoGetSearchIconSvg: () => string;
		__kustoCreateSearchControl: (hostEl: HTMLElement | null, options?: any) => void;
		__kustoGetSearchControlState: (inputId: string, modeId: string) => { query: string; mode: string };
		__kustoTryBuildSearchRegex: (query: string, mode: string) => { regex: RegExp | null; error: string | null; mode: string };
		__kustoRegexTest: (regex: RegExp | null, text: string) => boolean;
		__kustoCountRegexMatches: (regex: RegExp | null, text: string, maxMatches?: number) => number;
		__kustoHighlightPlainTextToHtml: (text: string, regex: RegExp | null, options?: any) => { html: string; count: number };
		__kustoHighlightElementTextNodes: (rootEl: HTMLElement | null, regex: RegExp | null, highlightClass?: string) => number;
		__kustoUpdateSearchModeToggle: (btn: HTMLElement | null, mode: string) => void;
		__kustoUpdateSearchStatus: (statusEl: HTMLElement | null, matchCount: number, currentMatchIndex: number, hasError: boolean, errorMsg?: string) => void;
		__kustoSetSearchNavEnabled: (prevBtn: HTMLButtonElement | null, nextBtn: HTMLButtonElement | null, enabled: boolean, matchCount: number) => void;

		// =====================================================================
		// dropdown.ts
		// =====================================================================
		__kustoDropdown: {
			getChevronDownSvg: () => string;
			renderSelectHtml: (opts: any) => string;
			renderMenuDropdownHtml: (opts: any) => string;
			renderMenuItemsHtml: (items: any[], opts: any) => string;
			closeAllMenus: () => void;
			closeMenuDropdown: (buttonId: string, menuId: string) => void;
			toggleMenuDropdown: (opts: any) => void;
			wireCloseOnFocusOut: (buttonEl: HTMLElement, menuEl: HTMLElement) => void;
			wireMenuInteractions: (menuEl: HTMLElement) => void;
			syncSelectBackedDropdown: (selectId: string) => void;
			selectFromMenu: (selectId: string, keyEnc: string) => void;
			toggleSelectMenu: (selectId: string) => void;
			renderCheckboxDropdownHtml: (opts: any) => string;
			renderCheckboxItemsHtml: (items: any[], opts: any) => string;
			getCheckboxSelections: (menuId: string) => string[];
			updateCheckboxButtonText: (buttonTextId: string, selectedValues: string[], placeholder: string) => void;
			toggleCheckboxMenu: (buttonId: string, menuId: string) => void;
		};

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
		// schema.ts
		// =====================================================================
		setSchemaLoading: (boxId: string, loading: boolean) => void;
		setSchemaLoadedSummary: (boxId: string, text: string, title: string, isError: boolean, meta?: any) => void;
		ensureSchemaForBox: (boxId: string, forceRefresh?: boolean) => void;
		onDatabaseChanged: (boxId: string) => void;
		refreshSchema: (boxId: string) => void;
		__kustoRequestSchema: (connectionId: string, database: string, forceRefresh?: boolean) => Promise<KustoSchemaInfo>;
		__kustoRequestDatabases: (connectionId: string, forceRefresh?: boolean) => Promise<string[]>;
		__kustoSchemaRequestTokenByBoxId: Record<string, any>;

		// =====================================================================
		// persistence.ts
		// =====================================================================
		schedulePersist: (reason?: string, immediate?: boolean) => void;
		getKqlxState: () => any;
		handleDocumentDataMessage: (message: any) => void;
		__kustoOnQueryResult: (boxId: string, result: any) => void;
		__kustoTryStoreQueryResult: (boxId: string, result: any) => void;
		__kustoRequestAddSection: (kind: string) => void;
		__kustoSetCompatibilityMode: (enabled: boolean) => void;
		__kustoApplyDocumentCapabilities: () => void;
		__kustoNormalizeClusterUrl: (url: string) => string;
		__kustoIsLeaveNoTraceCluster: (clusterUrl: string) => boolean;
		__kustoSetWrapperHeightPx: (boxId: string, suffix: string, heightPx: number) => void;
		__kustoGetWrapperHeightPx: (boxId: string, suffix: string) => number | undefined;
		__kustoGetQueryResultsOutputHeightPx: (boxId: string) => number | undefined;
		__kustoSetQueryResultsOutputHeightPx: (boxId: string, heightPx: number) => void;
		__kustoCompatibilityMode: boolean;
		__kustoCompatibilitySingleKind: string | null;
		__kustoCompatibilityTooltip: string | null;
		__kustoIsSessionFile: boolean;
		__kustoDocumentKind: string;
		__kustoAllowedSectionKinds: string[] | null;
		__kustoDefaultSectionKind: string | null;
		__kustoDevNotesSections: any[];
		__kustoPendingQueryTextByBoxId: Record<string, string>;
		__kustoPendingMarkdownTextByBoxId: Record<string, string>;
		__kustoPendingPythonCodeByBoxId: Record<string, string>;
		__kustoPendingWrapperHeightPxByBoxId: Record<string, number>;
		__kustoQueryResultJsonByBoxId: Record<string, any>;
		__kustoQueryExpandedByBoxId: Record<string, boolean>;
		__kustoQueryEditorPendingAdds: any[];
		__kustoLastRunCacheEnabledByBoxId: Record<string, boolean>;
		__kustoUpgradeRequestType: string | null;
		__kustoResultsVisibleByBoxId: Record<string, boolean>;

		// =====================================================================
		// queryBoxes.ts
		// =====================================================================
		addQueryBox: (options?: any) => string;
		removeQueryBox: (boxId: string) => void;
		toggleQueryBoxVisibility: (boxId: string) => void;
		__kustoMaximizeQueryBox: (boxId: string) => void;
		__kustoManualQueryEditorHeightPxByBoxId: Record<string, number>;
		__kustoLog: (_boxId?: string, _event?: string, _message?: string, _data?: any, _level?: string) => void;
		fullyQualifyTablesInEditor: (boxId: string) => Promise<void>;
		toggleCacheControls: (boxId: string) => void;
		qualifyTablesInTextPriority: (text: string, boxId: string) => string;
		qualifyTablesInText: (text: string, boxId: string) => string;
		__kustoIndexToAlphaName: (index: number) => string;
		__kustoGetUsedSectionNamesUpper: () => Set<string>;
		__kustoAutoSizeResults: (boxId: string) => void;
		__kustoUpdateQueryVisibilityToggleButton: (boxId: string) => void;
		__kustoApplyQueryBoxVisibility: (boxId: string) => void;
		toggleCachePill: (boxId: string) => void;
		toggleCachePopup: (boxId: string) => void;
		__kustoComparisonSummaryVisibleByBoxId?: Record<string, boolean>;

		// =====================================================================
		// queryBoxes-connection.ts
		// =====================================================================
		formatClusterDisplayName: (connection: KustoConnectionInfo) => string;
		formatClusterShortName: (clusterUrl: string) => string;
		promptAddConnectionFromDropdown: (boxId: string) => void;
		importConnectionsFromXmlFile: (boxId: string) => void;
		__kustoGetConnectionId: (boxId: string) => string;
		__kustoGetDatabase: (boxId: string) => string;
		__kustoGetClusterUrl: (boxId: string) => string;
		__kustoGetCurrentClusterUrlForBox: (boxId: string) => string;
		__kustoGetCurrentDatabaseForBox: (boxId: string) => string;
		__kustoGetQuerySectionElement: (boxId: string) => any;
		__kustoGetSectionName: (boxId: string) => string;
		__kustoSetSectionName: (boxId: string, name: string) => void;
		__kustoPickNextAvailableSectionLetterName: (excludeBoxId?: string) => string;
		__kustoEnsureSectionHasDefaultNameIfMissing: (boxId: string) => string;
		__kustoUpdateRunEnabledForBox: (boxId: string) => void;
		__kustoSetAutoEnterFavoritesForBox: (boxId: string, clusterUrl: string, database: string) => void;
		__kustoSetFavoritesModeForBox: (boxId: string, enabled: boolean) => void;
		__kustoUpdateFavoritesUiForBox: (boxId: string) => void;
		__kustoUpdateFavoritesUiForAllBoxes: () => void;
		__kustoTryAutoEnterFavoritesModeForAllBoxes: () => void;
		__kustoFindFavorite: (clusterUrl: string, database: string) => KustoFavoriteInfo | null;
		__kustoRestoreInProgress: boolean;
		__kustoMarkNewBoxForFavoritesAutoEnter: (boxId: string) => void;
		__kustoTryAutoEnterFavoritesModeForNewBox: (boxId: string) => void;
		__kustoIsRunSelectionReady: (boxId: string) => boolean;
		closeAllFavoritesDropdowns: () => void;
		toggleFavoriteForBox: (boxId: string) => void;
		removeFavorite: (clusterUrl: string, database: string) => void;
		refreshDatabases: (boxId: string) => void;
		updateConnectionSelects: () => void;
		updateDatabaseSelect: (boxId: string, databases: string[], responseConnectionId: string) => void;
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
		setSectionName: (boxId: string, name: string) => void;
		normalizeClusterUrlKey: (url: string) => string;
		clusterShortNameKey: (clusterUrl: string) => string;
		extractClusterUrlsFromQueryText: (queryText: string) => string[];
		extractClusterDatabaseHintsFromQueryText: (queryText: string) => Record<string, string>;
		computeMissingClusterUrls: (detectedClusterUrls: string[]) => string[];
		renderMissingClustersBanner: (boxId: string, missingClusterUrls: string[]) => void;
		updateMissingClustersForBox: (boxId: string, queryText: string) => void;
		updateDatabaseField: (boxId: string) => void;
		addMissingClusterConnections: (boxId: string) => void;
		getChildText: (node: Element, localName: string) => string;
		parseKustoConnectionString: (cs: string) => { dataSource: string; initialCatalog: string };
		__kustoFavoriteKey: (clusterUrl: string, database: string) => string;
		__kustoGetFavoritesSorted: () => KustoFavoriteInfo[];
		__kustoTryAutoEnterFavoritesModeForBox: (boxId: string) => void;
		__kustoFindConnectionIdForClusterUrl: (clusterUrl: string) => string;
		__kustoTryApplyPendingFavoriteSelectionForBox: (boxId: string) => boolean;
		__kustoSetElementDisplay: (el: HTMLElement | null, display: string) => void;
		__kustoApplyFavoritesMode: (boxId: string, enabled: boolean) => void;
		__kustoClearDatabaseLoadError: (boxId: string) => void;

		// =====================================================================
		// queryBoxes-toolbar.ts
		// =====================================================================
		initToolbarOverflow: (boxId: string) => void;
		getRunMode: (boxId: string) => string;
		setRunMode: (boxId: string, mode: string) => void;
		closeAllRunMenus: () => void;
		__kustoGetLastOptimizeModelId: () => string;
		__kustoSetLastOptimizeModelId: (modelId: string) => void;
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
		copyQueryAsAdeLink: (boxId: string) => void;
		__kustoShareCopyToClipboard: () => void;
		setToolbarActionBusy: (boxId: string, action: string, busy: boolean) => void;
		closeToolsDropdown: (boxId: string) => void;
		initRunButtonResponsive: (boxId: string) => void;
		updateRunButtonResponsive: (boxId: string) => void;
		updateToolbarOverflow: (boxId: string) => void;
		toggleToolbarOverflow: (boxId: string) => void;
		toggleOverflowSubmenu: (element: HTMLElement, event: Event) => void;
		closeToolbarOverflow: (boxId: string) => void;
		closeAllToolbarOverflowMenus: () => void;
		renderToolbarOverflowMenu: (boxId: string) => void;
		toggleToolsDropdown: (boxId: string) => void;
		renderToolsMenuForBox: (boxId: string) => void;
		runMonacoAction: (boxId: string, actionId: string) => void;
		replaceAllInEditor: (boxId: string, from: string, to: string) => void;
		exportQueryToPowerBI: (boxId: string) => Promise<void>;
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
		lastExecutedBox: string | null;
		__kustoSetResultsToolsVisible: (boxId: string, visible: boolean) => void;
		__kustoHideResultsTools: (boxId: string) => void;
		__kustoApplyComparisonSummaryVisibility: (boxId: string) => void;
		__kustoUpdateComparisonSummaryToggleButton: (boxId: string) => void;
		displayComparisonSummary: (sourceBoxId: string, comparisonBoxId: string) => void;
		toggleQueryResultsVisibility: (boxId: string) => void;
		toggleComparisonSummaryVisibility: (boxId: string) => void;
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
		__kustoGetResultsState: (boxId: string) => KustoResultsState | null;

		__kustoGetRawCellValue: (cell: any) => any;
		__kustoGetRawCellValueForChart: (cell: any) => any;
		__kustoNormalizeResultsColumnName: (col: KustoResultsColumn) => string;
		__kustoNormalizeColumnNameForComparison: (name: string) => string;
		__kustoBuildNameBasedColumnMapping: (state: KustoResultsState, names: string[]) => any;
		__kustoTryParseNumber: (v: any) => number | null;
		__kustoTryParseDateMs: (v: any) => number | null;
		__kustoSetResultsVisible: (boxId: string, visible: boolean) => void;
		__kustoApplyResultsVisibility: (boxId: string) => void;
		__kustoEnsureResultsShownForTool: (boxId: string) => void;
		__kustoEnsureDisplayRowIndexMaps: (state: KustoResultsState) => void;
		__kustoSetSplitCaretsVisible: (boxId: string, filtered: boolean) => void;
		__kustoFormatCellDisplayValueForTable: (cell: any) => string;
		__kustoUpdateQueryResultsToggleButton: (boxId: string) => void;
		__kustoNotifyResultsUpdated: (boxId: string) => void;
		__kustoClampResultsWrapperHeight: (boxId: string) => void;
		__kustoNavigateToQueryLocation: (event: Event, boxId: string, lineNumber: number, column: number) => void;
		__kustoRenderErrorUx: (boxId: string, error: any, clientActivityId?: string) => void;
		__kustoActiveFilterPopover: any;
		__kustoFilterGlobalCloseHandlerInstalled: boolean;
		__kustoLastActiveResultsBoxId: string;
		__kustoLastActiveResultsInteractionAt: number;
		__kustoResultsCopyKeyHandlerInstalled: boolean;
		__kustoResultsByBoxId: Record<string, KustoResultsState>;
		currentResult: any;
		currentAutocompleteIndex: number;
		__kustoSortDnD: { boxId: string | null; fromIdx: number; dragEnabled: boolean };
		__kustoErrorLocationClickHandlerInstalled: boolean;
		__kustoClampInt: (value: number, min: number, max: number) => number;
		__kustoSetCellSelectionState: (boxId: string, state: KustoResultsState, nextRow: number, nextCol: number, options?: any) => void;
		__kustoNormalizeSortDirection: (dir: string) => string;
		__kustoGetSortIconSvg: () => string;
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

		__kustoEnsureResultsStateMap: () => Record<string, KustoResultsState>;
		__kustoEnsureResultsSearchControls: (boxId: string) => void;
		__kustoTryExtractJsonFromErrorText: (raw: any) => any;
		__kustoExtractLinePosition: (text: string) => { line: number; col: number; token: string } | null;
		__kustoNormalizeBadRequestInnerMessage: (msg: string) => string;
		__kustoStripLinePositionTokens: (text: string) => string;
		__kustoTryExtractAutoFindTermFromMessage: (message: string) => string | null;
		__kustoBuildErrorUxModel: (rawError: any) => any;
		__kustoMaybeAdjustLocationForCacheLine: (boxId: string, location: any) => any;
		__kustoRenderActivityIdInlineHtml: (boxId: string, clientActivityId: string) => string;
		__kustoRenderErrorUxHtml: (boxId: string, model: any, clientActivityId: string) => string;

		// =====================================================================
		// resultsTable-export.ts
		// =====================================================================
		__kustoGetResultsVisibilityIconSvg: () => string;
		__kustoGetFilterIconSvg: (size?: number) => string;
		__kustoGetTrashIconSvg: (size?: number) => string;
		__kustoEscapeJsStringLiteral: (s: string) => string;
		__kustoEscapeForHtmlAttribute: (s: string) => string;
		__kustoEscapeForHtml: (s: string) => string;
		__kustoSplitMenuEl: HTMLElement | null;
		__kustoContextMenuEl: HTMLElement | null;
		__kustoOpenShareModal: (boxId: string) => void;

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
		__kustoMonacoInitialized: boolean;
		__kustoMonacoInitializedByModel: Record<string, boolean>;
		__kustoMonacoDatabaseInContext: { clusterUrl: string; database: string } | null;
		__kustoMonacoDatabaseInContextByModel: Record<string, { clusterUrl: string; database: string }>;
		__kustoMonacoLoadedSchemas: Record<string, any>;
		__kustoMonacoLoadedSchemasByModel: Record<string, any>;
		__kustoMonacoModelDisposeHookInstalled: boolean;
		__kustoMarkersEnabledModels: Set<string>;
		__kustoModelClusterMap: Record<string, string>;
		__kustoSchemaCache: Record<string, any>;
		__kustoSchemaOperationQueue: Promise<void>;
		__kustoGeneratedFunctionsMerged: boolean;
		__kustoFunctionDocs: Record<string, any>;
		__kustoControlCommandDocCache: Record<string, any>;
		__kustoControlCommandDocPending: Record<string, any>;
		__kustoWorkerInitialized: boolean;
		__kustoWorkerNeedsSchemaReload: boolean;
		__kustoLastFocusedBoxId: string | null;
		__kustoFocusInProgress: string | null;
		__kustoLastMonacoInteractionAt: number;
		__kustoMonacoInitRetryCountByBoxId: Record<string, number>;
		__kustoCrossClusterSchemas: Record<string, any>;
		__kustoCrossClusterCheckTimeout: Record<string, any>;
		__kustoStatementSeparatorMinBlankLines: number;
		__kustoAutoFindStateByBoxId: Record<string, any>;
		__kustoCaretDocsLastHtmlByBoxId: Record<string, string>;
		__kustoCaretDocsViewportListenersInstalled: boolean;
		__kustoWebviewHasFocus: boolean;
		__kustoWebviewFocusListenersInstalled: boolean;
		__kustoSetMonacoKustoSchema: (rawSchemaJson: any, clusterUrl: string, database: string, setAsContext?: boolean, modelUri?: string, forceRefresh?: boolean) => Promise<void>;
		__kustoSetMonacoKustoSchemaInternal: (rawSchemaJson: any, clusterUrl: string, database: string, setAsContext?: boolean, modelUri?: string, forceRefresh?: boolean) => Promise<void>;
		__kustoSetDatabaseInContext: (clusterUrl: string, database: string, modelUri?: string) => Promise<boolean>;
		__kustoUpdateSchemaForFocusedBox: (boxId: string, enableMarkers?: boolean) => Promise<void>;
		__kustoScheduleKustoDiagnostics: (boxId: string, delayMs?: number) => void;
		__kustoGetHoverInfoAt: (model: any, position: any) => any;
		__kustoEnableMarkersForModel: (modelUri: string) => void;
		__kustoDisableMarkersForModel: (modelUri: string) => void;
		__kustoEnableMarkersForBox: (boxId: string) => void;
		__kustoTriggerRevalidation: (boxId: string) => void;
		__kustoExtractCrossClusterRefs: (queryText: string) => any[];
		__kustoRequestCrossClusterSchema: (clusterName: string, database: string, boxId: string) => void;
		__kustoApplyCrossClusterSchema: (clusterName: string, clusterUrl: string, database: string, rawSchemaJson: any) => Promise<void>;
		__kustoApplyCrossClusterSchemaInternal: (clusterName: string, clusterUrl: string, database: string, rawSchemaJson: any) => Promise<void>;
		__kustoCheckCrossClusterRefs: (queryText: string, boxId: string) => void;
		__kustoGetStatementBlocksFromModel: (model: any) => any[];
		__kustoIsSeparatorBlankLine: (model: any, lineNumber: number) => boolean;
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
		__kustoAutoSizeEditor: (boxId: string, editor?: any) => void;
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
		monacoEditorWorkerUri: string;

		// =====================================================================
		// monaco-suggest.ts
		// =====================================================================
		__kustoSuggestWidgetScrollDismissInstalled: boolean;
		__kustoSuggestWidgetViewportListenersInstalled: boolean;
		__kustoClampAllSuggestWidgets: () => void;
		__kustoIsElementVisibleForSuggest: (el: HTMLElement) => boolean;
		__kustoGetWordNearCursor: (editor: any) => string;
		__kustoFindSuggestWidgetForEditor: (editor: any) => HTMLElement | null;
		__kustoRegisterGlobalSuggestMutationHandler: () => void;
		__kustoInstallSmartSuggestWidgetSizing: (editor: any) => void;

		// =====================================================================
		// monaco-writable.ts
		// =====================================================================
		__kustoNormalizeTextareasWritable: () => void;
		__kustoForceEditorWritable: (editor: any) => void;
		__kustoInstallWritableGuard: (editor: any) => void;
		__kustoEnsureEditorWritableSoon: (editor: any) => void;
		__kustoEnsureAllEditorsWritableSoon: () => void;

		// =====================================================================
		// monaco-resize.ts
		// =====================================================================
		__kustoAttachAutoResizeToContent: (editor: any, containerEl?: any) => void;

		// =====================================================================
		// monaco-prettify.ts
		// =====================================================================
		__kustoToSingleLineKusto: (text: string) => string;
		__kustoExplodePipesToLines: (text: string) => string;
		__kustoSplitTopLevel: (text: string) => string[];
		__kustoFindTopLevelKeyword: (text: string) => string | null;
		__kustoPrettifyWhereClause: (text: string) => string;
		__kustoPrettifyKusto: (text: string) => string;
		__kustoSplitKustoStatementsBySemicolon: (text: string) => string[];
		__kustoPrettifyKustoTextWithSemicolonStatements: (text: string) => string;

		// =====================================================================
		// monaco-theme.ts
		// =====================================================================
		isDarkTheme: () => boolean;
		getVSCodeEditorBackground: () => string;
		defineCustomThemes: (monaco: any) => void;
		applyMonacoTheme: (monaco: any) => void;
		startMonacoThemeObserver: (monaco: any) => void;

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
		onDatabasesError: (boxId: string, error: string, connectionId?: string) => void;
		parseKustoExplorerConnectionsXml: (xmlText: string) => any[];
		onPythonResult: (message: any) => void;
		onPythonError: (message: any) => void;
		__kustoMaximizeMarkdownBox: (boxId: string) => void;
		__kustoMaximizePythonBox: (boxId: string) => void;
		__kustoGetFocusedMonacoEditor: () => any | null;
		__kustoGetSelectionOrCurrentLineRange: (editor: any) => any;
		__kustoCopyOrCutFocusedMonaco: (isCut: boolean) => Promise<boolean>;
		__kustoCopyOrCutMonacoEditorImpl: (editor: any, isCut: boolean) => Promise<boolean>;
		__kustoToggleAddSectionDropdown: () => void;
		__kustoAddSectionFromDropdown: (sectionType: string) => void;
		__kustoUpdateAddSectionDropdownVisibility: () => void;
		__kustoWheelPassthroughInstalled?: boolean;
		closeColumnFilterPopover?: () => void;
		closeSortDialog?: (boxId?: string) => void;
		__kustoCloseShareModal?: () => void;
		__kustoDisplayBoxError?: (boxId: string, errorMsg: string, clientActivityId?: string) => void;
		__kustoEnterFavoritesModeForBox?: (boxId: string) => void;
		__kustoOnConfirmRemoveFavoriteResult?: (message: any) => void;
		__kustoMaybeDefaultFirstBoxToFavoritesMode?: () => void;
		__kustoOnConnectionsUpdated?: () => void;
		__kustoPendingChartConfig?: Record<string, any>;
		__kustoPendingTransformationConfig?: Record<string, any>;
		__kustoSetSectionExpanded?: (boxId: string, expanded: boolean) => void;
		__kustoDevNotesEnabled?: boolean;
		__kustoRequestKqlDiagnostics?: (args: any) => Promise<any>;
		__kustoRequestKqlTableReferences?: (args: any) => Promise<any>;

		// =====================================================================
		// copilotQueryBoxes.ts
		// =====================================================================
		__kustoQueryBoxKindByBoxId: Record<string, string>;
		__kustoCopilotChatStateByBoxId: Record<string, any>;
		__kustoCopilotToolResponsesByBoxId: Record<string, any>;
		__kustoCopilotToolSelectionByBoxId: Record<string, any>;
		__kustoCopilotChatWidthPxByBoxId: Record<string, number>;
		__kustoCopilotChatVisibleByBoxId: Record<string, boolean>;
		__kustoCopilotChatFirstTimeDismissed: boolean;
		__kustoGetCopilotChatWidthPx: (boxId: string) => number;
		__kustoSetCopilotChatWidthPx: (boxId: string, widthPx: number) => void;
		__kustoGetCopilotChatVisible: (boxId: string) => boolean;
		__kustoSetCopilotChatVisible: (boxId: string, visible: boolean) => void;
		__kustoToggleCopilotChatForBox: (boxId: string) => void;
		addCopilotQueryBox: (options?: any) => string;
		__kustoCopilotWriteQuerySend: (boxId: string) => void;
		__kustoCopilotWriteQueryCancel: (boxId: string) => void;
		__kustoDisposeCopilotQueryBox: (boxId: string) => void;
		__kustoCopilotApplyWriteQueryOptions: (boxId: string, models: any, selectedModelId: string, tools: any) => void;
		__kustoCopilotClearConversation: (boxId: string) => void;
		__kustoCopilotToggleToolsPanel: (boxId: string) => void;
		__kustoCopilotWriteQueryStatus: (boxId: string, text: string, detail: string, role: string) => void;
		__kustoCopilotWriteQuerySetQuery: (boxId: string, queryText: string) => void;
		__kustoCopilotWriteQueryDone: (boxId: string, ok: boolean, message: string) => void;
		__kustoCopilotWriteQueryToolResult: (boxId: string, toolName: string, label: string, jsonText: string, entryId: string) => void;
		__kustoCopilotAppendExecutedQuery: (boxId: string, query: string, resultSummary: string, errorMessage: string, entryId: string, result: any) => void;
		__kustoCopilotAppendGeneralRulesLink: (boxId: string, filePath: string, preview: string, entryId: string) => void;
		__kustoCopilotAppendClarifyingQuestion: (boxId: string, question: string, entryId: string) => void;
		__kustoCopilotAppendQuerySnapshot: (boxId: string, queryText: string, entryId: string) => void;
		__kustoCopilotAppendDevNotesContext: (boxId: string, preview: string, entryId: string) => void;
		__kustoCopilotAppendDevNoteToolCall: (boxId: string, action: string, detail: string, result: string, entryId: string) => void;

		// =====================================================================
		// extraBoxes.ts
		// =====================================================================
		__kustoPythonBoxes: any[];
		__kustoUrlBoxes: any[];
		__kustoMarkdownEditors: Record<string, any>;
		markdownEditors: Record<string, any>;
		pythonEditors: Record<string, any>;
		__kustoPythonEditors: Record<string, any>;
		chartStateByBoxId: Record<string, any>;
		transformationStateByBoxId: Record<string, any>;
		__kustoRefreshAllDataSourceDropdowns: () => void;
		__kustoGetChartValidationStatus: (boxId: string) => any;
		__kustoGetChartDatasetsInDomOrder: () => any[];
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
		__kustoSetupSectionModeResizeObserver: (boxId: string) => void;
		__kustoCleanupSectionModeResizeObserver: (boxId: string) => void;
		removePythonBox: (boxId: string) => void;
		initPythonEditor: (boxId: string) => void;
		setPythonOutput: (boxId: string, output: string) => void;
		runPythonBox: (boxId: string) => void;
		removeUrlBox: (boxId: string) => void;
		__kustoRefreshDependentExtraBoxes?: (boxId: string) => void;

		// =====================================================================
		// extraBoxes-chart.ts
		// =====================================================================
		__kustoChartBoxes: any[];
		__kustoDisposeChartEcharts: (boxId: string) => void;
		__kustoRenderChart: (boxId: string) => void;
		__kustoMaximizeChartBox: (boxId: string) => void;
		__kustoAutoFitChartIfClipped: (boxId: string) => void;
		removeChartBox: (boxId: string) => void;
		toggleChartBoxVisibility: (boxId: string) => void;
		__kustoApplyChartBoxVisibility: (boxId: string) => void;
		__kustoApplyChartMode: (boxId: string) => void;
		__kustoSetChartMode: (boxId: string, mode: string) => void;
		__kustoUpdateChartModeButtons: (boxId: string) => void;
		__kustoUpdateChartVisibilityToggleButton: (boxId: string) => void;
		__kustoGetChartMinResizeHeight: (boxId: string) => number;
		__kustoUpdateChartBuilderUI: (boxId: string) => void;
		__kustoGetChartActiveCanvasElementId: (boxId: string) => string | null;
		__kustoGetIsDarkThemeForEcharts: () => boolean;
		__kustoOnChartDataSourceChanged: (boxId: string) => void;
		__kustoOnChartTypeChanged: (boxId: string) => void;
		__kustoSelectChartType: (boxId: string, chartType: string) => void;
		__kustoOnChartLabelsToggled: (boxId: string) => void;
		__kustoOnChartLabelModeChanged: (boxId: string) => void;
		__kustoOnChartLabelDensityChanged: (boxId: string) => void;
		__kustoOnChartMappingChanged: (boxId: string) => void;
		__kustoOnChartYCheckboxChanged: (boxId: string) => void;
		__kustoOnChartTooltipCheckboxChanged: (boxId: string) => void;
		__kustoOnChartFunnelSortChanged: (boxId: string) => void;
		__kustoOnChartFunnelSortDirToggle: (boxId: string) => void;
		__kustoUpdateFunnelSortUI: (boxId: string) => void;
		__kustoNormalizeLegendPosition: (pos: string) => string;
		__kustoUpdateLegendPositionButtonUI: (boxId: string) => void;
		__kustoOnChartLegendPositionClicked: (boxId: string,pos: string) => void;
		__kustoFormatNumber: (n: number) => string;
		__kustoComputeAxisFontSize: (container: HTMLElement) => number;
		__kustoGetChartState: (boxId: string) => any;
		__kustoGetDefaultAxisSettings: () => any;
		__kustoHasCustomAxisSettings: (settings: any) => boolean;
		__kustoGetDefaultYAxisSettings: () => any;
		__kustoHasCustomYAxisSettings: (settings: any) => boolean;
		__kustoUpdateSeriesColorsUI: (boxId: string) => void;
		__kustoOnSeriesColorChanged: (boxId: string, seriesName: string, color: string) => void;
		__kustoResetSeriesColor: (boxId: string, seriesName: string) => void;
		__kustoToggleAxisSettingsPopup: (boxId: string, axis: string) => void;
		__kustoCloseAxisSettingsPopup: (boxId: string) => void;
		__kustoCloseAllAxisSettingsPopups: () => void;
		__kustoToggleLabelSettingsPopup: (boxId: string) => void;
		__kustoCloseLabelSettingsPopup: (boxId: string) => void;
		__kustoSyncLabelSettingsUI: (boxId: string) => void;
		__kustoHasCustomLabelSettings: (boxId: string) => boolean;
		__kustoUpdateLabelSettingsIndicator: (boxId: string) => void;
		__kustoSyncAxisSettingsUI: (boxId: string) => void;
		__kustoUpdateAxisLabelIndicator: (boxId: string) => void;
		__kustoOnAxisSettingChanged: (boxId: string, setting: string, value: any) => void;
		__kustoResetAxisSettings: (boxId: string) => void;
		__kustoFormatUtcDateTime: (dateMs: number) => string;
		__kustoComputeTimePeriodGranularity: (minMs: number, maxMs: number) => string;
		__kustoFormatTimePeriodLabel: (dateMs: number, granularity: string) => string;
		__kustoGenerateContinuousTimeLabels: (minMs: number, maxMs: number, count: number) => number[];
		__kustoShouldShowTimeForUtcAxis: (data: any[]) => boolean;
		__kustoComputeTimeAxisLabelRotation: (container: HTMLElement, labels: string[]) => number;
		__kustoComputeCategoryLabelRotation: (container: HTMLElement, labels: string[]) => number;
		__kustoMeasureLabelChars: (labels: string[]) => number;
		__kustoRefreshChartsForThemeChange: () => void;
		__kustoStartEchartsThemeObserver: () => void;

		// =====================================================================
		// extraBoxes-markdown.ts
		// =====================================================================
		__kustoMarkdownBoxes: any[];
		removeMarkdownBox: (boxId: string) => void;
		initMarkdownViewer: (boxId: string) => void;
		initMarkdownEditor: (boxId: string) => void;
		toggleMarkdownBoxVisibility: (boxId: string) => void;
		isLikelyDarkTheme: () => boolean;
		getToastUiPlugins: () => any[];
		ensureMarkedGlobal: () => any;
		__kustoTryApplyPendingMarkdownReveal: (boxId: string) => void;
		__kustoIsDarkTheme: () => boolean;
		__kustoApplyToastUiThemeToHost: (host: HTMLElement) => void;
		__kustoApplyToastUiThemeAll: () => void;
		__kustoStartToastUiThemeObserver: () => void;
		__kustoAutoExpandMarkdownBoxToContent: (boxId: string) => void;
		__kustoScheduleMdAutoExpand: (boxId: string) => void;
		__kustoEnsureMarkdownModeMap: () => void;
		__kustoGetMarkdownMode: (boxId: string) => string;
		__kustoSetMarkdownMode: (boxId: string, mode: string) => void;
		__kustoUpdateMarkdownModeButtons: (boxId: string) => void;
		__kustoToggleMdModeDropdown: (boxId: string) => void;
		__kustoCloseMdModeDropdown: (boxId: string) => void;
		__kustoUpdateMdModeResponsive: (boxId: string) => void;
		__kustoSetupMdModeResizeObserver: (boxId: string) => void;
		__kustoCleanupMdModeResizeObserver: (boxId: string) => void;
		__kustoUpdateMarkdownPreviewSizing: (boxId: string) => void;
		__kustoApplyMarkdownEditorMode: (boxId: string) => void;
		__kustoAutoFitMarkdownBoxHeight: (boxId: string) => void;
		__kustoUpdateMarkdownVisibilityToggleButton: (boxId: string) => void;
		__kustoApplyMarkdownBoxVisibility: (boxId: string) => void;
		__kustoRewriteToastUiImagesInContainer: (container: HTMLElement) => void;


		// =====================================================================
		// extraBoxes-transformation.ts
		// =====================================================================
		__kustoTransformationBoxes: any[];
		__kustoConfigureTransformation: (boxId: string, config: any) => any;
		__kustoRenderTransformation: (boxId: string) => void;
		removeTransformationBox: (boxId: string) => void;
		toggleTransformationBoxVisibility: (boxId: string) => void;
		__kustoGetTransformationState: (boxId: string) => any;
		__kustoGetTransformationMinResizeHeight: (boxId: string) => number;
		__kustoUpdateTransformationModeButtons: (boxId: string) => void;
		__kustoApplyTransformationMode: (boxId: string) => void;
		__kustoSetTransformationMode: (boxId: string, mode: string) => void;
		__kustoUpdateTransformationVisibilityToggleButton: (boxId: string) => void;
		__kustoApplyTransformationBoxVisibility: (boxId: string) => void;
		__kustoMaximizeTransformationBox: (boxId: string) => void;
		__kustoComputeTransformationFitHeightPx: (boxId: string) => number;
		__kustoMaybeAutoFitTransformationBox: (boxId: string) => void;
		__kustoSetTransformationType: (boxId: string, type: string) => void;
		__kustoOnTransformationDataSourceChanged: (boxId: string) => void;
		__kustoSetCheckboxDropdownText: (buttonTextId: string, selectedValues: string[], placeholder: string) => void;
		__kustoBuildCheckboxMenuHtml: (items: any[], opts: any) => string;
		__kustoToggleGroupByColumn: (boxId: string, column: string) => void;
		__kustoUpdateTransformationBuilderUI: (boxId: string) => void;
		__kustoOnTransformationDistinctChanged: (boxId: string) => void;
		__kustoOnTransformationAggChanged: (boxId: string) => void;
		__kustoAddTransformationAgg: (boxId: string) => void;
		__kustoRemoveTransformationAgg: (boxId: string, index: number) => void;
		__kustoOnGroupByColumnChanged?: (boxId: string) => void;
		__kustoAddGroupByColumn?: (boxId: string) => void;
		__kustoRemoveGroupByColumn?: (boxId: string, index: number) => void;
		__kustoOnGroupByDragStart?: (boxId: string, index: number) => void;
		__kustoClearGroupByDropIndicators?: (boxId: string) => void;
		__kustoOnGroupByDragOver?: (boxId: string, event: any) => void;
		__kustoOnGroupByDragEnd?: (boxId: string) => void;
		__kustoOnGroupByDrop?: (boxId: string) => void;
		__kustoOnAggDragStart?: (boxId: string, index: number) => void;
		__kustoClearAggDropIndicators?: (boxId: string) => void;
		__kustoOnAggDragOver?: (boxId: string, event: any) => void;
		__kustoOnAggDrop?: (boxId: string) => void;
		__kustoOnAggDragEnd?: (boxId: string) => void;
		__kustoOnCalculatedColumnChanged?: (boxId: string, index: number) => void;
		__kustoAddCalculatedColumn?: (boxId: string) => void;
		__kustoRemoveCalculatedColumn?: (boxId: string, index: number) => void;
		__kustoOnDeriveDragStart?: (boxId: string, index: number) => void;
		__kustoClearDeriveDropIndicators?: (boxId: string) => void;
		__kustoOnDeriveDragOver?: (boxId: string, event: any) => void;
		__kustoOnDeriveDrop?: (boxId: string) => void;
		__kustoOnDeriveDragEnd?: (boxId: string) => void;
		__kustoOnTransformationPivotChanged?: (boxId: string) => void;
		__kustoGroupByDragState?: any;
		__kustoAggDragState?: any;
		__kustoDeriveDragState?: any;
		__kustoOnResultsVisibilityToggled?: ((boxId?: string) => void) | null;
		__kustoConfigureTransformationFromTool?: (boxId: string, config: any) => any;
		__kustoRenderTransformationError?: (boxId: string, error: any) => void;
		__kustoEnsureTransformationAutoExpandWhenResultsAppear?: (boxId: string) => void;
		__kustoShowExpressionHelpTooltip?: (boxId: string, event: any) => void;
		__kustoHideExpressionHelpTooltip?: () => void;
		__kustoHideExpressionHelpTooltipImmediate?: () => void;
		__kustoFormatDate?: (date: any) => string;
		__kustoTryParseDate?: (v: any) => number | null;

		// =====================================================================
		// extraBoxes-markdown.ts (state — lazy-initialized)
		// =====================================================================
		__kustoMarkdownModeByBoxId?: Record<string, string>;
		__kustoMarkdownExpandedByBoxId?: Record<string, boolean>;
		__kustoMdAutoExpandTimersByBoxId?: Record<string, any>;
		__kustoToastUiViewerInitRetryCountByBoxId?: Record<string, number>;
		__kustoToastUiInitRetryCountByBoxId?: Record<string, number>;
		__kustoResolvedImageSrcCache?: Record<string, string>;
		__kustoRevealMarkdownRangeInBox?: (boxId: string, payload: any) => void;
		__kustoRevealTextRangeFromHost?: (message: any) => void;

		// =====================================================================
		// persistence.ts (additional state)
		// =====================================================================
		__kustoDocumentUri?: string;

		// =====================================================================
		// dropdown.ts (state)
		// =====================================================================
		__kustoToolbarScrollAtOpen?: number;

		// =====================================================================
		// resultsTable.ts (additional)
		// =====================================================================
		__kustoSetResultsState?: (boxId: string, state: KustoResultsState) => void;
		__kustoGetRawCellValueForTransform?: (cell: any) => any;
		__kustoTryParseFiniteNumber?: (v: any) => number | null;

		// =====================================================================
		// extraBoxes-transformation.ts (expression eval)
		// =====================================================================
		__kustoTokenizeExpr?: (expr: string) => any[];
		__kustoParseExprToRpn?: (tokens: any[]) => any[];
		__kustoEvalRpn?: (rpn: any[], row: any, colIndex: Record<string, number>) => any;

		// =====================================================================
		// main.ts (additional)
		// =====================================================================
		__kustoResolveResourceUri?: (args: any) => Promise<string>;

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
	}
}

export {};
