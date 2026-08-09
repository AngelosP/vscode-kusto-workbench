import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { html, render, nothing } from 'lit';

// ── Mocks (must come before component import) ────────────────────────────────

vi.mock('../../src/webview/core/persistence.js', () => ({
	schedulePersist: vi.fn(),
}));

vi.mock('../../src/webview/core/section-factory.js', () => ({
	__kustoRefreshAllDataSourceDropdowns: vi.fn(),
	__kustoNotifyResultsUpdated: vi.fn(),
}));

vi.mock('../../src/webview/core/utils.js', () => ({
	addPageScrollListener: vi.fn(() => vi.fn()),
	getScrollY: () => 0,
	maybeAutoScrollWhileDragging: () => {},
	escapeHtml: (s: string) => s,
}));

import '../../src/webview/sections/kw-url-section.js';
import '../../src/webview/components/kw-data-table.js';
import { KwUrlSection } from '../../src/webview/sections/kw-url-section.js';
import type { UrlSectionData } from '../../src/webview/sections/kw-url-section.js';
import { getCurrentResultArtifact } from '../../src/webview/core/results-state.js';
import { pState } from '../../src/webview/shared/persistence-state.js';
import {
	adoptHostOwnedMarkdownDocument,
	resetHostOwnedMarkdownDocument,
} from '../../src/webview/core/markdown-document-client.js';

// ── Static pure functions ─────────────────────────────────────────────────────

describe('KwUrlSection._parseCsv', () => {

	it('parses simple CSV', () => {
		const rows = KwUrlSection._parseCsv('a,b,c\n1,2,3');
		expect(rows).toEqual([['a', 'b', 'c'], ['1', '2', '3']]);
	});

	it('handles empty string', () => {
		const rows = KwUrlSection._parseCsv('');
		expect(rows).toEqual([['']]);
	});

	it('handles single field', () => {
		const rows = KwUrlSection._parseCsv('hello');
		expect(rows).toEqual([['hello']]);
	});

	it('handles CRLF line endings', () => {
		const rows = KwUrlSection._parseCsv('a,b\r\n1,2');
		expect(rows).toEqual([['a', 'b'], ['1', '2']]);
	});

	it('handles \\r only line endings', () => {
		const rows = KwUrlSection._parseCsv('a,b\r1,2');
		expect(rows).toEqual([['a', 'b'], ['1', '2']]);
	});

	it('handles quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"hello","world"');
		expect(rows).toEqual([['hello', 'world']]);
	});

	it('handles escaped quotes inside quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"say ""hello""",world');
		expect(rows).toEqual([['say "hello"', 'world']]);
	});

	it('handles commas inside quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"a,b",c');
		expect(rows).toEqual([['a,b', 'c']]);
	});

	it('handles newlines inside quoted fields', () => {
		const rows = KwUrlSection._parseCsv('"line1\nline2",b');
		expect(rows).toEqual([['line1\nline2', 'b']]);
	});

	it('handles trailing newline', () => {
		const rows = KwUrlSection._parseCsv('a,b\n');
		expect(rows).toEqual([['a', 'b'], ['']]);
	});

	it('handles Unicode line separators', () => {
		const rows = KwUrlSection._parseCsv('a,b\u2028c,d');
		expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
	});

	it('handles Unicode paragraph separators', () => {
		const rows = KwUrlSection._parseCsv('a,b\u2029c,d');
		expect(rows).toEqual([['a', 'b'], ['c', 'd']]);
	});

	it('handles multiple rows', () => {
		const rows = KwUrlSection._parseCsv('h1,h2\nv1,v2\nv3,v4');
		expect(rows).toEqual([['h1', 'h2'], ['v1', 'v2'], ['v3', 'v4']]);
	});

	it('handles empty fields', () => {
		const rows = KwUrlSection._parseCsv(',,,');
		expect(rows).toEqual([['', '', '', '']]);
	});
});

