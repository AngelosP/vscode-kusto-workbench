import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as crypto from 'crypto';
import * as lockfile from 'proper-lockfile';
import { spawn } from 'child_process';
import type { WorkbenchLogger } from '../workbenchLogger';

export const STS_VERSION = '6.0.20260409.1';
const CACHE_MANIFEST = 'kusto-workbench-sts.json';
const INSTALL_LOCK_STALE_MS = 10 * 60_000;
const INSTALL_LOCK_UPDATE_MS = 15_000;
const INSTALL_LOCK_WAIT_MS = 6 * 60_000;
const INSTALL_LOCK_RETRY_MS = 200;

const STS_ARCHIVE_SHA256: Record<StsPlatform, string> = {
	'win-x64': '6560ee3c8ec350b467e5c143fec418c26612ebb6d4a5d55e3ad8a30ce6a1160f',
	'win-arm64': '5a15a4f768bfcd778ad55e7183fff84f56fa36fda305f303c688fa639ace6f2e',
	'osx-x64': '2369ebc19cb421b7cfb23dedd51e4aa99771b02ef8bf6e88ccef50ff265003d3',
	'osx-arm64': 'a6bda527ce19ba6ad37cc16f875754aa42befb6cc317ab197b3ea7caa465f6de',
	'linux-x64': '02edc29f2efc6226fa353d0d2f88d906921c0166672c445958c9c93c5b91ef7e',
	'linux-arm64': 'ad75e1b697b738fb2c6e88821a14eaf0c8ade4b7b6c759d660389117e9a746bc',
};

export type StsPlatform = 'win-x64' | 'win-arm64' | 'osx-x64' | 'osx-arm64' | 'linux-x64' | 'linux-arm64';

export function detectPlatform(): StsPlatform | null {
	const plat = process.platform;
	const arch = process.arch;
	if (plat === 'win32' && arch === 'x64') return 'win-x64';
	if (plat === 'win32' && arch === 'arm64') return 'win-arm64';
	if (plat === 'darwin' && arch === 'x64') return 'osx-x64';
	if (plat === 'darwin' && arch === 'arm64') return 'osx-arm64';
	if (plat === 'linux' && arch === 'x64') return 'linux-x64';
	if (plat === 'linux' && arch === 'arm64') return 'linux-arm64';
	return null;
}

export function getArchiveExtension(platform: StsPlatform): string {
	return platform.startsWith('win') ? 'zip' : 'tar.gz';
}

export function getDownloadUrl(version: string, platform: StsPlatform): string {
	const ext = getArchiveExtension(platform);
	return `https://github.com/microsoft/sqltoolsservice/releases/download/${version}/Microsoft.SqlTools.ServiceLayer-${platform}-net10.0.${ext}`;
}

export function getBinaryName(platform: StsPlatform): string {
	return platform.startsWith('win') ? 'MicrosoftSqlToolsServiceLayer.exe' : 'MicrosoftSqlToolsServiceLayer';
}

export function getCacheDir(globalStoragePath: string, version: string, platform: StsPlatform): string {
	return path.join(globalStoragePath, 'sqltoolsservice', version, platform);
}

export function getBinaryPath(globalStoragePath: string, version: string, platform: StsPlatform): string {
	return path.join(getCacheDir(globalStoragePath, version, platform), getBinaryName(platform));
}

export function getExpectedArchiveSha256(platform: StsPlatform): string {
	return STS_ARCHIVE_SHA256[platform];
}

export async function invalidateStsCache(globalStoragePath: string, output?: WorkbenchLogger): Promise<void> {
	const platform = detectPlatform();
	if (!platform) return;
	const cacheDir = getCacheDir(globalStoragePath, STS_VERSION, platform);
	const installRoot = path.dirname(cacheDir);
	let releaseLock: (() => Promise<void>) | undefined;
	let quarantineDir: string | undefined;
	try {
		releaseLock = await acquireInstallLock(installRoot, platform);
		if (!fs.existsSync(cacheDir)) return;
		quarantineDir = path.join(installRoot, `.invalid-${platform}-${process.pid}-${Date.now()}`);
		await fs.promises.rename(cacheDir, quarantineDir);
	} catch (error) {
		output?.warn(`[sts] Failed to quarantine unusable runtime cache: ${error instanceof Error ? error.message : String(error)}`);
	} finally {
		try { await releaseLock?.(); } catch { /* stale lock recovery handles this */ }
	}
	if (quarantineDir) {
		try { await fs.promises.rm(quarantineDir, { recursive: true, force: true }); } catch (error) {
			output?.warn(`[sts] Failed to remove quarantined runtime cache: ${error instanceof Error ? error.message : String(error)}`);
		}
	}
}

