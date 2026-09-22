import type { ExternalMcpCatalog } from '../shared/externalMcpCatalog';

export interface WorkbenchProviderDescriptor {
	readonly protocolVersion: 1;
	readonly instanceId: string;
	readonly displayName: string;
	readonly extensionVersion: string;
	readonly schemaHash: string;
	readonly processId: number;
	readonly startedAt: string;
	readonly workspaceFolders: readonly string[];
	readonly workspaceFile?: string;
	readonly launchRequestId?: string;
	readonly endpoint: string;
	readonly token: string;
}

export interface PublicWorkbenchInstance {
	readonly instanceId: string;
	readonly displayName: string;
	readonly extensionVersion: string;
	readonly processId: number;
	readonly startedAt: string;
	readonly workspaceFolders: readonly string[];
	readonly workspaceFile?: string;
	readonly compatible: boolean;
}

export interface ConnectorToolResult {
	readonly content: readonly { readonly type: 'text'; readonly text: string }[];
	readonly isError?: boolean;
}

export interface LaunchWorkbenchRequest {
	readonly workspaceFolder: string;
	readonly timeoutMs?: number;
}

export interface WorkbenchLaunch {
	cleanup(options?: Readonly<{ preserveForLateLaunch?: boolean }>): Promise<void>;
}

export interface ExternalMcpConnectorDependencies {
	discoverProviders(signal?: AbortSignal): Promise<readonly WorkbenchProviderDescriptor[]>;
	invokeProvider(
		provider: WorkbenchProviderDescriptor,
		registeredName: string,
		input: Record<string, unknown>,
		signal?: AbortSignal,
	): Promise<ConnectorToolResult>;
	launchWorkbench(request: { workspaceFolder: string; launchRequestId: string }): Promise<WorkbenchLaunch>;
	sleep(milliseconds: number, signal?: AbortSignal): Promise<void>;
	createId(): string;
}

function publicInstance(provider: WorkbenchProviderDescriptor, schemaHash: string): PublicWorkbenchInstance {
	return {
		instanceId: provider.instanceId,
		displayName: provider.displayName,
		extensionVersion: provider.extensionVersion,
		processId: provider.processId,
		startedAt: provider.startedAt,
		workspaceFolders: [...provider.workspaceFolders],
		...(provider.workspaceFile ? { workspaceFile: provider.workspaceFile } : {}),
		compatible: provider.schemaHash === schemaHash,
	};
}

function errorResult(message: string): ConnectorToolResult {
	return { isError: true, content: [{ type: 'text', text: `Error: ${message}` }] };
}

