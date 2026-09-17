import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { access, writeFile as writeLocalFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import {
	CopilotCliConnectionCancelledError,
	CopilotCliSessionManager,
	type CopilotCliBridge,
	type CopilotCliConnectionTarget,
	type CopilotCliLease,
	type CopilotCliPreparedLaunch,
	type CopilotCliTerminal,
} from './copilotCliSessionManager';
import {
	EXTERNAL_CLI_BROKER_SCRIPT,
	EXTERNAL_CLI_RUNNER_SCRIPT,
	createExternalCliLaunchDescriptor,
	launchExternalCopilotCliTerminal,
} from './copilotCliExternalTerminal';
import type {
	RunningWorkbenchMcpBridge,
	StartWorkbenchMcpBridgeOptions,
	WorkbenchMcpToolDefinition,
} from './workbenchMcpBridge';
import { DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION } from './schemaIndexUtils';

const MAIN_AGENT_ID = 'kusto-workbench-cli';
const SEARCH_AGENT_ID = 'kusto-workbench-search-cli';
const MAX_TOOL_TIMEOUT_MS = 7_500_000;
const GET_SCHEMA_REGISTERED_NAME = 'kusto-workbench_get-schema';
const REFRESH_SCHEMA_REGISTERED_NAME = 'kusto-workbench_refresh-schema';
const FALLBACK_SCHEMA_TOKEN_BUDGET = 8_192;
export const COPILOT_CLI_ENABLED_SETTING = 'copilotCli.enabled';
export const MINIMUM_COPILOT_CLI_VERSION = '1.0.81';

interface LanguageModelToolContribution {
	name: string;
	toolReferenceName: string;
	displayName?: string;
	modelDescription: string;
	inputSchema: Record<string, unknown>;
}

interface RegisteredLanguageModelTool {
	name: string;
	description: string;
	inputSchema?: object;
}

interface RenderCopilotCliAgentsOptions {
	mainSource: string;
	searchSource: string;
	serverName: string;
	allToolNames: readonly string[];
}

interface PreparedCopilotCliLaunch extends CopilotCliPreparedLaunch {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: vscode.Uri;
	readonly external?: Readonly<{
		powerShellExecutable: string;
		taskkillExecutable: string;
		brokerScriptPath: string;
		descriptorPath: string;
		startPath: string;
		stopPath: string;
		exitedPath: string;
		visiblePidPath: string;
	}>;
}

interface WorkbenchMcpBridgeModule {
	startWorkbenchMcpBridge(options: StartWorkbenchMcpBridgeOptions): Promise<RunningWorkbenchMcpBridge>;
}

export interface CopilotCliIntegration extends vscode.Disposable {
	connect(target?: CopilotCliConnectionTarget): Promise<void>;
	stop(): Promise<void>;
}

export interface CopilotCliLogger {
	error(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
}

export async function publishCopilotCliLaunchAssets(operations: {
	writeAgents(): Promise<void>;
	writeCredential(): Promise<void>;
	cleanup(): Promise<void>;
}): Promise<void> {
	try {
		await operations.writeAgents();
		await operations.writeCredential();
	} catch (error) {
		try {
			await operations.cleanup();
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], 'Copilot CLI launch publication and cleanup both failed.');
		}
		throw error;
	}
}

type TokenCounterModel = Pick<vscode.LanguageModelChat, 'countTokens' | 'maxInputTokens'>;

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

