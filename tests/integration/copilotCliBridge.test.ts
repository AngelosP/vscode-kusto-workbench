import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { buildWorkbenchMcpToolDefinitions } from '../../src/host/copilotCliIntegration';
import { startWorkbenchMcpBridge } from '../../src/host/workbenchMcpBridge';

suite('Copilot CLI bridge', () => {
	test('returns the exact registered Workbench tool result through MCP', async () => {
		const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
		assert.ok(extension, 'Kusto Workbench extension should be installed in the test host.');
		await extension.activate();
		const contributions = extension.packageJSON.contributes.languageModelTools;
		const definitions = buildWorkbenchMcpToolDefinitions(contributions, vscode.lm.tools);
		const invoke = async (registeredName: string, input: unknown, signal: AbortSignal) => {
			const cancellation = new vscode.CancellationTokenSource();
			const cancel = () => cancellation.cancel();
			signal.addEventListener('abort', cancel, { once: true });
			try {
				const result = await vscode.lm.invokeTool(registeredName, {
					input: input as object,
					toolInvocationToken: undefined,
				}, cancellation.token);
				return {
					textParts: result.content.map(part => {
						assert.ok(part instanceof vscode.LanguageModelTextPart, 'Workbench tool result should contain text only.');
						return part.value;
					}),
				};
			} finally {
				signal.removeEventListener('abort', cancel);
				cancellation.dispose();
			}
		};
		const bridge = await startWorkbenchMcpBridge({ tools: definitions, invokeTool: invoke });
		const lease = bridge.createLease();
		const client = new Client(
			{ name: 'kusto-workbench-integration-test', version: '1.0.0' },
			{ versionNegotiation: { mode: 'auto' } },
		);
		try {
			await client.connect(new StreamableHTTPClientTransport(new URL(bridge.endpoint), {
				requestInit: { headers: { Authorization: `Bearer ${lease.token}` } },
			}));
			const direct = await vscode.lm.invokeTool('kusto-workbench_list-connections', {
				input: {},
				toolInvocationToken: undefined,
			});
			const bridged = await client.callTool({ name: 'listKustoConnections', arguments: {} });
			const directText = direct.content.map(part => {
				assert.ok(part instanceof vscode.LanguageModelTextPart);
				return part.value;
			});
			const bridgedText = bridged.content.map(part => {
				assert.strictEqual(part.type, 'text');
				return 'text' in part ? part.text : '';
			});
			assert.strictEqual(definitions.length, 26);
			assert.deepStrictEqual(bridgedText, directText);
		} finally {
			await client.close();
			lease.revoke();
			await bridge.close();
		}
	});
});