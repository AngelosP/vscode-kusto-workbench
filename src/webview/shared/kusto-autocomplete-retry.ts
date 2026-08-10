export type KustoAutocompleteRetryPosition = Readonly<{
	lineNumber: number;
	column: number;
}>;

export type KustoAutocompleteRetryModel = {
	getVersionId?: () => number;
	isDisposed?: () => boolean;
};

type KustoAutocompleteRetryDisposable = {
	dispose: () => void;
};

export type KustoAutocompleteRetryEditor = object & {
	getModel?: () => KustoAutocompleteRetryModel | null;
	getPosition?: () => KustoAutocompleteRetryPosition | null;
	hasTextFocus?: () => boolean;
	hasWidgetFocus?: () => boolean;
	onDidChangeCursorPosition?: (listener: () => void) => KustoAutocompleteRetryDisposable;
	onDidChangeModelContent?: (listener: () => void) => KustoAutocompleteRetryDisposable;
	onDidChangeModel?: (listener: () => void) => KustoAutocompleteRetryDisposable;
};

export type KustoAutocompleteRetryOutcome = Readonly<{
	generation: number;
	reason: 'ready' | 'not-ready' | 'stale' | 'unfocused' | 'error' | 'cancelled' | 'completed';
	error?: unknown;
}>;

export type KustoAutocompleteRetryBeginOptions = {
	editor: KustoAutocompleteRetryEditor;
	boxId: string;
	isEditorCurrent?: () => boolean;
	subscribeCurrentness?: (listener: () => void) => KustoAutocompleteRetryDisposable;
	subscribeCancellation?: (listener: () => void) => KustoAutocompleteRetryDisposable;
};

export type KustoAutocompleteRetryRequest = Readonly<{
	generation: number;
	editor: KustoAutocompleteRetryEditor;
	boxId: string;
	signal: AbortSignal;
}>;

export type KustoAutocompleteRetryQueueOptions = {
	ready: Promise<boolean>;
	trigger: () => unknown;
	fallback?: () => unknown;
	onSettled?: (outcome: KustoAutocompleteRetryOutcome) => void;
};

export type KustoAutocompleteFrameResult = Readonly<{
	accepted: boolean;
	triggered: boolean;
	stale: boolean;
}>;

export function runKustoAutocompleteTriggerFrame(options: {
	isCurrent: () => boolean;
	trigger: () => boolean;
	schedule: (callback: () => void) => void;
}): Promise<KustoAutocompleteFrameResult> {
	return new Promise(resolve => {
		options.schedule(() => {
			if (!options.isCurrent()) {
				resolve(Object.freeze({ accepted: true, triggered: false, stale: true }));
				return;
			}
			try {
				const triggered = options.trigger();
				resolve(Object.freeze({ accepted: triggered, triggered, stale: false }));
			} catch {
				resolve(Object.freeze({ accepted: false, triggered: false, stale: false }));
			}
		});
	});
}

export type KustoSupplementalRetryStatus = 'loaded' | 'failed' | 'pending' | 'stale' | undefined;

export function classifyKustoSupplementalRetryState(
	expectedReferenceGeneration: number,
	state: Readonly<{ status?: string; referenceGeneration?: number }> | undefined,
): Exclude<KustoSupplementalRetryStatus, undefined> {
	if (!state || state.referenceGeneration !== expectedReferenceGeneration) return 'stale';
	if (state.status === 'loaded' || state.status === 'failed') return state.status;
	return 'pending';
}

export type KustoSupplementalRetryTimerApi = {
	setTimer(callback: () => void, delayMs: number): unknown;
	clearTimer(timer: unknown): void;
	now?(): number;
};

