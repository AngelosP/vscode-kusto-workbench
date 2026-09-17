import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import {
	createMcpHandler,
	fromJsonSchema,
	McpServer,
} from '@modelcontextprotocol/server';
import {
	localhostHostValidation,
	localhostOriginValidation,
	toWebRequest,
} from '@modelcontextprotocol/node';
import type { CopilotCliBridge, CopilotCliLease } from './copilotCliSessionManager';

export interface WorkbenchMcpToolDefinition {
	readonly name: string;
	readonly registeredName: string;
	readonly title?: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

export interface WorkbenchMcpInvocationResult {
	readonly textParts: readonly string[];
}

export interface StartWorkbenchMcpBridgeOptions {
	readonly tools: readonly WorkbenchMcpToolDefinition[];
	readonly invokeTool: (
		registeredName: string,
		input: unknown,
		signal: AbortSignal,
	) => Promise<WorkbenchMcpInvocationResult>;
	readonly version?: string;
	readonly onError?: (error: Error) => void;
}

export interface RunningWorkbenchMcpBridge extends CopilotCliBridge {
	readonly toolCount: number;
}

function bearerToken(request: IncomingMessage): string | undefined {
	const header = request.headers.authorization;
	if (typeof header !== 'string' || !header.startsWith('Bearer ')) return undefined;
	const token = header.slice('Bearer '.length);
	return token.length > 0 ? token : undefined;
}

function tokensEqual(left: string, right: string): boolean {
	const leftBytes = Buffer.from(left);
	const rightBytes = Buffer.from(right);
	return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function writeJsonError(response: ServerResponse, status: number, message: string): void {
	response.writeHead(status, {
		'content-type': 'application/json; charset=utf-8',
		...(status === 401 ? { 'www-authenticate': 'Bearer' } : {}),
	});
	response.end(JSON.stringify({
		jsonrpc: '2.0',
		id: null,
		error: { code: -32001, message },
	}));
}

function abortError(signal: AbortSignal, fallback: string): Error {
	return signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason || fallback));
}

function waitForDrain(target: ServerResponse, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const cleanup = () => {
			target.off('drain', onDrain);
			target.off('close', onClose);
			target.off('error', onError);
			signal.removeEventListener('abort', onAbort);
		};
		const settle = (error?: Error) => {
			cleanup();
			if (error) reject(error);
			else resolve();
		};
		const onDrain = () => settle();
		const onClose = () => settle(new Error('MCP client closed during response delivery.'));
		const onError = (error: Error) => settle(error);
		const onAbort = () => settle(abortError(signal, 'MCP response delivery was cancelled.'));
		target.once('drain', onDrain);
		target.once('close', onClose);
		target.once('error', onError);
		signal.addEventListener('abort', onAbort, { once: true });
		if (target.destroyed) onClose();
		else if (signal.aborted) onAbort();
	});
}

function readResponseChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	target: ServerResponse,
	signal: AbortSignal,
): Promise<{ done: boolean; value?: Uint8Array }> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => {
			target.off('close', onClose);
			target.off('error', onError);
			signal.removeEventListener('abort', onAbort);
		};
		const settle = (result?: { done: boolean; value?: Uint8Array }, error?: Error) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) reject(error);
			else resolve(result!);
		};
		const onClose = () => settle(undefined, new Error('MCP client closed during response delivery.'));
		const onError = (error: Error) => settle(undefined, error);
		const onAbort = () => settle(undefined, abortError(signal, 'MCP response delivery was cancelled.'));
		target.once('close', onClose);
		target.once('error', onError);
		signal.addEventListener('abort', onAbort, { once: true });
		if (target.destroyed) {
			onClose();
			return;
		}
		if (signal.aborted) {
			onAbort();
			return;
		}
		void reader.read().then(result => settle(result), error => {
			settle(undefined, error instanceof Error ? error : new Error(String(error)));
		});
	});
}

export async function writeWebResponse(source: Response, target: ServerResponse, signal: AbortSignal): Promise<void> {
	const headers: Record<string, string> = {};
	source.headers.forEach((value, name) => { headers[name] = value; });
	target.writeHead(source.status, headers);
	if (!source.body) {
		target.end();
		return;
	}
	const reader = source.body.getReader();
	let completed = false;
	try {
		while (true) {
			if (signal.aborted) throw abortError(signal, 'MCP response delivery was cancelled.');
			const next = await readResponseChunk(reader, target, signal);
			if (next.done) break;
			if (!target.write(next.value)) {
				await waitForDrain(target, signal);
			}
		}
		if (!target.writableEnded) target.end();
		completed = true;
	} finally {
		if (!completed) {
			await reader.cancel(signal.reason).catch(() => undefined);
		}
		reader.releaseLock();
	}
}

function validateTools(tools: readonly WorkbenchMcpToolDefinition[]): void {
	if (tools.length === 0) throw new Error('The Workbench MCP bridge requires at least one tool.');
	const publicNames = new Set<string>();
	const registeredNames = new Set<string>();
	for (const tool of tools) {
		if (!tool.name.trim() || !tool.registeredName.trim() || !tool.description.trim()) {
			throw new Error('Workbench MCP tool names and descriptions must be non-empty.');
		}
		if (publicNames.has(tool.name)) throw new Error(`Duplicate Workbench MCP tool name: ${tool.name}`);
		if (registeredNames.has(tool.registeredName)) {
			throw new Error(`Duplicate registered Workbench tool name: ${tool.registeredName}`);
		}
		publicNames.add(tool.name);
		registeredNames.add(tool.registeredName);
	}
}

