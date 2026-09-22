// @vitest-environment node

import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	acquireExternalMcpRuntimeArchive,
	downloadExternalMcpRuntimeArchive,
	parseExternalMcpRuntimeMetadata,
	type ExternalMcpRuntimeMetadata,
} from '../../../src/host/externalMcpRuntime';

function metadataFor(payload: Uint8Array): ExternalMcpRuntimeMetadata {
	const version = '24.21.0';
	const target = 'win-x64' as const;
	const archive = `node-v${version}-${target}.zip`;
	return {
		schemaVersion: 1,
		version,
		target,
		archive,
		sha256: createHash('sha256').update(payload).digest('hex'),
		downloadUrl: `https://nodejs.org/dist/v${version}/${archive}`,
	};
}

describe('external MCP runtime acquisition', () => {
	const roots: string[] = [];
	afterEach(() => {
		for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
	});

	it('accepts only the pinned nodejs.org archive shape', () => {
		const metadata = metadataFor(Buffer.from('runtime'));
		expect(parseExternalMcpRuntimeMetadata(metadata)).toEqual(metadata);
		expect(() => parseExternalMcpRuntimeMetadata({
			...metadata,
			downloadUrl: 'https://example.test/runtime.zip',
		})).toThrow('download location');
		expect(() => parseExternalMcpRuntimeMetadata({
			...metadata,
			target: 'win-arm64',
		})).toThrow('metadata is invalid');
		expect(() => parseExternalMcpRuntimeMetadata({
			...metadata,
			sha256: 'not-a-hash',
		})).toThrow('metadata is invalid');
	});

	it('rejects unapproved direct download URLs without leaving a deadline timer', async () => {
		vi.useFakeTimers();
		try {
			await expect(downloadExternalMcpRuntimeArchive('https://example.test/runtime.zip', 'unused.zip'))
				.rejects.toThrow('not an approved nodejs.org HTTPS URL');
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it('downloads once, reuses a verified cache, and repairs corrupt cached bytes', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-runtime-cache-'));
		roots.push(root);
		const payload = Buffer.from('verified runtime archive');
		const metadata = metadataFor(payload);
		const download = vi.fn(async (_url: string, destination: string) => {
			await writeFile(destination, payload);
		});

		const first = await acquireExternalMcpRuntimeArchive(metadata, root, download);
		const offlineDownload = vi.fn(async () => { throw new Error('offline'); });
		const second = await acquireExternalMcpRuntimeArchive(metadata, root, offlineDownload);
		expect(second).toBe(first);
		expect(download).toHaveBeenCalledOnce();
		expect(offlineDownload).not.toHaveBeenCalled();
		expect(readFileSync(first)).toEqual(payload);

		await writeFile(first, 'corrupt');
		const repaired = await acquireExternalMcpRuntimeArchive(metadata, root, download);
		expect(repaired).toBe(first);
		expect(download).toHaveBeenCalledTimes(2);
		expect(readFileSync(repaired)).toEqual(payload);
	});

	it('reports network failures and removes partial downloads', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-runtime-offline-'));
		roots.push(root);
		const metadata = metadataFor(Buffer.from('expected'));
		const download = vi.fn(async (_url: string, destination: string) => {
			await writeFile(destination, 'partial');
			throw new Error('network unavailable');
		});

		await expect(acquireExternalMcpRuntimeArchive(metadata, root, download))
			.rejects.toThrow('Check your network connection and retry external-tools setup: network unavailable');
		expect(readdirSync(root)).toEqual([]);
	});

	it('rejects a hash mismatch without publishing bad or partial cache files', async () => {
		const root = mkdtempSync(join(tmpdir(), 'kw-runtime-mismatch-'));
		roots.push(root);
		const metadata = metadataFor(Buffer.from('expected'));
		const download = vi.fn(async (_url: string, destination: string) => {
			await writeFile(destination, 'unexpected');
		});

		await expect(acquireExternalMcpRuntimeArchive(metadata, root, download))
			.rejects.toThrow('SHA-256 mismatch');
		expect(readdirSync(root)).toEqual([]);
	});
});