const defaultSupplementalRetryTimerApi: KustoSupplementalRetryTimerApi = {
	setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export function waitForKustoSupplementalRetryReadiness(options: {
	keys: readonly string[];
	signal?: AbortSignal;
	getStatus: (key: string) => KustoSupplementalRetryStatus;
	onStale?: () => void;
	intervalMs?: number;
	timeoutMs?: number;
	timerApi?: KustoSupplementalRetryTimerApi;
}): Promise<boolean> {
	const keys = [...new Set((options.keys || []).map(String).filter(Boolean))];
	if (keys.length === 0 || options.signal?.aborted) return Promise.resolve(false);
	const timerApi = options.timerApi ?? defaultSupplementalRetryTimerApi;
	const now = () => timerApi.now?.() ?? Date.now();
	const timeoutMs = Number(options.timeoutMs);
	const hasTimeout = Number.isFinite(timeoutMs) && timeoutMs >= 0;
	const startedAt = now();
	return new Promise(resolve => {
		let settled = false;
		let timer: unknown;
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			if (timer !== undefined) timerApi.clearTimer(timer);
			try { options.signal?.removeEventListener('abort', abort); } catch { /* best effort */ }
			resolve(ready);
		};
		const abort = () => finish(false);
		const check = () => {
			if (options.signal?.aborted) {
				finish(false);
				return;
			}
			let statuses: KustoSupplementalRetryStatus[];
			try {
				statuses = keys.map(options.getStatus);
			} catch {
				finish(false);
				return;
			}
			if (statuses.some(status => status === 'stale')) {
				try { options.onStale?.(); } catch { /* observers are best effort */ }
				finish(false);
				return;
			}
			if (statuses.some(status => status === 'loaded')) {
				finish(true);
				return;
			}
			if (statuses.every(status => status === 'failed')) {
				finish(false);
				return;
			}
			const elapsedMs = now() - startedAt;
			if (hasTimeout && elapsedMs >= timeoutMs) {
				finish(false);
				return;
			}
			const intervalMs = Math.max(1, Number(options.intervalMs) || 50);
			const delayMs = hasTimeout ? Math.min(intervalMs, Math.max(1, timeoutMs - elapsedMs)) : intervalMs;
			timer = timerApi.setTimer(check, delayMs);
		};
		options.signal?.addEventListener('abort', abort, { once: true });
		check();
	});
}

type RetryTicket = KustoAutocompleteRetryRequest & {
	model: KustoAutocompleteRetryModel;
	modelVersion: number | undefined;
	position: KustoAutocompleteRetryPosition | null;
	controller: AbortController;
	isEditorCurrent?: () => boolean;
	subscribeCurrentness?: (listener: () => void) => KustoAutocompleteRetryDisposable;
	subscribeCancellation?: (listener: () => void) => KustoAutocompleteRetryDisposable;
	disposables: KustoAutocompleteRetryDisposable[];
	queueOptions?: KustoAutocompleteRetryQueueOptions;
};

function samePosition(left: KustoAutocompleteRetryPosition | null, right: KustoAutocompleteRetryPosition | null): boolean {
	return left === right || !!(left && right && left.lineNumber === right.lineNumber && left.column === right.column);
}

export class KustoAutocompleteRetryCoordinator {
	private readonly tickets = new WeakMap<KustoAutocompleteRetryEditor, RetryTicket>();
	private nextGeneration = 0;

	begin(options: KustoAutocompleteRetryBeginOptions): KustoAutocompleteRetryRequest | undefined {
		const boxId = String(options.boxId || '').trim();
		const model = options.editor?.getModel?.();
		if (!boxId || !model || model.isDisposed?.()) return undefined;
		this.cancel(options.editor);
		const modelVersion = model.getVersionId?.();
		const position = options.editor.getPosition?.() || null;
		const controller = new AbortController();
		const ticket: RetryTicket = {
			generation: ++this.nextGeneration,
			editor: options.editor,
			boxId,
			signal: controller.signal,
			model,
			modelVersion: Number.isFinite(modelVersion) ? modelVersion : undefined,
			position: position ? Object.freeze({ ...position }) : null,
			controller,
			isEditorCurrent: options.isEditorCurrent,
			subscribeCurrentness: options.subscribeCurrentness,
			subscribeCancellation: options.subscribeCancellation,
			disposables: [],
		};
		this.tickets.set(options.editor, ticket);
		this.observeInvalidation(ticket);
		return ticket;
	}

	queue(request: KustoAutocompleteRetryRequest, options: KustoAutocompleteRetryQueueOptions): boolean {
		const ticket = this.getCurrentTicket(request);
		if (!ticket) return false;
		ticket.queueOptions = options;
		if (!this.isEnvironmentCurrent(ticket)) {
			this.finish(ticket, 'stale');
			return false;
		}
		void options.ready.then(
			ready => this.settle(ticket, ready),
			error => this.fail(ticket, error),
		);
		return true;
	}

	isCurrent(request: KustoAutocompleteRetryRequest): boolean {
		const ticket = this.getCurrentTicket(request);
		return !!ticket && this.isEnvironmentCurrent(ticket);
	}

	hasQueuedRetry(request: KustoAutocompleteRetryRequest): boolean {
		return !!this.getCurrentTicket(request)?.queueOptions;
	}

	complete(request: KustoAutocompleteRetryRequest): boolean {
		const ticket = this.getCurrentTicket(request);
		if (!ticket || !this.isEnvironmentCurrent(ticket)) {
			if (ticket) this.finish(ticket, 'stale');
			return false;
		}
		this.finish(ticket, 'completed');
		return true;
	}

