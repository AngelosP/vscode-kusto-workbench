import { describe, expect, it } from 'vitest';
import { Uri } from 'vscode';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
	buildCompatSidecarFile,
	hydrateCompatSidecarState,
	isLinkedCompatSidecar,
	resolveCompatLinkedUri,
} from '../../../src/host/compatSidecarFormat';

describe('compatSidecarFormat', () => {
	it.each([
		'D:/queries/query.kql',
		'D:\\queries\\query.kql',
		'\\\\server\\share\\query.kql',
		'/tmp/query.kql',
	])('preserves absolute linked path %s', linkedPath => {
		const sidecarUri = Uri.file('C:/work/sample.kql.json');
		expect(resolveCompatLinkedUri(sidecarUri, linkedPath).toString())
			.toBe(Uri.file(linkedPath).toString());
	});

	it('recognizes a physical file alias as the linked compatibility source', () => {
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-compat-link-alias-'));
		const sourcePath = path.join(tmpDir, 'source.kql');
		const aliasPath = path.join(tmpDir, 'alias.kql');
		const hardLinkPath = path.join(tmpDir, 'hard-link.kql');
		try {
			fs.writeFileSync(sourcePath, 'print 1', 'utf8');
			fs.symlinkSync(sourcePath, aliasPath, 'file');
			fs.linkSync(sourcePath, hardLinkPath);
			const sidecarUri = Uri.file(path.join(tmpDir, 'source.kql.json'));
			(sidecarUri as any).path = sidecarUri.fsPath.replace(/\\/g, '/');
			const file = (linkedQueryPath: string) => ({
				kind: 'kqlx', version: 1, state: { sections: [
					{ type: 'query', linkedQueryPath },
				] },
			} as any);

			const resolved = resolveCompatLinkedUri(sidecarUri, 'alias.kql');
			expect(path.normalize(resolved.fsPath)).toBe(aliasPath);
			expect(fs.realpathSync.native(resolved.fsPath)).toBe(fs.realpathSync.native(sourcePath));
			expect(isLinkedCompatSidecar(sidecarUri, file('alias.kql'), Uri.file(sourcePath), ['query', 'copilotQuery'])).toBe(true);
			expect(isLinkedCompatSidecar(sidecarUri, file('hard-link.kql'), Uri.file(sourcePath), ['query', 'copilotQuery'])).toBe(true);
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});

	it.each([
		['KQL', 'query', ['query', 'copilotQuery'], 'kqlx'],
		['SQL', 'sql', ['sql'], 'sqlx'],
	] as const)('round-trips %s primary text outside sidecar metadata', (_label, primaryKind, acceptedPrimaryKinds, sidecarKind) => {
		const uri = Uri.file(`C:\work\sample.${primaryKind === 'sql' ? 'sql' : 'kql'}`);
		const file = buildCompatSidecarFile(uri, {
			caretDocsEnabled: true,
			autoTriggerAutocompleteEnabled: false,
			sections: [{ type: primaryKind, query: 'SECRET QUERY', name: 'Primary' } as any, { type: 'markdown', text: 'Notes' } as any],
		}, { primaryKind, acceptedPrimaryKinds, sidecarKind });

		expect(file.kind).toBe(sidecarKind);
		expect(file.state.sections[0]).toMatchObject({ type: primaryKind, linkedQueryPath: expect.any(String), name: 'Primary' });
		expect(file.state.sections[0]).not.toHaveProperty('query');

		const hydrated = hydrateCompatSidecarState(file, 'SELECTED TEXT', { primaryKind, acceptedPrimaryKinds });
		expect(hydrated.sections[0]).toMatchObject({ type: primaryKind, query: 'SELECTED TEXT', name: 'Primary' });
		expect(hydrated.sections[0]).not.toHaveProperty('linkedQueryPath');
		expect(hydrated.sections[1]).toMatchObject({ type: 'markdown', text: 'Notes' });
	});

	it('accepts only configured primary kinds when validating linkage', () => {
		const sidecarUri = Uri.file('/work/sample.kql.json');
		const compatUri = Uri.file('/work/sample.kql');
		const file = {
			kind: 'kqlx', version: 1,
			state: { sections: [{ type: 'copilotQuery', linkedQueryPath: 'sample.kql' }] },
		} as any;

		expect(isLinkedCompatSidecar(sidecarUri, file, compatUri, ['query', 'copilotQuery'])).toBe(true);
		expect(isLinkedCompatSidecar(sidecarUri, file, compatUri, ['sql'])).toBe(false);
	});

	it('uses platform-aware case sensitivity for linked file identity', () => {
		const sidecarUri = Uri.file('/work/sample.kql.json');
		const compatUri = Uri.file('/work/SAMPLE.kql');
		const file = {
			kind: 'kqlx', version: 1,
			state: { sections: [{ type: 'query', linkedQueryPath: 'sample.kql' }] },
		} as any;

		expect(isLinkedCompatSidecar(sidecarUri, file, compatUri, ['query'])).toBe(process.platform === 'win32');
	});

	it('overlays projected sidecar state onto future-compatible baseline data', () => {
		const compatUri = Uri.file('/work/sample.kql');
		const baseline = {
			kind: 'kqlx', version: 1, futureRoot: { producer: 2 }, state: {
				futureState: ['keep'], sections: [
					{
						id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql',
						name: 'Primary', futureQuerySetting: { mode: 'future' },
					},
					{ id: 'future_1', type: 'future-section', payload: { nested: true } },
				],
			},
		} as any;

		const file = buildCompatSidecarFile(
			compatUri,
			{ sections: [{ id: 'query_1', type: 'query', query: 'SECRET', name: 'Edited' }] },
			{ primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx' },
			baseline,
		);

		expect((file as any).futureRoot).toEqual({ producer: 2 });
		expect((file.state as any).futureState).toEqual(['keep']);
		expect(file.state.sections.map(section => (section as any).id)).toEqual(['query_1', 'future_1']);
		expect(file.state.sections[0]).toMatchObject({
			id: 'query_1', type: 'query', name: 'Edited', linkedQueryPath: 'sample.kql',
			futureQuerySetting: { mode: 'future' },
		});
		expect(file.state.sections[0]).not.toHaveProperty('query');
		expect(file.state.sections[1]).toEqual({
			id: 'future_1', type: 'future-section', payload: { nested: true },
		});
	});

	it.each([
		['query', ['query', 'copilotQuery'], 'kqlx', 'sample.kql'],
		['sql', ['sql'], 'sqlx', 'sample.sql'],
	] as const)('assigns one ID mapping after merging id-less %s sidecar sections', (
		primaryKind, acceptedPrimaryKinds, sidecarKind, primaryName,
	) => {
		const baseline = {
			kind: sidecarKind, version: 1, state: { sections: [
				{ type: primaryKind, linkedQueryPath: primaryName, futurePrimary: true },
				{ type: 'future-section', payload: { keep: true } },
				{ type: 'devnotes', entries: [{ id: 'note_1', content: 'keep' }] },
			] },
		} as any;
		const file = buildCompatSidecarFile(
			Uri.file(`/work/${primaryName}`),
			{ sections: [{ type: primaryKind, name: 'Edited' } as any] },
			{ primaryKind, acceptedPrimaryKinds, sidecarKind },
			baseline,
		);

		expect(file.state.sections).toHaveLength(3);
		expect(file.state.sections.map(section => section.type)).toEqual([primaryKind, 'future-section', 'devnotes']);
		expect(file.state.sections.map(section => (section as any).id).every(Boolean)).toBe(true);
		expect(file.state.sections[0]).toMatchObject({ futurePrimary: true });
		expect(file.state.sections[1]).toMatchObject({ payload: { keep: true } });
		expect(file.state.sections[2]).toMatchObject({ entries: [{ id: 'note_1', content: 'keep' }] });
	});

	it('keeps future fields attached when same-type id-less sections are hydrated then reordered', () => {
		const compatUri = Uri.file('/work/sample.kql');
		const format = { primaryKind: 'query', acceptedPrimaryKinds: ['query', 'copilotQuery'], sidecarKind: 'kqlx' } as const;
		const baseline = {
			kind: 'kqlx', version: 1, state: { sections: [
				{ type: 'query', linkedQueryPath: 'sample.kql', name: 'First', futureMarker: 'first' },
				{ type: 'query', name: 'Second', futureMarker: 'second' },
			] },
		} as any;
		const hydrated = hydrateCompatSidecarState(baseline, 'print primary = 1', format);
		const reordered = [hydrated.sections[1], hydrated.sections[0]].map(section => ({ ...section }));

		const file = buildCompatSidecarFile(compatUri, { ...hydrated, sections: reordered }, format, baseline);

		expect(file.state.sections.map(section => (section as any).name)).toEqual(['Second', 'First']);
		expect(file.state.sections.map(section => (section as any).futureMarker)).toEqual(['second', 'first']);
	});
});