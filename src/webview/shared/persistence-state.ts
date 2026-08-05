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
import type { PersistedResultArtifactV1 } from '../../shared/resultArtifact.js';
import type { ChartSectionState } from '../../shared/chartSectionDefinition.js';
import type { MarkdownSectionState } from '../../shared/markdownSectionDefinition.js';
import type { PythonSectionState } from '../../shared/pythonSectionDefinition.js';
import type { UrlSectionState } from '../../shared/urlSectionDefinition.js';
import type { TransformationSectionState } from '../../shared/transformationSectionDefinition.js';
import type { HtmlSectionState } from '../../shared/htmlSectionDefinition.js';
import { addableSectionKindsForDocument, defaultSectionKindForDocument } from '../../shared/documentSectionCapabilities.js';

export const pState = {
	/** Monotonic local UI edit revision used to reject stale host reloads. */
	documentEditRevision: 0,
	/** Host-created identity for the concrete native document-view panel incarnation. */
	documentViewSessionId: '',
	/** First projection request retained for the full session to make initial application exactly-once. */
	documentViewInitialProjectionRequestId: '',
	/** Bounded terminal request IDs preventing a projection from applying twice in one view session. */
	documentViewProjectionRequestIds: new Set<string>(),
	/** Host-issued source projection generation echoed by persistence snapshots. */
	sourceGeneration: 0,
	/** True when native Markdown persistence is owned by the host document aggregate. */
	hostOwnedMarkdownActive: false,
	/** Host-owned application revision for native Markdown commands. */
	markdownDocumentRevision: 0,
	/** Host source generation that owns the current Markdown projection. */
	markdownSourceGeneration: 0,
	/** Per-section revisions for native Markdown commands. */
	markdownSectionRevisions: {} as Record<string, number>,
	/** Per-section revisions for every section owned by the native host document aggregate. */
	documentSectionRevisions: {} as Record<string, number>,
	/** Last acknowledged host projection used instead of Markdown DOM serialization. */
	hostOwnedMarkdownSections: {} as Record<string, MarkdownSectionState>,
	/** Last acknowledged host projection used instead of Chart DOM serialization. */
	hostOwnedChartSections: {} as Record<string, ChartSectionState>,
	/** Last acknowledged host projection used instead of Python DOM serialization. */
	hostOwnedPythonSections: {} as Record<string, PythonSectionState>,
	/** Last acknowledged host projection used instead of URL DOM serialization. */
	hostOwnedUrlSections: {} as Record<string, UrlSectionState>,
	/** Last acknowledged host projection used instead of Transformation DOM serialization. */
	hostOwnedTransformationSections: {} as Record<string, TransformationSectionState>,
	/** Last acknowledged host projection used instead of HTML DOM serialization. */
	hostOwnedHtmlSections: {} as Record<string, HtmlSectionState>,
	/** Suppresses command emission while reconciling a rejected stale view. */
	applyingHostMarkdownProjection: false,

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

	/** Immutable artifact descriptor paired with each persisted result payload. */
	resultArtifactByBoxId: {} as Record<string, PersistedResultArtifactV1>,

	/** Exact Kusto account/policy owner for each persisted query result. */
	kustoResultOwnerByBoxId: {} as Record<string, { accountPartition: string; leaveNoTraceRevision: number }>,

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
	allowedSectionKinds: [...addableSectionKindsForDocument('kqlx')] as string[],

	/** Default section kind for empty documents. */
	defaultSectionKind: defaultSectionKindForDocument('kqlx') as string,

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

	/** False when the host projection is malformed or otherwise read-only. */
	documentMutationAllowed: true,

	/** False when retained last-good DOM is visual-only after a malformed reload. */
	documentRuntimeActive: false,

	/** True when delayed HTML Power BI export compatibility notices are enabled. */
	htmlPowerBiCompatibilityCheckEnabled: true,

	// ── Shared runtime state ─────────────────────────────────────────

	/** True while applyKqlxState is rebuilding the UI from a document payload. */
	restoreInProgress: false,

	/** Number of documentData payloads whose restore completed in this webview. */
	documentDataApplyCount: 0,

	/** Box ID of the last executed query (used by results routing). */
	lastExecutedBox: null as string | null,

	/** True after the user has dismissed the Copilot Chat first-time prompt. */
	copilotChatFirstTimeDismissed: false,
};
