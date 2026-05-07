/**
 * Shared persistence state — module-level variables replacing window.__kusto* bridges.
 *
 * All state maps, config scalars, and runtime flags that were previously stored on
 * `window` as bridge assignments are now exported from this module. Consumers import
 * `pState` and access/mutate properties directly:
 *
 *   import { pState } from '../shared/persistence-state';
 *   pState.resultsVisibleByBoxId[boxId] = true;
 *   if (pState.restoreInProgress) { ... }
 */

export const pState = {
	// ── State maps (keyed by boxId) ──────────────────────────────────

	/** Per-box results visibility (false = collapsed). */
	resultsVisibleByBoxId: {} as Record<string, boolean>,

	/** Per-box explicit user-resize height for the Monaco query editor wrapper. */
	manualQueryEditorHeightPxByBoxId: {} as Record<string, number>,

	/** Pending initial query text stashed during restore (consumed by initQueryEditor). */
	pendingQueryTextByBoxId: {} as Record<string, string>,

	/** Pending initial markdown text stashed during restore (consumed by kw-markdown-section). */
	pendingMarkdownTextByBoxId: {} as Record<string, string>,

	/** Pending initial Python code stashed during restore (consumed by kw-python-section). */
	pendingPythonCodeByBoxId: {} as Record<string, string>,

	/** Pending initial HTML code stashed during restore (consumed by kw-html-section). */
	pendingHtmlCodeByBoxId: {} as Record<string, string>,

	/** Pending initial SQL query stashed during restore (consumed by kw-sql-section). */
	pendingSqlQueryByBoxId: {} as Record<string, string>,

	/** Per-box persisted query result JSON (in-memory, included in getKqlxState). */
	queryResultJsonByBoxId: {} as Record<string, string>,

	/** Pending editor wrapper height to apply when Monaco initializes. */
	pendingWrapperHeightPxByBoxId: {} as Record<string, number>,

	/** Passthrough dev-notes sections (hidden, no DOM elements). */
	devNotesSections: [] as any[],

	/** Pending add-section counts from before the doc was fully loaded. */
	queryEditorPendingAdds: { query: 0, chart: 0, transformation: 0, markdown: 0, python: 0, url: 0 } as Record<string, number>,

	/** Per-box pending markdown reveal payload (queued before editor initializes). */
	pendingMarkdownRevealByBoxId: {} as Record<string, any>,

	/** Cache for resolved webview image URIs (key: baseUri + '::' + relativeSrc). */
	resolvedImageSrcCache: {} as Record<string, string>,

	// ── Config scalars (set by extension host) ───────────────────────

	/** True when editing the globalStorage session.kqlx file. */
	isSessionFile: false,

	/** True when editing a .kql/.csl file (compatibility mode). */
	compatibilityMode: false,

	/** Which section kinds the add-controls buttons allow. */
	allowedSectionKinds: ['query', 'chart', 'transformation', 'python', 'url', 'markdown'] as string[],

	/** Default section kind for empty documents. */
	defaultSectionKind: 'query' as string,

	/** Single section kind for compatibility mode (.kql → 'query', .md → 'markdown'). */
	compatibilitySingleKind: 'query' as string,

	/** Message type sent to extension host when user requests upgrade from compat mode. */
	upgradeRequestType: 'requestUpgradeToKqlx' as string,

	/** Tooltip shown on add buttons in compatibility mode. */
	compatibilityTooltip: 'This file is in .kql/.csl mode. Click to upgrade to .kqlx and enable sections.' as string,

	/** Document kind string (e.g. 'md' for .md files). */
	documentKind: '' as string,

	/** Document URI string (set by extension host). */
	documentUri: '' as string,

	/** True when the first section is pinned to position 0 (e.g. kql+json sidecar). */
	firstSectionPinned: false,

	/** True when delayed HTML Power BI export compatibility notices are enabled. */
	htmlPowerBiCompatibilityCheckEnabled: true,

	// ── Shared runtime state ─────────────────────────────────────────

	/** True while applyKqlxState is rebuilding the UI from a document payload. */
	restoreInProgress: false,

	/** Box ID of the last executed query (used by results routing). */
	lastExecutedBox: null as string | null,

	/** True after the user has dismissed the Copilot Chat first-time prompt. */
	copilotChatFirstTimeDismissed: false,
};
