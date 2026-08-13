import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

const authEffects = vi.hoisted(() => ({
	clearSqlTokenOverride: vi.fn(async () => undefined),
	setSqlServerAccountMapEntry: vi.fn(async () => undefined),
	setSqlTokenOverride: vi.fn(async () => undefined),
}));

vi.mock('../../../src/host/sql/sqlAuthState', () => ({
	clearSqlTokenOverride: authEffects.clearSqlTokenOverride,
	setSqlServerAccountMapEntry: authEffects.setSqlServerAccountMapEntry,
	setSqlTokenOverride: authEffects.setSqlTokenOverride,
}));

import { HostSqlEditorLifecycleApplicationHandler } from '../../../src/host/sqlEditorLifecycleApplicationHandler';
import type { IncomingWebviewMessage } from '../../../src/host/queryEditorTypes';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function createLifecycle() {
	return {
		openSection: vi.fn(),
		retireTarget: vi.fn(() => true),
		handleLanguageRequest: vi.fn(async () => undefined),
		didOpen: vi.fn(),
		didChange: vi.fn(async () => undefined),
		didClose: vi.fn(),
		connect: vi.fn(async () => undefined),
	};
}

function createContext(extensionMode: vscode.ExtensionMode): vscode.ExtensionContext {
	return { extensionMode } as vscode.ExtensionContext;
}

function createHandler(
	extensionMode: vscode.ExtensionMode = vscode.ExtensionMode.Test,
	lifecycle = createLifecycle(),
) {
	const context = createContext(extensionMode);
	const handler = new HostSqlEditorLifecycleApplicationHandler({ context, lifecycle });
	return { context, handler, lifecycle };
}

