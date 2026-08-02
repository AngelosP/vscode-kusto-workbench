import { afterEach, describe, expect, it } from 'vitest';
import { parseBrowserWorkbenchText } from '../../browser-ext/src/viewer-document';
import { parseKqlxText, type KqlxFileKind } from '../../src/host/kqlxFormat';
import {
	addableSectionKindsForDocument,
	canonicalSectionKind,
	defaultSectionKindForDocument,
	sectionKindCompatibility,
} from '../../src/shared/documentSectionCapabilities';
import {
	applyDocumentCapabilityProjection,
	getAddSectionAdmission,
	getAllowedAddSectionKinds,
	getDefaultAddSectionKind,
} from '../../src/webview/core/document-capabilities';
import { pState } from '../../src/webview/shared/persistence-state';

const knownSectionKinds = [
	'query', 'copilotQuery', 'sql', 'chart', 'transformation',
	'markdown', 'python', 'url', 'html', 'devnotes',
] as const;

const expectedPersistedKinds = {
	kqlx: knownSectionKinds,
	sqlx: ['sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html', 'devnotes'],
	mdx: ['markdown', 'url', 'transformation', 'devnotes'],
} as const satisfies Readonly<Record<KqlxFileKind, readonly (typeof knownSectionKinds)[number][]>>;

const expectedAddableKinds = {
	kqlx: ['query', 'sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
	sqlx: ['sql', 'chart', 'transformation', 'python', 'url', 'html', 'markdown'],
	mdx: ['markdown', 'url', 'transformation'],
} as const;

const originalProjection = {
	documentKind: pState.documentKind,
	allowedSectionKinds: [...pState.allowedSectionKinds],
	defaultSectionKind: pState.defaultSectionKind,
	upgradeRequestType: pState.upgradeRequestType,
};

afterEach(() => {
	pState.documentKind = originalProjection.documentKind;
	pState.allowedSectionKinds = [...originalProjection.allowedSectionKinds];
	pState.defaultSectionKind = originalProjection.defaultSectionKind;
	pState.upgradeRequestType = originalProjection.upgradeRequestType;
});

describe('document section capability matrix', () => {
	it.each(Object.keys(expectedPersistedKinds) as KqlxFileKind[])(
		'keeps matrix, parser, host projection, webview admission, and browser parsing aligned for %s',
		(documentKind) => {
			const expectedPersisted = new Set<string>(expectedPersistedKinds[documentKind]);
			const expectedAddable = expectedAddableKinds[documentKind];
			const allVisualKinds = ['query', 'sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html'];
			applyDocumentCapabilityProjection({
				documentKind,
				allowedSectionKinds: allVisualKinds,
				defaultSectionKind: defaultSectionKindForDocument(documentKind),
			});

			expect(addableSectionKindsForDocument(documentKind)).toEqual(expectedAddable);
			expect(getAllowedAddSectionKinds()).toEqual(expectedAddable);

			for (const rawSectionKind of knownSectionKinds) {
				const canonicalKind = canonicalSectionKind(rawSectionKind)!;
				const persistAllowed = expectedPersisted.has(rawSectionKind);
				const addAllowed = persistAllowed && canonicalKind !== 'devnotes';
				const section = { id: `${rawSectionKind}_section`, type: rawSectionKind };
				const text = JSON.stringify({ kind: documentKind, version: 1, state: { sections: [section] } });

				expect(
					sectionKindCompatibility(documentKind, rawSectionKind),
					`${documentKind}/${rawSectionKind} matrix`,
				).toBe(persistAllowed ? 'allowed' : 'incompatible');
				const parsed = parseKqlxText(text, { allowedKinds: [documentKind] });
				expect(parsed.ok, `${documentKind}/${rawSectionKind} host parser`).toBe(persistAllowed);
				const browserParsed = parseBrowserWorkbenchText(text, { allowedKinds: [documentKind] });
				expect(browserParsed.ok, `${documentKind}/${rawSectionKind} browser parser`).toBe(persistAllowed);
				expect(
					addableSectionKindsForDocument(documentKind).includes(canonicalKind as never),
					`${documentKind}/${rawSectionKind} host projection`,
				).toBe(addAllowed);
				const webviewAdmission = getAddSectionAdmission(rawSectionKind);
				expect(webviewAdmission.ok, `${documentKind}/${rawSectionKind} webview admission`).toBe(addAllowed);
				if (webviewAdmission.ok) expect(webviewAdmission.sectionKind).toBe(canonicalKind);
			}
		},
	);

	it.each(['kqlx', 'sqlx', 'mdx'] as const)(
		'preserves opaque future content while refusing to create it in %s',
		(documentKind) => {
			applyDocumentCapabilityProjection({
				documentKind,
				allowedSectionKinds: ['query', 'sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html'],
			});
			const section = { id: 'future_section', type: 'future-section', payload: { keep: true } };
			const text = JSON.stringify({ kind: documentKind, version: 1, state: { sections: [section] } });

			expect(sectionKindCompatibility(documentKind, section.type)).toBe('unknown');
			const parsed = parseKqlxText(text, { allowedKinds: [documentKind] });
			expect(parsed.ok).toBe(true);
			if (parsed.ok) expect(parsed.file.state.sections).toEqual([section]);
			const browserParsed = parseBrowserWorkbenchText(text, { allowedKinds: [documentKind] });
			expect(browserParsed.ok).toBe(true);
			if (browserParsed.ok) expect(browserParsed.file.state.sections).toEqual([section]);
			expect(getAddSectionAdmission(section.type)).toMatchObject({ ok: false });
		},
	);

	it('keeps an explicit empty host capability projection empty', () => {
		applyDocumentCapabilityProjection({
			documentKind: 'mdx', allowedSectionKinds: [], defaultSectionKind: 'markdown',
		});

		expect(getAllowedAddSectionKinds()).toEqual([]);
		expect(getDefaultAddSectionKind()).toBeUndefined();
		expect(getAddSectionAdmission('markdown')).toMatchObject({
			ok: false, error: expect.stringContaining('unavailable in the current document host'),
		});
	});
});