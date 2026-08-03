import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { QueryEditorProvider } from '../../../src/host/queryEditorProvider';

class FakePythonProcess extends EventEmitter {
	readonly stdout = new EventEmitter();
	readonly stderr = new EventEmitter();
	readonly stdin = { write: vi.fn(), end: vi.fn() };
	readonly kill = vi.fn();
}

describe('QueryEditorProvider Python execution', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('publishes one timeout terminal without waiting for process close', async () => {
		const child = new FakePythonProcess();
		child.kill.mockImplementation(() => { throw new Error('process ignored termination'); });
		const provider = Object.create(QueryEditorProvider.prototype) as QueryEditorProvider & Record<string, any>;
		provider.postMessage = vi.fn(() => true);
		provider.createPythonProcess = vi.fn(() => child);

		const execution = provider.executePythonFromWebview({
			type: 'executePython', boxId: 'python_timeout', code: 'while True: pass',
		});
		child.stdout.emit('data', Buffer.from('partial output'));
		await vi.advanceTimersByTimeAsync(15_000);
		await execution;

		expect(provider.createPythonProcess).toHaveBeenCalledOnce();
		expect(child.kill).toHaveBeenCalledOnce();
		expect(provider.postMessage).toHaveBeenCalledTimes(1);
		expect(provider.postMessage).toHaveBeenCalledWith({
			type: 'pythonResult', boxId: 'python_timeout',
			stdout: 'partial output', stderr: 'Timed out after 15s.', exitCode: -1,
		});

		child.emit('close', 0);
		child.emit('error', new Error('late error'));
		await Promise.resolve();
		expect(provider.postMessage).toHaveBeenCalledTimes(1);
	});
});