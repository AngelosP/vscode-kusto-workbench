import { readFileSync } from 'fs';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { getMdEditorHtml } from '../../../src/host/mdEditorHtml.js';

async function writeMockFile(uri: vscode.Uri, text: string): Promise<void> {
	await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
}

describe('Markdown compatibility editor HTML template', () => {
	afterEach(() => {
		(vscode as any).__mockFileSystem?.clear?.();
	});

	it('declares Did you know rendering dependencies before the md editor bundle', () => {
		const root = process.cwd();
		const template = readFileSync(join(root, 'src', 'webview', 'md-editor.html'), 'utf8');

		const markedIndex = template.indexOf('{{markedUri}}');
		const purifyIndex = template.indexOf('{{purifyUri}}');
		const codiconIndex = template.indexOf('{{codiconFontUri}}');
		const mdBundleIndex = template.indexOf('{{mdEditorBundleUri}}');

		expect(template).toContain('{{codiconFontUri}}');
		expect(template).toMatch(/@font-face[\s\S]*font-family:\s*["']?codicon["']?[\s\S]*{{codiconFontUri}}/);
		expect(markedIndex).toBeGreaterThanOrEqual(0);
		expect(purifyIndex).toBeGreaterThanOrEqual(0);
		expect(codiconIndex).toBeGreaterThanOrEqual(0);
		expect(mdBundleIndex).toBeGreaterThanOrEqual(0);
		expect(markedIndex).toBeLessThan(mdBundleIndex);
		expect(purifyIndex).toBeLessThan(mdBundleIndex);
		expect(codiconIndex).toBeLessThan(mdBundleIndex);
	});

	it('emits resolved Did you know asset URIs from the host HTML builder', async () => {
		const root = process.cwd();
		const extensionUri = vscode.Uri.file('/extension');
		const template = readFileSync(join(root, 'src', 'webview', 'md-editor.html'), 'utf8');
		const templateUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'md-editor.html');
		const cssBundleUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles', 'queryEditor.bundle.css');
		const overlayScrollbarsCssUri = vscode.Uri.joinPath(extensionUri, 'dist', 'webview', 'styles', 'overlayscrollbars.min.css');
		await writeMockFile(templateUri, template);
		await writeMockFile(cssBundleUri, '.app{color:var(--vscode-foreground);}');
		await writeMockFile(overlayScrollbarsCssUri, '.os-scrollbar{display:block;}');

		const webview = {
			asWebviewUri: (uri: vscode.Uri) => ({ toString: () => `webview-resource:${uri.fsPath}` }),
		} as unknown as vscode.Webview;
		const context = { extension: { packageJSON: { version: 'test-version' } } } as unknown as vscode.ExtensionContext;

		const html = await getMdEditorHtml(webview, extensionUri, context);
		const markedIndex = html.indexOf('marked.min.js');
		const purifyIndex = html.indexOf('purify.min.js');
		const codiconIndex = html.indexOf('codicon.ttf');
		const mdBundleIndex = html.indexOf('md-editor.bundle.js');

		expect(html).not.toContain('{{markedUri}}');
		expect(html).not.toContain('{{purifyUri}}');
		expect(html).not.toContain('{{codiconFontUri}}');
		expect(markedIndex).toBeGreaterThanOrEqual(0);
		expect(purifyIndex).toBeGreaterThanOrEqual(0);
		expect(codiconIndex).toBeGreaterThanOrEqual(0);
		expect(mdBundleIndex).toBeGreaterThanOrEqual(0);
		expect(markedIndex).toBeLessThan(mdBundleIndex);
		expect(purifyIndex).toBeLessThan(mdBundleIndex);
		expect(codiconIndex).toBeLessThan(mdBundleIndex);
	});
});