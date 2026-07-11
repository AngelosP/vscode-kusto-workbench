export type SupplementalOperationLeaseResult<T> =
	| Readonly<{ status: 'completed'; value: T }>
	| Readonly<{ status: 'timed-out' }>;

export function raceSupplementalOperationLease<T>(
	operation: Promise<T>,
	timeoutMs: number,
	setTimer: (callback: () => void, delayMs: number) => unknown = (callback, delayMs) => setTimeout(callback, delayMs),
	clearTimer: (timer: unknown) => void = timer => clearTimeout(timer as ReturnType<typeof setTimeout>),
): Promise<SupplementalOperationLeaseResult<T>> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const timer = setTimer(() => {
			if (settled) return;
			settled = true;
			resolve(Object.freeze({ status: 'timed-out' }));
		}, Math.max(0, timeoutMs));
		operation.then(
			value => {
				if (settled) return;
				settled = true;
				clearTimer(timer);
				resolve(Object.freeze({ status: 'completed', value }));
			},
			error => {
				if (settled) return;
				settled = true;
				clearTimer(timer);
				reject(error);
			},
		);
	});
}
