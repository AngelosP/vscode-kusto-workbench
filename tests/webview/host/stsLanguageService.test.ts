import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as vscode from 'vscode';
import { StsLanguageService } from '../../../src/host/sql/stsLanguageService';
import type { StsProcessManager } from '../../../src/host/sql/stsProcessManager';
import type { SqlConnectionManager, SqlConnection } from '../../../src/host/sqlConnectionManager';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';

// ── Mock factories ────────────────────────────────────────────────────────────

function createMockProcessManager(): StsProcessManager {
	const notificationHandlers = new Map<string, (params: any) => void>();
	const epochStartHandlers = new Set<(event: any) => void>();
	const epochEndHandlers = new Set<(event: any) => void>();

	return {
		ready: Promise.resolve(),
		isRunning: true,
		connection: null,
		start: vi.fn(),
		stop: vi.fn(),
		sendRequest: vi.fn().mockResolvedValue(null),
		sendNotification: vi.fn(),
		onNotification: vi.fn((method: string, handler: (params: any) => void) => {
			notificationHandlers.set(method, handler);
			return { dispose: () => notificationHandlers.delete(method) };
		}),
		onDidStartEpoch: vi.fn((handler: (event: any) => void) => {
			epochStartHandlers.add(handler);
			return { dispose: () => epochStartHandlers.delete(handler) };
		}),
		onDidEndEpoch: vi.fn((handler: (event: any) => void) => {
			epochEndHandlers.add(handler);
			return { dispose: () => epochEndHandlers.delete(handler) };
		}),
		// Test helper to simulate notifications
		_simulateNotification(method: string, params: any) {
			const handler = notificationHandlers.get(method);
			if (handler) handler(params);
		},
	} as any;
}

function createMockConnectionManager(): SqlConnectionManager {
	return {
		getConnection: vi.fn().mockReturnValue(null),
		assertConnectionCurrent: vi.fn().mockResolvedValue(undefined),
		getPasswordForConnection: vi.fn().mockResolvedValue('test-password'),
	} as any;
}

function createMockOutput(): any {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		log: vi.fn(),
		show: vi.fn(),
	};
}

function createMockContext(): any {
	return {
		globalState: {
			get: vi.fn().mockReturnValue(undefined),
			update: vi.fn().mockResolvedValue(undefined),
		},
		secrets: {
			get: vi.fn().mockResolvedValue(undefined),
			store: vi.fn().mockResolvedValue(undefined),
			delete: vi.fn().mockResolvedValue(undefined),
		},
	};
}

function createTestConnection(overrides: Partial<SqlConnection> = {}): SqlConnection {
	return {
		id: 'conn-1',
		name: 'Test Server',
		dialect: 'mssql',
		serverUrl: 'test-server.database.windows.net',
		authType: 'sql-login',
		username: 'testuser',
		...overrides,
	};
}

function createExpectedOwner(connection: SqlConnection, database: string, generation: number, principal = connection.username) {
	return {
		connectionId: connection.id,
		database,
		generation,
		targetSignature: sqlConnectionTargetSignature(connection),
		principalFingerprint: principal === 'aad-pending'
			? principal
			: sqlSchemaPrincipalFingerprintForPrincipal(connection, principal)!,
		revocationGeneration: 0,
	};
}

async function openOwnedDocument(
	service: StsLanguageService,
	connection: SqlConnection = createTestConnection(),
	database = String(connection.database || ''),
	generation = 1,
	principal = connection.username,
) {
	const owner = createExpectedOwner(connection, database, generation, principal);
	await service.openDocument('box-1', 'SELECT ', connection, owner);
	return owner;
}

async function waitForConnectCallCount(mockPm: ReturnType<typeof createMockProcessManager>, count: number): Promise<any[][]> {
	await vi.waitFor(() => {
		const connectCalls = (mockPm.sendRequest as any).mock.calls.filter((call: any[]) => call[0] === 'connection/connect');
		expect(connectCalls.length).toBeGreaterThanOrEqual(count);
	});
	return (mockPm.sendRequest as any).mock.calls.filter((call: any[]) => call[0] === 'connection/connect');
}

