import type { FirstLaunchEditingPreferences, FirstLaunchFilePreferences } from '../../shared/firstLaunchSetup';

export const FIRST_LAUNCH_STATE_KEY = 'kusto.firstLaunchSetup.state.v1';
export const FIRST_LAUNCH_WRITE_JOURNAL_KEY = 'kusto.firstLaunchSetup.writeJournal.v1';
export const FIRST_LAUNCH_FORCE_PENDING_KEY = 'kusto.firstLaunchSetup.forcePendingForDevelopment.v1';
export const FIRST_LAUNCH_INSTALL_MARKER_KEY = 'kusto.firstLaunchSetup.installMarker.v1';
export const FIRST_LAUNCH_CORRUPT_JOURNAL_BACKUP_KEY = 'kusto.firstLaunchSetup.corruptJournalBackup.v1';

export const FIRST_LAUNCH_SCHEMA_VERSION = 1 as const;

export type FirstLaunchTerminalStatus = 'completed' | 'skipped' | 'migrated';

export type { FirstLaunchEditingPreferences, FirstLaunchFilePreferences } from '../../shared/firstLaunchSetup';

export interface FirstLaunchStateRecord {
	schemaVersion: typeof FIRST_LAUNCH_SCHEMA_VERSION;
	status: FirstLaunchTerminalStatus;
	completedAt: string;
}

export interface FirstLaunchInstallMarker {
	schemaVersion: typeof FIRST_LAUNCH_SCHEMA_VERSION;
	createdAt: string;
}

export interface FirstLaunchWriteJournal {
	schemaVersion: typeof FIRST_LAUNCH_SCHEMA_VERSION;
	transactionId: string;
	outcome: 'completed' | 'skipped';
	filePreferences: FirstLaunchFilePreferences;
	editingPreferences?: FirstLaunchEditingPreferences;
	startedAt: string;
}

export type FirstLaunchResolution =
	| { kind: 'pending' }
	| { kind: 'recover'; journal: FirstLaunchWriteJournal }
	| { kind: 'terminal'; record: FirstLaunchStateRecord }
	| { kind: 'corrupt-journal' }
	| { kind: 'unsupported'; schemaVersion: number };

export interface FirstLaunchLegacyFootprint {
	globalStateKeys?: readonly string[];
	explicitFilePreferenceValues?: readonly unknown[];
	globalEditorAssociations?: Readonly<Record<string, string>>;
}

const LEGACY_GLOBAL_STATE_KEYS = new Set([
	'kusto.connections',
	'kusto.leaveNoTraceClusters',
	'kusto.fileConnectionCache',
	'kusto.lastConnectionId',
	'kusto.lastDatabase',
	'kusto.cachedDatabases',
	'kusto.cachedSchemas',
	'kusto.auth.knownAccounts',
	'kusto.auth.clusterAccountMap',
	'kusto.cacheClearEpoch',
	'kusto.caretDocsEnabled',
	'kusto.autoTriggerAutocompleteEnabled',
	'kusto.copilotInlineCompletionsEnabled',
	'kusto.cachedSchemasMigratedToDisk',
	'kusto.optimize.lastCopilotModelId',
	'kusto.favorites',
	'kusto.connectionManager.expandedClusters',
	'cachedValues.activeKind',
	'connectionManager.activeKind',
	'connectionManager.searchState',
	'sql.connections',
	'sql.lastConnectionId',
	'sql.lastDatabase',
	'sql.cachedDatabases',
	'sql.auth.serverAccountMap',
	'sql.connectionManager.expandedConnections',
	'sql.connectionManager.cachedDatabases',
	'sql.leaveNoTraceConnections',
	'sql.favorites',
	'kusto.copilotChatFirstTimeDismissed',
	'kusto.tutorials.subscriptions.v1',
	'kusto.tutorials.lastAutomaticCheckDate.v1',
	'kusto.tutorials.pendingPopups.v1',
	'kusto.tutorials.pendingPopup.v1',
	'kusto.exportedSkills',
]);

