import * as vscode from 'vscode';
import type { FirstLaunchFilePreferences } from '../../shared/firstLaunchSetup';

export const EDITOR_ASSOCIATION_OWNERSHIP_KEY = 'kusto.firstLaunchSetup.editorAssociationOwnership.v1';

const OWNERSHIP_SCHEMA_VERSION = 1 as const;

type AssociationPattern = '*.kql' | '*.csl' | '*.md' | '*.sql';
export type FilePreferenceKey = keyof FirstLaunchFilePreferences;

interface AssociationDefinition {
	pattern: AssociationPattern;
	preferenceKey: FilePreferenceKey;
	viewType: string;
	defaultValue: boolean;
}

const ASSOCIATION_DEFINITIONS: readonly AssociationDefinition[] = [
	{ pattern: '*.kql', preferenceKey: 'openKqlFiles', viewType: 'kusto.kqlCompatEditor', defaultValue: true },
	{ pattern: '*.csl', preferenceKey: 'openCslFiles', viewType: 'kusto.kqlCompatEditor', defaultValue: true },
	{ pattern: '*.md', preferenceKey: 'openMdFiles', viewType: 'kusto.mdCompatEditor', defaultValue: false },
	{ pattern: '*.sql', preferenceKey: 'openSqlFiles', viewType: 'kusto.sqlCompatEditor', defaultValue: false },
];

type PreviousAssociation =
	| { kind: 'absent' }
	| { kind: 'value'; value: string }
	| { kind: 'unknown' };

interface AssociationOwnershipEntry {
	ownedValue: string;
	previous: PreviousAssociation;
}

interface AssociationOwnershipRecord {
	schemaVersion: typeof OWNERSHIP_SCHEMA_VERSION;
	patterns: Partial<Record<AssociationPattern, AssociationOwnershipEntry>>;
}

export type AssociationReconcileMode = 'conservative' | 'explicit';

type GlobalStateLike = Pick<vscode.Memento, 'get' | 'update'>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parsePreviousAssociation(value: unknown): PreviousAssociation | undefined {
	if (!isRecord(value)) {
		return undefined;
	}
	if (value.kind === 'absent' || value.kind === 'unknown') {
		return { kind: value.kind };
	}
	if (value.kind === 'value' && typeof value.value === 'string') {
		return { kind: 'value', value: value.value };
	}
	return undefined;
}

function parseOwnershipRecord(value: unknown): AssociationOwnershipRecord {
	const empty: AssociationOwnershipRecord = { schemaVersion: OWNERSHIP_SCHEMA_VERSION, patterns: {} };
	if (!isRecord(value) || value.schemaVersion !== OWNERSHIP_SCHEMA_VERSION || !isRecord(value.patterns)) {
		return empty;
	}
	const patterns: AssociationOwnershipRecord['patterns'] = {};
	for (const definition of ASSOCIATION_DEFINITIONS) {
		const candidate = value.patterns[definition.pattern];
		if (!isRecord(candidate) || typeof candidate.ownedValue !== 'string') {
			continue;
		}
		const previous = parsePreviousAssociation(candidate.previous);
		if (previous) {
			patterns[definition.pattern] = { ownedValue: candidate.ownedValue, previous };
		}
	}
	return { schemaVersion: OWNERSHIP_SCHEMA_VERSION, patterns };
}

function cloneOwnershipRecord(record: AssociationOwnershipRecord): AssociationOwnershipRecord {
	return {
		schemaVersion: OWNERSHIP_SCHEMA_VERSION,
		patterns: Object.fromEntries(Object.entries(record.patterns).map(([pattern, entry]) => [
			pattern,
			entry ? { ownedValue: entry.ownedValue, previous: { ...entry.previous } } : entry,
		])) as AssociationOwnershipRecord['patterns'],
	};
}

function recordsEqual(left: unknown, right: unknown): boolean {
	return JSON.stringify(left) === JSON.stringify(right);
}

function previousAssociationFor(associations: Readonly<Record<string, string>>, pattern: string): PreviousAssociation {
	return Object.prototype.hasOwnProperty.call(associations, pattern)
		? { kind: 'value', value: associations[pattern] }
		: { kind: 'absent' };
}

function restoreAssociation(associations: Record<string, string>, pattern: string, previous: PreviousAssociation): void {
	if (previous.kind === 'absent') {
		delete associations[pattern];
		return;
	}
	associations[pattern] = previous.kind === 'value' ? previous.value : 'default';
}

export function getRecommendedFirstLaunchFilePreferences(): FirstLaunchFilePreferences {
	return {
		openKqlFiles: true,
		openCslFiles: true,
		openMdFiles: false,
		openSqlFiles: false,
	};
}

export function readGlobalFilePreferences(): FirstLaunchFilePreferences {
	const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
	const preferences = getRecommendedFirstLaunchFilePreferences();
	for (const definition of ASSOCIATION_DEFINITIONS) {
		const inspected = configuration.inspect<boolean>(definition.preferenceKey);
		preferences[definition.preferenceKey] = typeof inspected?.globalValue === 'boolean'
			? inspected.globalValue
			: definition.defaultValue;
	}
	return preferences;
}

export function readGlobalEditorAssociations(): Record<string, string> {
	const inspected = vscode.workspace.getConfiguration('workbench').inspect<Record<string, string>>('editorAssociations');
	return { ...(inspected?.globalValue ?? {}) };
}