export async function startWorkbenchMcpBridge(
	options: StartWorkbenchMcpBridgeOptions,
): Promise<RunningWorkbenchMcpBridge> {
	validateTools(options.tools);
	const leases = new Map<string, { id: string; markAuthenticated(): void; revokeBeforeAuthentication(): void }>();
	const activeRequests = new Map<string, Set<AbortController>>();
	let closed = false;
	let closePromise: Promise<void> | undefined;

	const handler = createMcpHandler(() => {
		const mcp = new McpServer({
			name: 'kusto-workbench',
			version: options.version || '0.0.0',
		});
		for (const tool of options.tools) {
			mcp.registerTool(
				tool.name,
				{
					...(tool.title ? { title: tool.title } : {}),
					description: tool.description,
					inputSchema: fromJsonSchema(tool.inputSchema),
				},
				async (input, context) => {
					const result = await options.invokeTool(
						tool.registeredName,
						input,
						context.mcpReq.signal,
					);
					return {
						content: result.textParts.map(text => ({ type: 'text' as const, text })),
					};
				},
			);
		}
		return mcp;
	}, {
		onerror: error => options.onError?.(error),
	});
	const validateHost = localhostHostValidation();
	const validateOrigin = localhostOriginValidation();

	const server = createServer((request, response) => {
		if (closed) {
			writeJsonError(response, 503, 'Kusto Workbench MCP bridge is stopping.');
			return;
		}
		let pathname: string;
		try {
			pathname = new URL(request.url || '/', 'http://127.0.0.1').pathname;
		} catch {
			writeJsonError(response, 400, 'Invalid request URL.');
			return;
		}
		if (pathname !== '/mcp') {
			writeJsonError(response, 404, 'Not found.');
			return;
		}
		if (!validateHost(request, response) || !validateOrigin(request, response)) return;
		const suppliedToken = bearerToken(request);
		const authorizedToken = suppliedToken === undefined
			? undefined
			: [...leases.keys()].find(candidate => tokensEqual(candidate, suppliedToken));
		if (!authorizedToken) {
			writeJsonError(response, 401, 'A current Kusto Workbench CLI lease is required.');
			return;
		}
		leases.get(authorizedToken)?.markAuthenticated();
		const abortController = new AbortController();
		let leaseRequests = activeRequests.get(authorizedToken);
		if (!leaseRequests) {
			leaseRequests = new Set<AbortController>();
			activeRequests.set(authorizedToken, leaseRequests);
		}
		leaseRequests.add(abortController);
		const abortRequest = () => {
			if (!response.writableEnded) abortController.abort('MCP client disconnected.');
		};
		request.once('aborted', abortRequest);
		response.once('close', abortRequest);
		void (async () => {
			const webRequest = await toWebRequest(request, undefined, { signal: abortController.signal });
			const webResponse = await handler.fetch(webRequest);
			await writeWebResponse(webResponse, response, abortController.signal);
		})().catch(error => {
			options.onError?.(error instanceof Error ? error : new Error(String(error)));
			if (!response.headersSent && !abortController.signal.aborted) writeJsonError(response, 500, 'MCP request failed.');
			else if (!response.writableEnded) response.end();
		}).finally(() => {
			request.off('aborted', abortRequest);
			response.off('close', abortRequest);
			leaseRequests?.delete(abortController);
			if (leaseRequests?.size === 0) activeRequests.delete(authorizedToken);
		});
	});

	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off('listening', onListening);
			reject(error);
		};
		const onListening = () => {
			server.off('error', onError);
			resolve();
		};
		server.once('error', onError);
		server.once('listening', onListening);
		server.listen(0, '127.0.0.1');
	});
	const address = server.address();
	if (!address || typeof address === 'string') {
		server.close();
		await handler.close();
		throw new Error('Kusto Workbench MCP bridge did not acquire a loopback port.');
	}

	const close = (): Promise<void> => {
		if (closePromise) return closePromise;
		closed = true;
		for (const lease of leases.values()) lease.revokeBeforeAuthentication();
		leases.clear();
		for (const requests of activeRequests.values()) {
			for (const request of requests) request.abort('Kusto Workbench MCP bridge closed.');
		}
		activeRequests.clear();
		const operation = (async () => {
			const serverClosed = new Promise<void>((resolve, reject) => {
				server.close(error => {
					if (!error || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
					else reject(error);
				});
				server.closeAllConnections();
			});
			await handler.close();
			await serverClosed;
		})();
		const retryableClose = operation.catch(error => {
			if (closePromise === retryableClose) closePromise = undefined;
			throw error;
		});
		closePromise = retryableClose;
		return closePromise;
	};

	return {
		endpoint: `http://127.0.0.1:${address.port}/mcp`,
		toolCount: options.tools.length,
		createLease(): CopilotCliLease {
			if (closed) throw new Error('Kusto Workbench MCP bridge is closed.');
			const id = randomUUID();
			const token = randomBytes(32).toString('base64url');
			let settleAuthentication: ((authenticated: boolean) => void) | undefined;
			const authenticated = new Promise<boolean>(resolve => { settleAuthentication = resolve; });
			let authenticationSettled = false;
			const settle = (value: boolean) => {
				if (authenticationSettled) return;
				authenticationSettled = true;
				settleAuthentication?.(value);
			};
			leases.set(token, { id, markAuthenticated: () => settle(true), revokeBeforeAuthentication: () => settle(false) });
			let revoked = false;
			return {
				id,
				token,
				authenticated,
				revoke() {
					if (revoked) return;
					revoked = true;
					leases.get(token)?.revokeBeforeAuthentication();
					leases.delete(token);
					const requests = activeRequests.get(token);
					if (requests) {
						for (const request of requests) request.abort('Copilot CLI lease revoked.');
						activeRequests.delete(token);
					}
				},
			};
		},
		close,
	};
}