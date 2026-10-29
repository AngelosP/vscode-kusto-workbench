import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();
});

describe('workbenchLogger', () => {
	it.each(['channel', 'sink', 'detail', 'clock'])('keeps file-opening trace failures observational (%s)', async fault => {
		const vscode = await import('vscode');
		const trace = vi.fn(() => { if (fault === 'sink') throw new Error('Trace sink failed'); });
		const createOutputChannel = vi.spyOn(vscode.window, 'createOutputChannel').mockImplementation((() => {
			if (fault === 'channel') throw new Error('Trace channel unavailable');
			return { trace };
		}) as any);
		const { createFileOpenTrace } = await import('../../../src/host/fileOpenTrace');
		const detail = fault === 'detail' ? {
			toJSON() { throw new Error('Cannot encode detail'); },
			[Symbol.toPrimitive]() { throw new Error('Cannot coerce detail'); },
		} : { uriHash: 'a'.repeat(64) };
		if (fault === 'clock') vi.spyOn(Date, 'now').mockImplementationOnce(() => { throw new Error('Trace clock unavailable'); });
		let opening: ReturnType<typeof createFileOpenTrace> | undefined;
		expect(() => { opening = createFileOpenTrace('activate', detail); }).not.toThrow();
		expect(opening).toMatchObject({ id: expect.any(Number), label: 'activate' });
		expect(() => opening!.mark('openWith.start', detail)).not.toThrow();
		createOutputChannel.mockReturnValue({ trace: vi.fn() } as any);
		expect(() => opening!.mark('openWith.done', { success: true })).not.toThrow();
	});

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
