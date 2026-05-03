import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);

interface KustoDiagnosticSummary {
	Code: string | null;
	Message: string | null;
	Severity: string | null;
	HasLocation: boolean;
	Start: number;
	Length: number;
	End: number;
}

function getKustoDiagnostics(text: string): KustoDiagnosticSummary[] {
	require('@kusto/language-service-next/bridge');
	require('@kusto/language-service-next');

	const codeScript = (globalThis as any).Kusto?.Language?.Editor?.CodeScript;
	if (!codeScript) {
		throw new Error('Kusto language service did not initialize CodeScript');
	}

	const script = codeScript.From$1(text);
	const block = script?.Blocks?.getItem(0);
	const diagnostics = block?.Service?.GetDiagnostics();
	if (!diagnostics) {
		return [];
	}

	const summaries: KustoDiagnosticSummary[] = [];
	for (let index = 0; index < diagnostics.Count; index += 1) {
		const diagnostic = diagnostics.getItem(index);
		summaries.push({
			Code: diagnostic.Code,
			Message: diagnostic.Message,
			Severity: diagnostic.Severity,
			HasLocation: diagnostic.HasLocation,
			Start: diagnostic.Start,
			Length: diagnostic.Length,
			End: diagnostic.End,
		});
	}
	return summaries;
}

describe('Kusto syntax diagnostic ranges', () => {
	it('gives Missing expression diagnostics a non-empty span so squiggles and hover have a visible target', () => {
		const query = [
			'print It = 1, ExpectedValue = 1, ActualValue = 1, Passed = true',
			'| project It, ExpectedValue, ActualValue, Passed+',
		].join('\n');

		const diagnostic = getKustoDiagnostics(query).find((candidate) => (
			candidate.Code === 'KS006' && candidate.Message === 'Missing expression'
		));

		if (!diagnostic) {
			throw new Error('Expected KS006 Missing expression diagnostic for trailing plus');
		}

		expect(diagnostic.HasLocation).toBe(true);
		expect(diagnostic.Start).toBeLessThan(diagnostic.End);
		expect(diagnostic.Length).toBeGreaterThan(0);
	});
});