import * as assert from 'assert';

import { KqlLanguageService, _splitTopLevelStatements } from '../../src/host/kqlLanguageService/service';


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

	// Regression: blank lines inside triple-backtick multi-line string literals (```) should NOT
	// be treated as statement separators. The content between ``` and ``` is a string literal where
	// any characters — including blank lines — are allowed.
	test('does not split on blank lines inside triple-backtick string literals', () => {
		// Case 1: triple-backtick at depth 0 (not inside brackets)
		const text1 = [
			'print ```hello',
			'',
			'world```',
		].join('\n');

		const stmts1 = _splitTopLevelStatements(text1);
		assert.strictEqual(
			stmts1.length,
			1,
			`Expected 1 statement for depth-0 triple-backtick string with blank lines, got ${stmts1.length}: ${JSON.stringify(stmts1.map(s => s.text), null, 2)}`
		);

		// Case 2: the full .create table pattern (depth > 0 due to parentheses; should also work)
		const text2 = [
			'.create table test_Funnels (',
			'Date: datetime,',
			'Count: long',
			')',
			'with (',
			'docstring = ```Funnel metrics table.',
			'',
			'Columns:',
			'Date - Start of the cohort window.```,',
			'folder = "test"',
			')',
		].join('\n');

		const stmts2 = _splitTopLevelStatements(text2);
		assert.strictEqual(
			stmts2.length,
			1,
			`Expected 1 statement for .create table with triple-backtick docstring, got ${stmts2.length}: ${JSON.stringify(stmts2.map(s => s.text), null, 2)}`
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

suite('_splitTopLevelStatements edge cases', () => {
	test('empty string returns no statements', () => {
		const stmts = _splitTopLevelStatements('');
		assert.strictEqual(stmts.length, 0, 'empty input should produce no statements');
	});

	test('whitespace-only string returns no statements', () => {
		const stmts = _splitTopLevelStatements('   \t\n  \n  ');
		assert.strictEqual(stmts.length, 0, 'whitespace-only input should produce no statements');
	});

	test('single line comment returns one statement', () => {
		const stmts = _splitTopLevelStatements('// this is a comment');
		assert.strictEqual(stmts.length, 1, 'comment-only input should produce one statement');
		assert.ok(stmts[0].text.includes('// this is a comment'));
	});

	test('block comment returns one statement', () => {
		const stmts = _splitTopLevelStatements('/* multi\nline\ncomment */');
		assert.strictEqual(stmts.length, 1);
	});

	test('semicolons inside single-quoted strings do not split', () => {
		const text = "print 'hello;world'";
		const stmts = _splitTopLevelStatements(text);
		assert.strictEqual(stmts.length, 1,
			`semicolon inside string should not split, got ${stmts.length} statements`);
	});

	test('semicolons inside double-quoted strings do not split', () => {
		const text = 'print "hello;world"';
		const stmts = _splitTopLevelStatements(text);
		assert.strictEqual(stmts.length, 1,
			`semicolon inside double-quoted string should not split, got ${stmts.length} statements`);
	});

	test('multiple statements separated by semicolons', () => {
		const text = 'let x = 1;\nT | take x';
		const stmts = _splitTopLevelStatements(text);
		assert.ok(stmts.length >= 2,
			`expected at least 2 statements, got ${stmts.length}`);
	});

	test('statements separated by blank lines', () => {
		const text = 'T | take 10\n\nU | take 5';
		const stmts = _splitTopLevelStatements(text);
		assert.ok(stmts.length >= 2,
			`expected at least 2 statements from blank-line separation, got ${stmts.length}`);
	});
});

suite('KQL diagnostics – additional coverage', () => {
	test('dot commands do not produce KW_EXPECTED_PIPE', () => {
		const text = '.show tables';
		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE for dot command, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('project-away does not produce KW_EXPECTED_PIPE', () => {
		const text = [
			'SampleEvents',
			'| project-away Metrics',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE for project-away, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('project-rename does not produce KW_EXPECTED_PIPE', () => {
		const text = [
			'SampleEvents',
			'| project-rename NewName = OldName',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE for project-rename, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('invoke operator does not produce KW_EXPECTED_PIPE', () => {
		const text = [
			'SampleEvents',
			'| invoke MyFunc()',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE for invoke, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('multiple let statements with semicolons produce no KW_EXPECTED_PIPE', () => {
		const text = [
			'let a = SampleEvents | take 1;',
			'let b = SampleEvents | take 2;',
			'a | union b',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		assert.strictEqual(
			expectedPipe.length,
			0,
			`Expected no KW_EXPECTED_PIPE for multiple let statements, got: ${JSON.stringify(expectedPipe, null, 2)}`
		);
	});

	test('known column is not flagged as KW_UNKNOWN_COLUMN', () => {
		const text = 'SampleEvents | where EventTime > ago(1h)';
		const schema: any = {
			tables: ['SampleEvents'],
			columnTypesByTable: {
				SampleEvents: { EventTime: 'datetime' }
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('EventTime')),
			`EventTime should not be flagged as unknown`
		);
	});

	test('column created by extend is valid in subsequent operators', () => {
		const text = [
			'SampleEvents',
			'| extend DayOfWeek = dayofweek(EventTime)',
			'| where DayOfWeek > 1d',
			''
		].join('\n');

		const schema: any = {
			tables: ['SampleEvents'],
			columnTypesByTable: {
				SampleEvents: { EventTime: 'datetime' }
			}
		};

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, schema);
		const unknownCols = diags.filter((d) => d.code === 'KW_UNKNOWN_COLUMN');
		assert.ok(
			!unknownCols.some((d) => String(d.message || '').includes('DayOfWeek')),
			`DayOfWeek created by extend should be valid, got: ${JSON.stringify(unknownCols, null, 2)}`
		);
	});
});
