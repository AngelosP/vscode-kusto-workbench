import * as vscode from 'vscode';
import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import extractZip from 'extract-zip';
import * as lockfile from 'proper-lockfile';
import { createExternalMcpCatalog, type CanonicalWorkbenchToolContribution } from '../shared/externalMcpCatalog';
import { ensureCurrentUserOnlyDirectory } from './externalMcpDiscovery';
import {
	acquireExternalMcpRuntimeArchive,
	parseExternalMcpRuntimeMetadata,
	type ExternalMcpRuntimeMetadata,
} from './externalMcpRuntime';
import { releaseLockPreservingError } from './lockRelease';

const INSTALL_LOCK_STALE_MS = 10 * 60_000;
const INSTALL_LOCK_WAIT_MS = 6 * 60_000;

export const EXTERNAL_MCP_BOOTSTRAP = `'use strict';
const fs = require('node:fs');
const path = require('node:path');
try {
	delete process.env.NODE_OPTIONS;
	delete process.env.NODE_PATH;
	const root = __dirname;
	const current = JSON.parse(fs.readFileSync(path.join(root, 'current.json'), 'utf8'));
	process.argv = [process.execPath, current.connectorPath, '--config', current.configPath];
	require(current.connectorPath);
} catch (error) {
	process.stderr.write('Kusto Workbench connector failed: ' + (error && error.message ? error.message : String(error)) + '\\n');
	process.exitCode = 1;
}
`;

export interface InstalledExternalMcpConnector {
	readonly root: string;
	readonly versionDirectory: string;
	readonly bootstrapPath: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly connectorVersion: string;
	readonly schemaHash: string;
	readonly launchTargetChanged?: boolean;
}

export interface InstallExternalMcpConnectorOptions {
	readonly context: vscode.ExtensionContext;
	readonly localAppData: string;
	readonly systemRoot: string;
	readonly codeExecutable: string;
	readonly profileName?: string;
	readonly codeArguments?: readonly string[];
	readonly acquireRuntimeArchive?: (
		metadata: ExternalMcpRuntimeMetadata,
		cacheDirectory: string,
	) => Promise<string>;
	/** The caller already holds acquireExternalMcpConnectorLock for this localAppData root. */
	readonly sharedLockAlreadyHeld?: boolean;
}

export async function acquireExternalMcpConnectorLock(
	localAppData: string,
	systemRoot = process.env.SystemRoot,
): Promise<() => Promise<void>> {
	const productRoot = join(localAppData, 'KustoWorkbench');
	await mkdir(productRoot, { recursive: true });
	if (process.platform === 'win32') await ensureCurrentUserOnlyDirectory(productRoot, systemRoot);
	return lockfile.lock(join(productRoot, '.mcp-connector-install'), {
		realpath: false,
		stale: INSTALL_LOCK_STALE_MS,
		update: 15_000,
		retries: {
			retries: Math.ceil(INSTALL_LOCK_WAIT_MS / 500),
			factor: 1,
			minTimeout: 500,
			maxTimeout: 500,
			randomize: false,
		},
	});
}

