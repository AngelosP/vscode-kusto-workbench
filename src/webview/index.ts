// Webview Lit components entry point.
// Each component self-registers its custom element on import.
// Legacy modules absorbed from global-scope JS — register window bridges on import.
import './modules/state.js'; // Must be first — initializes all state globals on window
import './modules/controlCommands.generated.js';
import './modules/functions.generated.js';
import './modules/utils.js';
import './modules/dropdown.js';
import './viewers/diff-view/kw-diff-view.js';
import './modules/persistence.js';
import './modules/resultsState.js';
import './modules/errorUtils.js';
import './modules/queryBoxes.js';
import './modules/extraBoxes.js';
import './modules/monaco-diagnostics.js'; // Before monaco — sets utility window bridges
import './modules/monaco-completions.js'; // Before monaco — sets completion provider bridges
import './modules/monaco.js';
import './modules/main.js'; // Must be last — message dispatcher
import './components/kw-search-bar.js';
import './components/kw-object-viewer.js';
import './components/kw-cell-viewer.js';
import './components/kw-filter-dialog.js';
import './components/kw-sort-dialog.js';
import './components/kw-dropdown.js';
import './components/kw-data-table.js';
import './components/kw-copilot-chat.js';
import './components/kw-section-shell.js';
import './components/kw-popover.js';
import './components/kw-section-reorder-popup.js';
import './viewers/cached-values/kw-cached-values.js';
import './viewers/connection-manager/kw-connection-manager.js';
import './sections/kw-python-section.js';
import './sections/kw-markdown-section.js';
import './sections/kw-url-section.js';
import './sections/kw-chart-section.js';
import './sections/kw-transformation-section.js';
import './sections/kw-query-section.js';
