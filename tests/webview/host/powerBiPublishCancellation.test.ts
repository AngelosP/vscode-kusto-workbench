import { describe, expect, it } from 'vitest';

import {
	canDeleteCreatedSemanticModelForTest,
	createExternalCommitGateForTest,
	createPowerBiPublishTempUriForTest,
	getFabricItemsContinuationPathForTest,
	getPowerBiSessionForAccountForTest,
	selectExactFabricItemIdForTest,
} from '../../../src/host/powerBiPublish';

describe('Power BI publish cancellation', () => {
	it('rejects cancellation that lands before the first external commit admission', async () => {
		const controller = new AbortController();
		const gate = createExternalCommitGateForTest(controller.signal);
		controller.abort();

		await expect(gate.dispatch(async () => 'never')).rejects.toEqual(expect.objectContaining({ name: 'AbortError' }));
	});

	it('does not reinterpret an admitted immutable external snapshot after cancellation', async () => {
		const controller = new AbortController();
		const gate = createExternalCommitGateForTest(controller.signal);
		await expect(gate.dispatch(async () => 'committed')).resolves.toBe('committed');
		controller.abort();

		await expect(gate.dispatch(async () => 'settled')).resolves.toBe('settled');
	});

	it('allocates collision-proof temporary roots for concurrent publish preparation', () => {
		const first = createPowerBiPublishTempUriForTest().toString();
		const second = createPowerBiPublishTempUriForTest().toString();

		expect(first).not.toBe(second);
		expect(first).toContain('kw-pbi-publish-');
		expect(second).toContain('kw-pbi-publish-');
	});

	it('recovers only an exact unique staging-name match', () => {
		const items = [
			{ id: 'unrelated', displayName: 'Dashboard' },
			{ id: 'exact', displayName: 'kw-transaction-report' },
		];

		expect(selectExactFabricItemIdForTest(items, 'kw-transaction-report', 'Report')).toBe('exact');
		expect(selectExactFabricItemIdForTest(items, 'missing', 'Report')).toBeUndefined();
		expect(() => selectExactFabricItemIdForTest([
			...items,
			{ id: 'duplicate', displayName: 'kw-transaction-report' },
		], 'kw-transaction-report', 'Report')).toThrow(/multiple Report items/);
	});

	it('retains a model when a dispatched report may exist but its ID is unresolved', () => {
		expect(canDeleteCreatedSemanticModelForTest(true, '')).toBe(false);
		expect(canDeleteCreatedSemanticModelForTest(true, 'report-id')).toBe(true);
		expect(canDeleteCreatedSemanticModelForTest(false, '')).toBe(true);
	});

	it('continues exact staging recovery through URI, body-token, and header-token pagination', () => {
		const basePath = '/workspaces/w/items?type=Report';
		expect(getFabricItemsContinuationPathForTest(
			{ continuationUri: 'https://api.fabric.microsoft.com/next' }, new Headers(), basePath,
		)).toBe('https://api.fabric.microsoft.com/next');
		expect(getFabricItemsContinuationPathForTest(
			{ continuationToken: 'body token' }, new Headers(), basePath,
		)).toBe(`${basePath}&continuationToken=body%20token`);
		expect(getFabricItemsContinuationPathForTest(
			{}, new Headers({ 'x-ms-continuation-token': 'header token' }), basePath,
		)).toBe(`${basePath}&continuationToken=header%20token`);
	});

	it('pins Power BI refresh authentication to the captured Fabric account', async () => {
		const account = { id: 'fabric-account', label: 'Fabric account' };
		const acquireSession = vi.fn(async (requestedAccount: typeof account) => ({
			accessToken: 'pbi-token', account: requestedAccount,
		}));

		await expect(getPowerBiSessionForAccountForTest(account, acquireSession)).resolves.toEqual({
			accessToken: 'pbi-token', account,
		});
		expect(acquireSession).toHaveBeenCalledWith(account);
		await expect(getPowerBiSessionForAccountForTest(account, async () => ({
			accessToken: 'other-token', account: { id: 'other-account', label: 'Other account' },
		}))).resolves.toBeUndefined();
	});
});