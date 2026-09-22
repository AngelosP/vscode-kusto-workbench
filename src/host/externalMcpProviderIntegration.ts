import * as vscode from 'vscode';
import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
	createExternalMcpCatalog,
	type CanonicalWorkbenchToolContribution,
} from '../shared/externalMcpCatalog';
import type { WorkbenchProviderDescriptor } from '../connector/externalMcpConnectorCore';
import {
	buildWorkbenchMcpToolDefinitions,
	createWorkbenchToolTokenizationOptions,
} from './workbenchMcpToolAdapter';
import {
	EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT,
	startExternalMcpDiscovery,
	type ExternalMcpDiscoveryServer,
} from './externalMcpDiscovery';
import type {
	RunningWorkbenchMcpBridge,
	StartWorkbenchMcpBridgeOptions,
} from './workbenchMcpBridge';
import { isExternalMcpHostEligible } from '../shared/externalMcpHostEligibility';
import { completeExternalMcpProviderStartup } from './externalMcpProviderStartup';

export const EXTERNAL_TOOLS_ENABLED_SETTING = 'externalTools.enabled';
export const EXTERNAL_TOOLS_LAUNCH_REQUEST_SETTING = 'externalTools.launchRequestId';
const EXTERNAL_MCP_RESTART_STABILITY_MS = 30_000;

export function externalMcpRestartDelay(attempt: number): number {
	const boundedAttempt = Math.min(Math.max(Math.trunc(attempt), 0), 6);
	return Math.min(500 * 2 ** boundedAttempt, 30_000);
}

interface WorkbenchMcpBridgeModule {
	startWorkbenchMcpBridge(options: StartWorkbenchMcpBridgeOptions): Promise<RunningWorkbenchMcpBridge>;
}

export interface ExternalMcpProviderLogger {
	error(message: string): void;
	warn(message: string): void;
	info(message: string): void;
}

export interface ExternalMcpProviderIntegration extends vscode.Disposable {
	start(): Promise<void>;
	stop(): Promise<void>;
	isRunning(): boolean;
}

function splitAgentSource(source: string): { frontmatter: string } {
	if (!source.startsWith('---')) throw new Error('Agent instructions are missing YAML frontmatter.');
	const closing = source.indexOf('\n---', 3);
	if (closing < 0) throw new Error('Agent instructions have unterminated YAML frontmatter.');
	return { frontmatter: source.slice(3, closing) };
}

