import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { join, win32 } from 'node:path';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import type {
	ConnectorToolResult,
	ExternalMcpConnectorDependencies,
	WorkbenchProviderDescriptor,
	WorkbenchLaunch,
} from './externalMcpConnectorCore';

const MAX_DISCOVERY_RESPONSE_BYTES = 64 * 1024;
const MAX_LAUNCH_CORRELATION_AGE_MS = 24 * 60 * 60 * 1000;
const inFlightDiscoveryRounds = new Map<string, Promise<WorkbenchProviderDescriptor[]>>();

export class DiscoveryResponseReader {
	private readonly decoder = new StringDecoder('utf8');
	private response = '';
	private receivedBytes = 0;

	append(chunk: Buffer): string | undefined {
		this.receivedBytes += chunk.byteLength;
		if (this.receivedBytes > MAX_DISCOVERY_RESPONSE_BYTES) {
			throw new Error('Kusto Workbench discovery response exceeded its size limit.');
		}
		this.response += this.decoder.write(chunk);
		const newline = this.response.indexOf('\n');
		return newline < 0 ? undefined : this.response.slice(0, newline);
	}
}

export interface ExternalMcpConnectorConfig {
	readonly schemaVersion: 1;
	readonly connectorVersion: string;
	readonly toolManifestPath: string;
	readonly guidancePath: string;
	readonly discoveryDirectory: string;
	readonly launchDirectory: string;
	readonly codeExecutable: string;
	readonly codeArguments?: readonly string[];
}

