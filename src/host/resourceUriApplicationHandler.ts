import * as path from 'path';
import * as vscode from 'vscode';

import { getErrorMessage } from './queryEditorUtils';
import type { IncomingWebviewMessage } from './queryEditorTypes';
import {
	isResourceUriWebviewMessageType,
	parseResourceUriWebviewMessage,
	type ResourceUriHostMessage,
	type ResourceUriRequestMessage,
} from '../shared/resourceUriProtocol';

export interface ResourceUriApplicationHandler {
	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined;
	dispose(): void;
}

export type ResourceUriApplicationHandlerOptions = {
	postMessage: (message: ResourceUriHostMessage) => Thenable<boolean>;
	asWebviewUri: (uri: vscode.Uri) => vscode.Uri | Thenable<vscode.Uri | undefined> | undefined;
	stat?: (uri: vscode.Uri) => Thenable<vscode.FileStat>;
	getWorkspaceFolder?: (uri: vscode.Uri) => vscode.WorkspaceFolder | undefined;
	platform?: NodeJS.Platform;
};

export class HostResourceUriApplicationHandler implements ResourceUriApplicationHandler {
	private readonly resolvedResourceUriCache = new Map<string, string>();
	private readonly stat: (uri: vscode.Uri) => Thenable<vscode.FileStat>;
	private readonly getWorkspaceFolder: (uri: vscode.Uri) => vscode.WorkspaceFolder | undefined;
	private readonly platform: NodeJS.Platform;
	private readonly pathApi: typeof path.posix | typeof path.win32;
	private disposed = false;

	constructor(private readonly options: ResourceUriApplicationHandlerOptions) {
		this.stat = options.stat ?? (uri => vscode.workspace.fs.stat(uri));
		this.getWorkspaceFolder = options.getWorkspaceFolder ?? (uri => vscode.workspace.getWorkspaceFolder(uri));
		this.platform = options.platform ?? process.platform;
		this.pathApi = this.platform === 'win32' ? path.win32 : path.posix;
	}

	handleMessage(message: IncomingWebviewMessage): Promise<void> | undefined {
		if (!isResourceUriWebviewMessageType(message)) return undefined;
		const parsed = parseResourceUriWebviewMessage(message);
		if (!parsed.ok) return Promise.resolve();
		return this.resolveResourceUri(parsed.value);
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.resolvedResourceUriCache.clear();
	}

	private postMessage(message: ResourceUriHostMessage): void {
		if (this.disposed) return;
		this.options.postMessage(message);
	}

	private reply(
		requestId: string,
		payload: { ok: true; uri: string } | { ok: false; error: string },
	): void {
		if (this.disposed) return;
		try {
			if (payload.ok) {
				this.postMessage({ type: 'resolveResourceUriResult', requestId, ok: true, uri: payload.uri });
			} else {
				this.postMessage({ type: 'resolveResourceUriResult', requestId, ok: false, error: payload.error });
			}
		} catch {
			// ignore
		}
	}

	private async resolveResourceUri(message: ResourceUriRequestMessage): Promise<void> {
		if (this.disposed) return;
		const requestId = message.requestId;
		const rawPath = message.path;
		const rawBase = message.baseUri ?? '';

		if (!requestId) {
			return;
		}
		if (!rawPath.trim()) {
			this.reply(requestId, { ok: false, error: 'Empty path.' });
			return;
		}

		const lower = rawPath.trim().toLowerCase();
		if (
			lower.startsWith('http://') ||
			lower.startsWith('https://') ||
			lower.startsWith('data:') ||
			lower.startsWith('blob:') ||
			lower.startsWith('vscode-webview://') ||
			lower.startsWith('vscode-resource:')
		) {
			this.reply(requestId, { ok: true, uri: rawPath.trim() });
			return;
		}

		let baseUri: vscode.Uri | null = null;
		try {
			if (rawBase) {
				baseUri = vscode.Uri.parse(rawBase);
			}
		} catch {
			baseUri = null;
		}
		if (!baseUri || baseUri.scheme !== 'file') {
			this.reply(requestId, { ok: false, error: 'Missing or unsupported baseUri. Only local files are supported.' });
			return;
		}

		let targetUri: vscode.Uri;
		try {
			const normalized = rawPath.replace(/\\/g, '/');

			if (normalized.startsWith('/')) {
				const workspaceFolder = this.getWorkspaceFolder(baseUri);
				const relativePath = normalized.replace(/^\/+/, '');
				if (workspaceFolder && relativePath) {
					targetUri = vscode.Uri.joinPath(workspaceFolder.uri, ...relativePath.split('/'));
				} else {
					const baseDirectory = this.pathApi.dirname(baseUri.fsPath);
					const resolvedPath = this.pathApi.resolve(baseDirectory, relativePath);
					targetUri = vscode.Uri.file(resolvedPath);
				}
			} else {
				const isWindowsAbsolute = /^[a-zA-Z]:\//.test(normalized) || normalized.startsWith('//');
				const isPosixAbsolute = !isWindowsAbsolute && path.posix.isAbsolute(normalized);
				if (isWindowsAbsolute || (isPosixAbsolute && this.platform !== 'win32')) {
					targetUri = vscode.Uri.file(normalized);
				} else {
					const baseDirectory = this.pathApi.dirname(baseUri.fsPath);
					const resolvedPath = this.pathApi.resolve(baseDirectory, normalized);
					targetUri = vscode.Uri.file(resolvedPath);
				}
			}
		} catch (error) {
			this.reply(requestId, { ok: false, error: `Failed to resolve path: ${getErrorMessage(error)}` });
			return;
		}

		const cacheKey = `${baseUri.toString()}::${rawPath}`;
		const cached = this.resolvedResourceUriCache.get(cacheKey);
		if (cached) {
			this.reply(requestId, { ok: true, uri: cached });
			return;
		}

		try {
			await this.stat(targetUri);
		} catch {
			this.reply(requestId, { ok: false, error: 'File not found.' });
			return;
		}
		if (this.disposed) return;

		let convertedUri: vscode.Uri | undefined;
		try {
			const conversion = this.options.asWebviewUri(targetUri);
			convertedUri = conversion && typeof (conversion as Thenable<vscode.Uri | undefined>).then === 'function'
				? await conversion
				: conversion as vscode.Uri | undefined;
		} catch (error) {
			this.reply(requestId, { ok: false, error: `Failed to create webview URI: ${getErrorMessage(error)}` });
			return;
		}
		if (this.disposed) return;
		if (!convertedUri) {
			this.reply(requestId, { ok: false, error: 'Webview panel is not available.' });
			return;
		}

		try {
			const webviewUri = convertedUri.toString();
			if (this.disposed) return;
			this.resolvedResourceUriCache.set(cacheKey, webviewUri);
			this.reply(requestId, { ok: true, uri: webviewUri });
		} catch (error) {
			this.reply(requestId, { ok: false, error: `Failed to create webview URI: ${getErrorMessage(error)}` });
		}
	}
}