async function acquireInstallLock(
	installRoot: string,
	platform: StsPlatform,
	token?: vscode.CancellationToken,
): Promise<() => Promise<void>> {
	await fs.promises.mkdir(installRoot, { recursive: true });
	const lockTarget = path.join(installRoot, `${platform}.install`);
	const deadline = Date.now() + INSTALL_LOCK_WAIT_MS;
	while (true) {
		if (token?.isCancellationRequested) throw new Error('Cancelled');
		try {
			return await lockfile.lock(lockTarget, {
				realpath: false,
				stale: INSTALL_LOCK_STALE_MS,
				update: INSTALL_LOCK_UPDATE_MS,
				retries: 0,
			});
		} catch (error) {
			if (Date.now() >= deadline) throw error;
			await waitForInstallLockRetry(token);
		}
	}
}

function waitForInstallLockRetry(token?: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		let subscription: vscode.Disposable | undefined;
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			subscription?.dispose();
			error ? reject(error) : resolve();
		};
		timer = setTimeout(() => finish(), INSTALL_LOCK_RETRY_MS);
		subscription = token?.onCancellationRequested(() => finish(new Error('Cancelled')));
	});
}

interface StsCacheManifest {
	version: string;
	platform: StsPlatform;
	archiveSha256: string;
	binarySha256: string;
}

export async function sha256File(filePath: string, token?: vscode.CancellationToken): Promise<string> {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash('sha256');
		const stream = fs.createReadStream(filePath);
		let settled = false;
		const cancellation = token?.onCancellationRequested(() => {
			if (settled) return;
			settled = true;
			stream.destroy();
			reject(new Error('Cancelled'));
		});
		stream.on('error', error => {
			if (settled) return;
			settled = true;
			cancellation?.dispose();
			reject(error);
		});
		stream.on('data', chunk => {
			if (token?.isCancellationRequested) return;
			hash.update(chunk);
		});
		stream.on('end', () => {
			if (settled) return;
			settled = true;
			cancellation?.dispose();
			if (token?.isCancellationRequested) reject(new Error('Cancelled'));
			else resolve(hash.digest('hex'));
		});
	});
}

async function isCompleteCache(cacheDir: string, version: string, platform: StsPlatform): Promise<boolean> {
	try {
		const manifestPath = path.join(cacheDir, CACHE_MANIFEST);
		const binaryPath = path.join(cacheDir, getBinaryName(platform));
		const manifest = JSON.parse(await fs.promises.readFile(manifestPath, 'utf8')) as Partial<StsCacheManifest>;
		if (manifest.version !== version
			|| manifest.platform !== platform
			|| manifest.archiveSha256 !== getExpectedArchiveSha256(platform)
			|| typeof manifest.binarySha256 !== 'string'
			|| !manifest.binarySha256) {
			return false;
		}
		return (await sha256File(binaryPath)) === manifest.binarySha256;
	} catch {
		return false;
	}
}

export async function ensureSts(
	globalStoragePath: string,
	output: WorkbenchLogger,
): Promise<string | null> {
	const platform = detectPlatform();
	if (!platform) {
		output.warn(`[sts] Unsupported platform: ${process.platform}/${process.arch}`);
		return null;
	}

	const cacheDir = getCacheDir(globalStoragePath, STS_VERSION, platform);
	const binaryPath = path.join(cacheDir, getBinaryName(platform));
	if (await isCompleteCache(cacheDir, STS_VERSION, platform)) {
		output.info(`[sts] Verified cached runtime at ${binaryPath}`);
		return binaryPath;
	}

	const result = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'SQL IntelliSense: Downloading language server...',
			cancellable: true,
		},
		async (progress, token) => {
			const installRoot = path.dirname(cacheDir);
			let releaseLock: (() => Promise<void>) | undefined;
			const archivePath = path.join(installRoot, `sts-${STS_VERSION}-${platform}.${getArchiveExtension(platform)}.partial`);
			const stagingDir = path.join(installRoot, `.stage-${platform}`);
			try {
				progress.report({ message: 'Waiting for SQL runtime installer...' });
				releaseLock = await acquireInstallLock(installRoot, platform, token);

				if (token.isCancellationRequested) return null;
				if (await isCompleteCache(cacheDir, STS_VERSION, platform)) {
					output.info(`[sts] Runtime installed by another window at ${binaryPath}`);
					return binaryPath;
				}

				await fs.promises.rm(cacheDir, { recursive: true, force: true });
				await fs.promises.rm(stagingDir, { recursive: true, force: true });
				await fs.promises.rm(archivePath, { force: true });
				await fs.promises.mkdir(stagingDir, { recursive: true });

				const url = getDownloadUrl(STS_VERSION, platform);
				output.info(`[sts] Downloading verified STS ${STS_VERSION} for ${platform}`);

				await downloadFile(url, archivePath, progress, token);
				if (token.isCancellationRequested) {
					return null;
				}
				const archiveSha256 = await sha256File(archivePath, token);
				if (token.isCancellationRequested) return null;
				if (archiveSha256 !== getExpectedArchiveSha256(platform)) {
					throw new Error('Downloaded SQL Tools Service archive failed integrity validation.');
				}

				progress.report({ message: 'Extracting...' });
				if (getArchiveExtension(platform) === 'zip') {
					await extractZip(archivePath, stagingDir, token);
				} else {
					await extractTarGz(archivePath, stagingDir, token);
				}
				if (token.isCancellationRequested) return null;

				const stagedBinaryPath = path.join(stagingDir, getBinaryName(platform));
				if (!fs.existsSync(stagedBinaryPath)) {
					throw new Error('SQL Tools Service binary was not found after extraction.');
				}
				if (!platform.startsWith('win')) {
					await fs.promises.chmod(stagedBinaryPath, 0o755);
				}

				const manifest: StsCacheManifest = {
					version: STS_VERSION,
					platform,
					archiveSha256,
					binarySha256: await sha256File(stagedBinaryPath, token),
				};
				if (token.isCancellationRequested) return null;
				await fs.promises.writeFile(path.join(stagingDir, CACHE_MANIFEST), JSON.stringify(manifest, null, 2), 'utf8');
				if (token.isCancellationRequested) return null;
				await fs.promises.rename(stagingDir, cacheDir);

				output.info(`[sts] Installed verified runtime at ${binaryPath}`);
				return binaryPath;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				output.error(`[sts] Runtime installation failed: ${msg}`);
				return null;
			} finally {
				await safeUnlink(archivePath);
				try { await fs.promises.rm(stagingDir, { recursive: true, force: true }); } catch { /* ignore */ }
				try { await releaseLock?.(); } catch { /* stale lock recovery handles this */ }
			}
		},
	);

	return result;
}

