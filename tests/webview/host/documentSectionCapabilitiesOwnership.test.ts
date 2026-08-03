import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';

const source = (relativePath: string): string => readFileSync(resolve(process.cwd(), relativePath), 'utf8');

function webviewSourceFiles(directory = resolve(process.cwd(), 'src/webview')): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return webviewSourceFiles(path);
		return /\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith('.d.ts') ? [path] : [];
	});
}

describe('document section capability ownership', () => {
	it('keeps the shared matrix as the only document-kind section authority', () => {
		const notebookProvider = source('src/host/kqlxEditorProvider.ts');
		const overlay = source('src/host/kqlxOverlay.ts');
		const compatibilityFormat = source('src/host/compatSidecarFormat.ts');
		const diffViewer = source('src/host/diffViewerUtils.ts');
		const queryEditorProvider = source('src/host/queryEditorProvider.ts');
		const kqlCompat = source('src/host/kqlCompatEditorProvider.ts');
		const sqlCompat = source('src/host/sqlCompatEditorProvider.ts');
		const webviewCapabilities = source('src/webview/core/document-capabilities.ts');
		const webviewMain = source('src/webview/core/main.ts');
		const messageHandler = source('src/webview/core/message-handler.ts');
		const persistence = source('src/webview/core/persistence.ts');
		const sectionFactory = source('src/webview/core/section-factory.ts');
		const queryExecution = source('src/webview/sections/query-execution.controller.ts');
		const copilotChatManager = source('src/webview/sections/copilot-chat-manager.controller.ts');
		const preload = source('src/webview/queryEditor.js');
		const markdownWebview = source('src/webview/md-editor/md-persistence.ts');
		const browserViewer = source('browser-ext/viewer-boot.js');
		const browserDocument = source('browser-ext/src/viewer-document.ts');
		const browserPreload = source('browser-ext/queryEditor-loader.js');

		expect(notebookProvider).not.toContain('getAllowedSectionKinds');
		expect(notebookProvider).not.toContain('sanitizeStateForKind');
		expect(notebookProvider).toContain('supportsMultipleEditorsPerDocument: false');
		expect(overlay).not.toContain('MDX_EDITABLE_SECTION_TYPES');
		expect(overlay).not.toContain('MDX_PASSTHROUGH_SECTION_TYPES');
		expect(kqlCompat).not.toContain('private static readonly allowedSectionKinds');
		expect(sqlCompat).not.toContain('private static readonly allowedSectionKinds');
		expect(compatibilityFormat).not.toContain('acceptedPrimaryKinds');
		expect(browserViewer).not.toContain('function parseKqlxText');
		expect(webviewMain).not.toContain('allowed.length === 0 ||');
		for (const creationSurface of [messageHandler, queryExecution, copilotChatManager]) {
			expect(creationSurface).toContain('createSectionWithCapabilities');
			expect(creationSurface).not.toMatch(/\badd(?:Query|Sql|Chart|Transformation|Markdown|Python|Url|Html)Box\s*\(/);
		}
		expect(queryEditorProvider).toContain("engine: sqlConnectionId ? 'sql' : 'kusto'");
		expect(browserDocument).toContain("from '../../src/host/kqlxFormat'");
		expect(browserDocument).toContain("from '../../src/shared/nativeDocumentValidation'");
		expect(notebookProvider).toContain("from '../shared/nativeDocumentValidation'");
		expect(browserViewer).toContain('parseBrowserNativeWorkbenchText');
		for (const decisionSurface of [
			notebookProvider, compatibilityFormat, diffViewer, queryEditorProvider,
			messageHandler, persistence, sectionFactory, preload, browserViewer, browserPreload,
		]) {
			expect(decisionSurface).not.toMatch(/(?:===|!==)\s*['"]copilotQuery['"]/);
			expect(decisionSurface).not.toContain("'copilotQuery'");
			expect(decisionSurface).not.toContain('"copilotQuery"');
		}

		for (const owner of [notebookProvider, overlay, kqlCompat, sqlCompat, webviewCapabilities, browserDocument]) {
			expect(owner).toContain('documentSectionCapabilities');
		}
		expect(markdownWebview).toContain("from '../core/document-capabilities.js'");
		expect(browserViewer).toContain("from './src/viewer-document'");
	});

	it('inventories raw factory calls and keeps legacy creation bridges capability-gated', () => {
		const factoryNames = new Set([
			'addQueryBox', 'addSqlBox', 'addChartBox', 'addTransformationBox',
			'addMarkdownBox', 'addPythonBox', 'addUrlBox', 'addHtmlBox',
		]);
		const bridgeNames = new Set([...factoryNames, 'addCopilotQueryBox']);
		const directCalls = new Map<string, number>();
		const bridgeAssignmentFiles = new Set<string>();
		const rawBridgeAssignments: string[] = [];

		for (const filePath of webviewSourceFiles()) {
			const relativePath = relative(process.cwd(), filePath).replace(/\\/g, '/');
			const syntaxKind = filePath.endsWith('.js') ? ts.ScriptKind.JS : ts.ScriptKind.TS;
			const root = ts.createSourceFile(filePath, readFileSync(filePath, 'utf8'), ts.ScriptTarget.Latest, true, syntaxKind);
			const visit = (node: ts.Node): void => {
				if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && factoryNames.has(node.expression.text)) {
					directCalls.set(node.expression.text, (directCalls.get(node.expression.text) ?? 0) + 1);
					expect(relativePath).toBe('src/webview/core/persistence.ts');
				}
				if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
					&& ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
					&& ['window', '_win'].includes(node.left.expression.text) && bridgeNames.has(node.left.name.text)) {
					bridgeAssignmentFiles.add(relativePath);
					if (ts.isIdentifier(node.right) && node.right.text === node.left.name.text) {
						rawBridgeAssignments.push(`${relativePath}:${node.left.name.text}`);
					}
				}
				ts.forEachChild(node, visit);
			};
			visit(root);
		}

		expect(Object.fromEntries([...directCalls].sort())).toEqual({
			addChartBox: 3,
			addHtmlBox: 2,
			addMarkdownBox: 5,
			addPythonBox: 3,
			addQueryBox: 5,
			addSqlBox: 4,
			addTransformationBox: 3,
			addUrlBox: 3,
		});
		expect([...bridgeAssignmentFiles].sort()).toEqual([
			'src/webview/core/persistence.ts',
			'src/webview/queryEditor.js',
		]);
		expect(rawBridgeAssignments).toEqual([]);
	});
});