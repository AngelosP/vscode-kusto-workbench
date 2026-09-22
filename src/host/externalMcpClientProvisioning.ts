import { execFile } from 'node:child_process';
import type { InstalledExternalMcpConnector } from './externalMcpConnectorInstaller';

export const KUSTO_WORKBENCH_MCP_SERVER_NAME = 'kusto-workbench';
const MCP_TIMEOUT_MS = 7_500_000;

export interface ProcessResult {
	readonly exitCode: number;
	readonly stdout: string;
	readonly stderr: string;
}

export type ExecuteClientCommand = (
	command: string,
	args: readonly string[],
	signal?: AbortSignal,
) => Promise<ProcessResult>;

export interface CopilotCliRegistrationResult {
	readonly changed: boolean;
	readonly reloadRequired: boolean;
	readonly executable: string;
	readonly rollback?: () => Promise<void>;
}

export const executeClientCommand: ExecuteClientCommand = (command, args, signal) => new Promise((resolve, reject) => {
	execFile(command, [...args], { windowsHide: true, timeout: 30_000, signal }, (error, stdout, stderr) => {
		if (error && typeof (error as { code?: unknown }).code !== 'number') {
			reject(error);
			return;
		}
		resolve({
			exitCode: typeof (error as { code?: unknown } | null)?.code === 'number'
				? (error as unknown as { code: number }).code
				: 0,
			stdout,
			stderr,
		});
	});
});

function parseCopilotServers(stdout: string): Record<string, Record<string, unknown>> {
	const parsed = JSON.parse(stdout) as { mcpServers?: unknown };
	if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object' || Array.isArray(parsed.mcpServers)) {
		throw new Error('Copilot CLI returned an invalid MCP server list.');
	}
	return parsed.mcpServers as Record<string, Record<string, unknown>>;
}

async function listCopilotServers(
	executable: string,
	execute: ExecuteClientCommand,
	signal?: AbortSignal,
): Promise<Record<string, Record<string, unknown>>> {
	const result = await execute(executable, ['mcp', 'list', '--json'], signal);
	if (result.exitCode !== 0) {
		throw new Error(`Copilot CLI could not list MCP servers: ${(result.stderr || result.stdout).trim()}`);
	}
	return parseCopilotServers(result.stdout);
}

function exactRegistration(
	server: Record<string, unknown>,
	connector: Pick<InstalledExternalMcpConnector, 'command' | 'args'>,
): boolean {
	return (server.type === 'stdio' || server.type === 'local')
		&& server.command === connector.command
		&& JSON.stringify(server.args) === JSON.stringify(connector.args)
		&& JSON.stringify(server.tools) === JSON.stringify(['*']);
}

async function requireSuccess(
	executable: string,
	args: readonly string[],
	execute: ExecuteClientCommand,
	signal?: AbortSignal,
): Promise<void> {
	const result = await execute(executable, args, signal);
	if (result.exitCode !== 0) {
		throw new Error(`Copilot CLI command failed: ${(result.stderr || result.stdout).trim()}`);
	}
}

async function rollbackAddedRegistration(
	executable: string,
	connector: InstalledExternalMcpConnector,
	execute: ExecuteClientCommand,
	cause: unknown,
): Promise<never> {
	try {
		const current = (await listCopilotServers(executable, execute))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
		if (!current || current.source !== 'user' || !exactRegistration(current, connector)) {
			throw new Error('The Kusto Workbench registration changed before rollback and was left untouched.');
		}
		await requireSuccess(executable, ['mcp', 'remove', KUSTO_WORKBENCH_MCP_SERVER_NAME], execute);
		const remaining = (await listCopilotServers(executable, execute))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
		if (remaining?.source === 'user' && exactRegistration(remaining, connector)) {
			throw new Error('Copilot CLI still reports the Kusto Workbench registration after rollback.');
		}
	} catch (rollbackError) {
		throw new AggregateError(
			[cause, rollbackError],
			'Copilot CLI setup failed and the newly added Kusto Workbench registration could not be removed.',
		);
	}
	throw cause;
}

async function rollbackEnabledRegistration(
	executable: string,
	connector: InstalledExternalMcpConnector,
	execute: ExecuteClientCommand,
	cause: unknown,
): Promise<never> {
	try {
		const current = (await listCopilotServers(executable, execute))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
		if (!current || current.source !== 'user' || current.enabled === false
			|| !exactRegistration(current, connector)) {
			throw new Error('The Kusto Workbench registration changed before rollback and was left untouched.');
		}
		await requireSuccess(executable, ['mcp', 'disable', KUSTO_WORKBENCH_MCP_SERVER_NAME], execute);
		const remaining = (await listCopilotServers(executable, execute))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
		if (!remaining || remaining.source !== 'user' || remaining.enabled !== false
			|| !exactRegistration(remaining, connector)) {
			throw new Error('Copilot CLI did not restore the disabled Kusto Workbench registration.');
		}
	} catch (rollbackError) {
		throw new AggregateError(
			[cause, rollbackError],
			'Copilot CLI setup failed and the previously disabled Kusto Workbench registration could not be disabled again.',
		);
	}
	throw cause;
}

