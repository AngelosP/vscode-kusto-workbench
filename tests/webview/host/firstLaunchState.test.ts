import { describe, expect, it, vi } from 'vitest';
import {
	FIRST_LAUNCH_SCHEMA_VERSION,
	hasLegacyFirstLaunchFootprint,
	resolveFirstLaunchState,
	type FirstLaunchWriteJournal,
} from '../../../src/host/firstLaunch/firstLaunchState.js';

const journal: FirstLaunchWriteJournal = {
	schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
	transactionId: 'tx-1',
	outcome: 'completed',
	filePreferences: {
		openKqlFiles: true,
		openCslFiles: true,
		openMdFiles: false,
		openSqlFiles: true,
	},
	editingPreferences: {
		caretDocsEnabled: true,
		autoTriggerAutocompleteEnabled: false,
		copilotInlineCompletionsEnabled: true,
	},
	startedAt: '2026-07-11T00:00:00.000Z',
};

describe('first-launch state resolution', () => {
	it('recovers an interrupted write before considering its partial settings a legacy footprint', () => {
		const resolution = resolveFirstLaunchState(undefined, journal, {
			globalStateKeys: ['kusto.autoTriggerAutocompleteEnabled'],
			explicitFilePreferenceValues: [true, true, false, true],
			globalEditorAssociations: { '*.kql': 'kusto.kqlCompatEditor' },
		});

		expect(resolution).toEqual({ kind: 'recover', journal });
	});

	it('recovers a journal even if a terminal record was written before journal cleanup', () => {
		const record = {
			schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
			status: 'completed' as const,
			completedAt: '2026-07-11T00:01:00.000Z',
		};

		expect(resolveFirstLaunchState(record, journal, {})).toEqual({ kind: 'recover', journal });
	});

	it('does not reopen onboarding for an unknown future record version', () => {
		expect(resolveFirstLaunchState({ schemaVersion: 2, status: 'completed' }, undefined, {}))
			.toEqual({ kind: 'unsupported', schemaVersion: 2 });
	});

	it('does not overwrite future journal or install-marker versions after downgrade', () => {
		expect(resolveFirstLaunchState(undefined, { schemaVersion: 3 }, {}, { schemaVersion: 2 }))
			.toEqual({ kind: 'unsupported', schemaVersion: 3 });
		expect(resolveFirstLaunchState(undefined, undefined, { globalStateKeys: ['kusto.connections'] }, { schemaVersion: 2 }))
			.toEqual({ kind: 'unsupported', schemaVersion: 2 });
	});

	it('leaves a genuinely fresh profile pending', () => {
		expect(resolveFirstLaunchState(undefined, undefined, {
			globalStateKeys: [],
			explicitFilePreferenceValues: [undefined, undefined, undefined, undefined],
			globalEditorAssociations: {},
		})).toEqual({ kind: 'pending' });
	});

	it('keeps an incomplete current install pending even after automatic extension state appears', () => {
		expect(resolveFirstLaunchState(undefined, undefined, {
			globalStateKeys: ['kusto.cachedSchemasMigratedToDisk', 'kusto.connections'],
		}, {
			schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
			createdAt: '2026-07-11T00:00:00.000Z',
		})).toEqual({ kind: 'pending' });
	});

	it('does not misclassify a malformed transaction journal as legacy usage', () => {
		expect(resolveFirstLaunchState(undefined, { schemaVersion: 1, outcome: 'completed' }, {
			globalStateKeys: ['kusto.caretDocsEnabled'],
		})).toEqual({ kind: 'corrupt-journal' });
	});

	it('recognizes explicit legacy preferences and the old four-association signature', () => {
		expect(hasLegacyFirstLaunchFootprint({ explicitFilePreferenceValues: [undefined, false] })).toBe(true);
		expect(hasLegacyFirstLaunchFootprint({
			globalEditorAssociations: {
				'*.kql': 'default',
				'*.csl': 'default',
				'*.md': 'default',
				'*.sql': 'default',
			},
		})).toBe(true);
	});

	it('recognizes known pre-onboarding global state but ignores unrelated keys', () => {
		for (const key of [
			'kusto.connections',
			'kusto.auth.knownAccounts',
			'sql.connections',
			'sql.auth.serverAccountMap',
			'kusto.tutorials.subscriptions.v1',
			'kusto.exportedSkills',
		]) {
			expect(hasLegacyFirstLaunchFootprint({ globalStateKeys: [key] }), key).toBe(true);
		}
		expect(hasLegacyFirstLaunchFootprint({ globalStateKeys: ['unrelated.extension.key'] })).toBe(false);
		expect(hasLegacyFirstLaunchFootprint({ globalStateKeys: ['kusto.firstLaunchSetup.writeJournal.v1'] })).toBe(false);
	});

	it('creates a migrated terminal record for a legacy profile', () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-11T12:00:00.000Z'));

		expect(resolveFirstLaunchState(undefined, undefined, { globalStateKeys: ['kusto.favorites'] }))
			.toEqual({
				kind: 'terminal',
				record: {
					schemaVersion: FIRST_LAUNCH_SCHEMA_VERSION,
					status: 'migrated',
					completedAt: '2026-07-11T12:00:00.000Z',
				},
			});

		vi.useRealTimers();
	});
});