export class EditorAssociationManager {
	private reconcileChain: Promise<void> = Promise.resolve();

	constructor(private readonly globalState: GlobalStateLike) {}

	adoptLegacyWorkbenchMappings(): Promise<void> {
		return this.enqueue(async () => {
			const associations = readGlobalEditorAssociations();
			const current = parseOwnershipRecord(this.globalState.get(EDITOR_ASSOCIATION_OWNERSHIP_KEY));
			const next = cloneOwnershipRecord(current);
			for (const definition of ASSOCIATION_DEFINITIONS) {
				if (associations[definition.pattern] === definition.viewType && !next.patterns[definition.pattern]) {
					next.patterns[definition.pattern] = {
						ownedValue: definition.viewType,
						previous: { kind: 'unknown' },
					};
				}
			}
			if (!recordsEqual(current, next)) {
				await this.globalState.update(EDITOR_ASSOCIATION_OWNERSHIP_KEY, next);
			}
		});
	}

	reconcile(
		preferences: FirstLaunchFilePreferences,
		mode: AssociationReconcileMode,
		changedPreferenceKeys?: readonly FilePreferenceKey[],
	): Promise<void> {
		return this.enqueue(() => this.reconcileNow(preferences, mode, changedPreferenceKeys));
	}

	clearOwnership(): Promise<void> {
		return this.enqueue(async () => {
			await this.globalState.update(EDITOR_ASSOCIATION_OWNERSHIP_KEY, undefined);
		});
	}

	resetForDevelopment(): Promise<void> {
		return this.enqueue(async () => {
			const workbenchConfiguration = vscode.workspace.getConfiguration('workbench');
			const associations = readGlobalEditorAssociations();
			const next = { ...associations };
			for (const definition of ASSOCIATION_DEFINITIONS) {
				if (next[definition.pattern] === definition.viewType || next[definition.pattern] === 'default') {
					delete next[definition.pattern];
				}
			}
			if (!recordsEqual(associations, next)) {
				await workbenchConfiguration.update('editorAssociations', next, vscode.ConfigurationTarget.Global);
			}
			await this.globalState.update(EDITOR_ASSOCIATION_OWNERSHIP_KEY, undefined);
		});
	}

	private enqueue(operation: () => Promise<void>): Promise<void> {
		const next = this.reconcileChain.then(operation, operation);
		this.reconcileChain = next.catch(() => undefined);
		return next;
	}

	private async reconcileNow(
		preferences: FirstLaunchFilePreferences,
		mode: AssociationReconcileMode,
		changedPreferenceKeys?: readonly FilePreferenceKey[],
	): Promise<void> {
		const workbenchConfiguration = vscode.workspace.getConfiguration('workbench');
		const currentAssociations = readGlobalEditorAssociations();
		const nextAssociations = { ...currentAssociations };
		const currentOwnership = parseOwnershipRecord(this.globalState.get(EDITOR_ASSOCIATION_OWNERSHIP_KEY));
		const preWriteOwnership = cloneOwnershipRecord(currentOwnership);
		const finalOwnership = cloneOwnershipRecord(currentOwnership);
		const changedKeys = changedPreferenceKeys ? new Set(changedPreferenceKeys) : undefined;

		for (const definition of ASSOCIATION_DEFINITIONS) {
			const definitionMode = mode === 'explicit' && (!changedKeys || changedKeys.has(definition.preferenceKey))
				? 'explicit'
				: 'conservative';
			const desired = preferences[definition.preferenceKey];
			const currentValue = currentAssociations[definition.pattern];
			const ownership = currentOwnership.patterns[definition.pattern];

			if (desired) {
				if (currentValue === definition.viewType) {
					continue;
				}
				const canClaim = definitionMode === 'explicit' || currentValue === undefined || currentValue === 'default';
				if (!canClaim) {
					if (ownership) {
						delete finalOwnership.patterns[definition.pattern];
					}
					continue;
				}
				const nextEntry: AssociationOwnershipEntry = ownership ?? {
					ownedValue: definition.viewType,
					previous: previousAssociationFor(currentAssociations, definition.pattern),
				};
				preWriteOwnership.patterns[definition.pattern] = nextEntry;
				finalOwnership.patterns[definition.pattern] = nextEntry;
				nextAssociations[definition.pattern] = definition.viewType;
				continue;
			}

			if (currentValue !== definition.viewType) {
				if (ownership) {
					delete finalOwnership.patterns[definition.pattern];
				}
				continue;
			}
			if (ownership) {
				restoreAssociation(nextAssociations, definition.pattern, ownership.previous);
				delete finalOwnership.patterns[definition.pattern];
			} else if (definitionMode === 'explicit') {
				nextAssociations[definition.pattern] = 'default';
			}
		}

		if (!recordsEqual(currentOwnership, preWriteOwnership)) {
			await this.globalState.update(EDITOR_ASSOCIATION_OWNERSHIP_KEY, preWriteOwnership);
		}
		if (!recordsEqual(currentAssociations, nextAssociations)) {
			await workbenchConfiguration.update('editorAssociations', nextAssociations, vscode.ConfigurationTarget.Global);
		}
		if (!recordsEqual(preWriteOwnership, finalOwnership)) {
			await this.globalState.update(EDITOR_ASSOCIATION_OWNERSHIP_KEY, finalOwnership);
		}
	}
}