export interface DiscoveryAnnouncement {
	readonly protocolVersion: 1;
	readonly instanceId: string;
	readonly pipeName: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseConnectorConfig(value: unknown): ExternalMcpConnectorConfig {
	if (!isRecord(value)
		|| value.schemaVersion !== 1
		|| typeof value.connectorVersion !== 'string'
		|| typeof value.toolManifestPath !== 'string'
		|| typeof value.guidancePath !== 'string'
		|| typeof value.discoveryDirectory !== 'string'
		|| typeof value.launchDirectory !== 'string'
		|| typeof value.codeExecutable !== 'string'
		|| (value.codeArguments !== undefined
			&& (!Array.isArray(value.codeArguments) || value.codeArguments.some(argument => typeof argument !== 'string')))) {
		throw new Error('Kusto Workbench connector configuration is invalid. Run external-tools setup again.');
	}
	return value as unknown as ExternalMcpConnectorConfig;
}

export async function loadConnectorConfig(path: string): Promise<ExternalMcpConnectorConfig> {
	return parseConnectorConfig(JSON.parse(await readFile(path, 'utf8')));
}

export function parseDiscoveryAnnouncement(value: unknown): DiscoveryAnnouncement {
	if (!isRecord(value)
		|| value.protocolVersion !== 1
		|| typeof value.instanceId !== 'string' || !/^[a-zA-Z0-9._-]{1,128}$/.test(value.instanceId)
		|| typeof value.pipeName !== 'string'
		|| !/^\\\\\.\\pipe\\kusto-workbench-[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.pipeName)) {
		throw new Error('Invalid Kusto Workbench discovery announcement.');
	}
	return value as unknown as DiscoveryAnnouncement;
}

export function parseWorkbenchProviderDescriptor(value: unknown): WorkbenchProviderDescriptor {
	if (!isRecord(value)
		|| value.protocolVersion !== 1
		|| typeof value.instanceId !== 'string'
		|| typeof value.displayName !== 'string'
		|| typeof value.extensionVersion !== 'string'
		|| typeof value.schemaHash !== 'string'
		|| typeof value.processId !== 'number'
		|| typeof value.startedAt !== 'string'
		|| !Array.isArray(value.workspaceFolders)
		|| value.workspaceFolders.some(folder => typeof folder !== 'string')
		|| typeof value.endpoint !== 'string'
		|| typeof value.token !== 'string') {
		throw new Error('Invalid Kusto Workbench discovery response.');
	}
	let endpoint: URL;
	try {
		endpoint = new URL(value.endpoint);
	} catch {
		throw new Error('Invalid Kusto Workbench provider endpoint.');
	}
	if (endpoint.protocol !== 'http:'
		|| endpoint.hostname !== '127.0.0.1'
		|| !endpoint.port
		|| endpoint.pathname !== '/mcp'
		|| endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
		throw new Error('Kusto Workbench provider endpoint must be an authenticated IPv4 loopback /mcp URL.');
	}
	return value as unknown as WorkbenchProviderDescriptor;
}

export function queryDiscoveryPipe(
	announcement: DiscoveryAnnouncement,
	timeoutMs = 2_000,
	signal?: AbortSignal,
): Promise<WorkbenchProviderDescriptor> {
	const validatedAnnouncement = parseDiscoveryAnnouncement(announcement);
	return new Promise<WorkbenchProviderDescriptor>((resolve, reject) => {
		const socket = createConnection(validatedAnnouncement.pipeName);
		const response = new DiscoveryResponseReader();
		let settled = false;
		const cleanup = () => {
			clearTimeout(timer);
			signal?.removeEventListener('abort', onAbort);
			socket.removeAllListeners();
			socket.destroy();
		};
		const settle = (provider?: WorkbenchProviderDescriptor, error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(provider!);
		};
		const onAbort = () => settle(undefined, signal?.reason instanceof Error ? signal.reason : new Error('Discovery was cancelled.'));
		const timer = setTimeout(() => settle(undefined, new Error('Kusto Workbench discovery pipe timed out.')), timeoutMs);
		socket.once('connect', () => socket.write('{"protocolVersion":1,"type":"discover"}\n'));
		socket.on('data', chunk => {
			try {
				const line = response.append(chunk);
				if (line === undefined) return;
				const provider = parseWorkbenchProviderDescriptor(JSON.parse(line));
				if (provider.instanceId !== validatedAnnouncement.instanceId) {
					throw new Error('Kusto Workbench discovery instance identity changed.');
				}
				settle(provider);
			} catch (error) {
				settle(undefined, error instanceof Error ? error : new Error(String(error)));
			}
		});
		socket.once('error', error => settle(undefined, error));
		signal?.addEventListener('abort', onAbort, { once: true });
		if (signal?.aborted) onAbort();
	});
}

export async function discoverProvidersFromDirectory(
	discoveryDirectory: string,
	signal?: AbortSignal,
	queryProvider: (announcement: DiscoveryAnnouncement, timeoutMs?: number) => Promise<WorkbenchProviderDescriptor> = queryDiscoveryPipe,
): Promise<WorkbenchProviderDescriptor[]> {
	if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Discovery was cancelled.');
	let round = inFlightDiscoveryRounds.get(discoveryDirectory);
	if (!round) {
		const started = discoverProvidersRound(discoveryDirectory, queryProvider);
		const tracked = started.finally(() => {
			if (inFlightDiscoveryRounds.get(discoveryDirectory) === tracked) {
				inFlightDiscoveryRounds.delete(discoveryDirectory);
			}
		});
		inFlightDiscoveryRounds.set(discoveryDirectory, tracked);
		round = tracked;
	}
	if (!signal) return round;
	return new Promise<WorkbenchProviderDescriptor[]>((resolve, reject) => {
		let settled = false;
		const settle = (value?: WorkbenchProviderDescriptor[], error?: unknown) => {
			if (settled) return;
			settled = true;
			signal.removeEventListener('abort', onAbort);
			if (error !== undefined) reject(error);
			else resolve(value!);
		};
		const onAbort = () => settle(undefined, signal.reason instanceof Error ? signal.reason : new Error('Discovery was cancelled.'));
		signal.addEventListener('abort', onAbort, { once: true });
		round.then(value => settle(value), error => settle(undefined, error));
		if (signal.aborted) onAbort();
	});
}

async function discoverProvidersRound(
	discoveryDirectory: string,
	queryProvider: (announcement: DiscoveryAnnouncement, timeoutMs?: number) => Promise<WorkbenchProviderDescriptor>,
): Promise<WorkbenchProviderDescriptor[]> {
	let names: string[];
	try {
		names = await readdir(discoveryDirectory);
	} catch (error) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
		throw error;
	}
	const discovered = await Promise.all(names
		.filter(name => name.endsWith('.json'))
		.map(async name => {
			try {
				const announcement = parseDiscoveryAnnouncement(JSON.parse(await readFile(join(discoveryDirectory, name), 'utf8')));
				if (name !== `${announcement.instanceId}.json`) return undefined;
				for (let attempt = 0; attempt < 3; attempt++) {
					try {
						return await queryProvider(announcement, 2_000);
					} catch {
						if (attempt >= 2) return undefined;
						await new Promise(resolve => setTimeout(resolve, 50));
					}
				}
				return undefined;
			} catch {
				return undefined;
			}
		}));
	const byId = new Map<string, WorkbenchProviderDescriptor>();
	for (const provider of discovered) if (provider) byId.set(provider.instanceId, provider);
	return [...byId.values()];
}

