// One-time script to extract connection/favorites/schema from queryBoxes.ts.
// Run with: node scripts/split-queryBoxes.mjs

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const root = join(import.meta.dirname, '..');
const modulesDir = join(root, 'src', 'webview', 'modules');
const qbPath = join(modulesDir, 'queryBoxes.ts');

const content = readFileSync(qbPath, 'utf8');
const lines = content.split('\n');
const total = lines.length;

function L(start, end) {
	return lines.slice(start - 1, end).join('\n');
}

// ──────────────────────────────────────────────────────────────────────
// Extraction boundaries:
// L1452-2362: connection mgmt, favorites, schema wiring functions
// Plus L1450 (private let declarations before computeMissingClusterUrls)
// The window bridge block with their assignments follows after.
// ──────────────────────────────────────────────────────────────────────

// Find where the connection section starts. The structural map shows L1452.
// But module-level lets before it (L1550-1551, L1646, L1691) also need to move.
// Actually, those are scattered WITHIN the extracted section, not before it.

// Find the window bridge block (window.addQueryBox onwards)
let bridgeStart = 0;
for (let i = 0; i < total; i++) {
	if (/^window\.addQueryBox\s*=/.test(lines[i])) {
		bridgeStart = i + 1; // 1-indexed
		break;
	}
}
console.log(`Connection section: L1452-L${bridgeStart - 1} (${bridgeStart - 1 - 1452} lines)`);
console.log(`Window bridges start at: L${bridgeStart}`);

// ──────────────────────────────────────────────────────────────────────
// 1. Create queryBoxes-connections.ts
// ──────────────────────────────────────────────────────────────────────
// Extract L1452 through the end of the connection-related window bridges.
// This includes: computeMissingClusterUrls through __kustoRequestDatabases,
// plus the window bridges that reference connection/favorites/schema functions.

const connBody = L(1452, bridgeStart - 1);

const connFile = `// Connection, favorites & schema management — extracted from queryBoxes.ts
import { pState } from '../shared/persistence-state';
import { postMessageToHost } from '../shared/webview-messages';
import { schedulePersist } from './persistence';
import {
	cachedDatabases,
	connections,
	favoritesModeByBoxId,
	pendingFavoriteSelectionByBoxId,
	queryEditors,
	schemaByBoxId,
	schemaFetchInFlightByBoxId,
	lastSchemaRequestAtByBoxId,
	schemaByConnDb,
	schemaRequestResolversByBoxId,
	databasesRequestResolversByBoxId,
	missingClusterDetectTimersByBoxId,
	lastQueryTextByBoxId,
	missingClusterUrlsByBoxId,
	suggestedDatabaseByClusterKeyByBoxId,
	kustoFavorites,
	lastConnectionId,
	lastDatabase,
} from './state';
import { buildSchemaInfo } from '../shared/schema-utils';
import { syncSelectBackedDropdown } from './dropdown';
import {
	formatClusterDisplayName,
	normalizeClusterUrlKey,
	formatClusterShortName,
	clusterShortNameKey,
	extractClusterUrlsFromQueryText,
	extractClusterDatabaseHintsFromQueryText,
	computeMissingClusterUrls as _computeMissing,
	favoriteKey as __kustoFavoriteKey,
	findFavorite as __kustoFindFavorite_pure,
	getFavoritesSorted as __kustoGetFavoritesSorted_pure,
	parseKustoConnectionString,
	findConnectionIdForClusterUrl as _findConnIdPure,
} from '../shared/clusterUtils';
import { escapeHtml } from './utils';
import { __kustoGetQuerySectionElement, __kustoGetConnectionId, __kustoGetDatabase, schemaRequestTokenByBoxId } from './queryBoxes';

const _win = window;

${connBody}
`;

writeFileSync(join(modulesDir, 'queryBoxes-connections.ts'), connFile);
console.log('✓ queryBoxes-connections.ts written (' + connFile.split('\n').length + ' lines)');

// ──────────────────────────────────────────────────────────────────────
// 2. Update queryBoxes.ts — remove extracted section + add re-exports
// ──────────────────────────────────────────────────────────────────────
const newLines = [...lines];

// Clear the extracted lines (L1452 through bridgeStart-1)
for (let i = 1452 - 1; i < bridgeStart - 1; i++) {
	newLines[i] = null;
}

// Insert re-exports at the extraction point
newLines[1452 - 1] = [
	'// ── Connection, favorites & schema management extracted to queryBoxes-connections.ts ──',
	"export {",
	"	computeMissingClusterUrls, updateMissingClustersForBox,",
	"	__kustoOnConnectionsUpdated,",
	"	__kustoFindConnectionIdForClusterUrl, __kustoGetCurrentClusterUrlForBox, __kustoGetCurrentDatabaseForBox,",
	"	__kustoFindFavorite, __kustoSetAutoEnterFavoritesForBox,",
	"	__kustoTryAutoEnterFavoritesModeForAllBoxes, __kustoMaybeDefaultFirstBoxToFavoritesMode,",
	"	__kustoUpdateFavoritesUiForAllBoxes,",
	"	addMissingClusterConnections, updateConnectionSelects,",
	"	promptAddConnectionFromDropdown, importConnectionsFromXmlFile,",
	"	parseKustoExplorerConnectionsXml,",
	"	refreshDatabases, onDatabasesError, updateDatabaseSelect,",
	"	ensureSchemaForBox, onDatabaseChanged, refreshSchema,",
	"} from './queryBoxes-connections';",
].join('\n');

const newContent = newLines.filter(l => l !== null).join('\n');
writeFileSync(qbPath, newContent);
const newLineCount = newContent.split('\n').length;
console.log('✓ queryBoxes.ts updated (' + newLineCount + ' lines, was ' + total + ')');
console.log('Done! Run: npx tsc --noEmit && npx vitest run');
