import * as zlib from 'zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { HostQuerySharingApplicationHandler } from '../../../src/host/querySharingApplicationHandler';
import type { ShareToClipboardMessage } from '../../../src/shared/querySharingProtocol';

const CLUSTER_URL = 'https://contoso.westus.kusto.windows.net';

function createHandler() {
	const findConnection = vi.fn((connectionId: string) => connectionId === 'connection-1'
		? { clusterUrl: CLUSTER_URL }
		: undefined);
	const postMessage = vi.fn().mockResolvedValue(true);
	const writeClipboardText = vi.fn().mockResolvedValue(undefined);
	const handler = new HostQuerySharingApplicationHandler({
		findConnection,
		postMessage,
		writeClipboardText,
	});
	return { handler, findConnection, postMessage, writeClipboardText };
}

function copyAdeLinkMessage(overrides: Partial<{
	query: string;
	connectionId: string;
	database: string;
	boxId: string;
}> = {}) {
	return {
		type: 'copyAdeLink' as const,
		query: 'StormEvents | take 10',
		connectionId: 'connection-1',
		database: 'Samples & More',
		boxId: 'query-1',
		...overrides,
	};
}

function shareMessage(overrides: Partial<ShareToClipboardMessage> = {}): ShareToClipboardMessage {
	return {
		type: 'shareToClipboard',
		engine: 'kusto',
		boxId: 'query-1',
		includeTitle: true,
		includeQuery: true,
		includeResults: true,
		sectionName: 'Storm sample',
		queryText: 'StormEvents | take 10',
		connectionId: 'connection-1',
		database: 'Samples',
		columns: ['State', 'Count'],
		rowsData: [['WA', '10']],
		totalRows: 1,
		...overrides,
	};
}

function decodeAdxQuery(urlText: string): string {
	const url = new URL(urlText);
	const encoded = url.searchParams.get('query') ?? '';
	const padded = encoded.padEnd(encoded.length + ((4 - encoded.length % 4) % 4), '=');
	return zlib.gunzipSync(Buffer.from(padded, 'base64')).toString('utf8');
}

