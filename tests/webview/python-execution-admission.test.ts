import { beforeEach, describe, expect, it } from 'vitest';

import {
	consumePythonExecutionTerminal,
	isPythonExecutionPending,
	reservePythonExecution,
	resetPythonExecutionAdmissionForTest,
} from '../../src/webview/core/python-execution-admission.js';

describe('Python execution admission', () => {
	beforeEach(() => resetPythonExecutionAdmissionForTest());

	it('keeps one exact box-only reservation until its canonical terminal is consumed', () => {
		const owner = {};
		expect(reservePythonExecution(' python-section ', owner, 'print(1)')).toBe(true);
		expect(reservePythonExecution('python-section', {}, 'print(2)')).toBe(false);
		expect(consumePythonExecutionTerminal(' python-section ')).toBeUndefined();
		expect(isPythonExecutionPending('python-section')).toBe(true);

		expect(consumePythonExecutionTerminal('python-section')).toEqual({
			boxId: 'python-section', owner, code: 'print(1)', retired: false,
		});
		expect(isPythonExecutionPending('python-section')).toBe(false);
	});
});