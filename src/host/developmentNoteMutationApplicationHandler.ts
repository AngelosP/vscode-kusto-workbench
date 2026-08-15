import {
	admitDevelopmentNoteMutationWebviewMessage,
	createDevelopmentNoteMutationHostMessage,
	type DevelopmentNoteMutationHostMessage,
	type DevelopmentNoteMutationPayload,
	type DevelopmentNoteMutationResult,
	type DevelopmentNoteMutationWebviewAdmission,
	type DevelopmentNoteMutationWebviewMessage,
} from '../shared/developmentNoteMutationProtocol';

export type { DevelopmentNoteMutationResult } from '../shared/developmentNoteMutationProtocol';

export interface DevelopmentNoteMutationApplicationHandler {
	updateDevelopmentNotes(message: DevelopmentNoteMutationPayload): Promise<DevelopmentNoteMutationResult>;
	handleMessage(message: unknown): boolean;
	handleResponseAdmission?(admission: DevelopmentNoteMutationWebviewAdmission): boolean;
	hasPendingResponse?(): boolean;
	dispose(): void;
}

export type DevelopmentNoteMutationApplicationHandlerOptions = {
	postMessage(message: DevelopmentNoteMutationHostMessage): boolean | PromiseLike<boolean>;
	isAvailable(): boolean;
};

export class HostDevelopmentNoteMutationApplicationHandler
implements DevelopmentNoteMutationApplicationHandler {
	private disposed = false;
	private readonly webviewMutationResponseResolvers = new Map<string, {
		resolve: (result: DevelopmentNoteMutationResult) => void;
		timer: ReturnType<typeof setTimeout>;
	}>();
	private readonly responseRequestIds = new Set<string>();

	constructor(private readonly options: DevelopmentNoteMutationApplicationHandlerOptions) {}

	updateDevelopmentNotes(message: DevelopmentNoteMutationPayload): Promise<DevelopmentNoteMutationResult> {
		if (this.disposed || !this.options.isAvailable()) {
			return Promise.resolve({ success: false, error: 'Kusto Workbench editor is unavailable.' });
		}

		const requestId = `copilot_devnotes_${Date.now()}_${Math.random().toString(36).slice(2)}`;
		const request = createDevelopmentNoteMutationHostMessage(requestId, message);
		if (!request.ok) {
			return Promise.resolve({ success: false, error: request.error });
		}
		return new Promise(resolve => {
			const timer = setTimeout(() => {
				this.webviewMutationResponseResolvers.delete(requestId);
				this.responseRequestIds.delete(requestId);
				resolve({ success: false, error: 'Development note update timed out.' });
			}, 5000);
			this.webviewMutationResponseResolvers.set(requestId, { resolve, timer });
			this.responseRequestIds.add(requestId);

			const settleDeliveryFailure = (error: string) => {
				const pending = this.webviewMutationResponseResolvers.get(requestId);
				if (!pending) return;
				this.webviewMutationResponseResolvers.delete(requestId);
				this.responseRequestIds.delete(requestId);
				clearTimeout(pending.timer);
				pending.resolve({ success: false, error });
			};

			let delivery: boolean | PromiseLike<boolean>;
			try {
				delivery = this.options.postMessage(request.value);
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

	handleMessage(message: unknown): boolean {
		return this.handleResponseAdmission(admitDevelopmentNoteMutationWebviewMessage(message));
	}

	handleResponseAdmission(admission: DevelopmentNoteMutationWebviewAdmission): boolean {
		if (!admission.recognized || !admission.requestId
			|| !this.responseRequestIds.has(admission.requestId)) return false;
		if (!admission.parsed.ok) return true;
		const response = admission.parsed.value;
		const pending = this.webviewMutationResponseResolvers.get(response.requestId);
		if (!pending) {
			this.responseRequestIds.delete(response.requestId);
			return true;
		}

		this.webviewMutationResponseResolvers.delete(response.requestId);
		this.responseRequestIds.delete(response.requestId);
		clearTimeout(pending.timer);
		pending.resolve(this.toMutationResult(response));
		return true;
	}

	hasPendingResponse(): boolean {
		return this.responseRequestIds.size > 0;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		for (const [requestId, pending] of [...this.webviewMutationResponseResolvers]) {
			this.webviewMutationResponseResolvers.delete(requestId);
			this.responseRequestIds.delete(requestId);
			clearTimeout(pending.timer);
			pending.resolve({ success: false, error: 'Kusto Workbench editor closed.' });
		}
	}

	private toMutationResult(message: DevelopmentNoteMutationWebviewMessage): DevelopmentNoteMutationResult {
		return {
			success: message.result.success,
			...(message.error !== undefined ? { error: message.error } : {}),
		};
	}
}
