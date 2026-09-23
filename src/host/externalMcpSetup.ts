import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, readdir, rename, rm } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import {
	acquireExternalMcpConnectorLock,
	installExternalMcpConnector,
	type InstalledExternalMcpConnector,
} from './externalMcpConnectorInstaller';
import { releaseLockPreservingError } from './lockRelease';
import {
	executeClientCommand,
	KUSTO_WORKBENCH_MCP_SERVER_NAME,
	removeCopilotCliRegistration,
} from './externalMcpClientProvisioning';
import { removeCopilotCliAgent } from './externalCopilotAgent';
import { reconcileCopilotCliIntegration } from './externalCopilotIntegration';
import { configureScoutIntegration } from './externalScoutIntegration';
import { removeScoutSkill } from './externalScoutSkill';
import { inspectScoutMcpRegistration, preflightScoutMcpRegistration, removeScoutMcpRegistration } from './externalScoutMcpProvisioning';
import {
	configureCopilotCodeIntegration,
	discoverCopilotCodeTargets,
	inspectCopilotCodeIntegration,
	preflightCopilotCodeIntegration,
	removeCopilotCodeIntegration,
	type CopilotCodeTarget,
} from './externalCopilotCodeIntegration';

export type ExternalMcpClientKind = 'copilot-cli' | 'scout' | 'copilot-code' | 'other';
const MAIN_EXTENSION_ID = 'angelos-petropoulos.vscode-kusto-workbench';
const BOOTSTRAP_EXTENSION_ID = 'angelos-petropoulos.kusto-workbench-mcp-bootstrap';

export interface ExternalMcpSetupLogger {
	error(message: string): void;
	warn(message: string): void;
	info(message: string): void;
}

export interface ExternalMcpSetupResult {
	readonly client: ExternalMcpClientKind;
	readonly integrationEnabled: boolean;
	readonly fullyConfigured: boolean;
	readonly requiresClientReload?: boolean;
	readonly requiresManualClientSetup?: boolean;
}

export function assertExternalToolsConfigurationRegistered(inspected: unknown): void {
	if (inspected) return;
	throw new Error(
		'This VS Code window has not loaded the current Kusto Workbench configuration. '
		+ 'Run Developer: Reload Window, then run this command again.',
	);
}

function runFile(
	command: string,
	args: readonly string[],
	env?: NodeJS.ProcessEnv,
	windowsVerbatimArguments = false,
): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		execFile(command, [...args], {
			windowsHide: true,
			timeout: 30_000,
			env,
			windowsVerbatimArguments,
		}, (error, stdout) => {
			if (error) reject(error);
			else resolve(stdout);
		});
	});
}

function vscodeCliEntry(): { commandFile: string; profileArgs: readonly string[] } {
	if (basename(process.execPath).toLowerCase() !== 'code.exe') {
		throw new Error('The supported VS Code desktop CLI could not be identified from this extension host.');
	}
	return { commandFile: join(dirname(process.execPath), 'bin', 'code.cmd'), profileArgs: [] };
}