function createLifecycleMessages() {
	const params = {
		boxId: 'sql-box-exact',
		sectionInstanceId: 'sql-instance-exact',
		line: 7,
		column: 11,
		ownerToken: 'owner-token-exact',
		targetGeneration: 13,
	};
	const expectedOwner = {
		connectionId: 'sql-connection-exact',
		database: 'ExactDb',
		targetSignature: 'target-signature-exact',
		principalFingerprint: 'principal-exact',
		revocationGeneration: 17,
	};
	const messages = [
		{ type: 'sqlSectionOpen', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact' },
		{
			type: 'retireSqlTarget', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			targetGeneration: 13,
		},
		{ type: 'stsRequest', requestId: 'sts-request-exact', method: 'textDocument/hover', params },
		{
			type: 'stsDidOpen', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			text: 'select 1;',
		},
		{
			type: 'stsDidChange', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			text: 'select 2;',
		},
		{ type: 'stsDidClose', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact' },
		{
			type: 'stsConnect', boxId: 'sql-box-exact', sectionInstanceId: 'sql-instance-exact',
			sqlConnectionId: 'sql-connection-exact', database: 'ExactDb', targetGeneration: 13,
			expectedOwner,
		},
	] as const satisfies readonly IncomingWebviewMessage[];
	return { expectedOwner, messages, params };
}

function createAllMessages(): readonly IncomingWebviewMessage[] {
	return [
		...createLifecycleMessages().messages,
		{
			type: 'testSetSqlAuthOverride', serverUrl: 'exact.database.windows.net',
			accountId: 'account-exact', token: 'token-exact',
		},
		{ type: 'testClearSqlAuthOverride', accountId: 'account-exact' },
	];
}

describe('HostSqlEditorLifecycleApplicationHandler', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authEffects.clearSqlTokenOverride.mockImplementation(async () => undefined);
		authEffects.setSqlServerAccountMapEntry.mockImplementation(async () => undefined);
		authEffects.setSqlTokenOverride.mockImplementation(async () => undefined);
	});

	it('declines unrelated traffic synchronously without lifecycle or auth effects', () => {
		const { handler, lifecycle } = createHandler();

		expect(handler.handleMessage({ type: 'showInfo', message: 'unrelated' })).toBeUndefined();
		expect(Object.values(lifecycle).every(effect => effect.mock.calls.length === 0)).toBe(true);
		expect(authEffects.setSqlServerAccountMapEntry).not.toHaveBeenCalled();
		expect(authEffects.setSqlTokenOverride).not.toHaveBeenCalled();
		expect(authEffects.clearSqlTokenOverride).not.toHaveBeenCalled();
	});

	it('forwards every section and STS route with exact fields and identities', async () => {
		const { handler, lifecycle } = createHandler();
		const { expectedOwner, messages, params } = createLifecycleMessages();

		for (const message of messages) {
			await expect(handler.handleMessage(message)).resolves.toBeUndefined();
		}

		expect(lifecycle.openSection).toHaveBeenCalledWith('sql-box-exact', 'sql-instance-exact');
		expect(lifecycle.retireTarget).toHaveBeenCalledWith('sql-box-exact', 'sql-instance-exact', 13);
		expect(lifecycle.handleLanguageRequest).toHaveBeenCalledWith(
			'sts-request-exact',
			'textDocument/hover',
			params,
		);
		expect(lifecycle.handleLanguageRequest.mock.calls[0][2]).toBe(params);
		expect(lifecycle.didOpen).toHaveBeenCalledWith('sql-box-exact', 'sql-instance-exact', 'select 1;');
		expect(lifecycle.didChange).toHaveBeenCalledWith('sql-box-exact', 'sql-instance-exact', 'select 2;');
		expect(lifecycle.didClose).toHaveBeenCalledWith('sql-box-exact', 'sql-instance-exact');
		expect(lifecycle.connect).toHaveBeenCalledWith(
			'sql-box-exact',
			'sql-instance-exact',
			'sql-connection-exact',
			'ExactDb',
			13,
			expectedOwner,
		);
		expect(lifecycle.connect.mock.calls[0][5]).toBe(expectedOwner);
	});

	it('claims malformed STS traffic before lifecycle effects', async () => {
		const { handler, lifecycle } = createHandler();
		const { messages } = createLifecycleMessages();
		const request = messages[2];
		const open = messages[3];
		const connect = messages[6];

		for (const malformed of [
			{ ...request, params: { ...request.params, ownerToken: ['owner-token-exact'] } },
			{ ...request, params: { ...request.params, line: 0 } },
			{ ...open, text: null },
			{ ...connect, expectedOwner: { ...connect.expectedOwner, revocationGeneration: '17' } },
		]) {
			await expect(handler.handleMessage(
				malformed as unknown as IncomingWebviewMessage,
			)).resolves.toBeUndefined();
		}

		expect(lifecycle.handleLanguageRequest).not.toHaveBeenCalled();
		expect(lifecycle.didOpen).not.toHaveBeenCalled();
		expect(lifecycle.didChange).not.toHaveBeenCalled();
		expect(lifecycle.didClose).not.toHaveBeenCalled();
		expect(lifecycle.connect).not.toHaveBeenCalled();
	});

	it('writes the development account map before the token override', async () => {
		const { context, handler } = createHandler();
		const accountWrite = deferred<void>();
		authEffects.setSqlServerAccountMapEntry.mockImplementation(() => accountWrite.promise);
		const request = handler.handleMessage({
			type: 'testSetSqlAuthOverride',
			serverUrl: 'exact.database.windows.net',
			accountId: 'account-exact',
			token: 'token-exact',
		});

		expect(authEffects.setSqlServerAccountMapEntry).toHaveBeenCalledWith(
			context,
			'exact.database.windows.net',
			'account-exact',
		);
		expect(authEffects.setSqlTokenOverride).not.toHaveBeenCalled();

		accountWrite.resolve();
		await expect(request).resolves.toBeUndefined();
		expect(authEffects.setSqlTokenOverride).toHaveBeenCalledWith(
			context,
			'account-exact',
			'token-exact',
		);
		expect(authEffects.setSqlServerAccountMapEntry.mock.invocationCallOrder[0])
			.toBeLessThan(authEffects.setSqlTokenOverride.mock.invocationCallOrder[0]);
	});

	it('does not write a token when the account-map write rejects', async () => {
		const { handler } = createHandler();
		const failure = new Error('account map write failed');
		authEffects.setSqlServerAccountMapEntry.mockRejectedValueOnce(failure);

		await expect(handler.handleMessage({
			type: 'testSetSqlAuthOverride',
			serverUrl: 'exact.database.windows.net',
			accountId: 'account-exact',
			token: 'token-exact',
		})).rejects.toBe(failure);
		expect(authEffects.setSqlTokenOverride).not.toHaveBeenCalled();
	});

	it('clears the exact development token override', async () => {
		const { context, handler } = createHandler();

		await expect(handler.handleMessage({
			type: 'testClearSqlAuthOverride',
			accountId: 'account-exact',
		})).resolves.toBeUndefined();

		expect(authEffects.clearSqlTokenOverride).toHaveBeenCalledWith(context, 'account-exact');
	});

	it('claims but suppresses both development-auth routes in Production', async () => {
		const { handler } = createHandler(vscode.ExtensionMode.Production);

		await expect(handler.handleMessage({
			type: 'testSetSqlAuthOverride',
			serverUrl: 'exact.database.windows.net',
			accountId: 'account-exact',
			token: 'token-exact',
		})).resolves.toBeUndefined();
		await expect(handler.handleMessage({
			type: 'testClearSqlAuthOverride',
			accountId: 'account-exact',
		})).resolves.toBeUndefined();

		expect(authEffects.setSqlServerAccountMapEntry).not.toHaveBeenCalled();
		expect(authEffects.setSqlTokenOverride).not.toHaveBeenCalled();
		expect(authEffects.clearSqlTokenOverride).not.toHaveBeenCalled();
	});

	it('propagates exact lifecycle rejection', async () => {
		const lifecycle = createLifecycle();
		const failure = new Error('STS connect failed');
		lifecycle.connect.mockRejectedValueOnce(failure);
		const { handler } = createHandler(vscode.ExtensionMode.Test, lifecycle);
		const connect = createLifecycleMessages().messages.at(-1)!;

		await expect(handler.handleMessage(connect)).rejects.toBe(failure);
	});

	it('preserves accepted settlement across disposal and suppresses every later recognized route', async () => {
		const lifecycle = createLifecycle();
		const change = deferred<void>();
		lifecycle.didChange.mockImplementationOnce(() => change.promise);
		const { handler } = createHandler(vscode.ExtensionMode.Test, lifecycle);
		const activeMessage = createLifecycleMessages().messages[4];
		const activeRequest = handler.handleMessage(activeMessage);

		handler.dispose();
		handler.dispose();
		for (const message of createAllMessages()) {
			await expect(handler.handleMessage(message)).resolves.toBeUndefined();
		}

		expect(lifecycle.didChange).toHaveBeenCalledOnce();
		expect(lifecycle.openSection).not.toHaveBeenCalled();
		expect(lifecycle.retireTarget).not.toHaveBeenCalled();
		expect(lifecycle.handleLanguageRequest).not.toHaveBeenCalled();
		expect(lifecycle.didOpen).not.toHaveBeenCalled();
		expect(lifecycle.didClose).not.toHaveBeenCalled();
		expect(lifecycle.connect).not.toHaveBeenCalled();
		expect(authEffects.setSqlServerAccountMapEntry).not.toHaveBeenCalled();
		expect(authEffects.setSqlTokenOverride).not.toHaveBeenCalled();
		expect(authEffects.clearSqlTokenOverride).not.toHaveBeenCalled();

		change.resolve();
		await expect(activeRequest).resolves.toBeUndefined();
	});
});