const LEGACY_ASSOCIATIONS: Readonly<Record<string, string>> = {
	'*.kql': 'kusto.kqlCompatEditor',
	'*.csl': 'kusto.kqlCompatEditor',
	'*.md': 'kusto.mdCompatEditor',
	'*.sql': 'kusto.sqlCompatEditor',
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBoolean(value: unknown): value is boolean {
	return typeof value === 'boolean';
}

function futureSchemaVersion(...values: unknown[]): number | undefined {
	const versions = values
		.filter(isRecord)
		.map(value => value.schemaVersion)
		.filter((value): value is number => typeof value === 'number' && value > FIRST_LAUNCH_SCHEMA_VERSION);
	return versions.length > 0 ? Math.max(...versions) : undefined;
}

function parseFilePreferences(value: unknown): FirstLaunchFilePreferences | undefined {
	if (!isRecord(value)
		|| !isBoolean(value.openKqlFiles)
		|| !isBoolean(value.openCslFiles)
		|| !isBoolean(value.openMdFiles)
		|| !isBoolean(value.openSqlFiles)) {
		return undefined;
	}
	return {
		openKqlFiles: value.openKqlFiles,
		openCslFiles: value.openCslFiles,
		openMdFiles: value.openMdFiles,
		openSqlFiles: value.openSqlFiles,
	};
}

function parseEditingPreferences(value: unknown): FirstLaunchEditingPreferences | undefined {
	if (!isRecord(value)
		|| !isBoolean(value.caretDocsEnabled)
		|| !isBoolean(value.autoTriggerAutocompleteEnabled)
		|| !isBoolean(value.copilotInlineCompletionsEnabled)) {
		return undefined;
	}
	return {
		caretDocsEnabled: value.caretDocsEnabled,
		autoTriggerAutocompleteEnabled: value.autoTriggerAutocompleteEnabled,
		copilotInlineCompletionsEnabled: value.copilotInlineCompletionsEnabled,
	};
}

export function parseFirstLaunchState(value: unknown): FirstLaunchStateRecord | undefined {
	if (!isRecord(value)
		|| value.schemaVersion !== FIRST_LAUNCH_SCHEMA_VERSION
		|| (value.status !== 'completed' && value.status !== 'skipped' && value.status !== 'migrated')
		|| typeof value.completedAt !== 'string') {
		return undefined;
	}
	return {
		schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
		status: value.status,
		completedAt: value.completedAt,
	};
}

export function parseFirstLaunchInstallMarker(value: unknown): FirstLaunchInstallMarker | undefined {
	if (!isRecord(value)
		|| value.schemaVersion !== FIRST_LAUNCH_SCHEMA_VERSION
		|| typeof value.createdAt !== 'string') {
		return undefined;
	}
	return { schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION, createdAt: value.createdAt };
}

export function parseFirstLaunchWriteJournal(value: unknown): FirstLaunchWriteJournal | undefined {
	if (!isRecord(value)
		|| value.schemaVersion !== FIRST_LAUNCH_SCHEMA_VERSION
		|| typeof value.transactionId !== 'string'
		|| !value.transactionId
		|| (value.outcome !== 'completed' && value.outcome !== 'skipped')
		|| typeof value.startedAt !== 'string') {
		return undefined;
	}
	const filePreferences = parseFilePreferences(value.filePreferences);
	if (!filePreferences) {
		return undefined;
	}
	const editingPreferences = value.editingPreferences === undefined
		? undefined
		: parseEditingPreferences(value.editingPreferences);
	if (value.outcome === 'completed' && !editingPreferences) {
		return undefined;
	}
	return {
		schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
		transactionId: value.transactionId,
		outcome: value.outcome,
		filePreferences,
		...(editingPreferences ? { editingPreferences } : {}),
		startedAt: value.startedAt,
	};
}

export function hasLegacyFirstLaunchFootprint(footprint: FirstLaunchLegacyFootprint): boolean {
	if (footprint.globalStateKeys?.some(key => LEGACY_GLOBAL_STATE_KEYS.has(key))) {
		return true;
	}
	if (footprint.explicitFilePreferenceValues?.some(value => value !== undefined)) {
		return true;
	}

	const associations = footprint.globalEditorAssociations;
	if (!associations) {
		return false;
	}
	if (Object.entries(LEGACY_ASSOCIATIONS).some(([pattern, viewType]) => associations[pattern] === viewType)) {
		return true;
	}

	const patterns = Object.keys(LEGACY_ASSOCIATIONS);
	return patterns.every(pattern => Object.prototype.hasOwnProperty.call(associations, pattern))
		&& patterns.every(pattern => associations[pattern] === 'default' || associations[pattern] === LEGACY_ASSOCIATIONS[pattern]);
}

export function resolveFirstLaunchState(
	stateValue: unknown,
	journalValue: unknown,
	legacyFootprint: FirstLaunchLegacyFootprint,
	installMarkerValue?: unknown,
): FirstLaunchResolution {
	const futureVersion = futureSchemaVersion(stateValue, journalValue, installMarkerValue);
	if (futureVersion !== undefined) {
		return { kind: 'unsupported', schemaVersion: futureVersion };
	}

	const journal = parseFirstLaunchWriteJournal(journalValue);
	if (journal) {
		return { kind: 'recover', journal };
	}
	if (journalValue !== undefined) {
		return { kind: 'corrupt-journal' };
	}
	const state = parseFirstLaunchState(stateValue);
	if (state) {
		return { kind: 'terminal', record: state };
	}
	if (installMarkerValue !== undefined) {
		return { kind: 'pending' };
	}
	if (hasLegacyFirstLaunchFootprint(legacyFootprint)) {
		return {
			kind: 'terminal',
			record: {
				schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
				status: 'migrated',
				completedAt: new Date().toISOString(),
			},
		};
	}
	return { kind: 'pending' };
}