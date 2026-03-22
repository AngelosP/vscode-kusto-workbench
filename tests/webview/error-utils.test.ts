import { describe, it, expect } from 'vitest';
import {
	__kustoTryExtractJsonFromErrorText,
	__kustoExtractLinePosition,
	__kustoNormalizeBadRequestInnerMessage,
	__kustoStripLinePositionTokens,
	__kustoTryExtractAutoFindTermFromMessage,
	__kustoBuildErrorUxModel,
	type ErrorUxModel,
} from '../../src/webview/shared/error-parser.js';

// ── __kustoTryExtractJsonFromErrorText ────────────────────────────────────────

describe('__kustoTryExtractJsonFromErrorText', () => {
	it('extracts JSON object from error text', () => {
		const raw = 'Error: {"error":{"code":"General_BadRequest","message":"bad"}}';
		const result = __kustoTryExtractJsonFromErrorText(raw);
		expect(result).toEqual({ error: { code: 'General_BadRequest', message: 'bad' } });
	});

	it('extracts JSON array from error text', () => {
		const raw = 'Prefix [1, 2, 3] suffix';
		const result = __kustoTryExtractJsonFromErrorText(raw);
		expect(result).toEqual([1, 2, 3]);
	});

	it('prefers object over array when object comes first', () => {
		const raw = '{"a":1} and [1]';
		const result = __kustoTryExtractJsonFromErrorText(raw);
		expect(result).toEqual({ a: 1 });
	});

	it('returns null for non-JSON text', () => {
		expect(__kustoTryExtractJsonFromErrorText('just plain text')).toBeNull();
	});

	it('returns null for empty/null input', () => {
		expect(__kustoTryExtractJsonFromErrorText('')).toBeNull();
		expect(__kustoTryExtractJsonFromErrorText(null)).toBeNull();
		expect(__kustoTryExtractJsonFromErrorText(undefined)).toBeNull();
	});

	it('returns null for malformed JSON', () => {
		expect(__kustoTryExtractJsonFromErrorText('prefix {not json} suffix')).toBeNull();
	});

	it('handles deeply nested JSON', () => {
		const raw = 'Error: {"error":{"innererror":{"@message":"deep"}}}';
		const result = __kustoTryExtractJsonFromErrorText(raw);
		expect(result).toEqual({ error: { innererror: { '@message': 'deep' } } });
	});
});

// ── __kustoExtractLinePosition ────────────────────────────────────────────────

describe('__kustoExtractLinePosition', () => {
	it('extracts line:position from standard format', () => {
		expect(__kustoExtractLinePosition('error [line:position=5:12]'))
			.toEqual({ line: 5, col: 12, token: '[line:position=5:12]' });
	});

	it('handles case-insensitive match', () => {
		expect(__kustoExtractLinePosition('error [Line:Position=3:7]'))
			.toEqual({ line: 3, col: 7, token: '[line:position=3:7]' });
	});

	it('handles spaces around equals/colon', () => {
		expect(__kustoExtractLinePosition('error [line:position = 10 : 20 ]'))
			.toEqual({ line: 10, col: 20, token: '[line:position=10:20]' });
	});

	it('returns null for missing token', () => {
		expect(__kustoExtractLinePosition('error without position')).toBeNull();
	});

	it('returns null for zero line', () => {
		expect(__kustoExtractLinePosition('[line:position=0:5]')).toBeNull();
	});

	it('returns null for zero col', () => {
		expect(__kustoExtractLinePosition('[line:position=5:0]')).toBeNull();
	});

	it('returns null for empty input', () => {
		expect(__kustoExtractLinePosition('')).toBeNull();
		expect(__kustoExtractLinePosition(null)).toBeNull();
	});
});

// ── __kustoNormalizeBadRequestInnerMessage ────────────────────────────────────

describe('__kustoNormalizeBadRequestInnerMessage', () => {
	it('strips "Request is invalid" prefix', () => {
		expect(__kustoNormalizeBadRequestInnerMessage('Request is invalid and target entity: foo'))
			.toBe('foo');
	});

	it('strips "Semantic error:" prefix', () => {
		expect(__kustoNormalizeBadRequestInnerMessage('Semantic error: column not found'))
			.toBe('column not found');
	});

	it('strips "Syntax error:" prefix', () => {
		expect(__kustoNormalizeBadRequestInnerMessage('Syntax error: unexpected token'))
			.toBe('unexpected token');
	});

	it('trims whitespace', () => {
		expect(__kustoNormalizeBadRequestInnerMessage('  some message  ')).toBe('some message');
	});

	it('handles null/undefined', () => {
		expect(__kustoNormalizeBadRequestInnerMessage(null)).toBe('');
		expect(__kustoNormalizeBadRequestInnerMessage(undefined)).toBe('');
	});
});

// ── __kustoStripLinePositionTokens ────────────────────────────────────────────

