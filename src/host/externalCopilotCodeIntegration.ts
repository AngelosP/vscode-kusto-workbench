import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { parse, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import * as lockfile from 'proper-lockfile';
import type { ExecuteClientCommand } from './externalMcpClientProvisioning';
import type { InstalledExternalMcpConnector } from './externalMcpConnectorInstaller';
import { releaseLockPreservingError } from './lockRelease';

export const COPILOT_CODE_PLUGIN_NAME = 'kusto-workbench';

export interface CopilotCodePluginFile {
	readonly relativePath: string;
	readonly content: string;
}

export function createCopilotCodePluginFiles(
	connector: Pick<InstalledExternalMcpConnector, 'command' | 'args' | 'connectorVersion'>,
	skillSourceContent: string,
): readonly CopilotCodePluginFile[] {
	return [
		{ relativePath: 'plugin.json', content: `${JSON.stringify({
			$schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
			name: COPILOT_CODE_PLUGIN_NAME,
			version: connector.connectorVersion,
			description: 'Build Kusto Workbench reports in VS Code from Copilot Code.',
			license: 'MIT',
		}, null, 2)}\n` },
		{ relativePath: 'mcp.json', content: `${JSON.stringify({
			$schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
			mcpServers: { 'kusto-workbench': { type: 'stdio', command: connector.command, args: [...connector.args] } },
		}, null, 2)}\n` },
		{ relativePath: 'skills/kusto-workbench/SKILL.md', content: `${skillSourceContent.trimEnd()}\n` },
	];
}

export interface CopilotCodeTarget {
	readonly accountId: string;
	readonly executable: string;
	readonly copilotHomeDirectory: string;
}

async function isPlainPath(path: string, kind: 'directory' | 'file'): Promise<boolean> {
	try {
		const stat = await lstat(path);
		return !stat.isSymbolicLink() && (kind === 'directory' ? stat.isDirectory() : stat.isFile());
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
		throw error;
	}
}

function compareRuntimeVersions(left: string, right: string): number {
	const leftParts = left.split('.').map(Number);
	const rightParts = right.split('.').map(Number);
	for (let index = 0; index < 4; index++) {
		const difference = rightParts[index] - leftParts[index];
		if (difference !== 0) return difference;
	}
	return 0;
}

export async function discoverCopilotCodeTargets(
	localAppData = process.env.LOCALAPPDATA,
): Promise<readonly CopilotCodeTarget[]> {
	if (!localAppData) throw new Error('The local application data directory is unavailable.');
	const userData = join(localAppData, 'Microsoft', 'Copilot', 'User Data');
	const runtimeRoot = join(userData, 'CopilotCodeTabRuntime');
	const accountsRoot = join(userData, 'CopilotCodingHome');
	if (!await isPlainPath(userData, 'directory') || !await isPlainPath(runtimeRoot, 'directory')) {
		throw new Error('Please open Copilot, select Code, and complete its first-time setup before configuring Kusto Workbench.');
	}
	const versions = (await readdir(runtimeRoot, { withFileTypes: true }))
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^\d{1,8}\.\d{1,8}\.\d{1,8}\.\d{1,8}$/.test(entry.name))
		.map(entry => entry.name)
		.sort(compareRuntimeVersions);
	let version: string | undefined;
	for (const candidate of versions) {
		const candidateRoot = join(runtimeRoot, candidate);
		if (await isPlainPath(join(candidateRoot, 'copilot.exe'), 'file') && await isPlainPath(join(candidateRoot, 'github_copilot.dll'), 'file')
			&& await isPlainPath(join(candidateRoot, 'manifest.json'), 'file')) { version = candidate; break; }
	}
	if (!version) throw new Error('The Copilot Code runtime is unavailable. Open Copilot and select Code to initialize it.');
	const runtime = join(runtimeRoot, version);
	const executable = join(runtime, 'copilot.exe');
	const manifestPath = join(runtime, 'manifest.json');
	if (!await isPlainPath(executable, 'file') || !await isPlainPath(join(runtime, 'github_copilot.dll'), 'file')
		|| !await isPlainPath(manifestPath, 'file')) {
		throw new Error('The installed Copilot Code runtime is incomplete. Repair Copilot before configuring integration.');
	}
	let manifest: Record<string, unknown>;
	try { manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, '')) as Record<string, unknown>; } catch {
		throw new Error('The Copilot Code runtime manifest is invalid. No configuration was changed.');
	}
	if (!manifest || manifest.manifest_version !== 2 || manifest.name !== 'Copilot Code Tab Runtime'
		|| manifest.api_version !== 4 || manifest.version !== version) {
		throw new Error('This Copilot Code runtime format is not supported. No configuration was changed.');
	}
	if (!await isPlainPath(accountsRoot, 'directory')) {
		throw new Error('No Copilot Code account is initialized. Open Copilot and select Code first.');
	}
	const targets = (await readdir(accountsRoot, { withFileTypes: true }))
		.filter(entry => entry.isDirectory() && !entry.isSymbolicLink() && /^[a-f0-9]{32}$/i.test(entry.name))
		.sort((left, right) => left.name.localeCompare(right.name))
		.map(entry => ({ accountId: entry.name, executable, copilotHomeDirectory: join(accountsRoot, entry.name) }));
	if (targets.length === 0) throw new Error('No Copilot Code account is initialized. Open Copilot and select Code first.');
	return targets;
}