async function sha256(path: string): Promise<string> {
	return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function atomicWrite(path: string, content: string): Promise<void> {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function atomicCopy(source: string, destination: string): Promise<void> {
	const temporary = `${destination}.${randomUUID()}.tmp`;
	try {
		await copyFile(source, temporary);
		await rename(temporary, destination);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function findFile(root: string, fileName: string): Promise<string | undefined> {
	for (const entry of await readdir(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isFile() && entry.name.toLowerCase() === fileName.toLowerCase()) return path;
		if (entry.isDirectory()) {
			const nested = await findFile(path, fileName);
			if (nested) return nested;
		}
	}
	return undefined;
}

function safeVersion(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

async function validateInstalledVersion(
	versionDirectory: string,
	expected: {
		connectorSource: string;
		manifestSource: string;
		guidanceSource: string;
		configContent: string;
	},
): Promise<boolean> {
	try {
		const installed = {
			connector: join(versionDirectory, 'connector.cjs'),
			config: join(versionDirectory, 'connector-config.json'),
			manifest: join(versionDirectory, 'tool-manifest.json'),
			guidance: join(versionDirectory, 'guidance.md'),
		};
		const stats = await Promise.all(Object.values(installed).map(path => stat(path)));
		if (stats.some(value => !value.isFile())) return false;
		const [connectorHash, expectedConnectorHash, manifestHash, expectedManifestHash, guidanceHash, expectedGuidanceHash] = await Promise.all([
			sha256(installed.connector),
			sha256(expected.connectorSource),
			sha256(installed.manifest),
			sha256(expected.manifestSource),
			sha256(installed.guidance),
			sha256(expected.guidanceSource),
		]);
		return connectorHash === expectedConnectorHash
			&& manifestHash === expectedManifestHash
			&& guidanceHash === expectedGuidanceHash
			&& await readFile(installed.config, 'utf8') === expected.configContent;
	} catch {
		return false;
	}
}

export async function installExternalMcpConnector(
	options: InstallExternalMcpConnectorOptions,
): Promise<InstalledExternalMcpConnector> {
	if (process.platform !== 'win32' || process.arch !== 'x64') {
		throw new Error('The packaged Kusto Workbench connector currently supports Windows x64 only.');
	}
	const root = join(options.localAppData, 'KustoWorkbench', 'McpConnector');
	const release = options.sharedLockAlreadyHeld
		? undefined
		: await acquireExternalMcpConnectorLock(options.localAppData, options.systemRoot);
	let operationError: unknown;
	try {
		await ensureCurrentUserOnlyDirectory(root, options.systemRoot);
		const extensionVersion = String(options.context.extension.packageJSON.version || '0.0.0');
		const contributions = (options.context.extension.packageJSON.contributes?.languageModelTools || []) as CanonicalWorkbenchToolContribution[];
		const catalog = createExternalMcpCatalog(contributions);
		if (options.profileName && options.codeArguments) {
			throw new Error('Specify either a VS Code profile or explicit launch arguments, not both.');
		}
		const codeArguments = options.codeArguments
			? [...options.codeArguments]
			: options.profileName ? ['--profile', options.profileName] : [];
		const launchTargetHash = createHash('sha256').update(JSON.stringify({
			codeExecutable: options.codeExecutable,
			codeArguments,
		})).digest('hex').slice(0, 12);
		const versionKey = `${safeVersion(extensionVersion)}-${catalog.schemaHash.slice(0, 12)}-${launchTargetHash}`;
		const versionsDirectory = join(root, 'versions');
		const versionDirectory = join(versionsDirectory, versionKey);
		let previousConfigPath: string | undefined;
		try {
			const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as { configPath?: unknown };
			previousConfigPath = typeof current.configPath === 'string' ? current.configPath : undefined;
		} catch {
			previousConfigPath = undefined;
		}
		const extensionPath = options.context.extensionUri.fsPath;
		const connectorSource = join(extensionPath, 'dist', 'mcp-connector', 'connector.cjs');
		const manifestSource = join(extensionPath, 'package.json');
		const guidanceSource = join(extensionPath, 'copilot-instructions', 'external-mcp-client.md');
		const runtimeMetadataPath = join(extensionPath, 'dist', 'mcp-connector', 'runtime', 'runtime.json');
		const runtimeMetadata = parseExternalMcpRuntimeMetadata(JSON.parse(await readFile(runtimeMetadataPath, 'utf8')));
		const connectorConfigContent = `${JSON.stringify({
			schemaVersion: 1,
			connectorVersion: extensionVersion,
			toolManifestPath: join(versionDirectory, 'tool-manifest.json'),
			guidancePath: join(versionDirectory, 'guidance.md'),
			discoveryDirectory: join(root, 'discovery'),
			launchDirectory: join(root, 'launches'),
			codeExecutable: options.codeExecutable,
			...(codeArguments.length > 0 ? { codeArguments } : {}),
		}, null, 2)}\n`;
		await mkdir(versionsDirectory, { recursive: true });
		const installedVersionValid = await validateInstalledVersion(versionDirectory, {
			connectorSource,
			manifestSource,
			guidanceSource,
			configContent: connectorConfigContent,
		});
		const installedRuntimeValid = await validateInstalledRuntime(root, runtimeMetadata);
		if (!installedVersionValid || !installedRuntimeValid) {
			const stagingDirectory = join(root, `.stage-${randomUUID()}`);
			const extractedDirectory = join(stagingDirectory, 'runtime');
			try {
				if (!installedRuntimeValid) {
					const runtimeArchive = await (options.acquireRuntimeArchive ?? acquireExternalMcpRuntimeArchive)(
						runtimeMetadata,
						join(root, 'runtime-cache'),
					);
					await mkdir(extractedDirectory, { recursive: true });
					await extractZip(runtimeArchive, { dir: extractedDirectory });
					const nodeSource = await findFile(extractedDirectory, 'node.exe');
					const licenseSource = await findFile(extractedDirectory, 'LICENSE');
					if (!nodeSource || !licenseSource) throw new Error('The connector runtime archive is incomplete.');
					const stableNodePath = join(root, 'node.exe');
					await atomicCopy(nodeSource, stableNodePath);
					await atomicCopy(licenseSource, join(root, 'NODE-LICENSE.txt'));
					await atomicWrite(join(root, 'runtime-installed.json'), `${JSON.stringify({
						schemaVersion: 1,
						version: runtimeMetadata.version,
						target: runtimeMetadata.target,
						nodeSha256: await sha256(stableNodePath),
					}, null, 2)}\n`);
				}
				if (!installedVersionValid) {
					await mkdir(stagingDirectory, { recursive: true });
					await copyFile(connectorSource, join(stagingDirectory, 'connector.cjs'));
					await copyFile(manifestSource, join(stagingDirectory, 'tool-manifest.json'));
					await copyFile(guidanceSource, join(stagingDirectory, 'guidance.md'));
					await writeFile(
						join(stagingDirectory, 'connector-config.json'),
						connectorConfigContent,
						'utf8',
					);
					await rm(extractedDirectory, { recursive: true, force: true });
					const previousVersionDirectory = `${versionDirectory}.previous-${randomUUID()}`;
					let previousVersionMoved = false;
					try {
						await rename(versionDirectory, previousVersionDirectory);
						previousVersionMoved = true;
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
					}
					try {
						await rename(stagingDirectory, versionDirectory);
					} catch (error) {
						if (previousVersionMoved) await rename(previousVersionDirectory, versionDirectory);
						throw error;
					}
					if (previousVersionMoved) {
						await rm(previousVersionDirectory, { recursive: true, force: true }).catch(() => undefined);
					}
				}
			} catch (error) {
				throw error;
			} finally {
				await rm(stagingDirectory, { recursive: true, force: true });
			}
		}
		const bootstrapPath = join(root, 'bootstrap.cjs');
		await atomicWrite(bootstrapPath, EXTERNAL_MCP_BOOTSTRAP);
		await atomicWrite(join(root, 'current.json'), `${JSON.stringify({
			schemaVersion: 1,
			connectorVersion: extensionVersion,
			nodeRuntimeVersion: runtimeMetadata.version,
			connectorPath: join(versionDirectory, 'connector.cjs'),
			configPath: join(versionDirectory, 'connector-config.json'),
			schemaHash: catalog.schemaHash,
		}, null, 2)}\n`);
		await ensureCurrentUserOnlyDirectory(join(root, 'discovery'), options.systemRoot);
		await ensureCurrentUserOnlyDirectory(join(root, 'launches'), options.systemRoot);
		return {
			root,
			versionDirectory,
			bootstrapPath,
			command: join(root, 'node.exe'),
			args: [bootstrapPath],
			connectorVersion: extensionVersion,
			schemaHash: catalog.schemaHash,
			launchTargetChanged: previousConfigPath !== join(versionDirectory, 'connector-config.json'),
		};
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		if (release) {
			await releaseLockPreservingError(
				release,
				operationError,
				'External MCP connector installation failed while releasing its shared lock.',
			);
		}
	}
}

async function validateInstalledRuntime(
	root: string,
	runtimeMetadata: { version: string; target: string },
): Promise<boolean> {
	try {
		const installed = JSON.parse(await readFile(join(root, 'runtime-installed.json'), 'utf8')) as {
			version?: unknown;
			target?: unknown;
			nodeSha256?: unknown;
		};
		if (installed.version !== runtimeMetadata.version
			|| installed.target !== runtimeMetadata.target
			|| typeof installed.nodeSha256 !== 'string') return false;
		await stat(join(root, 'NODE-LICENSE.txt'));
		return await sha256(join(root, 'node.exe')) === installed.nodeSha256;
	} catch {
		return false;
	}
}