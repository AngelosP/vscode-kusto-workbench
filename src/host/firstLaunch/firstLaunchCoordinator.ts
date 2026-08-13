import { randomUUID } from 'crypto';
import * as vscode from 'vscode';
import {
	parseEditingPreferencesHostMessage,
	type EditingPreferencesDataMessage,
} from '../../shared/editingPreferences';
import type {
	FirstLaunchEditingPreferences,
	FirstLaunchFilePreferences,
	FirstLaunchSetupMode,
	FirstLaunchSetupSnapshot,
} from '../../shared/firstLaunchSetup';
import {
	EDITING_PREFERENCE_CONFIGURATION_KEYS,
	getEditingPreferencesData,
	setEditingPreferences,
} from '../editingPreferences';
import { STORAGE_KEYS } from '../queryEditorTypes';
import { getWorkbenchLogger } from '../workbenchLogger';
import {
	readGlobalEditorAssociations,
	readGlobalFilePreferences,
	type AssociationReconcileMode,
	type FilePreferenceKey,
} from './editorAssociationManager';
import {
	FIRST_LAUNCH_SCHEMA_VERSION,
	FIRST_LAUNCH_CORRUPT_JOURNAL_BACKUP_KEY,
	FIRST_LAUNCH_FORCE_PENDING_KEY,
	FIRST_LAUNCH_INSTALL_MARKER_KEY,
	FIRST_LAUNCH_STATE_KEY,
	FIRST_LAUNCH_WRITE_JOURNAL_KEY,
	parseFirstLaunchInstallMarker,
	parseFirstLaunchWriteJournal,
	resolveFirstLaunchState,
	type FirstLaunchResolution,
	type FirstLaunchStateRecord,
	type FirstLaunchWriteJournal,
} from './firstLaunchState';
import {
	FirstLaunchProfileLease,
	type FirstLaunchLeaseHandle,
	type FirstLaunchProfileLeaseLike,
} from './firstLaunchProfileLease';

export type FirstLaunchPanelOutcome = 'completed' | 'skipped' | 'closed' | 'cancelled' | 'operational-failure';
export type FirstLaunchTriggerSource = 'file' | 'activity-bar' | 'command';

export interface FirstLaunchPanelRequest {
	mode: FirstLaunchSetupMode;
	snapshot: FirstLaunchSetupSnapshot;
	onSave: (filePreferences: FirstLaunchFilePreferences, editingPreferences: FirstLaunchEditingPreferences) => Promise<void>;
	onSkip?: () => Promise<void>;
}

interface AssociationManagerLike {
	adoptLegacyWorkbenchMappings(): Promise<void>;
	reconcile(preferences: FirstLaunchFilePreferences, mode: AssociationReconcileMode, changedPreferenceKeys?: readonly FilePreferenceKey[]): Promise<void>;
	clearOwnership(): Promise<void>;
	resetForDevelopment(): Promise<void>;
}

interface FirstLaunchCoordinatorOptions {
	context: vscode.ExtensionContext;
	associationManager: AssociationManagerLike;
	openPanel: (request: FirstLaunchPanelRequest) => Promise<FirstLaunchPanelOutcome>;
	broadcastEditingPreferences: (message: EditingPreferencesDataMessage) => Promise<unknown>;
	migrateFreshProfileByDefault?: boolean;
	migratePendingProfileByDefault?: boolean;
	profileLease?: FirstLaunchProfileLeaseLike;
}

const FILE_PREFERENCE_KEYS = [
	'openKqlFiles',
	'openCslFiles',
	'openMdFiles',
	'openSqlFiles',
] as const;

export class FirstLaunchCoordinator {
	private initialization: Promise<void> | undefined;
	private resolution: FirstLaunchResolution = { kind: 'pending' };
	private activeRun: Promise<FirstLaunchPanelOutcome> | undefined;
	private activeRunMode: FirstLaunchSetupMode | undefined;
	private automaticRunActive = false;
	private sessionSuppressed = false;
	private transactionInFlight = false;
	private developmentForcePending = false;
	private developmentReset: Promise<void> | undefined;
	private firstUseSettled = false;
	private firstUseBarrierGeneration = 0;
	private firstUseSettledPromise!: Promise<void>;
	private resolveFirstUseSettled!: () => void;
	private readonly profileLease: FirstLaunchProfileLeaseLike;

