let connections = [];
let queryBoxes = [];
let lastConnectionId = null;
let lastDatabase = null;
let cachedDatabases = {};
let queryEditors = {};
let queryEditorResizeObservers = {};
let queryEditorBoxByModelUri = {};
let suggestDebounceTimers = {};
let activeQueryEditorBoxId = null;
let schemaByBoxId = {};
let schemaFetchInFlightByBoxId = {};
let lastSchemaRequestAtByBoxId = {};
let monacoReadyPromise = null;

// The Monaco editor instance that most recently received focus (query/markdown/python).
// Used by global key handlers (e.g. Ctrl/Cmd+V paste) so we don't accidentally
// intercept shortcuts intended for a different editor.
let activeMonacoEditor = null;

let queryExecutionTimers = {};
let runModesByBoxId = {};

// Caret docs (custom tooltip) toggle
let caretDocsEnabled = true;
let caretDocOverlaysByBoxId = {};
