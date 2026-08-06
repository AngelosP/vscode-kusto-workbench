import * as path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	HostResourceUriApplicationHandler,
	type ResourceUriApplicationHandlerOptions,
} from '../../../src/host/resourceUriApplicationHandler';

const liveHandlers = new Set<HostResourceUriApplicationHandler>();
const DEFAULT_BASE_URI = 'file:///C:/workspace/docs/document.mdx';
const WEBVIEW_URI = 'vscode-webview://resource/assets/logo.png';

type HandlerOverrides = Partial<Omit<ResourceUriApplicationHandlerOptions, 'postMessage'>>;

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function resourceMessage(
	pathValue = 'assets/logo.png',
	requestId = 'resource-request',
	baseUri?: string,
) {
	const resolvedBaseUri = arguments.length >= 3 ? baseUri : DEFAULT_BASE_URI;
	return { type: 'resolveResourceUri' as const, requestId, path: pathValue, baseUri: resolvedBaseUri };
}

function createHandler(overrides: HandlerOverrides = {}) {
	const postMessage = vi.fn(() => Promise.resolve(true));
	const stat = vi.fn(overrides.stat ?? (async () => ({} as vscode.FileStat)));
	const getWorkspaceFolder = vi.fn(overrides.getWorkspaceFolder ?? (() => undefined));
	const asWebviewUri = vi.fn(overrides.asWebviewUri ?? (() => vscode.Uri.parse(WEBVIEW_URI)));
	const handler = new HostResourceUriApplicationHandler({
		postMessage,
		stat,
		getWorkspaceFolder,
		asWebviewUri,
		platform: overrides.platform ?? 'win32',
	});
	liveHandlers.add(handler);
	return { handler, postMessage, stat, getWorkspaceFolder, asWebviewUri };
}

