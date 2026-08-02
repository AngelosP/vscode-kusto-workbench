import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import '../../src/webview/sections/kw-query-section.js';
import '../../src/webview/sections/kw-sql-section.js';
import {
	__kustoWithPinnedSectionRemovalBypass,
	removeQueryBox,
	removeSqlBox,
	sqlBoxes,
} from '../../src/webview/core/section-factory.js';
import {
	getKqlxState,
	handleDocumentDataMessage,
	resetDocumentPersistenceForTest,
	suppressPersistenceForTest,
} from '../../src/webview/core/persistence.js';
import { queryBoxes } from '../../src/webview/core/state.js';
import { pState } from '../../src/webview/shared/persistence-state.js';

function clearSections(): void {
	__kustoWithPinnedSectionRemovalBypass(() => {
		for (const boxId of [...queryBoxes]) removeQueryBox(boxId);
		for (const boxId of [...sqlBoxes]) removeSqlBox(boxId);
	});
}

describe('pinned compatibility reload', () => {
	beforeEach(() => {
		suppressPersistenceForTest(true);
		resetDocumentPersistenceForTest();
		clearSections();
		document.body.innerHTML = '<div id="queries-container"></div>';
	});

	afterEach(() => {
		clearSections();
		pState.firstSectionPinned = false;
		document.body.innerHTML = '';
		suppressPersistenceForTest(false);
	});

	it.each([
		{
			label: 'KQL', documentKind: 'kql', upgradeRequestType: 'requestUpgradeToKqlx',
			sectionKind: 'query', sectionId: 'query_primary', before: 'print before = 1', after: 'print after = 2',
		},
		{
			label: 'SQL', documentKind: 'sql', upgradeRequestType: 'requestUpgradeToSqlx',
			sectionKind: 'sql', sectionId: 'sql_primary', before: 'SELECT 1', after: 'SELECT 2',
		},
	] as const)('force reloads one pinned $label primary without duplicate identity', async variant => {
		const apply = (query: string) => handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentUri: `file:///tmp/pinned-primary${variant.documentKind === 'sql' ? '.sql' : '.kql'}`,
			documentKind: variant.documentKind,
			upgradeRequestType: variant.upgradeRequestType,
			compatibilityMode: false,
			compatibilitySingleKind: variant.sectionKind,
			firstSectionPinned: true,
			allowedSectionKinds: variant.sectionKind === 'sql'
				? ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown']
				: ['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
			defaultSectionKind: variant.sectionKind,
			state: { sections: [{ id: variant.sectionId, type: variant.sectionKind, query }] },
		});

		expect(apply(variant.before)).toBe(true);
		expect(apply(variant.after)).toBe(true);
		await Promise.resolve();

		const ids = variant.sectionKind === 'sql' ? sqlBoxes : queryBoxes;
		expect(ids.filter(id => id === variant.sectionId)).toHaveLength(1);
		expect(document.querySelectorAll(`[id="${variant.sectionId}"]`)).toHaveLength(1);
		expect(getKqlxState().sections).toEqual(expect.arrayContaining([
			expect.objectContaining({ id: variant.sectionId, type: variant.sectionKind, query: variant.after }),
		]));
	});

	it.each([
		{ label: 'KQL', documentKind: 'kql', primaryKind: 'query', primaryId: 'compat_primary_query', query: 'print 1' },
		{ label: 'SQL', documentKind: 'sql', primaryKind: 'sql', primaryId: 'compat_primary_sql', query: 'SELECT 1' },
	] as const)('blocks real UI removal of a plain pinned $label primary', variant => {
		expect(handleDocumentDataMessage({
			type: 'documentData', ok: true, forceReload: true,
			documentUri: `file:///tmp/plain${variant.documentKind === 'sql' ? '.sql' : '.kql'}`,
			documentKind: variant.documentKind,
			compatibilityMode: true,
			compatibilitySingleKind: variant.primaryKind,
			firstSectionPinned: true,
			documentMutationAllowed: true,
			allowedSectionKinds: variant.primaryKind === 'sql' ? ['sql', 'markdown'] : ['query', 'markdown'],
			defaultSectionKind: variant.primaryKind,
			state: { sections: [{ id: variant.primaryId, type: variant.primaryKind, query: variant.query }] },
		})).toBe(true);
		const ids = variant.primaryKind === 'sql' ? sqlBoxes : queryBoxes;
		const primaryId = String(ids[0] || '');
		expect(primaryId).toBe(variant.primaryId);
		expect(getKqlxState().sections).toEqual([
			expect.objectContaining({ id: variant.primaryId, type: variant.primaryKind, query: variant.query }),
		]);

		if (variant.primaryKind === 'sql') removeSqlBox(primaryId);
		else removeQueryBox(primaryId);

		expect(document.getElementById(primaryId)).not.toBeNull();
		expect(ids).toContain(primaryId);
	});
});