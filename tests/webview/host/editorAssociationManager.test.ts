import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import {
	EDITOR_ASSOCIATION_OWNERSHIP_KEY,
	EditorAssociationManager,
	readGlobalFilePreferences,
} from '../../../src/host/firstLaunch/editorAssociationManager.js';
import type { FirstLaunchFilePreferences } from '../../../src/host/firstLaunch/firstLaunchState.js';

const defaults: FirstLaunchFilePreferences = {
	openKqlFiles: true,
	openCslFiles: true,
	openMdFiles: false,
	openSqlFiles: false,
};

function harness(initialAssociations: Record<string, string> = {}) {
	let associations = { ...initialAssociations };
	const state = new Map<string, unknown>();
	const globalState = {
		get: vi.fn((key: string) => state.get(key)),
		update: vi.fn(async (key: string, value: unknown) => {
			if (value === undefined) state.delete(key);
			else state.set(key, value);
		}),
	};
	const update = vi.fn(async (_key: string, value: Record<string, string>, target: vscode.ConfigurationTarget) => {
		expect(target).toBe(vscode.ConfigurationTarget.Global);
		associations = { ...value };
	});
	vi.spyOn(vscode.workspace, 'getConfiguration').mockImplementation((section: string) => {
		if (section === 'workbench') {
			return {
				inspect: () => ({ defaultValue: { '*.workspace': 'workspace.editor' }, workspaceValue: { '*.workspace': 'workspace.editor' }, globalValue: associations }),
				update,
			} as any;
		}
		return { inspect: () => undefined } as any;
	});
	return { manager: new EditorAssociationManager(globalState as any), state, update, associations: () => associations };
}

describe('EditorAssociationManager', () => {
	beforeEach(() => vi.restoreAllMocks());

	it('claims absent mappings conservatively without hoisting workspace associations', async () => {
		const test = harness({ '*.foreign': 'foreign.editor' });

		await test.manager.reconcile(defaults, 'conservative');

		expect(test.associations()).toEqual({
			'*.foreign': 'foreign.editor',
			'*.kql': 'kusto.kqlCompatEditor',
			'*.csl': 'kusto.kqlCompatEditor',
		});
		expect(test.associations()).not.toHaveProperty('*.workspace');
	});

	it('does not replace a foreign editor during conservative reconciliation', async () => {
		const test = harness({ '*.kql': 'another.kqlEditor' });

		await test.manager.reconcile(defaults, 'conservative');

		expect(test.associations()['*.kql']).toBe('another.kqlEditor');
	});

	it('explicitly claims a foreign editor and restores it when disabled', async () => {
		const test = harness({ '*.kql': 'another.kqlEditor' });

		await test.manager.reconcile(defaults, 'explicit');
		expect(test.associations()['*.kql']).toBe('kusto.kqlCompatEditor');

		await test.manager.reconcile({ ...defaults, openKqlFiles: false }, 'explicit');
		expect(test.associations()['*.kql']).toBe('another.kqlEditor');
	});

	it('restores an originally absent mapping by deleting the property', async () => {
		const test = harness();

		await test.manager.reconcile(defaults, 'explicit');
		await test.manager.reconcile({ ...defaults, openKqlFiles: false }, 'explicit');

		expect(test.associations()).not.toHaveProperty('*.kql');
	});

	it('leaves a manually changed mapping untouched and relinquishes ownership', async () => {
		const test = harness();
		await test.manager.reconcile(defaults, 'explicit');
		const owned = test.state.get(EDITOR_ASSOCIATION_OWNERSHIP_KEY) as any;
		expect(owned.patterns['*.kql']).toBeDefined();

		const current = test.associations();
		current['*.kql'] = 'manually.changed';
		await test.manager.reconcile({ ...defaults, openKqlFiles: false }, 'explicit');

		expect(test.associations()['*.kql']).toBe('manually.changed');
		const released = test.state.get(EDITOR_ASSOCIATION_OWNERSHIP_KEY) as any;
		expect(released.patterns['*.kql']).toBeUndefined();
	});

	it('does not reclaim a manually changed KQL mapping when only the SQL preference changed', async () => {
		const test = harness();
		await test.manager.reconcile(defaults, 'explicit');
		test.associations()['*.kql'] = 'manually.changed';

		await test.manager.reconcile({ ...defaults, openSqlFiles: true }, 'explicit', ['openSqlFiles']);

		expect(test.associations()['*.kql']).toBe('manually.changed');
		expect(test.associations()['*.sql']).toBe('kusto.sqlCompatEditor');
		const ownership = test.state.get(EDITOR_ASSOCIATION_OWNERSHIP_KEY) as any;
		expect(ownership.patterns['*.kql']).toBeUndefined();
	});

	it('adopts migrated Workbench mappings with unknown prior state and disables to default', async () => {
		const test = harness({ '*.kql': 'kusto.kqlCompatEditor' });

		await test.manager.adoptLegacyWorkbenchMappings();
		await test.manager.reconcile({ ...defaults, openKqlFiles: false }, 'explicit');

		expect(test.associations()['*.kql']).toBe('default');
	});

	it('reads only explicit global file preferences and ignores workspace overrides', () => {
		vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
			inspect: (key: string) => key === 'openSqlFiles'
				? { globalValue: false, workspaceValue: true }
				: undefined,
		} as any);

		expect(readGlobalFilePreferences()).toEqual(defaults);
	});
});