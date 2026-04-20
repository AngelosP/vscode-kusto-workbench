import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as https from 'https';
import * as yauzl from 'yauzl';
import { spawn } from 'child_process';

export const STS_VERSION = '6.0.20260409.1';

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

export async function ensureSts(
	globalStoragePath: string,
	output: vscode.OutputChannel,
): Promise<string | null> {
	const platform = detectPlatform();
	if (!platform) {
		output.appendLine(`[sts] Unsupported platform: ${process.platform}/${process.arch}`);
		return null;
	}

	const binaryPath = getBinaryPath(globalStoragePath, STS_VERSION, platform);

	// Check cache
	if (fs.existsSync(binaryPath)) {
		output.appendLine(`[sts] Binary cached at ${binaryPath}`);
		return binaryPath;
	}

	// Download with progress
	const url = getDownloadUrl(STS_VERSION, platform);
	output.appendLine(`[sts] Downloading STS ${STS_VERSION} for ${platform} from ${url}`);

	const result = await vscode.window.withProgress(
		{
			location: vscode.ProgressLocation.Notification,
			title: 'SQL IntelliSense: Downloading language server...',
			cancellable: true,
		},
		async (progress, token) => {
			try {
				const archivePath = path.join(globalStoragePath, `sts-${STS_VERSION}-${platform}.${getArchiveExtension(platform)}`);
				const cacheDir = getCacheDir(globalStoragePath, STS_VERSION, platform);

				// Ensure directories exist
				await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
				await fs.promises.mkdir(cacheDir, { recursive: true });

				// Download
				await downloadFile(url, archivePath, progress, token);
				if (token.isCancellationRequested) {
					await safeUnlink(archivePath);
					return null;
				}

				// Extract
				progress.report({ message: 'Extracting...' });
				if (getArchiveExtension(platform) === 'zip') {
					await extractZip(archivePath, cacheDir);
				} else {
					await extractTarGz(archivePath, cacheDir);
				}

				// Ensure executable on Unix
				if (!platform.startsWith('win')) {
					const extracted = getBinaryPath(globalStoragePath, STS_VERSION, platform);
					try { await fs.promises.chmod(extracted, 0o755); } catch { /* ignore */ }
				}

				// Clean up archive
				await safeUnlink(archivePath);

				output.appendLine(`[sts] Extracted to ${cacheDir}`);

				if (!fs.existsSync(binaryPath)) {
					output.appendLine(`[sts] ERROR: Binary not found after extraction at ${binaryPath}`);
					return null;
				}

				return binaryPath;
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				output.appendLine(`[sts] Download/extract failed: ${msg}`);
				return null;
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
					fileStream.close();
					if (token.isCancellationRequested) {
						reject(new Error('Cancelled'));
					} else {
						resolve();
					}
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

function extractZip(zipPath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
			if (err || !zipfile) { reject(err || new Error('Failed to open zip')); return; }

			zipfile.readEntry();
			zipfile.on('entry', (entry: yauzl.Entry) => {
				const entryPath = path.join(destDir, entry.fileName);

				// Security: prevent path traversal
				if (!entryPath.startsWith(destDir + path.sep) && entryPath !== destDir) {
					zipfile.readEntry();
					return;
				}

				if (/\/$/.test(entry.fileName)) {
					// Directory
					fs.mkdirSync(entryPath, { recursive: true });
					zipfile.readEntry();
				} else {
					// File
					fs.mkdirSync(path.dirname(entryPath), { recursive: true });
					zipfile.openReadStream(entry, (err2, readStream) => {
						if (err2 || !readStream) { reject(err2 || new Error('Failed to read entry')); return; }
						const writeStream = fs.createWriteStream(entryPath);
						readStream.pipe(writeStream);
						writeStream.on('finish', () => {
							writeStream.close();
							zipfile.readEntry();
						});
						writeStream.on('error', reject);
					});
				}
			});
			zipfile.on('end', resolve);
			zipfile.on('error', reject);
		});
	});
}

function extractTarGz(tarGzPath: string, destDir: string): Promise<void> {
	return new Promise((resolve, reject) => {
		// Use system tar — available on macOS and Linux.
		const child = spawn('tar', ['xzf', tarGzPath, '-C', destDir], { stdio: 'ignore' });
		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) resolve();
			else reject(new Error(`tar exited with code ${code}`));
		});
	});
}
