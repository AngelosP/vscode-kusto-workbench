import * as vscode from 'vscode';

/**
 * Renders a Monaco-based diff viewer in a webview panel.
 * 
 * This is a completely isolated utility for rendering text diffs.
 * It uses Monaco Editor's built-in diff editor loaded from CDN.
 */
export async function renderDiffInWebview(
	webviewPanel: vscode.WebviewPanel,
	extensionUri: vscode.Uri,
	originalUri: vscode.Uri
): Promise<void> {
	// Get the original (historical) content
	let originalContent = '';
	try {
		const originalDoc = await vscode.workspace.openTextDocument(originalUri);
		originalContent = originalDoc.getText();
	} catch {
		originalContent = '// Could not load original content';
	}

	// Get the working copy content
	let modifiedContent = originalContent;
	try {
		const workingCopyUri = vscode.Uri.file(originalUri.fsPath);
		const workingCopyBytes = await vscode.workspace.fs.readFile(workingCopyUri);
		modifiedContent = new TextDecoder('utf-8').decode(workingCopyBytes);
	} catch {
		// If we can't read the working copy, show just the original
	}

	// Determine the language for syntax highlighting
	const language = getLanguageFromUri(originalUri);
	const fileName = originalUri.path.split('/').pop() || 'file';

	webviewPanel.webview.options = {
		enableScripts: true,
		localResourceRoots: [extensionUri]
	};

	webviewPanel.webview.html = getDiffHtml(originalContent, modifiedContent, language, fileName);
}

function getLanguageFromUri(uri: vscode.Uri): string {
	const path = uri.path.toLowerCase();
	if (path.endsWith('.kql') || path.endsWith('.csl') || path.endsWith('.kqlx')) {
		return 'plaintext'; // Monaco doesn't have kusto built-in
	}
	if (path.endsWith('.md') || path.endsWith('.mdx')) {
		return 'markdown';
	}
	if (path.endsWith('.json')) {
		return 'json';
	}
	return 'plaintext';
}

function getDiffHtml(
	originalContent: string,
	modifiedContent: string,
	language: string,
	fileName: string
): string {
	// Escape content for safe embedding in HTML/JS
	const escapeForJs = (str: string): string => {
		return JSON.stringify(str);
	};

	const originalEscaped = escapeForJs(originalContent);
	const modifiedEscaped = escapeForJs(modifiedContent);

	// CSP needs to allow:
	// - script-src: inline scripts and CDN for Monaco
	// - style-src: inline styles and CDN for Monaco CSS
	// - font-src: CDN for Monaco fonts
	// - worker-src: blob: for Monaco's web workers (syntax highlighting, etc.)
	// - connect-src: CDN for loading Monaco modules
	return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline' https://cdn.jsdelivr.net; script-src 'unsafe-inline' https://cdn.jsdelivr.net; worker-src blob:; font-src https://cdn.jsdelivr.net data:; connect-src https://cdn.jsdelivr.net; img-src https://cdn.jsdelivr.net data:;">
	<title>Diff: ${fileName}</title>
	<style>
		* {
			margin: 0;
			padding: 0;
			box-sizing: border-box;
		}
		html, body {
			height: 100%;
			width: 100%;
			overflow: hidden;
			background: var(--vscode-editor-background, #1e1e1e);
		}
		#diff-container {
			width: 100%;
			height: 100%;
			display: flex;
			flex-direction: column;
		}
		.diff-header {
			display: flex;
			justify-content: space-between;
			padding: 8px 16px;
			background: var(--vscode-editorGroupHeader-tabsBackground, #252526);
			border-bottom: 1px solid var(--vscode-editorGroupHeader-tabsBorder, #1e1e1e);
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
			font-size: 12px;
			color: var(--vscode-foreground, #cccccc);
			flex-shrink: 0;
		}
		.diff-header-side {
			flex: 1;
			text-align: center;
			padding: 4px 8px;
		}
		.diff-header-side.original {
			background: rgba(255, 100, 100, 0.15);
			border-radius: 4px 0 0 4px;
			margin-right: 2px;
		}
		.diff-header-side.modified {
			background: rgba(100, 255, 100, 0.15);
			border-radius: 0 4px 4px 0;
			margin-left: 2px;
		}
		#editor-container {
			flex: 1;
			width: 100%;
			min-height: 0;
		}
		.loading {
			display: flex;
			align-items: center;
			justify-content: center;
			height: 100%;
			color: var(--vscode-foreground, #cccccc);
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		}
		.error {
			color: var(--vscode-errorForeground, #f48771);
			padding: 20px;
			font-family: var(--vscode-font-family, 'Segoe UI', sans-serif);
		}
	</style>
</head>
<body>
	<div id="diff-container">
		<div class="diff-header">
			<div class="diff-header-side original">Original (HEAD)</div>
			<div class="diff-header-side modified">Working Copy</div>
		</div>
		<div id="editor-container">
			<div class="loading">Loading diff viewer...</div>
		</div>
	</div>

	<script src="https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs/loader.js"></script>
	<script>
		(function() {
			const originalContent = ${originalEscaped};
			const modifiedContent = ${modifiedEscaped};
			const language = '${language}';

			// Configure Monaco loader
			require.config({
				paths: {
					'vs': 'https://cdn.jsdelivr.net/npm/monaco-editor@0.45.0/min/vs'
				}
			});

			// Load Monaco and create diff editor
			require(['vs/editor/editor.main'], function() {
				const container = document.getElementById('editor-container');
				container.innerHTML = '';

				// Detect VS Code theme based on body class or CSS variables
				const bodyClasses = document.body.className || '';
				const isDark = bodyClasses.includes('vscode-dark') || 
					bodyClasses.includes('vscode-high-contrast') ||
					!bodyClasses.includes('vscode-light');

				// Create the diff editor
				const diffEditor = monaco.editor.createDiffEditor(container, {
					theme: isDark ? 'vs-dark' : 'vs',
					automaticLayout: true,
					readOnly: true,
					renderSideBySide: true,
					enableSplitViewResizing: true,
					ignoreTrimWhitespace: false,
					renderIndicators: true,
					originalEditable: false,
					minimap: { enabled: true },
					scrollBeyondLastLine: false,
					fontSize: 13,
					lineNumbers: 'on',
					glyphMargin: true,
					folding: true,
					lineDecorationsWidth: 10,
					renderLineHighlight: 'all',
					scrollbar: {
						verticalScrollbarSize: 10,
						horizontalScrollbarSize: 10
					}
				});

				// Set the models
				const originalModel = monaco.editor.createModel(originalContent, language);
				const modifiedModel = monaco.editor.createModel(modifiedContent, language);

				diffEditor.setModel({
					original: originalModel,
					modified: modifiedModel
				});

				// Handle theme changes by observing body class changes
				const observer = new MutationObserver(function(mutations) {
					mutations.forEach(function(mutation) {
						if (mutation.attributeName === 'class') {
							const classes = document.body.className || '';
							const nowDark = classes.includes('vscode-dark') || 
								classes.includes('vscode-high-contrast') ||
								!classes.includes('vscode-light');
							monaco.editor.setTheme(nowDark ? 'vs-dark' : 'vs');
						}
					});
				});
				observer.observe(document.body, { attributes: true, attributeFilter: ['class'] });

			}, function(err) {
				// Error loading Monaco
				const container = document.getElementById('editor-container');
				container.innerHTML = '<div class="error">Failed to load diff viewer: ' + (err.message || err) + '</div>';
				console.error('Monaco load error:', err);
			});
		})();
	</script>
</body>
</html>`;
}
