import { describe, expect, it, vi } from 'vitest';
import { retireBrowserViewerElement } from '../../browser-ext/src/browser-viewer-cleanup';

describe('retireBrowserViewerElement', () => {
	it('retires both connected and host-detached viewer elements', () => {
		const connected = document.createElement('iframe');
		document.body.appendChild(connected);
		const detached = document.createElement('iframe');
		const beforeRemove = vi.fn((iframe: HTMLIFrameElement) => { iframe.onload = null; });

		expect(retireBrowserViewerElement(connected, beforeRemove)).toBeNull();
		expect(connected.isConnected).toBe(false);
		expect(retireBrowserViewerElement(detached, beforeRemove)).toBeNull();
		expect(beforeRemove).toHaveBeenCalledTimes(2);
	});
});