export async function invokeProviderViaHttp(
	provider: WorkbenchProviderDescriptor,
	publicToolName: string,
	input: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<ConnectorToolResult> {
	provider = parseWorkbenchProviderDescriptor(provider);
	const client = new Client(
		{ name: 'kusto-workbench-connector', version: '1.0.0' },
		{ versionNegotiation: { mode: 'auto' } },
	);
	const transport = new StreamableHTTPClientTransport(new URL(provider.endpoint), {
		requestInit: { headers: { Authorization: `Bearer ${provider.token}` }, signal },
	});
	try {
		await client.connect(transport);
		const result = await client.callTool({ name: publicToolName, arguments: input }, { signal });
		return {
			content: result.content.map(part => part.type === 'text'
				? { type: 'text' as const, text: part.text }
				: { type: 'text' as const, text: JSON.stringify(part) }),
			...(result.isError ? { isError: true } : {}),
		};
	} finally {
		await client.close().catch(() => undefined);
	}
}

export async function launchVsCodeWorkbench(
	config: ExternalMcpConnectorConfig,
	request: { workspaceFolder: string; launchRequestId: string },
): Promise<WorkbenchLaunch> {
	const workspaceFolder = request.workspaceFolder.trim().replace(/\//g, '\\');
	if (!/^[a-zA-Z]:\\/.test(workspaceFolder) || !win32.isAbsolute(workspaceFolder)) {
		throw new Error('workspaceFolder must be an absolute local drive path; UNC and device paths are not supported.');
	}
	const folder = await stat(workspaceFolder);
	if (!folder.isDirectory()) throw new Error('workspaceFolder must identify an existing directory.');
	await mkdir(config.launchDirectory, { recursive: true });
	for (const entry of await readdir(config.launchDirectory, { withFileTypes: true })) {
		if (!entry.isFile() || !entry.name.endsWith('.code-workspace')) continue;
		const candidate = join(config.launchDirectory, entry.name);
		try {
			const candidateStat = await stat(candidate);
			if (Date.now() - candidateStat.mtimeMs > MAX_LAUNCH_CORRELATION_AGE_MS) {
				await rm(candidate, { force: true });
			}
		} catch {
			// Another connector or delayed VS Code window may be consuming the file.
		}
	}
	const workspacePath = join(config.launchDirectory, `${request.launchRequestId}.code-workspace`);
	await writeFile(workspacePath, `${JSON.stringify({
		folders: [{ path: workspaceFolder }],
		settings: { 'kustoWorkbench.externalTools.launchRequestId': request.launchRequestId },
	}, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
	try {
		const child = spawn(config.codeExecutable, [...(config.codeArguments || []), '--new-window', workspacePath], {
			detached: true,
			stdio: 'ignore',
			windowsHide: true,
		});
		await new Promise<void>((resolve, reject) => {
			let settled = false;
			let startupTimer: ReturnType<typeof setTimeout> | undefined;
			const cleanup = () => {
				if (startupTimer) clearTimeout(startupTimer);
				child.off('spawn', onSpawn);
				child.off('error', onError);
				child.off('exit', onExit);
			};
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				if (error) reject(error);
				else resolve();
			};
			const onSpawn = () => {
				startupTimer = setTimeout(() => settle(), 250);
			};
			const onError = (error: Error) => settle(error);
			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				if (code !== null && code !== 0) {
					settle(new Error(`VS Code launch process exited with code ${code}.`));
				} else if (signal) {
					settle(new Error(`VS Code launch process exited from signal ${signal}.`));
				} else {
					settle();
				}
			};
			child.once('spawn', onSpawn);
			child.once('error', onError);
			child.once('exit', onExit);
		});
		child.unref();
		return {
			cleanup: options => options?.preserveForLateLaunch
				? Promise.resolve()
				: rm(workspacePath, { force: true }),
		};
	} catch (error) {
		await rm(workspacePath, { force: true });
		throw error;
	}
}

export function createNodeConnectorDependencies(
	config: ExternalMcpConnectorConfig,
): ExternalMcpConnectorDependencies {
	return {
		discoverProviders: signal => discoverProvidersFromDirectory(config.discoveryDirectory, signal),
		invokeProvider: invokeProviderViaHttp,
		launchWorkbench: request => launchVsCodeWorkbench(config, request),
		sleep: (milliseconds, signal) => new Promise<void>((resolve, reject) => {
			let settled = false;
			const settle = (error?: Error) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				signal?.removeEventListener('abort', onAbort);
				if (error) reject(error);
				else resolve();
			};
			const timer = setTimeout(() => settle(), milliseconds);
			const onAbort = () => {
				settle(signal?.reason instanceof Error ? signal.reason : new Error('Operation cancelled.'));
			};
			signal?.addEventListener('abort', onAbort, { once: true });
			if (signal?.aborted) onAbort();
		}),
		createId: randomUUID,
	};
}