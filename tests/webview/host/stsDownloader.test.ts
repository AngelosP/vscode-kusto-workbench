import { describe, it, expect } from 'vitest';
import {
	detectPlatform,
	getArchiveExtension,
	getDownloadUrl,
	getBinaryName,
	getCacheDir,
	getBinaryPath,
	STS_VERSION,
} from '../../../src/host/sql/stsDownloader';

// ── detectPlatform ────────────────────────────────────────────────────────────

describe('detectPlatform', () => {
	it('returns a non-null value for the current platform', () => {
		// We're running tests on an actual platform, so it should detect something
		const result = detectPlatform();
		// Can be null on unsupported platforms, but on common dev machines it should work
		if (process.platform === 'win32' || process.platform === 'darwin' || process.platform === 'linux') {
			expect(result).not.toBeNull();
		}
	});

	it('returns a string matching the expected format', () => {
		const result = detectPlatform();
		if (result) {
			expect(result).toMatch(/^(win|osx|linux)-(x64|arm64)$/);
		}
	});
});

// ── STS_VERSION ───────────────────────────────────────────────────────────────

describe('STS_VERSION', () => {
	it('is a non-empty string', () => {
		expect(STS_VERSION).toBeTruthy();
		expect(typeof STS_VERSION).toBe('string');
	});

	it('matches the expected version format', () => {
		expect(STS_VERSION).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
	});
});

// ── getArchiveExtension ───────────────────────────────────────────────────────

describe('getArchiveExtension', () => {
	it('returns "zip" for Windows platforms', () => {
		expect(getArchiveExtension('win-x64')).toBe('zip');
		expect(getArchiveExtension('win-arm64')).toBe('zip');
	});

	it('returns "tar.gz" for macOS and Linux platforms', () => {
		expect(getArchiveExtension('osx-x64')).toBe('tar.gz');
		expect(getArchiveExtension('osx-arm64')).toBe('tar.gz');
		expect(getArchiveExtension('linux-x64')).toBe('tar.gz');
		expect(getArchiveExtension('linux-arm64')).toBe('tar.gz');
	});
});

// ── getDownloadUrl ────────────────────────────────────────────────────────────

describe('getDownloadUrl', () => {
	it('constructs correct URL for win-x64', () => {
		const url = getDownloadUrl('1.2.3.4', 'win-x64');
		expect(url).toBe(
			'https://github.com/microsoft/sqltoolsservice/releases/download/1.2.3.4/Microsoft.SqlTools.ServiceLayer-win-x64-net10.0.zip',
		);
	});

	it('constructs correct URL for osx-arm64', () => {
		const url = getDownloadUrl('1.2.3.4', 'osx-arm64');
		expect(url).toBe(
			'https://github.com/microsoft/sqltoolsservice/releases/download/1.2.3.4/Microsoft.SqlTools.ServiceLayer-osx-arm64-net10.0.tar.gz',
		);
	});

	it('constructs correct URL for linux-x64', () => {
		const url = getDownloadUrl('1.2.3.4', 'linux-x64');
		expect(url).toBe(
			'https://github.com/microsoft/sqltoolsservice/releases/download/1.2.3.4/Microsoft.SqlTools.ServiceLayer-linux-x64-net10.0.tar.gz',
		);
	});

	it('uses the provided version string', () => {
		const url = getDownloadUrl(STS_VERSION, 'win-x64');
		expect(url).toContain(STS_VERSION);
	});
});

// ── getBinaryName ─────────────────────────────────────────────────────────────

describe('getBinaryName', () => {
	it('returns .exe for Windows', () => {
		expect(getBinaryName('win-x64')).toBe('MicrosoftSqlToolsServiceLayer.exe');
		expect(getBinaryName('win-arm64')).toBe('MicrosoftSqlToolsServiceLayer.exe');
	});

	it('returns no extension for macOS and Linux', () => {
		expect(getBinaryName('osx-x64')).toBe('MicrosoftSqlToolsServiceLayer');
		expect(getBinaryName('osx-arm64')).toBe('MicrosoftSqlToolsServiceLayer');
		expect(getBinaryName('linux-x64')).toBe('MicrosoftSqlToolsServiceLayer');
		expect(getBinaryName('linux-arm64')).toBe('MicrosoftSqlToolsServiceLayer');
	});
});

// ── getCacheDir ───────────────────────────────────────────────────────────────

describe('getCacheDir', () => {
	it('constructs the expected path', () => {
		const dir = getCacheDir('/global/storage', '1.2.3.4', 'win-x64');
		// Normalize for cross-platform comparison
		const normalized = dir.replace(/\\/g, '/');
		expect(normalized).toBe('/global/storage/sqltoolsservice/1.2.3.4/win-x64');
	});
});

// ── getBinaryPath ─────────────────────────────────────────────────────────────

describe('getBinaryPath', () => {
	it('includes version, platform, and binary name', () => {
		const p = getBinaryPath('/global/storage', '1.2.3.4', 'osx-arm64');
		const normalized = p.replace(/\\/g, '/');
		expect(normalized).toBe('/global/storage/sqltoolsservice/1.2.3.4/osx-arm64/MicrosoftSqlToolsServiceLayer');
	});

	it('uses .exe for Windows', () => {
		const p = getBinaryPath('/global/storage', '1.2.3.4', 'win-x64');
		const normalized = p.replace(/\\/g, '/');
		expect(normalized).toContain('MicrosoftSqlToolsServiceLayer.exe');
	});
});
