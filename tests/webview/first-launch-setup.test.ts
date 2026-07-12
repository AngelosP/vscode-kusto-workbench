import { beforeEach, describe, expect, it, vi } from 'vitest';
import '../../src/webview/first-launch/kw-first-launch-setup.js';
import type { KwFirstLaunchSetup } from '../../src/webview/first-launch/kw-first-launch-setup.js';

const postMessage = vi.fn();
(globalThis as any).acquireVsCodeApi = () => ({ postMessage });

function snapshot(mode: 'automatic' | 'configure' = 'automatic') {
	return {
		mode,
		filePreferences: { openKqlFiles: true, openCslFiles: true, openMdFiles: false, openSqlFiles: false },
		editingPreferences: { caretDocsEnabled: true, autoTriggerAutocompleteEnabled: true, copilotInlineCompletionsEnabled: true },
		inlineSuggestEnabled: false,
	};
}

async function create(mode: 'automatic' | 'configure' = 'automatic'): Promise<KwFirstLaunchSetup> {
	const element = document.createElement('kw-first-launch-setup') as KwFirstLaunchSetup;
	element.setAttribute('logo-uri', 'vscode-webview://kusto-workbench-logo.png');
	document.body.append(element);
	window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot(mode) } }));
	await element.updateComplete;
	return element;
}

describe('kw-first-launch-setup', () => {
	beforeEach(() => {
		document.body.innerHTML = '';
		postMessage.mockClear();
	});

	it('requests a snapshot and renders semantic file and editing choices with the toolbar icons', async () => {
		const element = await create();
		const root = element.shadowRoot!;

		expect(postMessage).toHaveBeenCalledWith({ type: 'ready' });
		expect(postMessage).toHaveBeenCalledWith({ type: 'requestSnapshot' });
		expect(root.querySelectorAll('fieldset')).toHaveLength(2);
		expect(root.querySelectorAll('input[type=checkbox]')).toHaveLength(7);
		expect(root.querySelectorAll('.option-icon')).toHaveLength(7);
		expect(root.querySelectorAll('.option-icon svg')).toHaveLength(6);
		expect(root.querySelectorAll('.option-icon .codicon')).toHaveLength(1);
		expect((root.querySelector('.brand-mark img') as HTMLImageElement).src).toContain('kusto-workbench-logo.png');
		expect(root.textContent).toContain('.kqlx');
		expect(root.textContent).toContain('Kusto Workbench extension settings');
		expect(root.textContent).toContain('manual shortcuts always remain enabled');
		expect(root.textContent).toContain('same icon in each Kusto section toolbar');
		expect(root.textContent).toContain('without pressing the shortcut');
		expect(root.textContent).toContain('There is no shortcut to remember');
		expect(root.textContent).toContain('Ctrl+Shift+Space');
		expect(root.textContent).toContain('Smart documentation (Kusto)');
		expect(root.textContent).toContain('inline suggestions are currently disabled');
	});

	it('announces its post-render layout change so the page scrollbar can remeasure immediately', async () => {
		const element = document.createElement('kw-first-launch-setup') as KwFirstLaunchSetup;
		const layoutChanged = vi.fn();
		element.addEventListener('first-launch-layout-change', layoutChanged);
		document.body.append(element);
		window.dispatchEvent(new MessageEvent('message', { data: { type: 'snapshot', snapshot: snapshot() } }));
		await element.updateComplete;

		expect(layoutChanged).toHaveBeenCalled();
	});

	it('posts edited choices on Save and uses Skip only in automatic mode', async () => {
		const element = await create();
		const root = element.shadowRoot!;
		const sql = root.querySelector('#file-openSqlFiles') as HTMLInputElement;
		sql.checked = true;
		sql.dispatchEvent(new Event('change', { bubbles: true }));
		(root.querySelector('[data-testid=first-launch-save]') as HTMLButtonElement).click();

		expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({
			type: 'save',
			filePreferences: expect.objectContaining({ openSqlFiles: true }),
		}));
		(root.querySelector('[data-testid=first-launch-secondary]') as HTMLButtonElement).click();
		expect(postMessage).toHaveBeenCalledWith({ type: 'skip' });
	});

	it('uses Cancel in configure mode and disables leaving after a retry-only error', async () => {
		const element = await create('configure');
		const root = element.shadowRoot!;
		const secondary = root.querySelector('[data-testid=first-launch-secondary]') as HTMLButtonElement;
		expect(secondary.textContent).toContain('Cancel');
		secondary.click();
		expect(postMessage).toHaveBeenCalledWith({ type: 'cancel' });

		window.dispatchEvent(new MessageEvent('message', { data: { type: 'error', message: 'Retry it', retryOnly: true } }));
		await element.updateComplete;
		expect((root.querySelector('[role=alert]') as HTMLElement).textContent).toContain('Retry it');
		expect((root.querySelector('[data-testid=first-launch-secondary]') as HTMLButtonElement).disabled).toBe(true);
		expect((root.querySelector('[data-testid=first-launch-save]') as HTMLButtonElement).textContent).toContain('Retry setup');
	});

	it('rehydrates retry-only Save choices with every option locked', async () => {
		const element = await create();
		window.dispatchEvent(new MessageEvent('message', { data: {
			type: 'snapshot',
			snapshot: {
				...snapshot(),
				filePreferences: { openKqlFiles: false, openCslFiles: false, openMdFiles: true, openSqlFiles: true },
				editingPreferences: { caretDocsEnabled: false, autoTriggerAutocompleteEnabled: false, copilotInlineCompletionsEnabled: true },
				pendingOperation: 'save',
				retryOnly: true,
			},
		} }));
		await element.updateComplete;
		const root = element.shadowRoot!;

		expect(Array.from(root.querySelectorAll<HTMLInputElement>('input[type=checkbox]')).every(input => input.disabled)).toBe(true);
		expect((root.querySelector('#file-openSqlFiles') as HTMLInputElement).checked).toBe(true);
		expect((root.querySelector('#editing-autoTriggerAutocompleteEnabled') as HTMLInputElement).checked).toBe(false);
		expect(root.querySelector('[role=alert]')?.textContent).toContain('Retry the pending Save operation');
	});
});