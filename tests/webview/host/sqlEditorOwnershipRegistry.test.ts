import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it, vi } from 'vitest';
import * as vscode from 'vscode';

import {
	SqlEditorOwnershipRegistry,
	sqlResultOwnersEqual,
	type SqlIssuedOwnerToken,
} from '../../../src/host/sql/sqlEditorOwnershipRegistry';
import { sqlSchemaPrincipalFingerprintForPrincipal } from '../../../src/host/sqlEditorSchema';
import { sqlConnectionTargetSignature } from '../../../src/shared/sqlConnectionIdentity';

function deferred<T>() {
	let resolve!: (value: T | PromiseLike<T>) => void;
	const promise = new Promise<T>(res => { resolve = res; });
	return { promise, resolve };
}

function createHarness(options: { accountId?: string; canonicalAccountId?: string } = {}) {
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
	fs.writeFileSync(path.join(directory, 'sql-server-account-map.v1.json'), JSON.stringify({
		schemaVersion: 1,
		version: 1,
		accountsByServer: canonicalAccountId ? { 'server.example': canonicalAccountId } : {},
	}), 'utf8');
	const connectionIdByBoxId = new Map([['sql_1', connection.id]]);
	const comparisonOwnerByBoxId = new Map([[
		'query_comparison',
		{ sourceBoxId: 'sql_1', connectionId: connection.id, copilotSequence: 7 },
	]]);
	const databaseByBoxId = new Map([['sql_1', 'Db']]);
	const targetGenerationByBoxId = new Map([['sql_1', 4]]);
	const ownerTokenByBoxId = new Map<string, SqlIssuedOwnerToken>();
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
	const registry = new SqlEditorOwnershipRegistry({
		context,
		sqlWorkbench,
		connectionIdByBoxId,
		comparisonOwnerByBoxId,
		databaseByBoxId,
		targetGenerationByBoxId,
		ownerTokenByBoxId,
	});
	return {
		directory,
		connection,
		context,
		sqlWorkbench,
		registry,
		connectionIdByBoxId,
		comparisonOwnerByBoxId,
		databaseByBoxId,
		targetGenerationByBoxId,
		ownerTokenByBoxId,
	};
}

describe('SqlEditorOwnershipRegistry', () => {
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
			fs.writeFileSync(path.join(harness.directory, 'sql-server-account-map.v1.json'), JSON.stringify({
				schemaVersion: 1, version: 2, accountsByServer: { 'server.example': 'account-a' },
			}), 'utf8');
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
					harness.databaseByBoxId.set('sql_1', 'OtherDb');
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
			const issued = { token: 'token-a', owner: harness.registry.getOwner('sql_1')! };
			harness.ownerTokenByBoxId.set('sql_1', issued);
			const validation = deferred<void>();
			const assertion = harness.registry.assertOwnerToken('sql_1', issued.token, async () => validation.promise);
			harness.ownerTokenByBoxId.set('sql_1', { token: issued.token, owner: issued.owner });
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
			harness.ownerTokenByBoxId.set('sql_1', { token: 'stable-token', owner });

			await expect(harness.registry.issueOwnerToken(
				'sql_1', owner,
				boxId => harness.registry.getCanonicalOwner(boxId),
				(boxId, expectedOwner, dispatch) => harness.registry.dispatchOwnerAllowed(boxId, expectedOwner, dispatch),
			)).resolves.toBe('stable-token');
			expect(harness.ownerTokenByBoxId.get('sql_1')).toEqual({ token: 'stable-token', owner });
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