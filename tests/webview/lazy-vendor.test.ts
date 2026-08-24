import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type WindowWithVendorGlobals = Window & typeof globalThis & {
	__kustoQueryEditorConfig?: { markedUrl?: string; purifyUrl?: string };
	define?: { amd?: unknown };
	module?: unknown;
	exports?: unknown;
	marked?: { parse(markdown: string): string };
	DOMPurify?: { sanitize(value: string): string };
};

const vendorWindow = window as WindowWithVendorGlobals;

beforeEach(() => {
	vi.resetModules();
	vendorWindow.__kustoQueryEditorConfig = {
		markedUrl: 'https://file+.vscode-resource.vscode-cdn.net/marked.js',
		purifyUrl: 'https://file+.vscode-resource.vscode-cdn.net/purify.js',
	};
});

afterEach(() => {
	vi.restoreAllMocks();
	delete vendorWindow.__kustoQueryEditorConfig;
	delete vendorWindow.define;
	delete vendorWindow.module;
	delete vendorWindow.exports;
	delete vendorWindow.marked;
	delete vendorWindow.DOMPurify;
});

describe('lazy Markdown vendor loading', () => {
	it('serializes AMD-suppressed scripts and restores the original globals', async () => {
		const amd = { original: true };
		const moduleValue = { module: true };
		const exportsValue = { exports: true };
		vendorWindow.define = { amd };
		vendorWindow.module = moduleValue;
		vendorWindow.exports = exportsValue;
		const scripts: HTMLScriptElement[] = [];
		vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
			if (node instanceof HTMLScriptElement) scripts.push(node);
			return node;
		});
		const { ensureDomPurifyLoaded, ensureMarkedLoaded } = await import('../../src/webview/shared/lazy-vendor.js');

		const markedLoad = ensureMarkedLoaded();
		const purifyLoad = ensureDomPurifyLoaded();
		await vi.waitFor(() => expect(scripts).toHaveLength(1));
		expect(vendorWindow.define.amd).toBeUndefined();
		expect(vendorWindow.module).toBeUndefined();
		expect(vendorWindow.exports).toBeUndefined();

		vendorWindow.marked = { parse: markdown => markdown };
		scripts[0].onload?.(new Event('load'));
		await markedLoad;
		await vi.waitFor(() => expect(scripts).toHaveLength(2));
		expect(vendorWindow.define.amd).toBeUndefined();

		vendorWindow.DOMPurify = { sanitize: value => value };
		scripts[1].onload?.(new Event('load'));
		await purifyLoad;

		expect(vendorWindow.define.amd).toBe(amd);
		expect(vendorWindow.module).toBe(moduleValue);
		expect(vendorWindow.exports).toBe(exportsValue);
	});

	it('rejects a loaded script that did not register its expected global', async () => {
		vendorWindow.define = { amd: { original: true } };
		let script: HTMLScriptElement | undefined;
		vi.spyOn(document.head, 'appendChild').mockImplementation(node => {
			if (node instanceof HTMLScriptElement) script = node;
			return node;
		});
		const { ensureMarkedLoaded } = await import('../../src/webview/shared/lazy-vendor.js');

		const loading = ensureMarkedLoaded();
		await vi.waitFor(() => expect(script).toBeDefined());
		script!.onload?.(new Event('load'));

		await expect(loading).rejects.toThrow('expected global was not registered');
		expect(vendorWindow.define.amd).toEqual({ original: true });
	});
});