describe('__kustoStripLinePositionTokens', () => {
	it('removes single position token', () => {
		expect(__kustoStripLinePositionTokens('error [line:position=5:12] here'))
			.toBe('error here');
	});

	it('removes multiple position tokens', () => {
		const input = 'a [line:position=1:2] b [line:position=3:4] c';
		expect(__kustoStripLinePositionTokens(input)).toBe('a b c');
	});

	it('handles case insensitivity', () => {
		expect(__kustoStripLinePositionTokens('err [LINE:POSITION=1:2] ok'))
			.toBe('err ok');
	});

	it('returns trimmed text for no tokens', () => {
		expect(__kustoStripLinePositionTokens('no tokens here')).toBe('no tokens here');
	});

	it('handles null/undefined', () => {
		expect(__kustoStripLinePositionTokens(null)).toBe('');
		expect(__kustoStripLinePositionTokens(undefined)).toBe('');
	});
});

// ── __kustoTryExtractAutoFindTermFromMessage ──────────────────────────────────

describe('__kustoTryExtractAutoFindTermFromMessage', () => {
	it('extracts term from SEM0139', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage(
			'SEM0139: Failed to resolve expression \'myColumn\''
		)).toBe('myColumn');
	});

	it('extracts term from SEM0260', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage(
			'SEM0260: Unknown function: \'myFunc\''
		)).toBe('myFunc');
	});

	it('detects notempty pitfall with SEM0219', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage(
			'SEM0219: function expects 1 argument. notempty was called incorrectly'
		)).toBe('notempty');
	});

	it('detects notempty with arity 1 message', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage(
			'The function expects 1 argument but notempty was given 0'
		)).toBe('notempty');
	});

	it('extracts named term', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage(
			"SEM1234: Something named 'UnknownThing' is not valid"
		)).toBe('UnknownThing');
	});

	it('returns null for empty message', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage('')).toBeNull();
		expect(__kustoTryExtractAutoFindTermFromMessage(null)).toBeNull();
	});

	it('returns null for message with no extractable term', () => {
		expect(__kustoTryExtractAutoFindTermFromMessage('Generic error occurred')).toBeNull();
	});
});

// ── __kustoBuildErrorUxModel ──────────────────────────────────────────────────

describe('__kustoBuildErrorUxModel', () => {
	it('returns kind "none" for empty/null input', () => {
		expect(__kustoBuildErrorUxModel('').kind).toBe('none');
		expect(__kustoBuildErrorUxModel(null).kind).toBe('none');
		expect(__kustoBuildErrorUxModel(undefined).kind).toBe('none');
		expect(__kustoBuildErrorUxModel('   ').kind).toBe('none');
	});

	it('parses General_BadRequest error', () => {
		const raw = JSON.stringify({
			error: {
				code: 'General_BadRequest',
				message: 'Semantic error: column not found [line:position=3:5]',
			},
		});
		const model = __kustoBuildErrorUxModel(raw);
		expect(model.kind).toBe('badrequest');
		expect(model.message).toBeTruthy();
		expect(model.location).toEqual({ line: 3, col: 5, token: '[line:position=3:5]' });
	});

	it('extracts autoFindTerm from bad request error', () => {
		const raw = JSON.stringify({
			error: {
				code: 'General_BadRequest',
				message: "SEM0139: Failed to resolve expression 'unknownCol'",
			},
		});
		const model = __kustoBuildErrorUxModel(raw);
		expect(model.kind).toBe('badrequest');
		expect(model.autoFindTerm).toBe('unknownCol');
	});

	it('uses innererror for location extraction', () => {
		const raw = JSON.stringify({
			error: {
				code: 'General_BadRequest',
				message: 'Bad request',
				innererror: {
					'@message': 'detailed error',
					'@line': '7',
					'@pos': '15',
				},
			},
		});
		const model = __kustoBuildErrorUxModel(raw);
		expect(model.kind).toBe('badrequest');
		expect(model.location).toEqual({ line: 7, col: 15, token: '[line:position=7:15]' });
	});

	it('returns kind "json" for non-BadRequest JSON errors', () => {
		const raw = JSON.stringify({
			error: {
				code: 'SomeOtherError',
				message: 'Something went wrong',
			},
		});
		const model = __kustoBuildErrorUxModel(raw);
		expect(model.kind).toBe('json');
		expect(model.pretty).toBeTruthy();
	});

	it('returns kind "text" for plain error text', () => {
		const model = __kustoBuildErrorUxModel('Connection refused');
		expect(model.kind).toBe('text');
		expect(model.text).toBe('Connection refused');
	});

	it('extracts autoFindTerm from plain text error', () => {
		const model = __kustoBuildErrorUxModel("SEM0139: Failed to resolve expression 'badName'");
		expect(model.kind).toBe('text');
		expect(model.autoFindTerm).toBe('badName');
	});
});
