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
	// Monaco 0.5x ships a single style.css under vs/ (editor/editor.main.css may not exist).
	const monacoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs', 'style.css')).toString();

	// Monaco workers are version-hashed files in vs/assets. Discover them at runtime and pass
	// their webview URIs into the page so the worker bootstrap is always correct.
	const monacoWorkers: Record<string, string> = {};
	try {
		const assetsUri = vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs', 'assets');
		const entries = await vscode.workspace.fs.readDirectory(assetsUri);
		for (const [name, type] of entries) {
			if (type !== vscode.FileType.File) continue;
			if (!name.endsWith('.js')) continue;
			const m = name.match(/^(css|editor|html|json|ts)\.worker\.[0-9a-f]+\.js$/i);
			if (!m) continue;
			const key = m[1].toLowerCase();
			const uri = webview.asWebviewUri(vscode.Uri.joinPath(assetsUri, name)).toString();
			monacoWorkers[key] = withCacheBuster(uri);
		}
	} catch {
		// If discovery fails, Monaco may still run without workers, but language features may degrade.
	}

	return template
		.replaceAll('{{queryEditorCssUri}}', queryEditorCssUri)
		.replaceAll('{{queryEditorJsUri}}', queryEditorJsUri)
		.replaceAll('{{monacoVsUri}}', monacoVsUri)
		.replaceAll('{{monacoLoaderUri}}', withCacheBuster(monacoLoaderUri))
		.replaceAll('{{monacoCssUri}}', withCacheBuster(monacoCssUri))
		.replaceAll('{{monacoWorkersJson}}', JSON.stringify(monacoWorkers))
		.replaceAll('{{cacheBuster}}', cacheBuster);
}
