import { describe, expect, it } from 'vitest';
import { createQueryResultFromSts, formatStsCell } from '../../../src/host/sql/stsResultAdapter';

describe('STS result adapter', () => {
	it('uses invariant values for semantic full values and localized values for display', () => {
		expect(formatStsCell({ displayValue: '1,25', invariantCultureDisplayValue: '1.25' })).toEqual({
			display: '1,25', full: '1.25',
		});
	});

	it('preserves null markers', () => {
		expect(formatStsCell({ displayValue: '', isNull: true })).toEqual({ display: 'null', full: 'null', isNull: true });
	});

	it('normalizes SQL bit values to the previous boolean text contract', () => {
		expect(formatStsCell({ displayValue: '1', invariantCultureDisplayValue: '1' }, 'bit')).toEqual({ display: 'true', full: 'true' });
		expect(formatStsCell({ displayValue: '0', invariantCultureDisplayValue: '0' }, 'bit')).toEqual({ display: 'false', full: 'false' });
	});

	it('disambiguates duplicate and unnamed columns by ordinal', () => {
		const result = createQueryResultFromSts([
			{ columnName: 'Value', dataTypeName: 'int' },
			{ columnName: 'value', dataTypeName: 'int' },
			{ columnName: '', dataTypeName: 'nvarchar' },
		], [[
			{ displayValue: '1', invariantCultureDisplayValue: '1' },
			{ displayValue: '2', invariantCultureDisplayValue: '2' },
			{ displayValue: 'three', invariantCultureDisplayValue: 'three' },
		]], { cluster: 'sql://server', database: 'Db', executionTime: '0.001s' });

		expect(result.columns).toEqual([
			{ name: 'Value', type: 'int' },
			{ name: 'value [2]', type: 'int' },
			{ name: 'Column3', type: 'nvarchar' },
		]);
		expect(result.rows[0]).toHaveLength(3);
	});

	it.each([
		[[{ displayValue: '1' }]],
		[[{ displayValue: '1' }, { displayValue: 'extra' }, { displayValue: 'extra-2' }]],
	])('rejects rows whose width differs from the announced columns', rows => {
		expect(() => createQueryResultFromSts(
			[{ columnName: 'A' }, { columnName: 'B' }],
			rows,
			{},
		)).toThrow(/cells for 2 columns/);
	});
});