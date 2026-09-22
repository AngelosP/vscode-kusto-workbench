import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve, win32 } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { applyEdits, modify, parseTree, type Node as JsonNode, type ParseError } from 'jsonc-parser/lib/esm/main.js';
import * as lockfile from 'proper-lockfile';
import type { InstalledExternalMcpConnector } from './externalMcpConnectorInstaller';
import { releaseLockPreservingError } from './lockRelease';

const SERVER_KEY = 'kusto_workbench';
const SERVER_NAME = 'Kusto Workbench';
const MAX_CONFIG_BYTES = 5 * 1024 * 1024;

type Connector = Pick<InstalledExternalMcpConnector, 'command' | 'args'>;
type JsonObject = Record<string, unknown>;
type ScoutRegistry = JsonObject & { servers: Record<string, unknown> };

export interface ScoutRegistrationOptions {
	readonly connector: Connector;
	readonly configPath?: string;
	readonly ownershipPath?: string;
	readonly isScoutRunning?: () => Promise<boolean>;
	readonly beforeCommit?: () => Promise<void>;
}

interface Ownership {
	readonly schemaVersion: 1;
	readonly operationId: string;
	readonly configPath: string;
	readonly serverKey: string;
	readonly entry: JsonObject;
}

export interface ScoutMcpRegistrationResult {
	readonly changed: boolean;
	readonly managed: boolean;
	readonly serverKey: string;
	readonly rollback?: () => Promise<void>;
}

function isObject(value: unknown): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function resolveScoutMcpPaths(): { configPath: string; ownershipPath: string } {
	if (!process.env.LOCALAPPDATA) throw new Error('The local application data directory is unavailable.');
	return {
		configPath: join(homedir(), '.scout', 'm-mcp-servers.json'),
		ownershipPath: join(process.env.LOCALAPPDATA, 'KustoWorkbench', 'ScoutIntegration', 'registration.json'),
	};
}

function pathsFor(options: ScoutRegistrationOptions): { configPath: string; ownershipPath: string } {
	const defaults = options.configPath && options.ownershipPath ? undefined : resolveScoutMcpPaths();
	return {
		configPath: resolve(options.configPath ?? defaults!.configPath),
		ownershipPath: resolve(options.ownershipPath ?? defaults!.ownershipPath),
	};
}

export async function isScoutRunning(): Promise<boolean> {
	if (process.platform !== 'win32' || !process.env.SystemRoot) {
		throw new Error('Automatic Scout configuration currently requires local Windows desktop.');
	}
	const executable = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
	const count = await new Promise<string>((resolveResult, reject) => {
		execFile(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
			'@(Get-Process -Name scout -ErrorAction SilentlyContinue).Count'], {
			windowsHide: true, timeout: 10_000,
		}, (error, stdout) => error ? reject(new Error('Could not check whether Microsoft Scout is running.')) : resolveResult(stdout.trim()));
	});
	if (!/^\d+$/.test(count)) throw new Error('Could not verify that Microsoft Scout is closed.');
	return Number(count) !== 0;
}

async function requireScoutClosed(options: ScoutRegistrationOptions): Promise<void> {
	if (await (options.isScoutRunning ?? isScoutRunning)()) {
		throw new Error('Close Microsoft Scout completely, including its system-tray process, then configure the integration again. No Scout settings were overwritten.');
	}
}

async function readOptional(path: string): Promise<string | undefined> {
	try {
		const info = await lstat(path);
		if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > MAX_CONFIG_BYTES) {
			throw new Error('Scout integration configuration must be a regular, unlinked file under 5 MB.');
		}
		return await readFile(path, 'utf8');
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
		throw error;
	}
}

function assertUniqueKeys(node: JsonNode): void {
	if (node.type === 'object') {
		const keys = new Set<string>();
		for (const property of node.children ?? []) {
			const key = property.children![0].value as string;
			if (keys.has(key)) throw new Error('Scout configuration is invalid: duplicate JSON keys.');
			keys.add(key);
		}
	}
	for (const child of node.children ?? []) assertUniqueKeys(child);
}

function parseRegistry(text: string | undefined): ScoutRegistry {
	if (text === undefined) {
		return { servers: { filesystem: { builtin: true, tools: [] }, playwright: { builtin: true, tools: [] } } };
	}
	const errors: ParseError[] = [];
	const tree = parseTree(text, errors, { disallowComments: true, allowTrailingComma: false });
	if (!tree || errors.length) throw new Error('Scout MCP configuration is invalid. Repair it in Scout before configuring integration.');
	assertUniqueKeys(tree);
	const value: unknown = JSON.parse(text);
	if (!isObject(value) || !isObject(value.servers)) throw new Error('Scout MCP configuration has an invalid or unsupported format.');
	return value as ScoutRegistry;
}