function modelFamily(source: string): string | undefined {
	const frontmatter = splitAgentSource(source).frontmatter;
	const match = /^model:\s*(.+?)\s*$/m.exec(frontmatter);
	return match?.[1]?.replace(/^['"]|['"]$/g, '').replace(/@.+$/, '');
}

async function readText(uri: vscode.Uri): Promise<string> {
	return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function displayName(): string {
	if (vscode.workspace.name?.trim()) return vscode.workspace.name.trim();
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length === 1) return folders[0].name;
	return 'Kusto Workbench';
}

export class DefaultExternalMcpProviderIntegration implements ExternalMcpProviderIntegration {
	private bridge: RunningWorkbenchMcpBridge | undefined;
	private discovery: ExternalMcpDiscoveryServer | undefined;
	private lifecycleTail: Promise<void> = Promise.resolve();
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private restartStabilityTimer: ReturnType<typeof setTimeout> | undefined;
	private restartBackoffAttempt = 0;
	private desiredRunning = false;
	private restartRequested = false;
	private disposed = false;
	private ready = false;
	private readonly instanceId = randomUUID();
	private readonly startedAt = new Date().toISOString();
	private readonly workspaceFoldersSubscription: vscode.Disposable;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: ExternalMcpProviderLogger,
	) {
		this.workspaceFoldersSubscription = vscode.workspace.onDidChangeWorkspaceFolders(() => {
			this.handleWorkspaceFoldersChanged();
		});
	}

	isRunning(): boolean {
		return this.ready && !!this.bridge && !!this.discovery;
	}

	start(): Promise<void> {
		if (this.disposed) throw new Error('External MCP provider integration has been disposed.');
		this.desiredRunning = true;
		return this.enqueueReconcile();
	}

	stop(): Promise<void> {
		this.desiredRunning = false;
		this.restartRequested = false;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = undefined;
		}
		if (this.restartStabilityTimer) {
			clearTimeout(this.restartStabilityTimer);
			this.restartStabilityTimer = undefined;
		}
		this.restartBackoffAttempt = 0;
		return this.enqueueReconcile();
	}

	async dispose(): Promise<void> {
		if (!this.disposed) {
			this.disposed = true;
			this.workspaceFoldersSubscription.dispose();
			this.desiredRunning = false;
			this.restartRequested = false;
			if (this.restartTimer) {
				clearTimeout(this.restartTimer);
				this.restartTimer = undefined;
			}
			if (this.restartStabilityTimer) {
				clearTimeout(this.restartStabilityTimer);
				this.restartStabilityTimer = undefined;
			}
			this.restartBackoffAttempt = 0;
		}
		await this.enqueueReconcile();
	}

	private handleWorkspaceFoldersChanged(): void {
		if (this.disposed || !this.desiredRunning) return;
		this.restartRequested = true;
		void this.enqueueReconcile().catch(error => {
			this.logError(`[External MCP] Workspace discovery refresh failed: ${error instanceof Error ? error.message : String(error)}`);
			this.scheduleDiscoveryRestart();
		});
	}

	private enqueueReconcile(): Promise<void> {
		const operation = this.lifecycleTail.catch(() => undefined).then(() => this.reconcile());
		this.lifecycleTail = operation.catch(() => undefined);
		return operation;
	}

	private async reconcile(): Promise<void> {
		if (this.restartRequested) {
			this.restartRequested = false;
			await this.stopResources();
		}
		if (!this.desiredRunning || this.disposed) {
			await this.stopResources();
			return;
		}
		if (this.isRunning()) return;
		if (this.bridge || this.discovery) await this.stopResources();
		if (!this.desiredRunning || this.disposed) return;
		await this.startCore();
		if (!this.desiredRunning || this.disposed) await this.stopResources();
	}

	private async stopResources(): Promise<void> {
		this.ready = false;
		const discovery = this.discovery;
		const bridge = this.bridge;
		const [discoveryResult, bridgeResult] = await Promise.allSettled([
			discovery?.close(),
			bridge?.close(),
		]);
		if (discoveryResult.status === 'fulfilled' && this.discovery === discovery) this.discovery = undefined;
		if (bridgeResult.status === 'fulfilled' && this.bridge === bridge) this.bridge = undefined;
		const failures = [discoveryResult, bridgeResult]
			.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
			.map(result => result.reason);
		if (failures.length > 0) throw new AggregateError(failures, 'External MCP provider shutdown failed.');
	}

	private logInfo(message: string): void {
		try { this.logger.info(message); } catch { /* logging must not own provider lifecycle */ }
	}

	private logError(message: string): void {
		try { this.logger.error(message); } catch { /* logging must not own provider lifecycle */ }
	}

	private logWarning(message: string): void {
		try { this.logger.warn(message); } catch { /* logging must not own provider lifecycle */ }
	}

	private async startCore(): Promise<void> {
		this.logInfo(`[External MCP] Initializing provider ${this.instanceId}.`);
		if (!isExternalMcpHostEligible({
			platform: process.platform,
			architecture: process.arch,
			remoteName: vscode.env.remoteName,
			desktop: vscode.env.uiKind === vscode.UIKind.Desktop,
		})) {
			throw new Error('External MCP integration currently supports local Windows x64 desktop VS Code windows only.');
		}
		const localAppData = process.env.LOCALAPPDATA;
		const systemRoot = process.env.SystemRoot;
		if (!localAppData || !systemRoot) throw new Error('Required Windows user directories are unavailable.');
		const contributions = (this.context.extension.packageJSON.contributes?.languageModelTools || []) as CanonicalWorkbenchToolContribution[];
		const catalog = createExternalMcpCatalog(contributions);
		const tools = buildWorkbenchMcpToolDefinitions(contributions, vscode.lm.tools);
		const instructions = await readText(vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'custom-agent.md'));
		const selectedModelFamily = modelFamily(instructions);
		const token = randomBytes(32).toString('base64url');
		const bridgeModulePath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workbench-mcp-bridge.js').fsPath;
		const bridgeModule = await import(vscode.Uri.file(bridgeModulePath).toString()) as WorkbenchMcpBridgeModule;
		const bridge = await bridgeModule.startWorkbenchMcpBridge({
			tools,
			sharedAuthorizationToken: token,
			version: String(this.context.extension.packageJSON.version || '0.0.0'),
			invokeTool: async (registeredName, input, signal) => {
				const cancellation = new vscode.CancellationTokenSource();
				const cancel = () => cancellation.cancel();
				signal.addEventListener('abort', cancel, { once: true });
				if (signal.aborted) cancellation.cancel();
				try {
					const tokenizationOptions = await createWorkbenchToolTokenizationOptions(
						registeredName,
						selectedModelFamily,
						cancellation.token,
						selector => vscode.lm.selectChatModels(selector),
					);
					const result = await vscode.lm.invokeTool(registeredName, {
						input: input as object,
						toolInvocationToken: undefined,
						...(tokenizationOptions ? { tokenizationOptions } : {}),
					}, cancellation.token);
					return {
						textParts: result.content.map((part, index) => {
							if (part instanceof vscode.LanguageModelTextPart) return part.value;
							throw new Error(`Workbench tool returned unsupported content at index ${index}.`);
						}),
					};
				} finally {
					signal.removeEventListener('abort', cancel);
					cancellation.dispose();
				}
			},
			onError: error => this.logError(`[External MCP] ${error.message}`),
		});
		this.bridge = bridge;
		const resources = await completeExternalMcpProviderStartup(bridge, async () => {
			this.logInfo(`[External MCP] HTTP bridge is ready with ${bridge.toolCount} tools.`);
			const providerStorage = vscode.Uri.joinPath(this.context.globalStorageUri, 'external-tools');
			await vscode.workspace.fs.createDirectory(providerStorage);
			const helperScript = vscode.Uri.joinPath(providerStorage, 'discovery-helper.ps1');
			await vscode.workspace.fs.writeFile(helperScript, Buffer.from(EXTERNAL_MCP_DISCOVERY_HELPER_SCRIPT, 'utf8'));
			const launchRequestId = vscode.workspace.getConfiguration('kustoWorkbench')
				.get<string>(EXTERNAL_TOOLS_LAUNCH_REQUEST_SETTING, '').trim();
			const discoveryDirectory = join(localAppData, 'KustoWorkbench', 'McpConnector', 'discovery');
			this.logInfo(
				`[External MCP] Discovery context: directory=${discoveryDirectory}; launchRequestId=${launchRequestId || '<none>'}.`,
			);
			const descriptor: WorkbenchProviderDescriptor = {
				protocolVersion: 1,
				instanceId: this.instanceId,
				displayName: displayName(),
				extensionVersion: String(this.context.extension.packageJSON.version || '0.0.0'),
				schemaHash: catalog.schemaHash,
				processId: process.pid,
				startedAt: this.startedAt,
				workspaceFolders: (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath),
				...(vscode.workspace.workspaceFile?.scheme === 'file' ? { workspaceFile: vscode.workspace.workspaceFile.fsPath } : {}),
				...(launchRequestId ? { launchRequestId } : {}),
				endpoint: bridge.endpoint,
				token,
			};
			this.logInfo('[External MCP] Starting secured discovery helper.');
			return startExternalMcpDiscovery({
				descriptor,
				discoveryDirectory,
				helperScriptPath: helperScript.fsPath,
				powerShellExecutable: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
				logger: { error: message => this.logError(message), warn: message => this.logWarning(message) },
				onUnexpectedClose: () => {
					this.ready = false;
					this.scheduleDiscoveryRestart();
				},
				onProvisionalServer: discovery => { this.discovery = discovery; },
				onStartupCleanupSucceeded: discovery => {
					if (this.discovery === discovery) this.discovery = undefined;
				},
			});
		}, closedBridge => {
			if (this.bridge === closedBridge) this.bridge = undefined;
		});
		this.bridge = resources.bridge;
		this.discovery = resources.discovery;
		this.ready = true;
		if (this.restartStabilityTimer) clearTimeout(this.restartStabilityTimer);
		this.restartStabilityTimer = setTimeout(() => {
			this.restartStabilityTimer = undefined;
			this.restartBackoffAttempt = 0;
		}, EXTERNAL_MCP_RESTART_STABILITY_MS);
		this.logInfo(`[External MCP] Provider ${this.instanceId} is ready.`);
	}

	private scheduleDiscoveryRestart(): void {
		if (this.disposed || !this.desiredRunning || this.restartTimer) return;
		if (this.restartStabilityTimer) {
			clearTimeout(this.restartStabilityTimer);
			this.restartStabilityTimer = undefined;
		}
		const delay = externalMcpRestartDelay(this.restartBackoffAttempt++);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (!vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>(EXTERNAL_TOOLS_ENABLED_SETTING, false)) {
				void this.stop().catch(error => this.logError(`[External MCP] Provider stop failed: ${error instanceof Error ? error.message : String(error)}`));
				return;
			}
			if (!this.desiredRunning || this.disposed) return;
			this.restartRequested = true;
			void this.enqueueReconcile().catch(error => {
				this.logError(`[External MCP] Discovery restart failed: ${error instanceof Error ? error.message : String(error)}`);
				this.scheduleDiscoveryRestart();
			});
		}, delay);
	}
}

export function createExternalMcpProviderIntegration(
	context: vscode.ExtensionContext,
	logger: ExternalMcpProviderLogger,
): ExternalMcpProviderIntegration {
	return new DefaultExternalMcpProviderIntegration(context, logger);
}