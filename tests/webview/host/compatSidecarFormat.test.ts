import { describe, expect, it } from 'vitest';
import { Uri } from 'vscode';

import {
	buildCompatSidecarFile,
	hydrateCompatSidecarState,
	isLinkedCompatSidecar,
} from '../../../src/host/compatSidecarFormat';

describe('compatSidecarFormat', () => {
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
});