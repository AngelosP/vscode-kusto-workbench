import { beforeEach, describe, expect, it, vi } from 'vitest';

async function importLazyVendor() {
	return import('../../src/webview/shared/lazy-vendor.js');
}

let appendedNodes: Element[] = [];

describe('lazy vendor loading', () => {
	beforeEach(() => {
		vi.resetModules();
		vi.restoreAllMocks();
		document.head.innerHTML = '';
		appendedNodes = [];
		vi.spyOn(document.head, 'appendChild').mockImplementation((node: Node) => {
			appendedNodes.push(node as Element);
			return node;
		});
		delete (window as any).echarts;
		delete (window as any).toastui;
		(window as any).__kustoQueryEditorConfig = {
			echartsUrl: 'https://example.test/echarts.webview.js',
			toastUiEditorUrl: 'https://example.test/toastui.webview.js',
			toastUiCssUrls: [
				'https://example.test/toastui-a.css',
				'https://example.test/toastui-b.css',
			],
		};
	});

	it('ensureEchartsLoaded is idempotent and injects one script', async () => {
		const { ensureEchartsLoaded } = await importLazyVendor();

		const p1 = ensureEchartsLoaded();
		const p2 = ensureEchartsLoaded();
		expect(p1).toBe(p2);

		const scripts = appendedNodes.filter((n) => n.tagName === 'SCRIPT') as HTMLScriptElement[];
		expect(scripts).toHaveLength(1);
		expect(scripts[0].src).toContain('echarts.webview.js');

		(window as any).echarts = { init: vi.fn() };
		scripts[0].onload?.(new Event('load'));
		await expect(p1).resolves.toBeUndefined();

		await expect(ensureEchartsLoaded()).resolves.toBeUndefined();
		expect(appendedNodes.filter((n) => n.tagName === 'SCRIPT')).toHaveLength(1);
	});

	it('ensureEchartsLoaded resets promise on load error and allows retry', async () => {
		const { ensureEchartsLoaded } = await importLazyVendor();

		const p1 = ensureEchartsLoaded();
		const first = appendedNodes.find((n) => n.tagName === 'SCRIPT') as HTMLScriptElement;
		first.onerror?.(new Event('error'));
		await expect(p1).rejects.toThrow('Failed to load ECharts');

		const p2 = ensureEchartsLoaded();
		const scripts = appendedNodes.filter((n) => n.tagName === 'SCRIPT') as HTMLScriptElement[];
		expect(scripts).toHaveLength(2);

		(window as any).echarts = { init: vi.fn() };
		scripts[1].onload?.(new Event('load'));
		await expect(p2).resolves.toBeUndefined();
	});

	it('ensureToastUiLoaded is idempotent, injects css/script, and restores globals', async () => {
		const savedDefine = { amd: { enabled: true } };
		(window as any).define = savedDefine;
		(window as any).module = { x: 1 };
		(window as any).exports = { y: 2 };

		const { ensureToastUiLoaded } = await importLazyVendor();
		const p1 = ensureToastUiLoaded();
		const p2 = ensureToastUiLoaded();
		expect(p1).toBe(p2);

		const links = appendedNodes.filter((n) => n.tagName === 'LINK') as HTMLLinkElement[];
		expect(links).toHaveLength(2);
		expect(links[0].href).toContain('toastui-a.css');
		expect(links[1].href).toContain('toastui-b.css');

		const scripts = appendedNodes.filter((n) => n.tagName === 'SCRIPT') as HTMLScriptElement[];
		expect(scripts).toHaveLength(1);
		expect(scripts[0].src).toContain('toastui.webview.js');

		(window as any).toastui = { Editor: function Editor() {} };
		scripts[0].onload?.(new Event('load'));
		await expect(p1).resolves.toBeUndefined();

		expect((window as any).define.amd).toBe(savedDefine.amd);
		expect((window as any).module).toEqual({ x: 1 });
		expect((window as any).exports).toEqual({ y: 2 });
	});

	it('ensureToastUiLoaded restores globals on error and allows retry', async () => {
		const savedDefine = { amd: { enabled: true } };
		(window as any).define = savedDefine;
		(window as any).module = { m: 1 };
		(window as any).exports = { e: 1 };

		const { ensureToastUiLoaded } = await importLazyVendor();
		const p1 = ensureToastUiLoaded();

		const first = appendedNodes.find((n) => n.tagName === 'SCRIPT') as HTMLScriptElement;
		first.onerror?.(new Event('error'));
		await expect(p1).rejects.toThrow('Failed to load TOAST UI Editor');

		expect((window as any).define.amd).toBe(savedDefine.amd);
		expect((window as any).module).toEqual({ m: 1 });
		expect((window as any).exports).toEqual({ e: 1 });

		const p2 = ensureToastUiLoaded();
		const scripts = appendedNodes.filter((n) => n.tagName === 'SCRIPT') as HTMLScriptElement[];
		expect(scripts).toHaveLength(2);

		(window as any).toastui = { Editor: function Editor() {} };
		scripts[1].onload?.(new Event('load'));
		await expect(p2).resolves.toBeUndefined();
	});
});