interface InstalledCodePlugin {
	readonly name: string;
	readonly enabled: boolean;
	readonly cache_path: string;
	readonly source: { readonly source: string; readonly path: string };
}

interface PluginReceipt {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly copilotHomeDirectory: string;
	readonly sourcePath: string;
	readonly cachePath: string;
	readonly files: readonly { relativePath: string; sha256: string }[];
}

interface CodePluginOptions {
	readonly target: CopilotCodeTarget;
	readonly localAppData?: string;
	readonly execute?: ExecuteClientCommand;
}

export interface CopilotCodeIntegrationResult {
	readonly changed: boolean;
	readonly managed: boolean;
	readonly requiresClientReload: boolean;
}

function object(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hash(content: string): string {
	return createHash('sha256').update(content, 'utf8').digest('hex');
}

function inside(root: string, target: string): boolean {
	const difference = relative(root, target);
	return difference !== '' && !difference.startsWith('..') && !isAbsolute(difference);
}

function managedRoot(options: CodePluginOptions): string {
	const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
	if (!localAppData || !/^[a-f0-9]{32}$/i.test(options.target.accountId)) throw new Error('The Copilot Code installation target is invalid.');
	return join(localAppData, 'KustoWorkbench', 'CopilotCode', options.target.accountId);
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		const stat = await lstat(path);
		if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error('Copilot Code metadata must be a regular file under 2 MB.');
		return await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

function parseConfiguration(text: string): Record<string, unknown> {
	const errors: ParseError[] = [];
	const value: unknown = parse(text, errors, { allowTrailingComma: true });
	if (errors.length || !object(value)) throw new Error('Copilot Code configuration is invalid. No existing plugins were changed.');
	return value;
}

async function installedPlugin(target: CopilotCodeTarget): Promise<InstalledCodePlugin | undefined> {
	const text = await readOptional(join(target.copilotHomeDirectory, 'config.json'));
	if (text === undefined) return undefined;
	const configuration = parseConfiguration(text);
	const plugins = configuration.installedPlugins ?? [];
	if (!Array.isArray(plugins)) throw new Error('Copilot Code plugin metadata uses an unsupported format.');
	const matches = plugins.filter(entry => object(entry) && entry.name === COPILOT_CODE_PLUGIN_NAME);
	if (matches.length > 1) throw new Error('Multiple Kusto Workbench plugins are installed in Copilot Code. Resolve them in Code > Customize first.');
	const plugin: unknown = matches[0];
	if (plugin === undefined) return undefined;
	if (!object(plugin) || plugin.enabled !== true || typeof plugin.cache_path !== 'string'
		|| !inside(join(target.copilotHomeDirectory, 'installed-plugins'), resolve(plugin.cache_path))
		|| !object(plugin.source) || plugin.source.source !== 'local' || typeof plugin.source.path !== 'string') {
		throw new Error('An existing Kusto Workbench plugin has different settings or is disabled. It was left unchanged.');
	}
	return plugin as unknown as InstalledCodePlugin;
}

function fingerprints(files: readonly CopilotCodePluginFile[]): PluginReceipt['files'] {
	return files.map(file => ({ relativePath: file.relativePath, sha256: hash(file.content) }));
}

async function matchingFiles(root: string, expected: PluginReceipt['files']): Promise<boolean> {
	if (!await isPlainPath(root, 'directory')) return false;
	const actual: string[] = [];
	const visit = async (directory: string): Promise<boolean> => {
		for (const entry of await readdir(directory, { withFileTypes: true })) {
			if (entry.isSymbolicLink() || actual.length > expected.length) return false;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) {
				const prefix = `${relative(root, path).replace(/\\/g, '/')}/`;
				if (!expected.some(file => file.relativePath.startsWith(prefix)) || !await visit(path)) return false;
			}
			else if (entry.isFile()) actual.push(relative(root, path).replace(/\\/g, '/'));
			else return false;
		}
		return true;
	};
	if (!await visit(root) || actual.length !== expected.length) return false;
	for (const file of expected) {
		if (!actual.includes(file.relativePath)) return false;
		const content = await readOptional(join(root, file.relativePath));
		if (content === undefined || hash(content) !== file.sha256) return false;
	}
	return true;
}

async function receiptFor(options: CodePluginOptions): Promise<PluginReceipt | undefined> {
	const root = managedRoot(options);
	const text = await readOptional(join(root, 'receipt.json'));
	if (text === undefined) return undefined;
	const value = parseConfiguration(text);
	const expectedPaths = ['plugin.json', 'mcp.json', 'skills/kusto-workbench/SKILL.md'];
	if (value.schemaVersion !== 1 || typeof value.operationId !== 'string' || value.copilotHomeDirectory !== options.target.copilotHomeDirectory
		|| typeof value.sourcePath !== 'string' || !inside(root, resolve(value.sourcePath))
		|| typeof value.cachePath !== 'string' || !inside(join(options.target.copilotHomeDirectory, 'installed-plugins'), resolve(value.cachePath))
		|| !Array.isArray(value.files) || value.files.length !== expectedPaths.length
		|| value.files.some((file, index) => !object(file) || file.relativePath !== expectedPaths[index] || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256))) {
		throw new Error('The Copilot Code ownership record is invalid or belongs to another account.');
	}
	return value as unknown as PluginReceipt;
}

