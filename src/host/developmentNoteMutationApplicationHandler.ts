import type { IncomingWebviewMessage } from './queryEditorTypes';

export type DevelopmentNoteMutationResult = { success: boolean; error?: string };

type ToolResponseMessage = Extract<IncomingWebviewMessage, {
	type: 'toolResponse';
}>;

export interface DevelopmentNoteMutationApplicationHandler {
	updateDevelopmentNotes(message: Record<string, unknown>): Promise<DevelopmentNoteMutationResult>;
	handleMessage(message: IncomingWebviewMessage): boolean;
	dispose(): void;
}

export type DevelopmentNoteMutationApplicationHandlerOptions = {
	postMessage(message: unknown): boolean | PromiseLike<boolean>;
	isAvailable(): boolean;
};

export class HostDevelopmentNoteMutationApplicationHandler
implements DevelopmentNoteMutationApplicationHandler {
	private disposed = false;
	private readonly webviewMutationResponseResolvers = new Map<string, {
		resolve: (result: DevelopmentNoteMutationResult) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();

	constructor(private readonly options: DevelopmentNoteMutationApplicationHandlerOptions) {}

	updateDevelopmentNotes(message: Record<string, unknown>): Promise<DevelopmentNoteMutationResult> {
		if (this.disposed || !this.options.isAvailable()) {
			return Promise.resolve({ success: false, error: 'Kusto Workbench editor is unavailable.' });
		}

		const requestId = `copilot_devnotes_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.webviewMutationResponseResolvers.delete(requestId);
				resolve({ success: false, error: 'Development note update timed out.' });
			}, 5000);
			this.webviewMutationResponseResolvers.set(requestId, { resolve, timer });

			const settleDeliveryFailure = (error: string) => {
				const pending = this.webviewMutationResponseResolvers.get(requestId);
				if (!pending) return;
				this.webviewMutationResponseResolvers.delete(requestId);
				clearTimeout(pending.timer);
				pending.resolve({ success: false, error });
			};

			let delivery: boolean | PromiseLike<boolean>;
			try {
				delivery = this.options.postMessage({ type: 'updateDevNotes', requestId, ...message });
			} catch (error) {
				settleDeliveryFailure(error instanceof Error ? error.message : String(error));
				return;
			}
			void Promise.resolve(delivery).then(delivered => {
				if (delivered === false) {
					settleDeliveryFailure('Kusto Workbench rejected the development note request.');
				}
			}, error => settleDeliveryFailure(error instanceof Error ? error.message : String(error)));
		});
	}

	handleMessage(message: IncomingWebviewMessage): boolean {
		if (message.type !== 'toolResponse') return false;
		const pending = this.webviewMutationResponseResolvers.get(message.requestId);
		if (!pending) return false;

		this.webviewMutationResponseResolvers.delete(message.requestId);
		clearTimeout(pending.timer);
		pending.resolve(this.toMutationResult(message));
		return true;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [requestId, pending] of [...this.webviewMutationResponseResolvers]) {
			this.webviewMutationResponseResolvers.delete(requestId);
			clearTimeout(pending.timer);
			pending.resolve({ success: false, error: 'Kusto Workbench editor closed.' });
		}
	}

	private toMutationResult(message: ToolResponseMessage): DevelopmentNoteMutationResult {
		const result = message.result && typeof message.result === 'object'
			? message.result as Record<string, unknown>
			: {};
		return {
			success: !message.error && result.success === true,
			...(message.error ? { error: String(message.error) } : {}),
		};
	}
}