describe('HostQuerySharingApplicationHandler', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const { handler, findConnection, postMessage, writeClipboardText } = createHandler();

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionOpen', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(findConnection).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(writeClipboardText).not.toHaveBeenCalled();
	});

	it('claims malformed sharing requests before lookup or formatting effects', async () => {
		const { handler, findConnection, postMessage, writeClipboardText } = createHandler();
		let getterCalls = 0;
		const accessor = {
			type: 'copyAdeLink', connectionId: 'connection-1', database: 'Samples', boxId: 'query-1',
		};
		Object.defineProperty(accessor, 'query', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});

		await handler.handleMessage(accessor as never);
		await handler.handleMessage({
			...shareMessage(), columns: ['State', 42],
		} as never);

		expect(getterCalls).toBe(0);
		expect(findConnection).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(writeClipboardText).not.toHaveBeenCalled();
	});

	it.each([
		[{ query: '' }, 'No query text to share.'],
		[{ connectionId: '' }, 'Select a cluster connection first.'],
		[{ database: '' }, 'Select a database first.'],
	] as const)('validates copy-link inputs before connection lookup', async (overrides, expectedMessage) => {
		const { handler, findConnection, postMessage, writeClipboardText } = createHandler();
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

		await handler.handleMessage(copyAdeLinkMessage(overrides));

		expect(infoSpy).toHaveBeenCalledWith(expectedMessage);
		expect(findConnection).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
		expect(writeClipboardText).not.toHaveBeenCalled();
	});

	it('reports missing and malformed Kusto connections and omits malformed rich-share links', async () => {
		const { handler, findConnection, postMessage, writeClipboardText } = createHandler();
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage(copyAdeLinkMessage({ connectionId: 'missing' }));
		findConnection.mockReturnValueOnce({ clusterUrl: 'https:///' });
		await handler.handleMessage(copyAdeLinkMessage());
		findConnection.mockReturnValueOnce({ clusterUrl: 'https:///' });
		await handler.handleMessage(shareMessage({ includeQuery: false, includeResults: false }));

		expect(errorSpy.mock.calls).toEqual([
			['Connection not found.'],
			['Could not determine cluster name for the selected connection.'],
		]);
		expect(writeClipboardText).not.toHaveBeenCalled();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'shareContentReady', html: '<b>Storm sample</b>', text: 'Storm sample',
		});
	});

	it('copies a Kusto gzip/base64 ADX link and publishes the native notification', async () => {
		const { handler, postMessage, writeClipboardText } = createHandler();
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
		const query = 'StormEvents\n| where State == "WA"';

		await handler.handleMessage(copyAdeLinkMessage({ query }));

		expect(writeClipboardText).toHaveBeenCalledOnce();
		const copiedUrl = writeClipboardText.mock.calls[0][0];
		expect(copiedUrl).toMatch(/^https:\/\/dataexplorer\.azure\.com\/clusters\/contoso\.westus\/databases\/Samples%20%26%20More\?query=/);
		expect(decodeAdxQuery(copiedUrl)).toBe(query);
		expect(infoSpy).toHaveBeenCalledWith('Azure Data Explorer link copied to clipboard.');
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('reports host clipboard failure without publishing success', async () => {
		const { handler, postMessage, writeClipboardText } = createHandler();
		writeClipboardText.mockRejectedValueOnce(new Error('clipboard denied'));
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
		const errorSpy = vi.spyOn(vscode.window, 'showErrorMessage');

		await handler.handleMessage(copyAdeLinkMessage());

		expect(errorSpy).toHaveBeenCalledWith('Failed to copy Azure Data Explorer link.');
		expect(infoSpy).not.toHaveBeenCalledWith('Azure Data Explorer link copied to clipboard.');
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('formats escaped Kusto title, query, rows, summary, and direct link', async () => {
		const { handler, postMessage } = createHandler();
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

		await handler.handleMessage(shareMessage({
			sectionName: '<Storm & "Rain">',
			queryText: 'print value="<tag>&"',
			columns: ['Name & Place', 'Value'],
			rowsData: [['A|B', '<unsafe>'], ['line\nbreak', '"quoted"']],
			totalRows: 25,
		}));

		expect(postMessage).toHaveBeenCalledOnce();
		const ready = postMessage.mock.calls[0][0] as { type: string; html: string; text: string };
		expect(ready.type).toBe('shareContentReady');
		expect(ready.html).toContain('<b>&lt;Storm &amp; &quot;Rain&quot;&gt;</b>');
		expect(ready.html).toContain('Direct link to query');
		expect(ready.html).toContain('<code class="kql">print value=&quot;&lt;tag&gt;&amp;&quot;</code>');
		expect(ready.html).toContain('Showing 2 of 25 rows');
		expect(ready.html).toContain('&lt;unsafe&gt;');
		expect(ready.html).not.toContain('<unsafe>');
		expect(ready.text).toContain('Direct link to query: https://dataexplorer.azure.com/');
		expect(ready.text).toContain('| A\\|B | <unsafe> |');
		expect(ready.text).toContain('| line break | "quoted" |');
		expect(infoSpy).toHaveBeenCalledWith('Copied to clipboard and ready to paste into Teams.');
	});

	it('formats SQL share content without an Azure Data Explorer link promise', async () => {
		const { handler, findConnection, postMessage } = createHandler();

		await handler.handleMessage(shareMessage({
			engine: 'sql',
			boxId: 'sql-1',
			includeResults: false,
			sectionName: '',
			queryText: 'select 1 as Value',
			database: 'SqlDb',
			columns: [],
			rowsData: [],
			totalRows: 0,
		}));

		const ready = postMessage.mock.calls[0][0] as { html: string; text: string };
		expect(ready.html).toContain('<b>SQL Query</b>');
		expect(ready.html).toContain('<code class="sql">select 1 as Value</code>');
		expect(ready.html).not.toContain('Direct link to query');
		expect(ready.text).toContain('SQL Query');
		expect(findConnection).not.toHaveBeenCalled();
	});

	it('preserves empty-selection and selected-empty-content UX', async () => {
		const { handler, postMessage } = createHandler();
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');

		await handler.handleMessage(shareMessage({
			includeTitle: false, includeQuery: false, includeResults: false,
		}));
		await handler.handleMessage(shareMessage({
			includeTitle: false, includeQuery: true, includeResults: true,
			queryText: '   ', columns: [], rowsData: [], totalRows: 0,
		}));

		expect(infoSpy.mock.calls).toEqual([
			['Select at least one section to share.'],
			['Nothing to share â€” the selected sections are empty.'],
		]);
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('disposal rejects new work and suppresses late clipboard success publication', async () => {
		const { handler, findConnection, postMessage, writeClipboardText } = createHandler();
		let resolveClipboard!: () => void;
		writeClipboardText.mockReturnValueOnce(new Promise<void>(resolve => { resolveClipboard = resolve; }));
		const infoSpy = vi.spyOn(vscode.window, 'showInformationMessage');
		const pending = handler.handleMessage(copyAdeLinkMessage())!;

		handler.dispose();
		resolveClipboard();
		await pending;
		await handler.handleMessage(shareMessage());

		expect(writeClipboardText).toHaveBeenCalledOnce();
		expect(findConnection).toHaveBeenCalledOnce();
		expect(postMessage).not.toHaveBeenCalled();
		expect(infoSpy).not.toHaveBeenCalled();
	});
});