export function createCopilotCodeCommand(target: CopilotCodeTarget): ExecuteClientCommand {
	return (executable, args, signal) => new Promise((resolveResult, reject) => {
		execFile(executable, ['--no-auto-update', ...args], {
			cwd: target.copilotHomeDirectory, windowsHide: true, timeout: 30_000, maxBuffer: 1024 * 1024, signal,
			env: { ...process.env, COPILOT_HOME: target.copilotHomeDirectory, COPILOT_AUTO_UPDATE: 'false' },
		}, (error, stdout, stderr) => {
			if (error && typeof (error as { code?: unknown }).code !== 'number') { reject(new Error('The Copilot Code management command did not complete. Inspect Code > Customize before retrying.')); return; }
			resolveResult({ exitCode: error ? Number((error as unknown as { code: number }).code) : 0, stdout, stderr });
		});
	});
}

async function runCode(options: CodePluginOptions, args: readonly string[]): Promise<string> {
	const result = await (options.execute ?? createCopilotCodeCommand(options.target))(options.target.executable, args);
	if (result.exitCode !== 0) throw new Error(`Copilot Code could not complete ${args.slice(0, 2).join(' ')}. Inspect Code > Customize; no permissions were changed.`);
	return result.stdout;
}

async function componentState(options: CodePluginOptions): Promise<{ server?: Record<string, unknown>; skills: Record<string, unknown>[] }> {
	let servers: unknown;
	let skills: unknown;
	try {
		servers = JSON.parse(await runCode(options, ['mcp', 'list', '--json']));
		skills = JSON.parse(await runCode(options, ['skill', 'list', '--json']));
	} catch { throw new Error('Copilot Code could not verify its MCP servers and skills. Existing configuration was left unchanged.'); }
	if (!object(servers) || !object(servers.mcpServers) || !Array.isArray(skills) || skills.some(skill => !object(skill))) {
		throw new Error('Copilot Code returned an unsupported component listing.');
	}
	const server = servers.mcpServers['kusto-workbench'];
	if (server !== undefined && !object(server)) throw new Error('Copilot Code returned an invalid Workbench server.');
	return { server, skills: (skills as Record<string, unknown>[]).filter(skill => skill.name === 'kusto-workbench') };
}