describe('KwUrlSection._looksLikeHtmlText', () => {

	it('detects <!doctype html', () => {
		expect(KwUrlSection._looksLikeHtmlText('<!doctype html><html>')).toBe(true);
	});

	it('detects <html', () => {
		expect(KwUrlSection._looksLikeHtmlText('<html><body>hi</body></html>')).toBe(true);
	});

	it('detects <head', () => {
		expect(KwUrlSection._looksLikeHtmlText('<head><title>Test</title></head>')).toBe(true);
	});

	it('detects <body', () => {
		expect(KwUrlSection._looksLikeHtmlText('<body>content</body>')).toBe(true);
	});

	it('is case insensitive', () => {
		expect(KwUrlSection._looksLikeHtmlText('<!DOCTYPE HTML>')).toBe(true);
		expect(KwUrlSection._looksLikeHtmlText('<HTML>')).toBe(true);
	});

	it('handles leading whitespace', () => {
		expect(KwUrlSection._looksLikeHtmlText('   <!doctype html>')).toBe(true);
	});

	it('returns false for non-HTML text', () => {
		expect(KwUrlSection._looksLikeHtmlText('just plain text')).toBe(false);
	});

	it('returns false for partial HTML tags', () => {
		expect(KwUrlSection._looksLikeHtmlText('<h1>Heading</h1>')).toBe(false);
	});

	it('returns false for empty string', () => {
		expect(KwUrlSection._looksLikeHtmlText('')).toBe(false);
	});

	it('handles null-ish input gracefully', () => {
		expect(KwUrlSection._looksLikeHtmlText(null as any)).toBe(false);
		expect(KwUrlSection._looksLikeHtmlText(undefined as any)).toBe(false);
	});
});

// ── Component rendering & serialization ───────────────────────────────────────

let container: HTMLDivElement;

function createUrlSection(boxId = 'url_test_1'): KwUrlSection {
	render(html`
		<kw-url-section box-id=${boxId}></kw-url-section>
	`, container);
	const section = container.querySelector('kw-url-section')!;
	section.id = boxId;
	return section;
}

