import * as vscode from 'vscode';

export async function getQueryEditorHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	context: vscode.ExtensionContext
): Promise<string> {
	const templateUri = vscode.Uri.joinPath(extensionUri, 'media', 'queryEditor.html');
	const templateBytes = await vscode.workspace.fs.readFile(templateUri);
	const template = new TextDecoder('utf-8').decode(templateBytes);

	const cacheBuster = `${context.extension.packageJSON?.version ?? 'dev'}-${Date.now()}`;
	const withCacheBuster = (uri: string) => {
		const sep = uri.includes('?') ? '&' : '?';
		return `${uri}${sep}v=${encodeURIComponent(cacheBuster)}`;
	};

	const queryEditorCssUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'queryEditor.css')).toString()
	);
	const queryEditorJsUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'queryEditor.js')).toString()
	);

	const monacoVsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs')).toString();
	const monacoLoaderUri = webview
		.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs', 'loader.js'))
		.toString();
	const monacoCssUri = webview
		.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs', 'editor', 'editor.main.css'))
		.toString();

	return template
		.replaceAll('{{queryEditorCssUri}}', queryEditorCssUri)
		.replaceAll('{{queryEditorJsUri}}', queryEditorJsUri)
		.replaceAll('{{monacoVsUri}}', monacoVsUri)
		.replaceAll('{{monacoLoaderUri}}', withCacheBuster(monacoLoaderUri))
		.replaceAll('{{monacoCssUri}}', withCacheBuster(monacoCssUri))
		.replaceAll('{{cacheBuster}}', cacheBuster);
}
