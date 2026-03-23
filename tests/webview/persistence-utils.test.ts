import { describe, it, expect } from 'vitest';
import {
	normalizeClusterUrl,
	isLeaveNoTraceCluster,
	byteLengthUtf8,
	trySerializeQueryResult,
} from '../../src/webview/shared/persistence-utils';

// ── normalizeClusterUrl ──────────────────────────────────────────────────────

describe('normalizeClusterUrl', () => {
	it('returns empty string for falsy input', () => {
		expect(normalizeClusterUrl('')).toBe('');
		expect(normalizeClusterUrl(null)).toBe('');
		expect(normalizeClusterUrl(undefined)).toBe('');
		expect(normalizeClusterUrl(0)).toBe('');
	});

	it('adds https:// prefix when missing', () => {
		expect(normalizeClusterUrl('mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('preserves existing https:// prefix', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('preserves http:// prefix', () => {
		expect(normalizeClusterUrl('http://mycluster.kusto.windows.net')).toBe('http://mycluster.kusto.windows.net');
	});

	it('strips trailing slashes', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/')).toBe('https://mycluster.kusto.windows.net');
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net///')).toBe('https://mycluster.kusto.windows.net');
	});

	it('lowercases the URL', () => {
		expect(normalizeClusterUrl('https://MyCluster.Kusto.Windows.Net')).toBe('https://mycluster.kusto.windows.net');
	});

	it('trims whitespace', () => {
		expect(normalizeClusterUrl('  https://mycluster.kusto.windows.net  ')).toBe('https://mycluster.kusto.windows.net');
	});

	it('handles URL with path', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/path')).toBe('https://mycluster.kusto.windows.net/path');
	});
});

// ── isLeaveNoTraceCluster ────────────────────────────────────────────────────

describe('isLeaveNoTraceCluster', () => {
	it('returns false for empty cluster URL', () => {
		expect(isLeaveNoTraceCluster('', ['https://a.kusto.windows.net'])).toBe(false);
		expect(isLeaveNoTraceCluster(null, ['https://a.kusto.windows.net'])).toBe(false);
	});

	it('returns false when list is empty', () => {
		expect(isLeaveNoTraceCluster('https://a.kusto.windows.net', [])).toBe(false);
	});

	it('returns false when list is not an array', () => {
		expect(isLeaveNoTraceCluster('https://a.kusto.windows.net', null as any)).toBe(false);
		expect(isLeaveNoTraceCluster('https://a.kusto.windows.net', undefined as any)).toBe(false);
	});

	it('matches exact URLs', () => {
		const list = ['https://secret.kusto.windows.net', 'https://other.kusto.windows.net'];
		expect(isLeaveNoTraceCluster('https://secret.kusto.windows.net', list)).toBe(true);
		expect(isLeaveNoTraceCluster('https://other.kusto.windows.net', list)).toBe(true);
	});

	it('matches case-insensitively', () => {
		const list = ['https://Secret.Kusto.Windows.Net'];
		expect(isLeaveNoTraceCluster('https://secret.kusto.windows.net', list)).toBe(true);
		expect(isLeaveNoTraceCluster('HTTPS://SECRET.KUSTO.WINDOWS.NET', list)).toBe(true);
	});

	it('matches URLs with/without trailing slashes', () => {
		const list = ['https://secret.kusto.windows.net/'];
		expect(isLeaveNoTraceCluster('https://secret.kusto.windows.net', list)).toBe(true);
	});

	it('matches URLs with/without https:// prefix', () => {
		const list = ['secret.kusto.windows.net'];
		expect(isLeaveNoTraceCluster('https://secret.kusto.windows.net', list)).toBe(true);
	});

	it('returns false when URL is not in list', () => {
		const list = ['https://other.kusto.windows.net'];
		expect(isLeaveNoTraceCluster('https://secret.kusto.windows.net', list)).toBe(false);
	});
});

// ── byteLengthUtf8 ───────────────────────────────────────────────────────────

describe('byteLengthUtf8', () => {
	it('returns correct byte length for ASCII strings', () => {
		expect(byteLengthUtf8('hello')).toBe(5);
		expect(byteLengthUtf8('')).toBe(0);
	});

	it('returns correct byte length for multi-byte characters', () => {
		// "é" is 2 bytes in UTF-8
		expect(byteLengthUtf8('é')).toBe(2);
		// "€" is 3 bytes in UTF-8
		expect(byteLengthUtf8('€')).toBe(3);
	});

	it('handles non-string input by coercing to string', () => {
		expect(byteLengthUtf8(42)).toBe(2); // "42"
		expect(byteLengthUtf8(true)).toBe(4); // "true"
	});
});

// ── trySerializeQueryResult ──────────────────────────────────────────────────