function quoteCmdArgument(value: string): string {
	if (/[\r\n"%!&|<>^]/.test(value)) throw new Error('The VS Code profile or path contains characters unsupported by the command-line installer.');
	return `"${value}"`;
}

export function executeVsCodeCli(
	cli: { commandFile: string; profileArgs: readonly string[] },
	args: readonly string[],
): Promise<string> {
	const comSpec = process.env.ComSpec;
	if (!comSpec) throw new Error('The Windows command processor is unavailable.');
	const commandLine = `"${[cli.commandFile, ...cli.profileArgs, ...args].map(quoteCmdArgument).join(' ')}"`;
	return runFile(comSpec, ['/d', '/s', '/c', commandLine], undefined, true);
}

export async function resolveCopilotCliExecutable(systemRoot = process.env.SystemRoot): Promise<string> {
	if (!systemRoot) throw new Error('The Windows system directory is unavailable.');
	let output: string;
	try {
		output = await runFile(join(systemRoot, 'System32', 'where.exe'), ['copilot']);
	} catch {
		throw new Error('GitHub Copilot CLI was not found on PATH. Install it, then run setup again.');
	}
	const candidates = output.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
	const executable = candidates.find(candidate => candidate.toLowerCase().endsWith('.exe'));
	if (!executable) throw new Error('A supported GitHub Copilot CLI executable was not found on PATH.');
	return executable;
}

export function createGenericMcpConfiguration(connector: InstalledExternalMcpConnector): object {
	return {
		mcpServers: {
			[KUSTO_WORKBENCH_MCP_SERVER_NAME]: {
				type: 'stdio',
				command: connector.command,
				args: [...connector.args],
				tools: ['*'],
			},
		},
	};
}

async function chooseVsCodeProfile(): Promise<{ profileName?: string } | undefined> {
	const selection = await vscode.window.showQuickPick([
		{ label: 'Default Profile', value: 'default' as const },
		{ label: 'Named profile...', value: 'named' as const },
	], {
		title: 'VS Code profile for Kusto Workbench external tools',
		placeHolder: 'Choose a profile where the Kusto Workbench extension is already installed',
		ignoreFocusOut: true,
	});
	if (!selection) return undefined;
	if (selection.value === 'default') return {};
	const profileName = (await vscode.window.showInputBox({
		title: 'Current VS Code profile name',
		prompt: 'Enter the exact profile name where Kusto Workbench is installed. The extension API does not expose it automatically.',
		ignoreFocusOut: true,
		validateInput: value => value.trim() ? undefined : 'A profile name is required.',
	}))?.trim();
	return profileName ? { profileName } : undefined;
}

async function chooseClient(preselected?: ExternalMcpClientKind): Promise<ExternalMcpClientKind | undefined> {
	if (preselected) return preselected;
	const picked = await vscode.window.showQuickPick([
		{ label: 'Copilot CLI', clientKind: 'copilot-cli' as const, description: 'Configure automatically through copilot mcp' },
		{ label: 'Microsoft Scout', clientKind: 'scout' as const, description: 'Configure the MCP server and Kusto Workbench skill automatically' },
		{ label: 'Microsoft Copilot (Code)', clientKind: 'copilot-code' as const, description: 'Configure local Code sessions with MCP tools and a Workbench skill' },
		{ label: 'Other MCP client...', clientKind: 'other' as const, description: 'Copy portable STDIO configuration guidance' },
	], { title: 'Configure integration with external tools', placeHolder: 'Choose an MCP client to configure or reconfigure' });
	return picked?.clientKind;
}

async function chooseCopilotCodeTarget(localAppData: string): Promise<CopilotCodeTarget> {
	const targets = await discoverCopilotCodeTargets(localAppData);
	if (targets.length === 1) return targets[0];
	const picked = await vscode.window.showQuickPick(targets.map(target => ({
		label: `Code account ${target.accountId}`,
		detail: target.copilotHomeDirectory,
		target,
	})), { title: 'Microsoft Copilot Code account', placeHolder: 'Choose the Code account to configure; other accounts are left unchanged', ignoreFocusOut: true });
	if (!picked) throw new vscode.CancellationError();
	return picked.target;
}

async function installForCurrentWindow(
	context: vscode.ExtensionContext,
	profile: { profileName?: string },
): Promise<InstalledExternalMcpConnector> {
	const localAppData = process.env.LOCALAPPDATA;
	const systemRoot = process.env.SystemRoot;
	if (process.platform !== 'win32' || process.arch !== 'x64' || !localAppData || !systemRoot) {
		throw new Error('External tools integration currently supports local Windows x64 desktop installations only.');
	}
	if (vscode.env.remoteName !== undefined || vscode.env.uiKind !== vscode.UIKind.Desktop) {
		throw new Error('External tools integration cannot be configured from a remote or web extension host.');
	}
	const profileName = profile.profileName;
	const cliBase = vscodeCliEntry();
	const cli = {
		...cliBase,
		profileArgs: profileName ? ['--profile', profileName] : [],
	};
	await installProviderBootstrap({ context, cli });
	return installExternalMcpConnector({
		context,
		localAppData,
		systemRoot,
		codeExecutable: process.execPath,
		profileName,
		sharedLockAlreadyHeld: true,
	});
}

export async function updateExternalToolsEnabledWithRollback(
	update: () => PromiseLike<void>,
	rollback?: () => Promise<void>,
): Promise<void> {
	try {
		await update();
	} catch (error) {
		if (!rollback) throw error;
		try {
			await rollback();
		} catch (rollbackError) {
			throw new AggregateError(
				[error, rollbackError],
				'External MCP setup failed and the client registration could not be restored.',
			);
		}
		throw error;
	}
}

export async function runExternalMcpSetup(
	context: vscode.ExtensionContext,
	logger: ExternalMcpSetupLogger,
	preselected?: ExternalMcpClientKind,
): Promise<ExternalMcpSetupResult | undefined> {
	assertExternalToolsConfigurationRegistered(
		vscode.workspace.getConfiguration('kustoWorkbench').inspect<boolean>('externalTools.enabled'),
	);
	const client = await chooseClient(preselected);
	if (!client) return undefined;
	const consent = await vscode.window.showWarningMessage(
		'Kusto Workbench will download an official Node runtime from nodejs.org, verify its SHA-256 digest, and install it with a local STDIO MCP connector under your user profile. The verified archive is cached for repair. A small companion extension will be installed in the selected VS Code profile, and the provider will be enabled application-wide so external clients can launch or operate Workbench windows. Copilot CLI setup also installs a managed user-level agent. Scout setup adds the MCP server and a skill; close Scout before first-time registration. Microsoft Copilot (Code) setup installs an MCP-and-skill plugin in its separate Code account, not Chat or Cowork. Existing integrations and approval settings are preserved. Client and enterprise approval policies still apply.',
		{ modal: true },
		'Continue',
	);
	if (consent !== 'Continue') return undefined;
	const profile = await chooseVsCodeProfile();
	if (!profile) throw new vscode.CancellationError();
	const localAppData = process.env.LOCALAPPDATA;
	const systemRoot = process.env.SystemRoot;
	if (!localAppData || !systemRoot) {
		throw new Error('External tools integration currently supports local Windows x64 desktop installations only.');
	}
	const copilotExecutable = client === 'copilot-cli' ? await resolveCopilotCliExecutable() : undefined;
	const copilotAgentSource = client === 'copilot-cli'
		? await readFile(join(context.extensionUri.fsPath, 'copilot-instructions', 'external-copilot-agent.md'), 'utf8')
		: undefined;
	const scoutSkillSource = client === 'scout' || client === 'copilot-code'
		? await readFile(join(context.extensionUri.fsPath, 'copilot-instructions', 'external-scout-skill.md'), 'utf8')
		: undefined;
	const codeTarget = client === 'copilot-code' ? await chooseCopilotCodeTarget(localAppData) : undefined;
	if (codeTarget) await preflightCopilotCodeIntegration({ target: codeTarget, localAppData });
	if (client === 'scout') {
		const connectorRoot = join(localAppData, 'KustoWorkbench', 'McpConnector');
		await preflightScoutMcpRegistration({ connector: {
			command: join(connectorRoot, 'node.exe'), args: [join(connectorRoot, 'bootstrap.cjs')],
		} });
	}
	const release = await acquireExternalMcpConnectorLock(localAppData, systemRoot);
	let operationError: unknown;
	let result!: ExternalMcpSetupResult;
	let notice: (() => void) | undefined;
	try {
		const connector = await vscode.window.withProgress({
			location: vscode.ProgressLocation.Notification,
			title: 'Installing Kusto Workbench MCP connector and verified runtime...',
			cancellable: false,
		}, () => installForCurrentWindow(context, profile));
		if (client === 'copilot-cli') {
			const integration = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Configuring GitHub Copilot CLI and Kusto Workbench agent...',
				cancellable: false,
			}, () => reconcileCopilotCliIntegration({
				executable: copilotExecutable!,
				connector,
				agentSourceContent: copilotAgentSource!,
			}));
			await updateExternalToolsEnabledWithRollback(
				() => vscode.workspace.getConfiguration('kustoWorkbench')
					.update('externalTools.enabled', true, vscode.ConfigurationTarget.Global),
				integration.rollback,
			);
			result = { client, integrationEnabled: true, fullyConfigured: true, requiresClientReload: integration.reloadRequired };
			notice = () => {
				void vscode.window.showInformationMessage(integration.reloadRequired
					? 'Kusto Workbench is configured for Copilot CLI, including its user-level agent. Start a new CLI session. Tool approvals remain controlled by Copilot CLI.'
					: 'Kusto Workbench and its user-level agent are already configured for Copilot CLI.');
				logger.info(`[External MCP] Copilot CLI registration and user-level agent verified (${integration.agent.status}).`);
			};
		} else if (client === 'scout') {
			const integration = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Configuring Microsoft Scout MCP server and Kusto Workbench skill...',
				cancellable: false,
			}, () => configureScoutIntegration({
				connector,
				skillSourceContent: scoutSkillSource!,
				enableProvider: () => vscode.workspace.getConfiguration('kustoWorkbench')
					.update('externalTools.enabled', true, vscode.ConfigurationTarget.Global),
			}));
			result = {
				client,
				integrationEnabled: true,
				fullyConfigured: true,
				requiresClientReload: integration.requiresRestart || integration.requiresNewConversation,
			};
			notice = () => {
				void vscode.window.showInformationMessage(integration.requiresRestart
					? 'Kusto Workbench is configured for Microsoft Scout, including its MCP server and skill. Open or restart Scout, then start a new conversation. Tool approvals remain controlled by Scout.'
					: 'Kusto Workbench MCP registration and skill are configured for Microsoft Scout. Start a new conversation to use the skill.');
				logger.info(`[External MCP] Scout registration verified (${integration.registration.changed ? 'installed' : 'existing'}); skill verified (${integration.skill.status}).`);
			};
		} else if (client === 'copilot-code') {
			const integration = await vscode.window.withProgress({
				location: vscode.ProgressLocation.Notification,
				title: 'Configuring Kusto Workbench plugin for Microsoft Copilot Code...',
				cancellable: false,
			}, () => configureCopilotCodeIntegration({
				target: codeTarget!, localAppData, connector, skillSourceContent: scoutSkillSource!,
				enableProvider: () => vscode.workspace.getConfiguration('kustoWorkbench')
					.update('externalTools.enabled', true, vscode.ConfigurationTarget.Global),
			}));
			result = { client, integrationEnabled: true, fullyConfigured: true, requiresClientReload: integration.requiresClientReload };
			notice = () => {
				void vscode.window.showInformationMessage(integration.requiresClientReload
					? 'Kusto Workbench is registered for Microsoft Copilot Code. Quit and reopen Copilot, then start a new Local Code session and ask to use Kusto Workbench. Local plugins may not appear in Customize. Review Code\'s MCP tool approval prompts.'
					: 'Kusto Workbench is already registered for Microsoft Copilot Code. Start a new Local Code session and ask to use Kusto Workbench. Local plugins may not appear in Customize. Review Code\'s MCP tool approval prompts.');
				logger.info(`[External MCP] Microsoft Copilot Code plugin verified (${integration.managed ? 'managed' : 'existing'}).`);
			};
		} else {
			await vscode.env.clipboard.writeText(JSON.stringify(createGenericMcpConfiguration(connector), null, 2));
			await vscode.workspace.getConfiguration('kustoWorkbench')
				.update('externalTools.enabled', true, vscode.ConfigurationTarget.Global);
			result = { client, integrationEnabled: true, fullyConfigured: false, requiresManualClientSetup: true };
			notice = () => {
				void vscode.window.showInformationMessage(
					'Portable STDIO MCP configuration was copied to the clipboard. Apply its command and arguments using your client’s documented MCP setup flow.',
				);
			};
		}
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		await releaseLockPreservingError(
			release,
			operationError,
			'External MCP setup failed while releasing its shared lock.',
		);
	}
	notice?.();
	return result;
}