	constructor(private readonly options: FirstLaunchCoordinatorOptions) {
		this.profileLease = options.profileLease
			?? (options.context.globalStorageUri
				? new FirstLaunchProfileLease(options.context.globalStorageUri)
				: { acquire: async () => ({ release: async () => undefined }), waitForRelease: async () => true });
		this.resetFirstUseBarrier();
	}

	initialize(): Promise<void> {
		if (!this.initialization) {
			const attempt = this.initializeOnce();
			this.initialization = attempt;
			void attempt.catch(() => {
				if (this.initialization === attempt) {
					this.initialization = undefined;
				}
			});
		}
		return this.initialization;
	}

	triggerAutomatic(source: FirstLaunchTriggerSource): Promise<FirstLaunchPanelOutcome> {
		if (this.developmentReset) {
			return this.developmentReset.then(() => this.triggerAutomatic(source));
		}
		if (this.activeRun) {
			if (this.activeRunMode === 'automatic') {
				return this.activeRun;
			}
			return this.activeRun.then(() => this.triggerAutomatic(source));
		}
		if (this.sessionSuppressed) {
			return Promise.resolve('closed');
		}
		this.automaticRunActive = true;
		const run = this.runPanel('automatic').finally(() => {
			this.settleFirstUseBarrier();
			if (this.activeRun === run) {
				this.activeRun = undefined;
				this.activeRunMode = undefined;
				this.automaticRunActive = false;
			}
		});
		this.activeRun = run;
		this.activeRunMode = 'automatic';
		return run;
	}

	openConfiguration(): Promise<FirstLaunchPanelOutcome> {
		if (this.developmentReset) {
			return this.developmentReset.then(() => this.openConfiguration());
		}
		if (this.activeRun) {
			return this.activeRun;
		}
		const run = this.runPanel('configure').then(outcome => {
			if (this.resolution.kind === 'terminal') {
				this.settleFirstUseBarrier();
			}
			return outcome;
		}).finally(() => {
			if (this.activeRun === run) {
				this.activeRun = undefined;
				this.activeRunMode = undefined;
			}
		});
		this.activeRun = run;
		this.activeRunMode = 'configure';
		return run;
	}

	async gateCommand(): Promise<void> {
		await this.triggerAutomatic('command');
	}

	async waitForAutomaticSetup(): Promise<void> {
		while (true) {
			if (this.developmentReset) await this.developmentReset;
			await this.initialize();
			const generation = this.firstUseBarrierGeneration;
			if (!this.firstUseSettled) await this.firstUseSettledPromise;
			if (generation === this.firstUseBarrierGeneration && !this.developmentReset) return;
		}
	}

	isAutomaticSetupActive(): boolean {
		return this.automaticRunActive;
	}

	async reconcileFileAssociationsFromSettings(changedPreferenceKeys: readonly FilePreferenceKey[]): Promise<void> {
		await this.initialize();
		if (this.transactionInFlight || this.resolution.kind !== 'terminal') {
			return;
		}
		await this.options.associationManager.reconcile(readGlobalFilePreferences(), 'explicit', changedPreferenceKeys);
	}

	async resetForDevelopment(): Promise<void> {
		if (this.developmentReset) return this.developmentReset;
		const reset = this.resetForDevelopmentOnce();
		this.developmentReset = reset;
		try {
			await reset;
		} finally {
			if (this.developmentReset === reset) this.developmentReset = undefined;
		}
	}

