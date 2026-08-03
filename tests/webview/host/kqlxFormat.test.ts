import { describe, it, expect } from 'vitest';
import {
	createEmptyKqlxFile,
	createEmptyKqlxOrMdxFile,
	overlayKqlxFileState,
	parseKqlxText,
	stringifyKqlxFile,
	type KqlxFileKind,
	type KqlxFileV1
} from '../../../src/host/kqlxFormat';

const knownSectionKinds = [
	'query', 'copilotQuery', 'sql', 'chart', 'transformation',
	'markdown', 'python', 'url', 'html', 'devnotes',
] as const;

const expectedSectionKindsByDocument = {
	kqlx: knownSectionKinds,
	sqlx: ['sql', 'chart', 'transformation', 'markdown', 'python', 'url', 'html', 'devnotes'],
	mdx: ['markdown', 'url', 'transformation', 'devnotes'],
} as const satisfies Readonly<Record<KqlxFileKind, readonly (typeof knownSectionKinds)[number][]>>;

describe('createEmptyKqlxFile', () => {
	it('returns kqlx file with kind, version 1, empty sections', () => {
		const file = createEmptyKqlxFile();
		expect(file.kind).toBe('kqlx');
		expect(file.version).toBe(1);
		expect(Array.isArray(file.state.sections)).toBe(true);
		expect(file.state.sections).toHaveLength(0);
	});
});

describe('createEmptyKqlxOrMdxFile', () => {
	it('kind kqlx → kind is kqlx', () => {
		const file = createEmptyKqlxOrMdxFile('kqlx');
		expect(file.kind).toBe('kqlx');
		expect(file.version).toBe(1);
		expect(file.state.sections).toEqual([]);
	});

	it('kind mdx → kind is mdx', () => {
		const file = createEmptyKqlxOrMdxFile('mdx');
		expect(file.kind).toBe('mdx');
		expect(file.version).toBe(1);
		expect(file.state.sections).toEqual([]);
	});
});

