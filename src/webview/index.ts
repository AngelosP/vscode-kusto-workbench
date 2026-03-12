// Webview Lit components entry point.
// Each component self-registers its custom element on import.
// Legacy modules absorbed from global-scope JS — register window bridges on import.
import './modules/state.js'; // Must be first — initializes all state globals on window
import './modules/utils.js';
import './modules/dropdown.js';
import './modules/columnAnalysis.js';
import './modules/searchControl.js';
import './modules/diffView.js';
import './modules/objectViewer.js';
import './modules/cellViewer.js';
import './modules/schema.js';
import './modules/persistence.js';
import './modules/copilotQueryBoxes.js';
import './modules/resultsTable.js';
import './modules/queryBoxes.js';
import './modules/extraBoxes.js';
import './modules/monaco.js';
import './modules/main.js'; // Must be last — message dispatcher
import './components/kw-object-viewer.js';
import './components/kw-filter-dialog.js';
import './components/kw-sort-dialog.js';
import './components/kw-data-table.js';
import './viewers/cached-values/kw-cached-values.js';
import './viewers/connection-manager/kw-connection-manager.js';
import './sections/kw-python-section.js';
import './sections/kw-markdown-section.js';
import './sections/kw-url-section.js';
import './sections/kw-chart-section.js';
import './sections/kw-transformation-section.js';
import './sections/kw-query-section.js';
