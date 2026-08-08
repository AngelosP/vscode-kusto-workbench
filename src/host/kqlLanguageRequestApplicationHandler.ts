import type { ConnectionManager } from './connectionManager';
import { KqlLanguageServiceHost } from './kqlLanguageService/host';
import { getErrorMessage } from './queryEditorUtils';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import type { WorkbenchLogger } from './workbenchLogger';

type KqlLanguageRequestMessage = Extract<IncomingWebviewMessage, { type: 'kqlLanguageRequest' }>;

export interface KqlLanguageRequestApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type KqlLanguageRequestApplicationHandlerOptions = {
	connectionManager: ConnectionManager;
	context: import('vscode').ExtensionContext;
	postMessage: (message: unknown) => Thenable<boolean>;
	output: Pick<WorkbenchLogger, 'error'>;
	languageHost?: Pick<KqlLanguageServiceHost, 'getDiagnostics' | 'findTableReferences'>;
};

export class HostKqlLanguageRequestApplicationHandler implements KqlLanguageRequestApplicationHandler {
	private readonly languageHost: Pick<KqlLanguageServiceHost, 'getDiagnostics' | 'findTableReferences'>;
	private disposed = false;

	constructor(private readonly options: KqlLanguageRequestApplicationHandlerOptions) {
		this.languageHost = options.languageHost
			?? new KqlLanguageServiceHost(options.connectionManager, options.context);
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (message.type !== 'kqlLanguageRequest') return undefined;
		return this.handleKqlLanguageRequest(message);
	}

	dispose(): void {
		this.disposed = true;
	}

	private postMessage(message: unknown): void {
		if (this.disposed) return;
		this.options.postMessage(message);
	}

	private async handleKqlLanguageRequest(message: KqlLanguageRequestMessage): Promise<void> {
		if (this.disposed) return;
		const requestId = String(message.requestId || '').trim();
		if (!requestId) return;

		try {
			const params = message.params && typeof message.params === 'object' ? message.params : { text: '' };
			switch (message.method) {
				case 'textDocument/diagnostic': {
					const result = await this.languageHost.getDiagnostics(params);
					this.postMessage({ type: 'kqlLanguageResponse', requestId, ok: true, result });
					return;
				}
				case 'kusto/findTableReferences': {
					const result = await this.languageHost.findTableReferences(params);
					this.postMessage({ type: 'kqlLanguageResponse', requestId, ok: true, result });
					return;
				}
				default:
					this.postMessage({
						type: 'kqlLanguageResponse',
						requestId,
						ok: false,
						error: { message: 'Unsupported method.' },
					});
					return;
			}
		} catch (error) {
			if (this.disposed) return;
			const raw = getErrorMessage(error);
			this.options.output.error(`[kql-ls] request failed: ${raw}`);
			this.postMessage({
				type: 'kqlLanguageResponse',
				requestId,
				ok: false,
				error: { message: 'KQL language service failed to process the request.' },
			});
		}
	}
}
