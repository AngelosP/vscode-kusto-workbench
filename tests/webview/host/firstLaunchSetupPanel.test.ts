import { describe, expect, it, vi } from 'vitest';
import { FirstLaunchSetupPanel } from '../../../src/host/firstLaunch/firstLaunchSetupPanel.js';

describe('FirstLaunchSetupPanel transaction retries', () => {
	it('moves from bootstrap readiness to component readiness without releasing the panel early', async () => {
		const panel = Object.create(FirstLaunchSetupPanel.prototype) as any;
		panel.request = {
			mode: 'automatic',
			snapshot: {
				mode: 'automatic',
				filePreferences: { openKqlFiles: true, openCslFiles: true, openMdFiles: false, openSqlFiles: false },
				editingPreferences: { caretDocsEnabled: true, autoTriggerAutocompleteEnabled: true, copilotInlineCompletionsEnabled: true },
				inlineSuggestEnabled: true,
			},
		};
		panel.terminal = false;
		panel.disposed = false;
		panel.operationInFlight = false;
		panel.armReadyTimer = vi.fn();
		panel.clearReadyTimer = vi.fn();
		panel.post = vi.fn(async () => true);
		panel.settle = vi.fn();

		await panel.handleMessage({ type: 'bootstrapReady' });
		expect(panel.armReadyTimer).toHaveBeenCalledWith(10_000);
		expect(panel.post).not.toHaveBeenCalled();
		expect(panel.settle).not.toHaveBeenCalled();

		await panel.handleMessage({ type: 'ready' });
		expect(panel.clearReadyTimer).toHaveBeenCalledOnce();
		expect(panel.post).toHaveBeenCalledWith({ type: 'snapshot', snapshot: panel.request.snapshot });
		expect(panel.settle).not.toHaveBeenCalled();
	});

	it('settles and disposes immediately when webview HTML initialization fails', () => {
		const panel = Object.create(FirstLaunchSetupPanel.prototype) as any;
		const dispose = vi.fn();
		const webview = {};
		Object.defineProperty(webview, 'html', { set: () => { throw new Error('template unavailable'); } });
		panel.panel = { webview, dispose };
		panel.buildHtml = vi.fn(() => '<html></html>');
		panel.resolveResult = vi.fn();
		panel.terminal = false;
		panel.disposed = false;
		panel.readyTimer = setTimeout(() => undefined, 10_000);

		panel.initializeWebview();

		expect(panel.terminal).toBe(true);
		expect(panel.resolveResult).toHaveBeenCalledWith('operational-failure');
		expect(panel.readyTimer).toBeUndefined();
		expect(dispose).toHaveBeenCalledOnce();
	});

	it('retries the original failed Skip when the retry button sends Save', async () => {
		const panel = Object.create(FirstLaunchSetupPanel.prototype) as any;
		let attempts = 0;
		const onSkip = vi.fn(async () => {
			attempts++;
			if (attempts === 1) throw new Error('settings are temporarily read-only');
		});
		const onSave = vi.fn(async () => undefined);
		panel.request = { mode: 'automatic', onSkip, onSave };
		panel.terminal = false;
		panel.disposed = false;
		panel.operationInFlight = false;
		panel.transactionStarted = false;
		panel.retryOperation = undefined;
		panel.post = vi.fn(async () => true);
		panel.settle = vi.fn();

		await panel.handleMessage({ type: 'skip' });
		expect(onSkip).toHaveBeenCalledOnce();
		expect(panel.retryOperation).toBeTypeOf('function');
		expect(panel.post).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', retryOnly: true }));

		await panel.handleMessage({
			type: 'save',
			filePreferences: { openKqlFiles: false, openCslFiles: false, openMdFiles: true, openSqlFiles: true },
			editingPreferences: { caretDocsEnabled: false, autoTriggerAutocompleteEnabled: false, copilotInlineCompletionsEnabled: false },
		});

		expect(onSkip).toHaveBeenCalledTimes(2);
		expect(onSave).not.toHaveBeenCalled();
		expect(panel.settle).toHaveBeenCalledWith('skipped');
	});

	it('rehydrates the original failed Save payload as retry-only after webview reload', async () => {
		const panel = Object.create(FirstLaunchSetupPanel.prototype) as any;
		const originalFilePreferences = { openKqlFiles: true, openCslFiles: false, openMdFiles: true, openSqlFiles: false };
		const originalEditingPreferences = { caretDocsEnabled: false, autoTriggerAutocompleteEnabled: false, copilotInlineCompletionsEnabled: true };
		const onSave = vi.fn(async () => { throw new Error('read-only settings'); });
		panel.request = {
			mode: 'automatic',
			snapshot: {
				mode: 'automatic',
				filePreferences: { openKqlFiles: true, openCslFiles: true, openMdFiles: false, openSqlFiles: false },
				editingPreferences: { caretDocsEnabled: true, autoTriggerAutocompleteEnabled: true, copilotInlineCompletionsEnabled: true },
				inlineSuggestEnabled: true,
			},
			onSave,
		};
		panel.terminal = false;
		panel.disposed = false;
		panel.operationInFlight = false;
		panel.transactionStarted = false;
		panel.retryOperation = undefined;
		panel.pendingOperation = undefined;
		panel.post = vi.fn(async () => true);
		panel.settle = vi.fn();
		panel.clearReadyTimer = vi.fn();

		await panel.handleMessage({
			type: 'save',
			filePreferences: originalFilePreferences,
			editingPreferences: originalEditingPreferences,
		});
		panel.post.mockClear();
		await panel.handleMessage({ type: 'requestSnapshot' });

		expect(panel.post).toHaveBeenCalledWith({
			type: 'snapshot',
			snapshot: expect.objectContaining({
				filePreferences: originalFilePreferences,
				editingPreferences: originalEditingPreferences,
				pendingOperation: 'save',
				retryOnly: true,
			}),
		});
	});
});