	private async resetForDevelopmentOnce(): Promise<void> {
		const previousRun = this.activeRun;
		if (previousRun) await previousRun;
		const previousInitialization = this.initialization;
		if (previousInitialization) await previousInitialization.catch(() => undefined);
		this.developmentForcePending = true;
		this.transactionInFlight = true;
		this.sessionSuppressed = false;
		try {
			await this.options.context.globalState.update(FIRST_LAUNCH_STATE_KEY, undefined);
			await this.options.context.globalState.update(FIRST_LAUNCH_WRITE_JOURNAL_KEY, undefined);
			await this.options.context.globalState.update(FIRST_LAUNCH_CORRUPT_JOURNAL_BACKUP_KEY, undefined);
			await this.options.context.globalState.update(FIRST_LAUNCH_FORCE_PENDING_KEY, true);
			await this.options.context.globalState.update(FIRST_LAUNCH_INSTALL_MARKER_KEY, {
				schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
				createdAt: new Date().toISOString(),
			});
			await this.options.context.globalState.update(STORAGE_KEYS.caretDocsEnabled, undefined);
			await this.options.context.globalState.update(STORAGE_KEYS.autoTriggerAutocompleteEnabled, undefined);
			await this.options.context.globalState.update(STORAGE_KEYS.copilotInlineCompletionsEnabled, undefined);
			await this.options.context.globalState.update(STORAGE_KEYS.editingPreferencesRevision, undefined);
			await this.options.associationManager.resetForDevelopment();
			const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
			for (const key of FILE_PREFERENCE_KEYS) {
				await configuration.update(key, undefined, vscode.ConfigurationTarget.Global);
			}
			for (const key of Object.values(EDITING_PREFERENCE_CONFIGURATION_KEYS)) {
				await configuration.update(key, undefined, vscode.ConfigurationTarget.Global);
			}
		} finally {
			this.resolution = { kind: 'pending' };
			this.initialization = undefined;
			this.transactionInFlight = false;
			this.resetFirstUseBarrier();
		}
	}

	private async initializeOnce(): Promise<void> {
		const context = this.options.context;
		const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
		const explicitFilePreferenceValues = FILE_PREFERENCE_KEYS.map(key => configuration.inspect<boolean>(key)?.globalValue);
		const storedStateValue = context.globalState.get(FIRST_LAUNCH_STATE_KEY);
		const journalValue = context.globalState.get(FIRST_LAUNCH_WRITE_JOURNAL_KEY);
		const forcePending = context.globalState.get<boolean>(FIRST_LAUNCH_FORCE_PENDING_KEY) === true;
		const stateValue = forcePending && this.developmentForcePending ? undefined : storedStateValue;
		const installMarkerValue = context.globalState.get(FIRST_LAUNCH_INSTALL_MARKER_KEY);
		this.resolution = resolveFirstLaunchState(stateValue, journalValue, {
			globalStateKeys: forcePending ? [] : (typeof context.globalState.keys === 'function' ? [...context.globalState.keys()] : []),
			explicitFilePreferenceValues: forcePending ? [] : explicitFilePreferenceValues,
			globalEditorAssociations: forcePending ? {} : readGlobalEditorAssociations(),
		}, installMarkerValue);
		const migratePendingProfile = this.options.migratePendingProfileByDefault === true
			&& !this.developmentForcePending;
		if (this.resolution.kind === 'pending' && (migratePendingProfile || (this.options.migrateFreshProfileByDefault === true && !forcePending))) {
			if (forcePending && migratePendingProfile) {
				await context.globalState.update(FIRST_LAUNCH_FORCE_PENDING_KEY, undefined);
			}
			this.resolution = {
				kind: 'terminal',
				record: {
					schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
					status: 'migrated',
					completedAt: new Date().toISOString(),
				},
			};
		}
		if (this.resolution.kind === 'pending' && !parseFirstLaunchInstallMarker(installMarkerValue)) {
			await context.globalState.update(FIRST_LAUNCH_INSTALL_MARKER_KEY, {
				schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
				createdAt: new Date().toISOString(),
			});
		}

		if (this.resolution.kind === 'recover') {
			await this.applyJournal(this.resolution.journal);
			this.settleFirstUseBarrier();
			return;
		}
		if (this.resolution.kind === 'corrupt-journal') {
			await context.globalState.update(FIRST_LAUNCH_CORRUPT_JOURNAL_BACKUP_KEY, {
				capturedAt: new Date().toISOString(),
				value: journalValue,
			});
			await context.globalState.update(FIRST_LAUNCH_WRITE_JOURNAL_KEY, undefined);
			this.resolution = { kind: 'pending' };
			if (!parseFirstLaunchInstallMarker(installMarkerValue)) {
				await context.globalState.update(FIRST_LAUNCH_INSTALL_MARKER_KEY, {
					schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
					createdAt: new Date().toISOString(),
				});
			}
			getWorkbenchLogger().warn('[Kusto Workbench] Quarantined a malformed first-launch setup journal and reopened setup.');
			return;
		}
		if (this.resolution.kind === 'unsupported') {
			this.sessionSuppressed = true;
			this.settleFirstUseBarrier();
			return;
		}
		if (this.resolution.kind === 'terminal') {
			if (stateValue === undefined) {
				await context.globalState.update(FIRST_LAUNCH_STATE_KEY, this.resolution.record);
			}
			if (this.resolution.record.status === 'migrated') {
				await this.options.associationManager.adoptLegacyWorkbenchMappings();
			}
			await this.options.associationManager.reconcile(readGlobalFilePreferences(), 'conservative');
			await this.broadcastEditingPreferences(getEditingPreferencesData(context));
			if (journalValue !== undefined) {
				await context.globalState.update(FIRST_LAUNCH_WRITE_JOURNAL_KEY, undefined);
			}
			this.settleFirstUseBarrier();
		}
	}

