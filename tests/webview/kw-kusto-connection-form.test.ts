import { afterEach, describe, expect, it } from 'vitest';
import { html, nothing, render } from 'lit';
import '../../src/webview/components/kw-kusto-connection-form.js';
import type { KwKustoConnectionForm } from '../../src/webview/components/kw-kusto-connection-form.js';

let container: HTMLDivElement;

afterEach(() => {
	render(nothing, container);
	container?.remove();
});

describe('kw-kusto-connection-form account selection', () => {
	it('marks the explicit account option selected for native rendering', async () => {
		container = document.createElement('div');
		document.body.appendChild(container);
		render(html`
			<kw-kusto-connection-form
				.accountId=${'account-2'}
				.accounts=${[
					{ id: 'account-1', label: 'one@example.com' },
					{ id: 'account-2', label: 'two@example.com' },
				]}
			></kw-kusto-connection-form>
		`, container);
		const form = container.querySelector('kw-kusto-connection-form') as KwKustoConnectionForm;
		await form.updateComplete;

		const select = form.shadowRoot!.querySelector('[data-testid="kusto-conn-account"]') as HTMLSelectElement;
		const selected = select.selectedOptions[0];
		expect(select.value).toBe('account-2');
		expect(selected.textContent).toBe('two@example.com');
		expect(selected.hasAttribute('selected')).toBe(true);
		expect(select.options[0].hasAttribute('selected')).toBe(false);
	});
});