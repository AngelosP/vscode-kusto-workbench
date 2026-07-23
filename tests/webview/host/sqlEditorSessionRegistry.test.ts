import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	SqlEditorSessionRegistry,
	sqlResultOwnersEqual,
} from '../../../src/host/sql/sqlEditorSessionRegistry';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';
import { createSqlStateCommit } from '../../../src/host/sql/sqlStateTransaction';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function writeCommittedAccountSnapshot(directory: string, version: number, accountId: string): void {
	const snapshot = {
		schemaVersion: 1,
		version,
		accountsByServer: accountId ? { 'server.example': accountId } : {},
		recoveryBlocked: false,
		blockedServerUrls: [],
	};
	const text = `${JSON.stringify(snapshot)}\n`;
	fs.writeFileSync(path.join(directory, 'sql-server-account-map.v1.json'), text, 'utf8');
	fs.writeFileSync(path.join(directory, 'sql-server-account-map.backup.v1.json'), text, 'utf8');
	fs.writeFileSync(path.join(directory, 'sql-server-account-map.commit.v1.json'), `${JSON.stringify(
		createSqlStateCommit(text, { schemaVersion: 1, version }),
	)}\n`, 'utf8');
	fs.writeFileSync(path.join(directory, 'sql-server-account-map-migrated.v1'), 'migrated\n', 'utf8');
}

function createHarness(options: { accountId?: string; canonicalAccountId?: string; database?: string } = {}) {
	const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kw-sql-editor-owner-'));
	const accountId = options.accountId ?? 'account-a';
	const canonicalAccountId = options.canonicalAccountId ?? accountId;
	const connection = {
		id: 'sql-1', name: 'SQL', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
	};
	const context = {
		globalStorageUri: vscode.Uri.file(directory),
		globalState: {
			get: vi.fn((key: string) => key === 'sql.auth.serverAccountMap' && accountId
				? { 'server.example': accountId }
				: undefined),
			update: vi.fn(async () => undefined),
		},
	} as any;
	writeCommittedAccountSnapshot(directory, 1, canonicalAccountId);
	const sqlWorkbench = {
		connectionManager: {
			getConnection: vi.fn((id: string) => id === connection.id ? connection : undefined),
			assertConnectionCurrent: vi.fn(async () => undefined),
		},
		leaveNoTracePolicy: { getRevocationGeneration: vi.fn(() => 3) },
		serverAccountMap: {
			getAccountsByServer: vi.fn(() => canonicalAccountId ? { 'server.example': canonicalAccountId } : {}),
			refresh: vi.fn(async () => canonicalAccountId ? { 'server.example': canonicalAccountId } : {}),
		},
		ready: vi.fn(async () => undefined),
		assertSqlConnectionAllowed: vi.fn(async () => undefined),
		dispatchSqlOwnerAllowed: vi.fn(async (_connection, _principal, _revocation, dispatch) => await dispatch()),
	} as any;
	const registry = new SqlEditorSessionRegistry({ context, sqlWorkbench });
	registry.adoptTarget('sql_1', connection.id, options.database === undefined ? 'Db' : options.database, 4, () => undefined);
	registry.setComparisonOwner('query_comparison', {
		sourceBoxId: 'sql_1', connectionId: connection.id, copilotSequence: 7,
	});
	return {
		directory,
		connection,
		context,
		sqlWorkbench,
		registry,
	};
}