function createEntry(connector: Connector): JsonObject {
	if (!win32.isAbsolute(connector.command) || connector.args.length !== 1 || !win32.isAbsolute(connector.args[0])
		|| /[\r\n\0"]/.test(connector.command + connector.args[0])) {
		throw new Error('Scout requires the installed connector executable and bootstrap argument as separate absolute paths.');
	}
	return {
		builtin: false,
		config: { name: SERVER_NAME, type: 'command', command: connector.command, args: [...connector.args] },
		tools: [],
	};
}

function samePath(left: unknown, right: string): boolean {
	return typeof left === 'string' && win32.normalize(left).toLowerCase() === win32.normalize(right).toLowerCase();
}

function exactConnector(config: JsonObject, connector: Connector): boolean {
	return (config.type === 'command' || config.type === 'stdio')
		&& samePath(config.command, connector.command)
		&& Array.isArray(config.args) && config.args.length === connector.args.length
		&& config.args.every((arg, index) => samePath(arg, connector.args[index]));
}

function workbenchName(value: unknown): boolean {
	return typeof value === 'string' && value.toLowerCase().replace(/[\s_-]/g, '') === 'kustoworkbench';
}

function findExisting(registry: ScoutRegistry, connector: Connector): [string, JsonObject] | undefined {
	const matches = Object.entries(registry.servers).filter(([key, entry]) => workbenchName(key)
		|| (isObject(entry) && isObject(entry.config) && (workbenchName(entry.config.name) || exactConnector(entry.config, connector))));
	if (matches.length > 1) throw new Error('Scout has multiple Kusto Workbench registrations. Resolve the duplicates in Scout before configuring integration.');
	const match = matches[0];
	if (!match) return undefined;
	const [key, entry] = match;
	if (!isObject(entry) || entry.builtin !== false || !isObject(entry.config) || !exactConnector(entry.config, connector)
		|| entry.enabled === false || entry.disabled === true || entry.config.enabled === false || entry.config.disabled === true) {
		throw new Error('Scout already has a Kusto Workbench registration with different settings. It was left unchanged.');
	}
	return [key, entry];
}

function withoutDiscoveredTools(entry: JsonObject): JsonObject {
	const { tools: _tools, ...identity } = entry;
	return identity;
}

function readOwnership(text: string | undefined, configPath: string): Ownership | undefined {
	if (text === undefined) return undefined;
	let value: unknown;
	try { value = JSON.parse(text); } catch { throw new Error('The Workbench Scout ownership record is invalid; configuration was left unchanged.'); }
	if (!isObject(value) || value.schemaVersion !== 1 || value.configPath !== configPath || typeof value.operationId !== 'string'
		|| value.serverKey !== SERVER_KEY || !isObject(value.entry)) {
		throw new Error('The Workbench Scout ownership record is invalid or belongs to another configuration.');
	}
	return value as unknown as Ownership;
}

function editEntry(text: string | undefined, key: string, value: JsonObject | undefined): string {
	const source = text ?? JSON.stringify(parseRegistry(undefined), null, 2);
	return applyEdits(source, modify(source, ['servers', key], value, {
		formattingOptions: { insertSpaces: true, tabSize: 2, eol: source.includes('\r\n') ? '\r\n' : '\n' },
	}));
}

async function publishCompared(path: string, expected: string | undefined, next: string | undefined, beforePublish: () => Promise<void>): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const staged = next === undefined ? undefined : join(dirname(path), `.kw-scout-${randomUUID()}.tmp`);
	let recovery: string | undefined;
	try {
		if (staged) {
			const handle = await open(staged, 'wx', 0o600);
			try { await handle.writeFile(next!, 'utf8'); await handle.sync(); } finally { await handle.close(); }
		}
		await beforePublish();
		if (await readOptional(path) !== expected) throw new Error('Scout configuration changed during setup; no concurrent changes were overwritten.');
		if (expected !== undefined) {
			recovery = join(dirname(path), `.kw-scout-${randomUUID()}.recovery`);
			await rename(path, recovery);
			if (await readOptional(recovery) !== expected) throw new Error('Scout configuration changed during setup.');
		}
		await beforePublish();
		if (staged) await link(staged, path);
		else if (await readOptional(path) !== undefined) throw new Error('Scout configuration changed during removal.');
		if (recovery) { await rm(recovery); recovery = undefined; }
	} catch (error) {
		if (recovery) {
			try { await link(recovery, path); await rm(recovery); } catch {
				throw new AggregateError([error], `Scout configuration changed; neither version was overwritten. Recovery file: ${recovery}`);
			}
		}
		throw error;
	} finally {
		if (staged) await rm(staged, { force: true });
	}
}

