import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AzureDevOpsProvider } from '../../browser-ext/src/providers/azure-devops';
import { loadBrowserCompanion } from '../../browser-ext/src/companion-state';
import { GitHubProvider } from '../../browser-ext/src/providers/github';
import { RawUrlProvider } from '../../browser-ext/src/providers/raw-url';
import { isSupportedFile } from '../../browser-ext/src/providers/types';
import {
	composeBrowserCompatibilityState,
	parseBrowserNativeWorkbenchText,
	parseBrowserWorkbenchText,
} from '../../browser-ext/src/viewer-document';

describe('browser provider document types', () => {
	it('makes raw URL routing and viewer resources reachable in the production manifest', () => {
		const manifest = JSON.parse(readFileSync(resolve(process.cwd(), 'browser-ext/manifest.json'), 'utf8'));

		expect(manifest.content_scripts).toEqual(expect.arrayContaining([
			expect.objectContaining({ matches: ['<all_urls>'], js: ['content-script.js'] }),
		]));
		expect(manifest.web_accessible_resources).toEqual(expect.arrayContaining([
			expect.objectContaining({ matches: ['<all_urls>'], resources: expect.arrayContaining(['viewer.html', 'viewer-boot.js']) }),
		]));
	});

	it('recognizes MDX filenames', () => {
		expect(isSupportedFile('analysis.mdx')).toBe(true);
		expect(isSupportedFile('ANALYSIS.MDX')).toBe(true);
	});

	it('detects MDX on GitHub', () => {
		const file = new GitHubProvider().getFileInfo(
			new URL('https://github.com/owner/repo/blob/main/docs/analysis.mdx'),
		);

		expect(file).toMatchObject({ filename: 'analysis.mdx', sourceLabel: 'GitHub' });
		expect(file?.rawContentUrl).toContain('/raw/main/docs/analysis.mdx');
	});

	it('detects MDX on Azure DevOps', () => {
		const file = new AzureDevOpsProvider().getFileInfo(
			new URL('https://dev.azure.com/org/project/_git/repo?path=%2Fdocs%2Fanalysis.mdx&version=GBmain'),
		);

		expect(file).toMatchObject({ filename: 'analysis.mdx', sourceLabel: 'Azure DevOps' });
		expect(file?.rawContentUrl).toBeTruthy();
	});

	it('detects direct MDX URLs', () => {
		const url = new URL('https://example.test/docs/analysis.mdx');
		const provider = new RawUrlProvider();

		expect(provider.canHandle(url)).toBe(true);
		expect(provider.getFileInfo(url)).toMatchObject({
			filename: 'analysis.mdx', rawContentUrl: url.href, sourceLabel: 'Direct Link',
		});
	});

	it.each([
		['unsafe ID', [{ id: 'bad id', type: 'markdown' }]],
		['duplicate ID', [{ id: 'same', type: 'markdown' }, { id: 'same', type: 'url' }]],
		['malformed known shape', [{ id: 'chart_1', type: 'chart', yColumns: [null] }]],
		['multiple linked owners', [
			{ id: 'query_1', type: 'query', linkedQueryPath: 'one.kql' },
			{ id: 'query_2', type: 'query', linkedQueryPath: 'two.kql' },
		]],
	] as const)('rejects browser documents with %s using host structural validation', (_label, sections) => {
		const parsed = parseBrowserWorkbenchText(JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections },
		}), { allowedKinds: ['kqlx'] });

		expect(parsed.ok).toBe(false);
	});

	it.each(['sqlx', 'kqlx'] as const)('rejects native %s SQL linked sections while preserving sidecar parser support', kind => {
		const text = JSON.stringify({
			kind, version: 1, state: { sections: [{
				id: 'sql_linked', type: 'sql', linkedQueryPath: 'query.sql',
			}] },
		});

		expect(parseBrowserWorkbenchText(text, { allowedKinds: [kind] }).ok).toBe(true);
		expect(parseBrowserNativeWorkbenchText(text, { allowedKinds: [kind] })).toMatchObject({
			ok: false, error: expect.stringContaining('do not support linkedQueryPath on SQL sections'),
		});
	});

	it('fails visibly composed browser state when an existing companion is invalid', () => {
		const result = composeBrowserCompatibilityState('print primary = 1', { status: 'loaded', content: JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'bad id', type: 'query', linkedQueryPath: 'sample.kql' },
			] },
		}) }, { expectedFilename: 'sample.kql' });

		expect(result).toMatchObject({ ok: false, error: expect.stringContaining('unsafe section id') });
	});

	it('hydrates valid browser companions without losing opaque data', () => {
		const result = composeBrowserCompatibilityState('print primary = 2', { status: 'loaded', content: JSON.stringify({
			kind: 'kqlx', version: 1, futureRoot: { keep: true }, state: { futureState: 'keep', sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql' },
				{ id: 'future_1', type: 'future-section', payload: { keep: true } },
			] },
		}) }, { expectedFilename: 'sample.kql' });

		expect(result).toMatchObject({ ok: true, state: {
			futureState: 'keep', sections: [
				{ id: 'query_1', type: 'query', query: 'print primary = 2' },
				{ id: 'future_1', type: 'future-section', payload: { keep: true } },
			],
		} });
	});

	it.each([
		['missing link', [
			{ id: 'query_1', type: 'query' },
		]],
		['mismatched link', [
			{ id: 'query_1', type: 'query', linkedQueryPath: 'other.kql' },
		]],
		['non-first link', [
			{ id: 'markdown_1', type: 'markdown', text: 'before' },
			{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql' },
		]],
	] as const)('rejects browser companions with %s', (_label, sections) => {
		const result = composeBrowserCompatibilityState('print primary = 1', { status: 'loaded', content: JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections },
		}) }, { expectedFilename: 'sample.kql' });

		expect(result.ok).toBe(false);
	});

	it('resolves companion linkage against the exact raw URL', () => {
		const result = composeBrowserCompatibilityState('print primary = 1', { status: 'loaded', content: JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql' },
			] },
		}) }, {
			expectedFilename: 'sample.kql',
			rawContentUrl: 'https://example.test/work/sample.kql',
			sidecarUrl: 'https://example.test/work/sample.kql.json',
		});

		expect(result).toMatchObject({ ok: true, state: { sections: [
			{ id: 'query_1', type: 'query', query: 'print primary = 1' },
		] } });
	});

	it('falls back only when the companion is absent with HTTP 404', async () => {
		const missing = await loadBrowserCompanion('https://example.test/sample.kql.json', async () => {
			throw Object.assign(new Error('HTTP 404: Not Found'), { status: 404 });
		});
		const failed = await loadBrowserCompanion('https://example.test/sample.kql.json', async () => {
			throw Object.assign(new Error('HTTP 500: Server Error'), { status: 500 });
		});

		expect(missing).toEqual({ status: 'missing' });
		expect(composeBrowserCompatibilityState('print primary = 1', missing)).toMatchObject({
			ok: true, state: { sections: [{ type: 'query', query: 'print primary = 1' }] },
		});
		expect(failed).toEqual({ status: 'error', error: 'HTTP 500: Server Error' });
		expect(composeBrowserCompatibilityState('print primary = 1', failed)).toMatchObject({
			ok: false, error: expect.stringContaining('HTTP 500'),
		});
	});

	it('rejects an existing empty companion instead of treating it as absent', async () => {
		const companion = await loadBrowserCompanion('https://example.test/sample.kql.json', async () => '');

		expect(companion).toEqual({ status: 'loaded', content: '' });
		expect(composeBrowserCompatibilityState('print primary = 1', companion)).toMatchObject({ ok: false });
	});

	it('preserves direct URL query parameters when deriving and validating a companion', () => {
		const file = new RawUrlProvider().getFileInfo(new URL('https://example.test/work/sample.kql?token=abc'))!;
		const result = composeBrowserCompatibilityState('print primary = 1', { status: 'loaded', content: JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql' },
			] },
		}) }, {
			expectedFilename: file.filename, rawContentUrl: file.rawContentUrl, sidecarUrl: file.sidecarUrl,
		});

		expect(file.sidecarUrl).toBe('https://example.test/work/sample.kql.json?token=abc');
		expect(result.ok).toBe(true);
	});

	it('validates Azure DevOps linkage using the REST path parameter', () => {
		const file = new AzureDevOpsProvider().getFileInfo(new URL(
			'https://dev.azure.com/org/project/_git/repo?path=%2Fdocs%2Fsample.kql&version=GBmain',
		))!;
		const result = composeBrowserCompatibilityState('print primary = 1', { status: 'loaded', content: JSON.stringify({
			kind: 'kqlx', version: 1, state: { sections: [
				{ id: 'query_1', type: 'query', linkedQueryPath: 'sample.kql' },
			] },
		}) }, {
			expectedFilename: file.filename, rawContentUrl: file.rawContentUrl, sidecarUrl: file.sidecarUrl,
		});

		expect(new URL(file.sidecarUrl!).searchParams.get('path')).toBe('/docs/sample.kql.json');
		expect(result.ok).toBe(true);
	});
});