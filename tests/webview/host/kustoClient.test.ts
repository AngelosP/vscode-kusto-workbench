import { describe, it, expect } from 'vitest';
import { parseKustoTimespan, normalizeClusterEndpoint } from '../../../src/host/kustoClient';

// ── parseKustoTimespan ────────────────────────────────────────────────────────

describe('parseKustoTimespan', () => {
	it('parses standard hh:mm:ss format', () => {
		expect(parseKustoTimespan('00:00:01')).toBe(1000);
	});

	it('parses hh:mm:ss.fraction format', () => {
		expect(parseKustoTimespan('00:00:01.5000000')).toBe(1500);
	});

	it('parses hours and minutes', () => {
		expect(parseKustoTimespan('01:30:00')).toBe(5400000); // 1h30m = 5400s
	});

	it('parses days.hh:mm:ss format', () => {
		expect(parseKustoTimespan('1.00:00:00')).toBe(86400000); // 1 day
	});

	it('parses days.hh:mm:ss.fraction format', () => {
		expect(parseKustoTimespan('2.12:30:45.5')).toBe(
			(2 * 86400 + 12 * 3600 + 30 * 60 + 45.5) * 1000
		);
	});

	it('parses fractional seconds with many digits', () => {
		expect(parseKustoTimespan('00:00:00.1406250')).toBeCloseTo(140.625, 1);
	});

	it('parses zero timespan', () => {
		expect(parseKustoTimespan('00:00:00')).toBe(0);
	});

	it('parses zero with fraction', () => {
		expect(parseKustoTimespan('00:00:00.0000000')).toBe(0);
	});

	it('returns undefined for undefined input', () => {
		expect(parseKustoTimespan(undefined)).toBeUndefined();
	});

	it('returns undefined for empty string', () => {
		expect(parseKustoTimespan('')).toBeUndefined();
	});

	it('returns undefined for non-string input', () => {
		expect(parseKustoTimespan(42 as any)).toBeUndefined();
	});

	it('returns undefined for malformed string', () => {
		expect(parseKustoTimespan('not-a-timespan')).toBeUndefined();
	});

	it('returns undefined for partial format', () => {
		expect(parseKustoTimespan('12:34')).toBeUndefined();
	});

	it('handles large day values', () => {
		expect(parseKustoTimespan('365.00:00:00')).toBe(365 * 86400000);
	});

	it('handles typical CPU time from Kusto response', () => {
		// Real-world example: "00:00:00.1406250"
		const ms = parseKustoTimespan('00:00:00.1406250');
		expect(ms).toBeDefined();
		expect(ms!).toBeCloseTo(140.625, 1);
	});
});

// ── normalizeClusterEndpoint ──────────────────────────────────────────────────

describe('normalizeClusterEndpoint', () => {
	it('normalizes full URL with scheme', () => {
		expect(normalizeClusterEndpoint('https://mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('adds https:// to bare hostname', () => {
		expect(normalizeClusterEndpoint('mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('expands short name without .kusto. domain', () => {
		expect(normalizeClusterEndpoint('help'))
			.toBe('https://help.kusto.windows.net');
	});

	it('expands regional short name', () => {
		expect(normalizeClusterEndpoint('mycluster.westus'))
			.toBe('https://mycluster.westus.kusto.windows.net');
	});

	it('preserves http:// scheme', () => {
		const result = normalizeClusterEndpoint('http://mycluster.kusto.windows.net');
		expect(result).toBe('http://mycluster.kusto.windows.net');
	});

	it('strips trailing slashes', () => {
		const result = normalizeClusterEndpoint('https://mycluster.kusto.windows.net/');
		// URL normalization removes trailing path
		expect(result).toBe('https://mycluster.kusto.windows.net');
	});

	it('strips leading slashes from bare hostname', () => {
		expect(normalizeClusterEndpoint('///help'))
			.toBe('https://help.kusto.windows.net');
	});

	it('trims whitespace', () => {
		expect(normalizeClusterEndpoint('  help  '))
			.toBe('https://help.kusto.windows.net');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeClusterEndpoint('')).toBe('');
	});

	it('returns empty string for null-ish input', () => {
		expect(normalizeClusterEndpoint(null as any)).toBe('');
		expect(normalizeClusterEndpoint(undefined as any)).toBe('');
	});

	it('does not expand URLs that already contain .kusto.', () => {
		expect(normalizeClusterEndpoint('https://myspecial.kusto.data.microsoft.com'))
			.toBe('https://myspecial.kusto.data.microsoft.com');
	});

	it('handles https://help correctly', () => {
		expect(normalizeClusterEndpoint('https://help'))
			.toBe('https://help.kusto.windows.net');
	});

	it('handles real cluster URL with port', () => {
		// Ports are stripped by URL normalization (standard https port)
		const result = normalizeClusterEndpoint('https://mycluster.kusto.windows.net:443');
		expect(result).toBe('https://mycluster.kusto.windows.net');
	});
});
