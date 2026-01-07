import * as assert from 'assert';

import { KqlLanguageService } from '../kqlLanguageService/service';


suite('KQL diagnostics', () => {
	test('does not flag closing brace/semicolon after pipe inside let body', () => {
		const text = [
			'let Base = () {',
			'    SampleEvents',
			'    | where AppId == "com.example.app"',
			'};',
			'Base',
			'| where ActionName == "example.app/action.success"',
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
			'SampleEvents | project LatencyMs | take 10',
			'',
			'SampleEvents | take 100',
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
			'SampleEvents',
			'| where AppId == "com.example.app"',
			'| where ActionName == "example.app/action.success"',
			'| summarize',
			'GenTPS = sum(todouble(Metrics.itemCount)),',
			'RPS = count(),',
			'Users = dcount(UserId)',
			'by',
			'Second = bin(EventTime, 1sec), Variant',
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
			'SampleEvents | project Operation | take 10',
			'',
			'SampleEvents | project DeviceId | take 100',
			''
		].join('\n');

		const schema: any = {
			tables: ['SampleEvents'],
			columnTypesByTable: {
				SampleEvents: {
					Operation: 'string',
					DeviceId: 'string'
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
			'SampleEvents',
			'| summarize RPS = count() by Second = bin(EventTime, 1sec)',
			'| where Second > 0 and EventTime > 0',
			''
		].join('\n');

		const schema: any = {
			tables: ['SampleEvents'],
			columnTypesByTable: {
				SampleEvents: {
					EventTime: 'datetime'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			unknownCols.some((d) => String(d.message || '').includes('EventTime')),
			`Expected KW_UNKNOWN_COLUMN for EventTime after summarize, got: ${JSON.stringify(unknownCols, null, 2)}`
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
			'SampleEvents',
			'| where AppId == "com.example.app"',
			'| where ActionName == "example.app/action.success"',
			'| summarize',
			'    GenTPS = sum(todouble(Metrics.itemCount)),',
			'    RPS = count(),',
			'    Users = dcount(UserId)',
			'    by',
			'    Second = bin(EventTime, 1sec), Variant',
			'| where',
			"    Adsasd = 'title'",
			''
		].join('\n');

		const schema: any = {
			tables: ['SampleEvents'],
			columnTypesByTable: {
				SampleEvents: {
					AppId: 'string',
					ActionName: 'string',
					Metrics: 'dynamic',
					UserId: 'string',
					EventTime: 'datetime',
					Variant: 'string'
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

	test('flags unknown identifiers inside let function bodies (e.g. _rangeStart)', () => {
		const text = [
			'let Base = () {',
			'    SampleEvents',
			'    | where EventTime between (ago(totimespan(_rangeStart)) .. now())',
			'};',
			'Base',
			'| take 1',
			''
		].join('\n');

		const schema: any = {
			tables: ['SampleEvents'],
			columnTypesByTable: {
				SampleEvents: {
					EventTime: 'datetime'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			unknownCols.some((d) => String(d.message || '').includes('_rangeStart')),
			`Expected KW_UNKNOWN_COLUMN for _rangeStart, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});

	// Regression: apostrophes in `//` comments must NOT confuse string-literal parsing.
	// Bug: the apostrophe in "People's" starts a string in the lightweight lexer, causing
	// the later quoted literal to be mis-tokenized and its words to squiggle.
	test("does not flag words inside a quoted string literal when a preceding // comment contains an apostrophe (People's)", () => {
		const text = [
			"// People's example comment",
			'DailyActivity',
			"    | where ClientLabel == 'Fictional Product Name'",
			''
		].join('\n');

		const schema: any = {
			tables: ['DailyActivity'],
			columnTypesByTable: {
				DailyActivity: {
					ClientLabel: 'string'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('Visual')),
			`Expected no KW_UNKNOWN_COLUMN for Visual (string literal word), got: ${JSON.stringify(unknownCols, null, 2)}`
		);
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('Studio')),
			`Expected no KW_UNKNOWN_COLUMN for Studio (string literal word), got: ${JSON.stringify(unknownCols, null, 2)}`
		);
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('Code')),
			`Expected no KW_UNKNOWN_COLUMN for Code (string literal word), got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});

	// Regression: columns created in the RHS of a lookup should be in-scope after lookup.
	// Bug: `TotalAfterPivot` is incorrectly squiggled as an unknown column.
	test('does not flag RHS lookup columns referenced after lookup (TotalAfterPivot)', () => {
		const text = [
			'let pivotDay = datetime(20251114);',
			';',
			'let usageBeforePivot = DailyActivity',
			"    | where ClientLabel == 'Fictional Product Name'",
			'        and Day < pivotDay',
			'    | summarize',
			'        TotalBeforePivot = sum(CallCount)',
			'        by',
			'        DeviceId',
			';',
			'let usageAfterPivot = DailyActivity',
			"    | where ClientLabel == 'Fictional Product Name'",
			'        and Day >= pivotDay',
			'    | summarize',
			'        TotalAfterPivot = sum(CallCount)',
			'        by',
			'        DeviceId',
			';',
			'usageBeforePivot',
			'    | lookup (usageAfterPivot) on DeviceId',
			'    | summarize',
			'        AllUsers = dcount(DeviceId, 2)',
			'        ChurnedUsers = dcountif(DeviceId, isempty(TotalAfterPivot), 2)',
			''
		].join('\n');

		const schema: any = {
			tables: ['DailyActivity'],
			columnTypesByTable: {
				DailyActivity: {
					ClientLabel: 'string',
					Day: 'datetime',
					CallCount: 'long',
					DeviceId: 'string'
				}
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('TotalAfterPivot')),
			`Expected TotalAfterPivot to be valid after lookup, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});
});