export async function showExternalMcpStatus(): Promise<void> {
	assertExternalToolsConfigurationRegistered(
		vscode.workspace.getConfiguration('kustoWorkbench').inspect<boolean>('externalTools.enabled'),
	);
	const enabled = vscode.workspace.getConfiguration('kustoWorkbench').get<boolean>('externalTools.enabled', false);
	const root = process.env.LOCALAPPDATA
		? join(process.env.LOCALAPPDATA, 'KustoWorkbench', 'McpConnector')
		: undefined;
	let installed = false;
	let connectorVersion = 'not installed';
	if (root) {
		try {
			const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as { connectorVersion?: unknown };
			installed = true;
			connectorVersion = String(current.connectorVersion || 'unknown');
		} catch {
			installed = false;
		}
	}
	let copilot = 'not detected';
	try {
		const executable = await resolveCopilotCliExecutable();
		const result = await executeClientCommand(executable, ['mcp', 'list', '--json']);
		if (result.exitCode === 0) {
			const servers = JSON.parse(result.stdout) as { mcpServers?: Record<string, { enabled?: boolean }> };
			const registration = servers.mcpServers?.[KUSTO_WORKBENCH_MCP_SERVER_NAME];
			copilot = registration ? (registration.enabled === false ? 'configured, disabled' : 'configured, enabled') : 'not configured';
		}
	} catch {
		// Keep status useful when Copilot CLI is absent.
	}
	let scout = 'not configured';
	if (root) {
		try {
			const registration = await inspectScoutMcpRegistration({ connector: { command: join(root, 'node.exe'), args: [join(root, 'bootstrap.cjs')] } });
			if (registration.configured) scout = registration.managed ? 'configured, managed' : 'configured, existing registration';
		} catch {
			scout = 'configuration unavailable or conflicting; inspect Scout Extensions > MCP Servers';
		}
	}
	let copilotCode = 'not initialized';
	try {
		const targets = await discoverCopilotCodeTargets();
		const installed = await Promise.all(targets.map(target => inspectCopilotCodeIntegration(target)));
		copilotCode = `${installed.filter(Boolean).length} of ${targets.length} Code accounts have the Workbench plugin`;
	} catch {
		copilotCode = 'unavailable or not initialized; open Copilot > Code';
	}
	void vscode.window.showInformationMessage(
		`External tools provider: ${enabled ? 'enabled' : 'disabled'}; connector: ${installed ? connectorVersion : 'not installed'}; Copilot CLI: ${copilot}; Scout: ${scout}; Microsoft Copilot: ${copilotCode}.`,
		{ modal: true },
	);
}

