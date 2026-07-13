import { describe, expect, it } from 'vitest';
import {
	getKustoAuthScopes,
	getKustoConnectionIdentityKey,
	normalizeKustoAuthorityId,
	resolveKustoConnection,
	resolveStrictKustoConnection,
} from '../../src/shared/kustoAuth';

describe('Kusto auth contract', () => {
	it('normalizes supported tenant authorities and rejects malformed values', () => {
		expect(normalizeKustoAuthorityId(' 910C7523-EBB8-4411-871E-1593F3C37767 '))
			.toBe('910c7523-ebb8-4411-871e-1593f3c37767');
		expect(normalizeKustoAuthorityId('Contoso.OnMicrosoft.com')).toBe('contoso.onmicrosoft.com');
		expect(normalizeKustoAuthorityId('organizations')).toBe('organizations');
		expect(normalizeKustoAuthorityId('')).toBeUndefined();
		expect(() => normalizeKustoAuthorityId('https://login.microsoftonline.com/tenant')).toThrow(/Tenant \/ Authority ID/);
	});

	it('adds the VS Code tenant control scope only for tenant-bound connections', () => {
		expect(getKustoAuthScopes()).toEqual(['https://kusto.kusto.windows.net/.default']);
		expect(getKustoAuthScopes('910c7523-ebb8-4411-871e-1593f3c37767')).toEqual([
			'https://kusto.kusto.windows.net/.default',
			'VSCODE_TENANT:910c7523-ebb8-4411-871e-1593f3c37767',
		]);
	});

	it('uses cluster and authority as the portable connection identity', () => {
		expect(getKustoConnectionIdentityKey('https://Help.kusto.windows.net/', undefined)).toBe('help|');
		expect(getKustoConnectionIdentityKey('help', 'CONTOSO.COM')).toBe('help|contoso.com');
	});

	it('resolves a valid hint before a unique cluster and authority match', () => {
		const connections = [
			{ id: 'default', clusterUrl: 'https://same.kusto.windows.net' },
			{ id: 'guest', clusterUrl: 'https://same.kusto.windows.net', authorityId: 'contoso.com' },
		];
		expect(resolveKustoConnection(connections, {
			clusterUrl: 'same', authorityId: 'CONTOSO.COM', connectionIdHint: 'guest',
		})).toEqual({ kind: 'matched', connection: connections[1] });
		expect(resolveKustoConnection(connections, {
			clusterUrl: 'same', authorityId: 'contoso.com', connectionIdHint: 'default',
		})).toEqual({ kind: 'matched', connection: connections[1] });
	});

	it('does not silently pick a same-cluster connection for legacy ambiguous state', () => {
		const connections = [
			{ id: 'default', clusterUrl: 'https://same.kusto.windows.net' },
			{ id: 'guest', clusterUrl: 'https://same.kusto.windows.net', authorityId: 'contoso.com' },
		];
		const resolution = resolveKustoConnection(connections, { clusterUrl: 'same' });
		expect(resolution.kind).toBe('ambiguous');
		if (resolution.kind === 'ambiguous') {
			expect(resolution.connections.map(connection => connection.id)).toEqual(['default', 'guest']);
		}
	});

	it('uses a stale current-format hint to restore the explicit default authority beside a guest connection', () => {
		const connections = [
			{ id: 'default-new-profile', clusterUrl: 'https://same.kusto.windows.net' },
			{ id: 'guest', clusterUrl: 'https://same.kusto.windows.net', authorityId: 'contoso.com' },
		];

		expect(resolveKustoConnection(connections, {
			clusterUrl: 'same',
			connectionIdHint: 'default-old-profile',
		})).toEqual({ kind: 'matched', connection: connections[0] });
		expect(resolveKustoConnection(connections, { clusterUrl: 'same' }).kind).toBe('ambiguous');
	});

	it('resolves a valid authority beside a malformed historical connection', () => {
		const connections = [
			{ id: 'legacy', clusterUrl: 'https://same.kusto.windows.net', authorityId: 'not a tenant' },
			{ id: 'guest', clusterUrl: 'https://same.kusto.windows.net', authorityId: 'resource.onmicrosoft.com' },
		];

		expect(resolveKustoConnection(connections, {
			clusterUrl: 'same',
			authorityId: 'resource.onmicrosoft.com',
			connectionIdHint: 'legacy',
		})).toEqual({ kind: 'matched', connection: connections[1] });
	});

	it('strictly resolves live commands without falling back from a supplied connection ID', () => {
		const connections = [
			{ id: 'home', clusterUrl: 'https://same.kusto.windows.net' },
			{ id: 'guest', clusterUrl: 'https://same.kusto.windows.net', authorityId: 'contoso.com' },
			{ id: 'other', clusterUrl: 'https://other.kusto.windows.net' },
		];
		expect(resolveStrictKustoConnection(connections, { clusterUrl: 'same', connectionId: 'guest' }))
			.toEqual({ kind: 'matched', connection: connections[1] });
		expect(resolveStrictKustoConnection(connections, { clusterUrl: 'same', connectionId: 'missing' }))
			.toEqual({ kind: 'missing' });
		expect(resolveStrictKustoConnection(connections, { clusterUrl: 'same', connectionId: 'other' }))
			.toEqual({ kind: 'mismatch', connection: connections[2] });
		expect(resolveStrictKustoConnection(connections, { clusterUrl: 'same' }).kind).toBe('ambiguous');
		expect(resolveStrictKustoConnection(connections, { clusterUrl: 'other' }))
			.toEqual({ kind: 'matched', connection: connections[2] });
	});
});