	private resetFirstUseBarrier(): void {
		const releasePrevious = this.resolveFirstUseSettled;
		this.firstUseBarrierGeneration++;
		this.firstUseSettled = false;
		this.firstUseSettledPromise = new Promise(resolve => {
			this.resolveFirstUseSettled = resolve;
		});
		releasePrevious?.();
	}

	private settleFirstUseBarrier(): void {
		if (this.firstUseSettled) {
			return;
		}
		this.firstUseSettled = true;
		this.resolveFirstUseSettled();
	}

	private broadcastEditingPreferences(message: EditingPreferencesDataMessage): Promise<unknown> {
		const parsed = parseEditingPreferencesHostMessage(message);
		if (!parsed.ok) {
			throw new Error(`Editing preferences publication was invalid: ${parsed.error}`);
		}
		return this.options.broadcastEditingPreferences(parsed.value);
	}

	private async runPanel(mode: FirstLaunchSetupMode): Promise<FirstLaunchPanelOutcome> {
		let lease: FirstLaunchLeaseHandle | undefined;
		try {
			await this.initialize();
			if (this.isUnsupportedResolution()) {
				void vscode.window.showWarningMessage(
					'Kusto Workbench setup was created by a newer extension version. Update the extension before changing these defaults.'
				);
				return 'operational-failure';
			}
			if (mode === 'automatic' && this.resolution.kind !== 'pending') {
				return 'completed';
			}
			lease = await this.profileLease.acquire();
			if (!lease) {
				const released = await this.profileLease.waitForRelease();
				if (!released) {
					return 'operational-failure';
				}
				await this.reloadProfileResolution();
				if (this.isUnsupportedResolution()) {
					void vscode.window.showWarningMessage(
						'Kusto Workbench setup was created by a newer extension version. Update the extension before changing these defaults.'
					);
					return 'operational-failure';
				}
				if (mode === 'configure') {
					return 'cancelled';
				}
				if (this.resolution.kind !== 'pending') {
					return 'completed';
				}
				lease = await this.profileLease.acquire();
				if (!lease) {
					return 'operational-failure';
				}
			}
			await this.reloadProfileResolution();
			if (this.isUnsupportedResolution()) {
				void vscode.window.showWarningMessage(
					'Kusto Workbench setup was created by a newer extension version. Update the extension before changing these defaults.'
				);
				return 'operational-failure';
			}
			if (mode === 'automatic' && this.resolution.kind !== 'pending') {
				return 'completed';
			}
			const snapshot = this.createSnapshot(mode);
			const outcome = await this.options.openPanel({
				mode,
				snapshot,
				onSave: async (filePreferences, editingPreferences) => {
					if (!editingPreferences) {
						throw new Error('Editing preferences are required when saving setup.');
					}
					await this.commit({
						schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
						transactionId: randomUUID(),
						outcome: 'completed',
						filePreferences,
						editingPreferences,
						startedAt: new Date().toISOString(),
					});
				},
				...(mode === 'automatic' ? {
					onSkip: async () => {
						await this.commit({
							schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
							transactionId: randomUUID(),
							outcome: 'skipped',
							filePreferences: readGlobalFilePreferences(),
							startedAt: new Date().toISOString(),
						});
					},
				} : {}),
			});
			if (mode === 'automatic' && (outcome === 'closed' || outcome === 'operational-failure')) {
				this.sessionSuppressed = true;
			}
			return outcome;
		} catch (error) {
			getWorkbenchLogger().error('[Kusto Workbench] First-launch setup failed:', error instanceof Error ? error : String(error));
			if (mode === 'automatic') {
				this.sessionSuppressed = true;
			}
			return 'operational-failure';
		} finally {
			await lease?.release().catch(error => {
				getWorkbenchLogger().error('[Kusto Workbench] Failed to release first-launch lease:', error instanceof Error ? error : String(error));
			});
		}
	}