describe('parseKqlxText', () => {
	it('valid minimal JSON → ok: true', () => {
		const text = '{"kind":"kqlx","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('kqlx');
			expect(result.file.version).toBe(1);
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('empty string → ok: true with default empty kqlx file', () => {
		const result = parseKqlxText('');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('kqlx');
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('empty string with defaultKind mdx → ok: true with mdx kind', () => {
		const result = parseKqlxText('', { defaultKind: 'mdx' });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('mdx');
		}
	});

	it('invalid JSON (syntax error) → ok: false', () => {
		const result = parseKqlxText('{not valid json}');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('Invalid JSON');
		}
	});

	it('valid JSON but wrong kind → ok: false', () => {
		const text = '{"kind":"bad","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('kind');
		}
	});

	it('kind mdx accepted when allowedKinds includes mdx', () => {
		const text = '{"kind":"mdx","version":1,"state":{"sections":[]}}';
		const result = parseKqlxText(text, { allowedKinds: ['kqlx', 'mdx'] });
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('mdx');
		}
	});

	it.each(Object.entries(expectedSectionKindsByDocument) as [KqlxFileKind, readonly string[]][])(
		'reports every known incompatible section in %s instead of accepting it for later filtering',
		(documentKind, allowedKinds) => {
			for (const sectionKind of knownSectionKinds) {
				const sectionId = `${sectionKind}_section`;
				const result = parseKqlxText(JSON.stringify({
					kind: documentKind,
					version: 1,
					state: { sections: [{ id: sectionId, type: sectionKind }] },
				}), { allowedKinds: [documentKind] });
				const expectedAllowed = allowedKinds.includes(sectionKind);

				expect(result.ok, `${documentKind}/${sectionKind}`).toBe(expectedAllowed);
				if (!expectedAllowed && !result.ok) {
					expect(result.error).toContain(documentKind);
					expect(result.error).toContain(sectionId);
					expect(result.error).toContain(sectionKind === 'copilotQuery' ? 'query' : sectionKind);
				}
			}
		},
	);

	it.each(['kqlx', 'sqlx', 'mdx'] as const)('accepts and preserves an opaque future section in %s', documentKind => {
		const futureSection = { id: 'future_section', type: 'future-section', payload: { keep: true } };
		const result = parseKqlxText(JSON.stringify({
			kind: documentKind,
			version: 1,
			state: { sections: [futureSection] },
		}), { allowedKinds: [documentKind] });

		expect(result.ok).toBe(true);
		if (result.ok) expect(result.file.state.sections).toEqual([futureSection]);
	});

	it('wrong version → ok: false', () => {
		const text = '{"kind":"kqlx","version":99,"state":{"sections":[]}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('version');
		}
	});

	it('missing state → ok: false', () => {
		const text = '{"kind":"kqlx","version":1}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('state');
		}
	});

	it('sections not an array → rejected', () => {
		const text = '{"kind":"kqlx","version":1,"state":{"sections":"oops"}}';
		const result = parseKqlxText(text);
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('state.sections');
		}
	});

	it('missing sections → rejected', () => {
		const result = parseKqlxText('{"kind":"kqlx","version":1,"state":{}}');
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('state.sections');
	});

	it.each(['caretDocsEnabled', 'autoTriggerAutocompleteEnabled'])('non-boolean state field %s → rejected', field => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [], [field]: 'SENTINEL' },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(field);
	});

	it('non-object sections and duplicate IDs → rejected', () => {
		const nonObject = parseKqlxText('{"kind":"kqlx","version":1,"state":{"sections":[null]}}');
		expect(nonObject.ok).toBe(false);
		const duplicate = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'same', type: 'query' },
				{ id: 'same', type: 'markdown' },
			] },
		}));
		expect(duplicate.ok).toBe(false);
		if (!duplicate.ok) expect(duplicate.error).toContain('duplicate section id');
	});

	it('multiple linked query sections → rejected', () => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'one.kql' },
				{ id: 'query_2', type: 'query', linkedQueryPath: 'two.kql' },
			] },
		}));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('only one linked query');
	});

	it('non-string IDs and linked query paths → rejected', () => {
		const invalidId = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', id: 42 }] },
		}));
		expect(invalidId.ok).toBe(false);
		const invalidPath = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ type: 'query', linkedQueryPath: { path: 'x.kql' } }] },
		}));
		expect(invalidPath.ok).toBe(false);
		const invalidSqlPath = parseKqlxText(JSON.stringify({
			kind: 'sqlx', version: 1, state: { sections: [{ type: 'sql', linkedQueryPath: ['x.sql'] }] },
		}), { allowedKinds: ['sqlx'] });
		expect(invalidSqlPath.ok).toBe(false);
		if (!invalidSqlPath.ok) expect(invalidSqlPath.error).toContain('linkedQueryPath');
	});

	it('counts Kusto and SQL linked owners together', () => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'one.kql' },
				{ id: 'sql_1', type: 'sql', linkedQueryPath: 'two.sql' },
			] },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('only one linked query');
	});

	it.each([
		['chart object', { id: 'chart_1', type: 'chart', xAxisSettings: 'SENTINEL' }],
		['transformation array', { id: 'transform_1', type: 'transformation', aggregations: 'SENTINEL' }],
		['development-note entries', { id: 'devnotes_1', type: 'devnotes', entries: { bad: true } }],
		['chart primitive array item', { id: 'chart_2', type: 'chart', yColumns: [null] }],
		['chart record member', { id: 'chart_3', type: 'chart', yAxisSettings: { seriesColors: { S: null } } }],
		['chart primitive leaf', { id: 'chart_4', type: 'chart', labelDensity: 'SENTINEL' }],
	] as const)('malformed nested known %s shape → rejected', (_label, section) => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [section] },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('invalid known field shape');
	});

	it('rejects a null persisted Markdown editor height', () => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'markdown_1', type: 'markdown', text: 'notes', editorHeightPx: null,
			}] },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('editorHeightPx');
	});

	it.each([
		['output', 42],
		['expanded', 'yes'],
		['editorHeightPx', null],
	] as const)('rejects invalid persisted Python %s', (field, value) => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'python_1', type: 'python', code: 'print(1)', [field]: value,
			}] },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(field);
	});

	it.each([
		['outputHeightPx', 0],
		['imageSizeMode', 'stretch'],
		['imageAlign', 'justify'],
		['imageOverflow', 'clip'],
	] as const)('rejects invalid persisted URL %s', (field, value) => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'url_1', type: 'url', url: 'https://example.test', [field]: value,
			}] },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(field);
	});

	it.each(['artifactId', 'sourceBoxId'] as const)('persisted result artifact missing required %s → rejected', field => {
		const resultArtifact: Record<string, unknown> = {
			version: 1, artifactId: 'artifact_1', sourceBoxId: 'query_1', revision: 1, createdAt: 1,
		};
		delete resultArtifact[field];
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query: 'print 1', resultArtifact,
			}] },
		}));

		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain(`resultArtifact.${field}`);
	});

	it.each([
		'__proto__', 'prototype', 'constructor', 'toString', 'hasOwnProperty', 'valueOf',
		'queries-container', 'bad\" onclick=\"alert(1)', 'bad id',
	])('unsafe section id %s → rejected', id => {
		const result = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{ id, type: 'chart' }] },
		}));
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('unsafe section id');
	});

	it('root is not an object (e.g. array) → ok: false', () => {
		const result = parseKqlxText('[1,2,3]');
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error).toContain('root must be a JSON object');
		}
	});

	it('sections are preserved in parsed output', () => {
		const sections = [
			{ type: 'query', name: 'Q1', query: 'StormEvents | take 10' },
			{ type: 'markdown', title: 'Notes', text: 'Hello' }
		];
		const text = JSON.stringify({ kind: 'kqlx', version: 1, state: { sections } });
		const result = parseKqlxText(text);
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.state.sections).toHaveLength(2);
			const q = result.file.state.sections[0] as any;
			expect(q.type).toBe('query');
			expect(q.name).toBe('Q1');
			expect(q.query).toBe('StormEvents | take 10');
			const md = result.file.state.sections[1] as any;
			expect(md.type).toBe('markdown');
			expect(md.title).toBe('Notes');
		}
	});
});

