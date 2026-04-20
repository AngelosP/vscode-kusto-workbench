import { describe, it, expect } from 'vitest';
import {
	SqlQueryCancelledError,
	SqlQueryExecutionError,
} from '../../../src/host/sqlClient';

// ── SqlQueryCancelledError ────────────────────────────────────────────────────

describe('SqlQueryCancelledError', () => {
	it('has default message "Query cancelled"', () => {
		const err = new SqlQueryCancelledError();
		expect(err.message).toBe('Query cancelled');
	});

	it('accepts a custom message', () => {
		const err = new SqlQueryCancelledError('User cancelled');
		expect(err.message).toBe('User cancelled');
	});

	it('has isCancelled set to true', () => {
		const err = new SqlQueryCancelledError();
		expect(err.isCancelled).toBe(true);
	});

	it('has name set to SqlQueryCancelledError', () => {
		const err = new SqlQueryCancelledError();
		expect(err.name).toBe('SqlQueryCancelledError');
	});

	it('is an instance of Error', () => {
		const err = new SqlQueryCancelledError();
		expect(err).toBeInstanceOf(Error);
	});
});

// ── SqlQueryExecutionError ────────────────────────────────────────────────────

describe('SqlQueryExecutionError', () => {
	it('stores the provided message', () => {
		const err = new SqlQueryExecutionError('Connection refused');
		expect(err.message).toBe('Connection refused');
	});

	it('has name set to SqlQueryExecutionError', () => {
		const err = new SqlQueryExecutionError('fail');
		expect(err.name).toBe('SqlQueryExecutionError');
	});

	it('is an instance of Error', () => {
		const err = new SqlQueryExecutionError('fail');
		expect(err).toBeInstanceOf(Error);
	});
});
