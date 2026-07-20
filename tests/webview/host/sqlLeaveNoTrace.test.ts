import { describe, expect, it, vi } from 'vitest';
import {
	SQL_LEAVE_NO_TRACE_STORAGE_KEY,
	assertSqlConnectionMayUseSts,
	isSqlLeaveNoTraceConnection,
} from '../../../src/host/sql/sqlLeaveNoTrace';
import { StsQueryService } from '../../../src/host/sql/stsQueryService';

function contextWith(ids: string[]) {
	return {
		globalState: {
			get: vi.fn((key: string) => key === SQL_LEAVE_NO_TRACE_STORAGE_KEY ? ids : undefined),
		},
	} as any;
}

describe('SQL Leave No Trace STS gate', () => {
	it('recognizes marked SQL connection IDs', () => {
		expect(isSqlLeaveNoTraceConnection(contextWith(['sql-1']), 'sql-1')).toBe(true);
		expect(isSqlLeaveNoTraceConnection(contextWith(['sql-1']), 'sql-2')).toBe(false);
	});

	it('fails closed before SQL Tools Service is used', async () => {
		const context = contextWith(['sql-1']);
		expect(() => assertSqlConnectionMayUseSts(context, 'sql-1')).toThrow('may buffer results on disk');

		const runtime = { getProcessManager: vi.fn(), dispose: vi.fn() };
		const service = new StsQueryService(
			runtime as any,
			{ getPassword: vi.fn() } as any,
			context,
			{ warn: vi.fn(), error: vi.fn() } as any,
		);
		const connection = {
			id: 'sql-1', name: 'Sensitive', dialect: 'mssql', serverUrl: 'server.example', authType: 'aad',
		};

		await expect(service.getDatabases(connection)).rejects.toThrow('may buffer results on disk');
		expect(() => service.executeQueryCancelable(connection, 'Db', 'SELECT 1')).toThrow('may buffer results on disk');
		expect(runtime.getProcessManager).not.toHaveBeenCalled();
	});
});