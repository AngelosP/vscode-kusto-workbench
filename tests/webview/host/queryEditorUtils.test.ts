import { describe, it, expect } from 'vitest';
import {
	getErrorMessage,
	formatQueryExecutionErrorForUser,
	isControlCommand,
	appendQueryMode,
	buildCacheDirective
} from '../../../src/host/queryEditorUtils';

// ---------------------------------------------------------------------------
// getErrorMessage
// ---------------------------------------------------------------------------

describe('getErrorMessage', () => {
	it('extracts message from Error objects', () => {
		expect(getErrorMessage(new Error('boom'))).toBe('boom');
	});

	it('converts non-Error values to string', () => {
		expect(getErrorMessage('string error')).toBe('string error');
		expect(getErrorMessage(42)).toBe('42');
		expect(getErrorMessage(null)).toBe('null');
	});
});

// ---------------------------------------------------------------------------
// formatQueryExecutionErrorForUser
// ---------------------------------------------------------------------------

describe('formatQueryExecutionErrorForUser', () => {
	it('formats cloud info errors', () => {
		const result = formatQueryExecutionErrorForUser('Failed to get cloud info for cluster', 'https://cluster.kusto.windows.net');
		expect(result).toContain("Can't connect to cluster");
		expect(result).toContain('VPN');
	});

	it('formats network timeout errors (ETIMEDOUT)', () => {
		const result = formatQueryExecutionErrorForUser('ETIMEDOUT', 'https://cluster.kusto.windows.net');
		expect(result).toContain('Connection timed out');
		expect(result).toContain('VPN');
	});

	it('formats client HTTP timeout (Axios)', () => {
		const result = formatQueryExecutionErrorForUser('timeout of 270000ms exceeded', 'https://cluster.kusto.windows.net');
		expect(result).toContain('client-side timeout');
		expect(result).toContain('Query Timeout');
		expect(result).not.toContain('VPN');
	});

	it('extracts minutes from client HTTP timeout message', () => {
		const result = formatQueryExecutionErrorForUser('timeout of 1200000ms exceeded', 'https://cluster.kusto.windows.net');
		expect(result).toContain('20 min');
	});

	it('formats server-side query timeout', () => {
		const result = formatQueryExecutionErrorForUser('Request is not allowed as it has exceeded the allowed timeout', 'https://cluster.kusto.windows.net');
		expect(result).toContain("server's time limit");
		expect(result).toContain('servertimeout');
	});

	it('formats server-side request timed out', () => {
		const result = formatQueryExecutionErrorForUser('Query execution request timed out', 'https://cluster.kusto.windows.net');
		expect(result).toContain("server's time limit");
	});

	it('formats DNS errors', () => {
		const result = formatQueryExecutionErrorForUser('getaddrinfo ENOTFOUND cluster', 'https://cluster.kusto.windows.net');
		expect(result).toContain('resolve the cluster host');
	});

	it('formats connection refused errors', () => {
		const result = formatQueryExecutionErrorForUser('ECONNREFUSED', 'https://cluster.kusto.windows.net');
		expect(result).toContain('refused');
	});

	it('formats authentication errors', () => {
		const result = formatQueryExecutionErrorForUser('AADSTS700054', 'https://cluster.kusto.windows.net');
		expect(result).toContain('Authentication failed');
	});

	it('includes database suffix when provided', () => {
		const result = formatQueryExecutionErrorForUser('ETIMEDOUT', 'https://cluster.kusto.windows.net', 'mydb');
		expect(result).toContain('(db: mydb)');
	});

	it('returns generic message for unknown errors', () => {
		const result = formatQueryExecutionErrorForUser('Something went wrong', 'https://cluster.kusto.windows.net');
		expect(result).toContain('Query failed');
		expect(result).toContain('Something went wrong');
	});

	it('strips "Query execution failed:" prefix', () => {
		const result = formatQueryExecutionErrorForUser('Query execution failed: timeout', 'https://c.kusto.windows.net');
		expect(result).toContain('Connection timed out');
	});

	it('shows short first line for semantic errors', () => {
		const result = formatQueryExecutionErrorForUser('Semantic error: column X not found', 'https://c.kusto.windows.net');
		expect(result).toContain('Semantic error');
	});

	it('does not expose raw JSON blobs as first line', () => {
		const result = formatQueryExecutionErrorForUser('{"error":"bad"}', 'https://c.kusto.windows.net');
		expect(result).toContain('Query failed');
	});
});