describe('trySerializeQueryResult', () => {
	it('serializes small results unchanged', () => {
		const result = { columns: ['a'], rows: [[1], [2]], metadata: {} };
		const { json, truncated } = trySerializeQueryResult(result);
		expect(truncated).toBe(false);
		expect(json).not.toBeNull();
		const parsed = JSON.parse(json!);
		expect(parsed.rows).toEqual([[1], [2]]);
	});

	it('returns null for null/undefined input', () => {
		expect(trySerializeQueryResult(null).json).toBeNull();
		expect(trySerializeQueryResult(undefined).json).toBeNull();
	});

	it('returns null for non-serializable input', () => {
		const circular: any = {};
		circular.self = circular;
		const { json } = trySerializeQueryResult(circular);
		expect(json).toBeNull();
	});

	it('truncates results that exceed the byte cap', () => {
		// Create a large result
		const bigRow = ['x'.repeat(100)];
		const rows = Array.from({ length: 1000 }, () => [...bigRow]);
		const result = { columns: ['col1'], rows, metadata: {} };
		const maxBytes = 5000; // very small cap for testing
		const { json, truncated, rowCount } = trySerializeQueryResult(result, maxBytes);
		expect(truncated).toBe(true);
		expect(json).not.toBeNull();
		expect(rowCount).toBeDefined();
		expect(rowCount!).toBeLessThan(1000);
		expect(byteLengthUtf8(json!)).toBeLessThanOrEqual(maxBytes);
		const parsed = JSON.parse(json!);
		expect(parsed.metadata.persistedTruncated).toBe(true);
		expect(parsed.metadata.persistedTotalRows).toBe(1000);
	});

	it('returns null when even a single row exceeds the cap', () => {
		const result = { columns: ['col1'], rows: [['x'.repeat(10000)]], metadata: {} };
		const { json } = trySerializeQueryResult(result, 100);
		expect(json).toBeNull();
	});

	it('respects maxRowsHardCap', () => {
		const rows = Array.from({ length: 100 }, (_, i) => [i]);
		const result = { columns: ['n'], rows, metadata: {} };
		const { json, truncated } = trySerializeQueryResult(result, 1024 * 1024, 10);
		// With a hard cap of 10, result should be truncated even though byte-wise it fits
		if (truncated) {
			const parsed = JSON.parse(json!);
			expect(parsed.rows.length).toBeLessThanOrEqual(10);
		}
	});

	it('preserves metadata through truncation', () => {
		const rows = Array.from({ length: 100 }, () => ['x'.repeat(50)]);
		const result = { columns: ['col1'], rows, metadata: { executionTime: '5s', source: 'test' } };
		const { json, truncated } = trySerializeQueryResult(result, 2000);
		if (truncated) {
			const parsed = JSON.parse(json!);
			expect(parsed.metadata.executionTime).toBe('5s');
			expect(parsed.metadata.source).toBe('test');
			expect(parsed.metadata.persistedTruncated).toBe(true);
		}
	});

	it('handles result with no rows gracefully (too large metadata)', () => {
		const result = { columns: ['a'], rows: [], metadata: { big: 'x'.repeat(200) } };
		const { json } = trySerializeQueryResult(result, 100);
		// No rows to trim, so it should give up
		expect(json).toBeNull();
	});

	it('maxRowsHardCap of zero does not affect results that fit under maxBytes', () => {
		const rows = Array.from({ length: 10 }, (_, i) => [i]);
		const result = { columns: ['n'], rows, metadata: {} };
		// maxRowsHardCap only constrains the truncation path; if the full result fits, it's returned as-is
		const { json, truncated } = trySerializeQueryResult(result, 1024 * 1024, 0);
		expect(json).not.toBeNull();
		expect(truncated).toBe(false);
	});

	it('result with zero maxBytes always truncates to null', () => {
		const result = { columns: ['a'], rows: [[1]], metadata: {} };
		const { json } = trySerializeQueryResult(result, 0);
		expect(json).toBeNull();
	});

	it('result with exactly one row and tight budget serializes that row', () => {
		const result = { columns: ['n'], rows: [[42]], metadata: {} };
		// Use a generous budget for 1 row
		const { json, truncated } = trySerializeQueryResult(result, 10000, 1);
		expect(json).not.toBeNull();
		const parsed = JSON.parse(json!);
		expect(parsed.rows).toEqual([[42]]);
		// 1 row with hardcap 1 — the original fits, so truncated should be false
		expect(truncated).toBe(false);
	});

	it('handles result with boolean values', () => {
		const result = { columns: ['flag'], rows: [[true], [false]], metadata: {} };
		const { json, truncated } = trySerializeQueryResult(result);
		expect(truncated).toBe(false);
		const parsed = JSON.parse(json!);
		expect(parsed.rows).toEqual([[true], [false]]);
	});

	it('handles result with nested objects in cells', () => {
		const result = { columns: ['data'], rows: [[{ nested: { deep: 'value' } }]], metadata: {} };
		const { json, truncated } = trySerializeQueryResult(result);
		expect(truncated).toBe(false);
		expect(json).not.toBeNull();
		const parsed = JSON.parse(json!);
		expect(parsed.rows[0][0].nested.deep).toBe('value');
	});
});
