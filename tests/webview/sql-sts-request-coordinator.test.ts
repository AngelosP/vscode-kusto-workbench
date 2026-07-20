import { describe, expect, it, vi } from 'vitest';

import { SqlStsRequestCoordinator } from '../../src/webview/monaco/sql-sts-request-coordinator.js';

describe('SqlStsRequestCoordinator', () => {
	it('admits a response only while the captured owner is still current', async () => {
		const coordinator = new SqlStsRequestCoordinator();
		const owner = { ownerToken: 'owner-a', targetGeneration: 1 };
		coordinator.setOwner('sql-1', owner);
		let requestId = '';
		const request = coordinator.request<{ label: string }>('sql-1', 1000, id => { requestId = id; });

		expect(coordinator.resolve(requestId, { label: 'TableA' }, owner)).toBe(true);
		await expect(request).resolves.toEqual({ label: 'TableA' });
	});

	it('settles pending owner-A requests when owner B replaces it', async () => {
		const coordinator = new SqlStsRequestCoordinator();
		coordinator.setOwner('sql-1', { ownerToken: 'owner-a', targetGeneration: 1 });
		let requestId = '';
		const request = coordinator.request('sql-1', 1000, id => { requestId = id; });

		coordinator.setOwner('sql-1', { ownerToken: 'owner-b', targetGeneration: 2 });

		await expect(request).resolves.toBeNull();
		expect(coordinator.resolve(requestId, { label: 'OwnerASecret' }, {
			ownerToken: 'owner-a', targetGeneration: 1,
		})).toBe(false);
	});

	it('rejects a response whose echoed owner differs from the captured owner', async () => {
		const coordinator = new SqlStsRequestCoordinator();
		coordinator.setOwner('sql-1', { ownerToken: 'owner-a', targetGeneration: 1 });
		let requestId = '';
		const request = coordinator.request('sql-1', 1000, id => { requestId = id; });

		coordinator.resolve(requestId, { label: 'WrongOwner' }, {
			ownerToken: 'owner-b', targetGeneration: 1,
		});

		await expect(request).resolves.toBeNull();
	});

	it('settles every pending request when a model owner is cleared', async () => {
		const coordinator = new SqlStsRequestCoordinator();
		coordinator.setOwner('sql-1', { ownerToken: 'owner-a', targetGeneration: 1 });
		const first = coordinator.request('sql-1', 1000, vi.fn());
		const second = coordinator.request('sql-1', 1000, vi.fn());

		coordinator.clearBox('sql-1');

		await expect(first).resolves.toBeNull();
		await expect(second).resolves.toBeNull();
		expect(coordinator.getOwner('sql-1')).toBeUndefined();
	});
});