export async function createWorkbenchToolTokenizationOptions(
	registeredName: string,
	modelFamily: string | undefined,
	token: vscode.CancellationToken,
	selectModels: (selector: vscode.LanguageModelChatSelector) => Thenable<readonly TokenCounterModel[]>,
): Promise<vscode.LanguageModelToolTokenizationOptions | undefined> {
	if (registeredName !== GET_SCHEMA_REGISTERED_NAME && registeredName !== REFRESH_SCHEMA_REGISTERED_NAME) return undefined;
	let model: TokenCounterModel | undefined;
	try {
		const preferred = modelFamily
			? await selectModels({ vendor: 'copilot', family: modelFamily })
			: [];
		model = preferred[0] ?? (await selectModels({ vendor: 'copilot' }))[0];
	} catch {
		model = undefined;
	}
	if (!model || model.maxInputTokens <= 0) {
		return {
			tokenBudget: FALLBACK_SCHEMA_TOKEN_BUDGET,
			countTokens: async text => estimateTokens(text),
		};
	}
	return {
		tokenBudget: Math.max(1, Math.floor(model.maxInputTokens * DEFAULT_SCHEMA_TOKEN_BUDGET_FRACTION)),
		countTokens: async (text, countToken) => {
			try {
				return await model.countTokens(text, countToken ?? token);
			} catch {
				return estimateTokens(text);
			}
		},
	};
}

function splitAgentSource(source: string): { frontmatter: string; body: string } {
	if (!source.startsWith('---')) throw new Error('Agent instructions are missing YAML frontmatter.');
	const closing = source.indexOf('\n---', 3);
	if (closing < 0) throw new Error('Agent instructions have unterminated YAML frontmatter.');
	return {
		frontmatter: source.slice(3, closing),
		body: source.slice(closing + 4).trimStart(),
	};
}

