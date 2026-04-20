import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StsLanguageService } from '../../../src/host/sql/stsLanguageService';
import type { StsProcessManager } from '../../../src/host/sql/stsProcessManager';
import type { SqlConnectionManager, SqlConnection } from '../../../src/host/sqlConnectionManager';

// ── Mock factories ────────────────────────────────────────────────────────────

function createMockProcessManager(): StsProcessManager {
	const notificationHandlers = new Map<string, (params: any) => void>();

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
		getPassword: vi.fn().mockResolvedValue('test-password'),
	} as any;
}

function createMockOutput(): any {
	return {
		appendLine: vi.fn(),
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
		service = new StsLanguageService(mockPm as any, mockConnMgr as any, mockContext as any, mockOutput);
	});

	// ── URI mapping ───────────────────────────────────────────────────────

	describe('document lifecycle', () => {
		it('openDocument sends didOpen notification with correct URI', () => {
			service.openDocument('box-1', 'SELECT 1');
			expect(mockPm.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
				textDocument: {
					uri: 'sql://box-1.sql',
					languageId: 'sql',
					version: 1,
					text: 'SELECT 1',
				},
			});
		});

		it('changeDocument increments version', () => {
			service.openDocument('box-1', 'SELECT 1');
			service.changeDocument('box-1', 'SELECT 2');

			const changeCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didChange',
			);
			expect(changeCalls).toHaveLength(1);
			expect(changeCalls[0][1].textDocument.version).toBe(2);
		});

		it('changeDocument uses version 3 after two changes', () => {
			service.openDocument('box-1', 'v1');
			service.changeDocument('box-1', 'v2');
			service.changeDocument('box-1', 'v3');

			const changeCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didChange',
			);
			expect(changeCalls).toHaveLength(2);
			expect(changeCalls[1][1].textDocument.version).toBe(3);
		});

		it('closeDocument sends didClose notification', () => {
			service.openDocument('box-1', 'SELECT 1');
			service.closeDocument('box-1');
			expect(mockPm.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
				textDocument: { uri: 'sql://box-1.sql' },
			});
		});

		it('changeDocument sends full content in contentChanges', () => {
			service.openDocument('box-1', 'old');
			service.changeDocument('box-1', 'new text');
			const changeCalls = (mockPm.sendNotification as any).mock.calls.filter(
				(c: any[]) => c[0] === 'textDocument/didChange',
			);
			expect(changeCalls[0][1].contentChanges).toEqual([{ text: 'new text' }]);
		});
	});

	// ── Completions ───────────────────────────────────────────────────────

	describe('getCompletions', () => {
		it('translates LSP completion items', async () => {
			(mockPm.sendRequest as any).mockResolvedValueOnce({
				items: [
					{ label: 'Users', kind: 22, detail: 'Table', insertText: 'Users' },
					{ label: 'SELECT', kind: 14, detail: 'Keyword' },
				],
			});

			const result = await service.getCompletions('box-1', 1, 1);
			expect(result.items).toHaveLength(2);
			expect(result.items[0].label).toBe('Users');
			expect(result.items[0].kind).toBe(22);
			expect(result.items[1].label).toBe('SELECT');
		});

		it('handles array response format', async () => {
			(mockPm.sendRequest as any).mockResolvedValueOnce([
				{ label: 'Id', kind: 5 },
			]);

			const result = await service.getCompletions('box-1', 1, 5);
			expect(result.items).toHaveLength(1);
			expect(result.items[0].label).toBe('Id');
		});

		it('returns empty items on error', async () => {
			(mockPm.sendRequest as any).mockRejectedValueOnce(new Error('timeout'));

			const result = await service.getCompletions('box-1', 1, 1);
			expect(result.items).toEqual([]);
		});

		it('passes correct LSP position (0-based)', async () => {
			(mockPm.sendRequest as any).mockResolvedValueOnce({ items: [] });

			await service.getCompletions('box-1', 5, 10);
			expect(mockPm.sendRequest).toHaveBeenCalledWith('textDocument/completion', {
				textDocument: { uri: 'sql://box-1.sql' },
				position: { line: 4, character: 9 }, // 1-based → 0-based
			});
		});
	});

	// ── Hover ─────────────────────────────────────────────────────────────

	describe('getHover', () => {
		it('translates LSP hover with string contents', async () => {
			(mockPm.sendRequest as any).mockResolvedValueOnce({
				contents: 'Table: Users (10 columns)',
				range: { start: { line: 0, character: 7 }, end: { line: 0, character: 12 } },
			});

			const result = await service.getHover('box-1', 1, 10);
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
			(mockPm.sendRequest as any).mockResolvedValueOnce(null);
			const result = await service.getHover('box-1', 1, 1);
			expect(result).toBeNull();
		});

		it('returns null on error', async () => {
			(mockPm.sendRequest as any).mockRejectedValueOnce(new Error('fail'));
			const result = await service.getHover('box-1', 1, 1);
			expect(result).toBeNull();
		});
	});

	// ── Signature help ────────────────────────────────────────────────────

	describe('getSignatureHelp', () => {
		it('translates LSP signature help', async () => {
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

			const result = await service.getSignatureHelp('box-1', 1, 15);
			expect(result).not.toBeNull();
			expect(result!.signatures).toHaveLength(1);
			expect(result!.signatures[0].label).toBe('DATEADD(datepart, number, date)');
			expect(result!.signatures[0].parameters).toHaveLength(3);
			expect(result!.activeParameter).toBe(1);
		});

		it('returns null for empty signatures', async () => {
			(mockPm.sendRequest as any).mockResolvedValueOnce({ signatures: [] });
			const result = await service.getSignatureHelp('box-1', 1, 1);
			expect(result).toBeNull();
		});
	});

	// ── Diagnostics ───────────────────────────────────────────────────────

	describe('diagnostics', () => {
		it('translates LSP diagnostics to Monaco markers', () => {
			const diagnosticsReceived: any[] = [];
			service.onDiagnostics((event) => diagnosticsReceived.push(event));

			// Simulate STS publishing diagnostics
			(mockPm as any)._simulateNotification('textDocument/publishDiagnostics', {
				uri: 'sql://box-1.sql',
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

			expect(diagnosticsReceived).toHaveLength(1);
			const event = diagnosticsReceived[0];
			expect(event.boxId).toBe('box-1');
			expect(event.markers).toHaveLength(2);

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

		it('ignores diagnostics for unknown URIs', () => {
			const diagnosticsReceived: any[] = [];
			service.onDiagnostics((event) => diagnosticsReceived.push(event));

			(mockPm as any)._simulateNotification('textDocument/publishDiagnostics', {
				uri: 'file:///some/other/file.sql',
				diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, message: 'test', severity: 1 }],
			});

			expect(diagnosticsReceived).toHaveLength(0);
		});
	});
});
