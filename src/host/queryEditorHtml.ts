import * as vscode from 'vscode';

export async function getQueryEditorHtml(
	webview: vscode.Webview,
	extensionUri: vscode.Uri,
	context: vscode.ExtensionContext,
	options?: { hideFooterControls?: boolean }
): Promise<string> {
	const templateUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'queryEditor.html');
	const templateBytes = await vscode.workspace.fs.readFile(templateUri);
	let template = new TextDecoder('utf-8').decode(templateBytes);

	// For certain modes (e.g. .md compatibility mode), we want to avoid rendering footer UI
	// (Add Section buttons + feedback link) entirely so it doesn't take up layout/scroll space.
	if (options?.hideFooterControls) {
		// Remove the "Add sections" controls block.
		template = template.replace(/\s*<div class="add-controls"[\s\S]*?<\/div>\s*/m, '\n');
		// Remove the feedback link block.
		template = template.replace(/\s*<div class="repo-issues-link"[\s\S]*?<\/div>\s*/m, '\n');
	}

	const cacheBuster = `${context.extension.packageJSON?.version ?? 'dev'}-${Date.now()}`;
	const withCacheBuster = (uri: string) => {
		const sep = uri.includes('?') ? '&' : '?';
		return `${uri}${sep}v=${encodeURIComponent(cacheBuster)}`;
	};

	const appCssBundleUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles', 'queryEditor.bundle.css')).toString()
	);
	const toastUiEditorCssUri = withCacheBuster(
		webview
			.asWebviewUri(
				vscode.Uri.joinPath(
					extensionUri,
					'dist',
					'webview',
					'vendor',
					'toastui-editor',
					'toastui-editor.css'
				)
			)
			.toString()
	);
	const toastUiEditorDarkCssUri = withCacheBuster(
		webview
			.asWebviewUri(
				vscode.Uri.joinPath(
					extensionUri,
					'dist',
					'webview',
					'vendor',
					'toastui-editor',
					'toastui-editor-dark.css'
				)
			)
			.toString()
	);
	const toastUiEditorColorSyntaxCssUri = withCacheBuster(
		webview
			.asWebviewUri(
				vscode.Uri.joinPath(
					extensionUri,
					'dist',
					'webview',
					'vendor',
					'toastui-editor',
					'toastui-editor-plugin-color-syntax.css'
				)
			)
			.toString()
	);
	const tuiColorPickerCssUri = withCacheBuster(
		webview
			.asWebviewUri(
				vscode.Uri.joinPath(
					extensionUri,
					'dist',
					'webview',
					'vendor',
					'toastui-editor',
					'tui-color-picker.css'
				)
			)
			.toString()
	);
	const queryEditorJsUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'queryEditor.js')).toString()
	);

	const echartsUrl = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'queryEditor', 'vendor', 'echarts', 'echarts.webview.js')).toString()
	);
	const toastUiEditorUrl = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'queryEditor', 'vendor', 'toastui-editor', 'toastui-editor.webview.js')).toString()
	);

	const copilotLogoUri = withCacheBuster(
		webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'images', 'copilot-button-logo.png')).toString()
	);

	const monacoVsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs')).toString();
	const monacoLoaderUri = webview
		.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs', 'loader.js'))
		.toString();
	// Monaco 0.52 ships CSS under vs/editor/editor.main.css.
	const monacoCssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'monaco', 'vs', 'editor', 'editor.main.css')).toString();

	// Alternating row color: inject as CSS custom property so it's available at first paint.
	// The setting also updates live via postMessage (settingsUpdate) when changed at runtime.
	const altRowColor = vscode.workspace.getConfiguration('kustoWorkbench').get<string>('alternatingRowColor', 'theme');
	let altRowCss = '';
	if (altRowColor !== 'off') {
		if (altRowColor === 'theme' || !altRowColor) {
			altRowCss = ':root{--kw-alt-row-bg:color-mix(in srgb,var(--vscode-editor-background) 97%,var(--vscode-foreground) 3%)}';
		} else {
			// Sanitize custom color: strip anything that could break out of the CSS declaration.
			const safe = altRowColor.replace(/[^a-zA-Z0-9#(),.\/\s%\-]/g, '');
			if (safe) { altRowCss = `:root{--kw-alt-row-bg:${safe}}`; }
		}
	}

	return template
		.replaceAll('{{alternatingRowStyle}}', altRowCss)
		.replaceAll('{{appCssBundleUri}}', appCssBundleUri)
		.replaceAll('{{queryEditorJsUri}}', queryEditorJsUri)
		.replaceAll('{{copilotLogoUri}}', copilotLogoUri)
		.replaceAll('{{monacoVsUri}}', monacoVsUri)
		.replaceAll('{{monacoLoaderUri}}', withCacheBuster(monacoLoaderUri))
		.replaceAll('{{monacoCssUri}}', withCacheBuster(monacoCssUri))
		.replaceAll('{{echartsUrl}}', echartsUrl)
		.replaceAll('{{toastUiEditorUrl}}', toastUiEditorUrl)
		.replaceAll('{{toastUiCssUrlsJson}}', JSON.stringify([
			toastUiEditorCssUri,
			toastUiEditorDarkCssUri,
			tuiColorPickerCssUri,
			toastUiEditorColorSyntaxCssUri,
		]))
		.replaceAll('{{cacheBuster}}', cacheBuster);
}