async function verifyComponents(options: CodePluginOptions, plugin: InstalledCodePlugin, files: readonly CopilotCodePluginFile[]): Promise<void> {
	if (!await matchingFiles(plugin.cache_path, fingerprints(files))) throw new Error('The Copilot Code Workbench plugin is incomplete or user-edited. It was left unchanged.');
	const { server, skills } = await componentState(options);
	const expectedServer = JSON.parse(files.find(file => file.relativePath === 'mcp.json')!.content).mcpServers['kusto-workbench'];
	if (!server || server.enabled !== true || server.source !== 'plugin' || server.sourcePlugin !== COPILOT_CODE_PLUGIN_NAME
		|| server.command !== expectedServer.command || JSON.stringify(server.args) !== JSON.stringify(expectedServer.args)
		|| skills.length !== 1 || skills[0].enabled !== true || skills[0].source !== 'plugin'
		|| typeof skills[0].path !== 'string' || resolve(skills[0].path) !== resolve(plugin.cache_path, 'skills', 'kusto-workbench')) {
		throw new Error('Copilot Code did not expose the intended Workbench MCP server and skill. A conflicting component may take precedence.');
	}
}

async function verifyOwned(options: CodePluginOptions, receipt: PluginReceipt): Promise<InstalledCodePlugin | undefined> {
	const plugin = await installedPlugin(options.target);
	if (!plugin) return undefined;
	if (plugin.source.path !== receipt.sourcePath || plugin.cache_path !== receipt.cachePath
		|| !await matchingFiles(plugin.cache_path, receipt.files) || !await matchingFiles(receipt.sourcePath, receipt.files)) {
		throw new Error('The Copilot Code plugin changed after Workbench setup and was left untouched.');
	}
	return plugin;
}

