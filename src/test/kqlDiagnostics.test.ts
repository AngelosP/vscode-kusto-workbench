import * as assert from 'assert';

import { KqlLanguageService } from '../kqlLanguageService/service';


suite('KQL diagnostics', () => {
	test('does not flag closing brace/semicolon after pipe inside let body', () => {
		const text = [
			'let Base = () {',
			'    RawEventsVSCodeExt',
			'    | where ExtensionName == "GitHub.copilot-chat"',
			'};',
			'Base',
			'| where EventName == "github.copilot-chat/response.success"',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE diagnostics, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('flags missing pipe after a bare identifier statement start', () => {
		const text = [
			'Base',
			'asdasdsadsa',
			'| take 1',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.ok(
			expectedPipe.length >= 1,
			'Expected at least one KW_EXPECTED_PIPE diagnostic for missing pipe'
		);
	});

	test('treats blank lines as statement separators', () => {
		const text = [
			'RawEventsVSCodeExt | project Duration | take 10',
			'',
			'RawEventsVSCodeExt | take 100',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE diagnostics across blank-line-separated statements, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	// Regression: multiline summarize blocks should not require indentation on subsequent lines.
	// Today this incorrectly produces KW_EXPECTED_PIPE squiggles on GenTPS/RPS/Users/by/Second.
	test('does not flag KW_EXPECTED_PIPE for multiline summarize output + by (unindented)', () => {
		const text = [
			'RawEventsVSCodeExt',
			'| where ExtensionName == "GitHub.copilot-chat"',
			'| where EventName == "github.copilot-chat/response.success"',
			'| summarize',
			'GenTPS = sum(todouble(Measures.tokencount)),',
			'RPS = count(),',
			'Users = dcount(VSCodeMachineId)',
			'by',
			'Second = bin(ServerTimestamp, 1sec), Model',
			'| where ',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE diagnostics for multiline summarize, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('does not leak projected columns across blank-line-separated statements', () => {
		const text = [
			'RawEventsVSCodeExt | project Command | take 10',
			'',
			'RawEventsVSCodeExt | project DevDeviceId | take 100',
			''
		].join('\n');

		const schema: any = {
			tables: ['RawEventsVSCodeExt'],
			columnTypesByTable: {
				RawEventsVSCodeExt: {
					Command: 'string',
					DevDeviceId: 'string'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.strictEqual(
			unknownCols.length,
			0,
			`Expected no KW_UNKNOWN_COLUMN diagnostics across blank-line-separated statements, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});

	test('narrows columns after summarize (post-summarize input columns are invalid)', () => {
		const text = [
			'RawEventsVSCodeExt',
			'| summarize RPS = count() by Second = bin(ServerTimestamp, 1sec)',
			'| where Second > 0 and ServerTimestamp > 0',
			''
		].join('\n');

		const schema: any = {
			tables: ['RawEventsVSCodeExt'],
			columnTypesByTable: {
				RawEventsVSCodeExt: {
					ServerTimestamp: 'datetime'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			unknownCols.some((d) => String(d.message || '').includes('ServerTimestamp')),
			`Expected KW_UNKNOWN_COLUMN for ServerTimestamp after summarize, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('Second')),
			`Expected Second to be valid after summarize, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});

	// Regression: identifiers in multiline `| where` clauses should still be validated as columns.
	// Today `Adsasd = 'title'` is incorrectly treated like an assignment LHS and is not flagged.
	test('flags unknown columns in multiline where after summarize (Adsasd)', () => {
		const text = [
			'RawEventsVSCodeExt',
			'| where ExtensionName == "GitHub.copilot-chat"',
			'| where EventName == "github.copilot-chat/response.success"',
			'| summarize',
			'    GenTPS = sum(todouble(Measures.tokencount)),',
			'    RPS = count(),',
			'    Users = dcount(VSCodeMachineId)',
			'    by',
			'    Second = bin(ServerTimestamp, 1sec), Model',
			'| where',
			"    Adsasd = 'title'",
			''
		].join('\n');

		const schema: any = {
			tables: ['RawEventsVSCodeExt'],
			columnTypesByTable: {
				RawEventsVSCodeExt: {
					ExtensionName: 'string',
					EventName: 'string',
					Measures: 'dynamic',
					VSCodeMachineId: 'string',
					ServerTimestamp: 'datetime',
					Model: 'string'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			unknownCols.some((d) => String(d.message || '').includes('Adsasd')),
			`Expected KW_UNKNOWN_COLUMN for Adsasd, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});

	test('flags unknown identifiers inside let function bodies (e.g. _startTime)', () => {
		const text = [
			'let Base = () {',
			'    RawEventsVSCodeExt',
			'    | where ServerTimestamp between (ago(totimespan(_startTime)) .. now())',
			'};',
			'Base',
			'| take 1',
			''
		].join('\n');

		const schema: any = {
			tables: ['RawEventsVSCodeExt'],
			columnTypesByTable: {
				RawEventsVSCodeExt: {
					ServerTimestamp: 'datetime'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			unknownCols.some((d) => String(d.message || '').includes('_startTime')),
			`Expected KW_UNKNOWN_COLUMN for _startTime, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});
});