async function withRegistrationLock<Result>(ownershipPath: string, action: () => Promise<Result>): Promise<Result> {
	await mkdir(dirname(ownershipPath), { recursive: true, mode: 0o700 });
	const release = await lockfile.lock(ownershipPath, { realpath: false, retries: 0 });
	let operationError: unknown;
	try { return await action(); } catch (error) { operationError = error; throw error; } finally {
		await releaseLockPreservingError(release, operationError, 'Scout configuration lock could not be released.');
	}
}

async function removeOwnedEntry(options: ScoutRegistrationOptions, configPath: string, ownership: Ownership): Promise<boolean> {
	const text = await readOptional(configPath);
	const registry = parseRegistry(text);
	const entry = registry.servers[ownership.serverKey];
	if (entry === undefined) return false;
	if (!isObject(entry) || !isDeepStrictEqual(withoutDiscoveredTools(entry), ownership.entry)) {
		throw new Error('The Scout Workbench registration changed after setup and was not removed.');
	}
	await requireScoutClosed(options);
	await options.beforeCommit?.();
	await publishCompared(configPath, text, editEntry(text, ownership.serverKey, undefined), () => requireScoutClosed(options));
	return true;
}

export async function reconcileScoutMcpRegistration(options: ScoutRegistrationOptions): Promise<ScoutMcpRegistrationResult> {
	const { configPath, ownershipPath } = pathsFor(options);
	const desired = createEntry(options.connector);
	return withRegistrationLock(ownershipPath, async () => {
		const text = await readOptional(configPath);
		const registry = parseRegistry(text);
		const existing = findExisting(registry, options.connector);
		const previousOwnership = await readOptional(ownershipPath);
		const ownership = readOwnership(previousOwnership, configPath);
		if (existing) {
			return { changed: false, serverKey: existing[0], managed: ownership?.serverKey === existing[0]
				&& isDeepStrictEqual(ownership.entry, withoutDiscoveredTools(existing[1])) };
		}
		await requireScoutClosed(options);
		const receipt: Ownership = {
			schemaVersion: 1, operationId: randomUUID(), configPath, serverKey: SERVER_KEY, entry: withoutDiscoveredTools(desired),
		};
		await options.beforeCommit?.();
		await publishCompared(configPath, text, editEntry(text, SERVER_KEY, desired), () => requireScoutClosed(options));
		try {
			await publishCompared(ownershipPath, previousOwnership, JSON.stringify(receipt, null, 2), () => requireScoutClosed(options));
		} catch (error) {
			try { await removeOwnedEntry(options, configPath, receipt); } catch (rollbackError) {
				throw new AggregateError([error, rollbackError], 'Scout registration could not be recorded or rolled back. Inspect Scout configuration before retrying.');
			}
			throw error;
		}
		return {
			changed: true, managed: true, serverKey: SERVER_KEY,
			rollback: async () => { await removeRegistration(options, receipt.operationId); },
		};
	});
}

export async function inspectScoutMcpRegistration(options: ScoutRegistrationOptions): Promise<{ configured: boolean; managed: boolean }> {
	const { configPath, ownershipPath } = pathsFor(options);
	const registry = parseRegistry(await readOptional(configPath));
	const existing = findExisting(registry, options.connector);
	const ownership = readOwnership(await readOptional(ownershipPath), configPath);
	return {
		configured: existing !== undefined,
		managed: existing !== undefined && ownership?.serverKey === existing[0]
			&& isDeepStrictEqual(ownership.entry, withoutDiscoveredTools(existing[1])),
	};
}

export async function preflightScoutMcpRegistration(options: ScoutRegistrationOptions): Promise<void> {
	createEntry(options.connector);
	if (!(await inspectScoutMcpRegistration(options)).configured) await requireScoutClosed(options);
}

async function removeRegistration(options: ScoutRegistrationOptions, expectedOperationId?: string): Promise<{ removed: boolean }> {
	const { configPath, ownershipPath } = pathsFor(options);
	return withRegistrationLock(ownershipPath, async () => {
		const ownershipText = await readOptional(ownershipPath);
		const ownership = readOwnership(ownershipText, configPath);
		if (!ownership) return { removed: false };
		if (expectedOperationId && ownership.operationId !== expectedOperationId) throw new Error('Scout registration ownership changed before rollback.');
		const removed = await removeOwnedEntry(options, configPath, ownership);
		await publishCompared(ownershipPath, ownershipText, undefined, () => requireScoutClosed(options));
		return { removed };
	});
}

export async function removeScoutMcpRegistration(options: ScoutRegistrationOptions): Promise<{ removed: boolean }> {
	return removeRegistration(options);
}