export async function disableExternalMcpIntegration(): Promise<void> {
	assertExternalToolsConfigurationRegistered(
		vscode.workspace.getConfiguration('kustoWorkbench').inspect<boolean>('externalTools.enabled'),
	);
	const choices = await vscode.window.showQuickPick([
		{ label: 'Disable Kusto Workbench provider', id: 'provider', picked: true },
		{ label: 'Remove Copilot CLI registration and managed agent', id: 'copilot', picked: false },
		{ label: 'Remove managed Scout MCP registration and skill', id: 'scout', picked: false },
		{ label: 'Remove Microsoft Copilot (Code) managed plugin', id: 'copilot-code', picked: false },
		{ label: 'Show other MCP client removal instructions', id: 'other', picked: false },
		{ label: 'Uninstall startup bootstrap from a VS Code profile...', id: 'bootstrap', picked: false },
		{ label: 'Remove the installed local connector', id: 'connector', picked: false },
	], {
		title: 'Disable integration with external tools',
		placeHolder: 'Choose the integration parts to disable or remove',
		canPickMany: true,
	});
	if (!choices) return;
	const selected = new Set(choices.map(choice => choice.id));
	let bootstrapCli: { commandFile: string; profileArgs: readonly string[] } | undefined;
	if (selected.has('bootstrap')) {
		const profile = await chooseVsCodeProfile();
		if (!profile) throw new vscode.CancellationError();
		const cli = vscodeCliEntry();
		bootstrapCli = {
			...cli,
			profileArgs: profile.profileName ? ['--profile', profile.profileName] : [],
		};
	}
	let codeTarget: CopilotCodeTarget | undefined;
	let codeTargetError: unknown;
	if (selected.has('copilot-code')) {
		try {
			if (!process.env.LOCALAPPDATA) throw new Error('The local application data directory is unavailable.');
			codeTarget = await chooseCopilotCodeTarget(process.env.LOCALAPPDATA);
		} catch (error) {
			if (error instanceof vscode.CancellationError) return;
			codeTargetError = error;
		}
	}
	const requiresLock = ['provider', 'copilot', 'scout', 'copilot-code', 'bootstrap', 'connector'].some(id => selected.has(id));
	const localAppData = process.env.LOCALAPPDATA;
	if (requiresLock && !localAppData) throw new Error('The local application data directory is unavailable.');
	const release = requiresLock ? await acquireExternalMcpConnectorLock(localAppData!) : undefined;
	let operationError: unknown;
	const failures: string[] = [];
	const runCleanup = async (label: string, action: () => Promise<void>): Promise<void> => {
		try {
			await action();
		} catch (error) {
			failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		}
	};
	try {
		if (selected.has('provider')) {
			await runCleanup('Disable provider', async () => {
				await vscode.workspace.getConfiguration('kustoWorkbench')
					.update('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
			});
		}
		if (selected.has('copilot')) {
			await runCleanup('Remove Copilot CLI registration', async () => {
				const executable = await resolveCopilotCliExecutable();
				const connectorRoot = join(localAppData!, 'KustoWorkbench', 'McpConnector');
				await removeCopilotCliRegistration({
					executable,
					connector: {
						command: join(connectorRoot, 'node.exe'),
						args: [join(connectorRoot, 'bootstrap.cjs')],
					},
				});
			});
			await runCleanup('Remove Copilot CLI managed agent', async () => {
				await removeCopilotCliAgent();
			});
		}
		if (selected.has('scout')) {
			await runCleanup('Remove managed Scout MCP registration', async () => {
				const connectorRoot = join(localAppData!, 'KustoWorkbench', 'McpConnector');
				const connector = { command: join(connectorRoot, 'node.exe'), args: [join(connectorRoot, 'bootstrap.cjs')] };
				await removeScoutMcpRegistration({ connector });
				if ((await inspectScoutMcpRegistration({ connector })).configured) {
					void vscode.window.showWarningMessage('An existing Scout MCP registration was preserved because Workbench did not create it. Remove it in Scout Extensions > MCP Servers if no longer needed.');
				}
			});
			await runCleanup('Remove managed Scout skill', async () => {
				await removeScoutSkill();
			});
		}
		if (selected.has('other')) {
			await runCleanup('Copy MCP client removal instructions', async () => {
				await vscode.env.clipboard.writeText('Use your MCP client’s documented server-management flow to remove the server named "kusto-workbench". Kusto Workbench does not edit client configuration files directly.');
			});
		}
		if (selected.has('copilot-code')) {
			await runCleanup('Remove Microsoft Copilot Code plugin', async () => {
				if (!codeTarget) throw codeTargetError;
				const removal = await removeCopilotCodeIntegration({ target: codeTarget, localAppData });
				if (removal.existingPreserved) {
					void vscode.window.showWarningMessage('The existing Copilot Code Workbench plugin was preserved because this setup did not install it. Manage it through Code > Customize.');
				}
			});
		}
		if (bootstrapCli) {
			await runCleanup('Uninstall startup bootstrap', () => uninstallProviderBootstrap(bootstrapCli!));
		}
		if (selected.has('connector')) {
			await runCleanup('Remove local connector', async () => {
				await vscode.workspace.getConfiguration('kustoWorkbench')
					.update('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
				await removeInstalledExternalMcpConnector(localAppData, true);
			});
		}
		if (failures.length > 0) throw new Error(`Some external integration cleanup steps failed: ${failures.join('; ')}`);
	} catch (error) {
		operationError = error;
		throw error;
	} finally {
		if (release) {
			await releaseLockPreservingError(
				release,
				operationError,
				'External MCP cleanup failed while releasing its shared lock.',
			);
		}
	}
	void vscode.window.showInformationMessage('Selected Kusto Workbench external integration settings were updated.');
}

export async function removeInstalledExternalMcpConnector(
	localAppData = process.env.LOCALAPPDATA,
	sharedLockAlreadyHeld = false,
): Promise<void> {
	if (!localAppData) throw new Error('The local application data directory is unavailable.');
	const productRoot = join(localAppData, 'KustoWorkbench');
	const root = join(productRoot, 'McpConnector');
	const quarantine = join(productRoot, `.mcp-connector-remove-${randomUUID()}`);
	const release = sharedLockAlreadyHeld ? undefined : await acquireExternalMcpConnectorLock(localAppData);
	let operationError: unknown;
	try {
		for (const entry of await readdir(productRoot, { withFileTypes: true })) {
			if (entry.isDirectory() && entry.name.startsWith('.mcp-connector-remove-')) {
				await rm(join(productRoot, entry.name), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
			}
		}
		try {
			await rename(root, quarantine);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
			throw error;
		}
		await rm(quarantine, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
	} catch (error) {
		const wrapped = new Error('The local connector could not be removed. Close external MCP clients using Kusto Workbench, then try again.', { cause: error });
		operationError = wrapped;
		throw wrapped;
	} finally {
		if (release) {
			await releaseLockPreservingError(
				release,
				operationError,
				'External MCP connector removal failed while releasing its shared lock.',
			);
		}
	}
}

export async function installProviderBootstrap(options: {
	context: vscode.ExtensionContext;
	cli: { commandFile: string; profileArgs: readonly string[] };
}): Promise<void> {
	const expectedVersion = String(options.context.extension.packageJSON.version || '').trim().toLowerCase();
	if (!expectedVersion) throw new Error('The current Kusto Workbench extension version is unavailable.');
	const beforeInstall = await executeVsCodeCli(options.cli, ['--list-extensions', '--show-versions']);
	const beforeExtensionIds = beforeInstall.split(/\r?\n/).map(line => line.trim().toLowerCase());
	const installedWorkbench = beforeExtensionIds.find(line => line.startsWith(`${MAIN_EXTENSION_ID}@`));
	if (!installedWorkbench) {
		throw new Error('Kusto Workbench is not installed in the selected VS Code profile. Install this VSIX in that profile, then run configuration again.');
	}
	if (installedWorkbench !== `${MAIN_EXTENSION_ID}@${expectedVersion}`) {
		const installedVersion = installedWorkbench.slice(MAIN_EXTENSION_ID.length + 1);
		throw new Error(
			`The selected VS Code profile has Kusto Workbench ${installedVersion} installed, but this setup requires ${expectedVersion}. `
			+ 'Install this VSIX in that profile, then run configuration again.',
		);
	}
	const vsixPath = vscode.Uri.joinPath(
		options.context.extensionUri,
		'dist',
		'mcp-connector',
		'kusto-workbench-mcp-bootstrap.vsix',
	).fsPath;
	await executeVsCodeCli(options.cli, ['--install-extension', vsixPath, '--force']);
	const installed = await executeVsCodeCli(options.cli, ['--list-extensions', '--show-versions']);
	const extensionIds = installed.split(/\r?\n/).map(line => line.trim().toLowerCase());
	if (!extensionIds.some(line => line.startsWith(`${BOOTSTRAP_EXTENSION_ID}@`))) {
		throw new Error('VS Code did not retain the Kusto Workbench external-tools startup bootstrap.');
	}
	if (!extensionIds.includes(`${MAIN_EXTENSION_ID}@${expectedVersion}`)) {
		throw new Error('The selected VS Code profile no longer contains the required Kusto Workbench version.');
	}
}

export async function uninstallProviderBootstrap(cli: { commandFile: string; profileArgs: readonly string[] }): Promise<void> {
	let installed = await executeVsCodeCli(cli, ['--list-extensions']);
	if (!installed.split(/\r?\n/).some(line => line.trim().toLowerCase() === BOOTSTRAP_EXTENSION_ID)) return;
	await executeVsCodeCli(cli, ['--uninstall-extension', BOOTSTRAP_EXTENSION_ID]);
	installed = await executeVsCodeCli(cli, ['--list-extensions']);
	if (installed.split(/\r?\n/).some(line => line.trim().toLowerCase() === BOOTSTRAP_EXTENSION_ID)) {
		throw new Error('VS Code still reports the Kusto Workbench external-tools startup bootstrap after uninstall.');
	}
}