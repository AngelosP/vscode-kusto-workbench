import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { __kustoNormalizeCollapsedMonacoMarkers } from '../../src/webview/monaco/marker-ranges.js';

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

function makeMonacoModel(text: string) {
	const lines = text.split('\n');
	return {
		getLineCount: () => lines.length,
		getLineContent: (lineNumber: number) => lines[lineNumber - 1] ?? '',
	};
}

function offsetToMonacoPosition(text: string, offset: number): { lineNumber: number; column: number } {
	const before = text.slice(0, Math.max(0, offset));
	const lines = before.split('\n');
	return {
		lineNumber: lines.length,
		column: lines[lines.length - 1].length + 1,
	};
}

describe('Kusto syntax diagnostic ranges', () => {
	it('normalizes collapsed Missing expression diagnostics into visible Monaco marker ranges', () => {
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
		expect(diagnostic.Length).toBe(0);
		expect(diagnostic.Start).toBe(diagnostic.End);

		const start = offsetToMonacoPosition(query, diagnostic.Start);
		const end = offsetToMonacoPosition(query, diagnostic.End);
		const marker = {
			severity: 8,
			message: diagnostic.Message,
			code: diagnostic.Code,
			startLineNumber: start.lineNumber,
			startColumn: start.column,
			endLineNumber: end.lineNumber,
			endColumn: end.column,
			source: 'Kusto',
		};

		const markers = [marker];
		const normalized = __kustoNormalizeCollapsedMonacoMarkers(makeMonacoModel(query), markers);

		expect(normalized).not.toBe(markers);
		expect(normalized[0].startLineNumber).toBe(normalized[0].endLineNumber);
		expect(normalized[0].startColumn).toBeLessThan(normalized[0].endColumn);
		expect(normalized[0]).toMatchObject({
			message: 'Missing expression',
			code: 'KS006',
			source: 'Kusto',
		});
		const line = query.split('\n')[normalized[0].startLineNumber as number - 1];
		expect(line[normalized[0].startColumn as number - 1]).toBe('+');
	});
});