beforeEach(() => {
	resetHostOwnedMarkdownDocument();
	delete (window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode;
	container = document.createElement('div');
	document.body.appendChild(container);
});

afterEach(() => {
	render(nothing, container);
	container.remove();
	resetHostOwnedMarkdownDocument();
	delete (window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode;
});

describe('kw-url-section — rendering', () => {
	it('renders the authored URL statically without requesting browser-host fetch', async () => {
		(window as unknown as { __kustoReadOnlyMode?: boolean }).__kustoReadOnlyMode = true;
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection();
			el.setUrl('https://example.com/data.csv');
			el.setExpanded(true);
			await el.updateComplete;

			(el as any)._requestFetch();
			await el.updateComplete;

			expect(postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'fetchUrl' }));
			expect(el.getFetchState()).toMatchObject({ loading: false, loaded: false });
			expect(el.shadowRoot!.querySelector('.url-readonly-source')?.textContent)
				.toBe('https://example.com/data.csv');
			expect(el.shadowRoot!.querySelector('.url-input')).toBeNull();
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('renders without errors', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		expect(el).toBeTruthy();
		expect(el.shadowRoot).toBeTruthy();
	});

	it('shows a URL input field', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		const input = el.shadowRoot!.querySelector('.url-input') as HTMLInputElement;
		expect(input).toBeTruthy();
		expect(input.placeholder).toContain('URL');
	});

	it('keeps Save enabled for imported CSV and uses the imported-data protocol', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		const internal = el as any;
		internal._url = 'https://example.com/data.csv';
		internal._fetchState = { ...internal._fetchState, loaded: true, kind: 'csv' };
		internal._csvColumns = [{ name: 'Name' }];
		internal._csvRows = [['alpha']];
		internal._csvActive = true;
		await el.updateComplete;
		const table = el.shadowRoot!.querySelector('kw-data-table') as any;
		expect(table.options.showSave).toBe(true);
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			table.dispatchEvent(new CustomEvent('save', {
				detail: { csv: 'Name\nalpha', suggestedFileName: 'CSV.csv' },
			}));
			expect(postMessage).toHaveBeenCalledWith({
				type: 'saveImportedCsv', csv: 'Name\nalpha', suggestedFileName: 'CSV.csv',
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('publishes CSV for artifact consumers and revokes it on URL error', async () => {
		const el = createUrlSection('custom-url');
		el.setName('Imported CSV');
		el.setUrl('https://example.com/data.csv');
		await el.updateComplete;
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		(el as any)._requestFetch();
		const request = postMessage.mock.calls.at(-1)?.[0] as any;

		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'urlContent', boxId: 'custom-url', requestId: request.requestId,
			requestedUrl: request.url, url: 'https://example.com/data.csv',
			kind: 'csv', contentType: 'text/csv', status: 200, body: 'Name,Score\nalpha,1\nbeta,2',
		} }));
		await el.updateComplete;
		await el.updateComplete;
		const artifact = getCurrentResultArtifact('custom-url');
		const table = el.shadowRoot?.querySelector('kw-data-table') as any;

		expect(artifact).toMatchObject({
			sourceBoxId: 'custom-url', columns: [{ name: 'Name' }, { name: 'Score' }],
			rows: [['alpha', '1'], ['beta', '2']],
			producer: expect.objectContaining({ engine: 'url', boxId: 'custom-url' }),
		});
		expect(table.resultArtifactGoverned).toBe(false);
		expect(table.canCopyRows()).toBe(true);
		expect(table.options.showSave).toBe(true);

		try {
			el.setUrl('https://example.com/failing.csv');
			(el as any)._requestFetch();
			const failedRequest = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlError', boxId: 'custom-url', requestId: failedRequest.requestId,
				requestedUrl: failedRequest.url, error: 'Fetch failed',
			} }));
			await el.updateComplete;
			expect(getCurrentResultArtifact('custom-url')).toBeNull();
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('does not republish URL A rows while URL B is pending', async () => {
		const el = createUrlSection('url-replacement');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			el.setUrl('https://example.com/a.csv');
			(el as any)._requestFetch();
			const requestA = postMessage.mock.calls.at(-1)?.[0] as any;
			expect(requestA).toMatchObject({ type: 'fetchUrl', url: 'https://example.com/a.csv' });
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: el.boxId, requestId: requestA.requestId,
				requestedUrl: requestA.url, url: requestA.url,
				kind: 'csv', contentType: 'text/csv', status: 200, body: 'Value\nA',
			} }));
			await el.updateComplete;
			expect(getCurrentResultArtifact(el.boxId)?.rows).toEqual([['A']]);

			el.setUrl('https://example.com/b.csv');
			(el as any)._requestFetch();
			const requestB = postMessage.mock.calls.at(-1)?.[0] as any;
			expect(requestB).toMatchObject({ type: 'fetchUrl', url: 'https://example.com/b.csv' });
			expect(requestB.requestId).not.toBe(requestA.requestId);
			expect(getCurrentResultArtifact(el.boxId)).toBeNull();
			expect(el.getFetchState()).toMatchObject({
				url: requestB.url, loaded: false, loading: true, kind: '', body: '',
			});

			for (const lateA of [
				{ type: 'urlContent', body: 'Value\nLATE_A', kind: 'csv', url: requestA.url },
				{ type: 'urlError', error: 'Late A failure' },
			]) {
				window.dispatchEvent(new MessageEvent('message', { data: {
					...lateA, boxId: el.boxId, requestId: requestA.requestId,
					requestedUrl: requestA.url, contentType: 'text/csv', status: 200,
				} }));
			}
			await el.updateComplete;
			expect(getCurrentResultArtifact(el.boxId)).toBeNull();
			expect(el.getFetchState()).toMatchObject({ url: requestB.url, loading: true, error: '' });

			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: el.boxId, requestId: requestB.requestId,
				requestedUrl: requestB.url, url: requestB.url,
				kind: 'csv', contentType: 'text/csv', status: 200, body: 'Value\nB',
			} }));
			await el.updateComplete;
			expect(getCurrentResultArtifact(el.boxId)?.rows).toEqual([['B']]);
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('rejects late responses after same-box same-URL component recreation', async () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const oldSection = createUrlSection('url-recreated');
			oldSection.id = 'url-recreated';
			oldSection.setUrl('https://example.com/data.csv');
			(oldSection as any)._requestFetch();
			const requestA = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: oldSection.boxId, requestId: requestA.requestId,
				requestedUrl: requestA.url, url: requestA.url,
				kind: 'csv', contentType: 'text/csv', status: 200, body: 'Value\nOLD',
			} }));
			await oldSection.updateComplete;
			expect(getCurrentResultArtifact(oldSection.boxId)?.rows).toEqual([['OLD']]);

			render(nothing, container);
			const newSection = createUrlSection('url-recreated');
			newSection.id = 'url-recreated';
			newSection.setUrl('https://example.com/data.csv');
			expect(getCurrentResultArtifact(newSection.boxId)).toBeNull();
			(newSection as any)._requestFetch();
			const requestB = postMessage.mock.calls.at(-1)?.[0] as any;
			expect(requestB.requestId).not.toBe(requestA.requestId);

			for (const lateA of [
				{ type: 'urlContent', kind: 'csv', body: 'Value\nLATE_A', url: requestA.url },
				{ type: 'urlError', error: 'Late A failure' },
			]) {
				window.dispatchEvent(new MessageEvent('message', { data: {
					...lateA, boxId: newSection.boxId, requestId: requestA.requestId,
					requestedUrl: requestA.url, contentType: 'text/csv', status: 200,
				} }));
			}
			await newSection.updateComplete;
			expect(getCurrentResultArtifact(newSection.boxId)).toBeNull();
			expect(newSection.getFetchState()).toMatchObject({ loading: true, loaded: false, error: '' });

			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: newSection.boxId, requestId: requestB.requestId,
				requestedUrl: requestB.url, url: requestB.url,
				kind: 'csv', contentType: 'text/csv', status: 200, body: 'Value\nB',
			} }));
			await newSection.updateComplete;
			expect(getCurrentResultArtifact(newSection.boxId)?.rows).toEqual([['B']]);
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('cancels a detached instance debounce before replacement data publishes', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const oldSection = createUrlSection('url-debounce-replaced');
			oldSection.id = 'url-debounce-replaced';
			await oldSection.updateComplete;
			const input = oldSection.shadowRoot?.querySelector<HTMLInputElement>('.url-input');
			expect(input).toBeTruthy();
			input!.value = 'https://example.com/a.csv';
			input!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

			render(nothing, container);
			const replacement = createUrlSection('url-debounce-replaced');
			replacement.id = 'url-debounce-replaced';
			replacement.setUrl('https://example.com/b.csv');
			(replacement as any)._requestFetch();
			const requestB = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: replacement.boxId, requestId: requestB.requestId,
				requestedUrl: requestB.url, url: requestB.url,
				kind: 'csv', contentType: 'text/csv', status: 200, body: 'Value\nB',
			} }));
			await replacement.updateComplete;
			expect(getCurrentResultArtifact(replacement.boxId)?.rows).toEqual([['B']]);

			vi.advanceTimersByTime(250);
			await replacement.updateComplete;

			expect(postMessage.mock.calls.map(call => call[0]).filter(message => message.url === 'https://example.com/a.csv'))
				.toEqual([]);
			expect(getCurrentResultArtifact(replacement.boxId)?.rows).toEqual([['B']]);
		} finally {
			window.vscode = previousVsCode;
			vi.useRealTimers();
		}
	});

	it('preserves a pending debounce across a synchronous DOM reorder', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection('url-debounce-moved');
			await el.updateComplete;
			const input = el.shadowRoot?.querySelector<HTMLInputElement>('.url-input');
			input!.value = 'https://example.com/moved.csv';
			input!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
			const sibling = document.createElement('div');
			container.appendChild(sibling);
			container.appendChild(el);
			await Promise.resolve();

			vi.advanceTimersByTime(250);
			await el.updateComplete;
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(1);
			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'fetchUrl', boxId: el.boxId, url: 'https://example.com/moved.csv',
			}));
		} finally {
			window.vscode = previousVsCode;
			vi.useRealTimers();
		}
	});

	it('preserves CSV artifact and resize observation across a synchronous DOM reorder', async () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection('url-csv-moved');
			el.setUrl('https://example.com/moved.csv');
			(el as any)._requestFetch();
			const request = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: el.boxId, requestId: request.requestId,
				requestedUrl: request.url, url: request.url, kind: 'csv', contentType: 'text/csv',
				status: 200, body: 'Name\nalpha',
			} }));
			await el.updateComplete;
			await el.updateComplete;
			const artifactBefore = getCurrentResultArtifact(el.boxId)?.artifactId;
			const observerBefore = (el as any)._csvResizeObs;
			expect(observerBefore).toBeTruthy();
			const sibling = document.createElement('div');
			container.appendChild(sibling);
			container.appendChild(el);
			await Promise.resolve();

			expect((el as any)._csvResizeObs).toBe(observerBefore);
			expect(getCurrentResultArtifact(el.boxId)?.artifactId).toBe(artifactBefore);
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('ignores a held persistence callback from a detached same-ID predecessor', async () => {
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.documentRuntimeActive = true;
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 14,
			sectionRevisions: { url_replaced: 0 },
			markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'url_replaced', type: 'url', url: 'https://example.com/current.png', expanded: true }],
		});
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const predecessor = createUrlSection('url_replaced');
			predecessor.applyHostDocumentState({
				id: predecessor.boxId, type: 'url', url: 'https://example.com/stale.png', expanded: true,
			});
			const heldPersist = () => (predecessor as any)._schedulePersist();
			render(nothing, container);
			const replacement = createUrlSection('url_replaced');
			replacement.applyHostDocumentState({
				id: replacement.boxId, type: 'url', url: 'https://example.com/current.png', expanded: true,
			});
			await Promise.resolve();
			postMessage.mockClear();

			heldPersist();

			expect(document.getElementById('url_replaced')).toBe(replacement);
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'markdownDocumentCommand')).toHaveLength(0);
		} finally {
			window.vscode = previousVsCode;
		}
	});
});