export async function reconcileCopilotCliRegistration(options: {
	executable: string;
	connector: InstalledExternalMcpConnector;
	execute?: ExecuteClientCommand;
	signal?: AbortSignal;
}): Promise<CopilotCliRegistrationResult> {
	const execute = options.execute ?? executeClientCommand;
	const servers = await listCopilotServers(options.executable, execute, options.signal);
	const existing = servers[KUSTO_WORKBENCH_MCP_SERVER_NAME];
	let changed = false;
	if (existing && !exactRegistration(existing, options.connector)) {
		throw new Error(
			`Copilot CLI already resolves ${KUSTO_WORKBENCH_MCP_SERVER_NAME} from ${String(existing.source || 'another source')} with different settings. `
			+ 'The existing registration was not modified. Remove or rename it explicitly, then run setup again.',
		);
	}
	let added = false;
	let enabledByThisCall = false;
	if (!existing) {
		await requireSuccess(options.executable, [
			'mcp',
			'add',
			'--tools',
			'*',
			'--timeout',
			String(MCP_TIMEOUT_MS),
			KUSTO_WORKBENCH_MCP_SERVER_NAME,
			'--',
			options.connector.command,
			...options.connector.args,
		], execute, options.signal);
		changed = true;
		added = true;
	} else if (existing.enabled === false) {
		if (existing.source !== 'user') {
			throw new Error(
				`The disabled ${KUSTO_WORKBENCH_MCP_SERVER_NAME} registration comes from ${String(existing.source || 'another source')} and was not modified.`,
			);
		}
		await requireSuccess(
			options.executable,
			['mcp', 'enable', KUSTO_WORKBENCH_MCP_SERVER_NAME],
			execute,
			options.signal,
		);
		changed = true;
		enabledByThisCall = true;
	}
	let verified: Record<string, unknown> | undefined;
	try {
		verified = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
	} catch (error) {
		if (added) return rollbackAddedRegistration(options.executable, options.connector, execute, error);
		if (enabledByThisCall) return rollbackEnabledRegistration(options.executable, options.connector, execute, error);
		throw error;
	}
	if (!verified || !exactRegistration(verified, options.connector) || verified.enabled === false) {
		if (added) {
			return rollbackAddedRegistration(
				options.executable,
				options.connector,
				execute,
				new Error('Copilot CLI did not retain the intended Kusto Workbench MCP registration.'),
			);
		}
		if (enabledByThisCall) {
			return rollbackEnabledRegistration(
				options.executable,
				options.connector,
				execute,
				new Error('Copilot CLI did not retain the intended Kusto Workbench MCP registration.'),
			);
		}
		throw new Error('Copilot CLI did not retain the intended Kusto Workbench MCP registration.');
	}
	const rollback = added
		? async () => {
			const current = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
			if (!current || current.source !== 'user' || !exactRegistration(current, options.connector)) {
				throw new Error('The Kusto Workbench registration changed before compensation and was left untouched.');
			}
			await requireSuccess(
				options.executable, ['mcp', 'remove', KUSTO_WORKBENCH_MCP_SERVER_NAME], execute, options.signal,
			);
			const remaining = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
			if (remaining?.source === 'user' && exactRegistration(remaining, options.connector)) {
				throw new Error('Copilot CLI still reports the Kusto Workbench registration after compensation.');
			}
		}
		: enabledByThisCall
			? async () => {
				const current = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
				if (!current || current.source !== 'user' || current.enabled === false
					|| !exactRegistration(current, options.connector)) {
					throw new Error('The Kusto Workbench registration changed before compensation and was left untouched.');
				}
				await requireSuccess(
					options.executable, ['mcp', 'disable', KUSTO_WORKBENCH_MCP_SERVER_NAME], execute, options.signal,
				);
				const remaining = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
				if (!remaining || remaining.source !== 'user' || remaining.enabled !== false
					|| !exactRegistration(remaining, options.connector)) {
					throw new Error('Copilot CLI did not restore the disabled Kusto Workbench registration.');
				}
			}
			: undefined;
	return { changed, reloadRequired: changed, executable: options.executable, ...(rollback ? { rollback } : {}) };
}

export async function removeCopilotCliRegistration(options: {
	executable: string;
	connector: Pick<InstalledExternalMcpConnector, 'command' | 'args'>;
	execute?: ExecuteClientCommand;
	signal?: AbortSignal;
}): Promise<{ removed: boolean }> {
	const execute = options.execute ?? executeClientCommand;
	const existing = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
	if (!existing) return { removed: false };
	if (existing.source !== 'user') {
		throw new Error(`The ${KUSTO_WORKBENCH_MCP_SERVER_NAME} server comes from ${String(existing.source || 'another source')} and was not modified.`);
	}
	if (!exactRegistration(existing, options.connector)) {
		throw new Error(`The ${KUSTO_WORKBENCH_MCP_SERVER_NAME} user registration has different settings and was not removed.`);
	}
	await requireSuccess(
		options.executable,
		['mcp', 'remove', KUSTO_WORKBENCH_MCP_SERVER_NAME],
		execute,
		options.signal,
	);
	const remaining = (await listCopilotServers(options.executable, execute, options.signal))[KUSTO_WORKBENCH_MCP_SERVER_NAME];
	if (remaining?.source === 'user' && exactRegistration(remaining, options.connector)) {
		throw new Error('Copilot CLI still reports the Kusto Workbench user registration after removal.');
	}
	return { removed: true };
}