describe('stringifyKqlxFile', () => {
	it('output has 2-space indentation', () => {
		const file = createEmptyKqlxFile();
		const text = stringifyKqlxFile(file);
		expect(text).toContain('  "kind"');
	});

	it('output ends with newline', () => {
		const file = createEmptyKqlxFile();
		const text = stringifyKqlxFile(file);
		expect(text.endsWith('\n')).toBe(true);
	});

	it('round-trip: parse(stringify(createEmpty())) equals createEmpty()', () => {
		const original = createEmptyKqlxFile();
		const text = stringifyKqlxFile(original);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file).toEqual(original);
		}
	});

	it('round-trip with sections preserves all fields', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', name: 'Test', query: 'StormEvents | count', expanded: true },
					{ type: 'markdown', title: 'Notes', text: '# Hello' }
				]
			}
		};
		const text = stringifyKqlxFile(file);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file).toEqual(file);
		}
	});
});

describe('parseKqlxText edge cases', () => {
	it('whitespace-only text (spaces, tabs, newlines) → empty file with defaults', () => {
		const result = parseKqlxText('   \t\n  ');
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.file.kind).toBe('kqlx');
			expect(result.file.state.sections).toEqual([]);
		}
	});

	it('section-level extra fields are preserved through roundtrip', () => {
		const sections = [
			{ type: 'query', name: 'Q1', query: 'T | take 1', customField: 'preserved', metadata: { x: 42 } }
		];
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: { sections: sections as any }
		};
		const text = stringifyKqlxFile(file);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			const s = parsed.file.state.sections[0] as any;
			expect(s.customField).toBe('preserved');
			expect(s.metadata).toEqual({ x: 42 });
		}
	});

	it('preserves root-level extension fields', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [] },
			extraProp: 'preserved'
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect((parsed.file as any).extraProp).toBe('preserved');
		}
	});

	it('preserves state-level extension fields', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], customState: true }
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect((parsed.file.state as any).customState).toBe(true);
		}
	});

	it('overlays a known edit without losing future fields, opaque sections, or order', () => {
		const parsed = parseKqlxText(JSON.stringify({
			kind: 'kqlx',
			version: 1,
			futureRoot: { producer: 2 },
			state: {
				futureState: ['keep'],
				sections: [
					{
						id: 'query_1',
						type: 'query',
						name: 'remove this known field',
						query: 'print before = 1',
						futureQuerySetting: { mode: 'future' },
					},
					{
						id: 'future_1',
						type: 'future-section',
						payload: { nested: [1, 2, 3] },
					},
					{ id: 'markdown_1', type: 'markdown', text: 'after opaque' },
				],
			},
		}));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;

		const overlaid = overlayKqlxFileState(parsed.file, {
			sections: [
				{ id: 'query_1', type: 'query', query: 'print after = 2' },
				{ id: 'markdown_1', type: 'markdown', text: 'after opaque' },
			],
		});

		expect((overlaid as any).futureRoot).toEqual({ producer: 2 });
		expect((overlaid.state as any).futureState).toEqual(['keep']);
		expect(overlaid.state.sections.map(section => (section as any).id)).toEqual([
			'query_1', 'future_1', 'markdown_1',
		]);
		expect(overlaid.state.sections[0]).toMatchObject({
			id: 'query_1',
			type: 'query',
			query: 'print after = 2',
			futureQuerySetting: { mode: 'future' },
		});
		expect((overlaid.state.sections[0] as any).name).toBeUndefined();
		expect(overlaid.state.sections[1]).toEqual({
			id: 'future_1',
			type: 'future-section',
			payload: { nested: [1, 2, 3] },
		});
	});

	it('preserves nested extensions while omitted known nested fields stay deleted', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'chart_1', type: 'chart', chartTitle: 'Before', labelMode: 'top5', labelDensity: 80,
				xAxisSettings: { sortDirection: 'asc', labelDensity: 75, futureTickMode: 'adaptive' },
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const editedWithAxis = overlayKqlxFileState(base.file, { sections: [{
			id: 'chart_1', type: 'chart', chartTitle: 'After',
			xAxisSettings: { labelDensity: 60 },
		}] });
		const chartWithAxis = editedWithAxis.state.sections[0] as any;
		expect(chartWithAxis.xAxisSettings).toEqual({ labelDensity: 60, futureTickMode: 'adaptive' });
		expect(chartWithAxis.xAxisSettings.sortDirection).toBeUndefined();
		expect(chartWithAxis.labelMode).toBeUndefined();
		expect(chartWithAxis.labelDensity).toBeUndefined();

		const editedWithoutAxis = overlayKqlxFileState(base.file, { sections: [{
			id: 'chart_1', type: 'chart', chartTitle: 'After',
		}] });
		expect((editedWithoutAxis.state.sections[0] as any).xAxisSettings).toEqual({
			futureTickMode: 'adaptive',
		});
	});

	it('does not resurrect reset chart or URL fields', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'chart_1', type: 'chart', labelMode: 'all', labelDensity: 90, validation: { stale: true } },
				{ id: 'url_1', type: 'url', url: 'https://example.test', imageSizeMode: 'natural', imageAlign: 'right', imageOverflow: 'scroll' },
			] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [
			{ id: 'chart_1', type: 'chart' },
			{ id: 'url_1', type: 'url', url: 'https://example.test' },
		] });
		const chart = overlaid.state.sections[0] as any;
		const url = overlaid.state.sections[1] as any;
		expect(chart.labelMode).toBeUndefined();
		expect(chart.labelDensity).toBeUndefined();
		expect(chart.validation).toBeUndefined();
		expect(url.imageSizeMode).toBeUndefined();
		expect(url.imageAlign).toBeUndefined();
		expect(url.imageOverflow).toBeUndefined();
	});

	it('matches legacy and id-less known sections by structural occurrence', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'legacy_1', type: 'copilotQuery', query: 'q1', futureSlot: 'legacy-query' },
				{ id: 'markdown_1', type: 'markdown', text: 'm1', futureSlot: 'markdown' },
				{ type: 'query', query: 'idless-1', futureSlot: 'idless-first' },
				{ type: 'query', query: 'idless-2', futureSlot: 'idless-second' },
			] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [
			{ id: 'legacy_1', type: 'query', query: 'q1-edit' },
			{ id: 'markdown_1', type: 'markdown', text: 'm1-edit' },
			{ id: 'query_runtime_1', type: 'query', query: 'idless-1-edit' },
			{ id: 'query_runtime_2', type: 'query', query: 'idless-2-edit' },
		] });

		expect(overlaid.state.sections.map(section => (section as any).futureSlot)).toEqual([
			'legacy-query', 'markdown', 'idless-first', 'idless-second',
		]);
		expect((overlaid.state.sections[0] as any).type).toBe('query');
	});

	it('anchors opaque sections to surviving neighbors when a known section is removed', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_a', type: 'query', query: 'a' },
				{ id: 'future_1', type: 'future-section', payload: 1 },
				{ id: 'query_b', type: 'query', query: 'b' },
			] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [
			{ id: 'query_b', type: 'query', query: 'b-edit' },
		] });
		expect(overlaid.state.sections.map(section => (section as any).id)).toEqual(['future_1', 'query_b']);
	});

	it.each([
		['kqlx', 'query'],
		['mdx', 'markdown'],
	] as const)('preserves opaque relative order when %s known anchors cross', (kind, knownType) => {
		const knownContent = (id: string) => knownType === 'query'
			? { id, type: knownType, query: id }
			: { id, type: knownType, text: id };
		const base = parseKqlxText(JSON.stringify({
			kind, version: 1, state: { sections: [
				knownContent('known_a'),
				{ id: 'opaque_x', type: 'future-section', payload: 'X' },
				knownContent('known_b'),
				{ id: 'opaque_y', type: 'future-section', payload: 'Y' },
				knownContent('known_c'),
			] },
		}), { allowedKinds: [kind], defaultKind: kind });
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [
			knownContent('known_c'),
			knownContent('known_a'),
			knownContent('known_b'),
		] as any }, kind);
		const ids = overlaid.state.sections.map(section => String((section as any).id));

		expect(ids.filter(id => id.startsWith('known_'))).toEqual(['known_c', 'known_a', 'known_b']);
		expect(ids.filter(id => id.startsWith('opaque_'))).toEqual(['opaque_x', 'opaque_y']);
	});

	it('returns a detached JSON snapshot', () => {
		const futureRoot = { nested: { value: 1 } };
		const editedSection = { id: 'query_1', type: 'query', query: 'after' } as const;
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot, state: { sections: [
				{ id: 'query_1', type: 'query', query: 'before', futureSection: { value: 2 } },
			] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;
		const overlaid = overlayKqlxFileState(base.file, { sections: [editedSection] });

		(overlaid as any).futureRoot.nested.value = 9;
		(overlaid.state.sections[0] as any).futureSection.value = 8;
		expect((base.file as any).futureRoot.nested.value).toBe(1);
		expect((base.file.state.sections[0] as any).futureSection.value).toBe(2);
	});

	it('preserves nested extensions across reorder when known shapes are unique', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'transform_1', type: 'transformation', aggregations: [
					{ name: '', function: 'sum', column: 'A', futureAggregation: 'first' },
					{ name: '', function: 'max', column: 'B', futureAggregation: 'second' },
				],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'transform_1', type: 'transformation', aggregations: [
				{ name: '', function: 'max', column: 'B' },
				{ name: '', function: 'sum', column: 'A' },
			],
		}] });
		expect((overlaid.state.sections[0] as any).aggregations).toEqual([
			{ name: '', function: 'max', column: 'B', futureAggregation: 'second' },
			{ name: '', function: 'sum', column: 'A', futureAggregation: 'first' },
		]);
	});

	it('fails closed when edited nested items cannot be correlated without losing extensions', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'transform_1', type: 'transformation', aggregations: [
					{ name: '', function: 'sum', column: 'A', futureAggregation: 'first' },
					{ name: '', function: 'sum', column: 'A', futureAggregation: 'second' },
				],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		expect(() => overlayKqlxFileState(base.file, { sections: [{
			id: 'transform_1', type: 'transformation', aggregations: [
				{ name: '', function: 'max', column: 'B' },
				{ name: '', function: 'min', column: 'C' },
			],
		}] })).toThrow('Cannot safely preserve future fields for an ambiguously edited nested array.');
	});

	it.each([
		['aggregations', { name: '', function: 'sum', column: 'A' }],
		['deriveColumns', { name: '', expression: 'A + 1' }],
		['joinKeys', { left: '', right: '' }],
	] as const)('fails closed when deleting or inserting ambiguous %s items with future fields', (field, known) => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'transform_1', type: 'transformation', [field]: [
					{ ...known, futureItem: 'first' },
					{ ...known, futureItem: 'second' },
				],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;
		const edited = (items: unknown[]) => ({ sections: [{ id: 'transform_1', type: 'transformation', [field]: items }] });

		expect(() => overlayKqlxFileState(base.file, edited([{ ...known }]) as any))
			.toThrow('Cannot safely preserve future fields for an ambiguously edited nested array.');
		expect(() => overlayKqlxFileState(base.file, edited([{ ...known }, { ...known }, { ...known }]) as any))
			.toThrow('Cannot safely preserve future fields for an ambiguously edited nested array.');
	});

	it('preserves ambiguous nested extensions when the known sequence is unchanged', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'transform_1', type: 'transformation', name: 'Before', aggregations: [
					{ name: '', function: 'sum', column: 'A', futureAggregation: '' },
					{ name: '', function: 'max', column: 'B', futureAggregation: { mode: 'future' } },
				],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'transform_1', type: 'transformation', name: 'After', aggregations: [
				{ name: '', function: 'sum', column: 'A' },
				{ name: '', function: 'max', column: 'B' },
			],
		}] });
		expect((overlaid.state.sections[0] as any).aggregations).toEqual([
			{ name: '', function: 'sum', column: 'A', futureAggregation: '' },
			{ name: '', function: 'max', column: 'B', futureAggregation: { mode: 'future' } },
		]);
	});

	it('preserves hostile extension keys as own data properties', () => {
		const base = parseKqlxText('{"kind":"kqlx","version":1,"__proto__":{"root":true},"constructor":{"root":2},"state":{"sections":[{"id":"query_1","type":"query","query":"before","__proto__":{"section":true},"constructor":{"section":2}}]}}');
		expect(base.ok).toBe(true);
		if (!base.ok) return;
		const overlaid = overlayKqlxFileState(base.file, {
			sections: [{ id: 'query_1', type: 'query', query: 'after' }],
		});

		expect(Object.prototype.hasOwnProperty.call(overlaid, '__proto__')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(overlaid, 'constructor')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(overlaid.state.sections[0], '__proto__')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(overlaid.state.sections[0], 'constructor')).toBe(true);
		expect(JSON.parse(stringifyKqlxFile(overlaid)).__proto__).toEqual({ root: true });
	});

	it('preserves hostile known series-color keys through an unrelated chart edit', () => {
		const base = parseKqlxText('{"kind":"kqlx","version":1,"state":{"sections":[{"id":"chart_1","type":"chart","name":"Before","yAxisSettings":{"seriesColors":{"__proto__":"#123456","constructor":"#abcdef"}}}]}}');
		expect(base.ok).toBe(true);
		if (!base.ok) return;
		const colors = JSON.parse('{"__proto__":"#123456","constructor":"#abcdef"}');
		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'chart_1', type: 'chart', name: 'After', yAxisSettings: { seriesColors: colors },
		}] });
		const reparsed = JSON.parse(stringifyKqlxFile(overlaid));
		const savedColors = reparsed.state.sections[0].yAxisSettings.seriesColors;

		expect(reparsed.state.sections[0].name).toBe('After');
		expect(Object.prototype.hasOwnProperty.call(savedColors, '__proto__')).toBe(true);
		expect(Object.prototype.hasOwnProperty.call(savedColors, 'constructor')).toBe(true);
		expect(savedColors['__proto__']).toBe('#123456');
		expect(savedColors['constructor']).toBe('#abcdef');
	});

	it('overlays development-note edits without losing future metadata', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'devnotes_1', type: 'devnotes', futureSectionSetting: { keep: true }, entries: [{
					id: 'note_1', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
					category: 'decision', relatedSectionIds: ['query_1'], content: 'before', source: 'user',
					futureEntrySetting: { mode: 'future' },
				}],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'devnotes_1', type: 'devnotes', entries: [{
				id: 'note_1', created: '2026-07-31T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
				category: 'decision', relatedSectionIds: ['query_1'], content: 'after', source: 'user',
			}],
		}] });
		const devnotes = overlaid.state.sections[0] as any;

		expect(devnotes.futureSectionSetting).toEqual({ keep: true });
		expect(devnotes.entries[0].content).toBe('after');
		expect(devnotes.entries[0].futureEntrySetting).toEqual({ mode: 'future' });
	});

	it('retains the baseline development-notes slot when hidden state is emitted last', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_a', type: 'query', query: 'print a = 1' },
				{ id: 'devnotes_1', type: 'devnotes', futureSectionSetting: 'keep', entries: [{
					id: 'note_1', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
					category: 'decision', relatedSectionIds: ['query_a'], content: 'before', source: 'user',
				}] },
				{ id: 'query_b', type: 'query', query: 'print b = 1' },
			] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [
			{ id: 'query_a', type: 'query', query: 'print a = 2' },
			{ id: 'query_b', type: 'query', query: 'print b = 1' },
			{ id: 'devnotes_1', type: 'devnotes', entries: [{
				id: 'note_1', created: '2026-07-31T00:00:00.000Z', updated: '2026-08-01T00:00:00.000Z',
				category: 'decision', relatedSectionIds: ['query_a'], content: 'after', source: 'user',
			}] },
		] });

		expect(overlaid.state.sections.map(section => (section as any).id)).toEqual([
			'query_a', 'devnotes_1', 'query_b',
		]);
		expect((overlaid.state.sections[1] as any).futureSectionSetting).toBe('keep');
		expect((overlaid.state.sections[1] as any).entries[0].content).toBe('after');
	});

	it('allows deletion of a uniquely identified development note with future metadata', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'devnotes_1', type: 'devnotes', entries: [
					{
						id: 'note_remove', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
						category: 'decision', relatedSectionIds: [], content: 'remove', source: 'user',
						futureEntrySetting: { keepOnlyWhileEntryExists: true },
					},
					{
						id: 'note_keep', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
						category: 'finding', relatedSectionIds: [], content: 'keep', source: 'user',
					},
				],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'devnotes_1', type: 'devnotes', entries: [{
				id: 'note_keep', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
				category: 'finding', relatedSectionIds: [], content: 'keep', source: 'user',
			}],
		}] });

		expect((overlaid.state.sections[0] as any).entries.map((entry: any) => entry.id)).toEqual(['note_keep']);
	});

	it('does not transfer future metadata across replaced development-note IDs', () => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'devnotes_1', type: 'devnotes', entries: [{
					id: 'note_a', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
					category: 'decision', relatedSectionIds: [], content: 'same known shape', source: 'user',
					futureEntrySetting: { belongsTo: 'note_a' },
				}],
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'devnotes_1', type: 'devnotes', entries: [{
				id: 'note_b', created: '2026-07-31T00:00:00.000Z', updated: '2026-07-31T00:00:00.000Z',
				category: 'decision', relatedSectionIds: [], content: 'same known shape', source: 'user',
			}],
		}] });
		const replacement = (overlaid.state.sections[0] as any).entries[0];

		expect(replacement.id).toBe('note_b');
		expect(replacement.futureEntrySetting).toBeUndefined();
	});

	it('does not transfer future metadata across replaced result artifact IDs', () => {
		const artifact = (artifactId: string, extra: Record<string, unknown> = {}) => ({
			version: 1, artifactId, sourceBoxId: 'query_1', revision: 1, createdAt: 1,
			...extra,
		});
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query: 'print 1',
				resultArtifact: artifact('artifact_a', { futureArtifactSetting: { belongsTo: 'artifact_a' } }),
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'query_1', type: 'query', query: 'print 1', resultArtifact: artifact('artifact_b'),
		}] } as any);
		const replacement = (overlaid.state.sections[0] as any).resultArtifact;

		expect(replacement.artifactId).toBe('artifact_b');
		expect(replacement.futureArtifactSetting).toBeUndefined();
	});

	it.each([
		['deletes', []],
		['replaces', [{ sourceArtifactId: 'source_b' }]],
	] as const)('%s a role-less lineage identity without transferring future metadata', (_action, lineage) => {
		const base = parseKqlxText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [{
				id: 'query_1', type: 'query', query: 'print 1', resultArtifact: {
					version: 1, artifactId: 'artifact_1', sourceBoxId: 'query_1', revision: 1, createdAt: 1,
					lineage: [{ sourceArtifactId: 'source_a', futureLineageSetting: { belongsTo: 'source_a' } }],
				},
			}] },
		}));
		expect(base.ok).toBe(true);
		if (!base.ok) return;

		const overlaid = overlayKqlxFileState(base.file, { sections: [{
			id: 'query_1', type: 'query', query: 'print 1', resultArtifact: {
				version: 1, artifactId: 'artifact_1', sourceBoxId: 'query_1', revision: 1, createdAt: 1,
				lineage: [...lineage],
			},
		}] } as any);
		const savedLineage = (overlaid.state.sections[0] as any).resultArtifact.lineage;

		expect(savedLineage).toHaveLength(lineage.length);
		if (savedLineage.length > 0) {
			expect(savedLineage[0].sourceArtifactId).toBe('source_b');
			expect(savedLineage[0].futureLineageSetting).toBeUndefined();
		}
	});

	it('preserves both legacy preference fields through parse, section edit, and stringify', () => {
		const parsed = parseKqlxText(JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: {
				caretDocsEnabled: false,
				autoTriggerAutocompleteEnabled: false,
				sections: [{ type: 'query', query: 'print before = 1' }],
			},
		}));
		expect(parsed.ok).toBe(true);
		if (!parsed.ok) return;
		(parsed.file.state.sections[0] as any).query = 'print after = 2';

		const reparsed = parseKqlxText(stringifyKqlxFile(parsed.file));

		expect(reparsed.ok).toBe(true);
		if (reparsed.ok) {
			expect(reparsed.file.state.caretDocsEnabled).toBe(false);
			expect(reparsed.file.state.autoTriggerAutocompleteEnabled).toBe(false);
			expect((reparsed.file.state.sections[0] as any).query).toBe('print after = 2');
		}
	});

	it('rejects autoTriggerAutocompleteEnabled when it is not boolean', () => {
		const parsed = parseKqlxText(JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], autoTriggerAutocompleteEnabled: 'no' },
		}));
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain('autoTriggerAutocompleteEnabled');
	});

	it('caretDocsEnabled is preserved when true', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], caretDocsEnabled: true }
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file.state.caretDocsEnabled).toBe(true);
		}
	});

	it('caretDocsEnabled is rejected when not a boolean', () => {
		const text = JSON.stringify({
			kind: 'kqlx',
			version: 1,
			state: { sections: [], caretDocsEnabled: 'yes' }
		});
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(false);
		if (!parsed.ok) expect(parsed.error).toContain('caretDocsEnabled');
	});

	it('unicode characters in query text survive roundtrip', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', name: '\u65e5\u672c\u8a9e\u30c6\u30b9\u30c8', query: 'T | where Name == "\u00fc\u00e4\u00f6\u00df\u20ac"' },
					{ type: 'markdown', title: '\u2603 \ud83d\ude80 Emoji', text: 'Hello \u4e16\u754c' }
				]
			}
		};
		const text = stringifyKqlxFile(file);
		const parsed = parseKqlxText(text);
		expect(parsed.ok).toBe(true);
		if (parsed.ok) {
			expect(parsed.file).toEqual(file);
		}
	});

	it('stringifyKqlxFile output is valid JSON that can be parsed back', () => {
		const file: KqlxFileV1 = {
			kind: 'kqlx',
			version: 1,
			state: {
				sections: [
					{ type: 'query', name: 'Q', query: 'T | take 1', resultJson: '{"rows":[]}' }
				]
			}
		};
		const text = stringifyKqlxFile(file);
		const reparsed = JSON.parse(text);
		expect(reparsed.kind).toBe('kqlx');
		expect(reparsed.version).toBe(1);
		expect(reparsed.state.sections).toHaveLength(1);
	});
});