async function saveReceipt(root: string, receipt: PluginReceipt): Promise<void> {
	const temporary = join(root, `${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o600 });
		await rename(temporary, join(root, 'receipt.json'));
	} finally { await rm(temporary, { force: true }); }
}

async function stagePlugin(root: string, files: readonly CopilotCodePluginFile[]): Promise<string> {
	const sourcePath = join(root, `kusto-workbench-${hash(JSON.stringify(files))}`);
	if (await isPlainPath(sourcePath, 'directory')) {
		if (!await matchingFiles(sourcePath, fingerprints(files))) throw new Error('The staged Copilot Code plugin was modified and was not overwritten.');
		return sourcePath;
	}
	const staging = join(root, `.stage-${randomUUID()}`);
	try {
		for (const file of files) {
			const destination = join(staging, file.relativePath);
			await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
			await writeFile(destination, file.content, { flag: 'wx', mode: 0o600 });
		}
		await rename(staging, sourcePath);
		return sourcePath;
	} finally { await rm(staging, { recursive: true, force: true }); }
}

async function withCodeLock<Result>(options: CodePluginOptions, action: (root: string) => Promise<Result>): Promise<Result> {
	const root = managedRoot(options);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(join(root, 'setup'), { realpath: false, retries: 0 });
	let operationError: unknown;
	try { return await action(root); } catch (error) { operationError = error; throw error; } finally {
		await releaseLockPreservingError(release, operationError, 'Copilot Code setup lock could not be released.');
	}
}

export async function preflightCopilotCodeIntegration(options: CodePluginOptions): Promise<void> {
	const plugin = await installedPlugin(options.target);
	const receipt = await receiptFor(options);
	if (plugin && receipt) await verifyOwned(options, receipt);
	const components = await componentState(options);
	if (!plugin && (components.server || components.skills.length)) throw new Error('Copilot Code already has a conflicting Workbench server or skill. It was left unchanged.');
}

export async function configureCopilotCodeIntegration(options: CodePluginOptions & {
	readonly connector: Pick<InstalledExternalMcpConnector, 'command' | 'args' | 'connectorVersion' | 'launchTargetChanged'>;
	readonly skillSourceContent: string;
	readonly enableProvider: () => PromiseLike<void>;
}): Promise<CopilotCodeIntegrationResult> {
	return withCodeLock(options, async root => {
		const files = createCopilotCodePluginFiles(options.connector, options.skillSourceContent);
		const previous = await receiptFor(options);
		const existing = await installedPlugin(options.target);
		await preflightCopilotCodeIntegration(options);
		if (existing && await matchingFiles(existing.cache_path, fingerprints(files))) {
			await verifyComponents(options, existing, files);
			await options.enableProvider();
			return { changed: false, managed: previous !== undefined, requiresClientReload: options.connector.launchTargetChanged === true };
		}
		if (existing && !previous) throw new Error('An existing Copilot Code Workbench plugin was not installed by this setup and was not overwritten.');
		const sourcePath = await stagePlugin(root, files);
		let installed: InstalledCodePlugin | undefined;
		try {
			if (!isDeepStrictEqual(await installedPlugin(options.target), existing)) throw new Error('Copilot Code plugin registration changed before installation.');
			await runCode(options, ['plugin', 'install', sourcePath]);
			installed = await installedPlugin(options.target);
			if (!installed || installed.source.path !== sourcePath) throw new Error('Copilot Code did not retain the generated Workbench plugin.');
			await verifyComponents(options, installed, files);
			await saveReceipt(root, { schemaVersion: 1, operationId: randomUUID(), copilotHomeDirectory: options.target.copilotHomeDirectory, sourcePath, cachePath: installed.cache_path, files: fingerprints(files) });
			await options.enableProvider();
			return { changed: true, managed: true, requiresClientReload: true };
		} catch (error) {
			try {
				const current = await installedPlugin(options.target);
				if ((!current && existing && previous) || (current?.source.path === sourcePath && await matchingFiles(current.cache_path, fingerprints(files)))) {
					if (existing && previous) {
						if (!await matchingFiles(previous.sourcePath, previous.files)) throw new Error('Previous Code plugin source changed before rollback.');
						await runCode(options, ['plugin', 'install', previous.sourcePath]);
						if (!await verifyOwned(options, previous)) throw new Error('The previous Copilot Code plugin was not restored.');
						await saveReceipt(root, previous);
					} else {
						await runCode(options, ['plugin', 'uninstall', COPILOT_CODE_PLUGIN_NAME]);
						if (await installedPlugin(options.target)) throw new Error('Copilot Code plugin removal could not be verified.');
						if (previous) await saveReceipt(root, previous);
						else await rm(join(root, 'receipt.json'), { force: true });
					}
				} else if (current && (!existing || current.source.path !== existing.source.path)) {
					throw new Error('Copilot Code plugin changed before compensation and was left untouched.');
				}
			} catch (rollbackError) {
				throw new AggregateError([error, rollbackError], 'Copilot Code setup failed and its prior plugin state could not be restored. Inspect Code > Customize before retrying.');
			}
			throw error;
		}
	});
}

export async function removeCopilotCodeIntegration(options: CodePluginOptions): Promise<{ removed: boolean; existingPreserved: boolean }> {
	return withCodeLock(options, async root => {
		const receipt = await receiptFor(options);
		if (!receipt) return { removed: false, existingPreserved: (await installedPlugin(options.target)) !== undefined };
		const plugin = await verifyOwned(options, receipt);
		if (plugin) {
			await runCode(options, ['plugin', 'uninstall', COPILOT_CODE_PLUGIN_NAME]);
			if (await installedPlugin(options.target)) throw new Error('Copilot Code still reports the Workbench plugin after removal.');
		}
		await rm(join(root, 'receipt.json'));
		return { removed: plugin !== undefined, existingPreserved: false };
	});
}

export async function inspectCopilotCodeIntegration(target: CopilotCodeTarget): Promise<boolean> {
	return (await installedPlugin(target)) !== undefined;
}