describe('kw-url-section — public API', () => {

	it('getName / setName work', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setName('My URL');
		expect(el.getName()).toBe('My URL');
	});

	it('setUrl updates the URL state', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setUrl('https://example.com');
		const state = el.getFetchState();
		expect(state.url).toBe('https://example.com');
	});

	it('setExpanded toggles expanded state', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setExpanded(false);
		expect(el.getFetchState().expanded).toBe(false);
		el.setExpanded(true);
		expect(el.getFetchState().expanded).toBe(true);
	});

	it('emits persisted edits through the shared host document command client', async () => {
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.documentRuntimeActive = true;
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 12,
			sectionRevisions: { url_owned: 0 },
			markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'url_owned', type: 'url', url: 'https://example.com/before.png', expanded: true }],
		});
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection('url_owned');
			el.applyHostDocumentState({
				id: 'url_owned', type: 'url', url: 'https://example.com/before.png', expanded: true,
			});
			await el.updateComplete;
			postMessage.mockClear();
			const input = el.shadowRoot!.querySelector('.url-input') as HTMLInputElement;
			input.value = 'https://example.com/after.png';
			input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));

			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'markdownDocumentCommand', sourceGeneration: 12, expectedDocumentRevision: 0,
				command: expect.objectContaining({
					type: 'patch', sectionId: 'url_owned', expectedSectionRevision: 0,
					patch: expect.objectContaining({ url: 'https://example.com/after.png' }),
				}),
			}));
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('commits programmatic collapse through the host command client', async () => {
		pState.documentKind = 'kqlx';
		pState.compatibilityMode = false;
		pState.documentRuntimeActive = true;
		adoptHostOwnedMarkdownDocument({
			documentRevision: 0,
			sourceGeneration: 13,
			sectionRevisions: { url_batch: 0 },
			markdownSectionRevisions: {},
		}, {
			sections: [{ id: 'url_batch', type: 'url', url: 'https://example.com/image.png', expanded: true }],
		});
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection('url_batch');
			el.applyHostDocumentState({
				id: 'url_batch', type: 'url', url: 'https://example.com/image.png', expanded: true,
			});
			postMessage.mockClear();
			el.setExpanded(false);
			el.commitDocumentState();

			expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
				type: 'markdownDocumentCommand', sourceGeneration: 13, expectedDocumentRevision: 0,
				command: expect.objectContaining({
					type: 'patch', sectionId: 'url_batch', expectedSectionRevision: 0,
					patch: expect.objectContaining({ expanded: false }),
				}),
			}));
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('applies same-URL presentation state without replacing CSV runtime state', async () => {
		const el = createUrlSection('url_projection');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			el.setUrl('https://example.com/data.csv');
			(el as any)._requestFetch();
			const request = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: el.boxId, requestId: request.requestId,
				requestedUrl: request.url, url: request.url, kind: 'csv', contentType: 'text/csv',
				status: 200, body: 'Name\nalpha',
			} }));
			await el.updateComplete;
			await el.updateComplete;
			const artifactBefore = getCurrentResultArtifact(el.boxId);
			const tableBefore = el.shadowRoot?.querySelector('kw-data-table');
			postMessage.mockClear();

			el.applyHostDocumentState({
				id: 'url_projection', type: 'url', name: 'Projected', url: 'https://example.com/data.csv',
				expanded: true, outputHeightPx: 360, imageSizeMode: 'natural', imageAlign: 'center',
				imageOverflow: 'scroll',
			});
			await el.updateComplete;

			expect(el.getFetchState()).toMatchObject({
				url: 'https://example.com/data.csv', expanded: true, loaded: true, body: 'Name\nalpha',
			});
			expect(getCurrentResultArtifact(el.boxId)?.artifactId).toBe(artifactBefore?.artifactId);
			expect(el.shadowRoot?.querySelector('kw-data-table')).toBe(tableBefore);
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(0);
			expect(el.createDocumentState()).toMatchObject({
				name: 'Projected', outputHeightPx: 360, imageSizeMode: 'natural', imageAlign: 'center',
				imageOverflow: 'scroll',
			});
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('keeps a redirected response URL out of persisted authored state', async () => {
		const el = createUrlSection('url_redirect');
		const authoredUrl = 'https://example.com/download.csv';
		const resolvedUrl = 'https://storage.example.net/blob.csv?signature=secret';
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			el.setUrl(authoredUrl);
			(el as any)._requestFetch();
			const request = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: el.boxId, requestId: request.requestId,
				requestedUrl: request.url, url: resolvedUrl, kind: 'csv', contentType: 'text/csv',
				status: 200, body: 'Name\nalpha',
			} }));
			await el.updateComplete;
			await el.updateComplete;
			const artifactBefore = getCurrentResultArtifact(el.boxId)?.artifactId;

			expect(el.getFetchState()).toMatchObject({ url: authoredUrl, resolvedUrl });
			expect(el.createDocumentState().url).toBe(authoredUrl);
			el.applyHostDocumentState({
				id: el.boxId, type: 'url', name: 'Renamed', url: authoredUrl, expanded: true,
				outputHeightPx: 360,
			});
			await el.updateComplete;
			expect(el.createDocumentState().url).toBe(authoredUrl);
			expect(getCurrentResultArtifact(el.boxId)?.artifactId).toBe(artifactBefore);
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(1);
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('applies same-URL presentation state without replacing the HTML iframe', async () => {
		const el = createUrlSection('url_html_projection');
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		const previousDomPurify = window.DOMPurify;
		window.vscode = { postMessage } as any;
		window.DOMPurify = { sanitize: (value: string) => value } as any;
		try {
			el.setUrl('https://example.com/page.html');
			(el as any)._requestFetch();
			const request = postMessage.mock.calls.at(-1)?.[0] as any;
			window.dispatchEvent(new MessageEvent('message', { data: {
				type: 'urlContent', boxId: el.boxId, requestId: request.requestId,
				requestedUrl: request.url, url: request.url, kind: 'html', contentType: 'text/html',
				status: 200, body: '<main>stable</main>',
			} }));
			await el.updateComplete;
			await el.updateComplete;
			const iframeBefore = el.shadowRoot?.querySelector('iframe');
			expect(iframeBefore).toBeTruthy();

			el.applyHostDocumentState({
				id: el.boxId, type: 'url', name: 'Projected HTML',
				url: 'https://example.com/page.html', expanded: true, outputHeightPx: 320,
			});
			await el.updateComplete;

			expect(el.shadowRoot?.querySelector('iframe')).toBe(iframeBefore);
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(1);
		} finally {
			window.vscode = previousVsCode;
			window.DOMPurify = previousDomPurify;
		}
	});

	it('cancels a pending URL debounce when an authoritative projection collapses the section', async () => {
		vi.useFakeTimers();
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection('url_collapsed_projection');
			await el.updateComplete;
			const input = el.shadowRoot?.querySelector<HTMLInputElement>('.url-input');
			input!.value = 'https://example.com/debounced.csv';
			input!.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
			el.applyHostDocumentState({
				id: el.boxId, type: 'url', url: 'https://example.com/debounced.csv', expanded: false,
			});

			vi.advanceTimersByTime(250);
			await el.updateComplete;
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(0);
			(el as any)._requestFetch();
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(0);
		} finally {
			window.vscode = previousVsCode;
			vi.useRealTimers();
		}
	});

	it('fetches once when reconciliation recreates an expanded URL section', async () => {
		const postMessage = vi.fn();
		const previousVsCode = window.vscode;
		window.vscode = { postMessage } as any;
		try {
			const el = createUrlSection('url_reconciled');
			el.setUrl('https://example.com/recreated.csv');
			el.applyHostDocumentState({
				id: el.boxId, type: 'url', url: 'https://example.com/recreated.csv', expanded: true,
			}, { fetchIfMissing: true });
			await el.updateComplete;
			await Promise.resolve();

			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(1);
			el.applyHostDocumentState({
				id: el.boxId, type: 'url', url: 'https://example.com/recreated.csv', expanded: true,
			}, { fetchIfMissing: true });
			await el.updateComplete;
			expect(postMessage.mock.calls.filter(call => call[0]?.type === 'fetchUrl')).toHaveLength(1);
		} finally {
			window.vscode = previousVsCode;
		}
	});

	it('keeps legacy URL projections with omitted expanded state collapsed', async () => {
		const el = createUrlSection('url_legacy_collapsed');
		el.applyHostDocumentState({
			id: el.boxId, type: 'url', url: 'https://example.com/legacy.png',
		});
		await el.updateComplete;

		expect(el.getFetchState().expanded).toBe(false);
		expect(el.createDocumentState().expanded).toBe(false);
	});
});