	cancel(editor: KustoAutocompleteRetryEditor): void {
		const ticket = this.tickets.get(editor);
		if (ticket) this.finish(ticket, 'cancelled');
	}

	cancelRequest(request: KustoAutocompleteRetryRequest): void {
		const ticket = this.getCurrentTicket(request);
		if (ticket) this.finish(ticket, 'cancelled');
	}

	private settle(ticket: RetryTicket, ready: boolean): void {
		if (this.tickets.get(ticket.editor) !== ticket) return;
		if (!this.isEnvironmentCurrent(ticket)) {
			this.finish(ticket, 'stale');
			return;
		}
		const focused = !!ticket.editor.hasTextFocus?.() || !!ticket.editor.hasWidgetFocus?.();
		if (!focused) {
			this.finish(ticket, 'unfocused');
			return;
		}
		const effect = ready ? ticket.queueOptions?.trigger : ticket.queueOptions?.fallback;
		this.finish(ticket, ready ? 'ready' : 'not-ready');
		this.invoke(effect);
	}

	private fail(ticket: RetryTicket, error: unknown): void {
		if (this.tickets.get(ticket.editor) !== ticket) return;
		const fallback = this.isEnvironmentCurrent(ticket)
			&& (!!ticket.editor.hasTextFocus?.() || !!ticket.editor.hasWidgetFocus?.())
			? ticket.queueOptions?.fallback
			: undefined;
		this.finish(ticket, 'error', error);
		this.invoke(fallback);
	}

	private finish(ticket: RetryTicket, reason: KustoAutocompleteRetryOutcome['reason'], error?: unknown): void {
		if (this.tickets.get(ticket.editor) !== ticket) return;
		this.tickets.delete(ticket.editor);
		try { ticket.controller.abort(); } catch { /* best effort */ }
		for (const disposable of ticket.disposables.splice(0)) {
			try { disposable.dispose(); } catch { /* best effort */ }
		}
		try { ticket.queueOptions?.onSettled?.(Object.freeze({ generation: ticket.generation, reason, ...(error === undefined ? {} : { error }) })); } catch { /* observers are best effort */ }
	}

	private getCurrentTicket(request: KustoAutocompleteRetryRequest): RetryTicket | undefined {
		const ticket = this.tickets.get(request.editor);
		return ticket === request ? ticket : undefined;
	}

	private isEnvironmentCurrent(ticket: RetryTicket): boolean {
		if (ticket.signal.aborted || (ticket.isEditorCurrent && !ticket.isEditorCurrent())) return false;
		const model = ticket.editor.getModel?.();
		if (model !== ticket.model || model?.isDisposed?.()) return false;
		const modelVersion = model?.getVersionId?.();
		if (ticket.modelVersion !== undefined && modelVersion !== ticket.modelVersion) return false;
		return samePosition(ticket.position, ticket.editor.getPosition?.() || null);
	}

	private observeInvalidation(ticket: RetryTicket): void {
		const cancelIfStale = () => {
			if (this.tickets.get(ticket.editor) === ticket && !this.isEnvironmentCurrent(ticket)) this.finish(ticket, 'stale');
		};
		const cancelForModelChange = () => {
			if (this.tickets.get(ticket.editor) === ticket) this.finish(ticket, 'stale');
		};
		try {
			const disposable = ticket.editor.onDidChangeCursorPosition?.(cancelIfStale);
			if (disposable) ticket.disposables.push(disposable);
		} catch { /* optional editor capability */ }
		try {
			const disposable = ticket.editor.onDidChangeModelContent?.(cancelForModelChange);
			if (disposable) ticket.disposables.push(disposable);
		} catch { /* optional editor capability */ }
		try {
			const disposable = ticket.editor.onDidChangeModel?.(cancelForModelChange);
			if (disposable) ticket.disposables.push(disposable);
		} catch { /* optional editor capability */ }
		try {
			const disposable = ticket.subscribeCurrentness?.(cancelIfStale);
			if (disposable) ticket.disposables.push(disposable);
		} catch { /* optional lifecycle capability */ }
		try {
			const disposable = ticket.subscribeCancellation?.(() => {
				if (this.tickets.get(ticket.editor) === ticket) this.finish(ticket, 'cancelled');
			});
			if (disposable) ticket.disposables.push(disposable);
		} catch { /* optional dismissal capability */ }
	}

	private invoke(effect: (() => unknown) | undefined): void {
		try {
			const result = effect?.();
			if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
				void Promise.resolve(result).catch(() => undefined);
			}
		} catch {
			// Retry and fallback presentation are best effort.
		}
	}
}
