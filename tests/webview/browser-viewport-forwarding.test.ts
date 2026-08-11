import { describe, expect, it, vi } from 'vitest';
import { installBrowserViewportForwarding } from '../../browser-ext/src/browser-viewport-forwarding';

describe('installBrowserViewportForwarding', () => {
	it('forwards the active viewport and removes both listeners on disposal', () => {
		const target = new EventTarget() as EventTarget & { innerHeight: number };
		target.innerHeight = 900;
		const send = vi.fn();
		let top = -125;
		let current = true;

		const dispose = installBrowserViewportForwarding(target, () => top, send, () => current);
		expect(send).toHaveBeenLastCalledWith({
			type: 'kusto-workbench-viewport', scrollTop: 125, viewportHeight: 900,
		});

		top = -250;
		target.dispatchEvent(new Event('scroll'));
		expect(send).toHaveBeenLastCalledWith({
			type: 'kusto-workbench-viewport', scrollTop: 250, viewportHeight: 900,
		});

		current = false;
		target.dispatchEvent(new Event('resize'));
		expect(send).toHaveBeenCalledTimes(2);

		dispose();
		current = true;
		target.dispatchEvent(new Event('scroll'));
		target.dispatchEvent(new Event('resize'));
		expect(send).toHaveBeenCalledTimes(2);
	});
});