import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();
});

describe('workbenchLogger', () => {
	it('creates one lazy LogOutputChannel and recreates it after disposal', async () => {
		const vscode = await import('vscode');
		const createdChannels: any[] = [];
		const createOutputChannel = vi.spyOn(vscode.window, 'createOutputChannel').mockImplementation(((name: string, options?: unknown) => {
			const channel = {
				name,
				options,
				trace: vi.fn(),
				debug: vi.fn(),
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				show: vi.fn(),
				dispose: vi.fn(),
			};
			createdChannels.push(channel);
			return channel;
		}) as any);

		const { getWorkbenchLogger, registerWorkbenchLogger, WORKBENCH_LOG_CHANNEL_NAME } = await import('../../../src/host/workbenchLogger');
		const subscriptions: Array<{ dispose(): void }> = [];

		registerWorkbenchLogger({ subscriptions } as any);
		expect(createOutputChannel).not.toHaveBeenCalled();

		const first = getWorkbenchLogger();
		const second = getWorkbenchLogger();
		first.info('hello');
		second.error('failure');

		expect(createOutputChannel).toHaveBeenCalledTimes(1);
		expect(createOutputChannel).toHaveBeenCalledWith(WORKBENCH_LOG_CHANNEL_NAME, { log: true });
		expect(createdChannels[0].info).toHaveBeenCalledWith('hello');
		expect(createdChannels[0].error).toHaveBeenCalledWith('failure');

		subscriptions[0].dispose();
		expect(createdChannels[0].dispose).toHaveBeenCalledTimes(1);

		getWorkbenchLogger().warn('again');
		expect(createOutputChannel).toHaveBeenCalledTimes(2);
		expect(createdChannels[1].warn).toHaveBeenCalledWith('again');
	});
});