describe('SqlEditorSessionRegistry', () => {
	it('preserves a monotonic generation tombstone when a target is removed', () => {
		const harness = createHarness();
		try {
			expect(harness.registry.removeTarget('sql_1')).toMatchObject({ generation: 4 });
			expect(harness.registry.getTarget('sql_1')).toBeUndefined();
			expect(harness.registry.getGeneration('sql_1')).toBe(5);
			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 4, () => undefined)).toBe('rejected');
			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 5, () => undefined)).toBe('rejected');
			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 6, () => undefined)).toBe('changed');
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('retires a target at the supplied generation and rejects older resurrection', async () => {
		const harness = createHarness();
		try {
			await harness.registry.issueOwnerToken('sql_1', harness.registry.getOwner('sql_1')!);
			const beforeOwnerChange = vi.fn();

			expect(harness.registry.retireTarget('sql_1', 7, beforeOwnerChange)).toBe('changed');
			expect(beforeOwnerChange).toHaveBeenCalledOnce();
			expect(harness.registry.getTarget('sql_1')).toBeUndefined();
			expect(harness.registry.getOwnerToken('sql_1')).toBeUndefined();
			expect(harness.registry.getGeneration('sql_1')).toBe(7);
			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 6, () => undefined)).toBe('rejected');
			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 7, () => undefined)).toBe('rejected');
			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 8, () => undefined)).toBe('changed');
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('adopts a newer target only after retiring the previous owner', async () => {
		const harness = createHarness();
		try {
			const oldToken = await harness.registry.issueOwnerToken('sql_1', harness.registry.getOwner('sql_1')!);
			const observations: Array<{ target: unknown; token: unknown }> = [];

			const result = harness.registry.adoptTarget('sql_1', 'sql-2', 'OtherDb', 5, () => {
				observations.push({
					target: harness.registry.getTarget('sql_1'),
					token: harness.registry.getOwnerToken('sql_1'),
				});
			});

			expect(result).toBe('changed');
			expect(observations).toEqual([{
				target: { boxId: 'sql_1', connectionId: 'sql-1', database: 'Db', generation: 4 },
				token: oldToken,
			}]);
			expect(harness.registry.getTarget('sql_1')).toEqual({
				boxId: 'sql_1', connectionId: 'sql-2', database: 'OtherDb', generation: 5,
			});
			expect(harness.registry.getOwnerToken('sql_1')).toBeUndefined();
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('fills missing same-generation target data without retiring its owner', () => {
		const harness = createHarness({ database: '' });
		try {
			const beforeOwnerChange = vi.fn();

			expect(harness.registry.adoptTarget('sql_1', 'sql-1', 'Db', 4, beforeOwnerChange)).toBe('unchanged');
			expect(harness.registry.getTarget('sql_1')).toEqual({
				boxId: 'sql_1', connectionId: 'sql-1', database: 'Db', generation: 4,
			});
			expect(beforeOwnerChange).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it.each([
		['stale generation', 'sql-1', 'Db', 3],
		['same-generation connection conflict', 'sql-2', 'Db', 4],
		['same-generation database conflict', 'sql-1', 'OtherDb', 4],
	] as const)('rejects %s without mutating the target', (_label, connectionId, database, generation) => {
		const harness = createHarness();
		try {
			const beforeOwnerChange = vi.fn();
			expect(harness.registry.adoptTarget('sql_1', connectionId, database, generation, beforeOwnerChange)).toBe('rejected');
			expect(harness.registry.getTarget('sql_1')).toEqual({
				boxId: 'sql_1', connectionId: 'sql-1', database: 'Db', generation: 4,
			});
			expect(beforeOwnerChange).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('builds direct and comparison owners from one source target', () => {
		const harness = createHarness();
		try {
			const expected = {
				connectionId: harness.connection.id,
				database: 'Db',
				generation: 4,
				targetSignature: sqlConnectionTargetSignature(harness.connection),
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(harness.connection, 'account-a')!,
				revocationGeneration: 3,
			};

			expect(harness.registry.getOwner('sql_1')).toEqual(expected);
			expect(harness.registry.getOwner('query_comparison')).toEqual(expected);
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('uses the canonical principal even when the globalState mirror is empty', async () => {
		const harness = createHarness({ accountId: '', canonicalAccountId: 'account-a' });
		try {
			const principalFingerprint = sqlSchemaPrincipalFingerprintForPrincipal(harness.connection, 'account-a');
			expect(harness.registry.getOwner('sql_1')).toMatchObject({ principalFingerprint });
			await expect(harness.registry.getCanonicalOwner('sql_1')).resolves.toMatchObject({ principalFingerprint });
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('refreshes the account store before projecting a newly established AAD owner', async () => {
		const harness = createHarness({ accountId: '', canonicalAccountId: '' });
		try {
			let accounts: Record<string, string> = {};
			harness.sqlWorkbench.serverAccountMap.getAccountsByServer.mockImplementation(() => ({ ...accounts }));
			harness.sqlWorkbench.serverAccountMap.refresh.mockImplementation(async () => {
				accounts = JSON.parse(fs.readFileSync(
					path.join(harness.directory, 'sql-server-account-map.v1.json'), 'utf8',
				)).accountsByServer;
				return { ...accounts };
			});

			expect(harness.registry.getOwner('sql_1')).toBeUndefined();
			writeCommittedAccountSnapshot(harness.directory, 2, 'account-a');
			await expect(harness.registry.getCanonicalOwner('sql_1')).resolves.toMatchObject({
				principalFingerprint: sqlSchemaPrincipalFingerprintForPrincipal(harness.connection, 'account-a'),
			});
			expect(harness.sqlWorkbench.serverAccountMap.refresh).toHaveBeenCalledOnce();
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('never projects the stale mirrored principal after the canonical principal rotates', async () => {
		const harness = createHarness({ accountId: 'account-a', canonicalAccountId: 'account-b' });
		try {
			const owner = harness.registry.getOwner('sql_1')!;
			const canonicalOwner = await harness.registry.getCanonicalOwner('sql_1');
			expect(owner.principalFingerprint).toBe(sqlSchemaPrincipalFingerprintForPrincipal(harness.connection, 'account-b'));
			expect(canonicalOwner).toEqual(owner);
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('rechecks editor ownership inside canonical dispatch admission', async () => {
		const harness = createHarness();
		try {
			const owner = harness.registry.getOwner('sql_1')!;
			const publish = vi.fn();
			harness.sqlWorkbench.dispatchSqlOwnerAllowed.mockImplementation(
				async (_connection, _principal, _revocation, dispatch) => {
					harness.registry.adoptTarget('sql_1', 'sql-1', 'OtherDb', 5, () => undefined);
					return await dispatch();
				},
			);

			await expect(harness.registry.dispatchOwnerAllowed('sql_1', owner, publish))
				.rejects.toThrow('owner changed');
			expect(publish).not.toHaveBeenCalled();
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('rejects a structurally identical token replacement during validation', async () => {
		const harness = createHarness();
		try {
			const owner = harness.registry.getOwner('sql_1')!;
			const token = await harness.registry.issueOwnerToken('sql_1', owner);
			const issued = harness.registry.getIssuedOwner('sql_1')!;
			const validation = deferred<void>();
			harness.sqlWorkbench.connectionManager.assertConnectionCurrent.mockImplementationOnce(async () => validation.promise);
			const assertion = harness.registry.assertOwnerToken('sql_1', token);
			(registryOwnerTokens(harness.registry)).set('sql_1', { token, owner });
			validation.resolve();

			await expect(assertion).rejects.toThrow('owner token changed');
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('reuses the token when STS reconnects the exact same owner', async () => {
		const harness = createHarness();
		try {
			const owner = harness.registry.getOwner('sql_1')!;
			const stableToken = await harness.registry.issueOwnerToken('sql_1', owner);

			await expect(harness.registry.issueOwnerToken('sql_1', owner)).resolves.toBe(stableToken);
			expect(harness.registry.getIssuedOwner('sql_1')).toEqual({ token: stableToken, owner });
		} finally {
			fs.rmSync(harness.directory, { recursive: true, force: true });
		}
	});

	it('compares every owner field and never equates missing owners', () => {
		const owner = createHarness().registry.getOwner('sql_1')!;
		expect(sqlResultOwnersEqual(undefined, undefined)).toBe(false);
		for (const replacement of [
			{ connectionId: 'sql-2' }, { database: 'OtherDb' }, { generation: 5 },
			{ targetSignature: 'other-target' }, { principalFingerprint: 'other-principal' },
			{ revocationGeneration: 4 },
		]) {
			expect(sqlResultOwnersEqual(owner, { ...owner, ...replacement })).toBe(false);
		}
	});
});

function registryOwnerTokens(registry: SqlEditorSessionRegistry): Map<string, { token: string; owner: any }> {
	return (registry as any).ownerTokenByBoxId;
}