function textResult(value: unknown): ConnectorToolResult {
	return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export class ExternalMcpConnectorCore {
	constructor(
		readonly catalog: ExternalMcpCatalog,
		private readonly dependencies: ExternalMcpConnectorDependencies,
	) {}

	async listInstances(signal?: AbortSignal): Promise<ConnectorToolResult> {
		const providers = await this.dependencies.discoverProviders(signal);
		return textResult({
			instances: providers
				.map(provider => publicInstance(provider, this.catalog.schemaHash))
				.sort((left, right) => left.instanceId.localeCompare(right.instanceId)),
		});
	}

	async checkInstance(instanceId: string, signal?: AbortSignal): Promise<ConnectorToolResult> {
		const provider = await this.resolveProvider(instanceId, signal);
		return textResult(publicInstance(provider, this.catalog.schemaHash));
	}

	async launchInstance(request: LaunchWorkbenchRequest, signal?: AbortSignal): Promise<ConnectorToolResult> {
		if (!request.workspaceFolder.trim()) return errorResult('workspaceFolder must be a non-empty absolute local path.');
		const launchRequestId = this.dependencies.createId();
		const launch = await this.dependencies.launchWorkbench({
			workspaceFolder: request.workspaceFolder,
			launchRequestId,
		});
		let claimed = false;
		let preserveForLateLaunch = false;
		let outcome: ConnectorToolResult | undefined;
		let launchError: Error | undefined;
		try {
			const timeoutMs = Math.min(Math.max(request.timeoutMs ?? 60_000, 1_000), 180_000);
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : new Error('Workbench launch was cancelled.');
				const providers = await this.dependencies.discoverProviders(signal);
				const provider = providers.find(candidate => candidate.launchRequestId === launchRequestId);
				if (provider) {
					this.assertCompatible(provider);
					claimed = true;
					outcome = textResult(publicInstance(provider, this.catalog.schemaHash));
					break;
				}
				await this.dependencies.sleep(100, signal);
			}
			if (!outcome) {
				preserveForLateLaunch = true;
				outcome = errorResult(
					`Kusto Workbench did not become ready within ${timeoutMs} ms for launch request ${launchRequestId}. `
					+ 'VS Code was already launched and may still become ready. Call listWorkbenchInstances and inspect the requested workspace before retrying launchWorkbenchInstance.',
				);
			}
		} catch (error) {
			preserveForLateLaunch = true;
			const message = error instanceof Error ? error.message : String(error);
			launchError = new Error(
				`${message} VS Code was already launched and may still become ready. `
				+ 'Call listWorkbenchInstances and inspect the requested workspace before retrying launchWorkbenchInstance.',
				{ cause: error },
			);
		}
		let cleanupError: unknown;
		if (!claimed) {
			try {
				await launch.cleanup({ preserveForLateLaunch });
			} catch (error) {
				cleanupError = error;
			}
		}
		if (launchError) {
			if (cleanupError !== undefined) {
				throw new AggregateError(
					[launchError, cleanupError],
					`${launchError.message} Launch correlation cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
				);
			}
			throw launchError;
		}
		if (cleanupError !== undefined) {
			const primary = outcome?.content[0]?.text.replace(/^Error:\s*/, '')
				?? 'Kusto Workbench launch correlation cleanup failed.';
			return errorResult(
				`${primary} Launch correlation cleanup also failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
			);
		}
		return outcome!;
	}

	async invokeWorkbenchTool(
		publicToolName: string,
		input: unknown,
		signal?: AbortSignal,
	): Promise<ConnectorToolResult> {
		const tool = this.catalog.tools.find(candidate => candidate.name === publicToolName);
		if (!tool) return errorResult(`Unknown Kusto Workbench tool: ${publicToolName}`);
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			return errorResult(`${publicToolName} requires an object input with instanceId.`);
		}
		const routedInput = input as Record<string, unknown>;
		const instanceId = typeof routedInput.instanceId === 'string' ? routedInput.instanceId.trim() : '';
		if (!instanceId) return errorResult(`${publicToolName} requires an explicit instanceId from listWorkbenchInstances.`);
		const { instanceId: _instanceId, ...toolInput } = routedInput;
		const provider = await this.resolveProvider(instanceId, signal);
		try {
			return await this.dependencies.invokeProvider(provider, tool.name, toolInput, signal);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return errorResult(
				`The call to ${publicToolName} on instance ${instanceId} lost its response: ${message}. `
				+ 'The operation may already have completed. Inspect that same instance and file before deciding whether to retry.',
			);
		}
	}

	private async resolveProvider(instanceId: string, signal?: AbortSignal): Promise<WorkbenchProviderDescriptor> {
		for (let attempt = 0; attempt < 3; attempt++) {
			const providers = await this.dependencies.discoverProviders(signal);
			const provider = providers.find(candidate => candidate.instanceId === instanceId);
			if (provider) {
				this.assertCompatible(provider);
				return provider;
			}
			if (attempt < 2) await this.dependencies.sleep(50, signal);
		}
		throw new Error(`Unknown or stale Kusto Workbench instance: ${instanceId}`);
	}

	private assertCompatible(provider: WorkbenchProviderDescriptor): void {
		if (provider.protocolVersion !== 1) {
			throw new Error(`Kusto Workbench instance ${provider.instanceId} uses unsupported discovery protocol ${provider.protocolVersion}.`);
		}
		if (provider.schemaHash !== this.catalog.schemaHash) {
			throw new Error(
				`Kusto Workbench instance ${provider.instanceId} has an incompatible tool catalog. `
				+ `Connector ${this.catalog.schemaHash.slice(0, 12)} != provider ${provider.schemaHash.slice(0, 12)}. Run setup again after updating Kusto Workbench.`,
			);
		}
	}
}