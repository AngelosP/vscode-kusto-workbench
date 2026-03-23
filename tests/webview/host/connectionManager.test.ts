import { describe, it, expect } from 'vitest';
import { normalizeClusterUrl } from '../../../src/host/connectionManager';

// ── normalizeClusterUrl ───────────────────────────────────────────────────────
// This function is used throughout the extension for connection identity comparison.
// Getting it wrong means silently connecting to the wrong cluster or losing cached data.

describe('normalizeClusterUrl', () => {
	it('adds https:// to bare hostname', () => {
		expect(normalizeClusterUrl('mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('preserves https:// prefix', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('preserves http:// prefix', () => {
		expect(normalizeClusterUrl('http://mycluster.kusto.windows.net'))
			.toBe('http://mycluster.kusto.windows.net');
	});

	it('lowercases the entire URL', () => {
		expect(normalizeClusterUrl('HTTPS://MyCluster.Kusto.Windows.Net'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('strips trailing slashes', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('strips multiple trailing slashes', () => {
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net///'))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('trims whitespace', () => {
		expect(normalizeClusterUrl('  mycluster.kusto.windows.net  '))
			.toBe('https://mycluster.kusto.windows.net');
	});

	it('returns empty string for empty input', () => {
		expect(normalizeClusterUrl('')).toBe('');
	});

	it('returns empty string for null-ish input', () => {
		expect(normalizeClusterUrl(null as any)).toBe('');
		expect(normalizeClusterUrl(undefined as any)).toBe('');
	});

	it('returns empty string for whitespace-only input', () => {
		expect(normalizeClusterUrl('   ')).toBe('');
	});

	it('handles short names (no scheme, no domain)', () => {
		expect(normalizeClusterUrl('help')).toBe('https://help');
	});

	it('handles regional cluster names', () => {
		expect(normalizeClusterUrl('mycluster.westus.kusto.windows.net'))
			.toBe('https://mycluster.westus.kusto.windows.net');
	});

	it('preserves path segments', () => {
		// Some special Kusto endpoints may have path segments
		expect(normalizeClusterUrl('https://mycluster.kusto.windows.net/v1'))
			.toBe('https://mycluster.kusto.windows.net/v1');
	});

	it('handles HTTPS with mixed case', () => {
		expect(normalizeClusterUrl('HTTPS://Help.kusto.windows.net'))
			.toBe('https://help.kusto.windows.net');
	});

	it('two URLs differing only in case normalize to the same value', () => {
		const a = normalizeClusterUrl('https://MyCluster.Kusto.Windows.Net');
		const b = normalizeClusterUrl('https://mycluster.kusto.windows.net');
		expect(a).toBe(b);
	});

	it('two URLs differing only in trailing slash normalize to the same value', () => {
		const a = normalizeClusterUrl('https://mycluster.kusto.windows.net/');
		const b = normalizeClusterUrl('https://mycluster.kusto.windows.net');
		expect(a).toBe(b);
	});

	it('two URLs where one has scheme and one does not normalize to the same value', () => {
		const a = normalizeClusterUrl('https://mycluster.kusto.windows.net');
		const b = normalizeClusterUrl('mycluster.kusto.windows.net');
		expect(a).toBe(b);
	});
});
