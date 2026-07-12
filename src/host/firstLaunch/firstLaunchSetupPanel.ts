import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as vscode from 'vscode';
import type {
	FirstLaunchSetupHostMessage,
	FirstLaunchSetupWebviewMessage,
} from '../../shared/firstLaunchSetup';
import type { FirstLaunchPanelOutcome, FirstLaunchPanelRequest } from './firstLaunchCoordinator';

const READY_TIMEOUT_MS = 10_000;

export class FirstLaunchSetupPanel {
	private static current: FirstLaunchSetupPanel | undefined;

	private readonly disposables: vscode.Disposable[] = [];
	private readonly result: Promise<FirstLaunchPanelOutcome>;
	private resolveResult!: (outcome: FirstLaunchPanelOutcome) => void;
	private messageQueue: Promise<void> = Promise.resolve();
	private readyTimer: ReturnType<typeof setTimeout> | undefined;
	private terminal = false;
	private disposed = false;
	private operationInFlight = false;
	private transactionStarted = false;
	private retryOperation: (() => Promise<FirstLaunchPanelOutcome>) | undefined;
	private pendingOperation: FirstLaunchSetupWebviewMessage & ({ type: 'save' } | { type: 'skip' }) | undefined;

	static open(
		context: vscode.ExtensionContext,
		extensionUri: vscode.Uri,
		request: FirstLaunchPanelRequest,
	): Promise<FirstLaunchPanelOutcome> {
		if (FirstLaunchSetupPanel.current && !FirstLaunchSetupPanel.current.terminal) {
			FirstLaunchSetupPanel.current.panel.reveal(vscode.ViewColumn.One);
			return FirstLaunchSetupPanel.current.result;
		}
		const current = new FirstLaunchSetupPanel(context, extensionUri, request);
		FirstLaunchSetupPanel.current = current;
		return current.result;
	}

