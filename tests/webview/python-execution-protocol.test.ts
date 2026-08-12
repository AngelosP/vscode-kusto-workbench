import { describe, expect, it } from 'vitest';

import {
	admitPythonExecutionHostMessage,
	admitPythonExecutionWebviewMessage,
	isPythonExecutionHostMessageType,
	isPythonExecutionWebviewMessageType,
	parsePythonExecutionHostMessage,
	parsePythonExecutionWebviewMessage,
	PYTHON_OUTPUT_MAX_BYTES,
} from '../../src/shared/pythonExecutionProtocol.js';

function inheritField(message: Record<string, unknown>, key: string): Record<string, unknown> {
	const ownFields = { ...message };
	const value = ownFields[key];
	delete ownFields[key];
	return Object.assign(Object.create({ [key]: value }), ownFields);
}

describe('Python execution protocol', () => {
	it('snapshots requests and terminals without normalizing exact values', () => {
		const request = { type: 'executePython', boxId: ' python-section ', code: '' } as const;
		const result = {
			type: 'pythonResult', boxId: 'python-section', stdout: '', stderr: '', exitCode: null,
		} as const;
		const error = { type: 'pythonError', boxId: 'python-section', error: '' } as const;

		const parsedRequest = parsePythonExecutionWebviewMessage(request);
		const parsedResult = parsePythonExecutionHostMessage(result);
		const parsedError = parsePythonExecutionHostMessage(error);
		expect(parsedRequest).toEqual({ ok: true, value: request });
		expect(parsedResult).toEqual({ ok: true, value: result });
		expect(parsedError).toEqual({ ok: true, value: error });
		if (parsedRequest.ok) expect(parsedRequest.value).not.toBe(request);
		if (parsedResult.ok) expect(parsedResult.value).not.toBe(result);
		if (parsedError.ok) expect(parsedError.value).not.toBe(error);
	});

	it('accepts null-prototype records and ignores inherited forbidden fields', () => {
		const request = Object.assign(Object.create(null), {
			type: 'executePython', boxId: 'python-section', code: 'print(1)',
		});
		const result = Object.assign(Object.create({ error: 'inherited' }), {
			type: 'pythonResult', boxId: 'python-section', stdout: 'one', stderr: '', exitCode: 0,
		});
		const error = Object.assign(Object.create({ stdout: 'inherited' }), {
			type: 'pythonError', boxId: 'python-section', error: 'failed',
		});

		expect(parsePythonExecutionWebviewMessage(request)).toEqual({ ok: true, value: { ...request } });
		expect(parsePythonExecutionHostMessage(result)).toEqual({
			ok: true,
			value: { type: 'pythonResult', boxId: 'python-section', stdout: 'one', stderr: '', exitCode: 0 },
		});
		expect(parsePythonExecutionHostMessage(error)).toEqual({
			ok: true,
			value: { type: 'pythonError', boxId: 'python-section', error: 'failed' },
		});
	});

	it('claims and rejects inherited, non-enumerable, and accessor required fields', () => {
		const request = { type: 'executePython', boxId: 'python-section', code: 'print(1)' };
		for (const key of ['type', 'boxId', 'code']) {
			expect(isPythonExecutionWebviewMessageType(inheritField(request, key))).toBe(true);
			expect(parsePythonExecutionWebviewMessage(inheritField(request, key))).toMatchObject({ ok: false });
		}

		const result = {
			type: 'pythonResult', boxId: 'python-section', stdout: 'one', stderr: '', exitCode: 0,
		};
		for (const key of ['type', 'boxId', 'stdout', 'stderr', 'exitCode']) {
			expect(parsePythonExecutionHostMessage(inheritField(result, key))).toMatchObject({ ok: false });
		}

		let getterCalls = 0;
		const accessor = { ...request };
		Object.defineProperty(accessor, 'code', {
			enumerable: true,
			get() {
				getterCalls++;
				throw new Error('must not run');
			},
		});
		const nonEnumerable = { ...request };
		Object.defineProperty(nonEnumerable, 'boxId', { value: 'python-section', enumerable: false });
		expect(parsePythonExecutionWebviewMessage(accessor)).toMatchObject({ ok: false });
		expect(parsePythonExecutionWebviewMessage(nonEnumerable)).toMatchObject({ ok: false });
		expect(getterCalls).toBe(0);
	});

	it('atomically snapshots valid proxies without property reads and claims callables', () => {
		const request = { type: 'executePython', boxId: 'python-section', code: 'print(1)' } as const;
		let typeInspections = 0;
		let propertyReads = 0;
		const requestProxy = new Proxy(request, {
			getOwnPropertyDescriptor(target, key) {
				if (key === 'type' && ++typeInspections > 1) throw new Error('type inspected twice');
				return Reflect.getOwnPropertyDescriptor(target, key);
			},
			get() {
				propertyReads++;
				throw new Error('property read');
			},
		});

		expect(admitPythonExecutionWebviewMessage(requestProxy)).toEqual({
			recognized: true, parsed: { ok: true, value: request },
		});
		expect(typeInspections).toBe(1);
		expect(propertyReads).toBe(0);
		expect(admitPythonExecutionWebviewMessage(Object.assign(() => undefined, request)))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitPythonExecutionHostMessage(Object.assign(() => undefined, {
			type: 'pythonError', boxId: 'python-section', error: 'failed',
		}))).toMatchObject({ recognized: true, parsed: { ok: false } });
	});

	it('fails closed on descriptor traps, revoked proxies, and bounded prototype inspection', () => {
		const request = { type: 'executePython', boxId: 'python-section', code: 'print(1)' };
		const descriptorTrap = new Proxy(request, {
			getOwnPropertyDescriptor() {
				throw new Error('descriptor trap');
			},
		});
		const revoked = Proxy.revocable(request, {});
		revoked.revoke();
		let cyclicProxy: object;
		cyclicProxy = new Proxy({}, { getPrototypeOf: () => cyclicProxy });
		let unboundedPrototypeReads = 0;
		const createUnboundedProxy = (): object => new Proxy({}, {
			getPrototypeOf() {
				unboundedPrototypeReads++;
				return createUnboundedProxy();
			},
		});

		expect(() => admitPythonExecutionWebviewMessage(descriptorTrap)).not.toThrow();
		expect(admitPythonExecutionWebviewMessage(descriptorTrap))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(() => admitPythonExecutionWebviewMessage(revoked.proxy)).not.toThrow();
		expect(admitPythonExecutionWebviewMessage(revoked.proxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(admitPythonExecutionWebviewMessage(cyclicProxy))
			.toMatchObject({ recognized: true, parsed: { ok: false } });
		expect(isPythonExecutionHostMessageType(createUnboundedProxy())).toBe(true);
		expect(unboundedPrototypeReads).toBe(16);
	});

	it('claims and rejects malformed requests and terminal identities', () => {
		const request = { type: 'executePython', boxId: 'python-section', code: 'print(1)' } as const;
		for (const malformed of [
			Object.assign([], request),
			{ ...request, boxId: '' },
			{ ...request, boxId: ['python-section'] },
			{ ...request, code: null },
		]) {
			expect(isPythonExecutionWebviewMessageType(malformed)).toBe(true);
			expect(parsePythonExecutionWebviewMessage(malformed)).toMatchObject({ ok: false });
		}

		const result = {
			type: 'pythonResult', boxId: 'python-section', stdout: '', stderr: '', exitCode: 0,
		} as const;
		for (const malformed of [
			Object.assign([], result),
			{ ...result, boxId: '' },
			{ ...result, boxId: ['python-section'] },
			{ ...result, stdout: null },
			{ ...result, stderr: [] },
			{ ...result, exitCode: 1.5 },
			{ ...result, exitCode: Number.NaN },
			{ ...result, exitCode: Number.POSITIVE_INFINITY },
		]) {
			expect(isPythonExecutionHostMessageType(malformed)).toBe(true);
			expect(parsePythonExecutionHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('requires exclusive result and error branches', () => {
		const result = {
			type: 'pythonResult', boxId: 'python-section', stdout: 'one', stderr: '', exitCode: -1,
		} as const;
		const error = { type: 'pythonError', boxId: 'python-section', error: 'failed' } as const;
		expect(parsePythonExecutionHostMessage(result)).toMatchObject({ ok: true });
		expect(parsePythonExecutionHostMessage(error)).toMatchObject({ ok: true });
		for (const malformed of [
			{ ...result, error: undefined },
			{ ...error, stdout: undefined },
			{ ...error, stderr: '' },
			{ ...error, exitCode: 1 },
		]) {
			expect(parsePythonExecutionHostMessage(malformed)).toMatchObject({ ok: false });
		}
	});

	it('enforces independent 200 KB UTF-8 stdout and stderr bounds', () => {
		const base = { type: 'pythonResult', boxId: 'python-section', exitCode: 0 } as const;
		const exactlyBounded = 'a'.repeat(PYTHON_OUTPUT_MAX_BYTES);
		expect(parsePythonExecutionHostMessage({ ...base, stdout: exactlyBounded, stderr: exactlyBounded }))
			.toMatchObject({ ok: true });
		expect(parsePythonExecutionHostMessage({ ...base, stdout: `${exactlyBounded}a`, stderr: '' }))
			.toMatchObject({ ok: false });
		expect(parsePythonExecutionHostMessage({
			...base, stdout: '', stderr: 'é'.repeat((PYTHON_OUTPUT_MAX_BYTES / 2) + 1),
		})).toMatchObject({ ok: false });
	});

	it('does not claim unrelated traffic and rejects unknown parser inputs', () => {
		expect(isPythonExecutionWebviewMessageType({ type: 'fetchUrl' })).toBe(false);
		expect(isPythonExecutionHostMessageType({ type: 'urlContent' })).toBe(false);
		expect(parsePythonExecutionWebviewMessage(null)).toMatchObject({ ok: false });
		expect(parsePythonExecutionHostMessage({ type: 'executePython' })).toMatchObject({ ok: false });
	});
});