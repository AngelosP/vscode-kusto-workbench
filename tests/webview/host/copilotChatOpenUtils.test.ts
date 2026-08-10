import { afterEach, describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import { openKustoWorkbenchAgentChat } from '../../../src/host/copilotChatOpenUtils';

describe('openKustoWorkbenchAgentChat', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('opens Kusto Workbench mode, waits exactly 150 ms, and reapplies the mode', async () => {
		vi.useFakeTimers();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

		const request = openKustoWorkbenchAgentChat();
		await Promise.resolve();

		expect(executeCommand.mock.calls).toEqual([
			['workbench.action.chat.open', { mode: 'Kusto Workbench' }],
		]);
		await vi.advanceTimersByTimeAsync(149);
		expect(executeCommand).toHaveBeenCalledOnce();

		await vi.advanceTimersByTimeAsync(1);
		await expect(request).resolves.toBe(true);
		expect(executeCommand.mock.calls).toEqual([
			['workbench.action.chat.open', { mode: 'Kusto Workbench' }],
			['workbench.action.chat.open', { mode: 'Kusto Workbench' }],
		]);
	});

	it('trims and reapplies a query with the existing submit behavior', async () => {
		vi.useFakeTimers();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand').mockResolvedValue(undefined);

		const request = openKustoWorkbenchAgentChat({ query: '  print value = 1  ', submit: false });
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(150);

		await expect(request).resolves.toBe(true);
		expect(executeCommand.mock.calls).toEqual([
			['workbench.action.chat.openInEditor'],
			['workbench.action.chat.open', { mode: 'Kusto Workbench' }],
			['workbench.action.chat.open', {
				mode: 'Kusto Workbench',
				query: 'print value = 1',
				isPartialQuery: true,
			}],
		]);
	});

	it('returns false without reapplying when the first open fails', async () => {
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand')
			.mockRejectedValueOnce(new Error('first open failed'));

		await expect(openKustoWorkbenchAgentChat()).resolves.toBe(false);
		expect(executeCommand).toHaveBeenCalledOnce();
	});

	it.each([
		{ options: undefined, expected: true },
		{ options: { query: 'print value = 1', submit: true }, expected: false },
	])('preserves the second-open fallback for $options', async ({ options, expected }) => {
		vi.useFakeTimers();
		const executeCommand = vi.spyOn(vscode.commands, 'executeCommand');
		if (options?.query) {
			executeCommand
				.mockResolvedValueOnce(undefined)
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('reapply failed'));
		} else {
			executeCommand
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error('reapply failed'));
		}

		const request = openKustoWorkbenchAgentChat(options);
		await Promise.resolve();
		await vi.advanceTimersByTimeAsync(150);

		await expect(request).resolves.toBe(expected);
		expect(executeCommand).toHaveBeenCalledTimes(options?.query ? 3 : 2);
	});
});