// ---------------------------------------------------------------------------
// isControlCommand
// ---------------------------------------------------------------------------

describe('isControlCommand', () => {
	it('detects .show as control command', () => {
		expect(isControlCommand('.show databases')).toBe(true);
	});

	it('detects control command with leading whitespace', () => {
		expect(isControlCommand('  .show tables')).toBe(true);
	});

	it('detects control command after line comment', () => {
		expect(isControlCommand('// comment\n.show databases')).toBe(true);
	});

	it('detects control command after block comment', () => {
		expect(isControlCommand('/* comment */.show databases')).toBe(true);
	});

	it('returns false for regular queries', () => {
		expect(isControlCommand('StormEvents | take 10')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(isControlCommand('')).toBe(false);
	});

	it('returns false if only comments and nothing after', () => {
		expect(isControlCommand('// just a comment')).toBe(false);
	});

	it('returns false for query starting with non-dot character', () => {
		expect(isControlCommand('T | where x > 1')).toBe(false);
	});

	it('returns false for unclosed block comment', () => {
		expect(isControlCommand('/* unclosed .show')).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// appendQueryMode
// ---------------------------------------------------------------------------

describe('appendQueryMode', () => {
	it('appends take 100 for take100 mode', () => {
		expect(appendQueryMode('T | where x > 1', 'take100')).toBe('T | where x > 1\n| take 100');
	});

	it('appends sample 100 for sample100 mode', () => {
		expect(appendQueryMode('T', 'sample100')).toBe('T\n| sample 100');
	});

	it('returns query unchanged for plain mode', () => {
		expect(appendQueryMode('T | take 5', 'plain')).toBe('T | take 5');
	});

	it('returns query unchanged for empty mode', () => {
		expect(appendQueryMode('T | take 5', '')).toBe('T | take 5');
	});

	it('returns query unchanged for undefined mode', () => {
		expect(appendQueryMode('T | take 5')).toBe('T | take 5');
	});

	it('does not append to control commands', () => {
		expect(appendQueryMode('.show databases', 'take100')).toBe('.show databases');
	});

	it('strips trailing semicolons before appending', () => {
		expect(appendQueryMode('T | where x > 1;', 'take100')).toBe('T | where x > 1\n| take 100');
	});

	it('strips trailing whitespace before appending', () => {
		expect(appendQueryMode('T   ', 'take100')).toBe('T\n| take 100');
	});
});

// ---------------------------------------------------------------------------
// buildCacheDirective
// ---------------------------------------------------------------------------

describe('buildCacheDirective', () => {
	it('returns undefined when not enabled', () => {
		expect(buildCacheDirective(false, 5, 'minutes')).toBeUndefined();
	});

	it('returns undefined when no value', () => {
		expect(buildCacheDirective(true, 0, 'minutes')).toBeUndefined();
	});

	it('returns undefined when no unit', () => {
		expect(buildCacheDirective(true, 5, '')).toBeUndefined();
	});

	it('builds minutes directive', () => {
		expect(buildCacheDirective(true, 30, 'minutes')).toBe('set query_results_cache_max_age = time(30m);');
	});

	it('builds hours directive', () => {
		expect(buildCacheDirective(true, 2, 'hours')).toBe('set query_results_cache_max_age = time(2h);');
	});

	it('builds days directive', () => {
		expect(buildCacheDirective(true, 7, 'days')).toBe('set query_results_cache_max_age = time(7d);');
	});

	it('returns undefined for unknown unit', () => {
		expect(buildCacheDirective(true, 5, 'weeks')).toBeUndefined();
	});

	it('handles unit case-insensitively', () => {
		expect(buildCacheDirective(true, 1, 'Hours')).toBe('set query_results_cache_max_age = time(1h);');
	});
});
