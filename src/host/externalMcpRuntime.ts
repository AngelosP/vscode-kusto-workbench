import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { get } from 'node:https';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';

const MAX_RUNTIME_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const DOWNLOAD_TIMEOUT_MS = 120_000;

export interface ExternalMcpRuntimeMetadata {
	readonly schemaVersion: 1;
	readonly version: string;
	readonly target: 'win-x64';
	readonly archive: string;
	readonly sha256: string;
	readonly downloadUrl: string;
}

export type ExternalMcpRuntimeDownloader = (url: string, destination: string) => Promise<void>;

export function parseExternalMcpRuntimeMetadata(value: unknown): ExternalMcpRuntimeMetadata {
	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		throw new Error('The packaged connector runtime metadata is invalid.');
	}
	const metadata = value as Record<string, unknown>;
	if (metadata.schemaVersion !== 1
		|| typeof metadata.version !== 'string'
		|| !/^\d+\.\d+\.\d+$/.test(metadata.version)
		|| metadata.target !== 'win-x64'
		|| typeof metadata.archive !== 'string'
		|| typeof metadata.sha256 !== 'string'
		|| !/^[a-f0-9]{64}$/i.test(metadata.sha256)
		|| typeof metadata.downloadUrl !== 'string') {
		throw new Error('The packaged connector runtime metadata is invalid.');
	}
	const expectedArchive = `node-v${metadata.version}-${metadata.target}.zip`;
	const expectedUrl = `https://nodejs.org/dist/v${metadata.version}/${expectedArchive}`;
	if (metadata.archive !== expectedArchive || metadata.downloadUrl !== expectedUrl) {
		throw new Error('The packaged connector runtime download location is invalid.');
	}
	return {
		schemaVersion: 1,
		version: metadata.version,
		target: metadata.target,
		archive: metadata.archive,
		sha256: metadata.sha256.toLowerCase(),
		downloadUrl: metadata.downloadUrl,
	};
}

export async function sha256File(path: string): Promise<string> {
	const hash = createHash('sha256');
	await pipeline(createReadStream(path), hash);
	return hash.digest('hex');
}

async function isVerifiedArchive(path: string, expectedSha256: string): Promise<boolean> {
	try {
		const file = await stat(path);
		if (!file.isFile() || file.size <= 0 || file.size > MAX_RUNTIME_ARCHIVE_BYTES) return false;
		return await sha256File(path) === expectedSha256;
	} catch {
		return false;
	}
}

function validatedRuntimeUrl(value: string): URL {
	const url = new URL(value);
	if (url.protocol !== 'https:'
		|| url.hostname !== 'nodejs.org'
		|| url.username
		|| url.password
		|| url.search
		|| url.hash) {
		throw new Error('The connector runtime download URL is not an approved nodejs.org HTTPS URL.');
	}
	return url;
}

export function downloadExternalMcpRuntimeArchive(
	url: string,
	destination: string,
	redirectCount = 0,
): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(
		() => controller.abort(new Error('Connector runtime download timed out.')),
		DOWNLOAD_TIMEOUT_MS,
	);
	return Promise.resolve()
		.then(() => downloadExternalMcpRuntimeArchiveWithRedirects(url, destination, redirectCount, controller.signal))
		.catch(error => {
			if (controller.signal.aborted && controller.signal.reason instanceof Error) {
				throw controller.signal.reason;
			}
			throw error;
		})
		.finally(() => clearTimeout(timeout));
}

function downloadExternalMcpRuntimeArchiveWithRedirects(
	url: string,
	destination: string,
	redirectCount: number,
	signal: AbortSignal,
): Promise<void> {
	if (redirectCount > MAX_REDIRECTS) return Promise.reject(new Error('Too many redirects while downloading the connector runtime.'));
	const validatedUrl = validatedRuntimeUrl(url);
	return new Promise<void>((resolve, reject) => {
		let settled = false;
		const settle = (error?: unknown) => {
			if (settled) return;
			settled = true;
			if (error !== undefined) reject(error);
			else resolve();
		};
		const request = get(validatedUrl, { headers: { 'user-agent': 'vscode-kusto-workbench' }, signal }, response => {
			const status = response.statusCode ?? 0;
			if (status >= 300 && status < 400 && response.headers.location) {
				response.destroy();
				let redirected: URL;
				try {
					redirected = validatedRuntimeUrl(new URL(response.headers.location, validatedUrl).toString());
				} catch (error) {
					settle(error);
					return;
				}
				void downloadExternalMcpRuntimeArchiveWithRedirects(
					redirected.toString(), destination, redirectCount + 1, signal,
				)
					.then(() => settle(), settle);
				return;
			}
			if (status !== 200) {
				response.destroy();
				settle(new Error(`Connector runtime download failed with HTTP ${status}.`));
				return;
			}
			const contentLength = Number(response.headers['content-length'] ?? 0);
			if (Number.isFinite(contentLength) && contentLength > MAX_RUNTIME_ARCHIVE_BYTES) {
				response.destroy();
				settle(new Error('Connector runtime download exceeded its size limit.'));
				return;
			}
			let downloaded = 0;
			response.on('data', (chunk: Buffer) => {
				downloaded += chunk.length;
				if (downloaded > MAX_RUNTIME_ARCHIVE_BYTES) {
					response.destroy(new Error('Connector runtime download exceeded its size limit.'));
				}
			});
			const output = createWriteStream(destination, { flags: 'wx', mode: 0o600 });
			void pipeline(response, output).then(() => settle(), settle);
		});
		request.once('error', settle);
	});
}

export async function acquireExternalMcpRuntimeArchive(
	metadata: ExternalMcpRuntimeMetadata,
	cacheDirectory: string,
	download: ExternalMcpRuntimeDownloader = downloadExternalMcpRuntimeArchive,
): Promise<string> {
	await mkdir(cacheDirectory, { recursive: true });
	const archivePath = join(cacheDirectory, metadata.archive);
	if (await isVerifiedArchive(archivePath, metadata.sha256)) return archivePath;
	await rm(archivePath, { force: true });
	const temporaryPath = `${archivePath}.${randomUUID()}.partial`;
	try {
		await download(metadata.downloadUrl, temporaryPath);
		const actualSha256 = await sha256File(temporaryPath);
		if (actualSha256 !== metadata.sha256) {
			throw new Error(`Connector runtime SHA-256 mismatch: expected ${metadata.sha256}, received ${actualSha256}.`);
		}
		await rename(temporaryPath, archivePath);
		return archivePath;
	} catch (error) {
		throw new Error(
			`Could not download the verified Node ${metadata.version} runtime. Check your network connection and retry external-tools setup: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}
