import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, it, expect } from 'vitest';
import {
	detectPlatform,
	getArchiveExtension,
	getDownloadUrl,
	getBinaryName,
	getCacheDir,
	getBinaryPath,
	getExpectedArchiveSha256,
	sha256File,
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

	it('pins the reviewed SQL Tools Service release', () => {
		expect(STS_VERSION).toBe('6.0.20260409.1');
		expect(getExpectedArchiveSha256('win-x64')).toBe('6560ee3c8ec350b467e5c143fec418c26612ebb6d4a5d55e3ad8a30ce6a1160f');
		expect(getExpectedArchiveSha256('linux-x64')).toBe('02edc29f2efc6226fa353d0d2f88d906921c0166672c445958c9c93c5b91ef7e');
		expect(getExpectedArchiveSha256('osx-arm64')).toBe('a6bda527ce19ba6ad37cc16f875754aa42befb6cc317ab197b3ea7caa465f6de');
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

describe('installer cancellation', () => {
	it('cancels archive hashing without publishing a digest', async () => {
		const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sts-hash-'));
		const filePath = path.join(directory, 'large.bin');
		fs.writeFileSync(filePath, Buffer.alloc(16 * 1024 * 1024, 7));
		let cancelled = false;
		const handlers = new Set<() => void>();
		const token = {
			get isCancellationRequested() { return cancelled; },
			onCancellationRequested(handler: () => void) {
				handlers.add(handler);
				return { dispose: () => handlers.delete(handler) };
			},
		} as any;
		try {
			const hashing = sha256File(filePath, token);
			cancelled = true;
			for (const handler of handlers) handler();
			await expect(hashing).rejects.toThrow('Cancelled');
		} finally {
			fs.rmSync(directory, { recursive: true, force: true });
		}
	});
});