async function simulateConnectedAndReady(mockPm: ReturnType<typeof createMockProcessManager>, ownerUri: string, connectionId: string): Promise<void> {
	(mockPm as any)._simulateNotification('connection/complete', {
		ownerUri,
		connectionId,
	});
	await Promise.resolve();
	(mockPm as any)._simulateNotification('textDocument/intelliSenseReady', {
		ownerUri,
	});
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('StsLanguageService', () => {
	let mockPm: ReturnType<typeof createMockProcessManager>;
	let mockConnMgr: ReturnType<typeof createMockConnectionManager>;
	let mockContext: ReturnType<typeof createMockContext>;
	let mockOutput: ReturnType<typeof createMockOutput>;
	let service: StsLanguageService;

	beforeEach(() => {
		mockPm = createMockProcessManager();
		mockConnMgr = createMockConnectionManager();
		mockContext = createMockContext();
		mockOutput = createMockOutput();
		service = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'test-session');
	});

	// ── URI mapping ───────────────────────────────────────────────────────

	describe('document lifecycle', () => {
		it('does not dispatch didOpen when composite owner admission rejects after preflight', async () => {
			const dispatchOwner = vi.fn(async () => { throw new Error('canonical owner changed'); });
			const guarded = new StsLanguageService(
				mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'guarded-session', undefined, dispatchOwner,
			);
			try {
				await expect(guarded.openDocument('box-guarded', 'SELECT 1', createTestConnection()))
					.rejects.toThrow('canonical owner changed');
				expect(dispatchOwner).toHaveBeenCalledOnce();
				expect(mockPm.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything());
			} finally {
				guarded.dispose();
			}
		});

		it('does not dispatch didOpen after the document closes during canonical admission', async () => {
			let releaseAdmission!: () => void;
			const admission = new Promise<void>(resolve => { releaseAdmission = resolve; });
			const dispatchOwner = vi.fn(async (_connection, _principal, _revocation, dispatch) => {
				await admission;
				return await dispatch();
			});
			const guarded = new StsLanguageService(
				mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'guarded-close', undefined, dispatchOwner,
			);
			try {
				const opening = guarded.openDocument('box-guarded', 'SELECT 1', createTestConnection());
				await vi.waitFor(() => expect(dispatchOwner).toHaveBeenCalledOnce());
				guarded.closeDocument('box-guarded');
				releaseAdmission();

				await expect(opening).rejects.toThrow('owner changed');
				expect(mockPm.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything());
			} finally {
				guarded.dispose();
			}
		});

		it.each(['target', 'principal'] as const)('blocks captured tool owner %s drift before didOpen', async drift => {
			const capturedConnection = createTestConnection();
			const actualConnection = drift === 'target' ? { ...capturedConnection, port: 1444 } : capturedConnection;
			const expectedOwner = {
				connectionId: capturedConnection.id,
				database: 'Db',
				targetSignature: sqlConnectionTargetSignature(capturedConnection),
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(
					capturedConnection,
					drift === 'principal' ? 'different-user' : capturedConnection.username,
				)!,
			};

			await expect(service.openDocument('box-tool', 'SELECT 1', actualConnection, expectedOwner))
				.rejects.toThrow(/tool execution (target|principal) changed/i);
			expect(mockPm.sendNotification).not.toHaveBeenCalledWith('textDocument/didOpen', expect.anything());
		});

		it('continues restart replay after one document owner fails', async () => {
			const stale = createTestConnection({ id: 'stale-connection' });
			const valid = createTestConnection({ id: 'valid-connection' });
			await service.openDocument('box-stale', 'SELECT stale', stale);
			await service.openDocument('box-valid', 'SELECT valid', valid);
			(mockPm.sendNotification as any).mockClear();
			mockConnMgr.assertConnectionCurrent.mockImplementation(async (connection: SqlConnection) => {
				if (connection.id === stale.id) throw new Error('stale owner');
			});
			(mockOutput.warn as any).mockClear();

			await (service as any)._replayDocumentsAfterRestartGuarded();

			const replayedText = (mockPm.sendNotification as any).mock.calls
				.filter((call: any[]) => call[0] === 'textDocument/didOpen')
				.map((call: any[]) => call[1].textDocument.text);
			expect(replayedText).toContain('SELECT valid');
			expect(mockOutput.warn).toHaveBeenCalledWith(expect.stringContaining('Failed to replay SQL language document'));
		});

		it('does not let stale restart replay close a replacement owner document', async () => {
			const connectionA = createTestConnection({ id: 'connection-a', database: 'DbA' });
			const connectionB = createTestConnection({ id: 'connection-b', database: 'DbB' });
			const ownerA = createExpectedOwner(connectionA, 'DbA', 1);
			const ownerB = createExpectedOwner(connectionB, 'DbB', 2);
			await service.openDocument('box-race', 'SELECT A', connectionA, ownerA);
			(service as any)._handleEpochEnded(new Error('restart'));
			(mockPm.sendNotification as any).mockClear();

			let releaseReplay!: () => void;
			let markReplayOpened!: () => void;
			const replayGate = new Promise<void>(resolve => { releaseReplay = resolve; });
			const replayOpened = new Promise<void>(resolve => { markReplayOpened = resolve; });
			const internal = service as any;
			const realSend = internal._sendGuardedNotification.bind(internal);
			let paused = false;
			vi.spyOn(internal, '_sendGuardedNotification').mockImplementation(async (connection: SqlConnection, method: string, params: any) => {
				await realSend(connection, method, params);
				if (!paused && method === 'textDocument/didOpen' && params.textDocument.uri.endsWith('/2.sql')) {
					paused = true;
					markReplayOpened();
					await replayGate;
				}
			});

			const replay = internal._replayDocumentsAfterRestartGuarded();
			await replayOpened;
			await service.openDocument('box-race', 'SELECT B', connectionB, ownerB);
			releaseReplay();
			await replay;

			expect(internal._documentUriByBoxId.get('box-race')).toBe('kw-sql://language/test-session/3.sql');
			expect(internal._targetByBoxId.get('box-race').expectedOwner).toEqual(ownerB);
			const closedUris = (mockPm.sendNotification as any).mock.calls
				.filter((call: any[]) => call[0] === 'textDocument/didClose')
				.map((call: any[]) => call[1].textDocument.uri);
			expect(closedUris).toContain('kw-sql://language/test-session/2.sql');
			expect(closedUris).not.toContain('kw-sql://language/test-session/3.sql');
		});

		it('rejects an older expected-owner generation after a replacement owner opens', async () => {
			const connectionA = createTestConnection({ id: 'connection-a', database: 'DbA' });
			const connectionB = createTestConnection({ id: 'connection-b', database: 'DbB' });
			const ownerA = createExpectedOwner(connectionA, 'DbA', 1);
			const ownerB = createExpectedOwner(connectionB, 'DbB', 2);
			await service.openDocument('box-generation', 'SELECT B', connectionB, ownerB);
			(mockPm.sendNotification as any).mockClear();

			await expect(service.openDocument('box-generation', 'SELECT A', connectionA, ownerA))
				.rejects.toThrow('owner generation was superseded');

			expect((service as any)._targetByBoxId.get('box-generation').expectedOwner).toEqual(ownerB);
			expect((service as any)._documentUriByBoxId.get('box-generation')).toBe('kw-sql://language/test-session/1.sql');
			expect(mockPm.sendNotification).not.toHaveBeenCalledWith('textDocument/didClose', expect.anything());
		});

		it('openDocument sends didOpen notification with correct URI', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());
			expect(mockPm.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
				textDocument: {
					uri: 'kw-sql://language/test-session/1.sql',
					languageId: 'sql',
					version: 1,
					text: 'SELECT 1',
				},
			});
		});

		it('does not let a failed didOpen close its replacement document', async () => {
			const connection = createTestConnection();
			let releaseFirstOpen!: () => void;
			let markFirstOpen!: () => void;
			const firstOpenGate = new Promise<void>(resolve => { releaseFirstOpen = resolve; });
			const firstOpenStarted = new Promise<void>(resolve => { markFirstOpen = resolve; });
			mockPm.sendNotification.mockImplementation(async (method: string, params: any) => {
				if (method === 'textDocument/didOpen' && params.textDocument.uri.endsWith('/1.sql')) {
					markFirstOpen();
					await firstOpenGate;
					throw new Error('didOpen failed');
				}
			});

			const firstOpen = service.openDocument('box-race', 'SELECT 1', connection);
			await firstOpenStarted;
			await expect(service.openDocument('box-race', 'SELECT 2', connection))
				.resolves.toBe('kw-sql://language/test-session/2.sql');
			releaseFirstOpen();
			await expect(firstOpen).rejects.toThrow('didOpen failed');

			expect((service as any)._documentUriByBoxId.get('box-race')).toBe('kw-sql://language/test-session/2.sql');
			const closedUris = mockPm.sendNotification.mock.calls
				.filter((call: any[]) => call[0] === 'textDocument/didClose')
				.map((call: any[]) => call[1].textDocument.uri);
			expect(closedUris).not.toContain('kw-sql://language/test-session/2.sql');
		});

		it('changeDocument increments version', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());
			await service.changeDocument('box-1', 'SELECT 2');

			const changeCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didChange',
			);
			expect(changeCalls).toHaveLength(1);
			expect(changeCalls[0][1].textDocument.version).toBe(2);
		});

		it('changeDocument uses version 3 after two changes', async () => {
			await service.openDocument('box-1', 'v1', createTestConnection());
			await service.changeDocument('box-1', 'v2');
			await service.changeDocument('box-1', 'v3');

			const changeCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didChange',
			);
			expect(changeCalls).toHaveLength(2);
			expect(changeCalls[1][1].textDocument.version).toBe(3);
		});

		it('closeDocument sends didClose notification', async () => {
			const diagnosticsReceived: any[] = [];
			service.onDiagnostics(event => diagnosticsReceived.push(event));
			const connection = createTestConnection();
			const owner = createExpectedOwner(connection, '', 1);
			await service.openDocument('box-1', 'SELECT 1', connection, owner);
			service.closeDocument('box-1');
			expect(mockPm.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
				textDocument: { uri: 'kw-sql://language/test-session/1.sql' },
			});
			expect(diagnosticsReceived).toContainEqual({ boxId: 'box-1', markers: [], owner });
		});

		it('changeDocument sends full content in contentChanges', async () => {
			await service.openDocument('box-1', 'old', createTestConnection());
			await service.changeDocument('box-1', 'new text');
			const changeCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didChange',
			);
			expect(changeCalls[0][1].contentChanges).toEqual([{ text: 'new text' }]);
		});

		it('assigns distinct owner URIs to simultaneous SQL sections', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());
			await service.openDocument('box-2', 'SELECT 2', createTestConnection());
			const openCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didOpen',
			);
			expect(openCalls.map((call: any[]) => call[1].textDocument.uri)).toEqual([
				'kw-sql://language/test-session/1.sql',
				'kw-sql://language/test-session/2.sql',
			]);
		});

		it('does not send didChange after Leave No Trace is enabled', async () => {
			let allowed = true;
			const policy = {
				getConnectionIds: () => allowed ? [] : ['conn-1'],
				isProtected: () => !allowed,
				refresh: vi.fn(async () => allowed ? [] : ['conn-1']),
				assertAllowed: vi.fn(async () => {
					if (!allowed) throw new Error('Leave No Trace blocked');
				}),
			};
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'guarded-session', policy as any);
			await guarded.openDocument('box-1', 'SELECT 1', createTestConnection());
			allowed = false;

			await expect(guarded.changeDocument('box-1', 'SELECT Secret FROM T')).rejects.toThrow('Leave No Trace blocked');
			const changes = (mockPm.sendNotification as any).mock.calls.filter((call: any[]) => call[0] === 'textDocument/didChange');
			expect(changes).toHaveLength(0);
			guarded.dispose();
		});
	});

	describe('connectDocument', () => {
		it('joins duplicate same-target connects before credentials resolve', async () => {
			let resolvePassword: (password: string) => void = () => undefined;
			(mockConnMgr.getPasswordForConnection as any).mockReturnValue(new Promise<string>((resolve) => { resolvePassword = resolve; }));
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());

			const connection = createTestConnection();
			const first = service.connectDocument('box-1', connection, 'sampledb');
			const second = service.connectDocument('box-1', connection, 'sampledb');
			await Promise.resolve();

			expect(mockPm.sendRequest).not.toHaveBeenCalledWith('connection/connect', expect.anything());
			resolvePassword('test-password');

			const connectCalls = await waitForConnectCallCount(mockPm, 1);
			expect(connectCalls).toHaveLength(1);

			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/1.sql', 'connected-1');

			await expect(first).resolves.toBeUndefined();
			await expect(second).resolves.toBeUndefined();
		});

		it('reopens the STS document when a different target supersedes an in-flight connect', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());

			const first = service.connectDocument('box-1', createTestConnection(), 'sampledb');
			const firstError = first.catch(err => err);
			await waitForConnectCallCount(mockPm, 1);
			const second = service.connectDocument('box-1', createTestConnection(), 'master');
			await waitForConnectCallCount(mockPm, 2);

			await expect(firstError).resolves.toHaveProperty('message', 'STS document superseded');
			const notifications = (mockPm.sendNotification as any).mock.calls;
			expect(notifications).toContainEqual(['textDocument/didClose', { textDocument: { uri: 'kw-sql://language/test-session/1.sql' } }]);
			expect(notifications).toContainEqual(['textDocument/didOpen', {
				textDocument: { uri: 'kw-sql://language/test-session/2.sql', languageId: 'sql', version: 1, text: 'SELECT 1' },
			}]);

			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/2.sql', 'connected-2');

			await expect(second).resolves.toBeUndefined();
		});

		it('reopens the STS document when a completed connection switches databases', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());
			const first = service.connectDocument('box-1', createTestConnection(), 'DbA');
			await waitForConnectCallCount(mockPm, 1);
			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/1.sql', 'connected-a');
			await first;

			const second = service.connectDocument('box-1', createTestConnection(), 'DbB');
			const connectCalls = await waitForConnectCallCount(mockPm, 2);
			expect(connectCalls[1][1].ownerUri).toBe('kw-sql://language/test-session/2.sql');
			expect((mockPm.sendNotification as any).mock.calls).toContainEqual([
				'textDocument/didClose', { textDocument: { uri: 'kw-sql://language/test-session/1.sql' } },
			]);
			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/2.sql', 'connected-b');
			await expect(second).resolves.toBeUndefined();
		});

		it('rejects duplicate waiters when the document closes while connecting', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());

			const connection = createTestConnection();
			const first = service.connectDocument('box-1', connection, 'sampledb');
			const second = service.connectDocument('box-1', connection, 'sampledb');
			await waitForConnectCallCount(mockPm, 1);

			service.closeDocument('box-1');

			await expect(first).rejects.toThrow('STS document closed');
			await expect(second).rejects.toThrow('STS document closed');
			await vi.waitFor(() => expect(mockPm.sendRequest).toHaveBeenCalledWith(
				'connection/cancelconnect',
				{ ownerUri: 'kw-sql://language/test-session/1.sql' },
				{ timeoutMs: 5000 },
			));
		});

		it('cleans pending state when connection/connect fails so a retry can connect', async () => {
			await service.openDocument('box-1', 'SELECT 1', createTestConnection());
			(mockPm.sendRequest as any).mockRejectedValueOnce(new Error('connect request failed'));

			await expect(service.connectDocument('box-1', createTestConnection(), 'sampledb')).rejects.toThrow('connect request failed');
			expect(mockPm.sendRequest).toHaveBeenCalledWith('connection/cancelconnect', { ownerUri: 'kw-sql://language/test-session/1.sql' }, { timeoutMs: 5000 });
			expect(mockPm.sendRequest).toHaveBeenCalledWith('connection/disconnect', { ownerUri: 'kw-sql://language/test-session/1.sql' }, { timeoutMs: 5000 });

			(mockPm.sendRequest as any).mockResolvedValueOnce(true);
			const retry = service.connectDocument('box-1', createTestConnection(), 'sampledb');
			await waitForConnectCallCount(mockPm, 2);
			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/1.sql', 'stale-connection');
			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/2.sql', 'connected-retry');

			await expect(retry).resolves.toBeUndefined();
		});
	});

	// ── Completions ───────────────────────────────────────────────────────

	describe('getCompletions', () => {
		it('translates LSP completion items', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce({
				items: [
					{ label: 'Users', kind: 22, detail: 'Table', insertText: 'Users' },
					{ label: 'SELECT', kind: 14, detail: 'Keyword' },
				],
			});

			const result = await service.getCompletions('box-1', 1, 1, owner);
			expect(result.items).toHaveLength(2);
			expect(result.items[0].label).toBe('Users');
			expect(result.items[0].kind).toBe(22);
			expect(result.items[1].label).toBe('SELECT');
		});

		it('handles array response format', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce([
				{ label: 'Id', kind: 5 },
			]);

			const result = await service.getCompletions('box-1', 1, 5, owner);
			expect(result.items).toHaveLength(1);
			expect(result.items[0].label).toBe('Id');
		});

		it('returns empty items on error', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockRejectedValueOnce(new Error('timeout'));

			const result = await service.getCompletions('box-1', 1, 1, owner);
			expect(result.items).toEqual([]);
		});

		it('passes correct LSP position (0-based)', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce({ items: [] });

			await service.getCompletions('box-1', 5, 10, owner);
			expect(mockPm.sendRequest).toHaveBeenCalledWith('textDocument/completion', {
				textDocument: { uri: 'kw-sql://language/test-session/1.sql' },
				position: { line: 4, character: 9 }, // 1-based → 0-based
			});
		});

		it('rejects completion items when policy changes before response admission', async () => {
			let allowed = true;
			const policy = {
				getConnectionIds: () => allowed ? [] : ['conn-1'],
				isProtected: () => !allowed,
				refresh: vi.fn(async () => allowed ? [] : ['conn-1']),
				assertAllowed: vi.fn(async () => {
					if (!allowed) throw new Error('Leave No Trace blocked');
				}),
			};
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'guarded-session', policy as any);
			const owner = await openOwnedDocument(guarded);
			(mockPm.sendRequest as any).mockImplementationOnce(async () => {
				allowed = false;
				return { items: [{ label: 'SecretTable', kind: 22 }] };
			});

			await expect(guarded.getCompletions('box-1', 1, 8, owner)).resolves.toEqual({ items: [] });
			guarded.dispose();
		});

		it('rejects completion items when the canonical AAD principal rotates before admission', async () => {
			let accountId = 'account-a';
			mockContext.globalState.get.mockImplementation((key: string) => key === 'sql.auth.serverAccountMap'
				? { 'test-server.database.windows.net': accountId }
				: undefined);
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'aad-session');
			const connection = createTestConnection({ authType: 'aad', username: undefined });
			const owner = await openOwnedDocument(guarded, connection, '', 1, 'account-a');
			(mockPm.sendRequest as any).mockImplementationOnce(async () => {
				accountId = 'account-b';
				return { items: [{ label: 'AccountASecretTable', kind: 22 }] };
			});

			await expect(guarded.getCompletions('box-1', 1, 8, owner)).resolves.toEqual({ items: [] });
			guarded.dispose();
		});

		it('adopts the first AAD principal established by its own connection', async () => {
			let accountId = '';
			mockContext.globalState.get.mockImplementation((key: string) => key === 'sql.auth.serverAccountMap'
				? (accountId ? { 'test-server.database.windows.net': accountId } : {})
				: undefined);
			mockContext.globalState.update.mockImplementation(async (key: string, value: any) => {
				if (key === 'sql.auth.serverAccountMap') accountId = value['test-server.database.windows.net'] || '';
			});
			vi.spyOn(vscode.authentication, 'getSession').mockResolvedValue({ accessToken: 'account-a-token', account: { id: 'account-a', label: 'Account A' } } as any);
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'first-aad-session');
			const connection = createTestConnection({ authType: 'aad', username: undefined });
			await guarded.openDocument('box-1', 'SELECT ', connection);
			const connect = guarded.connectDocument('box-1', connection, 'Db');
			await waitForConnectCallCount(mockPm, 1);
			await simulateConnectedAndReady(mockPm, 'kw-sql://language/first-aad-session/1.sql', 'connected-a');
			await connect;
			const owner = createExpectedOwner(connection, 'Db', 1, 'account-a');
			await guarded.connectDocument('box-1', connection, 'Db', owner);
			(mockPm.sendRequest as any).mockResolvedValueOnce({ items: [{ label: 'AccountATable', kind: 22 }] });

			await expect(guarded.getCompletions('box-1', 1, 8, owner)).resolves.toMatchObject({
				items: [expect.objectContaining({ label: 'AccountATable' })],
			});
			guarded.dispose();
		});

		it('rejects first-AAD language work when the canonical account differs from the token account', async () => {
			let accountId = '';
			mockContext.globalState.get.mockImplementation((key: string) => key === 'sql.auth.serverAccountMap'
				? (accountId ? { 'test-server.database.windows.net': accountId } : {})
				: undefined);
			vi.spyOn(vscode.authentication, 'getSession').mockImplementation(async () => {
				return { accessToken: 'account-a-token', account: { id: 'account-a', label: 'Account A' } } as any;
			});
			mockContext.globalState.update.mockImplementation(async (key: string, value: any) => {
				if (key === 'sql.auth.serverAccountMap') {
					accountId = value['test-server.database.windows.net'] || '';
					accountId = 'account-b';
				}
			});
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'mismatch-aad-session');
			const connection = createTestConnection({ authType: 'aad', username: undefined });
			await guarded.openDocument('box-1', 'SELECT ', connection);

			await expect(guarded.connectDocument('box-1', connection, 'Db')).rejects.toThrow('principal changed');
			guarded.dispose();
		});

		it('rejects completion items when the canonical connection target changes before admission', async () => {
			let targetCurrent = true;
			mockConnMgr.assertConnectionCurrent.mockImplementation(async () => {
				if (!targetCurrent) throw new Error('SQL connection changed while credentials were being resolved.');
			});
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'target-session');
			const owner = await openOwnedDocument(guarded);
			(mockPm.sendRequest as any).mockImplementationOnce(async () => {
				targetCurrent = false;
				return { items: [{ label: 'OldTargetSecretTable', kind: 22 }] };
			});

			await expect(guarded.getCompletions('box-1', 1, 8, owner)).resolves.toEqual({ items: [] });
			expect(JSON.stringify(mockOutput.info.mock.calls)).not.toContain('OldTargetSecretTable');
			expect(JSON.stringify(mockOutput.error.mock.calls)).not.toContain('OldTargetSecretTable');
			expect(mockOutput.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
			guarded.dispose();
		});

		it('suppresses STS error details when ownership changes before error logging', async () => {
			let targetCurrent = true;
			mockConnMgr.assertConnectionCurrent.mockImplementation(async () => {
				if (!targetCurrent) throw new Error('owner invalid');
			});
			const guarded = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'error-log-session');
			const owner = await openOwnedDocument(guarded);
			(mockPm.sendRequest as any).mockImplementationOnce(async () => {
				targetCurrent = false;
				throw new Error('SECRET_STS_TABLE_ERROR');
			});

			await expect(guarded.getCompletions('box-1', 1, 8, owner)).resolves.toEqual({ items: [] });

			expect(JSON.stringify(mockOutput.error.mock.calls)).not.toContain('SECRET_STS_TABLE_ERROR');
			expect(mockOutput.warn).toHaveBeenCalledWith(expect.stringContaining('details suppressed'));
			guarded.dispose();
		});
	});

	// ── Hover ─────────────────────────────────────────────────────────────

	describe('getHover', () => {
		it('translates LSP hover with string contents', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce({
				contents: 'Table: Users (10 columns)',
				range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } },
			});

			const result = await service.getHover('box-1', 1, 10, owner);
			expect(result).not.toBeNull();
			expect(result!.contents).toBe('Table: Users (10 columns)');
			expect(result!.range).toEqual({
				startLineNumber: 1,
				startColumn: 8,
				endLineNumber: 1,
				endColumn: 13,
			});
		});

		it('returns null for null response', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce(null);
			const result = await service.getHover('box-1', 1, 1, owner);
			expect(result).toBeNull();
		});

		it('returns null on error', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockRejectedValueOnce(new Error('fail'));
			const result = await service.getHover('box-1', 1, 1, owner);
			expect(result).toBeNull();
		});
	});

	// ── Signature help ────────────────────────────────────────────────────

	describe('getSignatureHelp', () => {
		it('translates LSP signature help', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce({
				signatures: [
					{
						label: 'DATEADD(datepart, number, date)',
						documentation: 'Adds an interval to a date.',
						parameters: [
							{ label: 'datepart', documentation: 'The part of the date.' },
							{ label: 'number', documentation: 'The number to add.' },
							{ label: 'date', documentation: 'The date to modify.' },
						],
					},
				],
				activeSignature: 0,
				activeParameter: 1,
			});

			const result = await service.getSignatureHelp('box-1', 1, 15, owner);
			expect(result).not.toBeNull();
			expect(result!.signatures).toHaveLength(1);
			expect(result!.signatures[0].label).toBe('DATEADD(datepart, number, date)');
			expect(result!.signatures[0].parameters).toHaveLength(3);
			expect(result!.activeParameter).toBe(1);
		});

		it('returns null for empty signatures', async () => {
			const owner = await openOwnedDocument(service);
			(mockPm.sendRequest as any).mockResolvedValueOnce({ signatures: [] });
			const result = await service.getSignatureHelp('box-1', 1, 1, owner);
			expect(result).toBeNull();
		});
	});

	// ── Diagnostics ───────────────────────────────────────────────────────

	describe('diagnostics', () => {
		it('translates LSP diagnostics to Monaco markers', async () => {
			const diagnosticsReceived: any[] = [];
			service.onDiagnostics((event) => diagnosticsReceived.push(event));
			const connection = createTestConnection();
			const expectedOwner = {
				connectionId: connection.id, database: 'Db', generation: 7,
				targetSignature: sqlConnectionTargetSignature(connection),
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connection, connection.username)!,
				revocationGeneration: 0,
			};
			await service.openDocument('box-1', 'SELECT 1', connection, expectedOwner);

			// Simulate STS publishing diagnostics
			(mockPm as any)._simulateNotification('textDocument/publishDiagnostics', {
				uri: 'kw-sql://language/test-session/1.sql',
				diagnostics: [
					{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } },
						message: 'Invalid syntax near SELECT',
						severity: 1, // Error
					},
					{
						range: { start: { line: 1, character: 4 }, end: { line: 1, character: 10 } },
						message: 'Unused variable',
						severity: 2, // Warning
					},
				],
			});
			await vi.waitFor(() => expect(diagnosticsReceived).toHaveLength(1));

			const event = diagnosticsReceived[0];
			expect(event.boxId).toBe('box-1');
			expect(event.markers).toHaveLength(2);
			expect(event.owner).toEqual(expectedOwner);

			// Error → Monaco severity 8
			expect(event.markers[0].severity).toBe(8);
			expect(event.markers[0].startLineNumber).toBe(1);
			expect(event.markers[0].startColumn).toBe(1);
			expect(event.markers[0].message).toBe('Invalid syntax near SELECT');

			// Warning → Monaco severity 4
			expect(event.markers[1].severity).toBe(4);
			expect(event.markers[1].startLineNumber).toBe(2);
			expect(event.markers[1].startColumn).toBe(5);
		});

		it('suppresses diagnostics when the full target changes inside composite admission', async () => {
			const diagnosticsReceived: any[] = [];
			let mutateOnDispatch = false;
			let guarded!: StsLanguageService;
			const dispatchOwner = vi.fn(async (_connection: unknown, _principal: string, _revocation: number, dispatch: () => unknown) => {
				if (mutateOnDispatch) {
					const target = (guarded as any)._targetByBoxId.get('box-race');
					(guarded as any)._targetByBoxId.set('box-race', { ...target, database: 'DbB', generation: target.generation + 1 });
				}
				return await dispatch();
			});
			guarded = new StsLanguageService(
				mockPm as any, mockConnMgr as any, mockContext as any, mockOutput, 'diag-race', undefined, dispatchOwner,
			);
			guarded.onDiagnostics(event => diagnosticsReceived.push(event));
			const connection = createTestConnection();
			const owner = {
				connectionId: connection.id, database: 'DbA', generation: 3,
				targetSignature: sqlConnectionTargetSignature(connection),
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(connection, connection.username)!,
				revocationGeneration: 0,
			};
			try {
				await guarded.openDocument('box-race', 'SELECT 1', connection, owner);
				mutateOnDispatch = true;
				(mockPm as any)._simulateNotification('textDocument/publishDiagnostics', {
					uri: 'kw-sql://language/diag-race/1.sql',
					diagnostics: [{
						range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
						message: 'owner-a-secret', severity: 1,
					}],
				});
				await vi.waitFor(() => expect(dispatchOwner).toHaveBeenCalledTimes(2));
				expect(diagnosticsReceived).toEqual([]);
			} finally {
				guarded.dispose();
			}
		});

		it('ignores diagnostics for unknown URIs', () => {
			const diagnosticsReceived: any[] = [];
			service.onDiagnostics((event) => diagnosticsReceived.push(event));

			(mockPm as any)._simulateNotification('textDocument/publishDiagnostics', {
				uri: 'file:///some/other/file.sql',
				diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'test', severity: 1 }],
			});

			expect(diagnosticsReceived).toHaveLength(0);
		});

		it('clears and ignores diagnostics from superseded STS document URIs', async () => {
			const diagnosticsReceived: any[] = [];
			service.onDiagnostics((event) => diagnosticsReceived.push(event));
			const connection = createTestConnection();
			const sampleOwner = createExpectedOwner(connection, 'sampledb', 1);
			const masterOwner = createExpectedOwner(connection, 'master', 2);
			await service.openDocument('box-1', 'SELECT 1', connection, sampleOwner);

			const first = service.connectDocument('box-1', connection, 'sampledb', sampleOwner);
			const firstError = first.catch(err => err);
			await waitForConnectCallCount(mockPm, 1);
			const second = service.connectDocument('box-1', connection, 'master', masterOwner);
			await waitForConnectCallCount(mockPm, 2);
			await expect(firstError).resolves.toHaveProperty('message', 'STS document superseded');

			(mockPm as any)._simulateNotification('textDocument/publishDiagnostics', {
				uri: 'kw-sql://language/test-session/1.sql',
				diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 6 } }, message: 'old', severity: 1 }],
			});

			expect(diagnosticsReceived).toEqual([{ boxId: 'box-1', markers: [], owner: sampleOwner }]);

			await simulateConnectedAndReady(mockPm, 'kw-sql://language/test-session/2.sql', 'connected-2');
			await expect(second).resolves.toBeUndefined();
		});
	});
});
