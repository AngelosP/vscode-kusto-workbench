import * as assert from 'node:assert';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { discoverProvidersFromDirectory } from '../../src/connector/externalMcpConnectorNode';

suite('External MCP provider', () => {
	test('starts from the opt-in setting and forwards the live registered tool', async function () {
		if (process.platform !== 'win32' || process.arch !== 'x64') this.skip();
		this.timeout(60_000);
		const extension = vscode.extensions.getExtension('angelos-petropoulos.vscode-kusto-workbench');
		assert.ok(extension, 'Kusto Workbench extension should be installed in the test host.');
		await extension.activate();
		const localAppData = process.env.LOCALAPPDATA;
		assert.ok(localAppData, 'LOCALAPPDATA is required for Windows discovery.');
		const discoveryDirectory = join(localAppData, 'KustoWorkbench', 'McpConnector', 'discovery');
		const configuration = vscode.workspace.getConfiguration('kustoWorkbench');
		const previous = configuration.inspect<boolean>('externalTools.enabled')?.globalValue;
		const waitForProvider = async (present: boolean) => {
			const deadline = Date.now() + 30_000;
			while (Date.now() < deadline) {
				const providers = await discoverProvidersFromDirectory(discoveryDirectory);
				const provider = providers.find(candidate => candidate.processId === process.pid);
				if (!!provider === present) return provider;
				await new Promise(resolve => setTimeout(resolve, 100));
			}
			throw new Error(`Timed out waiting for provider present=${present}.`);
		};
		try {
			await configuration.update('externalTools.enabled', true, vscode.ConfigurationTarget.Global);
			const provider = await waitForProvider(true);
			assert.ok(provider, 'The current extension host provider should be discoverable.');
			const client = new Client(
				{ name: 'external-provider-integration-test', version: '1.0.0' },
				{ versionNegotiation: { mode: 'auto' } },
			);
			try {
				await client.connect(new StreamableHTTPClientTransport(new URL(provider.endpoint), {
					requestInit: { headers: { Authorization: `Bearer ${provider.token}` } },
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
				const bridgedText = bridged.content.map(part => part.type === 'text' ? part.text : '');
				assert.deepStrictEqual(bridgedText, directText);
			} finally {
				await client.close();
			}
			await configuration.update('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
			await waitForProvider(false);
			await configuration.update('externalTools.enabled', true, vscode.ConfigurationTarget.Global);
			const restarted = await waitForProvider(true);
			assert.ok(restarted, 'The provider should restart after re-enabling integration.');
			assert.strictEqual(restarted.instanceId, provider.instanceId);
			assert.notStrictEqual(restarted.endpoint, provider.endpoint);
			assert.notStrictEqual(restarted.token, provider.token);
			await configuration.update('externalTools.enabled', false, vscode.ConfigurationTarget.Global);
			await waitForProvider(false);
		} finally {
			await configuration.update('externalTools.enabled', previous, vscode.ConfigurationTarget.Global);
		}
	});
});