describe('kw-url-section — serialize', () => {

	it('serializes default state', async () => {
		const el = createUrlSection('url_42');
		await el.updateComplete;
		const data = el.serialize();
		expect(data.id).toBe('url_42');
		expect(data.type).toBe('url');
		expect(data.name).toBe('');
		expect(data.url).toBe('');
		expect(data.expanded).toBe(true);
	});

	it('serializes with name and URL', async () => {
		const el = createUrlSection('url_99');
		await el.updateComplete;
		el.setName('Test URL');
		el.setUrl('https://example.com/data.csv');
		const data = el.serialize();
		expect(data.name).toBe('Test URL');
		expect(data.url).toBe('https://example.com/data.csv');
	});

	it('serializes expanded=false', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setExpanded(false);
		const data = el.serialize();
		expect(data.expanded).toBe(false);
	});

	it('omits default image display settings', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		const data = el.serialize();
		// Defaults: fill, left, shrink — all omitted.
		expect(data.imageSizeMode).toBeUndefined();
		expect(data.imageAlign).toBeUndefined();
		expect(data.imageOverflow).toBeUndefined();
	});

	it('includes non-default image display settings', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setImageDisplayMode('natural', 'center', 'scroll');
		const data = el.serialize();
		expect(data.imageSizeMode).toBe('natural');
		expect(data.imageAlign).toBe('center');
		expect(data.imageOverflow).toBe('scroll');
	});

	it('setImageDisplayMode ignores invalid values', async () => {
		const el = createUrlSection();
		await el.updateComplete;
		el.setImageDisplayMode('bogus' as any, 'bogus' as any, 'bogus' as any);
		const data = el.serialize();
		// Should still be defaults.
		expect(data.imageSizeMode).toBeUndefined();
		expect(data.imageAlign).toBeUndefined();
		expect(data.imageOverflow).toBeUndefined();
	});
});
