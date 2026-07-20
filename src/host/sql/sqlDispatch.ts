export type SqlDispatchOutcome<T> =
	| { ok: true; value: T }
	| { ok: false; error: unknown };

export type SqlDispatchHandle<T> = {
	settled: Promise<SqlDispatchOutcome<T>>;
};

export function startSqlDispatch<T>(dispatch: () => T | PromiseLike<T>): SqlDispatchHandle<T> {
	try {
		const dispatched = dispatch();
		return {
			settled: Promise.resolve(dispatched).then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			),
		};
	} catch (error) {
		return { settled: Promise.resolve({ ok: false, error }) };
	}
}

export async function unwrapSqlDispatch<T>(handle: SqlDispatchHandle<T>): Promise<T> {
	const outcome = await handle.settled;
	if (outcome.ok) return outcome.value;
	throw outcome.error;
}
