// @vitest-environment node
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import ts from 'typescript';

const source = ts.createSourceFile(
	'main.ts', readFileSync('src/webview/core/main.ts', 'utf8'), ts.ScriptTarget.Latest, true,
);
const runtimeGate = source.statements.find(statement => ts.isExpressionStatement(statement)
	&& ts.isBinaryExpression(statement.expression)
	&& statement.expression.left.getText(source) === 'pState.documentRuntimeActive');
const startup = source.statements.find(statement => ts.isIfStatement(statement)
	&& statement.expression.getText(source) === 'window.vscode');
if (!runtimeGate || !startup) throw new Error('Missing main webview startup boundary');
const script = ts.transpileModule(`${runtimeGate.getText(source)}\n${startup.getText(source)}`, {
	compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function initialize(bootstrapRequestedDocument: boolean, hasHost = true) {
	const postMessageToHost = vi.fn<(message: Record<string, unknown>) => void>();
	const pState = { documentRuntimeActive: true };
	runInNewContext(script, {
		pState,
		window: {
			vscode: hasHost ? {} : undefined,
			__kustoBootstrapRequestDocumentSent: bootstrapRequestedDocument,
		},
		document: { readyState: 'loading' },
		postMessageToHost,
		perfMark: vi.fn(),
		traceFileOpen: vi.fn(),
		console,
	});
	return { pState, messages: postMessageToHost.mock.calls.map(([message]) => message) };
}

describe('main webview startup', () => {
	it.each([false, true])(
		'does not request an inadmissible Kusto policy before document restore (early request=%s)',
		bootstrapRequestedDocument => {
			const { pState, messages } = initialize(bootstrapRequestedDocument);

			expect(pState.documentRuntimeActive).toBe(false);
			expect(messages.filter(message => message.type === 'getConnections')).toEqual([]);
			expect(messages.filter(message => message.type === 'requestDocument'))
				.toHaveLength(bootstrapRequestedDocument ? 0 : 1);
			expect(messages).toContainEqual({ type: 'getSqlConnections' });
			expect(messages).toContainEqual({ type: 'checkCopilotAvailability', boxId: '__kusto_global__' });
		},
	);

	it('does not request host metadata in a side-panel without the host bridge', () => {
		expect(initialize(false, false).messages).toEqual([]);
	});
});
