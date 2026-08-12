import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { FirstLaunchCoordinator, type FirstLaunchPanelRequest } from '../../../src/host/firstLaunch/firstLaunchCoordinator.js';
import type { FirstLaunchProfileLeaseLike } from '../../../src/host/firstLaunch/firstLaunchProfileLease.js';
import {
	FIRST_LAUNCH_CORRUPT_JOURNAL_BACKUP_KEY,
	FIRST_LAUNCH_FORCE_PENDING_KEY,
	FIRST_LAUNCH_INSTALL_MARKER_KEY,
	FIRST_LAUNCH_STATE_KEY,
	FIRST_LAUNCH_WRITE_JOURNAL_KEY,
} from '../../../src/host/firstLaunch/firstLaunchState.js';

function harness(options: {
	legacy?: boolean;
	failOnceOnKey?: string;
	migrateFreshProfileByDefault?: boolean;
	migratePendingProfileByDefault?: boolean;
	state?: Map<string, unknown>;
	configValues?: Map<string, boolean>;
	profileLease?: FirstLaunchProfileLeaseLike;
} = {}) {
	const state = options.state ?? new Map<string, unknown>();
	if (options.legacy) state.set('kusto.lastConnectionId', 'legacy');
	let failed = false;
	const globalState = {
		get: (key: string) => state.get(key),
		keys: () => [...state.keys()],
		update: vi.fn(async (key: string, value: unknown) => {
			if (!failed && options.failOnceOnKey === key) {
				failed = true;
				throw new Error(`Injected failure for ${key}`);
			}
			if (value === undefined) state.delete(key);
			else state.set(key, value);
		}),
	};
	const configValues = options.configValues ?? new Map<string, boolean>();
	const updateConfig = vi.fn(async (key: string, value: boolean | undefined) => {
		if (value === undefined) configValues.delete(key);
		else configValues.set(key, value);
	});
	vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => ({
		get: (_key: string, fallback: unknown) => fallback,
		inspect: (key: string) => section === 'workbench'
			? { globalValue: {} }
			: { globalValue: configValues.get(key) },
		update: updateConfig,
	}) as any);
	const associationManager = {
		adoptLegacyWorkbenchMappings: vi.fn(async () => undefined),
		reconcile: vi.fn(async () => undefined),
		clearOwnership: vi.fn(async () => undefined),
		resetForDevelopment: vi.fn(async () => undefined),
	};
	let panelRequest: FirstLaunchPanelRequest | undefined;
	let panelResolver: ((outcome: any) => void) | undefined;
	const openPanel = vi.fn((request: FirstLaunchPanelRequest) => {
		panelRequest = request;
		return new Promise(resolve => { panelResolver = resolve; });
	});
	const broadcast = vi.fn(async () => undefined);
	const profileLease = options.profileLease ?? {
		acquire: vi.fn(async () => ({ release: async () => undefined })),
		waitForRelease: vi.fn(async () => true),
	};
	const coordinator = new FirstLaunchCoordinator({
		context: { globalState } as any,
		associationManager,
		openPanel,
		broadcastEditingPreferences: broadcast,
		migrateFreshProfileByDefault: options.migrateFreshProfileByDefault,
		migratePendingProfileByDefault: options.migratePendingProfileByDefault,
		profileLease,
	});
	return {
		state,
		globalState,
		associationManager,
		openPanel,
		broadcast,
		coordinator,
		request: () => panelRequest!,
		resolvePanel: (outcome: any) => panelResolver?.(outcome),
	};
}

async function flush(): Promise<void> {
	for (let index = 0; index < 20; index++) await Promise.resolve();
}

function sharedLease(): FirstLaunchProfileLeaseLike {
	let held = false;
	let releaseWaiters: Array<() => void> = [];
	return {
		acquire: async () => {
			if (held) return undefined;
			held = true;
			return {
				release: async () => {
					held = false;
					const waiters = releaseWaiters;
					releaseWaiters = [];
					for (const resolve of waiters) resolve();
				},
			};
		},
		waitForRelease: async () => {
			if (!held) return true;
			await new Promise<void>(resolve => releaseWaiters.push(resolve));
			return true;
		},
	};
}