describe('HostResourceUriApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, postMessage, stat, asWebviewUri } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(postMessage).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(asWebviewUri).not.toHaveBeenCalled();
	});

	it('publishes nothing without a request identity', async () => {
		const { handler, postMessage, stat, asWebviewUri } = createHandler();

		await handler.handleMessage(resourceMessage('assets/logo.png', ''));

		expect(postMessage).not.toHaveBeenCalled();
		expect(stat).not.toHaveBeenCalled();
		expect(asWebviewUri).not.toHaveBeenCalled();
	});

	it('preserves the exact empty-path failure', async () => {
		const { handler, postMessage, stat, asWebviewUri } = createHandler();

		await handler.handleMessage(resourceMessage('  '));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'resolveResourceUriResult', requestId: 'resource-request', ok: false, error: 'Empty path.',
		});
		expect(stat).not.toHaveBeenCalled();
		expect(asWebviewUri).not.toHaveBeenCalled();
	});

	it.each([
		'http://example.test/logo.png',
		'https://example.test/logo.png',
		'data:image/png;base64,abc',
		'blob:https://example.test/id',
		'vscode-webview://authority/logo.png',
		'vscode-resource:/authority/logo.png',
	])('trims and passes through %s without local resolution', async rawPath => {
		const { handler, postMessage, stat, getWorkspaceFolder, asWebviewUri } = createHandler();

		await handler.handleMessage(resourceMessage(`  ${rawPath}  `, 'passthrough-request', undefined));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'resolveResourceUriResult', requestId: 'passthrough-request', ok: true, uri: rawPath,
		});
		expect(stat).not.toHaveBeenCalled();
		expect(getWorkspaceFolder).not.toHaveBeenCalled();
		expect(asWebviewUri).not.toHaveBeenCalled();
	});

	it.each([undefined, '', 'https://example.test/document.mdx'])(
		'rejects a missing or non-file base URI (%s)',
		async baseUri => {
			const { handler, postMessage, stat } = createHandler();

			await handler.handleMessage(resourceMessage('assets/logo.png', 'base-request', baseUri));

			expect(postMessage).toHaveBeenCalledWith({
				type: 'resolveResourceUriResult', requestId: 'base-request', ok: false,
				error: 'Missing or unsupported baseUri. Only local files are supported.',
			});
			expect(stat).not.toHaveBeenCalled();
		},
	);

	it('rejects a malformed base URI with the same unsupported-base failure', async () => {
		vi.spyOn(vscode.Uri, 'parse').mockImplementationOnce(() => {
			throw new Error('malformed URI');
		});
		const { handler, postMessage, stat } = createHandler();

		await handler.handleMessage(resourceMessage('assets/logo.png', 'malformed-request', 'malformed'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'resolveResourceUriResult', requestId: 'malformed-request', ok: false,
			error: 'Missing or unsupported baseUri. Only local files are supported.',
		});
		expect(stat).not.toHaveBeenCalled();
	});

	it.each(['win32', 'linux'] as const)(
		'resolves leading-slash paths from the workspace root on %s',
		async platform => {
			const workspaceUri = vscode.Uri.file(platform === 'win32' ? 'C:/workspace' : '/workspace');
			const baseUri = platform === 'win32'
				? DEFAULT_BASE_URI
				: 'file:///workspace/docs/document.mdx';
			const { handler, postMessage, stat, getWorkspaceFolder, asWebviewUri } = createHandler({
				platform,
				getWorkspaceFolder: () => ({ uri: workspaceUri } as vscode.WorkspaceFolder),
			});

			await handler.handleMessage(resourceMessage('/assets/images/logo.png', 'workspace-request', baseUri));

			expect(getWorkspaceFolder).toHaveBeenCalledOnce();
			expect(stat).toHaveBeenCalledWith(expect.objectContaining({
				fsPath: platform === 'win32'
					? 'C:/workspace/assets/images/logo.png'
					: '/workspace/assets/images/logo.png',
			}));
			expect(asWebviewUri).toHaveBeenCalledWith(stat.mock.calls[0][0]);
			expect(postMessage).toHaveBeenCalledWith({
				type: 'resolveResourceUriResult', requestId: 'workspace-request', ok: true, uri: WEBVIEW_URI,
			});
		},
	);

	it('normalizes relative Markdown backslashes against the base directory', async () => {
		const { handler, stat, getWorkspaceFolder, asWebviewUri } = createHandler({ platform: 'win32' });

		await handler.handleMessage(resourceMessage('assets\\images\\logo.png'));

		expect(getWorkspaceFolder).not.toHaveBeenCalled();
		expect(stat).toHaveBeenCalledWith(expect.objectContaining({
			fsPath: path.win32.resolve('C:/workspace/docs', 'assets/images/logo.png'),
		}));
		expect(asWebviewUri).toHaveBeenCalledWith(stat.mock.calls[0][0]);
	});

	it('falls leading-slash paths back to the base directory without a workspace folder', async () => {
		const { handler, stat } = createHandler({ platform: 'linux' });

		await handler.handleMessage(resourceMessage(
			'/opt/media/logo.png', 'posix-request', 'file:///home/user/docs/document.mdx',
		));

		expect(stat).toHaveBeenCalledWith(expect.objectContaining({
			fsPath: path.posix.resolve('/home/user/docs', 'opt/media/logo.png'),
		}));
	});

	it('preserves Windows drive paths as absolute on every platform', async () => {
		const { handler, stat } = createHandler({ platform: 'linux' });

		await handler.handleMessage(resourceMessage('D:\\media\\logo.png'));

		expect(stat).toHaveBeenCalledWith(expect.objectContaining({ fsPath: 'D:/media/logo.png' }));
	});

	it('preserves existing UNC normalization through the leading-slash workspace path', async () => {
		const { handler, stat } = createHandler({
			platform: 'win32',
			getWorkspaceFolder: () => ({ uri: vscode.Uri.file('C:/workspace') } as vscode.WorkspaceFolder),
		});

		await handler.handleMessage(resourceMessage('\\\\server\\share\\logo.png'));

		expect(stat).toHaveBeenCalledWith(expect.objectContaining({
			fsPath: 'C:/workspace/server/share/logo.png',
		}));
	});

	it('preserves path-resolution failure shaping', async () => {
		const { handler, postMessage, stat } = createHandler({
			getWorkspaceFolder: () => { throw new Error('workspace lookup failed'); },
		});

		await handler.handleMessage(resourceMessage('/assets/logo.png'));

		expect(postMessage).toHaveBeenCalledWith({
			type: 'resolveResourceUriResult', requestId: 'resource-request', ok: false,
			error: 'Failed to resolve path: workspace lookup failed',
		});
		expect(stat).not.toHaveBeenCalled();
	});

	it('publishes File not found without attempting webview conversion', async () => {
		const { handler, postMessage, stat, asWebviewUri } = createHandler({
			stat: async () => { throw new Error('missing'); },
		});

		await handler.handleMessage(resourceMessage());

		expect(stat).toHaveBeenCalledOnce();
		expect(asWebviewUri).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'resolveResourceUriResult', requestId: 'resource-request', ok: false, error: 'File not found.',
		});
	});

	it('stats before reporting that the webview panel is unavailable', async () => {
		const order: string[] = [];
		const { handler, postMessage } = createHandler({
			stat: async () => { order.push('stat'); return {} as vscode.FileStat; },
			asWebviewUri: () => { order.push('panel'); return undefined; },
		});

		await handler.handleMessage(resourceMessage());

		expect(order).toEqual(['stat', 'panel']);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'resolveResourceUriResult', requestId: 'resource-request', ok: false,
			error: 'Webview panel is not available.',
		});
	});

	it('caches by the exact parsed base URI and raw path before stat and panel checks', async () => {
		const { handler, postMessage, stat, asWebviewUri } = createHandler();

		await handler.handleMessage(resourceMessage('assets/logo.png', 'request-1'));
		await handler.handleMessage(resourceMessage('assets/logo.png', 'request-2'));
		await handler.handleMessage(resourceMessage('assets\\logo.png', 'request-3'));

		expect(stat).toHaveBeenCalledTimes(2);
		expect(asWebviewUri).toHaveBeenCalledTimes(2);
		expect(postMessage.mock.calls.map(call => call[0])).toEqual([
			{ type: 'resolveResourceUriResult', requestId: 'request-1', ok: true, uri: WEBVIEW_URI },
			{ type: 'resolveResourceUriResult', requestId: 'request-2', ok: true, uri: WEBVIEW_URI },
			{ type: 'resolveResourceUriResult', requestId: 'request-3', ok: true, uri: WEBVIEW_URI },
		]);
	});

	it.each(['throw', 'stringify'] as const)(
		'preserves webview URI conversion failure shaping for %s failures',
		async failure => {
			const { handler, postMessage } = createHandler({
				asWebviewUri: failure === 'throw'
					? () => { throw new Error('conversion failed'); }
					: () => ({ toString: () => { throw new Error('conversion failed'); } } as vscode.Uri),
			});

			await handler.handleMessage(resourceMessage());

			expect(postMessage).toHaveBeenCalledWith({
				type: 'resolveResourceUriResult', requestId: 'resource-request', ok: false,
				error: 'Failed to create webview URI: conversion failed',
			});
		},
	);

	it('contains synchronous response transport failure', async () => {
		const { handler, postMessage } = createHandler();
		postMessage.mockImplementation(() => { throw new Error('transport failed'); });

		await expect(handler.handleMessage(resourceMessage('https://example.test/logo.png'))).resolves.toBeUndefined();
	});

	it.each(['resolve', 'reject'] as const)(
		'suppresses late stat %s after disposal',
		async outcome => {
			const pendingStat = deferred<vscode.FileStat>();
			const { handler, postMessage, asWebviewUri } = createHandler({ stat: () => pendingStat.promise });
			const request = handler.handleMessage(resourceMessage())!;
			await Promise.resolve();

			handler.dispose();
			if (outcome === 'resolve') pendingStat.resolve({} as vscode.FileStat);
			else pendingStat.reject(new Error('late stat failure'));
			await request;

			expect(postMessage).not.toHaveBeenCalled();
			expect(asWebviewUri).not.toHaveBeenCalled();
		},
	);

	it.each(['resolve', 'reject'] as const)(
		'suppresses late webview URI conversion %s after disposal',
		async outcome => {
			const pendingConversion = deferred<vscode.Uri | undefined>();
			const { handler, postMessage, asWebviewUri } = createHandler({
				asWebviewUri: () => pendingConversion.promise,
			});
			const request = handler.handleMessage(resourceMessage())!;
			await vi.waitFor(() => expect(asWebviewUri).toHaveBeenCalledOnce());

			handler.dispose();
			if (outcome === 'resolve') pendingConversion.resolve(vscode.Uri.parse(WEBVIEW_URI));
			else pendingConversion.reject(new Error('late conversion failure'));
			await request;

			expect(postMessage).not.toHaveBeenCalled();
		},
	);

	it('clears cached URI state and suppresses later requests when disposed', async () => {
		const { handler, postMessage, stat } = createHandler();
		const cache = (handler as unknown as {
			resolvedResourceUriCache: Map<string, string>;
		}).resolvedResourceUriCache;
		await handler.handleMessage(resourceMessage());
		expect(cache.size).toBe(1);

		handler.dispose();
		await handler.handleMessage(resourceMessage('https://example.test/after-dispose.png', 'after-dispose'));

		expect(cache.size).toBe(0);
		expect(postMessage).toHaveBeenCalledOnce();
		expect(stat).toHaveBeenCalledOnce();
	});
});