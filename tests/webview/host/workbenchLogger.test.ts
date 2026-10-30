import { beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
	vi.resetModules();
	vi.restoreAllMocks();
});

describe('workbenchLogger', () => {
	it.each(['trace-off', 'channel', 'level', 'burst', 'registration', 'state', 'document', 'tabs', 'sink', 'mark', 'cleanup'])(
		'keeps activation observation bounded, metadata-only and disposable (%s)', async fault => {
			vi.useFakeTimers();
			const vscode = await import('vscode');
			const logger = await import('../../../src/host/workbenchLogger');
			const { createFileOpenTrace, observeFileOpenActivation } = await import('../../../src/host/fileOpenTrace');
			const subscriptions: Array<{ dispose(): void }> = [];
			logger.registerWorkbenchLogger({ subscriptions } as any);
			subscriptions[0].dispose();
			const descriptors = [[vscode, 'LogLevel'], [vscode.env, 'logLevel'], [vscode.workspace, 'onDidCloseTextDocument'],
				[vscode.workspace, 'textDocuments'], [vscode.window.tabGroups, 'all']].map(([owner, key]) => ({
				owner: owner as object, key: key as string, descriptor: Object.getOwnPropertyDescriptor(owner, key as string),
			}));
			Object.defineProperty(vscode, 'LogLevel', { configurable: true, value: { Trace: 1, Info: 3 } });
			Object.defineProperty(vscode.env, 'logLevel', { configurable: true, value: fault === 'trace-off' ? 1 : 3 });
			const failure = new Error('private diagnostic failure /work/secret.kqlx');
			const output = vi.fn(() => { if (fault === 'sink') throw failure; });
			const channel = { logLevel: fault === 'trace-off' ? 3 : 1, trace: output, dispose: vi.fn() };
			if (fault === 'level') Object.defineProperty(channel, 'logLevel', { get: () => { throw failure; } });
			vi.spyOn(vscode.window, 'createOutputChannel').mockImplementation((() => {
				if (fault === 'channel') throw failure;
				return channel;
			}) as any);
			const uri = vscode.Uri.file('/work/private-observer.kqlx');
			const document = { uri, version: 7, isDirty: false, isClosed: false, getText: vi.fn() };
			const tab = { input: new vscode.TabInputCustom(uri, 'kusto.kqlxEditor'), isActive: true };
			(vscode.workspace as any).textDocuments = [document];
			(vscode.window.tabGroups as any).all = [{ tabs: [tab] }];
			if (fault === 'document') Object.defineProperty(document, 'version', { get: () => { throw failure; } });
			if (fault === 'tabs') Object.defineProperty(tab, 'isActive', { get: () => { throw failure; } });
			const callbacks: Array<(event: any) => void> = [], disposals = [vi.fn(), vi.fn(), vi.fn()];
			const open = vi.spyOn(vscode.workspace, 'onDidOpenTextDocument').mockImplementation(listener => {
				callbacks[0] = listener; return { dispose: disposals[0] };
			});
			const close = vi.fn((listener: (event: any) => void) => {
				callbacks[1] = listener;
				if (fault === 'registration') throw failure;
				return { dispose: disposals[1] };
			});
			Object.defineProperty(vscode.workspace, 'onDidCloseTextDocument', { configurable: true, value: close });
			const tabs = vi.spyOn(vscode.window.tabGroups, 'onDidChangeTabs').mockImplementation(listener => {
				callbacks[2] = listener; return { dispose: disposals[2] };
			});
			const state = vi.fn(() => {
				if (fault === 'state') throw failure;
				return { phase: 'openWith' as const, backgroundOwnerMember: true, backgroundOperationMember: true, mutationBlockCount: 1 };
			});
			const opening = createFileOpenTrace('activate');
			if (fault === 'mark') vi.spyOn(opening, 'mark').mockImplementation(() => { throw failure; });
			const observed = () => output.mock.calls.map(([line]: any[]) => /activate\.(observe\.\w+) (.*)$/.exec(line))
				.filter(Boolean).map(match => ({ event: match![1], ...JSON.parse(match![2]) }));
			let observation: ReturnType<typeof observeFileOpenActivation> | undefined;
			try {
				expect(() => { observation = observeFileOpenActivation(opening, uri, state); }).not.toThrow();
				if (['trace-off', 'channel', 'level'].includes(fault)) {
					expect(logger.isWorkbenchTraceEnabled()).toBe(false);
					for (const subscribe of [open, close, tabs]) expect(subscribe).not.toHaveBeenCalled();
					expect(state).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0); expect(observed()).toEqual([]);
					return;
				}
				expect(logger.isWorkbenchTraceEnabled()).toBe(true);
				if (fault === 'registration') {
					expect(disposals[0]).toHaveBeenCalledOnce(); expect(tabs).not.toHaveBeenCalled();
					expect(vi.getTimerCount()).toBe(0);
					expect(observed().map(record => record.event)).toEqual(['observe.start', 'observe.unavailable', 'observe.stop']);
				} else {
					for (const subscribe of [open, close, tabs]) expect(subscribe).toHaveBeenCalledOnce();
					expect(vi.getTimerCount()).toBe(1);
					if (fault === 'burst') {
						for (let index = 0; index < 64; index++) callbacks[0](document);
						expect(observed()).toHaveLength(30); expect(state).toHaveBeenCalledTimes(30);
					}
					if (fault === 'cleanup') {
						vi.spyOn(globalThis, 'clearTimeout').mockImplementationOnce(() => { throw failure; });
						disposals[0].mockImplementation(() => { callbacks[0](document); throw failure; });
					} else {
						await vi.advanceTimersByTimeAsync(4999);
						expect(observed().filter(record => record.event === 'observe.pending')).toEqual([]);
						await vi.advanceTimersByTimeAsync(1);
						if (fault !== 'mark') expect(observed().filter(record => record.event === 'observe.pending')).toHaveLength(1);
					}
				}
				if (fault === 'state') expect(observed()[0].state).toBe('unavailable');
				if (fault === 'document') expect(observed()[0].document.version).toBe('unavailable');
				if (fault === 'tabs') expect(observed()[0].tabs.active).toBe('unavailable');
				expect(() => { observation!.dispose(); observation!.dispose(); }).not.toThrow();
				for (const [index, dispose] of disposals.entries()) expect(dispose).toHaveBeenCalledTimes(fault === 'registration' && index > 0 ? 0 : 1);
				if (fault === 'burst') {
					expect(observed()).toHaveLength(32);
					expect(observed().at(-1)).toMatchObject({ event: 'observe.stop', suppressed: 35 });
				}
				const reads = state.mock.calls.length, lines = output.mock.calls.length;
				const lateRead = vi.fn(() => { throw failure; });
				const late = { get uri() { return lateRead(); }, get opened() { return lateRead(); } };
				for (const callback of callbacks) expect(() => callback(late)).not.toThrow();
				await vi.advanceTimersByTimeAsync(10000);
				expect(lateRead).not.toHaveBeenCalled(); expect(state).toHaveBeenCalledTimes(reads);
				expect(output).toHaveBeenCalledTimes(lines); expect(vi.getTimerCount()).toBe(0);
				expect(document.getText).not.toHaveBeenCalled();
				for (const privateValue of [uri.toString(), uri.fsPath, 'private-observer.kqlx', failure.message]) {
					expect(JSON.stringify(output.mock.calls)).not.toContain(privateValue);
				}
			} finally {
				observation?.dispose(); subscriptions[0].dispose();
				for (const { owner, key, descriptor } of descriptors) {
					if (descriptor) Object.defineProperty(owner, key, descriptor);
					else Reflect.deleteProperty(owner, key);
				}
				vi.useRealTimers();
			}
		},
	);

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