describe('FirstLaunchCoordinator', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('coalesces simultaneous automatic triggers into one panel', async () => {
		const test = harness();
		const file = test.coordinator.triggerAutomatic('file');
		const activity = test.coordinator.triggerAutomatic('activity-bar');
		const command = test.coordinator.triggerAutomatic('command');
		await flush();

		expect(test.openPanel).toHaveBeenCalledOnce();
		expect(file).toBe(activity);
		expect(activity).toBe(command);
		test.resolvePanel('closed');
		await expect(file).resolves.toBe('closed');
	});

	it('migrates an existing profile without opening setup', async () => {
		const test = harness({ legacy: true });

		await expect(test.coordinator.triggerAutomatic('file')).resolves.toBe('completed');

		expect(test.openPanel).not.toHaveBeenCalled();
		expect(test.associationManager.adoptLegacyWorkbenchMappings).toHaveBeenCalledOnce();
		expect((test.state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('migrated');
	});

	it('journals before mutations and completes a saved setup', async () => {
		const test = harness();
		const run = test.coordinator.triggerAutomatic('command');
		await flush();
		test.globalState.update.mockClear();

		await test.request().onSave(
			{ openKqlFiles: true, openCslFiles: false, openMdFiles: true, openSqlFiles: false },
			{ caretDocsEnabled: false, autoTriggerAutocompleteEnabled: true, copilotInlineCompletionsEnabled: false },
		);
		expect(test.globalState.update.mock.calls[0][0]).toBe(FIRST_LAUNCH_WRITE_JOURNAL_KEY);
		expect(test.state.has(FIRST_LAUNCH_WRITE_JOURNAL_KEY)).toBe(false);
		expect((test.state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('completed');
		expect(test.broadcast).toHaveBeenCalledOnce();
		test.resolvePanel('completed');
		await expect(run).resolves.toBe('completed');
	});

	it('recovers a transaction after an injected mid-write failure without opening another panel', async () => {
		const first = harness({ failOnceOnKey: 'kusto.editingPreferencesRevision' });
		const run = first.coordinator.triggerAutomatic('command');
		await flush();
		await expect(first.request().onSave(
			{ openKqlFiles: true, openCslFiles: true, openMdFiles: false, openSqlFiles: true },
			{ caretDocsEnabled: true, autoTriggerAutocompleteEnabled: false, copilotInlineCompletionsEnabled: true },
		)).rejects.toThrow('Injected failure');
		expect(first.state.has(FIRST_LAUNCH_WRITE_JOURNAL_KEY)).toBe(true);
		first.resolvePanel('operational-failure');
		await run;

		const second = harness({ state: new Map(first.state) });
		await second.coordinator.initialize();

		expect(second.openPanel).not.toHaveBeenCalled();
		expect((second.state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('completed');
		expect(second.state.has(FIRST_LAUNCH_WRITE_JOURNAL_KEY)).toBe(false);
	});

	it('Skip preserves inherited editing preferences and applies associations conservatively', async () => {
		const test = harness();
		const run = test.coordinator.triggerAutomatic('activity-bar');
		await flush();

		await test.request().onSkip?.();
		expect(test.broadcast).not.toHaveBeenCalled();
		expect(test.associationManager.reconcile).toHaveBeenCalledWith(expect.any(Object), 'conservative');
		expect((test.state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('skipped');
		test.resolvePanel('skipped');
		await run;
	});

	it('development reset remains pending even when unrelated legacy state exists', async () => {
		const test = harness({ legacy: true });
		await test.coordinator.resetForDevelopment();
		expect(test.state.get(FIRST_LAUNCH_FORCE_PENDING_KEY)).toBe(true);

		const run = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		test.resolvePanel('closed');
		await run;
	});

	it('waits for an earlier setup run before resetting command admission', async () => {
		const test = harness();
		const firstRun = test.coordinator.triggerAutomatic('file');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();

		let resetSettled = false;
		const reset = test.coordinator.resetForDevelopment().then(() => { resetSettled = true; });
		await flush();
		expect(resetSettled).toBe(false);

		test.resolvePanel('closed');
		await firstRun;
		await reset;

		const commandRun = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledTimes(2);
		test.resolvePanel('closed');
		await commandRun;
	});

	it('holds a new automatic trigger until a development reset finishes', async () => {
		const test = harness();
		let releaseStateWrite!: () => void;
		const stateWrite = new Promise<void>(resolve => { releaseStateWrite = resolve; });
		test.globalState.update.mockImplementationOnce(async (key: string, value: unknown) => {
			await stateWrite;
			if (value === undefined) test.state.delete(key);
			else test.state.set(key, value);
		});

		const reset = test.coordinator.resetForDevelopment();
		await flush();
		const commandRun = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).not.toHaveBeenCalled();

		releaseStateWrite();
		await reset;
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		test.resolvePanel('closed');
		await commandRun;
	});

	it('waits for stale initialization before writing development reset state', async () => {
		const state = new Map<string, unknown>([
			[FIRST_LAUNCH_FORCE_PENDING_KEY, true],
			[FIRST_LAUNCH_INSTALL_MARKER_KEY, { schemaVersion: 1, createdAt: 'before-reset' }],
		]);
		const test = harness({ state, migratePendingProfileByDefault: true });
		let releaseMigration!: () => void;
		const migrationWrite = new Promise<void>(resolve => { releaseMigration = resolve; });
		let blockedMigration = false;
		test.globalState.update.mockImplementation(async (key: string, value: unknown) => {
			if (!blockedMigration && key === FIRST_LAUNCH_FORCE_PENDING_KEY && value === undefined) {
				blockedMigration = true;
				await migrationWrite;
			}
			if (value === undefined) state.delete(key);
			else state.set(key, value);
		});

		const initialization = test.coordinator.initialize();
		await flush();
		const reset = test.coordinator.resetForDevelopment();
		await flush();
		expect(state.get(FIRST_LAUNCH_FORCE_PENDING_KEY)).toBe(true);

		releaseMigration();
		await initialization;
		await reset;
		expect(state.get(FIRST_LAUNCH_FORCE_PENDING_KEY)).toBe(true);
		expect(state.has(FIRST_LAUNCH_STATE_KEY)).toBe(false);

		const commandRun = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		test.resolvePanel('closed');
		await commandRun;
	});

	it('can migrate a fresh development profile unless reset explicitly forces pending', async () => {
		const test = harness({ migrateFreshProfileByDefault: true });

		await expect(test.coordinator.triggerAutomatic('command')).resolves.toBe('completed');
		expect(test.openPanel).not.toHaveBeenCalled();
		expect((test.state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('migrated');
	});

	it('can migrate an explicitly pending E2E profile without opening setup', async () => {
		const state = new Map<string, unknown>([[FIRST_LAUNCH_FORCE_PENDING_KEY, true]]);
		const test = harness({ state, migratePendingProfileByDefault: true });

		await expect(test.coordinator.triggerAutomatic('command')).resolves.toBe('completed');

		expect(test.openPanel).not.toHaveBeenCalled();
		expect(test.state.has(FIRST_LAUNCH_FORCE_PENDING_KEY)).toBe(false);
		expect((test.state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('migrated');
	});

	it('development reset overrides pending-profile migration for the next setup run', async () => {
		const test = harness({ migratePendingProfileByDefault: true });
		await test.coordinator.resetForDevelopment();

		const run = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		test.resolvePanel('closed');
		await run;
	});

	it('development reset overrides a stale terminal state written after reset', async () => {
		const test = harness({ migratePendingProfileByDefault: true });
		await test.coordinator.resetForDevelopment();
		test.state.set(FIRST_LAUNCH_STATE_KEY, {
			schemaVersion: 1,
			status: 'migrated',
			completedAt: new Date().toISOString(),
		});

		const run = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		test.resolvePanel('closed');
		await run;
	});

	it('quarantines a malformed current journal and reopens setup', async () => {
		const state = new Map<string, unknown>([[FIRST_LAUNCH_WRITE_JOURNAL_KEY, { schemaVersion: 1, outcome: 'completed' }]]);
		const test = harness({ state });

		const run = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		expect(state.has(FIRST_LAUNCH_WRITE_JOURNAL_KEY)).toBe(false);
		expect(state.get(FIRST_LAUNCH_CORRUPT_JOURNAL_BACKUP_KEY)).toEqual(expect.objectContaining({
			value: { schemaVersion: 1, outcome: 'completed' },
		}));
		test.resolvePanel('closed');
		await run;
	});

	it.each([
		[FIRST_LAUNCH_STATE_KEY, { schemaVersion: 2, status: 'completed', completedAt: 'future' }],
		[FIRST_LAUNCH_WRITE_JOURNAL_KEY, { schemaVersion: 2, outcome: 'completed' }],
		[FIRST_LAUNCH_INSTALL_MARKER_KEY, { schemaVersion: 2, createdAt: 'future' }],
	])('refuses Configure without modifying future onboarding data in %s', async (key, value) => {
		const state = new Map<string, unknown>([[key, value]]);
		const test = harness({ state });

		await expect(test.coordinator.openConfiguration()).resolves.toBe('operational-failure');

		expect(test.openPanel).not.toHaveBeenCalled();
		expect(state.get(key)).toEqual(value);
	});

	it.each([
		[FIRST_LAUNCH_STATE_KEY, { schemaVersion: 2, status: 'completed', completedAt: 'future' }],
		[FIRST_LAUNCH_WRITE_JOURNAL_KEY, { schemaVersion: 2, outcome: 'completed' }],
		[FIRST_LAUNCH_INSTALL_MARKER_KEY, { schemaVersion: 2, createdAt: 'future' }],
	])('warns and preserves future onboarding data in %s after waiting for the lease', async (key, value) => {
		const state = new Map<string, unknown>();
		let firstAcquire = true;
		const profileLease: FirstLaunchProfileLeaseLike = {
			acquire: async () => {
				if (firstAcquire) {
					firstAcquire = false;
					return undefined;
				}
				return { release: async () => undefined };
			},
			waitForRelease: async () => {
				state.set(key, value);
				return true;
			},
		};
		const warning = vi.spyOn(vscode.window, 'showWarningMessage');
		const test = harness({ state, profileLease });

		await expect(test.coordinator.openConfiguration()).resolves.toBe('operational-failure');

		expect(test.openPanel).not.toHaveBeenCalled();
		expect(state.get(key)).toEqual(value);
		expect(warning).toHaveBeenCalledWith(expect.stringContaining('newer extension version'));
	});

	it('clears a failed initialization promise so bootstrap can retry safely', async () => {
		const test = harness({ failOnceOnKey: FIRST_LAUNCH_INSTALL_MARKER_KEY });

		await expect(test.coordinator.initialize()).rejects.toThrow('Injected failure');
		await expect(test.coordinator.initialize()).resolves.toBeUndefined();
		expect(test.state.get(FIRST_LAUNCH_INSTALL_MARKER_KEY)).toEqual(expect.objectContaining({ schemaVersion: 1 }));
	});

	it('keeps Close pending across reload even after automatic extension state is written', async () => {
		const first = harness();
		const firstRun = first.coordinator.triggerAutomatic('command');
		await flush();
		first.resolvePanel('closed');
		await firstRun;
		first.state.set('kusto.cachedSchemasMigratedToDisk', true);

		const second = harness({ state: new Map(first.state) });
		const secondRun = second.coordinator.triggerAutomatic('command');
		await flush();
		expect(second.openPanel).toHaveBeenCalledOnce();
		second.resolvePanel('closed');
		await secondRun;
	});

	it('holds automatic tutorial content until the pending setup settles', async () => {
		const test = harness();
		let released = false;
		const waiting = test.coordinator.waitForAutomaticSetup().then(() => { released = true; });
		await flush();
		expect(released).toBe(false);

		const run = test.coordinator.triggerAutomatic('activity-bar');
		await flush();
		test.resolvePanel('closed');
		await run;
		await waiting;
		expect(released).toBe(true);
	});

	it('carries an automatic tutorial waiter across development reset', async () => {
		const test = harness();
		let released = false;
		const waiting = test.coordinator.waitForAutomaticSetup().then(() => { released = true; });
		await flush();

		await test.coordinator.resetForDevelopment();
		await flush();
		expect(released).toBe(false);

		const run = test.coordinator.triggerAutomatic('command');
		await flush();
		expect(test.openPanel).toHaveBeenCalledOnce();
		test.resolvePanel('closed');
		await run;
		await waiting;
		expect(released).toBe(true);
	});

	it('opens automatic setup before releasing a command when first-use Configure is cancelled', async () => {
		const test = harness();
		const configure = test.coordinator.openConfiguration();
		await flush();
		expect(test.request().mode).toBe('configure');
		let commandReleased = false;
		const command = test.coordinator.gateCommand().then(() => { commandReleased = true; });
		await flush();
		expect(commandReleased).toBe(false);
		test.resolvePanel('cancelled');
		await configure;
		await flush();
		expect(test.openPanel).toHaveBeenCalledTimes(2);
		expect(test.request().mode).toBe('automatic');
		expect(commandReleased).toBe(false);
		test.resolvePanel('closed');
		await command;
		expect(commandReleased).toBe(true);
	});

	it('settles the tutorial barrier when first-use Configure is saved', async () => {
		const test = harness();
		let tutorialReleased = false;
		const tutorial = test.coordinator.waitForAutomaticSetup().then(() => { tutorialReleased = true; });
		const configure = test.coordinator.openConfiguration();
		await flush();
		await test.request().onSave(
			{ openKqlFiles: true, openCslFiles: true, openMdFiles: false, openSqlFiles: false },
			{ caretDocsEnabled: true, autoTriggerAutocompleteEnabled: true, copilotInlineCompletionsEnabled: true },
		);
		test.resolvePanel('completed');
		await configure;
		await tutorial;
		expect(tutorialReleased).toBe(true);
	});

	it('allows one setup owner across two coordinators and makes the waiter observe completion', async () => {
		const state = new Map<string, unknown>();
		const configValues = new Map<string, boolean>();
		const lease = sharedLease();
		const first = harness({ state, configValues, profileLease: lease });
		const second = harness({ state, configValues, profileLease: lease });

		const firstRun = first.coordinator.triggerAutomatic('command');
		await flush();
		expect(first.openPanel).toHaveBeenCalledOnce();
		const secondRun = second.coordinator.triggerAutomatic('activity-bar');
		await flush();
		expect(second.openPanel).not.toHaveBeenCalled();

		await first.request().onSave(
			{ openKqlFiles: true, openCslFiles: true, openMdFiles: false, openSqlFiles: false },
			{ caretDocsEnabled: true, autoTriggerAutocompleteEnabled: false, copilotInlineCompletionsEnabled: false },
		);
		first.resolvePanel('completed');
		await firstRun;
		await secondRun;

		expect(second.openPanel).not.toHaveBeenCalled();
		expect((state.get(FIRST_LAUNCH_STATE_KEY) as any).status).toBe('completed');
		expect(second.broadcast).toHaveBeenCalledWith(expect.objectContaining({
			autoTriggerAutocompleteEnabled: false,
			copilotInlineCompletionsEnabled: false,
		}));
	});
});