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

async function connect(endpoint: string, token: string): Promise<Client> {
	const client = new Client(
		{ name: 'kusto-workbench-test', version: '1.0.0' },
		{ versionNegotiation: { mode: 'auto' } },
	);
	await client.connect(new StreamableHTTPClientTransport(new URL(endpoint), {
		requestInit: { headers: { Authorization: `Bearer ${token}` } },
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

	it('requires a live lease and preserves catalog metadata, schema admission, and text results', async () => {
		const invokeTool = vi.fn(async (_registeredName: string, input: unknown) => ({
			textParts: [`first:${(input as { text: string }).text}`, 'second\nline'],
		}));
		bridge = await startWorkbenchMcpBridge({ tools: [tool], invokeTool });

		await expect(connect(bridge.endpoint, 'not-a-lease')).rejects.toThrow();
		const lease = bridge.createLease();
		const client = await connect(bridge.endpoint, lease.token);
		clients.push(client);
		expect(await lease.authenticated).toBe(true);

		const listed = await client.listTools();
		expect(listed.tools).toEqual([
			expect.objectContaining({
				name: tool.name,
				title: tool.title,
				description: tool.description,
				inputSchema: tool.inputSchema,
			}),
		]);

		const invalid = await client.callTool({
			name: tool.name,
			arguments: { text: 'ok', extra: true },
		});
		expect(invalid.isError).toBe(true);
		expect(invokeTool).not.toHaveBeenCalled();

		const result = await client.callTool({ name: tool.name, arguments: { text: 'exact' } });
		expect(result.content).toEqual([
			{ type: 'text', text: 'first:exact' },
			{ type: 'text', text: 'second\nline' },
		]);
		expect(invokeTool).toHaveBeenCalledWith(
			tool.registeredName,
			{ text: 'exact' },
			expect.any(AbortSignal),
		);
	});

	it('revokes one client without affecting another lease', async () => {
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			invokeTool: async () => ({ textParts: ['ok'] }),
		});
		const firstLease = bridge.createLease();
		const secondLease = bridge.createLease();
		const first = await connect(bridge.endpoint, firstLease.token);
		const second = await connect(bridge.endpoint, secondLease.token);
		clients.push(first, second);

		firstLease.revoke();
		await expect(first.listTools()).rejects.toThrow();
		expect((await second.callTool({ name: tool.name, arguments: { text: 'still-live' } })).content)
			.toEqual([{ type: 'text', text: 'ok' }]);
	});

	it('propagates client cancellation to the Workbench invocation', async () => {
		let observedSignal: AbortSignal | undefined;
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>(resolve => { markStarted = resolve; });
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			invokeTool: (_name, _input, signal) => new Promise((resolve) => {
				observedSignal = signal;
				markStarted?.();
				signal.addEventListener('abort', () => resolve({ textParts: ['late'] }), { once: true });
			}),
		});
		const lease = bridge.createLease();
		const client = await connect(bridge.endpoint, lease.token);
		clients.push(client);
		const controller = new AbortController();

		const call = client.callTool(
			{ name: tool.name, arguments: { text: 'cancel' } },
			{ signal: controller.signal },
		);
		await started;
		controller.abort('test cancellation');

		await expect(call).rejects.toThrow();
		await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true), { timeout: 1000 });
	});

	it('cancels active calls for a revoked lease without revoking another client', async () => {
		let firstSignal: AbortSignal | undefined;
		let firstStarted: (() => void) | undefined;
		const started = new Promise<void>(resolve => { firstStarted = resolve; });
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			invokeTool: (_name, input, signal) => {
				if ((input as { text: string }).text !== 'hold') return Promise.resolve({ textParts: ['second-ok'] });
				firstSignal = signal;
				firstStarted?.();
				return new Promise(resolve => {
					signal.addEventListener('abort', () => resolve({ textParts: ['cancelled'] }), { once: true });
				});
			},
		});
		const firstLease = bridge.createLease();
		const secondLease = bridge.createLease();
		const first = await connect(bridge.endpoint, firstLease.token);
		const second = await connect(bridge.endpoint, secondLease.token);
		clients.push(first, second);

		const heldCall = first.callTool({ name: tool.name, arguments: { text: 'hold' } });
		await started;
		firstLease.revoke();

		await vi.waitFor(() => expect(firstSignal?.aborted).toBe(true), { timeout: 1000 });
		await expect(heldCall).rejects.toThrow();
		expect((await second.callTool({ name: tool.name, arguments: { text: 'second' } })).content)
			.toEqual([{ type: 'text', text: 'second-ok' }]);
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
			start(controller) {
				controller.enqueue(new TextEncoder().encode('x'.repeat(32_000)));
			},
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
		expect(events.listenerCount('drain')).toBe(0);
		expect(events.listenerCount('close')).toBe(0);
		expect(events.listenerCount('error')).toBe(0);
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
		expect(events.listenerCount('close')).toBe(0);
		expect(events.listenerCount('error')).toBe(0);
	});

	it('keeps leases isolated across independent Workbench bridge instances', async () => {
		bridge = await startWorkbenchMcpBridge({
			tools: [tool],
			invokeTool: async () => ({ textParts: ['first-window'] }),
		});
		const secondBridge = await startWorkbenchMcpBridge({
			tools: [tool],
			invokeTool: async () => ({ textParts: ['second-window'] }),
		});
		try {
			const firstLease = bridge.createLease();
			const secondLease = secondBridge.createLease();
			await expect(connect(bridge.endpoint, secondLease.token)).rejects.toThrow();
			await expect(connect(secondBridge.endpoint, firstLease.token)).rejects.toThrow();
			const first = await connect(bridge.endpoint, firstLease.token);
			const second = await connect(secondBridge.endpoint, secondLease.token);
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