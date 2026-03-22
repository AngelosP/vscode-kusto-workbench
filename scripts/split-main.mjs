// One-time script to split main.ts into smaller files.
// Run with: node scripts/split-main.mjs
// Then delete this file.

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const modulesDir = join(root, 'src', 'webview', 'modules');
const mainPath = join(modulesDir, 'main.ts');

const content = readFileSync(mainPath, 'utf8');
const lines = content.split('\n');
const totalLines = lines.length;

/** Get 1-indexed line range (inclusive). Use Infinity for end-of-file. */
function L(start, end) {
	const actualEnd = end === Infinity ? totalLines : end;
	return lines.slice(start - 1, actualEnd).join('\n');
}

// ───────────────────────────────────────────────────────────────────────
// 1. keyboard-shortcuts.ts
// Lines 35-331 (paste, wheel, escape modals, ctrl+space, shift+space)
// Lines 424-813 (focused editor helper, toolbar focus IIFE, clipboard
//   utils, cut/copy handlers, ctrl+enter, F1, escape caret tooltip,
//   blur/focus/visibility)
// ───────────────────────────────────────────────────────────────────────
const ksContent = `// Keyboard shortcuts & clipboard handlers — extracted from main.ts
// Registers document-level keyboard event listeners for paste, cut/copy,
// autocomplete triggers, execute query, modal dismiss, and focus management.
import {
	activeMonacoEditor, activeQueryEditorBoxId, setActiveQueryEditorBoxId,
	queryEditors, caretDocOverlaysByBoxId,
} from './state';
import { __kustoGetQuerySectionElement } from './queryBoxes';
import { __kustoEnsureAllEditorsWritableSoon } from './monaco-writable';
import { executeQuery } from './queryBoxes-execution';

${L(35, 331)}

${L(424, 813)}

// ── Window bridges for remaining legacy callers ──
window.__kustoGetFocusedMonacoEditor = __kustoGetFocusedMonacoEditor;
window.__kustoGetSelectionOrCurrentLineRange = __kustoGetSelectionOrCurrentLineRange;
window.__kustoCopyOrCutFocusedMonaco = __kustoCopyOrCutFocusedMonaco;
window.__kustoCopyOrCutMonacoEditorImpl = __kustoCopyOrCutMonacoEditorImpl;
`;

writeFileSync(join(modulesDir, 'keyboard-shortcuts.ts'), ksContent);
console.log('✓ keyboard-shortcuts.ts written');

