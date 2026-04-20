import { describe, it, expect, beforeEach, vi } from 'vitest';
import { KustoWorkbenchToolOrchestrator } from '../../../src/host/kustoWorkbenchTools';

/**
 * Regression tests for the orchestrator connect/disconnect token mechanism.
 *
 * Bug: When multiple .kqlx files were open, closing an older tab would call
 * disconnectIfOwner() and unconditionally clear the orchestrator's callbacks,
 * even though a different editor was the current connection. This left the
 * still-open file's tools broken ("Kusto Workbench is not currently open.").
 */

const fakeContext = {
	globalState: { get: () => undefined, update: () => Promise.resolve() },
	globalStorageUri: { fsPath: '/tmp/test', scheme: 'file', path: '/tmp/test' },
	subscriptions: [],
} as any;

const fakeConnectionManager = {
	getConnections: () => [],
} as any;

describe('KustoWorkbenchToolOrchestrator connect/disconnect', () => {
	beforeEach(() => {
		// Reset the singleton between tests
		(KustoWorkbenchToolOrchestrator as any).instance = undefined;
	});

	it('connect returns a token and listSections uses the stateGetter', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager);
		const stateGetter = vi.fn(async () => [
			{ id: 'q1', type: 'query', name: 'My Query' },
		]);
		orch.connect(vi.fn(), stateGetter, vi.fn());

		const result = await orch.listSections();
		expect(stateGetter).toHaveBeenCalledTimes(1);
		expect(result.sections).toHaveLength(1);
		expect(result.sections[0].id).toBe('q1');
	});

	it('disconnectIfOwner with matching token clears callbacks', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager);
		const token = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());

		orch.disconnectIfOwner(token);

		// stateGetter is now undefined → listSections should throw
		await expect(orch.listSections()).rejects.toThrow('not currently open');
	});

	it('disconnectIfOwner with stale token does NOT clear callbacks', async () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager);

		// Editor A connects
		const tokenA = orch.connect(vi.fn(), vi.fn(async () => [{ id: 'a1', type: 'query' }]), vi.fn());

		// Editor B connects (overwrites A)
		const stateGetterB = vi.fn(async () => [{ id: 'b1', type: 'query' }]);
		orch.connect(vi.fn(), stateGetterB, vi.fn());

		// Editor A closes and tries to disconnect with its stale token
		orch.disconnectIfOwner(tokenA);

		// Orchestrator should still be connected to editor B
		const result = await orch.listSections();
		expect(stateGetterB).toHaveBeenCalled();
		expect(result.sections[0].id).toBe('b1');
	});

	it('postToActiveWebview uses the latest poster after reconnect', () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager);

		const posterA = vi.fn();
		orch.connect(posterA, vi.fn(async () => []), vi.fn());

		const posterB = vi.fn();
		orch.connect(posterB, vi.fn(async () => []), vi.fn());

		orch.postToActiveWebview({ type: 'test' });
		expect(posterA).not.toHaveBeenCalled();
		expect(posterB).toHaveBeenCalledWith({ type: 'test' });
	});

	it('successive connects increment the token', () => {
		const orch = KustoWorkbenchToolOrchestrator.getInstance(fakeContext, fakeConnectionManager);
		const t1 = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());
		const t2 = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());
		const t3 = orch.connect(vi.fn(), vi.fn(async () => []), vi.fn());
		expect(t2).toBeGreaterThan(t1);
		expect(t3).toBeGreaterThan(t2);
	});
});