function frontmatterValue(frontmatter: string, key: string): string | undefined {
	const match = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter);
	return match?.[1]?.replace(/^['"]|['"]$/g, '');
}

function cliModelFrom(frontmatter: string): string | undefined {
	return frontmatterValue(frontmatter, 'model')?.replace(/@.+$/, '');
}

function renderAgentFrontmatter(
	name: string,
	description: string,
	tools: readonly string[],
	infer: boolean,
	model?: string,
): string {
	return [
		'---',
		`name: ${name}`,
		`description: ${JSON.stringify(description)}`,
		`infer: ${infer}`,
		`tools: ${JSON.stringify(tools)}`,
		...(model ? [`model: ${model}`] : []),
		'---',
		'',
	].join('\n');
}

export function buildWorkbenchMcpToolDefinitions(
	contributions: readonly LanguageModelToolContribution[],
	registeredTools: readonly RegisteredLanguageModelTool[],
): WorkbenchMcpToolDefinition[] {
	const publicNames = new Set<string>();
	return contributions.map(contribution => {
		const registered = registeredTools.find(tool => tool.name === contribution.name);
		if (!registered) {
			throw new Error(`Workbench tool is not registered: ${contribution.name}`);
		}
		if (!registered.inputSchema) throw new Error(`Registered Workbench tool has no input schema: ${contribution.name}`);
		if (registered.description !== contribution.modelDescription
			|| JSON.stringify(registered.inputSchema) !== JSON.stringify(contribution.inputSchema)) {
			throw new Error(`Workbench tool metadata does not match its live registration: ${contribution.name}`);
		}
		if (!contribution.toolReferenceName || publicNames.has(contribution.toolReferenceName)) {
			throw new Error(`Workbench tool reference name is missing or duplicated: ${contribution.toolReferenceName || contribution.name}`);
		}
		publicNames.add(contribution.toolReferenceName);
		return {
			name: contribution.toolReferenceName,
			registeredName: contribution.name,
			...(contribution.displayName ? { title: contribution.displayName } : {}),
			description: contribution.modelDescription,
			inputSchema: contribution.inputSchema,
		};
	});
}

export function createCopilotCliMcpConfig(options: {
	serverName: string;
	endpoint: string;
	toolNames: readonly string[];
	token: string;
}): object {
	return {
		mcpServers: {
			[options.serverName]: {
				type: 'http',
				url: options.endpoint,
				headers: { Authorization: `Bearer ${options.token}` },
				tools: [...options.toolNames],
				timeout: MAX_TOOL_TIMEOUT_MS,
				deferTools: 'never',
				disableToolCache: true,
				filterMapping: 'none',
			},
		},
	};
}

export function renderCopilotCliAgents(options: RenderCopilotCliAgentsOptions): {
	main: string;
	search: string;
} {
	const main = splitAgentSource(options.mainSource);
	const search = splitAgentSource(options.searchSource);
	const mcpTool = (name: string) => `${options.serverName}/${name}`;
	const mainTools = [
		'view',
		'grep',
		'glob',
		'task',
		'web_fetch',
		'ask_user',
		...options.allToolNames.map(mcpTool),
	];
	const searchTools = [
		'view',
		'grep',
		'glob',
		...options.allToolNames
			.filter(name => search.frontmatter.includes(`'${name}'`) || search.frontmatter.includes(`"${name}"`))
			.map(mcpTool),
	];
	const mainBody = main.body
		.replaceAll('#runSubagent', '#task')
		.replaceAll('`Kusto Workbench Search`', `\`${SEARCH_AGENT_ID}\``);
	return {
		main: `${renderAgentFrontmatter(
			'Kusto Workbench',
			'Operate the connected Kusto Workbench VS Code window through its live tools.',
			mainTools,
			false,
			cliModelFrom(main.frontmatter),
		)}${mainBody}`,
		search: `${renderAgentFrontmatter(
			'Kusto Workbench Search',
			'Search every assigned Kusto connection through the connected Workbench window.',
			searchTools,
			true,
			cliModelFrom(search.frontmatter),
		)}${search.body}`,
	};
}

function parseVersion(value: string): [number, number, number] | undefined {
	const match = /(?:^|\s)v?(\d+)\.(\d+)\.(\d+)(?:-\d+)?(?=[.\s]|$)/i.exec(value);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function versionAtLeast(actual: [number, number, number], minimum: [number, number, number]): boolean {
	for (let index = 0; index < actual.length; index++) {
		if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
	}
	return true;
}

export function isCopilotCliVersionSupported(value: string): boolean {
	const actual = parseVersion(value);
	const minimum = parseVersion(MINIMUM_COPILOT_CLI_VERSION)!;
	return !!actual && versionAtLeast(actual, minimum);
}

function execFileText(executable: string, args: readonly string[], signal: AbortSignal): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile(executable, [...args], {
			windowsHide: true,
			timeout: 10_000,
			signal,
		}, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

async function resolveCopilotCliExecutable(signal: AbortSignal): Promise<string> {
	const locator = process.platform === 'win32' ? 'where.exe' : 'which';
	let output: string;
	try {
		output = await execFileText(locator, ['copilot'], signal);
	} catch {
		if (signal.aborted) throw new CopilotCliConnectionCancelledError();
		throw new Error('GitHub Copilot CLI was not found on PATH. Install it before connecting Kusto Workbench.');
	}
	const candidates = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
	const executable = process.platform === 'win32'
		? candidates.find(candidate => candidate.toLowerCase().endsWith('.exe')) ?? candidates[0]
		: candidates[0];
	if (!executable) throw new Error('GitHub Copilot CLI was not found on PATH.');
	let versionText: string;
	try {
		versionText = await execFileText(executable, ['--version'], signal);
	} catch {
		if (signal.aborted) throw new CopilotCliConnectionCancelledError();
		throw new Error('GitHub Copilot CLI did not respond to its version check within 10 seconds.');
	}
	if (!isCopilotCliVersionSupported(versionText)) {
		throw new Error(`GitHub Copilot CLI ${MINIMUM_COPILOT_CLI_VERSION} or newer is required.`);
	}
	return executable;
}

async function readText(uri: vscode.Uri): Promise<string> {
	return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

export function getWindowsExternalCliExecutables(systemRoot: string | undefined): {
	powerShellExecutable: string;
	taskkillExecutable: string;
} {
	if (!systemRoot) throw new Error('The Windows system directory is unavailable.');
	return {
		powerShellExecutable: join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
		taskkillExecutable: join(systemRoot, 'System32', 'taskkill.exe'),
	};
}

export async function chooseWorkingDirectory(signal: AbortSignal): Promise<vscode.Uri> {
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length === 0) {
		throw new Error('Open a workspace folder before connecting Copilot CLI.');
	}
	if (folders.length === 1) return folders[0].uri;
	return new Promise<vscode.Uri>((resolve, reject) => {
		const picker = vscode.window.createQuickPick<vscode.QuickPickItem & { folder: vscode.WorkspaceFolder }>();
		picker.placeholder = 'Choose the workspace for the Copilot CLI session';
		picker.items = folders.map(folder => ({ label: folder.name, description: folder.uri.fsPath, folder }));
		let settled = false;
		const subscriptions: vscode.Disposable[] = [];
		const cleanup = () => {
			for (const subscription of subscriptions) subscription.dispose();
			signal.removeEventListener('abort', onAbort);
			picker.dispose();
		};
		const settle = (uri?: vscode.Uri, error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(uri!);
		};
		const onAbort = () => {
			picker.hide();
			settle(undefined, new CopilotCliConnectionCancelledError());
		};
		subscriptions.push(
			picker.onDidAccept(() => settle(picker.selectedItems[0]?.folder.uri, picker.selectedItems[0] ? undefined : new vscode.CancellationError())),
			picker.onDidHide(() => settle(undefined, new vscode.CancellationError())),
		);
		signal.addEventListener('abort', onAbort, { once: true });
		if (signal.aborted) onAbort();
		else picker.show();
	});
}

class DefaultCopilotCliIntegration implements CopilotCliIntegration {
	private readonly manager: CopilotCliSessionManager;
	private readonly terminalRecords = new WeakMap<vscode.Terminal, { id: string; markClosed(): void }>();
	private terminalCloseSubscription: vscode.Disposable | undefined;
	private pendingExecutable: string | undefined;
	private pendingWorkingDirectory: vscode.Uri | undefined;
	private pendingExternalExecutables: ReturnType<typeof getWindowsExternalCliExecutables> | undefined;

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly logger: CopilotCliLogger,
	) {
		this.manager = new CopilotCliSessionManager({
			isEnabled: () => vscode.workspace.getConfiguration('kustoWorkbench')
				.get<boolean>(COPILOT_CLI_ENABLED_SETTING, false),
			prepareConnection: async (signal, target) => {
				try {
					this.pendingWorkingDirectory = await chooseWorkingDirectory(signal);
					if (this.pendingWorkingDirectory.scheme !== 'file'
						|| vscode.env.remoteName !== undefined
						|| vscode.env.uiKind !== vscode.UIKind.Desktop) {
						throw new Error('Copilot CLI integration currently supports local desktop VS Code windows with a local file working directory only.');
					}
					this.pendingExecutable = await resolveCopilotCliExecutable(signal);
					if (target === 'external') {
						if (process.platform !== 'win32') {
							throw new Error('External Copilot CLI consoles are currently supported on Windows only.');
						}
						this.pendingExternalExecutables = getWindowsExternalCliExecutables(process.env.SystemRoot);
						await Promise.all([
							access(this.pendingExternalExecutables.powerShellExecutable),
							access(this.pendingExternalExecutables.taskkillExecutable),
						]);
					}
				} catch (error) {
					this.pendingWorkingDirectory = undefined;
					this.pendingExecutable = undefined;
					this.pendingExternalExecutables = undefined;
					if (signal.aborted) throw new CopilotCliConnectionCancelledError();
					throw error;
				}
			},
			createBridge: () => this.createBridge(),
			prepareLaunch: ({ bridge, lease, target, retainLaunch }) => this.prepareLaunch(
				bridge,
				lease,
				target,
				retainLaunch,
			),
			launchTerminal: (launch, target, signal) => this.launchTerminal(
				launch as PreparedCopilotCliLaunch,
				target,
				signal,
			),
			showDisabledMessage: () => this.showDisabledMessage(),
		});
	}

	async connect(target: CopilotCliConnectionTarget = 'integrated'): Promise<void> {
		if (vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>(COPILOT_CLI_ENABLED_SETTING, false)) {
			if (target === 'integrated') this.ensureTerminalCloseListener();
		}
		try {
			await this.manager.connect(target);
		} catch (error) {
			if (error instanceof CopilotCliConnectionCancelledError) throw new vscode.CancellationError();
			throw error;
		}
	}

	async stop(): Promise<void> {
		try {
			await this.manager.stop();
		} finally {
			this.terminalCloseSubscription?.dispose();
			this.terminalCloseSubscription = undefined;
		}
	}

	async dispose(): Promise<void> {
		try {
			await this.manager.dispose();
		} finally {
			this.terminalCloseSubscription?.dispose();
			this.terminalCloseSubscription = undefined;
		}
	}

	private async createBridge(): Promise<CopilotCliBridge> {
		const contributions = (this.context.extension.packageJSON.contributes?.languageModelTools || []) as LanguageModelToolContribution[];
		const tools = buildWorkbenchMcpToolDefinitions(contributions, vscode.lm.tools);
		const mainSource = await readText(vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'custom-agent.md'));
		const modelFamily = cliModelFrom(splitAgentSource(mainSource).frontmatter);
		const modulePath = vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'workbench-mcp-bridge.js').fsPath;
		const bridgeModule = await import(pathToFileURL(modulePath).href) as WorkbenchMcpBridgeModule;
		return bridgeModule.startWorkbenchMcpBridge({
			tools,
			version: String(this.context.extension.packageJSON.version || '0.0.0'),
			invokeTool: async (registeredName, input, signal) => {
				const cancellation = new vscode.CancellationTokenSource();
				const cancel = () => cancellation.cancel();
				signal.addEventListener('abort', cancel, { once: true });
				if (signal.aborted) cancellation.cancel();
				try {
					const tokenizationOptions = await createWorkbenchToolTokenizationOptions(
						registeredName,
						modelFamily,
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
			onError: error => this.logger.error(`[Copilot CLI] ${error.message}`),
		});
	}

	private async prepareLaunch(
		bridge: CopilotCliBridge,
		lease: CopilotCliLease,
		target: CopilotCliConnectionTarget,
		retainLaunch: (launch: CopilotCliPreparedLaunch) => void,
	): Promise<PreparedCopilotCliLaunch> {
		const executable = this.pendingExecutable;
		const cwd = this.pendingWorkingDirectory;
		const externalExecutables = this.pendingExternalExecutables;
		this.pendingExecutable = undefined;
		this.pendingWorkingDirectory = undefined;
		this.pendingExternalExecutables = undefined;
		if (!executable || !cwd) throw new Error('Copilot CLI connection preflight did not complete.');
		if (target === 'external' && !externalExecutables) {
			throw new Error('External Copilot CLI connection preflight did not complete.');
		}

		const sessionRoot = vscode.Uri.joinPath(this.context.globalStorageUri, 'copilot-cli', lease.id);
		const agentRoot = vscode.Uri.joinPath(sessionRoot, 'agent');
		const agentsDir = vscode.Uri.joinPath(agentRoot, '.github', 'agents');
		const configUri = vscode.Uri.joinPath(sessionRoot, 'mcp.json');
		const brokerScriptUri = vscode.Uri.joinPath(sessionRoot, 'external-broker.ps1');
		const runnerScriptUri = vscode.Uri.joinPath(sessionRoot, 'external-runner.ps1');
		const descriptorUri = vscode.Uri.joinPath(sessionRoot, 'external-launch.json');
		const startUri = vscode.Uri.joinPath(sessionRoot, 'external-start');
		const stopUri = vscode.Uri.joinPath(sessionRoot, 'external-stop');
		const exitedUri = vscode.Uri.joinPath(sessionRoot, 'external-exited');
		const visiblePidUri = vscode.Uri.joinPath(sessionRoot, 'external-visible-pid');
		let cleanupPromise: Promise<void> | undefined;
		const disposeSessionRoot = () => {
			if (!cleanupPromise) {
				const operation = this.removeSessionRoot(sessionRoot);
				cleanupPromise = operation;
				void operation.catch(() => {
					if (cleanupPromise === operation) cleanupPromise = undefined;
				});
			}
			return cleanupPromise;
		};
		retainLaunch({ dispose: disposeSessionRoot });
		try {
			await vscode.workspace.fs.createDirectory(agentsDir);
			const mainSource = await readText(vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'custom-agent.md'));
			const searchSource = await readText(vscode.Uri.joinPath(this.context.extensionUri, 'copilot-instructions', 'custom-subagent-search.md'));
			const contributions = (this.context.extension.packageJSON.contributes?.languageModelTools || []) as LanguageModelToolContribution[];
			const toolNames = contributions.map(tool => tool.toolReferenceName);
			const serverName = `kusto-workbench-${lease.id.replaceAll('-', '').slice(0, 12)}`;
			const agents = renderCopilotCliAgents({ mainSource, searchSource, serverName, allToolNames: toolNames });
			const args = [
				`--additional-mcp-config=@${configUri.fsPath}`,
				`--add-dir=${agentRoot.fsPath}`,
				`--agent=${MAIN_AGENT_ID}`,
				'--no-remote-export',
			];
			const configBytes = Buffer.from(`${JSON.stringify(createCopilotCliMcpConfig({
				serverName,
				endpoint: bridge.endpoint,
				toolNames,
				token: lease.token,
			}), null, 2)}\n`, 'utf8');
			await publishCopilotCliLaunchAssets({
				writeAgents: async () => {
					const writes = [
						vscode.workspace.fs.writeFile(
							vscode.Uri.joinPath(agentsDir, `${MAIN_AGENT_ID}.agent.md`),
							Buffer.from(agents.main, 'utf8'),
						),
						vscode.workspace.fs.writeFile(
							vscode.Uri.joinPath(agentsDir, `${SEARCH_AGENT_ID}.agent.md`),
							Buffer.from(agents.search, 'utf8'),
						),
					];
					if (target === 'external') {
						writes.push(
							vscode.workspace.fs.writeFile(brokerScriptUri, Buffer.from(EXTERNAL_CLI_BROKER_SCRIPT, 'utf8')),
							vscode.workspace.fs.writeFile(runnerScriptUri, Buffer.from(EXTERNAL_CLI_RUNNER_SCRIPT, 'utf8')),
							vscode.workspace.fs.writeFile(descriptorUri, Buffer.from(createExternalCliLaunchDescriptor({
								cliExecutable: executable,
								arguments: args,
								workingDirectory: cwd.fsPath,
								powerShellExecutable: externalExecutables!.powerShellExecutable,
								taskkillExecutable: externalExecutables!.taskkillExecutable,
								runnerScriptPath: runnerScriptUri.fsPath,
								descriptorPath: descriptorUri.fsPath,
								startPath: startUri.fsPath,
								stopPath: stopUri.fsPath,
								exitedPath: exitedUri.fsPath,
								visiblePidPath: visiblePidUri.fsPath,
							}), 'utf8')),
						);
					}
					await Promise.all(writes);
				},
				writeCredential: () => writeLocalFile(configUri.fsPath, configBytes, { flag: 'wx', mode: 0o600 }).then(() => undefined),
				cleanup: disposeSessionRoot,
			});
			void this.deleteConfigAfterAuthentication(configUri, lease);
			return {
				executable,
				cwd,
				args,
				...(target === 'external' ? {
					external: {
						powerShellExecutable: externalExecutables!.powerShellExecutable,
						taskkillExecutable: externalExecutables!.taskkillExecutable,
						brokerScriptPath: brokerScriptUri.fsPath,
						descriptorPath: descriptorUri.fsPath,
						startPath: startUri.fsPath,
						stopPath: stopUri.fsPath,
						exitedPath: exitedUri.fsPath,
						visiblePidPath: visiblePidUri.fsPath,
					},
				} : {}),
				dispose: disposeSessionRoot,
			};
		} catch (error) {
			try {
				await disposeSessionRoot();
			} catch (cleanupError) {
				throw new AggregateError([error, cleanupError], 'Copilot CLI launch preparation and cleanup both failed.');
			}
			throw error;
		}
	}

	private async removeSessionRoot(sessionRoot: vscode.Uri): Promise<void> {
		try {
			await this.deleteWithRetry(sessionRoot, { recursive: true, useTrash: false });
		} catch (error) {
			this.logger.warn(`[Copilot CLI] Failed to remove session files: ${error instanceof Error ? error.message : String(error)}`);
			throw error;
		}
	}

	private async launchTerminal(
		launch: PreparedCopilotCliLaunch,
		target: CopilotCliConnectionTarget,
		signal: AbortSignal,
	): Promise<CopilotCliTerminal> {
		if (target === 'external') {
			if (!launch.external) throw new Error('External Copilot CLI launch assets are unavailable.');
			return launchExternalCopilotCliTerminal({
				...launch.external,
				workingDirectory: launch.cwd.fsPath,
				signal,
				onClosed: terminalId => this.manager.handleTerminalClosed(terminalId),
				onError: message => this.logger.error(`[Copilot CLI] ${message}`),
			});
		}
		const terminal = vscode.window.createTerminal({
			name: 'Kusto Workbench Copilot CLI',
			shellPath: launch.executable,
			shellArgs: [...launch.args],
			cwd: launch.cwd,
			isTransient: true,
		});
		const id = randomUUID();
		let closed = false;
		this.terminalRecords.set(terminal, { id, markClosed: () => { closed = true; } });
		return {
			id,
			isClosed: () => closed || (terminal.exitStatus !== undefined && terminal.exitStatus !== null),
			show: () => terminal.show(false),
			dispose: () => terminal.dispose(),
		};
	}

	private async deleteConfigAfterAuthentication(configUri: vscode.Uri, lease: CopilotCliLease): Promise<void> {
		if (!await lease.authenticated) return;
		try {
			await this.deleteWithRetry(configUri, { useTrash: false });
		} catch (error) {
			lease.revoke();
			this.logger.error(`[Copilot CLI] Revoked a session whose authenticated configuration could not be removed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async deleteWithRetry(
		uri: vscode.Uri,
		options: { recursive?: boolean; useTrash?: boolean },
	): Promise<void> {
		let lastError: unknown;
		for (let attempt = 0; attempt < 3; attempt++) {
			try {
				await vscode.workspace.fs.delete(uri, options);
				return;
			} catch (error) {
				if (error instanceof vscode.FileSystemError && error.code === 'FileNotFound') return;
				lastError = error;
				if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
			}
		}
		throw lastError;
	}

	private ensureTerminalCloseListener(): void {
		if (this.terminalCloseSubscription) return;
		this.terminalCloseSubscription = vscode.window.onDidCloseTerminal(terminal => {
			const record = this.terminalRecords.get(terminal);
			if (!record) return;
			record.markClosed();
			void this.manager.handleTerminalClosed(record.id).catch(error => {
				this.logger.error(`[Copilot CLI] Terminal cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			});
		});
	}

	private async showDisabledMessage(): Promise<void> {
		void vscode.window.showInformationMessage(
			'Copilot CLI integration is disabled. Enable kustoWorkbench.copilotCli.enabled before connecting.',
			'Open Settings',
		).then(selected => selected === 'Open Settings'
			? vscode.commands.executeCommand('workbench.action.openSettings', `kustoWorkbench.${COPILOT_CLI_ENABLED_SETTING}`)
			: undefined);
	}
}

export function createCopilotCliIntegration(
	context: vscode.ExtensionContext,
	logger: CopilotCliLogger,
): CopilotCliIntegration {
	return new DefaultCopilotCliIntegration(context, logger);
}