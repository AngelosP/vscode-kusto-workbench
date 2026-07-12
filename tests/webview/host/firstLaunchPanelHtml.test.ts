import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

describe('first-launch setup panel template', () => {
	it('uses a local nonce-protected bundle and codicon font', () => {
		const root = process.cwd();
		const template = readFileSync(join(root, 'src', 'webview', 'first-launch-setup.html'), 'utf8');
		const host = readFileSync(join(root, 'src', 'host', 'firstLaunch', 'firstLaunchSetupPanel.ts'), 'utf8');
		const entry = readFileSync(join(root, 'src', 'webview', 'first-launch', 'first-launch-entry.ts'), 'utf8');

		expect(template).toContain('content="{{csp}}"');
		expect(template).toContain('nonce="{{nonce}}"');
		expect(template).toContain('{{firstLaunchSetupBundleUri}}');
		expect(template).toContain('{{codiconFontUri}}');
		expect(template).toContain('logo-uri="{{kustoWorkbenchLogoUri}}"');
		expect(template).toContain('id="first-launch-scroll"');
		expect(template).toContain('margin: 0; padding: 0;');
		expect(template).toContain('kw-first-launch-setup { display: block; width: 100%; min-height: 100vh; }');
		expect(template).not.toMatch(/https?:\/\//);
		expect(host).toContain("default-src 'none'");
		expect(host).toContain('img-src ${webview.cspSource}');
		expect(host).toContain("script-src 'nonce-${nonce}'");
		expect(host).toContain("'media', 'images', 'kusto-workbench-logo.png'");
		expect(host).toContain('.replace(/{{kustoWorkbenchLogoUri}}/g, String(logoUri))');
		expect(host).toContain('READY_TIMEOUT_MS');
		expect(entry).toContain("import { OverlayScrollbars } from 'overlayscrollbars'");
		expect(entry).toContain('osLibrarySheet');
		expect(entry).toContain('osThemeSheet');
		expect(entry).toContain("autoHide: 'move'");
		expect(entry).toContain("setup?.addEventListener('first-launch-layout-change', refreshScrollbars)");
		expect(entry).toContain('new ResizeObserver(refreshScrollbars).observe(setup)');
		expect(entry).toContain('scrollbars.update(true)');
	});
});