// @vitest-environment node

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	startWorkbenchMcpBridge,
	type RunningWorkbenchMcpBridge,
	writeWebResponse,
} from '../../../src/host/workbenchMcpBridge';

const token = 'provider-secret-that-is-long-enough-for-local-use';
const tool = {
	name: 'echoWorkbench',
	registeredName: 'kusto-workbench_echo',
	title: 'Echo Workbench',
	description: 'Returns the exact supplied text.',
	inputSchema: {
		type: 'object',
		additionalProperties: false,
		properties: { text: { type: 'string' } },
		required: ['text'],
	},
} as const;

async function connect(endpoint: string, authorizationToken: string): Promise<Client> {
	const client = new Client(
		{ name: 'kusto-workbench-test', version: '1.0.0' },
		{ versionNegotiation: { mode: 'auto' } },
	);
	await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
		requestInit: { headers: { Authorization: `Bearer ${authorizationToken}` } },
	}));
	return client;
}

describe('Workbench MCP bridge', () => {
	let bridge: RunningWorkbenchMcpBridge | undefined;
	const clients: Client[] = [];

	afterEach(async () => {
		await Promise.all(clients.splice(0).map(client => client.close()));
		await bridge?.close();
		bridge = undefined;
	});

	it('requires the provider secret and preserves catalog metadata, schema admission, and text results', async () => {
		const invokeTool = vi.fn(async (_registeredName: string, input: unknown) => ({
			textParts: [`first:${(input as { text: string }).text}`, 'second\nline'],
		}));
		bridge = await startWorkbenchMcpBridge({ tools: [tool], sharedAuthorizationToken: token, invokeTool });

		await expect(connect(bridge.endpoint, 'not-the-provider-secret')).rejects.toThrow();
		const client = await connect(bridge.endpoint, token);
		clients.push(client);
		const listed = await client.listTools();
		expect(listed.tools).toEqual([
			expect.objectContaining({
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}),
		]);

		const invalid = await client.callTool({ name: tool.name, arguments: { text: 'ok', extra: true } });
		expect(invalid.isError).toBe(true);
		expect(invokeTool).not.toHaveBeenCalled();
		const result = await client.callTool({ name: tool.name, arguments: { text: 'exact' } });
		expect(result.content).toEqual([
			{ type: 'text', text: 'first:exact' },
			{ type: 'text', text: 'second\nline' },
		]);
		expect(invokeTool).toHaveBeenCalledWith(tool.registeredName, { text: 'exact' }, expect.any(AbortSignal));
	});

	it('allows concurrent independent MCP sessions through one provider secret', async () => {
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			sharedAuthorizationToken: token,
			invokeTool: async (_name, input) => ({ textParts: [`ok:${(input as { text: string }).text}`] }),
		});
		const first = await connect(bridge.endpoint, token);
		const second = await connect(bridge.endpoint, token);
		clients.push(first, second);
		expect((await first.callTool({ name: tool.name, arguments: { text: 'first' } })).content)
			.toEqual([{ type: 'text', text: 'ok:first' }]);
		expect((await second.callTool({ name: tool.name, arguments: { text: 'second' } })).content)
			.toEqual([{ type: 'text', text: 'ok:second' }]);
		await first.close();
		expect((await second.callTool({ name: tool.name, arguments: { text: 'still-live' } })).content)
			.toEqual([{ type: 'text', text: 'ok:still-live' }]);
	});

	it('propagates one client cancellation to only that Workbench invocation', async () => {
		let observedSignal: AbortSignal | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>(resolve => { markStarted = resolve; });
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			sharedAuthorizationToken: token,
			invokeTool: (_name, _input, signal) => new Promise(resolve => {
				observedSignal = signal;
				markStarted?.();
				signal.addEventListener('abort', () => resolve({ textParts: ['late'] }), { once: true });
			}),
		});
		const client = await connect(bridge.endpoint, token);
		clients.push(client);
		const controller = new AbortController();
		const call = client.callTool({ name: tool.name, arguments: { text: 'cancel' } }, { signal: controller.signal });
		await started;
		controller.abort('test cancellation');
		await expect(call).rejects.toThrow();
		await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true), { timeout: 1000 });
	});

	it('cancels all active requests only when the provider closes', async () => {
		const signals: AbortSignal[] = [];
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			sharedAuthorizationToken: token,
			invokeTool: (_name, _input, signal) => new Promise(resolve => {
				signals.push(signal);
				signal.addEventListener('abort', () => resolve({ textParts: ['cancelled'] }), { once: true });
			}),
		});
		const first = await connect(bridge.endpoint, token);
		const second = await connect(bridge.endpoint, token);
		clients.push(first, second);
		const firstCall = first.callTool({ name: tool.name, arguments: { text: 'one' } });
		const secondCall = second.callTool({ name: tool.name, arguments: { text: 'two' } });
		await vi.waitFor(() => expect(signals).toHaveLength(2));
		await bridge.close();
		await vi.waitFor(() => expect(signals.every(signal => signal.aborted)).toBe(true));
		await expect(firstCall).rejects.toThrow();
		await expect(secondCall).rejects.toThrow();
	});

	it('releases a backpressured response when the client closes before drain', async () => {
		const events = new EventEmitter();
		const target = Object.assign(events, {
			destroyed: false,
			writableEnded: false,
			writeHead: vi.fn(),
			write: vi.fn(() => false),
			end: vi.fn(),
		});
		const delivery = writeWebResponse(
			new Response('x'.repeat(32_000)),
			target as unknown as ServerResponse,
			new AbortController().signal,
		).catch(error => error);
		await vi.waitFor(() => expect(target.write).toHaveBeenCalledOnce());
		target.destroyed = true;
		events.emit('close');
		expect(await delivery).toMatchObject({ message: 'MCP client closed during response delivery.' });
		expect(events.listenerCount('drain')).toBe(0);
		expect(events.listenerCount('close')).toBe(0);
		expect(events.listenerCount('error')).toBe(0);
		expect(target.end).not.toHaveBeenCalled();
	});

	it('cancels the source reader when response delivery errors before drain', async () => {
		const events = new EventEmitter();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new TextEncoder().encode('x'.repeat(32_000))); },
			cancel,
		});
		const target = Object.assign(events, {
			destroyed: false,
			writableEnded: false,
			writeHead: vi.fn(),
			write: vi.fn(() => false),
			end: vi.fn(),
		});
		const delivery = writeWebResponse(
			new Response(body),
			target as unknown as ServerResponse,
			new AbortController().signal,
		).catch(error => error);
		await vi.waitFor(() => expect(target.write).toHaveBeenCalledOnce());
		events.emit('error', new Error('socket failed'));
		expect(await delivery).toMatchObject({ message: 'socket failed' });
		expect(cancel).toHaveBeenCalledOnce();
	});

	it('cancels a response stream when the client closes before the first chunk', async () => {
		const events = new EventEmitter();
		const cancel = vi.fn();
		const body = new ReadableStream<Uint8Array>({ cancel });
		const target = Object.assign(events, {
			destroyed: false,
			writableEnded: false,
			writeHead: vi.fn(),
			write: vi.fn(() => true),
			end: vi.fn(),
		});
		const delivery = writeWebResponse(
			new Response(body),
			target as unknown as ServerResponse,
			new AbortController().signal,
		).catch(error => error);
		await vi.waitFor(() => expect(events.listenerCount('close')).toBe(1));
		target.destroyed = true;
		events.emit('close');
		expect(await delivery).toMatchObject({ message: 'MCP client closed during response delivery.' });
		expect(cancel).toHaveBeenCalledOnce();
		expect(target.write).not.toHaveBeenCalled();
	});

	it('keeps provider secrets isolated across independent Workbench windows', async () => {
		const firstToken = 'first-provider-secret-that-is-long-enough';
		const secondToken = 'second-provider-secret-that-is-long-enough';
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			sharedAuthorizationToken: firstToken,
			invokeTool: async () => ({ textParts: ['first-window'] }),
		});
		const secondBridge = await startWorkbenchMcpBridge({
			tools: [tool],
			sharedAuthorizationToken: secondToken,
			invokeTool: async () => ({ textParts: ['second-window'] }),
		});
		try {
			await expect(connect(bridge.endpoint, secondToken)).rejects.toThrow();
			await expect(connect(secondBridge.endpoint, firstToken)).rejects.toThrow();
			const first = await connect(bridge.endpoint, firstToken);
			const second = await connect(secondBridge.endpoint, secondToken);
			clients.push(first, second);
			expect((await first.callTool({ name: tool.name, arguments: { text: 'one' } })).content)
				.toEqual([{ type: 'text', text: 'first-window' }]);
			expect((await second.callTool({ name: tool.name, arguments: { text: 'two' } })).content)
				.toEqual([{ type: 'text', text: 'second-window' }]);
		} finally {
			await secondBridge.close();
		}
	});
});
