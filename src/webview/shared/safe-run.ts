/**
 * Lightweight error handling wrapper. Catches exceptions and logs them
 * with a context tag so crashes in fire-and-forget DOM event handlers
 * don't silently swallow the stack trace.
 *
 * ```ts
 * import { safeRun } from '../shared/safe-run';
 * document.addEventListener('keydown', (e) => safeRun('paste', () => { ... }));
 * ```
 */
export function safeRun(tag: string, fn: () => void): void {
	try {
		fn();
	} catch (e) {
		console.error('[kusto]', tag, e);
	}
}

/** Async variant — wraps an async callback and catches rejected promises. */
export async function safeRunAsync(tag: string, fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch (e) {
		console.error('[kusto]', tag, e);
	}
}