// ───────────────────────────────────────────────────────────────────────
// 2. message-handler.ts
// Lines 333-422 (resolver maps + resource URI + KQL language bridge)
// Lines 815-2881 (big window.addEventListener('message', ...) switch)
// ───────────────────────────────────────────────────────────────────────
const mhContent = `// Message handler — extracted from main.ts
// Dispatches incoming postMessage from the extension host to the right module.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { buildSchemaInfo } from '../shared/schema-utils';
import { getResultsState, displayResultForBox, displayResult, displayCancelled } from './resultsState';
import { __kustoRenderErrorUx, __kustoDisplayBoxError } from './errorUtils';
import {
	addQueryBox, __kustoGetQuerySectionElement, __kustoSetSectionName,
	__kustoGetConnectionId, __kustoGetDatabase,
	updateConnectionSelects, updateDatabaseSelect, onDatabasesError,
	parseKustoExplorerConnectionsXml,
	__kustoUpdateFavoritesUiForAllBoxes, __kustoTryAutoEnterFavoritesModeForAllBoxes,
	__kustoMaybeDefaultFirstBoxToFavoritesMode, __kustoOnConnectionsUpdated,
	schemaRequestTokenByBoxId,
} from './queryBoxes';
import { addMarkdownBox, __kustoMaximizeMarkdownBox } from './extraBoxes-markdown';
import { addChartBox } from './extraBoxes-chart';
import { addTransformationBox } from './extraBoxes-transformation';
import {
	addPythonBox, addUrlBox, onPythonResult, onPythonError,
	__kustoGetChartValidationStatus,
} from './extraBoxes';
import {
	updateCaretDocsToggleButtons, updateAutoTriggerAutocompleteToggleButtons,
	updateCopilotInlineCompletionsToggleButtons, setRunMode,
} from './queryBoxes-toolbar';
import {
	executeQuery, setQueryExecuting, __kustoSetResultsVisible,
	__kustoSetLinkedOptimizationMode, displayComparisonSummary,
	optimizeQueryWithCopilot, __kustoSetOptimizeInProgress,
	__kustoHideOptimizePromptForBox, __kustoApplyOptimizeQueryOptions,
} from './queryBoxes-execution';
import {
	schedulePersist, handleDocumentDataMessage, getKqlxState,
	__kustoSetCompatibilityMode, __kustoApplyDocumentCapabilities,
	__kustoRequestAddSection, __kustoOnQueryResult,
} from './persistence';
import {
	__kustoControlCommandDocCache, __kustoControlCommandDocPending,
	__kustoCrossClusterSchemas,
} from './monaco';
import {
	activeQueryEditorBoxId,
	connections, setConnections, setLastConnectionId, setLastDatabase,
	kustoFavorites, setKustoFavorites, setLeaveNoTraceClusters,
	setCaretDocsEnabled, setAutoTriggerAutocompleteEnabled,
	setCopilotInlineCompletionsEnabled,
	queryEditors, cachedDatabases, optimizationMetadataByBoxId,
	schemaByConnDb, schemaRequestResolversByBoxId, schemaByBoxId,
	schemaFetchInFlightByBoxId, databasesRequestResolversByBoxId,
} from './state';

const _win = window;

// --- KQL language service bridge & resource URI resolver ---
${L(333, 422)}

// --- Extension host message dispatcher ---
${L(815, 2883)}
`;

writeFileSync(join(modulesDir, 'message-handler.ts'), mhContent);
console.log('✓ message-handler.ts written');

// ───────────────────────────────────────────────────────────────────────
// 3. drag-reorder.ts
// Lines 2896-3282 (section reorder IIFE)
// ───────────────────────────────────────────────────────────────────────
const drContent = `// Drag-and-drop section reorder — extracted from main.ts
// Self-invoking: installs DnD handlers on #queries-container on import.
import { schedulePersist } from './persistence';
import { __kustoRefreshAllDataSourceDropdowns } from './extraBoxes';
import { queryEditors, setQueryBoxes } from './state';
import { markdownBoxes, markdownEditors } from './extraBoxes-markdown';
import { pythonBoxes, urlBoxes } from './extraBoxes';

${L(2897, 3285)}
`;

writeFileSync(join(modulesDir, 'drag-reorder.ts'), drContent);
console.log('✓ drag-reorder.ts written (' + L(2897, 3285).split('\n').length + ' body lines)');

// ───────────────────────────────────────────────────────────────────────
// 4. Rewrite main.ts — thin orchestrator
// ───────────────────────────────────────────────────────────────────────
const newMain = `// Main module — initialization orchestrator.
// Keyboard shortcuts, message handling, and drag-reorder are in their own modules.
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { closeAllMenus as _closeAllDropdownMenus } from './dropdown';
import { __kustoCloseShareModal, __kustoShareCopyToClipboard } from './queryBoxes-toolbar';
import { __kustoRequestAddSection } from './persistence';

// Side-effect imports — register event handlers on import.
import './keyboard-shortcuts';
import './message-handler';
import './drag-reorder';

export {};

// Request connections on load (only in the query editor webview, not side-panel webviews
// like cached-values or connection-manager that also load the bundle).
${L(2885, 2893)}

// Initial content is now driven by the .kqlx document state.

${L(3284, 3448)}

// ── Window bridges for remaining legacy callers ──
window.__kustoToggleAddSectionDropdown = __kustoToggleAddSectionDropdown;
window.__kustoAddSectionFromDropdown = __kustoAddSectionFromDropdown;
window.__kustoUpdateAddSectionDropdownVisibility = __kustoUpdateAddSectionDropdownVisibility;
`;

writeFileSync(mainPath, newMain);
console.log('✓ main.ts rewritten');
console.log('Done. Run: npm run compile-tests && npx vitest');
