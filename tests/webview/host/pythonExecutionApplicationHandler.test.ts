import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { HostPythonExecutionApplicationHandler } from '../../../src/host/pythonExecutionApplicationHandler';

const OUTPUT_LIMIT = 200 * 1024;

class FakePythonProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly stdin = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn() });
	readonly kill = vi.fn();
}

const liveHandlers = new Set<HostPythonExecutionApplicationHandler>();

function createHandler(createProcess: ReturnType<typeof vi.fn>, cwd?: string) {
	const postMessage = vi.fn(() => Promise.resolve(true));
	const handler = new HostPythonExecutionApplicationHandler({
		postMessage,
		createProcess: createProcess as never,
		getWorkingDirectory: () => cwd,
	});
	liveHandlers.add(handler);
	return { handler, postMessage };
}

async function flushAsyncExecution(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
}

describe('HostPythonExecutionApplicationHandler', () => {
	afterEach(() => {
		for (const handler of liveHandlers) handler.dispose();
		liveHandlers.clear();
		vi.useRealTimers();
	});

	it('declines unrelated Kusto and SQL messages synchronously', () => {
		const createProcess = vi.fn();
		const { handler, postMessage } = createHandler(createProcess);

		expect(handler.handleMessage({
			type: 'kustoSectionOpen', boxId: 'query-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(handler.handleMessage({
			type: 'sqlSectionClose', boxId: 'sql-1', sectionInstanceId: 'instance-1',
		})).toBeUndefined();
		expect(createProcess).not.toHaveBeenCalled();
		expect(postMessage).not.toHaveBeenCalled();
	});

	it('writes code to python stdin and publishes its exact terminal output', async () => {
		const child = new FakePythonProcess();
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess, 'C:\\workspace');

		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-success', code: 'print("hello")',
		})!;
		child.stdout.emit('data', Buffer.from('hello\n'));
		child.stderr.emit('data', Buffer.from('warning\n'));
		child.emit('close', 3);
		await execution;

		expect(createProcess).toHaveBeenCalledWith('python', ['-'], 'C:\\workspace');
		expect(child.stdin.write).toHaveBeenCalledWith('print("hello")');
		expect(child.stdin.end).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python-success',
			stdout: 'hello\n', stderr: 'warning\n', exitCode: 3,
		});
	});

	it('falls back through python, python3, and py only for missing interpreters', async () => {
		const children = [new FakePythonProcess(), new FakePythonProcess(), new FakePythonProcess()];
		const createProcess = vi.fn()
			.mockReturnValueOnce(children[0])
			.mockReturnValueOnce(children[1])
			.mockReturnValueOnce(children[2]);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-fallback', code: 'print(1)',
		})!;

		children[0].emit('error', { code: 'ENOENT', message: 'spawn python ENOENT' });
		children[0].stdin.emit('error', Object.assign(new Error('late EPIPE'), { code: 'EPIPE' }));
		await flushAsyncExecution();
		children[1].emit('error', Object.assign(new Error('spawn python3 ENOENT'), { code: 'ENOENT' }));
		await flushAsyncExecution();
		children[2].stdout.emit('data', Buffer.from('1\n'));
		children[2].emit('close', 0);
		await execution;

		expect(createProcess.mock.calls).toEqual([
			['python', ['-'], undefined],
			['python3', ['-'], undefined],
			['py', ['-'], undefined],
		]);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python-fallback', stdout: '1\n', stderr: '', exitCode: 0,
		});
	});

	it('keeps close authoritative when stdin reports an expected early-exit error', async () => {
		const child = new FakePythonProcess();
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-epipe', code: 'print(1)',
		})!;

		child.stdin.emit('error', Object.assign(new Error('broken pipe'), { code: 'EPIPE' }));
		expect(postMessage).not.toHaveBeenCalled();
		child.emit('close', 0);
		await execution;

		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python-epipe', stdout: '', stderr: '', exitCode: 0,
		});
	});

	it('fails once and kills the child for an unexpected stdio error', async () => {
		const child = new FakePythonProcess();
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-stdio-error', code: 'print(1)',
		})!;

		child.stdout.emit('error', new Error('stdout failed'));
		child.emit('close', 0);
		child.stderr.emit('error', new Error('late stderr error'));
		await execution;

		expect(child.kill).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonError', boxId: 'python-stdio-error', error: 'stdout failed',
		});
	});

	it('falls back when process creation throws a synchronous ENOENT', async () => {
		const child = new FakePythonProcess();
		const missing = Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' });
		const createProcess = vi.fn()
			.mockImplementationOnce(() => { throw missing; })
			.mockReturnValueOnce(child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-sync-fallback', code: 'print(2)',
		})!;
		await flushAsyncExecution();

		child.stdout.emit('data', Buffer.from('2\n'));
		child.emit('close', 0);
		await execution;

		expect(createProcess.mock.calls).toEqual([
			['python', ['-'], undefined],
			['python3', ['-'], undefined],
		]);
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python-sync-fallback', stdout: '2\n', stderr: '', exitCode: 0,
		});
	});

	it('publishes one final error after all three interpreters are missing', async () => {
		const children = [new FakePythonProcess(), new FakePythonProcess(), new FakePythonProcess()];
		const createProcess = vi.fn()
			.mockReturnValueOnce(children[0])
			.mockReturnValueOnce(children[1])
			.mockReturnValueOnce(children[2]);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-missing', code: 'print(3)',
		})!;

		children[0].emit('error', Object.assign(new Error('python ENOENT'), { code: 'ENOENT' }));
		await flushAsyncExecution();
		children[1].emit('error', Object.assign(new Error('python3 ENOENT'), { code: 'ENOENT' }));
		await flushAsyncExecution();
		children[2].emit('error', Object.assign(new Error('py ENOENT'), { code: 'ENOENT' }));
		await execution;

		expect(createProcess.mock.calls.map(call => call[0])).toEqual(['python', 'python3', 'py']);
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonError', boxId: 'python-missing', error: 'py ENOENT',
		});
	});

	it('stops fallback on a non-missing-interpreter error and publishes one error terminal', async () => {
		const child = new FakePythonProcess();
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-error', code: 'print(1)',
		})!;

		child.emit('error', new Error('permission denied'));
		child.emit('close', 0);
		await execution;

		expect(createProcess).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonError', boxId: 'python-error', error: 'permission denied',
		});
	});

	it('publishes one bounded timeout terminal despite synchronous and late close or error', async () => {
		vi.useFakeTimers();
		const child = new FakePythonProcess();
		child.kill.mockImplementation(() => { throw new Error('process ignored termination'); });
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-timeout', code: 'while True: pass',
		})!;
		child.stdout.emit('data', Buffer.from('partial output'));

		await vi.advanceTimersByTimeAsync(15_000);
		await execution;

		expect(child.kill).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python-timeout',
			stdout: 'partial output', stderr: 'Timed out after 15s.', exitCode: -1,
		});
		child.emit('close', 9);
		child.emit('error', new Error('late error'));
		child.stdin.emit('error', Object.assign(new Error('late EPIPE'), { code: 'EPIPE' }));
		child.stdout.emit('error', Object.assign(new Error('late reset'), { code: 'ECONNRESET' }));
		child.stderr.emit('error', Object.assign(new Error('late destroyed'), { code: 'ERR_STREAM_DESTROYED' }));
		await flushAsyncExecution();
		expect(postMessage).toHaveBeenCalledOnce();
	});

	it('keeps timeout authority when kill synchronously emits close and error', async () => {
		vi.useFakeTimers();
		const child = new FakePythonProcess();
		child.kill.mockImplementation(() => {
			child.emit('close', 0);
			child.emit('error', new Error('synchronous kill error'));
		});
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-timeout-race', code: 'while True: pass',
		})!;

		await vi.advanceTimersByTimeAsync(15_000);
		await execution;

		expect(postMessage).toHaveBeenCalledOnce();
		expect(postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python-timeout-race',
			stdout: '', stderr: 'Timed out after 15s.', exitCode: -1,
		});
	});

	it('caps stdout and stderr independently at 200 KB of UTF-8 output', async () => {
		const child = new FakePythonProcess();
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-capped', code: 'print(1)',
		})!;

		child.stdout.emit('data', Buffer.from('😀'.repeat(OUTPUT_LIMIT)));
		child.stderr.emit('data', Buffer.from('é'.repeat(OUTPUT_LIMIT)));
		child.emit('close', 0);
		await execution;

		const terminal = postMessage.mock.calls[0][0] as { stdout: string; stderr: string };
		expect(Buffer.byteLength(terminal.stdout, 'utf8')).toBe(OUTPUT_LIMIT);
		expect(Buffer.byteLength(terminal.stderr, 'utf8')).toBe(OUTPUT_LIMIT);
		expect(terminal.stdout).not.toContain('�');
		expect(terminal.stderr).not.toContain('�');
	});

	it('does not publish a partial UTF-8 character cut by the byte cap', async () => {
		const child = new FakePythonProcess();
		const createProcess = vi.fn(() => child);
		const { handler, postMessage } = createHandler(createProcess);
		const execution = handler.handleMessage({
			type: 'executePython', boxId: 'python-utf8-boundary', code: 'print(1)',
		})!;

		child.stdout.emit('data', Buffer.concat([
			Buffer.alloc(OUTPUT_LIMIT - 1, 0x61),
			Buffer.from('é', 'utf8'),
		]));
		child.emit('close', 0);
		await execution;

		const terminal = postMessage.mock.calls[0][0] as { stdout: string };
		expect(Buffer.byteLength(terminal.stdout, 'utf8')).toBe(OUTPUT_LIMIT - 1);
		expect(terminal.stdout.endsWith('a')).toBe(true);
		expect(terminal.stdout).not.toContain('�');
	});

	it('disposal kills active children and suppresses their current and late terminals', async () => {
		const children = [new FakePythonProcess(), new FakePythonProcess()];
		const createProcess = vi.fn()
			.mockReturnValueOnce(children[0])
			.mockReturnValueOnce(children[1]);
		const { handler, postMessage } = createHandler(createProcess);
		const executions = [
			handler.handleMessage({ type: 'executePython', boxId: 'python-a', code: 'print("a")' })!,
			handler.handleMessage({ type: 'executePython', boxId: 'python-b', code: 'print("b")' })!,
		];

		handler.dispose();
		children[0].stdin.emit('error', Object.assign(new Error('disposed EPIPE'), { code: 'EPIPE' }));
		children[1].stdin.emit('error', Object.assign(new Error('disposed stream'), { code: 'ERR_STREAM_DESTROYED' }));
		children[0].emit('close', 0);
		children[1].emit('error', new Error('late error'));
		await Promise.all(executions);
		await handler.handleMessage({ type: 'executePython', boxId: 'python-c', code: 'print("c")' });

		expect(children[0].kill).toHaveBeenCalledOnce();
		expect(children[1].kill).toHaveBeenCalledOnce();
		expect(createProcess).toHaveBeenCalledTimes(2);
		expect(postMessage).not.toHaveBeenCalled();
	});
});