	private async reloadProfileResolution(): Promise<void> {
		this.initialization = undefined;
		await this.initialize();
	}

	private isUnsupportedResolution(): boolean {
		return this.resolution.kind === 'unsupported';
	}

	private createSnapshot(mode: FirstLaunchSetupMode): FirstLaunchSetupSnapshot {
		const editing = getEditingPreferencesData(this.options.context);
		return {
			mode,
			filePreferences: readGlobalFilePreferences(),
			editingPreferences: {
				caretDocsEnabled: editing.caretDocsEnabled,
				autoTriggerAutocompleteEnabled: editing.autoTriggerAutocompleteEnabled,
				copilotInlineCompletionsEnabled: editing.copilotInlineCompletionsEnabled,
			},
			inlineSuggestEnabled: vscode.workspace.getConfiguration('editor').get<boolean>('inlineSuggest.enabled', true),
		};
	}

	private async commit(requestedJournal: FirstLaunchWriteJournal): Promise<void> {
		const context = this.options.context;
		const existingRaw = context.globalState.get(FIRST_LAUNCH_WRITE_JOURNAL_KEY);
		const existing = parseFirstLaunchWriteJournal(existingRaw);
		if (existingRaw !== undefined && !existing) {
			throw new Error('The previous setup transaction is malformed. Reload VS Code before trying again.');
		}
		const journal = existing ?? requestedJournal;
		if (!existing) {
			await context.globalState.update(FIRST_LAUNCH_WRITE_JOURNAL_KEY, journal);
		}
		await this.applyJournal(journal);
	}

	private async applyJournal(journal: FirstLaunchWriteJournal): Promise<void> {
		const context = this.options.context;
		this.transactionInFlight = true;
		try {
			if (journal.outcome === 'completed') {
				const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
				for (const key of FILE_PREFERENCE_KEYS) {
					await configuration.update(key, journal.filePreferences[key], vscode.ConfigurationTarget.Global);
				}
				await this.options.associationManager.reconcile(journal.filePreferences, 'explicit');
				if (!journal.editingPreferences) {
					throw new Error('The setup transaction is missing editing preferences.');
				}
				const preferences = await setEditingPreferences(context, journal.editingPreferences);
				await this.broadcastEditingPreferences(preferences);
			} else {
				await this.options.associationManager.reconcile(journal.filePreferences, 'conservative');
			}

			const record: FirstLaunchStateRecord = {
				schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
				status: journal.outcome,
				completedAt: new Date().toISOString(),
			};
			await context.globalState.update(FIRST_LAUNCH_STATE_KEY, record);
			await context.globalState.update(FIRST_LAUNCH_FORCE_PENDING_KEY, undefined);
			this.developmentForcePending = false;
			this.resolution = { kind: 'terminal', record };
			await context.globalState.update(FIRST_LAUNCH_WRITE_JOURNAL_KEY, undefined);
		} finally {
			this.transactionInFlight = false;
		}
	}
}
