// Webview Lit components entry point.
// Each component self-registers its custom element on import.
// Legacy modules absorbed from global-scope JS — register window bridges on import.
import { sashSheet } from './shared/sash-styles.js';
document.adoptedStyleSheets = [...document.adoptedStyleSheets, sashSheet];
import './core/state.js'; // Must be first — initializes all state globals on window
import './generated/controlCommands.generated.js';
import './generated/functions.generated.js';
import './core/utils.js';
import './core/dropdown.js';
import './viewers/diff-view/kw-diff-view.js';
import './core/persistence.js';
import './core/results-state.js';
import './core/error-renderer.js';
import './core/section-factory.js';
import './monaco/diagnostics.js'; // Before monaco — sets utility window bridges
import './monaco/completions.js'; // Before monaco — sets completion provider bridges
import './monaco/monaco.js';
import './core/main.js'; // Must be last — message dispatcher
import './core/section-insert-zone.js'; // Hover-to-insert between sections
import './components/kw-search-bar.js';
import './components/kw-object-viewer.js';
import './components/kw-cell-viewer.js';
import './components/kw-filter-dialog.js';
import './components/kw-sort-dialog.js';
import './components/kw-dropdown.js';
import './components/kw-data-table.js';
import './components/kw-monaco-toolbar.js';
import './components/kw-unique-values-dialog.js';
import './components/kw-copilot-chat.js';
import './core/test-helpers.js'; // E2E: shadow-piercing __testFind/__testQuery helpers
import './components/kw-section-shell.js';
import './components/kw-popover.js';
import './components/kw-kusto-connection-form.js';
import './components/kw-sql-connection-form.js';
import './components/kw-kind-picker.js';
import './components/kw-chart-tooltip.js';
import './components/kw-section-reorder-popup.js';
import './viewers/cached-values/kw-cached-values.js';
import './viewers/connection-manager/kw-connection-manager.js';
import './sections/kw-python-section.js';
import './sections/kw-markdown-section.js';
import './sections/kw-url-section.js';
import './sections/kw-chart-section.js';
import './sections/kw-transformation-section.js';
import './sections/kw-html-section.js';
import './sections/kw-sql-section.js';
import './sections/kw-query-section.js';
import './sections/kw-query-toolbar.js';
