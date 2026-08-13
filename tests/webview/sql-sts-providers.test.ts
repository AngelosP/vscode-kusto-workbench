import { afterEach, describe, expect, it, vi } from 'vitest';

import {
	clearSqlSectionSessionsForTest,
	registerSqlSectionSession,
	type SqlSectionSessionTarget,
} from '../../src/webview/core/sql-section-message-router.js';
import {
	registerStsEditorModel,
	registerStsProviders,
	unregisterStsEditorModel,
} from '../../src/webview/monaco/sql-sts-providers.js';

describe('SQL STS Monaco providers', () => {
	afterEach(() => {
		unregisterStsEditorModel('file:///sql-1.sql');
		clearSqlSectionSessionsForTest();
		delete (window as any).monaco;
	});

	it('validates positions before reserving a local STS request', async () => {
		let hoverProvider: { provideHover(model: unknown, position: unknown): Promise<unknown> } | undefined;
		(window as any).monaco = {
			languages: {
				CompletionItemKind: {},
				registerCompletionItemProvider: vi.fn(),
				registerHoverProvider: vi.fn((_language: string, provider: typeof hoverProvider) => {
					hoverProvider = provider;
				}),
				registerSignatureHelpProvider: vi.fn(),
			},
		};
		const requestSts = vi.fn(async () => ({ contents: 'hover' }));
		const target = {
			boxId: 'sql-1',
			instanceId: 'instance-1',
			targetGeneration: 1,
			ownerToken: 'owner-1',
			stsReady: true,
			setStsReady: vi.fn(() => true),
			setExecutionOwner: vi.fn(() => true),
			requestSts,
			advanceTargetGeneration: vi.fn(() => 1),
			adoptHostGeneration: vi.fn(() => true),
			clearDatabaseRequest: vi.fn(),
			beginDatabaseRequest: vi.fn(() => true),
			acceptDatabaseResponse: vi.fn(() => true),
			completeDatabaseRequest: vi.fn(() => true),
			admitOwnedMessage: vi.fn(() => true),
			resolveStsResponse: vi.fn(() => true),
			clear: vi.fn(),
		} satisfies SqlSectionSessionTarget;
		registerSqlSectionSession(target);
		registerStsEditorModel('file:///sql-1.sql', 'sql-1');
		registerStsProviders();
		const model = { uri: { toString: () => 'file:///sql-1.sql' } };

		await expect(hoverProvider?.provideHover(model, { lineNumber: 0, column: 1 })).resolves.toBeNull();
		expect(requestSts).not.toHaveBeenCalled();

		await expect(hoverProvider?.provideHover(model, { lineNumber: 1, column: 1 })).resolves.toEqual({
			contents: [{ value: 'hover' }],
		});
		expect(requestSts).toHaveBeenCalledOnce();
		expect(requestSts).toHaveBeenCalledWith('textDocument/hover', 1, 1, 60_000, expect.any(Function));
	});
});
