// Webview Lit components entry point.
// Each component self-registers its custom element on import.
// Legacy modules absorbed from global-scope JS — register window bridges on import.
import './core/state.js'; // Must be first — initializes all state globals on window
import './generated/controlCommands.generated.js';
import './generated/functions.generated.js';
import './core/utils.js';
import './core/dropdown.js';
import './viewers/diff-view/kw-diff-view.js';
import './core/persistence.js';
import './core/results-state.js';
import './core/error-renderer.js';
import './modules/queryBoxes.js';
import './modules/extraBoxes.js';
import './monaco/diagnostics.js'; // Before monaco — sets utility window bridges
import './monaco/completions.js'; // Before monaco — sets completion provider bridges
import './monaco/monaco.js';
import './core/main.js'; // Must be last — message dispatcher
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
import './sections/kw-query-toolbar.js';
