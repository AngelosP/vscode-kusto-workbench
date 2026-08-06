import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostCopilotContentOpenApplicationHandler } from '../../../src/host/copilotContentOpenApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function toolResultMessage(overrides: Record<string, unknown> = {}): IncomingWebviewMessage {
	return {
		type: 'openToolResultInEditor',
		boxId: 'query-1',
		tool: 'get_schema',
		label: 'Schema result',
		content: 'Table\tColumn\r\nStormEvents\tState',
		...overrides,
	} as IncomingWebviewMessage;
}

function markdownPreviewMessage(filePath = 'C:\\workspace\\copilot-result.md'): IncomingWebviewMessage {
	return { type: 'openMarkdownPreview', filePath };
}

describe('HostCopilotContentOpenApplicationHandler', () => {
	beforeEach(() => {
		Object.assign(vscode.ViewColumn, { Beside: 2 });
		Object.assign(vscode.window, { showTextDocument: vi.fn(async () => undefined) });
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument');
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(openTextDocument).not.toHaveBeenCalled();
		expect(executeCommand).not.toHaveBeenCalled();
	});

	it('opens exact coerced content as untitled plaintext beside the editor', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const document = { uri: vscode.Uri.parse('untitled:tool-result') } as vscode.TextDocument;
		const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue(document);
		const showTextDocument = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as vscode.TextEditor);
		const toolToString = vi.fn(() => '  get_schema  ');
		const boxIdToString = vi.fn(() => 'ignored-box');
		const labelToString = vi.fn(() => 'Ignored label');
		const contentToString = vi.fn(() => '  exact content\r\nwith spacing  ');
		const message = toolResultMessage({
			boxId: { toString: boxIdToString },
			label: { toString: labelToString },
			tool: { toString: toolToString },
			content: { toString: contentToString },
		});

		await handler.handleMessage(message);

		expect(toolToString).toHaveBeenCalledOnce();
		expect(boxIdToString).not.toHaveBeenCalled();
		expect(labelToString).not.toHaveBeenCalled();
		expect(contentToString).toHaveBeenCalledOnce();
		expect(openTextDocument).toHaveBeenCalledOnce();
		expect(openTextDocument).toHaveBeenCalledWith({
			content: '  exact content\r\nwith spacing  ',
			language: 'plaintext',
		});
		expect(showTextDocument).toHaveBeenCalledWith(document, {
			preview: true,
			viewColumn: vscode.ViewColumn.Beside,
		});
	});

	it.each([undefined, null, false, 0])('coerces falsy content %s to the exact empty string', async content => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const document = {} as vscode.TextDocument;
		const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue(document);

		await handler.handleMessage(toolResultMessage({ content }));

		expect(openTextDocument).toHaveBeenCalledWith({ content: '', language: 'plaintext' });
	});

	it('uses the exact tool-result prefix when document creation fails', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		vi.spyOn(vscode.workspace, 'openTextDocument').mockRejectedValue(new Error('create failed'));
		const showTextDocument = vi.spyOn(vscode.window, 'showTextDocument');
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage(toolResultMessage());

		expect(showTextDocument).not.toHaveBeenCalled();
		expect(showErrorMessage).toHaveBeenCalledWith('Failed to open tool result: create failed');
	});

	it('uses the exact tool-result prefix when beside display fails', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		vi.spyOn(vscode.workspace, 'openTextDocument').mockResolvedValue({} as vscode.TextDocument);
		vi.spyOn(vscode.window, 'showTextDocument').mockRejectedValue(new Error('display failed'));
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage(toolResultMessage());

		expect(showErrorMessage).toHaveBeenCalledWith('Failed to open tool result: display failed');
	});

	it('constructs the exact local Markdown URI and invokes the built-in preview once', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const filePath = 'C:\\workspace\\notes\\result.md';
		const uri = vscode.Uri.file(filePath);
		const uriFile = vi.spyOn(vscode.Uri, 'file').mockReturnValue(uri);
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

		await handler.handleMessage(markdownPreviewMessage(filePath));

		expect(uriFile).toHaveBeenCalledOnce();
		expect(uriFile).toHaveBeenCalledWith(filePath);
		expect(executeCommand).toHaveBeenCalledOnce();
		expect(executeCommand).toHaveBeenCalledWith('markdown.showPreview', uri);
	});

	it('uses the exact Markdown prefix when URI construction fails', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		vi.spyOn(vscode.Uri, 'file').mockImplementationOnce(() => { throw new Error('URI failed'); });
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage(markdownPreviewMessage());

		expect(executeCommand).not.toHaveBeenCalled();
		expect(showErrorMessage).toHaveBeenCalledWith('Failed to open markdown preview: URI failed');
	});

	it('uses safe string conversion and the exact Markdown prefix when preview fails', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		vi.spyOn(vscode.commands, 'executeCommand').mockRejectedValue('command failed');
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage(markdownPreviewMessage());

		expect(showErrorMessage).toHaveBeenCalledWith('Failed to open markdown preview: command failed');
	});

	it('allows an accepted tool-result open to finish after disposal', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const pendingDocument = deferred<vscode.TextDocument>();
		const document = {} as vscode.TextDocument;
		const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument')
			.mockImplementationOnce(() => pendingDocument.promise);
		const showTextDocument = vi.spyOn(vscode.window, 'showTextDocument').mockResolvedValue({} as vscode.TextEditor);
		const request = handler.handleMessage(toolResultMessage())!;
		await vi.waitFor(() => expect(openTextDocument).toHaveBeenCalledOnce());

		handler.dispose();
		pendingDocument.resolve(document);
		await request;

		expect(showTextDocument).toHaveBeenCalledWith(document, {
			preview: true,
			viewColumn: vscode.ViewColumn.Beside,
		});
	});

	it('allows an accepted Markdown preview failure to notify after disposal', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const pendingCommand = deferred<unknown>();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand')
			.mockImplementationOnce(() => pendingCommand.promise);
		const showErrorMessage = vi.spyOn(vscode.window, 'showErrorMessage');
		const request = handler.handleMessage(markdownPreviewMessage())!;
		await vi.waitFor(() => expect(executeCommand).toHaveBeenCalledOnce());

		handler.dispose();
		pendingCommand.reject(new Error('late preview failure'));
		await request;

		expect(showErrorMessage).toHaveBeenCalledWith(
			'Failed to open markdown preview: late preview failure',
		);
	});

	it('claims but suppresses later related messages after disposal', async () => {
		const handler = new HostCopilotContentOpenApplicationHandler();
		const openTextDocument = vi.spyOn(vscode.workspace, 'openTextDocument');
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');

		handler.dispose();
		handler.dispose();
		const toolRequest = handler.handleMessage(toolResultMessage());
		const previewRequest = handler.handleMessage(markdownPreviewMessage());

		expect(toolRequest).toBeInstanceOf(Promise);
		expect(previewRequest).toBeInstanceOf(Promise);
		await Promise.all([toolRequest, previewRequest]);
		expect(openTextDocument).not.toHaveBeenCalled();
		expect(executeCommand).not.toHaveBeenCalled();
	});
});