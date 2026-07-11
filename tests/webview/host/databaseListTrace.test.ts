import { describe, expect, it, vi } from 'vitest';

import {
	createDatabaseListTraceId,
	databaseListTraceRef,
	getDatabaseListErrorDetails,
	traceDatabaseList,
} from '../../../src/host/databaseListTrace';

function createLogger() {
	return {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		show: vi.fn(),
		log: vi.fn(),
	};
}

describe('database-list trace privacy', () => {
	it('creates unique correlation IDs and stable opaque references', () => {
		expect(createDatabaseListTraceId()).not.toBe(createDatabaseListTraceId());
		expect(databaseListTraceRef('connection-1')).toBe(databaseListTraceRef('connection-1'));
		expect(databaseListTraceRef('connection-1')).not.toBe(databaseListTraceRef('connection-2'));
		expect(databaseListTraceRef('connection-1')).toMatch(/^[a-f0-9]{12}$/);
	});

	it('hashes request identifiers and redacts common credential shapes', () => {
		const output = createLogger();
		const jwt = 'eyJhbGciOiJSUzI1NiJ9.abcdefghijklmnop.qrstuvwxyz012345';
		traceDatabaseList(output, 'trace-1', 'test', 'event', {
			connectionId: 'draft:https://user:password@example.test/?sig=TRACE_SECRET',
			requestToken: 'raw-request-token',
			detail: `Bearer BEARER_SECRET ${jwt} https://example.test/?access_token=QUERY_SECRET`,
		});

		const text = String(output.trace.mock.calls[0][0]);
		expect(text).toContain('connectionIdRef=');
		expect(text).toContain('requestTokenRef=');
		expect(text).toContain('Bearer [redacted]');
		expect(text).toContain('[redacted-jwt]');
		expect(text).toContain('access_token=[redacted]');
		for (const secret of ['password', 'TRACE_SECRET', 'raw-request-token', 'BEARER_SECRET', jwt, 'QUERY_SECRET']) {
			expect(text).not.toContain(secret);
		}
	});

	it('extracts only allowlisted error metadata from nested SDK errors', () => {
		const error = Object.assign(new Error('Database SecretDb rejected account person@example.com token=SECRET'), {
			cause: { response: { status: 403 }, code: 'ERR_FORBIDDEN', accessToken: 'SECRET' },
		});

		expect(getDatabaseListErrorDetails(error)).toEqual({
			errorType: 'Error',
			status: 403,
			code: 'ERR_FORBIDDEN',
		});
		expect(JSON.stringify(getDatabaseListErrorDetails(error))).not.toContain('SecretDb');
		expect(JSON.stringify(getDatabaseListErrorDetails(error))).not.toContain('person@example.com');
		expect(JSON.stringify(getDatabaseListErrorDetails(error))).not.toContain('SECRET');
	});

	it('does not throw when SDK error properties have hostile getters', () => {
		const error = Object.create(null, {
			name: { get: () => { throw new Error('name getter failed'); } },
			cause: { get: () => { throw new Error('cause getter failed'); } },
			statusCode: { get: () => { throw new Error('status getter failed'); } },
			code: { get: () => { throw new Error('code getter failed'); } },
		});

		expect(() => getDatabaseListErrorDetails(error)).not.toThrow();
		expect(getDatabaseListErrorDetails(error)).toEqual({ errorType: 'Error' });
	});
});
