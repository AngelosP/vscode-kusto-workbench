import { describe, expect, it, vi } from 'vitest';
import { postMessageToHost } from '../../src/webview/shared/webview-messages.js';

describe('postMessageToHost', () => {
	it('calls vscode.postMessage when available', () => {
		const postMessage = vi.fn();
		(window as any).vscode = { postMessage };

		postMessageToHost({ type: 'getConnections' });

		expect(postMessage).toHaveBeenCalledTimes(1);
		expect(postMessage).toHaveBeenCalledWith({ type: 'getConnections' });
	});

	it('does not throw when vscode is undefined', () => {
		delete (window as any).vscode;
		expect(() => postMessageToHost({ type: 'getConnections' })).not.toThrow();
	});
});
