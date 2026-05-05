import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hideEmbeddedTutorialViewer, showEmbeddedTutorialViewer } from '../../src/webview/tutorials/embedded-tutorial-overlay.js';

const HOST_ID = 'kw-embedded-tutorial-viewer-host';
const STYLE_ID = 'kw-embedded-tutorial-viewer-style';

beforeEach(() => {
	if (!customElements.get('kw-tutorial-viewer')) {
		customElements.define('kw-tutorial-viewer', class extends HTMLElement {});
	}
	(window as unknown as { vscode?: { postMessage(message: unknown): void } }).vscode = { postMessage: vi.fn() };
	hideEmbeddedTutorialViewer();
	document.getElementById(STYLE_ID)?.remove();
});

afterEach(() => {
	hideEmbeddedTutorialViewer();
	document.getElementById(STYLE_ID)?.remove();
	delete (window as unknown as { vscode?: unknown }).vscode;
});

describe('embedded tutorial overlay', () => {
	it('mounts the tutorial viewer inside the current webview and hides it', async () => {
		await showEmbeddedTutorialViewer();

		const host = document.getElementById(HOST_ID);
		expect(host).toBeTruthy();
		expect(host?.querySelector('kw-tutorial-viewer')?.hasAttribute('embedded')).toBe(true);
		expect(document.getElementById(STYLE_ID)?.textContent).toContain('position: fixed');
		expect(document.getElementById(STYLE_ID)?.textContent).toContain('pointer-events: none');

		hideEmbeddedTutorialViewer();

		expect(document.getElementById(HOST_ID)).toBeNull();
	});

	it('responds to host show and hide messages', async () => {
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'showEmbeddedTutorialViewer' } }));
		await Promise.resolve();
		await Promise.resolve();

		expect(document.getElementById(HOST_ID)).toBeTruthy();

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'hideEmbeddedTutorialViewer' } }));

		expect(document.getElementById(HOST_ID)).toBeNull();
	});
});
