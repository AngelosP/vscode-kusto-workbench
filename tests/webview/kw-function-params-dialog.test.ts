import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/webview/components/kw-function-params-dialog.js';
import type { KwFunctionParamsDialog } from '../../src/webview/components/kw-function-params-dialog.js';

describe('kw-function-params-dialog', () => {
	let dialog: KwFunctionParamsDialog;

	beforeEach(async () => {
		dialog = document.createElement('kw-function-params-dialog');
		document.body.appendChild(dialog);
		dialog.show('GetValue', [{ name: 'value', type: 'string' }]);
		await dialog.updateComplete;
	});

	afterEach(() => {
		dialog.remove();
	});

	it('dismisses only when the mouse press starts on the backdrop', () => {
		const onCancel = vi.fn();
		dialog.addEventListener('function-cancel', onCancel);

		const content = dialog.shadowRoot!.querySelector('.sd') as HTMLElement;
		const backdrop = dialog.shadowRoot!.querySelector('.sd-bg') as HTMLElement;

		content.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		backdrop.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, composed: true }));
		backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true, composed: true }));
		expect(onCancel).not.toHaveBeenCalled();

		backdrop.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, composed: true }));
		expect(onCancel).toHaveBeenCalledOnce();
	});
});