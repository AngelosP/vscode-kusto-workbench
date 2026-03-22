import { describe, it, expect } from 'vitest';
import { KqlLanguageService, _splitTopLevelStatements } from '../../../src/host/kqlLanguageService/service';

describe('KQL diagnostics', () => {
	it('does not flag closing brace/semicolon after pipe inside let body', () => {
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
		expect(expectedPipe).toHaveLength(0);
	});

	it('flags missing pipe after a bare identifier statement start', () => {
		const text = [
			'Base',
			'asdasdsadsa',
			'| take 1',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe.length).toBeGreaterThanOrEqual(1);
	});

	it('treats blank lines as statement separators', () => {
		const text = [
			'SampleEvents | project LatencyMs | take 10',
			'',
			'SampleEvents | take 100',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe).toHaveLength(0);
	});

	it('does not split on blank lines inside triple-backtick string literals', () => {
		const text1 = [
			'print ```hello',
			'',
			'world```',
		].join('\n');

		const stmts1 = _splitTopLevelStatements(text1);
		expect(stmts1).toHaveLength(1);

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
		expect(stmts2).toHaveLength(1);
	});

	it('does not flag KW_EXPECTED_PIPE for multiline summarize output + by (unindented)', () => {
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
		expect(expectedPipe).toHaveLength(0);
	});

	it('does not leak projected columns across blank-line-separated statements', () => {
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
		expect(unknownCols).toHaveLength(0);
	});

	it('narrows columns after summarize (post-summarize input columns are invalid)', () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('EventTime'))).toBe(true);
		expect(unknownCols.some((d) => String(d.message || '').includes('Second'))).toBe(false);
	});

	it('flags unknown columns in multiline where after summarize (Adsasd)', () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('Adsasd'))).toBe(true);
	});

	it('flags unknown identifiers inside let function bodies (e.g. _rangeStart)', () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('_rangeStart'))).toBe(true);
	});

	it("does not flag words inside a quoted string literal when a preceding // comment contains an apostrophe (People's)", () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('Visual'))).toBe(false);
		expect(unknownCols.some((d) => String(d.message || '').includes('Studio'))).toBe(false);
		expect(unknownCols.some((d) => String(d.message || '').includes('Code'))).toBe(false);
	});

	it('does not flag RHS lookup columns referenced after lookup (TotalAfterPivot)', () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('TotalAfterPivot'))).toBe(false);
	});
});

describe('_splitTopLevelStatements edge cases', () => {
	it('empty string returns no statements', () => {
		const stmts = _splitTopLevelStatements('');
		expect(stmts).toHaveLength(0);
	});

	it('whitespace-only string returns no statements', () => {
		const stmts = _splitTopLevelStatements('   \t\n  \n  ');
		expect(stmts).toHaveLength(0);
	});

	it('single line comment returns one statement', () => {
		const stmts = _splitTopLevelStatements('// this is a comment');
		expect(stmts).toHaveLength(1);
		expect(stmts[0].text).toContain('// this is a comment');
	});

	it('block comment returns one statement', () => {
		const stmts = _splitTopLevelStatements('/* multi\nline\ncomment */');
		expect(stmts).toHaveLength(1);
	});

	it('semicolons inside single-quoted strings do not split', () => {
		const text = "print 'hello;world'";
		const stmts = _splitTopLevelStatements(text);
		expect(stmts).toHaveLength(1);
	});

	it('semicolons inside double-quoted strings do not split', () => {
		const text = 'print "hello;world"';
		const stmts = _splitTopLevelStatements(text);
		expect(stmts).toHaveLength(1);
	});

	it('multiple statements separated by semicolons', () => {
		const text = 'let x = 1;\nT | take x';
		const stmts = _splitTopLevelStatements(text);
		expect(stmts.length).toBeGreaterThanOrEqual(2);
	});

	it('statements separated by blank lines', () => {
		const text = 'T | take 10\n\nU | take 5';
		const stmts = _splitTopLevelStatements(text);
		expect(stmts.length).toBeGreaterThanOrEqual(2);
	});
});

describe('KQL diagnostics – additional coverage', () => {
	it('dot commands do not produce KW_EXPECTED_PIPE', () => {
		const text = '.show tables';
		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe).toHaveLength(0);
	});

	it('project-away does not produce KW_EXPECTED_PIPE', () => {
		const text = [
			'SampleEvents',
			'| project-away Metrics',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe).toHaveLength(0);
	});

	it('project-rename does not produce KW_EXPECTED_PIPE', () => {
		const text = [
			'SampleEvents',
			'| project-rename NewName = OldName',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe).toHaveLength(0);
	});

	it('invoke operator does not produce KW_EXPECTED_PIPE', () => {
		const text = [
			'SampleEvents',
			'| invoke MyFunc()',
			'| take 10',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe).toHaveLength(0);
	});

	it('multiple let statements with semicolons produce no KW_EXPECTED_PIPE', () => {
		const text = [
			'let a = SampleEvents | take 1;',
			'let b = SampleEvents | take 2;',
			'a | union b',
			''
		].join('\n');

		const svc = new KqlLanguageService();
		const diags = svc.getDiagnostics(text, null);
		const expectedPipe = diags.filter((d) => d.code === 'KW_EXPECTED_PIPE');
		expect(expectedPipe).toHaveLength(0);
	});

	it('known column is not flagged as KW_UNKNOWN_COLUMN', () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('EventTime'))).toBe(false);
	});

	it('column created by extend is valid in subsequent operators', () => {
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
		expect(unknownCols.some((d) => String(d.message || '').includes('DayOfWeek'))).toBe(false);
	});
});