	private constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly extensionUri: vscode.Uri,
		private readonly request: FirstLaunchPanelRequest,
		private readonly panel: vscode.WebviewPanel = vscode.window.createWebviewPanel(
			'kustoFirstLaunchSetup',
			request.mode === 'automatic' ? 'Welcome to Kusto Workbench' : 'Configure Kusto Workbench',
			vscode.ViewColumn.One,
			{
				enableScripts: true,
				retainContextWhenHidden: true,
				localResourceRoots: [extensionUri],
			},
		),
	) {
		this.result = new Promise(resolve => { this.resolveResult = resolve; });
		this.panel.webview.html = this.buildHtml(this.panel.webview);
		this.disposables.push(
			this.panel.webview.onDidReceiveMessage((message: FirstLaunchSetupWebviewMessage) => {
				this.messageQueue = this.messageQueue.then(() => this.handleMessage(message)).catch(error => {
					void this.post({ type: 'error', message: this.userMessage(error), retryOnly: this.transactionStarted });
				});
			}),
			this.panel.onDidDispose(() => {
				this.disposed = true;
				this.clearReadyTimer();
				void this.messageQueue.finally(() => {
					this.settle(this.request.mode === 'automatic' ? 'closed' : 'cancelled', false);
				});
			}),
		);
		this.readyTimer = setTimeout(() => {
			this.settle('operational-failure');
		}, READY_TIMEOUT_MS);
		this.context.subscriptions.push(...this.disposables);
	}

	private async handleMessage(message: FirstLaunchSetupWebviewMessage): Promise<void> {
		if (this.terminal || !message || typeof message.type !== 'string') {
			return;
		}
		if (message.type === 'ready' || message.type === 'requestSnapshot') {
			this.clearReadyTimer();
			await this.post({ type: 'snapshot', snapshot: this.currentSnapshot() });
			return;
		}
		if (this.operationInFlight) {
			return;
		}
		if (this.retryOperation) {
			if (message.type === 'save' || message.type === 'skip') {
				await this.executeTransaction(this.retryOperation);
			} else {
				await this.post({ type: 'error', message: 'Retry the pending setup transaction before leaving.', retryOnly: true });
			}
			return;
		}
		if (message.type === 'cancel') {
			if (this.request.mode === 'configure') {
				this.settle('cancelled');
			}
			return;
		}
		if (message.type === 'skip') {
			const onSkip = this.request.onSkip;
			if (!onSkip) {
				return;
			}
			await this.executeTransaction(async () => {
				await onSkip();
				return 'skipped';
			}, { type: 'skip' });
			return;
		}
		if (message.type === 'save') {
			const { filePreferences, editingPreferences } = message;
			await this.executeTransaction(async () => {
				await this.request.onSave(filePreferences, editingPreferences);
				return 'completed';
			}, { type: 'save', filePreferences, editingPreferences });
		}
	}

	private async executeTransaction(
		operation: () => Promise<FirstLaunchPanelOutcome>,
		pendingOperation: FirstLaunchSetupWebviewMessage & ({ type: 'save' } | { type: 'skip' }) | undefined = this.pendingOperation,
	): Promise<void> {
		this.operationInFlight = true;
		this.transactionStarted = true;
		this.retryOperation = operation;
		this.pendingOperation = pendingOperation;
		await this.post({ type: 'working', working: true });
		try {
			const outcome = await operation();
			this.retryOperation = undefined;
			this.pendingOperation = undefined;
			this.settle(outcome);
		} catch (error) {
			await this.post({ type: 'error', message: this.userMessage(error), retryOnly: true });
			await this.post({ type: 'working', working: false });
			this.operationInFlight = false;
		}
	}

	private currentSnapshot() {
		if (this.pendingOperation?.type === 'save') {
			return {
				...this.request.snapshot,
				filePreferences: this.pendingOperation.filePreferences,
				editingPreferences: this.pendingOperation.editingPreferences,
				pendingOperation: 'save' as const,
				retryOnly: true,
			};
		}
		if (this.pendingOperation?.type === 'skip') {
			return { ...this.request.snapshot, pendingOperation: 'skip' as const, retryOnly: true };
		}
		return this.request.snapshot;
	}

	private post(message: FirstLaunchSetupHostMessage): Thenable<boolean> | undefined {
		if (this.disposed) {
			return undefined;
		}
		return this.panel.webview.postMessage(message);
	}

	private settle(outcome: FirstLaunchPanelOutcome, dispose = true): void {
		if (this.terminal) {
			return;
		}
		this.terminal = true;
		this.clearReadyTimer();
		this.resolveResult(outcome);
		if (FirstLaunchSetupPanel.current === this) {
			FirstLaunchSetupPanel.current = undefined;
		}
		if (dispose && !this.disposed) {
			this.panel.dispose();
		}
	}

	private clearReadyTimer(): void {
		if (this.readyTimer) {
			clearTimeout(this.readyTimer);
			this.readyTimer = undefined;
		}
	}

	private buildHtml(webview: vscode.Webview): string {
		const templateUri = vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'first-launch-setup.html');
		const html = new TextDecoder().decode(fs.readFileSync(templateUri.fsPath));
		const nonce = randomBytes(16).toString('base64');
		const bundleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview', 'first-launch-setup.bundle.js'));
		const codiconsFontUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'monaco', 'vs', 'base', 'browser', 'ui', 'codicons', 'codicon', 'codicon.ttf'));
		const logoUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'images', 'kusto-workbench-logo.png'));
		const csp = [
			"default-src 'none'",
			`img-src ${webview.cspSource}`,
			`font-src ${webview.cspSource}`,
			`style-src ${webview.cspSource} 'unsafe-inline'`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');
		return html
			.replace(/{{csp}}/g, csp)
			.replace(/{{nonce}}/g, nonce)
			.replace(/{{firstLaunchSetupBundleUri}}/g, String(bundleUri))
			.replace(/{{codiconFontUri}}/g, String(codiconsFontUri))
			.replace(/{{kustoWorkbenchLogoUri}}/g, String(logoUri));
	}

	private userMessage(error: unknown): string {
		const detail = error instanceof Error ? error.message : String(error || 'Unknown error');
		return `Kusto Workbench could not save these choices. ${detail}`;
	}
}