async function safeUnlink(filePath: string): Promise<void> {
	try { await fs.promises.unlink(filePath); } catch { /* ignore */ }
}

function downloadFile(
	url: string,
	destPath: string,
	progress: vscode.Progress<{ message?: string; increment?: number }>,
	token: vscode.CancellationToken,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const doRequest = (reqUrl: string, redirectCount: number) => {
			if (redirectCount > 5) {
				reject(new Error('Too many redirects'));
				return;
			}

			const req = https.get(reqUrl, (res) => {
				// Follow redirects (GitHub → CDN)
				if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
					res.resume(); // Drain response
					doRequest(res.headers.location, redirectCount + 1);
					return;
				}

				if (res.statusCode !== 200) {
					res.resume();
					reject(new Error(`HTTP ${res.statusCode}`));
					return;
				}

				const totalBytes = parseInt(res.headers['content-length'] || '0', 10);
				let downloadedBytes = 0;
				let lastReportedPct = 0;

				const fileStream = fs.createWriteStream(destPath);

				res.on('data', (chunk: Buffer) => {
					if (token.isCancellationRequested) {
						res.destroy();
						fileStream.close();
						return;
					}
					downloadedBytes += chunk.length;
					if (totalBytes > 0) {
						const pct = Math.floor((downloadedBytes / totalBytes) * 100);
						if (pct > lastReportedPct) {
							progress.report({
								message: `Downloading... ${pct}%`,
								increment: pct - lastReportedPct,
							});
							lastReportedPct = pct;
						}
					}
				});

				res.pipe(fileStream);

				fileStream.on('finish', () => {
					fileStream.close(closeError => {
						if (closeError) {
							reject(closeError);
						} else if (token.isCancellationRequested) {
							reject(new Error('Cancelled'));
						} else {
							resolve();
						}
					});
				});

				fileStream.on('error', (err) => {
					fileStream.close();
					reject(err);
				});
			});

			req.on('error', reject);

			token.onCancellationRequested(() => {
				req.destroy();
				reject(new Error('Cancelled'));
			});
		};

		doRequest(url, 0);
	});
}

function extractZip(zipPath: string, destDir: string, token: vscode.CancellationToken): Promise<void> {
	// Windows ships bsdtar, which extracts the pinned STS ZIP in seconds and
	// rejects unsafe traversal paths. The archive hash is verified first.
	return extractWithTar(zipPath, destDir, token);
}

function extractTarGz(tarGzPath: string, destDir: string, token: vscode.CancellationToken): Promise<void> {
	return extractWithTar(tarGzPath, destDir, token);
}

export function extractWithTar(archivePath: string, destDir: string, token: vscode.CancellationToken): Promise<void> {
	return new Promise((resolve, reject) => {
		const workingDirectory = path.dirname(destDir);
		const archiveArgument = path.dirname(archivePath) === workingDirectory ? path.basename(archivePath) : archivePath;
		const destinationArgument = path.basename(destDir);
		const child = spawn('tar', ['-xf', archiveArgument, '-C', destinationArgument], {
			cwd: workingDirectory,
			stdio: ['ignore', 'ignore', 'pipe'],
		});
		let stderr = '';
		let cancelled = false;
		const cancellation = token.onCancellationRequested(() => {
			cancelled = true;
			try { child.kill('SIGKILL'); } catch { /* ignore */ }
		});
		child.stderr?.on('data', chunk => {
			stderr = (stderr + String(chunk)).slice(-2000);
		});
		child.on('error', error => {
			cancellation.dispose();
			reject(error);
		});
		child.on('close', (code) => {
			cancellation.dispose();
			if (cancelled || token.isCancellationRequested) reject(new Error('Cancelled'));
			else if (code === 0) resolve();
			else reject(new Error(`tar exited with code ${code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
		});
	});
}
