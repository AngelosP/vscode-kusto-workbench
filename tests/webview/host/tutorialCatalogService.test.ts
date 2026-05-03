import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';
import { TUTORIAL_CONNECTION_REQUIRED_MESSAGE, type TutorialCatalog } from '../../../src/shared/tutorials/tutorialCatalog.js';
import { TutorialCatalogService } from '../../../src/host/tutorials/tutorialCatalogService.js';

const catalogUrl = 'https://raw.githubusercontent.com/AngelosP/vscode-kusto-workbench/main/media/tutorials/catalog.v1.json';
const contentUrl = 'https://raw.githubusercontent.com/AngelosP/vscode-kusto-workbench/main/media/tutorials/content/one.md';

function mockConfiguration(url: string): void {
	vi.spyOn(vscode.workspace, 'getConfiguration').mockReturnValue({
		get: (key: string, fallback?: unknown) => {
			if (key === 'tutorials.catalogUrl') return url;
			if (key === 'tutorials.enableUpdateChecks') return true;
			if (key === 'tutorials.refreshIntervalHours') return 24;
			return fallback;
		},
		update: () => Promise.resolve(),
	} as any);
}

function createContext(extensionMode = vscode.ExtensionMode.Production): vscode.ExtensionContext {
	return {
		extensionMode,
		globalStorageUri: vscode.Uri.file('/global-storage'),
		extensionUri: vscode.Uri.file('/extension-root'),
		extension: { packageJSON: { version: '1.0.0' } },
	} as any;
}

function createService(extensionMode = vscode.ExtensionMode.Production): TutorialCatalogService {
	return new TutorialCatalogService(createContext(extensionMode));
}

function validCatalog(): TutorialCatalog {
	return {
		schemaVersion: 1,
		generatedAt: '2026-05-01T00:00:00.000Z',
		categories: [{ id: 'agent', title: 'Agent workflow' }],
		content: [{
			id: 'one',
			categoryId: 'agent',
			contentUrl: 'content/one.md',
			minExtensionVersion: '0.0.0',
			updateToken: 'one-v1',
		}],
	};
}

const webview = { asWebviewUri: (uri: vscode.Uri) => uri } as vscode.Webview;

describe('TutorialCatalogService', () => {
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		vi.restoreAllMocks();
		(vscode as any).__mockFileSystem.clear();
		mockConfiguration(catalogUrl);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		globalThis.fetch = originalFetch;
	});

	it('returns unavailable instead of packaged fallback when the remote catalog cannot be loaded', async () => {
		vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404 })));
		const service = createService();

		const result = await service.getViewerCatalog({ forceRefresh: true });

		expect(result.status.source).toBe('unavailable');
		expect(result.catalog.categories).toEqual([]);
		expect(result.catalog.content).toEqual([]);
		expect(result.status.errors[0]).toBe(TUTORIAL_CONNECTION_REQUIRED_MESSAGE);
	});

	it('does not fall back to extension markdown when remote tutorial content is unavailable', async () => {
		vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === catalogUrl) {
				return new Response(JSON.stringify(validCatalog()), { status: 200 });
			}
			return new Response('', { status: 404 });
		}));
		const service = createService();
		await service.getViewerCatalog({ forceRefresh: true });

		const content = await service.getTutorialContent('one', webview);

		expect(content.source).toBe('unavailable');
		expect(content.markdown).toBe('');
		expect(content.errors.join(' ')).toContain(TUTORIAL_CONNECTION_REQUIRED_MESSAGE);
	});

	it('uses downloaded catalog and content cache after the initial remote load', async () => {
		const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
			const url = String(input);
			if (url === catalogUrl) {
				return new Response(JSON.stringify(validCatalog()), { status: 200 });
			}
			if (url === contentUrl) {
				return new Response('# Downloaded tutorial\n\nCached rows are searchable.', { status: 200 });
			}
			return new Response('', { status: 404 });
		});
		vi.stubGlobal('fetch', fetchMock);
		const service = createService();
		const viewerCatalog = await service.getViewerCatalog({ forceRefresh: true });
		expect(viewerCatalog.catalog.content[0].displayName).toBe('Downloaded tutorial');
		expect(viewerCatalog.catalog.content[0].contentText).toBe('Cached rows are searchable.');
		const remoteContent = await service.getTutorialContent('one', webview);
		expect(remoteContent.source).toBe('remote');

		fetchMock.mockRejectedValue(new Error('offline'));
		const cachedCatalog = await service.getViewerCatalog();
		const cachedContent = await service.getTutorialContent('one', webview);

		expect(cachedCatalog.status.source).toBe('cache');
		expect(cachedContent.source).toBe('cache');
		expect(cachedContent.markdown).toContain('Downloaded tutorial');
	});

	it('loads the local media/tutorials catalog and content while running in extension development mode', async () => {
		const fetchMock = vi.fn(async () => new Response('', { status: 500 }));
		vi.stubGlobal('fetch', fetchMock);
		const context = createContext(vscode.ExtensionMode.Development);
		const service = new TutorialCatalogService(context);
		await vscode.workspace.fs.writeFile(service.getLocalDevelopmentCatalogUri(), new TextEncoder().encode(JSON.stringify(validCatalog())));
		await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(context.extensionUri, 'media', 'tutorials', 'content', 'one.md'), new TextEncoder().encode('# Local tutorial\n\nLocal searchable body.'));

		const result = await service.getViewerCatalog({ forceRefresh: true });
		const content = await service.getTutorialContent('one', webview);

		expect(result.status.source).toBe('localDevelopment');
		expect(result.catalog.content[0].id).toBe('one');
		expect(result.catalog.content[0].displayName).toBe('Local tutorial');
		expect(result.catalog.content[0].contentText).toBe('Local searchable body.');
		expect(content.source).toBe('localDevelopment');
		expect(content.markdown).toContain('Local tutorial');
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
