import { describe, it, expect } from 'vitest';
import { prettifySql } from '../../../src/webview/monaco/sql-prettify';

describe('prettifySql', () => {
	it('formats a simple SELECT statement', () => {
		const result = prettifySql('select id, name from users where id = 1');
		expect(result).toContain('SELECT');
		expect(result).toContain('FROM');
		expect(result).toContain('WHERE');
	});

	it('uppercases SQL keywords', () => {
		const result = prettifySql('select * from orders');
		expect(result).toMatch(/^SELECT\b/);
		expect(result).toMatch(/\bFROM\b/);
	});

	it('formats a multi-table JOIN', () => {
		const result = prettifySql(
			'select u.name, o.total from users u inner join orders o on u.id = o.user_id where o.total > 100'
		);
		expect(result).toContain('INNER JOIN');
		expect(result).toContain('ON');
	});

	it('returns original text for empty input', () => {
		expect(prettifySql('')).toBe('');
	});

	it('handles multi-statement input', () => {
		const result = prettifySql('select 1; select 2;');
		expect(result).toContain('SELECT');
	});

	it('preserves string literals', () => {
		const result = prettifySql("select * from t where name = 'hello world'");
		expect(result).toContain("'hello world'");
	});

	it('handles subqueries', () => {
		const result = prettifySql(
			'select * from (select id, count(*) as cnt from orders group by id) sub where cnt > 5'
		);
		expect(result).toContain('GROUP BY');
	});

	it('returns original text unchanged if already formatted', () => {
		const formatted = prettifySql('select 1');
		const reformatted = prettifySql(formatted);
		expect(reformatted).toBe(formatted);
	});

	it('keeps SELECT TOP n on the same line', () => {
		const result = prettifySql('select top 100 id, name from users order by id');
		expect(result).toMatch(/^SELECT TOP 100\n {4}id,/);
		expect(result).not.toMatch(/SELECT\s*\n\s+TOP/);
	});

	it('keeps SELECT DISTINCT TOP n on the same line', () => {
		const result = prettifySql('select distinct top 50 id, name from users');
		expect(result).toMatch(/^SELECT DISTINCT TOP 50\n {4}id,/);
	});

	it('puts each projected column on its own line after TOP', () => {
		const result = prettifySql(
			'select top 100 ProductID, Name, ProductNumber, Color from SalesLT.Product order by ProductID'
		);
		const lines = result.split('\n');
		expect(lines[0]).toBe('SELECT TOP 100');
		expect(lines[1]).toBe('    ProductID,');
		expect(lines[2]).toBe('    Name,');
		expect(lines[3]).toBe('    ProductNumber,');
		expect(lines[4]).toBe('    Color');
	});
});
