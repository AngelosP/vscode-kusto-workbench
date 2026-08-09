import type * as vscode from 'vscode';

const adaptedPanels = new WeakSet<object>();
const deferredPanels = new WeakSet<object>();

export function deferMainWebviewReadyForTest(panel: vscode.WebviewPanel): void {
	deferredPanels.add(panel as object);
}

export function adaptMainWebviewStartupTestPanel(panel: vscode.WebviewPanel): void {
	if (adaptedPanels.has(panel as object)) return;
	adaptedPanels.add(panel as object);
	const webview = panel.webview as any;
	const originalOnDidReceiveMessage = webview.onDidReceiveMessage.bind(webview);
	webview.onDidReceiveMessage = (handler: (message: any) => unknown, ...args: any[]) => {
		const subscription = originalOnDidReceiveMessage(handler, ...args);
		if (!deferredPanels.has(panel as object)) {
			queueMicrotask(() => {
				void Promise.resolve(handler({ type: 'mainWebviewDispatcherReady' })).catch(() => undefined);
			});
		}
		return subscription;
	};
}
