import * as vscode from 'vscode';

/**
 * Generate the lightweight HTML for the md-only webview.
 * Much simpler than `getQueryEditorHtml` — no Monaco, no ECharts, no bootstrap loader.
 * ToastUI JS + CSS are loaded directly in the HTML.
 */
export async function getMdEditorHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	context: vscode.ExtensionContext
): Promise<string> {
	const templateUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'md-editor.html');
	const cssBundleUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles', 'queryEditor.bundle.css');
	const overlayScrollbarsCssUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles', 'overlayscrollbars.min.css');
	const [templateBytes, cssBundleBytes, overlayScrollbarsCssBytes] = await Promise.all([
		vscode.workspace.fs.readFile(templateUri),
		vscode.workspace.fs.readFile(cssBundleUri),
		vscode.workspace.fs.readFile(overlayScrollbarsCssUri),
	]);
	let template = new TextDecoder('utf-8').decode(templateBytes);
	const appCssInline = new TextDecoder('utf-8').decode(overlayScrollbarsCssBytes).replaceAll('</style>', '<\\/style>')
		+ new TextDecoder('utf-8').decode(cssBundleBytes).replaceAll('</style>', '<\\/style>');

	const cacheBuster = `${context.extension.packageJSON?.version ?? 'dev'}-${Date.now()}`;
	const withCacheBuster = (uri: string) => {
		const sep = uri.includes('?') ? '&' : '?';
		return `${uri}${sep}v=${encodeURIComponent(cacheBuster)}`;
	};

	const toastUiEditorCssUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'vendor', 'toastui-editor', 'toastui-editor.css')).toString()
	);
	const toastUiEditorDarkCssUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'vendor', 'toastui-editor', 'toastui-editor-dark.css')).toString()
	);
	const tuiColorPickerCssUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'vendor', 'toastui-editor', 'tui-color-picker.css')).toString()
	);
	const toastUiEditorColorSyntaxCssUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'vendor', 'toastui-editor', 'toastui-editor-plugin-color-syntax.css')).toString()
	);
	const toastUiEditorJsUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'queryEditor', 'vendor', 'toastui-editor', 'toastui-editor.webview.js')).toString()
	);
	const vscodeApiJsUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'vscodeApi.js')).toString()
	);
	const mdEditorBundleUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'md-editor.bundle.js')).toString()
	);
	const toastUiEditorUrl = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'queryEditor', 'vendor', 'toastui-editor', 'toastui-editor.webview.js')).toString()
	);

	return template
		.replaceAll('{{toastUiEditorCssUri}}', toastUiEditorCssUri)
		.replaceAll('{{toastUiEditorDarkCssUri}}', toastUiEditorDarkCssUri)
		.replaceAll('{{tuiColorPickerCssUri}}', tuiColorPickerCssUri)
		.replaceAll('{{toastUiEditorColorSyntaxCssUri}}', toastUiEditorColorSyntaxCssUri)
		.replaceAll('{{toastUiEditorJsUri}}', toastUiEditorJsUri)
		.replaceAll('{{vscodeApiJsUri}}', vscodeApiJsUri)
		.replaceAll('{{mdEditorBundleUri}}', mdEditorBundleUri)
		.replaceAll('{{toastUiEditorUrl}}', toastUiEditorUrl)
		.replaceAll('{{toastUiCssUrlsJson}}', JSON.stringify([
			toastUiEditorCssUri,
			toastUiEditorDarkCssUri,
			tuiColorPickerCssUri,
			toastUiEditorColorSyntaxCssUri,
		]))
		.replaceAll('{{cacheBuster}}', cacheBuster)
		.replaceAll('{{appCssInline}}', appCssInline);
}
