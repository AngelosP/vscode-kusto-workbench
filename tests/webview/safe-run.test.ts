import { describe, it, expect, vi, beforeEach } from 'vitest';
import { safeRun, safeRunAsync } from '../../src/webview/shared/safe-run';

describe('safeRun', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('executes the callback', () => {
		const fn = vi.fn();
		safeRun('test', fn);
		expect(fn).toHaveBeenCalledOnce();
	});

	it('returns undefined', () => {
		const result = safeRun('test', () => {});
		expect(result).toBeUndefined();
	});

	it('catches thrown errors and logs them', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = new Error('boom');
		safeRun('myTag', () => { throw err; });
		expect(spy).toHaveBeenCalledWith('[kusto]', 'myTag', err);
	});

	it('catches non-Error throws', () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		safeRun('tag', () => { throw 'string-error'; });
		expect(spy).toHaveBeenCalledWith('[kusto]', 'tag', 'string-error');
	});

	it('does not propagate the error', () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		expect(() => safeRun('tag', () => { throw new Error('fail'); })).not.toThrow();
	});
});

describe('safeRunAsync', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it('executes the async callback', async () => {
		const fn = vi.fn().mockResolvedValue(undefined);
		await safeRunAsync('test', fn);
		expect(fn).toHaveBeenCalledOnce();
	});

	it('returns a promise that resolves to undefined', async () => {
		const result = await safeRunAsync('test', async () => {});
		expect(result).toBeUndefined();
	});

	it('catches rejected promises and logs them', async () => {
		const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
		const err = new Error('async boom');
		await safeRunAsync('asyncTag', async () => { throw err; });
		expect(spy).toHaveBeenCalledWith('[kusto]', 'asyncTag', err);
	});

	it('does not reject the returned promise on error', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await expect(safeRunAsync('tag', async () => { throw new Error('fail'); })).resolves.toBeUndefined();
	});

	it('awaits the async function before returning', async () => {
		const order: number[] = [];
		await safeRunAsync('test', async () => {
			await new Promise((r) => setTimeout(r, 10));
			order.push(1);
		});
		order.push(2);
		expect(order).toEqual([1, 2]);
	});
});
